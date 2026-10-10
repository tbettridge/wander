// Real-world rural generation, streamed interiors and baked lantern lighting.
// Requires Chrome and Playwright (or WANDER_PLAYWRIGHT_PATH).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'wander-rural-villages-'));
const server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error('Invalid path');
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(root + path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const browser = await chromium.launch({
  ...(process.env.WANDER_CHROME_PATH ? { executablePath: process.env.WANDER_CHROME_PATH } : { channel: 'chrome' }),
  headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [], report = { settlements: [] };
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && /THREE|shader|interior|settlement/i.test(m.text())) errors.push(m.text()); });
try {
  // A fixed basin preview keeps terrain immutable across distant test visits;
  // default regional travel is also supported with --regional.
  const water = process.argv.includes('--regional') ? '' : '&waterPreview=basins';
  await page.goto(`http://127.0.0.1:${server.address().port}/?wanderSeed=20260612${water}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wander, null, { timeout: 120000 });
  await page.evaluate(() => { __wander.quality.setLevel(0); __wander.quality.locked = true; });
  await page.fill('#player-name', 'Rural village QA'); await page.click('#player-name-save');
  await page.waitForFunction(() => document.getElementById('status').textContent.toLowerCase().includes('ready'), null, { timeout: 120000 });
  await page.click('#start-button');
  for (const kind of ['farmstead', 'hamlet', 'village']) {
    await page.evaluate(async kind => {
      const w = __wander, { settlementsAround } = await import('/src/settlementplacement.mjs');
      let site;
      outer: for (let r = 0; r < 12; r++) for (let ci = -r; ci <= r; ci++) for (let cj = -r; cj <= r; cj++) {
        if (Math.max(Math.abs(ci), Math.abs(cj)) !== r) continue;
        const sites = settlementsAround(w.world, ci * 3200 + 1600, cj * 3200 + 1600, w.world.seed, 3000, []);
        site = sites.find(s => s.kind === kind && !s.isStationSettlement);
        if (site) break outer;
      }
      if (!site) throw new Error(`No rural ${kind}`);
      window.__ruralSite = site;
      w.settlements.lastQueryX = Infinity; w.teleport(site.x, site.z);
    }, kind);
    await page.waitForFunction(() => __wander.settlements.active.has(__ruralSite.id) && !__wander.settlements.loading, null, { timeout: 120000 });
    await page.waitForFunction(() => [...document.querySelectorAll('body > [role="status"]')]
      .every(el => getComputedStyle(el).display === 'none'), null, { timeout: 180000 });
    await page.evaluate(() => {
      const w = __wander, site = __ruralSite;
      // Regional travel may commit a new terrain window while a village is
      // loading. Rebuild against that final terrain before evaluating it.
      w.settlements._unload(site.id);
      w.settlements.active.set(site.id, w.settlements._load(site, w.controls.rig.position));
    });
    const stats = await page.evaluate(() => {
      const w = __wander, v = w.settlements.active.get(__ruralSite.id), p = v.plan;
      const well = p.props.find(p => p.kind === 'well');
      w.sky.timeScale = 0; w.sky.time = .5;
      w.teleport(well.x + 10, well.z + 13); w.controls.yaw = Math.atan2(10, 13); w.controls.pitch = -.05;
      for (let i = 0; i < 100; i++) w.tick(.5);
      return { kind: p.site.kind, id: p.site.id, buildings: p.buildings.length, programs: [...new Set(p.buildings.map(b => b.program))],
        markets: p.props.filter(p => p.kind === 'market-stall').length, districtBuildings: p.district.buildings.length,
        well: !!well, streets: p.streets.length, lamps: v.lightingBake.field.lights.length, bake: { ...v.lightingBake.debug },
        furnishings: p.buildings.filter(b => b.interior).length, slots: w.villageLighting.lights.length };
    });
    // A streamed settlement can exist before travel terrain is ready. Do not
    // mistake a loading veil for visual proof of the village beneath it.
    await page.waitForFunction(() => [...document.querySelectorAll('body > [role="status"]')]
      .every(el => getComputedStyle(el).display === 'none'), null, { timeout: 180000 });
    await page.waitForTimeout(1000); await page.screenshot({ path: join(artifacts, `${kind}-day.png`) });
    const night = await page.evaluate(() => {
      const w = __wander, v = w.settlements.active.get(__ruralSite.id), source = v.lightingBake.field.lights[0];
      w.sky.time = 0; w.teleport(source.x + 2, source.z + 5);
      w.controls.yaw = Math.atan2(2, 5); w.controls.pitch = -.07;
      for (let i = 0; i < 100; i++) w.tick(0);
      const height = w.world.height(source.x, source.z);
      return { visible: v.lightingBake.ground.visible, warmth: v.lightingBake.field.sample({ x: source.x, y: height, z: source.z }),
        active: w.villageLighting.debug.active, budget: w.villageLighting.debug.budget };
    });
    await page.waitForTimeout(1000); await page.screenshot({ path: join(artifacts, `${kind}-night.png`) });
    assert.ok(stats.well && stats.lamps > 0 && stats.bake.bakedVertices > 0 && stats.bake.textureBytes > 0);
    assert.equal(stats.markets, 0); assert.equal(stats.districtBuildings, 0);
    assert.equal(stats.furnishings, stats.buildings); assert.equal(stats.slots, 6);
    assert.ok(night.visible && night.warmth > 0 && night.active <= night.budget);
    const reentry = await page.evaluate(() => {
      const w = __wander, site = __ruralSite;
      w.settlements._unload(site.id);
      const v = w.settlements._load(site, w.controls.rig.position); w.settlements.active.set(site.id, v);
      return { ...v.lightingBake.debug };
    });
    assert.equal(reentry.cacheHit, true);
    report.settlements.push({ ...stats, night, reentry });
    console.log('PASS:', JSON.stringify(report.settlements.at(-1)));
  }
  assert.deepEqual(errors, []); report.errors = errors;
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Artifacts:', artifacts);
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png') });
  console.error('Browser errors:', errors, 'Artifacts:', artifacts); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
