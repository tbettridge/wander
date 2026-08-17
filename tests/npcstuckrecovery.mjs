// Residents must not be able to wedge against a village permanently.
//
// A settlement lane is planned against one idea of what is solid and walked
// against another, so a route can legitimately point through something a
// resident cannot pass. That gap is worth narrowing — the planner half of this
// file asserts it stays narrow — but it will never be exactly zero, and the
// failure it used to produce was total: `arrived` is gated on not being
// blocked, so a wedged resident could never advance its waypoint, never reached
// its destination building, and so never re-planned. It pushed into the same
// wall for the rest of the session while everyone else routed down that lane
// piled up behind it, which is what a player actually saw.
//
// So both halves matter, and they are different promises: the steering must
// always get free, and the plan must rarely put anyone in that position.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { settlementBuildBlocker } from '../src/settlementspatial.mjs';
import { settlementOrigin } from '../src/settlementorigin.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { propCollisionRadius } from '../src/settlementprops.mjs';
import { advanceNpcSteering, createNpcSteeringState } from '../src/npcsteering.mjs';

const DT = 1 / 60;

// --- a wall the route did not know about must not hold anyone forever --------
{
  // One long segment straight across the path, with the waypoint behind it.
  const wall = { ax: -12, az: 6, bx: 12, bz: 6 };
  const resolveMovement = (position, previous) => {
    if (position.z <= 6 - 0.29) return { blocked: false };
    position.x = position.x; position.z = Math.min(position.z, 6 - 0.29);
    return { blocked: Math.abs(position.z - previous.z) > 1e-9 || previous.z >= 6 - 0.29 };
  };
  const position = { x: 0, y: 0, z: 0 };
  const state = createNpcSteeringState(0);
  let released = false;
  for (let frame = 0; frame < 60 * 20 && !released; frame++) {
    const movement = advanceNpcSteering(state, {
      position, target: { x: 0, y: 0, z: 14 }, nextTarget: null,
      dt: DT, maxSpeed: 1.35, arrivalRadius: 0.85, stopRadius: 0.14, resolveMovement,
    });
    if (movement.abandoned) released = true;
  }
  assert.ok(released, 'a resident held against a wall must give up the waypoint rather than push forever');
  assert.ok(position.z <= 6, 'giving up a waypoint must never walk a resident through the wall');
}

// --- but an unobstructed circuit must never give a waypoint away -------------
//
// The look-ahead stops the gap to the current waypoint closing as a resident
// rounds a corner, which looks exactly like a stall. Reading that as an
// obstruction would cut a corner off every turn in the village, so the escape
// hatch is gated on having actually touched something.
{
  const points = [{ x: 6, z: 0 }, { x: 6, z: 6 }, { x: 0, z: 6 }, { x: 0, z: 0 }];
  const position = { x: 0, y: 0, z: 0 };
  const state = createNpcSteeringState(0);
  let index = 0, abandons = 0, laps = 0;
  for (let frame = 0; frame < 60 * 120; frame++) {
    const movement = advanceNpcSteering(state, {
      position, target: points[index], nextTarget: points[(index + 1) % points.length],
      dt: DT, maxSpeed: 1.08, arrivalRadius: 0.62, stopRadius: 0.1,
    });
    if (movement.abandoned) abandons++;
    if (movement.arrived) { index = (index + 1) % points.length; if (!index) laps++; }
  }
  assert.equal(abandons, 0, 'an unobstructed resident must never abandon a waypoint');
  assert.ok(laps > 0, 'the circuit has to actually be walked for the check above to mean anything');
}

// --- the junction the whole village routes through must be standable ---------
//
// The well is dead centre of the square by design, and every street and lane
// used to meet at that exact point — so the one node the village routes through
// stood inside the one solid thing in the square, and no routing could save a
// path whose own endpoint is unwalkable.
{
  const world = new World(20260612);
  const railway = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(railway));
  clearStationSettlementCache();
  const sites = stationSettlements(world, world.seed);
  assert.ok(sites.length > 0, 'the seed has to produce station settlements');

  let routes = 0, blocked = 0;
  for (const site of sites) {
    const plan = createSettlementPlan(site, {
      heightAt: (x, z) => world.height(x, z),
      blockedAt: settlementBuildBlocker(world, site),
      origin: settlementOrigin(world, site),
    });

    const solidProps = (plan.props || []).filter((prop) => propCollisionRadius(prop));
    const insideProp = (x, z, padding = 0) => solidProps.some((prop) => {
      const radius = propCollisionRadius(prop);
      const hx = prop.width ? prop.width / 2 : radius;
      const hz = prop.depth ? prop.depth / 2 : radius;
      const c = Math.cos(prop.yaw), s = Math.sin(prop.yaw);
      const dx = x - prop.x, dz = z - prop.z;
      return Math.abs(dx * c - dz * s) < hx + padding && Math.abs(dx * s + dz * c) < hz + padding;
    });

    for (const node of plan.localGraph.nodes) {
      assert.ok(!insideProp(node.x, node.z),
        `${site.id}: routing node ${node.key} stands inside the square's furniture`);
    }

    // And the lanes between those nodes have to be walkable by the index that
    // actually stops a resident, not merely clear of the building footprints
    // the planner used to be the only thing it knew about.
    const index = new StructureCollisionIndex(() => ({
      portals: Object.fromEntries(
        plan.buildings.flatMap((b) => b.portals.map((p) => [p.id, { progress: 1 }])),
      ),
    }));
    index.registerPlan(plan);
    for (const path of plan.paths) {
      routes++;
      let hit = false;
      for (let i = 1; i < path.points.length && !hit; i++) {
        const a = path.points[i - 1], b = path.points[i];
        const distance = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(2, Math.ceil(distance / 0.3));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          const y = a.y + ((b.y ?? a.y) - a.y) * t;
          const item = index.collides(x, z, y, 0.29);
          // A lane is allowed to cross the plinth of the plot it serves: that
          // step up is the doorway, and the walkable claim carries them over it.
          if (item && !/:foundation:\d+$/.test(String(item.id))) { hit = true; break; }
        }
      }
      if (hit) blocked++;
    }
  }
  const rate = blocked / routes;
  assert.ok(rate < 0.12,
    `${(100 * rate).toFixed(1)}% of planned lanes cross something solid — the planner and the`
    + ' collision index have drifted apart again');
}

console.log('npcstuckrecovery PASS · a wedged resident always gives up the waypoint · '
  + 'an unobstructed one never does · village routing nodes stand clear of the square · '
  + 'planned lanes agree with the collision index');
