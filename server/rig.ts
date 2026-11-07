/**
 * Rig a character image into puppet layers (body + moving parts like wings, tail, head, arms)
 * so <Puppet> from '@kit' can animate each part around its joint.
 * Parts are found with Gemini segmentation (uses the Gemini key from Settings → Voiceover).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getConfig} from './config';
import {ROOT, python} from './paths';
import {getProject, projectDir, projectProvider, safeAssetName, writeFile} from './projects';
import {emit} from './events';


const runJson = (args: string[], stdin: string) =>
  new Promise<any>((resolve, reject) => {
    const p = spawn(python(), args, {windowsHide: true});
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `rig.py exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`rig.py returned invalid output: ${out.slice(0, 200)}`));
      }
    });
    p.stdin.end(stdin);
  });

type SegItem = {label: string; box_2d: [number, number, number, number]; mask: string};

type Box = {label: string; box_2d: [number, number, number, number]; role?: 'part' | 'context'};

/** Body regions that must stay still; their boxes tell GrabCut what is NOT a moving part. */
const CONTEXT = ['torso', 'left arm', 'right arm', 'left leg', 'right leg'];

const parseJsonList = (text: string) => {
  const body = text.includes('```') ? text.replace(/^[\s\S]*?```(?:json)?/, '').replace(/```[\s\S]*$/, '') : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body.trim());
};

/** 1st choice: precise masks straight from the Gemini API (free tier is ~20 requests/day). */
const geminiMasks = async (file: string, parts: string[]): Promise<SegItem[] | null> => {
  const key = getConfig().tts.geminiKey;
  if (!key) return null;
  const prompt = `Give the segmentation masks for these parts of the character: ${parts
    .map((p) => `"${p}"`)
    .join(', ')}. "left" and "right" mean the left and right side of the image. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label" (use exactly the names given).`;
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash']) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({
        contents: [{parts: [{inlineData: {mimeType: 'image/png', data: fs.readFileSync(file).toString('base64')}}, {text: prompt}]}],
        generationConfig: {thinkingConfig: {thinkingBudget: 0}},
      }),
    }).catch(() => null);
    if (!res) return null;
    if (res.status === 429) return null; // daily quota used up: go straight to the fallback
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const j: any = await res.json().catch(() => ({}));
    try {
      const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      const items = (parseJsonList(text) as SegItem[]).filter((i) => Array.isArray(i?.box_2d) && i.label);
      if (items.some((i) => (i.mask ?? '').length > 100)) return items;
    } catch {
      /* try again */
    }
  }
  return null;
};

