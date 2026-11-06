/** Which sizes does the image model accept? Invalid sizes fail fast; stops at the first one that works. npx tsx scripts/image-sizes.ts */
import {imageGenTarget} from '../server/media';

const t = imageGenTarget();
for (const size of process.argv.slice(2).length ? process.argv.slice(2) : ['2048x1360', '9999x9999']) {
  const t0 = Date.now();
  const r = await fetch(`${t.baseURL}/images/generations`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}`},
    body: JSON.stringify({model: t.model, prompt: 'a small red dot', size, n: 1}),
  });
  const text = await r.text();
  try {
    const b64 = JSON.parse(text)?.data?.[0]?.b64_json;
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      // PNG width/height live at bytes 16-23.
      console.log(`  returned image: ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
    }
  } catch {
    /* not json */
  }
  console.log(size, r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, text.replace(/[A-Za-z0-9+/=]{200,}/g, '<b64>').slice(0, 400));
  if (r.ok) break;
}
