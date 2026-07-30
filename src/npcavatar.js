import * as THREE from 'three';
import { npcHipHeight } from './npcpopulation.mjs';

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

  const hips = new THREE.Group();
  const hipHeight = npcHipHeight(identity.proportions.legScale);
  hips.position.y = hipHeight;
  root.add(hips);
  const torso = new THREE.Group();
  hips.add(torso);
  const head = new THREE.Group();
  head.position.y = identity.family === 'cloaked' ? 0.96 : 1.02;
  head.scale.setScalar(identity.proportions.headScale);
  torso.add(head);

  const leftArm = new THREE.Group();
  const rightArm = new THREE.Group();
  leftArm.position.set(-0.43, identity.family === 'cloaked' ? 0.43 : 0.72, 0);
  rightArm.position.set(0.43, identity.family === 'cloaked' ? 0.43 : 0.72, 0);
  torso.add(leftArm, rightArm);

  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  leftLeg.position.set(-0.18, 0, 0);
  rightLeg.position.set(0.18, 0, 0);
  hips.add(leftLeg, rightLeg);

  if (identity.family === 'cloaked') {
    addMesh(torso, g.cloak, mats.primary, {
      position: [0, 0, 0], scale: [identity.proportions.build, 1, identity.proportions.build],
    }, registry);
    addMesh(torso, g.cone, mats.secondary, {
      position: [0, 0.46, -0.02], rotation: [Math.PI, 0, 0], scale: [0.29, 0.30, 0.23],
    }, registry);
  } else {
    addMesh(torso, g.sphere, mats.primary, {
      position: [0, 0.42, 0],
      scale: [0.43 * identity.proportions.build, 0.53, 0.30 * identity.proportions.build],
    }, registry);
    addMesh(torso, g.peg, mats.secondary, {
      position: [0, 0.10, 0], scale: [0.39 * identity.proportions.build, 0.52, 0.29],
    }, registry);
    if (identity.appearance.scarf) {
      addMesh(torso, g.torus, mats.accent, {
        position: [0, 0.79, 0], rotation: [Math.PI / 2, 0, 0], scale: [0.25, 0.25, 0.18],
      }, registry);
    }
  }

  addFace(head, identity, assets, mats, registry);
  addHeadwear(head, identity, assets, mats, registry);

  for (const [arm, side] of [[leftArm, -1], [rightArm, 1]]) {
    addMesh(arm, g.limb, mats.primary, {
      position: [0, -0.26, 0], scale: [identity.family === 'cloaked' ? 1.18 : 1, 1, 1],
    }, registry);
    addMesh(arm, g.smallSphere, mats.skin, {
      position: [0, -0.53, 0], scale: [0.105, 0.105, 0.095],
    }, registry);
    arm.userData.side = side;
  }

  for (const leg of [leftLeg, rightLeg]) {
    addMesh(leg, g.peg, mats.dark, {
      position: [0, -0.34, 0], scale: [0.13, 0.66 * identity.proportions.legScale, 0.13],
    }, registry);
    addMesh(leg, g.box, mats.dark, {
      position: [0, -0.72 * identity.proportions.legScale, 0.06], scale: [0.22, 0.15, 0.34],
    }, registry);
  }

  addAccessory(root, { hips, torso, head, leftArm, rightArm, leftLeg, rightLeg }, identity, assets, mats, registry);

  root.scale.set(
    identity.proportions.build,
    identity.proportions.height,
    identity.proportions.build,
  );

  const rig = { hips, torso, head, leftArm, rightArm, leftLeg, rightLeg };
  let nearDetail = true;
  let shadows = true;

  return {
    root,
    rig,
    identity,
    applyMotion(motion) {
      hips.position.y = hipHeight + motion.rootBob;
      torso.rotation.set(motion.bodyLean, 0, motion.bodySway);
      head.rotation.set(0, motion.headYaw, motion.headTilt);
      leftArm.rotation.set(motion.leftArm, 0, motion.leftArmOut);
      rightArm.rotation.set(motion.rightArm, 0, motion.rightArmOut);
      leftLeg.rotation.set(motion.leftLeg, 0, 0);
      rightLeg.rotation.set(motion.rightLeg, 0, 0);
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
