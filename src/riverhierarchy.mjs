// Deterministic drainage hierarchy data for already merged/segmented river
// graphs.  This module owns the geographic contribution model only.  River
// terrain fitting can consume the returned channelProfile objects without
// needing to infer discharge from a mesh footprint.

import { drainageOrder } from './riverprofile.mjs';
import { mergeRiverRoutes, segmentRiverGraph } from './rivergraph.mjs';

export const RIVER_HIERARCHY_VERSION = 1;
export const RIVER_MIN_HALF_WIDTH = 1;
export const RIVER_MAX_HALF_WIDTH = 22.5;

// Ranges are total visible channel widths in metres.  The last class is
// intentionally represented by the model even though the current terrain
// fitter cannot accept its half-width.
export const RIVER_WIDTH_CLASSES = Object.freeze({
  headwater: Object.freeze({ minTotalWidth: 1, maxTotalWidth: 3, supported: true }),
  stream: Object.freeze({ minTotalWidth: 3, maxTotalWidth: 8, supported: true }),
  'medium-tributary': Object.freeze({ minTotalWidth: 8, maxTotalWidth: 20, supported: true }),
  // The class overlaps the current cap: up to 45 m total is supportable,
  // while the remainder is reported per-profile as unsupported.
  'main-valley': Object.freeze({ minTotalWidth: 20, maxTotalWidth: 50, maxSupportedTotalWidth: 45, supported: true }),
  'large-trunk': Object.freeze({ minTotalWidth: 50, maxTotalWidth: 100, maxSupportedTotalWidth: 45, supported: false }),
});

export const CATCHMENT_PROVENANCE = Object.freeze({
  EXPLICIT_FIXTURE: 'explicit-fixture',
  CATCHMENT_PROXY: 'catchment-proxy',
  MIXED: 'mixed',
  CROSS_REGION_INCOMPLETE: 'proxy-not-cross-region-catchment-completion',
});

const EPSILON = 1e-9;
const PROFILE_EPSILON = 1e-7;

/**
 * Build a stable drainage hierarchy from the output of mergeRiverRoutes and
 * segmentRiverGraph.
 *
 * `graph` and `segmented` are deliberately positional: callers already have
 * both objects at the network integration point.  A segmented value may be
 * omitted when the graph has enough level information to segment itself.
 * The result remains useful when a profile is outside the current terrain
 * fitter's width cap: such a profile is declared unsupported and retains its
 * requested dimensions rather than being silently shrunk.
 */
