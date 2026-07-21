// Procedural SDF wildlife for WANDER.
//
// Animals are authored as ordinary low-poly spheres, capsules and cones. The
// disconnected source meshes are merged into one BufferGeometry, then an SDF
// vertex pass projects them onto the smooth union of every animated primitive.
// This removes joint seams, derives continuous normals from the SDF gradient,
// and blends pigment by primitive proximity. Animation uses one rigid owner
// transform per vertex (not blended skinning) stored in a tiny float texture.
// Hooves are planted by reactive IK; tail and ear owners follow Verlet ropes.
// The result remains one conventional mesh draw per animal with no raymarching.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  animalAwareness,
  arcTurnRate,
  chooseTerrainHeading,
  terrainSpeedScale,
  turnSpeedScale,
} from './animalbehavior.mjs';
import { ANIMAL_RECIPES, LEG_ORDER, animalBindDimensions } from './animaldata.mjs';
import {
  advanceReactiveFoot,
  createReactiveFootState,
  forwardKinematics2D,
  predictiveFootholdDistance,
  quadrupedPose,
  quadrupedLegLimits,
  quadrupedTiming,
  solveThreeLinkIK,
  springStep,
} from './animalgait.mjs';
import { mulberry32 } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const TAU = Math.PI * 2;

const SHAPE_ELLIPSOID = 0;
const SHAPE_CAPSULE = 1;
const SHAPE_CONE = 2;
const SHAPE_TEXELS = 3;
// Only bounds the data-texture width and the merge-time error check; the
// per-vertex shader cost is capped separately by MAX_SHAPE_NEIGHBOURS.
const MAX_ANIMAL_SHAPES = 96;
const NEIGHBOUR_LANES = 5;
const MAX_SHAPE_NEIGHBOURS = NEIGHBOUR_LANES * 4;
const PALETTE_KEYS = ['coat', 'dark', 'light', 'cream', 'black', 'eye', 'antler', 'glint'];
const PALETTE_INDEX = Object.fromEntries(PALETTE_KEYS.map((key, index) => [key, index]));

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * Math.min(dt, 0.1)));
}
function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function localMatrix(position = [0, 0, 0], rotation = [0, 0, 0]) {
  tmpV.fromArray(position);
  tmpEuler.set(rotation[0], rotation[1], rotation[2], 'XYZ');
  tmpQ.setFromEuler(tmpEuler);
  return new THREE.Matrix4().compose(tmpV, tmpQ, tmpScale.set(1, 1, 1));
}

function prepareGeometry(source, scale, owner) {
  let geometry = source;
  if (source.index) {
    geometry = source.toNonIndexed();
    source.dispose();
  }
  geometry.scale(scale[0], scale[1], scale[2]);
  const owners = new Float32Array(geometry.attributes.position.count);
  owners.fill(owner);
  geometry.setAttribute('aAnimalOwner', new THREE.Float32BufferAttribute(owners, 1));
  return geometry;
}

function addShape(parts, shapes, rig, {
  boneName, colour, type, geometry, position = [0, 0, 0], rotation = [0, 0, 0],
  scale = [1, 1, 1], params = scale, blend = 0.12,
}) {
  if (!rig.byName[boneName]) throw new Error(`Unknown animal bone ${boneName}`);
  const owner = shapes.length;
  parts.push(prepareGeometry(geometry, scale, owner));
  shapes.push({
    boneName,
    colour: PALETTE_INDEX[colour],
    type,
    params: new THREE.Vector3().fromArray(params),
    blend,
    localMatrix: localMatrix(position, rotation),
  });
}

function ellipsoidPart(parts, shapes, rig, boneName, colour, position, scale, blend = 0.14, rotation = [0, 0, 0]) {
  addShape(parts, shapes, rig, {
    boneName, colour, type: SHAPE_ELLIPSOID,
    geometry: new THREE.SphereGeometry(1, 16, 10), position, rotation, scale, params: scale, blend,
  });
}

function capsulePart(parts, shapes, rig, boneName, colour, length, radius, direction = 1, blend = 0.10) {
  const straight = Math.max(0.015, length - radius * 2);
  addShape(parts, shapes, rig, {
    boneName, colour, type: SHAPE_CAPSULE,
    geometry: new THREE.CapsuleGeometry(radius, straight, 3, 10),
    position: [0, direction * length * 0.5, 0],
    params: [radius, straight * 0.5, 0], blend,
  });
}

function conePart(parts, shapes, rig, boneName, colour, position, scale, rotation = [0, 0, 0], blend = 0.055) {
  addShape(parts, shapes, rig, {
    boneName, colour, type: SHAPE_CONE,
    geometry: new THREE.ConeGeometry(1, 1, 7, 2, false),
    position, rotation, scale, params: scale, blend,
  });
}

function capsuleBetween(parts, shapes, rig, boneName, colour, a, b, radius, blend = 0.032) {
  tmpV.fromArray(a);
  tmpV2.fromArray(b);
  const direction = tmpV2.clone().sub(tmpV);
  const length = direction.length();
  if (length < 1e-5) return;
  const straight = Math.max(0.008, length - radius * 2);
  tmpQ.setFromUnitVectors(UP, direction.normalize());
  const center = tmpV.add(tmpV2).multiplyScalar(0.5);
  tmpEuler.setFromQuaternion(tmpQ, 'XYZ');
  addShape(parts, shapes, rig, {
    boneName, colour, type: SHAPE_CAPSULE,
    geometry: new THREE.CapsuleGeometry(radius, straight, 3, 10),
    position: center.toArray(), rotation: [tmpEuler.x, tmpEuler.y, tmpEuler.z],
    params: [radius, straight * 0.5, 0], blend: Math.min(blend, radius * 0.72),
  });
}

function bone(name, parent, position, rotation = [0, 0, 0]) {
  const result = new THREE.Bone();
  result.name = name;
  result.position.fromArray(position);
  result.rotation.set(rotation[0], rotation[1], rotation[2]);
  result.userData.bindPosition = result.position.clone();
  result.userData.bindRotation = result.rotation.clone();
  result.userData.bindQuaternion = result.quaternion.clone();
  parent?.add(result);
  return result;
}

function createRig(recipe) {
  const dimensions = animalBindDimensions(recipe);
  const root = bone('root', null, [0, 0, 0]);
  const body = bone('body', root, [0, dimensions.bodyY, 0]);
  const neckBase = bone('neckBase', body,
    [0, recipe.body[1] * 0.13, recipe.shoulderZ], [recipe.neck.bind[0], 0, 0]);
  const neck = bone('neck', neckBase,
    [0, recipe.neck.lengths[0], 0], [recipe.neck.bind[1], 0, 0]);
  const head = bone('head', neck, [0, recipe.neck.lengths[1], 0], [recipe.headPitch || 0, 0, 0]);
  const tailCount = recipe.tail.segments || (recipe.id === 'fox' ? 5 : 3);
  const tailSegmentLength = recipe.tail.length / tailCount;
  const tailBones = [];
  for (let i = 0; i < tailCount; i++) {
    const name = i === 0 ? 'tail' : i === tailCount - 1 ? 'tailTip' : `tail${i}`;
    const parent = i === 0 ? body : tailBones[i - 1];
    const position = i === 0
      ? [0, recipe.tail.lift ?? 0.02, -recipe.body[2] * (recipe.tail.root || 0.48)]
      : [0, tailSegmentLength, 0];
    const rotation = i === 0
      ? [recipe.tail.angle, 0, 0]
      : [recipe.tail.bend / Math.max(1, tailCount - 1), 0, 0];
    tailBones.push(bone(name, parent, position, rotation));
  }
  const earAngle = recipe.earAngle ?? 0.17;
  const earSegmentLength = recipe.ear[1] / 3;
  const earChains = [];
  for (const [sideName, side] of [['Left', -1], ['Right', 1]]) {
    const chain = [];
    for (let i = 0; i < 3; i++) {
      const name = `ear${sideName}${i === 0 ? '' : i}`;
      const parent = i === 0 ? head : chain[i - 1];
      const position = i === 0
        ? [side * recipe.head[0] * 0.70, recipe.head[1] * 0.68, -0.03]
        : [0, earSegmentLength, 0];
      chain.push(bone(name, parent, position,
        i === 0 ? [recipe.earSweep || 0, 0, -side * earAngle] : [0, 0, 0]));
    }
    earChains.push(chain);
  }

  const legRoots = {
    frontLeft: [-recipe.leg.front.x, dimensions.shoulderY - dimensions.bodyY, recipe.shoulderZ],
    frontRight: [recipe.leg.front.x, dimensions.shoulderY - dimensions.bodyY, recipe.shoulderZ],
    hindLeft: [-recipe.leg.hind.x, dimensions.hipY - dimensions.bodyY, recipe.hipZ],
    hindRight: [recipe.leg.hind.x, dimensions.hipY - dimensions.bodyY, recipe.hipZ],
  };
  for (const name of LEG_ORDER) {
    const chain = name.startsWith('front') ? recipe.leg.front : recipe.leg.hind;
    const stagger = (chain.stagger || 0) * (name.endsWith('Left') ? -1 : 1);
    const upper = bone(`${name}Upper`, body, legRoots[name], [chain.bind[0] + stagger, 0, 0]);
    const lower = bone(`${name}Lower`, upper, [0, -chain.lengths[0], 0], [chain.bind[1] - stagger, 0, 0]);
    const pastern = bone(`${name}Pastern`, lower, [0, -chain.lengths[1], 0], [chain.bind[2], 0, 0]);
    bone(`${name}Hoof`, pastern, [0, -chain.lengths[2], 0]);
  }

  root.updateMatrixWorld(true);
  const ordered = [];
  root.traverse((candidate) => { if (candidate.isBone) ordered.push(candidate); });
  const byName = Object.fromEntries(ordered.map((candidate) => [candidate.name, candidate]));
  return {
    root,
    ordered,
    byName,
    dimensions,
    ropeChains: {
      tail: { bones: tailBones, segmentLength: tailSegmentLength },
      earLeft: { bones: earChains[0], segmentLength: earSegmentLength },
      earRight: { bones: earChains[1], segmentLength: earSegmentLength },
    },
  };
}

