// Shared water "look". The ocean (water.js) and the river ribbons (river.js)
// compose their shaders from these primitives — one palette, one sky reflection,
// one sun glint, one fresnel, one noise, and ONE set of lighting/fog uniforms —
// so the two are the SAME water by construction and blend seamlessly where they
// meet at deltas. Each mesh keeps its own wave field + foam (the ocean is
// omnidirectional; rivers flow downstream), but every surface-look decision
// lives here, so a tweak lands on both at once.

import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';

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
  uTime:       { value: 0 },
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
};

// Prepended to both water fragment shaders: declares the shared uniforms and the
// shared surface primitives (namespaced wc* so they never clash).
export const WATER_COMMON_GLSL = /* glsl */`
uniform float uTime, uTide, uDay, uGlint, uFogNear, uFogFar;
uniform float uAtmoMist, uAtmoMistBase;
uniform vec3 uSunDir, uSunColor, uSkyHorizon, uSkyZenith, uFogColor, uAtmoMistCol;
// distance fog + valley mist in one step (matches the terrain atmosphere pass)
vec3 wcApplyAir(vec3 col, vec3 wp, float dist){
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  if (uAtmoMist > 0.001) {
    float mh = exp(-max(wp.y - uAtmoMistBase, 0.0) * 0.06);
    float md = 1.0 - exp(-max(dist - 18.0, 0.0) * 0.012);
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
// THE open-water wave field: two drifting noise layers. The ocean uses it
// directly; the river converges to it with camera distance, so from afar both
// waters are the same surface by construction and deltas have no seam.
float wcOceanH(vec2 p, float t){
  return wcFbm(p * 0.18 + vec2(t * 0.060, t * 0.022)) * 0.6
       + wcFbm(p * 0.55 - vec2(t * 0.035, t * 0.050)) * 0.4;
}
// the matching surface normal and colour/alpha assembly (identical maths to
// the ocean shader's own): depthCol drives the palette, depthAlpha the body
vec3 wcOceanNormal(vec2 p, float t){
  float e = 0.3;
  float h0 = wcOceanH(p, t);
  return normalize(vec3(
    -(wcOceanH(p + vec2(e, 0.0), t) - h0) / e * 0.35,
    1.0,
    -(wcOceanH(p + vec2(0.0, e), t) - h0) / e * 0.35
  ));
}
float wcDayLight(){ return 0.06 + 0.94 * uDay; }
// unified depth palette (depth01: 0 = shallow shore, 1 = deep)
vec3 wcPalette(float depth01, float extraDeep){
  float dl = wcDayLight();
  return mix(vec3(0.17, 0.34, 0.31) * dl, vec3(0.055, 0.175, 0.20) * dl, max(depth01, extraDeep));
}
// sky reflected in the surface normal
vec3 wcSkyReflect(vec3 N, vec3 V){
  vec3 R = reflect(-V, N);
  return mix(uSkyHorizon, uSkyZenith, clamp(R.y * 1.7, 0.0, 1.0));
}
// specular response: a tight glint plus a broad sheen. uSunDir/uSunColor carry
// the SUN by day and the MOON by night (uGlint scales for phase), so a full
// moon lays a silver road across the sea.
vec3 wcGlint(vec3 N, vec3 V){
  vec3 Hh = normalize(V + uSunDir);
  float d = max(dot(N, Hh), 0.0);
  return uSunColor * (pow(d, 230.0) * 1.5 + pow(d, 40.0) * 0.07) * uGlint;
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
