/**
 * Check whether a provider really supports streamed tool calls.
 *   npx tsx scripts/probe-provider.ts [providerId]
 * Prints the raw stream chunks (API key is never printed).
 */
import {getProvider} from '../server/config';

const p = getProvider(process.argv[2]);
if (!p) throw new Error('No provider');
console.log(`provider ${p.id} · ${p.baseURL} · ${p.model}`);

const body = {
  model: p.model,
  stream: process.argv.includes('--no-stream') ? false : true,
  tool_choice: 'auto',
  messages: [
    {role: 'system', content: 'You are a test agent. Always use the tools to do the work.'},
    {role: 'user', content: 'Create the file src/hello.txt containing "hi". Use the write_file tool.'},
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file',
        parameters: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content']},
      },
    },
  ],
};

const res = await fetch(`${p.baseURL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`},
  body: JSON.stringify(body),
});
console.log('HTTP', res.status, res.headers.get('content-type'));
const text = await res.text();
console.log(text.slice(0, 6000));
