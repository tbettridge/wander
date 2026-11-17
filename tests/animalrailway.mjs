// Animals may cross the railway, but nothing may stop on it: the train is
// scripted, never brakes, and drives straight through whatever stands there.
//
// The agent tests run the game's own AnimalAgent behaviour headlessly, with a
// small three.js stub standing in for the renderer (scripts/animal-track).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  RailwayTerrainIndex, RAILWAY_TERRAIN_TYPES, RAILWAY_TRACKBED_DROP,
  serializeRailwayTerrainPlan, setWorldRailwayTerrain,
} from '../src/railwayterrain.mjs';
import {
  RAILWAY_FOUL_HALF_WIDTH, RAILWAY_STANDING_CLEARANCE, clearOfRailway,
  nearestRailwayLine, onRailwayTrack, railwayExitPoint, railwayTrackDistance, railwayWithin,
} from '../src/railwayclearance.mjs';
import { resolveHorseGround } from '../src/horsepasture.mjs';
import { createLivestockPasture, livestockGroundSuitable } from '../src/livestockpasture.mjs';
import { ANIMAL_RECIPES } from '../src/animaldata.mjs';
import { createAnimalPhenotype } from '../src/animalpopulation.mjs';

register('../scripts/animal-track/three-loader.mjs', import.meta.url);
const { lightAgent } = await import('../scripts/animal-track/harness.mjs');

// --- a flat field with one straight line of railway along the x axis ----------
const GROUND = 5;
function flatWorld({ kind = RAILWAY_TERRAIN_TYPES.surface, formation = GROUND + RAILWAY_TRACKBED_DROP } = {}) {
  const segments = [], kinds = [];
  for (let x = -400; x < 400; x += 40) {
    segments.push(x, 0, formation, x + 40, 0, formation);
    kinds.push(kind);
  }
  const world = {
    seed: 7,
    height: () => GROUND,
    biomeAt: () => ({ id: 'grassland', h: GROUND, slope: 0.02, m: 0.5 }),
    riverAt: () => ({ wet: false, depth: 0 }),
    openFactor: () => 0.9,
    groveFactor: () => 0.1,
  };
  world.railwayTerrain = new RailwayTerrainIndex({
    version: 1, signature: 'flat-test', binSize: 180,
    segments: new Float64Array(segments), kinds: new Uint8Array(kinds),
    stations: new Float64Array(0), portals: new Float64Array(0),
  });
  return world;
}

// --- where the line is ----------------------------------------------------------
{
  const world = flatWorld();
  assert.equal(railwayTrackDistance(world, 12, 0), 0);
  assert.ok(Math.abs(railwayTrackDistance(world, 12, 2.5) - 2.5) < 1e-9);
  assert.ok(onRailwayTrack(world, 0, RAILWAY_FOUL_HALF_WIDTH - 0.1));
  assert.ok(!onRailwayTrack(world, 0, RAILWAY_FOUL_HALF_WIDTH + 0.1));
  assert.ok(!clearOfRailway(world, 0, RAILWAY_STANDING_CLEARANCE - 0.5));
  assert.ok(clearOfRailway(world, 0, RAILWAY_STANDING_CLEARANCE + 0.5));
  assert.ok(clearOfRailway(world, 0, 500), 'far from the line is clear');
  const line = nearestRailwayLine(world, 10, -3, {});
  assert.ok(line.across < 0 && Math.abs(line.across + 3) < 1e-9, 'across is signed by side');

  // A tunnel is under the hill and a viaduct over the valley: the ground there
  // is not the track, and an animal grazing above a bore is nowhere near a train.
  const tunnel = flatWorld({ kind: RAILWAY_TERRAIN_TYPES.tunnel, formation: GROUND - 14 });
  assert.equal(railwayTrackDistance(tunnel, 0, 0), Infinity);
  assert.ok(clearOfRailway(tunnel, 0, 0));
  assert.ok(!railwayWithin(tunnel, 0, 0, 30), 'a field may lie over a tunnel');
  const viaduct = flatWorld({ kind: RAILWAY_TERRAIN_TYPES.bridge, formation: GROUND + 18 });
  assert.equal(railwayTrackDistance(viaduct, 0, 0), Infinity, 'the valley floor under a bridge');
  assert.ok(railwayWithin(viaduct, 0, 0, 30), 'but no field is laid under one either');
}

