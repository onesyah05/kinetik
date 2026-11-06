/**
 * Replays the exact request the agent would send for a project and prints the raw stream.
 *   npx tsx scripts/replay.ts <projectId> [--drop-empty]
 */
import {getProvider} from '../server/config';
import {getProject, listAssets, listSourceFiles} from '../server/projects';
import {buildSystemPrompt} from '../server/agent/prompt';
import {loadHistory, toOpenAI} from '../server/agent/agent';
import {toolSchemas} from '../server/agent/tools';

const id = process.argv[2];
const project = getProject(id);
const p = getProvider(project.providerId)!;
let history = loadHistory(id);
if (process.argv.includes('--fresh')) history = history.filter((m) => m.role === 'user' && !m.hidden).slice(0, 1);
const messages = [
  {role: 'system', content: buildSystemPrompt(project, listSourceFiles(id), listAssets(id), p.vision)},
  ...toOpenAI(id, history, p.vision),
];
console.log(`provider ${p.baseURL} ${p.model}; ${messages.length} messages; roles: ${messages.map((m: any) => m.role[0]).join('')}`);
for (const m of messages.slice(1)) console.log('  ', JSON.stringify(m).slice(0, 160));

const res = await fetch(`${p.baseURL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
  body: JSON.stringify({model: p.model, messages, tools: toolSchemas(), tool_choice: 'auto', stream: !process.argv.includes('--no-stream'), ...(process.argv.includes('--no-parallel') ? {parallel_tool_calls: false} : {})}),
});
console.log('HTTP', res.status);
const text = await res.text();
if (process.argv.includes('--no-stream')) {
  console.log(text.slice(0, 3000));
  process.exit(0);
}
const lines = text.split('\n').filter((l) => l.startsWith('data:'));
console.log(`${lines.length} chunks`);
console.log(lines.slice(0, 6).join('\n').slice(0, 2500));
console.log('...');
console.log(lines.slice(-3).join('\n').slice(0, 1500));
