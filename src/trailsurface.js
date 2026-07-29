// Phase 4 trail presentation. Geometry is generated in workers by chunkgen;
// this shared material turns its RGBA biome-aware pigment into a softly
// blended, painterly path without relying on the terrain vertex grid.

import * as THREE from 'three';
import { injectAtmosphere } from './atmosphere.js';
import { groundDetailUniforms } from './grounddetail.js';
import { registerXRMaterialVariant } from './xrmaterialvariants.mjs?v=2';

export const trailSurfaceUniforms = {
  visibility: { value: 1.0 },
  detail: { value: 0.72 },
};

export const trailSurfaceMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.98,
  metalness: 0,
  transparent: true,
  depthWrite: false,
  alphaTest: 0.01,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

trailSurfaceMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTrailVisibility = trailSurfaceUniforms.visibility;
  shader.uniforms.uTrailDetail = trailSurfaceUniforms.detail;
  shader.uniforms.uGroundDetail = groundDetailUniforms.strength;
  shader.vertexShader = 'varying vec3 vTrailWP;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
    vTrailWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`
  );
  shader.fragmentShader = `
    varying vec3 vTrailWP;
    uniform float uTrailVisibility;
    uniform float uTrailDetail;
    uniform float uGroundDetail;
    float trailHash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float trailNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = trailHash(i), b = trailHash(i + vec2(1.0, 0.0));
      float c = trailHash(i + vec2(0.0, 1.0)), d = trailHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
  ` + shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
    {
      // Long, low-contrast pigment strokes follow no screen axis, so they stay
      // anchored while walking. Fine grain supplies dry soil/gravel tooth but
      // never becomes a dark contour or marbled boundary.
      vec2 q = mat2(0.82, -0.57, 0.57, 0.82) * vTrailWP.xz;
      float stroke = trailNoise(vec2(q.x * 0.075, q.y * 0.24)) - 0.5;
      float grain = trailNoise(vTrailWP.xz * 0.92 + 17.0) - 0.5;
      float detail = uTrailDetail * uGroundDetail;
      diffuseColor.rgb *= 1.0 + stroke * 0.105 * detail + grain * 0.045 * detail;
      diffuseColor.rgb = mix(diffuseColor.rgb,
        diffuseColor.rgb * vec3(1.025, 1.012, 0.975),
        (stroke + 0.5) * 0.055 * detail);
      diffuseColor.a *= uTrailVisibility;
    }`
  );
  trailSurfaceMaterial.userData.shader = shader;
};

trailSurfaceMaterial.customProgramCacheKey = () => 'wander-trail-surface-v2';
trailSurfaceMaterial.userData.excludeFromAO = true;
injectAtmosphere(trailSurfaceMaterial, { clouds: true, aerial: true });

// The headset path retains the trail's authored vertex pigment and alpha but
// uses Lambert lighting. Its two procedural brush samples run once per ribbon
// vertex and interpolate across the small trail triangles instead of running
// independently for every eye pixel.
export const xrTrailSurfaceMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  alphaTest: 0.01,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
  fog: true,
});
xrTrailSurfaceMaterial.name = 'xr-trail-surface';
xrTrailSurfaceMaterial.userData.excludeFromAO = true;
xrTrailSurfaceMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTrailVisibility = trailSurfaceUniforms.visibility;
  shader.uniforms.uTrailDetail = trailSurfaceUniforms.detail;
  shader.uniforms.uGroundDetail = groundDetailUniforms.strength;
  shader.vertexShader = `
varying float vXRTrailWash;
float xrTrailHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float xrTrailNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = xrTrailHash(i), b = xrTrailHash(i + vec2(1.0, 0.0));
  float c = xrTrailHash(i + vec2(0.0, 1.0)), d = xrTrailHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
` + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
     vec3 _xrTrailWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
     vec2 _xrTrailQ = mat2(0.82, -0.57, 0.57, 0.82) * _xrTrailWP.xz;
     float _xrTrailStroke = xrTrailNoise(vec2(_xrTrailQ.x * 0.075, _xrTrailQ.y * 0.24)) - 0.5;
     float _xrTrailGrain = xrTrailNoise(_xrTrailWP.xz * 0.92 + 17.0) - 0.5;
     vXRTrailWash = _xrTrailStroke * 0.105 + _xrTrailGrain * 0.045;`,
  );
  shader.fragmentShader = `
varying float vXRTrailWash;
uniform float uTrailVisibility;
uniform float uTrailDetail;
uniform float uGroundDetail;
` + shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
     float _xrTrailAmount = uTrailDetail * uGroundDetail;
     diffuseColor.rgb *= 1.0 + vXRTrailWash * _xrTrailAmount;
     diffuseColor.a *= uTrailVisibility;`,
  );
  xrTrailSurfaceMaterial.userData.shader = shader;
};
xrTrailSurfaceMaterial.customProgramCacheKey = () => 'wander-xr-trail-surface-v1';
injectAtmosphere(xrTrailSurfaceMaterial, { clouds: true, aerial: true });
registerXRMaterialVariant(trailSurfaceMaterial, xrTrailSurfaceMaterial);
