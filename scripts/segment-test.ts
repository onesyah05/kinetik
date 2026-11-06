/**
 * Try Gemini segmentation on an image and save each part mask, to check rigging quality.
 *   npx tsx scripts/segment-test.ts <image.png> "left wing,right wing,tail"
 */
import fs from 'node:fs';
import path from 'node:path';
import {getConfig} from '../server/config';

const [file, partsArg] = process.argv.slice(2);
const parts = (partsArg ?? 'left wing,right wing').split(',').map((s) => s.trim());
const key = getConfig().tts.geminiKey;
const out = path.join('data', 'seg-test');
fs.mkdirSync(out, {recursive: true});

const t0 = Date.now();
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.SEG_MODEL ?? 'gemini-2.5-flash'}:generateContent`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
  body: JSON.stringify({
    contents: [
      {
        parts: [
          {inlineData: {mimeType: 'image/png', data: fs.readFileSync(file).toString('base64')}},
          {
            text: `Give the segmentation masks for these parts of the character: ${parts.map((p) => `"${p}"`).join(', ')}. "left"/"right" mean the image's left/right side. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label" (use exactly the names given).`,
          },
        ],
      },
    ],
    generationConfig: {thinkingConfig: {thinkingBudget: 0}},
  }),
});
const j: any = await res.json();
console.log('HTTP', res.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
let items: any[] = [];
try {
  items = JSON.parse(text.replace(/^[\s\S]*?```json/, '').replace(/```[\s\S]*$/, '').trim());
} catch {
  console.log(text.slice(0, 500) || JSON.stringify(j).slice(0, 500));
}
for (const it of items) {
  const b64 = String(it.mask ?? '').replace(/^data:image\/png;base64,/, '');
  const name = String(it.label).replace(/\W+/g, '-');
  if (b64) fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(b64, 'base64'));
  console.log(it.label, 'box', JSON.stringify(it.box_2d), b64 ? 'mask saved' : 'no mask');
}
