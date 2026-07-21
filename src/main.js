import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { World, WATER_LEVEL } from './world.js';
import { ChunkManager, CHUNK_SIZE } from './terrain.js';
import { FarTerrain } from './farterrain.js';
import { createImpostorSystem } from './impostors.js';
import { LandmarkManager } from './landmarkmesh.js';
import { LighthouseFx } from './lighthousefx.js';
import { nearestMajorLandmark, landmarkForCell, LM_CELL } from './landmarks.js';
import { createVegetationLibrary, updateGrassTime } from './vegetation.js';
import { SkySystem } from './sky.js';
import { WeatherSystem } from './weather.js';
import { WaterSystem } from './water.js';
import { GrassField } from './grassfield.js';
import { Butterflies } from './butterflies.js';
import { Fireflies } from './fireflies.js';
import { Birds } from './birds.js';
import { AnimalSystem } from './animals.js';
import { RainSystem } from './rain.js';
import { updateWaterCommon } from './watercommon.js';
import { updateWaterfall } from './waterfall.js';
import { updateAtmosphere } from './atmosphere.js';
import { updateWind, windUniforms } from './wind.js';
import { PlayerControls } from './controls.js';
import { Soundscape } from './audio.js';
import { QualityManager } from './quality.js';
import { createPostFX } from './post.js';
import { setupDebugGUI } from './debug.js';
import { CaveExperiment } from './cave.js';
import { trailsAround, nearestTrailPoint } from './trails.js';
import { clamp, smoothstep } from './noise.js';

// --- renderer / scene -------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
// Tone mapping is done in the post-processing grade pass (linear-HDR pipeline),
// so the renderer itself does NOT tone map. The XR path has no post pipeline,
// so ACES is switched back on while a VR session is active (see below).
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
// The composer performs several renderer.render() calls per visual frame.
// Accumulate their counters until the next animation frame so the debug panel
// reports the real scene + post cost rather than only the final fullscreen pass.
renderer.info.autoReset = false;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
// Far plane kept just past the sky dome (scale 10000) — tightening it from
// 20000 nearly halves the depth-buffer range, which is what starves the distant
// ocean/coast edge of precision and makes it z-fight at grazing angles from the
// peaks.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 11000);

// --- world systems -----------------------------------------------------------

const world = new World(20260612);
const library = createVegetationLibrary(7);
const chunkMgr = new ChunkManager(scene, world, library);
const impostors = createImpostorSystem(renderer, library);
chunkMgr.impostors = impostors;
const farTerrain = new FarTerrain(scene, world);
const landmarks = new LandmarkManager(scene, world);
const lighthouseFx = new LighthouseFx(scene);
const sky = new SkySystem(scene, renderer, world.seed);
const weather = new WeatherSystem(world.seed);
const controls = new PlayerControls(renderer, camera, world, renderer.domElement);
scene.add(controls.rig);
const audio = new Soundscape();

// ocean / lake surface — shader-driven plane that follows the player
const water = new WaterSystem(scene, world);
const grassField = new GrassField(scene, world);
const rain = new RainSystem(scene);
const butterflies = new Butterflies(scene, world);
const fireflies = new Fireflies(scene, world);
const birds = new Birds(scene, world);
const animals = new AnimalSystem(scene, world);
const cave = new CaveExperiment(scene, world, controls, { terrain: chunkMgr, library });

// --- quality ------------------------------------------------------------------

const post = createPostFX(renderer, scene, camera);