function buildAnimalModel(recipe) {
  const rig = createRig(recipe);
  const parts = [];
  const shapes = [];
  const torsoY = recipe.torsoY || 0;

  // Generous overlap is intentional: the vertex shader replaces these raw
  // intersections with one smooth-min surface.
  ellipsoidPart(parts, shapes, rig, 'body', 'coat', [0, torsoY, 0],
    [recipe.body[0], recipe.body[1], recipe.body[2] * 0.50], 0.25);
  ellipsoidPart(parts, shapes, rig, 'body', recipe.id === 'whitetail' ? 'coat' : 'light', [0, torsoY + 0.04, recipe.shoulderZ],
    [recipe.chest[0], recipe.chest[1], recipe.chest[2] * 0.50], 0.24);
  ellipsoidPart(parts, shapes, rig, 'body', 'coat', [0, torsoY + 0.01, recipe.hipZ],
    [recipe.rump[0], recipe.rump[1], recipe.rump[2] * 0.50], 0.24);
  ellipsoidPart(parts, shapes, rig, 'body', 'cream',
    [0, torsoY - recipe.body[1] * 0.78, 0.10],
    [recipe.body[0] * 0.70, recipe.body[1] * 0.20, recipe.body[2] * 0.33], 0.075);
  // Scapular/neck-base mass is a crucial side/front silhouette landmark. It
  // is deliberately species-weighted instead of being hidden in one torso egg.
  ellipsoidPart(parts, shapes, rig, 'body', recipe.id === 'moose' ? 'dark' : 'coat',
    [0, torsoY + recipe.body[1] * (recipe.id === 'moose' ? 0.35 : 0.24), recipe.shoulderZ - 0.05],
    [recipe.chest[0] * 0.74, recipe.chest[1] * (recipe.id === 'fox' ? 0.48 : recipe.id === 'moose' ? 0.34 : 0.42), recipe.chest[2] * 0.34],
    recipe.id === 'moose' ? 0.20 : 0.14);

  capsulePart(parts, shapes, rig, 'neckBase', 'coat',
    recipe.neck.lengths[0], recipe.neck.radii[0], 1, 0.18);
  capsulePart(parts, shapes, rig, 'neck', 'coat',
    recipe.neck.lengths[1], recipe.neck.radii[1], 1, 0.14);
  ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, 0.01, 0.05],
    [recipe.head[0], recipe.head[1], recipe.head[2] * 0.50], 0.17);
  if (recipe.id === 'fox') {
    // White stays on the lower muzzle and chin; the bridge above remains red.
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.048, 0.19],
      [recipe.muzzle[0], recipe.muzzle[1] * 0.80, 0.17], 0.075);
    // A narrow, tapered bridge and tip give the muzzle its sharp vulpine
    // wedge instead of the earlier blunt tube.
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, 0.042, 0.31],
      [recipe.muzzle[0] * 0.58, recipe.muzzle[1] * 0.54, 0.16], 0.055);
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.030, 0.33],
      [recipe.muzzle[0] * 0.54, recipe.muzzle[1] * 0.44, 0.15], 0.040);
    for (const side of [-1, 1]) {
      // White cheek fur sits below the eye line and rolls under the jaw —
      // keeping it low leaves the eye on open coat instead of burying it.
      ellipsoidPart(parts, shapes, rig, 'head', 'cream', [side * 0.112, -0.078, 0.13],
        [0.082, 0.092, 0.100], 0.045, [0, 0, side * 0.10]);
      // Dark tear-line running from the inner eye corner down the muzzle.
      ellipsoidPart(parts, shapes, rig, 'head', 'dark', [side * 0.118, -0.038, 0.21],
        [0.018, 0.013, 0.052], 0.010, [0.10, side * 0.12, 0]);
    }
    ellipsoidPart(parts, shapes, rig, 'head', 'black', [0, -0.008, 0.435],
      [0.052, 0.042, 0.042], 0.015);
  } else if (recipe.id === 'whitetail') {
    ellipsoidPart(parts, shapes, rig, 'head', 'light', [0, -0.035, 0.28],
      [recipe.muzzle[0], recipe.muzzle[1], 0.20], 0.065);
    // Narrower nose bridge tapers the muzzle toward the nose pad and keeps
    // the profile level rather than drooping.
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, 0.020, 0.43],
      [recipe.muzzle[0] * 0.62, recipe.muzzle[1] * 0.60, 0.20], 0.048);
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.080, 0.37],
      [recipe.muzzle[0] * 1.10, recipe.muzzle[1] * 0.55, 0.21], 0.035);
    ellipsoidPart(parts, shapes, rig, 'head', 'black', [0, -0.030, 0.61],
      [0.050, 0.044, 0.050], 0.016);
    // White chin patch tucked under the nose — a signature whitetail marking.
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.115, 0.52],
      [0.048, 0.028, 0.062], 0.026);
    // Slightly darker crown between the ears.
    ellipsoidPart(parts, shapes, rig, 'head', 'dark', [0, recipe.head[1] * 0.56, -0.02],
      [recipe.head[0] * 0.60, 0.046, recipe.head[2] * 0.26], 0.045);
    for (const side of [-1, 1]) {
      ellipsoidPart(parts, shapes, rig, 'head', 'light',
        [side * recipe.head[0] * 0.72, recipe.head[1] * 0.10, recipe.head[2] * 0.46],
        [0.075, 0.052, 0.060], 0.026, [0, 0, -side * 0.12]);
    }
  } else {
    ellipsoidPart(parts, shapes, rig, 'head', 'light', [0, -0.11, 0.52],
      [recipe.muzzle[0], recipe.muzzle[1], recipe.muzzle[2] * 0.50], 0.14);
    ellipsoidPart(parts, shapes, rig, 'head', 'light', [0, -0.15, 0.85],
      [recipe.muzzle[0] * 1.02, recipe.muzzle[1] * 0.86, recipe.muzzle[2] * 0.20], 0.080);
    ellipsoidPart(parts, shapes, rig, 'head', 'black', [0, -0.14, 0.96],
      [recipe.muzzle[0] * 0.82, recipe.muzzle[1] * 0.54, 0.055], 0.020);
  }

  // Species-specific eye builds: large dark eyes ringed in cream for the
  // deer, slanted amber eyes with a proud pupil for the fox, and small
  // deep-set eyes for the moose. Insets are chosen so each eye's outer
  // surface clears the head ellipsoid — a buried eye renders as nothing.
  const EYE = {
    whitetail: { inset: 0.92, depth: 0.50, scale: [0.024, 0.046, 0.036], ring: [0.020, 0.058, 0.047], glint: [0.008, 0.009, 0.007], tilt: 0.10 },
    fox: { inset: 0.88, depth: 0.38, scale: [0.048, 0.042, 0.034], ring: null, glint: [0.010, 0.011, 0.009], tilt: 0.30 },
    moose: { inset: 0.90, depth: 0.36, scale: [0.045, 0.050, 0.040], ring: null, glint: [0.012, 0.014, 0.010], tilt: 0 },
  }[recipe.id];
  for (const side of [-1, 1]) {
    const eyeX = side * recipe.head[0] * EYE.inset;
    const eyeY = recipe.head[1] * 0.14;
    const eyeZ = recipe.head[2] * EYE.depth;
    if (EYE.ring) {
      // Pale orbital ring: a slightly taller shell just inboard of the eye,
      // so the dark eye pokes through its centre.
      ellipsoidPart(parts, shapes, rig, 'head', 'cream',
        [eyeX - side * 0.006, eyeY, eyeZ], EYE.ring, 0.018, [0, 0, side * EYE.tilt]);
    }
    ellipsoidPart(parts, shapes, rig, 'head', 'eye',
      [eyeX, eyeY, eyeZ], EYE.scale, 0.012,
      [0, side * (recipe.id === 'fox' ? 0.26 : 0), side * EYE.tilt]);
    if (recipe.id === 'fox') {
      // Vertical pupil breaking the outer surface of the amber iris.
      ellipsoidPart(parts, shapes, rig, 'head', 'black',
        [eyeX + side * EYE.scale[0] * 0.55, eyeY, eyeZ + 0.004],
        [EYE.scale[0] * 0.45, 0.026, 0.020], 0.008, [0, side * 0.26, side * EYE.tilt]);
    }
    if (recipe.id === 'moose') {
      ellipsoidPart(parts, shapes, rig, 'head', 'glint',
        [side * recipe.head[0] * (EYE.inset + 0.03), recipe.head[1] * 0.17, eyeZ + 0.0204],
        EYE.glint, 0.006);
    } else {
      // Catch-light rides the upper-front curve of the eyeball itself.
      ellipsoidPart(parts, shapes, rig, 'head', 'glint',
        [eyeX + side * EYE.scale[0] * 0.62, eyeY + EYE.scale[1] * 0.38, eyeZ + EYE.scale[2] * 0.30],
        EYE.glint, 0.006);
    }
  }

  // Ears are short articulated SDF ropes rather than a single rigid cone.
  // Overlapping tapered sections retain a pointed silhouette while smooth-min
  // projection makes all three moving segments one continuous surface.
  for (const sideName of ['Left', 'Right']) {
    const chain = rig.ropeChains[`ear${sideName}`];
    for (let i = 0; i < chain.bones.length; i++) {
      const t = i / Math.max(1, chain.bones.length - 1);
      const width = recipe.ear[0] * (0.58 - t * 0.30);
      const depth = recipe.ear[2] * (0.54 - t * 0.27);
      if (recipe.id === 'whitetail' && i === chain.bones.length - 1) {
        conePart(parts, shapes, rig, chain.bones[i].name, 'coat',
          [0, chain.segmentLength * 0.55, 0],
          [width * 1.05, chain.segmentLength * 1.55, depth], [0.04, 0, 0], 0.045);
      } else {
        ellipsoidPart(parts, shapes, rig, chain.bones[i].name,
          recipe.id === 'fox' && i === chain.bones.length - 1 ? 'dark' : 'coat',
          [0, chain.segmentLength * 0.50, 0],
          [width, chain.segmentLength * (0.92 - t * 0.10), depth], 0.070, [0.04, 0, 0]);
      }
      if (recipe.id === 'whitetail' && i < 2) {
        ellipsoidPart(parts, shapes, rig, chain.bones[i].name, 'light',
          [0, chain.segmentLength * 0.54, depth * 0.70],
          [width * 0.62, chain.segmentLength * (0.66 - t * 0.08), depth * 0.45],
          0.026, [0.04, 0, 0]);
      }
    }
  }

  for (const name of LEG_ORDER) {
    const isFront = name.startsWith('front');
    const chain = isFront ? recipe.leg.front : recipe.leg.hind;
    const lowerColour = recipe.id === 'whitetail' ? 'coat' : recipe.id === 'moose' ? 'light' : 'dark';
    const kneeRadius = Math.max(chain.radii[0] * 0.82, chain.radii[1] * 1.30);
    const hockRadius = Math.max(chain.radii[1] * 0.88, chain.radii[2] * 1.40);
    const kneeOverlap = kneeRadius * 0.78;
    const hockOverlap = hockRadius * 0.72;
    // Limb shafts deliberately continue through their skeletal pivot. The
    // overlapping volume gives smooth-min enough shared skin to form a broad,
    // fleshy transition instead of joining two capsule tips in an hourglass.
    capsulePart(parts, shapes, rig, `${name}Upper`, 'coat',
      chain.lengths[0] + kneeOverlap, chain.radii[0], -1, 0.13);
    // Upper-limb ellipsoids read as scapular/triceps mass in front and thigh/
    // glute mass behind; they also soften the transition into the torso SDF.
    ellipsoidPart(parts, shapes, rig, `${name}Upper`, 'coat',
      [0, -chain.lengths[0] * (isFront ? 0.30 : 0.34), isFront ? -chain.radii[0] * 0.10 : 0],
      [chain.radii[0] * (isFront ? 1.08 : 1.25), chain.lengths[0] * (isFront ? 0.27 : 0.32), chain.radii[0] * (isFront ? 1.12 : 1.32)],
      0.085);
    capsulePart(parts, shapes, rig, `${name}Lower`, lowerColour,
      chain.lengths[1] + hockOverlap, chain.radii[1], -1, 0.105);
    // Rounded elbow/knee mass. It is owned by the child hinge so it follows
    // articulation, while its near-spherical proportions hide that ownership.
    ellipsoidPart(parts, shapes, rig, `${name}Lower`, lowerColour,
      [0, -kneeRadius * 0.08, 0],
      [kneeRadius * 1.02, kneeRadius * 1.10, kneeRadius * 1.08], 0.12);
    capsulePart(parts, shapes, rig, `${name}Pastern`, lowerColour,
      chain.lengths[2], chain.radii[2], -1, 0.082);
    // The hock/carpal pad overlaps both the lower shaft and pastern, keeping
    // the skin full when the joint reaches the extremes of its gait range.
    ellipsoidPart(parts, shapes, rig, `${name}Pastern`, lowerColour,
      [0, -hockRadius * 0.05, 0],
      [hockRadius * 1.04, hockRadius * 1.08, hockRadius * 1.12], 0.10);
    if (recipe.id === 'whitetail') {
      for (const hoofSide of [-1, 1]) {
        ellipsoidPart(parts, shapes, rig, `${name}Hoof`, 'black',
          [hoofSide * recipe.leg.hoof[0] * 0.34, -recipe.leg.hoof[1] * 0.42,
            recipe.leg.hoof[2] * 0.12],
          [recipe.leg.hoof[0] * 0.62, recipe.leg.hoof[1], recipe.leg.hoof[2]],
          0.034, [0, hoofSide * 0.07, 0]);
      }
    } else {
      ellipsoidPart(parts, shapes, rig, `${name}Hoof`, 'black',
        [0, -recipe.leg.hoof[1] * 0.42, recipe.leg.hoof[2] * 0.12], recipe.leg.hoof, 0.045);
    }
  }

  // Each tail section owns ordinary vertices and an SDF primitive. The rope
  // can bend at every link without revealing a capsule seam or adding a draw.
  const tailChain = rig.ropeChains.tail;
  for (let i = 0; i < tailChain.bones.length; i++) {
    const t = i / Math.max(1, tailChain.bones.length - 1);
    const radius = recipe.tail.radius
      + (recipe.tail.tipRadius - recipe.tail.radius) * t;
    const isLightTip = (recipe.id === 'whitetail' && i === tailChain.bones.length - 1)
      || (recipe.id === 'fox' && i === tailChain.bones.length - 1);
    ellipsoidPart(parts, shapes, rig, tailChain.bones[i].name,
      isLightTip ? 'cream' : 'coat',
      [0, tailChain.segmentLength * 0.50, 0],
      // Segments overlap along the chain (y > half the segment) so the brush
      // reads as one tapered plume instead of a row of beads.
      [radius, tailChain.segmentLength * (recipe.id === 'fox' ? 0.86 : 0.64), radius],
      recipe.id === 'fox' ? 0.115 : 0.062);
  }
  if (recipe.id === 'fox') {
    // White throat running down the neck underside into a modest chest bib —
    // a strip hugging the surface, not a sphere hanging off the sternum.
    ellipsoidPart(parts, shapes, rig, 'neckBase', 'cream',
      [0, recipe.neck.lengths[0] * 0.45, 0.145], [0.10, recipe.neck.lengths[0] * 0.42, 0.075], 0.045);
    ellipsoidPart(parts, shapes, rig, 'body', 'cream',
      [0, torsoY + 0.06, recipe.shoulderZ + 0.13], [0.12, 0.155, 0.085], 0.075);
  }
  if (recipe.id === 'whitetail') {
    ellipsoidPart(parts, shapes, rig, 'body', 'cream',
      [0, torsoY + 0.05, recipe.shoulderZ + 0.20], [0.17, 0.38, 0.22], 0.052);
    // Throat patches hug the neck surface with a generous blend so they
    // feather into the coat instead of reading as attached spheres.
    ellipsoidPart(parts, shapes, rig, 'neckBase', 'cream',
      [0, recipe.neck.lengths[0] * 0.46, 0.17], [0.115, recipe.neck.lengths[0] * 0.34, 0.095], 0.070);
    ellipsoidPart(parts, shapes, rig, 'neck', 'cream',
      [0, recipe.neck.lengths[1] * 0.30, 0.14], [0.095, recipe.neck.lengths[1] * 0.30, 0.080], 0.060);
  }
  if (recipe.id === 'moose') {
    ellipsoidPart(parts, shapes, rig, 'body', 'dark',
      [0, torsoY + recipe.body[1] * 0.45, recipe.shoulderZ - 0.06],
      [recipe.chest[0] * 0.72, recipe.chest[1] * 0.30, recipe.chest[2] * 0.44], 0.15);
    conePart(parts, shapes, rig, 'neckBase', 'dark', [0, recipe.neck.lengths[0] * 0.24, 0.10],
      [0.31, 1.02, 0.27], [Math.PI, 0, 0], 0.065);
    for (const side of [-1, 1]) {
      ellipsoidPart(parts, shapes, rig, 'head', 'antler', [side * 0.45, 0.34, 0.04],
        [0.17, 0.11, 0.08], 0.035, [0, side * 0.20, side * 0.08]);
      ellipsoidPart(parts, shapes, rig, 'head', 'antler', [side * 0.84, 0.50, 0.15],
        [0.50, 0.12, 0.055], 0.060, [0, side * 0.50, side * 0.10]);
      ellipsoidPart(parts, shapes, rig, 'head', 'antler', [side * 1.18, 0.58, 0.22],
        [0.25, 0.13, 0.045], 0.050, [0, side * 0.46, side * 0.16]);
    }
  }
  for (const [a, b, radius] of recipe.antlers) {
    capsuleBetween(parts, shapes, rig, 'head', 'antler', a, b, radius);
  }

  if (shapes.length > MAX_ANIMAL_SHAPES) {
    throw new Error(`${recipe.id} uses ${shapes.length}/${MAX_ANIMAL_SHAPES} SDF shapes`);
  }
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error(`Unable to merge procedural ${recipe.id} geometry`);
  for (const part of parts) part.dispose();
  return { geometry, shapes, neighbourState: createNeighbourTextureState(rig, shapes) };
}

