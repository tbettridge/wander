import * as THREE from 'three';
import { enableVillageActorLighting } from './villagelighting.mjs';
import { applyInteriorFurniturePose } from './interiornpcpose.mjs';
import { npcBindDimensions } from './npcanatomy.mjs';
import { bunKnotHeight, tuckedHairShell } from './npcheadwear.mjs';
import { createGarments, createNpcSkeleton } from './npcrig.js';
import { NPC_GESTURES, npcBlinkAt, npcGesturePose, npcGestureArmTargets, npcGestureChestBounce } from './npcexpression.mjs?v=2';
import { solveNpcArmReach } from './npcgestureik.mjs';
import { npcPointMotion, npcPointTurnWeight } from './npcpointing.mjs';
import { bakeSkinnedParts, createNpcBodyMaterial } from './npcbodybake.js';

const reachWorld = new THREE.Vector3(), reachLocal = new THREE.Vector3();
const reachUpper = new THREE.Vector3(), reachLower = new THREE.Vector3();
const armDown = new THREE.Vector3(0, -1, 0);
const upperTarget = new THREE.Quaternion(), foreTarget = new THREE.Quaternion();
const inverseUpper = new THREE.Quaternion(), palmTarget = new THREE.Quaternion(), handTarget = new THREE.Quaternion();
const palmEuler = new THREE.Euler();
const pointShoulder = new THREE.Vector3(), pointElbow = new THREE.Vector3();
const pointDirection = new THREE.Vector3(), pointForward = new THREE.Vector3();
const pointY = new THREE.Vector3(), pointZ = new THREE.Vector3(), pointX = new THREE.Vector3();
const pointParent = new THREE.Quaternion(), pointWorld = new THREE.Quaternion();
const pointFrame = new THREE.Matrix4();

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
    this._bodyMaterial = null;
  }

  /** The single shared material baked NPC bodies draw with. */
  get bodyMaterial() {
    this._bodyMaterial ||= createNpcBodyMaterial();
    return this._bodyMaterial;
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
      enableVillageActorLighting(material);
      this.materials.set(key, material);
    }
    return material;
  }

  dispose() {
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this._bodyMaterial?.dispose();
    this._bodyMaterial = null;
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
    // Hair used to borrow `dark`, which is also the trousers and the boots, so
    // changing an outfit changed the hair with it.
    hair: assets.material(p.hair ?? p.dark, { roughness: 0.94 }),
    eye: assets.material(0x141817, { roughness: 0.72 }),
    paper: assets.material(0xd8cfad),
  };
}

function addFace(head, identity, assets, mats, registry) {
  const g = assets.geometries;
  const eyes = [];
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
      eyes.push(addMesh(head, g.box, mats.eye, {
        position: [side * 0.072, 0.025, 0.252],
        rotation: [0, 0, side * -0.08],
        scale: [0.055, 0.014, 0.012], nearOnly: true,
      }, registry));
    }
    const mouth = addMesh(head, g.smallSphere, mats.dark, {
      position: [0, -0.085, 0.253], scale: [0.028, 0.005, 0.006], nearOnly: true,
    }, registry);
    return { eyes, mouth };
  }

  addMesh(head, g.sphere, mats.skin, {
    scale: [0.235, 0.255, 0.22],
  }, registry);
  for (const side of [-1, 1]) {
    eyes.push(addMesh(head, g.smallSphere, mats.eye, {
      position: [side * 0.078, 0.035, 0.207],
      scale: [0.020, 0.028, 0.015], nearOnly: true,
    }, registry));
  }
  addMesh(head, g.smallSphere, mats.skin, {
    position: [0, -0.005, 0.224], scale: [0.032, 0.045, 0.035], nearOnly: true,
  }, registry);
  const mouth = addMesh(head, g.smallSphere, mats.dark, {
    position: [0, -0.085, 0.217], scale: [0.036, 0.006, 0.007], nearOnly: true,
  }, registry);
  if (identity.appearance.freckles) {
    for (const side of [-1, 1]) {
      addMesh(head, g.smallSphere, mats.secondary, {
        position: [side * 0.105, -0.025, 0.205],
        scale: [0.010, 0.010, 0.009], nearOnly: true,
      }, registry);
    }
  }
  return { eyes, mouth };
}