const quality = new QualityManager(renderer, (tier) => {
  post.setSize(window.innerWidth, window.innerHeight); // resync composer to the tier's pixel ratio
  post.setQuality(tier);
  grassField.setQuality(tier);
  animals.setQuality(tier);
  rain.setQuality(tier);
  chunkMgr.viewRadius = tier.viewRadius;
  chunkMgr.treeRadius = tier.treeRadius;
  chunkMgr.impostorRadius = tier.impostorRadius;
  chunkMgr.grassRadius = tier.grassRadius;
  chunkMgr.clutterRadius = tier.clutterRadius;
  chunkMgr.clutterDensityScale = tier.clutterDensityScale;
  chunkMgr.nearRes = tier.nearRes;
  chunkMgr.grassPerChunk = tier.grassPerChunk;
  chunkMgr.treeDensityScale = tier.treeDensityScale;
  chunkMgr.shadows = tier.shadowSize > 0;
  sky.setViewDistance(tier.viewRadius * CHUNK_SIZE * 0.95);
  farTerrain.setNearField(tier.viewRadius * CHUNK_SIZE);
  water.setNearField(tier.viewRadius * CHUNK_SIZE);
  sky.sun.castShadow = tier.shadowSize > 0;
  if (tier.shadowSize > 0 && sky.sun.shadow.mapSize.x !== tier.shadowSize) {
    sky.sun.shadow.mapSize.set(tier.shadowSize, tier.shadowSize);
    if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
    sky.sun.shadow.needsUpdate = true;   // rebuild the (throttled) map promptly
  }
}, QualityManager.guessInitialLevel());

// The sun's shadow map is re-rendered only a few times a second, not every
// frame. The sun creeps ~a millimetre per frame, so stale-by-a-few-frames
// shadows are invisible on the terrain, but skipping the per-frame re-render
// removes the shadow-map rasterization noise that made grass blades flicker —
// and it renders the costly 4096² depth map far less often.
sky.sun.shadow.autoUpdate = false;
sky.sun.shadow.needsUpdate = true;

const nearbyTrailEdges = [];
const nearestTrail = {};
function jumpToNearestTrail() {
  const p = controls.rig.position;
  trailsAround(world, p.x, p.z, world.seed, 5000, nearbyTrailEdges);
  nearestTrailPoint(nearbyTrailEdges, p.x, p.z, nearestTrail);
  if (!nearestTrail.edgeId) return null;
  controls.place(nearestTrail.x, nearestTrail.z);
  controls.yaw = Math.atan2(-nearestTrail.tangentX, -nearestTrail.tangentZ);
  return { ...nearestTrail };
}

// Stand the player at the landmark end of the nearest cave spur, facing the
// mouth, so the desire line to the cave is right in front of them. Confirms
// trails now lead to caves and gives a quick way to walk one in.
const caveTrailEdges = [];
function jumpToNearestCaveTrail() {
  const p = controls.rig.position;
  trailsAround(world, p.x, p.z, world.seed, 9000, caveTrailEdges);
  let best = null, bd = Infinity;
  for (const edge of caveTrailEdges) {
    if (!edge.toCave) continue;
    const d = (edge.toCave.x - p.x) ** 2 + (edge.toCave.z - p.z) ** 2;
    if (d < bd) { bd = d; best = edge; }
  }
  if (!best) {
    locationActions.current = 'no cave trail within ~9 km';
    return null;
  }
  // Approach from the landmark end (opposite the mouth) so the whole spur reads.
  const startX = best.caveEnd === 'to' ? best.curve.startX : best.curve.endX;
  const startZ = best.caveEnd === 'to' ? best.curve.startZ : best.curve.endZ;
  return placeDebugLocation({
    x: startX, z: startZ,
    tangentX: best.toCave.x - startX, tangentZ: best.toCave.z - startZ,   // face the mouth
  }, `cave trail: ${best.routeClass}`);
}

// --- spawn: find a high mountain summit and stand the player on top ----------

