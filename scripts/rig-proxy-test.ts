/**
 * Rig test without Gemini quota: part + context boxes from the proxy model, masks from local GrabCut.
 *   npx tsx scripts/rig-proxy-test.ts <image.png> [model]
 * Writes data/rig-test/ layers and data/rig-test/debug.png
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {getConfig} from '../server/config';

const [file, model = 'antigravity/gemini-3-flash'] = process.argv.slice(2);
const parts = ['left wing', 'right wing', 'tail', 'head'];
const context = ['torso', 'left arm', 'right arm', 'left leg', 'right leg'];
const p = getConfig().providers.find((x) => x.id === 'openai')!;
const out = path.join('data', 'rig-test');
fs.rmSync(out, {recursive: true, force: true});

const all = [...parts, ...context];
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
          {
            text: `Detect these parts of the character: ${all.map((x) => `"${x}"`).join(', ')}. "left"/"right" = left/right side of the image. Return only a JSON list with "label" (exactly as given) and "box_2d" [ymin, xmin, ymax, xmax] normalized to 0-1000, tight around each part.`,
            type: 'text',
          },
        ],
      },
    ],
  }),
});
const j: any = await res.json();
const text: string = j?.choices?.[0]?.message?.content ?? '';
const body = text.includes('```') ? text.replace(/^[\s\S]*?```(?:json)?/, '').replace(/```[\s\S]*$/, '') : text;
const boxes = JSON.parse(body.trim()) as {label: string; box_2d: number[]}[];
console.log(boxes.map((b) => `${b.label} ${JSON.stringify(b.box_2d)}`).join('\n'));
const items = boxes.map((b) => ({...b, role: context.includes(b.label) ? 'context' : 'part'}));
const t0 = Date.now();
const r = spawnSync('python', ['server/rig.py'], {input: JSON.stringify({image: file, outDir: out, prefix: 'x', items})});
if (r.status !== 0) throw new Error(r.stderr.toString());
const rig = JSON.parse(r.stdout.toString());
console.log(`cut in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, rig.parts.map((x: any) => `${x.name} pivot ${x.pivot.map(Math.round)}`).join(' | '));
spawnSync('python', ['server/rig.py', '--debug'], {input: JSON.stringify({outDir: out, body: rig.body, parts: rig.parts, out: path.join(out, 'debug.png')})});
