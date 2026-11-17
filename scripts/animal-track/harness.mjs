// Shared pieces of the headless wildlife-and-railway simulation: a world with
// the game's railway, the game's AnimalSystem spawning, and the game's
// AnimalAgent behaviour with its presentation (meshes, leg IK, ropes) stripped
// out. Load it with the three.js stub registered (see register.mjs), as
// simulate.mjs and tests/animalrailway.mjs do.

import { World } from '../../src/world.js';
import { planRegionalRailway } from '../../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../../src/railwayterrain.mjs';
import { clearStationSettlementCache } from '../../src/stationsettlement.mjs';
import { landmarksAround, majorLandmarksAround } from '../../src/landmarks.js';
import { caveAnchorsAround } from '../../src/cavegen.mjs';
import { settlementsAround } from '../../src/settlementplacement.mjs';
import { cachedSettlementPlan } from '../../src/settlementspatial.mjs';
import { StructureCollisionIndex } from '../../src/structurecollision.mjs';
import { ANIMAL_RECIPES, LEG_ORDER } from '../../src/animaldata.mjs';
import { createRegard } from '../../src/animalregard.mjs';
import { mulberry32 } from '../../src/noise.js';
import { AnimalAgent, AnimalSystem } from '../../src/animals.js';
import { Vector3 } from './three-stub.mjs';
import {
  RAILWAY_FOUL_HALF_WIDTH, nearestRailwayLine, railwayTrackDistance,
} from '../../src/railwayclearance.mjs';

const TAU = Math.PI * 2;
export const DT = 1 / 20;

const MOVING = new Set(['roam', 'travel', 'wade', 'investigate', 'pounce', 'follow', 'flee']);

// --- a presentation-free AnimalAgent ----------------------------------------
function bone() {
  return {
    rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 },
    userData: { bindRotation: { x: 0, y: 0, z: 0 }, bindPosition: { x: 0, y: 0, z: 0 } },
    matrixWorld: null, updateMatrixWorld() {},
  };
}
const inertRope = { step() {}, invalidate() {} };

export function lightAgent(recipe, world, seed) {
  const agent = Object.create(AnimalAgent.prototype);
  const bones = new Map();
  const rig = {
    root: bone(),
    byName: new Proxy({}, { get: (_, name) => {
      if (!bones.has(name)) bones.set(name, bone());
      return bones.get(name);
    } }),
  };
  const legLength = (chain) => chain.lengths[0] + chain.lengths[1] + chain.lengths[2];
  Object.assign(agent, {
    asset: { recipe, shapes: [] },
    recipe, world,
    rng: mulberry32(seed ^ recipe.seed),
    mesh: {
      position: new Vector3(), rotation: { x: 0, y: 0, z: 0 },
      scale: new Vector3(1, 1, 1), visible: true,
      updateMatrixWorld() {}, getWorldQuaternion(q) { return q; },
    },
    rig,
    shapeState: { data: new Float32Array(4), texture: {} },
    material: { userData: {} }, depthMaterial: {},
  });
  Object.assign(agent, {
    age: agent.rng() * 100, seedPhase: agent.rng() * TAU, heading: agent.rng() * TAU,
    routeGrade: 0, routeSafe: true, routeTimer: 0, speed: 0, gaitClock: 0,
    gaitReady: false, lastPose: null, wasLocomoting: false, state: 'idle',
    stateTimer: 1, stateDuration: 1, previewTimer: 0, behaviourElapsed: 0,
    alertness: 0, alertStage: 'calm', dangerTimer: 0, lastDanger: new Vector3(),
    hasDanger: false, regard: createRegard(), playerInSight: false,
    minimumEscapeTimer: 0, escapeReplanTimer: 0, queuedPounce: false,
    goalType: 'home', goalArrival: null, groupId: null, pasture: null,
    pasturePlan: null, isSentinel: false, tailAlarm: 0,
    target: new Vector3(), home: new Vector3(),
    lean: { value: 0, velocity: 0 }, look: { value: 0, velocity: 0 },
    headMood: { carriage: 0, target: 0, yaw: 0, yawTarget: 0, timer: 0 },
    tailSwish: { timer: 0, remaining: 0, phase: 0, speed: 0, force: 0 },
    lastTurn: 0, terrainTimer: 0, cachedGroundY: 0, cachedSlopePitch: 0,
    cachedSlopeRoll: 0, resumeBehaviour: null, motionPreviewSpeed: null,
    footStates: Object.fromEntries(LEG_ORDER.map((name) => [name, { initialized: false, armed: true }])),
    supportLegLength: Math.max(legLength(recipe.leg.front), legLength(recipe.leg.hind)),
    animationScratch: {
      right: new Vector3(), external: new Vector3(),
    },
    tailRope: inertRope, earLeftRope: inertRope, earRightRope: inertRope,
  });
  agent.steeringHeading = agent.heading;
  agent.behaviourTimer = agent.rng() * 0.22;
  agent.rareCooldown = 18 + agent.rng() * 34;
  agent.turnPreference = agent.rng() < 0.5 ? -1 : 1;
  agent.needs = {
    food: 0.25 + agent.rng() * 0.45, water: 0.12 + agent.rng() * 0.28,
    cover: 0.15 + agent.rng() * 0.30, rest: agent.rng() * 0.25,
  };
  // Legs step the moment they are asked: the gait solver only decides WHEN the
  // body may start translating, never where it goes.
  agent.updateReactiveLegs = () => ({ startedStep: true, activeSteps: 1 });
  agent.configurePhenotype = function configurePhenotype(phenotype) {
    this.phenotype = phenotype;
    this.mesh.scale.setScalar(phenotype?.scale || 1);
    this.rareCooldown = phenotype?.playfulPounces ? 2.5 + this.rng() * 5.5 : 18 + this.rng() * 34;
  };
  return agent;
}

