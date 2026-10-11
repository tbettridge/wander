import { wetBasinAt } from './basinmembership.mjs';

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function segmentDistance(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

// Conservative ownership for the terrain envelopes that meet at a confluence.
// This prepares meshing regions; it does not permit overlapping runtime fields.
// A section field never samples farther from its centreline than its full
// bank envelope, so `preciseOwnership` components may skip rectangle overlaps
// whose segments are farther apart than both envelopes combined.
export function prepareRiverJunctions(component) {
  if (component.status !== 'fitted') return component;
  const precise = component.preciseOwnership === true;
  const regions = new Map(component.junctions.map(j => [j.nodeId, {
    id: j.id, nodeId: j.nodeId, waterY: j.waterY, reachIds: new Set(), bounds: null,
  }]));
  const reaches = component.reaches.map(reach => ({ reach, segments: reach.points.slice(1).map((b, i) => {
    const a = reach.points[i];
    const margin = Math.max(...[a, b].flatMap(p => ['left', 'right'].map(side =>
      p[`${side}Width`] + p[`${side}BankWidth`] + p[`${side}BlendWidth`])));
    return { a, b, margin, bounds: { minX: Math.min(a.x, b.x) - margin, maxX: Math.max(a.x, b.x) + margin,
      minZ: Math.min(a.z, b.z) - margin, maxZ: Math.max(a.z, b.z) + margin } };
  }) }));
  const endpoints = reach => [reach.points[0].nodeId, reach.points.at(-1).nodeId];
  const overlap = (a, b) => {
    const box = { minX: Math.max(a.minX, b.minX), minZ: Math.max(a.minZ, b.minZ),
      maxX: Math.min(a.maxX, b.maxX), maxZ: Math.min(a.maxZ, b.maxZ) };
    return box.minX < box.maxX && box.minZ < box.maxZ ? box : null;
  };
  for (let i = 0; i < reaches.length; i++) for (let k = i + 1; k < reaches.length; k++) {
    const left = reaches[i], right = reaches[k];
    if (!overlap(left.reach.bounds, right.reach.bounds)) continue;
    const owners = endpoints(left.reach).filter(id => regions.has(id) && endpoints(right.reach).includes(id));
    for (const a of left.segments) for (const b of right.segments) {
      const box = overlap(a.bounds, b.bounds);
      if (!box || (precise && segmentDistance(a.a, a.b, b.a, b.b) >= a.margin + b.margin)) continue;
      // Segment rectangles overestimate the footprint. A conservative rejection
      // is preferable to certifying two different heads in an overlapping bank.
      const owner = owners.map(id => regions.get(id)).find(region =>
        [a.a, a.b, b.a, b.b].every(p => Math.abs(p.waterY - region.waterY) <= 1e-9));
      // Separate inlet/outlet endpoints can meet through the same lake rather
      // than through a three-arm river junction. Their overlapping envelopes
      // must already share the exact lake head and touch its connected water.
      const lakeOwner = (component.basins || []).find(lake =>
        left.reach.basinIds?.includes(lake.id) && right.reach.basinIds?.includes(lake.id)
        && [a.a, a.b, b.a, b.b].every(p => Math.abs(p.waterY - lake.level) <= 1e-9)
        && wetBasinAt([lake], (box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2));
      if (!owner && lakeOwner) continue;
      if (!owner) return { status: 'rejected', reason: owners.length ? 'junction-collar-too-short' : 'unowned-reach-overlap',
        reachIds: [left.reach.id, right.reach.id].sort(), bounds: box };
      owner.reachIds.add(left.reach.id); owner.reachIds.add(right.reach.id);
      owner.bounds = owner.bounds ? { minX: Math.min(owner.bounds.minX, box.minX), minZ: Math.min(owner.bounds.minZ, box.minZ),
        maxX: Math.max(owner.bounds.maxX, box.maxX), maxZ: Math.max(owner.bounds.maxZ, box.maxZ) } : box;
    }
  }
  const junctions = [...regions.values()].map(region => ({ ...region, reachIds: [...region.reachIds].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const junction of junctions) if (!junction.bounds || junction.reachIds.length < 3) {
    return { status: 'rejected', reason: 'incomplete-confluence', junctionId: junction.id };
  }
  for (let i = 0; i < junctions.length; i++) for (let k = i + 1; k < junctions.length; k++) {
    if (overlap(junctions[i].bounds, junctions[k].bounds)) {
      return { status: 'rejected', reason: 'overlapping-junction-regions', junctionIds: [junctions[i].id, junctions[k].id] };
    }
  }
  return { status: 'prepared', junctions, activationReady: false };
}
