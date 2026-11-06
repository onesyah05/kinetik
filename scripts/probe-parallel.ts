/**
 * Checks whether a provider returns several tool calls in one response.
 *   npx tsx scripts/probe-parallel.ts [providerId]
 */
import {getProvider} from '../server/config';
import {toolSchemas} from '../server/agent/tools';

const p = getProvider(process.argv[2])!;
for (const parallel of [undefined, false]) {
  const res = await fetch(`${p.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
    body: JSON.stringify({
      model: p.model,
      stream: false,
      tools: toolSchemas(),
      ...(parallel === false ? {parallel_tool_calls: false} : {}),
      messages: [
        ...(process.argv.includes('--one')
          ? [{role: 'system', content: 'Tool rule: call exactly ONE tool per response. Never emit several tool calls at once; do them one after another across turns.'}]
          : []),
        {
          role: 'user',
          content:
            'Generate three voiceovers in parallel in this single response: call tts three times (names scene1, scene2, scene3) with one short Indonesian sentence each.',
        },
      ],
    }),
  });
  const j: any = await res.json();
  const m = j?.choices?.[0];
  console.log(
    `parallel_tool_calls=${parallel ?? 'default'}: finish=${m?.finish_reason} tool_calls=${m?.message?.tool_calls?.length ?? 0} completion_tokens=${j?.usage?.completion_tokens}`,
  );
}
