// Atmosphere shader injection — three cheap, stackable effects applied to the
// world's lit materials via onBeforeCompile, all driven by one shared set of
// uniforms (one per-frame update covers every material):
//
//   1. Cloud shadows  — a low-frequency noise drifts across the world and
//      darkens the ground/foliage in soft moving patches.
//   2. Leaf back-light — when you look toward the sun through foliage/grass,
//      light scatters forward and the leaves glow (translucency).
//   3. Aerial haze    — distant surfaces desaturate toward a hazy blue with
//      distance, giving depth and scale (atmospheric perspective).
//
// Effects modify the LINEAR lit colour right after <opaque_fragment>, before
// tonemapping, so they compose correctly with the rest of the pipeline.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const u = {
  uAtmoTime:   { value: 0 },
  uAtmoSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uAtmoSunCol: { value: new THREE.Color(1, 1, 1) },
  uAtmoDay:    { value: 1 },
  uAtmoAerial: { value: new THREE.Color(0.30, 0.43, 0.62) },
  uAtmoCloudCover:  { value: 0.4 },
  uAtmoCloudShadow: { value: 0.65 },
  // valley mist: height-falloff fog that pools in low ground on misty mornings
  uAtmoMist:     { value: 0 },                                // strength 0..1
  uAtmoMistBase: { value: 0 },                                // world y of the pool's heart
  uAtmoMistCol:  { value: new THREE.Color(0.85, 0.90, 0.97) },
  // cumulus-anchored shadows: (x, z, radius, strength) per billboard, projected
  // along the sun ray by sky.update — the big clouds cast the shade they should
  uAtmoCumulus:  { value: new Float32Array(4 * 12) },
};
// shared so custom materials (e.g. the GPU grass field) can light to match
export const atmoUniforms = u;

// uniquely-named noise so it never clashes with a material's own injected noise
const ATMO_GLSL = /* glsl */`
uniform float uAtmoTime;
uniform float uAtmoDay;
uniform float uAtmoCloudCover, uAtmoCloudShadow;
uniform float uAtmoMist, uAtmoMistBase;
uniform vec2 uWindOffset;
uniform vec3 uAtmoSunDir;
uniform vec3 uAtmoSunCol;
uniform vec3 uAtmoAerial;
uniform vec3 uAtmoMistCol;
uniform vec4 uAtmoCumulus[12];
varying vec3 vAtmoWP;
float aCloudHash(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
float aCloudNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = aCloudHash(i), b = aCloudHash(i + vec2(1,0)), c = aCloudHash(i + vec2(0,1)), d = aCloudHash(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float aCloudFbm(vec2 p){ return aCloudNoise(p) * 0.65 + aCloudNoise(p * 2.7) * 0.35; }
`;