export function lightSystem(world, collision) {
  const system = Object.create(AnimalSystem.prototype);
  Object.assign(system, {
    scene: null, world,
    group: { add() {}, remove() {}, visible: true },
    assets: new Map(Object.values(ANIMAL_RECIPES).map((recipe) => [recipe.id, { recipe }])),
    streamed: new Map(), pool: new Map(), previews: [], pastureCache: new Map(),
    spawnCounter: 0, presentationOnly: false,
    sessionSalt: ((world.seed >>> 0) ^ 0x51f15e5d) >>> 0,
    surveyTimer: 0, lastSurveyX: Infinity, lastSurveyZ: Infinity,
    trailEdges: [], trailRefreshTimer: 0, lastTrailX: Infinity, lastTrailZ: Infinity,
    trailScratch: {}, playerSample: new Vector3(), playerSampleReady: false,
    playerSpeed: 0, startupContextDelay: 2, lastPlayer: new Vector3(),
    enabled: true, shadows: false, animationScale: 1.55,
    debug: {
      enabled: true, animationScale: 1.55, spawnFox: true, spawnMoose: true,
      spawnDeer: true, spawnHorses: true, spawnSheep: true, spawnCows: true,
      spawnChance: 0.52, status: '',
    },
    structureCollision: collision,
  });
  system.behaviourContext = {
    playerPosition: system.lastPlayer, playerSpeed: 0, groupAlarm: 0, groupDanger: null,
    familyLeader: null, trails: system.trailEdges, trailScratch: system.trailScratch,
  };
  system.acquireAgent = function acquireAgent(species) {
    const idle = this.pool.get(species);
    let agent = idle && idle.length ? idle.pop() : null;
    if (!agent) {
      const seed = (this.world.seed ^ this.sessionSalt
        ^ Math.imul(this.spawnCounter++, 2654435761)) >>> 0;
      agent = lightAgent(this.assets.get(species).recipe, this.world, seed);
    }
    agent.world = this.world;
    agent.structureCollision = this.structureCollision;
    return agent;
  };
  return system;
}

// --- world ---------------------------------------------------------------------
export function buildWorld(seed) {
  clearStationSettlementCache();
  const world = new World(seed);
  // The same survey the game runs (railwayplanning.js generate()), with the
  // game's compact loop (main.js: radius 1500, search 1200) round the origin.
  const center = { x: 0, z: 0 };
  const exclusions = [], caves = [];
  landmarksAround(world, center.x, center.z, seed, 14500, exclusions);
  majorLandmarksAround(world, center.x, center.z, seed, 14500, exclusions, true);
  caveAnchorsAround(world, center.x, center.z, seed, 14500, caves);
  for (const cave of caves) exclusions.push({ x: cave.x, z: cave.z, halo: 55, type: 'cave' });
  const plan = planRegionalRailway(world, {
    center, seed: seed ^ 0x5241494c, stationCount: 5, radius: 1500, searchRadius: 1200, exclusions,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return { world, plan };
}

export function routeSamples(plan, spacing) {
  const pts = plan.points;
  const out = [];
  let carried = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    let d = carried;
    while (d < length) {
      const t = d / length;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, structure: a.structure });
      d += spacing;
    }
    carried = d - length;
  }
  return out;
}

