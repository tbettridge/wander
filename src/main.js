import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { World, WATER_LEVEL } from './world.js';
import { ChunkManager, CHUNK_SIZE } from './terrain.js?v=6';
import { FarTerrain } from './farterrain.js?v=6';
import { createImpostorSystem } from './impostors.js?v=4';
import { LandmarkManager } from './landmarkmesh.js?v=4';
import { LighthouseFx } from './lighthousefx.js';
import { greatTreeArchetype, nearestMajorLandmark, landmarkForCell, LM_CELL } from './landmarks.js';
import {
  configureXRGrassPatches,
  createVegetationLibrary,
  setXRGrassPatchBudget,
  updateGrassTime,
  updateXRGrassPatches,
  xrGrassPatchDebug,
} from './vegetation.js?v=4';
import { SkySystem } from './sky.js?v=7';
import { WeatherSystem } from './weather.js';
import { WaterSystem } from './water.js';
import { GrassField } from './grassfield.js?v=2';
import { Butterflies } from './butterflies.js';
import { Fireflies } from './fireflies.js';
import { Birds } from './birds.js';
import { AnimalSystem } from './animals.js?v=5';
import { RainSystem } from './rain.js';
import { updateWaterCommon } from './watercommon.js';
import { updateWaterfall } from './waterfall.js';
import { updateAtmosphere } from './atmosphere.js';
import { CloudShadowCache } from './cloudshadows.js';
import { updateWind, windUniforms } from './wind.js';
import { PlayerControls } from './controls.js';
import { CarriedLantern } from './carriedlantern.js?v=7';
import { Soundscape } from './audio.js';
import { QualityManager } from './quality.js';
import { XRPerformanceController } from './xrperformance.js?v=4';
import { xrProfileForName } from './xrprofiles.mjs?v=3';
import { xrWorldTierForName, xrWorldTierLabel } from './xrworldtier.mjs';
import { XRRuntimeGovernor } from './xrgovernor.mjs?v=2';
import { QuestBenchmarkRunner } from './xrbenchmark.mjs?v=2';
import { createXRTerrainMaterial } from './xrterrain.js?v=4';
import {
  applyXRMaterialVariants,
  setXRMaterialVariants,
  xrMaterialVariantDebug,
} from './xrmaterialvariants.mjs?v=2';
import { XRShadowProxySystem, XR_SHADOW_LAYER } from './xrshadowproxies.js';
import { XRActionHUD } from './xractionhud.js?v=2';
import { XRExperimentController } from './xrexperimentcontroller.js?v=3';
import { renderOffscreen } from './offscreenrender.mjs';
import { createPostFX } from './post.js?v=3';
import { setupDebugGUI } from './debug.js?v=8';
import { CaveExperiment } from './cave.js?v=14';
import { RailLaboratory } from './raillab.js';
import { RegionalRailwayPreview } from './railwayplanning.js?v=2';
import { resumeDesktopAfterFastTravel } from './desktopfasttravel.mjs';
import { RegionalRailwayTrack } from './railwaystream.js';
import { RegionalRailwayService } from './railservice.js';
import { surfaceWaterOverlayOpacity } from './surfacewater.mjs?v=1';
import { trailsAround, nearestTrailPoint } from './trails.js';
import { buildNavGraph } from './npcnavgraph.mjs';
import { describeJourney } from './npcjourneycontext.mjs';
import { WalkableSurface } from './walkablesurface.mjs';
import { clamp, smoothstep } from './noise.js';
import { LivingWorldAI, LivingWorldDirector } from './livingworld.mjs?v=placecontext1';
import { buildStationDialogueContext } from './livingworldcontext.mjs?v=placecontext1';
import { LivingWorldPopulation } from './stationkeeper.js?v=npcplacecontext1';
import { SettlementSystem } from './settlementstream.js?v=placecontext1';
import { HorseRiding } from './horseriding.mjs';
import { warmStationSettlementPlans } from './settlementspatial.mjs';
import { nearestSettlement } from './settlementplacement.mjs';
import { settlementOrigin } from './settlementorigin.mjs';
import { StructureCollisionIndex } from './structurecollision.mjs';
import {
  consumeSurfaceShadowInterval,
  grassSnapshotDue,
  shadowPolicyForTier,
  surfaceShadowDue,
} from './shadowquality.mjs';

// --- renderer / scene -------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
// Tone mapping is done in the post-processing grade pass (linear-HDR pipeline),
// so the renderer itself does NOT tone map. The XR path has no post pipeline,
// so ACES is switched back on while a VR session is active (see below).
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
// r185 removed the legacy soft-PCF implementation and otherwise emits a
// deprecation warning before silently choosing PCF. Make that migration
// explicit while preserving the exact r165 rollback rendering path.
renderer.shadowMap.type = Number(THREE.REVISION) >= 185
  ? THREE.PCFShadowMap
  : THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
// The composer performs several renderer.render() calls per visual frame.
// Accumulate their counters until the next animation frame so the debug panel
// reports the real scene + post cost rather than only the final fullscreen pass.
renderer.info.autoReset = false;
// XR display settings must be chosen before VRButton requests a session. The
// controller reads the persisted Painterly/Survival choice immediately; world
// rendering policy remains separate and is introduced in the later XR phases.
const xrPerformance = new XRPerformanceController(renderer);
document.body.appendChild(renderer.domElement);
// A canvas is not focusable by default, so the domElement.focus() on pointer
// lock was a silent no-op and DOM focus stayed on whatever button started the
// session. Keyboard focus is independent of pointer lock, so every keydown kept
// targeting that button. tabIndex -1 makes the programmatic focus work without
// putting the canvas in the tab order.
renderer.domElement.tabIndex = -1;
// Request Layers up front so the opt-in compositor HUD can be activated from
// the debug panel. It remains optional and the scene-sprite HUD is the fallback.
document.body.appendChild(VRButton.createButton(renderer, {
  optionalFeatures: ['layers'],
}));

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
scene.add(impostors.root);   // one shared pool group; chunks contribute instances
const farTerrain = new FarTerrain(scene, world);
const landmarks = new LandmarkManager(scene, world);
const lighthouseFx = new LighthouseFx(scene);
const sky = new SkySystem(scene, renderer, world.seed);
const weather = new WeatherSystem(world.seed);
const cloudShadows = new CloudShadowCache();
const controls = new PlayerControls(renderer, camera, world, renderer.domElement);
scene.add(controls.rig);
// Bridge decks, plank crossings and railway spans stand above the terrain and
// are invisible to world.height(). One surface serves the player's feet and any
// NPC walking the same ground, so the two can never disagree about a deck.
const walkableSurface = new WalkableSurface(world, {
  seed: world.seed, trailsAround, nearestTrailPoint,
});
controls.setWalkableSurface(walkableSurface.provider());
const carriedLantern = new CarriedLantern(renderer, camera, controls);
const xrActionHud = new XRActionHUD(camera);
const audio = new Soundscape();

// ocean / lake surface — shader-driven plane that follows the player
const water = new WaterSystem(scene, world);
const grassField = new GrassField(scene, world);
const rain = new RainSystem(scene);
const butterflies = new Butterflies(scene, world);
const fireflies = new Fireflies(scene, world);
const birds = new Birds(scene, world);
const animals = new AnimalSystem(scene, world);
// Riding. Movement input is locked while mounted and mouselook left free, so
// the rider looks around from the saddle while the horse carries them.
const horseRiding = new HorseRiding(controls, {
  onMount: (horse) => { statusEl.textContent = `riding · ${horse.phenotype?.morph || 'horse'} · R to dismount`; },
  onDismount: () => { statusEl.textContent = 'ready — click to walk'; },
});
// A shaking horizon is the one thing a player cannot look away from, so the
// saddle's throw is halved in a headset and switched off outright for anyone
// who has asked the system for reduced motion.
horseRiding.jostleScale =
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) ? 0 : 1;
// R mounts and dismounts. Handled here rather than in controls so it can see
// the live animal list.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyR' || event.repeat) return;
  const target = event.target;
  const tag = target?.tagName?.toLocaleLowerCase();
  if (target?.isContentEditable || tag === 'input' || tag === 'textarea') return;
  if (!controls.enabled && !horseRiding.riding) return;
  horseRiding.toggle(animals.liveAgents(), controls.rig.position);
});
const cave = new CaveExperiment(scene, world, controls, { terrain: chunkMgr, library });
let regionalRailwayTrack = null;

function updateLivingWorldModelStatus({ state, progress, message } = {}) {
  const status = document.getElementById('living-world-status');
  const toggle = document.getElementById('living-world-ai');
  if (!status) return;
  const labels = {
    checking: 'Checking this browser…',
    unknown: 'Browser check timed out · enable AI to try directly',
    optional: 'Authored dialogue ready · enable AI to try the on-device model',
    unsupported: 'Edge model unavailable · authored dialogue remains active',
    unavailable: 'Edge model unavailable · authored dialogue remains active',
    available: 'Edge model available · enable it before entering',
    downloadable: 'Edge model can be downloaded · enable it before entering',
    downloading: `Downloading edge model… ${Math.round((progress || 0) * 100)}%`,
    initializing: 'Starting the on-device model…',
    ready: 'On-device model ready',
    generating: 'The station keeper is thinking…',
    remembering: 'Distilling the last conversation into memory…',
    disabled: 'AI off · authored dialogue remains active',
    failed: `Model failed${message ? `: ${message}` : ''} · authored dialogue active`,
  };
  status.textContent = labels[state] || String(state || 'Authored dialogue active');
  if (toggle) {
    const blocked = state === 'unsupported' || state === 'unavailable';
    toggle.disabled = blocked;
    if (blocked) toggle.checked = false;
  }
}

const livingWorldAI = new LivingWorldAI({ onStatus: updateLivingWorldModelStatus });
const livingWorldDirector = new LivingWorldDirector({
  ai: livingWorldAI,
  onStatus: updateLivingWorldModelStatus,
});
let desktopUiState = 'opening';