function findSummitSpawn() {
  // Spiral-scan a wide area for the highest point that isn't a sheer cliff face
  // (prefer high AND fairly flat — a summit or shoulder, not a wall).
  let best = { x: 0, z: 0, score: -Infinity };
  for (let r = 200; r < 20000; r += 140) {
    const steps = Math.max(6, Math.floor(r / 70));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 + r * 0.013;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const b = world.biomeAt(x, z);
      if (b.slope > 0.5) continue;                 // skip cliff faces
      const score = b.h - b.slope * 60;            // tall, and gentle underfoot
      if (score > best.score) best = { x, z, score };
    }
  }
  // hill-climb to the local summit so the player stands right on the peak
  let x = best.x, z = best.z;
  for (let step = 60; step >= 2; step *= 0.6) {
    let bx = x, bz = z, bh = world.height(x, z);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const nx = x + Math.cos(ang) * step, nz = z + Math.sin(ang) * step;
      const h = world.height(nx, nz);
      if (h > bh) { bh = h; bx = nx; bz = nz; }
    }
    x = bx; z = bz;
  }
  return { x, z, h: world.height(x, z) };
}

// Begin on an established route so the new network is a discoverable part of
// the walking experience. Select a scenic, gentle, inland section well away
// from either endpoint; retain the old summit search as a robust fallback.
function findTrailSpawn(fallback) {
  const edges = [];
  trailsAround(world, 0, 0, world.seed, 10000, edges);
  let best = null;
  for (const edge of edges) {
    if (edge.routeClass !== 'primary') continue;
    // The trailhead is a Phase-3 showcase, not merely the highest route point:
    // avoid globally rough edges and crossings that already need a bridge.
    if (edge.meanGrade > 0.11 || edge.maxGrade > 0.55 || edge.bridgeCount > 0) continue;
    const s = edge.segments;
    for (let i = 0; i < s.count; i += 2) {
      const arc = s.arc[i];
      if (arc < 180 || edge.arcLength - arc < 180) continue;
      const x = s.ax[i], z = s.az[i];
      const biome = world.biomeAt(x, z);
      if (biome.h < 20 || biome.slope > 0.12 || world.riverAt(x, z).wet) continue;
      const score = biome.h - biome.slope * 120
        - edge.meanGrade * 120 - edge.maxGrade * 20 - edge.fordCount * 5;
      if (best && score <= best.score) continue;
      const sl = s.len[i] || 1;
      best = {
        x, z, h: biome.h, score,
        tangentX: s.dx[i] / sl, tangentZ: s.dz[i] / sl,
        edgeId: edge.id,
      };
    }
  }
  return best || fallback;
}

const homeLocation = findSummitSpawn();
const homeSurfaceLocation = { x: -4129, z: -809 };
const trailheadLocation = findTrailSpawn(homeLocation);
const trailCrossingLocations = {
  stepping: { x: -10298.5, z: -8502.1, tangentX: -0.923703, tangentZ: 0.383109 },
  log: { x: -5293.0, z: -616.9, tangentX: -0.200223, tangentZ: -0.979750 },
  bridge: { x: 159.7, z: -6316.6, tangentX: -0.073579, tangentZ: -0.997289 },
};
const spawn = trailheadLocation;
controls.place(spawn.x, spawn.z);
if (spawn.tangentX !== undefined) controls.yaw = Math.atan2(-spawn.tangentX, -spawn.tangentZ);

function placeDebugLocation(location, label, randomYaw = false) {
  if (!location) return null;
  if (cave.active) cave.exit();
  controls.place(location.x, location.z);
  if (location.tangentX !== undefined) {
    controls.yaw = Math.atan2(-location.tangentX, -location.tangentZ);
  } else if (randomYaw) {
    controls.yaw = Math.random() * Math.PI * 2;
  }
  locationActions.lastLabel = label;
  locationActions.refresh();
  return location;
}

function findRandomDebugLocation(target = null) {
  const radius = 30000;
  for (let attempt = 0; attempt < 4000; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * radius;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    const biome = world.biomeAt(x, z);
    const matches = target === null
      || (target === 'mountain' ? biome.h > 120 : biome.id === target);
    if (!matches || biome.id === 'ocean' || biome.h < 1.5 || biome.slope > 0.32) continue;
    const river = world.riverAt(x, z);
    if (river.wet && river.depth > 0.04) continue;
    return { x, z, h: biome.h };
  }
  return null;
}

