// The landing page's moving parts: the loading card while the world is made
// or opened, the way in once it is ready, and the multiplayer corner.
// The words and the progress maths are in landingprogress.mjs.

import { landingCopy, landingCreep, landingElapsed, landingStage } from './landingprogress.mjs';

/**
 * Has this device already made the world for `seed`? The water planner keeps
 * its candidates in IndexedDB under `revision:seed:x:z`; a full window of them
 * means the slow part is already done. Never creates the database: opening a
 * missing one is aborted, so the planner still sets it up itself.
 */
export function worldAlreadyBuilt(seed, revision, { indexedDB = globalThis.indexedDB, needed = 20, timeoutMs = 900, name = 'wander-water-candidates' } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    setTimeout(() => finish(null), timeoutMs);
    let request;
    try { request = indexedDB.open(name, 1); } catch { finish(null); return; }
    request.onupgradeneeded = () => { try { request.transaction.abort(); } catch { /* already aborting */ } finish(false); };
    request.onerror = () => finish(false);
    request.onblocked = () => finish(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const prefix = `${revision}:${seed}:`;
        const count = db.transaction('plans', 'readonly').objectStore('plans').count(IDBKeyRange.bound(prefix, prefix + '￿'));
        count.onsuccess = () => { db.close(); finish(count.result >= needed); };
        count.onerror = () => { db.close(); finish(null); };
      } catch { db.close(); finish(null); }
    };
  });
}

export class LandingPage {
  constructor({ overlay, statusEl, courierMode = true, now = () => performance.now() }) {
    Object.assign(this, { overlay, statusEl, courierMode, now });
    this.el = id => document.getElementById(id);
    this.startedAt = now(); this.stageAt = now();
    this.reading = landingStage(statusEl?.textContent);
    this.firstBuild = null; this.state = null; this.shadersAtStart = null; this.shown = 0; this.gameReady = false;
    if (!courierMode) this.openWorldCopy();
    this.setCopy();
    this.observer = new MutationObserver(() => this.read());
    if (statusEl) this.observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
    this.read();
    this.timer = setInterval(() => this.tick(), 250);
    this.setState('loading');
  }

  /** The open world keeps its own name and invitation, from the first moment the page shows. */
  openWorldCopy() {
    const title = document.querySelector('#overlay h1'), sub = document.querySelector('#overlay .sub'), pitch = document.querySelector('#overlay .pitch');
    if (title) title.textContent = 'Wander';
    if (sub) sub.textContent = 'an endless countryside';
    if (pitch) pitch.textContent = 'Walk where you like. Rivers find the sea, villages keep their own hours, and the people in them remember you.';
    const start = this.el('start-button'), entry = this.el('courier-entry-button'), name = document.querySelector('label[for="player-name"]');
    if (start) start.textContent = 'Begin by the lake';
    if (entry) entry.textContent = 'Play First Post';
    if (name) name.textContent = 'Your name';
    document.title = 'Wander';
    const ring = document.querySelector('#overlay .postmark textPath');
    if (ring) ring.textContent = 'WANDER · AN ENDLESS COUNTRYSIDE · WANDER ·';
  }

  /** What the cache check found: true for a first build, false for a world already on this device. */
  setFirstBuild(value) {
    if (value === null || value === this.firstBuild) return;
    this.firstBuild = value; this.setCopy();
  }

  setCopy() {
    const copy = landingCopy({ firstBuild: this.firstBuild === true, courierMode: this.courierMode });
    const title = this.el('landing-loading-title'), note = this.el('landing-note');
    if (this.firstBuild === null) { if (title) title.textContent = 'Getting ready'; if (note) note.textContent = ''; return; }
    if (title) title.textContent = copy.title;
    if (note) note.innerHTML = copy.note;
  }

