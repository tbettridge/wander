#!/usr/bin/env node
// Survey how well NPCs stand on what is drawn under them.
//
// Attaches to a game held open by `npm run playbot -- --hold 9333`, hops the
// courier to each place in turn, lets the residents walk for a while and
// samples every NPC near the courier with npc-ground-probe.js. Writes the raw
// samples and a summary of floating and sinking NPCs.
//
//   node scripts/playbot/npc-ground-survey.mjs --attach http://127.0.0.1:9333 \
//     --places 6 --samples 12 --out npc-ground
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const attach = value('attach', 'http://127.0.0.1:9333');
const placeCount = Number(value('places', 6));
const samples = Number(value('samples', 12));
const outDir = value('out', join(root, 'playbot-reports', 'npc-ground'));
const tolerance = Number(value('tolerance', 0.06));

async function loadPlaywright() {
  for (const spec of [process.env.WANDER_PLAYWRIGHT_PATH, 'playwright-core', 'playwright',
    join(root, '.playbot', 'node_modules', 'playwright-core', 'index.mjs'),
    '/opt/node-tools/node_modules/playwright/index.mjs']) {
    if (!spec) continue;
    try { return await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec); } catch { /* next */ }
  }
  throw new Error('Playwright not found');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { chromium } = await loadPlaywright();
const browser = await chromium.connectOverCDP(attach);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().includes('127.0.0.1'));
if (!page) throw new Error('No game page found at ' + attach);
const probeSource = await readFile(join(here, 'npc-ground-probe.js'), 'utf8');
const probe = (opts) => page.evaluate(`(${probeSource.replace(/^\/\/.*$/gm, '').trim()})(${JSON.stringify(opts || {})})`);

const places = await page.evaluate((limit) => {
  const W = window.__wander;
  const summaries = [...(W.settlements.summaries || [])];
  const p = W.controls.rig.position;
  return summaries
    .filter((summary) => Number.isFinite(summary.x) && Number.isFinite(summary.z))
    .filter((summary) => !/lighthouse/i.test(summary.kind || ''))
    .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    .slice(0, limit)
    .map((summary) => ({ id: summary.id, name: summary.name, kind: summary.kind, x: summary.x, z: summary.z }));
}, placeCount);
console.log('places', places.map((place) => place.name || place.id).join(', '));

await mkdir(outDir, { recursive: true });
const all = [];
for (const place of places) {
  await page.evaluate(({ x, z }) => window.__wander.teleport(x + 4, z + 4), place);
  // Let the village stream in and its people start walking.
  for (let i = 0; i < 90; i++) {
    const ready = await page.evaluate((id) => {
      const current = window.__wander.settlements.active.get(id);
      return !!current && (current.residents || []).length > 0 && !(current.pending || []).length;
    }, place.id);
    if (ready) break;
    await sleep(1000);
  }
  await sleep(4000);
  for (let s = 0; s < samples; s++) {
    const result = await probe({ range: 70 });
    for (const npc of result.npcs) all.push({ ...npc, place: place.name || place.id, sample: s });
    await sleep(1500);
  }
  const here = all.filter((npc) => (npc.place === (place.name || place.id)) && npc.gap !== null);
  const off = here.filter((npc) => Math.abs(npc.gap) > tolerance);
  console.log(`${place.name || place.id}: ${here.length} samples, ${off.length} off by > ${tolerance} m`);
}

const measured = all.filter((npc) => npc.gap !== null && !npc.inside && !npc.rail);
const off = measured.filter((npc) => Math.abs(npc.gap) > tolerance);
const byKind = {};
for (const npc of measured) {
  const entry = byKind[npc.kind] ||= { samples: 0, floating: 0, sinking: 0, worstFloat: 0, worstSink: 0 };
  entry.samples++;
  if (npc.gap > tolerance) { entry.floating++; entry.worstFloat = Math.max(entry.worstFloat, npc.gap); }
  if (npc.gap < -tolerance) { entry.sinking++; entry.worstSink = Math.min(entry.worstSink, npc.gap); }
}
const summary = { tolerance, places, samples: measured.length, off: off.length, byKind,
  worst: [...off].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 25) };
await writeFile(join(outDir, 'samples.json'), JSON.stringify(all, null, 1));
await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ samples: summary.samples, off: summary.off, byKind }, null, 1));

process.exit(0);
