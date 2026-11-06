import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {bundle} from '@remotion/bundler';
import {BUNDLES, KIT} from './paths';
import {projectDir} from './projects';

const USE_RSPACK = process.env.KINETIK_BUNDLER !== 'webpack';

type Entry = {hash: string; serveUrl: string};
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string>>();

/** Hash of everything that affects the bundle: sources, project.json, asset names/sizes, kit. */
const hashProject = (id: string) => {
  const dir = projectDir(id);
  const h = createHash('sha1');
  const visit = (rel: string, contents: boolean) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(r, contents);
      else {
        h.update(r);
        if (contents) h.update(fs.readFileSync(path.join(dir, r)));
        else {
          const st = fs.statSync(path.join(dir, r));
          h.update(`${st.size}:${st.mtimeMs}`);
        }
      }
    }
  };
  visit('src', true);
  visit('public', false);
  // project.json is not hashed: size/fps/duration/captions arrive as inputProps (see Root.tsx calculateMetadata).
  const kitDir = path.dirname(KIT);
  for (const f of fs.readdirSync(kitDir).sort()) h.update(fs.readFileSync(path.join(kitDir, f)));
  return h.digest('hex');
};

export const getServeUrl = async (id: string, onProgress?: (p: number) => void): Promise<string> => {
  const pending = inflight.get(id);
  if (pending) await pending.catch(() => undefined);

  const hash = hashProject(id);
  const hit = cache.get(id);
  if (hit && hit.hash === hash && fs.existsSync(hit.serveUrl)) return hit.serveUrl;

  const dir = projectDir(id);
  const job = bundle({
    entryPoint: path.join(dir, 'src', 'index.ts'),
    outDir: path.join(BUNDLES, id),
    publicDir: path.join(dir, 'public'),
    enableCaching: true,
    onProgress: (p: number) => onProgress?.(p),
    // Rspack (Rust) bundles several times faster than webpack, which matters on a laptop.
    rspack: USE_RSPACK,
    rspackOverride: (c: any) => ({
      ...c,
      resolve: {...c.resolve, alias: {...(c.resolve?.alias ?? {}), '@kit': KIT}},
    }),
    webpackOverride: (c: any) => ({
      ...c,
      resolve: {
        ...c.resolve,
        alias: {...(c.resolve?.alias ?? {}), '@kit': KIT},
      },
    }),
  } as any).then((serveUrl) => {
    cache.set(id, {hash, serveUrl});
    return serveUrl;
  });
  inflight.set(id, job);
  try {
    return await job;
  } finally {
    inflight.delete(id);
  }
};

export const dropBundle = (id: string) => {
  cache.delete(id);
  fs.rmSync(path.join(BUNDLES, id), {recursive: true, force: true});
};
