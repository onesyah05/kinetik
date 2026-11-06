/**
 * Frame-by-frame animation (sprite) for a character: the image model draws every frame in ONE sprite sheet
 * (so the character stays consistent), then the sheet is sliced and the frames are aligned on the feet.
 * Works with gateways that cannot edit from a reference image: the reference is turned into a detailed
 * character description by the vision LLM instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getProvider} from './config';
import {ROOT} from './paths';
import {getProject, projectDir, safeAssetName, writeFile} from './projects';
import {emit} from './events';
import {imageGenTarget, removeBackground} from './media';

const PY = process.env.KINETIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const runPy = (script: string, input: unknown) =>
  new Promise<any>((resolve, reject) => {
    const p = spawn(PY, [path.join(ROOT, 'server', script)], {windowsHide: true});
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `${script} exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`${script}: ${out.slice(0, 200)}`));
      }
    });
    p.stdin.end(JSON.stringify(input));
  });

/** Grid for a frame count, filling a landscape sheet. */
const gridFor = (n: number): [number, number] => {
  if (n <= 4) return [2, 2];
  if (n <= 6) return [3, 2];
  if (n <= 8) return [4, 2];
  if (n <= 9) return [3, 3];
  if (n <= 10) return [5, 2];
  return [4, 3];
};

