import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFortifiedDungeonPlan,
  createFortifiedDungeonField,
  buildFortifiedDungeonDressingPlan,
  createDungeonStreamingState,
  dungeonEntranceTerrainReport,
  dungeonOpeningContains,
  dungeonOcclusionAt,
  validateFortifiedDungeonSurfaceLink,
  validateFortifiedDungeon,
} from '../src/fortifieddungeon.mjs';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import { inspectFortifiedDungeonTraversal } from '../src/ruininspection.mjs';

test('fortified dungeon links to a surface seam and preserves an in/out route', () => {
  const a = createFortifiedDungeonPlan(41), b = createFortifiedDungeonPlan(41);
  assert.deepEqual(a, b);
  assert.equal(validateFortifiedDungeon(a).valid, true);
  assert.equal(a.surfaceLink.portalId, 'portal:dungeon-floor');
  assert.equal(a.entrance.flatGround, true);
  assert.ok(dungeonOpeningContains(a, a.entrance.surface.x, a.entrance.surface.z));
  assert.ok(dungeonOcclusionAt(a, a.entrance.surface.x, a.entrance.surface.z));
  assert.equal(a.entropy.eventCount, 1);
  assert.ok(a.entropy.events[0].protectedRoute.includes(a.graph.entranceNodeId));
  assert.equal(a.dressing.suppressed, true);
  assert.equal(buildFortifiedDungeonDressingPlan(a, createFortifiedDungeonField(a), null).stalactites.length, 0);
});

test('dungeon apex is terrain-correct on a flat structure floor and regions cleanly release', () => {
  const plan = createFortifiedDungeonPlan({ seed: 8, surfaceY: 0.12 });
  const terrain = dungeonEntranceTerrainReport(plan, () => 0.12);
  assert.equal(terrain.valid, true);
  const stream = createDungeonStreamingState(plan);
  const first = stream.update(plan.graph.entranceNodeId);
  assert.ok(first.length >= 1);
  stream.update(plan.graph.goalNodeId);
  assert.ok(stream.snapshot().length >= 1);
  stream.clear();
  assert.deepEqual(stream.snapshot(), []);
});

test('dungeon program grammar varies intact meaning independently from entropy', () => {
  const families = new Set(), depths = new Set(), topologies = new Set(), features = new Set(), architectures = new Set();
  for (let seed = 0; seed < 256; seed++) {
    const plan = createFortifiedDungeonPlan(seed);
    const repeat = createFortifiedDungeonPlan(seed);
    assert.deepEqual(plan, repeat, `seed ${seed} is not deterministic`);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(validateFortifiedDungeon(plan).valid, true, `seed ${seed}: ${validateFortifiedDungeon(plan).errors}`);
    families.add(plan.program.family);
    depths.add(plan.program.depthPattern);
    topologies.add(plan.program.topologyPattern);
    features.add(plan.program.features.join('|'));
    architectures.add(plan.architectureHash);
    assert.equal(plan.diagnostics.programFallback, false);
    assert.equal(plan.diagnostics.protectedRouteNodeCount, plan.graph.mainPath.length);
    const edgePieces = new Set(plan.architecture.pieces.filter((piece) => piece.edgeId).map((piece) => piece.edgeId));
    assert.equal(edgePieces.size, plan.graph.edges.length, `seed ${seed} edge grammar coverage`);
    for (const claim of plan.walkableClaims) assert.ok(claim.sourcePieceId, `seed ${seed} claim source`);
  }
  assert.ok(families.size >= 5, `only ${families.size} program families`);
  assert.ok(depths.size >= 2, `only ${depths.size} depth patterns`);
  assert.ok(topologies.size >= 2, `only ${topologies.size} topology patterns`);
  assert.ok(features.size >= 5, `only ${features.size} feature programs`);
  assert.ok(architectures.size >= 128, `only ${architectures.size} intact architecture hashes`);

  const cellar = createFortifiedDungeonPlan({ seed: 41, program: 'cellar' });
  const crypt = createFortifiedDungeonPlan({ seed: 41, program: 'crypt' });
  assert.notEqual(cellar.program.family, crypt.program.family);
  assert.notEqual(cellar.architectureHash, crypt.architectureHash);
  assert.equal(cellar.entropyHash, crypt.entropyHash);
  assert.deepEqual(cellar.entropy, crypt.entropy);
  const fallback = createFortifiedDungeonPlan({ seed: 41, program: 'future-unknown-family' });
  assert.equal(fallback.diagnostics.programFallback, true);
  assert.equal(validateFortifiedDungeon(fallback).valid, true);
});

