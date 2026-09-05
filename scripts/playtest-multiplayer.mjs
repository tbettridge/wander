// Optional browser regression: npm run playtest:multiplayer. Requires Playwright and Chrome.
const { chromium } = await import(
  process.env.WANDER_PLAYWRIGHT_PATH || 'playwright'
);
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'wander-multiplayer-'));
console.log('Browser test artifacts:', artifacts);
const server = createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ departures: [], iceServers: [] }));
      return;
    }
    if (path === '/') path = '/index.html';
    if (path.includes('..')) throw new Error();
    res.setHeader(
      'content-type',
      path.endsWith('.html')
        ? 'text/html'
        : /\.m?js$/.test(path)
          ? 'text/javascript'
          : 'application/octet-stream',
    );
    res.end(await readFile(root + path));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  ...(process.env.WANDER_CHROME_PATH
    ? { executablePath: process.env.WANDER_CHROME_PATH }
    : { channel: 'chrome' }),
  headless: true,
  args: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const logs = [];
const capture = async (page) =>
  page.evaluate(() => {
    const w = window.__wander;
    if (!w)
      return {
        loaded: false,
        status: document.getElementById('status')?.textContent,
      };
    return {
      seed: w.world.seed,
      position: w.controls.rig.position.toArray(),
      role: w.multiplayer.role,
      ticket: w.multiplayer.ticket,
      peers: w.multiplayer.diagnostics.peers,
      avatars: w.multiplayer.diagnostics.avatarManager,
      authorityVisitors: [...w.multiplayerAuthority.visitors.keys()],
      swap: {
        visiting: w.regionSwap.visiting,
        loading: w.regionSwap.loading,
        regionId: w.regionSwap.regionId,
      },
      runtime: w.regionRuntime.diagnostics,
      stations: w.regionalRailwayService.stations.map((s) => ({
        id: s.id,
        name: s.name,
        x: s.x,
        z: s.z,
      })),
      center: w.regionalRailway.requestedCenter,
      status: document.getElementById('multiplayer-status')?.textContent,
    };
  });