// Add the effects to a material. opts: { clouds, aerial, backlight }.
export function injectAtmosphere(material, opts = {}) {
  const { clouds = true, aerial = true, backlight = false } = opts;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer); // keep the material's own shader work

    shader.uniforms.uAtmoTime = u.uAtmoTime;
    shader.uniforms.uAtmoSunDir = u.uAtmoSunDir;
    shader.uniforms.uAtmoSunCol = u.uAtmoSunCol;
    shader.uniforms.uAtmoDay = u.uAtmoDay;
    shader.uniforms.uAtmoAerial = u.uAtmoAerial;
    shader.uniforms.uAtmoCloudCover = u.uAtmoCloudCover;
    shader.uniforms.uAtmoCloudShadow = u.uAtmoCloudShadow;
    shader.uniforms.uAtmoMist = u.uAtmoMist;
    shader.uniforms.uAtmoMistBase = u.uAtmoMistBase;
    shader.uniforms.uAtmoMistCol = u.uAtmoMistCol;
    shader.uniforms.uAtmoCumulus = u.uAtmoCumulus;
    shader.uniforms.uWindOffset = windUniforms.uWindOffset;

    // capture world position (instancing-aware) after project_vertex
    shader.vertexShader = 'varying vec3 vAtmoWP;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        vec4 _awp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          _awp = instanceMatrix * _awp;
        #endif
        vAtmoWP = (modelMatrix * _awp).xyz;
      }`
    );

    let fx = '';
    if (clouds) fx += `
      {
        // Low cloud shadows travel at the visible flat layer's 70% wind rate.
        vec2 _cp = (vAtmoWP.xz - uWindOffset * 0.70) * 0.0016;
        float _threshold = mix(0.70, 0.38, uAtmoCloudCover);
        float _mask = smoothstep(_threshold - 0.08, _threshold + 0.08, aCloudFbm(_cp));
        // the big cumulus cast ANCHORED shadows: soft discs projected from the
        // actual billboards along the sun ray (published by sky.update)
        float _cum = 0.0;
        for (int _ci = 0; _ci < 12; _ci++) {
          vec4 _cd = uAtmoCumulus[_ci];
          if (_cd.w < 0.02) continue;
          _cum = max(_cum, _cd.w * smoothstep(_cd.z, _cd.z * 0.35, distance(vAtmoWP.xz, _cd.xy)));
        }
        float _shade = max(_mask * (0.40 * uAtmoCloudShadow), _cum * 0.42);
        gl_FragColor.rgb *= 1.0 - _shade * uAtmoDay;
      }`;
    if (backlight) fx += `
      {
        vec3 _Vw = normalize(cameraPosition - vAtmoWP);
        float _bk = pow(max(dot(-_Vw, uAtmoSunDir), 0.0), 3.0);
        gl_FragColor.rgb += uAtmoSunCol * gl_FragColor.rgb * (_bk * 0.6 * uAtmoDay);
      }`;
    if (aerial) fx += `
      {
        float _d = length(cameraPosition - vAtmoWP);
        float _a = (1.0 - exp(-max(_d - 300.0, 0.0) * 0.00030)) * 0.55 * uAtmoDay;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uAtmoAerial, clamp(_a, 0.0, 0.55));
        // valley mist: pools below uAtmoMistBase (height falloff) and needs a
        // little distance to accumulate, so the ground at your feet stays clear
        // while hollows and far meadows drown in it. Peaks float above.
        if (uAtmoMist > 0.001) {
          float _mh = exp(-max(vAtmoWP.y - uAtmoMistBase, 0.0) * 0.06);
          float _md = 1.0 - exp(-max(_d - 18.0, 0.0) * 0.012);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uAtmoMistCol, clamp(uAtmoMist * _mh * _md, 0.0, 0.92));
        }
      }`;

    shader.fragmentShader = ATMO_GLSL + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n' + fx
    );
  };
  material.needsUpdate = true;
}

export function updateAtmosphere(dt, sky, fog, weather, groundY = 0, shelter = 0) {
  u.uAtmoTime.value += dt;
  const outdoor = 1 - THREE.MathUtils.clamp(shelter, 0, 1);
  const solarDay = THREE.MathUtils.smoothstep(sky.sunElevation, -0.04, 0.12);
  const day = u.uAtmoDay.value = solarDay * outdoor;
  u.uAtmoCloudCover.value = weather?.cloudCover ?? sky.day.cloudCover;
  u.uAtmoCloudShadow.value = (weather?.cloudShadow ?? 0.65) * outdoor;
  u.uAtmoSunDir.value.copy(sky.sunDir);
  u.uAtmoSunCol.value.copy(sky.sun.color).multiplyScalar(Math.min(sky.sun.intensity / 3.1, 1));
  // hazy blue that follows the horizon/fog and fades to near-black at night
  u.uAtmoAerial.value.setRGB(0.40, 0.50, 0.66).multiplyScalar(0.25 + 0.75 * day).lerp(fog.color, 0.35);
  // valley mist: the weather timeline decides WHEN (misty dawns, humid days);
  // the pool tops out near the player's ground in the lowlands but is capped in
  // altitude, so it reads as a lowland phenomenon — mountains rise clear of it.
  u.uAtmoMist.value = (weather?.mist ?? 0) * 0.85 * outdoor;
  u.uAtmoMistBase.value = Math.min(groundY + 3, 34);
  if (sky.cumulusShadows) u.uAtmoCumulus.value.set(sky.cumulusShadows);
  // luminous by day (sunlit vapour), moon-grey by night
  u.uAtmoMistCol.value.setRGB(0.42 + 0.46 * day, 0.47 + 0.45 * day, 0.56 + 0.42 * day).lerp(fog.color, 0.25);
}
