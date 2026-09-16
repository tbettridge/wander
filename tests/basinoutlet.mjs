import test from 'node:test';
import assert from 'node:assert/strict';
import { surveyBasinOutlet } from '../src/basinoutlet.mjs';
import { prepareBasinOutletSurvey } from '../src/hydrologyworker.js';

const basin = { id: 'test-lake', centerX: 0, centerZ: 0, level: 2.6 };
const world = { seed: 1, _naturalHeight(x, z) {
  if (Math.hypot(x, z) < 16) return 1.5;
  if (x >= 32 && Math.abs(z) <= 8) return 1.5;
  if (x >= 16 && Math.abs(z) <= 8) return 3;
  return 5;
} };

test('outlet follows the low sill and solves a descending cut-only profile from the lake head', () => {
  const outlet = surveyBasinOutlet(world, basin, { size: 128 });
  assert.equal(outlet.status, 'candidate');
  assert.equal(outlet.activationReady, false);
  assert.equal(outlet.sill.naturalY, 3);
  assert.ok(outlet.downstream.x >= 32);
  assert.equal(outlet.shore.waterY, basin.level);
  assert.equal(outlet.lakeHead.minY, outlet.lakeHead.maxY);
  assert.ok(outlet.downstream.waterY < basin.level);
  for (let i = 0; i < outlet.points.length; i++) {
    const p = outlet.points[i], previous = outlet.points[i - 1];
    assert.ok(p.bedY <= p.naturalY + 1e-9);
    assert.ok(p.naturalY - p.bedY <= outlet.maxCut + 1e-9);
    if (previous) {
      assert.ok(p.waterY <= previous.waterY + 1e-9);
      assert.ok(previous.waterY - p.waterY <= (p.arc - previous.arc) * outlet.maxGrade + 1e-9);
    }
  }
  assert.deepEqual(surveyBasinOutlet(world, basin, { size: 128 }), outlet);
});

test('budget and survey edges cannot turn into invented lake outlets', () => {
  assert.equal(surveyBasinOutlet(world, basin, { size: 128, maxCut: 0.5 }).reason, 'outlet-cut-budget');
  assert.equal(surveyBasinOutlet(world, basin, { size: 128, maxPath: 1 }).reason, 'outlet-path-budget');
  assert.equal(surveyBasinOutlet(world, basin, { size: 64 }).reason, 'unresolved-outlet-boundary');
  assert.equal(surveyBasinOutlet({ seed: 1, _naturalHeight: () => 1 }, basin, { size: 64 }).reason, 'uncontained-basin');
  assert.equal(surveyBasinOutlet(world, { ...basin, level: 0.5 }, { size: 64 }).reason, 'dry-basin-anchor');
  assert.throws(() => surveyBasinOutlet(world, basin, { size: 2048 }), /Invalid/);
});

test('real lake and pond surveys survive planning-worker transport without publishing water plans', async () => {
  const request = { type: 'survey-basin-outlets', id: 31, seed: 20260612, regionX: 0, regionZ: 0 };
  const expected = prepareBasinOutletSurvey(request);
  assert.equal(expected.report.outlets.length, 4);
  for (const outlet of expected.report.outlets) {
    assert.equal(outlet.status, 'candidate');
    assert.ok(outlet.minimumCut > 1.4 && outlet.minimumCut < 1.7);
    assert.ok(outlet.downstream.naturalY < outlet.level - 0.2);
    assert.equal(outlet.shore.waterY, outlet.level);
  }
  const lake = expected.report.outlets.find(o => o.basinId.endsWith(':2912:1904'));
  assert.ok(lake.points.length >= 8, 'lake parent path crosses internal dry terrain before its final exit');
  const previousSelf = globalThis.self;
  let message;
  try {
    globalThis.self = { postMessage(m) { message = structuredClone(m); } };
    await import('../src/hydrologyworker.js?basin-outlet-test');
    self.onmessage({ data: request });
    assert.equal(message.type, 'basin-outlets-surveyed');
    assert.equal(message.id, request.id);
    assert.equal(message.plan, undefined);
    assert.deepEqual(message.report, expected.report);
  } finally { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; }
});
