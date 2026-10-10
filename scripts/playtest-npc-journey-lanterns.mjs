// Pixel proof on both Three runtimes and an optional real travelling-NPC check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

const artifacts = process.env.WANDER_LANTERN_ARTIFACTS || await mkdtemp(join(tmpdir(), 'wander-journey-lanterns-'));
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (path === '/lantern-proof') { res.setHeader('content-type', 'text/html'); res.end('<html><body style="margin:0"><script src="/src/threeruntime.js?v=6"></script></body></html>'); return; }
    if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error('Invalid path');
    res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    if (path === '/index.html' && process.env.WANDER_INDEX_PROOF_SOURCE) { res.end(await readFile(process.env.WANDER_INDEX_PROOF_SOURCE)); return; }
    res.end(isolated.get(path) || await readFile(path === '/src/main.js' && process.env.WANDER_MAIN_PROOF_SOURCE ? process.env.WANDER_MAIN_PROOF_SOURCE : root + path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [], report = { runtimes: [] };
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && /shader|THREE/i.test(m.text())) errors.push(m.text()); });
try {
  for (const runtime of process.argv.includes('--game-only') ? [] : ['candidate', 'baseline']) {
    await page.goto(url + '/lantern-proof?three=' + runtime);
    const proof = await page.evaluate(async () => {
      const THREE = await import('three');
      const { createNpcAvatar, NpcAssetLibrary } = await import('/src/npcavatar.js');
      const { createStationPopulation } = await import('/src/npcpopulation.mjs');
      const { VillageLightingSystem } = await import('/src/villagelighting.js');
      const { NpcJourneyLanternSystem } = await import('/src/npcjourneylantern.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(960, 720); renderer.toneMapping = THREE.ACESFilmicToneMapping;
      document.body.appendChild(renderer.domElement);
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x020306);
      scene.add(new THREE.HemisphereLight(0x9cbbdf, 0x242019, .035));
      const village = new VillageLightingSystem(scene), lanterns = new NpcJourneyLanternSystem(scene);
      const assets = new NpcAssetLibrary(), base = createStationPopulation({ id: 'proof', name: 'Proof' }, 42)[0].identity;
      const identity = { ...base, accessory: 'basket' }, avatar = createNpcAvatar(identity, assets); scene.add(avatar.root);
      const actor = { identity, avatar, roaming: true, journey: { phase: 'travel', x: 0, z: 0, heading: 0 } };
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0xaaa291, roughness: 1 })); floor.rotation.x = -Math.PI / 2; scene.add(floor);
      const camera = new THREE.PerspectiveCamera(55, 4 / 3, .1, 1200); camera.position.set(0, 2.1, 4); camera.lookAt(0, .8, 0); camera.updateMatrixWorld(true);
      const viewer = new THREE.Vector3(0, 0, 4), opts = { night: 1, actors: [actor], camera };
      for (let i = 0; i < 120; i++) lanterns.update(1 / 60, viewer, opts);
      const target = new THREE.WebGLRenderTarget(320, 240);
      const draw = () => { renderer.setRenderTarget(target); renderer.render(scene, camera); const pixels = new Uint8Array(320 * 240 * 4); renderer.readRenderTargetPixels(target, 0, 0, 320, 240, pixels); renderer.setRenderTarget(null); renderer.render(scene, camera); return pixels; };
      const sum = (pixels, point, radius = 1) => { const p = point.clone().project(camera), x = Math.round((p.x * .5 + .5) * 320), y = Math.round((p.y * .5 + .5) * 240); let total = 0; for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) for (let c = 0; c < 3; c++) total += pixels[((y + dy) * 320 + x + dx) * 4 + c]; return total; };
      const source = lanterns.pool.find(s => s.level > .99).source;
      const ground = new THREE.Vector3(source.x, .005, source.z + .45);
      const on = draw(); window.__nearLanternScreenshot = renderer.domElement.toDataURL('image/png');
      const programs = renderer.info.programs.length, saved = lanterns.lights.map(l => l.intensity);
      lanterns.lights.forEach(l => l.intensity = 0); const off = draw();
      const programsAfterOff = renderer.info.programs.length;
      const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      scene.overrideMaterial = maskMaterial; floor.visible = false; lanterns.beacons.visible = false;
      const actorMask = draw(); avatar.root.visible = false; const withoutActor = draw(); avatar.root.visible = true;
      scene.overrideMaterial = null; maskMaterial.dispose(); floor.visible = true; lanterns.beacons.visible = true;
      let actorPixels = 0, actorDifference = 0;
      const lampScreen = new THREE.Vector3(source.x, source.y, source.z).project(camera);
      const lampX = (lampScreen.x * .5 + .5) * 320, lampY = (lampScreen.y * .5 + .5) * 240;
      for (let i = 0; i < off.length; i += 4) {
        const x = i / 4 % 320, y = Math.floor(i / 4 / 320);
        if (Math.hypot(x - lampX, y - lampY) < 10) continue;
        if ([0, 1, 2].reduce((n, c) => n + Math.abs(actorMask[i + c] - withoutActor[i + c]), 0) > 8) {
          actorPixels++; actorDifference += [0, 1, 2].reduce((n, c) => n + Math.max(0, on[i + c] - off[i + c]), 0);
        }
      }
      lanterns.lights.forEach((l, i) => l.intensity = saved[i]); draw();
      const near = { source: [source.x, source.y, source.z], ...lanterns.debug, hand: avatar.journeyLanternHand, groundDifference: sum(on, ground) - sum(off, ground), actorDifference, actorPixels, programs, programsAfter: programsAfterOff };
      actor.journey.x = .2; avatar.root.position.x = .2; lanterns.update(.016, viewer, opts);
      near.movingLevel = lanterns.pool.find(s => s.id === identity.id).level;
      const model = lanterns.models.get(identity.id), modelPoint = model.root.localToWorld(new THREE.Vector3(0, -.205, 0));
      near.handLightError = lanterns.lights.find(l => l.intensity > 0).position.distanceTo(modelPoint);
      // Two occupied hands temporarily stow one prop, then restore it in daylight.
      avatar.setIntentLoadout({ leftHand: { prop: 'letter' }, rightHand: { prop: 'basket' } });
      lanterns.update(.1, viewer, opts); near.fullHandsLantern = avatar.journeyLanternHand;
      lanterns.update(.1, viewer, { ...opts, night: 0 });
      const day = { ...lanterns.debug, hand: avatar.journeyLanternHand };
      for (let i = 0; i < 120; i++) lanterns.update(1 / 60, viewer, opts);
      const density = Array.from({ length: 40 }, (_, i) => ({ id: 'far:' + i, journey: true, mode: 'walk', x: Math.sin(i) * 10, y: 0, z: Math.cos(i) * 10 }));
      for (let i = 0; i < 120; i++) lanterns.update(1 / 60, viewer, { night: 1, xr: true, travellers: density });
      const xr = { ...lanterns.debug, shadows: lanterns.lights.some(l => l.castShadow) };
      // At 600 m the full avatar is absent. The beacon has a minimum pixel
      // footprint but still loses to terrain/wall depth, even beyond scene fog.
      scene.remove(avatar.root); camera.position.set(0, 1, 0); camera.lookAt(0, .9, -600); camera.updateMatrixWorld(true);
      scene.fog = new THREE.Fog(0x020306, 30, 300);
      const farOpts = { night: 1, camera, travellers: [{ id: 'distant', journey: true, mode: 'walk', x: 0, y: 0, z: -600 }] };
      lanterns.update(.1, new THREE.Vector3(0, 0, 0), farOpts);
      const p = new THREE.Vector3(0, .9, -600), farOn = draw(); lanterns.beacons.visible = false; const farOff = draw(); lanterns.beacons.visible = true;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 1), new THREE.MeshBasicMaterial({ color: 0x020306 })); wall.position.set(0, 5, -40); scene.add(wall);
      const hiddenOn = draw(); lanterns.beacons.visible = false; const hiddenOff = draw();
      const far = { distance: 600, beaconDifference: sum(farOn, p, 2) - sum(farOff, p, 2), occludedDifference: sum(hiddenOn, p, 2) - sum(hiddenOff, p, 2), carried: lanterns.models.size, ...lanterns.debug };
      lanterns.update(.1, viewer, { night: 1, actors: [actor], sites: [{ x: 0, z: 0, radius: 200 }] });
      const villageExcluded = lanterns.debug.beacons === 0;
      actor.roaming = false; scene.add(avatar.root); lanterns.update(.1, viewer, opts);
      const strollExcluded = lanterns.debug.beacons === 0;
      lanterns.clear(); const cleared = { models: lanterns.models.size, beacons: lanterns.beacons.geometry.drawRange.count, active: lanterns.lights.filter(l => l.intensity > 0).length };
      lanterns.dispose(); village.dispose(); avatar.dispose(); assets.dispose(); target.dispose();
      return { revision: THREE.REVISION, near, day, xr, far, villageExcluded, strollExcluded, cleared };
    });
    await writeFile(join(artifacts, 'near-r' + proof.revision + '.png'), Buffer.from((await page.evaluate(() => window.__nearLanternScreenshot)).split(',')[1], 'base64'));
    console.log('Journey lantern proof:', JSON.stringify(proof));
    assert.ok(proof.near.groundDifference > 100, 'journey lantern failed to light the path');
    assert.ok(proof.near.actorDifference > 100, 'journey lantern failed to light the NPC');
    assert.equal(proof.near.hand, 'left'); assert.equal(proof.near.fullHandsLantern, 'left');
    assert.ok(proof.near.handLightError < .0001); assert.ok(proof.near.movingLevel > .99);
    assert.equal(proof.near.programs, proof.near.programsAfter);
    assert.equal(proof.day.carried, 0); assert.equal(proof.day.beacons, 0); assert.equal(proof.day.hand, null);
    assert.equal(proof.xr.slots, 3); assert.ok(proof.xr.active <= 1); assert.equal(proof.xr.shadows, false);
    assert.ok(proof.far.beaconDifference > 30, '600 m lantern beacon was not visible'); assert.equal(proof.far.occludedDifference, 0);
    assert.equal(proof.far.carried, 0); assert.equal(proof.villageExcluded, true); assert.equal(proof.strollExcluded, true);
    assert.deepEqual(proof.cleared, { models: 0, beacons: 0, active: 0 }); report.runtimes.push(proof);
  }
  if (process.argv.includes('--game')) {
    console.log('Game: loading world');
    await page.goto(url + '/?wanderSeed=20260612', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wander, null, { timeout: 120000 });
    await page.evaluate(() => { __wander.quality.setLevel(0); __wander.quality.locked = true; });
    await page.fill('#player-name', 'Journey lantern QA'); await page.click('#player-name-save');
    await page.waitForFunction(() => document.getElementById('status').textContent.toLowerCase().includes('ready'), null, { timeout: 120000 });
    await page.click('#start-button');
    await page.evaluate(() => {
      if (!__wander.regionalRailway.plan) __wander.regionalRailway.generate();
      // This initializes the regional trail graph; unified mobility need not
      // spawn any of the optional legacy station travellers.
      __wander.locations.randomNpc(); __wander.tick(0);
    });
    report.game = await page.evaluate(async () => {
      const w = __wander, state = w.livingWorld.worldState;
      const { createItinerary } = await import('/src/npcitinerary.mjs');
      const { registerNpcItinerary } = await import('/src/npcmobility.mjs');
      const { tickNpcMobilityItinerary } = await import('/src/npcmobilityexecutor.mjs');
      const { stationSettlements } = await import('/src/stationsettlement.mjs');
      const { outsideLanternVillages } = await import('/src/npcjourneylantern.mjs');
      const owned = new Set(w.npcMobility.excludedActorIdsProvider());
      const entity = Object.values(state.entities).find(e => e.kind === 'npc' && e.residence && !e.itineraryId && !owned.has(e.id));
      if (!entity) throw new Error('No idle canonical resident available for journey test');
      const target = Object.values(state.entities).find(e => e.kind === 'npc' && e.residence && e.residence.residenceSettlementId !== entity.residence.residenceSettlementId);
      const home = { kind: 'building', settlementId: entity.residence.residenceSettlementId, buildingId: entity.residence.homeBuildingId, nodeId: null };
      const destination = { kind: 'building', settlementId: target.residence.residenceSettlementId, buildingId: target.residence.homeBuildingId, nodeId: null };
      const edge = [...w.livingWorld.navGraph.nodes.values()].flatMap(n => n.links).find(link => link.edge.arcLength > 200)?.edge;
      if (!edge) throw new Error('No regional trail for journey fixture');
      const edgeLocation = { kind: 'regional-edge', edgeId: edge.id, fromKey: edge.fromKey, toKey: edge.toKey, progress: 0 };
      // Register and advance a genuine canonical round-trip walking itinerary.
      // Its two endpoints are real households in the generated station towns.
      const trip = createItinerary({ id: 'qa-lantern:' + entity.id, actorId: entity.id, residence: entity.residence,
        origin: { key: home.buildingId }, destination: { key: destination.buildingId }, purpose: { kind: 'quest' },
        outboundLegs: [{ id: 'out', kind: 'regional-walk', data: { durationSeconds: 36000, fromLocation: home, toLocation: destination, edgeLocation } }],
        activity: { id: 'visit', kind: 'quest', data: { durationSeconds: 100, location: destination } },
        returnLegs: [{ id: 'back', kind: 'regional-walk', data: { durationSeconds: 36000, fromLocation: destination, toLocation: home, edgeLocation: { ...edgeLocation, fromKey: edge.toKey, toKey: edge.fromKey } } }],
      });
      registerNpcItinerary(state, trip);
      const sites = stationSettlements(w.world, w.world.seed);
      let point, elapsed = 0;
      for (const progress of [.3, .5, .7]) {
        tickNpcMobilityItinerary(state, entity.id, { deltaSeconds: 36000 * progress - elapsed, worldHours: state.clock.worldHours });
        elapsed = 36000 * progress;
        point = w.npcMobility.locationResolver(entity.location, entity);
        if (point && outsideLanternVillages(point, sites)) break;
      }
      if (!point || !outsideLanternVillages(point, sites)) throw new Error('Journey fixture is still inside a village');
      window.__lanternTravellerId = entity.id;
      const dx = -Math.sin(point.heading) * 7 + Math.cos(point.heading) * 1.6;
      const dz = -Math.cos(point.heading) * 7 - Math.sin(point.heading) * 1.6;
      w.teleport(point.x + dx, point.z + dz); w.controls.yaw = Math.atan2(dx, dz); w.controls.pitch = -.04;
      w.npcMobility.update(.016, w.controls.rig.position);
      for (let i = 0; i < 100; i++) w.tick(0);
      const presentation = w.npcMobility.presentations.get(entity.id);
      return { id: entity.id, phase: entity.activity?.legKind, near: { ...w.npcJourneyLanterns.debug },
        hand: presentation?.actor.avatar.journeyLanternHand, carried: w.npcJourneyLanterns.models.has(entity.id) };
    });
    assert.equal(report.game.carried, true); assert.ok(report.game.near.active > 0); assert.ok(report.game.hand);
    await page.waitForTimeout(1000); await page.screenshot({ path: join(artifacts, 'journey-lantern-night.png') });
    report.game.far = await page.evaluate(() => {
      const w = __wander, id = __lanternTravellerId, entity = w.livingWorld.worldState.entities[id];
      const point = w.npcMobility.locationResolver(entity.location, entity);
      w.teleport(point.x - Math.sin(point.heading) * 500, point.z - Math.cos(point.heading) * 500);
      w.npcMobility.update(.016, w.controls.rig.position); w.tick(0);
      const current = w.npcMobility.walkingTravellers.get(id), coords = w.npcJourneyLanterns.beacons.geometry.attributes.position;
      const points = Array.from({ length: w.npcJourneyLanterns.debug.beacons }, (_, i) => [coords.getX(i), coords.getZ(i)]);
      return { ...w.npcJourneyLanterns.debug, bodyVisible: w.npcMobility.presentations.has(id),
        targetBeacon: !!current && points.some(([x, z]) => Math.hypot(x - current.x, z - current.z) < .1), carried: w.npcJourneyLanterns.models.has(id) };
    });
    assert.equal(report.game.far.bodyVisible, false); assert.equal(report.game.far.carried, false); assert.equal(report.game.far.targetBeacon, true);
    report.game.day = await page.evaluate(() => { __wander.tick(.5); return { ...__wander.npcJourneyLanterns.debug }; });
    assert.equal(report.game.day.beacons, 0); assert.equal(report.game.day.carried, 0);
    console.log('PASS: canonical inter-settlement itinerary lantern, distant body culling, night/day', JSON.stringify(report.game));
  }
  assert.deepEqual(errors, []); report.errors = errors;
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log('Artifacts:', artifacts);
} catch (error) {
  console.log('Errors:', JSON.stringify(errors));
  console.log('State:', JSON.stringify(await page.evaluate(() => ({ status: document.getElementById('status')?.textContent, build: window.__WANDER_APP_BUILD__, lanterns: window.__wander?.npcJourneyLanterns?.debug })).catch(() => null)));
  await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