export function buildRiverHierarchy(graph, segmented = null, options = {}) {
  const normalized = normalizeGraphAndSegments(graph, segmented, options);
  if (normalized.status !== 'accepted') return normalized;

  const terminalReport = verifyOceanTerminals(normalized.graph, normalized.segmented, {
    ...options,
    terminals: options.terminals ?? options.oceanTerminals,
  });
  if (terminalReport.status !== 'accepted') return terminalReport;

  const accumulation = accumulateRiverContributions(normalized.graph, normalized.segmented, options);
  if (accumulation.status !== 'accepted') return accumulation;

  const profiled = buildRiverReachProfiles(normalized.graph, normalized.segmented, accumulation, options);
  if (profiled.status !== 'accepted') return profiled;

  const channelProfiles = Object.fromEntries(profiled.profiles
    .sort((a, b) => a.reachId.localeCompare(b.reachId))
    .map(profile => [profile.reachId, profile.channelProfile]));
  const reaches = profiled.profiles.map(profile => ({
    ...profile.reach,
    channelProfile: profile.channelProfile,
    sourceContributions: profile.sourceContributions,
    accumulatedDrainage: profile.accumulatedDrainage,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const unsupportedProfiles = profiled.profiles
    .filter(profile => !profile.channelProfile.supported)
    .map(profile => ({
      reachId: profile.reachId,
      widthClass: profile.channelProfile.widthClass,
      requestedHalfWidth: profile.channelProfile.requestedHalfWidth,
      requestedTotalWidth: profile.channelProfile.requestedTotalWidth,
      reason: profile.channelProfile.unsupportedReason,
      declaredUnsupported: true,
    }))
    .sort((a, b) => a.reachId.localeCompare(b.reachId));

  return {
    // “planned” matches the network preview contract; the nested accepted
    // flag makes the hierarchy stage explicit to callers that use the graph
    // helpers' accepted/candidate vocabulary.
    status: 'planned',
    accepted: true,
    version: RIVER_HIERARCHY_VERSION,
    seed: options.seed ?? null,
    graph: normalized.graph,
    segmented: normalized.segmented,
    reaches,
    profiles: profiled.profiles,
    channelProfiles,
    junctions: normalized.segmented.junctions,
    sources: accumulation.sources,
    sourceContributions: accumulation.sources,
    sourceContributionById: accumulation.sourceContributionById,
    nodeContributions: accumulation.nodeContributions,
    edgeContributions: accumulation.edgeContributions,
    lakeTransitions: accumulation.lakeTransitions,
    terminals: terminalReport.terminals,
    oceanTerminals: terminalReport.oceanTerminals,
    rootPaths: terminalReport.rootPaths,
    oceanConnected: terminalReport.oceanConnected,
    catchment: accumulation.catchment,
    unsupportedProfiles,
    diagnostics: {
      ...accumulation.diagnostics,
      ...profiled.diagnostics,
      terminalCount: terminalReport.terminals.length,
      oceanTerminalCount: terminalReport.oceanTerminals.length,
      oceanPathCount: terminalReport.rootPaths.filter(path => path.ocean).length,
      unsupportedWidth: unsupportedProfiles.length > 0,
    },
  };
}

/**
 * Accumulate each source exactly once through the directed graph.  Shared
 * suffixes are represented by one graph edge and therefore receive the union
 * of source maps from the node once; route duplication cannot multiply flow.
 */
export function accumulateRiverContributions(graph, segmented = null, options = {}) {
  const normalized = normalizeGraphAndSegments(graph, segmented, options);
  if (normalized.status !== 'accepted') return normalized;
  const { graph: canonical, segmented: segments } = normalized;
  const topology = graphTopology(canonical);
  if (topology.status !== 'accepted') return topology;

  const sourceDescriptors = sourceEntries(options.sourceContributions ?? options.sources);
  const reachBySource = new Map();
  for (const reach of segments.reaches) {
    const source = String(reach.source ?? reach.points?.[0]?.id ?? '');
    if (!source) return reject('missing-source-id', { reachId: reach.id });
    if (!reachBySource.has(source)) reachBySource.set(source, []);
    reachBySource.get(source).push(reach);
  }

  const incoming = topology.incoming;
  const outgoing = topology.outgoing;
  const roots = canonical.nodes.filter(node => incoming.get(node.id).length === 0);
  const sourceByNode = new Map();
  const sources = [];
  const seenSourceIds = new Map();
  const usedSourceNodes = new Set();
  for (const node of roots) {
    const reaches = reachBySource.get(node.id) || [];
    const descriptor = sourceDescriptors.find(entry => entry.nodeId === node.id)
      || sourceDescriptors.find(entry => entry.id === node.id);
    const routeDescriptor = reaches.find(reach => sourceDescriptorFromReach(reach) !== null);
    const routeSource = routeDescriptor ? sourceDescriptorFromReach(routeDescriptor) : null;
    const explicit = descriptor || routeSource;
    const sourceId = String(explicit?.id ?? routeDescriptor?.source ?? node.id);
    if (seenSourceIds.has(sourceId)) {
      const prior = seenSourceIds.get(sourceId);
      if (prior.nodeId !== node.id) return reject('duplicate-source-id', { sourceId, nodeIds: [prior.nodeId, node.id] });
      // A repeated route for the same source is the common shared-suffix case;
      // keep one injection and validate any repeated explicit amount below.
      continue;
    }
    if (usedSourceNodes.has(node.id)) continue;
    const resolved = resolveSourceAmount(node, explicit, reaches, options, canonical);
    if (resolved.status !== 'accepted') return resolved;
    const entry = {
      id: sourceId,
      nodeId: node.id,
      contribution: resolved.contribution,
      mode: resolved.mode,
      basis: resolved.basis,
      kind: 'source',
    };
    seenSourceIds.set(sourceId, entry);
    usedSourceNodes.add(node.id);
    sources.push(entry);
    sourceByNode.set(node.id, [entry]);
  }

  // Explicit source descriptors may name a graph node that is not a root only
  // when it is a lake-local catchment. Ordinary interior injections would make
  // source identity depend on visit order, so reject those declarations.
  for (const descriptor of sourceDescriptors) {
    if (!descriptor.nodeId) continue;
    const node = canonical.nodes.find(item => item.id === descriptor.nodeId);
    if (!node) return reject('missing-source-node', { sourceId: descriptor.id, nodeId: descriptor.nodeId });
    if (incoming.get(node.id).length && !isLakeNode(node, options)) {
      return reject('source-node-not-headwater', { sourceId: descriptor.id, nodeId: descriptor.nodeId });
    }
  }

  const flowByNode = new Map();
  const nodeContributions = [];
  const lakeTransitions = [];
  for (const node of topology.order.map(id => canonical.nodes.find(item => item.id === id))) {
    const bySource = new Map();
    for (const edge of incoming.get(node.id).slice().sort(compareId)) {
      const upstream = flowByNode.get(edge.from);
      if (!upstream) return reject('missing-upstream-contribution', { edgeId: edge.id, nodeId: node.id });
      for (const [sourceId, amount] of upstream.bySource) addAmount(bySource, sourceId, amount);
    }
    for (const source of sourceByNode.get(node.id) || []) addAmount(bySource, source.id, source.contribution);

    const local = resolveLakeLocalContribution(node, options);
    if (local.status !== 'accepted') return local;
    if (local.contribution > EPSILON) {
      const localId = `lake-local:${node.id}`;
      addAmount(bySource, localId, local.contribution);
      sources.push({ id: localId, nodeId: node.id, contribution: local.contribution,
        mode: local.mode, basis: local.basis, kind: 'lake-local-catchment' });
    }
    const total = sumAmounts(bySource);
    const sourceList = [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([sourceId, contribution]) => ({ sourceId, contribution }));
    flowByNode.set(node.id, { total, bySource });
    nodeContributions.push({
      nodeId: node.id,
      contribution: total,
      accumulatedDrainage: total,
      sourceContributions: sourceList,
      incomingEdgeIds: incoming.get(node.id).map(edge => edge.id).sort(),
      outgoingEdgeId: outgoing.get(node.id)[0]?.id ?? null,
      localContribution: local.contribution,
    });
    if (isLakeNode(node, options) && incoming.get(node.id).length && outgoing.get(node.id).length) {
      const incomingContribution = sumAmounts(incoming.get(node.id)
        .map(edge => flowByNode.get(edge.from)?.total ?? 0));
      lakeTransitions.push({
        nodeId: node.id,
        lakeId: lakeIdOf(node, options),
        role: 'through-flow',
        incomingContribution,
        localCatchmentContribution: local.contribution,
        outgoingContribution: total,
        sourceIds: sourceList.map(item => item.sourceId),
      });
    }
  }

  const edgeContributions = canonical.edges.map(edge => {
    const flow = flowByNode.get(edge.from);
    return {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      contribution: flow?.total ?? 0,
      accumulatedDrainage: flow?.total ?? 0,
      sourceContributions: [...(flow?.bySource || new Map()).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sourceId, contribution]) => ({ sourceId, contribution })),
    };
  });
  const modeSet = new Set(sources.map(source => source.mode));
  const provenance = modeSet.size > 1 ? CATCHMENT_PROVENANCE.MIXED
    : (modeSet.values().next().value || CATCHMENT_PROVENANCE.CATCHMENT_PROXY);
  const sortedSources = uniqueSources(sources);
  const sourceContributionByIdWithLocal = Object.fromEntries(sortedSources
    .map(source => [source.id, source.contribution]));
  return {
    status: 'accepted',
    sources: sortedSources,
    sourceContributionById: sourceContributionByIdWithLocal,
    nodeContributions: nodeContributions.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    edgeContributions,
    lakeTransitions: lakeTransitions.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    flowByNode,
    topology,
    catchment: {
      provenance,
      mode: provenance,
      crossRegionComplete: false,
      status: CATCHMENT_PROVENANCE.CROSS_REGION_INCOMPLETE,
      label: CATCHMENT_PROVENANCE.CROSS_REGION_INCOMPLETE,
    },
    diagnostics: {
      rootCount: roots.length,
      nodeCount: canonical.nodes.length,
      edgeCount: canonical.edges.length,
      sourceCount: sortedSources.length,
      sharedSuffixes: canonical.nodes.filter(node => incoming.get(node.id).length > 1).length,
    },
  };
}

/**
 * Produce channelProfile data for each segmented reach.  Widths use a
 * sublinear contribution mapping plus local confinement/material factors.
 * Global arc offsets and an identity seed let the channel stage add variation
 * without resetting at a reach or tile boundary.
 */
export function buildRiverReachProfiles(graph, segmented, accumulation, options = {}) {
  if (accumulation?.status !== 'accepted') return reject('invalid-contribution-accumulation');
  const normalized = normalizeGraphAndSegments(graph, segmented, options);
  if (normalized.status !== 'accepted') return normalized;
  const topology = graphTopology(normalized.graph);
  if (topology.status !== 'accepted') return topology;
  const edgeById = new Map(normalized.graph.edges.map(edge => [edge.id, edge]));
  const flowByNode = accumulation.flowByNode;
  const distance = nodeDistances(normalized.graph, topology);
  const sourceDistance = sourceDistances(normalized.graph, topology, flowByNode, accumulation.sources);
  const morphology = options.riverMorphology === true;
  // Morphology needs upstream endpoint widths before it authors a downstream
  // start. Keep the legacy lexical order and calculations untouched when the
  // opt-in flag is absent so existing profiles remain byte stable.
  const orderedReaches = normalized.segmented.reaches.slice().sort(morphology
    ? (a, b) => (distance.get(a.points?.[0]?.id) ?? 0) - (distance.get(b.points?.[0]?.id) ?? 0)
      || compareId(a, b)
    : compareId);
  const reachByEdge = new Map();
  if (morphology) for (const reach of orderedReaches) {
    const edgeIds = reach.edgeIds?.length ? reach.edgeIds : consecutiveEdgeIds(reach.points || []);
    for (const edgeId of edgeIds) if (!reachByEdge.has(edgeId)) reachByEdge.set(edgeId, reach);
  }
  const profileByReach = new Map();
  const profiles = [];
  for (const reach of orderedReaches) {
    if (!Array.isArray(reach.points) || reach.points.length < 2) {
      return reject('degenerate-reach', { reachId: reach.id });
    }
    const edgeIds = reach.edgeIds?.length ? reach.edgeIds.slice() : consecutiveEdgeIds(reach.points);
    const edges = edgeIds.map(id => edgeById.get(id));
    if (edges.some(edge => !edge)) return reject('missing-reach-edge', { reachId: reach.id });
    const arc = cumulativeArc(reach.points);
    const startNode = reach.points[0];
    const incomingAtStart = topology.incoming.get(startNode.id) || [];
    const incomingContribution = sumAmounts(incomingAtStart
      .map(edge => flowByNode.get(edge.from)?.total ?? 0));
    const incomingWidthContribution = Math.max(0, ...incomingAtStart
      .map(edge => flowByNode.get(edge.from)?.total ?? 0));
    const localContribution = flowByNode.get(startNode.id)?.total - incomingContribution || 0;
    const incomingProfile = morphology && incomingContribution > EPSILON
      ? dominantIncomingProfile(incomingAtStart, reachByEdge, profileByReach, flowByNode)
      : null;
    // For a morphology join, the dominant *branch* owns identity and phase.
    // A newly joining source can be lexically earlier than a wider existing
    // mainstem, so choosing the globally largest individual source would make
    // the downstream boundary inherit the wrong endpoint width.
    const dominantSource = (morphology && incomingProfile?.identityId)
      || dominantSourceAt(flowByNode.get(startNode.id)?.bySource, accumulation.sources)
      || String(reach.source ?? reach.id);
    const arcOffset = sourceDistance.get(dominantSource)?.get(startNode.id)
      ?? distance.get(startNode.id) ?? 0;
    const qByPoint = reach.points.map((point, index) => {
      const edge = edges[Math.min(index, edges.length - 1)];
      return flowByNode.get(edge.from)?.total ?? flowByNode.get(point.id)?.total ?? 0;
    });
    const terminalFlow = flowByNode.get(reach.points.at(-1).id)?.total ?? qByPoint.at(-1) ?? 0;
    if (qByPoint.length) qByPoint[qByPoint.length - 1] = edges.length
      ? (flowByNode.get(edges.at(-1).from)?.total ?? qByPoint.at(-1))
      : terminalFlow;
    const variationSeed = stableHash(`${options.seed ?? 0}:${dominantSource}`);
    const nominalOptions = {
      ...options,
      // Larger footprints remain modeled as declared unsupported until the
      // terrain stage explicitly validates them; a caller cannot bypass the
      // current fit cap merely by passing a larger maxHalfWidth here.
      maxHalfWidth: Math.min(options.maxHalfWidth ?? RIVER_MAX_HALF_WIDTH, RIVER_MAX_HALF_WIDTH),
      ...(morphology ? {
        // A modestly stronger opt-in discharge curve keeps sequential joins
        // legible while leaving the established mapping unchanged for legacy
        // callers. Explicit width options still take precedence.
        widthBase: options.widthBase ?? 0.2,
        widthScale: options.widthScale ?? 3.2,
        widthExponent: options.widthExponent ?? 0.9,
      } : {}),
    };
    const rawSamples = reach.points.map((point, index) => {
      const q = Math.max(0, qByPoint[index]);
      const factors = sectionFactors(point, options);
      const target = dimensionsForContribution(q, factors, nominalOptions);
      // The hierarchy hands terrain fitting nominal anchors.  The channel
      // stage may add identity-seeded organic variation using variationSeed;
      // applying that variation here would make it run twice downstream.
      const rawHalfWidth = target.halfWidth;
      const rawDepth = target.depth;
      return {
        nodeId: point.id,
        arc: arc[index],
        globalArc: arcOffset + arc[index],
        drainageContribution: q,
        rawHalfWidth,
        rawDepth,
        requestedHalfWidth: target.halfWidth,
        requestedTotalWidth: target.totalWidth,
        widthClass: target.widthClass,
      };
    });
    const transitionDistance = downstreamTransitionDistance(rawSamples, incomingContribution, localContribution,
      nominalOptions, morphology);
    const targetAtEnd = rawSamples.at(-1);
    const startTarget = rawSamples[0];
    // Use the selected incoming branch's actual nominal endpoint. The terrain
    // character sampler applies the same seeded variation at this global arc,
    // so this also preserves the rendered width exactly at the junction.
    const incomingEndWidth = incomingProfile ? actualProfileEndpointWidth(incomingProfile) : undefined;
    const junctionStartWidth = incomingContribution > EPSILON && targetAtEnd
      ? (Number.isFinite(incomingEndWidth) ? incomingEndWidth
        : dimensionsForContribution(incomingWidthContribution, sectionFactors(startNode, options), nominalOptions).halfWidth)
      : startTarget?.rawHalfWidth ?? 0;
    const sourceOnset = morphology && incomingContribution <= EPSILON
      && (localContribution > EPSILON || (startTarget?.rawHalfWidth ?? 0) > EPSILON);
    const sourceOnsetFactor = sourceOnset
      ? clamp(firstFinite(options.morphologySourceStartFactor, 0.8), 0.5, 1)
      : 1;
    const sourceStartWidth = sourceOnset
      ? (startTarget?.rawHalfWidth ?? 0) * sourceOnsetFactor
      : junctionStartWidth;
    const sourceOnsetDistance = sourceOnset && startTarget
      ? clamp(Math.max(startTarget.rawHalfWidth * (options.morphologySourceOnsetWidths ?? 3),
        options.morphologySourceOnsetMinimum ?? 8),
      options.morphologySourceOnsetMinimum ?? 8, options.morphologySourceOnsetMaximum ?? 48)
      : 0;
    const responseDistance = incomingContribution > EPSILON ? transitionDistance : sourceOnsetDistance;
    const targetHalfWidth = targetAtEnd?.rawHalfWidth ?? startTarget?.rawHalfWidth ?? 0;
    const samples = rawSamples.map((sample, index) => {
      let halfWidth = sample.rawHalfWidth;
      if (morphology && responseDistance > 0) {
        const t = smoothstep(0, responseDistance, sample.arc);
        halfWidth = lerp(sourceOnset ? sourceStartWidth : junctionStartWidth, targetHalfWidth, t);
      } else if (!morphology && incomingContribution > EPSILON && targetAtEnd && transitionDistance > 0) {
        const t = smoothstep(0, transitionDistance, sample.arc);
        halfWidth = lerp(junctionStartWidth, sample.rawHalfWidth, t);
      }
      const depth = sample.rawDepth;
      return {
        ...sample,
        halfWidth,
        depth,
        supported: halfWidth >= RIVER_MIN_HALF_WIDTH - PROFILE_EPSILON
          && halfWidth <= nominalOptions.maxHalfWidth + PROFILE_EPSILON,
      };
    });
    const fullArc = arc.at(-1);
    const trendLength = morphology
      ? (responseDistance > 0 ? responseDistance : fullArc)
      : fullArc;
    // A short reach keeps the authored response interval even when its
    // canonical route ends first. Its endpoint is then sampled partway along
    // that curve, while the profile's end value remains the eventual target.
    // Longer reaches hold the requested width once the bounded response ends.
    const profileEndHalfWidth = morphology && responseDistance > 0
      ? targetHalfWidth
      : samples.at(-1)?.halfWidth ?? targetHalfWidth;
    const requestedHalfWidth = Math.max(...samples.map(sample => sample.rawHalfWidth));
    const requestedTotalWidth = requestedHalfWidth * 2;
    const widthClass = widthClassForTotalWidth(requestedTotalWidth);
    const supported = samples.every(sample => sample.halfWidth >= RIVER_MIN_HALF_WIDTH - PROFILE_EPSILON
      && sample.halfWidth <= nominalOptions.maxHalfWidth + PROFILE_EPSILON)
      && requestedHalfWidth >= RIVER_MIN_HALF_WIDTH - PROFILE_EPSILON
      && requestedHalfWidth <= nominalOptions.maxHalfWidth + PROFILE_EPSILON;
    const characteristicHalfWidth = weightedCharacteristic(samples);
    const characteristicDepth = weightedCharacteristic(samples, 'depth');
    const channelProfile = {
      // Keep the identity on the dominant upstream source so a mainstem
      // split at another junction continues the same channel-character
      // noise phase. reachId remains the unique graph mapping key.
      id: `channel-profile:${dominantSource}`,
      reachId: reach.id,
      identityId: dominantSource,
      source: reach.source,
      outlet: reach.outlet,
      halfWidth: supported ? characteristicHalfWidth : requestedHalfWidth,
      depth: characteristicDepth,
      startHalfWidth: samples[0].halfWidth,
      endHalfWidth: profileEndHalfWidth,
      arcOffset,
      trendStartArc: arcOffset,
      trendEndArc: arcOffset + trendLength,
      variationSeed,
      widthClass,
      requestedHalfWidth,
      requestedTotalWidth,
      maxHalfWidth: nominalOptions.maxHalfWidth,
      supported,
      declaredUnsupported: !supported,
      unsupportedReason: supported ? null
        : requestedHalfWidth < RIVER_MIN_HALF_WIDTH - PROFILE_EPSILON
          ? 'current-fit-min-half-width' : 'current-fit-half-width-cap',
      downstreamSmoothing: {
        method: 'identity-seeded-distance-smoothing',
        window: smoothingWindow(samples, options),
        transitionDistance: morphology ? responseDistance : transitionDistance,
        fromContribution: incomingContribution,
        fromWidthContribution: incomingWidthContribution,
        localContribution,
        toContribution: qByPoint[0] ?? 0,
        globalArcStart: arcOffset,
        globalArcEnd: arcOffset + (morphology ? trendLength : arc.at(-1)),
      },
      ...(morphology ? { morphology: true } : {}),
      samples,
    };
    const builtProfile = {
      reach,
      reachId: reach.id,
      channelProfile,
      sourceContributions: accumulation.nodeContributions
        .find(node => node.nodeId === startNode.id)?.sourceContributions || [],
      accumulatedDrainage: qByPoint,
    };
    profiles.push(builtProfile);
    if (morphology) profileByReach.set(reach.id, channelProfile);
  }
  const classCounts = {};
  for (const profile of profiles) {
    const key = profile.channelProfile.widthClass;
    classCounts[key] = (classCounts[key] || 0) + 1;
  }
  return {
    status: 'accepted',
    profiles: profiles.sort((a, b) => a.reachId.localeCompare(b.reachId)),
    diagnostics: { profileCount: profiles.length, widthClassCounts: classCounts },
  };
}

/**
 * Verify terminal semantics.  A numeric level of zero is only corroborating
 * evidence; it cannot turn an otherwise unexplained graph end into an ocean.
 */
export function verifyOceanTerminals(graph, segmented = null, options = {}) {
  const normalized = normalizeGraphAndSegments(graph, segmented, options);
  if (normalized.status !== 'accepted') return normalized;
  const topology = graphTopology(normalized.graph);
  if (topology.status !== 'accepted') return topology;
  const declarations = terminalEntries(options.terminals ?? options.oceanTerminals);
  const byId = new Map(declarations.map(entry => [entry.nodeId, entry]));
  const terminals = [];
  const oceanTerminals = [];
  for (const node of normalized.graph.nodes
    .filter(item => topology.outgoing.get(item.id).length === 0)
    .sort(compareId)) {
    const declaration = byId.get(node.id);
    const semantic = semanticTerminal(node, declaration, options);
    if (!semantic) return reject('missing-receiver', { nodeId: node.id });
    if (semantic.kind === 'ocean') {
      if (!semantic.verified) return reject('unverified-ocean-terminal', { nodeId: node.id });
      const seaLevel = options.seaLevel ?? 0;
      const level = Number.isFinite(node.preferredY) ? node.preferredY : node.waterY;
      if (Number.isFinite(level) && Number.isFinite(seaLevel)
        && Math.abs(level - seaLevel) > (options.oceanLevelTolerance ?? 1e-6)) {
        return reject('invalid-ocean-terminal', { nodeId: node.id, level, seaLevel });
      }
      oceanTerminals.push({ nodeId: node.id, kind: 'ocean', verified: true,
        semantic: semantic.semantic, level: Number.isFinite(level) ? level : null });
    }
    terminals.push({ nodeId: node.id, kind: semantic.kind, verified: semantic.verified,
      semantic: semantic.semantic });
  }
  const rootPaths = [];
  for (const root of normalized.graph.nodes.filter(node => topology.incoming.get(node.id).length === 0)
    .sort(compareId)) {
    const path = [], seen = new Set();
    let cursor = root.id;
    while (cursor !== null) {
      if (seen.has(cursor)) return reject('drainage-cycle', { nodeId: cursor });
      seen.add(cursor); path.push(cursor);
      const next = topology.outgoing.get(cursor)[0];
      cursor = next ? next.to : null;
    }
    const terminal = terminals.find(item => item.nodeId === path.at(-1));
    rootPaths.push({ sourceId: root.id, terminalId: path.at(-1), path,
      ocean: terminal?.kind === 'ocean' });
  }
  const oceanConnected = rootPaths.some(path => path.ocean);
  return {
    status: 'accepted',
    terminals,
    oceanTerminals: oceanTerminals.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    rootPaths,
    oceanConnected,
  };
}

export function widthClassForTotalWidth(totalWidth) {
  if (!Number.isFinite(totalWidth) || totalWidth < 0) throw new Error('Invalid river width');
  if (totalWidth < RIVER_WIDTH_CLASSES.stream.minTotalWidth) return 'headwater';
  if (totalWidth < RIVER_WIDTH_CLASSES['medium-tributary'].minTotalWidth) return 'stream';
  if (totalWidth < RIVER_WIDTH_CLASSES['main-valley'].minTotalWidth) return 'medium-tributary';
  if (totalWidth < RIVER_WIDTH_CLASSES['large-trunk'].minTotalWidth) return 'main-valley';
  return 'large-trunk';
}

/**
 * Inspect nominal hierarchy samples before terrain character is applied. `arc` is measured from the
 * reach start while `trendStartArc`/`trendEndArc` on the profile are global
 * graph distances.  Keeping both lets a split/rejoined reach use the same
 * identity and variation coordinate as its parent route.
 */
export function nominalReachProfileAt(profile, arc = 0, totalArc = null) {
  if (!profile || !Number.isFinite(arc) || arc < 0) throw new Error('Invalid channel profile sample');
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const inferredTotal = samples.length ? samples.at(-1).arc : profile.trendEndArc - profile.trendStartArc;
  const length = Number.isFinite(totalArc) ? Math.max(0, totalArc) : Math.max(0, inferredTotal || 0);
  const position = clamp(arc, 0, length);
  if (profile.morphology === true) {
    const arcOffset = profile.arcOffset ?? profile.trendStartArc ?? 0;
    const trendStart = Number.isFinite(profile.trendStartArc) ? profile.trendStartArc : arcOffset;
    const trendEnd = Number.isFinite(profile.trendEndArc) ? profile.trendEndArc : trendStart + length;
    const trendSpan = trendEnd - trendStart;
    const globalArc = arcOffset + position;
    const trendT = trendSpan > EPSILON ? clamp((globalArc - trendStart) / trendSpan, 0, 1) : 0;
    const trendHalfWidth = lerp(profile.startHalfWidth ?? profile.halfWidth ?? 0,
      profile.endHalfWidth ?? profile.halfWidth ?? 0, smoothstep(0, 1, trendT));
    if (!samples.length) {
      return {
        arc: position,
        globalArc,
        halfWidth: trendHalfWidth,
        depth: profile.depth ?? 0,
        supported: profile.supported !== false,
      };
    }
    let right = samples.findIndex(sample => sample.arc >= position);
    if (right < 0) right = samples.length - 1;
    if (right === 0) {
      return { ...samples[0], arc: position, globalArc, halfWidth: trendHalfWidth,
        supported: profile.supported !== false };
    }
    const left = samples[right - 1];
    const next = samples[right];
    const sampleT = next.arc - left.arc > EPSILON
      ? clamp((position - left.arc) / (next.arc - left.arc), 0, 1) : 0;
    return {
      ...left,
      arc: position,
      globalArc,
      drainageContribution: lerp(left.drainageContribution, next.drainageContribution, sampleT),
      halfWidth: trendHalfWidth,
      depth: lerp(left.depth, next.depth, sampleT),
      rawHalfWidth: lerp(left.rawHalfWidth, next.rawHalfWidth, sampleT),
      rawDepth: lerp(left.rawDepth, next.rawDepth, sampleT),
      supported: profile.supported !== false,
    };
  }
  if (!samples.length) {
    const t = length > EPSILON ? position / length : 0;
    return {
      arc: position,
      globalArc: (profile.arcOffset ?? profile.trendStartArc ?? 0) + position,
      halfWidth: lerp(profile.startHalfWidth ?? profile.halfWidth ?? 0,
        profile.endHalfWidth ?? profile.halfWidth ?? 0, smoothstep(0, 1, t)),
      depth: profile.depth ?? 0,
      supported: profile.supported !== false,
    };
  }
  let right = samples.findIndex(sample => sample.arc >= position);
  if (right < 0) right = samples.length - 1;
  if (right === 0) return { ...samples[0], arc: position,
    globalArc: (profile.arcOffset ?? 0) + position };
  const left = samples[right - 1];
  const next = samples[right];
  const t = next.arc - left.arc > EPSILON ? (position - left.arc) / (next.arc - left.arc) : 0;
  return {
    ...left,
    arc: position,
    globalArc: (profile.arcOffset ?? 0) + position,
    drainageContribution: lerp(left.drainageContribution, next.drainageContribution, t),
    halfWidth: lerp(left.halfWidth, next.halfWidth, t),
    depth: lerp(left.depth, next.depth, t),
    rawHalfWidth: lerp(left.rawHalfWidth, next.rawHalfWidth, t),
    rawDepth: lerp(left.rawDepth, next.rawDepth, t),
  };
}

function normalizeGraphAndSegments(graph, segmented, options) {
  let candidateGraph = graph;
  let candidateSegments = segmented;
  if (Array.isArray(candidateGraph)) candidateGraph = { routes: candidateGraph };
  if (candidateGraph?.routes && !candidateGraph.nodes && !candidateGraph.edges) {
    let merged;
    try { merged = mergeRiverRoutes(candidateGraph.routes); }
    catch (error) { return reject('invalid-route-graph', { message: error.message }); }
    if (merged.status !== 'candidate') return reject(merged.reason || 'invalid-route-graph');
    candidateGraph = merged;
  }
  if (candidateGraph?.graph && !candidateGraph.nodes) candidateGraph = candidateGraph.graph;
  if (!candidateGraph || !Array.isArray(candidateGraph.nodes) || !Array.isArray(candidateGraph.edges)) {
    return reject('invalid-river-graph');
  }
  const canonicalGraph = canonicalGraphCopy(candidateGraph);
  const validation = validateGraph(canonicalGraph);
  if (validation.status !== 'accepted') return validation;
  if (!candidateSegments) {
    const levels = Object.fromEntries(canonicalGraph.nodes.map(node => [node.id,
      Number.isFinite(node.waterY) ? node.waterY : node.preferredY]));
    if (Object.values(levels).some(value => !Number.isFinite(value))) return reject('missing-solved-river-level');
    try { candidateSegments = segmentRiverGraph(canonicalGraph, levels); }
    catch (error) { return reject('invalid-segmented-river-graph', { message: error.message }); }
  }
  if (candidateSegments?.segmented) candidateSegments = candidateSegments.segmented;
  if (!candidateSegments || candidateSegments.status !== 'candidate'
    || !Array.isArray(candidateSegments.reaches) || !Array.isArray(candidateSegments.junctions)) {
    return reject(candidateSegments?.reason || 'invalid-segmented-river-graph');
  }
  const canonicalSegments = {
    ...candidateSegments,
    reaches: candidateSegments.reaches.slice().sort(compareId).map(reach => ({
      ...reach,
      points: Array.isArray(reach.points) ? reach.points.map(point => ({ ...point })) : reach.points,
      edgeIds: reach.edgeIds ? reach.edgeIds.slice() : reach.edgeIds,
    })),
    junctions: candidateSegments.junctions.slice().sort(compareId).map(junction => ({ ...junction })),
  };
  return { status: 'accepted', graph: canonicalGraph, segmented: canonicalSegments };
}

function canonicalGraphCopy(graph) {
  return {
    ...graph,
    nodes: graph.nodes.slice().sort(compareId).map(node => ({ ...node })),
    edges: graph.edges.slice().sort(compareId).map(edge => ({ ...edge })),
  };
}

function validateGraph(graph) {
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.length) return reject('invalid-drainage-node');
    if (nodeIds.has(node.id)) return reject('duplicate-drainage-node', { nodeId: node.id });
    nodeIds.add(node.id);
    if (![node.x, node.z].every(Number.isFinite)) return reject('invalid-drainage-node', { nodeId: node.id });
  }
  const edgeIds = new Set();
  const downstream = new Map();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id.length) return reject('invalid-drainage-edge');
    if (edgeIds.has(edge.id)) return reject('duplicate-drainage-edge', { edgeId: edge.id });
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return reject('missing-receiver', { edgeId: edge.id, from: edge.from, to: edge.to });
    }
    if (edge.from === edge.to) return reject('drainage-cycle', { edgeId: edge.id });
    if (!Number.isFinite(edge.length) || edge.length <= 0) return reject('invalid-drainage-edge', { edgeId: edge.id });
    if (downstream.has(edge.from) && downstream.get(edge.from) !== edge.to) {
      return reject('ambiguous-downstream-owner', { nodeId: edge.from });
    }
    downstream.set(edge.from, edge.to);
  }
  for (const node of graph.nodes) {
    const declared = receiverOf(node, graph);
    if (declared !== undefined && declared !== null
      && (typeof declared !== 'string' || !nodeIds.has(declared))) {
      return reject('missing-receiver', { nodeId: node.id, receiver: declared });
    }
    if (declared && downstream.has(node.id) && downstream.get(node.id) !== declared) {
      return reject('receiver-mismatch', { nodeId: node.id, receiver: declared, edgeReceiver: downstream.get(node.id) });
    }
  }
  let topology;
  try { topology = drainageOrder(graph.nodes, graph.edges); }
  catch (error) {
    return reject(error.message === 'Unresolved drainage endpoint' ? 'missing-receiver' : 'invalid-drainage-graph',
      { message: error.message });
  }
  if (topology.status !== 'accepted') return reject(topology.reason || 'drainage-cycle');
  return { status: 'accepted' };
}

