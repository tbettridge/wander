import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  buildRailwayTrackTile,
  RailwayTrackIndex,
  serializeRailwayTrackPlan,
} from '../src/railwaystream.mjs';

const world = new World(20260612);
const plan = planRegionalRailway(world, {
  center: { x: 0, z: 0 }, seed: 20260612, stationCount: 5,
});
const spec = serializeRailwayTrackPlan(plan);
const index = new RailwayTrackIndex(structuredClone(spec));
assert.equal(index.segmentCount, plan.route.sampleCount);
assert.equal(index.stationCount, plan.stations.length);
assert.ok(index.tiles.size > 30, 'regional loop did not populate enough stream tiles');
assert.equal(index.entry(100000, 100000), null);

let sleepers = 0, stationCount = 0, railTiles = 0, bridgeTiles = 0, bridgePiers = 0, tunnelPieces = 0;
let masonryTris = 0, timberPiers = 0;
for (const entry of index.tiles.values()) {
  const tile = buildRailwayTrackTile(index, entry.ix, entry.iz, { groundHeightAt: () => -20 });
  assert.ok(tile);
  sleepers += tile.sleepers.length;
  stationCount += tile.stations.length;
  tunnelPieces += tile.structures.tunnel;
  if (tile.masonry) masonryTris += tile.masonry.indices.length;
  timberPiers += tile.piers.filter((p) => p.family === 1).length;
  if (tile.rails) {
    railTiles++;
    assert.equal(tile.rails.positions.length % 3, 0);
    assert.equal(tile.rails.normals.length, tile.rails.positions.length);
    assert.ok(tile.rails.indices.length > 0);
    assert.ok(tile.rails.positions.every(Number.isFinite));
  }
  if (tile.bridge) {
    bridgeTiles++;
    bridgePiers += tile.piers.length;
  }
  const minX = entry.ix * index.tileSize - 1e-5;
  const maxX = (entry.ix + 1) * index.tileSize + 1e-5;
  const minZ = entry.iz * index.tileSize - 1e-5;
  const maxZ = (entry.iz + 1) * index.tileSize + 1e-5;
  for (const sleeper of tile.sleepers) {
    assert.ok(sleeper.x >= minX && sleeper.x <= maxX);
    assert.ok(sleeper.z >= minZ && sleeper.z <= maxZ);
  }
}
assert.equal(stationCount, plan.stations.length, 'stations must have exactly one owning tile');
assert.ok(railTiles > 20);
assert.ok(bridgeTiles > 0);
assert.ok(bridgePiers > 0, 'elevated bridge spans omitted terrain-seated piers');
assert.ok(tunnelPieces > 0);
assert.ok(sleepers > 5000, 'production loop sleeper population is unexpectedly sparse');
assert.ok(sleepers < plan.route.length / 1.12 + 10, 'sleepers were duplicated at tile boundaries');
assert.ok(masonryTris > 0, 'Phase 6 structures produced no masonry geometry (parapets/retaining walls)');

console.log(`railwaystream PASS · ${index.tiles.size} indexed tiles · ${railTiles} rail tiles · ${sleepers} sleepers · ${masonryTris / 3} masonry tris · ${timberPiers} timber bents`);
