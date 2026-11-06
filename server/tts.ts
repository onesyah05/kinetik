import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT} from './paths';
import {projectDir, safeAssetName, writeFile} from './projects';
import {getConfig} from './config';
import {emit} from './events';
import {estimateWords, geminiSpeak, GEMINI_VOICES} from './tts-gemini';

const PY = process.env.KINETIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const SCRIPT = path.join(ROOT, 'server', 'tts.py');

export const run = (cmd: string, args: string[], stdin?: string) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, {windowsHide: true});
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `${cmd} exited ${code}`)),
    );
    if (stdin !== undefined) p.stdin.end(stdin);
  });

export const probeDuration = async (file: string) => {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.trim()) || 0;
};

export type TtsResult = {name: string; audio: string; module: string; importPath: string; durationInSeconds: number; words: number};

/**
 * One spoken phrase with its own delivery.
 * Edge engine uses rate "+8%", pitch "+10Hz", volume "+5%"; Gemini engine uses `style` (natural language).
 */
export type Segment = {text: string; style?: string; rate?: string; pitch?: string; volume?: string; pause?: number};

export const ttsEngine = () => {
  const cfg = getConfig().tts;
  return cfg.engine === 'gemini' && cfg.geminiKey ? 'gemini' : 'edge';
};

const isGeminiVoice = (v?: string) => !!v && GEMINI_VOICES.some(([n]) => n.toLowerCase() === v.toLowerCase());

// ---------- Gemini quota → Edge fallback ----------

/** While Gemini's free quota is used up, go straight to Edge instead of failing first. */
let geminiPausedUntil = 0;

/** Out of quota, rate limited or overloaded: worth switching to Edge rather than failing the video. */
const isQuotaError = (e: unknown) =>
  /Gemini TTS error (429|503)\b|RESOURCE_EXHAUSTED|quota|rate.?limit|UNAVAILABLE|overloaded/i.test(String((e as Error)?.message ?? e));

/** Daily quotas reset at midnight Pacific time; per-minute limits clear quickly. */
const pauseGemini = (e: unknown) => {
  const msg = String((e as Error)?.message ?? e);
  if (/per.?day|PerDay|daily/i.test(msg)) {
    const la = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/Los_Angeles'}));
    const sinceMidnight = ((la.getHours() * 60 + la.getMinutes()) * 60 + la.getSeconds()) * 1000;
    geminiPausedUntil = Date.now() + 24 * 3600_000 - sinceMidnight;
  } else geminiPausedUntil = Date.now() + 2 * 60_000;
};

/** An Edge voice in the default voice's language, with the same gender as the Gemini voice it replaces. */
const edgeStandIn = async (geminiVoice: string, fallback: string) => {
  const desc = GEMINI_VOICES.find(([n]) => n.toLowerCase() === geminiVoice.toLowerCase())?.[1] ?? '';
  const gender = /\bfemale\b/.test(desc) ? 'Female' : /\bmale\b/.test(desc) ? 'Male' : '';
  const locale = fallback.split('-').slice(0, 2).join('-');
  if (!gender || !locale) return fallback;
  try {
    const voices = await listVoices(locale);
    const current = voices.find((v) => v.name === fallback);
    if (current?.gender === gender) return fallback;
    return voices.find((v) => v.locale === locale && v.gender === gender)?.name ?? fallback;
  } catch {
    return fallback;
  }
};

