// Administrative setup only. The public game endpoint never creates custom voices.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { npcCastKeys, npcCastVoice, npcServerVoiceId } from '../../../src/npcvoiceidentity.mjs';

export async function designNpcCast({ apiKey, keys = npcCastKeys(), existing = {},
  fetchImpl = (...args) => globalThis.fetch(...args), save = async () => {}, preview = async () => {}, } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  if (!Array.isArray(keys) || keys.length > 144 || keys.some((key) => !npcCastVoice(key))) throw new Error('Invalid cast slots');
  const bank = { ...existing };
  for (const key of [...new Set(keys)]) {
    if (npcServerVoiceId(bank[key])) continue;
    const cast = npcCastVoice(key);
    const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/voices', {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ store: true, voice: { model: 'gemini-3.8-flash-tts', type: 'prompted',
        display_name: `WANDER ${key}`, gender: cast.gender, language_code: 'en-GB',
        prompted: { input: cast.prompt } } }), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Google voice design failed (${response.status}); saved progress can be resumed`); }
    const result = await response.json();
    if (!/^voice_[a-zA-Z0-9_-]{1,120}$/.test(result.id || '')) throw new Error('Google returned an invalid voice ID');
    bank[key] = result.id;
    await save(bank); // Persist each completed voice before another billable request.
    if (result.sample_audio?.mime_type === 'audio/wav' && result.sample_audio.data) {
      await preview(key, Buffer.from(result.sample_audio.data, 'base64'));
    }
  }
  return bank;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const keysArg = args.find((arg) => arg.startsWith('--keys='));
  const keys = keysArg ? keysArg.slice(7).split(',') : npcCastKeys();
  if (keys.some((key) => !npcCastVoice(key))) throw new Error('Invalid cast slots');
  if (!args.includes('--create')) {
    console.log(JSON.stringify(keys.map(npcCastVoice), null, 2));
    console.log('Preview only. Use --create with GEMINI_API_KEY to create this reusable cast.');
  } else {
    let existing = {};
    try { existing = JSON.parse(await readFile('.voice-bank.json', 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir('voice-previews', { recursive: true });
    const bank = await designNpcCast({ apiKey: process.env.GEMINI_API_KEY, keys, existing,
      save: async (value) => {
        await writeFile('.voice-bank.json.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
        await rename('.voice-bank.json.tmp', '.voice-bank.json');
        console.log(`Saved ${Object.keys(value).length} voice slots`);
      },
      preview: (key, wav) => writeFile(`voice-previews/${key.replaceAll(':', '-')}.wav`, wav),
    });
    console.log(`Ready: ${Object.keys(bank).length} reusable voices. Set NPC_VOICE_BANK_JSON to this manifest in the gateway configuration.`);
  }
}
