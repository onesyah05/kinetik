/**
 * Renders the same Indonesian narration with different voices and delivery so they can be compared by ear.
 *   npx tsx scripts/voice-samples.ts   → data/voice-samples/*.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../server/paths';
import {run} from '../server/tts';

const OUT = path.join(ROOT, 'data', 'voice-samples');
fs.mkdirSync(OUT, {recursive: true});
const SCRIPT = path.join(ROOT, 'server', 'tts.py');

const flat = 'Pernah kepikiran gimana sebuah film dibuat? Semuanya dimulai dari satu ide sederhana. Lalu ide itu ditulis jadi naskah, dan di situlah keajaiban dimulai.';

// The same text, directed: a hook that lifts, a calm explanation, a slower reveal after a pause.
const directed = [
  {text: 'Pernah kepikiran, gimana sebuah film dibuat?', rate: '+6%', pitch: '+12Hz', pause: 0.45},
  {text: 'Semuanya dimulai dari satu ide sederhana.', rate: '-4%', pitch: '-2Hz', pause: 0.3},
  {text: 'Lalu ide itu ditulis jadi naskah,', rate: '+0%', pitch: '+0Hz', pause: 0.2},
  {text: 'dan di situlah keajaiban dimulai.', rate: '-12%', pitch: '+4Hz', volume: '+10%', pause: 0},
];

const samples: [string, string, unknown[]][] = [
  ['1-gadis-flat (old default)', 'id-ID-GadisNeural', [{text: flat}]],
  ['2-ava-flat', 'en-US-AvaMultilingualNeural', [{text: flat}]],
  ['3-ava-directed', 'en-US-AvaMultilingualNeural', directed],
  ['4-andrew-directed', 'en-US-AndrewMultilingualNeural', directed],
  ['5-emma-directed', 'en-US-EmmaMultilingualNeural', directed],
];

for (const [name, voice, segments] of samples) {
  const out = path.join(OUT, `${name.split(' ')[0]}.mp3`);
  const t = Date.now();
  const r = JSON.parse(await run(process.platform === 'win32' ? 'python' : 'python3', [SCRIPT], JSON.stringify({voice, out, segments})));
  console.log(`${name.padEnd(28)} ${r.duration.toFixed(2)}s, ${r.words.length} words, ${Date.now() - t}ms → ${out}`);
}
