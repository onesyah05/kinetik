/**
 * Try reference-image editing through the images endpoints of the proxy.
 *   npx tsx scripts/frame-edit-test2.ts <ref.png> <model>
 */
import fs from 'node:fs';
import path from 'node:path';
import {getConfig} from '../server/config';

const [ref, model] = process.argv.slice(2);
const p = getConfig().providers.find((x) => x.id === 'openai')!;
const out = path.join('data', 'frame-test');
fs.mkdirSync(out, {recursive: true});
const prompt =
  'Redraw this exact same character, same body, same colors, same art style, same position and scale, but with BOTH WINGS RAISED fully UP above the shoulders (upstroke of a wing flap). Plain flat pure #00FF00 green background.';
const b64 = fs.readFileSync(ref).toString('base64');

const save = (tag: string, j: any) => {
  const d = j?.data?.[0];
  if (d?.b64_json) {
    const f = path.join(out, `${tag}.png`);
    fs.writeFileSync(f, Buffer.from(d.b64_json, 'base64'));
    return `saved ${f}`;
  }
  return JSON.stringify(j).replace(/[A-Za-z0-9+/=]{200,}/g, '<b64>').slice(0, 300);
};

// 1) /images/edits multipart
{
  const t0 = Date.now();
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('image', new Blob([fs.readFileSync(ref)], {type: 'image/png'}), 'ref.png');
  const r = await fetch(`${p.baseURL}/images/edits`, {method: 'POST', headers: {Authorization: `Bearer ${p.apiKey}`}, body: fd});
  const j = await r.json().catch(() => ({}));
  console.log('edits', r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, save('edits', j));
}
// 2) /images/generations with an image field (some gateways accept it)
for (const field of ['image', 'images', 'reference_images']) {
  const t0 = Date.now();
  const val = field === 'image' ? `data:image/png;base64,${b64}` : [`data:image/png;base64,${b64}`];
  const r = await fetch(`${p.baseURL}/images/generations`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
    body: JSON.stringify({model, prompt, n: 1, [field]: val}),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`generations+${field}`, r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, save(`gen-${field}`, j));
  if (r.ok) break;
}