// Pointer lock instrumentation. Chrome throttles requestPointerLock for ~1.25s
// after an exitPointerLock, and a throttled request is otherwise
// indistinguishable from a user-declined one: both surface as a bare
// pointerlockerror with no reason. Record enough context to tell them apart.
const pointerLockDebug = {
  lastRequestAt: null,
  lastRequestSource: null,
  lastUnlockAt: null,
  lastUnlockState: null,
  failures: [],
};

function pointerLockNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function notePointerLockRequest(source) {
  pointerLockDebug.lastRequestAt = pointerLockNow();
  pointerLockDebug.lastRequestSource = source;
  console.log('[pointerlock] request', {
    source,
    desktopUiState,
    msSinceLastUnlock: pointerLockDebug.lastUnlockAt === null
      ? null
      : Math.round(pointerLockNow() - pointerLockDebug.lastUnlockAt),
    lastUnlockState: pointerLockDebug.lastUnlockState,
  });
}

function describePointerLockReason(reason) {
  if (!reason) return { reasonType: 'none' };
  if (typeof Event !== 'undefined' && reason instanceof Event) {
    return { reasonType: 'event', eventType: reason.type };
  }
  if (reason instanceof Error) {
    return { reasonType: 'error', name: reason.name, message: reason.message };
  }
  return { reasonType: typeof reason, value: String(reason) };
}

function recordPointerLockFailure(source, reason) {
  const now = pointerLockNow();
  const record = {
    source,
    desktopUiState,
    ...describePointerLockReason(reason),
    msSinceLastUnlock: pointerLockDebug.lastUnlockAt === null
      ? null
      : Math.round(now - pointerLockDebug.lastUnlockAt),
    msSinceLastRequest: pointerLockDebug.lastRequestAt === null
      ? null
      : Math.round(now - pointerLockDebug.lastRequestAt),
    lastRequestSource: pointerLockDebug.lastRequestSource,
    lastUnlockState: pointerLockDebug.lastUnlockState,
    // Chrome's throttle window after exitPointerLock is ~1.25s; a failure
    // inside it is very likely throttled rather than declined.
    likelyThrottled: pointerLockDebug.lastUnlockAt !== null
      && now - pointerLockDebug.lastUnlockAt < 1250,
    documentHasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    activeElement: document.activeElement?.tagName || null,
    pointerLockElement: document.pointerLockElement ? 'present' : 'none',
  };
  pointerLockDebug.failures.push(record);
  if (pointerLockDebug.failures.length > 50) pointerLockDebug.failures.shift();
  console.warn('[pointerlock] failure', record);
  return record;
}

function beginNpcChat() {
  if (renderer.xr.isPresenting) return;
  desktopUiState = 'npc-dialogue';
  overlay.classList.add('hidden');
  controls.suspendInput();
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock?.();
  } else {
    livingWorldPopulation.setPointerReleased();
  }
}

function restoreNpcChatAfterLockFailure(reason) {
  recordPointerLockFailure('restoreNpcChatAfterLockFailure', reason);
  if (desktopUiState !== 'npc-resuming') return;
  desktopUiState = 'npc-dialogue';
  overlay.classList.add('hidden');
  controls.suspendInput();
  livingWorldPopulation.resumeDialogueClose();
}

function handlePointerLockFailure(reason) {
  if (desktopUiState === 'npc-resuming') {
    restoreNpcChatAfterLockFailure(reason);
    return;
  }
  recordPointerLockFailure('handlePointerLockFailure', reason);
  if (desktopUiState !== 'resuming') return;
  desktopUiState = 'paused';
  controls.suspendInput();
  overlay.classList.remove('hidden');
  startButton.focus({ preventScroll: true });
}

function resumeDesktopAfterStationTravel() {
  return resumeDesktopAfterFastTravel({
    active: started && !renderer.xr.isPresenting,
    locked: document.pointerLockElement === renderer.domElement,
    enterPlaying: () => {
      desktopUiState = 'playing';
      overlay.classList.add('hidden');
      controls.enabled = true;
      controls.allowLook = false;
      renderer.domElement.focus?.({ preventScroll: true });
    },
    enterResuming: () => {
      desktopUiState = 'resuming';
      overlay.classList.add('hidden');
      controls.suspendInput();
    },
    requestLock: () => {
      if (!renderer.domElement.requestPointerLock) {
        throw new Error('requestPointerLock unavailable');
      }
      notePointerLockRequest('station-fast-travel');
      return renderer.domElement.requestPointerLock();
    },
    onFailure: handlePointerLockFailure,
  });
}

function requestNpcChatClose() {
  if (desktopUiState !== 'npc-dialogue') {
    livingWorldPopulation.resumeDialogueClose();
    return;
  }
  desktopUiState = 'npc-resuming';
  controls.suspendInput();
  try {
    if (!renderer.domElement.requestPointerLock) {
      restoreNpcChatAfterLockFailure(new Error('requestPointerLock unavailable'));
      return;
    }
    notePointerLockRequest('npc-chat-close');
    const request = renderer.domElement.requestPointerLock();
    request?.catch?.(restoreNpcChatAfterLockFailure);
  } catch (error) {
    restoreNpcChatAfterLockFailure(error);
  }
}

function abandonNpcChat() {
  if (desktopUiState !== 'npc-dialogue' && desktopUiState !== 'npc-resuming') return;
  desktopUiState = started ? 'paused' : 'opening';
  controls.suspendInput();
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
  if (started) {
    overlay.classList.remove('hidden');
    startButton.focus({ preventScroll: true });
  }
}

const livingWorldPopulation = new LivingWorldPopulation(scene, controls, livingWorldDirector, {
  worldSeed: world.seed,
  // The same surface the player's feet resolve against, so an NPC never wades a
  // river the player walks over. Wired here rather than inside the population:
  // there is exactly one walkable surface and everyone shares it.
  groundAt: walkableSurface.groundProvider(),
  surfaceQuery: walkableSurface.queryProvider(),
  getAgencyContext: (position, station, actor) => {
    const currentWeather = weather.current || {};
    const schedule = regionalRailwayService?.schedule || null;
    const stationIndex = Number(station?.index);
    const trainDue = !!schedule && (schedule.nextStationIndex === stationIndex
      || schedule.currentStationIndex === stationIndex) && (schedule.atStation || schedule.etaSeconds < 90);
    const river = world.riverAt(position.x, position.z);
    const hour = sky.time * 24;
    return {
      weather: currentWeather.archetype || 'changeable',
      raining: (currentWeather.rain || 0) > 0.2,
      storm: (currentWeather.storm || 0) > 0.35,
      trainDue,
      thirsty: ((actor?.identity?.seed || 0) + Math.floor(hour)) % 5 === 0,
      bootsNeedRepair: ((actor?.identity?.seed || 0) + Math.floor(hour / 2)) % 7 === 0,
      hasStreamAnchor: !!Object.values(livingWorldPopulation.worldState.actionAnchors || {})
        .find((anchor) => anchor.kind === 'stream' && Math.hypot(anchor.x - position.x, anchor.z - position.z) < 80),
      hasTrailMarker: !!Object.values(livingWorldPopulation.worldState.actionAnchors || {})
        .find((anchor) => anchor.kind === 'trail-marker' && Math.hypot(anchor.x - position.x, anchor.z - position.z) < 80),
      hasRepairSite: true,
      standingInWater: !!river.wet,
    };
  },
  onChatOpen: beginNpcChat,
  onChatCloseRequest: requestNpcChatClose,
  onChatAbandon: abandonNpcChat,
  getContext: (station, encounterCount, npc, origin, journey, graph) => ({
    ...buildStationDialogueContext({
    world,
    station,
    player: controls.rig.position,
    sky,
    weather,
    npc,
    encounterCount,
    origin,
    // Which village this speaker belongs to, and why it is there. Measured
    // from where they are standing rather than from the station, because a
    // resident of a village answers for that village.
    place: settlementPlaceAt(origin?.x ?? controls.rig.position.x,
      origin?.z ?? controls.rig.position.z),
  }),
    // Null for a resident who has never left. A traveller carries where it set
    // out from, where it is going and why, so it can answer for its own walk
    // instead of the model inventing a destination it then contradicts.
    journey: describeJourney(journey, {
      world, seed: world.seed, nodes: graph?.nodes ?? navGraph?.nodes ?? null,
    }),
  }),
});
// Settlements share the canonical living-world state and the same walkable
// surface as station residents. Deterministic plans are streamed as needed;
// only household, portal, routine, and evolution deltas enter the save.
const structureCollision = new StructureCollisionIndex(() => livingWorldPopulation.worldState);
controls.setObstacleResolver(structureCollision);
const settlementSystem = new SettlementSystem(
  scene, world, walkableSurface, livingWorldPopulation.worldState, structureCollision,
  {
    isActorInDialogue: (actorId) => livingWorldPopulation.isTalkingTo(actorId),
    vegetationLibrary: library,
  },
);
livingWorldPopulation.setExternalActorsProvider(() => settlementSystem.interactiveActors());

/**
 * The settlement standing at this point and why it is there, or null.
 *
 * Reads `settlementSystem.summaries`, which the streamer already refreshes on
 * its own cadence, so this is a walk over a handful of nearby sites rather than
 * a fresh spatial query. `within` scales the halo: a resident belongs to their
 * village wherever in it they are standing, but the HUD should not name a place
 * you are still two fields away from.
 *
 * Declared as a function so it hoists above the dialogue-context closure that
 * uses it; `settlementSystem` is only read when that closure actually runs.
 */
function settlementPlaceAt(x, z, within = 1) {
  let best = null, bestDistance = Infinity;
  for (const site of settlementSystem.summaries) {
    const distance = Math.hypot(site.x - x, site.z - z);
    if (distance < site.radius * within && distance < bestDistance) {
      bestDistance = distance;
      best = site;
    }
  }
  return best ? settlementOrigin(world, best) : null;
}

// --- quality ------------------------------------------------------------------

const post = createPostFX(renderer, scene, camera);
let requestedShadowTier = null;
let xrWorldTierActive = null;
const xrWorldDebug = {
  tier: 'desktop inherited',
  geometry: 'waiting for quality tier',
};

