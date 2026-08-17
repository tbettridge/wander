import * as THREE from 'three';
import { TRAILER_CAPTURE_VERSION, TRAILER_SHOTS, validateTrailerPlan } from './trailerplan.mjs';
import { createConversation } from './npcsocial.mjs';

const CAPTURE_ENDPOINT = '/__trailer_capture__/';
const EYE_HEIGHT = 1.7;
const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _localTarget = new THREE.Vector3();

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smooth = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function hiddenTrailerUi(hidden) {
  document.body.classList.toggle('trailer-clean', hidden);
  for (const element of document.querySelectorAll('.lil-gui, #VRButton')) {
    element.style.display = hidden ? 'none' : '';
  }
}

function makePanel() {
  const panel = document.createElement('section');
  panel.id = 'trailer-capture-panel';
  panel.setAttribute('aria-label', 'Trailer capture controls');
  panel.innerHTML = `
    <strong>WANDER TRAILER</strong>
    <span data-trailer-status>Waiting for the world…</span>
    <div>
      <button type="button" data-trailer-record>Record approved trailer</button>
      <button type="button" data-trailer-preview>Preview next shot</button>
    </div>
    <div>
      <select data-trailer-shot aria-label="Trailer shot"></select>
      <button type="button" data-trailer-record-shot>Record selected shot</button>
    </div>
    <progress data-trailer-progress max="1" value="0"></progress>
  `;
  document.body.appendChild(panel);
  return panel;
}

function pointOnGround(world, x, z, height = EYE_HEIGHT) {
  return new THREE.Vector3(x, world.height(x, z) + height, z);
}

function deterministicScenicLocation(world, target) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  let best = null;
  for (let index = 1; index <= 7200; index++) {
    const distance = 300 + Math.sqrt(index / 7200) * 28500;
    const angle = index * golden + world.seed * 0.000017;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const biome = world.biomeAt(x, z);
    const coast = target === 'coast';
    const matches = coast
      ? ['dune', 'shingle', 'rocky', 'chalk'].includes(biome.coastType)
        && biome.h > 1 && biome.h < 22
      : biome.id === target;
    if (!matches || biome.slope > (coast ? 0.24 : 0.2) || world.riverAt(x, z).wet) continue;
    const openness = world.openFactor?.(x, z) ?? 0.5;
    const relief = Math.abs(world.height(x + 70, z) - biome.h)
      + Math.abs(world.height(x, z + 70) - biome.h);
    const score = openness * 2 + relief * 0.018 - biome.slope * 4;
    if (!best || score > best.score) best = { x, z, h: biome.h, score, biome };
  }
  return best;
}

function stationFrame(station) {
  const length = Math.hypot(station?.tangentX || 0, station?.tangentZ || 0) || 1;
  const tx = station.tangentX / length;
  const tz = station.tangentZ / length;
  return { tx, tz, rx: tz, rz: -tx };
}

function sampleEdgeArc(edge, arc, point, tangent) {
  const segments = edge?.segments;
  if (!segments?.count || !segments.arc?.length) return false;
  const clampedArc = THREE.MathUtils.clamp(arc, 0, segments.arcLength);
  let index = segments.count - 1;
  for (let candidate = 0; candidate < segments.count; candidate++) {
    if (clampedArc <= segments.arc[candidate + 1]) {
      index = candidate;
      break;
    }
  }
  const length = Math.max(0.001, segments.len[index]);
  const amount = THREE.MathUtils.clamp(
    (clampedArc - segments.arc[index]) / length, 0, 1,
  );
  point.set(
    segments.ax[index] + segments.dx[index] * amount,
    0,
    segments.az[index] + segments.dz[index] * amount,
  );
  tangent.set(segments.dx[index] / length, 0, segments.dz[index] / length);
  return true;
}

