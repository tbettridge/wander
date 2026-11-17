// Walk a whole railway line and list everything a passing train would drive
// through: terrain that the chunk mesh draws inside the clearance envelope,
// and scattered rocks, boulders or tree trunks inside it. The bore of every
// tunnel is held to the same rule against both.
//
// This mirrors the real pipeline rather than the analytic surface: terrain is
// sampled on the exact triangles `buildTerrainArrays` emits at each level of
// detail (or the water lattice where a chunk has one), and props come from the
// same `buildScatter`/`buildClutter` calls and railway filters the chunk worker
// runs. A count of zero for a seed is the promise "riding this line, nothing
// passes through the carriage".
//
// Pure and THREE-free: runs in Node tests, scripts, and the page console.

import { RAILWAY_CLEARANCE, railwayPropBounds, railwayPropIntrudes } from './railwayenvelope.mjs';
import { PORTAL_MOUTH } from './railwaytunnel.mjs';
import { buildScatter, buildClutter } from './chunkgen.js';
import { filterRailwayChunkProps } from './railwaychunkprops.mjs';

const CHUNK_SIZE = 140;
// Within a few metres either side of each portal plane the terrain curtain cut
// drops every triangle in the mouth, and the portal facade and its returns
// frame the opening; the mesh there is not what a rider sees.
const PORTAL_FRAME = PORTAL_MOUTH.reach + 0.8;

// Every grid the terrain around the rider can be drawn on: the nearest two
// rings use the quality tier's `nearRes` (potato 48, low 56, default 64,
// medium 72, XR 80, high 96, ultra 112), and the train a rider sits in is
// always inside them. Coarser rings start a full chunk away and only ever
// show a distant train, so they are not part of the promise.
export const RAILWAY_NEAR_TERRAIN_RESOLUTIONS = Object.freeze([48, 56, 64, 72, 80, 96, 112]);

function structureAtArc(plan, arc) {
  const route = plan.route, points = plan.points;
  let low = 0, high = route.sampleCount;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (route.arc[mid] <= arc) low = mid;
    else high = mid;
  }
  const i = Math.min(low, points.length - 1);
  const a = points[i].structure, b = points[(i + 1) % points.length].structure;
  return a === 'bridge' || b === 'bridge' ? 'bridge' : a;
}

function portalArcs(plan) {
  const out = [];
  const n = plan.points.length;
  for (let i = 0; i < n; i++) {
    const here = plan.points[i].structure === 'tunnel';
    const next = plan.points[(i + 1) % n].structure === 'tunnel';
    if (here !== next) out.push(plan.route.arc[i + 1]);
  }
  return out;
}

/** Terrain mesh height at (x, z) for a chunk drawn on a `res` grid (or the
 * water lattice the chunk is forced onto), on the mesher's own triangles. */
