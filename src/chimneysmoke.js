// Chimney smoke a walker can see from across the valley: a thin column from a
// few lit chimneys in each nearby settlement (villagebeacons.mjs chooses which).
// One THREE.Points pool, one draw call. Unlike the locomotive's puffs these are
// sized in metres, not pixels, so a plume still reads as a column at two
// kilometres, and they take the scene's fog like everything else out there.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const POOL = 2400;
const PUFF_EVERY = 0.35;         // seconds between puffs from one chimney
const LIFE = 20;                 // seconds a puff lasts: a column some thirty metres tall
const RISE = 1.9;                // metres per second, before the wind takes it
const START_SIZE = 2.4;          // metres across as it leaves the pot
const GROWTH = 0.65;             // how fast it spreads as it cools, per second

const VERTEX = /* glsl */`
  attribute float aAge;
  attribute float aSize;
  uniform float uScale;
  varying float vAge;
  #include <fog_pars_vertex>
  void main() {
    vAge = aAge;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Metres to pixels: the size a ball of this width would appear at this depth.
    // A few pixels at the least, so a plume a valley away still reads as a thread of smoke.
    gl_PointSize = clamp(aSize * uScale / max(1.0, -mvPosition.z), 3.0, 220.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uLight;
  uniform float uHaze;
  varying float vAge;
  #include <fog_pars_fragment>
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float disc = smoothstep(0.5, 0.12, d);
    float fadeIn = smoothstep(0.0, 0.06, vAge);
    float fadeOut = pow(1.0 - vAge, 0.75);
    float alpha = disc * fadeIn * fadeOut * uOpacity;
    if (alpha < 0.003) discard;
    // Fresh wood smoke is a little blue-grey; it thins to a paler haze.
    vec3 colour = mix(uColor * 0.72, uColor, vAge) * uLight;
    gl_FragColor = vec4(colour, alpha);
    // Only part of the haze: a plume stands out against far hills that the fog
    // has already taken, which is how it is seen across a valley.
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * uHaze);
    #endif
  }
`;

export class ChimneySmoke {
  constructor(scene) {
    this.scene = scene;
    this.positions = new Float32Array(POOL * 3);
    this.velocities = new Float32Array(POOL * 3);
    this.ages = new Float32Array(POOL).fill(1);
    this.sizes = new Float32Array(POOL);
    this.cursor = 0;
    /** Chimney tops currently smoking: `{ key, x, y, z, timer }`. */
    this.emitters = new Map();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAge', new THREE.BufferAttribute(this.ages, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, fog: true, transparent: true, depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uColor: { value: new THREE.Color(0xa29f99) }, uOpacity: { value: 0.55 }, uHaze: { value: 0.5 }, uLight: { value: 1 }, uScale: { value: 600 },
      }]),
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'Chimney smoke';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
  }

  /** Which chimneys are lit: a list of `{ key, x, y, z }`. Puffs already in the air drift on. */
  setChimneys(list) {
    const keep = new Set();
    for (const chimney of list) {
      keep.add(chimney.key);
      if (!this.emitters.has(chimney.key)) this.emitters.set(chimney.key, { ...chimney, timer: Math.random() * PUFF_EVERY });
    }
    for (const key of [...this.emitters.keys()]) if (!keep.has(key)) this.emitters.delete(key);
  }

  spawn(emitter) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % POOL;
    const o = i * 3;
    this.positions[o] = emitter.x + (Math.random() - 0.5) * 0.25;
    this.positions[o + 1] = emitter.y + 0.1;
    this.positions[o + 2] = emitter.z + (Math.random() - 0.5) * 0.25;
    this.velocities[o] = (Math.random() - 0.5) * 0.25;
    this.velocities[o + 1] = RISE * (0.8 + Math.random() * 0.4);
    this.velocities[o + 2] = (Math.random() - 0.5) * 0.25;
    this.ages[i] = 0;
    this.sizes[i] = START_SIZE * (0.8 + Math.random() * 0.4);
  }

  /**
   * `camera` sets how big a metre looks; `light` (0 at night to 1 by day)
   * keeps pale smoke from glowing in the dark.
   */
  update(dt, camera, renderer, light = 1) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    for (const emitter of this.emitters.values()) {
      emitter.timer -= dt;
      while (emitter.timer <= 0) { emitter.timer += PUFF_EVERY * (0.8 + Math.random() * 0.4); this.spawn(emitter); }
    }
    const windDir = windUniforms.uWindDir.value, windStrength = windUniforms.uWindStrength.value;
    // Higher up the wind has more hold on it: a plume leans more as it climbs.
    const windX = windDir.x * (0.4 + windStrength * 2.2), windZ = windDir.y * (0.4 + windStrength * 2.2);
    const settle = 1 - Math.exp(-0.35 * dt);
    let live = 0;
    for (let i = 0; i < POOL; i++) {
      if (this.ages[i] >= 1) { this.sizes[i] = 0; continue; }
      live++;
      // It rises straight out of the pot before the wind leans it over.
      const o = i * 3, lean = Math.min(1, Math.max(0, this.ages[i] * 1.6 - 0.15));
      this.velocities[o] += (windX * lean - this.velocities[o]) * settle;
      this.velocities[o + 1] += (RISE * (1 - this.ages[i] * 0.6) - this.velocities[o + 1]) * settle;
      this.velocities[o + 2] += (windZ * lean - this.velocities[o + 2]) * settle;
      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;
      this.ages[i] = Math.min(1, this.ages[i] + dt / LIFE);
      this.sizes[i] += GROWTH * dt;
    }
    this.live = live;
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAge.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    // Pixels per metre at one metre's distance, for this camera and canvas.
    const height = renderer?.getDrawingBufferSize?.(new THREE.Vector2()).y || window.innerHeight;
    const fov = THREE.MathUtils.degToRad(camera?.fov || 70);
    this.material.uniforms.uScale.value = height / (2 * Math.tan(fov / 2));
    // The scene is darkened by exposure after it is drawn and this is not, so night has to be set low here.
    const day = Math.max(0, Math.min(1, light));
    this.material.uniforms.uLight.value = 0.04 + 0.96 * day * day;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