function jumpToNearestLandmark() {
  const p = controls.rig.position;
  const lm = landmarks.nearest(p.x, p.z);
  if (!lm) return null;
  return placeDebugLocation({ x: lm.x + 18, z: lm.z + 18 }, `landmark: ${lm.type}`);
}

// nearest standard landmark of one type, searching outward ring by ring
function jumpToNearestOfType(type, label) {
  const p = controls.rig.position;
  const ci0 = Math.floor(p.x / LM_CELL), cj0 = Math.floor(p.z / LM_CELL);
  for (let r = 0; r <= 40; r++) {
    let best = null, bd = Infinity;
    for (let cj = cj0 - r; cj <= cj0 + r; cj++) {
      for (let ci = ci0 - r; ci <= ci0 + r; ci++) {
        if (Math.max(Math.abs(ci - ci0), Math.abs(cj - cj0)) !== r) continue;
        const lm = landmarkForCell(world, ci, cj, world.seed);
        if (!lm || lm.type !== type) continue;
        const d = (lm.x - p.x) ** 2 + (lm.z - p.z) ** 2;
        if (d < bd) { bd = d; best = lm; }
      }
    }
    if (best) {
      const s = Math.SQRT1_2 * 16;
      return placeDebugLocation({
        x: best.x + s, z: best.z + s,
        tangentX: -Math.SQRT1_2, tangentZ: -Math.SQRT1_2,   // face the landmark
      }, label);
    }
  }
  return null;
}

function jumpToNearestLighthouse() {
  const p = controls.rig.position;
  const lm = nearestMajorLandmark(world, p.x, p.z, world.seed, 8);
  if (!lm) {
    locationActions.current = 'no lighthouse within ~50 km';
    return null;
  }
  // arrive on the land side, looking at the tower (placement aims +X at the sea)
  const c = Math.cos(lm.yaw), s = Math.sin(lm.yaw);
  return placeDebugLocation({
    x: lm.x - c * 30, z: lm.z + s * 30,
    tangentX: c, tangentZ: -s,
  }, 'lighthouse');
}

const locationActions = {
  choice: 'trailhead',
  current: '',
  lastLabel: 'trailhead',
  refresh() {
    const p = controls.rig.position;
    const biome = world.biomeAt(p.x, p.z);
    this.current = `${this.lastLabel} · ${biome.id} · ${Math.round(biome.h)}m · ${Math.round(p.x)}, ${Math.round(p.z)}`;
  },
  go() {
    if (this.choice === 'home') return placeDebugLocation(homeLocation, 'home');
    if (this.choice === 'home-surface') return placeDebugLocation(homeSurfaceLocation, 'home surface test');
    if (this.choice === 'trailhead') return placeDebugLocation(trailheadLocation, 'trailhead');
    if (this.choice === 'trail-stepping') return placeDebugLocation(trailCrossingLocations.stepping, 'trail stepping stones');
    if (this.choice === 'trail-log') return placeDebugLocation(trailCrossingLocations.log, 'trail log crossing');
    if (this.choice === 'trail-bridge') return placeDebugLocation(trailCrossingLocations.bridge, 'trail plank bridge');
    if (this.choice === 'cave-spike') {
      const result = cave.enter();
      this.lastLabel = 'phase-3 cave entrance';
      this.refresh();
      return result;
    }
    if (this.choice === 'nearest-trail') {
      const result = jumpToNearestTrail();
      if (result) { this.lastLabel = `trail: ${result.routeClass}`; this.refresh(); }
      return result;
    }
    if (this.choice === 'nearest-cave-trail') return jumpToNearestCaveTrail();
    if (this.choice === 'nearest-landmark') return jumpToNearestLandmark();
    if (this.choice === 'watchtower') {
      const result = jumpToNearestOfType('tower', 'watchtower ruin');
      if (!result) this.current = 'no watchtower found nearby';
      return result;
    }
    if (this.choice === 'lighthouse') return jumpToNearestLighthouse();
    const target = this.choice === 'random' ? null : this.choice.replace('random-', '');
    const location = findRandomDebugLocation(target);
    if (!location) {
      this.current = `no safe ${target || 'random'} location found`;
      return null;
    }
    return placeDebugLocation(location, target ? `random ${target}` : 'random', true);
  },
  randomJump() { this.choice = 'random'; return this.go(); },
  home() { this.choice = 'home'; return this.go(); },
  homeSurface() { this.choice = 'home-surface'; return this.go(); },
  trailhead() { this.choice = 'trailhead'; return this.go(); },
  caveTrail() { this.choice = 'nearest-cave-trail'; return this.go(); },
  steppingCrossing() { this.choice = 'trail-stepping'; return this.go(); },
  logCrossing() { this.choice = 'trail-log'; return this.go(); },
  plankBridge() { this.choice = 'trail-bridge'; return this.go(); },
  cave() { this.choice = 'cave-spike'; return this.go(); },
  watchtower() { this.choice = 'watchtower'; return this.go(); },
  lighthouse() { this.choice = 'lighthouse'; return this.go(); },
};
locationActions.refresh();

