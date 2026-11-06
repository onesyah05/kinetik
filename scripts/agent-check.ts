/**
 * End-to-end check of the agent loop with a real provider on a throwaway project.
 *   npx tsx scripts/agent-check.ts [providerId]
 */
import {addClient} from '../server/events';
import {createProject, deleteProject} from '../server/projects';
import {loadHistory, runAgent} from '../server/agent/agent';

// Optional: --steps N limits the run, --text "..." sets the request.
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
// Passed per run, never written to the shared config.
const maxSteps = arg('--steps') ? Number(arg('--steps')) : undefined;

const providerId = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
// --project <id> continues an existing project instead of creating a throwaway one.
const id = arg('--project') ?? createProject({name: 'agent check', width: 1080, height: process.argv.includes('--portrait') ? 1920 : 1080, fps: 30, seconds: 3}).id;
addClient({write: () => true, on: () => undefined} as any, id);

try {
  await runAgent(id, {
    providerId,
    maxSteps,
    text: arg('--text') ?? 'Buat video 3 detik: latar biru tua dengan teks "Halo" yang fade in di tengah. Tulis kodenya lalu jalankan check_code. Tidak perlu snapshot.',
  });
  for (const m of loadHistory(id)) {
    if (m.role === 'assistant') console.log(`assistant: ${m.content.slice(0, 120).replace(/\n/g, ' ')} ${m.tool_calls?.map((t) => `[${t.name}]`).join(' ') ?? ''}`);
    else if (m.role === 'tool') console.log(`  tool ${m.name}: ${m.error ? 'ERROR ' : ''}${m.content.split('\n')[0].slice(0, 100)}`);
    else if (m.role === 'tool' && (m as any).questions) console.log(JSON.stringify((m as any).questions, null, 1));
    else if (m.role === 'user') console.log(`${m.hidden ? 'nudge' : 'user'}: ${m.content.slice(0, 80)}`);
    else console.log(`error: ${m.content}`);
  }
} finally {
  if (process.argv.includes('--keep')) console.log(`kept project ${id}`);
  else deleteProject(id);
  process.exit(0);
}
