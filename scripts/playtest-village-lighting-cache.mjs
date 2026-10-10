// Reproduce an immutable pre-lighting browser cache, then upgrade without
// clearing it. Requires Chrome, Playwright and the pre-lighting Git snapshot.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
// Optional isolation for a checkout being edited by another task. Test this
// feature against committed versions of unrelated modified source modules.
const isolated = new Map();
if (process.env.WANDER_ISOLATE_CHECKOUT) {
  const owned = new Set(['index.html', 'src/main.js', 'src/threeruntime.js', 'src/npcavatar.js',
    'src/npcmobilitypresentation.js', 'src/npcjourneylantern.js', 'src/npcjourneylantern.mjs', 'src/villagelighting.mjs']);
  const changed = execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: root }).toString().trim().split('\n');
  for (const file of changed) if (/^src\/.*\.m?js$/.test(file) && !owned.has(file)) {
    isolated.set('/' + file, execFileSync('git', ['show', `HEAD:${file}`], { cwd: root }));
  }
}

const baseline = process.env.WANDER_CACHE_BASE_REF || '592b777';
const currentIndex = await readFile(process.env.WANDER_INDEX_PROOF_SOURCE || root + 'index.html', 'utf8');
const expectedMainVersion = currentIndex.match(/src\/main\.js\?v=([^"]+)/)?.[1];
const previous = new Map();
for (const file of ['index.html', 'src/threeruntime.js', 'src/main.js', 'src/settlementstream.js',
  'src/villagedistrictvisuals.js', 'src/npcmobilitypresentation.js', 'src/railwaystream.js', 'src/railstation.js', 'src/railstation.mjs', 'src/npcavatar.js', 'src/npcbodybake.js', 'src/animals.js', 'src/carriedlantern.js']) {
  previous.set('/' + file, execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root }));
}
const previousBuild = previous.get('/src/threeruntime.js').toString().match(/const appBuild = '([^']+)'/)?.[1] || null;
let phase = 'old';
const requests = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error('Invalid path');
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.setHeader('cache-control', path.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable');
    requests.push({ phase, path: req.url });
    let data = phase === 'old' && previous.has(path) ? previous.get(path) : await readFile(root + path);
    if (phase === 'unchanged-urls' && path === '/index.html') data = previous.get(path);
    if (phase === 'fixed' && path === '/index.html' && process.env.WANDER_INDEX_PROOF_SOURCE) data = await readFile(process.env.WANDER_INDEX_PROOF_SOURCE);
    if (isolated.has(path)) data = isolated.get(path);
    if (path === '/src/main.js' && phase !== 'old' && process.env.WANDER_MAIN_PROOF_SOURCE) data = await readFile(process.env.WANDER_MAIN_PROOF_SOURCE);
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const errors = [];
page.on('pageerror', error => { errors.push({ phase, message: error.message }); console.log('Browser error:', phase, error.message); });
const loaded = async () => {
  await page.waitForFunction(() => window.__wander, null, { timeout: 120000 });
  await page.evaluate(() => { __wander.quality.setLevel(0); __wander.quality.locked = true; });
  return page.evaluate(() => ({ build: window.__WANDER_APP_BUILD__ || null, lighting: !!__wander.villageLighting, journey: !!__wander.npcJourneyLanterns, slots: __wander.villageLighting?.lights.length }));
};
try {
  await page.goto(url + '/?cache-generation=old', { waitUntil: 'domcontentloaded' });
  const old = await loaded(); assert.equal(old.lighting, !!previousBuild); assert.equal(old.build, previousBuild);
  console.log('REPRODUCED: previous cached runtime', JSON.stringify(old));
  phase = 'unchanged-urls';
  await page.goto(url + '/?cache-generation=unchanged', { waitUntil: 'domcontentloaded' });
  const stale = await loaded(); assert.deepEqual(stale, old);
  console.log('REPRODUCED: current server plus unchanged script URLs retains the old runtime', JSON.stringify(stale));
  phase = 'fixed';
  await page.goto(url + '/?cache-generation=fixed', { waitUntil: 'domcontentloaded' });
  const fixed = await loaded(); assert.equal(fixed.lighting, true); assert.equal(fixed.journey, true); assert.equal(fixed.slots, 6);
  assert.equal(fixed.build, 'lighthouse-interiors-1');
  const shared = await page.evaluate(async () => {
    const [a, b] = await Promise.all([import('/src/npcavatar.js?v=6'), import('/src/npcavatar.js?v=7')]);
    __wander.sky.time = 0;
    __wander.weather.update(__wander.sky.dayIndex, __wander.sky.time, __wander.sky.sunElevation, __wander.sky.moonIllum);
    return a === b;
  });
  assert.equal(shared, true);
  await page.waitForFunction(() => __wander.villageLighting.debug.night > .99, null, { timeout: 15000 });
  assert.ok(requests.some(r => r.phase === 'fixed' && r.path === '/src/main.js?v=' + expectedMainVersion));
  assert.ok(requests.some(r => r.phase === 'fixed' && r.path === '/src/settlementstream.js?v=lighthouse-interiors-1'));
  assert.ok(requests.some(r => r.phase === 'fixed' && r.path === '/src/railwaystream.js?v=lighthouse-interiors-1'));
  assert.ok(requests.some(r => r.phase === 'fixed' && r.path === '/src/railstation.js?v=lighthouse-interiors-1'));
  assert.equal(requests.some(r => r.phase === 'fixed' && /\/src\/(npcavatar|npcbodybake|settlementstream)\.js(?:\?v=(6|7|sharedworld18))?$/.test(r.path)), false);
  assert.deepEqual(errors, []);
  console.log('PASS: cached previous tab upgrades without cache clearing; NPC imports coalesce; debug time jump activates night lighting', JSON.stringify(fixed));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
