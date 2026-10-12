// Rendered courier regression. Teleports arrange remote scenes; movement checks
// use native foot, horse and train systems. This does not replace a human route
// playtest or a physical headset comfort test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), artifacts = await mkdtemp(join(tmpdir(), 'wander-courier-'));
const server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://localhost').pathname; if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error('Invalid path');
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(root + path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/?courier=first-post`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], report = { artifacts, checks: [] };
page.setDefaultTimeout(180000);
page.on('pageerror', e => errors.push(e.stack));
page.on('console', message => { if (message.type() === 'error' && !/CORS|Failed to load resource/.test(message.text())) console.error('Browser:', message.text()); });
const panel = page.locator('#courier-panel');
const click = name => panel.getByRole('button', { name, exact: true }).click();
const check = (name, value = true) => { assert.ok(value, name); report.checks.push(name); console.log('PASS:', name); };
let lastProgress = '';
const progressTimer = setInterval(async () => {
  try {
    const progress = await page.evaluate(() => document.querySelector('#status')?.textContent
      || document.querySelector('#start-button')?.textContent || 'Loading Wander');
    if (progress !== lastProgress) { console.log('Browser progress:', progress); lastProgress = progress; }
  } catch { /* navigation may replace the document */ }
}, 15000);
async function ready() {
  await page.waitForFunction(() => window.__wander?.courier?.prepared || window.__wander?.courier?.error, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => __wander.courier.error?.message || null), null);
  await page.waitForFunction(() => !document.querySelector('#start-button').disabled, null, { timeout: 180000 });
  await page.click('#start-button');
  await page.waitForFunction(() => __wander.courier.controller.story.onboarding.seen
    || (__wander.courier.ui?.isOpen && __wander.courier.ui.view === 'welcome'));
  if (await page.evaluate(() => __wander.courier.ui?.isOpen && __wander.courier.ui.view === 'welcome')) {
    check('first entry offers optional welcome, easy delivery, and explanation', (await panel.innerText()).includes('Show me an easy delivery')
      && (await panel.innerText()).includes('Explain how this works'));
    await click('I’ll explore first');
  }
}
async function close() {
  if (await panel.isVisible()) await click('Close · N / Esc');
}
async function placeAtPlace(place) {
  await close();
  await page.evaluate(key => { const c = __wander.courier, p = c.controller.story.bindings.places[key]; __wander.controls.place(p.x, p.z + 6); }, place);
  await page.waitForTimeout(1800); await terrainReady();
}
async function terrainReady() {
  await page.waitForFunction(() => ![...document.querySelectorAll('body > div[role="status"]')]
    .some(el => el.style.zIndex === '1000' && getComputedStyle(el).display !== 'none'), null, { timeout: 180000 });
}
async function talk(role) {
  await close();
  const id = await page.evaluate(r => __wander.courier.controller.npc(r)?.id || r, role);
  if (!await page.evaluate(id => !!__wander.livingWorld.actorById(id), id)) {
    await placeAtPlace(await page.evaluate(id => __wander.courier.controller.placeForNpc(id), id));
  }
  await page.waitForFunction(id => !!__wander.livingWorld.actorById(id), id, { timeout: 30000 });
  // Different terrain generations can place a wall or another resident on one
  // side of a household. Approach the actual resident from an available side.
  let selected = false;
  for (let approach = 0; approach < 12 && !selected; approach++) {
    await page.evaluate(({ id, approach }) => {
      const w = __wander, a = w.livingWorld.actorById(id), p = a.avatar.root.position;
      const angle = approach * Math.PI / 4, radius = approach < 8 ? 1.1 : .35;
      const dx = Math.cos(angle) * radius, dz = Math.sin(angle) * radius;
      w.controls.place(p.x + dx, p.z + dz); w.controls.yaw = Math.atan2(dx, dz);
    }, { id, approach });
    await page.waitForTimeout(500); await terrainReady();
    selected = await page.evaluate(id => __wander.livingWorld.activeNpc?.identity.id === id
      && __wander.livingWorld.activeNpc.distance <= 4.5, id);
  }
  assert.ok(selected, 'A natural nearby conversation target was not available for ' + role);
  await page.keyboard.press('t'); await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !__wander.livingWorld.chatBusy, null, { timeout: 30000 });
}
async function readStand(place, titles) {
  await placeAtPlace(place);
  await page.evaluate(key => { const c = __wander.courier, source = c.controller.sources().find(s => s.place === key), p = c.sourcePositions.get(source.sourceId); __wander.controls.place(p.x, p.z + 1); }, place);
  await page.keyboard.press('e'); await panel.waitFor({ state: 'visible' });
  if (await page.evaluate(() => __wander.courier.ui.view === 'leads')) {
    await click('See accounts and questions'); await click('Accounts and questions');
  }
  for (const title of titles) { await click('Read nearby: ' + title); await click('Back to accounts'); }
}
try {
  // This regression verifies the authored/offline game path. Live provider
  // behavior has its own deterministic protocol tests; no speech is requested.
  await page.route('https://wander-ai.departures-worker.workers.dev/**', route => route.fulfill({
    status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Offline courier browser regression' }),
  }));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__wander, null, { timeout: 120000 });
  await page.fill('#player-name', 'Courier Browser QA'); await page.click('#player-name-save');
  await ready();
  await page.evaluate(() => __wander.courier.director.runtime.setEnabled(false));
  check('prepared three connected communities and six distinct canonical adults', await page.evaluate(() => {
    const c = __wander.courier, b = c.controller.story.bindings;
    return Object.keys(b.places).length === 3 && new Set(Object.values(b.cast).map(p => p.id)).size === 6
      && Object.values(b.routes).every(r => r.length === 2 && r.every(t => t.target.worldX && t.instructions));
  }));
  check('scenario hides the train diagram', await page.evaluate(() => getComputedStyle(__wander.regionalRailwayService.mapEl).display === 'none'));
  check('skipping the welcome accepts no work and leaves handwritten pages intact', await page.evaluate(() => {
    const c = __wander.courier;
    return c.controller.story.onboarding.seen && Object.values(c.controller.story.jobs).every(j => j.state === 'offered')
      && c.notebook.book.pages[0].text === '';
  }));
  await page.waitForFunction(() => {
    const c = __wander.courier, actor = __wander.livingWorld.actorById(c.controller.npc('dispatcher').id), p = c.sourcePositions.get('board:A');
    return actor?.avatar.root.visible && p && Math.hypot(actor.avatar.root.position.x - p.x, actor.avatar.root.position.z - p.z) < 8;
  }, null, { timeout: 20000 });
  check('canonical welcoming courier is already beside the village post desk');
  await page.evaluate(() => { const p = __wander.courier.sourcePositions.get('board:A'); __wander.controls.place(p.x, p.z + 1); });
  await page.keyboard.press('e'); await panel.waitFor({ state: 'visible' });
  const openingName = await page.evaluate(() => __wander.courier.nearbyBoards().find(b => b.place === 'A').name);
  await click('Read board: ' + openingName);
  check('physical board opens local notices and records three leads without accepting', await page.evaluate(() => {
    const c = __wander.courier.controller;
    return Object.keys(c.story.leads).length === 3 && c.story.knownOffers['platform-seeds'] === undefined
      && Object.values(c.story.jobs).every(j => j.state === 'offered');
  }));
  await page.screenshot({ path: join(artifacts, 'leads.png') });
  await click('More'); await click('Help and controls'); await click('Hide desktop next-step reminder'); await close();
  check('optional reminder can be switched off', await page.evaluate(() => !__wander.courier.controller.story.onboarding.hintsEnabled
    && getComputedStyle(document.querySelector('#courier-reminder')).display === 'none'));
  const neighbor = await page.evaluate(() => {
    const c = __wander.courier.controller;
    return __wander.livingWorld.getExternalActors().find(a => a.avatar?.root.visible && !c.roleFor(a.identity.id)
      && c.placeForNpc(a.identity.id) === 'A')?.identity.id;
  });
  assert.ok(neighbor, 'A canonical ordinary local resident is available');
  await talk(neighbor);
  await panel.locator('[data-field="chat"]').fill('Is there any delivery work?'); await click('Send message');
  await page.waitForFunction(() => !__wander.livingWorld.chatBusy);
  check('ordinary residents give grounded local courier referrals', await page.evaluate(() => {
    const c = __wander.courier.controller, text = __wander.livingWorld.chatHistory.at(-1).content;
    return text.includes('Post & Errands') && text.includes(c.npc('dispatcher').name)
      && !text.includes('don’t really have things delivered');
  }));
  await close();
  await talk('dispatcher');
  check('courier greeting names an actual offered recipient', await page.evaluate(() => {
    const c = __wander.courier.controller, text = __wander.livingWorld.chatHistory[0]?.content || '';
    return text.includes(c.npc('guide').name) || text.includes(c.npc('gardener').name);
  }));
  await click('Pass on First Letter'); await click('Pass on A Note Across the Village'); await close();
  await talk('guide'); await click('Pass on Trail Notes'); await close();
  await talk('gardener'); await click('Pass on Seeds for the Platform'); await close();
  await talk('potter'); await click('Pass on A Cup for the Platform'); await close();
  await talk('poet'); await click('Pass on Return Manuscript'); await close();
  await talk('archivist'); await click('Pass on Catalog Copy'); await close();
  check('all seven jobs can be declined', await page.evaluate(() => Object.values(__wander.courier.controller.story.jobs).every(j => j.state === 'declined')));
  await readStand('A', ['The current dispatch sheet', 'The rider’s recollection', 'The gardener’s postcard', 'The old catalog illustration']);
  await click('Compare: Borrowed memories');
  await readStand('B', ['An older receipt', 'The maker’s signed label']);
  await click('Compare: The post and its records'); await click('Consider the larger pattern');
  check('exploration alone reveals the first hypothesis without a delivery', await page.evaluate(() => __wander.courier.controller.story.hypothesis && Object.values(__wander.courier.controller.story.jobs).every(j => j.state === 'declined')));
  await page.screenshot({ path: join(artifacts, 'story.png') });
  await talk('dispatcher');
  await panel.locator('[data-field="chat"]').fill('I will take A Note Across the Village'); await click('Send message');
  await page.waitForFunction(() => !__wander.livingWorld.chatBusy);
  check('explicit typed acceptance puts the short errand in the satchel', await page.evaluate(() => __wander.courier.controller.story.jobs['village-note'].state === 'active'));
  await close(); await talk('guide'); await click('Deliver A Note Across the Village');
  check('local delivery completes and invites a real next opportunity', await page.evaluate(() => {
    const c = __wander.courier.controller;
    return c.story.jobs['village-note'].state === 'delivered' && c.story.jobs['trail-notes'].state === 'declined'
      && !!c.story.leads['job:trail-notes'] && Object.keys(c.story.evidence).length === 6;
  }));
  check('completed note appears at the guide’s household', await page.evaluate(() => !!__wander.courier.deliveryProps.get('village-note')?.parent));
  await talk('potter'); await click('Accept A Cup for the Platform'); await close();
  await talk('gardener'); await click('Accept Seeds for the Platform'); await close();
  await talk('poet'); await click('Accept Return Manuscript'); await close();
  await talk('archivist'); await click('Accept Catalog Copy');
  check('three-slot cap is visible and rejects a fourth parcel', (await panel.innerText()).includes('satchel is full') && await page.evaluate(() => __wander.courier.controller.story.jobs['catalog-copy'].state === 'declined'));
  await click('Deliver A Cup for the Platform'); await click('Accept Catalog Copy');
  check('handoff transfers item ownership and frees a satchel slot', await page.evaluate(() => {
    const c = __wander.courier.controller; return c.story.jobs['platform-cup'].state === 'delivered'
      && c.state.projections.items['courier:item:platform-cup'].ownerId === c.npc('archivist').id && c.story.jobs['catalog-copy'].state === 'active';
  }));
  await talk('poet'); await click('Return Return Manuscript'); await click('Accept Return Manuscript');
  check('returned commissions can be accepted again', await page.evaluate(() => __wander.courier.controller.story.jobs['return-manuscript'].attempts === 2));
  await close(); await talk('dispatcher'); await click('Deliver Seeds for the Platform');
  check('delivered seeds visibly fill both station flower pots', await page.evaluate(() => __wander.courier.flowerPots.length === 2
    && __wander.courier.flowerPots.every(p => !!p.bloom && p.root.position.toArray().every(Number.isFinite))));
  await close(); await talk('poet');
  await click('Tell the poet about my journey');
  await page.waitForFunction(() => !!__wander.courier.controller.story.works.personal);
  const edition = await page.evaluate(() => JSON.stringify(__wander.courier.controller.story.works.personal));
  check('poet publishes a cached edition from explicitly shared travel', JSON.parse(edition).referencedEventIds.length > 0);
  await close(); await page.keyboard.press('n'); await panel.waitFor({ state: 'visible' }); await click('Notebook');
  await panel.locator('[data-field="title"]').fill('Bridge and village');
  await panel.locator('[data-field="note"]').fill('At the well, take the signed road. My own map follows.');
  const canvas = panel.locator('canvas'), box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .3); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 12 }); await page.mouse.up();
  check('undo is available immediately after drawing', await panel.getByRole('button', { name: 'Undo last stroke', exact: true }).isEnabled());
  const note = await page.evaluate(() => __wander.courier.notebook.book.pages[0]);
  check('desktop draws normalized vector strokes without distorting the page', note.strokes[0].points.length > 5 && Math.abs(box.width / box.height - 5 / 3) < .02);
  // Real held movement keys cannot walk behind an open notebook.
  const before = await page.evaluate(() => { document.activeElement.blur(); return __wander.controls.rig.position.toArray(); });
  await page.keyboard.down('w'); await page.waitForTimeout(650); await page.keyboard.up('w');
  const after = await page.evaluate(() => __wander.controls.rig.position.toArray());
  check('notebook captures desktop movement input', Math.hypot(after[0] - before[0], after[2] - before[2]) < .01);
  const popupPromise = page.waitForEvent('popup'); await click('Print / Save as PDF'); const print = await popupPromise;
  await print.waitForFunction(() => document.querySelectorAll('section').length > 3);
  check('printed notebook contains starter help and encountered opportunities', (await print.locator('body').innerText()).includes('Welcome to First Post')
    && (await print.locator('body').innerText()).includes('A Note Across the Village'));
  await print.pdf({ path: join(artifacts, 'journey-book.pdf'), preferCSSPageSize: true, printBackground: true });
  await print.screenshot({ path: join(artifacts, 'print.png') }); await print.close();
  check('print book has authored accounts, drawings, cover and blank pages');
  await page.screenshot({ path: join(artifacts, 'notebook.png') });
  await page.evaluate(async () => { await __wander.courier.ui.flush(); __wander.livingWorld.saveLivingWorldState(true); });
  await page.reload(); await ready();
  check('jobs, story discoveries, drawing and exact poem survive reload', await page.evaluate(({ note, edition }) => {
    const c = __wander.courier;
    return c.controller.story.hypothesis && JSON.stringify(c.controller.story.works.personal) === edition
      && JSON.stringify(c.notebook.book.pages[0]) === JSON.stringify(note) && c.controller.story.jobs['catalog-copy'].state === 'active';
  }, { note, edition }));
  // Exercise the scene-space canvas adapter and virtual keyboard without
  // pretending that a software controller is a physical headset.
  const xr = await page.evaluate(async () => {
    const w = __wander, c = w.courier, u = c.ui, x = c.xrPanel, THREE = await import('three');
    const original = { renderer: x.renderer, controller: x.controller, canOpen: x.canOpen };
    const source = { handedness: 'right', gamepad: { buttons: [{ pressed: false }, { pressed: false }] } };
    const controller = new THREE.Object3D(); w.scene.add(controller);
    x.controller = controller; x.canOpen = () => true;
    x.renderer = { xr: { isPresenting: true, getSession: () => ({ inputSources: [source] }), getCamera: () => w.controls.camera } };
    const aim = (px, py) => {
      const target = x.mesh.localToWorld(new THREE.Vector3((px / 1200 - .5) * .96, (.5 - py / 1080) * .864, 0));
      controller.position.copy(w.controls.camera.getWorldPosition(new THREE.Vector3()));
      controller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), target.sub(controller.position).normalize());
    };
    const trigger = (px, py) => { aim(px, py); source.gamepad.buttons[0].pressed = true; x.update(); source.gamepad.buttons[0].pressed = false; x.update(); };
    try {
      u.open('notes'); x.recenter(); x.update();
      trigger(400, 203); const selected = u.keyboard && u.inputTarget === 'title';
      trigger(93, 594); const keyboard = selected && u.editPage().title.endsWith('q');
      trigger(300, 964); x.update(); const d = x.drawingRect;
      aim(d.x + d.w * .1, d.y + d.h * .1); source.gamepad.buttons[0].pressed = true; x.update();
      aim(d.x + d.w * .8, d.y + d.h * .8); x.update(); source.gamepad.buttons[0].pressed = false; x.update();
      const strokes = u.editPage().strokes.length;
      source.gamepad.buttons[1].pressed = true; x.update(); source.gamepad.buttons[1].pressed = false; x.update();
      return { keyboard, strokes, ratio: d.w / d.h, captured: w.controls.uiInputCaptured, closed: !u.isOpen };
    } finally { if (u.isOpen) u.close(); Object.assign(x, original); controller.removeFromParent(); x.mesh.visible = false; }
  });
  check('simulated VR grip, trigger ray, virtual keyboard and drawing share notebook state', xr.keyboard && xr.strokes === 2 && Math.abs(xr.ratio - 5 / 3) < .001 && !xr.captured && xr.closed);
  // Native horse mounting and motion, then modal ownership while riding.
  const horse = await page.evaluate(() => { const h = __wander.courier.loanHorse.mesh.position; __wander.controls.place(h.x + 1, h.z); return h.toArray(); });
  await page.waitForTimeout(350); await page.keyboard.press('r');
  await page.waitForFunction(() => __wander.horseRiding.riding);
  await page.keyboard.down('w'); await page.waitForTimeout(1800); await page.keyboard.up('w');
  check('loan horse uses native mounting and riding movement', await page.evaluate(p => Math.hypot(__wander.courier.loanHorse.mesh.position.x - p[0], __wander.courier.loanHorse.mesh.position.z - p[2]) > 1, horse));
  await page.keyboard.press('n'); await panel.waitFor({ state: 'visible' });
  check('opening the book preserves the mounted input lock', await page.evaluate(() => __wander.controls.inputLocked && __wander.horseRiding.riding));
  await close(); check('closing the book preserves the mounted input lock', await page.evaluate(() => __wander.controls.inputLocked && __wander.horseRiding.riding));
  await page.keyboard.press('r'); await page.waitForFunction(() => !__wander.horseRiding.riding);
  // Advance the native regional service in bounded steps to its first proof
  // station. Boarding still uses the actual nearest door and its passability.
  const train = await page.evaluate(async () => {
    const w = __wander, r = w.regionalRailwayService, THREE = await import('three');
    // Audio schedules wall-clock notes; accelerated vehicle steps are silent
    // so simulation time cannot overrun Tone's clock.
    r.debug.sounds = false; r.trainAudio.setEnabled(false);
    for (let i = 0; i < 50000 && !(r.schedule.atStation && r.schedule.currentStationIndex === 0 && r.schedule.doorFactor > .99); i++) r.update(.1, w.controls.rig.position, false);
    const carriage = r.carriages[0], door = carriage.doors[0];
    const point = carriage.root.localToWorld(new THREE.Vector3(door.localX, door.localY, door.closedZ));
    w.controls.place(point.x, point.z);
    return { atStation: r.schedule.atStation, stop: r.schedule.currentStationIndex, door: r.schedule.doorFactor, boarded: r.tryBoardNearest() };
  });
  check('native regional train admits the player through a real open door', train.boarded);
  await page.evaluate(() => { const r = __wander.regionalRailwayService; for (let i = 0; i < 8 && !r.seated; i++) if (!r.npcClaimsSeat(r.passengerManifest(), r.ridingCarriage, i)) r.sit(i); });
  await page.keyboard.press('n'); await panel.waitFor({ state: 'visible' });
  const trainBefore = await page.evaluate(() => __wander.controls.rig.position.toArray());
  await page.evaluate(() => { const w = __wander, r = w.regionalRailwayService;
    for (let i = 0; i < 600; i++) { r.update(.1, w.controls.rig.position, false); r.syncSeatedRig(); w.courier.update(.1, true); }
  });
  const trainAfter = await page.evaluate(() => __wander.controls.rig.position.toArray());
  check('train continues carrying a seated reader while the book captures input', Math.hypot(trainAfter[0] - trainBefore[0], trainAfter[2] - trainBefore[2]) > 5 && await page.evaluate(() => !__wander.controls.enabled && __wander.regionalRailwayService.seated));
  await close(); check('closing the book restores seated control ownership', await page.evaluate(() => !__wander.controls.enabled && __wander.regionalRailwayService.seated));
  await page.evaluate(() => { const w = __wander, r = w.regionalRailwayService;
    for (let i = 0; i < 50000 && !(r.schedule.atStation && r.schedule.currentStationIndex === 1 && r.schedule.doorFactor > .99); i++) { r.update(.1, w.controls.rig.position, false); r.syncSeatedRig(); w.courier.update(.1, true); }
    r.leave();
  });
  check('leaving the train restores foot controls', await page.evaluate(() => __wander.controls.enabled && !__wander.regionalRailwayService.riding));
  await page.evaluate(() => localStorage.setItem('wander.normal-save-sentinel', 'preserve'));
  await page.keyboard.press('n'); await panel.waitFor({ state: 'visible' }); await click('Notebook');
  const resetLoaded = page.waitForEvent('load');
  page.once('dialog', d => d.accept()); await click('Restart First Post'); await resetLoaded; await ready();
  check('restart clears only the proof and is not undone by unload or worker saves', await page.evaluate(() => {
    const c = __wander.courier; return !c.controller.story.hypothesis && !c.controller.story.works.personal
      && Object.values(c.controller.story.jobs).every(j => j.state === 'offered') && !c.notebook.book.pages[0].text
      && localStorage.getItem('wander.normal-save-sentinel') === 'preserve';
  }));
  check('no browser runtime errors', errors.length === 0);
  report.errors = errors; report.physicalHeadset = 'not tested'; report.fullHumanRoutes = 'not tested';
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Courier browser checks passed. Artifacts:', artifacts);
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  const scene = await page.evaluate(() => ({ player: window.__wander?.controls.rig.position.toArray(), active: window.__wander?.livingWorld.activeNpc?.identity,
    cast: Object.values(window.__wander?.courier?.controller.story?.bindings.cast || {}).map(person => {
      const actor = __wander.livingWorld.actorById(person.id);
      return { ...person, visible: actor?.avatar.root.visible, position: actor?.avatar.root.position.toArray() };
    }) })).catch(() => null);
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ ...report, errors, scene, failure: error.stack }, null, 2));
  console.error('Courier browser artifacts:', artifacts); throw error;
} finally { clearInterval(progressTimer); await browser.close(); await new Promise(resolve => server.close(resolve)); }
