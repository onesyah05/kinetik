/** Tiny request to see whether the Gemini key is rate-limited and which quota applies. npx tsx scripts/gemini-quota.ts [model] */
import {getConfig} from '../server/config';

const key = getConfig().tts.geminiKey;
const model = process.argv[2] ?? 'gemini-2.5-flash';
const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
  body: JSON.stringify({contents: [{parts: [{text: 'hi'}]}], generationConfig: {thinkingConfig: {thinkingBudget: 0}, maxOutputTokens: 5}}),
});
const j: any = await r.json();
console.log(model, r.status, r.ok ? 'ok' : '');
for (const d of j?.error?.details ?? []) {
  for (const v of d.violations ?? []) console.log('quota:', v.quotaMetric, v.quotaId, 'limit', v.quotaValue);
  if (d.retryDelay) console.log('retry after', d.retryDelay);
}