function graphTopology(graph) {
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) return reject('missing-receiver', { edgeId: edge.id });
    incoming.get(edge.to).push(edge);
    outgoing.get(edge.from).push(edge);
  }
  for (const values of incoming.values()) values.sort(compareId);
  for (const values of outgoing.values()) values.sort(compareId);
  let order;
  try { order = drainageOrder(graph.nodes, graph.edges); }
  catch (error) { return reject('invalid-drainage-graph', { message: error.message }); }
  if (order.status !== 'accepted') return reject(order.reason || 'drainage-cycle');
  return { status: 'accepted', order: order.order, incoming, outgoing };
}

function sourceEntries(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()].map(([id, entry]) => normalizeSourceEntry(entry, id));
  if (Array.isArray(value)) return value.map((entry, index) => normalizeSourceEntry(entry, index));
  if (typeof value === 'object') return Object.entries(value).map(([id, entry]) => normalizeSourceEntry(entry, id));
  return [];
}

function normalizeSourceEntry(entry, fallbackId) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const id = String(entry.id ?? fallbackId);
    const nodeId = entry.nodeId ?? entry.sourceNodeId ?? entry.node ?? (entry.id && fallbackId === entry.id ? entry.id : undefined);
    const amount = firstFinite(entry.contribution, entry.amount, entry.value, entry.drainage, entry.runoff);
    return { ...entry, id, ...(nodeId !== undefined ? { nodeId: String(nodeId) } : {}),
      ...(amount !== undefined ? { contribution: amount } : {}) };
  }
  return { id: String(fallbackId), contribution: Number(entry) };
}

