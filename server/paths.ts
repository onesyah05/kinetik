import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = path.join(ROOT, 'workspace');
export const DATA = path.join(ROOT, 'data');
export const KIT = path.join(ROOT, 'kit', 'index.tsx');
export const TEMPLATE = path.join(ROOT, 'templates', 'project');
export const BUNDLES = path.join(DATA, 'bundles');

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
export const safeJoin = (base: string, rel: string) => {
  const p = path.resolve(base, rel.replace(/^[/\\]+/, ''));
  const b = path.resolve(base);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error(`Path escapes project: ${rel}`);
  return p;
};

export const toPosix = (p: string) => p.split(path.sep).join('/');
