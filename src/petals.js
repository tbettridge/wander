// Falling petals & leaves — a small pool of drifting point-sprites shed by
// nearby blossom trees (pink petals) and strongly-turned autumn broadleaves
// (gold/red leaves). Crowns are harvested from the streamed chunks' instanced
// vegetation a few times per second; petals spawn in the crown, tumble down on
// the shared wind, settle on the ground for a breath and respawn. One draw
// call, ~a hundred sprites, CPU cost is a handful of sines per petal.

import * as THREE from 'three';
import { windUniforms } from './wind.js';

const N = 110;
const CROWN_RANGE = 55;      // harvest crowns within this radius of the player
const MAX_CROWNS = 8;
const REFRESH = 2.5;         // seconds between crown scans

// Matches injectHueJitter's per-instance autumn hash (position-keyed), so we
// shed leaves from exactly the trees the canopy shader turned gold/red.
// vAutumn = smoothstep(0.90, 0.99, h2) — 0.93+ means a strongly turned tree.
function autumnHash(x, z) {
  const s = Math.sin(x * 39.346 + z * 11.135) * 24634.633;
  return s - Math.floor(s);
}

const AUTUMN_TYPES = ['broadleaf', 'oak', 'birch'];

export class Petals {
  constructor(scene, world) {
    this.world = world;

    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const alpha = new Float32Array(N);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3 + 1] = -100; phase[i] = Math.random() * 100; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.uniforms = { uTime: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec3 aCol;
        attribute float aAlpha, aPhase;
        uniform float uTime;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vCol = aCol;
          // tumbling flicker: a petal catches light and thins as it turns
          vA = aAlpha * (0.55 + 0.45 * sin(uTime * (3.0 + fract(aPhase)) + aPhase * 9.0));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 5.2 * (34.0 / max(-mv.z, 3.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float fall = smoothstep(0.5, 0.18, length(d));
          if (fall * vA < 0.01) discard;
          gl_FragColor = vec4(vCol, fall * vA);
        }`,
      transparent: true, depthWrite: false,
    });
    mat.userData.excludeFromAO = true;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);

    this.crowns = [];            // { x, y, z, r, col: THREE.Color }
    this.refreshT = 0;
    this.p = Array.from({ length: N }, () => ({
      x: 0, y: -100, z: 0, groundY: -100,
      vy: 0, sway: Math.random() * 10, swayR: 0.4 + Math.random() * 0.8,
      settle: 0,                 // >0 while resting on the ground (fade out)
      crown: -1,
    }));
    this._m = new THREE.Matrix4();
    this.t = 0;
  }

  // Harvest shedding crowns from the streamed instanced vegetation: every
  // blossom tree plus deciduous trees whose autumn hash turned them.
  refreshCrowns(chunkMgr, playerPos) {
    const crowns = this.crowns;
    crowns.length = 0;
    const m = this._m;
    const r2 = CROWN_RANGE * CROWN_RANGE;
    for (const chunk of chunkMgr.chunks.values()) {
      if (!chunk.veg || crowns.length >= MAX_CROWNS) continue;
      const gx = chunk.veg.position.x, gy = chunk.veg.position.y, gz = chunk.veg.position.z;
      for (const mesh of chunk.veg.children) {
        if (!mesh.isInstancedMesh || crowns.length >= MAX_CROWNS) continue;
        const type = (mesh.name || '').split('/')[0];
        const blossom = type === 'blossom';
        if (!blossom && !AUTUMN_TYPES.includes(type)) continue;
        for (let i = 0; i < mesh.count && crowns.length < MAX_CROWNS; i++) {
          mesh.getMatrixAt(i, m);
          const x = m.elements[12] + gx, y = m.elements[13] + gy, z = m.elements[14] + gz;
          const dx = x - playerPos.x, dz = z - playerPos.z;
          if (dx * dx + dz * dz > r2) continue;
          if (!blossom && autumnHash(x, z) < 0.93) continue;   // only turned trees shed
          const s = Math.hypot(m.elements[4], m.elements[5], m.elements[6]); // Y scale
          const col = new THREE.Color();
          if (blossom) col.setRGB(1.0, 0.74, 0.83);
          else if (autumnHash(x + 7, z) < 0.5) col.setRGB(1.0, 0.70, 0.24);  // gold
          else col.setRGB(0.88, 0.36, 0.22);                                 // red
          crowns.push({
            x, z, r: (blossom ? 1.7 : 2.3) * s,
            y: y + (blossom ? 3.1 : 4.6) * s,
            col,
          });
        }
      }
    }
  }

  spawn(p, colAttr, i) {
    if (!this.crowns.length) { p.y = -100; return; }
    const c = this.crowns[(Math.random() * this.crowns.length) | 0];
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * c.r;
    p.x = c.x + Math.cos(a) * rr;
    p.z = c.z + Math.sin(a) * rr;
    p.y = c.y - Math.random() * 1.2;
    p.groundY = this.world.height(p.x, p.z);
    p.vy = -(0.30 + Math.random() * 0.22);
    p.settle = 0;
    colAttr.setXYZ(i, c.col.r, c.col.g, c.col.b);
  }

  update(dt, playerPos, chunkMgr) {
    this.t += dt;
    this.uniforms.uTime.value = this.t;
    this.refreshT -= dt;
    if (this.refreshT <= 0) {
      this.refreshT = REFRESH;
      this.refreshCrowns(chunkMgr, playerPos);
    }
    const has = this.crowns.length > 0;
    this.points.visible = has || this.p.some((p) => p.y > -50);
    if (!this.points.visible) return;

    const posA = this.points.geometry.attributes.position;
    const colA = this.points.geometry.attributes.aCol;
    const alfA = this.points.geometry.attributes.aAlpha;
    const wd = windUniforms.uWindDir.value, ws = windUniforms.uWindStrength.value;
    for (let i = 0; i < N; i++) {
      const p = this.p[i];
      if (p.y <= -50) {                       // dormant: respawn only if crowns exist
        if (has && Math.random() < dt * 0.5) this.spawn(p, colA, i);
        else { alfA.setX(i, 0); continue; }
      }
      if (p.settle > 0) {                     // resting on the ground, fading
        p.settle -= dt;
        alfA.setX(i, Math.max(0, p.settle / 1.2) * 0.85);
        if (p.settle <= 0) p.y = -100;
      } else {
        p.sway += dt;
        p.x += (Math.sin(p.sway * 2.1) * 0.55 + wd.x * ws * 0.8) * dt * p.swayR * 2.2;
        p.z += (Math.cos(p.sway * 1.7) * 0.55 + wd.y * ws * 0.8) * dt * p.swayR * 2.2;
        p.y += p.vy * dt;
        alfA.setX(i, 0.9);
        if (p.y <= p.groundY + 0.04) { p.y = p.groundY + 0.04; p.settle = 1.2; }
      }
      posA.setXYZ(i, p.x, p.y, p.z);
    }
    posA.needsUpdate = true;
    colA.needsUpdate = true;
    alfA.needsUpdate = true;
  }
}
