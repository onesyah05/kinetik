/**
 * Edit a reference image with a Gemini image model ("nano banana") using the key in Settings.
 *   npx tsx scripts/nano-edit-test.ts <ref.png> <model> "<instruction>" <out.png>
 */
import fs from 'node:fs';
import {getConfig} from '../server/config';

const [ref, model, instruction, out] = process.argv.slice(2);
const key = getConfig().tts.geminiKey;
const t0 = Date.now();
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
  body: JSON.stringify({
    contents: [{parts: [{inlineData: {mimeType: 'image/png', data: fs.readFileSync(ref).toString('base64')}}, {text: instruction}]}],
    generationConfig: {responseModalities: ['IMAGE', 'TEXT']},
  }),
});
const j: any = await res.json().catch(() => ({}));
console.log(model, 'HTTP', res.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
if (part) {
  fs.writeFileSync(out, Buffer.from(part.inlineData.data, 'base64'));
  console.log('saved', out, part.inlineData.mimeType);
} else {
  console.log(JSON.stringify(j).replace(/[A-Za-z0-9+/=]{200,}/g, '<b64>').slice(0, 500));
  for (const d of j?.error?.details ?? []) for (const v of d.violations ?? []) console.log('quota:', v.quotaId, 'limit', v.quotaValue);
}
