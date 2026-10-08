// Fireflies: a handful of drifting warm glow-points that come out at night in
// meadows and forest clearings near the player. Rendered as additive shader
// points with HDR colour, so the bloom pass gives each one a soft halo — pure
// night magic for ~zero cost (one draw call, N tiny points, CPU wander is a
// few dozen sines per frame). Follows the butterflies respawn pattern.

import * as THREE from 'three';
import { settlementsAround } from './settlementplacement.mjs';

const N = 44;
const RANGE = 40;            // stay within this radius of the player

// How much of each biome's ground holds a colony at all. Fireflies are a
// glade-and-damp-meadow insect: forests carry them most, open grassland and
// taiga in scattered pockets.
const BIOME_HABITAT = Object.freeze({ forest: 1, jungle: 0.9, grassland: 0.45, taiga: 0.5 });
// Built-up ground: villages keep their nights dark but for the odd stray.
const SETTLEMENT_STRAY = 0.05;
const BUILT_RADIUS = Object.freeze({ 'station-village': 150, 'station-halt': 105 });

function hash2(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * Where a colony is, in the world rather than around the player: a fixed
 * field of patches tens of metres across, so walking back to a glade finds
 * its fireflies still there and the open field beside it still dark.
 */
export function fireflyPatch(x, z, habitat) {
  if (!(habitat > 0)) return 0;
  const n = valueNoise(x / 42, z / 42) * 0.7 + valueNoise(x / 13 + 31.7, z / 13 - 8.2) * 0.3;
  const threshold = 0.70 - habitat * 0.2;
  const t = Math.max(0, Math.min(1, (n - threshold) / 0.12));
  return t * t * (3 - 2 * t);
}

export class Fireflies {
  constructor(scene, world) {
    this.world = world;

    const pos = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3 + 1] = -100; phase[i] = Math.random() * 100; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uGlow: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aPhase;
        uniform float uTime;
        varying float vBlink;
        void main() {
          // slow lantern blink, each firefly on its own rhythm (never fully off)
          vBlink = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (0.7 + fract(aPhase) * 0.8) + aPhase), 2.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (6.5 + 2.0 * vBlink) * (60.0 / max(-mv.z, 4.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity, uGlow;
        varying float vBlink;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float fall = smoothstep(0.5, 0.08, d);
          // HDR warm chartreuse — bright enough to cross the bloom threshold
          vec3 col = vec3(1.35, 1.9, 0.55) * vBlink * uGlow;
          gl_FragColor = vec4(col, fall * vBlink * uOpacity);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.userData.excludeFromAO = true;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);

    this.f = Array.from({ length: N }, () => ({
      ax: 0, az: 0, ay: 0,          // anchor (ground point + hover base)
      alive: false,
      checkT: Math.random() * 3,
      p1: Math.random() * 10, p2: Math.random() * 10, p3: Math.random() * 10,
      r: 0.8 + Math.random() * 1.6, // wander radius
    }));
    this.t = 0;
    this.activity = 0;
    this.activeCount = N;
    this.nearSettlements = [];
    this.settlementQueryX = Infinity; this.settlementQueryZ = Infinity;
  }

  setXRScale(scale = 1) {
    this.activeCount = Math.max(12, Math.min(N, Math.round(N * scale)));
    this.points.geometry.setDrawRange(0, this.activeCount);
  }

  resetRegion(world = this.world) {
    this.world = world;
    this.activity = 0;
    this.settlementQueryX = Infinity;
    for (const firefly of this.f) {
      firefly.alive = false;
      firefly.ax = 0;
      firefly.az = 0;
      firefly.checkT = 0;
    }
    const positions = this.points.geometry.attributes.position;
    for (let i = 0; i < this.activeCount; i++) positions.setXYZ(i, 0, -100, 0);
    positions.needsUpdate = true;
  }

  // firefly habitat: low, gentle, grassy/forested ground (meadow edges, glades)
  habitatAt(x, z) {
    const b = this.world.biomeAt(x, z);
    if (b.h < 1.5 || b.h > 55 || b.slope > 0.3) return null;
    if (!BIOME_HABITAT[b.id]) return null;
    return b;
  }

  /** How likely a firefly is to be here, 0..1: biome, patch, and how built-up. */
  densityAt(x, z, biome) {
    const habitat = BIOME_HABITAT[biome.id] || 0;
    let density = fireflyPatch(x, z, habitat);
    if (density <= 0) return 0;
    for (const site of this.nearSettlements) {
      const built = BUILT_RADIUS[site.kind] || site.radius * 0.75;
      const d = Math.hypot(site.x - x, site.z - z);
      if (d < built + 40) {
        const t = Math.max(0, Math.min(1, (d - built) / 40));
        density *= SETTLEMENT_STRAY + (1 - SETTLEMENT_STRAY) * t * t * (3 - 2 * t);
      }
    }
    return density;
  }

  _refreshSettlements(playerPos) {
    if (Math.hypot(playerPos.x - this.settlementQueryX, playerPos.z - this.settlementQueryZ) < 60) return;
    this.settlementQueryX = playerPos.x; this.settlementQueryZ = playerPos.z;
    try {
      settlementsAround(this.world, playerPos.x, playerPos.z, this.world.seed, RANGE + 200, this.nearSettlements);
    } catch { this.nearSettlements.length = 0; }
  }

  update(dt, playerPos, sky, weather = null, shelter = 0) {
    this.t += dt;
    // Clear, calm nights are alive; gusts, rain and storms put the lanterns
    // away. Keep the old solar fallback so the system remains reusable alone.
    const nightTarget = (weather?.fireflyActivity ?? (sky.sunElevation < -0.05 ? 1 : 0))
      * (1 - Math.min(1, Math.max(0, shelter)));
    const response = 1 - Math.exp(-dt * (nightTarget > this.activity ? 1.8 : 4.5));
    this.activity += (nightTarget - this.activity) * response;
    const u = this.uniforms;
    const moonlight = (weather?.moonVisibility ?? 1) * (sky.moonIllum ?? 0);
    // They remain physically active under a bright moon, but their small glow
    // reads a little softer; clouded nights let the lights carry further.
    u.uOpacity.value = this.activity * (0.76 + (1 - moonlight) * 0.24);
    u.uGlow.value = 0.78 + (1 - moonlight) * 0.22;
    u.uTime.value = this.t;
    this.points.visible = u.uOpacity.value > 0.02;
    if (!this.points.visible) return;

    this._refreshSettlements(playerPos);
    const posAttr = this.points.geometry.attributes.position;
    for (let i = 0; i < this.activeCount; i++) {
      const f = this.f[i];
      f.checkT -= dt;
      const dx = f.ax - playerPos.x, dz = f.az - playerPos.z;
      if (f.checkT <= 0 || dx * dx + dz * dz > RANGE * RANGE) {
        f.checkT = 2 + Math.random() * 2;
        if (!f.alive || dx * dx + dz * dz > RANGE * RANGE) {
          // A spot is kept with the probability the patch field gives it, so
          // the pool gathers in colonies and leaves the rest of the night dark.
          // A few tries per check; a firefly that finds nowhere stays out.
          f.alive = false;
          for (let attempt = 0; attempt < 3 && !f.alive; attempt++) {
            const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * (RANGE - 8);
            const nx = playerPos.x + Math.cos(a) * r, nz = playerPos.z + Math.sin(a) * r;
            const bio = this.habitatAt(nx, nz);
            if (bio && Math.random() < this.densityAt(nx, nz, bio)) {
              f.ax = nx; f.az = nz; f.ay = bio.h; f.alive = true;
            }
          }
        }
      }
      if (!f.alive) { posAttr.setXYZ(i, 0, -100, 0); continue; }
      // lazy figure-eight drift around the anchor, hovering 0.4–1.6 m up
      const t = this.t;
      posAttr.setXYZ(i,
        f.ax + Math.sin(t * 0.31 + f.p1) * f.r + Math.sin(t * 0.83 + f.p2) * 0.5,
        f.ay + 0.9 + Math.sin(t * 0.47 + f.p3) * 0.55,
        f.az + Math.cos(t * 0.27 + f.p2) * f.r + Math.cos(t * 0.71 + f.p1) * 0.5
      );
    }
    posAttr.needsUpdate = true;
  }
}
