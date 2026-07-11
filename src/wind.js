// Coherent wind gust field. A single set of shared uniforms is sampled by the
// existing sway shaders (grass, leaves, palm fronds), so all foliage in the
// world responds to the SAME drifting noise — visible gusts ripple across
// grass and canopies in waves, with calm patches and stronger pulses.
//
// Uniforms (all shared across materials):
//   uWindDir       — unit vector, average wind direction in world XZ
//   uWindStrength  — weather-driven base intensity 0..1 with gentle lulls
//   uWindTime      — seconds, integrated dt
//   uWindGustScale — 1/wavelength of a gust (≈1/80 m)
//   uWindSpeed     — metres/sec the gust field drifts downwind
//   uWindOffset    — integrated downwind travel in world XZ
//
// In the shader, `windGust(worldXZ)` returns a 0..1 gust intensity at any world
// point; the sway shaders use it to modulate amplitude AND to add a directional
// bend so the whole landscape leans together when a gust passes through.

import * as THREE from 'three';

export const windUniforms = {
  uWindDir:       { value: new THREE.Vector2(1, 0) },
  uWindStrength:  { value: 0.5 },
  uWindTime:      { value: 0 },
  uWindGustScale: { value: 1 / 80 }, // wavelength in metres
  uWindSpeed:     { value: 7 },      // metres/sec
  uWindOffset:    { value: new THREE.Vector2() },
};

// Inject these declarations + the windGust() helper into a shader. Namespaced
// `w*` so the noise won't collide with the atmosphere/terrain noise blocks.
export const WIND_GLSL_DECLS = /* glsl */`
uniform vec2 uWindDir;
uniform vec2 uWindOffset;
uniform float uWindStrength, uWindTime, uWindGustScale, uWindSpeed;
float wH21(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
float wNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = wH21(i), b = wH21(i + vec2(1,0)), c = wH21(i + vec2(0,1)), d = wH21(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wFbm(vec2 p){ return wNoise(p) * 0.65 + wNoise(p * 2.6) * 0.35; }
// 0..1 gust intensity at world-space xz. Subtracting the integrated offset
// makes features travel TOWARD uWindDir, the same convention visible clouds use.
float windGust(vec2 wp){
  vec2 p = (wp - uWindOffset) * uWindGustScale;
  return wFbm(p);
}
`;

let initialized = false;

// The weather timeline supplies the prevailing direction, strength and speed.
// A deterministic two-frequency pulse adds short lulls without letting foliage,
// clouds and audio each invent unrelated gust envelopes.
export function updateWind(dt, weather) {
  const u = windUniforms;
  u.uWindTime.value += dt;

  const targetX = weather?.windX ?? u.uWindDir.value.x;
  const targetZ = weather?.windZ ?? u.uWindDir.value.y;
  const targetSpeed = weather?.windSpeed ?? u.uWindSpeed.value;
  const pulse = 0.88
    + Math.sin(u.uWindTime.value * 0.17 + 0.7) * 0.075
    + Math.sin(u.uWindTime.value * 0.051 + 2.1) * 0.045;
  const targetStrength = THREE.MathUtils.clamp(
    (weather?.windStrength ?? u.uWindStrength.value) * pulse, 0.04, 1,
  );

  const dir = u.uWindDir.value;
  if (!initialized) {
    dir.set(targetX, targetZ).normalize();
    u.uWindStrength.value = targetStrength;
    u.uWindSpeed.value = targetSpeed;
    initialized = true;
  } else {
    const dirBlend = 1 - Math.exp(-dt * 0.65);
    dir.x += (targetX - dir.x) * dirBlend;
    dir.y += (targetZ - dir.y) * dirBlend;
    if (dir.lengthSq() > 1e-8) dir.normalize();
    const strengthBlend = 1 - Math.exp(-dt * 0.45);
    const speedBlend = 1 - Math.exp(-dt * 0.35);
    u.uWindStrength.value += (targetStrength - u.uWindStrength.value) * strengthBlend;
    u.uWindSpeed.value += (targetSpeed - u.uWindSpeed.value) * speedBlend;
  }

  // One integrated travel vector keeps gust fronts and cloud shadows coherent
  // even while the prevailing direction bends gradually through a front.
  u.uWindOffset.value.addScaledVector(dir, u.uWindSpeed.value * dt);
}
