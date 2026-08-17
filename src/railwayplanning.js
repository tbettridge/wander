import * as THREE from 'three';
import { landmarksAround, majorLandmarksAround } from './landmarks.js';
import { caveAnchorsAround } from './cavegen.mjs';
import { planRegionalRailway } from './railwayplanner.mjs';
import { serializeRailwayTerrainPlan } from './railwayterrain.mjs';

const STRUCTURE_COLOURS = Object.freeze({
  surface: new THREE.Color(0x7fe08d),
  cut: new THREE.Color(0xd7a05d),
  fill: new THREE.Color(0xd9cf72),
  bridge: new THREE.Color(0x66c7e8),
  tunnel: new THREE.Color(0xb78bea),
});

function disposeObject(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose?.();
  });
}

function buildAlignmentPreview(plan) {
  const count = plan.points.length;
  const positions = new Float32Array(count * 2 * 3);
  const colours = new Float32Array(count * 2 * 3);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const a = plan.points[i], b = plan.points[j];
    const colour = STRUCTURE_COLOURS[a.structure] || STRUCTURE_COLOURS.surface;
    const offset = i * 6;
    positions[offset] = a.x;
    positions[offset + 1] = a.formationY + 2.2;
    positions[offset + 2] = a.z;
    positions[offset + 3] = b.x;
    positions[offset + 4] = b.formationY + 2.2;
    positions[offset + 5] = b.z;
    colours.set([colour.r, colour.g, colour.b, colour.r, colour.g, colour.b], offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const line = new THREE.LineSegments(geometry, material);
  line.name = 'Regional railway alignment preview';
  line.renderOrder = 50;
  line.frustumCulled = true;
  return line;
}

function buildStationMarker(station) {
  const root = new THREE.Group();
  root.name = `Regional railway ${station.id}`;
  root.position.set(station.x, station.formationY, station.z);
  const postMaterial = new THREE.MeshBasicMaterial({ color: 0xf2eee0, toneMapped: false });
  const capMaterial = new THREE.MeshBasicMaterial({ color: 0xe5a94e, toneMapped: false });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.48, 8, 8), postMaterial);
  post.position.y = 4;
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), capMaterial);
  cap.position.y = 8.6;
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.28, 0.28), postMaterial);
  crossbar.position.y = 6.7;
  crossbar.rotation.y = Math.atan2(station.tangentX, station.tangentZ);
  root.add(post, cap, crossbar);
  return root;
}

function structureSummary(structures) {
  return ['cut', 'fill', 'bridge', 'tunnel']
    .map((kind) => `${kind} ${structures[kind].count}`)
    .join(' · ');
}