function shapeBoundsRadius(shape) {
  if (shape.type === SHAPE_CAPSULE) return shape.params.x + shape.params.y;
  return Math.max(shape.params.x, shape.params.y, shape.params.z);
}

function createNeighbourTextureState(rig, shapes) {
  rig.root.updateMatrixWorld(true);
  const centres = [];
  for (const shape of shapes) {
    tmpM.multiplyMatrices(rig.byName[shape.boneName].matrixWorld, shape.localMatrix);
    centres.push(new THREE.Vector3().setFromMatrixPosition(tmpM));
  }
  const lists = shapes.map(() => []);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const gap = centres[i].distanceTo(centres[j])
        - shapeBoundsRadius(shapes[i]) - shapeBoundsRadius(shapes[j]);
      // A small positive margin preserves blends through the widest gait pose.
      if (gap < 0.24) {
        lists[i].push({ index: j, gap });
        lists[j].push({ index: i, gap });
      }
    }
  }

  const width = Math.max(1, shapes.length * NEIGHBOUR_LANES);
  const data = new Float32Array(width * 4);
  data.fill(-1);
  for (let i = 0; i < lists.length; i++) {
    lists[i].sort((a, b) => a.gap - b.gap);
    for (let j = 0; j < Math.min(MAX_SHAPE_NEIGHBOURS, lists[i].length); j++) {
      data[i * MAX_SHAPE_NEIGHBOURS + j] = lists[i][j].index;
    }
  }
  const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.name = 'animal-sdf-neighbours';
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, width };
}

