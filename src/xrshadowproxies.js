// XR-only shadow caster simplification. The ordinary scene remains on layer 0;
// these coarse tree/landmark volumes live on layer 2 and are seen only by the
// sun's shadow camera while WebXR is presenting. This keeps recognisable moving
// shade without sending alpha-tested leaves or detailed branches through the
// shadow pass.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IMPOSTOR_TYPES } from './vegdata.js';
import { XR_SHADOW_LAYER } from './xrlayers.mjs';

export { XR_SHADOW_LAYER } from './xrlayers.mjs';

const PROXY_TYPES = new Set([...IMPOSTOR_TYPES, 'cactus', 'deadtree']);

function nonIndexed(geometry) {
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

function cylinder(radiusTop, radiusBottom, height, y, sides = 6) {
  const geometry = new THREE.CylinderGeometry(
    Math.max(0.03, radiusTop), Math.max(0.03, radiusBottom),
    Math.max(0.05, height), sides, 1, false,
  );
  geometry.translate(0, y, 0);
  return nonIndexed(geometry);
}

function ellipsoid(rx, ry, rz, x, y, z) {
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.scale(Math.max(0.05, rx), Math.max(0.05, ry), Math.max(0.05, rz));
  geometry.translate(x, y, z);
  return nonIndexed(geometry);
}

function makeVegetationProxyGeometry(entry, type) {
  const source = entry.geo;
  source.computeBoundingBox();
  const bounds = source.boundingBox;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);
  const height = Math.max(0.35, size.y);
  const radius = Math.max(0.18, Math.max(size.x, size.z) * 0.5);
  const baseY = bounds.min.y;
  const parts = [];

  if (type === 'conifer') {
    parts.push(cylinder(radius * 0.12, radius * 0.17, height * 0.72,
      baseY + height * 0.36, 5));
    const crown = new THREE.ConeGeometry(radius * 0.92, height * 0.78, 6, 1, false);
    crown.translate(center.x, baseY + height * 0.58, center.z);
    parts.push(nonIndexed(crown));
  } else if (type === 'palm') {
    parts.push(cylinder(radius * 0.08, radius * 0.13, height * 0.84,
      baseY + height * 0.42, 5));
    parts.push(ellipsoid(radius, height * 0.10, radius,
      center.x, baseY + height * 0.88, center.z));
  } else if (type === 'cactus') {
    parts.push(cylinder(radius * 0.34, radius * 0.42, height * 0.94,
      baseY + height * 0.47, 6));
  } else if (type === 'deadtree') {
    parts.push(cylinder(radius * 0.10, radius * 0.24, height * 0.92,
      baseY + height * 0.46, 5));
  } else if (type === 'poplar') {
    parts.push(cylinder(radius * 0.10, radius * 0.15, height * 0.62,
      baseY + height * 0.31, 5));
    parts.push(ellipsoid(radius * 0.72, height * 0.39, radius * 0.72,
      center.x, baseY + height * 0.66, center.z));
  } else if (type === 'baobab') {
    parts.push(cylinder(radius * 0.30, radius * 0.45, height * 0.64,
      baseY + height * 0.32, 6));
    parts.push(ellipsoid(radius, height * 0.24, radius * 0.92,
      center.x, baseY + height * 0.73, center.z));
  } else {
    // Broadleaf, oak, birch, willow, blossom and dry/acacia trees: one trunk
    // prism and one low-poly crown approximate the important shadow masses.
    const flatCrown = type === 'drytree' ? 0.19 : type === 'willow' ? 0.34 : 0.29;
    parts.push(cylinder(radius * 0.09, radius * 0.17, height * 0.64,
      baseY + height * 0.32, 5));
    parts.push(ellipsoid(radius, height * flatCrown, radius * 0.92,
      center.x, baseY + height * 0.69, center.z));
  }

  const geometry = mergeGeometries(parts, false);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function setShadowLayer(object) {
  object.traverse((child) => child.layers.set(XR_SHADOW_LAYER));
  return object;
}

export class XRShadowProxySystem {
  constructor(scene, library) {
    this.scene = scene;
    this.library = library;
    this.enabled = false;
    this.root = new THREE.Group();
    this.root.name = 'xr-shadow-proxies';
    this.root.visible = false;
    scene.add(this.root);

    // The proxy material is never visible to the main camera (layer 0) or to
    // Three's reserved left/right WebXR eye layers (1/2). It is intentionally
    // opaque so Three's depth-only shadow material is minimal.
    this.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.geometryCache = new Map();
    this.chunkGroups = new Map();
    this.landmarkGroups = new Map();
    this._landmarkElapsed = Infinity;
    this.debug = { casters: 0, trees: 0, landmarks: 0 };
  }

  _geometry(type, variant) {
    const key = `${type}/${variant}`;
    if (!this.geometryCache.has(key)) {
      const entry = this.library[type]?.[variant];
      if (!entry) return null;
      this.geometryCache.set(key, makeVegetationProxyGeometry(entry, type));
    }
    return this.geometryCache.get(key);
  }

  attachChunk(chunk) {
    if (!this.enabled || !chunk?.veg || this.chunkGroups.has(chunk)) return;
    const group = new THREE.Group();
    group.name = `xr-shadow-chunk-${chunk.cx},${chunk.cz}`;
    let treeCount = 0;
    for (const source of chunk.veg.children) {
      if (!source.isInstancedMesh) continue;
      const [type, variantText] = source.name.split('/');
      if (!PROXY_TYPES.has(type)) continue;
      const variant = Number(variantText);
      const geometry = this._geometry(type, variant);
      if (!geometry) continue;
      const proxy = new THREE.InstancedMesh(geometry, this.material, source.count);
      // Zero-copy: placement remains owned by the streamed vegetation bucket.
      proxy.instanceMatrix = source.instanceMatrix;
      proxy.count = source.count;
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.frustumCulled = true;
      proxy.name = `xr-shadow-${source.name}`;
      proxy.computeBoundingSphere();
      setShadowLayer(proxy);
      group.add(proxy);
      treeCount += source.count;
    }
    if (!group.children.length) return;
    group.userData.xrTreeCount = treeCount;
    this.chunkGroups.set(chunk, group);
    this.root.add(group);
    this._refreshDebug();
  }

  detachChunk(chunk) {
    const group = this.chunkGroups.get(chunk);
    if (!group) return;
    this.root.remove(group);
    this.chunkGroups.delete(chunk);
    this._refreshDebug();
  }

  _makeLandmarkProxy(source) {
    const bounds = new THREE.Box3().setFromObject(source);
    if (bounds.isEmpty()) return null;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);
    const radius = Math.max(0.5, Math.max(size.x, size.z) * 0.5);
    const group = new THREE.Group();

    if (source.userData.giantTree) {
      const trunk = new THREE.Mesh(
        cylinder(radius * 0.10, radius * 0.22, size.y * 0.68, center.y - size.y * 0.16, 6),
        this.material,
      );
      const crown = new THREE.Mesh(
        ellipsoid(radius, size.y * 0.28, radius * 0.92,
          center.x, bounds.min.y + size.y * 0.72, center.z),
        this.material,
      );
      // Cylinder helper uses local X/Z zero, so align it to the world-space box.
      trunk.position.x = center.x;
      trunk.position.z = center.z;
      group.add(trunk, crown);
    } else if (source.userData.lighthouse) {
      const tower = new THREE.Mesh(
        cylinder(radius * 0.42, radius * 0.66, size.y * 0.92,
          center.y - size.y * 0.04, 7),
        this.material,
      );
      tower.position.x = center.x;
      tower.position.z = center.z;
      group.add(tower);
    } else {
      return null;
    }

    for (const child of group.children) {
      child.castShadow = true;
      child.receiveShadow = false;
    }
    return setShadowLayer(group);
  }

  _syncLandmarks(landmarks) {
    const wanted = new Set();
    for (const [key, source] of landmarks?.active || []) {
      if (!source.userData.giantTree && !source.userData.lighthouse) continue;
      wanted.add(key);
      if (this.landmarkGroups.has(key)) continue;
      const proxy = this._makeLandmarkProxy(source);
      if (!proxy) continue;
      proxy.name = `xr-shadow-landmark-${key}`;
      this.landmarkGroups.set(key, proxy);
      this.root.add(proxy);
    }
    for (const [key, proxy] of this.landmarkGroups) {
      if (wanted.has(key)) continue;
      this.root.remove(proxy);
      this.landmarkGroups.delete(key);
    }
    this._refreshDebug();
  }

  setEnabled(enabled, chunkManager = null, landmarks = null) {
    this.enabled = !!enabled;
    this.root.visible = this.enabled;
    if (this.enabled) {
      for (const chunk of chunkManager?.chunks?.values() || []) this.attachChunk(chunk);
      this._syncLandmarks(landmarks);
      this._landmarkElapsed = 0;
    }
    this._refreshDebug();
  }

  update(dt, landmarks) {
    if (!this.enabled) return;
    this._landmarkElapsed += dt;
    if (this._landmarkElapsed < 1) return;
    this._landmarkElapsed = 0;
    this._syncLandmarks(landmarks);
  }

  _refreshDebug() {
    let trees = 0;
    let buckets = 0;
    for (const group of this.chunkGroups.values()) {
      trees += group.userData.xrTreeCount || 0;
      buckets += group.children.length;
    }
    this.debug.trees = trees;
    this.debug.landmarks = this.landmarkGroups.size;
    this.debug.casters = buckets + this.landmarkGroups.size;
  }

  dispose() {
    this.scene.remove(this.root);
    for (const geometry of this.geometryCache.values()) geometry.dispose();
    for (const proxy of this.landmarkGroups.values()) {
      proxy.traverse((child) => child.geometry?.dispose());
    }
    this.material.dispose();
    this.chunkGroups.clear();
    this.landmarkGroups.clear();
  }
}
