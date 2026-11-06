"""Edge TTS helper with directed delivery.

Reads JSON from stdin:
  {"voice", "out", "segments": [{"text", "rate", "pitch", "volume", "pause"}]}   (or a single "text")
Each segment is spoken with its own rate/pitch/volume, followed by `pause` seconds of silence.
Segments are joined with ffmpeg; word timings are shifted so captions stay in sync.
Prints JSON: {"words": [{text, start, end}], "duration"}.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile

import edge_tts

SAMPLE_RATE = 24000


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out or 0)


async def synth_segment(seg, voice, path):
    c = edge_tts.Communicate(
        seg["text"],
        voice,
        rate=seg.get("rate") or "+0%",
        pitch=seg.get("pitch") or "+0Hz",
        volume=seg.get("volume") or "+0%",
        boundary="WordBoundary",
    )
    words = []
    with open(path, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])  # type: ignore[typeddict-item]
            elif ch["type"] == "WordBoundary":
                start = ch["offset"] / 1e7  # type: ignore[typeddict-item]
                end = start + ch["duration"] / 1e7  # type: ignore[typeddict-item]
                words.append({"text": ch["text"], "start": start, "end": end})  # type: ignore[typeddict-item]
    return words


def silence(path, seconds):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono",
         "-t", f"{seconds:.3f}", "-c:a", "pcm_s16le", path],
        check=True,
    )


def to_wav(src, dst):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", dst],
        check=True,
    )


async def synth(args):
    segments = args.get("segments") or [{"text": args["text"], "rate": args.get("rate"), "pitch": args.get("pitch")}]
    segments = [s for s in segments if str(s.get("text", "")).strip()]
    voice = args["voice"]
    words = []
    t = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, seg in enumerate(segments):
            mp3 = os.path.join(tmp, f"s{i}.mp3")
            wav = os.path.join(tmp, f"s{i}.wav")
            seg_words = await synth_segment(seg, voice, mp3)
            to_wav(mp3, wav)  # decode so durations add up exactly when joined
            for w in seg_words:
                words.append({"text": w["text"], "start": round(t + w["start"], 3), "end": round(t + w["end"], 3)})
            t += probe(wav)
            parts.append(wav)
            pause = float(seg.get("pause") or 0)
            if pause > 0 and i < len(segments) - 1:
                sil = os.path.join(tmp, f"p{i}.wav")
                silence(sil, pause)
                parts.append(sil)
                t += pause
        listfile = os.path.join(tmp, "list.txt")
        with open(listfile, "w", encoding="utf8") as f:
            for p in parts:
                f.write(f"file '{p}'\n")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listfile,
             "-c:a", "libmp3lame", "-b:a", "128k", args["out"]],
            check=True,
        )
    return {"words": words, "duration": round(t, 3)}


async def voices():
    vs = await edge_tts.list_voices()
    return [
        {
            "name": v["ShortName"],
            "locale": v["Locale"],
            "gender": v["Gender"],
            "personality": ", ".join(v.get("VoiceTag", {}).get("VoicePersonalities", [])),
            "multilingual": "Multilingual" in v["ShortName"],
        }
        for v in vs
    ]


def main():
    args = json.loads(sys.stdin.read())
    if args.get("cmd") == "voices":
        print(json.dumps(asyncio.run(voices())))
    else:
        print(json.dumps(asyncio.run(synth(args))))


if __name__ == "__main__":
    main()