function createShapeTextureState(rig, shapes) {
  const width = Math.max(1, shapes.length * SHAPE_TEXELS);
  const data = new Float32Array(width * 4);
  const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.name = 'animal-sdf-shapes';
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const state = { data, texture, width };
  updateShapeTexture(rig, shapes, state);
  return state;
}

function updateShapeTexture(rig, shapes, state) {
  rig.root.updateMatrixWorld(true);
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    tmpM.multiplyMatrices(rig.byName[shape.boneName].matrixWorld, shape.localMatrix);
    tmpM.decompose(tmpV, tmpQ, tmpScale);
    const offset = i * SHAPE_TEXELS * 4;
    state.data[offset] = tmpV.x;
    state.data[offset + 1] = tmpV.y;
    state.data[offset + 2] = tmpV.z;
    state.data[offset + 3] = shape.type + shape.colour * 4;
    state.data[offset + 4] = tmpQ.x;
    state.data[offset + 5] = tmpQ.y;
    state.data[offset + 6] = tmpQ.z;
    state.data[offset + 7] = tmpQ.w;
    state.data[offset + 8] = shape.params.x;
    state.data[offset + 9] = shape.params.y;
    state.data[offset + 10] = shape.params.z;
    state.data[offset + 11] = shape.blend;
  }
  state.texture.needsUpdate = true;
}

function createAnimalMaterial(recipe, shapeState, neighbourState, shapeCount) {
  const palette = PALETTE_KEYS.map((key) => new THREE.Color(
    key === 'glint' ? 0xf8eed8 : recipe.palette[key],
  ));
  const material = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  material.name = `${recipe.id}-sdf-skin`;
  const injectVertexProjection = (shader) => {
    shader.uniforms.uAnimalShapeData = { value: shapeState.texture };
    shader.uniforms.uAnimalNeighbourData = { value: neighbourState.texture };
    shader.uniforms.uAnimalShapeCount = { value: shapeCount };
    shader.uniforms.uAnimalDataInvWidth = { value: 1 / shapeState.width };
    shader.uniforms.uAnimalNeighbourInvWidth = { value: 1 / neighbourState.width };
    shader.uniforms.uAnimalPalette = { value: palette };
    shader.uniforms.uAnimalSdfOffset = { value: 0 };
    shader.vertexShader = `
      attribute float aAnimalOwner;
      uniform sampler2D uAnimalShapeData;
      uniform sampler2D uAnimalNeighbourData;
      uniform float uAnimalShapeCount;
      uniform float uAnimalDataInvWidth;
      uniform float uAnimalNeighbourInvWidth;
      uniform float uAnimalSdfOffset;
      uniform vec3 uAnimalPalette[8];
      varying vec3 vAnimalSdfColor;
      varying vec3 vAnimalViewNormal;
      varying vec3 vAnimalWorldNormal;
      varying vec3 vAnimalWorldPosition;

      struct AnimalSdf {
        float d;
        float nearestD;
        float nearest;
        float blend;
        vec3 g;
        vec3 pigment;
      };

      vec4 animalShapeTex(float shapeIndex, float lane) {
        float x = (shapeIndex * ${SHAPE_TEXELS.toFixed(1)} + lane + 0.5) * uAnimalDataInvWidth;
        return texture2D(uAnimalShapeData, vec2(x, 0.5));
      }
      vec4 animalNeighbourTex(float shapeIndex, float lane) {
        float x = (shapeIndex * ${NEIGHBOUR_LANES.toFixed(1)} + lane + 0.5)
          * uAnimalNeighbourInvWidth;
        return texture2D(uAnimalNeighbourData, vec2(x, 0.5));
      }
      vec3 animalPalette(float index) {
        if (index < 0.5) return uAnimalPalette[0];
        if (index < 1.5) return uAnimalPalette[1];
        if (index < 2.5) return uAnimalPalette[2];
        if (index < 3.5) return uAnimalPalette[3];
        if (index < 4.5) return uAnimalPalette[4];
        if (index < 5.5) return uAnimalPalette[5];
        if (index < 6.5) return uAnimalPalette[6];
        return uAnimalPalette[7];
      }
      vec3 animalRotate(vec4 q, vec3 v) {
        return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
      }
      vec3 animalInverseRotate(vec4 q, vec3 v) {
        return animalRotate(vec4(-q.xyz, q.w), v);
      }
      AnimalSdf animalShape(float index, vec3 p) {
        vec4 pose = animalShapeTex(index, 0.0);
        vec4 rotation = normalize(animalShapeTex(index, 1.0));
        vec4 dimensions = animalShapeTex(index, 2.0);
        float typeId = mod(pose.w, 4.0);
        float pigmentId = floor(pose.w * 0.25 + 0.001);
        vec3 q = animalInverseRotate(rotation, p - pose.xyz);
        float d;
        vec3 localGradient;

        if (typeId < 0.5) {
          vec3 radii = max(dimensions.xyz, vec3(0.002));
          vec3 scaled = q / radii;
          float radial = max(length(scaled), 0.0001);
          float radiusFloor = min(radii.x, min(radii.y, radii.z));
          d = (radial - 1.0) * radiusFloor;
          localGradient = normalize(q / (radii * radii) + vec3(0.000001));
        } else if (typeId < 1.5) {
          float cappedY = clamp(q.y, -dimensions.y, dimensions.y);
          vec3 delta = q - vec3(0.0, cappedY, 0.0);
          float radial = length(delta);
          d = radial - dimensions.x;
          localGradient = radial > 0.00001 ? delta / radial : vec3(1.0, 0.0, 0.0);
        } else {
          float halfHeight = max(dimensions.y * 0.5, 0.002);
          vec2 radii = max(dimensions.xz, vec2(0.002));
          vec2 scaled = q.xz / radii;
          float radial = max(length(scaled), 0.0001);
          float coneRadius = clamp((halfHeight - q.y) / (2.0 * halfHeight), 0.0, 1.0);
          float radiusFloor = min(radii.x, radii.y);
          float sideDistance = (radial - coneRadius) * radiusFloor;
          float capDistance = abs(q.y) - halfHeight;
          d = max(sideDistance, capDistance);
          if (capDistance > sideDistance) {
            localGradient = vec3(0.0, sign(q.y), 0.0);
          } else {
            localGradient = normalize(vec3(
              radiusFloor * q.x / (radial * radii.x * radii.x),
              radiusFloor / (2.0 * halfHeight),
              radiusFloor * q.z / (radial * radii.y * radii.y)
            ));
          }
        }

        AnimalSdf result;
        result.d = d;
        result.nearestD = d;
        result.nearest = index;
        result.blend = dimensions.w;
        result.g = normalize(animalRotate(rotation, localGradient));
        result.pigment = animalPalette(pigmentId);
        return result;
      }
      AnimalSdf animalScene(vec3 p, float owner) {
        AnimalSdf result = animalShape(owner, p);
        for (int lane = 0; lane < ${NEIGHBOUR_LANES}; lane++) {
          vec4 neighbours = animalNeighbourTex(owner, float(lane));
          for (int component = 0; component < 4; component++) {
            float neighbour = neighbours[component];
            if (neighbour < -0.5 || neighbour >= uAnimalShapeCount) continue;
            AnimalSdf nextShape = animalShape(neighbour, p);
            // The incoming primitive owns the blend radius. Thin accents use a
            // deliberately tiny value without affecting substantial joints.
            float k = max(0.001, min(result.blend, nextShape.blend));
            float h = clamp(0.5 + 0.5 * (nextShape.d - result.d) / k, 0.0, 1.0);
            result.d = mix(nextShape.d, result.d, h) - k * h * (1.0 - h);
            result.g = normalize(mix(nextShape.g, result.g, h) + vec3(0.000001));
            result.pigment = mix(nextShape.pigment, result.pigment, h);
            if (nextShape.nearestD < result.nearestD) {
              result.nearestD = nextShape.nearestD;
              result.nearest = nextShape.nearest;
            }
          }
        }
        return result;
      }
    ` + shader.vertexShader
      .replace(
        '#include <begin_vertex>',
        `vec4 animalOwnerPose = animalShapeTex(aAnimalOwner, 0.0);
         vec4 animalOwnerRotation = normalize(animalShapeTex(aAnimalOwner, 1.0));
         vec3 transformed = animalOwnerPose.xyz + animalRotate(animalOwnerRotation, position);
         AnimalSdf animalSurface = animalScene(transformed, aAnimalOwner);
         transformed -= clamp(animalSurface.d - uAnimalSdfOffset, -0.45, 0.45) * animalSurface.g;
         animalSurface = animalScene(transformed, aAnimalOwner);
         transformed -= clamp(animalSurface.d - uAnimalSdfOffset, -0.20, 0.20) * animalSurface.g;
         // When two source shells cover the same union patch, only the nearest
         // owner stays on the skin. The other shell tucks just underneath,
         // avoiding z-fighting without opening cracks at the blend.
         float animalBuried = step(0.5, abs(animalSurface.nearest - aAnimalOwner));
         transformed -= animalSurface.g * animalBuried * 0.0035;
         vAnimalSdfColor = animalSurface.pigment;
         vAnimalViewNormal = normalize(normalMatrix * animalSurface.g);
         vAnimalWorldNormal = normalize(mat3(modelMatrix) * animalSurface.g);`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vAnimalWorldPosition = worldPosition.xyz;`,
      );
  };
  material.userData.injectVertexProjection = injectVertexProjection;
  material.onBeforeCompile = (shader) => {
    injectVertexProjection(shader);

    shader.fragmentShader = `
      varying vec3 vAnimalSdfColor;
      varying vec3 vAnimalViewNormal;
      varying vec3 vAnimalWorldNormal;
      varying vec3 vAnimalWorldPosition;
      float animalHash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float animalValueNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = animalHash(i);
        float n100 = animalHash(i + vec3(1.0, 0.0, 0.0));
        float n010 = animalHash(i + vec3(0.0, 1.0, 0.0));
        float n110 = animalHash(i + vec3(1.0, 1.0, 0.0));
        float n001 = animalHash(i + vec3(0.0, 0.0, 1.0));
        float n101 = animalHash(i + vec3(1.0, 0.0, 1.0));
        float n011 = animalHash(i + vec3(0.0, 1.0, 1.0));
        float n111 = animalHash(i + vec3(1.0, 1.0, 1.0));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
      }
    ` + shader.fragmentShader
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         normal = normalize(vAnimalViewNormal);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // Pigment follows the same smooth-min weights as geometry, so coat
         // changes feather through a joint instead of forming a hard decal.
         diffuseColor.rgb = vAnimalSdfColor;
         float broadPigment = animalValueNoise(vAnimalWorldPosition * 1.65);
         float finePigment = animalValueNoise(vAnimalWorldPosition * 7.2 + 19.0);
         float paperBand = floor((broadPigment * 0.72 + finePigment * 0.28) * 5.0) / 5.0;
         float upFacing = clamp(vAnimalWorldNormal.y * 0.5 + 0.5, 0.0, 1.0);
         float darkPreserve = smoothstep(0.025, 0.16,
           max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));
         float wash = mix(0.93, 1.055, paperBand) * mix(0.94, 1.045, upFacing);
         diffuseColor.rgb *= mix(1.0, wash, darkPreserve);
         diffuseColor.rgb *= 1.0 + (finePigment - 0.5) * 0.035;`,
      )
      .replace(
        '#include <output_fragment>',
        `float animalRim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.2);
         outgoingLight += diffuseColor.rgb * animalRim * 0.10;
         #include <output_fragment>`,
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'wander-animal-sdf-v2';
  return material;
}

function createAnimalDepthMaterial(surfaceMaterial) {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });
  material.name = 'animal-sdf-depth';
  material.onBeforeCompile = (shader) => {
    surfaceMaterial.userData.injectVertexProjection(shader);
  };
  material.customProgramCacheKey = () => 'wander-animal-sdf-depth-v2';
  return material;
}