function applyWorldRenderTier(tier, { xr = false } = {}) {
  chunkMgr.setWorldRenderTier(tier);
  sky.setViewDistance(tier.viewRadius * CHUNK_SIZE * 0.95);
  farTerrain.setNearField(tier.viewRadius * CHUNK_SIZE);
  water.setNearField(tier.viewRadius * CHUNK_SIZE);
  xrWorldDebug.tier = xr ? tier.label : `desktop ${tier.name}`;
  xrWorldDebug.geometry = xr
    ? xrWorldTierLabel(tier)
    : `${tier.viewRadius * CHUNK_SIZE}m terrain · ${tier.treeRadius * CHUNK_SIZE}m real trees · ${tier.nearRes}² near terrain`;
}

const quality = new QualityManager(renderer, (tier) => {
  post.setSize(window.innerWidth, window.innerHeight); // resync composer to the tier's pixel ratio
  post.setQuality(tier);
  grassField.setQuality(tier);
  animals.setQuality(tier);
  rain.setQuality(tier);
  regionalRailwayTrack?.setMasonryRenderProfile({ tier: tier.name });
  applyWorldRenderTier(tier);
  chunkMgr.setShadowsEnabled(tier.shadowSize > 0);
  sky.sun.castShadow = tier.shadowSize > 0;
  requestedShadowTier = tier;
  if (tier.shadowSize > 0 && sky.sun.shadow.mapSize.x !== tier.shadowSize) {
    sky.sun.shadow.mapSize.set(tier.shadowSize, tier.shadowSize);
    if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
  }
  sky.sun.shadow.needsUpdate = tier.shadowSize > 0;
}, QualityManager.guessInitialLevel());

// --- XR Phase-2 visual path -------------------------------------------------
// Construct the additional GPU resources only when an XR session (or explicit
// desktop A/B preview) requests them. Default desktop continues to use its
// existing terrain, grass, shadow layers, quality controller and post stack.
let xrTerrainMaterial = null;
let xrShadowProxies = null;
let xrVisualsActive = false;
let xrVisualPreview = false;
let xrVisualProfile = null;
const xrRuntime = new XRRuntimeGovernor();

function ensureXRVisualSystems() {
  if (!xrTerrainMaterial) xrTerrainMaterial = createXRTerrainMaterial();
  if (!xrShadowProxies) {
    xrShadowProxies = new XRShadowProxySystem(scene, library);
    chunkMgr.shadowProxySystem = xrShadowProxies;
  }
}

function setSunShadowMapSize(size) {
  if (size <= 0 || sky.sun.shadow.mapSize.x === size) return;
  sky.sun.shadow.mapSize.set(size, size);
  if (sky.sun.shadow.map) {
    sky.sun.shadow.map.dispose();
    sky.sun.shadow.map = null;
  }
}

function applyXRRuntimeStage(stage, profile = xrVisualProfile) {
  if (!stage || !profile) return;
  setXRGrassPatchBudget(stage.grassPatchScale);
  const grassPlan = grassField.setXRRuntimeScale(stage.grassMidScale);
  xrTerrainMaterial?.userData.setXRGrassPlan?.(grassPlan);
  chunkMgr.setXRDetailBudget(stage.detailBudget);
  rain.setXRScale(stage.rainScale);
  butterflies.setXRScale(stage.ambientLifeScale);
  fireflies.setXRScale(stage.ambientLifeScale);
  birds.setXRScale(stage.ambientLifeScale);

  // Preserve a shadowed world in every stage. Only cadence falls under load;
  // resolution remains stable to avoid a render-target allocation hitch.
  const baseShadowPolicy = shadowPolicyForTier(`xr-${profile.name}`);
  const shadowHz = Math.max(2,
    Math.round(profile.shadowHz * stage.shadowHzScale));
  requestedShadowTier = {
    name: `xr-${profile.name}-${stage.name}`,
    shadowSize: profile.shadowSize,
    shadowPolicy: { ...baseShadowPolicy, surfaceHz: shadowHz },
  };
  sky.sun.shadow.needsUpdate = true;

  const requestedFoveation = Math.min(0.98,
    profile.foveation + stage.foveationBoost);
  const appliedFoveation = xrPerformance.setRuntimeFoveation(requestedFoveation);
  xrPerformance.setRuntimeStage(stage.label);
  const foveationLabel = appliedFoveation == null
    ? requestedFoveation.toFixed(2) : Number(appliedFoveation).toFixed(2);
  xrPerformance.telemetry.visuals =
    `${stage.label} · ${xrWorldTierActive?.label || 'XR world'} · grass near ${profile.grassBladeBudget.toLocaleString()}/chunk + mid ${grassPlan?.mid.instances.toLocaleString() || '—'} + shader far · ${profile.shadowSize}² @ ${shadowHz} Hz · fov ${foveationLabel}`;
}

function applyXRVisualProfile(profile, { preview = false } = {}) {
  ensureXRVisualSystems();
  xrVisualsActive = true;
  xrVisualPreview = preview;
  xrVisualProfile = profile;
  xrWorldTierActive = xrWorldTierForName(profile.worldTier);
  applyWorldRenderTier(xrWorldTierActive, { xr: true });
  // Weather density is world presentation, not eye-buffer policy. XR High
  // starts from the richer desktop High rain population; the runtime governor
  // still scales it down continuously under pressure.
  rain.setQuality({ name: xrWorldTierActive.rainTier });
  setXRMaterialVariants(true);
  applyXRMaterialVariants(scene, true);
  regionalRailwayTrack?.setMasonryRenderProfile({ xr: true, tier: profile.name });

  grassField.setXRActive(true, profile);
  chunkMgr.setXRGrassActive(true, profile);
  configureXRGrassPatches(true, profile);
  chunkMgr.setTerrainMaterial(xrTerrainMaterial);
  farTerrain.setSurfaceMaterial(xrTerrainMaterial);

  // Only layer-30 proxy casters enter the small, low-rate XR shadow map. Three
  // reserves layers 1/2 for the left/right WebXR cameras, so the proxy layer
  // must stay clear of them or coarse tree crowns leak into one eye.
  chunkMgr.setShadowsEnabled(true);
  xrShadowProxies.setEnabled(true, chunkMgr, landmarks);
  sky.sun.shadow.camera.layers.set(XR_SHADOW_LAYER);
  sky.sun.castShadow = true;
  setSunShadowMapSize(profile.shadowSize);
  xrRuntime.start(profile);
  applyXRRuntimeStage(xrRuntime.stage, profile);
}

function restoreDesktopVisuals({ shadowLayerMask = 1, resumeQuality = false } = {}) {
  if (!xrVisualsActive) return;
  xrVisualsActive = false;
  xrVisualPreview = false;
  xrWorldTierActive = null;
  setXRMaterialVariants(false);
  applyXRMaterialVariants(scene, false);
  regionalRailwayTrack?.setMasonryRenderProfile({ tier: quality.tier.name });
  configureXRGrassPatches(false);
  setXRGrassPatchBudget(1);
  grassField.setXRActive(false);
  chunkMgr.setXRGrassActive(false);
  chunkMgr.setXRDetailBudget(null);
  chunkMgr.setTerrainMaterial();
  farTerrain.setSurfaceMaterial();
  xrShadowProxies?.setEnabled(false, chunkMgr, landmarks);
  rain.setXRScale(1);
  butterflies.setXRScale(1);
  fireflies.setXRScale(1);
  birds.setXRScale(1);
  sky.sun.shadow.camera.layers.mask = shadowLayerMask;
  xrRuntime.stop();
  xrVisualProfile = null;
  xrPerformance.telemetry.visuals = 'Phase 3 inactive';
  xrPerformance.telemetry.runtime = 'inactive';
  if (resumeQuality) {
    quality.setSuspended(false);
    quality.apply();
  }
}

xrRuntime.onChange = ({ stage }) => {
  if (xrVisualsActive) applyXRRuntimeStage(stage);
};
xrPerformance.onSample = (sample) => {
  if (!xrVisualsActive || xrVisualPreview) return;
  xrRuntime.sample(sample);
};

// --- grass shadow snapshot ----------------------------------------------------
// Ordinary scene shadows update at a perceptually smooth 20/30 Hz rather than
// display-frame rate. Grass keeps an even slower double-buffered cache and
// crossfades matrices/textures, preserving the stable shadow edge that fixed
// foliage flicker without copying a 2K/4K RGBA target every few metres.
sky.sun.shadow.autoUpdate = false;
sky.sun.shadow.needsUpdate = true;

let shadowPolicy = shadowPolicyForTier('high');
let activeShadowTierName = '';
let surfaceShadowElapsed = Infinity;
let surfaceShadowForce = true;
let surfaceShadowScheduledLastFrame = false;
let grassSnapshotRequested = true;
let grassShadowAge = Infinity;
let lastGrassSnapX = Infinity, lastGrassSnapZ = Infinity;
let grassShadowTargets = [null, null];
let grassShadowTargetIndex = -1;
let grassShadowMapSize = 0;
let hasGrassSnapshot = false;
let grassShadowBlend = 1;
const grassShadowMatrix = new THREE.Matrix4();
const previousGrassShadowMatrix = new THREE.Matrix4();
const grassShadowInfo = {
  texture: null,
  previousTexture: null,
  matrix: grassShadowMatrix,
  previousMatrix: previousGrassShadowMatrix,
  mapSize: 0,
  packed: true,
  blend: 1,
  range: 0,
  worldSize: 224,
  enabled: false,
};
const canRenderLinearShadowCache = renderer.capabilities.isWebGL2
  && renderer.extensions.has('EXT_color_buffer_float');