// --- the way off is straight across, to the side the animal is bound for -------
{
  const world = flatWorld();
  const line = nearestRailwayLine(world, 20, 1, {});
  const across = railwayExitPoint(line, 20, 1, { toward: { x: 60, z: -40 } });
  assert.equal(across.side, -1, 'heads for the destination side, not back');
  assert.ok(Math.abs(across.x - 20) < 1e-9, 'square to the rails, not along them');
  assert.ok(across.z <= -RAILWAY_STANDING_CLEARANCE, 'and out past the standing clearance');
  const back = railwayExitPoint(line, 20, 1, {});
  assert.equal(back.side, 1, 'with nowhere to go, back to the side it came from');
  const onCentre = nearestRailwayLine(world, 20, 0, {});
  assert.equal(railwayExitPoint(onCentre, 20, 0, { fallbackSide: -1 }).side, -1);
  assert.equal(railwayExitPoint(line, 20, 1, { side: -1 }).side, -1, 'a forced side wins');
}

// --- horses around a village are never stood on the line ------------------------
{
  const site = { x: 0, z: 0 };
  const plan = {
    buildings: [{ x: 0, z: 0, width: 8, depth: 8, yaw: 0 }],
    props: [],
    square: { x: 0, z: 30, radius: 9 },
  };
  const world = flatWorld();
  // The railway runs along z = 0; reject anything within the clearance of it.
  const clear = (x, z) => clearOfRailway(world, x, z);
  let checked = 0;
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const x = Math.cos(angle) * 40, z = Math.sin(angle) * 40;
    const spot = resolveHorseGround(plan, site, x, z, (i + 0.5) / 64, clear);
    if (!spot) continue;
    checked++;
    assert.ok(clear(spot.x, spot.z), `horse stood on the line at ${spot.x.toFixed(1)},${spot.z.toFixed(1)}`);
  }
  assert.ok(checked > 32, 'the predicate must refuse only the line, not the village');
  // Without it the same village does put horses on the rails, which is what
  // the predicate is for.
  let onLine = 0;
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const spot = resolveHorseGround(plan, site, Math.cos(angle) * 40, Math.sin(angle) * 40, (i + 0.5) / 64);
    if (spot && !clear(spot.x, spot.z)) onLine++;
  }
  assert.ok(onLine > 0, 'the fixture has to be able to fail');
}

// --- no livestock field is laid across the line -------------------------------
{
  const world = flatWorld();
  world.height = () => GROUND;
  assert.equal(livestockGroundSuitable(world, { buildings: [], props: [] }, 30, 2), false);
  assert.equal(livestockGroundSuitable(world, { buildings: [], props: [] }, 30, 40), true);
  for (let seed = 1; seed <= 40; seed++) {
    const site = { id: `farm-${seed}`, kind: 'village', seed, x: 0, z: (seed % 7 - 3) * 12, radius: 20 };
    const plan = { site, buildings: [{ x: site.x, z: site.z, width: 6, depth: 6, yaw: 0 }], props: [] };
    for (const species of ['sheep', 'cow']) {
      const field = createLivestockPasture(world, plan, species);
      if (!field) continue;
      assert.ok(Math.abs(field.z) >= field.radius + RAILWAY_STANDING_CLEARANCE - 1e-6,
        `${species} field ${field.id} reaches the railway`);
    }
  }
}

// --- the game's own animal behaviour, headless ----------------------------------
function animal(species, world, x, z, { role = null, seed = 11 } = {}) {
  const agent = lightAgent(ANIMAL_RECIPES[species], world, seed);
  agent.configurePhenotype(createAnimalPhenotype(species, role ? { role } : {}, () => 0.5));
  agent.place(x, z);
  return agent;
}
const FAR = { x: 1e6, y: 0, z: 1e6 };
const DT = 1 / 30;
function run(agent, seconds, observer = FAR, each = null) {
  const steps = Math.round(seconds / DT);
  const context = {
    playerPosition: observer, playerSpeed: 0, groupAlarm: 0, groupDanger: null,
    familyLeader: null, trails: [], trailScratch: {},
  };
  for (let i = 0; i < steps; i++) {
    agent.update(DT, observer, true, context);
    each?.(agent, i * DT);
  }
}

// An animal set down grazing in the middle of the rails walks off them at
// once, and does not stop until it is clear.
for (const species of Object.keys(ANIMAL_RECIPES)) {
  const world = flatWorld();
  const agent = animal(species, world, 15, 0.6);
  agent.setState(species === 'moose' ? 'browse' : 'graze', 30);
  let stillOn = 0, leftAt = null;
  run(agent, 60, FAR, (a, t) => {
    const on = onRailwayTrack(world, a.mesh.position.x, a.mesh.position.z);
    if (!on) { leftAt ??= t; return; }
    // Later visits are crossings, which are allowed; stopping never is.
    if (a.speed < 0.2) stillOn += DT;
  });
  assert.ok(leftAt !== null && leftAt < 10, `${species} took ${leftAt}s to get off the line`);
  // The only still time allowed is the gait's first step from a standstill.
  assert.ok(stillOn < 0.75, `${species} stood on the line for ${stillOn.toFixed(2)}s`);
}