function createAnimalMesh(asset) {
  const rig = createRig(asset.recipe);
  const shapeState = createShapeTextureState(rig, asset.shapes);
  const material = createAnimalMaterial(
    asset.recipe, shapeState, asset.neighbourState, asset.shapes.length,
  );
  const mesh = new THREE.Mesh(asset.geometry, material);
  const depthMaterial = createAnimalDepthMaterial(material);
  mesh.name = `animal-${asset.recipe.id}`;
  mesh.customDepthMaterial = depthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.rotation.order = 'YXZ';
  return { mesh, rig, shapeState, material, depthMaterial };
}

// Lightweight world-space Verlet chains for SDF-owned bones. They simulate
// points rather than deforming vertices; after constraints are solved, each
// ordinary bone is aimed down its segment and the shared SDF texture receives
// the resulting rigid primitive transforms.
class VerletSdfRope {
  constructor(rig, mesh, chain, settings = {}) {
    this.rig = rig;
    this.mesh = mesh;
    this.bones = chain.bones;
    this.segmentLength = chain.segmentLength;
    this.gravity = settings.gravity ?? 2.5;
    this.damping = settings.damping ?? 0.91;
    this.restStrength = settings.restStrength ?? 0.08;
    this.iterations = settings.iterations ?? 5;
    this.terrain = settings.terrain || null;
    this.clearance = settings.clearance || 0;
    this.positions = Array.from({ length: this.bones.length + 1 }, () => new THREE.Vector3());
    this.previous = Array.from({ length: this.bones.length + 1 }, () => new THREE.Vector3());
    this.rest = Array.from({ length: this.bones.length + 1 }, () => new THREE.Vector3());
    this.initialized = false;
    this._meshQuaternion = new THREE.Quaternion();
    this._parentQuaternion = new THREE.Quaternion();
    this._direction = new THREE.Vector3();
    this._velocity = new THREE.Vector3();
    this._acceleration = new THREE.Vector3();
  }

  invalidate() { this.initialized = false; }

  syncRestPose() {
    this.rig.root.updateMatrixWorld(true);
    this.mesh.updateMatrixWorld(true);
    const first = this.bones[0];
    const parent = first.parent;
    this.rest[0].copy(first.userData.bindPosition).applyMatrix4(parent.matrixWorld);
    this.mesh.localToWorld(this.rest[0]);
    this.mesh.getWorldQuaternion(this._meshQuaternion);
    parent.getWorldQuaternion(this._parentQuaternion);
    this._parentQuaternion.premultiply(this._meshQuaternion);
    const cumulative = this._parentQuaternion.clone();
    for (let i = 0; i < this.bones.length; i++) {
      cumulative.multiply(this.bones[i].userData.bindQuaternion);
      this._direction.copy(UP).applyQuaternion(cumulative).multiplyScalar(this.segmentLength);
      this.rest[i + 1].copy(this.rest[i]).add(this._direction);
    }
  }

  reset() {
    this.syncRestPose();
    for (let i = 0; i < this.positions.length; i++) {
      this.positions[i].copy(this.rest[i]);
      this.previous[i].copy(this.rest[i]);
    }
    this.initialized = true;
    this.applyToBones();
  }

  constrainToTerrain(point) {
    if (!this.terrain) return;
    const floor = this.terrain(point.x, point.z) + this.clearance;
    if (point.y < floor) point.y = floor;
  }

  step(dt, external = null) {
    this.syncRestPose();
    if (!this.initialized || this.positions[0].distanceToSquared(this.rest[0]) > 16) {
      this.reset();
      return;
    }
    const safeDt = Math.min(Math.max(dt, 0), 0.05);
    if (safeDt <= 0) return;
    const substeps = Math.max(1, Math.ceil(safeDt / (1 / 60)));
    const h = safeDt / substeps;
    this._acceleration.set(0, -this.gravity, 0);
    if (external) this._acceleration.add(external);

    for (let substep = 0; substep < substeps; substep++) {
      const damping = Math.pow(this.damping, h * 60);
      for (let i = 1; i < this.positions.length; i++) {
        const point = this.positions[i];
        this._velocity.copy(point).sub(this.previous[i]).multiplyScalar(damping);
        this.previous[i].copy(point);
        point.add(this._velocity).addScaledVector(this._acceleration, h * h);
        const restWeight = this.restStrength * h * 60 / (1 + i * 0.18);
        point.lerp(this.rest[i], Math.min(0.72, restWeight));
      }

      for (let iteration = 0; iteration < this.iterations; iteration++) {
        this.positions[0].copy(this.rest[0]);
        for (let i = 0; i < this.bones.length; i++) {
          const a = this.positions[i];
          const b = this.positions[i + 1];
          this._direction.copy(b).sub(a);
          const distance = Math.max(1e-5, this._direction.length());
          const correction = (distance - this.segmentLength) / distance;
          if (i === 0) {
            b.addScaledVector(this._direction, -correction);
          } else {
            a.addScaledVector(this._direction, correction * 0.5);
            b.addScaledVector(this._direction, -correction * 0.5);
          }
          this.constrainToTerrain(b);
        }
      }
    }
    this.applyToBones();
  }

  applyToBones() {
    this.mesh.updateMatrixWorld(true);
    this.mesh.getWorldQuaternion(this._meshQuaternion);
    for (let i = 0; i < this.bones.length; i++) {
      const ropeBone = this.bones[i];
      ropeBone.parent.getWorldQuaternion(this._parentQuaternion);
      this._parentQuaternion.premultiply(this._meshQuaternion).invert();
      this._direction.copy(this.positions[i + 1]).sub(this.positions[i]).normalize()
        .applyQuaternion(this._parentQuaternion);
      ropeBone.quaternion.setFromUnitVectors(UP, this._direction);
      ropeBone.updateMatrixWorld(true);
    }
  }
}

