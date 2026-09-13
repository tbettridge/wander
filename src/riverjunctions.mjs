// Conservative ownership for the terrain envelopes that meet at a confluence.
// This prepares meshing regions; it does not permit overlapping runtime fields.
export function prepareRiverJunctions(component) {
  if (component.status !== 'fitted') return component;
  const regions = new Map(component.junctions.map(j => [j.nodeId, {
    id: j.id, nodeId: j.nodeId, waterY: j.waterY, reachIds: new Set(), bounds: null,
  }]));
  const reaches = component.reaches.map(reach => ({ reach, segments: reach.points.slice(1).map((b, i) => {
    const a = reach.points[i];
    const margin = Math.max(...[a, b].flatMap(p => ['left', 'right'].map(side =>
      p[`${side}Width`] + p[`${side}BankWidth`] + p[`${side}BlendWidth`])));
    return { a, b, bounds: { minX: Math.min(a.x, b.x) - margin, maxX: Math.max(a.x, b.x) + margin,
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
      if (!box) continue;
      // Segment rectangles overestimate the footprint. A conservative rejection
      // is preferable to certifying two different heads in an overlapping bank.
      const owner = owners.map(id => regions.get(id)).find(region =>
        [a.a, a.b, b.a, b.b].every(p => Math.abs(p.waterY - region.waterY) <= 1e-9));
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
