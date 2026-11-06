/**
 * Run one agent tool directly (no LLM), e.g.
 *   npx tsx scripts/tool-run.ts <projectId> generate_image '{"prompt":"...","filename":"assets/x.png"}'
 */
import {runTool} from '../server/agent/tools';

const [id, name, args] = process.argv.slice(2);
const t = Date.now();
const r = await runTool(name, args ?? '{}', {projectId: id, signal: new AbortController().signal});
console.log(`${name} ${r.error ? 'ERROR' : 'ok'} in ${((Date.now() - t) / 1000).toFixed(1)}s\n${r.content}`);
process.exit(0);
