import {useEffect, useRef} from 'react';
import type {ProjectSettings, CaptionSettings, VideoEntry} from '../../kit/settings';

export type {ProjectSettings, CaptionSettings, VideoEntry};
export type Project = ProjectSettings & {createdAt: number; updatedAt: number; providerId?: string; running?: boolean; entry?: string; thumb?: string};

export type Provider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  vision: boolean;
  maxTokens?: number;
  temperature?: number;
  oneToolPerTurn?: boolean;
};

export type Config = {
  providers: Provider[];
  activeProvider: string;
  imageGen: {baseURL: string; apiKey: string; model: string; size: string; providerId?: string};
  stock: {pexelsKey: string; unsplashKey: string};
  tts: {engine: 'edge' | 'gemini'; defaultVoice: string; rate: string; geminiKey: string; geminiModel: string; geminiVoice: string};
  render: {concurrency: number; quality: Quality};
  agent: {maxSteps: number; snapshotMaxSide: number};
  rig?: {providerId?: string; model?: string};
  facebook?: {pageId: string; pageToken: string; trendRegion?: string; aiLabel?: boolean};
};

export type Quality = 'draft' | 'standard' | 'high';

export type ToolCall = {id: string; name: string; arguments: string};
export type Message =
  | {id: string; ts: number; role: 'user'; content: string; images?: string[]; hidden?: boolean}
  | {id: string; ts: number; role: 'assistant'; content: string; reasoning?: string; tool_calls?: ToolCall[]; model?: string}
  | {
      id: string;
      ts: number;
      role: 'tool';
      tool_call_id: string;
      name: string;
      content: string;
      images?: string[];
      error?: boolean;
      display?: string;
      styles?: {id: string; name: string; description: string; file?: string; image?: string; voice?: string}[];
      questions?: {
        id: string;
        question: string;
        multiSelect?: boolean;
        options: {id: string; label: string; description?: string; recommended?: boolean}[];
      }[];
    }
  | {id: string; ts: number; role: 'error'; content: string};

export type FileEntry = {path: string; size: number; managed: boolean};
export type Asset = {path: string; size: number; kind: 'image' | 'video' | 'audio' | 'font' | 'data' | 'other'};
export type RenderJob = {
  jobId: string;
  projectId: string;
  status: 'bundling' | 'rendering' | 'done' | 'error' | 'cancelled';
  progress: number;
  quality: Quality;
  file?: string;
  files?: string[];
  videos?: {id: string; name: string}[];
  current?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};
export type ReelPost = {
  status: 'writing' | 'starting' | 'uploading' | 'processing' | 'publishing' | 'done' | 'error';
  progress: number;
  state: 'PUBLISHED' | 'DRAFT';
  description?: string;
  videoId?: string;
  url?: string;
  note?: string;
  error?: string;
  postedAt?: number;
};
export type RenderFile = {file: string; size: number; createdAt: number; videoName?: string; facebook?: ReelPost};


export type SubAccount = {id: string; kind: 'codex' | 'claude' | 'antigravity' | 'muse'; label: string; expiresAt: number; defaultModel: string};
export type LoginStatus =
  | {phase: 'awaiting_user'; message: string; url?: string; userCode?: string}
  | {phase: 'exchanging'; message: string}
  | {phase: 'done'; message: string; accountId: string; label: string}
  | {phase: 'error'; message: string};

