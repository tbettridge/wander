// Distant bird flocks — a V-formation of dark silhouettes crossing the sky a
// kilometre out, a few times a day. One InstancedMesh, at most two flocks
// aloft; each bird is a single flat quad whose wing-axis scale oscillates for
// the flap (the butterflies trick). The material fogs normally, so flocks
// dissolve into the haze at range exactly like the terrain below them — scale
// sold for ~40 triangles.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX_FLOCKS = 2;
const MAX_BIRDS = 9;
const POOL = MAX_FLOCKS * MAX_BIRDS;
const KILL_DIST = 2700;      // despawn once the flock is this far from the player
const SHOREBIRD_CELL = 72;
const SHOREBIRD_RADIUS = 175;
const MAX_SHOREBIRDS = 20;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smooth01(v) { const t = clamp01(v); return t * t * (3 - 2 * t); }
function shoreRandom(seed, cx, cz, salt = 0) {
  let h = (seed ^ Math.imul(cx | 0, 0x9e3779b9) ^ Math.imul(cz | 0, 0x85ebca6b) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function painted(geometry, color) {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function shorebirdGeometry() {
  // A tiny sandpiper silhouette: compact mottled body, pale belly, round head,
  // probing bill and two long legs. It is intentionally low-poly because an
  // entire feeding flock remains one instanced draw call.
  const parts = [];
  const brown = new THREE.Color(0x6f6557), pale = new THREE.Color(0xd8d0bc);
  const dark = new THREE.Color(0x302d29), leg = new THREE.Color(0x5a4d3c);
  const body = new THREE.SphereGeometry(0.15, 7, 5);
  body.scale(0.78, 0.68, 1.35); body.translate(0, 0.10, 0);
  parts.push(painted(body, brown));
  const belly = new THREE.SphereGeometry(0.115, 6, 4);
  belly.scale(0.72, 0.36, 1.18); belly.translate(0, 0.045, -0.015);
  parts.push(painted(belly, pale));
  const head = new THREE.SphereGeometry(0.085, 6, 4);
  head.translate(0, 0.19, -0.15); parts.push(painted(head, brown));
  const beak = new THREE.ConeGeometry(0.018, 0.20, 4);
  beak.rotateX(-Math.PI / 2); beak.translate(0, 0.175, -0.28);
  parts.push(painted(beak, dark));
  for (const x of [-0.042, 0.042]) {
    const shin = new THREE.CylinderGeometry(0.009, 0.009, 0.19, 4);
    shin.translate(x, -0.055, 0.005); parts.push(painted(shin, leg));
  }
  return mergeGeometries(parts);
}

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

    const shoreMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    });
    shoreMat.userData.excludeFromAO = true;
    this.shoreMesh = new THREE.InstancedMesh(shorebirdGeometry(), shoreMat, MAX_SHOREBIRDS);
    this.shoreMesh.name = 'shorebird-flock';
    this.shoreMesh.frustumCulled = false;
    this.shoreMesh.castShadow = this.shoreMesh.receiveShadow = false;
    scene.add(this.shoreMesh);
    this.shorebirds = [];
    this.shoreSurveyT = 0;
    this.shoreTime = 0;
    this.shorebirdCount = 0;

    this.flocks = Array.from({ length: MAX_FLOCKS }, () => ({
      active: false,
      x: 0, y: 0, z: 0, heading: 0, speed: 18,
      baseAlt: 200, t: 0, wob: Math.random() * 10, n: 7,
      phases: Array.from({ length: MAX_BIRDS }, () => Math.random() * 10),
      flapHz: 2.4 + Math.random() * 0.9,
    }));
    this.spawnT = 30 + Math.random() * 60;   // first flock fairly soon
    this.xrScale = 1;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  setXRScale(scale = 1) {
    this.xrScale = Math.max(0.4, Math.min(1, Number(scale) || 0));
  }

  resetRegion(world = this.world) {
    this.world = world;
    this.shorebirds.length = 0;
    this.shoreSurveyT = 0;
    this.spawnT = 30 + Math.random() * 60;
    this.shorebirdCount = 0;
    for (const flock of this.flocks) {
      flock.active = false;
      flock.t = 0;
    }
  }

  surveyShorebirds(playerPos) {
    const birds = [];
    const c0 = Math.floor((playerPos.x - SHOREBIRD_RADIUS) / SHOREBIRD_CELL);
    const c1 = Math.floor((playerPos.x + SHOREBIRD_RADIUS) / SHOREBIRD_CELL);
    const z0 = Math.floor((playerPos.z - SHOREBIRD_RADIUS) / SHOREBIRD_CELL);
    const z1 = Math.floor((playerPos.z + SHOREBIRD_RADIUS) / SHOREBIRD_CELL);
    for (let cz = z0; cz <= z1 && birds.length < MAX_SHOREBIRDS; cz++) {
      for (let cx = c0; cx <= c1 && birds.length < MAX_SHOREBIRDS; cx++) {
        if (shoreRandom(this.world.seed, cx, cz, 11) > 0.36) continue;
        const x = (cx + 0.18 + shoreRandom(this.world.seed, cx, cz, 21) * 0.64) * SHOREBIRD_CELL;
        const z = (cz + 0.18 + shoreRandom(this.world.seed, cx, cz, 31) * 0.64) * SHOREBIRD_CELL;
        const b = this.world.biomeAt(x, z);
        if (b.id !== 'beach' || b.h < 0.42 || b.h > 1.45 || b.slope > 0.22) continue;
        const seaNear = this.world.height(x + 18, z) < 0.18 || this.world.height(x - 18, z) < 0.18
          || this.world.height(x, z + 18) < 0.18 || this.world.height(x, z - 18) < 0.18;
        if (!seaNear) continue;
        const e = 5;
        const gx = this.world.height(x + e, z) - this.world.height(x - e, z);
        const gz = this.world.height(x, z + e) - this.world.height(x, z - e);
        const gl = Math.hypot(gx, gz) || 1;
        const tx = -gz / gl, tz = gx / gl;
        const count = 2 + Math.floor(shoreRandom(this.world.seed, cx, cz, 41) * 3);
        for (let i = 0; i < count && birds.length < MAX_SHOREBIRDS; i++) {
          const along = (i - (count - 1) * 0.5) * (1.6 + shoreRandom(this.world.seed, cx, cz, 50 + i));
          const bx = x + tx * along, bz = z + tz * along;
          const h = this.world.height(bx, bz);
          if (h < 0.34 || h > 1.55 || this.world.riverAt(bx, bz).wet) continue;
          birds.push({
            x: bx, z: bz, tangentX: tx, tangentZ: tz,
            phase: shoreRandom(this.world.seed, cx, cz, 70 + i) * Math.PI * 2,
          });
        }
      }
    }
    this.shorebirds = birds;
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
    this.shoreTime += dt;
    this.shoreSurveyT -= dt;
    if (this.shoreSurveyT <= 0) {
      this.shoreSurveyT = 1.75;
      this.surveyShorebirds(playerPos);
    }
    this.spawnT -= dt * Math.max(0.05, activity);
    if (this.spawnT <= 0) {
      this.spawnT = 80 + Math.random() * 140;
      if (activity > 0.15) this.spawnFlock(playerPos);
    }

    const m = this._m, q = this._q, e = this._e, s = this._s;
    let slot = 0;
    let flockIndex = 0;
    const activeFlockLimit = this.xrScale < 0.7 ? 1 : MAX_FLOCKS;
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
      const flockBirdCount = Math.max(5, Math.round(f.n * this.xrScale));
      if (flockIndex++ >= activeFlockLimit) continue;
      for (let k = 0; k < flockBirdCount; k++) {
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

    // Feeding flocks scurry parallel to the waterline and periodically peck.
    // A close approach lifts them together in a low, fast burst away from the
    // player; the sites remain stable when revisited because they are seeded by
    // world cell rather than by session randomness.
    let shoreSlot = 0;
    const shorebirdLimit = Math.max(8, Math.round(MAX_SHOREBIRDS * this.xrScale));
    for (const bird of this.shorebirds.slice(0, shorebirdLimit)) {
      const feed = this.shoreTime * 0.78 + bird.phase;
      const along = Math.sin(feed) * 1.7;
      let x = bird.x + bird.tangentX * along;
      let z = bird.z + bird.tangentZ * along;
      const dx = x - playerPos.x, dz = z - playerPos.z;
      const dist = Math.hypot(dx, dz);
      const alarm = smooth01((12 - dist) / 9);
      if (alarm > 0) {
        const dl = dist || 1;
        x += (dx / dl) * alarm * 7.5;
        z += (dz / dl) * alarm * 7.5;
      }
      const ground = this.world.height(x, z);
      const peck = alarm < 0.05 ? Math.max(0, Math.sin(feed * 3.7) - 0.72) / 0.28 : 0;
      const y = ground + 0.12 + alarm * (0.45 + 1.7 * alarm)
        + Math.abs(Math.sin(feed * 8.5)) * alarm * 0.08 - peck * 0.035;
      const heading = alarm > 0.05 ? Math.atan2(dx, dz)
        : Math.atan2(bird.tangentX * Math.cos(feed), bird.tangentZ * Math.cos(feed));
      this._p.set(x, y, z);
      this._e.set(peck * 0.42, heading, alarm * Math.sin(feed * 9) * 0.18);
      this._q.setFromEuler(this._e);
      const wing = 1 + alarm * Math.abs(Math.sin(feed * 15)) * 0.55;
      this._s.set(wing, 1 - peck * 0.16, 1);
      this._m.compose(this._p, this._q, this._s);
      this.shoreMesh.setMatrixAt(shoreSlot++, this._m);
    }
    for (let i = shoreSlot; i < MAX_SHOREBIRDS; i++) {
      this._m.makeScale(0, 0, 0);
      this.shoreMesh.setMatrixAt(i, this._m);
    }
    this.shoreMesh.instanceMatrix.needsUpdate = true;
    this.shorebirdCount = shoreSlot;
    this.shoreMesh.visible = shoreSlot > 0 && activity > 0.08 && caveShelter < 0.72;
  }
}