function sourceDescriptorFromReach(reach) {
  const amount = firstFinite(reach.sourceContribution, reach.contribution, reach.drainageContribution);
  if (amount === undefined) return null;
  return { id: String(reach.source ?? reach.points?.[0]?.id), nodeId: reach.points?.[0]?.id,
    contribution: amount, mode: 'explicit-fixture', basis: 'reach-source-contribution' };
}

function resolveSourceAmount(node, explicit, reaches, options, graph) {
  const routeExplicit = reaches.map(sourceDescriptorFromReach).filter(Boolean);
  const candidates = [explicit, ...routeExplicit].filter(Boolean)
    .map(entry => ({ ...entry, contribution: Number(entry.contribution) }));
  const finite = candidates.filter(entry => Number.isFinite(entry.contribution));
  if (finite.length && finite.some(entry => entry.contribution < 0)) return reject('invalid-source-contribution', { nodeId: node.id });
  if (finite.length && finite.some(entry => Math.abs(entry.contribution - finite[0].contribution) > EPSILON)) {
    return reject('conflicting-source-contributions', { nodeId: node.id });
  }
  if (finite.length) return {
    status: 'accepted', contribution: finite[0].contribution,
    mode: finite[0].mode === CATCHMENT_PROVENANCE.CATCHMENT_PROXY
      || options.sourceContributionMode === CATCHMENT_PROVENANCE.CATCHMENT_PROXY
      ? CATCHMENT_PROVENANCE.CATCHMENT_PROXY : CATCHMENT_PROVENANCE.EXPLICIT_FIXTURE,
    basis: finite[0].basis || (options.sourceContributionMode === CATCHMENT_PROVENANCE.CATCHMENT_PROXY
      ? 'local-source-proxy' : 'explicit-source-contribution'),
  };
  const proxy = catchmentProxyFor(node, reaches, options, graph);
  if (proxy.status !== 'accepted') return proxy;
  return proxy;
}

