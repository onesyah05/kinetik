/**
 * Minimal terminal client that uses the same core as the web app.
 *   npm run cli                    → pick/create a project interactively
 *   npm run cli -- <project-id>    → open a project
 * Commands inside: /render [draft|standard|high], /snap, /check, /clear, /exit
 */
import readline from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {addClient} from '../server/events';
import {createProject, listProjects, getProject} from '../server/projects';
import {runAgent, clearHistory} from '../server/agent/agent';
import {checkProject} from '../server/check';
import {renderSnapshots, startRender, waitForJob} from '../server/render';
import {getProvider} from '../server/config';

const c = {dim: (s: string) => `\x1b[2m${s}\x1b[0m`, acc: (s: string) => `\x1b[38;5;209m${s}\x1b[0m`, err: (s: string) => `\x1b[31m${s}\x1b[0m`};

// Attach a fake SSE client so agent events print to the terminal.
const sink = {
  write: (chunk: string) => {
    const m = chunk.match(/^data: (.*)\n\n$/s);
    if (!m) return true;
    const e = JSON.parse(m[1]);
    if (e.type === 'agent') {
      if (e.event === 'delta') stdout.write(e.text);
      if (e.event === 'tool_start') stdout.write(`\n${c.dim(`  → ${e.name} ${String(e.arguments).slice(0, 100).replace(/\s+/g, ' ')}`)}\n`);
      if (e.event === 'message' && e.message.role === 'tool')
        stdout.write(`${e.message.error ? c.err('  ✗ ') : c.dim('  ✓ ')}${c.dim(String(e.message.display ?? e.message.content).split('\n')[0].slice(0, 120))}\n`);
      if (e.event === 'message' && e.message.role === 'error') stdout.write(`\n${c.err(e.message.content)}\n`);
    }
    if (e.type === 'render_progress') stdout.write(`\r${c.dim(`  render ${e.job.status} ${Math.round(e.job.progress * 100)}%   `)}`);
    return true;
  },
  on: () => sink,
};

const main = async () => {
  const rl = readline.createInterface({input: stdin, output: stdout});
  let id = process.argv[2];
  if (!id) {
    const ps = listProjects();
    ps.slice(0, 9).forEach((p, i) => console.log(`  ${i + 1}. ${p.name} ${c.dim(`(${p.id}, ${p.width}x${p.height})`)}`));
    const a = await rl.question(`${c.acc('?')} Project number, or a name for a new project: `);
    const n = Number(a);
    id = n >= 1 && n <= ps.length ? ps[n - 1].id : createProject({name: a || 'CLI video'}).id;
  }
  const project = getProject(id);
  addClient(sink as any, id);
  console.log(`\n${c.acc('Kinetik')} · ${project.name} · ${project.width}x${project.height} · model ${getProvider(project.providerId)?.model}`);
  console.log(c.dim('Preview it in the web app (npm start). Commands: /render [quality], /snap, /check, /clear, /exit\n'));

  for (;;) {
    const line = (await rl.question(`${c.acc('›')} `)).trim();
    if (!line) continue;
    if (line === '/exit') break;
    try {
      if (line.startsWith('/render')) {
        const q = (line.split(' ')[1] as any) || 'standard';
        const job = startRender(id, q);
        const done = await waitForJob(job.jobId);
        console.log(`\n${done.status === 'done' ? `Saved workspace/${id}/renders/${done.file}` : c.err(done.error ?? done.status)}`);
      } else if (line === '/snap') {
        const r = await renderSnapshots(id, [0]);
        console.log(r.files.map((f) => `workspace/${id}/${f}`).join('\n'));
      } else if (line === '/check') {
        const r = await checkProject(id);
        console.log(r.ok ? 'OK' : r.errors.join('\n'), r.warnings.length ? `\n${r.warnings.join('\n')}` : '');
      } else if (line === '/clear') {
        clearHistory(id);
        console.log('Cleared.');
      } else {
        await runAgent(id, {text: line});
        stdout.write('\n\n');
      }
    } catch (e: any) {
      console.log(c.err(e.message));
    }
  }
  rl.close();
  process.exit(0);
};

main();