function addHair(head, identity, assets, mats, registry) {
  const g = assets.geometries;
  const style = identity.appearance.hair;
  if (!style || style === 'none') return;
  const hat = identity.appearance.hat;
  const shell = tuckedHairShell(style, hat);
  if (!shell) return;
  addMesh(head, g.sphere, mats.hair, {
    position: [...shell.centre], scale: [...shell.radii],
  }, registry);

  if (style === 'bun') {
    // The knot follows the hat down. Worn under one it sits at the nape, below
    // the rim, which is where a bun goes when a hat has to fit over it.
    addMesh(head, g.smallSphere, mats.hair, {
      position: [0, bunKnotHeight(hat), -0.19], scale: [0.11, 0.11, 0.10],
    }, registry);
  } else if (style === 'braid') {
    // The plait hangs behind the skull rather than through it, and stops above
    // the shoulder yoke. It is already below every rim, so a hat leaves it be.
    addMesh(head, g.cylinder, mats.hair, {
      position: [0, -0.19, -0.19], rotation: [0.14, 0, 0], scale: [0.062, 0.30, 0.062],
    }, registry);
    addMesh(head, g.smallSphere, mats.hair, {
      position: [0, -0.36, -0.165], scale: [0.05, 0.06, 0.05],
    }, registry);
  } else if (style === 'long') {
    addMesh(head, g.box, mats.hair, {
      position: [0, -0.22, -0.15], rotation: [0.08, 0, 0], scale: [0.28, 0.34, 0.13],
    }, registry);
  }
}