function catchmentProxyFor(node, reaches, options, graph) {
  const callback = options.catchmentProxy;
  let value;
  let basis = 'default-catchment-proxy';
  if (typeof callback === 'function') value = callback({ ...node }, reaches[0] || null, graph);
  else if (callback instanceof Map) value = callback.get(node.id);
  else if (callback && typeof callback === 'object') value = callback[node.id];
  if (value && typeof value === 'object') {
    basis = value.basis || 'catchment-proxy';
    value = firstFinite(value.contribution, value.amount, value.value, value.runoff);
  }
  if (!Number.isFinite(value)) {
    const area = firstFinite(node.catchmentArea, node.drainageArea,
      node.catchmentProxy, reaches[0]?.catchmentArea, reaches[0]?.drainageArea);
    const runoff = firstFinite(node.runoffWeight, node.moistureWeight,
      reaches[0]?.runoffWeight, options.defaultRunoffWeight) ?? 1;
    if (area !== undefined) { value = area * runoff; basis = 'catchment-area-proxy'; }
  }
  if (!Number.isFinite(value)) value = Number.isFinite(options.defaultSourceContribution)
    ? options.defaultSourceContribution : 1;
  if (!(value >= 0) || !Number.isFinite(value)) return reject('invalid-source-contribution', { nodeId: node.id });
  return { status: 'accepted', contribution: value, mode: 'catchment-proxy', basis };
}