setupDebugGUI({ post, sky, weather, rain, quality, chunkMgr, locationActions, renderer, controls, cave, animals });

// --- UI -----------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start-button');
const statusEl = document.getElementById('status');
const hud = document.getElementById('hud');
const underwaterEl = document.getElementById('underwater');
const comfortEl = document.getElementById('weather-comfort');
const gentleRainEl = document.getElementById('gentle-rain');
const muteThunderEl = document.getElementById('mute-thunder');
let started = false;

const savedBool = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch (e) { return fallback; }
};
const comfort = {
  reducedRainMotion: savedBool('wander.gentleRain',
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
  muteThunder: savedBool('wander.muteThunder', false),
};
const applyComfort = (persist = true) => {
  gentleRainEl.checked = comfort.reducedRainMotion;
  muteThunderEl.checked = comfort.muteThunder;
  rain.setComfort({ reducedMotion: comfort.reducedRainMotion });
  audio.setComfort({ thunderEnabled: !comfort.muteThunder });
  if (persist) {
    try {
      localStorage.setItem('wander.gentleRain', String(comfort.reducedRainMotion));
      localStorage.setItem('wander.muteThunder', String(comfort.muteThunder));
    } catch (e) { /* private browsing/storage restrictions */ }
  }
};
applyComfort(false);
comfortEl.addEventListener('click', (e) => e.stopPropagation());
gentleRainEl.addEventListener('change', () => {
  comfort.reducedRainMotion = gentleRainEl.checked;
  applyComfort();
});
muteThunderEl.addEventListener('change', () => {
  comfort.muteThunder = muteThunderEl.checked;
  applyComfort();
});

overlay.addEventListener('click', async () => {
  if (!ready) return;
  started = true;
  overlay.classList.add('hidden');
  controls.enabled = true;
  renderer.domElement.requestPointerLock?.();
  await audio.start();
});

document.addEventListener('pointerlockchange', () => {
  if (!renderer.xr.isPresenting && started && document.pointerLockElement !== renderer.domElement) {
    overlay.classList.remove('hidden');
    controls.enabled = false;
    startButton.focus({ preventScroll: true });
  }
});
renderer.xr.addEventListener('sessionstart', async () => {
  started = true;
  overlay.classList.add('hidden');
  controls.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // VR renders direct (no post grade)
  await audio.start();
});
renderer.xr.addEventListener('sessionend', () => {
  renderer.toneMapping = THREE.NoToneMapping;          // back to the post-grade pipeline
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});

// --- main loop ------------------------------------------------------------------

let ready = false;
let hudTimer = 0;
const eyePos = new THREE.Vector3();
const clock = new THREE.Clock();

// cheap "near water" probe: sample heights in a ring around the player
function waterProximity(px, pz) {
  let near = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    for (const r of [6, 25, 60]) {
      const h = world.height(px + Math.cos(a) * r, pz + Math.sin(a) * r);
      if (h < WATER_LEVEL + 0.3) near = Math.max(near, 1 - r / 80);
    }
  }
  return near;
}

