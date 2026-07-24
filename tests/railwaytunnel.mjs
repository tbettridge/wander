import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  collectTunnelRuns,
  collectTunnelPortals,
  buildTunnelRunGeometry,
  tunnelImmersion,
  filterTerrainIndexForPortals,
  TUNNEL_PROFILE,
  PORTAL_MOUTH,
} from '../src/railwaytunnel.mjs';
import {
  RailwayTerrainIndex,
  serializeRailwayTerrainPlan,
  setWorldRailwayTerrain,
  RAILWAY_TUNNEL_MIN_COVER,
} from '../src/railwayterrain.mjs';
import {
  buildRailwayTrackTile,
  RailwayTrackIndex,
  serializeRailwayTrackPlan,
} from '../src/railwaystream.mjs';

const world = new World(20260612);
const plan = planRegionalRailway(world, {
  center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5,
});

// --- run discovery -----------------------------------------------------------
const runs = collectTunnelRuns(plan);
assert.ok(runs.length >= 1, 'test seed lost its tunnels');
const n = plan.points.length;
for (const run of runs) {
  assert.equal(plan.points[run.startIndex].structure, 'tunnel');
  assert.equal(plan.points[run.endIndex].structure, 'tunnel');
  assert.notEqual(plan.points[(run.startIndex - 1 + n) % n].structure, 'tunnel',
    'run must start at a cut/tunnel boundary');
  assert.notEqual(plan.points[(run.endIndex + 1) % n].structure, 'tunnel',
    'run must end at a tunnel/cut boundary');
  assert.ok(run.length > 5, `degenerate tunnel run: ${run.length}m`);
  assert.ok(run.samples.length >= 3);
  for (let i = 1; i < run.samples.length; i++) {
    assert.ok(run.samples[i].arc > run.samples[i - 1].arc, 'samples must advance');
  }
  // Portals face away from each other along the bore.
  const dot = run.portalA.outX * run.portalB.outX + run.portalA.outZ * run.portalB.outZ;
  assert.ok(dot < 0.6, `portal outward directions should oppose: ${dot}`);
}

// --- geometry ------------------------------------------------------------------
let liningTris = 0, portalTris = 0;
for (const run of runs) {
  const data = buildTunnelRunGeometry(run);
  for (const part of [data.lining, data.ribs, data.portals]) {
    if (!part) continue;
    assert.equal(part.positions.length % 3, 0);
    assert.equal(part.normals.length, part.positions.length);
    assert.equal(part.indices.length % 3, 0);
    assert.ok(part.positions.every(Number.isFinite));
    assert.ok(part.normals.every(Number.isFinite));
  }
  assert.ok(data.lining, 'tunnel run produced no lining');
  assert.ok(data.portals, 'tunnel run produced no portal facades');
  liningTris += data.lining.indices.length / 3;
  portalTris += data.portals.indices.length / 3;
  // Lining stays near the run's centreline bounds.
  for (let i = 0; i < data.lining.positions.length; i += 3) {
    assert.ok(data.lining.positions[i] > run.bounds.minX - 12);
    assert.ok(data.lining.positions[i] < run.bounds.maxX + 12);
  }
}
assert.ok(liningTris > 50, 'suspiciously little tunnel lining');
assert.ok(portalTris > 20, 'suspiciously few portal triangles');

// --- immersion ------------------------------------------------------------------
const longest = runs.reduce((a, b) => (a.length > b.length ? a : b));
const mid = longest.samples[Math.floor(longest.samples.length / 2)];
const inside = tunnelImmersion(runs, mid.x, mid.y + 1.4, mid.z, {});
if (longest.length > 26) {
  assert.ok(inside.factor > 0.8, `mid-bore should be dark: ${inside.factor}`);
}
assert.ok(inside.engaged, 'mid-bore should engage the walking environment');
assert.ok(Math.abs(inside.floorY - mid.y) < 0.5);
const away = tunnelImmersion(runs, mid.x + 80, mid.y, mid.z + 80, {});
assert.equal(away.factor, 0, 'open country must not read as tunnel');
const approach = tunnelImmersion(
  runs,
  longest.portalA.x + longest.portalA.outX * 10,
  longest.portalA.y + 1.4,
  longest.portalA.z + longest.portalA.outZ * 10,
  {},
);
assert.ok(approach.factor < 0.35, `10m outside the portal is still daylight: ${approach.factor}`);

