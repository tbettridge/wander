// Locomotive chimney smoke: a single THREE.Points pool (one draw call) of
// soft billboard puffs. Emission chuffs in time with the drivers, puffs
// inherit train velocity, then buoyancy and the weather's wind take over.
// Off by default — the service only updates it while its debug flag is set.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const POOL = 96;
const DRIVER_RADIUS = 0.5;      // matches the locomotive's driving wheels
const CHUFFS_PER_REV = 2;       // visual beat; real 2-cylinder engines give 4
const IDLE_PERIOD = 0.42;       // standstill wisp cadence
const BASE_LIFE = 2.3;

const VERTEX = /* glsl */`
  attribute float aAge;
  attribute float aSize;
  varying float vAge;
  void main() {
    vAge = aAge;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * clamp(230.0 / max(1.0, -mv.z), 1.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    // Soft disc, quick fade-in so puffs never pop, long dissolve tail.
    float disc = smoothstep(0.5, 0.16, d);
    float fadeIn = smoothstep(0.0, 0.1, vAge);
    float fadeOut = pow(1.0 - vAge, 1.5);
    float alpha = disc * fadeIn * fadeOut * uOpacity;
    if (alpha < 0.004) discard;
    // Fresh steam is bright; older smoke greys off.
    vec3 colour = mix(uColor, uColor * 0.62, vAge);
    gl_FragColor = vec4(colour, alpha);
  }
`;

export class LocomotiveSmoke {
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;
    this.positions = new Float32Array(POOL * 3);
    this.velocities = new Float32Array(POOL * 3);
    this.ages = new Float32Array(POOL).fill(1);     // 1 = dead
    this.lives = new Float32Array(POOL).fill(BASE_LIFE);
    this.sizes = new Float32Array(POOL);
    this.cursor = 0;
    this.chuffPhase = 0;
    this.idleTimer = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAge', new THREE.BufferAttribute(this.ages, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uColor: { value: new THREE.Color(0xd8d4cc) },
        uOpacity: { value: 0.34 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'Locomotive smoke';
    this.points.frustumCulled = true;
    this.points.visible = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.points.visible = this.enabled;
    if (!this.enabled) this.ages.fill(1);
  }

  spawn(origin, forward, speed, vigor) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % POOL;
    const o = i * 3;
    this.positions[o] = origin.x + (Math.random() - 0.5) * 0.18;
    this.positions[o + 1] = origin.y + Math.random() * 0.1;
    this.positions[o + 2] = origin.z + (Math.random() - 0.5) * 0.18;
    // Leaves the stack rising hard, carrying most of the train's momentum.
    this.velocities[o] = forward.x * speed * 0.75 + (Math.random() - 0.5) * 0.5;
    this.velocities[o + 1] = 2.0 + vigor * 1.7 + Math.random() * 0.6;
    this.velocities[o + 2] = forward.z * speed * 0.75 + (Math.random() - 0.5) * 0.5;
    this.ages[i] = 0;
    this.lives[i] = BASE_LIFE * (0.75 + Math.random() * 0.6);
    this.sizes[i] = 0.9 + vigor * 0.5 + Math.random() * 0.35;
  }

  update(dt, chimney, forward, speed) {
    if (!this.enabled || !(dt > 0)) return;

    // Chuffs in time with the driving wheels; a gentle idle wisp at rest.
    const vigor = Math.min(1, speed / 10);
    if (speed > 0.4) {
      const beats = (speed / (Math.PI * 2 * DRIVER_RADIUS)) * CHUFFS_PER_REV;
      this.chuffPhase += beats * dt;
      while (this.chuffPhase >= 1) {
        this.chuffPhase -= 1;
        const burst = 3 + (Math.random() * 2 | 0);
        for (let k = 0; k < burst; k++) this.spawn(chimney, forward, speed, vigor);
      }
    } else {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.idleTimer = IDLE_PERIOD * (0.8 + Math.random() * 0.5);
        this.spawn(chimney, forward, 0, 0.1);
      }
    }

    // Integrate: drag sheds the launch velocity while wind and buoyancy take over.
    const windDir = windUniforms.uWindDir.value;
    const windStrength = windUniforms.uWindStrength.value;
    const windX = windDir.x * (0.8 + windStrength * 3.4);
    const windZ = windDir.y * (0.8 + windStrength * 3.4);
    const drag = Math.exp(-1.7 * dt);
    for (let i = 0; i < POOL; i++) {
      if (this.ages[i] >= 1) { this.sizes[i] = 0; continue; }
      const o = i * 3;
      this.velocities[o] = this.velocities[o] * drag + windX * (1 - drag);
      this.velocities[o + 1] = this.velocities[o + 1] * drag + 0.85 * (1 - drag);
      this.velocities[o + 2] = this.velocities[o + 2] * drag + windZ * (1 - drag);
      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;
      this.ages[i] = Math.min(1, this.ages[i] + dt / this.lives[i]);
      // Puffs swell as they cool and disperse.
      this.sizes[i] += this.sizes[i] * 1.05 * dt;
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAge.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    geometry.boundingSphere.center.copy(chimney);
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
