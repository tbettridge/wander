import * as THREE from 'three';
import { npcBindDimensions } from './npcanatomy.mjs';
import { createGarments, createNpcSkeleton } from './npcrig.js';

// The cloak cylinder's own size, so whatever scales it can convert into metres
// rather than guessing. The geometry below is built from these.
const CLOAK_SOURCE = Object.freeze({ hemRadius: 0.57, taper: 0.6, height: 1.28 });

// The half-height the face and headwear meshes are authored against, and how
// far past life-size a head is allowed to go. A real head is 0.13 of stature;
// at 2.0 these read as storybook without becoming balloons, and — unlike a
// hardcoded size — they still vary with each resident's own headScale.
const HEAD_UNIT_HALF = 0.255;
const HEAD_STYLE_SCALE = 2.0;

function addMesh(parent, geometry, material, {
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
  nearOnly = false,
} = {}, registry) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.fromArray(position);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.scale.fromArray(scale);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  parent.add(mesh);
  registry.meshes.push(mesh);
  if (nearOnly) registry.nearMeshes.push(mesh);
  return mesh;
}

export class NpcAssetLibrary {
  constructor() {
    this.geometries = Object.freeze({
      sphere: new THREE.SphereGeometry(1, 12, 8),
      smallSphere: new THREE.SphereGeometry(1, 8, 6),
      limb: new THREE.CapsuleGeometry(0.1, 0.30, 3, 7),
      peg: new THREE.CylinderGeometry(0.78, 1, 1, 7),
      cloak: new THREE.CylinderGeometry(
        CLOAK_SOURCE.hemRadius * CLOAK_SOURCE.taper, CLOAK_SOURCE.hemRadius, CLOAK_SOURCE.height, 9,
      ),
      cone: new THREE.ConeGeometry(1, 1, 8),
      cylinder: new THREE.CylinderGeometry(1, 1, 1, 9),
      box: new THREE.BoxGeometry(1, 1, 1),
      torus: new THREE.TorusGeometry(1, 0.16, 5, 12),
    });
    this.materials = new Map();
  }

