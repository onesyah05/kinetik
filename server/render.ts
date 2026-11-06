import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureBrowser,
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type BrowserLog,
} from '@remotion/renderer';
import {getServeUrl} from './bundle';
import {getConfig} from './config';
import {emit} from './events';
import {getProject, projectDir, rendersDir} from './projects';

// ---------- Shared headless browser (closed when idle to free RAM) ----------

type Browser = Awaited<ReturnType<typeof openBrowser>>;
let browser: Promise<Browser> | null = null;
let users = 0;
let idleTimer: NodeJS.Timeout | null = null;

const acquireBrowser = async (): Promise<Browser> => {
  users++;
  if (idleTimer) clearTimeout(idleTimer);
  if (!browser) {
    browser = (async () => {
      await ensureBrowser();
      return openBrowser('chrome');
    })();
    browser.catch(() => (browser = null));
  }
  return browser;
};

const releaseBrowser = () => {
  users = Math.max(0, users - 1);
  if (users === 0) {
    idleTimer = setTimeout(async () => {
      const b = browser;
      browser = null;
      if (b) (await b.catch(() => null))?.close({silent: true}).catch(() => undefined);
    }, 90_000);
  }
};

export const warmupBrowser = () => ensureBrowser().catch((e) => console.warn('[render] browser download failed:', e?.message));

const inputPropsFor = (id: string) => ({settings: getProject(id)});

const logCollector = () => {
  const logs: string[] = [];
  return {
    logs,
    onBrowserLog: (l: BrowserLog) => {
      if (l.type === 'error' || l.type === 'warning') logs.push(`[${l.type}] ${l.text}`.slice(0, 500));
    },
  };
};

// ---------- Snapshots ----------

export type SnapshotResult = {files: string[]; logs: string[]; width: number; height: number};

