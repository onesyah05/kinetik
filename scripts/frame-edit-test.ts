/**
 * Can a proxy image model edit a reference image (same character, new pose)? Prints the response shape and saves images.
 *   npx tsx scripts/frame-edit-test.ts <ref.png> <model> "<instruction>"
 */
import fs from 'node:fs';
import path from 'node:path';
import {getConfig} from '../server/config';

const [ref, model, instruction] = process.argv.slice(2);
const p = getConfig().providers.find((x) => x.id === 'openai')!;
const out = path.join('data', 'frame-test');
fs.mkdirSync(out, {recursive: true});
const t0 = Date.now();
const res = await fetch(`${p.baseURL}/chat/completions`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
  body: JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {type: 'image_url', image_url: {url: `data:image/png;base64,${fs.readFileSync(ref).toString('base64')}`}},
          {type: 'text', text: instruction},
        ],
      },
    ],
  }),
});
const raw = await res.text();
console.log(model, 'HTTP', res.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, `${raw.length} bytes`);
// Find any base64 image anywhere in the response (content string, images array, parts...).
const found = [...raw.matchAll(/data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]{200,})/g)];
const shape = raw.replace(/[A-Za-z0-9+/=]{200,}/g, '<b64>').slice(0, 700);
console.log('shape:', shape);
found.forEach((m, i) => {
  const f = path.join(out, `${model.replace(/\W+/g, '_')}-${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
  console.log('saved', f);
});
