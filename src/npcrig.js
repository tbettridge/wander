// The NPC skeleton and its two garment skins.
//
// Bone layout, all authored in the NPC root's local space so both garments and
// every attached primitive share one coordinate system:
//
//   hips -> spine -> chest -> neck -> head
//   hips -> thigh -> shin -> foot        (x2)
//   chest -> upperArm -> forearm -> hand (x2)
//
// Limbs extend down local -Y and the face looks down +Z. A positive rotation
// about a bone's local X therefore swings the child BACKWARD, away from the
// face — the opposite of solveThreeLinkIK, which calls that direction +forward.
// Gait angles are negated where applyPose assigns them; see npcavatar.js.

import * as THREE from 'three';
import { buildGarmentGeometry, createGarment, limbSection } from './npcskin.js';

const SIDES = Object.freeze([
  { key: 'left', sign: -1 },
  { key: 'right', sign: 1 },
]);

function bone(name, position) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.fromArray(position);
  return b;
}

/**
 * Build the skeleton for one NPC.
 * Returns the bones plus their bind-pose positions in root space, which the
 * garment builder needs to author geometry around them.
 */
export function createNpcSkeleton(dims) {
  const bones = {};
  const bind = {};

  bones.hips = bone('hips', [0, dims.hipHeight, 0]);
  // A single spine joint is enough at this scale: it carries the counter-twist
  // against the pelvis, which is the part the eye reads.
  bones.spine = bone('spine', [0, dims.torsoLength * 0.34, 0]);
  bones.chest = bone('chest', [0, dims.torsoLength * 0.44, 0]);
  bones.neck = bone('neck', [0, dims.torsoLength * 0.22, 0]);
  bones.head = bone('head', [0, dims.neck, 0]);
  bones.hips.add(bones.spine);
  bones.spine.add(bones.chest);
  bones.chest.add(bones.neck);
  bones.neck.add(bones.head);

  for (const { key, sign } of SIDES) {
    const thigh = bone(`${key}Thigh`, [sign * dims.hipJointWidth * 0.5, 0, 0]);
    const shin = bone(`${key}Shin`, [0, -dims.thigh, 0]);
    const foot = bone(`${key}Foot`, [0, -dims.shin, 0]);
    thigh.add(shin); shin.add(foot);
    bones.hips.add(thigh);
    bones[`${key}Thigh`] = thigh;
    bones[`${key}Shin`] = shin;
    bones[`${key}Foot`] = foot;

    const upperArm = bone(`${key}UpperArm`, [sign * dims.shoulderJointWidth * 0.5, 0, 0]);
    const forearm = bone(`${key}Forearm`, [0, -dims.upperArm, 0]);
    const hand = bone(`${key}Hand`, [0, -dims.forearm, 0]);
    upperArm.add(forearm); forearm.add(hand);
    bones.chest.add(upperArm);
    bones[`${key}UpperArm`] = upperArm;
    bones[`${key}Forearm`] = forearm;
    bones[`${key}Hand`] = hand;
  }

  // Bind-pose positions in root space. Computed directly rather than via
  // matrixWorld so the rig can be built before it joins a scene.
  const spineY = dims.hipHeight + bones.spine.position.y;
  const chestY = spineY + bones.chest.position.y;
  const neckY = chestY + bones.neck.position.y;
  bind.hips = [0, dims.hipHeight, 0];
  bind.spine = [0, spineY, 0];
  bind.chest = [0, chestY, 0];
  bind.neck = [0, neckY, 0];
  bind.head = [0, neckY + dims.neck, 0];
  for (const { key, sign } of SIDES) {
    const hipX = sign * dims.hipJointWidth * 0.5;
    bind[`${key}Thigh`] = [hipX, dims.hipHeight, 0];
    bind[`${key}Shin`] = [hipX, dims.hipHeight - dims.thigh, 0];
    bind[`${key}Foot`] = [hipX, dims.hipHeight - dims.thigh - dims.shin, 0];
    const shoulderX = sign * dims.shoulderJointWidth * 0.5;
    bind[`${key}UpperArm`] = [shoulderX, chestY, 0];
    bind[`${key}Forearm`] = [shoulderX, chestY - dims.upperArm, 0];
    bind[`${key}Hand`] = [shoulderX, chestY - dims.upperArm - dims.forearm, 0];
  }

  return { bones, bind };
}

/**
 * Pants: pelvis plus both legs, one skin so neither hip nor knee is a seam.
 * It stops above the ankle, leaving the ankle and foot as their own primitives —
 * which is also where a trouser cuff would end.
 */
