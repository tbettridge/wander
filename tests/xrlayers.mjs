import assert from 'node:assert/strict';
import {
  THREE_XR_EYE_LAYERS,
  THREE_XR_LEFT_EYE_LAYER,
  THREE_XR_RIGHT_EYE_LAYER,
  XR_SHADOW_LAYER,
  isThreeXREyeLayer,
} from '../src/xrlayers.mjs';

assert.deepEqual(THREE_XR_EYE_LAYERS, [1, 2]);
assert.equal(THREE_XR_LEFT_EYE_LAYER, 1);
assert.equal(THREE_XR_RIGHT_EYE_LAYER, 2);
assert.equal(isThreeXREyeLayer(THREE_XR_LEFT_EYE_LAYER), true);
assert.equal(isThreeXREyeLayer(THREE_XR_RIGHT_EYE_LAYER), true);
assert.equal(isThreeXREyeLayer(XR_SHADOW_LAYER), false,
  'shadow proxies must not collide with Three.js WebXR eye layers');

const leftEyeMask = (1 << 0) | (1 << THREE_XR_LEFT_EYE_LAYER);
const rightEyeMask = (1 << 0) | (1 << THREE_XR_RIGHT_EYE_LAYER);
const shadowMask = 1 << XR_SHADOW_LAYER;
assert.equal(leftEyeMask & shadowMask, 0);
assert.equal(rightEyeMask & shadowMask, 0);
assert.notEqual(shadowMask, 0);

console.log('xrlayers PASS · shadow-only proxies isolated from left/right eye layers');
