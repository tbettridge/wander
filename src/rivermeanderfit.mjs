import { proposeRiverMeanders } from './rivermeanders.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';

// Preview readiness and publication use the exact mesh already validated here.
// Keying by the immutable fitted sections survives the planner's metadata spread
// without putting a second large grid into the serialized network report.
const validatedMeshes = new WeakMap();
export const validatedMeanderMesh = component => validatedMeshes.get(component.reaches);

// Check the fitted curve, after Hermite resampling. A safe proposal polyline
// alone cannot rule out an overshoot bringing two distant bank envelopes together.
export function meanderFootprintsSeparated(reaches) {
  const radius = p => Math.max(p.leftWidth + p.leftBankWidth + p.leftBlendWidth,
    p.rightWidth + p.rightBankWidth + p.rightBlendWidth);
  const distance = (p, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
  };
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  for (const reach of reaches) {
    const points = reach.points, radii = points.map(radius);
    for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
      const a = points[i - 1], b = points[i], c = points[j - 1], d = points[j];
      const clearance = Math.max(radii[i - 1], radii[i]) + Math.max(radii[j - 1], radii[j]);
      // Neighboring swept sections overlap intentionally; local curvature is
      // constrained by prepareRiverReach. Test only distant pieces of the reach.
      if (c.arc - b.arc < clearance * 1.5) continue;
      if (Math.min(c.x, d.x) - Math.max(a.x, b.x) >= clearance
        || Math.min(a.x, b.x) - Math.max(c.x, d.x) >= clearance
        || Math.min(c.z, d.z) - Math.max(a.z, b.z) >= clearance
        || Math.min(a.z, b.z) - Math.max(c.z, d.z) >= clearance) continue;
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
        || Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b)) < clearance) return false;
    }
  }
  return true;
}

function shapeChange(baseline, fitted) {
  let maxExcursion = 0, target = null, focusScore = 0, changedReaches = 0;
  const reaches = fitted.reaches.map(reach => {
    const before = baseline.reaches.find(r => r.id === reach.id);
    let excursion = 0, reachTarget = null;
    for (const p of reach.points) {
      let nearest = Infinity;
      for (let i = 1; i < before.points.length; i++) {
        const a = before.points[i - 1], b = before.points[i], dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
        nearest = Math.min(nearest, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
      }
      if (nearest > excursion) { excursion = nearest; reachTarget = { x: p.x, z: p.z }; }
      maxExcursion = Math.max(maxExcursion, nearest);
    }
    if (excursion > 1) changedReaches++;
    const span = Math.hypot(reach.points.at(-1).x - reach.points[0].x, reach.points.at(-1).z - reach.points[0].z);
    const sinuosity = reach.points.at(-1).arc / span;
    const score = excursion * Math.max(0.01, sinuosity - before.points.at(-1).arc / span);
    if (score > focusScore) { focusScore = score; target = reachTarget; }
    return { id: reach.id, excursion, sinuosity };
  });
  return { changedReaches, maxExcursion, target, reaches };
}

// Run once after a component's source routing is complete. Routing nodes remain
// the drainage skeleton; fitted sections and their canonical mesh are the only
// authority for the displaced banks, terrain, rendered water and collision.
// No extra routing or unbounded search is added to the walking stream.
export function fitRiverMeanders(world, segmented, baseline, options = {}) {
  if (baseline.status !== 'fitted') throw new Error('Meanders require a fitted baseline');
  const attempts = [];
  for (const strength of [1, 0.6, 0.3]) {
    const proposal = proposeRiverMeanders(world, segmented, { ...options, seed: world.seed, strength });
    const fitted = fitRiverComponent(world, proposal, options);
    if (fitted.status !== 'fitted') {
      attempts.push({ strength, stage: 'fit', reason: fitted.reason }); continue;
    }
    if (!meanderFootprintsSeparated(fitted.reaches)) {
      attempts.push({ strength, stage: 'shape', reason: 'meander-bank-self-overlap' }); continue;
    }
    const change = shapeChange(baseline, fitted);
    if (!change.changedReaches) {
      attempts.push({ strength, stage: 'shape', reason: 'terrain-retained-straight-reaches' }); continue;
    }
    const candidate = { ...baseline, ...fitted };
    const ownership = prepareRiverJunctions(candidate);
    if (ownership.status !== 'prepared') {
      attempts.push({ strength, stage: 'junctions', reason: ownership.reason }); continue;
    }
    const mesh = bakeSparseRiverComponent(world, candidate);
    if (mesh.status !== 'baked') {
      attempts.push({ strength, stage: 'mesh', reason: mesh.reason }); continue;
    }
    validatedMeshes.set(candidate.reaches, mesh);
    return { ...candidate, meanders: { status: 'accepted', strength, attempts, ...change,
      proposal: proposal.diagnostics } };
  }
  return { ...baseline, meanders: { status: 'retained-baseline', attempts } };
}
