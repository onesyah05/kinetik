#!/usr/bin/env node
// Kinetik command line: `kinetik` (or `kinetik start`) runs the app, plus a few helpers.
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {UPDATE_EXIT_CODE, compareVersions, currentVersion, fetchLatest, installMethod, performUpdate} from './update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('-') && !['--port', '--home'].includes(args[i - 1]));
const command = flag('version') || args.includes('-v')
  ? 'version'
  : flag('help') || args.includes('-h')
    ? 'help'
    : positional[0] ?? 'start';

const c = {
  orange: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const banner = () =>
  console.log(`\n  ${c.orange(c.bold('K I N E T I K'))}  ${c.dim(`v${pkg.version} · AI video agent`)}\n`);

if (option('home')) process.env.KINETIK_HOME = path.resolve(option('home'));
if (option('port')) process.env.PORT = String(option('port'));

/** Data folder, same rule as server/paths.ts. */
const home = () => {
  if (process.env.KINETIK_HOME) return path.resolve(process.env.KINETIK_HOME);
  const checkout = fs.existsSync(path.join(ROOT, '.git')) || fs.existsSync(path.join(ROOT, 'workspace'));
  return checkout ? ROOT : path.join(os.homedir(), 'Kinetik');
};

const SYSTEM_PYTHON = process.env.KINETIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
/** Kinetik's own Python environment, same place as VENV in server/paths.ts. */
const venvDir = () => path.join(home(), 'data', 'python');
const venvPython = () => path.join(venvDir(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
/** The Python the server uses: KINETIK_PYTHON, else Kinetik's venv, else the system one. */
const python = () => process.env.KINETIK_PYTHON || (fs.existsSync(venvPython()) ? venvPython() : SYSTEM_PYTHON);
const has = (cmd, a = ['-version']) => {
  const r = spawnSync(cmd, a, {stdio: 'ignore'});
  return r.status === 0;
};
const pyModulesOk = () =>
  spawnSync(python(), ['-c', 'import edge_tts, numpy, PIL, scipy'], {stdio: 'ignore'}).status === 0;

/** Load TypeScript sources through tsx, then run them. */
const runTs = async (rel) => {
  const {register} = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(path.join(ROOT, rel)).href);
};

const help = () => {
  banner();
  console.log(`  ${c.bold('Usage')}
    kinetik                 Start Kinetik and open it in the browser
    kinetik start           Same as above
      --port 3300           Use another port (default 3210)
      --no-open             Don't open the browser
      --home <folder>       Keep projects and settings in another folder
    kinetik doctor          Check FFmpeg, Python and the data folder
    kinetik setup           Install the Python packages (voiceover, transparent images)
    kinetik cli [project]   Chat with the agent in the terminal
    kinetik update          Install the newest version (projects are kept)
      --check               Only check, don't install
    kinetik home            Show where projects and settings are stored
    kinetik --version       Show the version

  ${c.dim('Docs: https://github.com/onesyah05/kinetik')}
`);
};

const doctor = () => {
  banner();
  const major = Number(process.versions.node.split('.')[0]);
  const rows = [
    ['Node.js 20+', major >= 20, `found ${process.versions.node}. Get the LTS from https://nodejs.org`],
    ['FFmpeg', has('ffmpeg'), 'needed to render MP4. Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Linux: apt install ffmpeg'],
    ['Python 3', has(python(), ['--version']), 'needed for voiceover. https://www.python.org/downloads/ · macOS: brew install python'],
    ['Python packages', pyModulesOk(), 'run: kinetik setup'],
  ];
  for (const [name, ok, fix] of rows) console.log(`  ${ok ? c.green('✓') : c.red('✗')} ${name}${ok ? '' : c.dim(`  — ${fix}`)}`);
  console.log(`\n  Python: ${python()}`);
  console.log(`  Projects and settings: ${home()}\n`);
  return rows.every((r) => r[1]);
};

const setup = () => {
  banner();
  if (!has(SYSTEM_PYTHON, ['--version'])) {
    console.log(`  ${c.red('Python 3 is not installed.')} Get it from https://www.python.org/downloads/ (macOS: brew install python) and run "kinetik setup" again.\n`);
    process.exit(1);
  }
  const req = path.join(ROOT, 'requirements.txt');
  const pip = (py, extra = []) => spawnSync(py, ['-m', 'pip', 'install', ...extra, '-r', req], {stdio: 'inherit'}).status === 0;
  const finish = (ok) => {
    const ready = ok && pyModulesOk();
    if (ready) console.log(`\n  ${c.green('✓')} Python packages are ready (${python()}).\n`);
    else console.log(`\n  ${c.red('✗')} The Python packages did not install. Check the messages above, then run "kinetik setup" again.\n`);
    process.exit(ready ? 0 : 1);
  };
  console.log('  Installing Python packages (edge-tts, numpy, pillow, scipy, opencv)…\n');

  // A Python the user picked: install straight into it.
  if (process.env.KINETIK_PYTHON) finish(pip(SYSTEM_PYTHON));
  // Windows: the user's own Python takes packages with --user, like Start-Kinetik.bat.
  if (process.platform === 'win32' && !fs.existsSync(venvPython())) {
    if (pip(SYSTEM_PYTHON, ['--user'])) finish(true);
    console.log(`\n  ${c.dim('That did not work, so Kinetik will use its own Python environment instead.')}\n`);
  }
  // macOS / Linux: the system Python refuses pip installs (PEP 668), so Kinetik keeps its own environment.
  if (!fs.existsSync(venvPython())) {
    console.log(`  Creating Kinetik's Python environment in ${venvDir()}…\n`);
    fs.mkdirSync(path.dirname(venvDir()), {recursive: true});
    const r = spawnSync(SYSTEM_PYTHON, ['-m', 'venv', venvDir()], {stdio: 'inherit'});
    if (r.status !== 0 || !fs.existsSync(venvPython())) {
      fs.rmSync(venvDir(), {recursive: true, force: true});
      const hint = process.platform === 'linux' ? ' On Debian/Ubuntu run: sudo apt install python3-venv' : '';
      console.log(`\n  ${c.red('Could not create a Python environment.')}${hint}\n`);
      process.exit(1);
    }
  }
  spawnSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], {stdio: 'ignore'});
  finish(pip(venvPython()));
};

