/**
 * Calls every agent tool once through the provider (forced tool_choice) to find tools a proxy drops.
 *   npx tsx scripts/probe-tools.ts [providerId]
 */
import {getProvider} from '../server/config';
import {toolSchemas} from '../server/agent/tools';

const p = getProvider(process.argv[2])!;
const all = toolSchemas();
for (const tool of all) {
  const res = await fetch(`${p.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
    body: JSON.stringify({
      model: p.model,
      stream: false,
      tools: all,
      tool_choice: {type: 'function', function: {name: tool.function.name}},
      messages: [{role: 'user', content: `Call the ${tool.function.name} tool once with sensible example arguments for a short video project.`}],
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  const calls = j?.choices?.[0]?.message?.tool_calls ?? [];
  const got = calls.map((c: any) => `${c.function?.name}(${String(c.function?.arguments).slice(0, 60)})`).join(', ');
  console.log(`${tool.function.name.padEnd(16)} HTTP ${res.status} finish=${j?.choices?.[0]?.finish_reason} ${got || 'NO TOOL CALL RETURNED'}`);
}
