// Minimal structural dungeon visual: entrance masonry, passage lining and a
// single chamber shell. Cave topology remains rendered by the existing cave
// field/mesh path; these parts are the semantic architectural layer.

import * as THREE from 'three';
import { landmarkMaterial } from './landmarkmesh.js';

function addBox(parts, piece) {
  const geometry = new THREE.BoxGeometry(piece.width || 1, piece.height || 1, piece.depth || 1);
  geometry.rotateY(piece.yaw || 0);
  geometry.translate(piece.x || 0, piece.y || 0, piece.z || 0);
  parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
}

function addLine(parts, line) {
  const dx = line.bx - line.ax, dz = line.bz - line.az;
  const length = Math.hypot(dx, dz) || 0.01;
  const geometry = new THREE.BoxGeometry(line.thickness || 0.45, Math.max(0.3, line.maxY - line.minY), length);
  geometry.rotateY(Math.atan2(dx, dz));
  geometry.translate((line.ax + line.bx) / 2, (line.minY + line.maxY) / 2, (line.az + line.bz) / 2);
  parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
}

export function buildFortifiedDungeonVisual(plan, { material = landmarkMaterial } = {}) {
  if (!plan?.architecture) throw new TypeError('A fortified dungeon plan is required.');
  const group = new THREE.Group();
  group.name = `${plan.id}:architecture`;
  const parts = [];
  for (const piece of plan.architecture.pieces || []) {
    if (piece.renderSuppressed) continue;
    if (piece.kind === 'masonry-pier' || piece.kind === 'masonry-lintel'
      || piece.kind === 'masonry-support' || piece.kind === 'well-shaft'
      || piece.kind === 'crypt-recess' || piece.kind === 'masonry-floor'
      || piece.kind === 'masonry-threshold' || piece.kind === 'masonry-arch'
      || piece.kind === 'masonry-pillar' || piece.kind === 'masonry-retaining') addBox(parts, piece);
    else if (piece.kind === 'chamber-shell') {
      const shell = new THREE.SphereGeometry(1, 16, 10);
      shell.scale(piece.radiusX || 8, piece.radiusY || 4, piece.radiusZ || 8);
      shell.translate(piece.x || 0, piece.y || 0, piece.z || 0);
      parts.push(shell.toNonIndexed());
    }
  }
  for (const line of plan.architecture.renderProxies || plan.architecture.collisionProxies || []) {
    if (line.sourcePieceId?.startsWith('dungeon:passage:')) addLine(parts, line);
  }
  if (parts.length) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    for (const part of parts) {
      const position = part.attributes.position;
      for (let index = 0; index < position.count; index++) {
        positions.push(position.getX(index), position.getY(index), position.getZ(index));
      }
      part.dispose();
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.semanticPlanId = plan.id;
    mesh.userData.surfaceLink = plan.surfaceLink;
    group.add(mesh);
  }
  group.userData.semanticPlanId = plan.id;
  group.userData.dressingSuppressed = true;
  return group;
}

export function disposeFortifiedDungeonVisual(group) {
  if (!group) return;
  group.traverse((object) => object.geometry?.dispose?.());
  group.parent?.remove(group);
}