const req = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
  const isForm = body instanceof FormData;
  const r = await fetch(url, {
    method,
    headers: body && !isForm ? {'Content-Type': 'application/json'} : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
};

const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export type UpdateResult = {ok: boolean; from: string; to: string; error?: string; at?: number};
export type VersionInfo = {version: string; root: string; lastUpdate: UpdateResult | null};
export type UpdateInfo = {
  current: string;
  latest?: string | null;
  available: boolean;
  notes?: string;
  url?: string | null;
  method?: 'git' | 'npm' | 'folder';
  canSelfUpdate?: boolean;
  command?: string;
  disabled?: boolean;
};

export const api = {
  version: () => req<VersionInfo>('GET', '/api/version'),
  checkUpdate: (force = false) => req<UpdateInfo>('GET', `/api/update${force ? '?force=1' : ''}`),
  startUpdate: () => req<{ok: boolean}>('POST', '/api/update', {}),
  config: () => req<Config>('GET', '/api/config'),
  saveConfig: (c: Config) => req<Config>('PUT', '/api/config', c),
  models: (b: {providerId?: string; baseURL: string; apiKey?: string}) => req<{models: string[]}>('POST', '/api/models', b),
  testVoice: async (text?: string) => {
    const r = await fetch('/api/tts/test', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return URL.createObjectURL(await r.blob());
  },
  voices: (locale = '') => req<{name: string; locale: string; gender: string}[]>('GET', `/api/voices?locale=${encodeURIComponent(locale)}`),

  projects: () => req<Project[]>('GET', '/api/projects'),
  createProject: (b: {name: string; width: number; height: number; fps: number; seconds: number}) => req<Project>('POST', '/api/projects', b),
  project: (id: string) => req<Project>('GET', P(id)),
  updateProject: (id: string, patch: Partial<Project>) => req<Project>('PATCH', P(id), patch),
  // Several videos per project (shared style and assets)
  createVideos: (id: string, items: {name?: string; theme?: string}[]) =>
    req<{project: Project; created: VideoEntry[]}>('POST', `${P(id)}/videos`, {items}),
  switchVideo: (id: string, vid: string) => req<Project>('POST', `${P(id)}/videos/${encodeURIComponent(vid)}/activate`),
  renameVideo: (id: string, vid: string, name: string) => req<Project>('PATCH', `${P(id)}/videos/${encodeURIComponent(vid)}`, {name}),
  deleteVideo: (id: string, vid: string) => req<Project>('DELETE', `${P(id)}/videos/${encodeURIComponent(vid)}`),
  deleteProject: (id: string) => req('DELETE', P(id)),

  files: (id: string) => req<FileEntry[]>('GET', `${P(id)}/files`),
  file: (id: string, path: string) => req<{content: string}>('GET', `${P(id)}/file?path=${encodeURIComponent(path)}`),
  saveFile: (id: string, path: string, content: string) => req('PUT', `${P(id)}/file`, {path, content}),
  deleteFile: (id: string, path: string) => req('DELETE', `${P(id)}/file?path=${encodeURIComponent(path)}`),
  check: (id: string) => req<{ok: boolean; errors: string[]; warnings: string[]}>('POST', `${P(id)}/check`),

  assets: (id: string) => req<Asset[]>('GET', `${P(id)}/assets`),
  upload: (id: string, files: File[], dir = '') => {
    const fd = new FormData();
    fd.append('dir', dir);
    for (const f of files) fd.append('files', f, f.name);
    return req<string[]>('POST', `${P(id)}/assets`, fd);
  },
  deleteAsset: (id: string, path: string) => req('DELETE', `${P(id)}/assets?path=${encodeURIComponent(path)}`),

  messages: (id: string) => req<{messages: Message[]; running: boolean}>('GET', `${P(id)}/messages`),
  clearMessages: (id: string) => req('DELETE', `${P(id)}/messages`),
  chat: (id: string, b: {text: string; images?: string[]; providerId?: string; editFrom?: string}) => req('POST', `${P(id)}/chat`, b),
  stop: (id: string) => req('POST', `${P(id)}/stop`),

  // Subscription logins (Codex / Claude Code / Antigravity / Muse Code)
  subscriptions: () => req<{accounts: SubAccount[]; running: string[]}>('GET', '/api/subscriptions'),
  disconnect: (id: string) => req('DELETE', `/api/subscriptions/${encodeURIComponent(id)}`),
  cancelLogin: (kind: string) => req('POST', `/api/subscriptions/${kind}/cancel`),
  /**
   * Start a login and stream progress. `onStatus` gets each phase; the promise
   * resolves on the terminal `done`/`error` status.
   */
  login: async (kind: string, onStatus: (s: LoginStatus) => void): Promise<void> => {
    const r = await fetch(`/api/subscriptions/${kind}/login`, {method: 'POST'});
    if (!r.body) throw new Error('Login stream unavailable');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const s = JSON.parse(line.slice(5).trim()) as LoginStatus;
          onStatus(s);
          if (s.phase === 'done' || s.phase === 'error') return;
        } catch {
          /* ignore */
        }
      }
    }
  },

  renders: (id: string) => req<{files: RenderFile[]; jobs: RenderJob[]}>('GET', `${P(id)}/renders`),
  render: (id: string, quality: Quality, videos?: string[] | 'all') =>
    req<RenderJob>('POST', `${P(id)}/render`, {quality, videos}),
  cancelRender: (jobId: string) => req('POST', `/api/renders/${jobId}/cancel`),
  deleteRender: (id: string, file: string) => req('DELETE', `${P(id)}/renders/${encodeURIComponent(file)}`),

  // Facebook Reels
  testFacebook: (pageId: string, pageToken: string) =>
    req<{id: string; name: string; warning?: string}>('POST', '/api/facebook/test', {pageId, pageToken}),
  /** One click: the server writes the caption with AI, then uploads and publishes. */
  postReel: (id: string, file: string) => req<ReelPost>('POST', `${P(id)}/renders/${encodeURIComponent(file)}/reel`, {}),
};

export const publicUrl = (id: string, rel: string) => `/ws/${id}/public/${rel.split('/').map(encodeURIComponent).join('/')}`;
/** URL for a project-relative path such as ".snapshots/x.jpg" or "public/a.png". */
export const projectUrl = (id: string, rel: string) => `/ws/${id}/${rel.split('/').map(encodeURIComponent).join('/')}`;

export type ServerEvent = {type: string; projectId?: string; [k: string]: any};

/** Subscribe to server-sent events for one project. */
export const useEvents = (projectId: string | null, onEvent: (e: ServerEvent) => void) => {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    if (!projectId) return;
    const es = new EventSource(`/api/events?project=${encodeURIComponent(projectId)}`);
    es.onmessage = (m) => {
      try {
        ref.current(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [projectId]);
};

/** Timecode like 00:04.20 (minutes:seconds.hundredths). */
export const timecode = (frame: number, fps: number) => {
  const t = frame / fps;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const PRESETS = [
  {label: '16:9', sub: 'YouTube', width: 1920, height: 1080},
  {label: '9:16', sub: 'Reels / TikTok', width: 1080, height: 1920},
  {label: '1:1', sub: 'Square', width: 1080, height: 1080},
  {label: '4:5', sub: 'Feed', width: 1080, height: 1350},
];
