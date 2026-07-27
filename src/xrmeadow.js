// XR-only meadow renderer. Two world-fixed instanced layers reuse GrassField's
// cached terrain data: true blades nearby for stereo depth, and broad crossed
// tufts through the middle distance. Beyond them, xrterrain.js carries wind as
// animated ground pigment instead of geometry.

import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';
import { caveEntranceUniforms, CAVE_EXCLUSION_GLSL } from './cavevisual.js';
import { windUniforms, WIND_GLSL_DECLS } from './wind.js';
import {
  XR_GRASS_OUTER_FADE_METERS,
  scaledXRGrassDimensions,
} from './xrgrassquality.mjs';

const MAX_NEAR = 12000;
const MAX_MID = 48000;

const VERTEX_SHADER = /* glsl */`
uniform sampler2D uHTex;
uniform sampler2D uCTex;
uniform sampler2D uTrailTex;
uniform vec2 uAnchor;
uniform float uFieldCover;
uniform float uLayerCover;
uniform float uMinDistance;
uniform float uMaxDistance;
uniform float uDensityBoost;
uniform float uHeightScale;
uniform float uWidthScale;
uniform float uSeedOffset;
uniform vec3 uCam;
uniform float uTime;
${WIND_GLSL_DECLS}
${CAVE_EXCLUSION_GLSL}

varying vec3 vXRGrassGround;
varying vec3 vXRGrassWorld;
varying float vXRGrassHeight;
varying float vXRGrassMacro;
varying float vXRGrassGust;

uint xrGrassHash(uint state) {
  state = state * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float xrGrassRandom(uint state) {
  return float(xrGrassHash(state)) * (1.0 / 4294967296.0);
}
vec4 xrGrassField(sampler2D fieldTexture, vec2 uv) {
  ivec2 dimensions = textureSize(fieldTexture, 0);
  vec2 texelPosition = clamp(uv, 0.0, 1.0) * vec2(dimensions - ivec2(1));
  ivec2 lower = ivec2(floor(texelPosition));
  ivec2 upper = min(lower + ivec2(1), dimensions - ivec2(1));
  vec2 blend = fract(texelPosition);
  vec4 row0 = mix(
    texelFetch(fieldTexture, ivec2(lower.x, lower.y), 0),
    texelFetch(fieldTexture, ivec2(upper.x, lower.y), 0), blend.x);
  vec4 row1 = mix(
    texelFetch(fieldTexture, ivec2(lower.x, upper.y), 0),
    texelFetch(fieldTexture, ivec2(upper.x, upper.y), 0), blend.x);
  return mix(row0, row1, blend.y);
}

void main() {
  uint instanceId = uint(gl_InstanceID) + uint(uSeedOffset);
  vec2 seed = vec2(
    xrGrassRandom(instanceId * 2u + 0x68bc21ebu),
    xrGrassRandom(instanceId * 2u + 0x02e5be93u)
  ) * uLayerCover;
  // A periodic world lattice keeps every tuft fixed underfoot. Only the copy
  // nearest the viewer is rendered, and it is already scaled away before wrap.
  vec2 base = seed + uLayerCover * floor((uCam.xz - seed) / uLayerCover + 0.5);
  float distanceToCamera = distance(base, uCam.xz);
  float distanceMask = smoothstep(uMinDistance - 2.0, uMinDistance + 1.0, distanceToCamera)
                     * (1.0 - smoothstep(uMaxDistance - ${XR_GRASS_OUTER_FADE_METERS.toFixed(1)}, uMaxDistance, distanceToCamera));

  vec2 fieldUv = clamp((base - uAnchor) / uFieldCover, 0.0, 1.0);
  vec4 field = xrGrassField(uHTex, fieldUv);
  float trailMask = texture(uTrailTex, fieldUv).r;
  // Density decides a world-fixed binary occupancy. It must not scale blades
  // as the viewer moves; only the narrow radial perimeter may shrink them.
  float habitatKeep = clamp(field.g * uDensityBoost, 0.0, 1.0);
  float threshold = xrGrassRandom(instanceId * 3u + 0xa511e9b3u);
  float occupancy = step(threshold, habitatKeep);
  float trailOccupancy = step(0.5, trailMask);
  float caveOccupancy = 1.0 - step(0.5, caveEntranceMask(base));
  float presence = occupancy * trailOccupancy * caveOccupancy * distanceMask;

  float randomHeight = mix(0.72, 1.28,
    xrGrassRandom(instanceId * 5u + 0x63d83595u));
  float height = randomHeight * uHeightScale * max(field.b, 0.08)
               * mix(0.94, 1.09, field.a) * presence;
  float width = uWidthScale * mix(0.76, 1.26,
    xrGrassRandom(instanceId * 11u + 0x91e10da5u)) * presence;

  vec3 local = vec3(position.x * width, position.y * height, position.z * width);
  float yaw = xrGrassRandom(instanceId * 7u + 0xb8f3a789u) * 6.2831853;
  local.xz = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw)) * local.xz;

  vec2 gustCell = (floor(base / 8.0) + 0.5) * 8.0;
  float phase = gustCell.x * 1.71 + gustCell.y * 2.13;
  float gust = windGust(gustCell);
  float gustAmplitude = 0.25 + 1.35 * gust * uWindStrength;
  float sway = (sin(uTime * 1.6 + phase)
              + sin(uTime * 2.7 + phase * 1.7) * 0.5) * 0.075;
  float weight = position.y * presence;
  local.x += (sway + uWindDir.x * gust * uWindStrength * 0.72)
           * gustAmplitude * weight;
  local.z += (cos(uTime * 1.3 + phase) * 0.05
           + uWindDir.y * gust * uWindStrength * 0.72)
           * gustAmplitude * weight;

  vec3 worldPosition = vec3(base.x, field.r - 0.055, base.y) + local;
  vXRGrassGround = texture(uCTex, fieldUv).rgb;
  vXRGrassWorld = worldPosition;
  vXRGrassHeight = position.y;
  vXRGrassMacro = field.a;
  vXRGrassGust = gust * uWindStrength;
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
}`;

