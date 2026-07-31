import * as THREE from 'three';
import { npcBindDimensions } from './npcanatomy.mjs';
import { createGarments, createNpcSkeleton } from './npcrig.js';

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
      cloak: new THREE.CylinderGeometry(0.34, 0.57, 1.28, 9),
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
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.22, 0], scale: [0.34, 0.035, 0.34],
    }, registry);
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.34, 0], scale: [0.20, 0.22, 0.20],
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
  const target = identity.accessory === 'case' ? rig.leftArm : rig.rightArm;
  if (identity.accessory === 'lantern') {
    addMesh(target, g.cylinder, mats.dark, {
      position: [0, -0.69, 0], scale: [0.07, 0.19, 0.07],
    }, registry);
    addMesh(target, g.sphere, mats.accent, {
      position: [0, -0.69, 0], scale: [0.11, 0.13, 0.11],
    }, registry);
  } else if (identity.accessory === 'satchel') {
    addMesh(rig.torso, g.box, mats.secondary, {
      position: [0.38, 0.05, 0.08], rotation: [0, 0, -0.08], scale: [0.24, 0.30, 0.13],
    }, registry);
  } else if (identity.accessory === 'case') {
    addMesh(target, g.box, mats.secondary, {
      position: [0, -0.72, 0.03], scale: [0.30, 0.24, 0.13],
    }, registry);
    addMesh(target, g.torus, mats.dark, {
      position: [0, -0.55, 0.03], scale: [0.08, 0.08, 0.08],
    }, registry);
  } else if (identity.accessory === 'basket') {
    addMesh(target, g.box, mats.secondary, {
      position: [0, -0.69, 0.04], scale: [0.26, 0.20, 0.20],
    }, registry);
    addMesh(target, g.torus, mats.secondary, {
      position: [0, -0.55, 0.04], scale: [0.13, 0.15, 0.10],
    }, registry);
  } else if (identity.accessory === 'staff') {
    addMesh(root, g.cylinder, mats.dark, {
      position: [0.48, 0.72, 0.02], scale: [0.035, 1.42, 0.035],
    }, registry);
  } else if (identity.accessory === 'book') {
    addMesh(target, g.box, mats.secondary, {
      position: [0, -0.58, 0.08], rotation: [0.16, 0, 0], scale: [0.20, 0.05, 0.26],
    }, registry);
    addMesh(target, g.box, mats.paper, {
      position: [0, -0.57, 0.08], scale: [0.17, 0.058, 0.22], nearOnly: true,
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
  const head = new THREE.Group();
  head.scale.setScalar(identity.proportions.headScale);
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
    addMesh(bones.chest, g.cloak, mats.primary, {
      position: [0, -dims.torsoLength * 0.10, 0],
      scale: [identity.proportions.build, 1, identity.proportions.build],
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
    hips: bones.hips, torso: bones.chest, head,
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
    applyPose(pose, groundY = 0) {
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
