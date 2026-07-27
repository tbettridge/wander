import assert from 'node:assert/strict';
import { renderOffscreen } from '../src/offscreenrender.mjs';

function makeRenderer({ throws = false } = {}) {
  const calls = [];
  const originalTarget = { name: 'xr-framebuffer' };
  const renderer = {
    xr: { enabled: true, isPresenting: true },
    target: originalTarget,
    getRenderTarget() { return this.target; },
    setRenderTarget(target) {
      this.target = target;
      calls.push(['target', target?.name]);
    },
    render(scene, camera) {
      calls.push(['render', this.xr.enabled, this.target?.name, scene, camera]);
      if (throws) throw new Error('synthetic render failure');
    },
  };
  return { renderer, calls, originalTarget };
}

const target = { name: 'cloud-cache' };
const scene = { name: 'cache-scene' };
const camera = { name: 'orthographic-cache-camera' };
const normal = makeRenderer();
renderOffscreen(normal.renderer, target, scene, camera);
assert.deepEqual(normal.calls, [
  ['target', 'cloud-cache'],
  ['render', false, 'cloud-cache', scene, camera],
  ['target', 'xr-framebuffer'],
]);
assert.equal(normal.renderer.xr.enabled, true);
assert.equal(normal.renderer.target, normal.originalTarget);

const failing = makeRenderer({ throws: true });
assert.throws(() => renderOffscreen(failing.renderer, target, scene, camera),
  /synthetic render failure/);
assert.equal(failing.renderer.xr.enabled, true,
  'XR rendering must be restored even when an auxiliary pass fails');
assert.equal(failing.renderer.target, failing.originalTarget,
  'the headset framebuffer must be restored after an auxiliary pass fails');

console.log('offscreenrender PASS · auxiliary cameras isolated from live WebXR stereo state');