// forest density estimate for wind shelter + birdsong
function forestness(biomeId) {
  return { jungle: 1, forest: 0.9, taiga: 0.8 }[biomeId] || 0;
}

// river proximity + flow speed (rapids) for the flowing-water soundscape:
// sample a ring for the nearest wet channel, then its surface slope.
function riverProximity(px, pz) {
  let near = 0, best = null, bestD = 1e9;
  for (const rad of [4, 12, 24]) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rad;
      const x = px + Math.cos(a) * rad, z = pz + Math.sin(a) * rad;
      const r = world.riverAt(x, z);
      if (r.wet) {
        near = Math.max(near, 1 - rad / 34);
        if (rad < bestD) { bestD = rad; best = { x, z }; }
      }
    }
  }
  let flow = 0, fall = 0;
  if (best) {
    // slope of the PURE channel surface (ySmooth) — the effective surface
    // sinks below terrain at shorelines, which would read as false rapids
    const e = 4;
    const gx = world.riverAt(best.x + e, best.z).ySmooth - world.riverAt(best.x - e, best.z).ySmooth;
    const gz = world.riverAt(best.x, best.z + e).ySmooth - world.riverAt(best.x, best.z - e).ySmooth;
    const slope = Math.hypot(gx, gz) / (2 * e);   // metres of drop per metre
    flow = Math.min(1, slope * 30);                // gentle head gradient → audible current
    fall = near * smoothstep(0.45, 1.4, slope);    // a steep drop nearby = roar
  }
  return { near, flow, fall };
}

let slowProbe = { nearWater: 0, caveWater: 0, forest: 0, biome: null, river: { near: 0, flow: 0, fall: 0 }, timer: 0 };
let shadowFrame = 0;   // throttles sun-shadow refreshes (see autoUpdate = false)
let lastShadowX = Infinity, lastShadowZ = Infinity;