export const synthesize = async (
  id: string,
  input: {name: string; text?: string; segments?: Segment[]; voice?: string; rate?: string; pitch?: string; direction?: string},
  /** false: report Gemini errors instead of switching to Edge (the Settings voice test). */
  allowFallback = true,
): Promise<TtsResult & {engine: string; note?: string}> => {
  const cfg = getConfig().tts;
  let engine = ttsEngine();
  let note: string | undefined;
  const geminiVoice = isGeminiVoice(input.voice) ? input.voice! : cfg.geminiVoice || 'Aoede';
  const until = () => new Date(geminiPausedUntil).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  if (engine === 'gemini' && allowFallback && Date.now() < geminiPausedUntil) {
    engine = 'edge';
    note = `Gemini TTS quota is still used up (until about ${until()}), so this track used the free Edge voice instead.`;
  }
  const name = safeAssetName(input.name).replace(/\//g, '-').replace(/\.[a-z0-9]+$/i, '') || 'voice';
  const segments: Segment[] = (input.segments?.length ? input.segments : [{text: input.text ?? '', rate: input.rate || cfg.rate, pitch: input.pitch}]).filter(
    (s) => s.text?.trim(),
  );
  const text = segments.map((s) => s.text.trim()).join(' ');
  if (!text) throw new Error('Nothing to say: pass text or segments.');
  const rel = `voiceover/${name}.mp3`;
  const out = path.join(projectDir(id), 'public', rel);
  fs.mkdirSync(path.dirname(out), {recursive: true});

  let voice = '';
  let words: {text: string; start: number; end: number}[] = [];
  let duration = 0;
  if (engine === 'gemini') {
    voice = geminiVoice;
    // Write to a temp name first so the preview never plays a half-written file.
    const tmp = `${out}.part.mp3`;
    try {
      await geminiSpeak(segments, voice, input.direction, tmp);
      fs.renameSync(tmp, out);
      duration = await probeDuration(out);
      words = await estimateWords(out, duration, segments);
    } catch (e) {
      fs.rmSync(tmp, {force: true});
      if (!allowFallback || !isQuotaError(e)) throw e;
      pauseGemini(e);
      console.warn(`[tts] Gemini unavailable, using Edge until ${until()}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      engine = 'edge';
      note = `Gemini TTS quota is used up (until about ${until()}), so this track used the free Edge voice instead.`;
    }
  }
  if (engine === 'edge') {
    // A Gemini voice name means this was meant for Gemini: pick a matching Edge voice.
    voice = note
      ? await edgeStandIn(geminiVoice, cfg.defaultVoice)
      : input.voice && !isGeminiVoice(input.voice)
        ? input.voice
        : cfg.defaultVoice;
    const res = JSON.parse(await run(PY, [SCRIPT], JSON.stringify({segments, voice, out}))) as {
      words: {text: string; start: number; end: number}[];
      duration: number;
    };
    duration = await probeDuration(out).catch(() => res.duration);
    words = res.words;
  }
  const track = {src: rel, text, voice, durationInSeconds: Math.round(duration * 1000) / 1000, words};
  const moduleRel = `src/voiceover/${name}.ts`;
  writeFile(
    id,
    moduleRel,
    `// Generated by the tts tool. Re-run tts to change; do not edit by hand.\nimport type {VoiceTrack} from '@kit';\n\nconst track: VoiceTrack = ${JSON.stringify(track, null, 2)};\n\nexport default track;\n`,
  );
  emit({type: 'assets_changed', projectId: id});
  return {
    name,
    audio: rel,
    module: moduleRel,
    importPath: `./voiceover/${name}`,
    durationInSeconds: track.durationInSeconds,
    words: words.length,
    engine,
    ...(note
      ? {
          note: `${note} Edge voice: ${voice}. Tell the user in one line. Tracks made earlier with Gemini sound different; for one consistent voice, run tts again for those tracks (they will use Edge too until the quota resets), or wait and redo this one with Gemini later.`,
        }
      : {}),
  };
};

type Voice = {name: string; locale: string; gender: string; personality: string; multilingual: boolean};
let voiceCache: Voice[] | null = null;
/** Voices for a locale prefix. Multilingual voices speak almost any language, so they are always included. */
export const listVoices = async (locale = '') => {
  if (!voiceCache) voiceCache = JSON.parse(await run(PY, [SCRIPT], JSON.stringify({cmd: 'voices'})));
  return voiceCache!.filter((v) => !locale || v.multilingual || v.locale.toLowerCase().startsWith(locale.toLowerCase()));
};

/** Synthesise a sample line into a scratch project folder and return the MP3 bytes. */
export const synthesizeTest = async (text: string | undefined, direction: string | undefined, dir: string) => {
  const id = path.basename(dir);
  const sample =
    text?.trim() ||
    'Pernah kepikiran gimana sebuah film dibuat? Ternyata semuanya dimulai dari satu ide kecil. Dan dari situ, keajaiban dimulai!';
  const sentences = sample.match(/[^.!?]+[.!?]*/g)?.map((t) => t.trim()).filter(Boolean) ?? [sample];
  const styles = ['nada bertanya, penasaran, sedikit naik di akhir', 'tenang dan meyakinkan', 'pelan lalu bersemangat, beri penekanan'];
  const r = await synthesize(id, {
    name: 'test',
    direction,
    segments: sentences.map((t, i) => ({text: t, style: styles[i % styles.length], pitch: i === 0 ? '+10Hz' : '+0Hz', pause: 0.3})),
  }, false); // the voice test should show Gemini errors, not quietly play Edge
  return fs.readFileSync(path.join(dir, 'public', r.audio));
};