/** Fallback: bounding boxes from a vision model through the LLM provider (no daily quota), masks via local GrabCut. */
const proxyBoxes = async (projectId: string, file: string, labels: string[]): Promise<Box[]> => {
  const c = getConfig();
  // The rig setting wins; otherwise the provider this project chats with (the global default may be offline).
  const provider = (c.rig?.providerId && c.providers.find((x) => x.id === c.rig?.providerId)) || projectProvider(projectId);
  if (!provider) throw new Error('No LLM provider configured for part detection.');
  const model = c.rig?.model || provider.model;
  const res = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`},
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {type: 'image_url', image_url: {url: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`}},
            {
              type: 'text',
              text: `Detect these parts of the character: ${labels
                .map((x) => `"${x}"`)
                .join(', ')}. "left"/"right" = left/right side of the image. Return only a JSON list with "label" (exactly as given) and "box_2d" [ymin, xmin, ymax, xmax] normalized to 0-1000, tight around each visible part. Skip parts that are not visible.`,
            },
          ],
        },
      ],
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Part detection failed (${model}): HTTP ${res.status} ${String(j?.error?.message ?? '').slice(0, 200)}`);
  const text: string = j?.choices?.[0]?.message?.content ?? '';
  try {
    return (parseJsonList(text) as Box[]).filter((b) => Array.isArray(b?.box_2d) && b.box_2d.length === 4 && b.label);
  } catch {
    throw new Error(`Part detection returned no boxes (${model}). Set a vision model in Settings → Rigging.`);
  }
};

/** Masks where Gemini provides them, boxes + GrabCut for the rest. Returns items for rig.py and how they were made. */
const segment = async (projectId: string, file: string, parts: string[]) => {
  const masks = (await geminiMasks(file, parts)) ?? [];
  const withMask = masks.filter((m) => (m.mask ?? '').length > 100);
  const missing = parts.filter((p) => !withMask.some((m) => m.label.toLowerCase() === p.toLowerCase()));
  const items: (SegItem | Box)[] = withMask.map((m) => ({...m, role: 'part' as const}));
  let method = withMask.length ? 'gemini masks' : '';
  if (missing.length || !withMask.length) {
    const boxes = await proxyBoxes(projectId, file, [...missing, ...CONTEXT.filter((c) => !parts.includes(c))]);
    for (const b of boxes) {
      const isContext = CONTEXT.includes(b.label.toLowerCase()) && !parts.some((p) => p.toLowerCase() === b.label.toLowerCase());
      items.push({...b, role: isContext ? 'context' : 'part'});
    }
    method = method ? `${method} + boxes/GrabCut for ${missing.join(', ')}` : 'boxes + local GrabCut';
  }
  return {items, method};
};

const defaultMotion = (name: string) => {
  const n = name.toLowerCase();
  if (/wing|sayap/.test(n)) return {type: 'flap', z: 'back'};
  if (/tail|ekor/.test(n)) return {type: 'wag', z: 'back'};
  if (/head|kepala/.test(n)) return {type: 'nod', z: 'front'};
  if (/arm|hand|paw|tangan|lengan/.test(n)) return {type: 'wave', z: 'front'};
  if (/ear|telinga/.test(n)) return {type: 'sway', z: 'front'};
  return {type: 'sway', z: 'front'};
};

export const rigCharacter = async (id: string, input: {src: string; name: string; parts: string[]}) => {
  const src = safeAssetName(input.src.replace(/^\/?(public\/)?/, ''));
  const file = path.join(projectDir(id), 'public', src);
  if (!fs.existsSync(file)) throw new Error(`Not found: public/${src}`);
  const name = safeAssetName(input.name).replace(/\//g, '-') || 'character';
  const parts = input.parts.map((p) => p.trim()).filter(Boolean).slice(0, 8);
  if (!parts.length) throw new Error('Name at least one part to animate, e.g. ["left wing", "right wing", "tail"].');

  const outDir = path.join(projectDir(id), 'public', 'rigs', name);
  const {items, method} = await segment(id, file, parts);
  fs.rmSync(outDir, {recursive: true, force: true});
  const r = await runJson([path.join(ROOT, 'server', 'rig.py')], JSON.stringify({image: file, outDir, prefix: name, items}));

  const rig = {
    width: r.width,
    height: r.height,
    body: `rigs/${name}/${r.body}`,
    parts: r.parts.map((p: any) => {
      const m = defaultMotion(p.name);
      return {name: p.name, src: `rigs/${name}/${p.file}`, pivot: p.pivot, box: p.box, z: m.z, motion: m.type};
    }),
  };
  const moduleRel = `src/rigs/${name}.ts`;
  writeFile(
    id,
    moduleRel,
    `// Generated by the rig_character tool from public/${src}. Re-run the tool to change the cut.\nimport type {Rig} from '@kit';\n\nconst rig: Rig = ${JSON.stringify(rig, null, 2)};\n\nexport default rig;\n`,
  );
  emit({type: 'assets_changed', projectId: id});
  // Debug view for the agent: the cut layers over a grid with the joints marked.
  let debug: string | undefined;
  try {
    const dbgDir = path.join(projectDir(id), '.snapshots');
    fs.mkdirSync(dbgDir, {recursive: true});
    const dbgName = `rig-${name}-${Date.now()}.png`;
    await runJson(
      [path.join(ROOT, 'server', 'rig.py'), '--debug'],
      JSON.stringify({outDir: path.join(projectDir(id), 'public', 'rigs', name), body: r.body, parts: r.parts, out: path.join(dbgDir, dbgName)}),
    );
    debug = `.snapshots/${dbgName}`;
  } catch {
    /* debug image is optional */
  }
  const missing = parts.filter((p) => !rig.parts.some((x: any) => x.name.toLowerCase() === p.toLowerCase()));
  return {rig, module: moduleRel, importPath: `./rigs/${name}`, missing, debug, method};
};
