import { prepareRiverReach, finishRiverReach } from './riverterrain.mjs';
import { solveRiverGraph } from './rivergraph.mjs';

// Fit bank/bed intervals before selecting any shared water heads. Routing
// elevations are preferences; only terrain, crossing and mouth intervals are
// hard constraints. Confluence geometry is a separate activation requirement.
export function fitRiverComponent(world, segmented, { fixedLevels = [], junctionLength = 0, mouthLength = 0,
  channelProfiles = null, ...options } = {}) {
  if (segmented.status !== 'candidate') return segmented;
  if (!Number.isFinite(junctionLength) || junctionLength < 0 || junctionLength > 256) {
    throw new Error('Invalid junction length');
  }
  if (!Number.isFinite(mouthLength) || mouthLength < 0 || mouthLength > 256) throw new Error('Invalid mouth length');
  if (channelProfiles !== null && (!channelProfiles || typeof channelProfiles !== 'object'
    || Array.isArray(channelProfiles) || segmented.reaches.some(r => !Object.hasOwn(channelProfiles, r.id)))) {
    throw new Error('Missing river channel profiles');
  }
  const junctionIds = new Set(segmented.junctions.map(junction => junction.nodeId));
  const nodes = new Map(), edges = [], prepared = [], found = new Set();
  for (const route of segmented.reaches) {
    const anchors = fixedLevels.filter(anchor => route.points.some(p =>
      anchor.nodeId ? p.id === anchor.nodeId : Math.hypot(p.x - anchor.x, p.z - anchor.z) < 1e-6));
    for (const anchor of anchors) found.add(anchor);
    const reach = prepareRiverReach(world, route, { ...options, id: route.id, fixedLevels: anchors,
      ...(channelProfiles ? { channelProfile: channelProfiles[route.id] } : {}),
      sourceClosure: route.sourceClosure, oceanMouth: route.oceanMouth });
    if (reach.status !== 'prepared') return reach;
    const atStart = junctionIds.has(reach.points[0].nodeId);
    const atEnd = junctionIds.has(reach.points.at(-1).nodeId);
    const totalArc = reach.points.at(-1).arc;
    const ids = reach.points.map((p, i) => p.nodeId ?? `section:${route.id}:${i}`);
    for (let i = 0; i < reach.points.length; i++) {
      const p = reach.points[i], id = ids[i], prior = nodes.get(id);
      if (prior) {
        if (prior.x !== p.x || prior.z !== p.z) throw new Error('Conflicting fitted junction coordinates');
        prior.minY = Math.max(prior.minY, p.minY); prior.maxY = Math.min(prior.maxY, p.maxY);
        prior.preferredY = Math.min(prior.preferredY, p.preferredY);
      } else nodes.set(id, { id, x: p.x, z: p.z, minY: p.minY, maxY: p.maxY, preferredY: p.preferredY });
      if (i) {
        const previous = reach.points[i - 1];
        // Include the segment crossing the requested boundary, so the whole
        // junction collar is level, not just the last point inside it. Adjacent
        // junction collars may meet; the same solve then reconciles both heads.
        const levelCollar = (junctionLength > 0 && ((atStart && previous.arc < junctionLength)
          || (atEnd && totalArc - p.arc < junctionLength)))
          || (route.oceanMouth && mouthLength > 0 && totalArc - p.arc < mouthLength);
        edges.push({ id: `${route.id}:${i}`, from: ids[i - 1], to: id,
          length: p.arc - previous.arc, ...(levelCollar ? { maxDrop: 0 } : {}) });
      }
    }
    prepared.push({ reach, ids });
  }
  if (found.size !== fixedLevels.length) return { status: 'retain-legacy', reason: 'missed-crossing-anchor' };
  const solved = solveRiverGraph([...nodes.values()], edges, { maxGrade: options.maxGrade ?? 0.025 });
  if (solved.status !== 'accepted') return solved;
  return { status: 'fitted', reaches: prepared.map(({ reach, ids }) =>
    finishRiverReach(reach, ids.map(id => solved.levels[id]))),
  junctions: segmented.junctions.map(junction => ({ ...junction, waterY: solved.levels[junction.nodeId],
    ...(junctionLength > 0 ? { levelLength: junctionLength } : {}) })) };
}
