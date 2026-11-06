/**
 * Checks the silence-based caption timing used for Gemini TTS against a sample file.
 *   npx tsx scripts/align-test.ts [file.mp3]
 */
import {estimateWords} from '../server/tts-gemini';
import {probeDuration} from '../server/tts';

const f = process.argv[2] ?? 'data/voice-samples/3-ava-directed.mp3';
const segs = [
  {text: 'Pernah kepikiran, gimana sebuah film dibuat?'},
  {text: 'Semuanya dimulai dari satu ide sederhana.'},
  {text: 'Lalu ide itu ditulis jadi naskah,'},
  {text: 'dan di situlah keajaiban dimulai.'},
];
const d = await probeDuration(f);
const w = await estimateWords(f, d, segs);
console.log(`duration ${d}s`);
console.log(w.map((x) => `${x.start.toFixed(2)}-${x.end.toFixed(2)} ${x.text}`).join('\n'));