renderer.setAnimationLoop(() => {
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  // Refresh the sun shadow map only rarely — essentially static, tracking the
  // sun's slow transit with an occasional step — or immediately whenever the
  // player moves enough that the follow-frustum would otherwise lag. Between
  // refreshes the map is byte-identical, so grass reads a rock-steady shadow.
  if ((shadowFrame++ % 2000) === 0
    || Math.abs(controls.rig.position.x - lastShadowX) > 3
    || Math.abs(controls.rig.position.z - lastShadowZ) > 3) {
    sky.sun.shadow.needsUpdate = true;
    lastShadowX = controls.rig.position.x;
    lastShadowZ = controls.rig.position.z;
  }

  controls.update(dt);
  cave.update(dt);
  const px = controls.rig.position.x, pz = controls.rig.position.z;

  chunkMgr.update(px, pz);
  farTerrain.update(px, pz);
  landmarks.update(px, pz);
  if (!ready && chunkMgr.pendingNearby() === 0 && chunkMgr.chunks.size > 8) {
    ready = true;
    statusEl.textContent = 'ready — click to walk';
  }

  // Weather supplies the prevailing wind before the sky moves its cloud pools;
  // the clock is at most one frame behind here, imperceptible on hour-long
  // transitions and exactly continuous at the shared midnight boundary.
  weather.update(sky.dayIndex, sky.time, sky.sunElevation, sky.moonIllum);
  updateWind(dt, weather.current);
  sky.update(dt, controls.rig.position, weather.current);
  const caveAtmosphere = cave.updateAtmosphere(dt, sky, weather.current, scene.fog);
  animals.update(dt, controls.rig.position, caveAtmosphere.factor);
  updateWaterCommon(dt, sky, scene.fog, weather.current);
  water.update(dt, controls.rig.position);
  grassField.update(dt, controls.rig.position, sky.sun);
  rain.update(dt, controls.rig.position, weather.current, sky, scene.fog, caveAtmosphere.factor);
  butterflies.update(dt, controls.rig.position, sky.sunElevation, weather.current, caveAtmosphere.factor);
  fireflies.update(dt, controls.rig.position, sky, weather.current, caveAtmosphere.factor);
  birds.update(dt, controls.rig.position, sky, weather.current, caveAtmosphere.factor);
  lighthouseFx.update(dt, controls.rig.position, sky, weather.current, landmarks);
  updateWaterfall(dt, sky, scene.fog);
  updateAtmosphere(dt, sky, scene.fog, weather.current,
    slowProbe.biome ? slowProbe.biome.h : 0, caveAtmosphere.factor);
  impostors.update(smoothstep(-0.04, 0.12, sky.sunElevation));
  updateGrassTime(t);

  // is the player standing in a river? (drives wading audio + underwater tint)
  const river = world.riverAt(px, pz);

  // slow probes (4 Hz): biome, water proximity, forest cover
  slowProbe.timer -= dt;
  if (slowProbe.timer <= 0) {
    slowProbe.timer = 0.25;
    slowProbe.biome = world.biomeAt(px, pz);
    cave.discoverNear(px, pz);   // walk-up cave discovery (in-place activation)
    slowProbe.nearWater = waterProximity(px, pz);
    slowProbe.caveWater = cave.waterProximity(controls.rig.position);
    slowProbe.forest = forestness(slowProbe.biome.id);
    slowProbe.river = riverProximity(px, pz);
    post.setBiomeTint(slowProbe.biome.id);   // regional grade drifts with you
  }

  const b = slowProbe.biome;
  if (b) {
    const surfacePresence = 1 - caveAtmosphere.factor;
    audio.update(dt, {
      altitude: Math.max(0, b.h),
      forestness: slowProbe.forest,
      nearWater: Math.max(slowProbe.nearWater * surfacePresence, slowProbe.caveWater),
      riverNear: Math.max(slowProbe.river.near * surfacePresence, slowProbe.caveWater * 0.72),
      riverFlow: Math.max(slowProbe.river.flow * surfacePresence, slowProbe.caveWater * 0.38),
      fallNear: slowProbe.river.fall * surfacePresence,
      dayness: smoothstep(-0.05, 0.15, sky.sunElevation),
      windStrength: windUniforms.uWindStrength.value * (0.12 + surfacePresence * 0.88),
      windSpeed: windUniforms.uWindSpeed.value * (0.18 + surfacePresence * 0.82),
      rain: weather.current.rain * surfacePresence,
      storm: weather.current.storm * surfacePresence,
      birdActivity: weather.current.birdActivity * surfacePresence,
      nocturnalActivity: weather.current.nocturnalActivity * surfacePresence,
      biomeId: b.id,
      slope: b.slope,
      wading: b.h < WATER_LEVEL + 0.4 || (river.wet && river.depth > 0.05),
    }, controls.consumeFootstep());
  }

  // underwater tint when the eye dips below the sea or a river surface
  controls.eyeWorldPosition(eyePos);
  const underwater = eyePos.y < WATER_LEVEL || (river.wet && eyePos.y < river.y);
  underwaterEl.style.display = underwater ? 'block' : 'none';

  quality.tick(dt);

  hudTimer -= dt;
  if (hudTimer <= 0 && b) {
    hudTimer = 0.5;
    hud.innerHTML =
      `${Math.round(quality.fps)} fps · ${quality.tier.name}<br/>` +
      `${b.id} · ${Math.round(b.h)}m · ${b.t.toFixed(0)}°C · ${sky.clockString()}`;
  }

  // VR can't use the post pipeline (it breaks XR's direct framebuffer) → render
  // direct; otherwise run the composer (SSAO + bloom + tonemap/grade).
  if (renderer.xr.isPresenting) {
    const surfaceExposure = renderer.toneMappingExposure;
    renderer.toneMappingExposure = surfaceExposure * caveAtmosphere.exposureScale;
    renderer.render(scene, camera);
    renderer.toneMappingExposure = surfaceExposure;
  } else {
    post.update(renderer.toneMappingExposure, sky.sunElevation, sky.duskWarmthScale, weather.current, dt, sky, caveAtmosphere);
    post.render();
  }
});

