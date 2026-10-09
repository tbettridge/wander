import * as THREE from 'three';
import { prepareInteriorRoom } from './interiorgeometry.mjs';
import { desiredInteriorRooms, INTERIOR_STREAM_POLICY as POLICY } from './interiorvisibility.mjs';
import { interiorBaseY } from './interiorarchitecture.mjs';
import { planOpenings } from './buildingopenings.mjs';
const NIGHT_LIGHT_FADE_SECONDS = 1.2;
const NIGHT_LIGHT_FADE_DAY_MAX = 0.35;
function roomMaterial(room, building, fixtures) {
  const center = { x: (room.bounds.minX + room.bounds.maxX) / 2, y: room.y + 1, z: (room.bounds.minZ + room.bounds.maxZ) / 2 };
  const windows = [];
  for (const side of [-1, 1]) for (const opening of planOpenings(building, building.width)) {
    const door = building.portals.find(p => p.kind === (side > 0 ? 'exterior-door' : 'back-door'));
    if (door && Math.abs(opening.x - door.x) < (opening.width + door.width) / 2 + 0.12 && opening.bottom < door.height) continue;
    windows.push(new THREE.Vector3(opening.x, opening.bottom + opening.height / 2, side * building.depth / 2));
  }
  if (building.program === 'church') for (const side of [-1, 1]) for (const opening of planOpenings(building, building.depth))
    windows.push(new THREE.Vector3(side * building.width / 2, opening.bottom + opening.height / 2, -opening.x));
  windows.sort((a, b) => a.distanceToSquared(center) - b.distanceToSquared(center));
  const daylight = Array.from({ length: 4 }, (_, i) => windows[i] || new THREE.Vector3(0, -1000, 0));
  const uniforms = { uInteriorDay: { value: 1 }, uInteriorTime: { value: 0 }, uInteriorLightReveal: { value: 1 },
    uInteriorLamp0: { value: new THREE.Vector3(...[0, -1000, 0]) }, uInteriorLamp1: { value: new THREE.Vector3(0, -1000, 0) },
    uInteriorLamps: { value: new THREE.Vector2() }, uInteriorWindows: { value: daylight } };
  fixtures.forEach((f, i) => uniforms[`uInteriorLamp${i}`].value.set(f.x, f.y, f.z));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, fog: false });
  mat.userData.interiorUniforms = uniforms;
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vInteriorPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvInteriorPosition = position;');
    shader.fragmentShader = 'varying vec3 vInteriorPosition;\nuniform float uInteriorDay;\nuniform float uInteriorTime;\nuniform float uInteriorLightReveal;\nuniform vec3 uInteriorLamp0;\nuniform vec3 uInteriorLamp1;\nuniform vec2 uInteriorLamps;\nuniform vec3 uInteriorWindows[4];\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      float windowDistance = 1000.0;
      for (int i=0; i<4; i++) windowDistance = min(windowDistance, distance(vInteriorPosition, uInteriorWindows[i]));
      float skyReach = 0.16 + 0.48 * exp(-windowDistance * 0.65);
      reflectedLight.indirectDiffuse *= skyReach;
      reflectedLight.directDiffuse *= 0.35 + skyReach * 0.65;
      float f0 = uInteriorLamps.x / (1.0 + dot(vInteriorPosition-uInteriorLamp0, vInteriorPosition-uInteriorLamp0)*1.2);
      float f1 = uInteriorLamps.y / (1.0 + dot(vInteriorPosition-uInteriorLamp1, vInteriorPosition-uInteriorLamp1)*1.2);
      float flicker = 0.96 + 0.025*sin(uInteriorTime*6.1) + 0.015*sin(uInteriorTime*10.7);
      reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0,0.52,0.19) * (f0+f1)*flicker*uInteriorLightReveal;
      reflectedLight.indirectDiffuse += diffuseColor.rgb * (0.025*uInteriorLightReveal + uInteriorDay*0.035);`);
  };
  mat.customProgramCacheKey = () => 'wander-interior-v2';
  return mat;
}
function geometry(data) {
  const g = new THREE.BufferGeometry();
  for (const [name, array] of Object.entries(data)) g.setAttribute(name, new THREE.BufferAttribute(array, 3));
  g.computeBoundingBox(); g.computeBoundingSphere(); return g;
}
export class InteriorStream {
  constructor({ worker = true } = {}) {
    this.buildings = new Map(); this.rooms = new Map(); this.pending = new Map(); this.ready = [];
    this.sequence = 0; this.elapsed = 0; this.lastPlayer = null; this.disposed = false;
    this.metrics = { activeRooms: 0, warmRooms: 0, pending: 0, bytes: 0, triangles: 0, assemblyMs: 0, failures: 0 };
    if (worker && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./interiorworker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const request = this.pending.get(data.id); if (!request) return;
          this.pending.delete(data.id);
          if (data.error) { this.metrics.failures++; this.ready.push({ ...request, data: null }); console.warn('[interior]', data.error); }
          else if (this.buildings.has(request.record.building.id)) this.ready.push({ ...request, data: data.result });
        };
        this.worker.onerror = () => { this.worker?.terminate(); this.worker = null;
          for (const request of this.pending.values()) this.ready.push({ ...request, data: null });
          this.pending.clear(); this.metrics.failures++; };
      } catch { this.worker = null; }
    }
  }
  register(plan, parent) {
    const root = new THREE.Group(); root.name = `${plan.id}:interiors`; root.userData.dynamicStructure = true; parent.add(root);
    const ids = [];
    for (const building of plan.buildings) if (building.interior) {
      const group = new THREE.Group(); group.name = `${building.id}:interior`; group.position.set(building.x, interiorBaseY(building), building.z);
      group.rotation.y = building.yaw; root.add(group);
      const record = { building, group, root, failed: false }; this.buildings.set(building.id, record); ids.push(building.id);
    }
    return () => {
      for (const id of ids) {
        this.buildings.delete(id);
        for (const [key, room] of this.rooms) if (room.buildingId === id) this.releaseRoom(key);
        for (const [key, request] of this.pending) if (request.record.building.id === id) this.pending.delete(key);
      }
      this.ready = this.ready.filter(r => !ids.includes(r.record.building.id)); root.parent?.remove(root);
    };
  }
  releaseRoom(key) {
    const room = this.rooms.get(key); if (!room) return;
    room.group.parent?.remove(room.group); room.group.traverse(o => { o.geometry?.dispose(); }); room.material.dispose(); this.rooms.delete(key);
  }
  update(dt, player, { day = 1, time = 0, xr = false, budgetMs = POLICY.assemblyMs, enabled = true, decorations = true } = {}) {
    if (this.disposed) return;
    const start = performance.now(); this.elapsed += Math.max(0, dt);
    const previous = this.lastPlayer;
    const velocity = previous && dt > 0 ? { x: (player.x - previous.x) / dt, z: (player.z - previous.z) / dt } : { x: 0, z: 0 };
    if (Math.hypot(velocity.x, velocity.z) > 9) { velocity.x = 0; velocity.z = 0; }
    this.lastPlayer = { x: player.x, z: player.z };
    const wanted = new Map(), requests = [];
    const queued = new Set([...this.pending.values(), ...this.ready].map(r => r.room.id));
    if (enabled) for (const candidate of desiredInteriorRooms([...this.buildings.values()].map(r => r.building), player, velocity)) {
      const { building, room, full, inside, priority } = candidate;
      wanted.set(room.id, { full, inside });
      const record = this.buildings.get(building.id);
      if (!this.rooms.has(room.id) && !record.failed && !queued.has(room.id)) requests.push({ record, room, priority });
    }
    for (const request of requests.slice(0, Math.max(0, 2 - this.pending.size - this.ready.length))) {
      const id = ++this.sequence;
      if (this.worker) {
        try { this.pending.set(id, request); this.worker.postMessage({ id, building: request.record.building, roomId: request.room.id }); }
        catch { this.pending.delete(id); this.ready.push({ ...request, data: null }); this.metrics.failures++; }
      }
      else this.ready.push({ ...request, data: null });
    }
    // One room upload per frame, within the remaining settlement allowance.
    if (budgetMs > 0 && this.ready.length && performance.now() - start < budgetMs) {
      const request = this.ready.shift();
      if (this.buildings.has(request.record.building.id) && wanted.has(request.room.id)) {
        try { request.data ||= prepareInteriorRoom(request.record.building, request.room.id); }
        catch (error) { request.record.failed = true; this.metrics.failures++; console.warn('[interior]', error); return; }
        const needed = [request.data.major, request.data.decoration].reduce((n, data) => n + Object.values(data).reduce((s, a) => s + a.byteLength, 0), 0);
        // Evict retained rooms before admitting another preview. The occupied
        // building is always first in the bounded admission list.
        const cold = [...this.rooms].filter(([key]) => !wanted.has(key)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        let used = [...this.rooms.values()].reduce((n, room) => n + room.bytes, 0);
        while (cold.length && (this.rooms.size >= POLICY.maxWarmRooms || used + needed > POLICY.maxBytes)) {
          const [key, room] = cold.shift(); used -= room.bytes; this.releaseRoom(key);
        }
        if (this.rooms.size >= POLICY.maxWarmRooms || used + needed > POLICY.maxBytes) return;
        const group = new THREE.Group(); group.name = request.room.id; group.visible = false;
        const mat = roomMaterial(request.room, request.record.building, request.data.fixtures);
        let bytes = 0, triangles = 0, detail = null;
        for (const [tier, data] of Object.entries({ major: request.data.major, decoration: request.data.decoration })) {
          if (!data.position.length) continue;
          const mesh = new THREE.Mesh(geometry(data), mat); mesh.receiveShadow = true; mesh.castShadow = false;
          mesh.name = `${request.room.id}:${tier}`; group.add(mesh);
          bytes += Object.values(data).reduce((n, a) => n + a.byteLength, 0); triangles += data.position.length / 9;
          if (tier === 'decoration') detail = mesh;
        }
        request.record.group.add(group);
        this.rooms.set(request.room.id, { buildingId: request.record.building.id, group, detail, material: mat,
          fixtures: request.data.fixtures, bytes, triangles, lastSeen: this.elapsed, pinned: false, nightLightStart: null });
      }
    }
    let bytes = 0, triangles = 0, active = 0;
    for (const [key, room] of this.rooms) {
      const interest = wanted.get(key);
      // Fade lighting only when a dark room first appears (including cached
      // reentry). Geometry and disappearance keep their existing behavior.
      if (interest && !room.group.visible) room.nightLightStart = day < NIGHT_LIGHT_FADE_DAY_MAX ? this.elapsed : null;
      room.group.visible = !!interest; room.pinned = !!interest?.inside;
      if (interest) { room.lastSeen = this.elapsed; active++; triangles += room.triangles;
        if (room.detail) room.detail.visible = decorations && interest.full && (!xr || interest.inside);
        const u = room.material.userData.interiorUniforms; u.uInteriorDay.value = day; u.uInteriorTime.value = time;
        if (day >= NIGHT_LIGHT_FADE_DAY_MAX) room.nightLightStart = null;
        u.uInteriorLightReveal.value = room.nightLightStart === null ? 1
          : THREE.MathUtils.smoothstep((this.elapsed - room.nightLightStart) / NIGHT_LIGHT_FADE_SECONDS, 0, 1);
        u.uInteriorLamps.value.set(room.fixtures[0] ? 0.25 + (1 - day) * 1.25 : 0, room.fixtures[1] ? 0.2 + (1 - day) * 1.0 : 0);
      }
      bytes += room.bytes;
      if (!interest && this.elapsed - room.lastSeen > POLICY.retention) this.releaseRoom(key);
    }
    if (this.rooms.size > POLICY.maxWarmRooms || bytes > POLICY.maxBytes) {
      const cold = [...this.rooms].filter(([key]) => !wanted.has(key)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [key, room] of cold) { this.releaseRoom(key); bytes -= room.bytes;
        if (this.rooms.size <= POLICY.maxWarmRooms && bytes <= POLICY.maxBytes) break; }
    }
    Object.assign(this.metrics, { activeRooms: active, warmRooms: this.rooms.size - active, pending: this.pending.size + this.ready.length,
      bytes: [...this.rooms.values()].reduce((n, r) => n + r.bytes, 0), triangles, assemblyMs: performance.now() - start });
  }
  dispose() {
    this.disposed = true; this.worker?.terminate(); this.worker = null;
    for (const key of [...this.rooms.keys()]) this.releaseRoom(key);
    for (const record of this.buildings.values()) record.root.parent?.remove(record.root);
    this.buildings.clear(); this.pending.clear(); this.ready.length = 0;
  }
}