function resolveLakeLocalContribution(node, options) {
  if (!isLakeNode(node, options)) return { status: 'accepted', contribution: 0, mode: 'none', basis: 'none' };
  const value = firstFinite(node.localCatchmentContribution, node.lakeLocalCatchment,
    node.localContribution, node.catchmentContribution, options.lakeLocalContributions?.[node.id]);
  if (value === undefined) return { status: 'accepted', contribution: 0, mode: 'none', basis: 'no-independent-lake-surface-source' };
  if (!(value >= 0) || !Number.isFinite(value)) return reject('invalid-lake-local-contribution', { nodeId: node.id });
  return { status: 'accepted', contribution: value, mode: 'catchment-proxy', basis: 'lake-local-catchment-proxy' };
}

function uniqueSources(sources) {
  const byId = new Map();
  for (const source of sources) {
    const prior = byId.get(source.id);
    if (!prior) byId.set(source.id, source);
    else if (Math.abs(prior.contribution - source.contribution) > EPSILON) {
      // This can only happen when a malformed graph gives two local lake
      // nodes the same ID. Keep the first deterministic record; validation of
      // ordinary root IDs happens earlier.
      throw new Error(`Conflicting source contribution ${source.id}`);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function terminalEntries(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()].map(([nodeId, declaration]) => normalizeTerminalEntry(declaration, nodeId));
  if (value instanceof Set) return [...value].map(nodeId => normalizeTerminalEntry({ kind: 'ocean', verified: true }, nodeId));
  if (Array.isArray(value)) return value.map((entry, index) => normalizeTerminalEntry(entry, index));
  if (typeof value === 'object') return Object.entries(value).map(([nodeId, declaration]) => normalizeTerminalEntry(declaration, nodeId));
  return [];
}

function normalizeTerminalEntry(entry, fallbackId) {
  if (typeof entry === 'string') return { nodeId: String(fallbackId), kind: entry, verified: false };
  if (entry && typeof entry === 'object') {
    return { ...entry, nodeId: String(entry.nodeId ?? entry.id ?? fallbackId),
      kind: String(entry.kind ?? entry.type ?? 'ocean'), verified: entry.verified === true };
  }
  return { nodeId: String(fallbackId), kind: 'ocean', verified: false };
}

function semanticTerminal(node, declaration, options) {
  const marker = node.terminal ?? node.terminalKind ?? node.terminalType;
  const nodeOcean = node.oceanTerminal === true || node.ocean === true || node.kind === 'ocean'
    || marker === 'ocean';
  const nodeLake = node.closedBasin === true || node.closed === true
    || marker === 'lake' || marker === 'basin' || marker === 'closed-basin'
    || (node.kind === 'lake' && node.throughFlow !== true && node.outlet !== true);
  if (declaration) {
    const kind = declaration.kind === 'ocean' ? 'ocean'
      : (['lake', 'basin', 'closed-basin'].includes(declaration.kind) ? 'closed-basin' : declaration.kind);
    if (kind === 'ocean') return { kind, verified: declaration.verified === true, semantic: 'explicit-terminal-declaration' };
    if (kind === 'closed-basin') return { kind, verified: declaration.verified !== false, semantic: 'explicit-closed-basin-declaration' };
  }
  if (nodeOcean) return { kind: 'ocean', verified: true, semantic: 'explicit-ocean-node' };
  if (nodeLake) return { kind: 'closed-basin', verified: true, semantic: 'explicit-closed-basin-node' };
  if (options.allowImplicitClosedBasins === true && node.kind === 'basin') {
    return { kind: 'closed-basin', verified: true, semantic: 'explicit-basin-kind' };
  }
  return null;
}

function receiverOf(node, graph) {
  if (node.receiver !== undefined) return node.receiver;
  if (node.receiverId !== undefined) return node.receiverId;
  const map = graph.receiverByNode ?? graph.receivers;
  if (map instanceof Map) return map.get(node.id);
  if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, node.id)) return map[node.id];
  return undefined;
}

