/**
 * Transcribe an audio file with Gemini (uses the key saved in Settings) to verify what a voiceover actually says.
 *   npx tsx scripts/transcribe.ts <file.mp3>
 */
import fs from 'node:fs';
import {getConfig} from '../server/config';

const file = process.argv[2];
const key = getConfig().tts.geminiKey;
if (!key) throw new Error('No Gemini key in Settings');
const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
  body: JSON.stringify({
    contents: [
      {
        parts: [
          {inlineData: {mimeType: 'audio/mpeg', data: fs.readFileSync(file).toString('base64')}},
          {
            text: 'Transcribe this audio exactly, word for word. Then on a new line starting with "Delivery:" describe the tone, pace and intonation in one sentence.',
          },
        ],
      },
    ],
  }),
});
const j: any = await res.json();
console.log(res.status, j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? JSON.stringify(j).slice(0, 400));