export class TrailerDirector {
  constructor(context) {
    validateTrailerPlan();
    this.context = context;
    // Trailer capture must never inherit the adaptive desktop ramp. Ultra is
    // the authored default, with an explicit per-shot override available for
    // unusually heavy moving-camera takes.
    if (this.context.quality) {
      this.context.quality.locked = true;
      this.context.quality.setLevel(4);
      this.context.quality.apply();
    }
    this.panel = makePanel();
    this.statusElement = this.panel.querySelector('[data-trailer-status]');
    this.progressElement = this.panel.querySelector('[data-trailer-progress]');
    this.recordButton = this.panel.querySelector('[data-trailer-record]');
    this.previewButton = this.panel.querySelector('[data-trailer-preview]');
    this.shotSelect = this.panel.querySelector('[data-trailer-shot]');
    this.recordShotButton = this.panel.querySelector('[data-trailer-record-shot]');
    this.recordButton.addEventListener('click', () => this.recordAll());
    this.previewButton.addEventListener('click', () => this.previewNext());
    this.active = null;
    this.previewIndex = 0;
    this.recording = false;
    this.audioStream = null;
    this.scenic = new Map();
    this.sceneState = {};
    this.shots = TRAILER_SHOTS.map((shot) => ({ ...shot, ...this._shotBehavior(shot) }));
    this.progressElement.max = this.shots.length;
    this.shotSelect.append(...this.shots.map((shot) => {
      const option = document.createElement('option');
      option.value = shot.id;
      option.textContent = shot.id;
      return option;
    }));
    this.recordShotButton.addEventListener('click', () => this.recordSelected());
    window.__wanderTrailer = this;
  }

  status(message) {
    this.statusElement.textContent = message;
  }

  setCaptureQuality(level = 4) {
    if (!this.context.quality) return;
    this.context.quality.locked = true;
    this.context.quality.setLevel(level);
    this.context.quality.apply();
  }

  async beginSession() {
    this.setCaptureQuality(4);
    this.context.beginSession?.();
    this.context.controls.enabled = true;
    this.context.controls.setInputLocked(true);
    hiddenTrailerUi(true);
    await this.context.audio.start();
    this.audioStream = this.context.audio.captureStream?.() || null;
    const start = performance.now();
    while (!this.context.isReady() && performance.now() - start < 45000) {
      this.status('Finishing the nearby world…');
      await wait(250);
    }
    if (!this.context.isReady()) throw new Error('The world did not become ready for capture.');
  }

