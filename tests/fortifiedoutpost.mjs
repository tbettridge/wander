import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFortifiedOutpostPlan,
  createFortifiedOutpostWalkableClaims,
  pointInsideFortifiedOutpost,
  protectedRouteClearance,
  fortifiedOutpostClaimHeight,
  fortifiedOutpostClaimNormal,
} from '../src/fortifiedoutpost.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { registerFortifiedOutpostRuntime } from '../src/fortifiedoutpostruntime.mjs';

test('fortified outpost plans are deterministic, immutable, varied and versioned', () => {
  const a = createFortifiedOutpostPlan(17), b = createFortifiedOutpostPlan(17);
  assert.deepEqual(a, b);
  assert.equal(a.diagnostics.validation.valid, true);
  assert.equal(a.entropy.events.length, 1);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.intact), true);
  assert.equal(Object.isFrozen(a.entropy), true);
  assert.notEqual(a.architectureHash, createFortifiedOutpostPlan(18).architectureHash);
  assert.notEqual(a.entropyHash, createFortifiedOutpostPlan(18).entropyHash);
  assert.ok(a.intact.bounds.maxX - a.intact.bounds.minX >= 35);
  assert.ok(a.intact.bounds.maxX - a.intact.bounds.minX <= 58);
  assert.ok(a.intact.curtain.gate.width >= 3);
  assert.ok(a.intact.towers.length === 1 || a.intact.towers.length === 2);
  assert.ok(pointInsideFortifiedOutpost(a, 0, 0));
});

test('collapse removes only a non-gate wall and keeps the protected route clear', () => {
  const plan = createFortifiedOutpostPlan(93);
  const intactIds = new Set(plan.intact.pieces.map((piece) => piece.id));
  assert.ok(plan.entropy.removedPieceIds.every((id) => intactIds.has(id)));
  assert.ok(!plan.entropy.removedPieceIds.some((id) => id.includes('gate')));
  for (const rubble of plan.entropy.rubble.filter((piece) => piece.stable)) {
    assert.ok(protectedRouteClearance(plan, rubble) > 2.0);
  }
  for (const proxy of plan.collisionProxies) {
    assert.ok(proxy.sourcePieceId);
    assert.ok(plan.renderPieces.some((piece) => piece.id === proxy.sourcePieceId));
  }
});

test('ramp recipes expose a continuous height and normal through WalkableSurface', () => {
  const plan = createFortifiedOutpostPlan(7);
  const claims = createFortifiedOutpostWalkableClaims(plan);
  const ramp = claims.find((claim) => claim.mode === 'ramp');
  const surface = new WalkableSurface({ seed: 1, height: () => 0 });
  const release = surface.registerClaims(claims);
  const mid = { x: (ramp.ax + ramp.bx) / 2, z: (ramp.az + ramp.bz) / 2 };
  const query = surface.queryAt(mid.x, mid.z, 20);
  assert.equal(query.supportId, ramp.id);
  assert.ok(query.y > ramp.ay && query.y < ramp.by);
  assert.ok(query.normal[1] > 0.8 && query.normal[1] < 1);
  assert.equal(fortifiedOutpostClaimHeight(ramp, mid.x, mid.z), query.y);
  assert.deepEqual(fortifiedOutpostClaimNormal(ramp), query.normal);
  release();
  assert.equal(surface.structureClaims.size, 0);
});

test('runtime registration keeps gate openings open and releases every representation atomically', () => {
  const plan = createFortifiedOutpostPlan(41);
  const surface = new WalkableSurface({ seed: 1, height: () => 0 });
  const collision = new StructureCollisionIndex();
  const release = registerFortifiedOutpostRuntime({
    plan, walkableSurface: surface, collisionIndex: collision,
  });
  const gate = plan.intact.curtain.gate;
  assert.equal(collision.collides(gate.x, gate.z, 1), null);
  const wall = plan.survivingPieces.find((piece) => piece.kind === 'curtain-wall');
  assert.ok(wall);
  assert.equal(collision.collides((wall.ax + wall.bx) / 2, (wall.az + wall.bz) / 2, 1)?.sourcePieceId, wall.id);
  assert.equal(surface.structureClaims.size, 3);
  release();
  assert.equal(surface.structureClaims.size, 0);
  assert.equal(collision.records.size, 0);

  const failingCirculation = { register: () => { throw new Error('circulation rejected'); } };
  assert.throws(() => registerFortifiedOutpostRuntime({
    plan, walkableSurface: surface, collisionIndex: collision, circulation: failingCirculation,
  }), /circulation rejected/);
  assert.equal(surface.structureClaims.size, 0);
  assert.equal(collision.records.size, 0);
});

console.log('fortifiedoutpost PASS · semantic variation · one entropy event · ramp parity · atomic runtime');
