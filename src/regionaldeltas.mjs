import { fitRiverReach } from './riverterrain.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';

// Distributaries are a coastal composition, downstream of the drainage graph.
// Every arm shares the already solved sea head; none introduces a new inland
// receiver or a second authority for the parent river's banks.
export function addRegionalDelta(world, trunk, splitDistance = 180) {
  if (trunk.status !== 'baked') return trunk;
  const main = trunk.component.reaches.find(r => r.oceanMouth && r.channelProfile?.regionalTrunk);
  if (!main) return trunk;
  const end = main.points.at(-1), zero = main.points.findIndex(p => Math.abs(p.waterY) < 1e-9);
  if (zero < 0 || end.arc - main.points[zero].arc < 200) return { ...trunk, delta: { arms: 1, reason: 'short-tidal-reach' } };
  let split = main.points.findIndex(p => p.arc >= end.arc - splitDistance);
  split = Math.max(zero, split);
  const existing = splitDistance === 180 ? trunk.component.junctions.find(j =>
    j.nodeId === main.points[0].nodeId && Math.abs(j.waterY) < 1e-9) : null;
  if (existing) split = 0;
  const station = main.points[split], nodeId = existing?.nodeId || `delta:${main.id}`;
  const join = { ...station, nodeId };
  const upstream = { ...main, id: `${main.id}:inland`, oceanMouth: false,
    points: [...main.points.slice(0, split), join] };
  const primary = { ...main, id: `${main.id}:mouth`, sourceClosure: false,
    points: [join, ...main.points.slice(split + 1)].map(p => ({ ...p, arc: p.arc - station.arc })) };
  // The receiving channel separates into narrower distributaries, leaving
  // real dry sediment between them instead of hiding every fork in one wide
  // water ribbon. A tidal confluence can own that fork without a second,
  // overlapping junction authority.
  primary.points = primary.points.map(p => {
    const t = Math.min(1, p.arc / 96), taper = 1 - 0.55 * t * t * (3 - 2 * t);
    const q = { ...p };
    for (const side of ['left', 'right']) {
      q[`${side}Width`] *= taper;
      const offset = (q[`${side}Width`] + q[`${side}BankWidth`]) * (side === 'left' ? -1 : 1);
      q[`${side}BankY`] = world._naturalHeight(q.x - q.tz * offset, q.z + q.tx * offset);
    }
    return q;
  });
  const reaches = trunk.component.reaches.filter(r => r !== main).concat(existing ? [primary] : [upstream, primary]);
  const branches = [], reasons = [];
  for (const side of [-1, 1]) {
    const tx = end.tx * 0.85 - end.tz * side * 0.53, tz = end.tz * 0.85 + end.tx * side * 0.53;
    let outlet = null;
    for (const distance of [240, 320, 400, 560]) {
      const x = station.x + tx * distance, z = station.z + tz * distance;
      if (world._naturalHeight(x, z) < -0.25) { outlet = { x, z }; break; }
    }
    if (!outlet) continue;
    const points = Array.from({ length: 17 }, (_, i) => {
      const t = i / 16, bend = Math.sin(Math.PI * t) * 15 * side;
      return { x: station.x + (outlet.x - station.x) * t - tz * bend,
        z: station.z + (outlet.z - station.z) * t + tx * bend, waterY: 0 };
    });
    points[0] = { ...points[0], id: nodeId };
    const route = { status: 'candidate', id: `${main.id}:delta:${side}`, sourceClosure: false,
      oceanMouth: true, source: nodeId, points };
    const fitted = fitRiverReach(world, route, { id: route.id, sourceClosure: false, oceanMouth: true,
      maxFill: 2, maxCut: 16, maxGrade: 0, channelProfile: {
        id: route.id, halfWidth: 9, startHalfWidth: 10, endHalfWidth: 9, depth: 1.6,
        morphology: true, variationSeed: world.seed + side * 41,
      } });
    if (fitted.status === 'fitted') branches.push(fitted);
    else reasons.push(fitted.reason);
  }
  if (!branches.length) return { ...trunk, delta: { arms: 1, reason: 'tidal-banks', reasons } };
  const junction = { ...(existing || {}), id: existing?.id || nodeId, nodeId,
    x: station.x, z: station.z, waterY: 0,
    ...(existing ? {} : { incomingReachIds: [upstream.id] }), outgoingReachId: primary.id,
    outgoingReachIds: [primary.id, ...branches.map(r => r.id)], levelLength: existing?.levelLength || 180 };
  const component = { ...trunk.component, reaches: [...reaches, ...branches],
    junctions: [...trunk.component.junctions.filter(j => j !== existing).map(previous => ({ ...previous,
      ...(previous.incomingReachIds ? { incomingReachIds: previous.incomingReachIds
        .map(id => id === main.id ? upstream.id : id) } : {}),
      outgoingReachId: previous.outgoingReachId === main.id ? upstream.id : previous.outgoingReachId,
      ...(previous.outgoingReachIds ? { outgoingReachIds: previous.outgoingReachIds
        .map(id => id === main.id ? upstream.id : id) } : {}),
    })), junction] };
  const mesh = bakeSparseRiverComponent(world, component, { gridStep: 8, maxCells: 21000 });
  if (mesh.status !== 'baked') {
    if (['junction-collar-too-short', 'unowned-reach-overlap'].includes(mesh.reason) && splitDistance > 40) {
      return addRegionalDelta(world, trunk, splitDistance > 120 ? 120 : splitDistance > 72 ? 72 : 40);
    }
    return { ...trunk, delta: { arms: 1, reason: mesh.reason } };
  }
  return { ...trunk, component, mesh, delta: { arms: branches.length + 1, x: station.x, z: station.z } };
}
