import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { villageNightLevel } from './villagelighting.mjs';
import {
  NPC_JOURNEY_LANTERN as P, createJourneyLanternPool, stepJourneyLanternPool,
  journeyLanternBeaconLevel, outsideLanternVillages, walkingLanternTraveller,
} from './npcjourneylantern.mjs';

const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
function lanternHousing() {
  const parts = [];
  const add = (geometry, x, y, z) => { geometry.translate(x, y, z); parts.push(geometry); };
  add(new THREE.CylinderGeometry(.075, .075, .028, 8), 0, -.10, 0);
  add(new THREE.CylinderGeometry(.075, .09, .035, 8), 0, -.31, 0);
  add(new THREE.ConeGeometry(.085, .065, 8), 0, -.065, 0);
  for (const x of [-.055, .055]) for (const z of [-.055, .055]) add(new THREE.BoxGeometry(.012, .20, .012), x, -.205, z);
  add(new THREE.TorusGeometry(.047, .009, 4, 10, Math.PI), 0, -.025, 0);
  const geometry = mergeGeometries(parts); parts.forEach(g => g.dispose()); return geometry;
}
function visibleRoot(root) {
  if (!root?.parent) return false;
  for (let p = root; p; p = p.parent) if (!p.visible) return false;
  return true;
}
export class NpcJourneyLanternSystem {
  constructor(scene, { groundAt = () => 0 } = {}) {
    this.scene = scene; this.groundAt = groundAt; this.enabled = true;
    this.models = new Map(); this.groundCache = new Map(); this.pool = createJourneyLanternPool(); this.time = 0;
    this.housing = lanternHousing(); this.flame = new THREE.CylinderGeometry(.038, .048, .15, 8); this.flame.translate(0, -.205, 0);
    this.metal = new THREE.MeshStandardMaterial({ color: 0x564132, metalness: .45, roughness: .65 });
    this.warmFlame = new THREE.Color(0xffd19a);
    this.fire = new THREE.MeshBasicMaterial({ color: 0xffd19a, toneMapped: false });
    this.lights = this.pool.map((_, i) => {
      const light = new THREE.PointLight(0xffd29a, 0, P.lightRange, 2);
      light.name = `NPC journey lantern light ${i + 1}`; light.castShadow = false; scene.add(light); return light;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P.maxBeacons * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('lanternAlpha', new THREE.BufferAttribute(new Float32Array(P.maxBeacons), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: 1 } }, transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
      vertexShader: `attribute float lanternAlpha; varying float glowAlpha; uniform float pixelRatio;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); glowAlpha = lanternAlpha;
          gl_Position = projectionMatrix * p; gl_PointSize = clamp(2.5 + 18.0 / max(1.0, -p.z), 2.5, 9.0) * pixelRatio; }`,
      fragmentShader: `varying float glowAlpha;
        void main() { vec2 p = gl_PointCoord - vec2(0.5); float r = dot(p, p); if (r > 0.25) discard;
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.36), glowAlpha * exp(-r * 18.0)); }`,
    });
    this.beacons = new THREE.Points(geometry, material); this.beacons.name = 'Distant NPC journey lanterns';
    this.beacons.frustumCulled = false; this.beacons.renderOrder = 4; scene.add(this.beacons);
    this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4(); this.sphere = new THREE.Sphere();
    this.debug = { slots: this.lights.length, active: 0, beacons: 0, carried: 0, night: 0 };
  }
  removeModel(id) {
    const model = this.models.get(id);
    if (!model) return;
    model.avatar.setJourneyLantern(null); model.root.removeFromParent(); this.models.delete(id);
  }
  clear() {
    for (const id of [...this.models.keys()]) this.removeModel(id);
    this.groundCache.clear(); this.beacons.geometry.setDrawRange(0, 0);
    for (const slot of this.pool) { slot.id = null; slot.source = null; slot.level = 0; }
    this.lights.forEach(l => l.intensity = 0);
    Object.assign(this.debug, { active: 0, beacons: 0, carried: 0 });
  }
  update(dt, viewer, { night = 0, xr = false, enabled = true, actors = [], travellers = [], entities = {}, sites = [], camera = null, pixelRatio = 1 } = {}) {
    const level = enabled && this.enabled ? villageNightLevel(night) : 0;
    this.fire.color.copy(this.warmFlame).multiplyScalar(level);
    this.time += Math.max(0, dt); let groundSamples = 0;
    const candidates = new Map();
    if (level > .001) {
      for (const point of travellers) if (point.journey === true && point.mode === 'walk' && !point.railPhase && !point.seated) candidates.set(point.id, { ...point });
      for (const actor of actors) {
        const id = actor.identity?.id; if (!id || actor.sharedReplicaMissing) continue;
        if (!candidates.has(id) && !walkingLanternTraveller(actor, entities[id])) continue;
        const root = actor.avatar?.root, pose = actor.mobilityPose;
        const remote = actor.remotePose;
        const point = candidates.get(id) || (pose ? { ...pose } : remote ? { ...remote } : actor.roaming
          ? { x: actor.journey.x, z: actor.journey.z, y: root?.position.y, heading: actor.journey.heading }
          : root?.position);
        if (!point) continue;
        const entry = { ...point, id, avatar: actor.avatar };
        if (visibleRoot(root)) {
          root.getWorldPosition(position); entry.x = position.x; entry.y = position.y; entry.z = position.z;
        }
        if (Math.hypot(entry.x - viewer.x, entry.z - viewer.z) >= P.beaconRange) continue;
        // Distant legacy travellers keep moving without ground/gait work. Only
        // a few cached terrain heights are refreshed per frame for their glow.
        if (actor.roaming && !visibleRoot(root)) {
          let cached = this.groundCache.get(id);
          if ((!cached || this.time - cached.time > .5) && groundSamples < 4) {
            cached = { y: this.groundAt(entry.x, entry.z), time: this.time }; this.groundCache.set(id, cached); groundSamples++;
          }
          entry.y = cached?.y ?? entry.y;
        }
        candidates.set(id, entry);
      }
    }
    const selected = [...candidates.values()].filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
      && Math.hypot(p.x - viewer.x, p.z - viewer.z) < P.beaconRange && outsideLanternVillages(p, sites))
      .sort((a, b) => Math.hypot(a.x - viewer.x, a.z - viewer.z) - Math.hypot(b.x - viewer.x, b.z - viewer.z) || a.id.localeCompare(b.id))
      .slice(0, P.maxBeacons);
    const keep = new Set(); const sources = [];
    const positions = this.beacons.geometry.attributes.position, alpha = this.beacons.geometry.attributes.lanternAlpha;
    if (camera) {
      camera.updateWorldMatrix(true, false); this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.projection);
    }
    for (let i = 0; i < selected.length; i++) {
      const traveller = selected[i], avatar = traveller.avatar;
      position.set(traveller.x, traveller.y + .9, traveller.z);
      if (avatar?.setJourneyLantern && visibleRoot(avatar.root)) {
        let model = this.models.get(traveller.id);
        if (model && model.avatar !== avatar) { this.removeModel(traveller.id); model = null; }
        if (!model) {
          const root = new THREE.Group(); root.name = 'NPC carried journey lantern';
          root.add(new THREE.Mesh(this.housing, this.metal), new THREE.Mesh(this.flame, this.fire));
          model = { root, avatar }; this.models.set(traveller.id, model);
        }
        avatar.setJourneyLantern(model.root); keep.add(traveller.id);
        // The grip follows the animated wrist; counter-rotation keeps the cage
        // hanging down instead of swinging rigidly through the NPC's elbow.
        model.root.parent.getWorldQuaternion(rotation); model.root.quaternion.copy(rotation.invert());
        model.root.updateWorldMatrix(true, false);
        position.set(0, -.205, 0); model.root.localToWorld(position);
      }
      positions.setXYZ(i, position.x, position.y, position.z);
      const distance = position.distanceTo(viewer);
      const flicker = .97 + .03 * Math.sin(this.time * 11 + i * 2.4);
      alpha.setX(i, level * flicker * journeyLanternBeaconLevel(distance));
      this.sphere.center.copy(position); this.sphere.radius = P.lightRange;
      if (!camera || this.frustum.intersectsSphere(this.sphere)) sources.push({ id: traveller.id, x: position.x, y: position.y, z: position.z });
    }
    for (const id of [...this.models.keys()]) if (!keep.has(id)) this.removeModel(id);
    const selectedIds = new Set(selected.map(p => p.id));
    for (const id of [...this.groundCache.keys()]) if (!selectedIds.has(id)) this.groundCache.delete(id);
    positions.needsUpdate = alpha.needsUpdate = true;
    this.beacons.geometry.setDrawRange(0, selected.length); this.beacons.visible = selected.length > 0;
    this.beacons.material.uniforms.pixelRatio.value = pixelRatio;
    const state = stepJourneyLanternPool(this.pool, sources, viewer, level, dt, { xr, enabled: enabled && this.enabled });
    this.pool.forEach((slot, i) => {
      const light = this.lights[i]; light.intensity = slot.level * P.intensity;
      if (slot.source) light.position.set(slot.source.x, slot.source.y, slot.source.z);
    });
    Object.assign(this.debug, state, { slots: this.lights.length, beacons: selected.length, carried: keep.size, night: level, groundSamples });
    return this.debug;
  }
  dispose() {
    this.clear(); this.lights.forEach(l => l.removeFromParent()); this.beacons.removeFromParent();
    this.beacons.geometry.dispose(); this.beacons.material.dispose(); this.housing.dispose(); this.flame.dispose(); this.metal.dispose(); this.fire.dispose();
  }
}
