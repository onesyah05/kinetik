/**
 * Gemini TTS: expressive speech steered with natural-language direction.
 * The whole script is spoken in one request so it flows like a real read; word timings for captions
 * are estimated from the silences in the audio (Gemini returns none).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getConfig} from './config';

/** Prebuilt Gemini voices and their character (from Google's docs). */
export const GEMINI_VOICES: [string, string][] = [
  ['Puck', 'upbeat, male'],
  ['Fenrir', 'excitable, male'],
  ['Charon', 'informative, male'],
  ['Orus', 'firm, male'],
  ['Iapetus', 'clear, male'],
  ['Umbriel', 'easy-going, male'],
  ['Algenib', 'gravelly, male'],
  ['Achird', 'friendly, male'],
  ['Zubenelgenubi', 'casual, male'],
  ['Sadaltager', 'knowledgeable, male'],
  ['Kore', 'firm, female'],
  ['Aoede', 'breezy, female'],
  ['Leda', 'youthful, female'],
  ['Zephyr', 'bright, female'],
  ['Autonoe', 'bright, female'],
  ['Callirrhoe', 'easy-going, female'],
  ['Despina', 'smooth, female'],
  ['Laomedeia', 'upbeat, female'],
  ['Achernar', 'soft, female'],
  ['Sulafat', 'warm, female'],
  ['Vindemiatrix', 'gentle, female'],
  ['Sadachbia', 'lively, female'],
  ['Gacrux', 'mature, female'],
];

export type GeminiSegment = {text: string; style?: string; pause?: number};
export type Word = {text: string; start: number; end: number};

const runCapture = (cmd: string, args: string[]) =>
  new Promise<{out: string; err: string}>((resolve, reject) => {
    const p = spawn(cmd, args, {windowsHide: true});
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({out, err}) : reject(new Error(err.trim().split('\n').slice(-3).join('\n')))));
  });

/** Build the prompt: overall direction, then each line with its own delivery note. */
const buildPrompt = (segments: GeminiSegment[], direction?: string) => {
  const lines = segments.map((s) => {
    const note = s.style?.trim() ? `(${s.style.trim()}) ` : '';
    const pause = s.pause && s.pause >= 0.4 ? ' ...' : '';
    return `${note}${s.text.trim()}${pause}`;
  });
  return [
    `Kamu adalah pengisi suara profesional untuk video. ${direction?.trim() || 'Bacakan dengan natural, hidup, dan ekspresif seperti orang sungguhan bercerita, bukan membaca.'}`,
    'Bacakan naskah di bawah ini persis kata per kata. Catatan dalam tanda kurung adalah arahan cara membaca kalimat itu: ikuti arahannya, JANGAN dibacakan. Beri jeda alami di antara kalimat.',
    '',
    'NASKAH:',
    ...lines,
  ].join('\n');
};

export const geminiReady = () => !!getConfig().tts.geminiKey;

/** Calls Gemini and writes an MP3. Returns duration in seconds. */
export const geminiSpeak = async (segments: GeminiSegment[], voice: string, direction: string | undefined, outMp3: string) => {
  const cfg = getConfig().tts;
  if (!cfg.geminiKey) throw new Error('Gemini TTS needs an API key (Settings → Voiceover).');
  const model = cfg.geminiModel || 'gemini-2.5-flash-preview-tts';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey},
    body: JSON.stringify({
      contents: [{parts: [{text: buildPrompt(segments, direction)}]}],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: voice}}},
      },
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini TTS error ${res.status}: ${String(json?.error?.message ?? JSON.stringify(json)).slice(0, 400)}`);
  const part = json?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error(`Gemini returned no audio (${json?.candidates?.[0]?.finishReason ?? 'unknown reason'})`);
  const mime: string = part.inlineData.mimeType ?? '';
  const rate = Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000);
  const pcm = `${outMp3}.pcm`;
  fs.mkdirSync(path.dirname(outMp3), {recursive: true});
  fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
  try {
    // Trim leading/trailing silence so the voice starts right on the scene cut.
    await runCapture('ffmpeg', [
      '-y', '-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', pcm,
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse',
      '-c:a', 'libmp3lame', '-b:a', '128k', outMp3,
    ]);
  } finally {
    fs.rmSync(pcm, {force: true});
  }
};

/** Speech intervals [start, end] found with ffmpeg silencedetect. */
const speechIntervals = async (file: string, duration: number) => {
  const {err} = await runCapture('ffmpeg', ['-v', 'info', '-i', file, '-af', 'silencedetect=noise=-38dB:d=0.16', '-f', 'null', '-']);
  const silences: [number, number][] = [];
  let start: number | null = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) {
      silences.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start !== null) silences.push([start, duration]);
  const speech: [number, number][] = [];
  let t = 0;
  for (const [a, b] of silences) {
    if (a - t > 0.05) speech.push([t, a]);
    t = b;
  }
  if (duration - t > 0.05) speech.push([t, duration]);
  return {speech, silences};
};

const weight = (w: string) => Math.max(1, (w.match(/[aiueoAIUEO]/g) ?? []).length) + (/[,.!?;:]$/.test(w) ? 1.5 : 0);

/**
 * Estimate word timings: split the audio into one span per segment at the longest silences,
 * then spread each segment's words over its span by syllable weight.
 */
export const estimateWords = async (file: string, duration: number, segments: GeminiSegment[]): Promise<Word[]> => {
  const {speech, silences} = await speechIntervals(file, duration);
  const total: [number, number] = speech.length ? [speech[0][0], speech[speech.length - 1][1]] : [0, duration];
  // Pick the N-1 longest inner silences as boundaries between segments.
  const inner = silences.filter(([a, b]) => a > total[0] + 0.05 && b < total[1] - 0.05);
  const cuts = [...inner]
    .sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
    .slice(0, Math.max(0, segments.length - 1))
    .sort((x, y) => x[0] - y[0]);
  const spans: [number, number][] = [];
  if (cuts.length === segments.length - 1) {
    let s = total[0];
    for (const [a, b] of cuts) {
      spans.push([s, a]);
      s = b;
    }
    spans.push([s, total[1]]);
  } else {
    // Not enough pauses: split proportionally by text weight.
    const ws = segments.map((g) => g.text.split(/\s+/).filter(Boolean).reduce((n, w) => n + weight(w), 0));
    const sum = ws.reduce((a, b) => a + b, 0) || 1;
    let s = total[0];
    for (const w of ws) {
      const e = s + ((total[1] - total[0]) * w) / sum;
      spans.push([s, e]);
      s = e;
    }
  }
  const words: Word[] = [];
  segments.forEach((g, i) => {
    const list = g.text.split(/\s+/).filter(Boolean);
    const ws = list.map(weight);
    const sum = ws.reduce((a, b) => a + b, 0) || 1;
    const [a, b] = spans[i];
    let t = a;
    list.forEach((w, j) => {
      const d = ((b - a) * ws[j]) / sum;
      words.push({text: w.replace(/^[("'“]+|[)"'”,.!?;:]+$/g, '') || w, start: Math.round(t * 1000) / 1000, end: Math.round((t + d * 0.92) * 1000) / 1000});
      t += d;
    });
  });
  return words;
};
