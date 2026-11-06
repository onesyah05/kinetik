// Update checks and self-update for Kinetik. Plain JavaScript with no dependencies,
// because it runs while the package's own files (and node_modules) are being replaced.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'onesyah05/kinetik';
/** Exit code the server uses to ask `kinetik start` to update and start it again. */
export const UPDATE_EXIT_CODE = 75;

export const currentVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** Same rule as server/paths.ts. */
export const homeDir = () => {
  if (process.env.KINETIK_HOME) return path.resolve(process.env.KINETIK_HOME);
  const checkout = fs.existsSync(path.join(ROOT, '.git')) || fs.existsSync(path.join(ROOT, 'workspace'));
  return checkout ? ROOT : path.join(os.homedir(), 'Kinetik');
};
const statusFile = () => path.join(homeDir(), 'data', 'update-status.json');

/** 1 when a is newer than b. */
export const compareVersions = (a, b) => {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
};

/** How this copy was installed, which decides how to update it. */
export const installMethod = () => {
  if (fs.existsSync(path.join(ROOT, '.git'))) return 'git';
  if (ROOT.split(path.sep).includes('node_modules')) return 'npm';
  return 'folder';
};

/** The command a person can run by hand for this install. */
export const manualCommand = (method = installMethod()) =>
  method === 'git' ? `cd "${ROOT}" && git pull && npm install` : 'kinetik update';

const tarballUrl = (version) => `https://github.com/${REPO}/releases/download/v${version}/kinetik-studio-${version}.tgz`;

/** The release API: full notes, but limited to 60 requests per hour per IP without a token. */
const fromApi = async (timeoutMs) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'kinetik-update-check'},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const version = String(j.tag_name ?? '').replace(/^v/, '');
  if (!version) return null;
  const tgz = (j.assets ?? []).find((a) => /\.tgz$/.test(a.name));
  return {version, notes: String(j.body ?? ''), url: j.html_url, tarball: tgz?.browser_download_url ?? tarballUrl(version), publishedAt: j.published_at};
};

/** No rate limit: /releases/latest redirects to the newest tag, and CHANGELOG.md has the notes. */
const fromRedirect = async (timeoutMs) => {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, {method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)});
  const tag = (r.headers.get('location') ?? '').match(/\/tag\/v?([0-9][^/?#]*)/)?.[1];
  if (!tag) return null;
  let notes = '';
  try {
    const c = await fetch(`https://raw.githubusercontent.com/${REPO}/v${tag}/CHANGELOG.md`, {signal: AbortSignal.timeout(timeoutMs)});
    if (c.ok) {
      const text = await c.text();
      const start = text.indexOf(`## v${tag}`);
      if (start >= 0) {
        const rest = text.slice(start);
        const next = rest.indexOf('\n## ', 4);
        notes = (next > 0 ? rest.slice(0, next) : rest).split('\n').slice(1).join('\n').trim();
      }
    }
  } catch {
    /* notes are optional */
  }
  return {version: tag, notes, url: `https://github.com/${REPO}/releases/tag/v${tag}`, tarball: tarballUrl(tag)};
};

/** Newest published release on GitHub, or null when offline. */
export const fetchLatest = async (timeoutMs = 8000) => {
  for (const source of [fromApi, fromRedirect]) {
    try {
      const latest = await source(timeoutMs);
      if (latest) return latest;
    } catch {
      /* try the next source */
    }
  }
  return null;
};

const run = (cmd, args, opts = {}) => {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // npm is a .cmd script on Windows, which needs a shell. Arguments here never contain spaces or user text,
  // so they are joined into one command line (passing an array with shell:true is deprecated).
  const shell = opts.shell ?? process.platform === 'win32';
  const r = shell
    ? spawnSync([cmd, ...args].join(' '), {stdio: 'inherit', ...opts, shell: true})
    : spawnSync(cmd, args, {stdio: 'inherit', ...opts, shell: false});
  if (r.status !== 0) throw new Error(`"${cmd} ${args.join(' ')}" failed (exit ${r.status ?? r.signal ?? r.error?.message}).`);
};

/** A zip/folder install: unpack the release tarball over the code, then reinstall dependencies. */
const updateFolder = async (latest) => {
  if (!latest.tarball) throw new Error('This release has no package file to download.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetik-update-'));
  try {
    console.log(`  Downloading ${latest.tarball}`);
    const r = await fetch(latest.tarball, {signal: AbortSignal.timeout(120_000)});
    if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}).`);
    const file = path.join(tmp, 'kinetik.tgz');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    run('tar', ['-xzf', file, '-C', tmp], {shell: false});
    const pkg = path.join(tmp, 'package');
    if (!fs.existsSync(path.join(pkg, 'package.json'))) throw new Error('The downloaded package looks broken.');
    // Only code is copied; workspace/ and data/ are never in the package.
    fs.cpSync(pkg, ROOT, {recursive: true, force: true});
    run('npm', ['install', '--no-audit', '--no-fund'], {cwd: ROOT});
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
};

const writeStatus = (s) => {
  try {
    fs.mkdirSync(path.dirname(statusFile()), {recursive: true});
    fs.writeFileSync(statusFile(), JSON.stringify({...s, at: Date.now()}, null, 2));
  } catch {
    /* status is only informative */
  }
};

/** Result of the last update attempt, if any. */
export const readStatus = () => {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), 'utf8'));
  } catch {
    return null;
  }
};

/** Install the newest release. Returns {ok, from, to, error?}. Never throws. */
export const performUpdate = async (latest) => {
  const from = currentVersion();
  latest = latest ?? (await fetchLatest());
  if (!latest) {
    const res = {ok: false, from, to: from, error: 'Could not reach GitHub to check for updates. Check the internet connection.'};
    writeStatus(res);
    return res;
  }
  if (compareVersions(latest.version, from) <= 0) {
    const res = {ok: true, from, to: from, upToDate: true};
    return res;
  }
  const method = installMethod();
  console.log(`\n  Updating Kinetik v${from} → v${latest.version} (${method} install)\n`);
  try {
    if (method === 'git') {
      run('git', ['pull', '--ff-only'], {cwd: ROOT, shell: false});
      run('npm', ['install', '--no-audit', '--no-fund'], {cwd: ROOT});
    } else if (method === 'npm') {
      // The release tarball works whether or not the package is on the npm registry.
      run('npm', ['install', '-g', '--no-audit', '--no-fund', latest.tarball ?? 'kinetik-studio@latest']);
    } else {
      await updateFolder(latest);
    }
    const to = currentVersion();
    const res = {ok: true, from, to};
    writeStatus(res);
    console.log(`\n  ✓ Kinetik updated to v${to}\n`);
    return res;
  } catch (e) {
    const hint =
      method === 'npm' && process.platform !== 'win32'
        ? ' If it says EACCES (permission denied), run: sudo kinetik update'
        : method === 'git'
          ? ' If you changed files in the Kinetik folder, commit or undo them first.'
          : '';
    const res = {ok: false, from, to: from, error: `${e?.message ?? e}${hint}`};
    writeStatus(res);
    console.log(`\n  ✗ Update failed: ${res.error}\n`);
    return res;
  }
};