  read() {
    const text = this.statusEl?.textContent || '';
    const shaders = text.match(/Preparing shaders… (\d+) left/);
    if (shaders && this.shadersAtStart === null) this.shadersAtStart = Number(shaders[1]);
    let reading = landingStage(text, { shadersAtStart: this.shadersAtStart });
    // The world can be ready before the round is: First Post still sorts its post after the land is made.
    if (reading.stage === 'ready' && !this.gameReady) reading = landingStage('Preparing the courier communities and their roads…');
    // The landscape's own words settle a cache check that could not answer.
    if (reading.cached !== null && this.firstBuild === null) this.setFirstBuild(!reading.cached);
    if (reading.cached === false && this.firstBuild === false) this.setFirstBuild(true);
    if (reading.stage !== this.reading.stage || reading.fraction > this.reading.fraction) this.stageAt = this.now();
    // The bar never runs backwards: a stage reported twice keeps its place.
    if (!reading.error && this.reading && reading.fraction < this.reading.fraction && reading.stage === this.reading.stage) reading.fraction = this.reading.fraction;
    this.reading = reading;
    if (reading.error) this.setState('error');
    this.render();
  }

  tick() {
    if (this.state !== 'loading' && this.state !== 'error') return;
    this.render();
  }

  render() {
    const bar = this.el('landing-progress'), stage = this.el('landing-stage'), elapsed = this.el('landing-elapsed');
    const seconds = (this.now() - this.startedAt) / 1000;
    if (elapsed) elapsed.textContent = seconds >= 3 ? landingElapsed(seconds) : '';
    if (stage) stage.textContent = this.reading.label + (this.reading.error || this.reading.stage === 'ready' ? '' : '…');
    if (!this.reading.error) {
      const target = landingCreep(this.reading, (this.now() - this.stageAt) / 1000);
      this.shown = Math.max(this.shown, target);
      if (bar) bar.style.width = (this.shown * 100).toFixed(1) + '%';
    }
  }

  /** `loading`, `ready` (the way in), `paused` (back from the round) or `error`. */
  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.overlay.dataset.state = state;
    if (state === 'ready' || state === 'paused') { clearInterval(this.timer); this.timer = null; const bar = this.el('landing-progress'); if (bar) bar.style.width = '100%'; }
  }

  /** Called every frame with what the game knows. */
  update({ ready, started }) {
    if (this.state === 'error') return;
    if (ready !== this.gameReady) { this.gameReady = ready; this.read(); }
    this.setState(ready ? (started ? 'paused' : 'ready') : 'loading');
  }
}

/** The bottom-right corner: the station board behind a quiet button. */
export function setupMultiplayerCorner({ courierMode, openWorld, onOpen = () => {} }) {
  const button = document.getElementById('multiplayer-button'), popover = document.getElementById('multiplayer-popover');
  const close = document.getElementById('multiplayer-close'), note = document.getElementById('multiplayer-courier-note');
  const board = document.getElementById('departures-panel');
  if (!button || !popover) return { open() {}, close() {} };
  if (courierMode) { if (note) note.hidden = false; if (board) board.style.display = 'none'; }
  const set = open => {
    popover.classList.toggle('open', open); button.setAttribute('aria-expanded', String(open));
    if (open) onOpen();
  };
  for (const element of [button, popover]) {
    element.addEventListener('click', event => event.stopPropagation());
    element.addEventListener('keydown', event => { if (event.key === 'Escape') { set(false); button.focus(); } event.stopPropagation(); });
  }
  button.addEventListener('click', () => set(!popover.classList.contains('open')));
  // A click anywhere else while it is open only closes it; it never starts the round underneath.
  document.getElementById('overlay')?.addEventListener('click', event => {
    if (!popover.classList.contains('open') || popover.contains(event.target) || button.contains(event.target)) return;
    event.stopImmediatePropagation(); set(false);
  }, true);
  close?.addEventListener('click', () => { set(false); button.focus(); });
  document.getElementById('multiplayer-open-world')?.addEventListener('click', () => openWorld());
  // A board the world cannot use says so, instead of an empty panel.
  if (!courierMode && board && board.style.display === 'none' && !popover.querySelector('.unavailable')) {
    const text = document.createElement('p'); text.className = 'unavailable';
    text.textContent = 'Multiplayer is not available in this world.';
    board.before(text);
  }
  return { open: () => set(true), close: () => set(false) };
}