export function registerSettlements(world, plan, collision) {
  const seen = new Set();
  for (const p of routeSamples(plan, 200)) {
    for (const site of settlementsAround(world, p.x, p.z, world.seed, 700, [])) {
      if (seen.has(site.id)) continue;
      seen.add(site.id);
      try { collision.registerPlan(cachedSettlementPlan(world, site)); } catch { /* unplannable */ }
    }
  }
  return seen.size;
}

// --- measurement -----------------------------------------------------------
export function newStats() {
  return {
    animalSeconds: 0, foulSeconds: 0, stillSeconds: 0, stationaryStateSeconds: 0,
    stillSpells: 0, longestStill: 0, longestVisit: 0, visits: 0, crossings: 0,
    maxAlongPerVisit: 0, alongTotal: 0, spawns: 0, spawnsOnTrack: 0,
    strikes: 0, bySpecies: {},
  };
}
function speciesStats(stats, species) {
  return stats.bySpecies[species] ||= {
    animalSeconds: 0, foulSeconds: 0, stillSeconds: 0, longestStill: 0, visits: 0, strikes: 0,
  };
}

const lineScratch = {};
function trackState(world, agent) {
  const p = agent.mesh.position;
  const distance = railwayTrackDistance(world, p.x, p.z, null, lineScratch);
  if (!(distance < RAILWAY_FOUL_HALF_WIDTH)) return null;
  return { distance, across: lineScratch.across, tangentX: lineScratch.tangentX, tangentZ: lineScratch.tangentZ };
}

export function observe(stats, world, system, dt, track, train = null) {
  for (const entry of system.streamed.values()) {
    const agent = entry.agent;
    let memo = track.get(agent);
    if (!memo || memo.id !== entry.id) {
      memo = { id: entry.id, visit: null, still: 0, spawned: true };
      track.set(agent, memo);
    }
    const s = speciesStats(stats, entry.species);
    stats.animalSeconds += dt;
    s.animalSeconds += dt;
    const on = trackState(world, agent);
    if (memo.spawned) {
      memo.spawned = false;
      stats.spawns++;
      if (on) stats.spawnsOnTrack++;
    }
    const p = agent.mesh.position;
    if (on) {
      stats.foulSeconds += dt;
      s.foulSeconds += dt;
      if (!memo.visit) {
        memo.visit = {
          time: 0, startAcross: on.across, x: p.x, z: p.z, along: 0, struck: false,
          species: entry.species, states: new Set(),
        };
        stats.visits++;
        s.visits++;
      }
      const visit = memo.visit;
      visit.along += Math.abs((p.x - visit.x) * on.tangentX + (p.z - visit.z) * on.tangentZ);
      visit.x = p.x; visit.z = p.z;
      visit.time += dt;
      visit.lastAcross = on.across;
      visit.states.add(`${agent.state}/${agent.alertStage}`);
      stats.longestVisit = Math.max(stats.longestVisit, visit.time);
      if (agent.speed < 0.2) {
        stats.stillSeconds += dt;
        s.stillSeconds += dt;
        memo.still += dt;
        if (memo.still > 1 && memo.still - dt <= 1) stats.stillSpells++;
        stats.longestStill = Math.max(stats.longestStill, memo.still);
        s.longestStill = Math.max(s.longestStill, memo.still);
      } else memo.still = 0;
      if (!MOVING.has(agent.state)) stats.stationaryStateSeconds += dt;
      if (train && !visit.struck && Math.hypot(train.x - p.x, train.z - p.z) < 25) {
        visit.struck = true;
        stats.strikes++;
        s.strikes++;
      }
    } else if (memo.visit) {
      closeVisit(stats, memo, world, agent);
    }
  }
}
function closeVisit(stats, memo, world, agent) {
  const visit = memo.visit;
  memo.visit = null;
  memo.still = 0;
  stats.alongTotal += visit.along;
  stats.maxAlongPerVisit = Math.max(stats.maxAlongPerVisit, visit.along);
  const line = nearestRailwayLine(world, agent.mesh.position.x, agent.mesh.position.z, {});
  if (line && Math.sign(line.across) !== Math.sign(visit.startAcross)) stats.crossings++;
  if (process.env.ANIMAL_TRACK_DEBUG && visit.time > Number(process.env.ANIMAL_TRACK_DEBUG)) {
    console.error(`visit ${visit.species} ${visit.time.toFixed(1)}s along ${visit.along.toFixed(1)}m`
      + ` at ${agent.mesh.position.x.toFixed(0)},${agent.mesh.position.z.toFixed(0)}`
      + ` states ${[...visit.states].join(' ')}`);
  }
}