const FRAGMENT_SHADER = /* glsl */`
layout(location = 0) out highp vec4 outColor;
uniform vec3 uAtmoSunDir, uAtmoSunCol, uAtmoAerial, uAtmoMistCol;
uniform float uAtmoDay, uAtmoMist, uAtmoMistBase;
varying vec3 vXRGrassGround;
varying vec3 vXRGrassWorld;
varying float vXRGrassHeight;
varying float vXRGrassMacro;
varying float vXRGrassGust;
vec3 xrGrassGradient(vec3 ground, float height, float dryness) {
  float luma = dot(ground, vec3(0.299, 0.587, 0.114));
  vec3 lush = mix(ground * vec3(0.96, 1.10, 0.72),
    vec3(luma * 0.82, luma * 1.16, luma * 0.48), 0.38);
  vec3 dry = vec3(luma * 1.18, luma * 1.05, luma * 0.68);
  return mix(ground, mix(lush, dry, dryness * 0.58), smoothstep(0.0, 0.58, height));
}

void main() {
  vec3 blade = xrGrassGradient(vXRGrassGround, vXRGrassHeight, vXRGrassMacro);
  float viewDistance = length(cameraPosition - vXRGrassWorld);
  vec3 coolFill = mix(vec3(0.075, 0.10, 0.16), vec3(0.27, 0.34, 0.44), uAtmoDay);
  vec3 warmKey = uAtmoSunCol * (0.48 + max(uAtmoSunDir.y, 0.0) * 0.72);
  vec3 lit = blade * (coolFill + warmKey);
  lit *= 1.0 + vXRGrassGust * mix(0.13, 0.23, vXRGrassMacro) * uAtmoDay;
  float seedHead = smoothstep(0.72, 1.0, vXRGrassHeight)
                 * smoothstep(0.52, 0.88, vXRGrassMacro);
  lit = mix(lit, lit * vec3(1.18, 1.10, 0.82), seedHead * 0.32);

  float aerial = (1.0 - exp(-max(viewDistance - 80.0, 0.0) * 0.004)) * 0.32 * uAtmoDay;
  lit = mix(lit, uAtmoAerial, clamp(aerial, 0.0, 0.32));
  if (uAtmoMist > 0.001) {
    float mistHeight = exp(-max(vXRGrassWorld.y - uAtmoMistBase, 0.0) * 0.06);
    float mistDistance = 1.0 - exp(-max(viewDistance - 18.0, 0.0) * 0.012);
    lit = mix(lit, uAtmoMistCol,
      clamp(uAtmoMist * mistHeight * mistDistance, 0.0, 0.78));
  }
  outColor = vec4(lit, 1.0);
}`;

function makeNearBladeGeometry() {
  const geometry = new THREE.PlaneGeometry(0.13, 1, 1, 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const height = position.getY(i) + 0.5;
    position.setX(i, position.getX(i) * (1 - height * 0.86));
    position.setY(i, height);
  }
  return geometry;
}

