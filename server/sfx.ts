/**
 * A small sound-effect kit synthesized on the spot: no downloads, no licences, same
 * result every time. Idea from claude-remotion-skill (MIT): "no SFX assets is not a
 * reason to ship silent".
 */
import {savePublic} from './media';

const SR = 44100;

const wav = (samples: Float32Array, rate = SR) => {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
};

/** Seeded noise so every project gets the same kit. */
const noise = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
};

const make = (seconds: number, fn: (i: number, t: number, n: number) => number, rate = SR) => {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i, i / n, n);
  return out;
};

/** Noise through a swept one-pole low-pass, shaped by an envelope. */
const sweptNoise = (seconds: number, seed: number, env: (t: number) => number, cutoff: (t: number) => number, gain = 0.9) => {
  const rnd = noise(seed);
  let lp = 0;
  return make(seconds, (_i, t) => {
    lp += cutoff(t) * (rnd() - lp);
    return lp * env(t) * gain;
  });
};

const tone = (seconds: number, freq: (t: number) => number, env: (t: number) => number, gain = 0.8) => {
  let phase = 0;
  return make(seconds, (_i, t) => {
    phase += (2 * Math.PI * freq(t)) / SR;
    return Math.sin(phase) * env(t) * gain;
  });
};

const SOUNDS: Record<string, {make: () => Float32Array; use: string}> = {
  whoosh: {
    make: () => sweptNoise(0.45, 11, (t) => Math.sin(Math.PI * t ** 0.7) ** 2, (t) => 0.04 + 0.26 * Math.sin(Math.PI * t)),
    use: 'element or scene entering with movement',
  },
  'whoosh-fast': {
    make: () => sweptNoise(0.24, 23, (t) => Math.sin(Math.PI * t ** 0.5) ** 2, (t) => 0.08 + 0.35 * Math.sin(Math.PI * t), 0.8),
    use: 'quick slides, whip pans, small items',
  },
  swoosh: {
    make: () => sweptNoise(0.5, 37, (t) => t ** 2 * (1 - t) * 6.75, (t) => 0.02 + 0.3 * t ** 1.5),
    use: 'reverse swoosh building INTO a cut (start it ~12 frames before)',
  },
  pop: {make: () => tone(0.14, (t) => 700 - 380 * t, (t) => Math.exp(-t * 9)), use: 'icons, badges, bubbles popping in'},
  click: {
    make: () => {
      const rnd = noise(5);
      return make(0.04, (_i, t) => (rnd() * 0.6 + Math.sin(t * 2 * Math.PI * 160)) * Math.exp(-t * 40) * 0.6);
    },
    use: 'UI taps, cursor clicks, toggles',
  },
  tick: {make: () => tone(0.05, () => 1900, (t) => Math.exp(-t * 14), 0.45), use: 'counters (one per step), list items'},
  bass: {make: () => tone(0.5, (t) => 85 - 30 * t, (t) => Math.min(1, t * 80) * Math.exp(-t * 6), 0.95), use: 'the big HIT: title lands, payoff, cut on the beat'},
  riser: {
    make: () => {
      const n = sweptNoise(1.6, 71, (t) => t ** 2.2, (t) => 0.02 + 0.4 * t ** 2, 0.55);
      const s = tone(1.6, (t) => 180 + 520 * t ** 2, (t) => t ** 2.5, 0.35);
      return n.map((v, i) => v + s[i]);
    },
    use: 'tension before a reveal; end it exactly on the bass hit',
  },
  shimmer: {
    make: () => {
      const freqs = [1568, 2093, 2637, 3136];
      const phases = freqs.map(() => 0);
      return make(0.9, (_i, t) => {
        let v = 0;
        freqs.forEach((f, k) => {
          phases[k] += (2 * Math.PI * f * (1 + 0.003 * Math.sin(t * 40 + k))) / SR;
          v += Math.sin(phases[k]) * (k % 2 ? 0.6 : 1);
        });
        return (v / freqs.length) * Math.min(1, t * 30) * Math.exp(-t * 4) * 0.5;
      });
    },
    use: 'sparkle on the hero word, logo or CTA',
  },
};

const PADS: Record<string, number[]> = {
  warm: [110, 164.81, 220, 277.18], // A major
  dark: [110, 164.81, 220, 261.63], // A minor
  bright: [130.81, 196, 261.63, 293.66, 329.63], // C add9
};

/** A soft detuned chord to sit under narration (music bed). */
const pad = (seconds: number, mood: string) => {
  const rate = 22050;
  const freqs = PADS[mood] ?? PADS.warm;
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  freqs.forEach((f, k) => {
    for (const d of [f / 1.0015, f * 1.0015]) {
      let phase = k * 1.7;
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * d) / rate;
        out[i] += Math.sin(phase);
      }
    }
  });
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 1.6);
    const release = Math.min(1, (seconds - t) / 2.2);
    const swell = 1 - 0.18 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.13 * t));
    out[i] *= (0.5 / (freqs.length * 2)) * attack * release * swell;
  }
  return wav(out, rate);
};

export const SFX_NAMES = Object.keys(SOUNDS);

/** Writes public/sfx/*.wav (and an optional music bed) into the project. */
export const addSfx = (projectId: string, opts: {padSeconds?: number; mood?: string} = {}) => {
  const files = SFX_NAMES.map((name) => ({file: savePublic(projectId, `sfx/${name}.wav`, wav(SOUNDS[name].make())), use: SOUNDS[name].use}));
  if (opts.padSeconds && opts.padSeconds > 0) {
    const seconds = Math.min(180, Math.max(4, opts.padSeconds));
    const mood = opts.mood && PADS[opts.mood] ? opts.mood : 'warm';
    files.push({file: savePublic(projectId, `sfx/pad-${mood}.wav`, pad(seconds, mood)), use: `music bed (${seconds}s, ${mood}); volume 0.15-0.25, lower under narration`});
  }
  return files;
};
