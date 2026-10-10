// Shared water "look". The ocean (water.js) and the river ribbons (river.js)
// compose their shaders from these primitives — one palette, one sky reflection,
// one sun glint, one fresnel, one noise, and ONE set of lighting/fog uniforms —
// so the two are the SAME water by construction and blend seamlessly where they
// meet at deltas. Each mesh keeps its own wave field + foam (the ocean is
// omnidirectional; rivers flow downstream), but every surface-look decision
// lives here, so a tweak lands on both at once.

import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';
import { windUniforms } from './wind.js';

const _weatherSky = new THREE.Color();

// Shared uniform VALUE objects: both materials spread these in, so they point at
// the same {value} refs and one update per frame covers ocean and rivers.
// Tide: a gentle vertical swing. On near-flat beaches ±TIDE_AMP metres moves the
// waterline many metres horizontally — the visible "in and out". AMP is kept
// below the static worker-side river cut (WATER_LEVEL + 0.25) so the river
// meshes never need regenerating as the sea breathes.
export const TIDE_AMP = 0.18;    // metres
const TIDE_PERIOD = 110;         // seconds per full in-out cycle

export const waterUniforms = {
  uLakeReflectionMap: { value: null },
  uLakeReflectionMatrix: { value: new THREE.Matrix4() },
  uLakeReflectionBounds: { value: new THREE.Vector4() },
  uLakeReflectionLevel: { value: 0 },
  uLakeReflectionReady: { value: 0 },
  uTime:       { value: 0 },
  uWaterWindDir: windUniforms.uWindDir,
  uWaterWindStrength: windUniforms.uWindStrength,
  uWaterWindOffset: windUniforms.uWindOffset,
  uTide:       { value: 0 },
  uDay:        { value: 1 },
  uGlint:      { value: 1 },   // specular strength: sun by day, MOON by night
  uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
  uSunColor:   { value: new THREE.Color(1, 1, 1) },
  uSkyHorizon: { value: new THREE.Color() },
  uSkyZenith:  { value: new THREE.Color() },
  uFogColor:   { value: new THREE.Color() },
  uFogNear:    { value: 200 },
  uFogFar:     { value: 900 },
  // valley mist — SHARED {value} objects with the atmosphere injection, so the
  // one updateAtmosphere() write covers land and water alike (misty dawns
  // shroud rivers and bays exactly as they shroud the meadows around them).
  uAtmoMist:     atmoUniforms.uAtmoMist,
  uAtmoMistBase: atmoUniforms.uAtmoMistBase,
  uAtmoMistCol:  atmoUniforms.uAtmoMistCol,
  uAtmoMistRate: atmoUniforms.uAtmoMistRate || { value: 0.012 },
};

