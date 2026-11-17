#!/usr/bin/env node
// First Post playtest bot. It plays whole rounds of the real game in a
// headless browser, from Ada's welcome to the last letter, one story seed at
// a time, the way a patient player who follows the book would: it talks by
// typing, answers Y/N prompts, reads boards and stands, compares accounts in
// the book, delivers, shows people what it carries, and walks (or rides) from
// place to place by holding the movement keys. It writes a report of every
// softlock, stuck route, page error and story dead end it meets, with
// screenshots.
//
//   npm run playbot:setup            # once: browser and CDN copies into .playbot/
//   npm run playbot -- --seeds 1,2,3 # play three story seeds
//
// See docs/playtest-bot.md for every option and how to read the report.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, '.playbot', 'node_modules');

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const value = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
if (flag('help')) {
  console.log(`First Post playtest bot
  --seeds 1,2,3        story seeds to play (default 1)
  --seed-range 1-10    or a range of seeds
  --policy jobs        jobs (carry post on the way) or no-jobs (story only)
  --travel mixed       walk: every metre on foot or horse; mixed: walk up to --walk-limit metres per leg, then hop
  --walk-limit 1500    metres a leg may be before mixed travel hops most of it
  --speed 3            game clock multiple (1 = real time)
  --minutes 60         wall-clock budget per seed
  --out playbot-reports/<time>   where the report goes
  --headed             show the browser window (needs a display)
  --milestone-shots    screenshot every milestone, not only findings and the ending
  --draw               draw every frame instead of only for screenshots
  --attach http://127.0.0.1:9333   (development) play on in a browser already running with --remote-debugging-port`);
  process.exit(0);
}
const seeds = (() => {
  const range = value('seed-range');
  if (range) { const [a, b] = range.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  return String(value('seeds', '1')).split(',').map(Number).filter(Number.isFinite);
})();
const options = {
  policy: value('policy', 'jobs'),
  travel: value('travel', 'mixed'),
  walkLimit: Number(value('walk-limit', 1500)),
  speed: Number(value('speed', 3)),
  minutes: Number(value('minutes', 60)),
  headed: flag('headed'),
  draw: flag('draw'),
  milestoneShots: flag('milestone-shots'),
  attach: value('attach', null),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = value('out', join(root, 'playbot-reports', stamp));

// ---------------------------------------------------------------- browser
async function loadPlaywright() {
  for (const spec of [process.env.WANDER_PLAYWRIGHT_PATH, 'playwright', 'playwright-core',
    join(vendor, 'playwright-core', 'index.mjs'), join(vendor, 'playwright', 'index.mjs'), '/opt/node-tools/node_modules/playwright/index.mjs']) {
    if (!spec) continue;
    try { return await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec); } catch { /* try the next */ }
  }
  throw new Error('Playwright was not found. Run `npm run playbot:setup`, or set WANDER_PLAYWRIGHT_PATH.');
}
async function launchOptions() {
  const args = ['--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];
  if (process.env.PLAYBOT_CHROMIUM) return { executablePath: process.env.PLAYBOT_CHROMIUM, args, how: process.env.PLAYBOT_CHROMIUM };
  if (existsSync(join(vendor, '@sparticuz', 'chromium'))) {
    const require = createRequire(join(vendor, 'x.js'));
    const chromium = (await import(pathToFileURL(require.resolve('@sparticuz/chromium')).href)).default;
    return { executablePath: await chromium.executablePath(), args, how: '@sparticuz/chromium (.playbot)' };
  }
  return { channel: 'chrome', args, how: 'installed Chrome' };
}

// A tiny static server for the repository, like the other playtest scripts.
function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' };
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); if (path === '/') path = '/index.html';
      if (path.includes('..')) throw new Error('bad path');
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.setHeader('content-type', types[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream');
      res.end(await readFile(join(root, path)));
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// unpkg copies of three and Tone, when a cloud sandbox cannot reach the CDN.
async function vendored(url) {
  const match = url.match(/^https:\/\/unpkg\.com\/(three|tone)@[^/]+\/(.+)$/);
  if (!match) return null;
  const file = join(vendor, match[1], match[2].split('?')[0]);
  try { await stat(file); return await readFile(file); } catch { return null; }
}

// ---------------------------------------------------------------- one run
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Run {
  constructor(seed, browser, base) {
    this.seed = seed; this.browser = browser; this.base = base;
    this.dir = join(outDir, 'seed-' + seed);
    this.findings = []; this.log = []; this.milestones = []; this.errors = [];
    this.travel = { walked: 0, rode: 0, hopped: 0, train: 0, legs: [] };
    this.shots = 0; this.started = Date.now(); this.deadline = this.started + options.minutes * 60e3;
    this.failedTargets = new Map(); // what kept failing, so the bot moves on instead of looping
  }
  elapsed() { return Math.round((Date.now() - this.started) / 1000); }
  note(text, extra = null) { const line = { t: this.elapsed(), text, ...(extra || {}) }; this.log.push(line); console.log(`[seed ${this.seed} ${line.t}s]`, text); }

  async start() {
    await mkdir(this.dir, { recursive: true });
    if (options.attach) return this.attach();
    this.context = await this.browser.newContext({ viewport: { width: 960, height: 640 } });
    const page = this.page = await this.context.newPage();
    page.setDefaultTimeout(120000);
    await page.addInitScript(config => { window.__PLAYBOT_CONFIG__ = config; }, { speed: options.speed, draw: options.draw });
    await page.addInitScript({ path: join(root, 'scripts', 'playbot', 'page-agent.js') });
    page.on('pageerror', error => this.pageError('pageerror', error.stack || error.message));
    page.on('console', message => {
      const text = message.text();
      if (message.type() === 'error' && !/Failed to load resource|net::ERR|status of 50\d|CORS|departures|relay credentials/.test(text)) this.pageError('console.error', text);
      if (/^\[courier welcome\]/.test(text)) this.note('game: ' + text);
    });
    // The game's AI gateway and multiplayer services are never reached: First Post runs on its authored dialogue.
    await page.route(url => !url.href.startsWith(this.base), async route => {
      const body = await vendored(route.request().url());
      if (body) return route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body });
      if (/unpkg\.com|cdn\.jsdelivr|esm\.sh/.test(route.request().url())) return route.continue();
      return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"error":"offline playtest"}' });
    });
    this.note('loading First Post, story seed ' + this.seed);
    await page.goto(`${this.base}/?courier=first-post&storySeed=${this.seed}`);
    let lastStatus = '';
    const loadStarted = Date.now();
    while (true) {
      // Hold the quality tier still from the start: the adaptive tier reads a headless frame rate as a slow
      // machine and keeps rebuilding materials. Set it before shaders are warmed, not after.
      await page.evaluate(() => { const q = window.__wander?.quality; if (q && !q.locked) { q.locked = true; q.setLevel(1); } }).catch(() => {});
      const s = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent || '', prepared: !!window.__wander?.courier?.prepared,
        error: window.__wander?.courier?.error?.message || null, disabled: document.querySelector('#start-button')?.disabled ?? true })).catch(() => ({}));
      if (s.status && s.status !== lastStatus) { lastStatus = s.status; if (!/surrounding areas/.test(s.status)) this.note('loading: ' + s.status); }
      if (s.error) throw new Error('courier preparation failed: ' + s.error);
      if (s.prepared && s.disabled === false) break;
      if (Date.now() - loadStarted > 20 * 60e3) throw new Error('the game did not become ready in 20 minutes (last status: ' + lastStatus + ')');
      await sleep(3000);
    }
    this.loadSeconds = Math.round((Date.now() - loadStarted) / 1000);
    this.note('ready after ' + this.loadSeconds + ' s');
    await page.fill('#player-name', 'Playbot');
    await page.click('#start-button');
    await page.waitForFunction(() => __wander.courier.isPlaying(), null, { timeout: 60000 });
    this.note('round begun');
  }

  /** Development: play on in a page that is already loaded, so a change to the bot needs no four-minute reload. */
  async attach() {
    this.context = this.browser.contexts()[0];
    const page = this.page = this.context.pages()[0];
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => this.pageError('pageerror', error.stack || error.message));
    await page.evaluate(config => { window.__PLAYBOT_CONFIG__ = config; }, { speed: 1, draw: false });
    // Always load the current page agent (an older one is stopped first; its frame hook stays, idle).
    await page.evaluate(() => window.__playbot?.stop());
    await page.addScriptTag({ path: join(root, 'scripts', 'playbot', 'page-agent.js') });
    await page.evaluate(() => { window.__playbotDraw = false; const q = __wander.quality; q.locked = true; });
    // A panel left open by an earlier run pauses the round; close it before deciding the round needs starting.
    for (let i = 0; i < 4 && await page.evaluate(() => __wander.courier.ui?.isOpen); i++) { await page.keyboard.press('Escape'); await sleep(700); }
    if (!await page.evaluate(() => __wander.courier.isPlaying())) {
      await page.fill('#player-name', 'Playbot'); await page.click('#start-button');
      await page.waitForFunction(() => __wander.courier.isPlaying(), null, { timeout: 60000 });
    }
    this.note('attached to a running game');
  }

  pageError(kind, text) {
    // With the game clock sped up, trains run faster than the audio clock, so the rail clacks of one joint can be
    // scheduled before the last axle of the joint before it and Tone refuses. Simulated at ×1 this never happens,
    // so it is the bot's doing, not the game's.
    if (options.speed !== 1 && /last scheduled time/.test(text) && /RailwayAudio\._clack/.test(text)) return this.note('ignored a rail-sound timing error caused by the ×' + options.speed + ' clock');
    const key = String(text).split('\n').slice(0, 2).join(' ');
    if (this.errors.some(e => e.key === key)) { this.errors.find(e => e.key === key).count++; return; }
    this.errors.push({ key, kind, text: String(text).slice(0, 2000), count: 1, t: this.elapsed() });
    this.note(kind + ': ' + key.slice(0, 200));
  }

  /** A finding is anything a player would call a bug: kind, where, what was seen, and a picture. */
  async finding(kind, summary, detail = {}) {
    const state = await this.state().catch(() => null);
    const shot = await this.screenshot(kind).catch(() => null);
    const item = { kind, summary, t: this.elapsed(), seed: this.seed, place: state?.here || null, position: state?.position || null,
      screenshot: shot ? relative(outDir, shot) : null, detail, guidance: state?.guidance || null };
    this.findings.push(item);
    this.note('FINDING ' + kind + ': ' + summary);
    return item;
  }

  async screenshot(label) {
    const file = join(this.dir, String(++this.shots).padStart(2, '0') + '-' + label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40) + '.png');
    const page = this.page;
    await page.evaluate(() => { window.__playbotDraw = true; });
    try { await page.screenshot({ path: file, timeout: 240000 }); }
    finally { await page.evaluate(() => { window.__playbotDraw = false; }).catch(() => {}); }
    return file;
  }
  async milestone(label) {
    // Software drawing makes a screenshot cost a minute or more, so only the ending gets one unless asked.
    const shot = options.milestoneShots || label === 'ending' ? await this.screenshot(label).catch(() => null) : null;
    this.milestones.push({ label, t: this.elapsed(), screenshot: shot ? relative(outDir, shot) : null });
    this.note('milestone: ' + label);
  }

  // ------------------------------------------------------------ eyes
  /** What the bot can know: the same things the book, the satchel and the screen show, plus the save for the report. */
  state() {
    return this.page.evaluate(async () => {
      const story = await import('/src/courierstory.mjs');
      const w = __wander, c = w.courier, k = c.controller, s = k.story, p = w.controls.rig.position;
      const choiceEl = document.querySelector('#courier-choice');
      const jobs = Object.entries(s.jobs).map(([id, job]) => { const def = k.jobDef(id); return { id, state: job.state, title: def?.title, sender: def?.sender, recipient: def?.recipient, unaddressed: !!def?.unaddressed }; });
      const offers = Object.entries(s.plot.sites).flatMap(([site, entry]) => entry.offers.map(offer => ({ site, account: offer.a, channel: offer.ch, held: !!s.evidence[offer.a], by: s.plot.accounts[offer.a]?.by || null })));
      return {
        position: { x: Math.round(p.x), z: Math.round(p.z) }, here: c.settlementAt(p), hour: Math.round(((w.sky.time * 24) % 24) * 10) / 10, day: w.sky.dayIndex,
        mode: c.rail.riding ? 'train' : c.horseRiding.riding ? 'horse' : 'foot',
        welcome: k.welcome ? { step: k.welcome.step } : null, onboarding: { ...s.onboarding },
        panel: c.ui?.isOpen ? c.ui.view : null, dialogue: w.livingWorld.dialogueOpen ? w.livingWorld.conversationNpcId : null,
        choice: choiceEl && getComputedStyle(choiceEl).display !== 'none' && choiceEl.textContent.trim() ? choiceEl.textContent : null,
        guidance: k.guidance(),
        beats: Object.fromEntries(story.STORY_BEATS.map(beat => [beat.id, story.beatDone(s, beat.id) ? 'done' : story.beatOpen(s, beat.id) ? 'open' : 'closed'])),
        evidence: Object.keys(s.evidence), ready: k.readyThread(), hypothesis: !!s.hypothesis,
        jobs, satchel: jobs.filter(j => j.state === 'active').length, delivered: k.deliveredCount(),
        offers, closer: s.plot.closer, seen: s.plot.pacing.seen.map(entry => entry[0]), arrivals: s.plot.pacing.arrivals,
        places: s.bindings.places, boards: [...c.noticeBoards.keys()], saveBytes: JSON.stringify(s).length,
      };
    });
  }

  // ------------------------------------------------------------ hands
  get panel() { return this.page.locator('#courier-panel'); }
  async buttons() { return this.page.evaluate(() => [...document.querySelectorAll('#courier-panel button')].filter(b => b.offsetParent && !b.disabled).map(b => b.textContent.trim())); }
  async click(pattern) {
    const names = await this.buttons();
    const name = names.find(n => typeof pattern === 'string' ? n === pattern || n.replace(/↵$/, '') === pattern : pattern.test(n));
    if (!name) return null;
    // By its text, as shown: a primary button carries a ↵ that is not part of its accessible name.
    await this.page.evaluate(text => [...document.querySelectorAll('#courier-panel button')].find(b => b.offsetParent && !b.disabled && b.textContent.trim() === text)?.click(), name);
    await sleep(400);
    return name;
  }
  async closePanel() {
    for (let i = 0; i < 4; i++) {
      const open = await this.page.evaluate(() => __wander.courier.ui?.isOpen || __wander.livingWorld.dialogueOpen);
      if (!open) return;
      await this.page.keyboard.press('Escape'); await sleep(700);
    }
  }
  async idleChat() { await this.page.waitForFunction(() => !__wander.livingWorld.chatBusy, null, { timeout: 90000 }); }
  async say(text) {
    await this.panel.locator('[data-field="chat"]').fill(text);
    await this.panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await sleep(300); await this.idleChat(); await sleep(700);
    return this.page.evaluate(() => __wander.livingWorld.chatHistory?.at(-1)?.content || '');
  }
  async pressChoice(yes) { await this.page.keyboard.press(yes ? 'y' : 'n'); await sleep(900); }

  // ------------------------------------------------------------ the welcome
  async welcome() {
    if ((await this.state()).onboarding.seen && !(await this.page.evaluate(() => !!__wander.courier.controller.welcome))) return;
    // Ada should walk over and say hello on her own; the bot only waits.
    const met = await this.page.waitForFunction(() => {
      const c = __wander.courier, ada = c.controller.npc('dispatcher'), a = __wander.livingWorld.actorById(ada?.id), p = __wander.controls.rig.position;
      return a && Math.hypot(a.avatar.root.position.x - p.x, a.avatar.root.position.z - p.z) < 4.2 && (c.welcomeLog || []).some(l => /greeting|greeted/.test(l.step));
    }, null, { timeout: 60000 }).then(() => true, () => false);
    if (!met) {
      const log = await this.page.evaluate(() => __wander.courier.welcomeLog || []);
      await this.finding('welcome', 'Ada did not walk over and greet the new courier within a minute of Begin', { welcomeLog: log });
    }
    await this.milestone('ada-arrives');
    // Under a heavy machine a frame can take seconds, so give T time, and press it once more before calling it broken.
    let opened = false;
    for (let press = 0; press < 2 && !opened; press++) {
      if (!await this.page.evaluate(() => __wander.livingWorld.dialogueOpen)) await this.page.keyboard.press('t');
      opened = await this.page.waitForFunction(() => __wander.livingWorld.dialogueOpen, null, { timeout: 30000 }).then(() => true, () => false);
    }
    if (!opened) { await this.finding('welcome', 'Pressing T beside Ada did not open the conversation'); return; }
    const lines = [];
    for (const reply of ['Yes please, tell me how it works.', 'I see. Go on.', 'And the country round about?', 'That sounds good.']) {
      if (await this.page.evaluate(() => !!__wander.courier.choice)) break;
      lines.push(await this.say(reply));
    }
    // The offer's Y/N prompt follows Ada's line by a moment.
    await this.page.waitForFunction(() => /A Note Across the Village/.test(document.querySelector('#courier-choice')?.textContent || '')
      && getComputedStyle(document.querySelector('#courier-choice')).display !== 'none', null, { timeout: 20000 }).catch(() => {});
    const choice = (await this.state()).choice;
    if (!choice || !/A Note Across the Village/.test(choice)) {
      await this.finding('welcome', 'The welcome did not hold out A Note Across the Village with a Y/N prompt after four replies', { lines, choice });
      return;
    }
    await this.milestone('first-errand-offered');
    await this.pressChoice(true);
    await sleep(6000);
    const after = await this.state();
    if (after.jobs.find(j => j.id === 'village-note')?.state !== 'active') await this.finding('welcome', 'Y on the first errand did not put it in the satchel', { choice });
    if (after.dialogue) { await sleep(8000); if ((await this.state()).dialogue) await this.finding('welcome', 'The welcome conversation stayed open after the errand was taken'); }
    await this.closePanel();
  }

  // ------------------------------------------------------------ travel
  /** Walk (or ride) along the trail network to a point, hopping long stretches when travel is mixed. */
  async travelTo(target, { arrive = 3, label = 'somewhere', follow = null } = {}) {
    const page = this.page;
    let from = await page.evaluate(() => { const p = __wander.controls.rig.position; return { x: p.x, z: p.z }; });
    if (Math.hypot(target.x - from.x, target.z - from.z) <= arrive) return true;
    // Indoors: leave by the door first, as a player would, then plan from the doorstep.
    const out = await page.evaluate(to => __playbot.wayOut(to), { x: target.x, z: target.z }).catch(() => null);
    if (out) {
      const inside = await this.local(from, out.points[0]);
      const exit = { label: label + ' (leaving ' + out.building.split(':').slice(-2).join(' ') + ')', from: { x: Math.round(from.x), z: Math.round(from.z) }, to: { x: Math.round(out.points[2].x), z: Math.round(out.points[2].z) }, straight: 0, walked: 0, hopped: 0, rode: 0, result: null, stalls: [] };
      this.travel.legs.push(exit);
      exit.result = await this.move([...(inside || []), ...out.points], { arrive: 1, label: exit.label, leg: exit }) ? 'arrived' : 'failed';
      from = await page.evaluate(() => { const p = __wander.controls.rig.position; return { x: p.x, z: p.z }; });
    }
    const straight = Math.hypot(target.x - from.x, target.z - from.z);
    if (straight <= arrive) return true;
    const leg = { label, from: { x: Math.round(from.x), z: Math.round(from.z) }, to: { x: Math.round(target.x), z: Math.round(target.z) }, straight: Math.round(straight), walked: 0, hopped: 0, rode: 0, result: null, stalls: [] };
    this.travel.legs.push(leg);
    let points = [target];
    if (straight > 220) {
      const route = await page.evaluate(async ({ from, target }) => {
        const { trailFrameAtArc } = await import('/src/trails.js');
        const c = __wander.courier, graph = c.getNavGraph();
        let a = null, b = null;
        for (const node of graph.nodes.values()) {
          if (!node.links?.length) continue;
          const da = Math.hypot(node.x - from.x, node.z - from.z), db = Math.hypot(node.x - target.x, node.z - target.z);
          if (!a || da < a.d) a = { node, d: da };
          if (!b || db < b.d) b = { node, d: db };
        }
        if (!a || !b || a.node === b.node) return null;
        const route = c.courierRoute(graph, a.node.key, b.node.key);
        if (!route?.legs?.length) return null;
        const points = [];
        for (const leg of route.legs) {
          const length = leg.edge.arcLength;
          for (let d = 0; d <= length; d += 10) {
            const f = trailFrameAtArc(leg.edge, leg.forward ? d : length - d, {});
            // A trail out of a station can run straight through the village's houses; mark points that sit
            // inside a house so the bot plans its own way round the village instead of walking into walls.
            if (Number.isFinite(f?.x)) points.push({ x: f.x, z: f.z, indoors: __playbot.groundFloor(f.x, f.z) != null });
          }
        }
        return { points, distance: route.distance, from: a.node.key, to: b.node.key, joinFrom: a.d, joinTo: b.d };
      }, { from, target });
      if (route?.points?.length) {
        // Join the trail past the last house it crosses near the start, and leave it before the first house it
        // crosses near the end; the local planner finds the way through the village streets.
        const near = (p, q) => Math.hypot(p.x - q.x, p.z - q.z) < 250;
        let first = 0, last = route.points.length - 1;
        route.points.forEach((p, i) => { if (p.indoors && near(p, from)) first = Math.max(first, i + 2); });
        for (let i = route.points.length - 1; i >= first; i--) if (route.points[i].indoors && near(route.points[i], target)) last = Math.min(last, i - 2);
        if (first > 0 || last < route.points.length - 1) leg.trimmed = { first, last: route.points.length - 1 - last };
        route.points = last > first ? route.points.slice(first, last + 1).map(({ x, z }) => ({ x, z })) : [];
      }
      if (route?.points?.length && route.distance < straight * 3 + 400) {
        const end = route.points[route.points.length - 1];
        const out = Math.hypot(route.points[0].x - from.x, route.points[0].z - from.z) < 200 ? await this.wayRound(from, route.points[0]) : null;
        const last = Math.hypot(target.x - end.x, target.z - end.z) < 200 ? await this.wayRound(end, target, Math.max(0, arrive - 0.5)) : null;
        points = [...(out || []), ...route.points, ...(last || [target])];
        leg.route = { distance: Math.round(route.distance), from: route.from, to: route.to };
      } else leg.route = null;
    }
    // Across open ground, or within a village: go round the houses at each end rather than into them.
    // The last stretch only has to come within reach (a person behind a counter, a board on a porch).
    const near = Math.max(0, arrive - 0.5);
    if (!leg.route) points = await this.wayRound(from, target, near);
    const total = points.reduce((sum, p, i) => sum + (i ? Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : Math.hypot(p.x - from.x, p.z - from.z)), 0);
    // Mixed travel walks the first and last stretches of a long leg, and hops the middle.
    if (options.travel === 'mixed' && total > options.walkLimit) {
      const keep = options.walkLimit / 2;
      let run = Math.hypot(points[0].x - from.x, points[0].z - from.z), cut = points.length - 1;
      for (let i = 1; i < points.length; i++) { run += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z); if (run > total - keep) { cut = i; break; } }
      // Walk out of here first, so the way out of a village is always tested.
      let out = 0, start = 0;
      for (let i = 1; i < points.length && out < keep; i++) { out += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z); start = i; }
      if (start < cut) {
        if (!await this.move(points.slice(0, start + 1), { arrive: 4, label: label + ' (setting out)', leg })) return false;
        const hop = points[cut];
        const at = await page.evaluate(() => { const p = __wander.controls.rig.position; return { x: p.x, z: p.z }; });
        leg.hopped += Math.round(Math.hypot(hop.x - at.x, hop.z - at.z)); this.travel.hopped += Math.hypot(hop.x - at.x, hop.z - at.z);
        await this.hop(hop);
        points = points.slice(cut);
      }
    }
    const ok = await this.move(points, { arrive, label, leg, follow });
    leg.result = ok ? 'arrived' : 'failed';
    return ok;
  }

  /** Put the courier down somewhere (a debug teleport, counted as hopped) and wait for the ground to be there. */
  async hop(point) {
    await this.page.evaluate(({ x, z }) => {
      if (__wander.horseRiding.riding) __wander.horseRiding.dismount();
      const floor = __playbot.groundFloor(x, z);
      if (floor != null) __wander.controls.placeAt(x, floor + 0.02, z); else __wander.controls.place(x, z);
    }, point);
    await this.page.waitForFunction(() => { const w = __wander, p = w.controls.rig.position; return w.chunkMgr.hasTerrainAt(p.x, p.z) && w.chunkMgr.pendingNearby() === 0; }, null, { timeout: 180000 }).catch(() => {});
    await sleep(1500);
  }

  /**
   * Across open ground: the straight line, cut into 150 m stretches, each with
   * its own way round whatever walls are on it (a stretch's end that falls in
   * a house moves to open ground beside it).
   */
  async wayRound(from, to, near = 0) {
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    const n = Math.max(1, Math.ceil(d / 150)), out = [];
    let at = { x: from.x, z: from.z };
    for (let k = 1; k <= n; k++) {
      const last = k === n, end = last ? to : { x: from.x + (to.x - from.x) * k / n, z: from.z + (to.z - from.z) * k / n };
      const way = await this.local(at, end, !last, last ? near : 0);
      out.push(...(way || [end]));
      at = out[out.length - 1];
    }
    return out;
  }

  /** A way round walls between two nearby points (page-agent planLocal), or null. */
  local(from, to, nudge = false, near = 0) {
    return this.page.evaluate(({ from, to, nudge, near }) => __playbot.planLocal(from, to, { nudge, near }), { from: { x: from.x, z: from.z }, to: { x: to.x, z: to.z }, nudge, near }).catch(() => null);
  }

  async move(points, { arrive, label, leg, follow = null }, retried = false) {
    const page = this.page;
    const fragile = (await this.state()).jobs.some(j => j.id === 'platform-cup' && j.state === 'active');
    await page.evaluate(({ points, arrive, label, sprint, follow }) => __playbot.go(points, { arrive, label, sprint, follow }), { points, arrive, label, sprint: !fragile, follow });
    const startedAt = Date.now();
    // A leg only times out if it stops getting anywhere for a minute and a half of wall clock (a slow machine
    // walks slowly but steadily), or takes far longer than any walk should. A real stall is caught sooner by the
    // steering's own stall check.
    const budget = 600e3 + points.length * 30 * 1000;
    let status = null, best = Infinity, reached = -1, gainedAt = startedAt;
    while (true) {
      await sleep(1500);
      status = await page.evaluate(() => __playbot.status());
      if (!status || status.state !== 'moving') break;
      // Progress is a new waypoint reached or the end coming closer.
      if (status.i > reached || (Number.isFinite(status.toEnd) && status.toEnd < best - 2)) { reached = Math.max(reached, status.i); best = Math.min(best, status.toEnd ?? best); gainedAt = Date.now(); }
      if (Date.now() - gainedAt > 90e3 || Date.now() - startedAt > budget) { await page.evaluate(() => __playbot.stop('timeout')); status.state = 'timeout'; break; }
      // Something opened on its own (a neighbour calling over, a notice): read it and carry on.
      const busy = await page.evaluate(() => __wander.courier.ui?.isOpen || __wander.livingWorld.dialogueOpen);
      if (busy) { this.note('something opened while walking; closing it'); await this.closePanel(); }
    }
    const mode = await page.evaluate(() => __wander.horseRiding.riding ? 'horse' : 'foot');
    if (mode === 'horse') { this.travel.rode += status.walked; leg.rode += status.walked; } else { this.travel.walked += status.walked; leg.walked += status.walked; }
    leg.stalls.push(...(status.events || []));
    if (status.state === 'arrived') return true;
    // Within talking distance of someone it was following is as good as there (the game's talk range is 6.5 m).
    if (follow && Number.isFinite(status.toEnd) && status.toEnd <= 5) return true;
    if (!retried && status.position) {
      // One second try: find a way round from where the courier stands, as a player would after bumping into a wall.
      const end = points[points.length - 1], here = status.position, i = Math.min(status.i, points.length - 1);
      const goal = Math.hypot(end.x - here.x, end.z - here.z) < 200 ? points.length - 1 : i;
      const way = await this.wayRound(here, points[goal]);
      if (way) {
        this.note('stuck on the way to ' + label + '; trying a way round');
        return this.move([...way, ...points.slice(goal + 1)], { arrive, label, leg, follow }, true);
      }
    }
    await this.finding('stuck-route', `Stuck${status.state === 'timeout' ? ' (too slow)' : ''} on the way to ${label}: ${status.toEnd} m short after ${status.walked} m on ${mode}`,
      { status, label, leg: { from: leg.from, to: leg.to, route: leg.route } });
    // Rescue: put the courier down where it was going, so one bad corner does not end the round. It counts as hopped.
    const end = points[points.length - 1];
    const gap = Math.hypot(end.x - status.position.x, end.z - status.position.z);
    leg.hopped += Math.round(gap); this.travel.hopped += gap; leg.rescued = true;
    await this.hop(end);
    this.note('rescued: hopped the last ' + Math.round(gap) + ' m to ' + label);
    return true;
  }

  // ------------------------------------------------------------ people and places
  async personInfo(npcId) {
    return this.page.evaluate(id => {
      const w = __wander, c = w.courier, k = c.controller, a = w.livingWorld.actorById(id), p = w.controls.rig.position;
      const entity = w.livingWorld.worldState.entities[id];
      const place = k.placeForNpc?.(id) || c.npcPlace?.(id);
      const placeRecord = place && k.place(place);
      const role = k.roleFor(id), cast = role ? k.npc(role) : null, plotPerson = k.story.plot.people?.[id];
      const home = cast?.home || plotPerson?.home || (place ? c.adultsOf(place).find(x => x.id === id)?.home : null);
      // Stand outside the front door, not in the middle of the house: a courier knocks.
      let approach = null;
      const building = home?.id && Object.values(c.plans || {}).flatMap(plan => plan?.buildings || []).find(b => b.id === home.id);
      const door = building?.portals?.find(portal => portal.kind === 'exterior-door') || building?.portals?.[0];
      if (door) {
        // A step out from the door along its own axis; either handedness of the building's yaw, whichever lands in the open.
        const lx = Math.abs(door.x) > Math.abs(door.z) ? door.x + Math.sign(door.x) * 2.5 : door.x;
        const lz = Math.abs(door.x) > Math.abs(door.z) ? door.z : door.z + Math.sign(door.z || 1) * 2.5;
        for (const hand of [1, -1]) {
          const cos = Math.cos(building.yaw), sin = Math.sin(building.yaw) * hand;
          const point = { x: building.x + lx * cos + lz * sin, z: building.z - lx * sin + lz * cos };
          if (!w.structureCollision.collides(point.x, point.z, (building.y || p.y) + 0.05, 0.5)) { approach = point; break; }
        }
      }
      return { id, name: entity?.name || cast?.name || plotPerson?.name, visible: !!a?.avatar?.root?.visible,
        at: a ? { x: a.avatar.root.position.x, z: a.avatar.root.position.z } : null, distance: a ? Math.hypot(a.avatar.root.position.x - p.x, a.avatar.root.position.z - p.z) : null,
        place, placeAt: placeRecord ? { x: placeRecord.x, z: placeRecord.z } : null, home: home ? { x: approach?.x ?? home.x, z: approach?.z ?? home.z, address: home.address, door: !!approach } : null };
    }, npcId);
  }

  /** Walk up to someone, press T and wait for the conversation, as a player would. */
  async talkTo(npcId, why = '') {
    let info = await this.personInfo(npcId);
    const label = (info.name || npcId) + (why ? ' (' + why + ')' : '');
    if (!info.at || info.distance > 60) {
      const goal = info.home || info.placeAt;
      if (!goal) { await this.finding('dead-end', 'Nobody can say where ' + label + ' is: no home and no place', { info }); return false; }
      if (!await this.travelTo(goal, { arrive: 6, label: label + '’s home' })) return false;
      for (let i = 0; i < 20 && !(info = await this.personInfo(npcId)).at; i++) await sleep(1500);
      if (!info.at) {
        // Out at work or asleep: wait a little, then try their place's middle.
        if (info.placeAt) await this.travelTo(info.placeAt, { arrive: 10, label: (info.name || npcId) + '’s village' });
        for (let i = 0; i < 20 && !(info = await this.personInfo(npcId)).at; i++) await sleep(1500);
      }
      if (!info.at) { await this.finding('missing-person', label + ' is not anywhere near their home or village', { info }); return false; }
    }
    let lastMiss = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      // The game offers T to the nearest person within 6.5 m, so there is no need to walk right up.
      const already = await this.page.evaluate(id => { const a = __wander.livingWorld.activeNpc; return a?.identity?.id === id && a.distance < 5; }, npcId);
      if (!already && !await this.travelTo(info.at, { arrive: 3, label, follow: npcId })) {
        info = await this.personInfo(npcId);
        if (!info.at || info.distance > 4) continue;
      }
      const ok = await this.page.evaluate(id => {
        const w = __wander, a = w.livingWorld.actorById(id), p = w.controls.rig.position;
        if (!a) return false;
        const at = a.avatar.root.position; w.controls.yaw = Math.atan2(at.x - p.x, at.z - p.z) + Math.PI;
        return true;
      }, npcId);
      await sleep(600);
      const active = await this.page.evaluate(() => ({ id: __wander.livingWorld.activeNpc?.identity?.id || null, d: __wander.livingWorld.activeNpc?.distance }));
      if (!ok || active.id !== npcId) {
        // The game talks to whoever is nearest. When someone else is nearer, step round to the far side
        // of the person we want, away from the others, as a player would.
        lastMiss = await this.page.evaluate(({ id, other }) => {
          const w = __wander, lw = w.livingWorld, a = lw.actorById(id), p = w.controls.rig.position;
          if (!a) return { missing: true };
          const at = a.avatar.root.position, b = other && lw.actorById(other);
          const away = b ? { x: at.x - b.avatar.root.position.x, z: at.z - b.avatar.root.position.z } : { x: p.x - at.x, z: p.z - at.z };
          const len = Math.hypot(away.x, away.z) || 1;
          return { visible: !!a.avatar.root.visible, interactive: !!a.identity?.interactive, distance: Math.hypot(at.x - p.x, at.z - p.z), dy: at.y - p.y,
            nearer: other, nearerDistance: lw.activeNpc?.distance, spot: { x: at.x + away.x / len * 0.9, z: at.z + away.z / len * 0.9 } };
        }, { id: npcId, other: active.id });
        if (lastMiss?.spot && active.id) await this.travelTo(lastMiss.spot, { arrive: 0.5, label });
        info = await this.personInfo(npcId); continue;
      }
      await this.page.keyboard.press('t');
      if (await this.page.waitForFunction(id => __wander.livingWorld.dialogueOpen && __wander.livingWorld.conversationNpcId === id, npcId, { timeout: 15000 }).then(() => true, () => false)) {
        await this.idleChat(); return true;
      }
    }
    await this.finding('cannot-talk', 'Stood beside ' + label + ' but could not start a conversation with T'
      + (lastMiss?.nearer ? '; the game kept offering ' + lastMiss.nearer + ' instead' : ''), { info, lastMiss });
    return false;
  }

  async boardPosition(placeKey) {
    return this.page.evaluate(key => {
      const c = __wander.courier, p = c.sourcePositions.get('board:' + key) || c.sourcePositions.get('stand:' + key);
      return p ? { x: p.x, z: p.z } : null;
    }, placeKey);
  }

  /** Stand at a place's board, press E, read the notices, then every account the stand shows. */
  async readBoard(placeKey, why = 'board') {
    let at = await this.boardPosition(placeKey);
    if (!at) {
      const place = await this.page.evaluate(key => { const p = __wander.courier.controller.place(key); return p && { x: p.x, z: p.z, name: p.name }; }, placeKey);
      if (!place) return false;
      if (!await this.travelTo(place, { arrive: 15, label: (place.name || placeKey) + ' (' + why + ')' })) return false;
      for (let i = 0; i < 10 && !(at = await this.boardPosition(placeKey)); i++) await sleep(1000);
      if (!at) { await this.finding('dead-end', 'No Post & Errands board appeared in ' + (place.name || placeKey) + ' though the story needs it', { placeKey }); return false; }
    }
    if (!await this.travelTo({ x: at.x, z: at.z + 1 }, { arrive: 2.5, label: 'the board in ' + placeKey })) return false;
    // The game reads the board (or stand) nearest within 5 m; wait for it to count us as there, so a miss below is the game's.
    const near = () => this.page.evaluate(key => {
      const c = __wander.courier, p = c.sourcePositions.get('board:' + key) || c.sourcePositions.get('stand:' + key), r = __wander.controls.rig.position;
      return { boards: [...c.nearbyBoards().map(b => b.place), ...c.nearbySources().map(() => 'stand')], distance: p ? Math.round(Math.hypot(p.x - r.x, (p.y ?? r.y) - r.y, p.z - r.z) * 10) / 10 : null,
        open: !!c.ui?.isOpen, focus: document.activeElement?.tagName || null, choice: !!c.choice };
    }, placeKey);
    let before = await near();
    // The spot in front of a board can sit inside its frame, and the planner then stops short; close in on the board itself.
    if (!before.boards.length) { await this.travelTo({ x: at.x, z: at.z }, { arrive: 3.5, label: 'closer to the board in ' + placeKey }); before = await near(); }
    for (let i = 0; i < 4 && !before.boards.length; i++) { await sleep(1000); before = await near(); }
    await this.page.keyboard.press('e');
    const opened = await this.page.waitForFunction(() => __wander.courier.ui?.isOpen, null, { timeout: 8000 }).then(() => true, () => false);
    if (!opened) { await this.finding('cannot-read', 'Pressing E at the board in ' + placeKey + ' opened nothing' + (before.boards.length ? '' : ' (the game did not count the courier as at the board, ' + before.distance + ' m away)'), { before }); return false; }
    const read = [];
    for (let i = 0; i < 14; i++) {
      const name = await this.click(/^Read board: /) || await this.click(/^Read nearby: /) || await this.click('Back to accounts')
        || await this.click('Read the public accounts here');
      if (!name) break;
      if (/^Read/.test(name)) read.push(name);
    }
    if (read.length) this.note('read at ' + placeKey + ': ' + read.join('; '));
    await this.closePanel();
    return true;
  }

  /** Open the book's Story page and do what it offers: compare, consider the pattern. */
  async book() {
    const s = await this.state();
    if (!s.ready && s.beats.pattern !== 'open') return false;
    await this.closePanel();
    await this.page.keyboard.press('n');
    if (!await this.page.waitForFunction(() => __wander.courier.ui?.isOpen, null, { timeout: 8000 }).then(() => true, () => false)) {
      await this.finding('book', 'N did not open the book'); return false;
    }
    await this.click(/^\d?Story$/);
    const did = [];
    for (let i = 0; i < 5; i++) { const name = await this.click(/^Compare: /) || await this.click('Consider the larger pattern'); if (!name) break; did.push(name); }
    await this.closePanel();
    const after = await this.state();
    if (did.length) this.note('book: ' + did.join('; '));
    if ((s.ready && !did.some(d => d.startsWith('Compare'))) || (s.beats.pattern === 'open' && after.beats.pattern !== 'done' && !s.ready)) {
      await this.finding('book', 'The book did not offer the step the story was ready for', { ready: s.ready, pattern: s.beats.pattern, buttons: did });
    }
    if (after.beats.pattern === 'done' && s.beats.pattern !== 'done') await this.milestone('pattern');
    return did.length > 0;
  }

  // ------------------------------------------------------------ deliveries and jobs
  async deliver(job) {
    const recipient = await this.page.evaluate(role => __wander.courier.controller.npc(role)?.id || role, job.recipient);
    if (!await this.talkTo(recipient, 'deliver ' + job.title)) return false;
    let done = await this.click('Deliver ' + job.title);
    if (!done) {
      // The Y/N prompt to hand it over comes after a little while.
      const prompt = await this.page.waitForFunction(() => __wander.courier.choice?.kind === 'deliver', null, { timeout: 25000 }).then(() => true, () => false);
      if (prompt) { await this.pressChoice(true); done = 'Y'; }
    }
    await sleep(1500);
    const s = await this.state();
    const state = s.jobs.find(j => j.id === job.id)?.state;
    if (state !== 'delivered') {
      await this.finding('delivery', 'Could not hand over ' + job.title + ' to its recipient (no Deliver button or prompt; state ' + state + ')', { job, buttons: await this.buttons() });
      await this.closePanel(); return false;
    }
    this.note('delivered ' + job.title);
    if (s.delivered === 1) await this.milestone('first-delivery');
    // A reply to carry back may be held out at once.
    if (s.choice && /^Take /.test(s.choice) && s.satchel < 3) await this.pressChoice(true);
    await this.closePanel();
    return true;
  }

  async acceptFromSender(job) {
    const sender = await this.page.evaluate(role => __wander.courier.controller.npc(role)?.id || role, job.sender);
    if (!await this.talkTo(sender, 'collect ' + job.title)) return false;
    let took = await this.click('Accept ' + job.title);
    if (!took) {
      await this.say('Have you any packages for me?');
      const s = await this.state();
      if (s.choice && /^Take /.test(s.choice)) { await this.pressChoice(true); took = 'Y'; }
    }
    await sleep(1000);
    const state = (await this.state()).jobs.find(j => j.id === job.id)?.state;
    await this.closePanel();
    if (state !== 'active') { await this.finding('collect', 'Asked ' + job.title + '’s sender for it but it did not go into the satchel (state ' + state + ')', { job }); return false; }
    this.note('collected ' + job.title);
    return true;
  }

  // ------------------------------------------------------------ the round
  async play() {
    await this.welcome();
    let lastProgress = '', stale = 0, steps = 0;
    while (Date.now() < this.deadline) {
      steps++;
      const s = await this.state();
      const progress = JSON.stringify([s.evidence.length, s.delivered, Object.values(s.beats).filter(b => b === 'done').length, s.seen.length, s.satchel]);
      if (progress === lastProgress) stale++; else { stale = 0; lastProgress = progress; }
      if (stale === 12) await this.finding('softlock', 'Twelve steps in a row changed nothing the story counts (papers, deliveries, beats, places)', { state: s });
      if (stale >= 30) { await this.finding('softlock', 'Gave up: thirty steps with no progress', { state: s }); break; }
      if (s.beats.ending === 'done') { await this.milestone('ending'); await this.readEnding(); return 'ended'; }
      const action = await this.decide(s);
      this.note('step ' + steps + ': ' + action.why);
      const ok = await action.run().catch(async error => { await this.finding('bot-error', 'The bot itself failed: ' + error.message, { stack: error.stack }); return false; });
      if (!ok) this.failedTargets.set(action.key, (this.failedTargets.get(action.key) || 0) + 1);
    }
    return Date.now() >= this.deadline ? 'out of time' : 'gave up';
  }

  /** Choose the next thing to do, from what the book and the satchel say, the way a player follows the book. */
  async decide(s) {
    const tried = key => (this.failedTargets.get(key) || 0) >= 2;
    const act = (key, why, run) => ({ key, why, run });
    if (s.choice && /^Take A Note Across the Village/.test(s.choice)) return act('welcome-yes', 'say yes to the first errand', () => this.pressChoice(true).then(() => true));
    if (s.welcome && !s.onboarding.seen && !tried('welcome')) return act('welcome', 'finish the welcome', () => this.welcome().then(() => true));
    if (s.ready || s.beats.pattern === 'open') return act('book', 'open the book: ' + (s.ready ? 'compare “' + s.ready.title + '”' : 'consider the pattern'), () => this.book());
    // The last letter.
    if (s.closer && s.beats.ending === 'open' && !tried('closer')) return act('closer', 'find ' + s.closer.name + ' in ' + s.closer.siteName + ' and show what I found', async () => {
      if (!await this.talkTo(s.closer.id, 'asked for the courier')) return false;
      const name = await this.click('Show what I found');
      if (!name) { await this.finding('dead-end', s.closer.name + ' asked for the courier but the conversation has no “Show what I found”', { buttons: await this.buttons() }); await this.closePanel(); return false; }
      await sleep(1500); await this.closePanel(); return true;
    });
    // A paper waiting to be handed over in person.
    const handed = s.offers.filter(o => o.channel === 'handed' && !o.held && o.by && !tried('handed:' + o.account));
    if (handed.length) {
      const offer = handed.find(o => o.site === s.places?.[s.here]?.id || o.site === s.here) || handed[0];
      return act('handed:' + offer.account, 'collect a paper someone has written for me (' + offer.account + ')', async () => {
        if (!await this.talkTo(offer.by, 'has something for me')) return false;
        const name = await this.click(/^Take: /);
        if (!name) { await this.finding('dead-end', 'The writer of a handed paper has nothing to hand over when spoken to', { offer, buttons: await this.buttons() }); await this.closePanel(); return false; }
        this.note('took ' + name.replace(/^Take:\s*/, '').trim() + ' from ' + offer.by);
        await sleep(1200); await this.closePanel(); return true;
      });
    }
    // Papers pinned up at a stand.
    const pinned = s.offers.filter(o => o.channel === 'stand' && !o.held && !tried('stand:' + o.site));
    if (pinned.length) {
      const offer = pinned[0];
      const key = await this.page.evaluate(site => __wander.courier.controller.placeKey(site) || site, offer.site);
      return act('stand:' + offer.site, 'read what is pinned up in ' + key, () => this.readBoard(key, 'a paper is pinned up'));
    }
    // Post in the satchel.
    const active = s.jobs.filter(j => j.state === 'active' && !j.unaddressed && !tried('deliver:' + j.id));
    if (active.length) {
      const job = active.find(j => j.id === s.guidance?.jobId) || active[0];
      return act('deliver:' + job.id, 'deliver ' + job.title, () => this.deliver(job));
    }
    // The tutorial's own stands, until their accounts are read (A first; it holds the dispatch sheet).
    for (const key of ['A', 'B', 'H']) {
      const fixed = await this.page.evaluate(k => __wander.courier.controller.sources().filter(src => src.place === k && !__wander.courier.controller.story.evidence[src.id]).length, key);
      if (fixed && !tried('stand:' + key)) return act('stand:' + key, 'read the stand in ' + (s.places[key]?.name || key), () => this.readBoard(key, 'the stand'));
    }
    // What do people make of it: show what I carry to whoever is near.
    if (s.beats.voices === 'open' && s.evidence.length && !tried('voices:' + s.here)) return act('voices:' + s.here, 'show people what I carry', () => this.showAround());
    // Take on post when the policy is to carry it.
    if (options.policy === 'jobs' && s.satchel < 2) {
      const open = s.jobs.filter(j => ['offered', 'returned'].includes(j.state) && j.sender && !tried('collect:' + j.id));
      const local = [];
      for (const job of open) {
        const place = await this.page.evaluate(role => __wander.courier.controller.placeOf(role), job.sender);
        if (place && (place === s.here || place === s.places?.[s.here]?.key)) local.push(job);
      }
      const job = local[0] || (s.guidance?.jobId && open.find(j => j.id === s.guidance.jobId));
      if (job) return act('collect:' + job.id, 'collect ' + job.title, () => this.acceptFromSender(job));
    }
    // Otherwise go somewhere new and see what it has.
    return act('explore', 'go on to a settlement not yet visited', () => this.explore(s));
  }

  async showAround() {
    const people = await this.page.evaluate(() => {
      const w = __wander, p = w.controls.rig.position, k = w.courier.controller;
      return w.livingWorld.getExternalActors().filter(a => a.avatar?.root.visible && !k.story.knowledge[a.identity.id])
        .map(a => ({ id: a.identity.id, d: Math.hypot(a.avatar.root.position.x - p.x, a.avatar.root.position.z - p.z) }))
        .filter(a => a.d < 80).sort((a, b) => a.d - b.d).slice(0, 3).map(a => a.id);
    });
    if (!people.length) { this.note('nobody near to show'); return false; }
    let shown = 0;
    for (const id of people) {
      if (!await this.talkTo(id, 'show what I carry')) continue;
      await this.click(/^More to ask/);
      const name = await this.click('Show what I carry');
      if (name) shown++;
      const voices = await this.page.evaluate(() => Object.keys(__wander.courier.controller.story.plot.voices));
      this.note('showed what I carry to ' + id + (name ? '' : ' (no button: ' + (await this.buttons()).join(' | ') + ')') + '; voices heard: ' + voices.join(', '));
      await sleep(1200); await this.closePanel();
      if ((await this.state()).beats.voices === 'done') break;
    }
    return shown > 0;
  }

  async explore(s) {
    const next = await this.page.evaluate(({ seen, places }) => {
      const w = __wander, c = w.courier, graph = c.getNavGraph(), p = w.controls.rig.position;
      const known = new Set([...seen, ...Object.values(places).map(place => place.id)]);
      const candidates = [];
      for (const node of graph.nodes.values()) {
        const match = node.key.match(/^(settlement:[-\d]+:[-\d]+)(?::\d+)?:entrance$/) || node.key.match(/^R\d+$/);
        if (!match) continue;
        // Station nodes R0, R1… are the stations of station-settlement:0, :1…
        const id = node.key.endsWith(':entrance') ? node.key.replace(/:entrance$/, '') : 'station-settlement:' + node.key.slice(1);
        if (known.has(id)) continue;
        const d = Math.hypot(node.x - p.x, node.z - p.z);
        if (d < 150) continue;
        candidates.push({ key: node.key, x: node.x, z: node.z, d });
      }
      return candidates.sort((a, b) => a.d - b.d).slice(0, 6);
    }, { seen: s.seen, places: s.places });
    const target = next.find(n => !this.failedTargets.has('explore:' + n.key));
    if (!target) { await this.finding('dead-end', 'No settlement left to explore within reach of the trail network'); return false; }
    this.failedTargets.set('explore:' + target.key, 1);
    if (!await this.travelTo(target, { arrive: 8, label: 'new settlement ' + target.key })) return false;
    // Walk on into the middle, where the well and the board are.
    const middle = await this.page.evaluate(({ x, z }) => {
      const cat = __wander.courier.getSettlementCatalog(); let best = null;
      for (const r of cat.values()) { const d = Math.hypot(r.x - x, r.z - z); if (!best || d < best.d) best = { x: r.x, z: r.z, d, id: r.id }; }
      return best && best.d < 600 ? best : null;
    }, target);
    if (middle) await this.travelTo(middle, { arrive: 12, label: 'the middle of ' + middle.id });
    await sleep(2500);
    const here = (await this.state()).here;
    if (here) { const board = await this.boardPosition(here); if (board) await this.readBoard(here, 'arrived'); }
    return true;
  }

  async readEnding() {
    await this.page.keyboard.press('n'); await sleep(800);
    await this.click(/^\d?Story$/);
    const opened = await this.click(/^Open: /);
    const text = await this.page.evaluate(() => document.querySelector('#courier-panel')?.innerText?.slice(0, 2000) || '');
    this.ending = { opened, text };
    await this.screenshot('last-letter').catch(() => {});
    await this.closePanel();
  }

  async finish(outcome) {
    const s = await this.state().catch(() => null);
    if (s && s.saveBytes > 24 * 1024) await this.finding('save-size', 'The story save is ' + s.saveBytes + ' bytes, over the 24 KB the design allows');
    for (const error of this.errors) this.findings.push({ kind: 'page-error', summary: error.kind + ' ×' + error.count + ': ' + error.key.slice(0, 300), t: error.t, seed: this.seed, detail: { text: error.text } });
    const result = { seed: this.seed, outcome, minutes: Math.round((Date.now() - this.started) / 6e3) / 10, loadSeconds: this.loadSeconds,
      travel: { walkedKm: +(this.travel.walked / 1000).toFixed(2), rodeKm: +(this.travel.rode / 1000).toFixed(2), hoppedKm: +(this.travel.hopped / 1000).toFixed(2), legs: this.travel.legs },
      final: s && { beats: s.beats, evidence: s.evidence.length, delivered: s.delivered, places: s.seen.length, arrivals: s.arrivals, saveBytes: s.saveBytes, guidance: s.guidance },
      milestones: this.milestones, findings: this.findings, ending: this.ending || null, log: this.log };
    await writeFile(join(this.dir, 'run.json'), JSON.stringify(result, null, 2));
    if (!options.attach) await this.context.close().catch(() => {});
    return result;
  }
}

