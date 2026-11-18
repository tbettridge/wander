// Injected into the page before Wander loads (scripts/playbot-courier.mjs).
// It never decides what to do; it only gives the bot hands and eyes inside
// the page: a switch that skips GPU drawing between screenshots, an optional
// faster clock, and a per-frame steering helper that walks or rides toward
// waypoints by holding the same keys a player holds.
(() => {
  const config = window.__PLAYBOT_CONFIG__ || {};
  const speed = Math.max(1, Number(config.speed) || 1);

  // Software WebGL spends seconds per frame drawing; the game itself never
  // reads pixels back, so the bot draws only when it takes a screenshot.
  window.__playbotDraw = !!config.draw;
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'blitFramebuffer']) {
      const original = C?.prototype?.[name];
      if (!original) continue;
      C.prototype[name] = function (...args) { if (window.__playbotDraw === false) return undefined; return original.apply(this, args); };
    }
  }

  // An optional faster clock. Frame time is capped by the game at 0.1 s, so a
  // modest multiple only takes bigger steps; workers and timers keep real time.
  const realNow = performance.now.bind(performance), origin = realNow();
  const scaled = t => origin + (t - origin) * speed;
  if (speed !== 1) performance.now = () => scaled(realNow());
  const raf = window.requestAnimationFrame.bind(window);
  const frames = { count: 0, busyMs: 0 };
  window.requestAnimationFrame = callback => raf(t => {
    const started = realNow();
    advanceGameClock();
    try { hookTalk(); agent.tick(); } catch (error) { agent.error = String(error?.stack || error); }
    try { callback(speed !== 1 ? scaled(t) : t); } finally { frames.count++; frames.busyMs += realNow() - started; }
  });

  // The steering keeps time in game seconds, not wall seconds: the game caps a frame at 0.1 s, so on a
  // slow machine the courier covers less ground per real second, and a wall-clock stall check would fire
  // while the courier is walking along perfectly well.
  let gameMs = 0, lastFrame = null;
  const gameNow = () => gameMs;
  const advanceGameClock = () => { const r = realNow(); if (lastFrame != null) gameMs += Math.min((r - lastFrame) * speed, 100); lastFrame = r; };
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'];

  // Eyes on talking: what the game saw on the frames that read a T press, and when conversations opened
  // or were dropped, so a cannot-talk finding can say why. Hooked lazily, once the game has built its
  // population, and only once per population however many times the agent is injected.
  const talkLog = [];
  const logTalk = entry => { talkLog.push({ at: Math.round(gameNow()), ...entry }); if (talkLog.length > 40) talkLog.shift(); };
  const hookTalk = () => {
    const lw = window.__wander?.livingWorld;
    if (!lw || lw.__playbotTalkHook) return;
    lw.__playbotTalkHook = true;
    const update = lw.updateTalkPartner.bind(lw), begin = lw.beginDialogue.bind(lw), abandon = lw.abandonDialogue.bind(lw);
    lw.updateTalkPartner = (nearest, player, options = {}) => {
      const pressed = lw.talkQueued;
      const result = update(nearest, player, options);
      if (pressed) {
        const a = lw.activeNpc, root = a?.avatar?.root;
        logTalk({ kind: 'T read', partner: a?.identity?.id || null, distance: a ? Math.round(a.distance * 10) / 10 : null,
          dy: root ? Math.round((root.position.y - player.y) * 10) / 10 : null, active: options.active !== false,
          opened: lw.dialogueOpen, prompt: lw.promptEl?.style.display || null });
      }
      return result;
    };
    lw.beginDialogue = context => { logTalk({ kind: 'open', partner: lw.activeNpc?.identity?.id || null, context: !!context }); return begin(context); };
    lw.abandonDialogue = (options = {}) => { logTalk({ kind: 'dropped', partner: lw.conversationNpcId || lw.activeNpc?.identity?.id || null, reason: options.reason || 'closed' }); return abandon(options); };
    window.addEventListener('keydown', event => {
      if (event.code !== 'KeyT') return;
      const target = event.target;
      logTalk({ kind: 'T key', target: target?.tagName || null, controls: !!window.__wander.controls.enabled, open: !!lw.dialogueOpen,
        panel: !!window.__wander.courier?.ui?.isOpen, partner: lw.activeNpc?.identity?.id || null });
    }, true);
  };

  const agent = window.__playbot = {
    frames,
    talkLog,
    nav: null,
    error: null,
    /** Start moving along waypoints [{x,z}], arriving within `arrive` metres of the last. */
    go(waypoints, { arrive = 2, sprint = false, label = '', follow = null } = {}) {
      this.stop();
      const p = window.__wander.controls.rig.position;
      this.nav = { waypoints: waypoints.map(w => ({ x: w.x, z: w.z, tight: !!w.tight })), i: 0, arrive, sprint, label, follow,
        state: 'moving', startedAt: gameNow(), walked: 0, last: { x: p.x, z: p.z }, check: { at: gameNow(), x: p.x, z: p.z, d: Infinity },
        recover: 0, recoveries: 0, skipped: 0, events: [] };
      return true;
    },
    /**
     * A short way round walls, over a half-metre grid, using the game's own
     * structure collision (the walls and doors the courier's body is held by).
     * Returns waypoints from `from` to `to`, or null when there is none within
     * `margin` metres of the straight line's box.
     */
    /**
     * If the courier stands inside a house, the way out through its front (or back) door:
     * a point just inside the door, the doorway, and a point 2.5 m out. Null outdoors.
     * `to` keeps the courier indoors when the target is in the same house.
     */
    wayOut(to) {
      const w = window.__wander, here = w?.controls?.rig?.position;
      if (!here) return null;
      const local = (b, x, z) => { const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0); return { x: dx * c - dz * s, z: dx * s + dz * c }; };
      const world = (b, lx, lz) => { const c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0); return { x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c }; };
      const inside = (b, x, z) => { const p = local(b, x, z); return Math.abs(p.x) < b.width / 2 && Math.abs(p.z) < b.depth / 2; };
      const house = [...((w.settlements || w.settlementSystem)?.active?.values?.() || [])].flatMap(current => current.plan?.buildings || [])
        .find(b => Number.isFinite(b.y) && here.y > b.y - 0.5 && here.y < b.y + 2 && inside(b, here.x, here.z));
      if (!house || (to && inside(house, to.x, to.z))) return null;
      const doors = (house.portals || []).filter(p => p.kind === 'exterior-door' || p.kind === 'back-door');
      if (!doors.length) return null;
      const ways = doors.map(door => {
        const z = door.kind === 'back-door' ? -house.depth / 2 : house.depth / 2, out = Math.sign(z);
        return [{ ...world(house, door.x, z - out * 1.2), tight: true }, { ...world(house, door.x, z), tight: true }, { ...world(house, door.x, z + out * 2.5), tight: true }];
      });
      const score = way => Math.hypot(way[0].x - here.x, way[0].z - here.z) + (to ? Math.hypot(to.x - way[2].x, to.z - way[2].z) : 0);
      ways.sort((a, b) => score(a) - score(b));
      return { building: house.id, points: ways[0] };
    },
    /** The ground floor under (x, z) if it is inside a house, else null: a hop indoors lands downstairs, not on the roof or the landing. */
    groundFloor(x, z) {
      const w = window.__wander;
      for (const b of [...((w?.settlements || w?.settlementSystem)?.active?.values?.() || [])].flatMap(current => current.plan?.buildings || [])) {
        const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0);
        if (Number.isFinite(b.y) && Math.abs(dx * c - dz * s) < b.width / 2 && Math.abs(dx * s + dz * c) < b.depth / 2) return b.y;
      }
      return null;
    },
    planLocal(from, to, options) {
      // Front and back doors swing open by themselves when the courier comes within a couple of metres.
      // The plan opens only the doors of a house it starts or ends in; every other house stays shut, so
      // a way across a village never cuts through somebody's kitchen.
      const w = window.__wander, collision = w?.structureCollision;
      if (!collision) return null;
      const open = new Set();
      for (const b of [...((w.settlements || w.settlementSystem)?.active?.values?.() || [])].flatMap(current => current.plan?.buildings || [])) {
        const within = p => { const dx = p.x - b.x, dz = p.z - b.z, c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0);
          return Math.abs(dx * c - dz * s) < b.width / 2 + 0.5 && Math.abs(dx * s + dz * c) < b.depth / 2 + 0.5; };
        if (within(from) || within(to)) for (const portal of b.portals || []) open.add(portal.id);
      }
      if (!open.size) return this.planThrough(from, to, options);
      const real = collision.getState;
      collision.getState = () => {
        const state = real.call(collision);
        if (!state) return state;
        const portals = new Proxy(state.portals || {}, { get: (target, id) => open.has(id) ? { progress: 1 } : target[id] });
        return { ...state, portals };
      };
      try { return this.planThrough(from, to, options); } finally { collision.getState = real; }
    },
    planThrough(from, to, { cell = 0.5, margin = 25, radius = 0.38, standing = 0.36, maxCells = 160000, retry = true, nudge = false, near = 0 } = {}) {
      const w = window.__wander, collision = w?.structureCollision;
      const minX = Math.min(from.x, to.x) - margin, minZ = Math.min(from.z, to.z) - margin;
      const nx = Math.ceil((Math.max(from.x, to.x) + margin - minX) / cell), nz = Math.ceil((Math.max(from.z, to.z) + margin - minZ) / cell);
      if (nx * nz > maxCells) return null;
      // Walls are tested at the height of the feet, as the courier's own movement tests them; the ground
      // is read once per 4 m block (the world's height, with the courier's own height where it stands).
      const heights = new Map(), floors = new Map(), here = w.controls.rig.position;
      // Houses stand on raised floors, often well above the slope around them. Inside a footprint the feet
      // are at the floor, or the walls (which start at the floor) would be missed.
      const maxX = minX + nx * cell, maxZ = minZ + nz * cell;
      const buildings = [...((w.settlements || w.settlementSystem)?.active?.values?.() || [])]
        .flatMap(current => current.plan?.buildings || [])
        .filter(b => Number.isFinite(b.y) && b.x + 30 > minX && b.x - 30 < maxX && b.z + 30 > minZ && b.z - 30 < maxZ);
      const floorAt = (x, z) => {
        const key = Math.floor(x) + ',' + Math.floor(z);
        if (!floors.has(key)) {
          let y = null;
          for (const b of buildings) {
            const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0);
            if (Math.abs(dx * c - dz * s) <= b.width / 2 + 0.6 && Math.abs(dx * s + dz * c) <= b.depth / 2 + 0.6) y = Math.max(y ?? -Infinity, b.y);
          }
          floors.set(key, y);
        }
        return floors.get(key);
      };
      const feet = (x, z) => {
        if (Math.hypot(x - here.x, z - here.z) < 2) return here.y + 0.05;
        const floor = floorAt(x, z);
        if (floor != null) return floor + 0.05;
        const key = Math.floor(x / 4) + ',' + Math.floor(z / 4);
        if (!heights.has(key)) heights.set(key, (w.world.biomeAt(Math.floor(x / 4) * 4 + 2, Math.floor(z / 4) * 4 + 2)?.h ?? here.y) + 0.05);
        return heights.get(key);
      };
      const blocked = new Int8Array(nx * nz).fill(-1);
      const sx = (from.x - minX) / cell, sz = (from.z - minZ) / cell;
      const free = i => {
        // Where the courier already stands counts as open, so a body pressed against a wall can still step away from it.
        if (Math.hypot(i % nx + 0.5 - sx, Math.floor(i / nx) + 0.5 - sz) * cell < standing) return true;
        if (blocked[i] < 0) { const x = minX + (i % nx + 0.5) * cell, z = minZ + (Math.floor(i / nx) + 0.5) * cell; const y = feet(x, z); blocked[i] = (collision.collides(x, z, y, radius) || collision.collides(x, z, y + 0.9, radius)) ? 1 : 0; }
        return blocked[i] === 0;
      };
      const index = p => Math.max(0, Math.min(nz - 1, Math.floor((p.z - minZ) / cell))) * nx + Math.max(0, Math.min(nx - 1, Math.floor((p.x - minX) / cell)));
      const start = index(from);
      let goal = index(to);
      // A stopping point that happens to fall in a wall moves to the nearest open ground (never the final goal: that is a person or a board).
      if (nudge && !free(goal)) {
        const gx0 = goal % nx, gz0 = Math.floor(goal / nx);
        search: for (let r = 1; r < 24; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ax = gx0 + dx, az = gz0 + dz; if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
          if (free(az * nx + ax)) { goal = az * nx + ax; to = { x: minX + (ax + 0.5) * cell, z: minZ + (az + 0.5) * cell }; break search; }
        }
      }
      const g = new Float32Array(nx * nz).fill(Infinity), came = new Int32Array(nx * nz).fill(-1), closed = new Uint8Array(nx * nz);
      // A small binary heap keyed on f = g + h.
      const heap = [], push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top[1]; };
      // With `near`, any open cell that close to the goal will do: a person standing at a counter or in a
      // doorway is reached from wherever there is room beside them, not from inside the counter.
      const gx = goal % nx, gz = Math.floor(goal / nx), reach = near / cell;
      const h = i => Math.max(0, Math.hypot(i % nx - gx, Math.floor(i / nx) - gz) - reach);
      g[start] = 0; push(start, h(start));
      const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
      let found = null, expanded = 0;
      while (heap.length && expanded < 120000) {
        const i = pop(); if (closed[i]) continue; closed[i] = 1; expanded++;
        if (i === goal || (reach > 0 && h(i) === 0 && free(i))) { found = i; break; }
        const x = i % nx, z = Math.floor(i / nx);
        for (const [dx, dz, cost] of steps) {
          const ax = x + dx, az = z + dz; if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
          const j = az * nx + ax; if (closed[j] || (!free(j) && j !== goal)) continue;
          if (dx && dz && (!free(z * nx + ax) || !free(az * nx + x))) continue; // no squeezing past a corner
          const next = g[i] + cost; if (next < g[j]) { g[j] = next; came[j] = i; push(j, next + h(j)); }
        }
      }
      // Pressed into a corner: try once more with a slimmer body, as a player would edge out sideways.
      if (found == null) return retry ? this.planThrough(from, to, { cell: 0.25, margin: Math.min(margin, 12), radius: 0.22, standing: 0.3, maxCells, retry: false, nudge, near }) : null;
      const cells = []; for (let i = found; i >= 0; i = came[i]) cells.push(i); cells.reverse();
      if (found !== goal) to = { x: minX + (found % nx + 0.5) * cell, z: minZ + (Math.floor(found / nx) + 0.5) * cell };
      // Keep only the corners, so the steering walks straight lines between them.
      const point = i => ({ x: minX + (i % nx + 0.5) * cell, z: minZ + (Math.floor(i / nx) + 0.5) * cell });
      const out = [];
      for (let k = 1; k < cells.length - 1; k++) {
        const a = cells[k - 1], b = cells[k], c = cells[k + 1];
        if ((b - a) !== (c - b)) out.push({ ...point(b), tight: true });
      }
      out.push({ x: to.x, z: to.z });
      return out;
    },
    stop(state = 'stopped') {
      const keys = window.__wander?.controls?.keys;
      if (keys) for (const key of KEYS) keys.delete(key);
      if (this.nav && this.nav.state === 'moving') this.nav.state = state;
    },
    status() {
      const n = this.nav, w = window.__wander, p = w?.controls.rig.position;
      if (!n) return null;
      const target = n.waypoints[Math.min(n.i, n.waypoints.length - 1)], end = n.waypoints[n.waypoints.length - 1];
      return { state: n.state, i: n.i, of: n.waypoints.length, walked: Math.round(n.walked), recoveries: n.recoveries, skipped: n.skipped,
        toTarget: target && p ? Math.round(dist(p, target) * 10) / 10 : null, toEnd: end && p ? Math.round(dist(p, end)) : null, events: n.events.slice(-6),
        position: p && { x: p.x, z: p.z }, label: n.label };
    },
    tick() {
      const n = this.nav, w = window.__wander;
      if (!n || n.state !== 'moving' || !w?.controls) return;
      const controls = w.controls, keys = controls.keys, p = controls.rig.position, now = gameNow();
      const riding = !!w.horseRiding?.riding;
      n.walked += dist(p, n.last); n.last = { x: p.x, z: p.z };
      // A follower re-aims the last waypoint at a moving resident each frame.
      if (n.follow) {
        const actor = w.livingWorld.actorById(n.follow), at = actor?.avatar?.root?.position;
        if (at) n.waypoints[n.waypoints.length - 1] = { x: at.x, z: at.z };
        // The game already offers T for them (nearest person within 6.5 m): a player stops and talks.
        // Pressing on to their exact spot walked into whatever they stood by, such as the well's rim.
        const offered = w.livingWorld.activeNpc;
        if (offered?.identity?.id === n.follow && offered.distance < 5) {
          for (const key of KEYS) keys.delete(key); n.state = 'arrived'; return;
        }
      }
      // Something on screen needs the courier: stand still until it is answered.
      if (w.courier?.ui?.isOpen || w.livingWorld?.dialogueOpen || w.regionalRailwayService?.riding) {
        for (const key of KEYS) keys.delete(key); n.check.at = now; return;
      }
      let target = n.waypoints[n.i];
      // A corner round a wall must be reached, not cut; a point along a trail only passed near.
      while (target && n.i < n.waypoints.length - 1 && dist(p, target) < (target.tight ? 0.7 : riding ? 7 : 3.5)) target = n.waypoints[++n.i];
      if (!target || (n.i === n.waypoints.length - 1 && dist(p, target) <= n.arrive)) {
        for (const key of KEYS) keys.delete(key); n.state = 'arrived'; return;
      }
      // Look ahead: aim at the farthest of the next few points still close by, so bends are cut gently.
      const want = Math.atan2(target.x - p.x, target.z - p.z);
      if (riding) {
        const horse = w.horseRiding.mount, diff = wrap(want - horse.heading);
        keys.add('KeyW');
        if (diff > 0.12) { keys.add('KeyA'); keys.delete('KeyD'); }
        else if (diff < -0.12) { keys.add('KeyD'); keys.delete('KeyA'); }
        else { keys.delete('KeyA'); keys.delete('KeyD'); }
        if (n.sprint && Math.abs(diff) < 0.5 && dist(p, target) > 25) keys.add('ShiftLeft'); else keys.delete('ShiftLeft');
      } else if (n.recover > now) {
        // Recovering: keep the step chosen when the stall was noticed.
      } else {
        keys.delete('KeyS');
        controls.yaw = want + Math.PI; // the rig looks down -z: yaw π faces +z
        keys.delete('KeyA'); keys.delete('KeyD');
        keys.add('KeyW');
        if (n.sprint && dist(p, target) > 12) keys.add('ShiftLeft'); else keys.delete('ShiftLeft');
      }
      // Progress check every 4 game seconds; a stall tries a hop and a sidestep, twice, then gives up on that waypoint.
      if (now - n.check.at > 4000) {
        const moved = Math.hypot(p.x - n.check.x, p.z - n.check.z), closer = n.check.d - dist(p, target), advanced = n.i !== n.check.i;
        n.check = { at: now, x: p.x, z: p.z, d: dist(p, target), i: n.i };
        // Passing waypoints is progress, even when the next one is no nearer than the last was (a spiral stair).
        if (moved < 1.2 || (!advanced && Number.isFinite(closer) && closer < 0.6 && moved < 6)) {
          n.recoveries++;
          n.events.push({ at: Math.round((now - n.startedAt) / 1000), kind: 'stalled', x: Math.round(p.x), z: Math.round(p.z), waypoint: n.i, moved: Math.round(moved * 10) / 10 });
          const attempt = n.recoveries % 4;
          if (attempt === 3 && n.i < n.waypoints.length - 1) { n.i++; n.skipped++; return; }
          if (n.recoveries >= 9) { for (const key of KEYS) keys.delete(key); n.state = 'stuck'; return; }
          if (!riding) {
            // Back off a step, then try to the side and over: a corner that caught the body lets go when it steps back.
            keys.delete('KeyW');
            if (attempt === 1) keys.add('KeyS');
            else { controls.requestJump?.(); keys.add(attempt % 2 ? 'KeyD' : 'KeyA'); }
            n.recover = now + 1200;
          }
        }
      }
    },
  };
})();