test('dungeon entrance and terrain opening stay coupled to a transformed outpost seam', () => {
  const local = createFortifiedOutpostPlan(93);
  const surface = transformFortifiedOutpostPlan(local, {
    x: 140, y: 27, z: -85, yaw: 1.17,
  });
  const plan = createFortifiedDungeonPlan({ seed: 93, surfacePlan: surface });
  const parity = validateFortifiedDungeonSurfaceLink(plan, surface);
  assert.equal(parity.valid, true, parity.errors.join(', '));
  assert.equal(plan.surfaceContext.anchorPieceId, 'room:floor');
  assert.equal(plan.surfaceContext.anchorKind, 'room');
  assert.equal(plan.surfaceLink.orientationYaw, 1.17);
  assert.ok(Math.abs(plan.entrance.surface.x - surface.dungeonSeam.x) < 1e-5);
  assert.ok(Math.abs(plan.entrance.surface.z - surface.dungeonSeam.z) < 1e-5);
  assert.equal(plan.terrainOpening.surfacePieceId, surface.dungeonSeam.surfacePieceId);
  assert.equal(plan.entrance.surface.y, surface.dungeonSeam.y);
  assert.equal(inspectFortifiedDungeonTraversal(plan).valid, true);
});

test('dungeon entrance families couple to the available surface access contract', () => {
  const surface = createFortifiedOutpostPlan(41);
  const cellar = createFortifiedDungeonPlan({ seed: 41, surfacePlan: surface, program: 'cellar' });
  const crypt = createFortifiedDungeonPlan({ seed: 41, surfacePlan: surface, program: 'crypt' });
  const underkeep = createFortifiedDungeonPlan({ seed: 41, surfacePlan: surface, program: 'underkeep' });

  assert.deepEqual(surface.dungeonSeam.surfacePieceId, 'room:floor');
  assert.deepEqual(cellar.surfaceContext.availableEntranceFamilies, ['cellar-stairs', 'crypt-access']);
  assert.equal(cellar.entrance.kind, 'cellar-stairs');
  assert.equal(cellar.program.entranceFallback, false);
  assert.equal(crypt.entrance.kind, 'crypt-access');
  assert.equal(crypt.program.entranceFallback, false);
  assert.equal(underkeep.entrance.kind, 'cellar-stairs');
  assert.equal(underkeep.program.entranceFallback, true);
  assert.equal(underkeep.entrance.surfaceAccess.pieceId, surface.dungeonSeam.surfacePieceId);
  assert.equal(underkeep.surfaceLink.trailContract.gateId, surface.intact.curtain.gate.id);
  assert.ok(underkeep.surfaceLink.vegetationExclusion.radius >= surface.intact.footprintRadius);
  assert.equal(validateFortifiedDungeon(underkeep).valid, true);
});

test('dungeon dressing stays masonry-led and entropy accounting is explicit', () => {
  const plan = createFortifiedDungeonPlan({ seed: 77, program: 'crypt' });
  const kinds = new Set(plan.architecture.pieces.map((piece) => piece.kind));
  assert.ok(kinds.has('masonry-floor'));
  assert.ok(kinds.has('masonry-arch'));
  assert.ok(kinds.has('masonry-pillar'));
  assert.ok(kinds.has('masonry-threshold'));
  assert.ok(plan.architecture.materialVariants.length >= 2);
  assert.equal(plan.dressing.naturalSuppressed, true);
  assert.equal(plan.dressing.masonryEnabled, true);
  assert.equal(plan.entropy.eventCount, 1);
  assert.equal(plan.entropy.events[0].supportCascade.rubbleIds.length, plan.entropy.rubble.length);
  assert.ok(plan.entropy.rubble.every((piece) => piece.sourcePieceId));
  const target = plan.entropy.events[0].targetEdgeId;
  assert.ok(plan.architecture.collapseOmissions.includes(`dungeon:floor:${target}`));
  assert.equal(plan.architecture.supports.find((support) => support.id === `dungeon:support:passage:${target}`).status, 'failed');
  assert.equal(validateFortifiedDungeon(plan).valid, true);
  for (const proxy of plan.architecture.renderProxies) {
    assert.ok(plan.architecture.pieces.some((piece) => piece.id === proxy.sourcePieceId));
  }
});

test('dungeon local navigation preserves headroom, grades, and a safe return route', () => {
  for (let seed = 0; seed < 128; seed++) {
    const plan = createFortifiedDungeonPlan(seed);
    const nav = plan.localNavigation;
    assert.equal(nav.channel, 'dungeon-local-navigation');
    assert.equal(nav.protectedRoute[0], 'surface:portal');
    assert.equal(nav.protectedRoute.at(-1), 'surface:portal');
    assert.ok(nav.returnRoute.length >= 2);
    assert.equal(validateFortifiedDungeon(plan).valid, true, `seed ${seed}`);
    for (const edge of nav.edges) {
      assert.ok(edge.headroom >= 2.0, `seed ${seed} ${edge.id} headroom`);
      assert.ok(edge.grade <= 0.45, `seed ${seed} ${edge.id} grade`);
      assert.equal(edge.bidirectional, true);
    }
  }
});

console.log('fortifieddungeon PASS · grammar variation · independent entropy · apex opening · cleanup');
