import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  THREE_RUNTIMES,
  alternatingTrialOrder,
  calibratedRepeatCount,
  describeMultiviewCapability,
  formatMultiviewResult,
  normalizeCompositorMode,
  normalizeMultiviewMode,
  normalizeThreeRuntime,
  selectedThreeRuntime,
  summarizeMultiviewTrials,
  urlWithThreeRuntime,
} from '../src/xrexperiments.mjs';
import { MULTIVIEW_VERTEX_SHADER } from '../src/xrmultiview.js';

assert.equal(THREE_RUNTIMES.baseline.revision, '165');
assert.equal(THREE_RUNTIMES.candidate.revision, '185');
assert.equal(normalizeThreeRuntime('next'), 'candidate');
assert.equal(normalizeThreeRuntime('r185'), 'candidate');
assert.equal(normalizeThreeRuntime('anything-else'), 'baseline');
assert.equal(selectedThreeRuntime('?three=r185', 'baseline'), 'candidate');
assert.equal(selectedThreeRuntime('', 'candidate'), 'candidate');
assert.equal(urlWithThreeRuntime('https://example.test/world?foo=1#test', 'candidate'),
  '/world?foo=1&three=r185#test');
assert.equal(urlWithThreeRuntime('https://example.test/world?foo=1&three=r185', 'baseline'),
  '/world?foo=1');
assert.equal(normalizeCompositorMode(true), 'quad');
assert.equal(normalizeCompositorMode('scene'), 'scene');
assert.equal(normalizeMultiviewMode('probe'), 'probe');
assert.equal(normalizeMultiviewMode(false), 'off');

assert.deepEqual(describeMultiviewCapability(), {
  supported: false,
  reason: 'requires WebGL 2',
});
assert.deepEqual(describeMultiviewCapability({ isWebGL2: true }), {
  supported: false,
  reason: 'OVR_multiview2 unavailable',
});
assert.deepEqual(describeMultiviewCapability({
  isWebGL2: true,
  extensionPresent: true,
  maxViews: 2,
}), { supported: true, reason: '2 simultaneous views' });

assert.deepEqual(alternatingTrialOrder(0), ['stereo', 'multiview']);
assert.deepEqual(alternatingTrialOrder(1), ['multiview', 'stereo']);
assert.equal(calibratedRepeatCount(2, 4, 5), 10);
assert.equal(calibratedRepeatCount(0, 1, 5, 2, 96), 96);
const summary = summarizeMultiviewTrials([
  { stereo: 5, multiview: 3 },
  { stereo: 6, multiview: 4 },
  { stereo: 7, multiview: 4 },
]);
assert.equal(summary.trials, 3);
assert.equal(summary.stereoP50, 6);
assert.equal(summary.multiviewP50, 4);
assert.ok(summary.savingsPercent > 33 && summary.savingsPercent < 34);
assert.match(formatMultiviewResult(summary), /faster/);

assert.match(MULTIVIEW_VERTEX_SHADER, /#extension GL_OVR_multiview2 : require/);
assert.match(MULTIVIEW_VERTEX_SHADER, /layout\(num_views=2\) in/);
assert.match(MULTIVIEW_VERTEX_SHADER, /gl_ViewID_OVR/);

const boot = await readFile(new URL('../src/threeruntime.js', import.meta.url), 'utf8');
assert.match(boot, /0\.165\.0/);
assert.match(boot, /0\.185\.0/);
assert.match(boot, /document\.currentScript\.after\(importMap\)/,
  'the selected import map must be inserted synchronously before modules load');

console.log('xrexperiments PASS · pinned Three A/B · quad fallback modes · isolated OVR multiview analysis');