function releaseAll(system) {
  for (const entry of system.streamed.values()) system.releaseAgent(entry.agent, entry.species);
  system.streamed.clear();
}

export function soak(world, plan, collision, minutes, { spacing = 480 } = {}) {
  const stats = newStats();
  const system = lightSystem(world, collision);
  const track = new Map();
  const windows = routeSamples(plan, spacing);
  const far = new Vector3(1e6, 0, 1e6);
  for (const center of windows) {
    releaseAll(system);
    system.survey(center.x, center.z);
    const steps = Math.round(minutes * 60 / DT);
    for (let i = 0; i < steps; i++) {
      if (i % 40 === 0) system.survey(center.x, center.z);
      // No observer near: the context player stands a thousand km away.
      const ctx = system.behaviourContext;
      ctx.playerPosition = far;
      ctx.playerSpeed = 0;
      const groups = new Map();
      for (const entry of system.streamed.values()) {
        if (entry.groupId && entry.member === 0) groups.set(entry.groupId, entry.agent);
      }
      for (const entry of system.streamed.values()) {
        const leader = entry.groupId ? groups.get(entry.groupId) : null;
        ctx.groupAlarm = 0;
        ctx.groupDanger = null;
        ctx.familyLeader = leader && leader !== entry.agent ? leader : null;
        entry.agent.update(DT * system.animationScale, far, true, ctx);
      }
      observe(stats, world, system, DT, track);
    }
    for (const entry of system.streamed.values()) {
      const memo = track.get(entry.agent);
      if (memo?.visit) closeVisit(stats, memo, world, entry.agent);
    }
  }
  releaseAll(system);
  stats.windows = windows.length;
  return stats;
}

export function ride(world, plan, collision, laps) {
  const stats = newStats();
  const system = lightSystem(world, collision);
  const track = new Map();
  const path = routeSamples(plan, 2);
  const stationIndex = new Set(plan.stations.map((station) => {
    let best = 0, bestD = Infinity;
    path.forEach((p, i) => {
      const d = Math.hypot(p.x - station.x, p.z - station.z);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }));
  const player = new Vector3(path[0].x, world.height(path[0].x, path[0].z) + 1.6, path[0].z);
  const cruise = 16;
  let s = 0, dwell = 0, lastIndex = 0;
  const total = path.length * 2 * laps;
  while (s < total) {
    if (dwell > 0) dwell -= DT;
    else {
      s += cruise * DT;
      const index = Math.floor(s / 2);
      for (let k = lastIndex + 1; k <= index; k++) if (stationIndex.has(k % path.length)) dwell = 45;
      lastIndex = index;
    }
    const p = path[Math.floor(s / 2) % path.length];
    player.set(p.x, world.height(p.x, p.z) + 1.6, p.z);
    system.update(DT, player);
    observe(stats, world, system, DT, track, player);
  }
  for (const entry of system.streamed.values()) {
    const memo = track.get(entry.agent);
    if (memo?.visit) closeVisit(stats, memo, world, entry.agent);
  }
  releaseAll(system);
  stats.routeKm = path.length * 2 / 1000;
  return stats;
}

export function round(value, digits = 1) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}
export function summarise(stats) {
  const hours = stats.animalSeconds / 3600;
  return {
    animalHours: round(hours, 2),
    foulSeconds: round(stats.foulSeconds),
    foulSecondsPerAnimalHour: round(stats.foulSeconds / Math.max(hours, 1e-9)),
    stillSeconds: round(stats.stillSeconds),
    stationaryStateSeconds: round(stats.stationaryStateSeconds),
    stillSpellsOver1s: stats.stillSpells,
    longestStillSpell: round(stats.longestStill),
    visits: stats.visits,
    crossings: stats.crossings,
    longestVisit: round(stats.longestVisit),
    meanAlongPerVisit: round(stats.alongTotal / Math.max(1, stats.visits)),
    maxAlongPerVisit: round(stats.maxAlongPerVisit),
    spawns: stats.spawns,
    spawnsOnTrack: stats.spawnsOnTrack,
    strikes: stats.strikes,
    bySpecies: Object.fromEntries(Object.entries(stats.bySpecies).map(([k, v]) => [k, {
      animalHours: round(v.animalSeconds / 3600, 2), foulSeconds: round(v.foulSeconds),
      stillSeconds: round(v.stillSeconds), longestStill: round(v.longestStill), visits: v.visits,
      strikes: v.strikes,
    }])),
  };
}

