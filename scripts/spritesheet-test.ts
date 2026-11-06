/**
 * Sprite sheet test: describe a reference character with the vision LLM, then draw N animation frames in ONE image.
 *   npx tsx scripts/spritesheet-test.ts <ref.png> "<action>" [cols] [rows]
 */
import fs from 'node:fs';
import path from 'node:path';
import {getConfig} from '../server/config';

const [ref, action, colsArg, rowsArg] = process.argv.slice(2);
const cols = Number(colsArg ?? 3);
const rows = Number(rowsArg ?? 2);
const c = getConfig();
const p = c.providers.find((x) => x.id === 'openai')!;
const out = path.join('data', 'frame-test');
fs.mkdirSync(out, {recursive: true});

// 1. Character sheet text from the reference image.
let t0 = Date.now();
const d = await fetch(`${p.baseURL}/chat/completions`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
  body: JSON.stringify({
    model: p.model,
    messages: [
      {
        role: 'user',
        content: [
          {type: 'image_url', image_url: {url: `data:image/png;base64,${fs.readFileSync(ref).toString('base64')}`}},
          {
            type: 'text',
            text: 'Describe this character for an illustrator who must redraw it identically: species, body shape and proportions, every clothing item, every colour as a hex code, markings, eyes, expression, art style (line weight, shading, rendering). One dense paragraph, no intro.',
          },
        ],
      },
    ],
  }),
}).then((r) => r.json());
const sheet: string = d?.choices?.[0]?.message?.content ?? '';
console.log(`description (${((Date.now() - t0) / 1000).toFixed(1)}s):`, sheet.slice(0, 400), '...');
fs.writeFileSync(path.join(out, 'character.txt'), sheet);

// 2. All frames in one image so they stay consistent.
const n = cols * rows;
const prompt = `Animation sprite sheet: exactly ${n} frames of the SAME character arranged in a perfectly even grid of ${cols} columns and ${rows} rows, read left-to-right, top-to-bottom. Every cell is the same size, the character is the same size and stands at exactly the same spot in every cell (feet on the same baseline, body centered), only the animated part changes.
Animation: ${action}. The ${n} frames form one smooth looping cycle, evenly spaced in time.
Character (identical in every frame): ${sheet}
Plain flat pure #00FF00 green background in every cell, no grid lines, no borders, no shadows, no text, no numbers.`;
t0 = Date.now();
const r = await fetch(`${p.baseURL}/images/generations`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
  body: JSON.stringify({model: c.imageGen.model, prompt, size: cols >= rows ? '1536x1024' : '1024x1536', n: 1}),
});
const j: any = await r.json();
console.log(`sheet HTTP ${r.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (j?.data?.[0]?.b64_json) {
  fs.writeFileSync(path.join(out, 'sheet.png'), Buffer.from(j.data[0].b64_json, 'base64'));
  console.log('saved data/frame-test/sheet.png');
} else console.log(JSON.stringify(j).slice(0, 300));