// Prepended to both water fragment shaders: declares the shared uniforms and the
// shared surface primitives (namespaced wc* so they never clash).
export const WATER_COMMON_GLSL = /* glsl */`
uniform float uTime, uTide, uDay, uGlint, uFogNear, uFogFar;
uniform float uWaterWindStrength;
uniform vec2 uWaterWindDir, uWaterWindOffset;
uniform float uAtmoMist, uAtmoMistBase, uAtmoMistRate;
uniform vec3 uSunDir, uSunColor, uSkyHorizon, uSkyZenith, uFogColor, uAtmoMistCol;
// distance fog + valley mist in one step (matches the terrain atmosphere pass)
vec3 wcApplyAir(vec3 col, vec3 wp, float dist){
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  if (uAtmoMist > 0.001) {
    float mh = exp(-max(wp.y - uAtmoMistBase, 0.0) * 0.06);
    float md = 1.0 - exp(-max(dist - 18.0, 0.0) * uAtmoMistRate);
    col = mix(col, uAtmoMistCol, clamp(uAtmoMist * mh * md, 0.0, 0.92));
  }
  return col;
}
float wcH21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float wcNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = wcH21(i), b = wcH21(i + vec2(1,0)), c = wcH21(i + vec2(0,1)), d = wcH21(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wcFbm(vec2 p){ return wcNoise(p) * 0.6 + wcNoise(p * 2.7) * 0.25 + wcNoise(p * 6.1) * 0.15; }
// Keep fine wavelets from turning into bright stripes at oblique angles.
float wcWave(float phase){
  float footprint = fwidth(phase);
  return sin(phase) * exp(-footprint * footprint * 0.28);
}
// Reset advection invisibly. Spatial phases stay in world coordinates even
// where a tributary turns, so neighbouring currents do not create seams.
float wcFlowTexture(vec2 p, vec2 velocity, float scale, float t){
  float phase = fract(t * 0.09), second = fract(phase + 0.5);
  return mix(wcNoise((p - velocity * phase) * scale),
    wcNoise((p - velocity * second) * scale), abs(phase * 2.0 - 1.0));
}
// THE open-water wave field: two drifting noise layers. The ocean uses it
// directly; the river converges to it with camera distance, so from afar both
// waters are the same surface by construction and deltas have no seam.
float wcOceanH(vec2 p, float t){
  float drift = dot(uWaterWindOffset, vec2(0.89, 0.46)) * 0.04 + t * 0.11;
  return wcWave(dot(p, vec2(0.89, 0.46)) * 0.22 - drift) * 0.36
    + wcWave(dot(p, vec2(-0.38, 0.925)) * 0.55 - drift * 1.37) * 0.19
    + wcNoise(p * 0.045 - vec2(t * 0.005, 0.0)) * 0.14;
}
// the matching surface normal and colour/alpha assembly (identical maths to
// the ocean shader's own): depthCol drives the palette, depthAlpha the body
vec3 wcOceanNormal(vec2 p, float t){
  vec2 a = vec2(0.89, 0.46), b = vec2(-0.38, 0.925);
  float drift = dot(uWaterWindOffset, a) * 0.04 + t * 0.11;
  float phaseA = dot(p, a) * 0.22 - drift, phaseB = dot(p, b) * 0.55 - drift * 1.37;
  float fa = fwidth(phaseA), fb = fwidth(phaseB);
  vec2 slope = a * cos(phaseA) * 0.0792 * exp(-fa * fa * 0.28)
    + b * cos(phaseB) * 0.1045 * exp(-fb * fb * 0.28);
  float bump = mix(0.30, 0.70, uWaterWindStrength);
  return normalize(vec3(-slope.x * bump, 1.0, -slope.y * bump));
}
float wcDayLight(){ return 0.06 + 0.94 * uDay; }
// unified depth palette (depth01: 0 = shallow shore, 1 = deep)
vec3 wcPalette(float depth01, float extraDeep){
  float dl = wcDayLight();
  float depth = max(depth01, extraDeep);
  float tone = smoothstep(0.04, 0.26, depth) * 0.35 + smoothstep(0.42, 0.85, depth) * 0.65;
  return mix(vec3(0.17, 0.34, 0.31) * dl, vec3(0.055, 0.175, 0.20) * dl, tone);
}
// Fresh water shares the coastal blue-green family. Sediment adds warm tea
// shallows, with gradual absorption rather than a saturated perimeter ring.
vec3 wcFreshPalette(float depth, float turbidity){
  float absorb = 1.0 - exp(-max(depth, 0.0) * mix(0.30, 0.72, turbidity));
  vec3 shallow = mix(vec3(0.115, 0.34, 0.285), vec3(0.24, 0.285, 0.155), turbidity);
  vec3 deep = mix(vec3(0.028, 0.16, 0.17), vec3(0.075, 0.155, 0.10), turbidity);
  float tone = smoothstep(0.05, 0.55, absorb) * 0.65 + smoothstep(0.55, 0.95, absorb) * 0.35;
  return mix(shallow, deep, tone) * wcDayLight();
}
float wcCaustics(vec2 p, float t, float depth){
  float a = wcNoise(p * 4.4 + vec2(t * 0.12, -t * 0.09));
  float b = wcNoise(p * 8.1 - vec2(t * 0.14, t * 0.07));
  float web = 1.0 - abs(a - b) * 2.4;
  return smoothstep(0.78, 0.98, web) * (1.0 - smoothstep(0.2, 1.0, depth))
    * smoothstep(0.02, 0.16, depth) * uDay;
}
// sky reflected in the surface normal
vec3 wcSkyReflect(vec3 N, vec3 V){
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(R.y * 1.7, 0.0, 1.0));
  vec2 cloudUV = R.xz / max(0.18, abs(R.y) + 0.18);
  float clouds = smoothstep(0.48, 0.77, wcFbm(cloudUV * 1.8 + vec2(uTime * 0.002, 5.0)));
  return mix(sky, uSkyHorizon * 1.08, clouds * 0.30 * uDay * smoothstep(0.03, 0.4, R.y));
}
// specular response: a tight glint plus a broad sheen. uSunDir/uSunColor carry
// the SUN by day and the MOON by night (uGlint scales for phase), so a full
// moon lays a silver road across the sea.
vec3 wcGlint(vec3 N, vec3 V){
  vec3 Hh = normalize(V + uSunDir);
  float d = max(dot(N, Hh), 0.0);
  float filtering = 1.0 / (1.0 + dot(fwidth(N), fwidth(N)) * 180.0);
  // Broad, restrained painted highlights read with the landscape's cel shading.
  float glint = smoothstep(0.985, 0.998, d) * 0.25 * filtering + smoothstep(0.88, 0.985, d) * 0.075;
  return uSunColor * glint * uGlint;
}
float wcFresnel(vec3 N, vec3 V){ return 0.06 + 0.94 * pow(1.0 - max(dot(V, N), 0.0), 4.0); }
`;

// One update per frame drives every water surface.
export function updateWaterCommon(dt, sky, fog, weather) {
  const u = waterUniforms;
  u.uTime.value += dt;
  u.uTide.value = TIDE_AMP * Math.sin(u.uTime.value * (2 * Math.PI / TIDE_PERIOD));
  const day = u.uDay.value = THREE.MathUtils.smoothstep(sky.sunElevation, -0.04, 0.12);
  // by night the MOON takes over the specular slot — a silver glint road on the
  // water, brightest at full moon; uGlint keeps the palette's uDay untouched.
  const moonIllum = sky.moonIllum || 0;
  if (day < 0.3 && sky.moonDir) {
    u.uSunDir.value.copy(sky.moonDir);
    u.uSunColor.value.setRGB(0.62, 0.72, 0.92).multiplyScalar(0.35 + 0.65 * moonIllum);
  } else {
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunColor.value.copy(sky.sun.color).multiplyScalar(Math.min(sky.sun.intensity / 3.1, 1));
  }
  u.uGlint.value = Math.max(day, (1 - day) * moonIllum * 0.75);
  u.uSkyHorizon.value.copy(fog.color);
  u.uSkyZenith.value.setRGB(0.02 + 0.22 * day, 0.03 + 0.42 * day, 0.06 + 0.7 * day);
  // Dense weather replaces the clear blue reflection with the same neutral
  // grey carried by the fog/cloud ceiling; storm water must not stay tropical.
  _weatherSky.copy(fog.color).multiplyScalar(0.72 + day * 0.18);
  u.uSkyZenith.value.lerp(_weatherSky, (weather?.cloudShade ?? 0) * day * 0.85);
  u.uFogColor.value.copy(fog.color);
  u.uFogNear.value = fog.near;
  u.uFogFar.value = fog.far;
}
