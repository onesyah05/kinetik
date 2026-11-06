/** List the Gemini models available to the key in Settings. npx tsx scripts/gemini-models.ts [filter] */
import {getConfig} from '../server/config';

const key = getConfig().tts.geminiKey;
const filter = new RegExp(process.argv[2] ?? '.', 'i');
const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {headers: {'x-goog-api-key': key}});
const j: any = await r.json();
console.log(r.status);
console.log(((j.models ?? []) as any[]).map((m) => m.name.replace('models/', '')).filter((n) => filter.test(n)).join('\n') || JSON.stringify(j).slice(0, 400));
