import assert from 'node:assert/strict';
import {
  BLUR_WEIGHTS, DOWN_WEIGHTS, SOFT_BACKGROUND_ALPHA, WASH,
  blurKernelSum, depthToDistance, downKernelSum, isBackgroundDepth,
  softDistanceAlpha, washAmount, washAmountFromSoftAlpha,
} from '../src/softkernel.mjs';

// ── blur kernels must be energy-preserving ───────────────────────────────────
// A kernel that does not sum to 1 silently lightens or darkens far ground, and
// because it only shows where the wash is already strong it reads as "the fog
// colour is off" rather than as a broken filter.
assert.ok(Math.abs(downKernelSum() - 1) < 1e-9,
  `downsample kernel sums to ${downKernelSum()}, not 1`);
assert.ok(Math.abs(blurKernelSum() - 1) < 2e-3,
  `blur kernel sums to ${blurKernelSum()}, not 1`);
assert.ok(Object.isFrozen(DOWN_WEIGHTS) && Object.isFrozen(BLUR_WEIGHTS) && Object.isFrozen(WASH));
// a low-pass kernel's weights must all be positive, or it rings
for (const w of [...Object.values(DOWN_WEIGHTS), ...Object.values(BLUR_WEIGHTS)]) {
  assert.ok(w > 0, 'blur weights must be positive');
}
assert.ok(BLUR_WEIGHTS.centre > BLUR_WEIGHTS.far, 'gaussian must fall off from the centre');

// ── depth linearisation ──────────────────────────────────────────────────────
// Mirrors Three's perspectiveDepthToViewZ. If this drifts from the GLSL the
// wash silently ramps over the wrong distances, which looks like a tuning
// problem rather than a maths one.
const NEAR = 0.1, FAR = 11000;   // main.js PerspectiveCamera(70, aspect, 0.1, 11000)
assert.ok(Math.abs(depthToDistance(0, NEAR, FAR) - NEAR) < 1e-6,
  'depth 0 is the near plane');
assert.ok(Math.abs(depthToDistance(1, NEAR, FAR) - FAR) < 1e-3,
  'depth 1 is the far plane');
// monotonic, and the classic 1/z crowding means most of the buffer is near
let prevDist = 0;
for (let d = 0; d <= 1.0001; d += 0.05) {
  const dist = depthToDistance(Math.min(d, 1), NEAR, FAR);
  assert.ok(dist >= prevDist, 'distance must grow monotonically with depth');
  prevDist = dist;
}

// ── background must never wash ───────────────────────────────────────────────
// The sky dome has depthWrite:false, so the sky arrives here as untouched
// background. It is the one large surface a distance wash would visibly ruin —
// it would desaturate and soften the cleanest gradient in the frame.
assert.ok(isBackgroundDepth(1.0), 'depth 1 is background');
assert.ok(SOFT_BACKGROUND_ALPHA < 0,
  'background alpha must remain distinct from valid near-surface distance zero');
assert.ok(isBackgroundDepth(WASH.skyDepth), 'the threshold itself is background');
assert.ok(!isBackgroundDepth(0.999), 'real far geometry is not background');
assert.ok(!isBackgroundDepth(0.999999), 'even 7.5 km terrain is not background');
assert.ok(!isBackgroundDepth(0.5));
// Far terrain reaches 7.5 km and MUST still wash, so the background cutoff has
// to sit above the depth of the furthest real geometry.
const farTerrainDepth = (() => {
  // invert depthToDistance for 7500 m
  const dist = 7500;
  const z = (2 * NEAR * FAR / dist - FAR - NEAR) / -(FAR - NEAR);
  return (z + 1) / 2;
})();
assert.ok(!isBackgroundDepth(farTerrainDepth),
  `7.5 km terrain (depth ${farTerrainDepth}) must not be mistaken for sky`);
assert.ok(washAmount(depthToDistance(farTerrainDepth, NEAR, FAR)) > 0.8,
  'the far horizon should be near full wash');

// ── the wash curve ───────────────────────────────────────────────────────────
assert.ok(WASH.near > 0 && WASH.near < WASH.far);
// Near ground is untouched. This is watercolour, not depth of field: there is
// no focal plane, so close distances must mean zero wash.
assert.equal(washAmount(0), 0);
assert.equal(washAmount(WASH.near), 0, 'the ramp starts at WASH.near');
assert.equal(washAmount(10), 0, 'foreground detail must stay crisp');
assert.equal(washAmount(-5), 0, 'a negative distance is not a wash');
for (const distance of [1, 10, WASH.near, 240, WASH.far]) {
  assert.ok(Math.abs(
    washAmountFromSoftAlpha(softDistanceAlpha(distance)) - washAmount(distance),
  ) < 1e-9, `soft-buffer distance encoding must preserve the wash at ${distance}m`);
}
// monotonic in distance
let prev = -1;
for (let d = 0; d <= WASH.far * 1.5; d += WASH.far / 20) {
  const w = washAmount(d);
  assert.ok(w >= prev, 'wash must grow monotonically with distance');
  prev = w;
}
// even the far horizon keeps a little structure rather than dissolving
assert.ok(washAmount(1e6) < 1, 'the horizon must not fully dissolve');
assert.ok(Math.abs(washAmount(1e6) - WASH.maxWet) < 1e-9);
// the master is a true A/B: 0 disables, 1 is full strength
assert.equal(washAmount(1e6, 0), 0, 'wetness 0 must disable the wash entirely');
assert.equal(washAmount(1e6, 5), washAmount(1e6, 1), 'wetness clamps at 1');

// neither term may reach a full replacement of the original pixel
assert.ok(WASH.softMix > 0 && WASH.softMix < 0.5,
  'the sharp image must stay the majority contributor even at max distance');
assert.ok(WASH.chromaBleed > 0 && WASH.chromaBleed < WASH.softMix,
  'chroma bleed is seasoning on top of the softening, not the main effect');

console.log('softbuffer PASS · energy-preserving kernels · depth linearisation · '
  + 'sky excluded, 7.5 km terrain included · monotonic distance-gated wash');