function addHeadwear(head, identity, assets, mats, registry) {
  const g = assets.geometries;
  const style = identity.appearance.hat;
  if (!style || style === 'hood' || style === 'none') return;
  if (style === 'cap') {
    // Deepened rather than widened: it was an ellipsoid tapering to a point at
    // 0.07, so the part of it near the head was narrower than any hair under
    // it and the hair swelled out through the side. Reaching further down the
    // skull means the cap, not the hair, is what you see at the rim.
    addMesh(head, g.sphere, mats.dark, {
      position: [0, 0.175, -0.015], scale: [0.248, 0.135, 0.228],
    }, registry);
    addMesh(head, g.box, mats.dark, {
      position: [0, 0.145, 0.205], scale: [0.25, 0.035, 0.15],
    }, registry);
  } else if (style === 'brim') {
    // Worn down on the head rather than perched on the crown. The head is an
    // ellipsoid half a metre tall, so a brim up at 0.22 sat where the skull has
    // already narrowed to a sixth of its width and read as a disc hovering
    // above the head. Down here it crosses the skull at close to full width.
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.135, 0], scale: [0.34, 0.035, 0.34],
    }, registry);
    // The crown was radius 0.20 on a skull of 0.235 — narrower than the head
    // it was supposed to be covering, let alone the hair. Sized to the skull
    // with a little ease, and no wider: it still reads as a band well inside
    // the 0.34 brim.
    addMesh(head, g.cylinder, mats.secondary, {
      position: [0, 0.252, 0], scale: [0.243, 0.215, 0.224],
    }, registry);
  } else if (style === 'kerchief') {
    // Tied over the crown and knotted at the nape, so it covers the top of
    // whatever hair is under it and leaves the length showing.
    addMesh(head, g.sphere, mats.accent, {
      position: [0, 0.10, -0.02], scale: [0.262, 0.20, 0.232],
    }, registry);
    addMesh(head, g.smallSphere, mats.accent, {
      position: [0, 0.03, -0.21], scale: [0.07, 0.06, 0.07],
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

function createIntentPropLayer(bones, assets, mats, registry, castsShadow = () => true) {
  const g = assets.geometries;
  const handY = -0.13;
  const handProps = {
    letter: [g.box, mats.paper, { position: [0, handY, 0.055], rotation: [0.15, 0, 0], scale: [0.13, 0.012, 0.09] }],
    parcel: [g.box, mats.secondary, { position: [0, handY - 0.02, 0.08], scale: [0.21, 0.16, 0.16] }],
    basket: [g.box, mats.secondary, { position: [0, handY - 0.05, 0.04], scale: [0.18, 0.15, 0.14] }],
    lantern: [g.sphere, mats.accent, { position: [0, handY - 0.05, 0], scale: [0.07, 0.09, 0.07] }],
    staff: [g.cylinder, mats.dark, { position: [0, -0.68, 0.02], scale: [0.025, 1.25, 0.025] }],
    'damaged-equipment': [g.box, mats.dark, { position: [0, handY - 0.02, 0.08], rotation: [0.1, 0.2, 0], scale: [0.19, 0.12, 0.15] }],
    map: [g.box, mats.paper, { position: [0, handY, 0.11], rotation: [0.2, 0, 0], scale: [0.2, 0.012, 0.15] }],
  };
  const specs = new Map();
  for (const hand of [bones.leftHand, bones.rightHand]) {
    for (const [kind, spec] of Object.entries(handProps)) specs.set(`${hand.name}:${kind}`, [hand, ...spec]);
  }
  specs.set(`${bones.hips.name}:tools`, [bones.hips, g.box, mats.dark, { position: [0.24, 0.03, 0.03], scale: [0.12, 0.16, 0.08] }]);
  // Built on first use. A resident only ever shows one or two of these, yet
  // all fifteen used to be built up front and carried, hidden, through every
  // frame's matrix update.
  const props = [];
  const made = new Map();
  const ensure = (parent, kind) => {
    const key = `${parent.name}:${kind}`;
    if (made.has(key)) return made.get(key);
    const spec = specs.get(key);
    if (!spec) return null;
    const [owner, geometry, material, options] = spec;
    const mesh = addMesh(owner, geometry, material, options, registry);
    mesh.castShadow = castsShadow();
    mesh.userData.intentPropKind = kind;
    made.set(key, mesh);
    props.push(mesh);
    return mesh;
  };
  return {
    props,
    setLoadout(loadout = {}) {
      for (const mesh of props) mesh.visible = false;
      const show = (slot, parent) => {
        const item = loadout[slot];
        if (item) { const mesh = ensure(parent, item.prop); if (mesh) mesh.visible = true; }
      };
      show('leftHand', bones.leftHand); show('rightHand', bones.rightHand); show('hip', bones.hips);
    },
  };
}

/**
 * Everything worn over the two skinned garments.
 *
 * The cloaked family already proved the approach: an unskinned solid hung off
 * a bone, sized from the body rather than from the geometry's own units. Each
 * overlay here follows that, so nothing has to be re-skinned and a hem cannot
 * tear when a leg swings through it.
 *
 * A silhouette takes the trouser colour on purpose. The legs underneath are
 * still drawn and will pass through a skirt as it walks; matching the colour
 * is what makes that read as a leg under a skirt rather than as a clipping
 * error, and it is the same trick the robe uses.
 */
function addWardrobe(bones, bind, dims, identity, assets, mats, registry) {
  const wardrobe = identity.wardrobe;
  if (!wardrobe) return;
  const g = assets.geometries;

  // A tapered solid between two absolute heights, hung off a bone.
  const hang = (bone, anchorY, material, topY, bottomY, hemRadius) => {
    if (topY <= bottomY) return;
    const radiusScale = hemRadius / CLOAK_SOURCE.hemRadius;
    addMesh(bone, g.cloak, material, {
      position: [0, (topY + bottomY) * 0.5 - anchorY, 0],
      scale: [radiusScale, (topY - bottomY) / CLOAK_SOURCE.height, radiusScale],
    }, registry);
    return { topY, bottomY, hemRadius };
  };

  const kneeY = dims.ankleHeight + dims.shin;
  let hemAt = null;

  if (wardrobe.garment === 'skirt') {
    hemAt = hang(bones.hips, bind.hips[1], mats.dark,
      dims.hipHeight + dims.girth.pelvis * 0.35, dims.ankleHeight + dims.shin * 0.75,
      dims.girth.pelvis * 1.95);
  } else if (wardrobe.garment === 'tunic') {
    hemAt = hang(bones.chest, bind.chest[1], mats.primary,
      bind.chest[1] + dims.girth.chest * 0.25, dims.hipHeight - dims.thigh * 0.40,
      dims.girth.pelvis * 1.70);
  }

  if (wardrobe.layer === 'coat') {
    // Narrower than the robe and stopping below the knee, so the two never
    // read as the same garment.
    hemAt = hang(bones.chest, bind.chest[1], mats.secondary,
      bind.chest[1] + dims.girth.chest * 0.20, kneeY - dims.shin * 0.18,
      dims.girth.pelvis * 1.62) || hemAt;
  } else if (wardrobe.layer === 'waistcoat') {
    addMesh(bones.chest, g.cylinder, mats.secondary, {
      position: [0, -dims.girth.chest * 0.35, 0],
      scale: [dims.girth.chest * 1.12, dims.torsoLength * 0.46, dims.girth.chest * 0.86],
    }, registry);
  } else if (wardrobe.layer === 'shawl') {
    addMesh(bones.chest, g.sphere, mats.accent, {
      position: [0, dims.girth.chest * 0.18, 0],
      scale: [dims.shoulderWidth * 0.58, dims.girth.chest * 0.78, dims.girth.chest * 1.02],
    }, registry);
  }

  for (const item of wardrobe.workDress) {
    if (item === 'apron') {
      // Undyed linen across the front, from the waist to mid-thigh, and a
      // bib up the chest. Sits proud of the body so it never z-fights.
      addMesh(bones.hips, g.box, mats.paper, {
        position: [0, dims.girth.pelvis * 0.1 - dims.thigh * 0.34, dims.girth.pelvis * 1.02],
        scale: [dims.hipWidth * 0.86, dims.thigh * 1.05, 0.012],
      }, registry);
      addMesh(bones.chest, g.box, mats.paper, {
        position: [0, -dims.girth.chest * 0.30, dims.girth.chest * 1.10],
        scale: [dims.shoulderWidth * 0.46, dims.torsoLength * 0.34, 0.012],
      }, registry);
    } else if (item === 'armband') {
      // One arm only, and always the same one: a band on both reads as a
      // costume rather than as the mark of an office.
      addMesh(bones.leftUpperArm, g.cylinder, mats.accent, {
        position: [0, -dims.upperArm * 0.42, 0],
        scale: [dims.girth.upperArm * 1.18, dims.upperArm * 0.20, dims.girth.upperArm * 1.18],
      }, registry);
    } else if (item === 'rolled-sleeves') {
      // The shirt is skinned and cannot be shortened, so the forearm is given
      // back its skin over the top of it, with the roll itself at the elbow.
      // The shirt is skinned and cannot be shortened, so the lower arm is
      // given back its skin over the top of it. Sized against the SLEEVE, not
      // against the arm: the shirt tapers from `elbow * 0.92` to `wrist * 1.10`
      // along this bone, and a cylinder matched to bare-arm girth sits a
      // fraction of a millimetre inside that and z-fights the whole way down.
      // It covers only the lower two thirds, where the sleeve is narrowest and
      // the clearance is comfortable.
      for (const side of ['left', 'right']) {
        addMesh(bones[`${side}Forearm`], g.cylinder, mats.skin, {
          position: [0, -dims.forearm * 0.66, 0],
          scale: [dims.girth.wrist * 1.40, dims.forearm * 0.62, dims.girth.wrist * 1.40],
        }, registry);
        // The fold itself, thicker than both, so the eye reads a sleeve pushed
        // up an arm rather than an arm that changes colour halfway down.
        addMesh(bones[`${side}Forearm`], g.cylinder, mats.primary, {
          position: [0, -dims.forearm * 0.32, 0],
          scale: [dims.girth.elbow * 1.34, dims.forearm * 0.17, dims.girth.elbow * 1.34],
        }, registry);
      }
    } else if (item === 'satchel-strap') {
      addMesh(bones.chest, g.box, mats.dark, {
        position: [0, -dims.girth.chest * 0.18, dims.girth.chest * 0.92],
        rotation: [0, 0, 0.62],
        scale: [dims.shoulderWidth * 1.24, 0.045, 0.016],
      }, registry);
    }
  }

  if (wardrobe.trim.collar) {
    addMesh(bones.neck, g.torus, mats.accent, {
      position: [0, -dims.neck * 0.18, 0], rotation: [Math.PI / 2, 0, 0],
      scale: [dims.girth.neck * 1.55, dims.girth.neck * 1.55, dims.girth.neck * 0.9],
    }, registry);
  }
  if (wardrobe.trim.cuffs) {
    for (const side of ['left', 'right']) {
      addMesh(bones[`${side}Forearm`], g.cylinder, mats.accent, {
        position: [0, -dims.forearm * 0.86, 0],
        scale: [dims.girth.wrist * 1.42, dims.forearm * 0.11, dims.girth.wrist * 1.42],
      }, registry);
    }
  }
  if (wardrobe.trim.hem && hemAt) {
    const bone = wardrobe.garment === 'skirt' && wardrobe.layer !== 'coat'
      ? bones.hips : bones.chest;
    const anchorY = bone === bones.hips ? bind.hips[1] : bind.chest[1];
    addMesh(bone, g.cylinder, mats.accent, {
      position: [0, hemAt.bottomY + 0.018 - anchorY, 0],
      scale: [hemAt.hemRadius * 1.01, 0.032, hemAt.hemRadius * 1.01],
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
  // A bone rather than a plain group: the body is baked into one skinned mesh
  // below, and everything on the head is bound to this, so the gaze and
  // gesture rotations applied to `rig.head` move it exactly as before.
  const head = new THREE.Bone();
  head.name = 'headShape';
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
    // A small thumb on the palm side makes palm-up versus palm-down readable
    // when the wrist rolls, rather than rotating a symmetric mitten.
    addMesh(bones[`${side}Hand`], g.smallSphere, mats.skin, {
      position: [sign * dims.girth.wrist * 0.95, -dims.hand * 0.22, dims.girth.wrist * 0.60],
      rotation: [0, 0, sign * 0.45],
      scale: [dims.girth.wrist * 0.52, dims.hand * 0.32, dims.girth.wrist * 0.55],
    }, registry);
    // Ankle joint, then a boot that reaches forward from it. The foot bone sits
    // at the ankle, so the shoe is offset forward by half its length.
    addMesh(bones[`${side}Foot`], g.smallSphere, mats.dark, {
      scale: [dims.girth.ankle * 1.15, dims.girth.ankle * 1.15, dims.girth.ankle * 1.15],
    }, registry);
    addMesh(bones[`${side}Foot`], g.box, mats.dark, {
      // Leave a small sole margin below the neutral ankle contact. The old
      // centre/height put the box about 1cm through level ground before any
      // heel pitch was applied.
      position: [0, -dims.ankleHeight * 0.42, dims.footLength * 0.22],
      scale: [dims.girth.ankle * 2.0, dims.ankleHeight * 0.92, dims.footLength * 0.92],
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

  addWardrobe(bones, skeleton.bind, dims, identity, assets, mats, registry);
  const face = addFace(head, identity, assets, mats, registry);
  addHair(head, identity, assets, mats, registry);
  addHeadwear(head, identity, assets, mats, registry);

  const accessoryStart = registry.meshes.length;
  addAccessory(root, {
    dims, hips: bones.hips, torso: bones.chest, head,
    leftArm: bones.leftHand, rightArm: bones.rightHand,
    leftLeg: bones.leftThigh, rightLeg: bones.rightThigh,
  }, identity, assets, mats, registry);
  let staticAccessoryMeshes = registry.meshes.slice(accessoryStart);
  const intentProps = createIntentPropLayer(bones, assets, mats, registry, () => shadows);

  // --- one skinned draw for the whole body ---------------------------------
  // Everything above is authored as separate primitives on the bones. Bake
  // them, in this bind pose and before the root takes its scale, into
  // SkinnedMeshes that share one skeleton and one material (npcbodybake.js):
  //   body      — garments and every always-visible primitive
  //   face      — the near-detail features, visible only up close
  //   accessory — a carried or slung item, hidden while an intent prop shows
  // Intent props are built later, on demand, as ordinary meshes: they are
  // hidden nearly all the time.
  //
  // Eyes and mouth animate (blink, lip-sync) by scale and position, so each
  // first becomes a bone carrying its mesh's transform, and `face` points at
  // those bones; updateFace below drives them unchanged.
  const toBone = (mesh) => {
    const bone = new THREE.Bone();
    bone.name = 'npc-face-part';
    bone.position.copy(mesh.position);
    bone.quaternion.copy(mesh.quaternion);
    bone.scale.copy(mesh.scale);
    mesh.parent.add(bone);
    bone.add(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    return bone;
  };
  face.eyes = face.eyes.map(toBone);
  face.mouth = toBone(face.mouth);
  // A staff stands on the root itself; give such parts a static bone to bind to.
  const rootAnchor = new THREE.Bone();
  rootAnchor.name = 'npc-root-anchor';
  root.add(rootAnchor);
  const accessorySet = new Set(staticAccessoryMeshes);
  const nearSet = new Set(registry.nearMeshes);
  const bodyParts = [], faceParts = [], accessoryParts = [], keptNear = [];
  for (const mesh of registry.meshes) {
    if (mesh.parent === root) rootAnchor.add(mesh);
    if (accessorySet.has(mesh)) (nearSet.has(mesh) ? keptNear : accessoryParts).push(mesh);
    else (nearSet.has(mesh) ? faceParts : bodyParts).push(mesh);
  }
  root.updateMatrixWorld(true);
  const skeletonBones = [];
  root.traverse((object) => { if (object.isBone) skeletonBones.push(object); });
  const bodySkeleton = new THREE.Skeleton(skeletonBones);
  const bodyMesh = bakeSkinnedParts(bodyParts, bodySkeleton, assets.bodyMaterial, 'npc-body');
  const faceMesh = bakeSkinnedParts(faceParts, bodySkeleton, assets.bodyMaterial, 'npc-face');
  const accessoryMesh = bakeSkinnedParts(accessoryParts, bodySkeleton, assets.bodyMaterial, 'npc-accessory');
  for (const mesh of [...bodyParts, ...faceParts, ...accessoryParts]) mesh.removeFromParent();
  garments.pants.geometry.dispose();
  garments.shirt.geometry.dispose();
  const baked = [bodyMesh, faceMesh, accessoryMesh].filter(Boolean);
  // Skinned bounds are otherwise recomputed from the posed skeleton or, for
  // the old garments, skipped by switching culling off. One sphere in the
  // root's space that holds any reach (a raised hand, a pointing arm, a staff)
  // lets every pass cull the whole resident at once.
  const reach = new THREE.Sphere(new THREE.Vector3(0, dims.stature * 0.55, 0), dims.stature * 0.95);
  for (const mesh of baked) {
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.boundingSphere = reach.clone();
    root.add(mesh);
  }
  staticAccessoryMeshes = [accessoryMesh, ...keptNear].filter(Boolean);
  registry.meshes = [...baked, ...keptNear];
  registry.nearMeshes = [faceMesh, ...keptNear].filter(Boolean);

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
  const staticHand = ['lantern', 'basket', 'book', 'staff'].includes(identity.accessory) ? 'right'
    : identity.accessory === 'case' ? 'left' : null;
  const occupiedHands = { left: staticHand === 'left', right: staticHand === 'right' };
  const chestBindY = bones.chest.position.y;
  const eyeHeights = face.eyes.map(eye => eye.scale.y);
  const mouthScale = face.mouth.scale.clone(), mouthY = face.mouth.position.y;
  const faceState = { mouthOpen: 0, blink: 0 };
  let targetMouth = 0, faceUpdatedAt = null;
  const updateFace = (mouthOpen = targetMouth, now = (globalThis.performance?.now?.() ?? Date.now()) / 1000) => {
    targetMouth = Math.max(0, Math.min(1, Number(mouthOpen) || 0));
    const dt = faceUpdatedAt === null ? 0 : Math.max(0, Math.min(0.1, now - faceUpdatedAt));
    faceUpdatedAt = now;
    const rate = targetMouth > faceState.mouthOpen ? 28 : 20;
    faceState.mouthOpen += (targetMouth - faceState.mouthOpen) * (1 - Math.exp(-rate * dt));
    faceState.blink = npcBlinkAt(now, identity.seed);
    face.eyes.forEach((eye, i) => { eye.scale.y = eyeHeights[i] * (1 - faceState.blink * 0.96); });
    const amount = faceState.mouthOpen;
    face.mouth.scale.set(mouthScale.x * (1 - amount * 0.22), mouthScale.y * (1 + amount * 3.5), mouthScale.z);
    face.mouth.position.y = mouthY - amount * 0.012;
    return faceState;
  };

  return {
    root,
    rig,
    identity,
    dims,
    faceState,
    updateFace,
    setIntentLoadout(loadout = {}) {
      const dynamic = !!(loadout.leftHand || loadout.rightHand || loadout.hip || loadout.back);
      for (const mesh of staticAccessoryMeshes) mesh.visible = !dynamic;
      intentProps.setLoadout(loadout);
      occupiedHands.left = !!loadout.leftHand || !dynamic && staticHand === 'left';
      occupiedHands.right = !!loadout.rightHand || !dynamic && staticHand === 'right';
    },

    /**
     * Drive the skeleton from a solved bipedal pose (see npcgait.mjs).
     * `groundY` is the world height the root sits at, so the solved world-space
     * pelvis can be expressed in the root's local space.
     */
    applyPose(pose, groundY = 0, {
      gesture = 0, gestureHand = 'right', point = 0, pointHand = null,
      pointBearing = null, pointDistance = 200, pointElapsed = 0, pointHold = 2.6, pointTarget = null,
      actionKind = null, speech = null, speechGestureHand = gestureHand, furniturePose = null,
    } = {}) {
      const scaleY = identity.proportions.height || 1;
      bones.head.rotation.set(0, 0, 0);
      bones.chest.position.y = chestBindY;
      bones.hips.position.y = (pose.pelvis.y - groundY) / scaleY;
      // The pose is solved in world metres and the root scale is uniform, so the
      // lateral shift converts back into root space by the same divisor.
      bones.hips.position.x = pose.pelvis.sway / scaleY;
      bones.hips.position.z = 0;
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
      const lateralLean = (pose.turn?.lean || 0) + (pose.terrain?.crossSlope || 0) * 0.035;
      const gradeLean = Math.max(-0.12, Math.min(0.12, (pose.terrain?.grade || 0) * 0.12));
      // An older resident carries a permanent forward set through the spine.
      // Added to the solved lean rather than baked into the bind pose, because
      // the gait rewrites both of these rotations every frame.
      const stoop = identity.posture?.stoop || 0;
      bones.spine.rotation.set(pose.pelvis.lean * 0.85 + gradeLean + stoop, pose.torsoTwist * 0.5, lateralLean);
      bones.chest.rotation.set(pose.pelvis.lean * 0.5 + gradeLean * 0.45 + stoop * 0.55, pose.torsoTwist * 0.5, lateralLean * 0.45);

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
        bones[`${key}Foot`].rotation.z = leg.roll || 0;
      }
      for (const arm of pose.arms) {
        const key = arm.side < 0 ? 'left' : 'right';
        bones[`${key}UpperArm`].rotation.set(-arm.shoulder, 0, arm.out);
        bones[`${key}Forearm`].rotation.set(-arm.elbow, 0, 0);
        bones[`${key}Hand`].rotation.set(-arm.wrist, 0, 0);
      }

      applyInteriorFurniturePose(bones, furniturePose, scaleY);
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

      if (actionKind === 'consult-map') {
        bones.leftUpperArm.rotation.set(-0.72, 0, -0.22);
        bones.rightUpperArm.rotation.set(-0.72, 0, 0.22);
        bones.leftForearm.rotation.x = -0.82;
        bones.rightForearm.rotation.x = -0.82;
      } else if (actionKind === 'repair-boots') {
        bones.hips.position.y -= 0.16 / scaleY;
        bones.spine.rotation.x += 0.34;
        bones.leftUpperArm.rotation.x = -0.62;
        bones.rightUpperArm.rotation.x = -0.78;
        bones.leftForearm.rotation.x = -1.05;
        bones.rightForearm.rotation.x = -1.0;
      } else if (actionKind === 'drink-stream') {
        bones.hips.position.y -= 0.09 / scaleY;
        bones.spine.rotation.x += 0.42;
        bones.rightUpperArm.rotation.x = -0.9;
        bones.rightForearm.rotation.x = -1.15;
      } else if (actionKind === 'examine-marker') {
        bones.spine.rotation.x += 0.18;
        bones.leftUpperArm.rotation.x = -0.42;
        bones.leftForearm.rotation.x = -0.7;
      } else if (actionKind === 'repair-site') {
        bones.spine.rotation.x += 0.2;
        bones.rightUpperArm.rotation.x = -0.85;
        bones.rightForearm.rotation.x = -1.0;
      } else if (actionKind === 'shelter-rain') {
        bones.leftUpperArm.rotation.z -= 0.14;
        bones.rightUpperArm.rotation.z += 0.14;
        bones.spine.rotation.x += 0.08;
      } else if (actionKind === 'tend-garden') {
        // Down among the beds: low, bent over, both hands working the soil.
        bones.hips.position.y -= 0.24 / scaleY;
        bones.spine.rotation.x += 0.52;
        bones.leftUpperArm.rotation.x = -0.48;
        bones.rightUpperArm.rotation.x = -0.66;
        bones.leftForearm.rotation.x = -0.55;
        bones.rightForearm.rotation.x = -0.72;
      } else if (actionKind === 'hang-washing') {
        // Reaching up to the line with both hands.
        bones.spine.rotation.x -= 0.06;
        bones.leftUpperArm.rotation.set(-2.35, 0, -0.18);
        bones.rightUpperArm.rotation.set(-2.2, 0, 0.18);
        bones.leftForearm.rotation.x = -0.35;
        bones.rightForearm.rotation.x = -0.42;
      } else if (actionKind === 'window-watch') {
        // Hands on the sill, leaning a little into the view.
        bones.spine.rotation.x += 0.14;
        bones.leftUpperArm.rotation.set(-0.55, 0, -0.12);
        bones.rightUpperArm.rotation.set(-0.55, 0, 0.12);
        bones.leftForearm.rotation.x = -0.75;
        bones.rightForearm.rotation.x = -0.75;
      } else if (actionKind === 'lean-door') {
        // Easy in the doorway: weight off, one arm folded across.
        bones.spine.rotation.z += 0.06;
        bones.leftUpperArm.rotation.set(-0.35, 0, 0.32);
        bones.leftForearm.rotation.x = -1.55;
      }
      const name = speech?.gestureName;
      const duration = speech?.gestureDuration ?? NPC_GESTURES[name]?.duration;
      const availableHand = speechGestureHand === null ? null
        : !occupiedHands[speechGestureHand] ? speechGestureHand
        : !occupiedHands.left ? 'left' : !occupiedHands.right ? 'right' : null;
      const bothUnavailable = NPC_GESTURES[name]?.bothHands && (occupiedHands.left || occupiedHands.right);
      const expression = npcGesturePose(name, speech?.gestureElapsed, availableHand, duration);
      if (expression) for (const [key, rotation] of Object.entries(expression)) {
        // Pointing and carried props retain ownership of their hands. Head
        // gestures still work while both hands are occupied.
        const armSide = key.startsWith('left') ? 'left' : 'right';
        if (/(Arm|Hand)$/.test(key) && (point > 0.01 || availableHand === null
          || occupiedHands[armSide] || bothUnavailable || actionKind)) continue;
        if (!bones[key]) continue;
        bones[key].rotation.x += rotation[0];
        bones[key].rotation.y += rotation[1];
        bones[key].rotation.z += rotation[2];
      }
      bones.chest.position.y += npcGestureChestBounce(name, speech?.gestureElapsed, duration, dims.torsoLength);
      if (availableHand && !bothUnavailable && point <= 0.01 && !actionKind) {
        for (const target of npcGestureArmTargets(name, speech?.gestureElapsed, dims, availableHand, duration)) {
          if (occupiedHands[target.side]) continue;
          const upper = bones[`${target.side}UpperArm`], fore = bones[`${target.side}Forearm`], wrist = bones[`${target.side}Hand`];
          const anchor = target.anchor === 'head' ? head : bones.chest;
          anchor.updateWorldMatrix(true, false);
          reachWorld.fromArray(target.offset).applyMatrix4(anchor.matrixWorld);
          upper.parent.updateWorldMatrix(true, false);
          reachLocal.copy(reachWorld);
          upper.parent.worldToLocal(reachLocal).sub(upper.position);
          const solved = solveNpcArmReach(reachLocal.toArray(), dims.upperArm, dims.forearm, target.pole);
          if (!solved) continue;
          reachUpper.fromArray(solved.upper); upperTarget.setFromUnitVectors(armDown, reachUpper);
          inverseUpper.copy(upperTarget).invert();
          reachLower.fromArray(solved.lower).applyQuaternion(inverseUpper);
          foreTarget.setFromUnitVectors(armDown, reachLower);
          palmTarget.setFromEuler(palmEuler.set(target.palmPitch || 0, target.palm, 0));
          handTarget.copy(upperTarget).multiply(foreTarget).invert().multiply(palmTarget);
          upper.quaternion.slerp(upperTarget, target.weight);
          fore.quaternion.slerp(foreTarget, target.weight);
          wrist.quaternion.slerp(handTarget, target.weight);
        }
      }
      // Aim last so posture, torso twist and speech bounce cannot deflect it.
      this.applyPoint({ point, pointHand: pointHand || gestureHand,
        pointBearing, pointDistance, pointElapsed, pointHold, pointTarget });
      updateFace(speech?.mouthOpen || 0);
    },

    applyPoint({ point = 0, pointHand = 'right', pointBearing = null,
      pointDistance = 200, pointElapsed = 0, pointHold = 2.6, pointTarget = null } = {}) {
      if (!(point > 0.001)) return;
      let key = pointHand === 'left' ? 'left' : 'right';
      if (occupiedHands[key]) key = key === 'left' ? 'right' : 'left';
      if (occupiedHands[key]) return;
      const upper = bones[`${key}UpperArm`], fore = bones[`${key}Forearm`], hand = bones[`${key}Hand`];
      upper.getWorldPosition(pointShoulder);
      root.getWorldQuaternion(pointParent);
      pointForward.set(0, 0, 1).applyQuaternion(pointParent).setY(0).normalize();
      const bearing = Number.isFinite(pointBearing) ? pointBearing : Math.atan2(pointForward.x, pointForward.z);
      const hasTarget = Number.isFinite(pointTarget?.worldX) && Number.isFinite(pointTarget?.worldZ);
      const aimFrom = position => {
        if (hasTarget) pointDirection.set(pointTarget.worldX - position.x, 0, pointTarget.worldZ - position.z);
        else pointDirection.set(Math.sin(bearing), 0, Math.cos(bearing));
        return pointDirection.normalize();
      };
      aimFrom(pointShoulder);
      if (pointDirection.lengthSq() < 0.5) return;
      const angle = Math.acos(Math.max(-1, Math.min(1, pointForward.dot(pointDirection))));
      const weight = Math.min(1, point) * npcPointTurnWeight(angle);
      if (weight <= 0.001) return;
      const motion = npcPointMotion(pointDistance, pointElapsed, pointHold);
      const pitch = angle => { pointDirection.multiplyScalar(Math.cos(angle)); pointDirection.y = Math.sin(angle); };
      const orient = bone => {
        bone.parent.getWorldQuaternion(pointParent);
        pointWorld.setFromUnitVectors(armDown, pointDirection);
        pointParent.invert().multiply(pointWorld);
        bone.quaternion.slerp(pointParent, weight);
      };
      pitch(motion.upperPitch); orient(upper);
      // Aim from the actual elbow, including the shoulder offset, body lean,
      // root scale, and any still-blending lift. This removes the old lateral
      // fan-out and stays correct as the body turns or the speaker moves.
      fore.getWorldPosition(pointElbow);
      aimFrom(pointElbow); pitch(motion.forePitch); orient(fore);
      // The hand's -Y follows the forearm; its broad +Z face is the palm.
      // Build a world frame to turn that face up nearby and down farther away.
      pointY.copy(pointDirection).negate();
      pointZ.set(0, motion.palmUp ? 1 : -1, 0);
      pointZ.addScaledVector(pointY, -pointZ.dot(pointY)).normalize();
      pointX.crossVectors(pointY, pointZ).normalize();
      pointFrame.makeBasis(pointX, pointY, pointZ);
      pointWorld.setFromRotationMatrix(pointFrame);
      hand.parent.getWorldQuaternion(pointParent);
      pointParent.invert().multiply(pointWorld);
      hand.quaternion.slerp(pointParent, weight);
    },

    setDetail(distance, { xr = false } = {}) {
      updateFace();
      // Eyes, nose and mouth are a few centimetres: about one composer pixel
      // at 50 m even on a 4K Ultra canvas, and well under one at the former
      // 78 m — draw calls spent on sub-pixel shimmer across a whole village.
      const nextNear = distance < (xr ? 38 : 50);
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
      // Primitive geometry and materials belong to the shared asset library;
      // the baked body geometry and the skeleton's bone texture are this
      // avatar's own.
      for (const mesh of baked) mesh.geometry.dispose();
      bodySkeleton.dispose();
      root.removeFromParent();
    },
  };
}