function isLakeNode(node, options) {
  if (!node) return false;
  if (node.kind === 'lake' || node.lake === true || node.lakeId || node.basinId) return true;
  const lakes = options.lakes;
  if (Array.isArray(lakes)) return lakes.some(lake => String(lake.nodeId ?? lake.id) === node.id && lake.kind !== 'ocean');
  return false;
}

function lakeIdOf(node, options) {
  if (node.lakeId !== undefined) return String(node.lakeId);
  if (node.basinId !== undefined) return String(node.basinId);
  if (node.id !== undefined) {
    const lake = (options.lakes || []).find?.(entry => String(entry.nodeId ?? entry.id) === node.id);
    if (lake?.lakeId !== undefined) return String(lake.lakeId);
    if (lake?.id !== undefined) return String(lake.id);
  }
  return node.id;
}

function sectionFactors(point, options) {
  const confinement = firstFinite(point.valleyConfinement, point.confinement,
    point.valley?.confinement, options.defaultConfinement) ?? 0;
  const material = String(point.bankMaterial ?? point.material ?? options.bankMaterial ?? '').toLowerCase();
  const materialFactor = material.includes('rock') ? 0.82
    : material.includes('sand') ? 1.06
      : material.includes('alluv') ? 1.1
        : material.includes('gravel') ? 1.03 : 1;
  return {
    confinement: clamp(confinement, 0, 1),
    materialFactor,
  };
}

