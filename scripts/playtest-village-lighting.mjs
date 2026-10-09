// Native shader/pixel proof on both supported Three versions, plus real-world
// village streaming and actor checks. Requires Playwright and Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.WANDER_LIGHTING_ARTIFACTS || await mkdtemp(join(tmpdir(), 'wander-village-lighting-'));
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error('Invalid path');
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (path === '/lighting-proof') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body style="margin:0;background:#151b21"><script src="/src/threeruntime.js?v=5"></script></body></html>'); return;
    }
    res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(root + path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.WANDER_CHROME_PATH ? { executablePath: process.env.WANDER_CHROME_PATH } : { channel: 'chrome' }),
  headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [], report = { runtimes: [] };
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /THREE|shader|village/i.test(message.text())) errors.push(message.text()); });
try {
  for (const runtime of process.argv.includes('--game-only') ? [] : ['candidate', 'baseline']) {
    await page.goto(`${url}/lighting-proof?three=${runtime}`);
    const proof = await page.evaluate(async () => {
      const THREE = await import('three');
      const { VillageLightingSystem, bakeVillageLighting } = await import('/src/villagelighting.js');
      const { villageLightingNight, VILLAGE_LIGHTING } = await import('/src/villagelighting.mjs');
      const { createNpcBodyMaterial } = await import('/src/npcbodybake.js');
      const { buildDistrictVisuals } = await import('/src/villagedistrictvisuals.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(960, 720); renderer.toneMapping = THREE.ACESFilmicToneMapping;
      document.body.appendChild(renderer.domElement);
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x151b21);
      scene.add(new THREE.HemisphereLight(0x9cbbdf, 0x242019, .15));
      const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, .1, 50);
      camera.position.set(0, 3, 8); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
      const group = new THREE.Group(), detail = new THREE.Group(); detail.name = 'proof:district-detail';
      scene.add(group); group.add(detail);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, .3), new THREE.MeshStandardMaterial({ color: 0x9f907a, roughness: .95 }));
      wall.position.set(-1, 1, 0); wall.castShadow = true; group.add(wall);
      const plan = { site: { id: 'proof' }, district: {}, buildings: [{ x: -1, y: 0, z: 0, width: 2, depth: .3, floorCount: 1, floorHeight: 2 }] };
      const system = new VillageLightingSystem(scene);
      const build = bakeVillageLighting(group, plan, { height: () => 0 }, [{ x: 0, y: 3, z: 1.8 }]);
      let result, steps = 0, maxStepMs = 0;
      do { const start = performance.now(); result = build.next(); maxStepMs = Math.max(maxStepMs, performance.now() - start); steps++; } while (!result.done);
      const bake = result.value;
      system.register('proof', group, detail, bake);
      const body = new THREE.SphereGeometry(.6, 16, 12), surfaces = new Float32Array(body.attributes.position.count * 2);
      for (let i = 0; i < surfaces.length; i += 2) surfaces[i] = .95;
      body.setAttribute('npcSurface', new THREE.BufferAttribute(surfaces, 2));
      body.setAttribute('color', new THREE.BufferAttribute(new Float32Array(body.attributes.position.count * 3).fill(1), 3));
      const actor = new THREE.Mesh(body, createNpcBodyMaterial()); actor.position.set(1, 1.1, 1); scene.add(actor);
      const viewer = new THREE.Vector3(0, 0, 2);
      for (let i = 0; i < 120; i++) system.update(1 / 60, viewer, { night: 1, actors: [{ root: actor }], camera });
      const target = new THREE.WebGLRenderTarget(160, 120);
      const draw = () => {
        renderer.setRenderTarget(target); renderer.render(scene, camera);
        const pixels = new Uint8Array(160 * 120 * 4); renderer.readRenderTargetPixels(target, 0, 0, 160, 120, pixels);
        renderer.setRenderTarget(null); renderer.render(scene, camera); return pixels;
      };
      const sum = (pixels, position) => {
        const p = position.clone().project(camera), x = Math.round((p.x * .5 + .5) * 160), y = Math.round((p.y * .5 + .5) * 120);
        let value = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let c = 0; c < 3; c++) value += pixels[((y + dy) * 160 + x + dx) * 4 + c];
        return value;
      };
      const saved = system.lights.map(light => light.intensity);
      system.lights.forEach(light => light.intensity = 0); const off = draw();
      const programs = renderer.info.programs.length;
      system.lights.forEach((light, index) => light.intensity = saved[index]); const on = draw();
      const wallPoint = new THREE.Vector3(-1, 1.3, .151), actorPoint = actor.position.clone().add(new THREE.Vector3(0, 0, .5));
      const native = { staticDifference: sum(on, wallPoint) - sum(off, wallPoint), actorDifference: sum(on, actorPoint) - sum(off, actorPoint), programsBefore: programs, programsAfter: renderer.info.programs.length };
      const ordinary = new THREE.PointLight(0xffffff, 9, 12, 2); ordinary.position.set(0, 3, 1.8); scene.add(ordinary);
      const ordinaryOn = draw(); native.ordinaryLightDifference = sum(ordinaryOn, wallPoint) - sum(on, wallPoint); scene.remove(ordinary);
      const nightPixels = bake.ground.material.map.image.data.filter((_, index) => index % 4 === 3 && bake.ground.material.map.image.data[index] > 0).length;
      const captured = buildDistrictVisuals(new THREE.Group(), new THREE.Group(), {
        boundaries: [], gates: [], windowBoxes: [], stones: [], gutters: [],
        posts: [{ x: 4, y: 0, z: 2, height: 2.4, kind: 'lantern-post' }], props: [{ x: 2, y: 0, z: 4, kind: 'lamp-post', variant: 1 }],
        lines: [{ kind: 'lanterns', ax: -5, ay: 4, az: 4, bx: 5, by: 4, bz: 4, sag: .6, seed: 12 }],
      }, { height: () => 0 });
      const positions = captured.lightSources.map(s => [s.x, s.y, s.z]);
      const daytime = system.update(.1, viewer, { night: 0, actors: [{ root: actor }], camera });
      const day = { groundVisible: bake.ground.visible, uniform: villageLightingNight.value };
      for (let i = 0; i < 120; i++) system.update(1 / 60, viewer, { night: 1, xr: true, actors: [{ root: actor }], camera });
      const xr = { ...system.debug, shadowless: system.lights.every(l => !l.castShadow) };
      system.update(.1, viewer, { night: 1, actors: [{ root: actor }], camera }); draw();
      window.__lightingProof = { renderer, scene, camera, system, draw };
      return { revision: THREE.REVISION, savedIntensities: saved, actorDefine: actor.material.defines, actorOff: sum(off, actorPoint), actorOn: sum(on, actorPoint), bake: bake.debug, steps, maxStepMs, native, nightPixels, day, xr, capturedPositions: positions };
    });
    console.log('Shader proof:', JSON.stringify(proof), 'Errors:', JSON.stringify(errors));
    await page.screenshot({ path: join(artifacts, `shader-proof-r${proof.revision}.png`) });
    assert.equal(proof.native.staticDifference, 0, 'native lights changed baked wall brightness');
    assert.ok(proof.native.actorDifference > 200, 'NPC body failed to receive real point lighting');
    assert.ok(proof.native.ordinaryLightDifference > 100, 'ordinary point lights were incorrectly filtered');
    assert.equal(proof.native.programsBefore, proof.native.programsAfter, 'intensity changes compiled new programs');
    assert.ok(proof.bake.bakedVertices > 0); assert.ok(proof.nightPixels > 0);
    assert.equal(proof.day.groundVisible, false); assert.equal(proof.day.uniform, 0);
    assert.equal(proof.xr.budget, 2); assert.ok(proof.xr.active <= 2); assert.equal(proof.xr.shadowless, true);
    assert.ok(proof.capturedPositions.length > 2); assert.ok(proof.capturedPositions.flat().every(Number.isFinite));
    const station = await page.evaluate(async () => {
      const THREE = await import('three');
      const { VillageLightingSystem, bakeVillageLighting } = await import('/src/villagelighting.js');
      const { villageLightingNight, enableVillageActorLighting } = await import('/src/villagelighting.mjs');
      const { RegionalRailwayTrack } = await import('/src/railwaystream.js');
      const { buildStationGroup } = await import('/src/railstation.js');
      const { stationLampPositions, stationLightingPlan, STATION_LAYOUT } = await import('/src/railstation.mjs');
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x070b12);
      scene.add(new THREE.HemisphereLight(0x9cbbdf, 0x242019, .08));
      const world = { height: () => 9 }, track = new RegionalRailwayTrack(scene, world);
      const spec = { id: 'proof-station', x: 40, z: -30, formationY: 10, tangentX: Math.SQRT1_2, tangentZ: Math.SQRT1_2 };
      const group = buildStationGroup(spec, 'LIGHTING', track.materials, new THREE.MeshStandardMaterial());
      group.position.set(40, 10, -30); group.rotation.y = Math.PI / 4; scene.add(group); group.updateMatrixWorld(true);
      const point = (x, y, z) => group.localToWorld(new THREE.Vector3(x, y, z));
      const sources = stationLampPositions().map(s => { const p = point(s.x, s.y, s.z); return { x: p.x, y: p.y, z: p.z }; });
      const build = bakeVillageLighting(group, stationLightingPlan(spec), world, sources, { includeMesh: m => m.receiveShadow && m.material !== track.materials.lantern });
      let result; do { result = build.next(); } while (!result.done);
      const bake = result.value, system = new VillageLightingSystem(scene), release = system.register('station', group, group, bake);
      const local = stationLampPositions()[0], platformPoint = point(local.x + .65, STATION_LAYOUT.platformTop + .002, local.z);
      const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, .1, 80);
      camera.position.copy(point(local.x, 6.5, local.z + 7)); camera.lookAt(point(local.x, STATION_LAYOUT.platformTop, local.z)); camera.updateMatrixWorld(true);
      const renderer = window.__lightingProof.renderer, target = new THREE.WebGLRenderTarget(160, 120);
      const draw = () => { renderer.setRenderTarget(target); renderer.render(scene, camera); const pixels = new Uint8Array(160 * 120 * 4); renderer.readRenderTargetPixels(target, 0, 0, 160, 120, pixels); renderer.setRenderTarget(null); return pixels; };
      const sum = (pixels, p) => { const projected = p.clone().project(camera), x = Math.round((projected.x * .5 + .5) * 160), y = Math.round((projected.y * .5 + .5) * 120); let value = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let c = 0; c < 3; c++) value += pixels[((y + dy) * 160 + x + dx) * 4 + c]; return value; };
      villageLightingNight.value = 0; const dark = draw(); villageLightingNight.value = 1; const baked = draw();
      const viewer = point(local.x, STATION_LAYOUT.platformTop, local.z);
      for (let i = 0; i < 120; i++) system.update(1 / 60, viewer, { night: 1 });
      const dynamic = draw();
      const actor = new THREE.Mesh(new THREE.SphereGeometry(.45), enableVillageActorLighting(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 })));
      actor.position.copy(point(local.x + 1.5, STATION_LAYOUT.platformTop + .9, local.z)); scene.add(actor);
      const actorPoint = actor.position.clone().lerp(camera.position, .025), lit = draw();
      system.lights.forEach(l => l.intensity = 0); const unlit = draw();
      const groundVertex = new THREE.Vector3().fromBufferAttribute(bake.ground.geometry.attributes.position, 0); group.localToWorld(groundVertex);
      const check = { bake: { ...bake.debug }, platformBakeDifference: sum(baked, platformPoint) - sum(dark, platformPoint), platformNativeDifference: sum(dynamic, platformPoint) - sum(baked, platformPoint), actorDifference: sum(lit, actorPoint) - sum(unlit, actorPoint), groundWorldHeight: groundVertex.y, slots: system.lights.length, shadows: false };
      group.traverse(o => { if (o.isMesh && o.castShadow) check.shadows = true; });
      release(); system.update(.1, viewer, { night: 1 }); check.remainingSources = system.debug.sources;
      target.dispose(); system.dispose(); track.dispose();
      return check;
    });
    assert.ok(station.platformBakeDifference > 100, 'raised station platform failed to show baked lighting');
    assert.equal(station.platformNativeDifference, 0, 'station static lighting doubled when player approached');
    assert.ok(station.actorDifference > 100, 'station point light failed to illuminate an actor');
    assert.ok(Math.abs(station.groundWorldHeight - 9.065) < .001, 'rotated station displaced its ground glow');
    assert.equal(station.shadows, false); assert.equal(station.slots, 6); assert.equal(station.remainingSources, 0);
    proof.station = station;
    console.log('PASS: station platform and actor pixel proof', JSON.stringify(station));
    report.runtimes.push(proof);
    await page.screenshot({ path: join(artifacts, `shader-proof-r${proof.revision}.png`) });
    console.log(`PASS: r${proof.revision} native light/material pixel checks`, JSON.stringify(proof));
  }
  if (process.argv.includes('--game')) {
    console.log('Game: loading world');
    await page.goto(`${url}/?wanderSeed=20260612`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wander, null, { timeout: 120000 });
    await page.evaluate(() => { __wander.quality.setLevel(0); __wander.quality.locked = true; });
    await page.fill('#player-name', 'Village lighting QA'); await page.click('#player-name-save');
    await page.waitForFunction(() => document.getElementById('status').textContent.toLowerCase().includes('ready'), null, { timeout: 120000 });
    await page.click('#start-button');
    await page.evaluate(async () => {
      const w = __wander;
      if (!w.regionalRailway.plan) w.regionalRailway.generate();
      const { stationSettlements } = await import('/src/stationsettlement.mjs');
      const site = stationSettlements(w.world, w.world.seed).find(s => s.kind === 'station-village');
      if (!site) throw new Error('No station village generated for lighting test');
      window.__lightingTestSite = site;
      w.settlements.lastQueryX = Infinity;
      w.teleport(site.x, site.z);
    });
    console.log('Game: moving to village', await page.evaluate(() => ({ site: __lightingTestSite, player: __wander.controls.rig.position.toArray() })));
    await page.waitForFunction(() => [...__wander.settlements.active.values()].some(v => v.lightingBake.field.lights.length) && !__wander.settlements.loading, null, { timeout: 120000 });
    await page.evaluate(() => { __wander.sky.timeScale = 0; __wander.tick(.02); });
    await page.waitForTimeout(1500);
    report.game = await page.evaluate(() => {
      const w = __wander, villages = [...w.settlements.active.values()];
      const village = villages.find(v => v.lightingBake.field.lights.length);
      if (!village) throw new Error('No village lanterns materialized');
      const ranked = village.lightingBake.field.lights.map(source => {
        const height = w.world.height(source.x, source.z);
        return { source, height, warmth: village.lightingBake.field.sample({ x: source.x, y: height, z: source.z }) };
      }).sort((a, b) => (b.warmth * Math.max(.1, b.source.y - b.height)) - (a.warmth * Math.max(.1, a.source.y - a.height)));
      const source = ranked[0].source;
      w.teleport(source.x + 2, source.z + 5); w.controls.yaw = Math.atan2(2, 5); w.controls.pitch = -.07;
      const actor = village.residents.find(r => r.avatar?.root);
      if (actor) { actor.root.position.set(source.x + .7, w.world.height(source.x + .7, source.z), source.z); actor.root.visible = true; actor.dormant = false; actor.greetingLock = 100; }
      for (let i = 0; i < 100; i++) w.tick(.02);
      let actorReceivesLight = false;
      actor?.avatar.root.traverse(child => { if (child.isSkinnedMesh && child.material?.defines?.WANDER_VILLAGE_ACTOR) actorReceivesLight = true; });
      return { lighting: { ...w.villageLighting.debug }, villages: villages.map(v => ({ id: v.site.id, ...v.lightingBake.debug })),
        actorReceivesLight, sourceCheck: ranked.slice(0, 3).map(r => ({ source: [r.source.x, r.source.y, r.source.z], ground: r.height, warmth: r.warmth })),
        slots: w.villageLighting.lights.length,
      };
    });
    await page.waitForTimeout(1500); await page.screenshot({ path: join(artifacts, 'village-night.png') });
    assert.equal(report.game.slots, 6); assert.ok(report.game.lighting.sources > 0);
    assert.ok(report.game.lighting.bakedVertices > 0); assert.ok(report.game.lighting.textureBytes > 0);
    assert.ok(report.game.actorReceivesLight);
    report.game.cacheReentry = await page.evaluate(() => {
      const w = __wander, current = [...w.settlements.active.values()].find(v => v.lightingBake.field.lights.length), site = current.site;
      w.settlements._unload(site.id);
      const loaded = w.settlements._load(site, w.controls.rig.position);
      w.settlements.active.set(site.id, loaded);
      return { ...loaded.lightingBake.debug };
    });
    assert.equal(report.game.cacheReentry.cacheHit, true);
    await page.evaluate(() => {
      const w = __wander, station = w.regionalRailway.plan.stations[0];
      window.__stationLightingTest = station;
      w.teleport(station.x, station.z);
    });
    await page.waitForFunction(() => [...__wander.villageLighting.villages.keys()].some(id => id.startsWith('railway-station:')), null, { timeout: 120000 });
    await page.evaluate(() => {
      const w = __wander, { bake } = [...w.villageLighting.villages.values()].find(v => v.bake.field.lights[0]?.id.startsWith('railway-station:'));
      const source = bake.field.lights[0], s = __stationLightingTest;
      const dx = -s.tangentX * 6 - s.tangentZ * 3, dz = -s.tangentZ * 6 + s.tangentX * 3;
      w.teleport(source.x + dx, source.z + dz);
      w.controls.yaw = Math.atan2(dx, dz); w.controls.pitch = .08; w.tick(0);
    });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(artifacts, 'station-night.png') });
    report.game.station = await page.evaluate(async () => {
      const w = __wander;
      const entry = [...w.villageLighting.villages.entries()].find(([id]) => id.startsWith('railway-station:'));
      const [id, { bake, group }] = entry, source = bake.field.lights[0];
      w.teleport(source.x + .7, source.z + .7); w.sky.time = 0;
      for (let i = 0; i < 100; i++) w.tick(.02);
      const result = { id, ...bake.debug, activeStationSlots: w.villageLighting.pool.filter(s => s.level > .01 && s.source?.id.startsWith(id)).length, slots: w.villageLighting.lights.length };
      w.regionalRailwayTrack.clear();
      result.released = !w.villageLighting.villages.has(id);
      result.pendingAfterClear = w.regionalRailwayTrack.lightingJobs.size;
      // Reenter using the same canonical plan: the atlas should be reused.
      for (let i = 0; i < 300 && !w.villageLighting.villages.has(id); i++) w.regionalRailwayTrack.update(source.x, source.z);
      const reentry = w.villageLighting.villages.get(id);
      result.reentryCacheHit = reentry?.bake.debug.cacheHit;
      if (reentry?.bake.ground) {
        const THREE = await import('three');
        const p = new THREE.Vector3().fromBufferAttribute(reentry.bake.ground.geometry.attributes.position, 0);
        reentry.bake.ground.localToWorld(p);
        result.reentryGroundError = Math.abs(p.y - w.world.height(p.x, p.z) - .065);
      }
      // Also cancel a partially baked tile, before any material registration.
      w.regionalRailwayTrack.clear();
      w.regionalRailwayTrack.update(source.x, source.z);
      w.regionalRailwayTrack.clear();
      result.pendingAfterCancel = w.regionalRailwayTrack.lightingJobs.size;
      const plan = w.regionalRailway.plan;
      w.regionalRailwayTrack.setPlan(null);
      result.regenerationReleased = ![...w.villageLighting.villages.keys()].some(key => key.startsWith('railway-station:'));
      w.regionalRailwayTrack.setPlan(plan);
      for (let i = 0; i < 300 && !w.villageLighting.villages.has(id); i++) w.regionalRailwayTrack.update(source.x, source.z);
      result.regeneratedFreshBake = w.villageLighting.villages.get(id)?.bake.debug.cacheHit === false;
      return result;
    });
    assert.equal(report.game.station.sources, 2); assert.ok(report.game.station.bakedVertices > 0);
    assert.ok(report.game.station.activeStationSlots > 0); assert.equal(report.game.station.slots, 6);
    assert.equal(report.game.station.released, true); assert.equal(report.game.station.pendingAfterClear, 0);
    assert.equal(report.game.station.reentryCacheHit, true); assert.ok(report.game.station.reentryGroundError < .01); assert.equal(report.game.station.pendingAfterCancel, 0);
    assert.equal(report.game.station.regenerationReleased, true); assert.equal(report.game.station.regeneratedFreshBake, true);
    console.log('PASS: station tile streaming, shared pool, reload cache and cancellation', JSON.stringify(report.game.station));
    report.game.cleanup = await page.evaluate(() => {
      const w = __wander;
      w.regionalRailwayTrack.clear();
      for (const id of [...w.settlements.active.keys()]) w.settlements._unload(id);
      w.settlements.updateLighting(.1, w.controls.rig.position, { night: 1 });
      return { villages: w.villageLighting.villages.size, activeLights: w.villageLighting.debug.active, sources: w.villageLighting.debug.sources };
    });
    assert.equal(report.game.cleanup.villages, 0); assert.equal(report.game.cleanup.activeLights, 0);
    console.log('PASS: real village streaming, actor materials and unload cleanup', JSON.stringify(report.game));
  }
  assert.deepEqual(errors, []); report.errors = errors;
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Artifacts:', artifacts);
} catch (error) {
  console.log('Browser errors:', JSON.stringify(errors));
  console.log('Game diagnostics:', JSON.stringify(await page.evaluate(() => {
    const w = window.__wander; if (!w) return { status: document.getElementById('status')?.textContent };
    return { status: document.getElementById('status')?.textContent, player: w.controls.rig.position.toArray(), target: window.__lightingTestSite,
      lighting: w.villageLighting.debug, loading: w.settlements.loading?.site, features: w.settlements.state.features,
      active: [...w.settlements.active.values()].map(v => ({ id: v.site.id, kind: v.site.kind, sources: v.lightingBake?.field.lights.length, hasDistrict: !!v.plan.district, square: v.plan.square })),
      geometry: w.settlements.root.children.map(g => ({ name: g.name, visible: g.visible, meshes: g.children.length })) };
  }).catch(() => ({ unavailable: true }))));
  await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
