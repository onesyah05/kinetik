/**
 * Fake OpenAI-compatible endpoint for testing the agent loop without an API key.
 * Turn 1: streams two tool calls (update_project + snapshot). Turn 2: streams a text reply.
 *   npx tsx scripts/mock-llm.ts   → http://localhost:4010/v1
 */
import http from 'node:http';

const sse = (res: http.ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, {'Content-Type': 'text/event-stream'});
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const chunk = (delta: unknown, finish: string | null = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  model: 'mock',
  choices: [{index: 0, delta, finish_reason: finish}],
});

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({data: [{id: 'mock-model'}]}));
      }
      const j = JSON.parse(body || '{}');
      const msgs: any[] = j.messages ?? [];
      const last = msgs.at(-1);
      const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url').length;
      console.log(`[mock] ${msgs.length} messages, ${j.tools?.length} tools, ${images} images, last=${last?.role}`);
      if (last?.role === 'user' && typeof last.content === 'string') {
        const args1 = JSON.stringify({durationInSeconds: 8});
        const args2 = JSON.stringify({frames: [30, 90]});
        return sse(res, [
          chunk({role: 'assistant', content: 'Oke, saya cek dulu. '}),
          chunk({tool_calls: [{index: 0, id: 'call_a', type: 'function', function: {name: 'update_project', arguments: ''}}]}),
          chunk({tool_calls: [{index: 0, function: {arguments: args1.slice(0, 10)}}]}),
          chunk({tool_calls: [{index: 0, function: {arguments: args1.slice(10)}}]}),
          chunk({tool_calls: [{index: 1, id: 'call_b', type: 'function', function: {name: 'snapshot', arguments: args2}}]}),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sse(res, [chunk({role: 'assistant', content: `Selesai! Saya melihat **${images} gambar** snapshot. `}), chunk({content: 'Durasi sekarang 8 detik.'}), chunk({}, 'stop')]);
    });
  })
  .listen(4010, () => console.log('mock LLM on http://localhost:4010/v1'));
