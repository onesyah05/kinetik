#!/usr/bin/env node
// Kinetik command line: `kinetik` (or `kinetik start`) runs the app, plus a few helpers.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

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

const PYTHON = process.env.KINETIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const has = (cmd, a = ['-version']) => {
  const r = spawnSync(cmd, a, {stdio: 'ignore'});
  return r.status === 0;
};
const pyModulesOk = () =>
  spawnSync(PYTHON, ['-c', 'import edge_tts, numpy, PIL, scipy'], {stdio: 'ignore'}).status === 0;

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
    ['Python 3', has(PYTHON, ['--version']), 'needed for voiceover. https://www.python.org/downloads/'],
    ['Python packages', pyModulesOk(), 'run: kinetik setup'],
  ];
  for (const [name, ok, fix] of rows) console.log(`  ${ok ? c.green('✓') : c.red('✗')} ${name}${ok ? '' : c.dim(`  — ${fix}`)}`);
  console.log(`\n  Projects and settings: ${home()}\n`);
  return rows.every((r) => r[1]);
};

const setup = () => {
  banner();
  if (!has(PYTHON, ['--version'])) {
    console.log(`  ${c.red('Python 3 is not installed.')} Get it from https://www.python.org/downloads/ and run "kinetik setup" again.\n`);
    process.exit(1);
  }
  console.log('  Installing Python packages (edge-tts, numpy, pillow, scipy, opencv)…\n');
  const r = spawnSync(PYTHON, ['-m', 'pip', 'install', '--user', '-r', path.join(ROOT, 'requirements.txt')], {
    stdio: 'inherit',

  });
  process.exit(r.status ?? 1);
};

switch (command) {
  case 'start':
  case 'serve': {
    banner();
    if (!has('ffmpeg')) console.log(`  ${c.red('!')} FFmpeg not found: rendering MP4 will fail. Run ${c.bold('kinetik doctor')} for help.\n`);
    else if (!pyModulesOk()) console.log(`  ${c.red('!')} Voiceover needs Python packages. Run ${c.bold('kinetik setup')} once.\n`);
    if (!flag('no-open')) process.env.KINETIK_OPEN = '1';
    await runTs('server/index.ts');
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
