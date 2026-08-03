import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { World } from '../src/world.js';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan, portalWorldPoint } from '../src/settlementplan.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { buildingLocalPoint, settlementGroundAtPlans } from '../src/settlementspatial.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';

const world = {
  seed: 991,
  height(x, z) { return 16 + Math.sin(x * 0.0002) + Math.cos(z * 0.0003); },
  biomeAt(x, z) { return { h: this.height(x, z), slope: 0.035, m: 0.6, t: 12, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function siteAndPlan() {
  for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) {
    const site = settlementForCell(world, i, j, world.seed);
    if (site) return { site, plan: createSettlementPlan(site, { heightAt: world.height.bind(world) }) };
  }
  throw new Error('No deterministic settlement in test corpus.');
}

function reachableKeys(plan) {
  const adjacent = new Map(plan.localGraph.nodes.map((node) => [node.key, []]));
  for (const edge of plan.localGraph.edges) { adjacent.get(edge.from).push(edge.to); adjacent.get(edge.to).push(edge.from); }
  const seen = new Set([plan.site.regionalEntrance.key]), queue = [...seen];
  while (queue.length) for (const next of adjacent.get(queue.shift()) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

test('phase 1 spatial plans keep buildings separate and connect every doorstep', () => {
  const { plan } = siteAndPlan(), reachable = reachableKeys(plan);
  for (let i = 0; i < plan.buildings.length; i++) for (let j = i + 1; j < plan.buildings.length; j++) {
    const a = plan.buildings[i], b = plan.buildings[j];
    const clearance = Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(a.width, a.depth) / 2 - Math.hypot(b.width, b.depth) / 2;
    assert.ok(clearance > 2.9, `${a.id} and ${b.id} overlap (${clearance.toFixed(2)}m)`);
  }
  for (const approach of plan.localGraph.nodes.filter((node) => node.kind === 'door-approach')) assert.ok(reachable.has(approach.key), `${approach.key} is disconnected`);
});

test('real-world building pads have safe thresholds and one authoritative interior support', () => {
  const realWorld = new World(20260612);
  let buildingCount = 0;
  for (let cj = -5; cj <= 5; cj++) for (let ci = -5; ci <= 5; ci++) {
    const site = settlementForCell(realWorld, ci, cj, realWorld.seed); if (!site) continue;
    const plan = createSettlementPlan(site, { heightAt: (x, z) => realWorld.height(x, z) });
    for (const building of plan.buildings) {
      buildingCount++;
      assert.equal(building.terrainFit.valid, true,
        `${building.id} accepted an unsafe lot: ${JSON.stringify(building.terrainFit)}`);
      assert.ok(building.terrainFit.doorStep <= 0.18 + 1e-9,
        `${building.id} has a ${building.terrainFit.doorStep.toFixed(2)}m doorway cliff`);
    }
  }
  assert.ok(buildingCount > 350, `real terrain soak only checked ${buildingCount} buildings`);

  const site = settlementForCell(realWorld, 0, 0, realWorld.seed);
  const plan = createSettlementPlan(site, { heightAt: (x, z) => realWorld.height(x, z) });
  const surface = new WalkableSurface(realWorld);
  plan.claims.forEach((claim) => surface.registerClaim(claim));
  for (const building of plan.buildings) {
    const claim = plan.claims.find((entry) => entry.buildingId === building.id);
    for (const nz of [-0.4, -0.2, 0, 0.2, 0.4]) for (const nx of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const point = buildingWorldPoint(building, nx * building.width, nz * building.depth);
      const footing = surface.queryAt(point.x, point.z, claim.y + 0.5);
      assert.equal(footing.supportId, claim.id, `${building.id} toggled back to raw terrain indoors`);
      assert.ok(Math.abs(footing.y - claim.y) < 1e-9, `${building.id} has a non-level interior floor`);
    }
    const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
    let previousY = null, worstStep = 0;
    for (let offset = 0.35; offset >= -0.35; offset -= 0.05) {
      const point = portalWorldPoint(building, { ...portal, z: building.depth / 2 + offset });
      const y = surface.groundAt(point.x, point.z, claim.y + 0.5);
      if (previousY !== null) worstStep = Math.max(worstStep, Math.abs(y - previousY));
      previousY = y;
    }
    assert.ok(worstStep <= 0.19, `${building.id} doorway changes ${worstStep.toFixed(2)}m in one step`);
  }
});

test('1,000-settlement spatial soak has no overlaps, disconnected doors, or paths through structures', () => {
  let settlementCount = 0;
  for (let cj = -24; cj <= 24 && settlementCount < 1000; cj++) for (let ci = -24; ci <= 24 && settlementCount < 1000; ci++) {
    const site = settlementForCell(world, ci, cj, world.seed); if (!site) continue;
    const plan = createSettlementPlan(site, { heightAt: world.height.bind(world) }); settlementCount++;
    const reachable = reachableKeys(plan);
    for (let i = 0; i < plan.buildings.length; i++) for (let j = i + 1; j < plan.buildings.length; j++) {
      const a = plan.buildings[i], b = plan.buildings[j];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(a.width, a.depth) / 2 - Math.hypot(b.width, b.depth) / 2 > 2.9);
    }
    for (const approach of plan.localGraph.nodes.filter((node) => node.kind === 'door-approach')) assert.ok(reachable.has(approach.key));
    for (const path of plan.paths) for (let segment = 1; segment < path.points.length; segment++) {
      const a = path.points[segment - 1], b = path.points[segment], samples = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5);
      for (let sample = 1; sample < samples; sample++) {
        const t = sample / samples, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        assert.equal(plan.buildings.some((building) => {
          const local = buildingLocalPoint(building, x, z);
          return Math.abs(local.x) < building.width / 2 + 0.45 && Math.abs(local.z) < building.depth / 2 + 0.45;
        }), false, `${path.id} crosses a structure`);
      }
    }
  }
  assert.equal(settlementCount, 1000);
});

test('phase 2 masks interiors, dirt aprons, work yards, and rendered path cores', () => {
  const { plan } = siteAndPlan(), building = plan.buildings[0];
  assert.equal(settlementGroundAtPlans([plan], building.x, building.z).kind, 'interior');
  const apronPoint = buildingWorldPoint(building, building.width / 2 + 1, 0);
  assert.match(settlementGroundAtPlans([plan], apronPoint.x, apronPoint.z).kind, /apron|yard/);
  const path = plan.paths[0], midpoint = path.points[Math.floor(path.points.length / 2)];
  assert.equal(settlementGroundAtPlans([plan], midpoint.x, midpoint.z).density, 0);
});

test('phase 3 swept collision blocks walls, admits an open door, and prevents tunnelling', () => {
  const { plan } = siteAndPlan(), building = plan.buildings[0], state = { portals: {} };
  const index = new StructureCollisionIndex(() => state); index.registerPlan(plan);
  const wallOutside = buildingWorldPoint(building, -building.width / 2 - 0.8, 0);
  const wallInside = buildingWorldPoint(building, -building.width / 2 + 0.8, 0);
  const blocked = { ...wallInside, y: building.y + 1 };
  index.resolveMovement(blocked, { ...wallOutside, y: blocked.y });
  assert.ok(buildingLocalPoint(building, blocked.x, blocked.z).x < -building.width / 2 + 0.05, 'player crossed a solid wall');

  const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
  const outside = buildingWorldPoint(building, portal.x, building.depth / 2 + 0.9);
  const inside = buildingWorldPoint(building, portal.x, building.depth / 2 - 0.9);
  const closed = { ...inside, y: building.y + 1 };
  index.resolveMovement(closed, { ...outside, y: closed.y });
  assert.ok(buildingLocalPoint(building, closed.x, closed.z).z > building.depth / 2 - 0.1, 'closed door admitted player');
  state.portals[portal.id] = { progress: 1, open: true };
  const opened = { ...inside, y: building.y + 1 };
  index.resolveMovement(opened, { ...outside, y: opened.y });
  assert.ok(Math.hypot(opened.x - inside.x, opened.z - inside.z) < 0.08, 'open doorway retained collision');

  const interior = building.portals.find((entry) => entry.kind === 'interior-door');
  const roomA = buildingWorldPoint(building, interior.x, interior.z - 0.9);
  const roomB = buildingWorldPoint(building, interior.x, interior.z + 0.9);
  const throughRoom = { ...roomB, y: building.y + 1 };
  index.resolveMovement(throughRoom, { ...roomA, y: throughRoom.y });
  assert.ok(Math.hypot(throughRoom.x - roomB.x, throughRoom.z - roomB.z) < 0.08, 'open interior doorway retained collision');
});

test('grass layers and renderer consume the shared corrective contracts', async () => {
  const [chunk, blanket, renderer, population, main] = await Promise.all([
    readFile(new URL('../src/chunkgen.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/grassfield.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/settlementstream.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(chunk, /settlementGroundAtPlans/);
  assert.match(blanket, /settlementGroundAtPlans/);
  assert.match(renderer, /buildGroundTreatment/);
  assert.match(renderer, /function addRoof/);
  assert.match(renderer, /ConeGeometry\(1, rise, 4, 1, false/);
  assert.match(renderer, /BoxGeometry\(slopeLength, thickness, depth\)/);
  assert.match(renderer, /function addGableEnds/);
  assert.doesNotMatch(renderer, /new THREE\.ExtrudeGeometry/);
  assert.match(renderer, /function addWallWithOpenings/);
  assert.match(renderer, /windowAssembly/);
  assert.doesNotMatch(renderer, /const glass\s*=/);
  assert.doesNotMatch(renderer, /box\(root, pane,/);
  assert.match(renderer, /createNpcAvatar/);
  assert.doesNotMatch(renderer, /CapsuleGeometry\(0\.25, 0\.75/);
  assert.match(renderer, /advanceResidentLoiter/);
  assert.match(renderer, /function stopResidentSteering/);
  assert.match(renderer, /function residentSocialMotion/);
  assert.match(renderer, /const socialStop = !!resident\.conversation \|\| talkingToPlayer/);
  assert.match(renderer, /if \(socialStop\) \{\s*\/\/ Preserve the active waypoint[\s\S]*?stopResidentSteering\(resident\)/);
  assert.match(renderer, /const movingThisFrame = Math\.hypot/);
  assert.match(renderer, /held: socialMotion\.held/);
  assert.match(renderer, /advanceGaze/);
  assert.match(renderer, /updateResidentConversations/);
  assert.match(renderer, /pulseDelivery/);
  assert.match(renderer, /separation < 1\.75/);
  assert.match(renderer, /interactiveActors\(\)/);
  assert.match(population, /setExternalActorsProvider/);
  assert.match(population, /isTalkingTo\(actorId\)/);
  assert.match(main, /setExternalActorsProvider\(\(\) => settlementSystem\.interactiveActors\(\)\)/);
  assert.match(renderer, /routeBetweenBuildings/);
  assert.match(renderer, /mergeStaticSettlementMeshes/);
});