/** Print a one-line notice when a newer release exists (never blocks startup). */
const announceUpdate = () =>
  fetchLatest(5000).then((latest) => {
    if (latest && compareVersions(latest.version, currentVersion()) > 0)
      console.log(`  ${c.orange('↑')} Kinetik v${latest.version} is available. Click ${c.bold('Update')} in the app, or run ${c.bold('kinetik update')}.\n`);
  });

/**
 * `kinetik start` keeps a small parent process around the server. When the server asks
 * for an update (Update button), it exits with UPDATE_EXIT_CODE; the parent installs
 * the new version in this same terminal and starts the server again.
 */
const supervise = async () => {
  banner();
  if (!has('ffmpeg')) console.log(`  ${c.red('!')} FFmpeg not found: rendering MP4 will fail. Run ${c.bold('kinetik doctor')} for help.\n`);
  else if (!pyModulesOk()) console.log(`  ${c.red('!')} Voiceover needs Python packages. Run ${c.bold('kinetik setup')} once.\n`);
  if (!process.env.KINETIK_NO_UPDATE_CHECK) announceUpdate();
  let open = !flag('no-open');
  let stopping = false;
  let child = null;
  // Ctrl+C reaches the server too; just wait for it to close instead of dying first.
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => {
    stopping = true;
    child?.kill('SIGTERM');
  });
  for (;;) {
    const env = {...process.env, KINETIK_CHILD: '1', KINETIK_SUPERVISED: '1', KINETIK_OPEN: open ? '1' : ''};
    child = spawn(process.execPath, [path.join(ROOT, 'bin', 'kinetik.mjs'), 'start', ...args.filter((a) => a !== 'start' && a !== 'serve')], {stdio: 'inherit', env});
    const code = await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
    if (stopping || code !== UPDATE_EXIT_CODE) {
      process.exitCode = code;
      return;
    }
    // Update requested from the app. The page reloads by itself, so don't open another tab.
    await performUpdate();
    open = false;
    console.log('  Starting Kinetik again…\n');
  }
};

