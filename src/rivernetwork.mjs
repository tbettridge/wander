import { RiverRoutePlanner } from './riverroute.mjs';
import { mergeRiverRoutes, segmentRiverGraph } from './rivergraph.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { buildRiverHierarchy } from './riverhierarchy.mjs';
import { fitRiverMeanders } from './rivermeanderfit.mjs';

// Planning descriptors only. A fitted source-to-sea graph still needs bounded
// junction/mouth meshes before it can replace terrain in the runtime field.
export function planRiverNetwork(world, sources, { maxSources = 81, maxVisited = 2048,
  junctionLength = 64, mouthLength = 0, riverCharacter = false, riverMeanders = false,
  riverMorphology = false } = {}) {
  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 256
    || !Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Array.isArray(sources) || sources.length > maxSources
    || !Number.isFinite(junctionLength) || junctionLength < 0 || junctionLength > 256
    || !Number.isFinite(mouthLength) || mouthLength < 0 || mouthLength > 256
    || typeof riverCharacter !== 'boolean'
    || typeof riverMeanders !== 'boolean'
    || typeof riverMorphology !== 'boolean'
    || !sources.every(p => p && [p.x, p.z].every(Number.isFinite)
      && (p.drainageContribution === undefined || (Number.isFinite(p.drainageContribution) && p.drainageContribution > 0))
      && (p.id === undefined || (typeof p.id === 'string' && p.id.length)))) throw new Error('Invalid network source budget');
  const ordered = sources.map(p => ({ ...p, id: p.id || `source:${p.x},${p.z}`,
    height: world._naturalHeight(p.x, p.z) }))
    .sort((a, b) => b.height - a.height || a.id.localeCompare(b.id));
  if (new Set(ordered.map(p => p.id)).size !== ordered.length
    || new Set(ordered.map(p => `${p.x},${p.z}`)).size !== ordered.length) throw new Error('Duplicate network source');
  const sourceById = new Map(ordered.map(source => [source.id, source]));
  const planner = new RiverRoutePlanner(world, { maxVisited });
  const targets = new Map(), owners = new Map(), groups = new Set(), rejected = [];
  let joinedSources = 0;
  for (const source of ordered) {
    const branch = planner.route(source, { deferProfile: true, downstream: targets });
    if (branch.status !== 'candidate') { rejected.push({ source: source.id, reason: branch.reason }); continue; }
    const owner = branch.joins ? owners.get(branch.joins) : null;
    // Reuse the exact downstream path, rather than independently routing past
    // the meeting point and creating a split or a second overlapping channel.
    const suffix = owner?.routes.find(r => r.points.some(p => p.id === branch.joins));
    const tail = suffix ? suffix.points.slice(suffix.points.findIndex(p => p.id === branch.joins) + 1) : [];
    const points = [...branch.points, ...tail].map(p => ({ ...p }));
    let arc = 0;
    for (let i = 0; i < points.length; i++) {
      if (i) arc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      points[i].arc = arc;
    }
    if (points.length < 2 || new Set(points.map(p => p.id)).size !== points.length) {
      rejected.push({ source: source.id, reason: 'degenerate-network-source' }); continue;
    }
    const route = { ...branch, points, outlet: points.at(-1).id };
    const routes = [...(owner?.routes || []), route];
    const graph = mergeRiverRoutes(routes);
    if (graph.status !== 'candidate') { rejected.push({ source: source.id, reason: graph.reason }); continue; }
    const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(p => [p.id, p.preferredY])));
    let hierarchy = null;
    if (riverCharacter || riverMorphology) {
      // This first preview accumulates explicit contributions on the accepted
      // local route graph. A unit per headwater is a source-count proxy, not a
      // cross-region catchment survey. Downstream shared suffixes count once.
      const receivers = new Set(graph.edges.map(edge => edge.from));
      const terminals = graph.nodes.filter(node => !receivers.has(node.id)).map(node => ({
        nodeId: node.id, kind: 'ocean',
        verified: routes.some(r => !r.joins && r.outlet === node.id)
          && world._naturalHeight(node.x, node.z) < -0.25,
      }));
      hierarchy = buildRiverHierarchy(graph, segmented, {
        seed: world.seed,
        riverMorphology,
        defaultSourceContribution: 1,
        sourceContributions: routes.filter(r => sourceById.get(r.source)?.drainageContribution !== undefined)
          .map(r => ({ id: r.source, nodeId: r.points[0].id,
            contribution: sourceById.get(r.source).drainageContribution })),
        terminals,
      });
      if (hierarchy.status !== 'planned' || hierarchy.unsupportedProfiles.length) {
        rejected.push({ source: source.id,
          reason: hierarchy.reason || hierarchy.unsupportedProfiles[0].reason }); continue;
      }
    }
    let fitted;
    // Increase the level collar only when the actual bank overlap needs it.
    // Each attempt re-solves terrain constraints; longer collars cannot force
    // an incompatible head or silently flatten an already fitted river.
    for (const length of [...new Set([junctionLength, ...[96, 128, 192, 256].filter(n => n > junctionLength)])]) {
      fitted = fitRiverComponent(world, segmented, { junctionLength: length, mouthLength,
        ...(hierarchy ? { channelProfiles: hierarchy.channelProfiles } : {}) });
      if (fitted.status !== 'fitted') break;
      const ownership = prepareRiverJunctions(fitted);
      if (ownership.status === 'prepared') break;
      fitted = ownership;
      if (ownership.reason !== 'junction-collar-too-short') break;
    }
    if (fitted.status !== 'fitted') { rejected.push({ source: source.id, reason: fitted.reason }); continue; }
    const group = { routes, graph, segmented, fitted, hierarchy };
    if (owner) { groups.delete(owner); joinedSources++; }
    groups.add(group);
    // Publish ownership only after every reach in the enlarged group fits.
    // A rejected tributary cannot alter the accepted downstream component.
    for (const r of routes) for (const p of r.points) {
      owners.set(p.id, group);
      // Arbitrary source IDs are not lattice targets. Ocean endpoints are
      // left to the sea test; they do not count as inland tributary joins.
      if (Number.isInteger(p.ix) && Number.isInteger(p.iz) && p.h >= -0.25) targets.set(p.id, p);
    }
  }
  if (riverMeanders) for (const group of groups) {
    const length = group.fitted.junctions[0]?.levelLength ?? junctionLength;
    group.fitted = fitRiverMeanders(world, group.segmented, group.fitted, {
      junctionLength: length, mouthLength,
      ...(group.hierarchy ? { channelProfiles: group.hierarchy.channelProfiles } : {}),
    });
  }
  return { status: 'planned', activationReady: false,
    components: [...groups].map(g => ({ ...g.fitted, sources: g.routes.map(r => r.source).sort(),
      graph: g.graph, routes: g.routes, activationReady: false,
      ...(g.hierarchy ? { hierarchy: g.hierarchy } : {}) })),
    diagnostics: { sources: sources.length, joinedSources, rejected } };
}