try {
  const pages = [];
  for (const [i, seed] of [20260612, 12345].entries()) {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (e) => {
      logs.push({ i, type: 'pageerror', message: e.stack });
      console.log('ERROR', i, e.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        logs.push({ i, type: msg.type(), message: msg.text() });
        if (/multiplayer|peer/.test(msg.text())) console.log(i, msg.text());
      }
    });
    await page.addInitScript(() =>
      Object.defineProperty(globalThis, 'WANDER_DEPARTURES_URL', {
        value: '/api',
        writable: false,
      }),
    );
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?wanderSeed=${seed}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 },
    );
    await page.waitForFunction(() => window.__wander, null, {
      timeout: 120000,
    });
    await page.evaluate(() => {
      __wander.quality.setLevel(0);
      __wander.quality.locked = true;
    });
    console.log('LOADED', i);
    await page.waitForFunction(
      () => __wander.regionalRailwayService.stations.length > 0,
      null,
      { timeout: 120000 },
    );
    console.log('RAIL READY', i);
  }
  const [host, guest] = pages;
  for (const [i, page] of pages.entries()) {
    await page.exposeFunction('signalToOther', async (message) => {
      await pages[1 - i].evaluate(
        (msg) => window.testReceiveSignal(msg),
        message,
      );
    });
    await page.evaluate(() => {
      const directory = __wander.multiplayer.directory;
      directory.register = async (departure) => {
        directory.listing = departure;
        return { departure, hostToken: 'test-token' };
      };
      directory.unregister = async () => {
        directory.listing = null;
      };
      directory.heartbeat = async () => directory.listing;
      directory.openSignalSocket = ({ onMessage }) => {
        window.testReceiveSignal = onMessage;
        return {
          readyState: 1,
          send: (data) => window.signalToOther(JSON.parse(data)),
          close() {},
        };
      };
    });
  }
  // Match a real host walking away from the seed's original planning center.
  await host.evaluate(() => {
    __wander.teleport(
      __wander.trailheadLocation.x + 30,
      __wander.trailheadLocation.z + 30,
    );
    __wander.controls.yaw = 0;
    __wander.controls.pitch = 0;
  });
  await host.locator('#overlay').dispatchEvent('click');
  // Guest joins from the departures screen without starting to walk.
  const homeBefore = await capture(guest);
  const departure = await host.evaluate(async () => {
    await __wander.multiplayer.openRegion();
    return __wander.multiplayer.region;
  });
  await guest.evaluate(async (departure) => {
    __wander.multiplayer.selectDeparture(departure);
    await __wander.multiplayer.requestVisit();
  }, departure);
  await guest.waitForFunction(
    () => __wander.multiplayer.ticket?.phase === 'visit-active',
    null,
    { timeout: 30000 },
  );
  console.log('VISIT ACTIVE');
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        () =>
          !__wander.regionSwap.loading &&
          __wander.multiplayer.diagnostics.avatarManager.players.some(
            (p) => p.visible,
          ),
        {},
        { timeout: 60000 },
      ),
    ),
  );
  await new Promise((r) => setTimeout(r, 1000));
  const result = {
    host: await capture(host),
    guest: await capture(guest),
    logs,
  };
  const sharedHost = await host.evaluate(() => __wander.multiplayerAuthority.state.sharedWorld);
  const sharedGuest = await guest.evaluate(() => __wander.sharedWorld.presentation);
  assert.equal(sharedHost.schemaVersion, 1);
  assert.equal(sharedGuest.schemaVersion, 1);
  assert.equal(sharedHost.worldSeed, sharedGuest.worldSeed);
  assert.ok(Number.isFinite(sharedHost.clock.worldHours));
  assert.ok(sharedGuest.simTick >= 0);
  assert.ok(Object.keys(sharedHost.entities || {}).length > 0, 'host publishes NPC state');
  assert.ok(Object.keys(sharedGuest.entities || {}).length > 0, 'guest receives NPC state');
  const sharedEntityIds = Object.keys(sharedGuest.entities || {});
  const firstPublishedPose = sharedGuest.entities[sharedEntityIds[0]]?.pose;
  // Bring the guest into the entity's interest radius so the renderer is
  // expected to materialize the host-controlled pose, even when the first
  // projected entity is on the far side of the 1.1km network window.
  await guest.evaluate(({ x, z }) => __wander.controls.place(x, z), firstPublishedPose);
  const materialized = await guest.waitForFunction((ids) => ids.find((id) => {
    const actor = __wander.livingWorld.actors.find((entry) => entry.identity?.id === id)
      || __wander.settlements.interactiveActors().find((entry) => entry.identity?.id === id);
    return !!(actor?.avatar?.root || actor?.root);
  }) || false, sharedEntityIds, { timeout: 10000 });
  const npcId = await materialized.jsonValue();
  assert.ok(npcId, 'guest materializes a published NPC body');
  const publishedNpcPose = sharedGuest.entities[npcId]?.pose;
  await guest.evaluate(({ x, z }) => __wander.controls.place(x, z), publishedNpcPose);
  await new Promise((r) => setTimeout(r, 500));
  const npcPose = await guest.evaluate((id) => {
    const actor = __wander.livingWorld.actors.find((entry) => entry.identity?.id === id)
      || __wander.settlements.interactiveActors().find((entry) => entry.identity?.id === id);
    const root = actor?.avatar?.root || actor?.root;
    if (!root) return null;
    return actor ? {
      pose: [root.position.x, root.position.y, root.position.z],
      remotePose: actor.remotePose,
      visible: root.visible,
      station: actor.station,
      player: __wander.controls.rig.position.toArray(),
    } : null;
  }, npcId);
  assert.ok(npcPose && publishedNpcPose, 'guest materializes a published NPC');
  assert.ok(Math.hypot(npcPose.pose[0] - publishedNpcPose.x, npcPose.pose[2] - publishedNpcPose.z) < 0.2,
    'guest NPC follows the host pose');
  await writeFile(
    join(artifacts, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(
    'Shared seed:',
    result.host.seed,
    '; stations:',
    result.host.stations.map((s) => s.name).join(', '),
  );
  assert.equal(result.host.seed, result.guest.seed);
  assert.deepEqual(result.host.stations, result.guest.stations);
  assert.deepEqual(result.host.center, result.guest.center);
  assert.equal(result.host.avatars.count, 1);
  assert.equal(result.guest.avatars.count, 1);
  assert.equal(result.host.avatars.players[0].visible, true);
  assert.equal(result.guest.avatars.players[0].visible, true);
  const separation = Math.hypot(
    result.host.position[0] - result.guest.position[0],
    result.host.position[2] - result.guest.position[2],
  );
  assert.ok(separation >= 1.5 && separation <= 6);
  for (const [i, page] of pages.entries()) {
    await page.evaluate(() => {
      document.getElementById('overlay').style.display = 'none';
      __wander.tick(0.4);
    });
    await page.screenshot({
      path: join(artifacts, `${i === 0 ? 'host' : 'guest'}.png`),
    });
    await page.evaluate(() => {
      document.getElementById('overlay').style.display = '';
    });
  }
  // Begin walking only after the visit is established; staying a guest matters.
  await guest.evaluate(() => {
    document.getElementById('open-region-to-visitors').checked = true;
  });
  await guest.locator('#overlay').dispatchEvent('click');
  assert.equal(await guest.evaluate(() => __wander.multiplayer.role), 'guest');
  await guest.evaluate(() =>
    __wander.controls.place(
      __wander.controls.rig.position.x + 4,
      __wander.controls.rig.position.z,
    ),
  );
  await new Promise((r) => setTimeout(r, 1200));
  const motion = await host.evaluate(() => {
    const a = [...__wander.multiplayer.avatarManager.avatars.values()][0];
    return a.history.at(-1);
  });
  const guestPosition = await guest.evaluate(() =>
    __wander.controls.rig.position.toArray(),
  );
  assert.ok(Math.abs(motion.x - guestPosition[0]) < 0.05);
  assert.ok(Math.abs(motion.z - guestPosition[2]) < 0.05);
  await host.evaluate(() =>
    __wander.controls.place(
      __wander.controls.rig.position.x + 2,
      __wander.controls.rig.position.z,
    ),
  );
  await new Promise((r) => setTimeout(r, 1200));
  const hostMotion = await guest.evaluate(() =>
    [...__wander.multiplayer.avatarManager.avatars.values()][0].history.at(-1),
  );
  const hostPosition = await host.evaluate(() =>
    __wander.controls.rig.position.toArray(),
  );
  assert.ok(Math.abs(hostMotion.x - hostPosition[0]) < 0.05);
  assert.ok(Math.abs(hostMotion.z - hostPosition[2]) < 0.05);
  await guest.evaluate(() => __wander.multiplayer.requestReturnHome());
  await guest.waitForFunction(() => !__wander.regionSwap.loading, null, {
    timeout: 60000,
  });
  const returned = await capture(guest);
  assert.equal(returned.seed, homeBefore.seed);
  assert.deepEqual(returned.stations, homeBefore.stations);
  assert.deepEqual(returned.center, homeBefore.center);
  assert.ok(
    Math.hypot(
      returned.position[0] - homeBefore.position[0],
      returned.position[2] - homeBefore.position[2],
    ) < 0.05,
  );
  console.log(
    'PASS: same world, identical stations, two visible avatars, guest movement reaches host, and home restored',
  );
} finally {
  await writeFile(
    join(artifacts, 'console.json'),
    JSON.stringify(logs, null, 2),
  );
  await browser.close();
  server.close();
}