  material(color, { metalness = 0, roughness = 0.92 } = {}) {
    const key = `${color}:${metalness}:${roughness}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color,
        metalness,
        roughness,
        flatShading: true,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  dispose() {
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}

function makeMaterials(identity, assets) {
  const p = identity.palette;
  return {
    primary: assets.material(p.primary),
    secondary: assets.material(p.secondary),
    accent: assets.material(p.accent, { metalness: 0.08, roughness: 0.68 }),
    dark: assets.material(p.dark),
    skin: assets.material(p.skin, { roughness: 0.88 }),
    eye: assets.material(0x141817, { roughness: 0.72 }),
    paper: assets.material(0xd8cfad),
  };
}

function addFace(head, identity, assets, mats, registry) {
  const g = assets.geometries;
  if (identity.family === 'cloaked') {
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.01, -0.025], scale: [0.29, 0.32, 0.24],
    }, registry);
    const maskScale = identity.appearance.mask === 'leaf' ? [0.18, 0.27, 0.075]
      : identity.appearance.mask === 'angular' ? [0.22, 0.22, 0.07] : [0.21, 0.25, 0.075];
    addMesh(head, g.sphere, mats.accent, {
      position: [0, -0.01, 0.18], scale: maskScale,
    }, registry);
    for (const side of [-1, 1]) {
      addMesh(head, g.box, mats.eye, {
        position: [side * 0.072, 0.025, 0.252],
        rotation: [0, 0, side * -0.08],
        scale: [0.055, 0.014, 0.012], nearOnly: true,
      }, registry);
    }
    return;
  }

  addMesh(head, g.sphere, mats.skin, {
    scale: [0.235, 0.255, 0.22],
  }, registry);
  for (const side of [-1, 1]) {
    addMesh(head, g.smallSphere, mats.eye, {
      position: [side * 0.078, 0.035, 0.207],
      scale: [0.020, 0.028, 0.015], nearOnly: true,
    }, registry);
  }
  addMesh(head, g.smallSphere, mats.skin, {
    position: [0, -0.005, 0.224], scale: [0.032, 0.045, 0.035], nearOnly: true,
  }, registry);
  addMesh(head, g.box, mats.dark, {
    position: [0, -0.085, 0.217], scale: [0.072, 0.012, 0.010], nearOnly: true,
  }, registry);
  if (identity.appearance.freckles) {
    for (const side of [-1, 1]) {
      addMesh(head, g.smallSphere, mats.secondary, {
        position: [side * 0.105, -0.025, 0.205],
        scale: [0.010, 0.010, 0.009], nearOnly: true,
      }, registry);
    }
  }
}

function addHeadwear(head, identity, assets, mats, registry) {
  const g = assets.geometries;
  const style = identity.appearance.headwear;
  if (style === 'hood' || style === 'none') return;
  if (style === 'cap') {
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.19, -0.015], scale: [0.245, 0.12, 0.225],
    }, registry);
    addMesh(head, g.box, mats.dark, {
      position: [0, 0.155, 0.205], scale: [0.25, 0.035, 0.15],
    }, registry);
  } else if (style === 'brim') {
    // Worn down on the head rather than perched on the crown. The head is an
    // ellipsoid half a metre tall, so a brim up at 0.22 sat where the skull has
    // already narrowed to a sixth of its width and read as a disc hovering
    // above the head. Down here it crosses the skull at close to full width.
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.135, 0], scale: [0.34, 0.035, 0.34],
    }, registry);
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.255, 0], scale: [0.20, 0.22, 0.20],
    }, registry);
  } else if (style === 'bun') {
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.08, -0.14], scale: [0.25, 0.25, 0.19],
    }, registry);
    addMesh(head, g.smallSphere, mats.dark, {
      position: [0, 0.22, -0.19], scale: [0.11, 0.11, 0.10],
    }, registry);
  } else if (style === 'bob') {
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.015, -0.07], scale: [0.27, 0.29, 0.21],
    }, registry);
  } else if (style === 'crop') {
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.125, -0.045], scale: [0.245, 0.15, 0.21],
    }, registry);
  }
}

function addAccessory(root, rig, identity, assets, mats, registry) {
  const g = assets.geometries;
  const dims = rig.dims;
  const target = identity.accessory === 'case' ? rig.leftArm : rig.rightArm;
  // Carried items hang from the fist. These offsets used to be ~0.7m, measured
  // down from the shoulder on the rig that came before the skeleton; against
  // the hand bone they are parented to now, 0.7m put every basket and lantern
  // on the floor beside its owner. `grip` is the underside of the closed hand,
  // and everything is stacked from there.
  // The hand bone is the wrist, so the underside of the closed fist is most of
  // a hand length below it. An item hangs from there: `carried` takes the
  // item's own half-height and returns the centre that puts its TOP in the fist.
  const grip = -dims.hand * 0.62;
  const carried = (halfHeight) => grip - halfHeight - 0.012;
  if (identity.accessory === 'lantern') {
    addMesh(target, g.cylinder, mats.dark, {
      position: [0, carried(0.065), 0], scale: [0.05, 0.13, 0.05],
    }, registry);
    addMesh(target, g.sphere, mats.accent, {
      position: [0, carried(0.065), 0], scale: [0.075, 0.09, 0.075],
    }, registry);
  } else if (identity.accessory === 'satchel') {
    // Not carried: slung at the hip, on the side the free hand is not using.
    addMesh(rig.hips, g.box, mats.secondary, {
      position: [dims.hipWidth * 0.5 + 0.04, dims.girth.pelvis * 0.2, 0.05],
      rotation: [0, 0, -0.08], scale: [0.17, 0.21, 0.10],
    }, registry);
  } else if (identity.accessory === 'case') {
    addMesh(target, g.box, mats.secondary, {
      position: [0, carried(0.09), 0.02], scale: [0.22, 0.18, 0.10],
    }, registry);
    // The handle closes around the fist rather than floating under it.
    addMesh(target, g.torus, mats.dark, {
      position: [0, grip - 0.02, 0.02], scale: [0.055, 0.055, 0.06],
    }, registry);
  } else if (identity.accessory === 'basket') {
    addMesh(target, g.box, mats.secondary, {
      position: [0, carried(0.075), 0.03], scale: [0.19, 0.15, 0.15],
    }, registry);
    addMesh(target, g.torus, mats.secondary, {
      position: [0, grip - 0.02, 0.03], scale: [0.09, 0.10, 0.07],
    }, registry);
  } else if (identity.accessory === 'staff') {
    // Held in the fist and standing on the ground, so its length follows the
    // resident's own stature rather than a fixed 1.42m.
    const staffHeight = dims.stature * 0.95;
    addMesh(root, g.cylinder, mats.dark, {
      position: [dims.shoulderJointWidth * 0.5 + 0.06, staffHeight * 0.5, 0.03],
      scale: [0.028, staffHeight, 0.028],
    }, registry);
  } else if (identity.accessory === 'book') {
    // Carried in the palm, so it rests at the fist rather than dangling below.
    addMesh(target, g.box, mats.secondary, {
      position: [0, grip - 0.02, 0.06], rotation: [0.16, 0, 0], scale: [0.16, 0.04, 0.20],
    }, registry);
    addMesh(target, g.box, mats.paper, {
      position: [0, grip - 0.012, 0.06], scale: [0.135, 0.046, 0.17], nearOnly: true,
    }, registry);
  }
}

export function createNpcAvatar(identity, assets = new NpcAssetLibrary()) {
  const registry = { meshes: [], nearMeshes: [] };
  const g = assets.geometries;
  const mats = makeMaterials(identity, assets);
  const root = new THREE.Group();
  root.name = `${identity.name} · ${identity.role}`;
  root.userData.npcId = identity.id;
  root.userData.npcRole = identity.role;

  const dims = npcBindDimensions(identity.proportions);
  const skeleton = createNpcSkeleton(dims);
  const bones = skeleton.bones;
  root.add(bones.hips);

  // Two garments span the joints so neither knee nor elbow is a visible seam.
  // The cloaked family keeps its robe instead of trousers.
  const garments = createGarments(dims, skeleton, {
    pants: identity.family === 'cloaked' ? mats.primary : mats.dark,
    shirt: mats.primary,
  });
  root.add(garments.pants, garments.shirt);
  for (const garment of [garments.pants, garments.shirt]) {
    garment.castShadow = true;
    garment.receiveShadow = false;
    registry.meshes.push(garment);
  }

  // Everything below is an ordinary primitive attached to a bone, overlapping
  // the garment rather than being skinned by it: neck, head, hands, feet.
  // Every face and hat mesh below is authored against a head whose half-height
  // is HEAD_UNIT_HALF, so sizing the head is a matter of scaling this group and
  // everything on it follows. It used to be left at 1, which made a head 0.51m
  // tall on a resident of 1.5m — nearly three times life, and low enough that
  // its underside reached past the shoulder joints and swallowed the neck
  // whole. Derive it from the anatomy instead, keeping a deliberate
  // storybook exaggeration, and lift it so it sits ON the neck rather than
  // centred on the joint at the top of it.
  const headHalf = dims.headHeight * 0.5 * HEAD_STYLE_SCALE;
  const head = new THREE.Group();
  head.scale.setScalar(headHalf / HEAD_UNIT_HALF);
  head.position.y = headHalf * 0.88;
  bones.head.add(head);
  addMesh(bones.neck, g.cylinder, mats.skin, {
    position: [0, dims.neck * 0.45, 0],
    scale: [dims.girth.neck, dims.neck * 1.15, dims.girth.neck],
  }, registry);

  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? -1 : 1;
    // Hand: a flattened sphere at the wrist bone.
    addMesh(bones[`${side}Hand`], g.smallSphere, mats.skin, {
      position: [0, -dims.hand * 0.42, 0],
      scale: [dims.girth.wrist * 1.30, dims.hand * 0.52, dims.girth.wrist * 0.95],
    }, registry);
    // Ankle joint, then a boot that reaches forward from it. The foot bone sits
    // at the ankle, so the shoe is offset forward by half its length.
    addMesh(bones[`${side}Foot`], g.smallSphere, mats.dark, {
      scale: [dims.girth.ankle * 1.15, dims.girth.ankle * 1.15, dims.girth.ankle * 1.15],
    }, registry);
    addMesh(bones[`${side}Foot`], g.box, mats.dark, {
      position: [0, -dims.ankleHeight * 0.55, dims.footLength * 0.22],
      scale: [dims.girth.ankle * 2.0, dims.ankleHeight * 1.25, dims.footLength * 0.92],
    }, registry);
    void sign;
  }

  if (identity.family === 'cloaked') {
    // Sized from the body rather than left at the source cylinder's own metre
    // and a quarter. Unscaled, its hem is 0.57 across and its top reached above
    // the crown of a resident this size: a lampshade with legs, no head and no
    // arms. Hang it from the chest to mid-shin, with a collar narrower than the
    // head so the head clears it and the arms stay outside it.
    const hemRadius = dims.girth.pelvis * 2.1;
    const topY = skeleton.bind.chest[1] - dims.girth.chest * 0.15;
    const bottomY = dims.ankleHeight + dims.shin * 0.55;
    const radiusScale = hemRadius / CLOAK_SOURCE.hemRadius;
    addMesh(bones.chest, g.cloak, mats.primary, {
      position: [0, (topY + bottomY) * 0.5 - skeleton.bind.chest[1], 0],
      scale: [radiusScale, (topY - bottomY) / CLOAK_SOURCE.height, radiusScale],
    }, registry);
  } else if (identity.appearance.scarf) {
    addMesh(bones.neck, g.torus, mats.accent, {
      position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0],
      scale: [dims.girth.neck * 1.9, dims.girth.neck * 1.9, dims.girth.neck * 1.4],
    }, registry);
  }

  addFace(head, identity, assets, mats, registry);
  addHeadwear(head, identity, assets, mats, registry);

  addAccessory(root, {
    dims, hips: bones.hips, torso: bones.chest, head,
    leftArm: bones.leftHand, rightArm: bones.rightHand,
    leftLeg: bones.leftThigh, rightLeg: bones.rightThigh,
  }, identity, assets, mats, registry);

  // Uniform, and deliberately so. A non-uniform scale does not commute with the
  // bone rotations underneath it: a leg solved to reach a world-space foothold
  // renders somewhere else entirely, by as much as 40cm, and the planted foot
  // slides. `build` is not dropped, it is already in the dims above — girths and
  // both widths are multiplied by it — so scaling by it here applied it twice.
  root.scale.setScalar(identity.proportions.height);

  const rig = {
    hips: bones.hips, torso: bones.chest, head,
    leftArm: bones.leftUpperArm, rightArm: bones.rightUpperArm,
    leftLeg: bones.leftThigh, rightLeg: bones.rightThigh,
    bones, dims,
  };
  let nearDetail = true;
  let shadows = true;

  return {
    root,
    rig,
    identity,
    dims,

    /**
     * Drive the skeleton from a solved bipedal pose (see npcgait.mjs).
     * `groundY` is the world height the root sits at, so the solved world-space
     * pelvis can be expressed in the root's local space.
     */
    applyPose(pose, groundY = 0, {
      gesture = 0, gestureHand = 'right', point = 0, pointPitch = 0, pointHand = null,
    } = {}) {
      const scaleY = identity.proportions.height || 1;
      bones.hips.position.y = (pose.pelvis.y - groundY) / scaleY;
      // The pose is solved in world metres and the root scale is uniform, so the
      // lateral shift converts back into root space by the same divisor.
      bones.hips.position.x = pose.pelvis.sway / scaleY;
      // The hips bone stays level, and that is load-bearing rather than lazy.
      // Every leg joint here is sagittal-only, so a pelvis YAW cannot be
      // cancelled by any combination of leg angles: it simply carries both legs
      // with it. The IK solves each foothold against a hip at the root's own
      // orientation, so rotating this bone swings the planted foot bodily
      // sideways — measured at 80mm of drift per stride, which is most of what
      // still read as sliding after the stride direction was fixed.
      //
      // The lean and the counter-twist move up to the spine and chest, which is
      // where the eye reads them anyway: what says "walk" is the shoulders
      // rotating against the hips, and hips that stay square give exactly that
      // opposition without dragging the feet.
      bones.hips.rotation.set(0, 0, 0);
      bones.spine.rotation.set(pose.pelvis.lean * 0.85, pose.torsoTwist * 0.5, 0);
      bones.chest.rotation.set(pose.pelvis.lean * 0.5, pose.torsoTwist * 0.5, 0);

      // The solver's +forward is the rig's -Z, so every sagittal angle is
      // negated on the way in. These bones hang down -Y, and a positive
      // rotation about X carries a point below the joint toward -Z — away from
      // the face, which looks down +Z. Applied unnegated, the legs stride
      // backwards: each foot lands about a stride behind the foothold the gait
      // planted, and the "planted" foot slides forward under the body all the
      // way through stance. Only the downward chains flip. The torso leans from
      // a joint it sits ABOVE, so its +lean already tips toward the face.
      for (let i = 0; i < pose.legs.length; i++) {
        const leg = pose.legs[i];
        const key = leg.side < 0 ? 'left' : 'right';
        bones[`${key}Thigh`].rotation.x = -leg.hip;
        bones[`${key}Shin`].rotation.x = -leg.knee;
        bones[`${key}Foot`].rotation.x = -leg.ankle;
      }
      for (const arm of pose.arms) {
        const key = arm.side < 0 ? 'left' : 'right';
        bones[`${key}UpperArm`].rotation.set(-arm.shoulder, 0, arm.out);
        bones[`${key}Forearm`].rotation.x = -arm.elbow;
        bones[`${key}Hand`].rotation.x = -arm.wrist;
      }

      // A gesture rides on top of whatever the arm was already doing, so it
      // lands the same whether its owner is standing still or mid-stride. It
      // lifts one hand and folds the elbow: the shape of making a point, not a
      // wave. Forward is negative here for the same reason the swing was.
      if (gesture > 0.001) {
        const key = gestureHand === 'left' ? 'left' : 'right';
        const outward = key === 'left' ? -1 : 1;
        bones[`${key}UpperArm`].rotation.x -= 0.58 * gesture;
        bones[`${key}UpperArm`].rotation.z += outward * 0.20 * gesture;
        bones[`${key}Forearm`].rotation.x -= 0.80 * gesture;
        bones[`${key}Hand`].rotation.x -= 0.18 * gesture;
      }

      // Pointing is not a beat riding on the swing — it replaces it. The arm
      // comes up straight ahead and the elbow opens out, because a bent arm
      // reads as a shrug rather than as "over there". The body is turned to the
      // same bearing by the caller, so straight ahead IS the direction.
      if (point > 0.001) {
        const key = (pointHand || gestureHand) === 'left' ? 'left' : 'right';
        const outward = key === 'left' ? -1 : 1;
        const blend = (bone, axis, value) => {
          bone.rotation[axis] += (value - bone.rotation[axis]) * point;
        };
        blend(bones[`${key}UpperArm`], 'x', -1.42 + pointPitch);
        blend(bones[`${key}UpperArm`], 'z', outward * 0.14);
        blend(bones[`${key}Forearm`], 'x', -0.05);
        blend(bones[`${key}Hand`], 'x', 0);
      }
    },

    setDetail(distance, { xr = false } = {}) {
      const nextNear = distance < (xr ? 38 : 78);
      if (nextNear !== nearDetail) {
        nearDetail = nextNear;
        for (const mesh of registry.nearMeshes) mesh.visible = nearDetail;
      }
      const nextShadows = !xr && distance < 48;
      if (nextShadows !== shadows) {
        shadows = nextShadows;
        for (const mesh of registry.meshes) mesh.castShadow = shadows;
      }
    },
    dispose() {
      root.removeFromParent();
    },
  };
}