class AnimalAgent {
  constructor(asset, world, seed) {
    this.asset = asset;
    this.recipe = asset.recipe;
    this.world = world;
    this.rng = mulberry32(seed ^ asset.recipe.seed);
    const instance = createAnimalMesh(asset);
    this.mesh = instance.mesh;
    this.rig = instance.rig;
    this.shapeState = instance.shapeState;
    this.material = instance.material;
    this.depthMaterial = instance.depthMaterial;
    this.age = this.rng() * 100;
    this.seedPhase = this.rng() * TAU;
    this.heading = this.rng() * TAU;
    this.steeringHeading = this.heading;
    this.routeGrade = 0;
    this.routeSafe = true;
    this.routeTimer = 0;
    this.turnPreference = this.rng() < 0.5 ? -1 : 1;
    this.speed = 0;
    this.gaitClock = 0;
    this.gaitReady = false;
    this.lastPose = null;
    this.wasLocomoting = false;
    this.state = 'idle';
    this.stateTimer = 1;
    this.previewTimer = 0;
    this.target = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.lean = { value: 0, velocity: 0 };
    this.look = { value: 0, velocity: 0 };
    this.lastTurn = 0;
    this.terrainTimer = 0;
    this.cachedGroundY = 0;
    this.cachedSlopePitch = 0;
    this.cachedSlopeRoll = 0;
    this.resumeBehaviour = null;
    this.motionPreviewSpeed = null;
    this.footStates = Object.fromEntries(LEG_ORDER.map((name, index) => [
      name,
      createReactiveFootState([0.25, 0.75, 0.50, 0.00][index]),
    ]));
    this.gaitOrder = LEG_ORDER.slice();
    this.legSolvers = Object.fromEntries(LEG_ORDER.map((name) => {
      const isFront = name.startsWith('front');
      const chain = isFront ? this.recipe.leg.front : this.recipe.leg.hind;
      const upper = this.rig.byName[`${name}Upper`];
      const lower = this.rig.byName[`${name}Lower`];
      const pastern = this.rig.byName[`${name}Pastern`];
      const bindAngles = [
        upper.userData.bindRotation.x,
        lower.userData.bindRotation.x,
        pastern.userData.bindRotation.x,
      ];
      return [name, {
        chain,
        upper,
        lower,
        pastern,
        hoof: this.rig.byName[`${name}Hoof`],
        totalLength: chain.lengths[0] + chain.lengths[1] + chain.lengths[2],
        neutral: forwardKinematics2D(chain.lengths, bindAngles),
        limits: quadrupedLegLimits(isFront),
      }];
    }));
    this.supportLegLength = Math.max(
      ...Object.values(this.legSolvers).map((solver) => solver.totalLength),
    );
    this.animationScratch = {
      hip: new THREE.Vector3(),
      offset: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      target: new THREE.Vector3(),
      relative: new THREE.Vector3(),
      bodyQuaternion: new THREE.Quaternion(),
      right: new THREE.Vector3(),
      external: new THREE.Vector3(),
    };
    const terrain = (x, z) => this.world.height(x, z);
    const hoofClearance = this.recipe.leg.hoof[1] * 1.38;
    this.terrainFootHeight = (x, z) => this.world.height(x, z) + hoofClearance;
    this.tailRope = new VerletSdfRope(this.rig, this.mesh, this.rig.ropeChains.tail, {
      gravity: this.recipe.id === 'fox' ? 2.8 : 2.2,
      damping: this.recipe.id === 'fox' ? 0.935 : 0.90,
      restStrength: this.recipe.id === 'fox' ? 0.055 : 0.11,
      iterations: 5,
      terrain,
      clearance: this.recipe.tail.tipRadius * 0.45,
    });
    this.earLeftRope = new VerletSdfRope(this.rig, this.mesh, this.rig.ropeChains.earLeft, {
      gravity: 0.55, damping: 0.82, restStrength: 0.34, iterations: 5,
    });
    this.earRightRope = new VerletSdfRope(this.rig, this.mesh, this.rig.ropeChains.earRight, {
      gravity: 0.55, damping: 0.82, restStrength: 0.34, iterations: 5,
    });
  }

  invalidateProceduralAnimation() {
    for (const state of Object.values(this.footStates)) {
      state.initialized = false;
      state.armed = true;
    }
    this.tailRope.invalidate();
    this.earLeftRope.invalidate();
    this.earRightRope.invalidate();
  }

  place(x, z) {
    const y = this.world.height(x, z);
    this.mesh.position.set(x, y, z);
    this.cachedGroundY = y;
    this.terrainTimer = 0;
    this.previewTimer = 0;
    this.home.set(x, y, z);
    this.target.set(x, y, z);
    this.steeringHeading = this.heading;
    this.routeGrade = 0;
    this.routeSafe = true;
    this.routeTimer = 0;
    this.resumeBehaviour = null;
    this.gaitClock = 0;
    this.gaitReady = false;
    this.wasLocomoting = false;
    this.invalidateProceduralAnimation();
    this.pickState(true);
  }

  pickState(initial = false) {
    const roll = this.rng();
    if (!initial && roll < 0.25) {
      this.state = 'graze';
      this.stateTimer = 3.5 + this.rng() * 6.5;
      return;
    }
    if (!initial && roll < 0.43) {
      this.state = 'idle';
      this.stateTimer = 1.8 + this.rng() * 4.5;
      return;
    }
    this.state = 'roam';
    this.stateTimer = 5 + this.rng() * 9;
    const angle = this.rng() * TAU;
    const radius = 5 + this.rng() * 14;
    this.target.set(
      this.home.x + Math.sin(angle) * radius,
      0,
      this.home.z + Math.cos(angle) * radius,
    );
    this.routeTimer = 0;
  }

  safeAhead(x, z) {
    const height = this.world.height(x, z);
    const river = this.world.riverAt(x, z);
    return height > 0.35 && !(river.wet && river.depth > 0.04);
  }

  rememberBehaviour() {
    if (this.resumeBehaviour || this.state === 'alert' || this.state === 'flee') return;
    this.resumeBehaviour = {
      state: this.state,
      timer: Math.max(0.5, this.stateTimer),
      target: this.target.clone(),
    };
  }

  resumePreviousBehaviour() {
    if (!this.resumeBehaviour) {
      this.pickState();
      return;
    }
    this.state = this.resumeBehaviour.state;
    this.stateTimer = this.resumeBehaviour.timer;
    this.target.copy(this.resumeBehaviour.target);
    this.resumeBehaviour = null;
    this.routeTimer = 0;
  }

  planTerrainRoute(targetHeading) {
    const route = chooseTerrainHeading({
      x: this.mesh.position.x,
      z: this.mesh.position.z,
      currentHeading: this.heading,
      targetHeading,
      lookAhead: Math.max(6, this.recipe.body[2] * 3.4 + this.speed * 1.6),
      sampleHeight: (x, z) => this.world.height(x, z),
      traversable: (x, z) => this.safeAhead(x, z),
      turnPreference: this.turnPreference,
    });
    this.steeringHeading = route.heading;
    // Cross-slope support is less costly than climbing but still limits speed
    // because the left and right legs have unequal reach.
    this.routeGrade = Math.max(route.grade, route.crossGrade * 0.65);
    this.routeSafe = route.safe;
    this.routeTimer = 0.30 + this.rng() * 0.12;
    return route;
  }

  normalisedGaitSpeed(speed) {
    const cruise = this.recipe.motion.cruise;
    return speed <= cruise
      ? clamp(speed / Math.max(cruise, 0.01), 0, 1) * 0.42
      : 0.42 + clamp(
        (speed - cruise) / Math.max(this.recipe.motion.run - cruise, 0.01), 0, 1,
      ) * 0.58;
  }

