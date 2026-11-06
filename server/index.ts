import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import multer from 'multer';
import {createServer as createVite} from 'vite';
import {ROOT, safeJoin, toPosix} from './paths';
import {addClient} from './events';
import {getConfig, saveConfig, type Config} from './config';
import {
  createProject,
  createVideos,
  deleteVideo,
  previewEntry,
  renameVideo,
  switchVideo,
  deleteFile,
  deleteProject,
  getProject,
  listAssets,
  listProjects,
  listRenders,
  listSourceFiles,
  projectDir,
  readFile,
  rendersDir,
  safeAssetName,
  updateProject,
  writeFile,
} from './projects';
import {savePublic} from './media';
import {checkProject} from './check';
import {cancelRender, listJobs, startRender, warmupBrowser} from './render';
import {listVoices, synthesizeTest} from './tts';
import {dropBundle} from './bundle';
import {clearHistory, isRunning, loadHistory, runAgent, stopAgent} from './agent/agent';
import {subscriptionRouter} from './subscription/routes';
import {syncSubscriptionProviders} from './subscription/sync';

const PORT = Number(process.env.PORT || 3210);
const app = express();
app.use(express.json({limit: '20mb'}));
const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 500 * 1024 * 1024}});

type H = (req: Request, res: Response) => unknown;
const h = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e: any) {
    next(e);
  }
};
const pid = (req: Request) => String(req.params.id);

// ---------- Subscription gateway ----------
// Mounted before Vite so the OpenAI-compatible gateway route (/sub/v1/...) and
// the login routes are always reachable. The provider list is synced to the
// connected accounts on startup and on every config GET.
syncSubscriptionProviders();
app.use(subscriptionRouter);

// ---------- Config ----------

const maskKey = (k: string) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '');
const MASK = /^.{0,4}….{0,4}$/;

/** Return config with secrets masked; on save, masked values keep the stored secret. */
const publicConfig = (c: Config) => ({
  ...c,
  // Subscription providers carry the account id (not a secret) in apiKey so the
  // gateway can resolve them; leave those intact so the UI keeps showing them.
  providers: c.providers.map((p) =>
    p.id.startsWith('sub:') ? p : {...p, apiKey: maskKey(p.apiKey)},
  ),
  imageGen: {...c.imageGen, apiKey: maskKey(c.imageGen.apiKey)},
  stock: {pexelsKey: maskKey(c.stock.pexelsKey), unsplashKey: maskKey(c.stock.unsplashKey)},
  tts: {...c.tts, geminiKey: maskKey(c.tts.geminiKey)},
});

app.get(
  '/api/config',
  h(() => {
    syncSubscriptionProviders();
    return publicConfig(getConfig());
  }),
);
app.put(
  '/api/config',
  h((req) => {
    const cur = getConfig();
    const next = req.body as Config;
    const keep = (v: string, old: string) => (MASK.test(v) && v.includes('…') ? old : v);
    next.providers = next.providers.map((p) => ({...p, apiKey: keep(p.apiKey, cur.providers.find((o) => o.id === p.id)?.apiKey ?? '')}));
    next.imageGen.apiKey = keep(next.imageGen.apiKey, cur.imageGen.apiKey);
    next.stock.pexelsKey = keep(next.stock.pexelsKey, cur.stock.pexelsKey);
    next.stock.unsplashKey = keep(next.stock.unsplashKey, cur.stock.unsplashKey);
    next.tts.geminiKey = keep(next.tts.geminiKey ?? '', cur.tts.geminiKey);
    saveConfig(next);
    syncSubscriptionProviders();
    return publicConfig(getConfig());
  }),
);

/** List models from an OpenAI-compatible /models endpoint (for the settings dropdown). */
app.post(
  '/api/models',
  h(async (req) => {
    const {providerId, baseURL, apiKey} = req.body as {providerId?: string; baseURL: string; apiKey?: string};
    const stored = getConfig().providers.find((p) => p.id === providerId);
    const key = apiKey && !apiKey.includes('…') ? apiKey : stored?.apiKey ?? '';
    const r = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {headers: key ? {Authorization: `Bearer ${key}`} : {}});
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return {models: (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean)};
  }),
);

