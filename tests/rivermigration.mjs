import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { prepareBasinRegion } from '../src/hydrologyworker.js';
import { auditCrossingMigration, traceRetainedLegacyComponent, validateCrossingReplacement } from '../src/rivermigration.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { fitRiverReach } from '../src/riverterrain.mjs';

test('crossing migration audits the whole manifest deterministically and retains incompatible structures', () => {
  const { manifest } = prepareBasinRegion({ seed: 1, regionX: 0, regionZ: 0 });
  const world = new World(1);
  const first = auditCrossingMigration(world, manifest);
  const second = auditCrossingMigration(world, structuredClone(manifest));
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.results.length, manifest.crossings.length);
  assert.equal(first.diagnostics.candidates + first.diagnostics.retained, first.results.length);
  assert.equal(first.activationReady, false);
  assert.deepEqual(first.components, second.components);
  const { hash: reportHash, results: ignoredResults, diagnostics: ignoredDiagnostics, ...reportPayload } = first;
  assert.equal(reportHash, descriptorHash(reportPayload));
  assert.equal(first.diagnostics.componentCandidates + first.diagnostics.componentRetained,
    first.components.length);
  const componentCrossings = first.components.flatMap(component => component.crossingIds).sort();
  assert.deepEqual(componentCrossings, manifest.crossings.filter(entry => entry.solved && entry.reservation)
    .map(entry => entry.id).sort());
  for (const component of first.components) {
    assert.ok(component.crossingIds.length > 0);
    assert.ok(component.reason || component.status === 'candidate');
  }
  const stones = first.results.find(result => result.id === '-2_0~0_-1:crossing:1');
  assert.equal(stones.status, 'retained');
  assert.ok(stones.reason, 'a rejected crossing needs an actionable migration reason');
  const oversized = first.results.filter(result => {
    const crossing = manifest.crossings.find(entry => entry.id === result.id);
    return crossing?.solved?.span > 45;
  });
  assert.ok(oversized.length > 0);
  assert.ok(oversized.every(result => result.reason !== 'legacy-span-exceeds-channel'));
  for (const result of first.results.filter(result => result.status === 'candidate')) {
    const crossing = manifest.crossings.find(entry => entry.id === result.id);
    assert.ok(result.waterY >= crossing.waterInterval[0] && result.waterY <= crossing.waterInterval[1]);
    assert.ok(result.clearance >= (crossing.solved.kind === 'bridge' ? 0.52 : 0.04));
    assert.ok(result.approachDelta <= 0.25);
  }
});

test('migration identity and malformed crossing contracts fail closed', () => {
  const { manifest } = prepareBasinRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  assert.throws(() => auditCrossingMigration(new World(2), manifest), /identity/);
  const malformed = structuredClone(manifest);
  const entry = malformed.crossings.find(crossing => crossing.solved);
  entry.waterInterval = [entry.waterInterval[1], entry.waterInterval[0]];
  assert.throws(() => auditCrossingMigration(new World(manifest.seed), malformed), /checksum/);
  const { hash, ...payload } = malformed;
  malformed.hash = descriptorHash(payload);
  const report = auditCrossingMigration(new World(manifest.seed), malformed);
  assert.equal(report.results.find(result => result.id === entry.id).reason, 'invalid-crossing-contract');
});

test('retention surveys follow the signal but never authorize an incomplete component', () => {
  const world = {
    seed: 1,
    _riverSignalAt: (x, z) => (x - Math.sin(z / 200) * 20) * 0.001,
    _naturalHeight(x, z, out) { Object.assign(out, { h: 4 - Math.abs(z) * 0.02, base: 4 - Math.abs(z) * 0.02 }); },
    _riverSectionAt(x, z, natural, out) { out.riverInfluence = true; },
  };
  const entry = { id: 'crossing', solved: { x: 15, z: 0 } };
  const survey = traceRetainedLegacyComponent(world, entry, { maxSteps: 100 });
  assert.equal(survey.status, 'surveyed');
  assert.equal(survey.activationReady, false);
  assert.ok(survey.component.points.every(p => Math.abs(world._riverSignalAt(p.x, p.z)) < 1e-8));
  assert.deepEqual(traceRetainedLegacyComponent(world, entry, { maxSteps: 100 }), survey);
  assert.equal(traceRetainedLegacyComponent(world, entry, { maxSteps: 9 }).reason, 'legacy-trace-budget');
});

test('a long bridge can pass over a narrow channel, but damaged approaches cannot pass', () => {
  const world = { seed: 1, _naturalHeight: (x, z) => 4 - z * 0.01 + x * x * 0.004 };
  const route = { status: 'candidate', source: 'spring', points: Array.from({ length: 9 }, (_, i) => ({
    x: 0, z: i * 50, waterY: Math.max(0, 3.4 - i * 0.5),
  })) };
  const reach = fitRiverReach(world, route, { fixedLevels: [{ id: 'bridge', x: 0, z: 200, minY: 1.5, maxY: 1.5 }] });
  assert.equal(reach.status, 'fitted');
  const entry = { solved: { x: 0, z: 200, kind: 'bridge', span: 120, deckLength: 120, surfaceY: 3 },
    waterInterval: [1.4, 1.6], reservation: { points: [-80, -70, 70, 80].map(x => ({
      x, z: 200, wet: false, floor: world._naturalHeight(x, 200),
    })) } };
  assert.equal(validateCrossingReplacement(world, entry, reach).status, 'accepted');
  const damaged = structuredClone(entry);
  // Farther than 60% of deck length: still part of its full captured approach.
  damaged.reservation.points[0].floor += 1;
  assert.equal(validateCrossingReplacement(world, damaged, reach).reason, 'crossing-approach-support');
  assert.equal(validateCrossingReplacement(world, { ...entry, solved: { ...entry.solved, surfaceY: 1.8 } }, reach).reason,
    'crossing-clearance');
});

test('migration reports survive the planning worker protocol without changing the active water plan', async () => {
  const messages = [];
  globalThis.self = { postMessage(message) { messages.push(structuredClone(message)); } };
  try {
    await import('../src/hydrologyworker.js?migration-protocol-test');
    self.onmessage({ data: { type: 'audit-migration', id: 17, seed: 20260612, regionX: 0, regionZ: 0 } });
    const response = messages.at(-1);
    assert.equal(response.type, 'migration-audited');
    assert.equal(response.id, 17);
    assert.equal(response.report.activationReady, false);
    assert.equal(response.report.footprint.activationReady, false);
    assert.equal(response.report.components.some(component => component.status === 'retained'), true);
    assert.ok(response.report.footprint.diagnostics.checks <= 250000);
    assert.ok(response.report.footprint.diagnostics.cells <= 8192);
    assert.equal(response.report.diagnostics.candidates + response.report.diagnostics.retained,
      response.report.results.length);
    assert.deepEqual(JSON.parse(JSON.stringify(response)), response);
    assert.equal(response.plan, undefined);
  } finally { delete globalThis.self; }
});