  async settle(seconds = 2.2) {
    const deadline = performance.now() + Math.max(0, seconds) * 1000;
    while (performance.now() < deadline) await wait(100);
    const streamDeadline = performance.now() + 14000;
    while (performance.now() < streamDeadline) {
      if (this.context.chunkMgr.pendingNearby() === 0
          && this.context.chunkMgr.results.length === 0) break;
      await wait(120);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  setView(eye, target, fov = 60) {
    const controls = this.context.controls;
    controls.rig.position.set(eye.x, eye.y - EYE_HEIGHT, eye.z);
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    controls.yaw = Math.atan2(-dx, -dz);
    controls.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    controls.rig.rotation.y = controls.yaw;
    controls.camera.rotation.set(controls.pitch, 0, 0);
    controls.camera.position.set(0, EYE_HEIGHT, 0);
    if (Math.abs(controls.camera.fov - fov) > 0.01) {
      controls.camera.fov = fov;
      controls.camera.updateProjectionMatrix();
    }
  }

  setWeather(time = 0.5, weather = 'clear') {
    this.context.weather.setForced(weather);
    this.context.sky.time = time;
    this.context.tick?.(time);
  }

  scenicLocation(target) {
    if (!this.scenic.has(target)) {
      this.scenic.set(target, deterministicScenicLocation(this.context.world, target));
    }
    return this.scenic.get(target);
  }

  async placeScenic(target, time, weather) {
    if (this.context.cave.active) this.context.cave.exit();
    if (this.context.railway.riding) this.context.railway.leave(false);
    const location = this.scenicLocation(target);
    if (!location) throw new Error(`No scenic ${target} location was found.`);
    this.context.controls.place(location.x, location.z);
    this.setWeather(time, weather);
    this.sceneState.location = location;
  }

  _shotBehavior(shot) {
    const method = `_${shot.scene.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())}`;
    const behavior = this[method]?.bind(this);
    if (!behavior) throw new Error(`No trailer behavior for ${shot.scene}.`);
    return behavior(shot);
  }

  _mountain() {
    return {
      prepare: async () => {
        if (this.context.cave.active) this.context.cave.exit();
        if (this.context.railway.riding) this.context.railway.leave(false);
        // A seeded 213 m coastal summit. Looking almost due north reveals the
        // descending mountain shoulders, forested slopes, a river mouth in the
        // middle distance and the ocean filling the horizon beyond it.
        const x = -3719.7;
        const z = -887.35;
        const angle = 6.087;
        const dx = Math.sin(angle), dz = Math.cos(angle);
        this.context.controls.place(x, z);
        this.setWeather(0.26, 'scattered');
        if (this.context.post) this.context.post.bloomStrengthOverride = 0.08;
        this.sceneState.mountain = {
          x, z, h: this.context.world.height(x, z), dx, dz,
          sideX: dz, sideZ: -dx,
        };
      },
      sample: (t) => {
        const { x, z, h, dx, dz, sideX, sideZ } = this.sceneState.mountain;
        // Keep the entire take inside the same dawn light window; the normal
        // world clock continues advancing for every other trailer scene.
        this.context.sky.time = 0.26;
        const travel = lerp(-8, 10, smooth(t));
        _eye.set(
          x + sideX * travel - dx * lerp(2, -2, smooth(t)),
          h + lerp(9, 13, smooth(t)),
          z + sideZ * travel - dz * lerp(2, -2, smooth(t)),
        );
        _target.set(x + dx * 2800, 12, z + dz * 2800);
        this.setView(_eye, _target, 55);
      },
      settle: 8,
    };
  }

  _trail() {
    return {
      prepare: async () => {
        this.context.locations.trailhead();
        this.setWeather(0.40, 'clear');
        const p = this.context.controls.rig.position.clone();
        const yaw = this.context.controls.yaw;
        this.sceneState.trail = { p, fx: -Math.sin(yaw), fz: -Math.cos(yaw) };
      },
      sample: (t) => {
        const { p, fx, fz } = this.sceneState.trail;
        const travel = smooth(t) * 22;
        const x = p.x + fx * travel;
        const z = p.z + fz * travel;
        _eye.copy(pointOnGround(this.context.world, x, z, 1.72));
        const tx = x + fx * 12;
        const tz = z + fz * 12;
        _target.set(tx, this.context.world.height(tx, tz) + 1.65, tz);
        this.setView(_eye, _target, 70);
      },
      settle: 2.8,
    };
  }

  _taiga() { return this._environmentBehavior('taiga', 0.46, 'scattered', 1.0); }
  _desert() { return this._environmentBehavior('desert', 0.53, 'clear', 2.1); }
  _jungle() { return this._environmentBehavior('jungle', 0.42, 'scattered', 3.2); }
  _coast() { return this._environmentBehavior('coast', 0.69, 'clear', 4.3); }

  _environmentBehavior(target, time, weather, angle) {
    return {
      prepare: async () => this.placeScenic(target, time, weather),
      sample: (t) => {
        const p = this.sceneState.location;
        const radius = 13;
        _eye.set(p.x + Math.cos(angle + t * 0.09) * radius,
          p.h + 4.8 + t * 1.2, p.z + Math.sin(angle + t * 0.09) * radius);
        _target.set(p.x, p.h + 1.6, p.z);
        this.setView(_eye, _target, 58);
      },
      settle: 3.2,
    };
  }

  _stepping() { return this._crossingBehavior('steppingCrossing'); }
  _log() { return this._crossingBehavior('logCrossing'); }
  _bridge() { return this._crossingBehavior('plankBridge'); }

  _bridgeZoom(shot) {
    return {
      prepare: async () => {
        const result = this.context.locations.plankBridge();
        this.setWeather(0.49, 'clear');
        const crossings = this.context.walkableSurface?.crossingsAt(result.x, result.z) || [];
        let crossing = null;
        for (const candidate of crossings) {
          if (!candidate.walkable) continue;
          const distance = Math.hypot(candidate.x - result.x, candidate.z - result.z);
          if (!crossing || distance < crossing.distance) crossing = { ...candidate, distance };
        }
        const edge = crossing && this.context.walkableSurface.edges.get(crossing.edgeId);
        if (!crossing || !edge) throw new Error('The plank bridge path could not be resolved.');
        const travel = Math.min(
          Math.max(8, shot.travelMeters ?? 28),
          crossing.deckLength * 0.72,
        );
        const centerArc = (crossing.arcStart + crossing.arcEnd) * 0.5;
        this.sceneState.bridgeZoom = {
          edge, surfaceY: crossing.surfaceY,
          startArc: centerArc - travel * 0.5,
          endArc: centerArc + travel * 0.5,
          lookEndArc: crossing.arcEnd - 2,
        };
      },
      sample: (t) => {
        const bridge = this.sceneState.bridgeZoom;
        if (!bridge) return;
        const arc = lerp(bridge.startArc, bridge.endArc, smooth(t));
        const lookArc = Math.min(bridge.lookEndArc, arc + 12);
        if (!sampleEdgeArc(bridge.edge, arc, _eye, _local)
          || !sampleEdgeArc(bridge.edge, lookArc, _target, _localTarget)) return;
        _eye.y = bridge.surfaceY + lerp(1.78, 2.05, smooth(t));
        _target.y = bridge.surfaceY + 1.18;
        this.setView(_eye, _target, 72);
      },
      settle: 5,
    };
  }

  _crossingBehavior(action) {
    return {
      prepare: async () => {
        const result = this.context.locations[action]();
        this.setWeather(0.49, 'clear');
        const p = this.context.controls.rig.position.clone();
        const yaw = this.context.controls.yaw;
        this.sceneState.crossing = { p, fx: -Math.sin(yaw), fz: -Math.cos(yaw), result };
      },
      sample: (t) => {
        const { p, fx, fz } = this.sceneState.crossing;
        const travel = smooth(t) * 6;
        const x = p.x + fx * travel;
        const z = p.z + fz * travel;
        _eye.copy(pointOnGround(this.context.world, x, z, 1.7));
        const tx = x + fx * 8, tz = z + fz * 8;
        _target.set(tx, this.context.world.height(tx, tz) + 1.25, tz);
        this.setView(_eye, _target, 68);
      },
      settle: 2.2,
    };
  }

  _wildlife() {
    return {
      prepare: async () => {
        await this.placeScenic('grassland', 0.46, 'clear');
        const p = this.context.controls.rig.position;
        // Clear ambient families from this isolated wildlife portrait so the
        // frame contains one subject, then hold a single moose in a calm
        // grazing pose far enough away to feel like an observed wild animal.
        Object.assign(this.context.animals.debug, {
          spawnFox: false, spawnMoose: false, spawnDeer: false, spawnHorses: false,
        });
        this.context.animals.resurvey(p);
        const moose = this.context.animals.stagePreview(
          'moose', p.x + 4.8, p.z - 25.5, p.x + 18, p.z - 25.5, 16,
        );
        if (!moose) throw new Error('The grazing moose could not be staged.');
        moose.setState('graze', 18);
        moose.previewTimer = 18;
        this.sceneState.animals = [moose];
        this.sceneState.anchor = p.clone();
      },
      sample: (t) => {
        const p = this.sceneState.anchor;
        const travel = smooth(t) * 1.8;
        _eye.set(p.x - 3.2 + travel, p.y + 2.75, p.z + 1.8);
        const mx = p.x + 4.8;
        const mz = p.z - 25.5;
        _target.set(mx, this.context.world.height(mx, mz) + 1.25, mz);
        this.setView(_eye, _target, 43);
      },
      settle: 1.8,
    };
  }

  async _prepareStation() {
    if (!this.context.regionalRailway.plan || !this.context.railway.schedule) {
      this.context.regionalRailway.generate();
    }
    this.context.regionalRailway.jumpToPlan();
    const station = this.context.railway.stations[0] || this.context.regionalRailway.plan?.stations?.[0];
    if (!station) throw new Error('The regional station was not generated.');
    this.sceneState.station = station;
    this.setWeather(0.48, 'scattered');
    const deadline = performance.now() + 10000;
    let stableFrames = 0;
    while (performance.now() < deadline) {
      if (this.context.livingWorld.actors.some((actor) => actor.avatar?.root)) stableFrames++;
      else stableFrames = 0;
      if (stableFrames >= 5) return;
      await wait(120);
    }
    throw new Error('Station residents did not materialize for the trailer shot.');
  }

  _village() {
    return {
      prepare: async () => this._prepareStation(),
      sample: (t) => {
        const station = this.sceneState.station;
        const frame = stationFrame(station);
        const ground = this.context.world.height(station.x, station.z);
        const travel = smooth(t) * 7;
        _eye.set(station.x - frame.tx * (34 - travel) + frame.rx * 25,
          ground + lerp(13, 9, smooth(t)), station.z - frame.tz * (34 - travel) + frame.rz * 25);
        _target.set(station.x + frame.tx * 3, ground + 3.3, station.z + frame.tz * 3);
        this.setView(_eye, _target, 55);
      },
      settle: 5,
    };
  }

  _villageLife() {
    return {
      prepare: async () => {
        await this._prepareStation();
        this.context.livingWorld.debug.playtestVignette = 'map consultation';
        this.context.livingWorld.debug.loadPlaytestVignette();
        this.sceneState.actor = this.context.livingWorld.activeNpc
          || this.context.livingWorld.actors.find((actor) => actor.avatar?.root);
        if (!this.sceneState.actor) throw new Error('No village resident is available for the shot.');
        await this._waitForActorPresentation(this.sceneState.actor);
      },
      sample: (t) => this._orbitActor(this.sceneState.actor, t, 4.8, 52),
      settle: 1.5,
    };
  }

  _npcJourney() {
    return {
      prepare: async () => {
        await this._prepareStation();
        // The parcel vignette depends on a journey descriptor that is not
        // guaranteed to be populated before its first presentation frame.
        // The consultation vignette has the same purposeful, destination-led
        // body language and is deterministic for capture.
        this.context.livingWorld.debug.playtestVignette = 'map consultation';
        this.context.livingWorld.debug.loadPlaytestVignette();
        this.sceneState.actor = this.context.livingWorld.activeNpc
          || this.context.livingWorld.actors.find((actor) => actor.avatar?.root);
        if (!this.sceneState.actor) throw new Error('No travelling resident is available for the shot.');
        await this._waitForActorPresentation(this.sceneState.actor);
      },
      sample: (t) => this._orbitActor(this.sceneState.actor, t, 5.2, 50),
      settle: 1.5,
    };
  }

  _npcMemory() {
    return {
      prepare: async () => {
        await this._prepareStation();
        this.context.livingWorld.debug.playtestVignette = 'map consultation';
        this.context.livingWorld.debug.loadPlaytestVignette();
        this.sceneState.actor = this.context.livingWorld.activeNpc
          || this.context.livingWorld.actors.find((actor) => actor.avatar?.root);
        if (!this.sceneState.actor) throw new Error('No returning resident is available for the shot.');
        await this._waitForActorPresentation(this.sceneState.actor);
      },
      sample: (t) => this._orbitActor(this.sceneState.actor, t, 3.6, 48),
      settle: 1.2,
    };
  }

  _market() {
    return {
      prepare: async () => {
        await this._prepareStation();
        const station = this.sceneState.station;
        const deadline = performance.now() + 12000;
        let market = null;
        while (performance.now() < deadline) {
          const candidates = [...(this.context.settlements?.active?.values?.() || [])]
            .filter((current) => current.plan?.props?.some((prop) => prop.kind === 'market-stall')
              && current.residents?.length >= 2)
            .sort((a, b) => Math.hypot(a.site.x - station.x, a.site.z - station.z)
              - Math.hypot(b.site.x - station.x, b.site.z - station.z));
          market = candidates[0] || null;
          if (market) break;
          await wait(120);
        }
        if (!market) throw new Error('The station market did not materialize for capture.');

        const stalls = market.plan.props.filter((prop) => prop.kind === 'market-stall');
        const merchant = market.residents.find((resident) => resident.post?.kind === 'merchant')
          || market.residents[0];
        const customer = market.residents.find((resident) => resident !== merchant
          && resident.post?.kind === 'customer') || market.residents.find((resident) => resident !== merchant);
        const stall = merchant.post?.stall || stalls[0];
        if (!stall || !merchant || !customer) throw new Error('The market interaction could not be staged.');

        const forwardX = Math.sin(stall.yaw), forwardZ = Math.cos(stall.yaw);
        const merchantPoint = {
          x: stall.x - forwardX * 1.05,
          y: stall.y,
          z: stall.z - forwardZ * 1.05,
        };
        const customerPoint = {
          x: stall.x + forwardX * 1.62,
          y: stall.y,
          z: stall.z + forwardZ * 1.62,
        };
        const conversation = createConversation(
          merchant.identity.seed ^ customer.identity.seed,
          { id: 'trailer:market', participantIds: [merchant.actorId, customer.actorId] },
        );
        conversation.life = 30;
        conversation.beat = 0;
        conversation.exchangeDone = true;
        conversation.actors = [merchant, customer];
        merchant.conversation = conversation;
        merchant.conversationSide = 0;
        customer.conversation = conversation;
        customer.conversationSide = 1;
        market.conversations = market.conversations.filter((entry) => (
          !entry.actors?.includes(merchant) && !entry.actors?.includes(customer)
        ));
        market.conversations.push(conversation);
        if (merchant.post) merchant.post.dwell = 30;
        if (customer.post) customer.post.dwell = 30;
        this.sceneState.market = {
          market, stall, merchant, customer, merchantPoint, customerPoint,
          forwardX, forwardZ, rightX: Math.cos(stall.yaw), rightZ: -Math.sin(stall.yaw),
        };
        this.setWeather(0.52, 'scattered');
      },
      sample: (t) => {
        const scene = this.sceneState.market;
        if (!scene) return;
        const { stall, merchant, customer, merchantPoint, customerPoint } = scene;
        merchant.root.position.set(merchantPoint.x, merchantPoint.y, merchantPoint.z);
        customer.root.position.set(customerPoint.x, customerPoint.y, customerPoint.z);
        merchant.groundY = merchantPoint.y;
        customer.groundY = customerPoint.y;
        merchant.heading = stall.yaw;
        merchant.root.rotation.y = stall.yaw;
        customer.heading = stall.yaw + Math.PI;
        customer.root.rotation.y = stall.yaw + Math.PI;
        const drift = smooth(t) * 1.5;
        _eye.set(
          stall.x + scene.forwardX * 5.8 + scene.rightX * (3.5 - drift),
          stall.y + 2.45,
          stall.z + scene.forwardZ * 5.8 + scene.rightZ * (3.5 - drift),
        );
        _target.set(stall.x + scene.forwardX * 0.15, stall.y + 1.35,
          stall.z + scene.forwardZ * 0.15);
        this.setView(_eye, _target, 52);
      },
      settle: 3.0,
    };
  }

  _orbitActor(actor, t, radius = 4.2, fov = 52) {
    if (!actor) return;
    const p = this.context.livingWorld.actorPosition(actor);
    const y = actor.groundY ?? this.context.world.height(p.x, p.z);
    const angle = -0.55 + smooth(t) * 0.35;
    _eye.set(p.x + Math.cos(angle) * radius, y + 2.05, p.z + Math.sin(angle) * radius);
    _target.set(p.x, y + 1.35, p.z);
    this.setView(_eye, _target, fov);
  }

  async _waitForActorPresentation(actor, timeout = 6000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const position = this.context.livingWorld.actorPosition(actor);
      const root = actor.avatar?.root;
      if (root?.visible && Math.hypot(root.position.x - position.x, root.position.z - position.z) < 8) return;
      await wait(100);
    }
  }

  _npcTrain() {
    return {
      prepare: async () => {
        await this._prepareStation();
        this.sceneState.railBoarding = this.context.prepareNpcRailBoarding();
      },
      sample: () => {
        const setup = this.sceneState.railBoarding;
        const carriage = this.context.railway.carriages[setup?.carriageIndex || 0];
        if (!setup || !carriage) return;
        carriage.root.updateWorldMatrix(true, false);
        // Stage from the aisle looking out. This keeps the doorway itself as
        // the frame and lets the passenger approach, cross the threshold, and
        // enter toward camera without the platform fascia masking the action.
        _local.set(setup.side * 0.28, 1.83, -0.5);
        _localTarget.set(setup.side * 3.4, 1.52, 0.02);
        _eye.copy(carriage.root.localToWorld(_local));
        _target.copy(carriage.root.localToWorld(_localTarget));
        this.setView(_eye, _target, 62);
      },
      settle: 1.0,
    };
  }

  _playerTrain() {
    return {
      prepare: async () => {
        await this._prepareStation();
        this.context.preparePlayerTrainShot();
        const [first, second] = this.context.railway.carriages;
        if (!first || !second) throw new Error('Both passenger cars are required for the boarding shot.');
        first.root.updateWorldMatrix(true, false);
        second.root.updateWorldMatrix(true, false);
        const trainPoint = (carriage, x, y, z) => carriage.root.localToWorld(
          new THREE.Vector3(x, y, z),
        );
        this.sceneState.trainPath = new THREE.CatmullRomCurve3([
          trainPoint(first, 3.25, 2.35, 0.45),
          trainPoint(first, 1.55, 2.40, 0.34),
          trainPoint(first, 0.18, 2.46, 0.22),
          trainPoint(first, 0.00, 2.48, -2.45),
          trainPoint(first, 0.00, 2.48, -3.50),
          trainPoint(second, 0.00, 2.48, 3.50),
          trainPoint(second, 0.12, 2.48, 2.35),
          trainPoint(second, 0.34, 2.48, 0.85),
        ], false, 'catmullrom', 0.42);
      },
      sample: (t) => {
        const path = this.sceneState.trainPath;
        if (!path) return;
        const progress = smooth(t) * 0.94;
        path.getPoint(progress, _eye);
        path.getTangent(progress, _target).multiplyScalar(6).add(_eye);
        _target.y -= 0.12;
        this.setView(_eye, _target, 68);
      },
      settle: 1.0,
    };
  }

  _caveExit() {
    return {
      prepare: async () => {
        if (this.context.railway.riding) this.context.railway.leave(false);
        const review = this.context.cave.reviewEntranceLighting();
        if (!review) throw new Error('The cave entrance could not be prepared for capture.');
        this.context.lantern.setEnabled(false);
        this.setWeather(0.32, 'clear');
        const cave = this.context.cave;
        const mouth = cave.graph?.entrance?.mouth;
        if (!mouth) throw new Error('The cave entrance has no authored mouth.');
        const referenceFloor = cave.entranceFloorLocal;
        const pathPoint = (depth, lateral = 0) => {
          const localX = mouth[0] + lateral;
          const localZ = mouth[2] + depth;
          const xz = cave.localToWorldXZ(localX, localZ);
          let floor;
          if (depth >= -0.5) {
            floor = cave.field.floorHeightNear(
              localX, localZ, referenceFloor, 3.5, 3.5,
            );
            if (floor != null) floor += cave.origin.y;
          }
          if (floor == null) {
            floor = cave.terrain?.renderedHeightAt?.(xz.x, xz.z)
              ?? this.context.world.height(xz.x, xz.z);
          }
          return new THREE.Vector3(xz.x, floor + EYE_HEIGHT, xz.z);
        };
        this.sceneState.caveExitPath = new THREE.CatmullRomCurve3([
          pathPoint(7.8, 0.08),
          pathPoint(4.6, -0.10),
          pathPoint(2.4, 0.06),
          pathPoint(0.45, 0),
          pathPoint(-2.8, -0.08),
          pathPoint(-6.8, 0.10),
          pathPoint(-11.8, 0),
          pathPoint(-16.5, -0.12),
        ], false, 'catmullrom', 0.42);
      },
      sample: (t) => {
        const path = this.sceneState.caveExitPath;
        if (!path) return;
        const progress = smooth(t) * 0.98;
        path.getPointAt(progress, _eye);
        path.getTangentAt(progress, _target).multiplyScalar(6.5).add(_eye);
        _target.y -= 0.08;
        this.setView(_eye, _target, 64);
      },
      settle: 8,
    };
  }

  _greatTree() {
    return {
      prepare: async () => {
        if (this.context.cave.active) this.context.cave.exit();
        this.context.locations.greatTree();
        this.setWeather(0.70, 'scattered');
        this.sceneState.anchor = this.context.controls.rig.position.clone();
      },
      sample: (t) => {
        const p = this.sceneState.anchor;
        const angle = 0.65 + smooth(t) * 0.16;
        _eye.set(p.x + Math.cos(angle) * 7, p.y + lerp(2.6, 5.2, smooth(t)), p.z + Math.sin(angle) * 7);
        _target.set(p.x - 22, p.y + 16, p.z - 22);
        this.setView(_eye, _target, 55);
      },
      settle: 4,
    };
  }

  update() {
    if (!this.active) return;
    const elapsed = (performance.now() - this.active.startedAt) / 1000;
    const t = clamp01(elapsed / this.active.shot.duration);
    this.active.shot.sample(t);
    if (t >= 1) {
      const resolve = this.active.resolve;
      this.active = null;
      resolve();
    }
  }

  async playShot(shot) {
    this.status(`Preparing ${shot.id}…`);
    this.setCaptureQuality(shot.qualityLevel ?? 4);
    if (this.context.post) this.context.post.bloomStrengthOverride = null;
    await shot.prepare();
    shot.sample(0);
    await this.settle(shot.settle ?? 2);
    return new Promise((resolve) => {
      this.active = { shot, resolve, startedAt: performance.now() };
    });
  }

  makeRecorder() {
    const video = this.context.renderer.domElement.captureStream(60);
    const stream = new MediaStream(video.getVideoTracks());
    for (const track of this.audioStream?.getAudioTracks?.() || []) stream.addTrack(track);
    const mimeTypes = [
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
    ];
    const mimeType = mimeTypes.find((value) => MediaRecorder.isTypeSupported(value)) || '';
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 22_000_000,
      audioBitsPerSecond: 192_000,
    });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    return { recorder, chunks, stream, mimeType: mimeType || 'video/webm' };
  }

  async recordShot(shot) {
    this.status(`Preparing ${shot.id}…`);
    this.setCaptureQuality(shot.qualityLevel ?? 4);
    if (this.context.post) this.context.post.bloomStrengthOverride = null;
    await shot.prepare();
    shot.sample(0);
    await this.settle(shot.settle ?? 2);
    const capture = this.makeRecorder();
    const stopped = new Promise((resolve) => capture.recorder.addEventListener('stop', resolve, { once: true }));
    capture.recorder.start(250);
    await new Promise((resolve) => {
      this.active = { shot, resolve, startedAt: performance.now() };
    });
    capture.recorder.stop();
    await stopped;
    for (const track of capture.stream.getVideoTracks()) track.stop();
    const blob = new Blob(capture.chunks, { type: capture.mimeType });
    this.status(`Saving ${shot.id}…`);
    const response = await fetch(`${CAPTURE_ENDPOINT}${shot.id}.webm`, {
      method: 'POST', headers: { 'Content-Type': capture.mimeType }, body: blob,
    });
    if (!response.ok) throw new Error(`Capture upload failed for ${shot.id}: ${response.status}`);
    return response.json();
  }

  async recordAll() {
    if (this.recording) return;
    this.recording = true;
    this.recordButton.disabled = true;
    this.previewButton.disabled = true;
    this.recordShotButton.disabled = true;
    try {
      await this.beginSession();
      const manifest = {
        version: TRAILER_CAPTURE_VERSION,
        capturedAt: new Date().toISOString(),
        viewport: { width: this.context.renderer.domElement.width, height: this.context.renderer.domElement.height },
        shots: [],
      };
      for (let index = 0; index < this.shots.length; index++) {
        const shot = this.shots[index];
        const result = await this.recordShot(shot);
        manifest.shots.push({ id: shot.id, duration: shot.duration, ...result });
        this.progressElement.value = index + 1;
      }
      const manifestResponse = await fetch(`${CAPTURE_ENDPOINT}capture_manifest.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest, null, 2),
      });
      if (!manifestResponse.ok) throw new Error(`Manifest upload failed: ${manifestResponse.status}`);
      this.status(`All ${this.shots.length} shots recorded. Ready to edit.`);
      window.dispatchEvent(new CustomEvent('wander-trailer-captured', { detail: manifest }));
    } catch (error) {
      console.error('[trailer]', error);
      this.status(`Capture stopped: ${error.message}`);
    } finally {
      this.recording = false;
      this.recordButton.disabled = false;
      this.previewButton.disabled = false;
      this.recordShotButton.disabled = false;
      this.context.controls.setInputLocked(false);
      hiddenTrailerUi(false);
      this.panel.style.display = '';
    }
  }

  async recordSelected() {
    if (this.recording) return;
    const shot = this.shots.find((candidate) => candidate.id === this.shotSelect.value);
    if (!shot) return;
    this.recording = true;
    this.recordButton.disabled = true;
    this.previewButton.disabled = true;
    this.recordShotButton.disabled = true;
    try {
      await this.beginSession();
      await this.recordShot(shot);
      this.status(`${shot.id} retake recorded.`);
    } catch (error) {
      console.error('[trailer]', error);
      this.status(`Retake stopped: ${error.message}`);
    } finally {
      this.recording = false;
      this.recordButton.disabled = false;
      this.previewButton.disabled = false;
      this.recordShotButton.disabled = false;
      this.context.controls.setInputLocked(false);
      hiddenTrailerUi(false);
      this.panel.style.display = '';
    }
  }

  async previewNext() {
    if (this.recording) return;
    await this.beginSession();
    this.panel.style.display = '';
    const shot = this.shots[this.previewIndex % this.shots.length];
    this.previewIndex++;
    this.status(`Previewing ${shot.id}…`);
    await this.playShot(shot);
    this.status(`${shot.id} preview complete.`);
    this.context.controls.setInputLocked(false);
    hiddenTrailerUi(false);
    this.panel.style.display = '';
  }

  get suppressPlayerTrainInteraction() {
    return this.active?.shot?.id === '11_player_train';
  }
}
