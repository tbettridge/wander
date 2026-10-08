// Collapse a rigid assembly's static parts into one mesh per material.
//
// The train and the stations are modelled from hundreds of small boxes and
// cylinders, each its own draw call: about a sixth of a frame's draws for a
// few thousand triangles wherever they were in view, and all of the carriage
// interior while riding. Parts that move on their own (door panels) or carry
// their own material state (a lantern's glass) are passed in `keep` and stay
// separate, as does everything beneath them.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _toRoot = new THREE.Matrix4();
const _local = new THREE.Matrix4();

export function mergeRigidParts(root, keep = []) {
  const kept = new Set(keep);
  const isKept = (object) => {
    for (let o = object; o && o !== root; o = o.parent) if (kept.has(o)) return true;
    return false;
  };
  root.updateMatrixWorld(true);
  _toRoot.copy(root.matrixWorld).invert();
  const buckets = new Map();
  root.traverse((o) => {
    // A mirrored transform would need its winding flipped; none are expected,
    // so leave any such part exactly as it was rather than merge it inside out.
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh
      || Array.isArray(o.material) || !o.visible || isKept(o)
      || o.matrixWorld.determinant() < 0) return;
    const g = o.geometry;
    const attrs = Object.keys(g.attributes).sort()
      .map((name) => `${name}:${g.attributes[name].itemSize}`).join('|');
    const key = `${o.material.uuid}/${o.castShadow}/${o.receiveShadow}/${o.renderOrder}/`
      + `${o.frustumCulled}/${g.index ? 'indexed' : 'plain'}/${attrs}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  });
  const retired = new Set();
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((m) => m.geometry.clone()
      .applyMatrix4(_local.multiplyMatrices(_toRoot, m.matrixWorld)));
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (!geometry) continue;
    const first = meshes[0];
    const merged = new THREE.Mesh(geometry, first.material);
    merged.name = `${root.name} · ${first.material.name || 'rigid parts'}`;
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;
    merged.renderOrder = first.renderOrder;
    merged.frustumCulled = first.frustumCulled;
    // Ownership flags (who disposes the geometry) travel with the merge.
    Object.assign(merged.userData, first.userData);
    for (const m of meshes) {
      m.removeFromParent();
      retired.add(m.geometry);
    }
    root.add(merged);
  }
  // Shared source geometry may still be drawn by a kept mesh; only release
  // what nothing renders any more.
  const live = new Set();
  root.traverse((o) => { if (o.geometry) live.add(o.geometry); });
  for (const geometry of retired) if (!live.has(geometry)) geometry.dispose();
  return root;
}