export function buildPantsGeometry(dims, bind, options = {}) {
  const g = dims.girth;
  const sections = [];
  // The pelvis block is owned by the hips bone and spans both hip joints, so
  // the two thighs share a continuous seat rather than meeting at a point.
  // The seat spans the hip JOINTS and is then thickened until its outer surface
  // reaches the body's real hip breadth. Spanning the breadth and adding a
  // pelvis radius on top of that made the hips half a metre wide on a resident
  // barely one and a half metres tall.
  const seatRadius = Math.max(g.thigh * 1.02, (dims.hipWidth - dims.hipJointWidth) * 0.5);
  sections.push(limbSection('hips',
    [-dims.hipJointWidth * 0.5, bind.hips[1], 0], [dims.hipJointWidth * 0.5, bind.hips[1], 0],
    seatRadius, seatRadius, seatRadius * 1.04));
  sections.push(limbSection('hips',
    [0, bind.hips[1] + g.pelvis * 0.55, 0], [0, bind.hips[1] - g.pelvis * 0.10, 0],
    g.waist * 0.92, g.pelvis * 0.86, g.waist * 0.90));
  for (const { key } of SIDES) {
    const thighTop = bind[`${key}Thigh`];
    const knee = bind[`${key}Shin`];
    const ankle = bind[`${key}Foot`];
    sections.push(limbSection(`${key}Thigh`, thighTop, knee,
      g.thigh, g.knee * 0.94, g.thigh * 1.02));
    // The shin section stops a little short of the ankle: that is the cuff.
    const cuff = [ankle[0], ankle[1] + dims.shin * 0.10, ankle[2]];
    sections.push(limbSection(`${key}Shin`, knee, cuff, g.knee * 0.92, g.calf * 0.86, g.knee));
  }
  const boneNames = ['hips', 'leftThigh', 'leftShin', 'rightThigh', 'rightShin'];
  return { geometry: buildGarmentGeometry(sections, boneNames, options), boneNames };
}

/**
 * Shirt: chest and waist plus both arms, ending at the wrist and the neck so
 * hands, neck and head remain their own primitives.
 */
export function buildShirtGeometry(dims, bind, options = {}) {
  const g = dims.girth;
  const sections = [];
  sections.push(limbSection('chest',
    [0, bind.chest[1] + g.chest * 0.30, 0], [0, bind.spine[1] - g.waist * 0.20, 0],
    g.chest, g.waist, g.chest * 1.02));
  // A crossbar across the shoulders so the two sleeves join through a yoke
  // instead of pinching into the chest cylinder. Like the seat of the pants it
  // spans the JOINTS and is thickened out toward the breadth: spanning the
  // biacromial breadth and then wrapping most of a chest radius around it made
  // the shoulders half again as wide as the body they belong to.
  const yokeRadius = Math.max(g.upperArm * 1.05, (dims.shoulderWidth - dims.shoulderJointWidth) * 0.5);
  sections.push(limbSection('chest',
    [-dims.shoulderJointWidth * 0.5, bind.chest[1], 0],
    [dims.shoulderJointWidth * 0.5, bind.chest[1], 0],
    yokeRadius, yokeRadius, yokeRadius * 1.06));
  for (const { key } of SIDES) {
    const shoulder = bind[`${key}UpperArm`];
    const elbow = bind[`${key}Forearm`];
    const wrist = bind[`${key}Hand`];
    sections.push(limbSection(`${key}UpperArm`, shoulder, elbow,
      g.upperArm, g.elbow * 0.94, g.upperArm * 1.05));
    const cuff = [wrist[0], wrist[1] + dims.forearm * 0.12, wrist[2]];
    sections.push(limbSection(`${key}Forearm`, elbow, cuff,
      g.elbow * 0.92, g.wrist * 1.10, g.elbow));
  }
  const boneNames = ['chest', 'leftUpperArm', 'leftForearm', 'rightUpperArm', 'rightForearm'];
  return { geometry: buildGarmentGeometry(sections, boneNames, options), boneNames };
}

export function createGarments(dims, skeleton, materials, options = {}) {
  // THREE.Skeleton derives its bind inverses by inverting each bone's
  // matrixWorld at construction. The rig is assembled detached from any scene,
  // so those matrices are still identity here and the inverses come out
  // identity too — leaving every garment vertex, already authored at its
  // absolute bind position, to be translated a second time by its own bone.
  // Resolving the bind pose first is what makes the inverses real. The NPC root
  // is still untransformed at this point, so these are root-local bind
  // matrices, which is the space the geometry is authored in and matches the
  // identity bind matrix the meshes take in createGarment.
  skeleton.bones.hips.updateMatrixWorld(true);
  const pants = buildPantsGeometry(dims, skeleton.bind, options);
  const shirt = buildShirtGeometry(dims, skeleton.bind, options);
  return {
    pants: createGarment(pants.geometry,
      pants.boneNames.map((name) => skeleton.bones[name]), materials.pants, 'npc-pants'),
    shirt: createGarment(shirt.geometry,
      shirt.boneNames.map((name) => skeleton.bones[name]), materials.shirt, 'npc-shirt'),
  };
}

export { SIDES as NPC_SIDES };
