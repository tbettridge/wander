// Garment skins for NPC limbs.
//
// The animals build one implicit surface over every capsule and ellipsoid, so a
// hock or a shoulder never shows a seam. NPCs get the same idea in a cheaper
// form: the limb volume is still described as overlapping capsules with a
// sphere at each joint, but instead of an SDF the volume is inflated slightly
// into a garment mesh and bound to the skeleton.
//
// Two garments, each spanning a whole limb group so no joint is ever a visible
// break:
//   pants — pelvis + both thighs + both shins
//   shirt — chest + waist + both upper arms + both forearms
//
// Deliberately BLENDED skin weights rather than the rigid one-bone-per-vertex
// binding the animals use. A deer's hock bends through a modest arc and the
// overlap volume hides the crease; a human knee and elbow fold to ~145 degrees
// and the player stands next to them holding a conversation. Rigid binding
// creases visibly there. Vertices near a joint therefore take weight from both
// bones, falling off over a band scaled to the joint's own radius.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** Shortest distance from a point to a bone's segment, in bind space. */
function distanceToSegment(point, start, end) {
  _a.fromArray(start);
  _b.fromArray(end);
  _ab.subVectors(_b, _a);
  _ap.subVectors(point, _a);
  const lengthSq = Math.max(1e-8, _ab.lengthSq());
  const t = Math.max(0, Math.min(1, _ap.dot(_ab) / lengthSq));
  _ab.multiplyScalar(t).add(_a);
  return point.distanceTo(_ab);
}

/**
 * One limb section: a tapered capsule from `start` to `end` owned by `bone`,
 * with a sphere of `jointRadius` at its start so the joint stays full through a
 * bend. Coordinates are in the garment's bind space (the skinned mesh's own
 * local space), metres.
 */
export function limbSection(bone, start, end, radiusStart, radiusEnd, jointRadius = 0) {
  return { bone, start, end, radiusStart, radiusEnd, jointRadius };
}

function sectionGeometry(section, inflate, radialSegments) {
  const start = new THREE.Vector3().fromArray(section.start);
  const end = new THREE.Vector3().fromArray(section.end);
  const axis = new THREE.Vector3().subVectors(end, start);
  const length = axis.length();
  const parts = [];

  if (length > 1e-5) {
    // The shaft deliberately runs the full bone length; the joint spheres at
    // either end then overlap it, so a bend never opens a gap the way two
    // capsule tips meeting at a point would.
    const shaft = new THREE.CylinderGeometry(
      section.radiusEnd + inflate, section.radiusStart + inflate,
      length, radialSegments, 1, true,
    );
    // CylinderGeometry runs along +Y from its centre; aim it down the bone.
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), axis.clone().normalize(),
    );
    shaft.applyQuaternion(quaternion);
    shaft.translate(
      (start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5,
    );
    parts.push(shaft);
  }

  const jointRadius = section.jointRadius || section.radiusStart;
  const cap = new THREE.SphereGeometry(jointRadius + inflate, radialSegments, Math.max(4, radialSegments >> 1));
  cap.translate(start.x, start.y, start.z);
  parts.push(cap);

  const tip = new THREE.SphereGeometry(section.radiusEnd + inflate, radialSegments, Math.max(4, radialSegments >> 1));
  tip.translate(end.x, end.y, end.z);
  parts.push(tip);

  return parts;
}

/**
 * Build a garment geometry over `sections`, bound to `boneNames`.
 *
 * `blendBand` is how far from a joint the weighting blends, as a multiple of
 * the joint radius. Too narrow and the knee creases; too wide and the thigh
 * follows the shin.
 */
export function buildGarmentGeometry(sections, boneNames, {
  inflate = 0.012,
  radialSegments = 10,
  blendBand = 1.65,
} = {}) {
  const boneIndex = new Map(boneNames.map((name, i) => [name, i]));
  const pieces = [];
  for (const section of sections) {
    for (const geometry of sectionGeometry(section, inflate, radialSegments)) {
      pieces.push(geometry.toNonIndexed());
    }
  }
  const merged = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  merged.computeVertexNormals();

  const position = merged.attributes.position;
  const count = position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const point = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    point.fromBufferAttribute(position, i);
    // Rank every bone by distance to its segment, then keep the best two. Two
    // is enough for a limb: a vertex is only ever between one joint's parent
    // and child.
    let best = -1; let bestDist = Infinity;
    let second = -1; let secondDist = Infinity;
    for (const section of sections) {
      const index = boneIndex.get(section.bone);
      if (index === undefined) continue;
      const distance = distanceToSegment(point, section.start, section.end);
      if (distance < bestDist) {
        if (best !== index) { second = best; secondDist = bestDist; }
        best = index; bestDist = distance;
      } else if (distance < secondDist && index !== best) {
        second = index; secondDist = distance;
      }
    }
    if (best < 0) { best = 0; bestDist = 0; }

    let weightA = 1;
    let weightB = 0;
    if (second >= 0 && Number.isFinite(secondDist)) {
      // Blend only inside a band around the shared joint. Beyond it the vertex
      // belongs wholly to its own bone, so a thigh does not drag when the shin
      // swings.
      const band = Math.max(1e-4, blendBand * 0.5 * (bestDist + secondDist));
      const overlap = Math.max(0, 1 - (secondDist - bestDist) / band);
      weightB = 0.5 * overlap * overlap;   // smooth, and never exceeds the owner
      weightA = 1 - weightB;
    }
    skinIndex[i * 4] = best;
    skinIndex[i * 4 + 1] = second >= 0 ? second : best;
    skinWeight[i * 4] = weightA;
    skinWeight[i * 4 + 1] = weightB;
  }

  merged.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  merged.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  return merged;
}

/**
 * Bind a garment geometry to a skeleton built from `bones`, in order.
 *
 * The bones stay where they are in the NPC's hierarchy — this deliberately does
 * NOT re-parent them under the mesh. Both garments share one skeleton hierarchy
 * (the shirt's chest bone is a descendant of the pants' hips bone), so moving
 * bones under whichever mesh bound them first would tear the body in half.
 * Geometry is authored in the root's local space and the mesh sits at that same
 * origin, so the default bind matrix is already correct.
 */
export function createGarment(geometry, bones, material, name) {
  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.bind(skeleton);
  mesh.frustumCulled = false;   // limbs swing outside a stale bounding sphere
  return mesh;
}
