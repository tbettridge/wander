import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  buildRailwayTrackTile,
  railwayMasonryProfile,
  RailwayTrackIndex,
  serializeRailwayTrackPlan,
} from '../src/railwaystream.mjs';

assert.deepEqual(
  { segments: railwayMasonryProfile({ xr: true, tier: 'survival' }).archSegments,
    trim: railwayMasonryProfile({ xr: true, tier: 'survival' }).trimLevel,
    shadows: railwayMasonryProfile({ xr: true, tier: 'survival' }).receiveShadow,
    frontSide: railwayMasonryProfile({ xr: true, tier: 'survival' }).frontSide },
  { segments: 8, trim: 0, shadows: false, frontSide: true },
);
assert.equal(railwayMasonryProfile({ tier: 'ultra' }).archSegments, 16);
assert.equal(railwayMasonryProfile({ tier: 'high' }).trimLevel, 2);

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
let masonryTris = 0, timberPiers = 0, archSpans = 0, archSupports = 0;
let culvertArches = 0, retainingBays = 0, retainingSupports = 0;
for (const entry of index.tiles.values()) {
  const tile = buildRailwayTrackTile(index, entry.ix, entry.iz, { groundHeightAt: () => -20 });
  assert.ok(tile);
  sleepers += tile.sleepers.length;
  stationCount += tile.stations.length;
  tunnelPieces += tile.structures.tunnel;
  if (tile.masonry) masonryTris += tile.masonry.indices.length;
  timberPiers += tile.piers.filter((p) => p.family === 1).length;
  archSpans += tile.arches.spans;
  archSupports += tile.arches.supports;
  culvertArches += tile.arches.culverts;
  retainingBays += tile.arches.retainingBays;
  retainingSupports += tile.arches.retainingSupports;
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
assert.ok(bridgePiers + archSupports > 0, 'elevated bridge spans omitted terrain-seated supports');
assert.ok(tunnelPieces > 0);
assert.ok(sleepers > 5000, 'production loop sleeper population is unexpectedly sparse');
assert.ok(sleepers < plan.route.length / 1.12 + 10, 'sleepers were duplicated at tile boundaries');
assert.ok(masonryTris > 0, 'Phase 6 structures produced no masonry geometry (parapets/retaining walls)');
assert.ok(archSpans > 0, 'production railway produced no masonry arch spans');
assert.ok(archSupports > archSpans, 'masonry arches omitted their boundary supports');

// A deterministic synthetic viaduct crosses several stream tiles. Arch phase
// is planned from route distance, so every span/support must have exactly one
// owner even when its geometry extends across a tile boundary.
{
  const xs = [-65, -45, -25, -5, 15, 35, 55, 75];
  const count = xs.length - 1;
  const segments = new Float64Array(count * 8);
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    segments[o] = xs[i]; segments[o + 1] = 8; segments[o + 2] = 0;
    segments[o + 3] = xs[i + 1]; segments[o + 4] = 8; segments[o + 5] = 0;
    segments[o + 6] = i * 20; segments[o + 7] = (i + 1) * 20;
  }
  const synthetic = new RailwayTrackIndex({
    version: 1, signature: 'synthetic-arch-crossing', tileSize: 40, routeLength: count * 20,
    segments,
    kinds: Uint8Array.from([0, 3, 3, 3, 3, 3, 0]),
    families: Uint8Array.from([0, 6, 6, 6, 6, 6, 0]),
    stations: new Float64Array(0),
  });
  assert.equal(synthetic.masonryArchSpans.length, 5);
  assert.equal(synthetic.masonryArchSupports.length, 6);
  const spanOwners = [], supportOwners = [];
  let prototypeSpans = 0, prototypeSupports = 0, prototypeTris = 0, minimumY = Infinity;
  let xrTris = 0, desktopTris = 0, desktopHasToneVariation = false;
  let legacyTris = 0;
  for (const entry of synthetic.tiles.values()) {
    spanOwners.push(...entry.masonryArchSpans);
    supportOwners.push(...entry.masonryArchSupports);
    const tile = buildRailwayTrackTile(synthetic, entry.ix, entry.iz, {
      groundHeightAt: () => -12,
      masonryArches: true,
      masonryArchSegments: 10,
    });
    prototypeSpans += tile.arches.spans;
    prototypeSupports += tile.arches.supports;
    if (tile.masonry) {
      prototypeTris += tile.masonry.indices.length / 3;
      minimumY = Math.min(minimumY, ...tile.masonry.positions.filter((_, i) => i % 3 === 1));
      assert.ok(tile.masonry.positions.every(Number.isFinite));
      assert.ok(tile.masonry.normals.every(Number.isFinite));
    }
    const legacy = buildRailwayTrackTile(synthetic, entry.ix, entry.iz, {
      groundHeightAt: () => -12,
      masonryArches: false,
    });
    assert.deepEqual(legacy.arches, {
      spans: 0, supports: 0, culverts: 0, retainingBays: 0, retainingSupports: 0,
    });
    if (legacy.masonry) legacyTris += legacy.masonry.indices.length / 3;
    const xr = buildRailwayTrackTile(synthetic, entry.ix, entry.iz, {
      groundHeightAt: () => -12,
      masonryArchSegments: 8,
      masonryTrimLevel: 0,
      masonryColorVariation: 0.03,
    });
    const desktop = buildRailwayTrackTile(synthetic, entry.ix, entry.iz, {
      groundHeightAt: () => -12,
      masonryArchSegments: 16,
      masonryTrimLevel: 2,
      masonryColorVariation: 0.07,
    });
    if (xr.masonry) xrTris += xr.masonry.indices.length / 3;
    if (desktop.masonry) {
      desktopTris += desktop.masonry.indices.length / 3;
      assert.equal(desktop.masonry.colors.length, desktop.masonry.positions.length);
      desktopHasToneVariation ||= desktop.masonry.colors.some((value) => Math.abs(value - 1) > 1e-4);
    }
  }
  assert.deepEqual([...spanOwners].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.deepEqual([...supportOwners].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(prototypeSpans, 5);
  assert.equal(prototypeSupports, 6);
  assert.ok(minimumY <= -12.1, 'tapered masonry supports did not seat into the terrain');
  assert.ok(prototypeTris > legacyTris, 'A/B prototype did not add its arch silhouette');
  assert.ok(prototypeTris < 1800, `synthetic viaduct exceeded triangle budget: ${prototypeTris}`);
  assert.ok(desktopTris > xrTris, 'desktop masonry trim did not exceed simplified XR geometry');
  assert.ok(xrTris < 1500, `synthetic XR viaduct exceeded triangle budget: ${xrTris}`);
  assert.ok(desktopTris < 3000, `synthetic desktop viaduct exceeded triangle budget: ${desktopTris}`);
  assert.ok(desktopHasToneVariation, 'desktop masonry omitted deterministic vertex colour variation');
}

// Culverts use one flattened masonry arch across the complete wet run. The
// legacy A/B path retains the previous rectangular barrel for comparison.
{
  const xs = [-20, -10, 0, 10, 20];
  const count = xs.length - 1;
  const segments = new Float64Array(count * 8);
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    segments[o] = xs[i]; segments[o + 1] = 3.2; segments[o + 2] = 0;
    segments[o + 3] = xs[i + 1]; segments[o + 4] = 3.2; segments[o + 5] = 0;
    segments[o + 6] = i * 10; segments[o + 7] = (i + 1) * 10;
  }
  const culvert = new RailwayTrackIndex({
    version: 1, signature: 'synthetic-arched-culvert', tileSize: 20, routeLength: 40,
    segments,
    kinds: Uint8Array.from([0, 3, 3, 0]),
    families: Uint8Array.from([0, 3, 3, 0]),
    stations: new Float64Array(0),
  });
  assert.equal(culvert.masonryArchSpans.length, 1);
  assert.equal(culvert.masonryArchSpans[0].family, 'culvert');
  let archesBuilt = 0, supportsBuilt = 0, legacyMasonry = 0;
  for (const entry of culvert.tiles.values()) {
    const tile = buildRailwayTrackTile(culvert, entry.ix, entry.iz, { groundHeightAt: () => 0 });
    archesBuilt += tile.arches.culverts;
    supportsBuilt += tile.arches.supports;
    const legacy = buildRailwayTrackTile(culvert, entry.ix, entry.iz, {
      groundHeightAt: () => 0, masonryArches: false,
    });
    if (legacy.masonry) legacyMasonry += legacy.masonry.indices.length;
  }
  assert.equal(archesBuilt, 1);
  assert.equal(supportsBuilt, 2);
  assert.ok(legacyMasonry > 0, 'culvert A/B path omitted the legacy box barrel');
}

// High fills get recessed blind arches and buttresses, never open viaduct
// holes: backing vertices remain behind the complete lower half of each bay.
{
  const xs = [-30, -15, 0, 15, 30, 45];
  const count = xs.length - 1;
  const segments = new Float64Array(count * 8);
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    segments[o] = xs[i]; segments[o + 1] = 4.6; segments[o + 2] = 0;
    segments[o + 3] = xs[i + 1]; segments[o + 4] = 4.6; segments[o + 5] = 0;
    segments[o + 6] = i * 15; segments[o + 7] = (i + 1) * 15;
  }
  const retaining = new RailwayTrackIndex({
    version: 1, signature: 'synthetic-blind-arcade', tileSize: 30, routeLength: 75,
    segments,
    kinds: Uint8Array.from([0, 2, 2, 2, 0]),
    families: Uint8Array.from([0, 1, 1, 1, 0]),
    stations: new Float64Array(0),
  });
  assert.equal(retaining.masonryArchSpans.length, 0);
  assert.equal(retaining.retainingSpans.length, 3);
  assert.equal(retaining.retainingSupports.length, 4);
  let baysBuilt = 0, buttressesBuilt = 0, retainingTris = 0, legacyRetainingTris = 0;
  let hasRecessedBacking = false;
  for (const entry of retaining.tiles.values()) {
    const tile = buildRailwayTrackTile(retaining, entry.ix, entry.iz, { groundHeightAt: () => 0 });
    baysBuilt += tile.arches.retainingBays;
    buttressesBuilt += tile.arches.retainingSupports;
    const legacy = buildRailwayTrackTile(retaining, entry.ix, entry.iz, {
      groundHeightAt: () => 0, masonryArches: false,
    });
    if (legacy.masonry) legacyRetainingTris += legacy.masonry.indices.length / 3;
    if (!tile.masonry) continue;
    retainingTris += tile.masonry.indices.length / 3;
    const p = tile.masonry.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(Math.abs(p[i + 2]) - 2.17) < 1e-3 && p[i + 1] < 0) {
        hasRecessedBacking = true;
        break;
      }
    }
  }
  assert.equal(baysBuilt, 3);
  assert.equal(buttressesBuilt, 4);
  assert.ok(hasRecessedBacking, 'blind retaining arches omitted their solid recessed backing');
  assert.ok(legacyRetainingTris > 0, 'retaining A/B path omitted the legacy solid wall');
  assert.ok(retainingTris < 1500, `synthetic retaining arcade exceeded triangle budget: ${retainingTris}`);
}

console.log(`railwaystream PASS · ${index.tiles.size} indexed tiles · ${railTiles} rail tiles · ${sleepers} sleepers · ${masonryTris / 3} masonry tris · ${archSpans} arches (${culvertArches} culverts) · ${archSupports} masonry supports · ${retainingBays} blind retaining bays/${retainingSupports} buttresses · ${timberPiers} timber bents`);
