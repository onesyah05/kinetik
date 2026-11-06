/**
 * Try segmentation masks through the OpenAI-compatible proxy (any vision model that can emit Gemini-style masks).
 *   npx tsx scripts/proxy-segment-test.ts <image.png> <model> "left wing,right wing"
 */
import fs from 'node:fs';
import path from 'node:path';
import {getConfig} from '../server/config';

const [file, model, partsArg] = process.argv.slice(2);
const parts = (partsArg ?? 'left wing,right wing,tail,head').split(',').map((s) => s.trim());
const p = getConfig().providers.find((x) => x.id === 'openai')!;
const out = path.join('data', 'seg-test', model.replace(/\W+/g, '_'));
fs.mkdirSync(out, {recursive: true});

const prompt = `Give the segmentation masks for these parts of the character: ${parts
  .map((x) => `"${x}"`)
  .join(', ')}. "left" and "right" mean the left and right side of the image. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label" (use exactly the names given).`;
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
          {type: 'image_url', image_url: {url: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`}},
          {type: 'text', text: prompt},
        ],
      },
    ],
  }),
});
const j: any = await res.json().catch(() => ({}));
const text: string = j?.choices?.[0]?.message?.content ?? '';
console.log(model, 'HTTP', res.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, `${text.length} chars`);
if (!res.ok) console.log(JSON.stringify(j).slice(0, 300));
const body = text.includes('```') ? text.replace(/^[\s\S]*?```(?:json)?/, '').replace(/```[\s\S]*$/, '') : text;
try {
  for (const it of JSON.parse(body.trim())) {
    const b64 = String(it.mask ?? '').replace(/^data:image\/\w+;base64,/, '');
    let ok = false;
    if (b64.length > 100) {
      fs.writeFileSync(path.join(out, `${String(it.label).replace(/\W+/g, '-')}.png`), Buffer.from(b64, 'base64'));
      ok = true;
    }
    console.log(' ', it.label, JSON.stringify(it.box_2d), ok ? `mask ${b64.length} b64 chars` : 'NO MASK');
  }
} catch {
  console.log('  unparseable:', text.slice(0, 300).replace(/\n/g, ' '));
}
