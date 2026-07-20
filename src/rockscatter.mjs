// Deterministic, chunk-boundary-safe rock cluster planning. Geometry remains
// main-thread/THREE-owned; this pure module only describes where rocks belong
// and how their size hierarchy should read.

import { mulberry32, smoothstep } from './noise.js';
import { VARIANT_COUNTS } from './vegdata.js';

export const ROCK_CLUSTER_CELL = 36;
export const ROCK_CLUSTER_RADIUS = 13;

function mix(a, b, t) { return a + (b - a) * t; }
function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

function rockCellSeed(worldSeed, gx, gz) {
  let h = (worldSeed | 0) ^ Math.imul(gx, 0x51d7348d) ^ Math.imul(gz, 0x7f4a7c15);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function terrainDirection(world, x, z) {
  const e = 3;
  const dx = world.height(x - e, z) - world.height(x + e, z);
  const dz = world.height(x, z - e) - world.height(x, z + e);
  const length = Math.hypot(dx, dz);
  return length > 1e-5 ? { x: dx / length, z: dz / length, strength: length / (e * 2) }
    : { x: 1, z: 0, strength: 0 };
}

function variantFor(rng, biome, slope, scale) {
  let choices;
  if (slope > 0.48) choices = [1, 2, 4, 6];       // wedge / slab / angular / split
  else if (scale > 4.5) choices = [0, 3, 5, 6];   // block / shoulder / monolith / split
  else if (biome === 'desert' || biome === 'savanna') choices = [1, 2, 3, 4];
  else choices = [0, 2, 3, 4, 7];                 // broad, grounded field silhouettes
  return choices[(rng() * choices.length) | 0] % VARIANT_COUNTS.rock;
}

function clusterAt(world, gx, gz) {
  const rng = mulberry32(rockCellSeed(world.seed, gx, gz));
  const x = (gx + 0.14 + rng() * 0.72) * ROCK_CLUSTER_CELL;
  const z = (gz + 0.14 + rng() * 0.72) * ROCK_CLUSTER_CELL;
  const biome = world.biomeAt(x, z);
  if (!biome || biome.id === 'ocean' || biome.h < 0.5) return null;

  // Exposed/steep/high ground accumulates stone; flatter grass and forest still
  // receive occasional landmark groups rather than a uniform pebble sprinkle.
  const exposure = 0.28
    + biome.slope * 0.68
    + smoothstep(85, 155, biome.h) * 0.18
    + smoothstep(0.48, 0.78, biome.slope) * 0.24;
  if (rng() > Math.min(0.82, exposure)) return null;

  const direction = terrainDirection(world, x, z);
  const randomAngle = rng() * Math.PI * 2;
  const downhillAngle = Math.atan2(direction.z, direction.x);
  const heading = direction.strength > 0.08
    ? downhillAngle + (rng() - 0.5) * 0.55
    : randomAngle;
  const rareHero = rng() < 0.035;
  const large = rareHero || rng() < 0.24 + biome.slope * 0.18;
  const leaderScale = rareHero ? 5.8 + rng() * 2.7
    : large ? 2.8 + rng() * 2.5
      : 1.35 + rng() * 1.65;
  const solitary = !large && biome.slope < 0.22 && rng() < 0.22;
  const count = solitary ? 1 : 4 + (rng() * (large ? 7 : 5) | 0);
  const spread = clamp(leaderScale * (1.55 + rng() * 0.65), 3.2, ROCK_CLUSTER_RADIUS);
  const alongStretch = 1.0 + smoothstep(0.18, 0.65, biome.slope) * 1.0;
  const members = [];

  for (let index = 0; index < count; index++) {
    let memberX = x, memberZ = z, scale = leaderScale;
    if (index > 0) {
      const radial = Math.sqrt(rng());
      const angle = rng() * Math.PI * 2;
      const along = Math.cos(angle) * radial * spread * alongStretch;
      const across = Math.sin(angle) * radial * spread * (0.48 + rng() * 0.28);
      const hx = Math.cos(heading), hz = Math.sin(heading);
      memberX += hx * along - hz * across;
      memberZ += hz * along + hx * across;
      const secondary = index <= 2;
      scale = secondary
        ? leaderScale * (0.38 + rng() * 0.34)
        : leaderScale * (0.10 + rng() * 0.25);
      scale = clamp(scale, 0.18, leaderScale * 0.76);
    }

    const memberBiome = world.biomeAt(memberX, memberZ);
    if (!memberBiome || memberBiome.id === 'ocean' || memberBiome.h < 0.45) continue;
    const type = scale >= 1.12 ? 'boulder' : 'rock';
    const variant = variantFor(rng, memberBiome.id, memberBiome.slope, scale)
      % VARIANT_COUNTS[type];
    const broadness = 0.82 + rng() * 0.42;
    const depth = 0.82 + rng() * 0.42;
    const height = variant === 2 ? 0.72 + rng() * 0.18
      : variant === 5 ? 1.08 + rng() * 0.22
        : 0.84 + rng() * 0.28;
    members.push({
      clusterX: x,
      clusterZ: z,
      x: memberX,
      z: memberZ,
      type,
      variant,
      scale,
      scaleX: scale * broadness,
      scaleY: scale * height,
      scaleZ: scale * depth,
      yaw: heading + (rng() - 0.5) * 1.35,
      burial: variant === 2 ? 0.18 + rng() * 0.10
        : type === 'boulder' ? 0.34 + rng() * 0.15
          : 0.25 + rng() * 0.13,
      leader: index === 0,
    });
  }
  return { gx, gz, x, z, heading, leaderScale, members };
}

export function rockClustersForChunk(world, cx, cz, chunkSize) {
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const minGX = Math.floor((x0 - ROCK_CLUSTER_RADIUS) / ROCK_CLUSTER_CELL);
  const maxGX = Math.floor((x0 + chunkSize + ROCK_CLUSTER_RADIUS) / ROCK_CLUSTER_CELL);
  const minGZ = Math.floor((z0 - ROCK_CLUSTER_RADIUS) / ROCK_CLUSTER_CELL);
  const maxGZ = Math.floor((z0 + chunkSize + ROCK_CLUSTER_RADIUS) / ROCK_CLUSTER_CELL);
  const clusters = [];
  for (let gz = minGZ; gz <= maxGZ; gz++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      const cluster = clusterAt(world, gx, gz);
      if (cluster) clusters.push(cluster);
    }
  }
  return clusters;
}

export function rockPlacementsForChunk(world, cx, cz, chunkSize) {
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const placements = [];
  for (const cluster of rockClustersForChunk(world, cx, cz, chunkSize)) {
    for (const member of cluster.members) {
      // Half-open ownership means a cluster crossing a chunk boundary is emitted
      // exactly once by each member's containing chunk, never duplicated.
      if (member.x >= x0 && member.x < x0 + chunkSize
        && member.z >= z0 && member.z < z0 + chunkSize) placements.push(member);
    }
  }
  return placements;
}
