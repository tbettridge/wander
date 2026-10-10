// Render both new animals and exercise village streaming/containment in Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'wander-livestock-'));
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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [], report = { models: [] };
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGL/i.test(m.text())) errors.push(m.text()); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/animal-lab.html?clean&species=sheep&view=quarter`);
  await page.waitForFunction(() => window.__animalLab?.selected, null, { timeout: 60000 });
  for (const species of ['sheep', 'cow']) {
    await page.evaluate(species => __animalLab.select(species, 'quarter'), species);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifacts, `${species}.png`) });
    const model = await page.evaluate(() => {
      const a = __animalLab.selected;
      return { species: a.recipe.id, shapes: a.asset.shapes.length, vertices: a.mesh.geometry.attributes.position.count,
        shaderReady: !!a.material.userData.shader, meshes: a.mesh.isMesh ? 1 : 0 };
    });
    assert.ok(model.shaderReady && model.shapes <= 96 && model.vertices > 0 && model.meshes === 1);
    report.models.push(model);
  }
  report.population = await page.evaluate(async () => {
    const THREE = await import('three');
    const { World } = await import('/src/world.js');
    const { AnimalSystem } = await import('/src/animals.js?v=5');
    const { settlementsAround } = await import('/src/settlementplacement.mjs');
    const { pastureContains } = await import('/src/livestockpasture.mjs');
    const system = new AnimalSystem(new THREE.Scene(), new World(20260612));
    Object.assign(system.debug, { spawnFox: false, spawnMoose: false, spawnDeer: false, spawnHorses: false });
    let fields, village;
    outer: for (let r = 0; r < 8; r++) for (let cx = -r; cx <= r; cx++) for (let cz = -r; cz <= r; cz++) {
      if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
      for (const site of settlementsAround(system.world, cx * 3200 + 1600, cz * 3200 + 1600,
        system.world.seed, 2000, [])) {
        if (site.isStationSettlement) continue;
        system.pastureSpawns([site], system.activeSpecies(), new Map());
        fields = [...system.pastureCache.values()].find(fs => fs.length === 2 && fs[0].plan.site.id === site.id);
        if (fields) { village = site; break outer; }
      }
    }
    if (!fields) throw new Error('No rural village with two usable grazing fields');
    const points = fields.map(f => f.pasture);
    system.survey(points[0].x, points[0].z, { interestPositions: [points[1], points[0]] });
    const initial = [...system.streamed].map(([id, entry]) => ({ id, species: entry.species, phenotype: entry.agent.phenotype }));
    const counts = Object.fromEntries(['sheep', 'cow'].map(s => [s, initial.filter(e => e.species === s).length]));
    if (counts.sheep < 4 || counts.cow < 3) throw new Error(`Incomplete groups: ${JSON.stringify(counts)}`);
    const start = new Map([...system.streamed].map(([id, e]) => [id, e.agent.mesh.position.clone()]));
    system.startupContextDelay = Infinity;
    const player = new THREE.Vector3(points[0].x + 40, 12, points[0].z);
    const otherPlayer = { x: points[1].x + 40, z: points[1].z, y: 12 };
    const states = new Set();
    for (let tick = 0; tick < 1800; tick++) {
      system.update(1 / 30, player, 0, true, { interestPositions: [otherPlayer] });
      for (const entry of system.streamed.values()) {
        const a = entry.agent;
        states.add(a.state);
        if (!pastureContains(a.pasture, a.mesh.position.x, a.mesh.position.z, a.structureRadius - 0.01))
          throw new Error('Livestock escaped its grazing field');
        if (!Number.isFinite(a.mesh.position.y) || !a.safeAhead(a.mesh.position.x, a.mesh.position.z))
          throw new Error('Livestock moved onto unsafe ground');
      }
    }
    const moved = [...system.streamed].filter(([id, e]) => e.agent.mesh.position.distanceTo(start.get(id)) > 1).length;
    if (!moved || !states.has('graze')) throw new Error('Livestock did not walk and graze');
    const snapshot = system.sharedStateSnapshot();
    if (Object.keys(snapshot).length !== initial.length) throw new Error('Population changed during grazing');
    const replica = new AnimalSystem(new THREE.Scene(), system.world);
    replica.applySharedState({ animals: snapshot });
    if (replica.streamed.size !== initial.length) throw new Error('Multiplayer livestock replication failed');
    replica.dispose();
    system.survey(points[0].x + 2000, points[0].z + 2000);
    if (system.streamed.size) throw new Error('Livestock did not unload');
    system.survey(points[0].x, points[0].z, { interestPositions: [points[1]] });
    const returned = [...system.streamed].map(([id, entry]) => ({ id, species: entry.species, phenotype: entry.agent.phenotype }));
    if (JSON.stringify(initial) !== JSON.stringify(returned)) throw new Error('Livestock identity changed on return');
    Object.assign(system.debug, { spawnSheep: false, spawnCows: false });
    system.survey(points[0].x, points[0].z, { interestPositions: [points[1]] });
    if (system.streamed.size) throw new Error('Livestock toggles did not clear population');
    system.resetRegion(system.world);
    if (system.pastureCache.size) throw new Error('Old region fields retained');
    system.dispose();
    return { village: { id: village.id, kind: village.kind, x: village.x, z: village.z }, counts, moved,
      states: [...states], fields: points, simulatedSeconds: 60, stableOnReturn: true, replicated: true };
  });
  if (process.argv.includes('--world')) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?wanderSeed=20260612&waterPreview=basins`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wander, null, { timeout: 120000 });
    await page.evaluate(() => { __wander.quality.setLevel(0); __wander.quality.locked = true; });
    await page.fill('#player-name', 'Livestock QA'); await page.click('#player-name-save');
    await page.waitForFunction(() => document.getElementById('status').textContent.toLowerCase().includes('ready'), null, { timeout: 120000 });
    await page.click('#start-button');
    await page.evaluate(village => {
      const w = __wander;
      w.sky.timeScale = 0; w.sky.time = 0.5;
      w.teleport(village.x, village.z);
    }, report.population.village);
    await page.waitForFunction(() => !__wander.settlements.loading
      && [...__wander.animals.streamed.values()].some(e => e.species === 'sheep'), null, { timeout: 120000 });
    report.world = [];
    for (const species of ['sheep', 'cow']) {
      const stats = await page.evaluate(species => {
        const w = __wander;
        const entry = [...w.animals.streamed.values()].find(e => e.species === species);
        if (!entry) throw new Error(`No streamed ${species} near the farmstead`);
        const field = entry.agent.pasture, village = entry.agent.pasturePlan.site;
        const d = Math.hypot(field.x - village.x, field.z - village.z);
        const vx = (field.x - village.x) / d, vz = (field.z - village.z) / d;
        w.teleport(field.x + vx * 23, field.z + vz * 23);
        w.controls.yaw = Math.atan2(vx, vz); w.controls.pitch = -0.08;
        w.animals.survey(field.x, field.z);
        return { species, count: [...w.animals.streamed.values()].filter(e => e.species === species).length,
          field, village: village.id, terrain: w.world.biomeAt(field.x, field.z).id };
      }, species);
      await page.waitForFunction(() => [...document.querySelectorAll('body > [role="status"]')]
        .every(el => getComputedStyle(el).display === 'none'), null, { timeout: 180000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(artifacts, `${species}-field.png`) });
      assert.ok(stats.count >= (species === 'sheep' ? 4 : 3));
      report.world.push(stats);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS:', JSON.stringify(report));
  console.log('Artifacts:', artifacts);
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png') });
  console.error('Browser errors:', errors, 'Artifacts:', artifacts); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