  updateReactiveLegs(dt, pose, speed01, plannedSpeed) {
    const body = this.rig.byName.body;
    const scratch = this.animationScratch;
    this.rig.root.updateMatrixWorld(true);
    this.mesh.updateMatrixWorld(true);
    body.getWorldQuaternion(scratch.bodyQuaternion);
    const strideDuration = pose.swingPortion / Math.max(0.18, pose.cadence)
      * (1 + pose.running * pose.swingDurationBoost);
    const stanceDuration = pose.dutyFactor / Math.max(0.18, pose.cadence);
    const hoofClearance = this.recipe.leg.hoof[1] * 1.38;
    let activeSteps = Object.values(this.footStates).filter((state) => state.swinging).length;
    let startedStep = false;
    // A ~0.67 duty-factor mammal walk naturally has a short two-leg swing
    // overlap around each quarter-cycle. Allowing that overlap prevents the
    // next hoof being held behind the hip while another step finishes.
    const suspensionEnabled = this.gaitReady && pose.running > pose.suspensionThreshold;
    const maxConcurrentSteps = suspensionEnabled ? 4 : 2;

    // Service the limbs closest to lift-off first. Near a trot this preserves
    // diagonal pairs (FL+HR, FR+HL) instead of letting an overdue ipsilateral
    // leg consume the second swing slot merely because of array order.
    const gaitOrder = this.gaitOrder.sort(
      (a, b) => pose.legs[a].phase - pose.legs[b].phase,
    );
    for (const name of gaitOrder) {
      const solver = this.legSolvers[name];
      const legPose = pose.legs[name];
      solver.upper.getWorldPosition(scratch.hip);
      scratch.offset.set(0, -solver.neutral.down, -solver.neutral.forward)
        .applyQuaternion(scratch.bodyQuaternion);
      scratch.desired.copy(scratch.hip).add(scratch.offset);
      this.mesh.localToWorld(scratch.desired);
      const stateBefore = this.footStates[name];
      if (!stateBefore.initialized) {
        // Seed the contact under the bind-pose hoof, not at the predicted
        // future foothold. Otherwise startup can consider every foot already
        // "placed" ahead and wait a full cycle before showing any leg motion.
        const neutralY = this.terrainFootHeight(scratch.desired.x, scratch.desired.z);
        advanceReactiveFoot(
          stateBefore,
          [scratch.desired.x, neutralY, scratch.desired.z],
          legPose.phase,
          0,
          { swingWindow: pose.swingPortion, armOnInitialize: plannedSpeed > 0.02 },
        );
      }
      const rawPrediction = predictiveFootholdDistance(
        plannedSpeed,
        strideDuration,
        stanceDuration,
        solver.totalLength,
        pose.running,
        pose.runReach,
      );
      // Cap the foothold to the leg's diagonal reach at its working height.
      // Planting beyond it leaves the IK chain straining at full extension
      // and the hoof gliding into position after touchdown instead of
      // striking once, committedly, and staying put.
      const reachDown = solver.neutral.down * 0.90;
      const diagonalForward = Math.sqrt(Math.max(
        0.001, (solver.totalLength * 0.99) ** 2 - reachDown ** 2,
      ));
      const legPrediction = Math.min(
        rawPrediction, Math.max(diagonalForward, solver.totalLength * 0.30),
      );
      scratch.desired.x += Math.sin(this.heading) * legPrediction;
      scratch.desired.z += Math.cos(this.heading) * legPrediction;
      scratch.desired.y = this.world.height(scratch.desired.x, scratch.desired.z) + hoofClearance;

      const wasSwinging = stateBefore.swinging;
      const state = advanceReactiveFoot(
        stateBefore,
        [scratch.desired.x, scratch.desired.y, scratch.desired.z],
        legPose.phase,
        dt,
        {
          swingWindow: pose.swingPortion,
          stepDuration: strideDuration,
          stepHeight: Math.max(hoofClearance * 1.10, solver.totalLength * 0.095)
            * (0.72 + speed01 * 0.55)
            * (1 + pose.running * pose.stepLiftBoost)
            * (1 + clamp(-this.cachedSlopePitch * 1.8, 0, 0.55)),
          triggerDistance: Math.max(0.055, solver.totalLength * (0.090 - pose.running * 0.025)),
          // A planted foot legitimately drifts speed × stance-duration before
          // its next scheduled window. Emergency/critical re-steps must sit
          // above that envelope or steady walking re-triggers mid-stance —
          // the foot pattering down two or three times in one stride. These
          // now only catch true disruptions (sharp turns, teleports, drops).
          emergencyDistance: Math.max(
            0.18,
            solver.totalLength * (0.42 - pose.running * 0.08),
            plannedSpeed * stanceDuration * 1.20,
          ),
          criticalDistance: Math.max(
            0.24,
            solver.totalLength * 0.52,
            plannedSpeed * stanceDuration * 1.45,
          ),
          retargetStrength: 4 + pose.running * pose.retargetBoost,
          allowStep: wasSwinging || activeSteps < 2
            || (suspensionEnabled && activeSteps < maxConcurrentSteps
              && legPose.phase < pose.swingPortion),
          armOnInitialize: !this.gaitReady && plannedSpeed > 0.02,
          terrainHeight: this.terrainFootHeight,
        },
      );
      if (!wasSwinging && state.swinging) {
        activeSteps++;
        startedStep = true;
      }

      scratch.target.fromArray(state.position);
      this.mesh.worldToLocal(scratch.target);
      body.worldToLocal(scratch.target);
      scratch.relative.copy(scratch.target).sub(solver.upper.position);
      const targetForward = -scratch.relative.z;
      const targetDown = Math.hypot(-scratch.relative.y, scratch.relative.x);
      const result = solveThreeLinkIK(
        solver.chain.lengths,
        targetForward,
        targetDown,
        [solver.upper.rotation.x, solver.lower.rotation.x, solver.pastern.rotation.x],
        solver.limits,
      );
      solver.lastError = result.error;
      const response = state.swinging ? 34 : 46;
      solver.upper.rotation.x = damp(solver.upper.rotation.x, result.angles[0], response, dt);
      solver.lower.rotation.x = damp(solver.lower.rotation.x, result.angles[1], response, dt);
      solver.pastern.rotation.x = damp(solver.pastern.rotation.x, result.angles[2], response, dt);
      solver.upper.rotation.z = damp(
        solver.upper.rotation.z,
        clamp(Math.atan2(scratch.relative.x, Math.max(0.10, -scratch.relative.y)), -0.34, 0.34),
        30,
        dt,
      );
      const cumulative = result.angles[0] + result.angles[1] + result.angles[2];
      solver.hoof.rotation.x = damp(solver.hoof.rotation.x, -cumulative, 38, dt);
      solver.hoof.rotation.z = damp(solver.hoof.rotation.z, -solver.upper.rotation.z, 30, dt);
    }
    return { activeSteps, startedStep };
  }

  update(dt, playerPosition, visible = true) {
    this.mesh.visible = visible;
    if (!visible) return;
    this.age += dt;
    this.stateTimer -= dt;
    this.previewTimer = Math.max(0, this.previewTimer - dt);
    const dx = this.mesh.position.x - playerPosition.x;
    const dz = this.mesh.position.z - playerPosition.z;
    const playerDistance = Math.hypot(dx, dz);
    // Deer, foxes and moose do not need to square their bodies to a person to
    // monitor them. Peripheral awareness leaves normal behaviour untouched at
    // distance, pauses without turning in the caution band, and only triggers
    // flight once the player is genuinely close.
    const awareness = this.previewTimer > 0 ? 'unconcerned' : animalAwareness(playerDistance);
    if (awareness === 'flee') {
      this.rememberBehaviour();
      this.state = 'flee';
      this.stateTimer = 0.5;
      const inverse = 1 / Math.max(0.01, playerDistance);
      this.target.set(
        this.mesh.position.x + dx * inverse * 30,
        0,
        this.mesh.position.z + dz * inverse * 30,
      );
    } else if (awareness === 'pause') {
      this.rememberBehaviour();
      this.state = 'alert';
      this.stateTimer = Math.max(this.stateTimer, 0.5);
    } else if (this.state === 'alert' || this.state === 'flee') {
      this.resumePreviousBehaviour();
    } else if (this.stateTimer <= 0 || (this.state === 'roam'
      && Math.hypot(this.target.x - this.mesh.position.x, this.target.z - this.mesh.position.z) < 1.2)) {
      this.pickState();
    }

    let desiredSpeed = 0;
    if (this.state === 'roam') desiredSpeed = this.recipe.motion.cruise;
    if (this.state === 'flee') desiredSpeed = this.recipe.motion.run;
    if (Number.isFinite(this.motionPreviewSpeed)) desiredSpeed = this.motionPreviewSpeed;
    const targetHeading = Math.atan2(
      this.target.x - this.mesh.position.x,
      this.target.z - this.mesh.position.z,
    );
    this.lastTurn = damp(this.lastTurn, 0, 5.5, dt);
    if (desiredSpeed > 0) {
      this.routeTimer -= dt;
      if (Number.isFinite(this.motionPreviewSpeed)) {
        this.steeringHeading = targetHeading;
        this.routeGrade = 0;
        this.routeSafe = true;
      } else if (this.routeTimer <= 0) {
        this.planTerrainRoute(targetHeading);
      }

      const steeringTurn = angleDelta(this.heading, this.steeringHeading);
      desiredSpeed *= terrainSpeedScale(this.routeGrade) * turnSpeedScale(steeringTurn);
      // If no gentle escape arc exists, use a controlled fast walk instead of
      // charging up or down an extreme grade.
      if (this.state === 'flee' && this.routeGrade > 0.18) {
        desiredSpeed = Math.min(desiredSpeed, this.recipe.motion.cruise * 1.15);
      }
      // Heading can only change once the animal is translating. Angular speed
      // is also limited by species turn radius, producing a forward arc rather
      // than an in-place robot-vacuum pivot.
      const turnRate = arcTurnRate(
        this.speed,
        this.recipe.motion.turn,
        this.recipe.motion.turnRadius,
      );
      if (this.gaitReady && this.speed > 0.035 && turnRate > 0) {
        const turnStep = clamp(steeringTurn, -dt * turnRate, dt * turnRate);
        this.heading += turnStep;
        this.lastTurn = turnStep / Math.max(dt, 1e-4);
      }
    }

    const wantsLocomotion = desiredSpeed > 0.025;
    if (wantsLocomotion && !this.wasLocomoting) {
      // Enter the gait at a known right-hind swing phase and hold translation
      // until that hoof has visibly left stance. This prevents the whole body
      // moving first and towing four planted legs behind it.
      this.gaitClock = 0;
      this.gaitReady = false;
      this.speed = 0;
      for (const state of Object.values(this.footStates)) state.armed = true;
    }
    const translationTarget = wantsLocomotion && !this.gaitReady ? 0 : desiredSpeed;
    this.speed = damp(this.speed, translationTarget, translationTarget > this.speed ? 2.6 : 4.4, dt);
    this.mesh.position.x += Math.sin(this.heading) * this.speed * dt;
    this.mesh.position.z += Math.cos(this.heading) * this.speed * dt;
    // Slope probes are staggered at 8–10Hz. Root height itself is sampled every
    // frame so an uphill animal cannot outrun its torso and overextend/drag all
    // four stance legs before the next terrain probe.
    const liveGroundY = this.world.height(this.mesh.position.x, this.mesh.position.z);
    this.cachedGroundY = liveGroundY;
    this.terrainTimer -= dt;
    if (this.terrainTimer <= 0) {
      this.terrainTimer = 0.10 + this.rng() * 0.035;
      const probe = Math.max(0.45, this.recipe.body[2] * 0.42);
      const fx = Math.sin(this.heading) * probe, fz = Math.cos(this.heading) * probe;
      const sx = Math.cos(this.heading) * probe * 0.65, sz = -Math.sin(this.heading) * probe * 0.65;
      const frontY = this.world.height(this.mesh.position.x + fx, this.mesh.position.z + fz);
      const backY = this.world.height(this.mesh.position.x - fx, this.mesh.position.z - fz);
      const leftY = this.world.height(this.mesh.position.x - sx, this.mesh.position.z - sz);
      const rightY = this.world.height(this.mesh.position.x + sx, this.mesh.position.z + sz);
      this.cachedSlopePitch = -Math.atan2(frontY - backY, probe * 2);
      this.cachedSlopeRoll = Math.atan2(rightY - leftY, probe * 1.3);
    }

    // Plan from requested velocity during gait pre-roll, then converge to real
    // velocity. This gives the first swing a useful forward foothold while the
    // body is intentionally still held in place.
    const plannedSpeed = wantsLocomotion
      ? Math.max(this.speed, desiredSpeed * 0.72) : this.speed;
    const speed01 = this.normalisedGaitSpeed(plannedSpeed);
    const timing = quadrupedTiming(this.recipe, speed01);
    this.gaitClock += dt * timing.cadence;
    const pose = quadrupedPose(this.recipe, this.age, speed01, {
      seedPhase: this.seedPhase,
      phaseOverride: this.gaitClock,
    });
    this.lastPose = pose;
    this.mesh.position.y = damp(
      this.mesh.position.y,
      liveGroundY + pose.rootBob,
      26 + this.speed * 10,
      dt,
    );
    this.mesh.rotation.y = this.heading;
    // Keep the torso's up-axis aligned to world vertical. Each world-planted
    // hoof already samples its own terrain height, so the four IK chains—not a
    // tilted root—absorb the hill beneath the animal.
    this.mesh.rotation.x = damp(this.mesh.rotation.x, 0, 12, dt);
    this.mesh.rotation.z = damp(this.mesh.rotation.z, 0, 12, dt);

    const body = this.rig.byName.body;
    const dynamicLean = springStep(this.lean, clamp(-this.lastTurn * 0.065, -0.14, 0.14), dt, 5.2, 0.95);
    body.rotation.x = body.userData.bindRotation.x + pose.bodyPitch + pose.spineFlex;
    body.rotation.z = body.userData.bindRotation.z + pose.bodyRoll + dynamicLean;
    const locomotionCrouch = this.supportLegLength
      * (pose.locomotion * 0.018 + pose.running * pose.locomotionCrouch);
    body.position.y = body.userData.bindPosition.y + pose.breath * 0.009 - locomotionCrouch;

    const legActivity = this.updateReactiveLegs(dt, pose, speed01, plannedSpeed);
    if (wantsLocomotion && !this.gaitReady
      && (legActivity.startedStep || legActivity.activeSteps > 0)) this.gaitReady = true;
    this.wasLocomoting = wantsLocomotion;

    const graze = this.state === 'graze' ? 1 : 0;
    const alert = this.state === 'alert' ? 1 : 0;
    const look = springStep(this.look, graze, dt, 4.0, 0.92);
    const neck = this.rig.byName.neck;
    const neckBase = this.rig.byName.neckBase;
    const head = this.rig.byName.head;
    neckBase.rotation.x = neckBase.userData.bindRotation.x + look * 0.46 - alert * 0.04
      + Math.sin(this.age * 0.72 + this.seedPhase) * 0.010;
    neck.rotation.x = neck.userData.bindRotation.x + look * 0.68 - alert * 0.07
      + Math.sin(this.age * 0.72 + this.seedPhase) * 0.018;
    head.rotation.x = head.userData.bindRotation.x + look * 0.58
      + Math.sin(this.age * 1.1 + this.seedPhase) * 0.025 - pose.spineFlex * 0.42;
    head.rotation.y = head.userData.bindRotation.y
      + Math.sin(this.age * 0.43 + this.seedPhase) * (alert ? 0.10 : 0.035);

    // Secondary appendages are simulated as world-space ropes. Body, head and
    // turning motion create real inertial lag; the small procedural impulses
    // supply alert/flee expression without reverting to angle clips.
    this.mesh.updateMatrixWorld(true);
    this.animationScratch.right.set(1, 0, 0).applyQuaternion(
      this.mesh.getWorldQuaternion(tmpQ),
    );
    this.animationScratch.external.copy(this.animationScratch.right)
      .multiplyScalar(pose.tailWave * (this.recipe.id === 'fox' ? 4.8 : 2.0));
    if (this.state === 'flee') this.animationScratch.external.y += 2.0;
    this.tailRope.step(dt, this.animationScratch.external);
    const earImpulse = pose.earFlick * 3.0 + alert * 0.65;
    this.animationScratch.external.copy(this.animationScratch.right).multiplyScalar(-earImpulse);
    this.earLeftRope.step(dt, this.animationScratch.external);
    this.animationScratch.external.copy(this.animationScratch.right).multiplyScalar(earImpulse);
    this.earRightRope.step(dt, this.animationScratch.external);

    updateShapeTexture(this.rig, this.asset.shapes, this.shapeState);
  }

