// Shared cloud-shadow cache. The old atmosphere path evaluated its cloud FBM
// and twelve projected cumulus discs in every terrain/foliage fragment. This
// small world-space target evaluates that field once at 8 Hz; all outdoor
// materials then pay one filtered texture lookup. Between refreshes the map is
// translated by the live wind offset, so the broad shadow fronts keep moving
// smoothly rather than advancing in eighth-second steps.

import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';
import { renderOffscreen } from './offscreenrender.mjs';
import { windUniforms } from './wind.js';

const MAP_SIZE = 256;
const COVERAGE = 18000;
const UPDATE_INTERVAL = 1 / 8;
const ANCHOR_STEP = 128;

const VERT = /* glsl */`
varying vec2 vUvCache;
void main() {
  vUvCache = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform vec2 uCenter;
uniform vec2 uRenderWind;
uniform float uCoverage;
uniform float uCloudCover;
uniform float uCloudShadow;
uniform vec4 uCumulus[12];
varying vec2 vUvCache;

float cscHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float cscNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = cscHash(i);
  float b = cscHash(i + vec2(1.0, 0.0));
  float c = cscHash(i + vec2(0.0, 1.0));
  float d = cscHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float cscFbm(vec2 p) {
  return cscNoise(p) * 0.65 + cscNoise(p * 2.7) * 0.35;
}

void main() {
  vec2 worldXZ = uCenter + (vUvCache - 0.5) * uCoverage;
  vec2 cp = (worldXZ - uRenderWind * 0.70) * 0.0016;
  float threshold = mix(0.70, 0.38, uCloudCover);
  float mask = smoothstep(threshold - 0.08, threshold + 0.08, cscFbm(cp));
  float cumulus = 0.0;
  for (int i = 0; i < 12; i++) {
    vec4 cloud = uCumulus[i];
    if (cloud.w < 0.02) continue;
    cumulus = max(cumulus,
      cloud.w * smoothstep(cloud.z, cloud.z * 0.35, distance(worldXZ, cloud.xy)));
  }
  float shade = max(mask * (0.40 * uCloudShadow), cumulus * 0.42);
  gl_FragColor = vec4(vec3(shade), 1.0);
}`;

export class CloudShadowCache {
  constructor() {
    this.target = new THREE.WebGLRenderTarget(MAP_SIZE, MAP_SIZE, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.target.texture.name = 'wander-cloud-shadow-cache';

    this.center = new THREE.Vector2();
    this.renderWind = new THREE.Vector2();
    this.elapsed = Infinity;
    this.ready = false;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCenter: { value: this.center },
        uRenderWind: { value: this.renderWind },
        uCoverage: { value: COVERAGE },
        uCloudCover: atmoUniforms.uAtmoCloudCover,
        uCloudShadow: atmoUniforms.uAtmoCloudShadow,
        uCumulus: atmoUniforms.uAtmoCumulus,
      },
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    atmoUniforms.uAtmoCloudMap.value = this.target.texture;
    atmoUniforms.uAtmoCloudMapCenter.value.copy(this.center);
    atmoUniforms.uAtmoCloudMapCoverage.value = COVERAGE;
  }

  update(renderer, playerPos, dt = 0, force = false) {
    const currentWind = windUniforms.uWindOffset.value;
    // The low cloud layer travels at 70% of the shared wind offset (matching
    // the source field in FRAG), so compensate by that same amount while the
    // cached image waits for its next refresh.
    atmoUniforms.uAtmoCloudMapScroll.value.copy(currentWind).sub(this.renderWind).multiplyScalar(0.70);

    this.elapsed += dt;
    if (!atmoUniforms.uAtmoCloudCacheEnabled.value) return false;
    if (!force && this.ready && this.elapsed < UPDATE_INTERVAL) return false;

    this.elapsed = 0;
    this.center.set(
      Math.round(playerPos.x / ANCHOR_STEP) * ANCHOR_STEP,
      Math.round(playerPos.z / ANCHOR_STEP) * ANCHOR_STEP,
    );
    this.renderWind.copy(currentWind);

    renderOffscreen(renderer, this.target, this.scene, this.camera);

    atmoUniforms.uAtmoCloudMapCenter.value.copy(this.center);
    atmoUniforms.uAtmoCloudMapScroll.value.set(0, 0);
    this.ready = true;
    return true;
  }

  dispose() {
    this.quad.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
  }
}
