import * as THREE from 'three';
import { baseWorldHeight } from './railwayterrain.mjs';
import {
  buildRailwayTrackTile,
  RailwayTrackIndex,
  serializeRailwayTrackPlan,
} from './railwaystream.mjs';

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

function composeStationMatrix(station, across, y, width, height, length) {
  const rightX = station.tangentZ, rightZ = -station.tangentX;
  const yaw = Math.atan2(station.tangentX, station.tangentZ);
  _position.set(station.x + rightX * across, station.y + y, station.z + rightZ * across);
  _quaternion.setFromAxisAngle(_up.set(0, 1, 0), yaw);
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
    this.materials = {
      shoulder: new THREE.MeshStandardMaterial({ color: 0x67645a, roughness: 1 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x596064, roughness: 0.52, metalness: 0.46 }),
      sleeper: new THREE.MeshStandardMaterial({ color: 0x4c382b, roughness: 0.96 }),
      bridge: new THREE.MeshStandardMaterial({ color: 0x716b60, roughness: 0.92 }),
      pier: new THREE.MeshStandardMaterial({ color: 0x777164, roughness: 0.98 }),
      platform: new THREE.MeshStandardMaterial({ color: 0x8a806c, roughness: 1 }),
      station: new THREE.MeshStandardMaterial({ color: 0x46564b, roughness: 0.9 }),
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
    this.debug.status = this.index
      ? `${(this.index.routeLength / 1000).toFixed(1)}km alignment · awaiting nearby tiles`
      : 'no regional track';
    return true;
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
    for (const mesh of [ballast, rails, bridge]) {
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
      const piers = new THREE.InstancedMesh(this.unitBoxGeometry, this.materials.pier, data.piers.length);
      piers.name = 'railway bridge piers';
      for (let i = 0; i < data.piers.length; i++) {
        const pier = data.piers[i], height = pier.topY - pier.bottomY;
        piers.setMatrixAt(i, composeTrackMatrix({
          ...pier, y: pier.bottomY + height * 0.5,
        }, 2.8, height, 0.95));
      }
      piers.instanceMatrix.needsUpdate = true;
      piers.computeBoundingSphere();
      piers.receiveShadow = true;
      root.add(piers);
    }

    if (data.stations.length) {
      const platforms = new THREE.InstancedMesh(
        this.unitBoxGeometry, this.materials.platform, data.stations.length * 2,
      );
      platforms.name = 'regional station platforms';
      let instance = 0;
      for (const station of data.stations) {
        platforms.setMatrixAt(instance++, composeStationMatrix(
          station, -3.25, 0.17, station.width, 0.34, station.length,
        ));
        platforms.setMatrixAt(instance++, composeStationMatrix(
          station, 3.25, 0.17, station.width, 0.34, station.length,
        ));
        const shelter = new THREE.Mesh(this.unitBoxGeometry, this.materials.station);
        shelter.name = `station ${station.index + 1} shelter`;
        shelter.matrixAutoUpdate = false;
        shelter.matrix.copy(composeStationMatrix(station, 4.2, 2.35, 3.0, 0.16, 9.5));
        root.add(shelter);
      }
      platforms.instanceMatrix.needsUpdate = true;
      platforms.computeBoundingSphere();
      platforms.receiveShadow = true;
      root.add(platforms);
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
    this.sleeperGeometry.dispose();
    this.unitBoxGeometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
