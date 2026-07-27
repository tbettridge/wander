// Butterflies: a small CPU-driven flock of instanced quads that wander over
// flowering meadows near the player. ~48 instances updated per frame (trivial
// cost); wing-flap is baked into the instance matrix as an X-scale oscillation.
// Daytime only; butterflies respawn near the player when left behind.

import * as THREE from 'three';

const N = 19;
const RANGE = 45;          // stay within this radius of the player

export class Butterflies {
  constructor(scene, world) {
    this.world = world;
    const geo = new THREE.PlaneGeometry(0.26, 0.16);
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false,
    });
    mat.userData.excludeFromAO = true;
    this.material = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    const palette = [[0.95, 0.55, 0.1], [0.9, 0.85, 0.75], [0.4, 0.5, 0.95], [0.85, 0.3, 0.2], [0.9, 0.75, 0.2]];
    for (let i = 0; i < N; i++) {
      const c = palette[i % palette.length];
      this.mesh.setColorAt(i, new THREE.Color(c[0], c[1], c[2]));
    }
    scene.add(this.mesh);
    this.b = Array.from({ length: N }, () => ({
      pos: new THREE.Vector3(0, -100, 0),   // hidden until placed
      dir: Math.random() * Math.PI * 2,
      phase: Math.random() * 10,
      speed: 0.8 + Math.random() * 0.9,
      turn: 0,
      alive: false,
      checkT: Math.random() * 2,
    }));
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this.t = 0;
    this.activity = 0;
    this.activeCount = N;
  }

  setXRScale(scale = 1) {
    this.activeCount = Math.max(6, Math.min(N, Math.round(N * scale)));
    this.mesh.count = this.activeCount;
  }

  // meadow test: matches the grass field's flowering zone (low, gentle, grassy)
  meadowAt(x, z) {
    const b = this.world.biomeAt(x, z);
    if (b.h < 2 || b.h > 45 || b.slope > 0.25) return null;
    if (!(b.id === 'grassland' || b.id === 'forest' || b.id === 'savanna')) return null;
    return b;
  }

  update(dt, playerPos, sunElevation, weather = null, shelter = 0) {
    this.t += dt;
    // Butterfly weather is not a binary daytime switch. A building front
    // gently thins their presence before the storm/rain gate takes them away.
    const target = (weather?.butterflyActivity ?? (sunElevation > 0.04 ? 1 : 0))
      * (1 - Math.min(1, Math.max(0, shelter)));
    const response = 1 - Math.exp(-dt * (target > this.activity ? 1.7 : 4.2));
    this.activity += (target - this.activity) * response;
    this.material.opacity = this.activity;
    this.mesh.visible = this.activity > 0.02;
    if (!this.mesh.visible) return;
    const m = this._m, q = this._q, e = this._e, s = this._s;
    for (let i = 0; i < this.activeCount; i++) {
      const b = this.b[i];
      // staggered ground/validity check (~every 2s per butterfly)
      b.checkT -= dt;
      const dx = b.pos.x - playerPos.x, dz = b.pos.z - playerPos.z;
      if (b.checkT <= 0 || dx * dx + dz * dz > RANGE * RANGE) {
        b.checkT = 1.5 + Math.random();
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * (RANGE - 10);
        const nx = playerPos.x + Math.cos(a) * r, nz = playerPos.z + Math.sin(a) * r;
        if (!b.alive || dx * dx + dz * dz > RANGE * RANGE) {
          const bio = this.meadowAt(nx, nz);
          if (bio) {
            b.pos.set(nx, bio.h + 0.5 + Math.random() * 1.0, nz);
            b.alive = true;
          } else if (!this.meadowAt(b.pos.x, b.pos.z)) {
            b.alive = false;
            b.pos.y = -100;
          }
        }
      }
      if (!b.alive) { m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, m); continue; }
      // wandering flight: slow heading drift + vertical bob
      b.turn += (Math.random() - 0.5) * 2.4 * dt;
      b.turn *= 0.96;
      b.dir += b.turn;
      const fl = Math.abs(Math.sin(this.t * 11 + b.phase));   // wing flap
      b.pos.x += Math.cos(b.dir) * b.speed * dt;
      b.pos.z += Math.sin(b.dir) * b.speed * dt;
      b.pos.y += Math.sin(this.t * 2.1 + b.phase) * 0.5 * dt + (fl - 0.5) * 0.25 * dt;
      e.set(0, -b.dir, 0);
      q.setFromEuler(e);
      s.set(0.35 + fl * 0.75, 1, 1);       // flap = wings folding via X scale
      m.compose(b.pos, q, s);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
