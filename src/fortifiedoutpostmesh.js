// Lightweight THREE representation for the semantic fortified-outpost plan.
// It deliberately consumes render recipes only; collision and walkables never
// inspect render triangles.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { landmarkMaterial } from './landmarkmesh.js';
import { fortifiedOutpostRenderRecipes } from './fortifiedoutpost.mjs';

function nonIndexed(geometry) { return geometry.index ? geometry.toNonIndexed() : geometry; }

function segmentBox(piece, yOffset = 0) {
  const dx = piece.bx - piece.ax, dz = piece.bz - piece.az;
  const length = Math.hypot(dx, dz) || 0.01;
  const geometry = new THREE.BoxGeometry(piece.thickness || 0.75, piece.height || 1, length);
  geometry.translate(0, (piece.baseY || 0) + (piece.height || 1) / 2 + yOffset, 0);
  geometry.rotateY(Math.atan2(dx, dz));
  geometry.translate((piece.ax + piece.bx) / 2, 0, (piece.az + piece.bz) / 2);
  return geometry;
}

function boxPiece(piece, yOffset = 0) {
  const geometry = new THREE.BoxGeometry(piece.width || 1, piece.height || 0.2, piece.depth || 1);
  geometry.rotateY(piece.yaw || 0);
  geometry.translate(piece.x || 0, (piece.y || 0) + (piece.height || 0.2) / 2 + yOffset, piece.z || 0);
  return geometry;
}

function rampSteps(piece, yOffset = 0) {
  const count = Math.max(3, piece.steps || 9);
  const dx = piece.bx - piece.ax, dz = piece.bz - piece.az;
  const length = Math.hypot(dx, dz) || 1;
  const yaw = Math.atan2(dx, dz);
  const parts = [];
  for (let index = 0; index < count; index++) {
    const t = (index + 0.5) / count;
    const step = new THREE.BoxGeometry(piece.width, Math.max(0.12, Math.abs(piece.by - piece.ay) / count + 0.12), length / count + 0.12);
    step.rotateY(yaw);
    step.translate(
      piece.ax + dx * t,
      piece.ay + (piece.by - piece.ay) * t + yOffset,
      piece.az + dz * t,
    );
    parts.push(step);
  }
  return parts;
}

function towerShell(piece, yOffset = 0) {
  const geometry = new THREE.CylinderGeometry(piece.radius, piece.radius * 1.04, piece.height, 12, 1, true);
  geometry.translate(piece.x, (piece.height / 2) + yOffset, piece.z);
  return geometry;
}

function rubblePiece(piece, yOffset = 0) {
  return boxPiece({
    ...piece,
    y: piece.y || 0,
    yaw: piece.yaw || 0,
  }, yOffset);
}

/** Build one batched stone mesh with semantic piece IDs retained in userData. */
export function buildFortifiedOutpostVisual(plan, {
  groundOffset = 0, material = landmarkMaterial, name = `${plan?.id || 'outpost'}:visual`,
} = {}) {
  if (!plan?.id) throw new TypeError('A fortified outpost plan is required.');
  const group = new THREE.Group();
  group.name = name;
  const parts = [], semanticPieceIds = [];
  for (const piece of fortifiedOutpostRenderRecipes(plan)) {
    let geometry = null;
    if (piece.kind === 'curtain-wall' || piece.kind === 'parapet' || piece.kind === 'room-wall') {
      geometry = segmentBox(piece, groundOffset);
    } else if (piece.kind === 'tower') {
      geometry = towerShell(piece, groundOffset);
    } else if (piece.kind === 'stair') {
      const steps = rampSteps(piece, groundOffset);
      parts.push(...steps.map(nonIndexed));
      semanticPieceIds.push(...steps.map(() => piece.id));
      continue;
    } else if (piece.kind === 'floor' || piece.kind === 'landing' || piece.kind.endsWith('rubble')) {
      geometry = boxPiece(piece, groundOffset);
    } else if (piece.kind === 'large-rubble' || piece.kind === 'small-rubble') {
      geometry = rubblePiece(piece, groundOffset);
    }
    if (!geometry) continue;
    parts.push(nonIndexed(geometry));
    semanticPieceIds.push(piece.id);
  }
  if (parts.length) {
    const merged = mergeGeometries(parts, false);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${name}:masonry`;
    mesh.userData.semanticPieceIds = semanticPieceIds;
    mesh.userData.sourcePlanId = plan.id;
    group.add(mesh);
  }
  group.userData.semanticPlanId = plan.id;
  group.userData.architectureHash = plan.architectureHash;
  group.userData.entropyHash = plan.entropyHash;
  group.userData.dungeonSeam = plan.dungeonSeam;
  return group;
}

export function disposeFortifiedOutpostVisual(group) {
  if (!group) return;
  group.traverse((object) => {
    object.geometry?.dispose?.();
  });
  group.parent?.remove(group);
}

export class FortifiedOutpostVisualManager {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.options = options;
    this.active = new Map();
  }

  registerFortifiedOutpost(plan) {
    const previous = this.active.get(plan.id);
    if (previous) disposeFortifiedOutpostVisual(previous);
    const visual = buildFortifiedOutpostVisual(plan, this.options);
    this.scene.add(visual);
    this.active.set(plan.id, visual);
    return () => {
      const current = this.active.get(plan.id);
      if (current !== visual) return;
      disposeFortifiedOutpostVisual(current);
      this.active.delete(plan.id);
    };
  }

  registerPlan(plan) { return this.registerFortifiedOutpost(plan); }

  clear() {
    for (const visual of this.active.values()) disposeFortifiedOutpostVisual(visual);
    this.active.clear();
  }
}
