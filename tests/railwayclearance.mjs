// Riding the line, nothing should pass through the train: no ground drawn over
// the rails or inside a tunnel bore, and no rock, boulder or tree trunk inside
// the clearance. Walks the whole line of several worlds on the same mesh
// triangles and the same prop filters the chunk worker uses.
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { TIERS } from '../src/quality.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import {
  RAILWAY_CLEARANCE,
  railwayPropBounds,
  railwayPropIntrudes,
  filterRailwayPropIntrusions,
} from '../src/railwayenvelope.mjs';
import {
  auditRailwayClearance,
  auditRailwayProps,
  RAILWAY_NEAR_TERRAIN_RESOLUTIONS,
} from '../src/railwayclearanceaudit.mjs';

// Every quality tier's near terrain grid is part of the promise.
for (const tier of TIERS) {
  assert.ok(RAILWAY_NEAR_TERRAIN_RESOLUTIONS.includes(tier.nearRes),
    `${tier.name} draws near terrain at ${tier.nearRes}, which the clearance audit does not check`);
}

function railwayWorld(seed) {
  const world = new World(seed, { generationVersion: 3 });
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: seed ^ 0x5241494c, stationCount: 5, radius: 2600, searchRadius: 5200,
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return { world, plan };
}

// Seeds with long tunnels, river crossings and boulder fields beside the line.
const SEEDS = [20260612, 20260613, 20260615];
let sawTunnel = false;
for (const seed of SEEDS) {
  const { world, plan } = railwayWorld(seed);
  sawTunnel ||= plan.metrics.structures.tunnel.count > 0;
  const audit = auditRailwayClearance(world, plan, { terrain: { resolutions: [48, 64, 112] } });
  for (const [res, { samples, intrusions }] of Object.entries(audit.terrain)) {
    assert.ok(samples > 0);
    const worst = intrusions.slice(0, 3).map((hit) =>
      `${hit.structure} at arc ${hit.arc.toFixed(0)} (${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}) +${hit.over.toFixed(2)}m`);
    assert.equal(intrusions.length, 0,
      `seed ${seed}: terrain rises into the train at ${intrusions.length} metres of line on the ${res} grid: ${worst.join('; ')}`);
  }
  const props = audit.props;
  assert.ok(props.instances > 0, `seed ${seed}: no props near the line to check`);
  assert.equal(props.intrusions.length, 0,
    `seed ${seed}: ${props.intrusions.map((hit) => `${hit.type} on ${hit.structure} at (${hit.x.toFixed(0)}, ${hit.z.toFixed(0)})`).join('; ')}`);
}
assert.ok(sawTunnel, 'the test seeds should include a tunnel');

// The prop filter is what keeps the rocks out: without it the same chunks put
// solid props in the clearance.
{
  const { world, plan } = railwayWorld(20260613);
  const raw = auditRailwayProps(world, plan, { unfiltered: true });
  assert.ok(raw.intrusions.length > 0, 'expected unfiltered scatter to reach into the line on this seed');
}

// The envelope test itself, on a straight synthetic line.
{
  const index = {
    binSize: 180,
    segments: new Float32Array([-100, 0, 10, 100, 0, 10]),
    kinds: new Uint8Array([0]),
    _bin: () => ({ segments: [0] }),
  };
  const boulder = railwayPropBounds('boulder', 0);
  const at = (x, y, z, scale = 1) => new Float32Array([
    scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1,
  ]);
  // Centre beside the line but big enough to overhang the rails.
  assert.ok(railwayPropIntrudes(index, at(0, 10, 6, 4), 0, boulder));
  // Small and well clear.
  assert.equal(railwayPropIntrudes(index, at(0, 10, 6, 1), 0, boulder), null);
  // Buried well below the formation.
  assert.equal(railwayPropIntrudes(index, at(0, 10 - 4, 0, 1), 0, boulder), null);
  // Above a tunnel crown it is hidden; inside the bore it is not.
  index.kinds[0] = 4;
  assert.equal(railwayPropIntrudes(index, at(0, 10 + RAILWAY_CLEARANCE.boreTop + 2, 0, 1), 0, boulder), null);
  assert.ok(railwayPropIntrudes(index, at(0, 12, 0, 1), 0, boulder));
  // Soft clutter is not policed here.
  assert.equal(railwayPropBounds('grass', 0), null);
  // Filtering keeps per-instance arrays in step.
  const bucket = {
    type: 'boulder', variant: 0,
    matrices: new Float32Array([...at(0, 12, 0), ...at(0, 10, 40)]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0]),
  };
  filterRailwayPropIntrusions(index, bucket);
  assert.equal(bucket.matrices.length, 16);
  assert.equal(bucket.matrices[14], 40);
  assert.deepEqual([...bucket.colors], [0, 1, 0]);
}

console.log('railway clearance OK');