// A tame horse that stops to watch someone still will not do it on the rails.
{
  const world = flatWorld();
  const horse = animal('horse', world, -20, -0.4);
  const watcher = { x: -14, y: GROUND, z: -0.4 };
  let still = 0, alerted = false;
  run(horse, 40, watcher, (a) => {
    if (a.alertStage !== 'calm') alerted = true;
    if (onRailwayTrack(world, a.mesh.position.x, a.mesh.position.z) && a.speed < 0.2) still += DT;
  });
  assert.ok(alerted, 'the fixture has to actually alarm the horse');
  assert.ok(still < 0.75, `a watching horse stood on the line for ${still.toFixed(2)}s`);
  assert.ok(!onRailwayTrack(world, horse.mesh.position.x, horse.mesh.position.z));
}

// Crossing is allowed, and it is done square-on: a horse bound for the far
// side goes over the line, not along it.
{
  const world = flatWorld();
  const horse = animal('horse', world, 0, -14);
  horse.setTravelGoal({ x: 30, z: 18 }, 'food');
  let along = 0, entered = false, last = null, reached = false;
  run(horse, 90, FAR, (a) => {
    if (a.goalType !== 'food' || a.state !== 'travel') return;
    if (a.mesh.position.z > RAILWAY_STANDING_CLEARANCE) reached = true;
    const on = onRailwayTrack(world, a.mesh.position.x, a.mesh.position.z);
    if (on) {
      entered = true;
      if (last) along += Math.abs(a.mesh.position.x - last.x);
      last = { x: a.mesh.position.x };
    } else last = null;
  });
  assert.ok(entered, 'the horse has to cross for this to mean anything');
  assert.ok(reached, 'it reached the far side');
  assert.ok(along < 3, `it walked ${along.toFixed(1)} m along the rails while crossing`);
}

// Left alone beside the line, an animal never chooses to stop on it.
for (const species of ['horse', 'whitetail', 'fox', 'moose']) {
  const world = flatWorld();
  for (let seed = 1; seed <= 6; seed++) {
    const agent = animal(species, world, 0, seed % 2 ? 7 : -7, { seed });
    let still = 0;
    run(agent, 240, FAR, (a) => {
      if (onRailwayTrack(world, a.mesh.position.x, a.mesh.position.z) && a.speed < 0.2) still += DT;
      if (TRAVEL_GOAL_ON_LINE(a, world)) assert.fail(`${species} chose a ${a.goalType} spot on the line`);
    });
    assert.ok(still < 0.75, `${species} (seed ${seed}) stood on the line for ${still.toFixed(2)}s`);
  }
}
function TRAVEL_GOAL_ON_LINE(agent, world) {
  if (agent.state !== 'travel' && agent.state !== 'roam') return false;
  if (agent.goalType === 'clear') return false;
  return !clearOfRailway(world, agent.target.x, agent.target.z);
}

// --- the real railway ------------------------------------------------------------
{
  const world = new World(20260612);
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: 20260612 ^ 0x5241494c, stationCount: 5, radius: 1500, searchRadius: 1200,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  // The open-air line reads as track, the middle of a tunnel never does (the
  // ground there is the hillside), and nor does ground a field's width away.
  let open = 0, seen = 0, bores = 0;
  plan.points.forEach((point, i) => {
    const distance = railwayTrackDistance(world, point.x, point.z);
    const before = plan.points[(i - 1 + plan.points.length) % plan.points.length];
    const after = plan.points[(i + 1) % plan.points.length];
    if (point.structure === 'tunnel' && before.structure === 'tunnel' && after.structure === 'tunnel') {
      bores++;
      assert.equal(distance, Infinity, `the hill over the bore at ${point.x.toFixed(0)},${point.z.toFixed(0)}`);
    }
    if (point.structure === 'tunnel' || point.structure === 'bridge') return;
    open++;
    if (distance < 0.5) seen++;
    const line = nearestRailwayLine(world, point.x, point.z, {});
    const aside = { x: point.x + line.normalX * 30, z: point.z + line.normalZ * 30 };
    const near = nearestRailwayLine(world, aside.x, aside.z, {});
    if (near && near.distance > 25) assert.ok(clearOfRailway(world, aside.x, aside.z));
  });
  assert.ok(open > 100 && bores > 0, 'the fixture needs open line and a tunnel');
  // Joints beside a portal or an abutment, where the ground is the hill or the
  // valley, are the only misses.
  assert.ok(seen / open > 0.9, `only ${seen}/${open} open-air samples read as track`);
}
