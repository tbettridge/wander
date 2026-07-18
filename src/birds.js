// Distant bird flocks — a V-formation of dark silhouettes crossing the sky a
// kilometre out, a few times a day. One InstancedMesh, at most two flocks
// aloft; each bird is a single flat quad whose wing-axis scale oscillates for
// the flap (the butterflies trick). The material fogs normally, so flocks
// dissolve into the haze at range exactly like the terrain below them — scale
// sold for ~40 triangles.

import * as THREE from 'three';

const MAX_FLOCKS = 2;
const MAX_BIRDS = 9;
const POOL = MAX_FLOCKS * MAX_BIRDS;
const KILL_DIST = 2700;      // despawn once the flock is this far from the player

export class Birds {
  constructor(scene, world) {
    this.world = world;
    const geo = new THREE.PlaneGeometry(3.4, 1.2);
    geo.rotateX(-Math.PI / 2);          // flat — seen from below as a silhouette
    const mat = new THREE.MeshBasicMaterial({ color: 0x232c38, fog: true, side: THREE.DoubleSide });
    mat.userData.excludeFromAO = true;
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    this.flocks = Array.from({ length: MAX_FLOCKS }, () => ({
      active: false,
      x: 0, y: 0, z: 0, heading: 0, speed: 18,
      baseAlt: 200, t: 0, wob: Math.random() * 10, n: 7,
      phases: Array.from({ length: MAX_BIRDS }, () => Math.random() * 10),
      flapHz: 2.4 + Math.random() * 0.9,
    }));
    this.spawnT = 30 + Math.random() * 60;   // first flock fairly soon
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  spawnFlock(playerPos) {
    const f = this.flocks.find((ff) => !ff.active);
    if (!f) return;
    // start ~1.4 km out on a random bearing, crossing the sky tangentially so
    // the formation traverses the view rather than beelining at the player
    const b = Math.random() * Math.PI * 2;
    const side = Math.random() < 0.5 ? 1 : -1;
    f.x = playerPos.x + Math.cos(b) * 1400;
    f.z = playerPos.z + Math.sin(b) * 1400;
    f.heading = b + Math.PI / 2 * side + (Math.random() - 0.5) * 0.6;
    f.speed = 15 + Math.random() * 7;
    const ground = this.world.height(f.x, f.z);
    f.baseAlt = Math.max(ground, playerPos.y) + 130 + Math.random() * 130;
    f.y = f.baseAlt;
    f.t = 0;
    f.n = 5 + ((Math.random() * (MAX_BIRDS - 4)) | 0);
    f.flapHz = 2.4 + Math.random() * 0.9;
    f.active = true;
  }

  update(dt, playerPos, sky, weather, shelter = 0) {
    // spawn cadence rides the weather's bird activity (quiet in storms/night)
    const day = Math.min(1, Math.max(0, (sky.sunElevation + 0.04) / 0.16));
    const caveShelter = Math.min(1, Math.max(0, shelter));
    const activity = (weather?.birdActivity ?? day) * day * (1 - caveShelter);
    this.spawnT -= dt * Math.max(0.05, activity);
    if (this.spawnT <= 0) {
      this.spawnT = 80 + Math.random() * 140;
      if (activity > 0.15) this.spawnFlock(playerPos);
    }

    const m = this._m, q = this._q, e = this._e, s = this._s;
    let slot = 0;
    for (const f of this.flocks) {
      if (!f.active) { continue; }
      f.t += dt;
      // gentle meander: heading wanders, altitude breathes
      f.heading += Math.sin(f.t * 0.07 + f.wob) * 0.022 * dt * 60 * 0.016;
      f.x += Math.cos(f.heading) * f.speed * dt;
      f.z += Math.sin(f.heading) * f.speed * dt;
      f.y = f.baseAlt + Math.sin(f.t * 0.11 + f.wob) * 16;
      const dx = f.x - playerPos.x, dz = f.z - playerPos.z;
      if (dx * dx + dz * dz > KILL_DIST * KILL_DIST || f.t > 300) { f.active = false; continue; }

      const ch = Math.cos(f.heading), sh = Math.sin(f.heading);
      e.set(0, -f.heading, 0);
      q.setFromEuler(e);
      for (let k = 0; k < f.n; k++) {
        // V formation: leader first, pairs trailing alternately left/right
        const row = (k + 1) >> 1, side = (k & 1) ? 1 : -1;
        const back = row * 7.5, lat = k === 0 ? 0 : side * row * 5.4;
        this._p.set(
          f.x - ch * back - sh * lat,
          f.y - row * 1.3,
          f.z - sh * back + ch * lat
        );
        // flap: wing-axis squash, phase-lagged down the formation so the wave
        // travels; brief glides read naturally from the sine's soft bottoms
        const flap = 0.30 + 0.70 * Math.abs(Math.sin(f.t * f.flapHz + f.phases[k] + row * 0.55));
        s.set(flap, 1, 1);
        m.compose(this._p, q, s);
        this.mesh.setMatrixAt(slot++, m);
      }
    }
    // park unused instances
    for (let i = slot; i < POOL; i++) {
      m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = slot > 0 && caveShelter < 0.8;
  }
}
