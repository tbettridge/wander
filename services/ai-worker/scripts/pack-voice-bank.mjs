import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { npcCastVoice, npcServerVoiceId } from '../../../src/npcvoiceidentity.mjs';

// Keep every value below Cloudflare's 5 KB binding limit and clear stale chunks.
export function packVoiceBank(bank) {
  const chunks = [{}];
  for (const [key, voice] of Object.entries(bank || {})) {
    if (!npcCastVoice(key) || !npcServerVoiceId(voice)) throw new Error('Invalid cast mapping');
    let last = chunks.at(-1);
    if (Buffer.byteLength(JSON.stringify({ ...last, [key]: voice })) > 4500) {
      if (chunks.length >= 8) throw new Error('Cast mapping exceeds supported binding sizes');
      chunks.push(last = {});
    }
    last[key] = voice;
  }
  return Object.fromEntries([['NPC_VOICE_BANK_JSON', '{}'],
    ...Array.from({ length: 8 }, (_, i) => [`NPC_VOICE_BANK_${i}_JSON`, JSON.stringify(chunks[i] || {})])]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith('--')) || '.voice-bank.json';
  const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
  const packed = JSON.stringify(packVoiceBank(JSON.parse(await readFile(input, 'utf8'))), null, 2);
  if (output) { await writeFile(output, packed, { mode: 0o600 }); console.log('Prepared cast secret bindings.'); }
  else console.log(packed);
}