const shadowDebug = {
  surface: 'initializing…',
  grass: 'initializing…',
  surfaceUpdates: 0,
  grassUpdates: 0,
};
let shadowStatsElapsed = 0;
let shadowStatsSurface = 0;
let shadowStatsGrass = 0;
const shadowCopyScene = new THREE.Scene();
const shadowCopyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const shadowCopyMat = new THREE.ShaderMaterial({
  uniforms: {
    uSrc: { value: null },
    uSrcTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
    uPackedOutput: { value: canRenderLinearShadowCache ? 0 : 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float;
    varying vec2 vUv;
    uniform sampler2D uSrc;
    uniform vec2 uSrcTexel;
    uniform float uPackedOutput;
    float unpackDepth(vec4 rgba) {
      const float downscale = 255.0 / 256.0;
      return dot(rgba, downscale / vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0));
    }
    void main() {
      if (uPackedOutput > 0.5) {
        // Compatibility fallback: retain Three's exact packed representation.
        gl_FragColor = texture2D(uSrc, vUv);
        return;
      }
      // Conservative 2×2 depth reduction keeps narrow branches present when
      // the live 1024/2048 map resolves into the 512/1024 grass cache.
      vec2 h = uSrcTexel * 0.5;
      float d = min(
        min(unpackDepth(texture2D(uSrc, vUv + vec2(-h.x, -h.y))),
            unpackDepth(texture2D(uSrc, vUv + vec2( h.x, -h.y)))),
        min(unpackDepth(texture2D(uSrc, vUv + vec2(-h.x,  h.y))),
            unpackDepth(texture2D(uSrc, vUv + vec2( h.x,  h.y))))
      );
      gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
    }`,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending,
});
shadowCopyMat.toneMapped = false;
shadowCopyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowCopyMat));

function disposeGrassShadowTargets() {
  for (const target of grassShadowTargets) target?.dispose();
  grassShadowTargets = [null, null];
  grassShadowTargetIndex = -1;
  grassShadowMapSize = 0;
  hasGrassSnapshot = false;
  grassShadowBlend = 1;
  grassShadowInfo.texture = null;
  grassShadowInfo.previousTexture = null;
}

function makeGrassShadowTarget(size) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: canRenderLinearShadowCache ? THREE.RedFormat : THREE.RGBAFormat,
    type: canRenderLinearShadowCache ? THREE.FloatType : THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function applyRequestedShadowQuality() {
  if (!requestedShadowTier || requestedShadowTier.name === activeShadowTierName) return;
  activeShadowTierName = requestedShadowTier.name;
  shadowPolicy = requestedShadowTier.shadowPolicy
    || shadowPolicyForTier(activeShadowTierName);
  disposeGrassShadowTargets();
  surfaceShadowElapsed = Infinity;
  surfaceShadowForce = true;
  surfaceShadowScheduledLastFrame = false;
  grassSnapshotRequested = shadowPolicy.grassSize > 0;
  grassShadowAge = Infinity;
}

function snapshotGrassShadow(playerPos) {
  const map = sky.sun.shadow.map;
  const size = shadowPolicy.grassSize;
  if (!map || !sky.sun.castShadow || size <= 0) return false;
  if (grassShadowMapSize !== size) {
    disposeGrassShadowTargets();
    grassShadowTargets = [makeGrassShadowTarget(size), makeGrassShadowTarget(size)];
    grassShadowMapSize = size;
  }
  const previousIndex = grassShadowTargetIndex;
  const nextIndex = previousIndex < 0 ? 0 : 1 - previousIndex;
  shadowCopyMat.uniforms.uSrc.value = map.texture;
  shadowCopyMat.uniforms.uSrcTexel.value.set(
    1 / sky.sun.shadow.mapSize.x,
    1 / sky.sun.shadow.mapSize.y,
  );
  renderOffscreen(
    renderer, grassShadowTargets[nextIndex], shadowCopyScene, shadowCopyCam,
  );
  if (previousIndex >= 0) previousGrassShadowMatrix.copy(grassShadowMatrix);
  grassShadowMatrix.copy(sky.sun.shadow.matrix);
  grassShadowTargetIndex = nextIndex;
  grassShadowInfo.texture = grassShadowTargets[nextIndex].texture;
  grassShadowInfo.previousTexture = previousIndex >= 0
    ? grassShadowTargets[previousIndex].texture
    : grassShadowTargets[nextIndex].texture;
  if (previousIndex < 0) previousGrassShadowMatrix.copy(grassShadowMatrix);
  grassShadowBlend = previousIndex < 0 ? 1 : 0;
  hasGrassSnapshot = true;
  grassShadowAge = 0;
  lastGrassSnapX = playerPos.x;
  lastGrassSnapZ = playerPos.z;
  grassSnapshotRequested = false;
  shadowStatsGrass++;
  return true;
}

function snapSunShadowCamera(playerPos) {
  const cameraWidth = sky.sun.shadow.camera.right - sky.sun.shadow.camera.left;
  const worldTexel = cameraWidth / Math.max(1, sky.sun.shadow.mapSize.x);
  const snappedX = Math.round(playerPos.x / worldTexel) * worldTexel;
  const snappedZ = Math.round(playerPos.z / worldTexel) * worldTexel;
  const dx = snappedX - sky.sun.target.position.x;
  const dz = snappedZ - sky.sun.target.position.z;
  sky.sun.target.position.x += dx;
  sky.sun.target.position.z += dz;
  sky.sun.position.x += dx;
  sky.sun.position.z += dz;
}

function updateShadowSystem(dt, playerPos) {
  applyRequestedShadowQuality();
  const enabled = sky.sun.castShadow && shadowPolicy.surfaceHz > 0;
  if (!enabled) {
    grassShadowInfo.enabled = false;
    shadowDebug.surface = 'disabled';
    shadowDebug.grass = 'disabled';
    return;
  }
  snapSunShadowCamera(playerPos);
  surfaceShadowElapsed += dt;
  grassShadowAge += dt;
  grassShadowBlend = Math.min(1,
    grassShadowBlend + dt / Math.max(0.01, shadowPolicy.grassFade));

  if (grassSnapshotDue({
    hasSnapshot: hasGrassSnapshot,
    age: grassShadowAge,
    playerX: playerPos.x,
    playerZ: playerPos.z,
    anchorX: lastGrassSnapX,
    anchorZ: lastGrassSnapZ,
    policy: shadowPolicy,
  })) grassSnapshotRequested = true;

  // A map scheduled on the prior animation frame has now been rendered by the
  // main composer. Resolve grass from it before requesting another shadow pass,
  // keeping the two large GPU jobs off the same visual frame.
  let copiedGrass = false;
  if (surfaceShadowScheduledLastFrame) {
    surfaceShadowScheduledLastFrame = false;
    if (grassSnapshotRequested) copiedGrass = snapshotGrassShadow(playerPos);
  }

  if (!copiedGrass && surfaceShadowDue(
    surfaceShadowElapsed,
    shadowPolicy.surfaceHz,
    surfaceShadowForce,
  )) {
    const wasForced = surfaceShadowForce;
    sky.sun.shadow.needsUpdate = true;
    surfaceShadowScheduledLastFrame = true;
    surfaceShadowElapsed = consumeSurfaceShadowInterval(
      surfaceShadowElapsed, shadowPolicy.surfaceHz, wasForced,
    );
    surfaceShadowForce = false;
    shadowStatsSurface++;
  }

  grassShadowInfo.mapSize = grassShadowMapSize;
  grassShadowInfo.packed = !canRenderLinearShadowCache;
  grassShadowInfo.blend = grassShadowBlend;
  grassShadowInfo.range = shadowPolicy.grassRange;
  grassShadowInfo.enabled = hasGrassSnapshot;

  shadowStatsElapsed += dt;
  if (shadowStatsElapsed >= 1) {
    const inv = 1 / shadowStatsElapsed;
    shadowDebug.surfaceUpdates = +(shadowStatsSurface * inv).toFixed(1);
    shadowDebug.grassUpdates = +(shadowStatsGrass * inv).toFixed(2);
    shadowDebug.surface = `${sky.sun.shadow.mapSize.x}² · ${shadowDebug.surfaceUpdates}/s (${shadowPolicy.surfaceHz} cap)`;
    shadowDebug.grass = `${grassShadowMapSize || 0}² ${canRenderLinearShadowCache ? 'R32F' : 'RGBA8'} · ${shadowDebug.grassUpdates}/s · ${Math.round(grassShadowBlend * 100)}% blend`;
    shadowStatsElapsed = 0;
    shadowStatsSurface = 0;
    shadowStatsGrass = 0;
  }
}

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
function jumpToNearestCaveTrail(seaOnly = false) {
  const p = controls.rig.position;
  trailsAround(world, p.x, p.z, world.seed, 9000, caveTrailEdges);
  let best = null, bd = Infinity;
  for (const edge of caveTrailEdges) {
    if (!edge.toCave) continue;
    if (seaOnly && edge.toCave.kind !== 'sea-cave') continue;
    const d = (edge.toCave.x - p.x) ** 2 + (edge.toCave.z - p.z) ** 2;
    if (d < bd) { bd = d; best = edge; }
  }
  if (!best) {
    locationActions.current = `no ${seaOnly ? 'sea-cave cliff path' : 'cave trail'} within ~9 km`;
    return null;
  }
  // Approach from the landmark end (opposite the mouth) so the whole spur reads.
  const startX = best.caveEnd === 'to' ? best.curve.startX : best.curve.endX;
  const startZ = best.caveEnd === 'to' ? best.curve.startZ : best.curve.endZ;
  return placeDebugLocation({
    x: startX, z: startZ,
    tangentX: best.toCave.x - startX, tangentZ: best.toCave.z - startZ,   // face the mouth
  }, `${best.cliffPath ? 'cliff path to sea cave' : 'cave trail'}: ${best.routeClass}`);
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
// Spawn on the scenic trailhead itself — no auto-walk to a cave mouth (that
// search picked any cave-bound trail, sea caves included, which read as an
// unwanted relocation).
const spawn = trailheadLocation;
controls.place(spawn.x, spawn.z);
if (spawn.tangentX !== undefined) controls.yaw = Math.atan2(-spawn.tangentX, -spawn.tangentZ);

// The bounded Phase-1 laboratory still proves train motion and passenger
// camera behaviour. The regional system now owns the production alignment,
// earthworks and nearby track streaming; train transfer follows separately.
const railLab = new RailLaboratory(scene, world, controls, {
  near: spawn,
  onBeforeTravel: () => { if (cave.active) cave.exit(); },
});
regionalRailwayTrack = new RegionalRailwayTrack(scene, world);
regionalRailwayTrack.setMasonryRenderProfile({ tier: quality.tier.name });
const regionalRailwayService = new RegionalRailwayService(scene, world, controls, {
  // Route train sounds through the soundscape's master (limiter included)
  // once it has started; the rail audio falls back to the destination if not.
  audioBus: () => audio.master,
  onBeforeTravel: () => {
    if (railLab.riding) railLab.leave(false);
    if (cave.active) cave.exit();
  },
});
const regionalRailway = new RegionalRailwayPreview(scene, world, controls, {
  center: spawn,
  seed: world.seed,
  // A compact regional loop kept near spawn so a station is discoverable on
  // foot and the passenger service is rideable without debug teleports.
  radius: 1500,
  searchRadius: 1200,
  onBeforeTravel: () => {
    if (railLab.riding) railLab.leave(false);
    if (regionalRailwayService.riding) regionalRailwayService.leave(false);
    if (cave.active) cave.exit();
  },
  onAfterTravel: resumeDesktopAfterStationTravel,
  onTerrainPlan: (spec) => {
    if (spec && cave.active) cave.exit();
    if (!chunkMgr.setRailwayTerrain(spec)) return;
    farTerrain.needsRebuild = true;
    grassField.invalidateTerrain();
  },
  onTrackPlan: (plan) => regionalRailwayTrack.setPlan(plan),
  onTrackVisibility: (visible) => regionalRailwayTrack.setEnabled(visible),
  onServicePlan: (plan) => {
    regionalRailwayService.setPlan(plan);
    livingWorldPopulation.setPlan(plan);
    ensureNavGraph();
    // Lay the station villages out now, while the world is still generating.
    // Left to first touch this lands inside grass refresh on the main thread,
    // which is a hitch on approach to a village rather than a pause nobody is
    // present for. Same reasoning as the nav graph above.
    if (plan) {
      const started = performance.now();
      const villages = warmStationSettlementPlans(world, world.seed);
      if (villages) {
        console.info(`[settlements] ${villages} station villages laid out`
          + ` in ${Math.round(performance.now() - started)}ms`);
      }
    }
  },
});

// The landmark network travellers walk, built once.
//
// Gathered at TRAVEL scale rather than streaming scale, which is not a tuning
// choice: trailsAround returns edges touching the query area, so a small radius
// omits every link to a landmark just outside it. Measured on this world, a 5km
// gather sees 11 landmarks in 3 disconnected pieces while a 20km gather sees 272
// with 96% of them mutually reachable. A traveller routed on the cheap graph
// would be stranded by an artifact of the query radius rather than by the world.
//
// It costs a few hundred milliseconds, paid once while the world is still
// generating, which is the moment nobody is walking anywhere.
// In-world hours since the previous frame, taken from the sky's own time (0..1
// across a day) and handling the wrap at midnight.
let lastSkyTime = null;
function wrappedSkyHours(time) {
  if (lastSkyTime === null) { lastSkyTime = time; return 0; }
  let delta = time - lastSkyTime;
  if (delta < -0.5) delta += 1;      // midnight wrap
  lastSkyTime = time;
  return Math.max(0, delta) * 24;
}

const NAV_GRAPH_RADIUS = 20000;
let navGraph = null;
function ensureNavGraph() {
  if (navGraph) return navGraph;
  const started = performance.now();
  const navEdges = [];
  trailsAround(world, controls.rig.position.x, controls.rig.position.z,
    world.seed, NAV_GRAPH_RADIUS, navEdges);
  navGraph = buildNavGraph(navEdges);
  livingWorldPopulation.setNavGraph(navGraph);
  livingWorldPopulation.setRouteActionAnchors(navEdges);
  console.info(`[nav] ${navGraph.nodes.size} landmarks, ${navGraph.edgeCount} trails`
    + ` in ${Math.round(performance.now() - started)}ms`);
  return navGraph;
}

/**
 * Stand the player just behind an NPC that is walking somewhere, facing them.
 *
 * Behind rather than in front, and close: the point is to watch a journey and
 * follow it, so the traveller should be ahead of the player walking away, not
 * approaching and then passing.
 *
 * If nobody happens to be travelling, one is sent on its way rather than
 * reporting that none exists. Stays run up to 24 in-world hours, so "wait and
 * try again" is the usual answer and is indistinguishable from a broken button.
 */
function jumpToRandomNpc() {
  ensureNavGraph();
  const actor = livingWorldPopulation.travellerInTransit({ force: true });
  if (!actor) return null;
  const where = livingWorldPopulation.actorPosition(actor);
  const heading = actor.journey.heading;
  // The traveller's own direction of travel: (sin, cos) by the same convention
  // the rig and the trail frames use.
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const back = 6.5;      // far enough to see the whole body walking
  const side = 1.6;      // off the trail, so the player is not stood in its path
  const x = where.x - fx * back + fz * side;
  const z = where.z - fz * back - fx * side;
  controls.place(x, z);
  // Look at them: the rig's forward is (-sin yaw, -cos yaw).
  controls.yaw = Math.atan2(-(where.x - x), -(where.z - z));
  const name = actor.identity?.name || 'traveller';
  const destination = actor.journey.destKey || 'somewhere';
  console.info(`[npc] ${name} → ${destination}`
    + ` · ${actor.journey.phase} · ${Math.round(actor.journey.speed * 100) / 100} m/s`
    + ` · leg ${actor.journey.legIndex + 1}/${actor.journey.route?.legs.length ?? 1}`);
  if (!livingWorldPopulation.debug.enabled) {
    console.warn('[npc] living world is disabled — the traveller will not be drawn');
  }
  return { x, z, label: `${name} → ${destination}` };
}

function placeDebugLocation(location, label, randomYaw = false) {
  if (!location) return null;
  if (railLab.riding) railLab.leave(false);
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
  const coastTarget = target && target.startsWith('coast-') ? target.slice(6) : null;
  for (let attempt = 0; attempt < (coastTarget ? 12000 : 4000); attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * radius;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    const biome = world.biomeAt(x, z);
    const matches = target === null
      || (coastTarget
        ? biome.coastType === coastTarget && biome.h > 0.8 && biome.h < 24
        : (target === 'mountain' ? biome.h > 120 : biome.id === target));
    if (!matches || biome.id === 'ocean' || biome.h < 1.5 || biome.slope > 0.32) continue;
    const river = world.riverAt(x, z);
    if (river.wet && river.depth > 0.04) continue;
    if (coastTarget) {
      const probes = [[28, 0], [-28, 0], [0, 28], [0, -28]];
      let sea = null, lowest = Infinity;
      for (const [dx, dz] of probes) {
        const ph = world.height(x + dx, z + dz);
        if (ph < lowest) { lowest = ph; sea = { dx, dz }; }
      }
      if (!sea || lowest >= 0.15) continue;
      return { x, z, h: biome.h, tangentX: sea.dx, tangentZ: sea.dz };
    }
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

function jumpToNearestSettlement() {
  const p = controls.rig.position;
  const site = nearestSettlement(world, p.x, p.z, world.seed, 8);
  if (!site) return null;
  const distance = site.radius * 0.82 + 7;
  return placeDebugLocation({
    x: site.x + Math.cos(site.yaw) * distance,
    z: site.z + Math.sin(site.yaw) * distance,
    tangentX: -Math.cos(site.yaw), tangentZ: -Math.sin(site.yaw),
  }, `settlement: ${site.kind}`);
}

// nearest standard landmark of one type, searching outward ring by ring
function jumpToNearestOfType(type, label, approachDistance = 16, excludeKeys = null) {
  const p = controls.rig.position;
  const ci0 = Math.floor(p.x / LM_CELL), cj0 = Math.floor(p.z / LM_CELL);
  for (let r = 0; r <= 40; r++) {
    let best = null, bd = Infinity;
    for (let cj = cj0 - r; cj <= cj0 + r; cj++) {
      for (let ci = ci0 - r; ci <= ci0 + r; ci++) {
        if (Math.max(Math.abs(ci - ci0), Math.abs(cj - cj0)) !== r) continue;
        const lm = landmarkForCell(world, ci, cj, world.seed);
        if (!lm || lm.type !== type) continue;
        if (excludeKeys?.has(lm.key)) continue;
        const d = (lm.x - p.x) ** 2 + (lm.z - p.z) ** 2;
        if (d < bd) { bd = d; best = lm; }
      }
    }
    if (best) {
      const s = Math.SQRT1_2 * approachDistance;
      const location = placeDebugLocation({
        x: best.x + s, z: best.z + s,
        tangentX: -Math.SQRT1_2, tangentZ: -Math.SQRT1_2,   // face the landmark
      }, label);
      return location ? { ...location, landmark: best } : null;
    }
  }
  return null;
}

// A stateful landmark review route. The ordinary nearest lookup would keep
// selecting the tree the player is already standing beside; retaining visited
// keys lets the debug button advance through distinct specimens indefinitely.
const greatTreeReview = { visited: new Set(), index: 0 };
function jumpToGreatTree(reset = false) {
  if (reset) {
    greatTreeReview.visited.clear();
    greatTreeReview.index = 0;
  }
  let result = jumpToNearestOfType('giant', 'Great Tree', 42, greatTreeReview.visited);
  if (!result && greatTreeReview.visited.size > 0) {
    // The world is infinite, but reset gracefully if a custom seed produces no
    // unseen tree within the 40-cell review radius.
    greatTreeReview.visited.clear();
    greatTreeReview.index = 0;
    result = jumpToNearestOfType('giant', 'Great Tree', 42, greatTreeReview.visited);
  }
  if (!result) return null;
  greatTreeReview.visited.add(result.landmark.key);
  greatTreeReview.index++;
  const form = greatTreeArchetype(result.landmark.seed).replace('open', 'open-grown');
  locationActions.lastLabel = `Great Tree ${greatTreeReview.index} · ${form}`;
  locationActions.refresh();
  return result;
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
    if (this.choice === 'rail-lab') {
      const result = railLab.jumpToLab();
      this.lastLabel = 'Phase-1 rail laboratory';
      this.refresh();
      return result;
    }
    if (this.choice === 'regional-railway') {
      const result = regionalRailway.jumpToPlan();
      this.lastLabel = 'regional railway station';
      this.refresh();
      return result;
    }
    if (this.choice === 'trail-stepping') return placeDebugLocation(trailCrossingLocations.stepping, 'trail stepping stones');
    if (this.choice === 'trail-log') return placeDebugLocation(trailCrossingLocations.log, 'trail log crossing');
    if (this.choice === 'trail-bridge') return placeDebugLocation(trailCrossingLocations.bridge, 'trail plank bridge');
    if (this.choice === 'random-npc') {
      const result = jumpToRandomNpc();
      this.lastLabel = result ? `NPC — ${result.label}` : 'no travellers available yet';
      this.refresh();
      return result;
    }
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
    if (this.choice === 'sea-cave-path') return jumpToNearestCaveTrail(true);
    if (this.choice === 'nearest-landmark') return jumpToNearestLandmark();
    if (this.choice === 'nearest-settlement') return jumpToNearestSettlement();
    if (this.choice === 'great-tree') {
      const result = jumpToGreatTree(true);
      if (!result) this.current = 'no Great Tree found nearby';
      return result;
    }
    if (this.choice === 'next-great-tree') {
      const result = jumpToGreatTree(false);
      if (!result) this.current = 'no Great Tree found nearby';
      return result;
    }
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
  railLab() { this.choice = 'rail-lab'; return this.go(); },
  regionalRailway() { this.choice = 'regional-railway'; return this.go(); },
  caveTrail() { this.choice = 'nearest-cave-trail'; return this.go(); },
  seaCavePath() { this.choice = 'sea-cave-path'; return this.go(); },
  steppingCrossing() { this.choice = 'trail-stepping'; return this.go(); },
  logCrossing() { this.choice = 'trail-log'; return this.go(); },
  plankBridge() { this.choice = 'trail-bridge'; return this.go(); },
  randomNpc() { this.choice = 'random-npc'; return this.go(); },
  cave() { this.choice = 'cave-spike'; return this.go(); },
  greatTree() { this.choice = 'great-tree'; return this.go(); },
  nextGreatTree() { this.choice = 'next-great-tree'; return this.go(); },
  watchtower() { this.choice = 'watchtower'; return this.go(); },
  lighthouse() { this.choice = 'lighthouse'; return this.go(); },
  settlement() { this.choice = 'nearest-settlement'; return this.go(); },
};
locationActions.refresh();

// Stable scene setup for headset performance comparisons. The measurement
// runner deliberately lives outside the scene systems: it only orchestrates
// existing travel/weather controls and samples the same frame telemetry used
// by the XR runtime governor.
let denseMeadowBenchmarkLocation = null;
function findDenseMeadowBenchmarkLocation() {
  if (denseMeadowBenchmarkLocation) return denseMeadowBenchmarkLocation;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let best = null;
  for (let i = 1; i <= 2400; i++) {
    const distance = 140 + Math.sqrt(i / 2400) * 7200;
    const angle = i * goldenAngle + (world.seed % 997) * 0.001;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const biome = world.biomeAt(x, z);
    if (biome.id !== 'grassland' || biome.h < 2 || biome.h > 38
        || biome.slope > 0.13 || world.riverAt(x, z).wet) continue;
    const openness = world.openFactor(x, z);
    const grove = world.groveFactor(x, z);
    const score = openness * 2.2 - grove * 1.4 - biome.slope * 7
      - Math.abs(biome.h - 16) * 0.012;
    if (!best || score > best.score) best = { x, z, h: biome.h, score };
  }
  denseMeadowBenchmarkLocation = best || trailheadLocation;
  return denseMeadowBenchmarkLocation;
}

function prepareQuestBenchmarkScene(benchmarkScene) {
  if (railLab.riding) railLab.leave(false);
  if (regionalRailwayService.riding) regionalRailwayService.leave(false);
  if (cave.active) cave.exit();
  carriedLantern.setEnabled(false);
  weather.setForcedMistyDawn(false);

  if (benchmarkScene.id === 'dense-meadow') {
    weather.setForced('clear');
    sky.time = 0.50;
    return placeDebugLocation({
      ...findDenseMeadowBenchmarkLocation(), tangentX: 0.707, tangentZ: -0.707,
    }, 'Quest benchmark · dense meadow');
  }
  if (benchmarkScene.id === 'storm-water') {
    weather.setForced('storm');
    sky.time = 0.58;
    return placeDebugLocation(trailCrossingLocations.stepping,
      'Quest benchmark · storm / water');
  }
  if (benchmarkScene.id === 'station-train') {
    weather.setForced('scattered');
    sky.time = 0.44;
    regionalRailway.generate();
    return regionalRailway.jumpToPlan();
  }
  if (benchmarkScene.id === 'cave-lantern') {
    weather.setForced('clear');
    sky.time = 0.02;
    carriedLantern.setEnabled(true);
    return cave.reviewEntranceLighting();
  }
  throw new Error(`Unknown benchmark scene: ${benchmarkScene.id}`);
}

function questBenchmarkContext() {
  let gpu = 'unknown';
  try {
    const gl = renderer.getContext();
    gpu = gl.getParameter(gl.RENDERER) || gpu;
  } catch (error) { /* renderer metadata is optional */ }
  const profile = xrPerformance.activeProfile || xrPerformance.selectedProfile;
  return {
    userAgent: navigator.userAgent,
    gpu,
    worldSeed: world.seed,
    profile: profile.name,
    worldTier: xrWorldDebug.tier,
    framebufferScale: profile.framebufferScale,
    foveation: (() => {
      try { return renderer.xr.getFoveation(); } catch (error) { return profile.foveation; }
    })(),
    refreshRate: xrPerformance.telemetry.refreshRate,
    runtimeMode: xrRuntime.debug.mode,
    runtimeStage: xrRuntime.stage?.label || xrRuntime.debug.stage,
    position: {
      x: Math.round(controls.rig.position.x),
      y: Math.round(controls.rig.position.y),
      z: Math.round(controls.rig.position.z),
    },
    weather: weather.current?.archetype || 'unknown',
    clock: sky.clockString(),
    lanternEnabled: carriedLantern.enabled,
    caveActive: cave.active,
    xrExperiments: xrExperiments.snapshot(),
  };
}

function beginControlledQuestBenchmark() {
  const snapshot = {
    runtimeMode: xrRuntime.mode,
    inputLocked: controls.inputLocked,
  };
  controls.setInputLocked(true);
  xrRuntime.setMode('recovery');
  return snapshot;
}

function endControlledQuestBenchmark(snapshot) {
  if (!snapshot) return;
  controls.setInputLocked(snapshot.inputLocked);
  xrRuntime.setMode(snapshot.runtimeMode);
}

const questBenchmark = new QuestBenchmarkRunner({
  prepareScene: prepareQuestBenchmarkScene,
  canRun: () => renderer.xr.isPresenting && xrPerformance.presenting,
  isSceneReady: () => chunkMgr.pendingNearby() === 0 && chunkMgr.results.length === 0,
  beginControlledRun: beginControlledQuestBenchmark,
  endControlledRun: endControlledQuestBenchmark,
  context: questBenchmarkContext,
});
const xrExperiments = new XRExperimentController({
  renderer,
  actionHud: xrActionHud,
  xrPerformance,
  threeRevision: THREE.REVISION,
  isSceneBenchmarkRunning: () => questBenchmark.running,
});
questBenchmark.onComplete = (report) => {
  console.log('Quest benchmark complete', report);
  console.table(report.results.map((result) => ({
    scene: result.label,
    fps: result.averageFps,
    missed: `${result.missedPercent}%`,
    cpuP95: result.cpuMs?.p95,
    gpuP95: result.gpuMs?.p95 ?? 'unsupported',
    callsP95: result.render?.p95DrawCalls,
    trianglesP95: result.render?.p95Triangles,
  })));
  if (report.aggregates?.length) console.table(report.aggregates);
};

setupDebugGUI({
  post, sky, weather, rain, quality, chunkMgr, locationActions, renderer, controls,
  cave, carriedLantern, animals, railLab, regionalRailway, regionalRailwayTrack,
  regionalRailwayService, livingWorldPopulation,
  shadowDebug, grassTrailDebug: grassField.trailDebug, xrPerformance, xrRuntime,
  xrBenchmark: questBenchmark,
  xrGrassFieldDebug: grassField.xrDebug,
  xrMaterialVariantDebug,
  xrWorldDebug,
  xrExperiments,
});

// --- UI -----------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start-button');
const statusEl = document.getElementById('status');
const hud = document.getElementById('hud');
const underwaterEl = document.getElementById('underwater');
const comfortEl = document.getElementById('weather-comfort');
const gentleRainEl = document.getElementById('gentle-rain');
const muteThunderEl = document.getElementById('mute-thunder');
const livingWorldSettingsEl = document.getElementById('living-world-setting');
const livingWorldAIEl = document.getElementById('living-world-ai');
const xrSettingsEl = document.getElementById('xr-profile-settings');
const xrProfileEl = document.getElementById('xr-profile');
const requestedQuestBenchmark = new URLSearchParams(window.location.search)
  .get('questBenchmark');
const xrProfileNoteEl = document.getElementById('xr-profile-note');
let started = false;

const updateXRProfileUI = ({ name, profile, pending = false }) => {
  xrProfileEl.value = name;
  xrProfileNoteEl.textContent = pending
    ? `${profile.label} will apply to the next VR session`
    : `${profile.label} · ${profile.framebufferScale.toFixed(2)}× eye buffer · ${profile.preferredFrameRate} Hz target`;
};
xrPerformance.onSelectionChange = updateXRProfileUI;
updateXRProfileUI({ name: xrPerformance.selectedName, profile: xrPerformance.selectedProfile });
xrSettingsEl.addEventListener('click', (event) => event.stopPropagation());
xrProfileEl.addEventListener('change', () => xrPerformance.selectProfile(xrProfileEl.value));

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
livingWorldSettingsEl.addEventListener('click', (event) => event.stopPropagation());
livingWorldAIEl.checked = savedBool('wander.livingWorld.ai', false);
// Some Chrome builds can stall inside the native availability probe. Never
// touch the model API during world startup: feature-detect synchronously, then
// create the model only from an explicit, opted-in opening gesture.
if ('LanguageModel' in globalThis) {
  livingWorldDirector.availabilityState = 'optional';
  updateLivingWorldModelStatus({ state: 'optional' });
} else {
  livingWorldDirector.availabilityState = 'unsupported';
  updateLivingWorldModelStatus({ state: 'unsupported' });
}
livingWorldAIEl.addEventListener('change', () => {
  try {
    localStorage.setItem('wander.livingWorld.ai', String(livingWorldAIEl.checked));
  } catch (error) { /* optional */ }
  // The checkbox is its own explicit gesture. Use it to begin any required
  // model download so the later click-to-walk gesture can be reserved for
  // pointer lock.
  livingWorldDirector.initializeFromUserGesture(livingWorldAIEl.checked);
});
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
  desktopUiState = 'resuming';
  overlay.classList.add('hidden');
  controls.suspendInput();
  try {
    // Pointer lock must be the first activation-gated operation in this click.
    // LanguageModel.create() may also require the same transient activation.
    notePointerLockRequest('overlay-click');
    const request = renderer.domElement.requestPointerLock?.();
    request?.catch?.(handlePointerLockFailure);
  } catch (error) {
    handlePointerLockFailure(error);
  }
  await audio.start();
});

document.addEventListener('pointerlockchange', () => {
  if (renderer.xr.isPresenting) return;
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked) {
    pointerLockDebug.lastUnlockAt = pointerLockNow();
    pointerLockDebug.lastUnlockState = desktopUiState;
    console.log('[pointerlock] unlocked', { desktopUiState });
  }
  if (locked) {
    if (desktopUiState === 'npc-resuming') livingWorldPopulation.completeDialogueClose();
    desktopUiState = 'playing';
    overlay.classList.add('hidden');
    controls.enabled = true;
    controls.allowLook = false;
    renderer.domElement.focus?.({ preventScroll: true });
    // A persisted AI preference may not have initialized during this page
    // visit. Wait until pointer lock is confirmed so model creation can never
    // race or consume the click-to-walk activation first.
    if (livingWorldAIEl.checked && !livingWorldDirector.aiReady) {
      livingWorldDirector.initializeFromUserGesture(true);
    }
    return;
  }
  if (desktopUiState === 'npc-dialogue') {
    overlay.classList.add('hidden');
    controls.suspendInput();
    livingWorldPopulation.setPointerReleased();
    return;
  }
  if (desktopUiState === 'npc-resuming') {
    overlay.classList.add('hidden');
    controls.suspendInput();
    return;
  }
  if (started) {
    desktopUiState = 'paused';
    overlay.classList.remove('hidden');
    controls.suspendInput();
    startButton.focus({ preventScroll: true });
  }
});
document.addEventListener('pointerlockerror', handlePointerLockFailure);
let desktopRenderSnapshot = null;
renderer.xr.addEventListener('sessionstart', async () => {
  // The mobile page may have loaded at a desktop low tier. Preserve it exactly
  // and freeze its adaptive controller; XR profile policy is independent.
  desktopRenderSnapshot = {
    qualityLevel: quality.level,
    qualityLocked: quality.locked,
    qualitySuspended: quality.suspended,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    sunShadowLayerMask: sky.sun.shadow.camera.layers.mask,
    xrPreviewProfile: xrVisualPreview ? xrVisualProfile?.name : null,
  };
  livingWorldPopulation.abandonDialogue({ notify: false });
  desktopUiState = 'xr';
  quality.setSuspended(true);
  started = true;
  overlay.classList.add('hidden');
  controls.enabled = true;
  xrActionHud.setActive(true);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // VR renders direct (no post grade)
  const xrSession = renderer.xr.getSession();
  const xrPerformanceStart = xrPerformance.startSession(xrSession);
  const xrExperimentStart = xrExperiments.startSession(xrSession);
  applyXRVisualProfile(xrPerformance.selectedProfile);
  await Promise.all([
    xrPerformanceStart,
    xrExperimentStart,
    audio.start(),
  ]);
  if (requestedQuestBenchmark) {
    if (requestedQuestBenchmark === 'suite') questBenchmark.startSuite();
    else questBenchmark.startScene(requestedQuestBenchmark);
  }
});
renderer.xr.addEventListener('sessionend', () => {
  const previewProfile = desktopRenderSnapshot?.xrPreviewProfile || null;
  restoreDesktopVisuals({
    shadowLayerMask: desktopRenderSnapshot?.sunShadowLayerMask ?? 1,
  });
  xrExperiments.endSession();
  xrActionHud.setActive(false);
  questBenchmark.stop('XR session ended');
  xrPerformance.endSession();
  if (desktopRenderSnapshot) {
    quality.level = desktopRenderSnapshot.qualityLevel;
    quality.locked = desktopRenderSnapshot.qualityLocked;
    renderer.toneMapping = desktopRenderSnapshot.toneMapping;
    renderer.toneMappingExposure = desktopRenderSnapshot.toneMappingExposure;
    quality.setSuspended(desktopRenderSnapshot.qualitySuspended);
    quality.apply();
    desktopRenderSnapshot = null;
    if (previewProfile) {
      quality.setSuspended(true);
      applyXRVisualProfile(xrProfileForName(previewProfile), { preview: true });
    }
  } else {
    renderer.toneMapping = THREE.NoToneMapping;
    quality.setSuspended(false);
  }
  desktopUiState = 'paused';
  controls.suspendInput();
  overlay.classList.remove('hidden');
  startButton.focus({ preventScroll: true });
});

// `?xrPreview=painterly` / `?xrPreview=survival` is an explicit desktop A/B
// harness. It exercises the Phase-2 materials and geometry through the normal
// browser renderer, while an unadorned URL remains the untouched desktop path.
const xrPreviewName = new URLSearchParams(window.location.search).get('xrPreview');
if (xrPreviewName) {
  quality.setSuspended(true);
  applyXRVisualProfile(xrProfileForName(xrPreviewName), { preview: true });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});

// --- main loop ------------------------------------------------------------------

let ready = false;
let hudTimer = 0;
// Bring the regional passenger service to life a moment after the world settles,
// so a running train and a discoverable station exist without debug controls.
let autoRailTimer = -1;
let autoRailDone = false;
const eyePos = new THREE.Vector3();
let previousFrameSeconds = performance.now() / 1000;
let elapsedFrameSeconds = 0;

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

// Open-coast probe kept separate from generic near-water so the soundscape can
// distinguish ocean breakers from river noise. The low-altitude gate excludes
// most incised inland channels whose carved floors happen to cross sea level.
function coastProximity(px, pz, altitude) {
  if (altitude > 36) return 0;
  let near = 0;
  for (const r of [8, 28, 65, 115]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = px + Math.cos(a) * r, sz = pz + Math.sin(a) * r;
      if (world.height(sx, sz) < WATER_LEVEL + 0.12 && !world.riverAt(sx, sz).wet) {
        near = Math.max(near, 1 - r / 140);
      }
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

let slowProbe = { nearWater: 0, coast: 0, caveWater: 0, forest: 0, biome: null, river: { near: 0, flow: 0, fall: 0 }, timer: 0 };

renderer.setAnimationLoop(() => {
  const frameCpuStart = performance.now();
  renderer.info.reset();
  const frameSeconds = frameCpuStart / 1000;
  const dt = Math.min(Math.max(0, frameSeconds - previousFrameSeconds), 0.1);
  previousFrameSeconds = frameSeconds;
  elapsedFrameSeconds += dt;
  const t = elapsedFrameSeconds;

  controls.update(dt);
  carriedLantern.update(dt, t, {
    togglePressed: controls.lanternTogglePressed,
    allowDynamicShadows: xrWorldTierActive
      ? xrWorldTierActive.shadowSize > 0
      : quality.tier.shadowSize > 0,
  });
  railLab.update(dt);
  cave.update(dt);
  const px = controls.rig.position.x, pz = controls.rig.position.z;

  chunkMgr.update(px, pz);
  regionalRailwayTrack.update(px, pz);
  regionalRailwayService.update(dt, controls.rig.position, ready, sky.nightAmt);
  // Loitering is specified in in-world HOURS, and passing seconds here is how a
  // 24-hour stay silently becomes a 24-second one. Read from the sky's own clock
  // rather than recomputed from dt: night runs 3.5x faster, and a second copy of
  // that rule would drift from the sky the moment either changed.
  const skyHours = wrappedSkyHours(sky.time);
  livingWorldPopulation.update(dt, controls.rig.position, {
    hours: skyHours,
    active: ready && started
      && (controls.enabled || desktopUiState === 'npc-dialogue' || desktopUiState === 'npc-resuming')
      && !regionalRailwayService.riding
      && !cave.active && !renderer.xr.isPresenting,
    allowAI: started && !renderer.xr.isPresenting,
    xr: renderer.xr.isPresenting,
  });
  settlementSystem.update(dt, controls.rig.position, {
    hours: livingWorldPopulation.worldState.clock.worldHours,
    active: ready && started && !cave.active,
  });
  xrActionHud.update(regionalRailwayService.interactionCue, dt);
  farTerrain.update(px, pz);
  landmarks.update(px, pz);
  if (!ready && chunkMgr.pendingNearby() === 0 && chunkMgr.chunks.size > 8) {
    ready = true;
    statusEl.textContent = 'ready — click to walk';
    autoRailTimer = 2.0;
  }
  if (!autoRailDone && autoRailTimer > 0) {
    autoRailTimer -= dt;
    if (autoRailTimer <= 0) {
      autoRailDone = true;
      regionalRailway.generate();
    }
  }

  // Weather supplies the prevailing wind before the sky moves its cloud pools;
  // the clock is at most one frame behind here, imperceptible on hour-long
  // transitions and exactly continuous at the shared midnight boundary.
  weather.update(sky.dayIndex, sky.time, sky.sunElevation, sky.moonIllum);
  updateWind(dt, weather.current);
  sky.update(dt, controls.rig.position, weather.current);
  updateShadowSystem(dt, controls.rig.position);
  const caveAtmosphere = cave.updateAtmosphere(
    dt, sky, weather.current, scene.fog, carriedLantern,
  );
  // Railway tunnels share the cave's underground signal: merging here dims
  // exposure, closes fog, quiets rain/birdsong and mutes surface audio for
  // every consumer below, exactly as a cave does.
  regionalRailwayTrack.updateTunnelPresence(dt, controls, cave.active, scene.fog, caveAtmosphere);
  if (controls.xrActions.mountPressed) {
    horseRiding.toggle(animals.liveAgents(), controls.rig.position);
  }
  if (horseRiding.riding) {
    // Halved in a headset: the same throw that reads as a horse on a monitor is
    // a moving horizon under a visor, and the head is already free to move.
    if (horseRiding.jostleScale > 0) horseRiding.jostleScale = renderer.xr.isPresenting ? 0.5 : 1;
    horseRiding.drive({
      forwardKey: controls.keys.has('KeyW') || controls.keys.has('ArrowUp'),
      backKey: controls.keys.has('KeyS') || controls.keys.has('ArrowDown'),
      leftKey: controls.keys.has('KeyA') || controls.keys.has('ArrowLeft'),
      rightKey: controls.keys.has('KeyD') || controls.keys.has('ArrowRight'),
      sprintKey: controls.keys.has('ShiftLeft') || controls.keys.has('ShiftRight')
        || controls.xrActions.sprintHeld,
      stickX: controls.xrActions.stickX,
      stickY: controls.xrActions.stickY,
    });
  }
  animals.update(dt, controls.rig.position, caveAtmosphere.factor, ready);
  // Seat follows the horse once it has actually stepped.
  if (horseRiding.riding) horseRiding.carry(dt);
  updateWaterCommon(dt, sky, scene.fog, weather.current);
  water.update(dt, controls.rig.position);
  grassField.update(dt, controls.rig.position, grassShadowInfo);
  if (xrVisualsActive) {
    updateXRGrassPatches(controls.rig.position, dt);
    xrShadowProxies.update(dt, landmarks);
  }
  rain.update(dt, controls.rig.position, weather.current, sky, scene.fog, caveAtmosphere.factor);
  butterflies.update(dt, controls.rig.position, sky.sunElevation, weather.current, caveAtmosphere.factor);
  fireflies.update(dt, controls.rig.position, sky, weather.current, caveAtmosphere.factor);
  birds.update(dt, controls.rig.position, sky, weather.current, caveAtmosphere.factor);
  lighthouseFx.update(dt, controls.rig.position, sky, weather.current, landmarks);
  updateWaterfall(dt, sky, scene.fog);
  updateAtmosphere(dt, sky, scene.fog, weather.current,
    slowProbe.biome ? slowProbe.biome.h : 0, caveAtmosphere.factor);
  cloudShadows.update(renderer, controls.rig.position, dt);
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
    slowProbe.coast = coastProximity(px, pz, slowProbe.biome.h);
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
      coastPresence: slowProbe.coast * surfacePresence,
      coastExposure: ({ dune: 0.72, shingle: 0.92, rocky: 1.18, chalk: 1.28 })[b.coastType] || 0.82,
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
      // Asked of the player, not of the map: this used to test the terrain and
      // river beneath their feet with no regard for the bridge they were
      // standing on, so every crossing splashed.
      wading: controls.wading,
    }, controls.consumeFootstep());
  }

  // Underwater tint belongs to the actual surface ocean/river volume. A sea
  // cave can descend below the global sea-level plane while its passage is
  // still dry; using eyeWorldY alone used to switch a blue fullscreen overlay
  // on at that invisible plane. Cave atmosphere target/factor identifies the
  // throat before the portal boolean changes and eases the overlay away.
  controls.eyeWorldPosition(eyePos);
  const seaDepth = WATER_LEVEL - eyePos.y;
  const riverDepth = river.wet ? river.y - eyePos.y : -Infinity;
  const waterOverlayOpacity = surfaceWaterOverlayOpacity(
    Math.max(seaDepth, riverDepth),
    caveAtmosphere.factor,
    caveAtmosphere.target,
    cave.inside,
  );
  underwaterEl.style.display = waterOverlayOpacity > 0.001 ? 'block' : 'none';
  underwaterEl.style.opacity = waterOverlayOpacity.toFixed(3);

  quality.tick(dt);

  hudTimer -= dt;
  if (hudTimer <= 0 && b) {
    hudTimer = 0.5;
    const xrFps = xrPerformance.telemetry.fps || quality.fps;
    const qualityLabel = renderer.xr.isPresenting
      ? `VR ${xrPerformance.label}` : quality.tier.name;
    // Naming the village you are standing in, on the tighter 0.62 halo: the
    // full radius reaches a couple of fields out, and a place should announce
    // itself when you are in it rather than when you can see it.
    const here = settlementPlaceAt(controls.rig.position.x, controls.rig.position.z, 0.62);
    hud.innerHTML =
      `${Math.round(renderer.xr.isPresenting ? xrFps : quality.fps)} fps · ${qualityLabel}<br/>` +
      `${here ? `${here.name} · ` : ''}${b.id} · ${Math.round(b.h)}m · ${b.t.toFixed(0)}°C · ${sky.clockString()}`;
  }

  // VR can't use the post pipeline (it breaks XR's direct framebuffer) → render
  // direct; otherwise run the composer (SSAO + bloom + tonemap/grade).
  if (renderer.xr.isPresenting) {
    const surfaceExposure = renderer.toneMappingExposure;
    renderer.toneMappingExposure = surfaceExposure * caveAtmosphere.exposureScale;
    xrExperiments.beforeXRRender(renderer.xr.getFrame());
    xrPerformance.beginGpuFrame();
    try {
      xrExperiments.renderXR(scene, camera, renderer.xr.getFrame());
    } finally {
      xrPerformance.endGpuFrame();
    }
    renderer.toneMappingExposure = surfaceExposure;
    const cpuMs = performance.now() - frameCpuStart;
    xrPerformance.tick(dt, cpuMs, renderer.info);
    questBenchmark.tick(dt, {
      cpuMs,
      gpuMs: xrPerformance.telemetry.gpuMs,
      gpuSampleSerial: xrPerformance.telemetry.gpuSampleSerial,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      refreshRate: xrPerformance.telemetry.refreshRate,
      runtimeStage: xrRuntime.stage?.label || xrRuntime.debug.stage,
    });
  } else {
    post.update(renderer.toneMappingExposure, sky.sunElevation, sky.duskWarmthScale, weather.current, dt, sky, caveAtmosphere);
    post.render();
  }
});

// console handle for debugging / exploring: __wander.teleport(x, z)
window.__wander = {
  world, controls, sky, weather, wind: windUniforms, quality, xr: xrPerformance, chunkMgr, water, farTerrain, impostors, audio, landmarks, post, scene, shadows: shadowDebug, cloudShadows, grassTrails: grassField.trailDebug,
  rain, cave, animals, lantern: carriedLantern, horseRiding,
  railway: railLab, regionalRailway, regionalRailwayTrack, regionalRailwayService,
  livingWorld: livingWorldPopulation,
  settlements: settlementSystem,
  comfort,
  walkableSurface,
  structureCollision,
  pointerLock: {
    debug: pointerLockDebug,
    get state() { return desktopUiState; },
    get locked() { return document.pointerLockElement === renderer.domElement; },
  },
  xrBenchmark: questBenchmark,
  xrExperiments,
  locations: locationActions,
  homeLocation,
  homeSurfaceLocation,
  trailheadLocation,
  trailCrossingLocations,
  butterflies, fireflies, birds, lighthouseFx,
  xrPhase2: {
    get active() { return xrVisualsActive; },
    get previewing() { return xrVisualPreview; },
    get grassPatches() {
      return {
        ...chunkMgr.xrGrassDebug,
        ...xrGrassPatchDebug,
        compactField: { ...grassField.xrDebug },
        materials: { ...xrMaterialVariantDebug },
        world: { ...xrWorldDebug },
      };
    },
    get proxyShadows() { return xrShadowProxies?.debug || null; },
    preview: (profileName = 'painterly') => {
      quality.setSuspended(true);
      applyXRVisualProfile(xrProfileForName(profileName), { preview: true });
      return xrPerformance.telemetry.visuals;
    },
    restoreDesktop: () => {
      restoreDesktopVisuals({ resumeQuality: true });
      return 'desktop visuals restored';
    },
  },
  xrPhase3: {
    runtime: xrRuntime.debug,
    setMode: (mode = 'auto') => xrRuntime.setMode(mode),
    get stage() { return xrRuntime.stage; },
    get lastSessionReport() { return xrPerformance.lastSessionReport; },
  },
  // debug: freeze the clock at a time-of-day and pump every per-frame sky/light
  // update with dt=0, so a screenshot renders a faithful frame even when the
  // preview tab is backgrounded and the rAF loop is throttled.
  tick: (t) => {
    if (t !== undefined) sky.time = t;
    const pos = controls.rig.position;
    weather.update(sky.dayIndex, sky.time, sky.sunElevation, sky.moonIllum);
    updateWind(0, weather.current);
    sky.update(0, pos, weather.current);
    const caveAtmosphere = cave.updateAtmosphere(
      0.5, sky, weather.current, scene.fog, carriedLantern,
    );
    updateWaterCommon(0, sky, scene.fog, weather.current);
    updateAtmosphere(0, sky, scene.fog, weather.current,
      slowProbe.biome ? slowProbe.biome.h : 0, caveAtmosphere.factor);
    cloudShadows.update(renderer, pos, 0, true);
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
  toRailLab: () => locationActions.railLab(),
  toRegionalRailway: () => locationActions.regionalRailway(),
  toSteppingCrossing: () => locationActions.steppingCrossing(),
  toLogCrossing: () => locationActions.logCrossing(),
  toPlankBridge: () => locationActions.plankBridge(),
  toLandmark: jumpToNearestLandmark,
  toSettlement: jumpToNearestSettlement,
  toGreatTree: () => jumpToGreatTree(true),
  nextGreatTree: () => jumpToGreatTree(false),
  toWatchtower: () => jumpToNearestOfType('tower', 'watchtower ruin'),
  toLighthouse: jumpToNearestLighthouse,
  toTrail: jumpToNearestTrail,
  toCaveTrail: jumpToNearestCaveTrail,
  randomLocation: () => locationActions.randomJump(),
  showAnimal: (species = 'whitetail') => animals.preview(species, controls.rig.position, controls.yaw),
  showAnimals: () => animals.previewAll(controls.rig.position, controls.yaw),
};
