import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {TEMPLATE, WORKSPACE, safeJoin, toPosix} from './paths';
import {emit} from './events';
import type {ProjectSettings, VideoEntry} from '../kit/settings';
import {defaultCaptions} from '../kit/settings';

export type Project = ProjectSettings & {createdAt: number; updatedAt: number; providerId?: string};

/** Files the agent/user may not touch. */
const MANAGED = new Set(['src/index.ts', 'src/Root.tsx', 'project.json', 'chat.json']);
const HIDDEN_DIRS = new Set(['renders', '.snapshots', '.tmp', 'node_modules']);

export const projectDir = (id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid project id');
  return path.join(WORKSPACE, id);
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'video';

/** Latest snapshot the agent rendered, used as the project thumbnail. */
const latestThumb = (id: string): string | undefined => {
  const dir = path.join(projectDir(id), '.snapshots');
  if (!fs.existsSync(dir)) return undefined;
  const last = fs.readdirSync(dir).filter((f) => /^\d+-f\d+\.jpg$/.test(f)).sort().at(-1);
  return last ? `.snapshots/${last}` : undefined;
};

export const listProjects = (): (Project & {thumb?: string})[] => {
  fs.mkdirSync(WORKSPACE, {recursive: true});
  return fs
    .readdirSync(WORKSPACE, {withFileTypes: true})
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(WORKSPACE, d.name, 'project.json')))
    .map((d) => ({...getProject(d.name), thumb: latestThumb(d.name)}))
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const getProject = (id: string): Project => {
  const p = JSON.parse(fs.readFileSync(path.join(projectDir(id), 'project.json'), 'utf8')) as Project;
  p.captions = {...defaultCaptions, ...p.captions};
  return p;
};

const copyDir = (from: string, to: string) => {
  fs.mkdirSync(to, {recursive: true});
  for (const e of fs.readdirSync(from, {withFileTypes: true})) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
};

