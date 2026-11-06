import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

/** Where Kinetik's own code lives (the git checkout, or the npm package folder). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the user's projects and settings live.
 * - KINETIK_HOME wins when set.
 * - A git checkout (or a folder that already has workspace/) keeps everything next to the code, as before.
 * - An npm install uses ~/Kinetik, so updating or reinstalling the package never touches user data.
 */
const isCheckout = fs.existsSync(path.join(ROOT, '.git')) || fs.existsSync(path.join(ROOT, 'workspace'));
export const HOME = path.resolve(process.env.KINETIK_HOME || (isCheckout ? ROOT : path.join(os.homedir(), 'Kinetik')));

export const WORKSPACE = path.join(HOME, 'workspace');
export const DATA = path.join(HOME, 'data');
export const KIT = path.join(ROOT, 'kit', 'index.tsx');
export const TEMPLATE = path.join(ROOT, 'templates', 'project');
export const BUNDLES = path.join(DATA, 'bundles');

/**
 * Project code imports react/remotion/etc. When projects live outside the package
 * (npm install), link HOME/node_modules to the package's dependencies so Vite, the
 * bundler and the compile check all resolve them the same way.
 */
export const linkDependencies = () => {
  if (HOME === ROOT) return;
  fs.mkdirSync(WORKSPACE, {recursive: true});
  let target: string;
  try {
    // The folder that actually holds the dependencies (nested for global installs, hoisted otherwise).
    const pkg = createRequire(path.join(ROOT, 'package.json')).resolve('remotion/package.json');
    target = pkg.slice(0, pkg.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
  } catch {
    return;
  }
  const link = path.join(HOME, 'node_modules');
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return; // a real folder the user made; leave it alone
    if (path.resolve(fs.readlinkSync(link)) === path.resolve(target)) return;
    fs.unlinkSync(link); // removes only the link, never the target
  } catch {
    /* no link yet */
  }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
};

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
export const safeJoin = (base: string, rel: string) => {
  const p = path.resolve(base, rel.replace(/^[/\\]+/, ''));
  const b = path.resolve(base);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error(`Path escapes project: ${rel}`);
  return p;
};

export const toPosix = (p: string) => p.split(path.sep).join('/');
