import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFortifiedOutpostPlan,
  createFortifiedOutpostWalkableClaims,
  pointInsideFortifiedOutpost,
  protectedRouteClearance,
  fortifiedOutpostClaimHeight,
  fortifiedOutpostClaimNormal,
  fortifiedOutpostTier,
  donjonRimCourses,
  validateFortifiedOutpostPlan,
  OUTPOST_TIERS,
} from '../src/fortifiedoutpost.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { registerFortifiedOutpostRuntime } from '../src/fortifiedoutpostruntime.mjs';

// Seeds chosen for their tier so each assertion says which scale it is about.
const KEEP = 17, OUTPOST = 7, WATCH = 3;

test('fortified outpost plans are deterministic, immutable, varied and versioned', () => {
  const a = createFortifiedOutpostPlan(KEEP), b = createFortifiedOutpostPlan(KEEP);
  assert.deepEqual(a, b);
  assert.equal(a.diagnostics.validation.valid, true);
  assert.equal(a.entropy.events.length, 1);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.intact), true);
  assert.equal(Object.isFrozen(a.entropy), true);
  assert.notEqual(a.architectureHash, createFortifiedOutpostPlan(18).architectureHash);
  assert.notEqual(a.entropyHash, createFortifiedOutpostPlan(18).entropyHash);
  assert.ok(a.intact.bounds.maxX - a.intact.bounds.minX >= 35);
  assert.ok(a.intact.bounds.maxX - a.intact.bounds.minX <= 62);
  assert.ok(a.intact.curtain.gate.width >= 3);
  assert.ok(pointInsideFortifiedOutpost(a, 0, 0));
});

// The whole point of the site rework: three scales, one building. A watch site
// is the lone drum, an outpost walls it, a keep gives it a hall and a way down.
test('every tier is the same drum at a different scale', () => {
  const tiers = { watch: 0, outpost: 0, keep: 0 };
  for (let seed = 1; seed <= 3000; seed++) {
    const plan = createFortifiedOutpostPlan(seed);
    tiers[plan.tier]++;
    const report = validateFortifiedOutpostPlan(plan);
    assert.ok(report.valid, `seed ${seed} (${plan.tier}): ${report.errors.join(', ')}`);
    // The drum is the constant.
    assert.equal(plan.intact.donjon.id, 'tower:donjon');
    assert.equal(plan.intact.towers[0].id, 'tower:donjon');
    assert.ok(plan.survivingPieces.some((piece) => piece.id === 'tower:donjon'));
    if (plan.tier === 'watch') {
      assert.equal(plan.intact.curtain, null);
      assert.equal(plan.intact.undercroft, null);
      assert.equal(plan.dungeonSeam, null);
    } else {
      assert.ok(plan.intact.curtain.runs.length >= 8);
    }
    if (plan.tier === 'keep') {
      assert.equal(plan.dungeonSeam.enabled, true);
      assert.equal(plan.dungeonSeam.kind, 'undercroft-door');
      assert.ok(plan.intact.ramp && plan.intact.landing && plan.intact.room);
    } else {
      assert.equal(plan.intact.ramp, null);
    }
  }
  for (const tier of OUTPOST_TIERS) assert.ok(tiers[tier] > 300, `${tier}: ${tiers[tier]}`);
  assert.ok(tiers.watch > tiers.outpost && tiers.outpost > tiers.keep);
  assert.equal(fortifiedOutpostTier(KEEP), 'keep');
});

// Issue 4 in the playtest: you could walk straight through the watchtower.
test('the drum is solid up to the height that actually survived, and open at its door', () => {
  for (const seed of [WATCH, OUTPOST, KEEP]) {
    const plan = createFortifiedOutpostPlan(seed);
    const donjon = plan.intact.donjon;
    const collision = new StructureCollisionIndex();
    const release = registerFortifiedOutpostRuntime({ plan, collisionIndex: collision });

    // The best-preserved bearing is a wall.
    const tallX = Math.cos(donjon.tallAngle) * donjon.radius;
    const tallZ = Math.sin(donjon.tallAngle) * donjon.radius;
    assert.ok(collision.collides(tallX, tallZ, 1.2), `seed ${seed}: tall side is walk-through`);

    // The doorway is not.
    const doorX = Math.cos(donjon.doorAngle) * donjon.radius;
    const doorZ = Math.sin(donjon.doorAngle) * donjon.radius;
    assert.equal(collision.collides(doorX, doorZ, 1.2), null, `seed ${seed}: doorway is blocked`);

    // A proxy never stands taller than the stones behind it.
    for (const proxy of plan.collisionProxies.filter((item) => item.sourcePieceId === 'tower:donjon')) {
      const middle = Math.atan2(
        (proxy.az + proxy.bz) / 2 - donjon.z, (proxy.ax + proxy.bx) / 2 - donjon.x,
      );
      const standing = donjonRimCourses(donjon, middle) * donjon.courseHeight;
      assert.ok(proxy.maxY <= standing + 0.01, `seed ${seed}: proxy overtops the ruin`);
    }
    release();
  }
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
  const plan = createFortifiedOutpostPlan(KEEP);
  const claims = createFortifiedOutpostWalkableClaims(plan);
  const ramp = claims.find((claim) => claim.mode === 'ramp');
  const surface = new WalkableSurface({ seed: 1, height: () => 0 });
  const release = surface.registerClaims(claims);
  const mid = { x: (ramp.ax + ramp.bx) / 2, z: (ramp.az + ramp.bz) / 2 };
  const query = surface.queryAt(mid.x, mid.z, 20);
  assert.equal(query.supportId, ramp.id);
  assert.ok(query.y > ramp.ay && query.y < ramp.by);
  assert.ok(query.normal[1] > 0.8 && query.normal[1] < 1);
  // A ramp you cannot walk up is a wall with a surface claim on it.
  assert.ok(Math.abs(ramp.by - ramp.ay) / Math.hypot(ramp.bx - ramp.ax, ramp.bz - ramp.az) <= 0.28);
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
  assert.equal(surface.structureClaims.size, plan.walkableClaims.length);
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

console.log('fortifiedoutpost PASS · three scales, one drum · solid tower · atomic runtime');
