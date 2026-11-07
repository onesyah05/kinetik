import fs from 'node:fs';
import path from 'node:path';
import {getConfig, getProvider} from './config';
import {ROOT, python} from './paths';
import {run} from './tts';
import {emit} from './events';
import {getProject, projectDir, safeAssetName} from './projects';

export const savePublic = (id: string, rel: string, buf: Buffer) => {
  const clean = safeAssetName(rel);
  if (!clean) throw new Error('Invalid file name');
  const file = path.join(projectDir(id), 'public', clean);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, buf);
  emit({type: 'assets_changed', projectId: id});
  return clean;
};

const EXT: [string, string][] = [
  ['png', '.png'],
  ['jpeg', '.jpg'],
  ['jpg', '.jpg'],
  ['webp', '.webp'],
  ['svg', '.svg'],
  ['gif', '.gif'],
  ['mp4', '.mp4'],
  ['webm', '.webm'],
  ['mpeg', '.mp3'],
  ['wav', '.wav'],
];
const extFromType = (t: string | null) => EXT.find(([k]) => t?.includes(k))?.[1] ?? '';

/** Download a URL into public/. Adds an extension from the content-type if missing. */
export const downloadAsset = async (id: string, url: string, filename: string) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs are supported');
  const res = await fetch(url, {headers: {'User-Agent': 'Kinetik/0.1'}});
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 300 * 1024 * 1024) throw new Error('File is larger than 300 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  let name = filename;
  if (!path.extname(name)) name += extFromType(res.headers.get('content-type'));
  return {path: savePublic(id, name, buf), bytes: buf.length};
};

/** `imageGen.providerId` value meaning "use whatever the project chats with". */
export const IMAGE_AUTO = 'auto';
/** Subscription accounts that can draw (Codex image tool, Antigravity Gemini image). */
const canDraw = (id: string) => id.startsWith('sub:codex:') || id.startsWith('sub:antigravity:');

/**
 * Endpoint + key for image generation. In auto mode it follows the project's chat
 * provider when that account can draw, else any connected account that can;
 * otherwise a named provider or the endpoint's own settings.
 */
export const imageGenTarget = (projectId?: string) => {
  const c = getConfig();
  const cfg = c.imageGen;
  let p = cfg.providerId && cfg.providerId !== IMAGE_AUTO ? c.providers.find((x) => x.id === cfg.providerId) : undefined;
  if (cfg.providerId === IMAGE_AUTO) {
    let chatId: string | undefined;
    try {
      chatId = projectId ? getProject(projectId).providerId : undefined;
    } catch {
      /* project gone */
    }
    const chat = getProvider(chatId);
    p = chat && canDraw(chat.id) ? chat : c.providers.find((x) => canDraw(x.id));
  }
  const baseURL = (p?.baseURL ?? cfg.baseURL).replace(/\/$/, '');
  const apiKey = p?.apiKey ?? cfg.apiKey;
  const ready = !!cfg.model && (!!apiKey || /localhost|127\.0\.0\.1/.test(baseURL));
  return {baseURL, apiKey, model: cfg.model, size: cfg.size, ready, via: p?.name};
};

const BG_SCRIPT = path.join(ROOT, 'server', 'bgremove.py');

/** Make a flat background transparent and trim the empty margin. */
export const removeBackground = async (file: string) => {
  const out = await run(python(), [BG_SCRIPT, file, file, '--trim']);
  return JSON.parse(out) as {ok: boolean; removed: number; reason?: string};
};

/** POST /images/edits with a reference image (keeps a character consistent across poses). */
const editWithReference = async (t: ReturnType<typeof imageGenTarget>, prompt: string, size: string, refFile: string) => {
  const fd = new FormData();
  fd.append('model', t.model);
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('n', '1');
  fd.append('image', new Blob([fs.readFileSync(refFile)], {type: 'image/png'}), path.basename(refFile));
  const res = await fetch(`${t.baseURL}/images/edits`, {method: 'POST', headers: {Authorization: `Bearer ${t.apiKey}`}, body: fd});
  const json: any = await res.json().catch(() => ({}));
  return {res, json};
};