function dimensionsForContribution(contribution, factors, options) {
  // Calibrated around the local-source proxy used by the regional preview:
  // one unit is a roughly 3 m total channel, while a joined 3–8 unit trunk
  // lands in the 7–14 m range.  The exponent remains sublinear so many
  // tributaries do not make a physically implausible jump in width.
  const base = options.widthBase ?? 0.5;
  const scale = options.widthScale ?? 2.6;
  const exponent = options.widthExponent ?? 0.82;
  const totalBase = base + scale * Math.pow(Math.max(0, contribution), exponent);
  const totalWidth = clamp(totalBase * factors.materialFactor
    * lerp(1, 0.72, factors.confinement), 1, options.maxModeledTotalWidth ?? 100);
  const halfWidth = totalWidth / 2;
  const depth = clamp((options.depthBase ?? 0.45)
    + (options.depthScale ?? 0.8) * Math.pow(Math.max(0, contribution), options.depthExponent ?? 0.35)
    * lerp(1.15, 0.95, factors.confinement), options.minDepth ?? 0.2, options.maxDepth ?? 12);
  return { totalWidth, halfWidth, depth, widthClass: widthClassForTotalWidth(totalWidth) };
}

function dominantIncomingProfile(incomingEdges, reachByEdge, profileByReach, flowByNode) {
  const candidates = [];
  for (const edge of incomingEdges) {
    const reach = reachByEdge.get(edge.id);
    const profile = reach ? profileByReach.get(reach.id) : null;
    if (!profile) continue;
    candidates.push({
      reach,
      profile,
      contribution: flowByNode.get(edge.from)?.total ?? 0,
    });
  }
  return candidates.sort((a, b) => b.contribution - a.contribution
    || compareId(a.reach, b.reach))[0]?.profile || null;
}

function actualProfileEndpointWidth(profile) {
  if (!profile || profile.morphology !== true) return profile?.endHalfWidth;
  const canonicalLength = Array.isArray(profile.samples) && profile.samples.length
    ? profile.samples.at(-1).arc : null;
  const trendLength = Number.isFinite(profile.trendStartArc) && Number.isFinite(profile.trendEndArc)
    ? profile.trendEndArc - profile.trendStartArc : canonicalLength;
  if (!Number.isFinite(canonicalLength) || !Number.isFinite(trendLength)
    || trendLength <= EPSILON || canonicalLength >= trendLength - PROFILE_EPSILON) {
    return profile.endHalfWidth;
  }
  const t = smoothstep(0, trendLength, canonicalLength);
  return lerp(profile.startHalfWidth, profile.endHalfWidth, t);
}

function downstreamTransitionDistance(samples, incomingContribution, localContribution, options, morphology = false) {
  if (!(incomingContribution > EPSILON) || samples.length < 2) return 0;
  const desired = Math.max(...samples.map(sample => sample.rawHalfWidth));
  const widthBased = desired * (morphology
    ? (options.morphologySmoothingWidths ?? options.smoothingWidths ?? 6)
    : (options.smoothingWidths ?? 4));
  return clamp(widthBased,
    morphology ? (options.morphologyMinSmoothingDistance ?? options.minSmoothingDistance ?? 24)
      : (options.minSmoothingDistance ?? 12),
    morphology ? (options.morphologyMaxSmoothingDistance ?? options.maxSmoothingDistance ?? 192)
      : (options.maxSmoothingDistance ?? 192));
}

function smoothingWindow(samples, options) {
  if (samples.length < 2) return 0;
  const totalArc = samples.at(-1).arc;
  return clamp(options.smoothingWindow ?? Math.max(12, totalArc / Math.max(1, samples.length - 1) * 2), 0, 256);
}

function weightedCharacteristic(samples, field = 'halfWidth') {
  if (!samples.length) return 0;
  let total = 0, weight = 0;
  for (let i = 0; i < samples.length; i++) {
    const localWeight = i === 0 || i === samples.length - 1 ? 0.5 : 1;
    total += samples[i][field] * localWeight; weight += localWeight;
  }
  return total / Math.max(weight, EPSILON);
}

function nodeDistances(graph, topology) {
  const distance = new Map();
  for (const id of topology.order) {
    const incoming = topology.incoming.get(id);
    distance.set(id, incoming.length ? Math.max(...incoming.map(edge =>
      (distance.get(edge.from) ?? 0) + edge.length)) : 0);
  }
  return distance;
}

function sourceDistances(graph, topology, flowByNode, sources) {
  const sourceNodes = new Map((sources || []).map(source => [source.id, source.nodeId]));
  const distances = new Map();
  for (const id of topology.order) {
    const incoming = topology.incoming.get(id);
    const flow = flowByNode.get(id)?.bySource || new Map();
    for (const sourceId of flow.keys()) {
      const candidates = incoming.map(edge => {
        const prior = distances.get(sourceId)?.get(edge.from);
        return prior === undefined ? -Infinity : prior + edge.length;
      }).filter(Number.isFinite);
      const atSource = sourceNodes.get(sourceId) === id ? 0 : -Infinity;
      const value = Math.max(atSource, ...candidates);
      if (!Number.isFinite(value)) continue;
      if (!distances.has(sourceId)) distances.set(sourceId, new Map());
      distances.get(sourceId).set(id, value);
    }
  }
  return distances;
}

function dominantSourceAt(bySource, sources) {
  if (!(bySource instanceof Map) || !bySource.size) return null;
  const sourceKinds = new Map((sources || []).map(source => [source.id, source.kind]));
  return [...bySource.entries()]
    .filter(([id]) => sourceKinds.get(id) !== 'lake-local-catchment')
    .sort(([a, amountA], [b, amountB]) => amountB - amountA || a.localeCompare(b))[0]?.[0]
    || [...bySource.keys()].sort()[0]
    || null;
}

function cumulativeArc(points) {
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    arc.push(arc.at(-1) + length);
  }
  return arc;
}

function consecutiveEdgeIds(points) {
  return points.slice(1).map((point, index) => `${points[index].id}>${point.id}`);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function firstFinite(...values) {
  return values.find(value => Number.isFinite(value));
}

function sumAmounts(values) {
  let total = 0;
  const iterable = values instanceof Map ? values.values() : (values || []);
  for (const value of iterable) total += Number(value) || 0;
  return total;
}

function addAmount(map, id, amount) { map.set(id, (map.get(id) || 0) + amount); }

function compareId(a, b) { return String(a.id ?? a).localeCompare(String(b.id ?? b)); }

function reject(reason, details = {}) { return { status: 'rejected', reason, ...details }; }

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