export const createProject = (input: {name: string; width?: number; height?: number; fps?: number; seconds?: number}): Project => {
  const id = `${slug(input.name)}-${randomBytes(2).toString('hex')}`;
  const dir = projectDir(id);
  copyDir(TEMPLATE, dir);
  fs.mkdirSync(path.join(dir, 'public'), {recursive: true});
  const fps = input.fps ?? 30;
  const now = Date.now();
  const project: Project = {
    id,
    name: input.name || 'Untitled',
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    fps,
    durationInFrames: Math.round((input.seconds ?? 10) * fps),
    captions: {...defaultCaptions},
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  return project;
};

export const updateProject = (id: string, patch: Partial<Project>): Project => {
  const cur = getProject(id);
  const next: Project = {
    ...cur,
    ...patch,
    captions: {...cur.captions, ...(patch.captions ?? {})},
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
  };
  for (const k of ['width', 'height'] as const) {
    next[k] = Math.max(16, Math.round(next[k] / 2) * 2); // h264 needs even sizes
  }
  next.fps = Math.max(1, Math.min(120, Math.round(next.fps)));
  next.durationInFrames = Math.max(1, Math.round(next.durationInFrames));
  // Keep the active video's stored length in step with the top-level duration.
  if (next.videos?.length) {
    const active = activeVideoId(next);
    next.videos = next.videos.map((v) => (v.id === active ? {...v, durationInFrames: next.durationInFrames} : v));
  }
  fs.writeFileSync(path.join(projectDir(id), 'project.json'), JSON.stringify(next, null, 2));
  emit({type: 'project_updated', projectId: id, project: {...next, entry: previewEntry(id, next)}});
  return next;
};

// ---------- Videos (several per project, sharing style and assets) ----------

export const MAIN_VIDEO = 'main';
export const activeVideoId = (p: Project) => p.activeVideo ?? MAIN_VIDEO;
/** Folder of a video's own sources, relative to the project. */
export const videoDirRel = (vid: string) => (vid === MAIN_VIDEO ? 'src' : `src/videos/${vid}`);
/** Entry file of a video, relative to the project. */
export const videoEntryRel = (vid: string) => `${videoDirRel(vid)}/Video.tsx`;
/** All videos, with the top-level duration standing in for the active one. */
export const videosOf = (p: Project): VideoEntry[] => {
  const list = p.videos?.length ? p.videos : [{id: MAIN_VIDEO, name: p.name, durationInFrames: p.durationInFrames}];
  return list.map((v) => (v.id === activeVideoId(p) ? {...v, durationInFrames: p.durationInFrames} : v));
};
/** Module URL Vite serves for the live preview of the active video. */
export const previewEntry = (id: string, p: Project = getProject(id)) =>
  `/@fs/${toPosix(path.join(projectDir(id), videoEntryRel(activeVideoId(p)))).replace(/^\//, '')}`;

/** Root.tsx registers every video and renders the active one, so render and snapshot work unchanged. */
const writeRoot = (id: string, videos: VideoEntry[]) => {
  const imports = videos.map((v, i) => `import {Video as V${i}} from '${videoEntryRel(v.id).replace(/^src/, '.').replace(/\.tsx$/, '')}';`);
  const map = videos.map((v, i) => `  ${JSON.stringify(v.id)}: V${i},`);
  const src = [
    '// Managed by Kinetik. Do not edit.',
    '// Size/fps/duration/captions come from project.json, passed in as props at render time.',
    '// One project can hold several videos; settings.activeVideo picks which one renders.',
    "import React from 'react';",
    "import {Composition} from 'remotion';",
    "import {KitRoot, type ProjectSettings} from '@kit';",
    "import project from '../project.json';",
    ...imports,
    '',
    'const VIDEOS: Record<string, React.FC> = {',
    ...map,
    '};',
    '',
    'const Main: React.FC<{settings: ProjectSettings}> = ({settings}) => {',
    "  const V = VIDEOS[settings.activeVideo ?? 'main'] ?? V0;",
    '  return (',
    '    <KitRoot settings={settings}>',
    '      <V />',
    '    </KitRoot>',
    '  );',
    '};',
    '',
    'export const Root: React.FC = () => (',
    '  <Composition',
    '    id="main"',
    '    component={Main}',
    '    width={project.width}',
    '    height={project.height}',
    '    fps={project.fps}',
    '    durationInFrames={project.durationInFrames}',
    '    defaultProps={{settings: project as unknown as ProjectSettings}}',
    '    calculateMetadata={({props}) => ({',
    '      width: props.settings.width,',
    '      height: props.settings.height,',
    '      fps: props.settings.fps,',
    '      durationInFrames: props.settings.durationInFrames,',
    '    })}',
    '  />',
    ');',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projectDir(id), 'src', 'Root.tsx'), src);
};

const videoSlug = (s: string) => slug(s).slice(0, 20).replace(/-$/, '') || 'video';

/** Add videos (a starter scene each) without switching to them. */
export const createVideos = (id: string, items: {name?: string; theme?: string}[]): {project: Project; created: VideoEntry[]} => {
  const p = getProject(id);
  const videos = videosOf(p);
  const created: VideoEntry[] = [];
  const starter = fs.readFileSync(path.join(TEMPLATE, 'src', 'Video.tsx'), 'utf8');
  for (const it of items) {
    const name = (it.name || it.theme || 'New video').trim().slice(0, 80);
    let vid = '';
    do vid = `${videoSlug(name)}-${randomBytes(2).toString('hex')}`;
    while (videos.some((v) => v.id === vid));
    const file = path.join(projectDir(id), videoEntryRel(vid));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, starter);
    const v: VideoEntry = {id: vid, name, durationInFrames: Math.round(10 * p.fps), ...(it.theme?.trim() ? {theme: it.theme.trim().slice(0, 500)} : {})};
    videos.push(v);
    created.push(v);
  }
  writeRoot(id, videos);
  emit({type: 'files_changed', projectId: id});
  return {project: updateProject(id, {videos}), created};
};

/** Make another video the active one (preview, agent tools and render follow it). */
export const switchVideo = (id: string, vid: string): Project => {
  const p = getProject(id);
  const videos = videosOf(p);
  const target = videos.find((v) => v.id === vid);
  if (!target) throw new Error(`No video "${vid}" in this project. Videos: ${videos.map((v) => v.id).join(', ')}`);
  if (activeVideoId(p) === vid) return p;
  return updateProject(id, {videos, activeVideo: vid, durationInFrames: target.durationInFrames});
};