// console handle for debugging / exploring: __wander.teleport(x, z)
window.__wander = {
  world, controls, sky, weather, wind: windUniforms, quality, chunkMgr, water, farTerrain, impostors, audio, landmarks, post, scene,
  rain, cave, animals,
  comfort,
  locations: locationActions,
  homeLocation,
  homeSurfaceLocation,
  trailheadLocation,
  trailCrossingLocations,
  butterflies, fireflies, birds, lighthouseFx,
  // debug: freeze the clock at a time-of-day and pump every per-frame sky/light
  // update with dt=0, so a screenshot renders a faithful frame even when the
  // preview tab is backgrounded and the rAF loop is throttled.
  tick: (t) => {
    if (t !== undefined) sky.time = t;
    const pos = controls.rig.position;
    weather.update(sky.dayIndex, sky.time, sky.sunElevation, sky.moonIllum);
    updateWind(0, weather.current);
    sky.update(0, pos, weather.current);
    const caveAtmosphere = cave.updateAtmosphere(0.5, sky, weather.current, scene.fog);
    updateWaterCommon(0, sky, scene.fog, weather.current);
    updateAtmosphere(0, sky, scene.fog, weather.current,
      slowProbe.biome ? slowProbe.biome.h : 0, caveAtmosphere.factor);
    rain.update(0.5, pos, weather.current, sky, scene.fog, caveAtmosphere.factor);
    butterflies.update(0.5, pos, sky.sunElevation, weather.current);
    fireflies.update(0.5, pos, sky, weather.current); // fixed pseudo-dt so fades converge when paused
    lighthouseFx.update(0.5, pos, sky, weather.current, landmarks);
    post.update(renderer.toneMappingExposure, sky.sunElevation, sky.duskWarmthScale, weather.current, 0.5, sky, caveAtmosphere);
    const activePalette = sky.time < 0.5 ? sky.day.dawnPalette : sky.day.duskPalette;
    return {
      clock: sky.clockString(), elev: +sky.sunElevation.toFixed(3), palette: activePalette.name,
      weather: weather.current.archetype, scenario: weather.current.scenario,
      solarPhase: weather.current.solarPhase,
    };
  },
  jump: () => controls.requestJump(),
  teleport: (x, z) => {
    if (cave.active) cave.exit();
    return controls.place(x, z);
  },
  // debug/exploration teleports are also exposed in the Location GUI folder.
  toHome: () => placeDebugLocation(homeLocation, 'home'),
  toTrailhead: () => placeDebugLocation(trailheadLocation, 'trailhead'),
  toSteppingCrossing: () => locationActions.steppingCrossing(),
  toLogCrossing: () => locationActions.logCrossing(),
  toPlankBridge: () => locationActions.plankBridge(),
  toLandmark: jumpToNearestLandmark,
  toWatchtower: () => jumpToNearestOfType('tower', 'watchtower ruin'),
  toLighthouse: jumpToNearestLighthouse,
  toTrail: jumpToNearestTrail,
  toCaveTrail: jumpToNearestCaveTrail,
  randomLocation: () => locationActions.randomJump(),
  showAnimal: (species = 'whitetail') => animals.preview(species, controls.rig.position, controls.yaw),
  showAnimals: () => animals.previewAll(controls.rig.position, controls.yaw),
};
