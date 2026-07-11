// Player-relative GPU rain. Every drop is a tiny camera-facing streak inside a
// wrapping volume around the walker, so rain remains dense overhead without
// spawning/despawning CPU particles. Slant comes directly from the shared wind
// uniforms used by grass, trees, clouds and cloud shadows.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const MAX_DROPS = 2400;
const TIER_COUNTS = Object.freeze({ potato: 550, low: 850, medium: 1300, high: 1850, ultra: 2400 });

const VERTEX = /* glsl */`
attribute vec3 aOrigin;
attribute float aPhase, aSpeed, aThreshold, aSize;
uniform float uTime, uIntensity, uDensityScale, uMotionScale, uFogNear, uFogFar;
uniform vec3 uCenter;
uniform vec2 uWindDir;
uniform float uWindStrength, uWindSpeed;
varying vec2 vDropUv;
varying float vAlpha, vFog;

float wrapRange(float v, float range) {
  return mod(v + range * 0.5, range) - range * 0.5;
}

void main() {
  float cycle = fract(aPhase + uTime * mix(0.34, 0.62, aSpeed));
  float fallY = mix(38.0, -7.0, cycle);
  float slant = 0.08 + uWindStrength * 0.58;
  vec3 fallDir = normalize(vec3(uWindDir.x * slant, -1.0, uWindDir.y * slant));

  // Drops accumulate downwind displacement as they fall, then wrap inside the
  // local field. Direction changes therefore bend the whole rain curtain.
  vec2 drift = uWindDir * uWindSpeed * uWindStrength * cycle * 1.45;
  vec2 localXZ = vec2(
    wrapRange(aOrigin.x + drift.x, 76.0),
    wrapRange(aOrigin.z + drift.y, 76.0)
  );
  vec3 world = uCenter + vec3(localXZ.x, fallY, localXZ.y);
  vec3 viewPos = (viewMatrix * vec4(world, 1.0)).xyz;

  // Build the streak in view space: its long axis follows wind-slanted fall,
  // while its narrow axis always faces the camera, including at the zenith.
  vec3 fallView = normalize((viewMatrix * vec4(fallDir, 0.0)).xyz);
  vec3 across = cross(fallView, vec3(0.0, 0.0, 1.0));
  float acrossLen = length(across);
  across = acrossLen < 0.001 ? vec3(1.0, 0.0, 0.0) : across / acrossLen;
  float lengthScale = mix(0.42, 1.75, uIntensity)
    * mix(0.62, 1.0, uMotionScale) * mix(0.75, 1.35, aSize);
  float widthScale = mix(0.012, 0.026, aSize);
  viewPos += across * position.x * widthScale + fallView * position.y * lengthScale;

  float dist = length(viewPos);
  float density = smoothstep(aThreshold - 0.14, aThreshold + 0.025, uIntensity * uDensityScale);
  float nearFade = smoothstep(1.2, 4.5, dist);
  float rangeFade = 1.0 - smoothstep(48.0, 58.0, dist);
  vAlpha = density * nearFade * rangeFade * mix(0.42, 0.82, aSize);
  vFog = smoothstep(uFogNear, max(uFogNear + 1.0, uFogFar), dist);
  vDropUv = position.xy + 0.5;
  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
}`;

const FRAGMENT = /* glsl */`
uniform vec3 uDropColor, uFogColor;
varying vec2 vDropUv;
varying float vAlpha, vFog;
void main() {
  float edge = 1.0 - smoothstep(0.16, 0.50, abs(vDropUv.x - 0.5));
  float ends = smoothstep(0.0, 0.17, vDropUv.y)
    * (1.0 - smoothstep(0.83, 1.0, vDropUv.y));
  float alpha = vAlpha * edge * ends;
  if (alpha < 0.004) discard;
  vec3 color = mix(uDropColor, uFogColor, vFog * 0.72);
  gl_FragColor = vec4(color, alpha);
}`;

function makeGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0,  0.5, -0.5, 0,
     0.5,  0.5, 0, -0.5,  0.5, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const origin = new Float32Array(MAX_DROPS * 3);
  const phase = new Float32Array(MAX_DROPS);
  const speed = new Float32Array(MAX_DROPS);
  const threshold = new Float32Array(MAX_DROPS);
  const size = new Float32Array(MAX_DROPS);
  // Fixed pseudo-random population: weather changes only density/appearance,
  // never reallocates buffers or causes a new spatial pattern to pop in.
  let state = 0x92d68ca2;
  const random = () => {
    state |= 0; state = state + 0x6d2b79f5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  for (let i = 0; i < MAX_DROPS; i++) {
    origin[i * 3] = (random() - 0.5) * 76;
    origin[i * 3 + 1] = 0;
    origin[i * 3 + 2] = (random() - 0.5) * 76;
    phase[i] = random();
    speed[i] = random();
    threshold[i] = random();
    size[i] = random();
  }
  geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speed, 1));
  geometry.setAttribute('aThreshold', new THREE.InstancedBufferAttribute(threshold, 1));
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
  geometry.instanceCount = TIER_COUNTS.high;
  return geometry;
}

const _dayColor = new THREE.Color(0.76, 0.84, 0.92);
const _nightColor = new THREE.Color(0.38, 0.48, 0.64);

export class RainSystem {
  constructor(scene) {
    this.intensity = 0;
    this.maxDrops = TIER_COUNTS.high;
    this.reducedMotion = false;
    this.uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uDensityScale: { value: 1 },
      uMotionScale: { value: 1 },
      uCenter: { value: new THREE.Vector3() },
      uWindDir: windUniforms.uWindDir,
      uWindStrength: windUniforms.uWindStrength,
      uWindSpeed: windUniforms.uWindSpeed,
      uDropColor: { value: _dayColor.clone() },
      uFogColor: { value: new THREE.Color(0.45, 0.52, 0.62) },
      uFogNear: { value: 45 },
      uFogFar: { value: 60 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    material.userData.excludeFromAO = true;
    this.mesh = new THREE.Mesh(makeGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setQuality(tier) {
    this.maxDrops = TIER_COUNTS[tier.name] ?? TIER_COUNTS.high;
    this.updateDropCount();
  }

  setComfort({ reducedMotion = false } = {}) {
    this.reducedMotion = !!reducedMotion;
    this.uniforms.uDensityScale.value = this.reducedMotion ? 0.58 : 1;
    this.uniforms.uMotionScale.value = this.reducedMotion ? 0.38 : 1;
    this.updateDropCount();
  }

  updateDropCount() {
    if (this.intensity <= 0.008) {
      this.mesh.geometry.instanceCount = 0;
      return;
    }
    // Drizzle does not pay the full storm vertex cost. Instance count grows
    // continuously with precipitation, then the shader feathers density within
    // that population. Reduced-motion mode cuts the remaining cost further.
    const weatherScale = 0.10 + 0.90 * Math.sqrt(this.intensity);
    const comfortScale = this.reducedMotion ? 0.62 : 1;
    this.mesh.geometry.instanceCount = Math.max(80,
      Math.round(this.maxDrops * weatherScale * comfortScale));
  }

  update(dt, playerPos, weather, sky, fog) {
    const target = weather?.rain ?? 0;
    const response = 1 - Math.exp(-dt * (target > this.intensity ? 1.35 : 2.2));
    this.intensity += (target - this.intensity) * response;
    const u = this.uniforms;
    u.uTime.value += dt * (this.reducedMotion ? 0.38 : 1);
    u.uIntensity.value = this.intensity;
    u.uCenter.value.copy(playerPos);
    this.mesh.visible = this.intensity > 0.008;
    this.updateDropCount();
    if (!this.mesh.visible) return;

    const day = THREE.MathUtils.smoothstep(sky?.sunElevation ?? 0, -0.08, 0.18);
    u.uDropColor.value.copy(_nightColor).lerp(_dayColor, day);
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      // The local rain volume is much nearer than world fog; remap the scene's
      // weather density into its 58 m range rather than using kilometre values.
      const fogDensity = 1 - Math.min(1, Math.max(0, (fog.far - fog.near) / 5000));
      u.uFogNear.value = THREE.MathUtils.lerp(42, 18, fogDensity);
      u.uFogFar.value = THREE.MathUtils.lerp(60, 48, fogDensity);
    }
  }
}
