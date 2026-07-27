import assert from 'node:assert/strict';
import { XRPerformanceController } from '../src/xrperformance.js';

const calls = { scale: [], foveation: [], refresh: [] };
const storageValues = new Map();
const storage = {
  getItem: (key) => storageValues.get(key) ?? null,
  setItem: (key, value) => storageValues.set(key, value),
};
const renderer = {
  getContext: () => ({}),
  xr: {
    isPresenting: false,
    setFramebufferScaleFactor: (value) => calls.scale.push(value),
    setFoveation: (value) => calls.foveation.push(value),
    getFoveation: () => calls.foveation.at(-1),
  },
};

const controller = new XRPerformanceController(renderer, { storage });
assert.equal(controller.selectedName, 'painterly');
assert.equal(calls.scale.at(-1), 0.82);

controller.selectProfile('survival');
assert.equal(controller.selectedName, 'survival');
assert.equal(calls.scale.at(-1), 0.70);
assert.equal(storageValues.get('wander.xrProfile'), 'survival');

const session = {
  frameRate: 90,
  supportedFrameRates: new Float32Array([72, 90, 120]),
  async updateTargetFrameRate(rate) {
    calls.refresh.push(rate);
    this.frameRate = rate;
  },
};
renderer.xr.isPresenting = true;
await controller.startSession(session);
assert.equal(controller.activeName, 'survival');
assert.equal(calls.foveation.at(-1), 0.90);
assert.equal(calls.refresh.at(-1), 72);
assert.equal(controller.telemetry.refreshRate, 72);

const scaleCallsDuringSession = calls.scale.length;
let selectionEvent = null;
let performanceSample = null;
controller.onSelectionChange = (event) => { selectionEvent = event; };
controller.onSample = (sample) => { performanceSample = sample; };
controller.selectProfile('painterly');
assert.equal(controller.activeName, 'survival');
assert.equal(calls.scale.length, scaleCallsDuringSession);
assert.equal(selectionEvent.pending, true);

for (let i = 0; i < 60; i++) {
  controller.tick(1 / 72, 4.2, { render: { calls: 80, triangles: 120000 } });
}
assert.ok(controller.telemetry.fps > 70);
assert.equal(controller.telemetry.drawCalls, 80);
assert.equal(controller.telemetry.missedPercent, 0);
assert.equal(performanceSample.drawCalls, 80);
controller.setRuntimeStage('Full');
assert.equal(controller.setRuntimeFoveation(0.96), 0.96);
assert.equal(calls.foveation.at(-1), 0.96);

renderer.xr.isPresenting = false;
controller.endSession();
assert.equal(controller.activeName, null);
assert.equal(controller.telemetry.state, 'desktop');
assert.equal(calls.scale.at(-1), 0.82);
assert.ok(controller.lastSessionReport.averageFps > 70);
assert.equal(controller.lastSessionReport.runtimeStages[0].label, 'Full');
assert.match(controller.telemetry.lastSession, /fps avg/);

console.log('xrperformance PASS · session-safe profile switch · 72 Hz target · desktop preflight restored');