// --- terrain spec portals + clearance --------------------------------------------
const spec = serializeRailwayTerrainPlan(plan);
assert.equal(spec.portals.length / 5, runs.length * 2, 'terrain spec must carry every portal');
const terrainIndex = new RailwayTerrainIndex(structuredClone(spec));
const portalList = collectTunnelPortals(runs);
for (const portal of portalList) {
  const clearance = terrainIndex.clearanceAt(portal.x, portal.z, {});
  assert.ok(clearance.treeClearance > 0.9, `portal mouth keeps trees out: ${clearance.treeClearance}`);
  assert.ok(clearance.grassClearance > 0.6);
}

// --- terrain curtain cut -----------------------------------------------------------
// Synthetic 3-column strip crossing the portal plane at mouth height: the
// crossing quad must be dropped, a far quad must survive.
{
  const portal = { x: 0, y: 0, z: 0, outX: 1, outZ: 0 };
  const positions = new Float32Array([
    // Quad straddling the plane (x=-2 → 2), inside mouth laterally/vertically.
    -2, 1, -1, 2, 1, -1, -2, 1, 1, 2, 1, 1,
    // Far quad, 40m away.
    38, 1, -1, 42, 1, -1, 38, 1, 1, 42, 1, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
  const filtered = filterTerrainIndexForPortals(positions, indices, [portal]);
  assert.ok(filtered, 'curtain quad was not removed');
  assert.equal(filtered.length, 6, 'only the far quad should remain');
  assert.deepEqual([...filtered], [4, 5, 6, 5, 7, 6]);
  // A curtain outside the mouth's lateral bounds survives.
  const wide = new Float32Array([
    -2, 1, PORTAL_MOUTH.halfWidth + 3, 2, 1, PORTAL_MOUTH.halfWidth + 3,
    -2, 1, PORTAL_MOUTH.halfWidth + 5, 2, 1, PORTAL_MOUTH.halfWidth + 5,
  ]);
  const wideIndices = new Uint32Array([0, 1, 2, 1, 3, 2]);
  assert.equal(filterTerrainIndexForPortals(wide, wideIndices, [portal]), null);
}

// --- track continues through the bore ------------------------------------------------
const trackIndex = new RailwayTrackIndex(serializeRailwayTrackPlan(plan));
let tunnelRailTiles = 0, tunnelTilesSeen = 0;
for (const entry of trackIndex.tiles.values()) {
  const tile = buildRailwayTrackTile(trackIndex, entry.ix, entry.iz, { groundHeightAt: () => -20 });
  if (!tile || !tile.structures.tunnel) continue;
  tunnelTilesSeen++;
  if (tile.rails && tile.sleepers.length) tunnelRailTiles++;
}
assert.ok(tunnelTilesSeen > 0, 'no tiles contain tunnel segments');
assert.equal(tunnelRailTiles, tunnelTilesSeen, 'every tunnel tile must carry track');

// Bore must clear the train envelope.
assert.ok(TUNNEL_PROFILE.halfWidth > 1.4, 'bore too narrow for the carriage');
assert.ok(TUNNEL_PROFILE.crownY > 3.5, 'bore too low for the locomotive');

// --- nothing intrudes into the bore ---------------------------------------------
// With the modifier installed, the rendered terrain over every bore must stay
// above the tube crown for the run's whole interior span (portal collars are
// open on purpose), across the tube's width — no grass ledge, rock seat or
// terrain saddle can exist inside the tunnel.
setWorldRailwayTerrain(world, spec);
let coverChecked = 0, worstCover = Infinity;
for (const run of runs) {
  for (const sample of run.samples) {
    const depth = Math.min(sample.arc - run.arcStart, run.arcEnd - sample.arc);
    if (depth < 2) continue; // collar/portal plane — the mouth is meant to be open
    for (const lateral of [-TUNNEL_PROFILE.halfWidth, 0, TUNNEL_PROFILE.halfWidth]) {
      const x = sample.x + sample.rx * lateral;
      const z = sample.z + sample.rz * lateral;
      const cover = world.height(x, z) - sample.y;
      worstCover = Math.min(worstCover, cover);
      assert.ok(cover > TUNNEL_PROFILE.crownY + 0.3,
        `terrain intrudes into bore at depth ${depth.toFixed(0)}m: cover ${cover.toFixed(2)}m`);
      coverChecked++;
    }
  }
}
assert.ok(coverChecked > 20, 'cover audit sampled too little');
assert.ok(RAILWAY_TUNNEL_MIN_COVER > TUNNEL_PROFILE.crownY, 'min cover must exceed the crown');
setWorldRailwayTerrain(world, null);

console.log(`railwaytunnel PASS · ${runs.length} runs · ${Math.round(runs.reduce((s, r) => s + r.length, 0))}m bored · ${liningTris} lining tris · portals cleared`);
