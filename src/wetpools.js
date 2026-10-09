// Still pools in wet woodland — the render side of wetwoodland.mjs.
//
// One instanced disc per pool, one InstancedMesh per chunk. The water is the
// world's own: the shared palette, sky reflection, glint and air from
// watercommon, and the lake reflection capture when it is pointed at the
// pools nearby (waterreflection.js), so the alders stand upside down in them.
// Peat water is dark and almost still: what you see is mostly reflection,
// with a faint skin of ripple, and the edge is broken by noise and dissolves
// into the wet ground rather than ending on the disc.

import * as THREE from 'three';
import { waterUniforms, WATER_COMMON_GLSL } from './watercommon.js';

const VERT = /* glsl */`
attribute float aSeed;
varying vec3 vWP;
varying vec2 vLocal;
varying float vSeed;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vLocal = position.xz;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = WATER_COMMON_GLSL + /* glsl */`
uniform sampler2D uLakeReflectionMap;
uniform mat4 uLakeReflectionMatrix;
uniform vec4 uLakeReflectionBounds;
uniform float uLakeReflectionLevel, uLakeReflectionReady;
varying vec3 vWP;
varying vec2 vLocal;
varying float vSeed;

void main() {
  // An irregular shoreline: the disc's radius wanders with the angle.
  float d = length(vLocal);
  vec2 dir = d > 1e-4 ? vLocal / d : vec2(1.0, 0.0);
  float shore = 0.86 + 0.16 * (wcNoise(dir * 1.6 + vSeed * 37.0) - 0.5)
    + 0.08 * (wcNoise(dir * 4.3 + vSeed * 11.0) - 0.5);
  float alpha = 1.0 - smoothstep(shore - 0.2, shore, d);
  if (alpha < 0.01) discard;

  vec3 V = normalize(cameraPosition - vWP);
  // Almost still: a faint skin of wind ripple, slow and fine.
  vec2 p = vWP.xz;
  float t = uTime;
  float e = 0.15;
  float h0 = wcNoise(p * 1.7 + vec2(t * 0.05, -t * 0.03));
  float hx = wcNoise((p + vec2(e, 0.0)) * 1.7 + vec2(t * 0.05, -t * 0.03));
  float hz = wcNoise((p + vec2(0.0, e)) * 1.7 + vec2(t * 0.05, -t * 0.03));
  vec3 N = normalize(vec3(-(hx - h0) / e * 0.025, 1.0, -(hz - h0) / e * 0.025));

  float dl = wcDayLight();
  // Peat water: tea-dark in the middle, the brown of the bed at the margin.
  vec3 deep = vec3(0.020, 0.032, 0.022) * dl;
  vec3 margin = vec3(0.075, 0.072, 0.040) * dl;
  vec3 waterCol = mix(deep, margin, smoothstep(0.35, 0.95, d / shore));

  vec3 reflected = wcSkyReflect(N, V);
  if (uLakeReflectionReady > 0.5 && abs(vWP.y - uLakeReflectionLevel) < 0.45
    && p.x > uLakeReflectionBounds.x && p.y > uLakeReflectionBounds.y
    && p.x < uLakeReflectionBounds.z && p.y < uLakeReflectionBounds.w) {
    vec4 projected = uLakeReflectionMatrix * vec4(vWP.x, uLakeReflectionLevel, vWP.z, 1.0);
    vec2 uv = projected.xy / max(projected.w, 0.001) + N.xz * 0.012;
    float edge = smoothstep(0.0, 0.035, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    reflected = mix(reflected, texture2D(uLakeReflectionMap, clamp(uv, 0.001, 0.999)).rgb, edge);
  }
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
  // Dark still water is a mirror, but a dark one: the peat takes a share of
  // everything it reflects, so even a white sky comes back dimmed and warm.
  reflected *= vec3(0.62, 0.64, 0.58);
  vec3 col = mix(waterCol, reflected, clamp(0.3 + fres * 0.6, 0.0, 0.9));
  col += wcGlint(N, V) * 0.5;
  // The rim reads as wet ground meeting water, not the edge of a disc.
  alpha *= mix(0.55, 1.0, smoothstep(0.55, 0.85, 1.0 - d / shore + 0.4));

  float dist = length(cameraPosition - vWP);
  gl_FragColor = vec4(wcApplyAir(col, vWP, dist), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const wetPoolMaterial = new THREE.ShaderMaterial({
  vertexShader: VERT,
  fragmentShader: FRAG,
  uniforms: { ...waterUniforms },
  transparent: true,
  depthWrite: false,
  // The pool lies centimetres above its bed; hold it in front of the ground
  // it grazes at the shore instead of letting the two flicker.
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -2,
});
wetPoolMaterial.userData.excludeFromAO = true;
wetPoolMaterial.userData.waterSurface = true;

let poolGeometry = null;
function getPoolGeometry() {
  if (poolGeometry) return poolGeometry;
  poolGeometry = new THREE.CircleGeometry(1, 40);
  poolGeometry.rotateX(-Math.PI / 2);
  return poolGeometry;
}

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * A chunk's pools as one InstancedMesh. `data` is the worker's flat array:
 * [x, y, z, radius, yaw, seed] per pool.
 */
export function buildWetPoolMesh(data) {
  const count = Math.floor(data.length / 6);
  const geometry = getPoolGeometry().clone();
  const seeds = new Float32Array(count);
  const mesh = new THREE.InstancedMesh(geometry, wetPoolMaterial, count);
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    _position.set(data[o], data[o + 1], data[o + 2]);
    _quaternion.setFromAxisAngle(_up, data[o + 4]);
    _scale.set(data[o + 3], 1, data[o + 3]);
    mesh.setMatrixAt(i, _matrix.compose(_position, _quaternion, _scale));
    seeds[i] = data[o + 5];
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'wet-pools';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3;
  mesh.userData.reflectionRange = 0;
  mesh.computeBoundingSphere();
  return mesh;
}
