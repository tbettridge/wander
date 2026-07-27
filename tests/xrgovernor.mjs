import assert from 'node:assert/strict';
import {
  XR_RUNTIME_STAGES,
  XRRuntimeGovernor,
  xrRuntimePressure,
} from '../src/xrgovernor.mjs';

assert.equal(XR_RUNTIME_STAGES.length, 3);
assert.equal(XR_RUNTIME_STAGES[2].nearGrassScale, 0.88,
  'recovery must retain most nearby stereo grass');
assert.ok(XR_RUNTIME_STAGES[2].midGrassScale < XR_RUNTIME_STAGES[1].midGrassScale);
assert.ok(XR_RUNTIME_STAGES[2].shadowHzScale > 0,
  'recovery must retain low-rate lighting rather than disabling shadows');

const healthy = xrRuntimePressure({
  refreshRate: 72, frameP95Ms: 14, cpuP95Ms: 7, gpuMs: 8, missedPercent: 0,
});
assert.equal(healthy.level, 0);
assert.equal(healthy.healthy, true);

const strained = xrRuntimePressure({
  refreshRate: 72, frameP95Ms: 17, cpuP95Ms: 9, gpuMs: 11, missedPercent: 5,
});
assert.equal(strained.level, 1);

const severeMetrics = {
  refreshRate: 72, frameP95Ms: 28, cpuP95Ms: 18, gpuMs: 19, missedPercent: 22,
};
const severe = xrRuntimePressure(severeMetrics);
assert.equal(severe.level, 2);

const governor = new XRRuntimeGovernor({ warmupWindows: 2, slowWindows: 2, recoveryWindows: 3 });
governor.start({ preferredFrameRate: 72 });
governor.sample(severeMetrics); // warmup 1
governor.sample(severeMetrics); // warmup 2
assert.equal(governor.stage.name, 'full');
governor.sample(severeMetrics); // severe contributes two slow windows
assert.equal(governor.stage.name, 'assisted');
governor.sample(severeMetrics);
assert.equal(governor.stage.name, 'recovery');
for (let i = 0; i < 3; i++) governor.sample({
  refreshRate: 72, frameP95Ms: 14, cpuP95Ms: 7, gpuMs: 8, missedPercent: 0,
});
assert.equal(governor.stage.name, 'assisted', 'healthy hysteresis did not restore one stage');
for (let i = 0; i < 3; i++) governor.sample({
  refreshRate: 72, frameP95Ms: 14, cpuP95Ms: 7, gpuMs: 8, missedPercent: 0,
});
assert.equal(governor.stage.name, 'full', 'healthy hysteresis did not fully restore');

governor.setMode('recovery');
assert.equal(governor.stage.name, 'recovery');
governor.setMode('auto');
assert.equal(governor.stage.name, 'full');

console.log('xrgovernor PASS · protected near grass · 3-stage hysteresis · manual A/B');
