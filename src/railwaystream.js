import * as THREE from 'three';
import { baseWorldHeight } from './railwayterrain.mjs';
import {
  buildRailwayTrackTile,
  RailwayTrackIndex,
  serializeRailwayTrackPlan,
} from './railwaystream.mjs';
import {
  collectTunnelRuns,
  buildTunnelRunGeometry,
  tunnelImmersion,
} from './railwaytunnel.mjs';
import {
  dampCaveValue,
  adaptCaveExposure,
  caveExposureTarget,
} from './caveatmosphere.mjs';
import { buildStationGroup, makeSignMaterial } from './railstation.js';
import {
  stationCollisionModel,
  stationContains,
  stationFloorAt,
  stationConstrain,
} from './railstation.mjs';
import { nameRegionalStations } from './railservice.mjs';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();

function meshFromArrays(data, material, name) {
  if (!data) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

function composeTrackMatrix(sample, width, height, length) {
  _forward.set(sample.tangentX, sample.tangentY, sample.tangentZ).normalize();
  _right.set(_forward.z, 0, -_forward.x).normalize();
  _up.crossVectors(_forward, _right).normalize();
  _matrix.makeBasis(_right, _up, _forward);
  _quaternion.setFromRotationMatrix(_matrix);
  _position.set(sample.x, sample.y, sample.z);
  _scale.set(width, height, length);
  _matrix.compose(_position, _quaternion, _scale);
  return _matrix;
}

function disposeTile(root) {
  root.traverse((object) => {
    if (object.userData.railOwnsGeometry) object.geometry?.dispose?.();
  });
  root.removeFromParent();
}

export class RegionalRailwayTrack {
  constructor(scene, world, {
    streamRadius = 3,
    assemblyBudgetMs = 2.0,
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.streamRadius = streamRadius;
    this.assemblyBudgetMs = assemblyBudgetMs;
    this.index = null;
    this.plan = null;
    this.tiles = new Map();
    this.queue = [];
    this.enabled = true;
    // Tunnels are built whole at plan time (a few hundred metres of tube at
    // most), so bore and exit are always resident before a train enters.
    this.tunnelRuns = [];
    this.tunnelGroup = null;
    this._tunnel = {
      factor: 0,
      exposure: 1,
      probe: {},
      fogColor: new THREE.Color(0x0c0d0f),
      surfaceFog: { near: 0, far: 0, color: new THREE.Color() },
    };
    // Station collision: models from the plan, and a single walking environment
    // that reads whichever station the player is currently at.
    this._stationModels = [];
    this._signMaterials = new Map();
    this._activeStation = null;
    this._stationHit = {};
    this._railEnv = { kind: 'none', object: null };
    this._tunnelEnvironment = {
      isIndoor: () => true,
      floorHeight: () => (this._tunnel.probe.sample ? this._tunnel.probe.floorY + 0.10 : undefined),
      constrain: (position) => {
        const s = this._tunnel.probe.sample;
        if (!s || this._tunnel.probe.depth < 1.2) return;
        const lateral = (position.x - s.x) * s.rx + (position.z - s.z) * s.rz;
        const limit = 2.05;
        if (Math.abs(lateral) > limit) {
          const excess = lateral - Math.sign(lateral) * limit;
          position.x -= s.rx * excess;
          position.z -= s.rz * excess;
        }
      },
    };
    this._stationEnvironment = {
      isIndoor: () => false,   // platforms are outdoors: keep jump + normal look
      floorHeight: (x, z) => {
        const m = this._activeStation;
        const terrain = this.world.height(x, z);
        return m ? stationFloorAt(m, x, z, terrain) : terrain;
      },
      constrain: (position) => {
        const m = this._activeStation;
        if (!m) return;
        const r = stationConstrain(m, position.x, position.z, this._stationHit);
        if (r) { position.x = r.x; position.z = r.z; }
      },
    };
    this.materials = {
      shoulder: new THREE.MeshStandardMaterial({ color: 0x67645a, roughness: 1, side: THREE.DoubleSide }),
      rail: new THREE.MeshStandardMaterial({ color: 0x596064, roughness: 0.52, metalness: 0.46 }),
      sleeper: new THREE.MeshStandardMaterial({ color: 0x4c382b, roughness: 0.96 }),
      bridge: new THREE.MeshStandardMaterial({ color: 0x716b60, roughness: 0.92 }),
      masonry: new THREE.MeshStandardMaterial({ color: 0x8a8474, roughness: 0.98, side: THREE.DoubleSide }),
      timber: new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.95, side: THREE.DoubleSide }),
      pier: new THREE.MeshStandardMaterial({ color: 0x777164, roughness: 0.98 }),
      pierTimber: new THREE.MeshStandardMaterial({ color: 0x5c4327, roughness: 0.95 }),
      platform: new THREE.MeshStandardMaterial({ color: 0x8f8672, roughness: 1 }),
      station: new THREE.MeshStandardMaterial({ color: 0x46564b, roughness: 0.9 }),
      // Classic-station palette: brick body, pale stone trim, slate roof, a
      // painted "station green" for joinery, dark glass, and iron lamps.
      brick: new THREE.MeshStandardMaterial({ color: 0x9a5641, roughness: 0.96, side: THREE.DoubleSide }),
      stationTrim: new THREE.MeshStandardMaterial({ color: 0xd6caac, roughness: 0.9 }),
      slate: new THREE.MeshStandardMaterial({ color: 0x3b4348, roughness: 0.86 }),
      stationTimber: new THREE.MeshStandardMaterial({ color: 0x2f5347, roughness: 0.85, side: THREE.DoubleSide }),
      glass: new THREE.MeshStandardMaterial({ color: 0x28323a, roughness: 0.25, metalness: 0.1 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.6, metalness: 0.3 }),
      lantern: new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffca92, emissiveIntensity: 0.9, roughness: 0.4 }),
      // Tunnel lining is deliberately UNLIT: the sun cannot be occluded inside
      // the bore (nothing there casts shadows), so a lit material would render
      // sunlit walls underground. Basic material makes the colour the exact
      // near-dark we want — visible masonry rhythm out a carriage window, fog
      // still applies with distance.
      tunnelLining: new THREE.MeshBasicMaterial({
        color: 0x16130f, side: THREE.DoubleSide,
      }),
      tunnelRib: new THREE.MeshBasicMaterial({
        color: 0x262019, side: THREE.DoubleSide,
      }),
      portal: new THREE.MeshStandardMaterial({
        color: 0x847d6d, roughness: 0.97, side: THREE.DoubleSide,
      }),
    };
    this.sleeperGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.debug = {
      enabled: true,
      streamRadius,
      status: 'no regional track',
    };
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.debug.enabled = this.enabled;
    for (const tile of this.tiles.values()) tile.visible = this.enabled;
    if (this.tunnelGroup) this.tunnelGroup.visible = this.enabled;
  }

  clearTunnels() {
    if (this.tunnelGroup) {
      disposeTile(this.tunnelGroup);
      this.tunnelGroup = null;
    }
    this.tunnelRuns = [];
  }

  buildTunnels(plan) {
    this.clearTunnels();
    this.tunnelRuns = collectTunnelRuns(plan);
    if (!this.tunnelRuns.length) return;
    const group = this.tunnelGroup = new THREE.Group();
    group.name = 'Regional railway tunnels';
    group.visible = this.enabled;
    for (const run of this.tunnelRuns) {
      const data = buildTunnelRunGeometry(run);
      const lining = meshFromArrays(data.lining, this.materials.tunnelLining, `${data.key} lining`);
      const ribs = meshFromArrays(data.ribs, this.materials.tunnelRib, `${data.key} ribs`);
      const portals = meshFromArrays(data.portals, this.materials.portal, `${data.key} portals`);
      for (const mesh of [lining, ribs, portals]) {
        if (!mesh) continue;
        mesh.userData.railOwnsGeometry = true;
        group.add(mesh);
      }
    }
    this.scene.add(group);
  }

  _signMaterialFor(index, name) {
    let material = this._signMaterials.get(index);
    if (!material) {
      material = makeSignMaterial(name);
      this._signMaterials.set(index, material);
    }
    return material;
  }

  _clearSignMaterials() {
    for (const material of this._signMaterials.values()) {
      material.map?.dispose?.();
      material.dispose?.();
    }
    this._signMaterials.clear();
  }

  _stationAt(x, z) {
    for (const model of this._stationModels) {
      if (stationContains(model, x, z)) return model;
    }
    return null;
  }

  /** Install/replace/release the single railway walking environment (tunnel or
   * station), never clobbering a cave's environment. */
  _applyRailEnvironment(controls, want, kind) {
    if (this._railEnv.object === want) return;
    if (this._railEnv.object && controls.environment === this._railEnv.object) {
      controls.setEnvironment(null);
    }
    if (want) controls.setEnvironment(want);
    this._railEnv = { kind, object: want };
  }

  setStreamRadius(radius) {
    this.streamRadius = Math.max(1, Math.round(radius));
    this.debug.streamRadius = this.streamRadius;
  }

  clear() {
    for (const tile of this.tiles.values()) disposeTile(tile);
    this.tiles.clear();
    this.queue.length = 0;
  }

  setPlan(plan = null) {
    const spec = serializeRailwayTrackPlan(plan);
    if ((this.index?.signature || null) === (spec?.signature || null)) return false;
    this.clear();
    this.plan = plan;
    this.index = spec ? new RailwayTrackIndex(spec) : null;
    this.buildTunnels(plan && this.index ? plan : null);
    // Station collision + names (deterministic, so independent of the service).
    this._clearSignMaterials();
    this._stationModels = [];
    if (plan?.stations?.length) {
      nameRegionalStations(plan, { world: this.world, seed: plan.seed });
      this._stationModels = plan.stations.map(stationCollisionModel);
    }
    this.debug.status = this.index
      ? `${(this.index.routeLength / 1000).toFixed(1)}km alignment · ${this.tunnelRuns.length} tunnels · awaiting nearby tiles`
      : 'no regional track';
    return true;
  }

  /**
   * Per-frame tunnel presence: dims and quiets the world through the bore by
   * merging into the shared cave-atmosphere signal, closes the fog in, and
   * gives a walking player a floor and side limits inside the bore. Riding is
   * covered by the same path — the rig tracks the seat through the tunnel.
   */
  updateTunnelPresence(dt, controls, caveActive, fog, atmosphere) {
    const state = this._tunnel;
    const rig = controls.rig.position;
    const probe = this.tunnelRuns.length
      ? tunnelImmersion(this.tunnelRuns, rig.x, rig.y + 1.2, rig.z, state.probe)
      : { factor: 0, engaged: false };
    const blendDt = Math.min(Math.max(0, dt), 0.10);
    state.factor = dampCaveValue(state.factor, probe.factor, blendDt,
      probe.factor > state.factor ? 0.9 : 0.8);
    state.exposure = adaptCaveExposure(state.exposure,
      caveExposureTarget(state.factor * 0.85), blendDt);
    if (state.factor < 0.003 && probe.factor === 0) state.factor = 0;

    if (atmosphere) {
      if (state.factor > atmosphere.factor) atmosphere.factor = state.factor;
      atmosphere.exposureScale = Math.max(atmosphere.exposureScale, state.exposure);
    }
    if (fog && state.factor > 0.003) {
      // Applied after the cave's own fog pass; in a tunnel the cave factor is
      // ~0, so this is the only underground fog acting on the frame.
      fog.color.lerp(state.fogColor, state.factor);
      fog.near = THREE.MathUtils.lerp(fog.near, 26, state.factor);
      fog.far = THREE.MathUtils.lerp(fog.far, 170, state.factor);
    }

    // Walking support: give the player the right floor + collision for where
    // they are — the tunnel bore, a station platform/building, or nothing —
    // without ever overriding a cave's environment.
    let want = null, kind = 'none';
    this._activeStation = null;
    if (!caveActive && controls.enabled) {
      if (probe.engaged) {
        want = this._tunnelEnvironment; kind = 'tunnel';
      } else {
        this._activeStation = this._stationAt(rig.x, rig.z);
        if (this._activeStation) { want = this._stationEnvironment; kind = 'station'; }
      }
    }
    this._applyRailEnvironment(controls, want, kind);
    return state.factor;
  }

  desiredEntries(px, pz) {
    if (!this.index) return [];
    const size = this.index.tileSize;
    const pcx = Math.floor(px / size), pcz = Math.floor(pz / size);
    const desired = [];
    for (let dz = -this.streamRadius; dz <= this.streamRadius; dz++) {
      for (let dx = -this.streamRadius; dx <= this.streamRadius; dx++) {
        if (dx * dx + dz * dz > this.streamRadius * this.streamRadius + 1) continue;
        const entry = this.index.entry(pcx + dx, pcz + dz);
        if (entry) desired.push({ ...entry, distanceSq: dx * dx + dz * dz });
      }
    }
    desired.sort((a, b) => a.distanceSq - b.distanceSq);
    return desired;
  }

  buildTile(entry) {
    const data = buildRailwayTrackTile(this.index, entry.ix, entry.iz, {
      groundHeightAt: (x, z) => baseWorldHeight(this.world, x, z),
    });
    if (!data) return null;
    const root = new THREE.Group();
    root.name = `Regional railway tile ${data.key}`;
    root.visible = this.enabled;
    const ballast = meshFromArrays(data.ballast, this.materials.shoulder, 'railway ballast');
    const rails = meshFromArrays(data.rails, this.materials.rail, 'railway rails');
    const bridge = meshFromArrays(data.bridge, this.materials.bridge, 'railway bridge deck');
    const masonry = meshFromArrays(data.masonry, this.materials.masonry, 'railway masonry');
    const timberwork = meshFromArrays(data.timber, this.materials.timber, 'railway timberwork');
    for (const mesh of [ballast, rails, bridge, masonry, timberwork]) {
      if (!mesh) continue;
      mesh.userData.railOwnsGeometry = true;
      root.add(mesh);
    }

    if (data.sleepers.length) {
      const sleepers = new THREE.InstancedMesh(
        this.sleeperGeometry, this.materials.sleeper, data.sleepers.length,
      );
      sleepers.name = 'railway sleepers';
      for (let i = 0; i < data.sleepers.length; i++) {
        sleepers.setMatrixAt(i, composeTrackMatrix(data.sleepers[i], 2.45, 0.12, 0.21));
      }
      sleepers.instanceMatrix.needsUpdate = true;
      sleepers.computeBoundingSphere();
      sleepers.receiveShadow = true;
      root.add(sleepers);
    }

    if (data.piers.length) {
      // Split supports by family so stone piers and timber bents take their own
      // material; both are seated on the ground the tile builder found.
      const stonePiers = data.piers.filter((p) => p.family !== 1);
      const timberPiers = data.piers.filter((p) => p.family === 1);
      const pierGroups = [
        { list: stonePiers, material: this.materials.pier, width: 2.8, name: 'railway stone piers' },
        { list: timberPiers, material: this.materials.pierTimber, width: 1.5, name: 'railway timber bents' },
      ];
      for (const { list, material, width, name } of pierGroups) {
        if (!list.length) continue;
        const piers = new THREE.InstancedMesh(this.unitBoxGeometry, material, list.length);
        piers.name = name;
        for (let i = 0; i < list.length; i++) {
          const pier = list[i], height = pier.topY - pier.bottomY;
          piers.setMatrixAt(i, composeTrackMatrix({
            ...pier, y: pier.bottomY + height * 0.5,
          }, width, height, 0.95));
        }
        piers.instanceMatrix.needsUpdate = true;
        piers.computeBoundingSphere();
        piers.receiveShadow = true;
        root.add(piers);
      }
    }

    for (const station of data.stations) {
      // A full classic station, built in local space and oriented so +Z runs
      // with the track. Collision comes from the matching model (see setPlan).
      const name = this.plan?.stations?.[station.index]?.name;
      const signMaterial = this._signMaterialFor(station.index, name);
      const group = buildStationGroup(station, name, this.materials, signMaterial);
      group.position.set(station.x, station.y, station.z);
      group.rotation.y = Math.atan2(station.tangentX, station.tangentZ);
      root.add(group);
    }
    this.scene.add(root);
    return root;
  }

  update(px, pz) {
    if (!this.index) return;
    const desired = this.desiredEntries(px, pz);
    const desiredKeys = new Set(desired.map((entry) => `${entry.ix},${entry.iz}`));
    for (const [key, tile] of this.tiles) {
      if (!desiredKeys.has(key)) {
        disposeTile(tile);
        this.tiles.delete(key);
      }
    }
    const queued = new Set(this.queue.map((entry) => `${entry.ix},${entry.iz}`));
    for (const entry of desired) {
      const key = `${entry.ix},${entry.iz}`;
      if (!this.tiles.has(key) && !queued.has(key)) this.queue.push(entry);
    }
    this.queue = this.queue.filter((entry) => desiredKeys.has(`${entry.ix},${entry.iz}`));
    this.queue.sort((a, b) => a.distanceSq - b.distanceSq);

    const started = performance.now();
    let built = 0;
    while (this.queue.length && built < 1 && performance.now() - started < this.assemblyBudgetMs) {
      const entry = this.queue.shift(), key = `${entry.ix},${entry.iz}`;
      if (this.tiles.has(key)) continue;
      const tile = this.buildTile(entry);
      if (tile) this.tiles.set(key, tile);
      built++;
    }
    this.debug.status = `${this.tiles.size} nearby tiles · ${this.queue.length} queued · ${(this.index.routeLength / 1000).toFixed(1)}km loop`;
  }

  dispose() {
    this.clear();
    this.clearTunnels();
    this._clearSignMaterials();
    this.sleeperGeometry.dispose();
    this.unitBoxGeometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