  dispose() {
    this.material.dispose();
    this.depthMaterial.dispose();
    this.shapeState.texture.dispose();
  }
}

export class AnimalSystem {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'procedural-wildlife';
    scene.add(this.group);
    this.assets = new Map();
    this.agents = [];
    this.spawnOrigin = new THREE.Vector3(Infinity, 0, Infinity);
    this.enabled = true;
    this.shadows = true;
    this.animationScale = 1;
    this.lastPlayer = new THREE.Vector3();
    this.debug = {
      enabled: true,
      animationScale: 1,
      status: 'waiting for terrain',
    };

    for (const recipe of Object.values(ANIMAL_RECIPES)) {
      const model = buildAnimalModel(recipe);
      this.assets.set(recipe.id, { recipe, ...model });
    }
  }

  findHabitat(recipe, px, pz, ordinal) {
    const rng = mulberry32((this.world.seed ^ recipe.seed ^ (ordinal * 0x9e3779b9)) >>> 0);
    let best = null;
    for (let i = 0; i < 32; i++) {
      const angle = (ordinal / 3) * TAU + (rng() - 0.5) * 1.5;
      const radius = 16 + ordinal * 7 + rng() * 25;
      const x = px + Math.sin(angle) * radius;
      const z = pz + Math.cos(angle) * radius;
      const biome = this.world.biomeAt(x, z);
      const river = this.world.riverAt(x, z);
      if (biome.h <= 0.4 || (river.wet && river.depth > 0.04)) continue;
      const habitat = recipe.habitats.includes(biome.id) ? 3 : 0;
      const score = habitat + (1 - clamp(biome.slope, 0, 1)) * 2 - Math.abs(radius - 30) * 0.01;
      if (!best || score > best.score) best = { x, z, score };
    }
    return best || { x: px + 18 + ordinal * 8, z: pz + 14 + ordinal * 6 };
  }

  populateNear(playerPosition) {
    for (const agent of this.agents) {
      this.group.remove(agent.mesh);
      agent.dispose();
    }
    this.agents.length = 0;
    const order = ['fox', 'whitetail', 'moose'];
    for (let i = 0; i < order.length; i++) {
      const asset = this.assets.get(order[i]);
      const agent = new AnimalAgent(asset, this.world, this.world.seed + i * 7919);
      agent.mesh.castShadow = this.shadows;
      const site = this.findHabitat(asset.recipe, playerPosition.x, playerPosition.z, i);
      agent.place(site.x, site.z);
      this.group.add(agent.mesh);
      this.agents.push(agent);
    }
    this.spawnOrigin.copy(playerPosition);
    this.debug.status = '3 SDF animals · fox / white-tail / moose';
  }

  setQuality(tier) {
    this.shadows = (tier?.shadowSize || 0) > 0;
    for (const agent of this.agents) agent.mesh.castShadow = this.shadows;
  }

  preview(species, playerPosition, playerYaw = 0) {
    const agent = this.agents.find((candidate) => candidate.recipe.id === species);
    if (!agent) return null;
    const forwardX = -Math.sin(playerYaw), forwardZ = -Math.cos(playerYaw);
    const sideX = -forwardZ, sideZ = forwardX;
    const x = playerPosition.x + forwardX * 10 + sideX * 2.8;
    const z = playerPosition.z + forwardZ * 10 + sideZ * 2.8;
    agent.place(x, z);
    agent.heading = Math.atan2(playerPosition.x - x, playerPosition.z - z);
    agent.state = 'alert';
    agent.stateTimer = 6;
    agent.previewTimer = 6;
    return agent;
  }

  previewAll(playerPosition, playerYaw = 0) {
    if (!this.agents.length) this.populateNear(playerPosition);
    const forwardX = -Math.sin(playerYaw), forwardZ = -Math.cos(playerYaw);
    const sideX = -forwardZ, sideZ = forwardX;
    const order = ['fox', 'whitetail', 'moose'];
    for (let i = 0; i < order.length; i++) {
      const agent = this.agents.find((candidate) => candidate.recipe.id === order[i]);
      if (!agent) continue;
      const lateral = (i - 1) * 4.5;
      const distance = 10.5 + Math.abs(i - 1) * 1.8;
      const x = playerPosition.x + forwardX * distance + sideX * lateral;
      const z = playerPosition.z + forwardZ * distance + sideZ * lateral;
      agent.place(x, z);
      agent.heading = Math.atan2(playerPosition.x - x, playerPosition.z - z);
      agent.state = 'alert';
      agent.stateTimer = 7;
      agent.previewTimer = 7;
    }
    this.debug.status = 'SDF showcase · fox / white-tail / moose';
    return this.agents;
  }

  update(dt, playerPosition, caveFactor = 0) {
    this.enabled = this.debug.enabled;
    this.animationScale = this.debug.animationScale;
    this.group.visible = this.enabled && caveFactor < 0.52;
    if (!this.enabled) return;
    this.lastPlayer.copy(playerPosition);
    if (!this.agents.length || this.spawnOrigin.distanceToSquared(playerPosition) > 210 * 210) {
      this.populateNear(playerPosition);
    }
    const visible = caveFactor < 0.52;
    for (const agent of this.agents) agent.update(dt * this.animationScale, playerPosition, visible);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const agent of this.agents) agent.dispose();
    for (const asset of this.assets.values()) {
      asset.geometry.dispose();
      asset.neighbourState.texture.dispose();
    }
  }
}