export class RegionalRailwayPreview {
  constructor(scene, world, controls, {
    center = { x: 0, z: 0 },
    seed = world.seed ?? 1,
    radius = 3400,
    searchRadius = 9000,
    onBeforeTravel = null,
    onAfterTravel = null,
    onTerrainPlan = null,
    onTrackPlan = null,
    onTrackVisibility = null,
    onServicePlan = null,
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.requestedCenter = { x: center.x, z: center.z };
    this.seed = seed >>> 0;
    this.radius = radius;
    this.searchRadius = searchRadius;
    this.onBeforeTravel = onBeforeTravel;
    this.onAfterTravel = onAfterTravel;
    this.onTerrainPlan = onTerrainPlan;
    this.onTrackPlan = onTrackPlan;
    this.onTrackVisibility = onTrackVisibility;
    this.onServicePlan = onServicePlan;
    this.plan = null;
    this.preview = null;
    this.stationIndex = -1;
    this.exclusions = [];
    this.caveExclusions = [];
    this.debug = {
      // The coloured survey line is useful for diagnosis, but the production
      // track should be the ordinary view once Phase 4 geometry is active.
      enabled: false,
      terrainEnabled: true,
      trackEnabled: true,
      stationCount: 5,
      status: 'not generated',
      structures: '—',
      generate: () => this.generate(),
      jumpToPlan: () => this._tracedJump('jump to first station', () => this.jumpToPlan()),
      previousStation: () => this._tracedJump('← previous station', () => this.previousStation()),
      nextStation: () => this._tracedJump('next station →', () => this.nextStation()),
      printPlan: () => this.printPlan(),
    };
  }

  clearPreview() {
    if (!this.preview) return;
    this.scene.remove(this.preview);
    disposeObject(this.preview);
    this.preview = null;
  }

  setVisible(visible) {
    this.debug.enabled = !!visible;
    if (this.preview) this.preview.visible = this.debug.enabled;
  }

  setTerrainEnabled(enabled) {
    this.debug.terrainEnabled = !!enabled;
    if (!this.plan) return;
    this.onTerrainPlan?.(
      this.debug.terrainEnabled ? serializeRailwayTerrainPlan(this.plan) : null,
      this.debug.terrainEnabled ? this.plan : null,
    );
  }

  setTrackEnabled(enabled) {
    this.debug.trackEnabled = !!enabled;
    this.onTrackVisibility?.(this.debug.trackEnabled);
  }

  setRegion({ world = this.world, seed = world.seed, center = this.requestedCenter } = {}) {
    this.world = world;
    this.seed = (Number(seed) || 0) >>> 0;
    this.requestedCenter = { x: Number(center?.x) || 0, z: Number(center?.z) || 0 };
    this.plan = null;
    this.stationIndex = -1;
    this.exclusions.length = 0;
    this.caveExclusions.length = 0;
    this.clearPreview();
    this.debug.status = 'region ready · railway not generated';
    this.debug.structures = '—';
    return this;
  }

  generate() {
    // Remove the previous modifier before surveying so regeneration never
    // plans against its own old cuttings and embankments.
    this.onTerrainPlan?.(null, null);
    this.onTrackPlan?.(null);
    this.onServicePlan?.(null);
    this.clearPreview();
    landmarksAround(
      this.world,
      this.requestedCenter.x,
      this.requestedCenter.z,
      this.seed,
      14500,
      this.exclusions,
    );
    majorLandmarksAround(
      this.world,
      this.requestedCenter.x,
      this.requestedCenter.z,
      this.seed,
      14500,
      this.exclusions,
      true,
    );
    caveAnchorsAround(
      this.world,
      this.requestedCenter.x,
      this.requestedCenter.z,
      this.seed,
      14500,
      this.caveExclusions,
    );
    for (const cave of this.caveExclusions) {
      this.exclusions.push({ x: cave.x, z: cave.z, halo: 55, type: 'cave' });
    }
    this.plan = planRegionalRailway(this.world, {
      center: this.requestedCenter,
      seed: this.seed ^ 0x5241494c,
      stationCount: this.debug.stationCount,
      radius: this.radius,
      searchRadius: this.searchRadius,
      exclusions: this.exclusions,
    });
    const group = this.preview = new THREE.Group();
    group.name = 'Regional railway survey overlay';
    group.add(buildAlignmentPreview(this.plan));
    for (const station of this.plan.stations) group.add(buildStationMarker(station));
    group.visible = this.debug.enabled;
    this.scene.add(group);
    if (this.debug.terrainEnabled) {
      this.onTerrainPlan?.(serializeRailwayTerrainPlan(this.plan), this.plan);
    }
    this.onTrackPlan?.(this.plan);
    this.onServicePlan?.(this.plan);
    this.stationIndex = -1;
    const metrics = this.plan.metrics;
    this.debug.status = `${(metrics.length / 1000).toFixed(1)}km · ${this.plan.stations.length} stations · ${(metrics.maxGrade * 100).toFixed(1)}% max · ${metrics.planningMs.toFixed(0)}ms`;
    this.debug.structures = structureSummary(metrics.structures);
    return this.plan;
  }

  // Wraps the debug-panel station buttons so a click that "does nothing" can be
  // told apart from a click that never arrived. Under pointer lock the browser
  // routes every mouse event to the locked canvas, so the button may not be
  // reachable at all; if it is, this reports where the jump actually put us.
  _tracedJump(label, run) {
    const before = this.controls.rig.position.clone();
    const locked = typeof document !== 'undefined' ? !!document.pointerLockElement : null;
    console.log('[station] button invoked', {
      label,
      pointerLocked: locked,
      activeElement: typeof document !== 'undefined' ? document.activeElement?.tagName : null,
      from: [Math.round(before.x), Math.round(before.z)],
      stationIndex: this.stationIndex,
      hasPlan: !!this.plan,
    });
    try {
      const station = run();
      const after = this.controls.rig.position;
      console.log('[station] jump complete', {
        label,
        stationIndex: this.stationIndex,
        to: [Math.round(after.x), Math.round(after.z)],
        movedMetres: Math.round(before.distanceTo(after)),
        status: this.debug.status,
      });
      // Debug-panel travel is a direct user gesture. Give the host a
      // synchronous seam to restore pointer lock before that activation is
      // consumed; otherwise clicking a station button leaves desktop controls
      // suspended after the jump.
      this.onAfterTravel?.({ label, station });
      return station;
    } catch (error) {
      console.error('[station] jump threw', { label, error });
      throw error;
    }
  }

  jumpToStation(index) {
    if (!this.plan) this.generate();
    const count = this.plan.stations.length;
    this.stationIndex = ((index % count) + count) % count;
    const station = this.plan.stations[this.stationIndex];
    this.onBeforeTravel?.();
    const rightX = station.tangentZ, rightZ = -station.tangentX;
    const x = station.x + rightX * 7;
    const z = station.z + rightZ * 7;
    this.controls.place(x, z);
    this.controls.yaw = Math.atan2(x - station.x, z - station.z);
    this.debug.status = `station ${this.stationIndex + 1}/${count} · ${station.biome} · ${(this.plan.metrics.length / 1000).toFixed(1)}km loop`;
    return station;
  }

  jumpToPlan() {
    return this.jumpToStation(0);
  }

  nextStation() {
    return this.jumpToStation(this.stationIndex + 1);
  }

  previousStation() {
    return this.jumpToStation(this.stationIndex < 0 ? 0 : this.stationIndex - 1);
  }

  printPlan() {
    if (!this.plan) this.generate();
    console.table(this.plan.stations.map((station) => ({
      station: station.index + 1,
      biome: station.biome,
      x: Math.round(station.x),
      z: Math.round(station.z),
      slope: +(station.slope * 100).toFixed(2),
      routeKm: +(station.routeDistance / 1000).toFixed(2),
    })));
    console.log('Regional railway plan', this.plan.metrics, this.plan);
    return this.plan;
  }
}