function renderedTerrainSampler(world, res) {
  const cache = new Map();
  const vertex = (step, ix, iz) => {
    const key = `${step}:${ix},${iz}`;
    let height = cache.get(key);
    if (height === undefined) {
      height = world.height(ix * step, iz * step);
      cache.set(key, height);
    }
    return height;
  };
  const steps = new Map();
  const stepFor = (x, z) => {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    let step = steps.get(key);
    if (step === undefined) {
      const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
      const water = world.waterField?.gridStep(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
      step = CHUNK_SIZE / (water ? Math.ceil(CHUNK_SIZE / water) : res);
      steps.set(key, step);
    }
    return step;
  };
  return (x, z) => {
    const step = stepFor(x, z);
    const gx = Math.floor(x / step + 1e-9), gz = Math.floor(z / step + 1e-9);
    const fx = x / step - gx, fz = z / step - gz;
    if (fx + fz <= 1) {
      const h00 = vertex(step, gx, gz);
      return h00 + (vertex(step, gx + 1, gz) - h00) * fx + (vertex(step, gx, gz + 1) - h00) * fz;
    }
    const h11 = vertex(step, gx + 1, gz + 1);
    return h11 + (vertex(step, gx, gz + 1) - h11) * (1 - fx) + (vertex(step, gx + 1, gz) - h11) * (1 - fz);
  };
}

/**
 * Terrain intrusions along the line for each mesh resolution in `resolutions`.
 * Returns `{ [res]: { samples, intrusions: [{ arc, x, z, structure, lateral,
 * over }] } }` where `over` is how far into the envelope the ground rises.
 */
export function auditRailwayTerrain(world, plan, {
  resolutions = RAILWAY_NEAR_TERRAIN_RESOLUTIONS,
  step = 1,
  lateralStep = 0.25,
  limit = Infinity,
} = {}) {
  const route = plan.route;
  const portals = portalArcs(plan);
  const result = {};
  for (const res of resolutions) {
    const heightAt = renderedTerrainSampler(world, res);
    const intrusions = [];
    let samples = 0;
    const sample = {};
    for (let arc = 0; arc < route.length; arc += step) {
      route.sampleAtDistance(arc, sample);
      const structure = structureAtArc(plan, arc);
      const tunnel = structure === 'tunnel';
      if (portals.some((p) => Math.abs(arc - p) < PORTAL_FRAME)) continue;
      const hyp = Math.hypot(sample.tangentX, sample.tangentZ) || 1;
      const rx = sample.tangentZ / hyp, rz = -sample.tangentX / hyp;
      const halfWidth = tunnel ? RAILWAY_CLEARANCE.boreHalfWidth - 0.25 : RAILWAY_CLEARANCE.halfWidth;
      const floor = sample.y + RAILWAY_CLEARANCE.floor;
      const top = sample.y + (tunnel ? RAILWAY_CLEARANCE.boreTop : Infinity);
      let worst = null;
      for (let lateral = -halfWidth; lateral <= halfWidth + 1e-9; lateral += lateralStep) {
        const x = sample.x + rx * lateral, z = sample.z + rz * lateral;
        const h = heightAt(x, z);
        samples++;
        // Open line: no ground over the rails. Tunnel: no ground surface
        // between the rails and the crown (above it the bore is buried, below
        // it the lining stands clear of the ground, which a rider can't see).
        if (h > floor && h < top) {
          const over = tunnel ? Math.min(h - floor, top - h) : h - floor;
          if (!worst || over > worst.over) worst = { arc, x, z, structure, lateral, over, ground: h, rail: sample.y };
        }
      }
      if (worst) {
        intrusions.push(worst);
        if (intrusions.length >= limit) break;
      }
    }
    result[res] = { samples, intrusions };
  }
  return result;
}

function chunksAlongLine(plan, reach) {
  const chunks = new Map();
  const route = plan.route, sample = {};
  for (let arc = 0; arc < route.length; arc += 4) {
    route.sampleAtDistance(arc, sample);
    const minX = Math.floor((sample.x - reach) / CHUNK_SIZE), maxX = Math.floor((sample.x + reach) / CHUNK_SIZE);
    const minZ = Math.floor((sample.z - reach) / CHUNK_SIZE), maxZ = Math.floor((sample.z + reach) / CHUNK_SIZE);
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) chunks.set(`${cx},${cz}`, { cx, cz });
    }
  }
  return [...chunks.values()];
}

/**
 * Props the chunk worker would emit that reach into the clearance, for the
 * near-ring settings (`res`, densities) given. Each entry names the type,
 * variant, position and structure it intrudes on.
 */
export function auditRailwayProps(world, plan, {
  res = 64,
  treeDensityScale = 1,
  clutterDensityScale = 1,
  unfiltered = false,
} = {}) {
  const index = world.railwayTerrain;
  const intrusions = [];
  let instances = 0;
  const chunks = chunksAlongLine(plan, 24);
  for (const { cx, cz } of chunks) {
    let scatter = buildScatter(world, cx, cz, CHUNK_SIZE, { mode: 'full', treeDensityScale, res });
    let clutter = buildClutter(world, cx, cz, CHUNK_SIZE, { clutterDensityScale });
    if (!unfiltered) {
      scatter = filterRailwayChunkProps(world, scatter, 'treeClearance', 0.14);
      clutter = filterRailwayChunkProps(world, clutter, 'plantClearance', 0.12);
    }
    for (const bucket of [...scatter, ...clutter]) {
      const bounds = railwayPropBounds(bucket.type, bucket.variant);
      const count = bucket.matrices.length / 16;
      instances += count;
      if (!bounds) continue;
      for (let i = 0; i < count; i++) {
        const hit = railwayPropIntrudes(index, bucket.matrices, i * 16, bounds);
        if (!hit) continue;
        intrusions.push({
          type: bucket.type, variant: bucket.variant, chunk: `${cx},${cz}`,
          x: bucket.matrices[i * 16 + 12], y: bucket.matrices[i * 16 + 13], z: bucket.matrices[i * 16 + 14],
          scale: Math.hypot(bucket.matrices[i * 16], bucket.matrices[i * 16 + 1], bucket.matrices[i * 16 + 2]),
          structure: ['surface', 'cut', 'fill', 'bridge', 'tunnel'][hit.kind],
          distance: hit.distance,
        });
      }
    }
  }
  return { chunks: chunks.length, instances, intrusions };
}

/** Both audits, summarised. */
export function auditRailwayClearance(world, plan, options = {}) {
  const terrain = auditRailwayTerrain(world, plan, options.terrain);
  const props = auditRailwayProps(world, plan, options.props);
  return { length: plan.route.length, terrain, props };
}