export const renameVideo = (id: string, vid: string, name: string): Project => {
  const videos = videosOf(getProject(id)).map((v) => (v.id === vid ? {...v, name: name.trim().slice(0, 80) || v.name} : v));
  return updateProject(id, {videos});
};

/** Delete a video and its folder. The first video (src/Video.tsx) always stays. */
export const deleteVideo = (id: string, vid: string): Project => {
  if (vid === MAIN_VIDEO) throw new Error('The first video cannot be deleted.');
  const p = getProject(id);
  const videos = videosOf(p).filter((v) => v.id !== vid);
  const main = videos.find((v) => v.id === MAIN_VIDEO)!;
  const patch: Partial<Project> = {videos};
  if (activeVideoId(p) === vid) Object.assign(patch, {activeVideo: MAIN_VIDEO, durationInFrames: main.durationInFrames});
  const next = updateProject(id, patch);
  fs.rmSync(path.join(projectDir(id), videoDirRel(vid)), {recursive: true, force: true});
  writeRoot(id, videos);
  emit({type: 'files_changed', projectId: id});
  return next;
};

export const touchProject = (id: string) => {
  try {
    const file = path.join(projectDir(id), 'project.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    p.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
  } catch {
    /* ignore */
  }
};

export const deleteProject = (id: string) => {
  fs.rmSync(projectDir(id), {recursive: true, force: true});
};

// ---------- Files ----------

export type FileEntry = {path: string; size: number; managed: boolean};

const walk = (base: string, rel = ''): FileEntry[] => {
  const out: FileEntry[] = [];
  const dir = path.join(base, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!HIDDEN_DIRS.has(e.name)) out.push(...walk(base, r));
    } else {
      out.push({path: r, size: fs.statSync(path.join(base, r)).size, managed: MANAGED.has(r)});
    }
  }
  return out;
};

/** Source files (everything except public assets, renders, and chat). */
export const listSourceFiles = (id: string) =>
  walk(projectDir(id)).filter((f) => !f.path.startsWith('public/') && f.path !== 'chat.json');

export const readFile = (id: string, rel: string) => fs.readFileSync(safeJoin(projectDir(id), rel), 'utf8');

export const assertWritable = (rel: string) => {
  const r = toPosix(rel).replace(/^\.?\//, '');
  if (MANAGED.has(r)) throw new Error(`${r} is managed by Kinetik and cannot be edited. Use update_project for settings.`);
  if (!r.startsWith('src/') && !r.startsWith('public/')) throw new Error('Only files under src/ or public/ can be written.');
  return r;
};

export const writeFile = (id: string, rel: string, content: string | Buffer) => {
  const r = assertWritable(rel);
  const file = safeJoin(projectDir(id), r);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  touchProject(id);
  emit({type: 'files_changed', projectId: id, paths: [r]});
  return r;
};

export const deleteFile = (id: string, rel: string) => {
  const r = assertWritable(rel);
  if (r === 'src/Video.tsx') throw new Error('src/Video.tsx is the entry scene and cannot be deleted.');
  fs.rmSync(safeJoin(projectDir(id), r), {force: true});
  emit({type: 'files_changed', projectId: id, paths: [r]});
  return r;
};

// ---------- Assets (public/) ----------

export type Asset = {path: string; size: number; kind: 'image' | 'video' | 'audio' | 'font' | 'data' | 'other'};

export const assetKind = (p: string): Asset['kind'] => {
  const ext = path.extname(p).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) return 'font';
  if (['.json', '.csv', '.txt'].includes(ext)) return 'data';
  return 'other';
};

export const listAssets = (id: string): Asset[] =>
  walk(path.join(projectDir(id), 'public')).map((f) => ({path: f.path, size: f.size, kind: assetKind(f.path)}));

export const safeAssetName = (name: string) =>
  name
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[^a-zA-Z0-9._-]+/g, '-'))
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');

// ---------- Renders ----------

export const rendersDir = (id: string) => path.join(projectDir(id), 'renders');

export const listRenders = (id: string) => {
  const dir = rendersDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.gif'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return {file: f, size: st.size, createdAt: st.mtimeMs};
    })
    .sort((a, b) => b.createdAt - a.createdAt);
};
