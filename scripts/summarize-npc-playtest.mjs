import { readFile } from 'node:fs/promises';
import { summarizePlaytest } from '../src/npcplaytest.mjs';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('Usage: npm run playtest:score -- response-1.json ... response-5.json');
  process.exitCode = 1;
} else {
  const responses = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  const summary = summarizePlaytest(responses);
  console.log(JSON.stringify(summary, null, 2));
  if (!Object.values(summary.gates).every(Boolean)) process.exitCode = 2;
}