// ---------------------------------------------------------------- main
function markdown(results) {
  const lines = ['# First Post playtest bot report', '', `Run ${stamp} · policy ${options.policy} · travel ${options.travel} (walk limit ${options.walkLimit} m) · clock ×${options.speed}`, ''];
  lines.push('| Seed | Outcome | Minutes | Beats done | Papers | Delivered | Places | Walked km | Rode km | Hopped km | Findings |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const beats = r.final ? Object.values(r.final.beats).filter(b => b === 'done').length + '/' + Object.keys(r.final.beats).length : '—';
    lines.push(`| ${r.seed} | ${r.outcome} | ${r.minutes} | ${beats} | ${r.final?.evidence ?? '—'} | ${r.final?.delivered ?? '—'} | ${r.final?.places ?? '—'} | ${r.travel?.walkedKm ?? 0} | ${r.travel?.rodeKm ?? 0} | ${r.travel?.hoppedKm ?? 0} | ${r.findings.length} |`);
  }
  lines.push('', '## Findings', '');
  const all = results.flatMap(r => r.findings);
  if (!all.length) lines.push('None.');
  for (const f of all) lines.push(`- **${f.kind}** (seed ${f.seed}, ${f.t}s${f.place ? ', in ' + f.place : ''}${f.position ? ` at ${f.position.x}, ${f.position.z}` : ''}): ${f.summary}${f.screenshot ? ` — [screenshot](${f.screenshot})` : ''}`);
  lines.push('', '## What was walked and what was hopped', '', 'Hopped stretches are debug teleports along the real trail route; walked and ridden ones use the game’s own movement, holding the keys a player holds.');
  return lines.join('\n') + '\n';
}

const { chromium } = await loadPlaywright();
const launch = await launchOptions();
await mkdir(outDir, { recursive: true });
console.log('Browser:', launch.how, '· report:', outDir);
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = options.attach ? await chromium.connectOverCDP(options.attach) : await chromium.launch({ headless: !options.headed, ...launch });
const results = [];
try {
  for (const seed of seeds) {
    const run = new Run(seed, browser, base);
    let outcome = 'error';
    try { await run.start(); outcome = await run.play(); }
    catch (error) { await run.finding('bot-error', 'Run stopped: ' + error.message, { stack: error.stack }).catch(() => run.findings.push({ kind: 'bot-error', summary: error.message, seed })); }
    results.push(await run.finish(outcome));
    await writeFile(join(outDir, 'report.json'), JSON.stringify({ options, seeds, results }, null, 2));
    await writeFile(join(outDir, 'report.md'), markdown(results));
  }
} finally {
  if (!options.attach) await browser.close().catch(() => {});
  server.close();
}
console.log('\n' + markdown(results));
process.exit(results.some(r => r.findings.length) ? 1 : 0);