function makeMidTuftGeometry() {
  const positions = new Float32Array([
    -0.24, 0, 0,  0.24, 0, 0,  0, 1, 0,
     0, 0, -0.24,  0, 0, 0.24,  0, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export class XRMeadow {
  constructor(scene, fieldResources) {
    this.scene = scene;
    this.active = false;
    this.profile = null;
    this.nearBudgetScale = 1;
    this.midBudgetScale = 1;

    this.commonUniforms = {
      uHTex: { value: fieldResources.heightTexture },
      uCTex: { value: fieldResources.colorTexture },
      uTrailTex: { value: fieldResources.trailTexture },
      uAnchor: { value: fieldResources.anchor },
      uFieldCover: { value: fieldResources.cover },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      ...windUniforms,
      ...caveEntranceUniforms,
      uAtmoSunDir: atmoUniforms.uAtmoSunDir,
      uAtmoSunCol: atmoUniforms.uAtmoSunCol,
      uAtmoAerial: atmoUniforms.uAtmoAerial,
      uAtmoDay: atmoUniforms.uAtmoDay,
      uAtmoMist: atmoUniforms.uAtmoMist,
      uAtmoMistBase: atmoUniforms.uAtmoMistBase,
      uAtmoMistCol: atmoUniforms.uAtmoMistCol,
    };

    this.near = this._makeLayer(makeNearBladeGeometry(), MAX_NEAR, {
      seed: 0, density: 0.80, height: 1.18, width: 1.0,
    });
    this.mid = this._makeLayer(makeMidTuftGeometry(), MAX_MID, {
      seed: 1000003, density: 1.0, height: 1.42, width: 1.05,
    });
    this.near.name = 'xr-meadow-near-blades';
    this.mid.name = 'xr-meadow-mid-tufts';
    scene.add(this.near, this.mid);
    this.debug = { coverage: 'inactive', shadows: 'disabled for clean grass' };
  }

  _makeLayer(geometry, capacity, settings) {
    const dimensions = scaledXRGrassDimensions(settings.height, settings.width);
    const uniforms = {
      ...this.commonUniforms,
      uLayerCover: { value: 40 },
      uMinDistance: { value: 0 },
      uMaxDistance: { value: 18 },
      uDensityBoost: { value: settings.density },
      uHeightScale: { value: dimensions.height },
      uWidthScale: { value: dimensions.width },
      uSeedOffset: { value: settings.seed },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      glslVersion: THREE.GLSL3,
    });
    material.userData.excludeFromAO = true;
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  setProfile(profile) {
    this.profile = profile;
    this.nearBudgetScale = 1;
    this.midBudgetScale = 1;
    this.near.material.uniforms.uLayerCover.value = (profile.nearGrassRadius + 3) * 2;
    // Start fully opaque at the viewer; the negative inner edge avoids the
    // generic annulus fade making an unintended bare disc around their feet.
    this.near.material.uniforms.uMinDistance.value = -3;
    this.near.material.uniforms.uMaxDistance.value = profile.nearGrassRadius;
    this.mid.material.uniforms.uLayerCover.value = (profile.midGrassRadius + 3) * 2;
    this.mid.material.uniforms.uMinDistance.value = Math.max(7, profile.nearGrassRadius - 5);
    this.mid.material.uniforms.uMaxDistance.value = profile.midGrassRadius;
    this._updateBudgetCounts();
    this._syncVisibility();
  }

  setBudgetScale(nearScale = 1, midScale = 1) {
    this.nearBudgetScale = THREE.MathUtils.clamp(nearScale, 0.5, 1);
    this.midBudgetScale = THREE.MathUtils.clamp(midScale, 0.25, 1);
    this._updateBudgetCounts();
    this._syncVisibility();
  }

  _updateBudgetCounts() {
    if (!this.profile) return;
    this.near.count = Math.min(MAX_NEAR,
      Math.round(this.profile.nearGrassCount * this.nearBudgetScale));
    this.mid.count = Math.min(MAX_MID,
      Math.round(this.profile.midGrassCount * this.midBudgetScale));
    this.debug.coverage = `${this.near.count.toLocaleString()} blades to ${this.profile.nearGrassRadius}m · ${this.mid.count.toLocaleString()} tufts to ${this.profile.midGrassRadius}m`;
  }

  setActive(active) {
    this.active = !!active;
    this._syncVisibility();
  }

  _syncVisibility() {
    const visible = this.active && !!this.profile;
    this.near.visible = visible && this.near.count > 0;
    this.mid.visible = visible && this.mid.count > 0;
  }

  update(dt, playerPosition) {
    if (!this.active) return;
    this.commonUniforms.uTime.value += dt;
    this.commonUniforms.uCam.value.copy(playerPosition);
  }

  dispose() {
    for (const mesh of [this.near, this.mid]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