app.get('/api/voices', h(async (req) => listVoices(String(req.query.locale ?? ''))));

/** Speak a short line with the current voice settings and return the MP3, for the Settings "Test voice" button. */
app.post('/api/tts/test', async (req, res) => {
  try {
    const dir = path.join(ROOT, 'data', 'voice-test');
    fs.rmSync(dir, {recursive: true, force: true});
    const id = 'voice-test-tmp';
    const fake = path.join(ROOT, 'workspace', id);
    fs.mkdirSync(path.join(fake, 'src'), {recursive: true});
    try {
      const r = await synthesizeTest(req.body?.text, req.body?.direction, fake);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(r);
    } finally {
      fs.rmSync(fake, {recursive: true, force: true});
    }
  } catch (e: any) {
    res.status(400).json({error: String(e?.message ?? e)});
  }
});

// ---------- Projects ----------

app.get('/api/projects', h(() => listProjects()));
app.post('/api/projects', h((req) => createProject(req.body)));
app.get(
  '/api/projects/:id',
  h((req) => ({
    ...getProject(pid(req)),
    running: isRunning(pid(req)),
    // Absolute module URL Vite serves for the live preview (the active video).
    entry: previewEntry(pid(req)),
  })),
);

// Videos inside a project (shared style and assets)
app.post(
  '/api/projects/:id/videos',
  h((req) => {
    const items = (req.body?.items ?? []) as {name?: string; theme?: string}[];
    if (!items.length) throw new Error('Give at least one video.');
    return createVideos(pid(req), items.slice(0, 20));
  }),
);
app.post(
  '/api/projects/:id/videos/:vid/activate',
  h((req) => {
    if (isRunning(pid(req))) throw new Error('Wait for the agent to finish (or stop it) before switching videos.');
    return switchVideo(pid(req), String(req.params.vid));
  }),
);
app.patch('/api/projects/:id/videos/:vid', h((req) => renameVideo(pid(req), String(req.params.vid), String(req.body?.name ?? ''))));
app.delete(
  '/api/projects/:id/videos/:vid',
  h((req) => {
    if (isRunning(pid(req))) throw new Error('Stop the agent first.');
    return deleteVideo(pid(req), String(req.params.vid));
  }),
);
app.patch('/api/projects/:id', h((req) => updateProject(pid(req), req.body)));
app.delete(
  '/api/projects/:id',
  h((req) => {
    stopAgent(pid(req));
    dropBundle(pid(req));
    deleteProject(pid(req));
    return {ok: true};
  }),
);

// Files
app.get('/api/projects/:id/files', h((req) => listSourceFiles(pid(req))));
app.get('/api/projects/:id/file', h((req) => ({path: req.query.path, content: readFile(pid(req), String(req.query.path))})));
app.put('/api/projects/:id/file', h((req) => ({path: writeFile(pid(req), req.body.path, req.body.content)})));
app.delete('/api/projects/:id/file', h((req) => ({path: deleteFile(pid(req), String(req.query.path))})));
app.post('/api/projects/:id/check', h((req) => checkProject(pid(req))));

// Assets
app.get('/api/projects/:id/assets', h((req) => listAssets(pid(req))));
app.post(
  '/api/projects/:id/assets',
  upload.array('files', 50),
  h((req) => {
    const dir = safeAssetName(String(req.body?.dir ?? ''));
    const files = (req.files as Express.Multer.File[]) ?? [];
    return files.map((f) => {
      // multer decodes names as latin1; fix UTF-8 names.
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
      return savePublic(pid(req), dir ? `${dir}/${original}` : original, f.buffer);
    });
  }),
);
app.delete(
  '/api/projects/:id/assets',
  h((req) => {
    const rel = `public/${safeAssetName(String(req.query.path))}`;
    fs.rmSync(safeJoin(projectDir(pid(req)), rel), {force: true});
    return {ok: true};
  }),
);