/** Renders the given frames as JPEGs into .snapshots/ and returns their project-relative paths. */
export const renderSnapshots = async (id: string, frames: number[]): Promise<SnapshotResult> => {
  const project = getProject(id);
  const t0 = Date.now();
  const browserP = acquireBrowser();
  browserP.catch(() => undefined); // avoid an unhandled rejection if bundling fails first
  const {logs, onBrowserLog} = logCollector();
  try {
    // Bundle and browser start in parallel.
    const [serveUrl, b] = await Promise.all([getServeUrl(id), browserP]);
    const t1 = Date.now();
    const inputProps = inputPropsFor(id);
    const composition = await selectComposition({serveUrl, id: 'main', inputProps, puppeteerInstance: b, onBrowserLog});
    const maxSide = getConfig().agent.snapshotMaxSide || 768;
    const scale = Math.min(1, maxSide / Math.max(project.width, project.height));
    const dir = path.join(projectDir(id), '.snapshots');
    fs.mkdirSync(dir, {recursive: true});
    pruneSnapshots(dir);
    const stamp = Date.now();
    const files: string[] = [];
    const uniq = [...new Set(frames.map((f) => Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(f)))))];
    for (const frame of uniq.slice(0, 8)) {
      const name = `${stamp}-f${frame}.jpg`;
      await renderStill({
        composition,
        serveUrl,
        frame,
        output: path.join(dir, name),
        imageFormat: 'jpeg',
        jpegQuality: 75,
        scale,
        inputProps,
        puppeteerInstance: b,
        onBrowserLog,
      });
      files.push(`.snapshots/${name}`);
    }
    console.log(`[snapshot] ${id}: bundle+browser ${((t1 - t0) / 1000).toFixed(1)}s, ${files.length} frames ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    return {files, logs: [...new Set(logs)].slice(0, 20), width: Math.round(project.width * scale), height: Math.round(project.height * scale)};
  } finally {
    releaseBrowser();
  }
};

const pruneSnapshots = (dir: string) => {
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 60))) fs.rmSync(path.join(dir, f), {force: true});
};

// ---------- Final renders ----------

export type Quality = 'draft' | 'standard' | 'high';

export type RenderJob = {
  jobId: string;
  projectId: string;
  status: 'bundling' | 'rendering' | 'done' | 'error' | 'cancelled';
  progress: number;
  quality: Quality;
  file?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

const jobs = new Map<string, RenderJob & {cancel?: () => void}>();

const PRESETS: Record<Quality, {scale: number; crf: number; x264Preset: 'veryfast' | 'faster' | 'medium'}> = {
  draft: {scale: 0.5, crf: 30, x264Preset: 'veryfast'},
  standard: {scale: 1, crf: 23, x264Preset: 'faster'},
  high: {scale: 1, crf: 18, x264Preset: 'medium'},
};

export const listJobs = (projectId: string) =>
  [...jobs.values()].filter((j) => j.projectId === projectId).map(({cancel, ...j}) => j);

const publish = (job: RenderJob) => {
  const {cancel, ...plain} = job as RenderJob & {cancel?: unknown};
  emit({type: 'render_progress', projectId: job.projectId, job: plain});
};

export const startRender = (projectId: string, quality: Quality = getConfig().render.quality): RenderJob => {
  const running = [...jobs.values()].find((j) => j.projectId === projectId && (j.status === 'bundling' || j.status === 'rendering'));
  if (running) throw new Error('A render is already running for this project.');
  const jobId = `${Date.now()}`;
  const {cancelSignal, cancel} = makeCancelSignal();
  const job: RenderJob & {cancel?: () => void} = {
    jobId,
    projectId,
    status: 'bundling',
    progress: 0,
    quality,
    startedAt: Date.now(),
    cancel,
  };
  jobs.set(jobId, job);
  publish(job);

  (async () => {
    const browserP = acquireBrowser();
    browserP.catch(() => undefined);
    try {
      const b = await browserP;
      const serveUrl = await getServeUrl(projectId, (p) => {
        job.progress = p / 100;
        publish(job);
      });
      const inputProps = inputPropsFor(projectId);
      const composition = await selectComposition({serveUrl, id: 'main', inputProps, puppeteerInstance: b});
      const preset = PRESETS[quality];
      const proj = getProject(projectId);
      // With several videos, name the file after the one being rendered.
      const current = proj.videos && proj.videos.length > 1 ? proj.videos.find((v) => v.id === (proj.activeVideo ?? 'main')) : undefined;
      const name = (current ? `${proj.name}-${current.name}` : proj.name).replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60) || 'video';
      const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${quality}.mp4`;
      fs.mkdirSync(rendersDir(projectId), {recursive: true});
      job.status = 'rendering';
      job.progress = 0;
      publish(job);
      let last = 0;
      const cpus = os.cpus().length;
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: path.join(rendersDir(projectId), file),
        inputProps,
        concurrency: Math.max(1, Math.min(cpus, getConfig().render.concurrency || 2)),
        scale: preset.scale,
        crf: preset.crf,
        x264Preset: preset.x264Preset,
        puppeteerInstance: b,
        cancelSignal,
        onProgress: ({progress}) => {
          job.progress = progress;
          if (Date.now() - last > 300) {
            last = Date.now();
            publish(job);
          }
        },
      });
      job.status = 'done';
      job.progress = 1;
      job.file = file;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      job.status = /cancel/i.test(msg) ? 'cancelled' : 'error';
      job.error = msg.slice(0, 2000);
    } finally {
      job.finishedAt = Date.now();
      releaseBrowser();
      publish(job);
    }
  })();

  const {cancel: _c, ...plain} = job;
  return plain;
};

export const cancelRender = (jobId: string) => {
  jobs.get(jobId)?.cancel?.();
};

/** Wait for a job to finish (used by the agent's render tool). */
export const waitForJob = (jobId: string, signal?: AbortSignal) =>
  new Promise<RenderJob>((resolve) => {
    const tick = () => {
      const j = jobs.get(jobId);
      if (!j || ['done', 'error', 'cancelled'].includes(j.status) || signal?.aborted) {
        const {cancel, ...plain} = (j ?? {}) as RenderJob & {cancel?: unknown};
        resolve(plain as RenderJob);
      } else setTimeout(tick, 500);
    };
    tick();
  });