export const generateImage = async (
  id: string,
  input: {prompt: string; filename: string; size?: string; transparent?: boolean; reference?: string},
) => {
  const t = imageGenTarget(id);
  if (!t.ready) throw new Error('Image generation is not configured (Settings → Image generation).');
  const transparent = input.transparent !== false;
  // Ask for a flat backdrop we can key out locally; many gateways ignore `background: transparent`.
  const prompt = transparent
    ? `${input.prompt}\n\nIsolated single subject, centered with margin, on a perfectly flat solid pure #00FF00 green background. No shadow on the ground, no scenery, no text, no border.`
    : input.prompt;
  const size = input.size || t.size;

  let res: Response | null = null;
  let json: any = {};
  let usedReference = false;
  if (input.reference) {
    const refFile = path.join(projectDir(id), 'public', safeAssetName(input.reference.replace(/^\/?(public\/)?/, '')));
    if (!fs.existsSync(refFile)) throw new Error(`Reference not found: public/${input.reference}`);
    const r = await editWithReference(
      t,
      `Use the attached image as the reference character: keep the exact same character design, colours, proportions and art style.\n\n${prompt}`,
      size,
      refFile,
    ).catch(() => null);
    // Fall back to a plain generation if the gateway has no edits endpoint.
    if (r?.res.ok) {
      res = r.res;
      json = r.json;
      usedReference = true;
    }
  }
  if (!res) {
    const body: Record<string, unknown> = {model: t.model, prompt, size, n: 1};
    if (transparent && /gpt-image/i.test(t.model)) Object.assign(body, {background: 'transparent', output_format: 'png'});
    res = await fetch(`${t.baseURL}/images/generations`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}`},
      body: JSON.stringify(body),
    }).catch((e: Error) => {
      throw new Error(`Cannot reach the image endpoint ${t.baseURL} (${e.message}). Check Settings → Image generation, or restart the app if you just changed it.`);
    });
    json = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(`Image API error ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 400)}`);
  if (input.reference && !usedReference) json.__note = 'reference not supported by the image endpoint, generated without it';
  const item = json?.data?.[0];
  let name = input.filename.replace(/\.(jpe?g|webp)$/i, '.png');
  if (!path.extname(name)) name += '.png';
  let raw: Buffer;
  if (item?.b64_json) raw = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`Image download failed: HTTP ${r.status}`);
    raw = Buffer.from(await r.arrayBuffer());
  } else throw new Error('Image API returned no image');

  // Work in a private temp folder so the preview never sees the unprocessed (green) image.
  const tmpDir = path.join(projectDir(id), '.tmp');
  fs.mkdirSync(tmpDir, {recursive: true});
  const stamp = `${Date.now()}`;
  const rawFile = path.join(tmpDir, `${stamp}-raw`);
  const pngFile = path.join(tmpDir, `${stamp}.png`);
  let note = '';
  try {
    fs.writeFileSync(rawFile, raw);
    // Normalise to PNG (some APIs return JPEG/WebP bytes).
    await run('ffmpeg', ['-y', '-v', 'error', '-i', rawFile, pngFile]);
    if (transparent) {
      const r = await removeBackground(pngFile);
      note = r.ok ? `background removed (${Math.round(r.removed * 100)}% transparent)` : `background NOT removed: ${r.reason}`;
    }
    const rel = savePublic(id, name, fs.readFileSync(pngFile));
    if (json.__note) note = note ? `${note}; ${json.__note}` : json.__note;
    else if (usedReference) note = note ? `${note}; matched to reference` : 'matched to reference';
    return {path: rel, note};
  } finally {
    fs.rmSync(rawFile, {force: true});
    fs.rmSync(pngFile, {force: true});
  }
};

/** Save an SVG the agent drew into public/ and rasterise it to a transparent PNG next to it. */
export const createVectorAsset = async (id: string, input: {filename: string; svg: string; width?: number}) => {
  const {Resvg} = await import('@resvg/resvg-js');
  const base = safeAssetName(input.filename).replace(/\.(svg|png)$/i, '');
  if (!base) throw new Error('Invalid filename');
  if (!/<svg[\s>]/i.test(input.svg)) throw new Error('svg must be a complete <svg> document');
  let svg = input.svg.trim();
  if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const png = new Resvg(svg, {fitTo: {mode: 'width', value: Math.min(2048, Math.max(64, input.width ?? 1024))}, background: 'rgba(0,0,0,0)'})
    .render()
    .asPng();
  const svgPath = savePublic(id, `${base}.svg`, Buffer.from(svg, 'utf8'));
  const pngPath = savePublic(id, `${base}.png`, Buffer.from(png));
  return {svg: svgPath, png: pngPath};
};

export type StockItem = {
  source: 'pexels' | 'unsplash';
  type: 'photo' | 'video';
  id: string;
  description: string;
  width: number;
  height: number;
  duration?: number;
  preview: string;
  download: string;
  credit: string;
};

export const searchStock = async (input: {
  query: string;
  type?: 'photo' | 'video';
  orientation?: 'landscape' | 'portrait' | 'square';
  count?: number;
}) => {
  const cfg = getConfig().stock;
  const type = input.type ?? 'photo';
  const n = Math.min(15, input.count ?? 8);
  const out: StockItem[] = [];
  const errors: string[] = [];

  if (cfg.pexelsKey) {
    try {
      const qs = new URLSearchParams({query: input.query, per_page: String(n)});
      if (input.orientation) qs.set('orientation', input.orientation);
      const url = type === 'video' ? `https://api.pexels.com/videos/search?${qs}` : `https://api.pexels.com/v1/search?${qs}`;
      const r = await fetch(url, {headers: {Authorization: cfg.pexelsKey}});
      if (!r.ok) throw new Error(`Pexels HTTP ${r.status}`);
      const j: any = await r.json();
      if (type === 'video') {
        for (const v of j.videos ?? []) {
          // Prefer a file close to 1080p to keep renders light.
          const files = (v.video_files ?? [])
            .filter((f: any) => f.file_type === 'video/mp4')
            .sort((a: any, b: any) => Math.abs((a.height ?? 0) - 1080) - Math.abs((b.height ?? 0) - 1080));
          if (!files[0]) continue;
          out.push({
            source: 'pexels',
            type,
            id: String(v.id),
            description: v.url?.split('/').filter(Boolean).pop() ?? '',
            width: files[0].width,
            height: files[0].height,
            duration: v.duration,
            preview: v.image,
            download: files[0].link,
            credit: `Video by ${v.user?.name} on Pexels`,
          });
        }
      } else {
        for (const p of j.photos ?? []) {
          out.push({
            source: 'pexels',
            type,
            id: String(p.id),
            description: p.alt ?? '',
            width: p.width,
            height: p.height,
            preview: p.src?.medium,
            download: p.src?.large2x ?? p.src?.original,
            credit: `Photo by ${p.photographer} on Pexels`,
          });
        }
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  if (cfg.unsplashKey && type === 'photo') {
    try {
      const qs = new URLSearchParams({query: input.query, per_page: String(n)});
      if (input.orientation) qs.set('orientation', input.orientation === 'square' ? 'squarish' : input.orientation);
      const r = await fetch(`https://api.unsplash.com/search/photos?${qs}`, {
        headers: {Authorization: `Client-ID ${cfg.unsplashKey}`},
      });
      if (!r.ok) throw new Error(`Unsplash HTTP ${r.status}`);
      const j: any = await r.json();
      for (const p of j.results ?? []) {
        out.push({
          source: 'unsplash',
          type,
          id: p.id,
          description: p.alt_description ?? p.description ?? '',
          width: p.width,
          height: p.height,
          preview: p.urls?.small,
          download: `${p.urls?.raw}&w=2160&q=85&fm=jpg`,
          credit: `Photo by ${p.user?.name} on Unsplash`,
        });
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  if (!cfg.pexelsKey && !cfg.unsplashKey) errors.push('No stock API key configured (Settings → Stock media). Pexels keys are free.');
  return {results: out, errors};
};