// Chat / agent
app.get('/api/projects/:id/messages', h((req) => ({messages: loadHistory(pid(req)), running: isRunning(pid(req))})));
app.delete(
  '/api/projects/:id/messages',
  h((req) => {
    if (isRunning(pid(req))) throw new Error('Stop the agent first.');
    clearHistory(pid(req));
    return {ok: true};
  }),
);
app.post(
  '/api/projects/:id/chat',
  h((req) => {
    const id = pid(req);
    const {text, images, providerId, editFrom} = req.body as {text: string; images?: string[]; providerId?: string; editFrom?: string};
    if (!text?.trim()) throw new Error('Empty message');
    if (isRunning(id)) throw new Error('Agent is already running.');
    if (providerId) updateProject(id, {providerId});
    // Validate provider synchronously so the UI gets an immediate error.
    const run = runAgent(id, {text, images, providerId, editFrom});
    run.catch(() => undefined);
    return Promise.race([run.then(() => ({ok: true})), new Promise((r) => setTimeout(() => r({ok: true, started: true}), 50))]);
  }),
);
app.post('/api/projects/:id/stop', h((req) => (stopAgent(pid(req)), {ok: true})));

// Renders
app.get('/api/projects/:id/renders', h((req) => ({files: listRenders(pid(req)), jobs: listJobs(pid(req))})));
app.post('/api/projects/:id/render', h((req) => startRender(pid(req), req.body?.quality)));
app.post('/api/renders/:jobId/cancel', h((req) => (cancelRender(String(req.params.jobId)), {ok: true})));
app.delete(
  '/api/projects/:id/renders/:file',
  h((req) => {
    fs.rmSync(safeJoin(rendersDir(pid(req)), String(req.params.file)), {force: true});
    return {ok: true};
  }),
);

// Events (SSE)
app.get('/api/events', (req, res) => {
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
  res.write(': connected\n\n');
  addClient(res, req.query.project ? String(req.query.project) : undefined);
});

// ---------- Static project files ----------

const sendProjectFile = (sub: string) => (req: Request, res: Response) => {
  try {
    const rel = (req.params as any).rest as string[] | string;
    const joined = Array.isArray(rel) ? rel.join('/') : rel;
    const file = safeJoin(path.join(projectDir(pid(req)), sub), decodeURIComponent(joined));
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file, {dotfiles: 'allow', headers: {'Cache-Control': 'no-cache'}});
  } catch {
    res.status(400).end();
  }
};
app.get('/ws/:id/public/*rest', sendProjectFile('public'));
// Same files under a version segment: the UI bumps it when assets change so browser caches never serve old images.
app.get('/ws/:id/v/:ver/public/*rest', sendProjectFile('public'));
app.get('/ws/:id/renders/*rest', sendProjectFile('renders'));
app.get('/ws/:id/.snapshots/*rest', sendProjectFile('.snapshots'));

app.use('/api', (err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({error: String(err?.message ?? err)});
});

// ---------- Web UI (Vite in middleware mode) ----------

const httpServer = http.createServer(app);
const vite = await createVite({
  configFile: path.join(ROOT, 'vite.config.ts'),
  // HMR websocket shares the app's port, so only one port is needed.
  server: {middlewareMode: true, hmr: {server: httpServer}},
  appType: 'spa',
});
app.use(vite.middlewares);

httpServer.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`
  Port ${PORT} is in use. Is Kinetik already running? Set PORT=xxxx to use another port.
`);
  else console.error(e);
  process.exit(1);
});
httpServer.listen(PORT, () => {
  console.log(`\n  Kinetik running at http://localhost:${PORT}\n`);
  fs.mkdirSync(path.join(ROOT, 'workspace'), {recursive: true});
  warmupBrowser();
});
