// The migration boundary is realised geometry, not a second invocation of a
// terrain-dependent crossing solver. This format contains no World references,
// functions or worker-local caches and survives JSON/structuredClone transport.
import { solveCrossing } from './trailcrossings.mjs';
import { trailFrameAtArc } from './trails.js';
import { buildCrossingRecipe, CROSSING_RECIPE_VERSION } from './crossinggeometry.mjs';

export const CROSSING_MANIFEST_VERSION = 1;
const BUFFER = 32;

import { plain, descriptorHash } from './hydrologyformat.mjs';
export { descriptorHash } from './hydrologyformat.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function captureCrossingManifest(world, edges, { layoutSignature = 'unmodified-terrain' } = {}) {
  if (world.generationVersion !== 2) throw new Error('Capture crossings from the isolated version 2 world');
  const routes = [], crossings = [];
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    routes.push(plain(edge));
    for (let index = 0; index < (edge.fords || []).length; index++) {
      const ford = edge.fords[index], id = `${edge.id}:crossing:${index}`;
      const solved = solveCrossing(world, edge, ford);
      // Preserve rejected crossings too; changed ground must not materialise a
      // new structure on an existing route merely by re-running the solver.
      if (!solved) { crossings.push({ id, edgeId: edge.id, index, solved: null, recipe: null }); continue; }
      const recipe = buildCrossingRecipe(world, edge, ford, id, solved);
      const arcStart = Math.max(0, Math.min(solved.arcStart, solved.wetStart) - BUFFER);
      const arcEnd = Math.min(edge.arcLength, Math.max(solved.arcEnd, solved.wetEnd) + BUFFER);
      const count = Math.max(1, Math.ceil((arcEnd - arcStart) / 4));
      const points = [];
      for (let k = 0; k <= count; k++) {
        const arc = arcStart + (arcEnd - arcStart) * k / count;
        const frame = trailFrameAtArc(edge, arc, {});
        const water = world.riverAt(frame.x, frame.z);
        points.push({ arc, x: frame.x, z: frame.z, floor: world.height(frame.x, frame.z),
          wet: water.wet, waterY: water.y });
      }
      const radius = solved.halfWidth + BUFFER;
      const bounds = {
        minX: Math.min(...points.map(p => p.x)) - radius,
        minZ: Math.min(...points.map(p => p.z)) - radius,
        maxX: Math.max(...points.map(p => p.x)) + radius,
        maxZ: Math.max(...points.map(p => p.z)) + radius,
      };
      // These are conservative design intervals; they never authorise changing
      // a foothold or imply that a longitudinal profile has been solved.
      const tolerance = solved.kind === 'bridge' ? 0.25 : 0.02;
      const maxWater = solved.kind === 'bridge'
        ? solved.surfaceY - 0.52 : solved.waterY + tolerance;
      crossings.push({ id, edgeId: edge.id, index, solved: plain(solved), recipe,
        reservation: { radius, arcStart, arcEnd, points, bounds },
        waterInterval: [solved.waterY - tolerance, Math.min(solved.waterY + tolerance, maxWater)] });
    }
  }
  const payload = plain({ version: CROSSING_MANIFEST_VERSION, recipeVersion: CROSSING_RECIPE_VERSION,
    generationVersion: 2, seed: world.seed, layoutSignature, routes, crossings });
  return freeze({ ...payload, hash: descriptorHash(payload) });
}

export { readCrossingManifest, CrossingReservations } from './crossingregistry.mjs';