/** Detailed character description from a reference image, cached next to the project. */
const describeCharacter = async (id: string, refFile: string) => {
  const cacheDir = path.join(projectDir(id), '.tmp');
  fs.mkdirSync(cacheDir, {recursive: true});
  const cache = path.join(cacheDir, `describe-${path.basename(refFile)}-${fs.statSync(refFile).mtimeMs}.txt`);
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
  // The provider this project chats with; the global default may be offline.
  const p = getProvider(getProject(id).providerId);
  if (!p) throw new Error('No LLM provider configured to describe the reference character.');
  const res = await fetch(`${p.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
    body: JSON.stringify({
      model: p.model,
      messages: [
        {
          role: 'user',
          content: [
            {type: 'image_url', image_url: {url: `data:image/png;base64,${fs.readFileSync(refFile).toString('base64')}`}},
            {
              type: 'text',
              text: 'Describe this character for an illustrator who must redraw it identically: species, body shape and proportions, every clothing item and accessory, every colour as a hex code, markings, eyes, expression, pose, art style (line weight, shading, rendering). One dense paragraph, no intro.',
            },
          ],
        },
      ],
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  const text: string = j?.choices?.[0]?.message?.content ?? '';
  if (!res.ok || !text) throw new Error(`Could not describe the reference character (${p.model}): HTTP ${res.status}`);
  fs.writeFileSync(cache, text);
  return text;
};

export type SpriteInput = {
  name: string;
  /** What moves, e.g. "flaps its wings" or "walks in place". */
  action: string;
  frames?: number;
  /** Existing asset to copy the character from. */
  reference?: string;
  /** Character description if there is no reference. */
  description?: string;
  /** Optional per-frame notes, in order. */
  poses?: string[];
  fps?: number;
  mode?: 'loop' | 'pingpong' | 'once';
};

export const generateSprite = async (id: string, input: SpriteInput) => {
  const t = imageGenTarget(id);
  if (!t.ready) throw new Error('Image generation is not configured (Settings → Image generation).');
  const name = safeAssetName(input.name).replace(/\//g, '-') || 'sprite';
  const n = Math.max(4, Math.min(12, Math.round(input.frames ?? 6)));
  const [cols, rows] = gridFor(n);
  const total = cols * rows;

  const extra = input.description?.trim() ?? '';
  const ref = input.reference ? path.join(projectDir(id), 'public', safeAssetName(input.reference.replace(/^\/?(public\/)?/, ''))) : '';
  if (ref && !fs.existsSync(ref)) throw new Error(`Reference not found: public/${input.reference}`);
  if (!ref && !extra) throw new Error('Give a reference image or a character description.');

  const poses = input.poses?.length
    ? `\nFrame by frame: ${input.poses.slice(0, total).map((p, i) => `frame ${i + 1}: ${p}`).join('; ')}.`
    : '';
  const sheetPrompt = (character: string) => `Animation sprite sheet: exactly ${total} frames of the SAME character arranged in a perfectly even grid of ${cols} columns and ${rows} rows, read left-to-right, top-to-bottom. Every cell is the same size; the character is the same size and stands at exactly the same spot in every cell (feet on the same baseline, body centred, nothing crossing into neighbouring cells). Only the animated part changes between frames.
Animation: ${input.action}. The ${total} frames form one smooth cycle, evenly spaced in time.${poses}
Character, identical in every frame: ${character}
Plain flat pure #00FF00 green background in every cell, no grid lines, no borders, no ground shadow, no text, no numbers.`;

  const tmp = path.join(projectDir(id), '.tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const sheetFile = path.join(tmp, `sheet-${name}-${Date.now()}.png`);
  let json: any = null;

  // With a reference, hand the image itself to the image model (keeps the design exact).
  if (ref) {
    const fd = new FormData();
    fd.append('model', t.model);
    fd.append('prompt', sheetPrompt(`exactly the character in the attached image: same design, colours, proportions and art style.${extra ? ` ${extra}` : ''}`));
    fd.append('size', '1536x1024');
    fd.append('n', '1');
    fd.append('image', new Blob([fs.readFileSync(ref)], {type: 'image/png'}), path.basename(ref));
    const res = await fetch(`${t.baseURL}/images/edits`, {method: 'POST', headers: {Authorization: `Bearer ${t.apiKey}`}, body: fd}).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : null;
    if (res?.ok && j?.data?.[0]) json = j;
  }

  // Otherwise (or if the endpoint has no edits), describe the character in words.
  // Larger sheets give sharper frames; fall back to the standard size if the model refuses.
  const prompt = json ? '' : sheetPrompt(ref ? `${await describeCharacter(id, ref)}${extra ? ` ${extra}` : ''}` : extra);
  for (const size of json ? [] : ['2048x1360', '1536x1024']) {
    const body: Record<string, unknown> = {model: t.model, prompt, size, n: 1};
    if (/gpt-image/i.test(t.model)) Object.assign(body, {background: 'transparent', output_format: 'png'});
    const res = await fetch(`${t.baseURL}/images/generations`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}`},
      body: JSON.stringify(body),
    }).catch((e: Error) => {
      throw new Error(`Cannot reach the image endpoint ${t.baseURL} (${e.message}). Check Settings → Image generation.`);
    });
    json = await res.json().catch(() => ({}));
    if (res.ok) break;
    if (res.status !== 400) throw new Error(`Image API error ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  }
  const item = json?.data?.[0];
  if (item?.b64_json) fs.writeFileSync(sheetFile, Buffer.from(item.b64_json, 'base64'));
  else if (item?.url) fs.writeFileSync(sheetFile, Buffer.from(await (await fetch(item.url)).arrayBuffer()));
  else throw new Error(`Image API returned no sheet: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);

  // Make the background transparent (or clean leftover chroma pockets if it already is).
  await removeBackground(sheetFile).catch(() => undefined);

  const outDir = path.join(projectDir(id), 'public', 'sprites', name);
  fs.rmSync(outDir, {recursive: true, force: true});
  const preview = path.join(projectDir(id), '.snapshots', `sprite-${name}-${Date.now()}.png`);
  const r = await runPy('sprite.py', {sheet: sheetFile, cols, rows, outDir, prefix: name, preview});
  fs.rmSync(sheetFile, {force: true});
  if (r.error) throw new Error(r.error);

  const frames = (r.frames as string[]).slice(0, n).map((f) => `sprites/${name}/${f}`);
  const sprite = {
    width: r.width,
    height: r.height,
    fps: Math.max(4, Math.min(24, input.fps ?? 10)),
    mode: input.mode ?? 'loop',
    frames,
  };
  writeFile(
    id,
    `src/sprites/${name}.ts`,
    `// Generated by the generate_sprite tool (${input.action}). Re-run the tool to redraw.\nimport type {SpriteData} from '@kit';\n\nconst sprite: SpriteData = ${JSON.stringify(sprite, null, 2)};\n\nexport default sprite;\n`,
  );
  emit({type: 'assets_changed', projectId: id});
  return {sprite, importPath: `./sprites/${name}`, preview: `.snapshots/${path.basename(preview)}`, frames: frames.length};
};