switch (command) {
  case 'start':
  case 'serve': {
    if (process.env.KINETIK_CHILD === '1') await runTs('server/index.ts');
    else await supervise();
    break;
  }
  case 'update': {
    banner();
    const current = currentVersion();
    console.log(`  Installed: v${current}  ${c.dim(`(${installMethod()} install, ${ROOT})`)}`);
    const latest = await fetchLatest();
    if (!latest) {
      console.log(`  ${c.red('Could not reach GitHub.')} Check the internet connection and try again.\n`);
      process.exitCode = 1;
      break;
    }
    console.log(`  Newest:    v${latest.version}\n`);
    if (compareVersions(latest.version, current) <= 0) {
      console.log(`  ${c.green('✓')} Kinetik is up to date.\n`);
      break;
    }
    const notes = latest.notes.split(/\r?\n/).filter((l) => /^\s*[-*] /.test(l)).slice(0, 8);
    if (notes.length) console.log(`  ${c.bold("What's new")}\n${notes.map((l) => `   ${l.trim().replace(/\*\*/g, '')}`).join('\n')}\n`);
    if (flag('check')) {
      console.log(`  Run ${c.bold('kinetik update')} to install it. ${c.dim(latest.url)}\n`);
      break;
    }
    // If Kinetik is running, let it update itself: files in use can't be replaced on Windows.
    const port = Number(process.env.PORT) || 3210;
    const running = await fetch(`http://localhost:${port}/api/version`, {signal: AbortSignal.timeout(1500)})
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (running?.root && path.resolve(running.root) === ROOT) {
      const r = await fetch(`http://localhost:${port}/api/update`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})
        .then(async (res) => ({ok: res.ok, body: await res.json().catch(() => ({}))}))
        .catch((e) => ({ok: false, body: {error: e.message}}));
      if (r.ok) {
        console.log(`  Kinetik is running, so it will update and restart itself. Watch the terminal where it runs; the browser page reloads when it is done.\n`);
        break;
      }
      console.log(`  ${c.red('!')} ${r.body.error ?? 'The running Kinetik could not update itself.'}\n  Close Kinetik (Ctrl+C in its terminal) and run ${c.bold('kinetik update')} again.\n`);
      process.exitCode = 1;
      break;
    }
    const res = await performUpdate(latest);
    if (!res.ok) {
      process.exitCode = 1;
      break;
    }
    console.log(`  Run ${c.bold('kinetik')} to start it.\n`);
    break;
  }
  case 'cli': {
    const id = args.filter((a) => !a.startsWith('-'))[1];
    process.argv = [process.argv[0], path.join(ROOT, 'cli', 'index.ts'), ...(id ? [id] : [])];
    await runTs('cli/index.ts');
    break;
  }
  case 'doctor':
    process.exit(doctor() ? 0 : 1);
    break;
  case 'setup':
    setup();
    break;
  case 'home':
  case 'where':
    console.log(home());
    break;
  case 'version':
    console.log(pkg.version);
    break;
  case 'help':
    help();
    break;
  default:
    if (flag('version') || flag('v') || args.includes('-v')) console.log(pkg.version);
    else if (flag('help') || args.includes('-h')) help();
    else {
      console.log(c.red(`\n  Unknown command: ${command}`));
      help();
      process.exit(1);
    }
}
