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
  alertnessStage,
  arcTurnRate,
  chooseAnimalGoal,
  chooseTerrainHeading,
  terrainSpeedScale,
  turnSpeedScale,
  updateAnimalAlertness,
} from './animalbehavior.mjs?v=5';
import { ANIMAL_RECIPES, LEG_ORDER, animalBindDimensions } from './animaldata.mjs';
import { REGARD_HEAD_TURN, advanceRegard, createRegard } from './animalregard.mjs';
import { OUTSIDE_MARGIN, groundIsClear, resolveHorseGround } from './horsepasture.mjs';
import { settlementsAround } from './settlementplacement.mjs';
import { cachedSettlementPlan } from './settlementspatial.mjs';
import {
  createAnimalFamily,
  HORSE_COLOURS,
  showcaseAnimalPhenotype,
} from './animalpopulation.mjs?v=5';
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
import { nearestTrailPoint, trailsAround } from './trails.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const TAU = Math.PI * 2;

// Wildlife is streamed from a coarse world grid: each cell has a small,
// session-random chance of hosting one animal, so sightings are sparse and
// scattered rather than a fixed entourage that follows the player.
const ANIMAL_SPAWN_CELL = 220;      // metres per potential-spawn cell
const ANIMAL_STREAM_RADIUS = 240;   // load distance (~4x the old ~60 m pop-in)
const ANIMAL_MAX_ACTIVE = 8;        // hard safety cap on concurrent animals
const ANIMAL_CONTEXT_RADIUS = 280;  // one shared, slowly-refreshed trail window

function sharedAnimalId(seed, cellX, cellZ, member = 0) {
  return `animal:${(Number(seed) || 0) >>> 0}:${cellX}:${cellZ}:${member}`;
}

const SPECIES_SENSES = Object.freeze({
  whitetail: Object.freeze({ sight: 58, fov: 2.55, sensitivity: 1.08 }),
  fox: Object.freeze({ sight: 44, fov: 2.15, sensitivity: 0.94 }),
  moose: Object.freeze({ sight: 50, fov: 2.35, sensitivity: 0.88 }),
  // Prey eyes set wide on the skull, so a horse sees nearly all the way around
  // itself — but a village horse is used to people. Low sensitivity keeps it
  // from working itself up over someone crossing the common; `tame` on the
  // recipe is what stops it running even at arm's length.
  horse: Object.freeze({ sight: 52, fov: 2.80, sensitivity: 0.42 }),
});

// How far from a settlement's edge a village horse may graze. Wide enough to
// be out on the common rather than pressed against the houses, tight enough
// that finding one always means a village is over the rise.
const HORSE_PASTURE_REACH = 190;
// How close the player must be for a tame animal to bother looking up at all.
const REGARD_SIGHT = 16;
const horseSiteScratch = [];

/**
 * The settlement whose horses would graze here, or null.
 *
 * Returns the site rather than a yes/no because siting the horse needs the
 * village's plan — which square to stand in, which houses to keep out of.
 */
function horseSettlementFor(world, x, z) {
  settlementsAround(world, x, z, world.seed, HORSE_PASTURE_REACH, horseSiteScratch);
  let best = null;
  let bestDistance = Infinity;
  for (const site of horseSiteScratch) {
    // Measured to the settlement's edge, not its centre, so a large village's
    // horses are not pushed out proportionally further than a hamlet's.
    const distance = Math.hypot(site.x - x, site.z - z);
    if (distance < site.radius + HORSE_PASTURE_REACH && distance < bestDistance) {
      bestDistance = distance;
      best = site;
    }
  }
  return best;
}

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
    isAntler: colour === 'antler',
    type,
    params: new THREE.Vector3().fromArray(params),
    blend,
    localMatrix: localMatrix(position, rotation),
  });
}

// Smooth-min blend width, clamped against the shape it belongs to. A blend
// wider than the form itself stops rounding edges and starts dissolving the
// form into its neighbours — which is what turned the deer's throat, chest and
// skull into one soft pale mass once those shapes were scaled down to
// anatomical size while the blends stayed at their original values.
function softBlend(size, requested) {
  const smallest = Math.min(Math.abs(size[0]), Math.abs(size[1]), Math.abs(size[2]));
  return Math.min(requested, smallest * 0.70);
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
  // Splay rotates the whole limb at its root: yaw toes it in or out, roll
  // swings it away from the body. Mirrored left to right, so a positive value
  // means the same thing on both sides rather than rotating the animal.
  const legSplay = recipe.sculpt || {};
  for (const name of LEG_ORDER) {
    const isForeLimb = name.startsWith('front');
    const chain = isForeLimb ? recipe.leg.front : recipe.leg.hind;
    const stagger = (chain.stagger || 0) * (name.endsWith('Left') ? -1 : 1);
    const splay = (isForeLimb ? legSplay.foreSplay : legSplay.hindSplay) || [0, 0, 0];
    const mirror = name.endsWith('Left') ? -1 : 1;
    const upper = bone(`${name}Upper`, body, legRoots[name],
      [chain.bind[0] + stagger + splay[0], splay[1] * mirror, splay[2] * mirror]);
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
    [recipe.body[0], recipe.body[1], recipe.body[2] * 0.50], softBlend(recipe.body, 0.25));
  // `sculpt` is optional per-species shaping: where the chest and rump masses
  // sit inside the barrel, and how the limb muscle is proportioned. The
  // defaults are the literals these were authored with, so a recipe without a
  // sculpt block builds exactly as before.
  const sculpt = recipe.sculpt || {};
  const chestOffset = sculpt.chestOffset || [0, 0.04, 0];
  const rumpOffset = sculpt.rumpOffset || [0, 0.01, 0];
  const chestSize = [recipe.chest[0], recipe.chest[1], recipe.chest[2] * 0.50];
  ellipsoidPart(parts, shapes, rig, 'body', recipe.id === 'whitetail' ? 'coat' : 'light',
    [chestOffset[0], torsoY + chestOffset[1], recipe.shoulderZ + chestOffset[2]],
    chestSize, softBlend(chestSize, 0.24), sculpt.chestRotation || [0, 0, 0]);
  const rumpSize = [recipe.rump[0], recipe.rump[1], recipe.rump[2] * 0.50];
  // Tilting the rump is what sets the angle of the croup — the line from hip to
  // tail — which no amount of moving or resizing it can express.
  ellipsoidPart(parts, shapes, rig, 'body', 'coat',
    [rumpOffset[0], torsoY + rumpOffset[1], recipe.hipZ + rumpOffset[2]],
    rumpSize, softBlend(rumpSize, 0.24), sculpt.rumpRotation || [0, 0, 0]);
  // The pale underside is a belly stripe, not a bib: keep it narrow so it does
  // not wrap up the flanks and pool under the throat.
  const bellySize = [recipe.body[0] * 0.52, recipe.body[1] * 0.18, recipe.body[2] * 0.31];
  ellipsoidPart(parts, shapes, rig, 'body', 'cream',
    [0, torsoY - recipe.body[1] * 0.84, 0.02],
    bellySize, softBlend(bellySize, 0.075));
  // Scapular/neck-base mass is a crucial side/front silhouette landmark. It
  // is deliberately species-weighted instead of being hidden in one torso egg.
  const scapularSize = [
    recipe.chest[0] * 0.74,
    recipe.chest[1] * (recipe.id === 'fox' ? 0.48 : recipe.id === 'moose' ? 0.34 : 0.42),
    recipe.chest[2] * 0.34,
  ];
  ellipsoidPart(parts, shapes, rig, 'body', recipe.id === 'moose' ? 'dark' : 'coat',
    [0, torsoY + recipe.body[1] * (recipe.id === 'moose' ? 0.35 : 0.24), recipe.shoulderZ - 0.05],
    scapularSize, softBlend(scapularSize, recipe.id === 'moose' ? 0.20 : 0.14));

  // Blend radii here are smooth-min widths, and a blend wider than the capsule
  // itself inflates the throat into a balloon. Keep them well under the neck
  // radius so the taper survives the union with the chest.
  //
  // The two neck capsules are drawn LONGER than the bones they sit on so they
  // overlap through the joint. Butting them end to end left a visible pinch:
  // the lower capsule's rounded cap met the upper's smaller cap and the
  // silhouette necked in, which the old oversized blend had been hiding.
  capsulePart(parts, shapes, rig, 'neckBase', 'coat',
    recipe.neck.lengths[0] * 1.34, recipe.neck.radii[0], 1,
    Math.min(0.18, recipe.neck.radii[0] * 0.55));
  capsulePart(parts, shapes, rig, 'neck', 'coat',
    recipe.neck.lengths[1] * 1.18, recipe.neck.radii[1], 1,
    Math.min(0.14, recipe.neck.radii[1] * 0.55));
  const craniumSize = [recipe.head[0], recipe.head[1], recipe.head[2] * 0.50];
  ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, 0.01, 0.05],
    craniumSize, softBlend(craniumSize, 0.17));
  if (recipe.id === 'fox') {
    // Muzzle stations sit much closer to the skull than they once did: the old
    // literals pushed the nose 0.435 out from a head only 0.30 long, giving a
    // snout longer than the cranium. These keep the sharp vulpine wedge while
    // holding total head length near 0.45x shoulder height, as the sheet shows.
    // White stays on the lower muzzle and chin; the bridge above remains red.
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.044, 0.130],
      [recipe.muzzle[0], recipe.muzzle[1] * 0.80, 0.117], 0.066);
    // A narrow, tapered bridge and tip give the muzzle its sharp vulpine
    // wedge instead of the earlier blunt tube.
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, 0.033, 0.211],
      [recipe.muzzle[0] * 0.58, recipe.muzzle[1] * 0.54, 0.110], 0.048);
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.026, 0.226],
      [recipe.muzzle[0] * 0.54, recipe.muzzle[1] * 0.44, 0.102], 0.035);
    for (const side of [-1, 1]) {
      // White cheek fur sits below the eye line and rolls under the jaw —
      // keeping it low leaves the eye on open coat instead of burying it.
      ellipsoidPart(parts, shapes, rig, 'head', 'cream', [side * 0.090, -0.064, 0.089],
        [0.066, 0.074, 0.080], 0.037, [0, 0, side * 0.10]);
      // Dark tear-line running from the inner eye corner down the muzzle.
      ellipsoidPart(parts, shapes, rig, 'head', 'dark', [side * 0.095, -0.031, 0.143],
        [0.014, 0.011, 0.042], 0.009, [0.10, side * 0.12, 0]);
    }
    ellipsoidPart(parts, shapes, rig, 'head', 'black', [0, -0.007, 0.297],
      [0.042, 0.034, 0.033], 0.012);
  } else if (recipe.id === 'whitetail') {
    // Muzzle stations pulled in to match the smaller skull: the old literals
    // put the nose pad 0.61 ahead of a cranium only 0.44 long, giving a head
    // nearly twice its anatomical length. Total head length now sits near a
    // third of shoulder height, as the reference sheet shows.
    // ONE muzzle shape. The snout runs from the front of the cranium to the
    // nose pad as a single ellipsoid, so the profile is a clean taper instead
    // of three overlapping lumps. Its half-length sets total head length:
    // cranium back (-0.07) to nose tip (~0.371) = ~0.30 m at this species'
    // scale, a third of shoulder height, which is what the sheet shows.
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, -0.022, 0.215],
      [recipe.muzzle[0], recipe.muzzle[1], 0.140], 0.030);
    ellipsoidPart(parts, shapes, rig, 'head', 'black', [0, -0.018, 0.337],
      [0.034, 0.030, 0.034], 0.010);
    // White chin patch tucked under the nose — a signature whitetail marking.
    ellipsoidPart(parts, shapes, rig, 'head', 'cream', [0, -0.066, 0.287],
      [0.033, 0.019, 0.043], 0.016);
    // Slightly darker crown between the ears.
    ellipsoidPart(parts, shapes, rig, 'head', 'dark', [0, recipe.head[1] * 0.56, -0.011],
      [recipe.head[0] * 0.60, 0.028, recipe.head[2] * 0.26], 0.028);
    for (const side of [-1, 1]) {
      ellipsoidPart(parts, shapes, rig, 'head', 'light',
        [side * recipe.head[0] * 0.72, recipe.head[1] * 0.10, recipe.head[2] * 0.46],
        [0.040, 0.030, 0.034], 0.016, [0, 0, -side * 0.12]);
    }
  } else if (recipe.id === 'horse') {
    // A horse's head is ONE straight wedge from poll to nostril.
    //
    // It shared the moose's branch before this, and a moose muzzle is an
    // overhanging bell hung at z 0.52–0.96 — offsets tuned to a moose's much
    // longer skull. On the horse those landed clear of the cranium entirely, so
    // the snout floated in front of the face as a detached sausage with daylight
    // between them, which is what made the head look so wrong.
    //
    // Every station below is a fraction of the cranium's own length, so the
    // muzzle starts INSIDE the skull and walks forward out of it. The drop per
    // station is small and even: that straight line down the front of the face
    // is the single most horse-like thing about the profile.
    const L = recipe.head[2];
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, -0.030 * L, L * 0.62],
      [recipe.muzzle[0] * 0.96, recipe.muzzle[1] * 0.92, L * 0.42], 0.055);
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, -0.085 * L, L * 1.02],
      [recipe.muzzle[0] * 0.80, recipe.muzzle[1] * 0.74, L * 0.30], 0.045);
    // The nose itself: small, soft and slightly under-slung, with the nostril
    // as a dark smudge rather than a pad — a horse has no black nose plate.
    ellipsoidPart(parts, shapes, rig, 'head', 'coat', [0, -0.135 * L, L * 1.22],
      [recipe.muzzle[0] * 0.62, recipe.muzzle[1] * 0.54, L * 0.16], 0.032);
    for (const side of [-1, 1]) {
      ellipsoidPart(parts, shapes, rig, 'head', 'dark',
        [side * recipe.muzzle[0] * 0.34, -0.115 * L, L * 1.30],
        [recipe.muzzle[0] * 0.20, recipe.muzzle[1] * 0.20, L * 0.055], 0.012);
      // The cheek: a horse's jowl is a round mass at the back of the JAW —
      // low and behind, under the eye. Set wide and high it simply inflated
      // the whole skull, and the front view came out with a face as broad as
      // it was deep, which no horse has: a horse is famously narrow seen
      // head-on. Tucked down and pulled inboard, it reads as the jowl it is.
      ellipsoidPart(parts, shapes, rig, 'head', 'coat',
        [side * recipe.head[0] * 0.44, -recipe.head[1] * 0.52, L * 0.02],
        [recipe.head[0] * 0.34, recipe.head[1] * 0.44, L * 0.34], 0.050);
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
    // Set back along the skull and sunk into it: `inset` is a fraction of the
    // cranium's half-width, but the skull is an ellipsoid, so at the eye's
    // position its local half-width is much less than head[0]. At the old 0.92
    // the eye floated 0.073 proud of that surface and bulged; 0.82 leaves it
    // 0.024 proud — seated in the socket but still clearing the coat.
    whitetail: { inset: 0.82, depth: 0.40, scale: [0.021, 0.020, 0.017], ring: [0.026, 0.025, 0.022], glint: [0.006, 0.007, 0.005], tilt: 0.10 },
    fox: { inset: 0.88, depth: 0.38, scale: [0.037, 0.033, 0.026], ring: null, glint: [0.009, 0.010, 0.008], tilt: 0.30 },
    moose: { inset: 0.90, depth: 0.36, scale: [0.045, 0.050, 0.040], ring: null, glint: [0.012, 0.014, 0.010], tilt: 0 },
    // A horse's eye is the largest of any land mammal's and sits high and wide
    // on the skull, which is what gives it its near-panoramic vision — and,
    // read as a face, most of its gentleness. Set proud rather than deep-set:
    // the socket stands out from the cheek instead of sinking into it.
    horse: { inset: 0.94, depth: 0.30, scale: [0.040, 0.046, 0.036], ring: null, glint: [0.011, 0.013, 0.009], tilt: 0.06 },
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
    // Proportions are `sculpt`-tunable so a haunch can be built up or slimmed
    // without touching the bone lengths that the gait solver depends on. Sizes
    // are multiples of the segment's own radius and length; offsets likewise,
    // so the mass tracks the limb it belongs to at any scale.
    const limbMass = (isFront ? sculpt.foreMass : sculpt.hindMass) || (isFront
      ? { size: [1.08, 0.27, 1.12], offset: [0, -0.30, -0.10] }
      : { size: [1.25, 0.32, 1.32], offset: [0, -0.34, 0] });
    ellipsoidPart(parts, shapes, rig, `${name}Upper`, 'coat',
      [
        limbMass.offset[0] * chain.radii[0],
        limbMass.offset[1] * chain.lengths[0],
        limbMass.offset[2] * chain.radii[0],
      ],
      [
        chain.radii[0] * limbMass.size[0],
        chain.lengths[0] * limbMass.size[1],
        chain.radii[0] * limbMass.size[2],
      ],
      0.085,
      // Rotating the thigh mass angles the haunch across the limb, which is
      // most of what distinguishes a driving hindquarter from a straight one.
      (limbMass.rotation || [0, 0, 0]).map((angle, axis) => (
        axis === 0 ? angle : angle * (name.endsWith('Left') ? -1 : 1)
      )));
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
    // A horse's tail is hair, and it is the same hair as the mane — so it takes
    // the same palette slot the mane and the lower legs use. That is not a
    // shortcut: on a real horse those three are one colour system (a bay's
    // black points are its mane, tail and legs), so every morph below stays
    // coherent without listing the parts separately.
    const horseHair = recipe.id === 'horse';
    ellipsoidPart(parts, shapes, rig, tailChain.bones[i].name,
      horseHair ? 'dark' : isLightTip ? 'cream' : 'coat',
      [0, tailChain.segmentLength * 0.50, 0],
      // Segments overlap along the chain (y > half the segment) so the brush
      // reads as one tapered plume instead of a row of beads.
      // The horse's fall is flattened side-to-side and deepened front-to-back,
      // so it hangs as a sheet of hair rather than a rope.
      horseHair
        ? [radius * 0.78, tailChain.segmentLength * 0.72, radius * 1.24]
        : [radius, tailChain.segmentLength * (recipe.id === 'fox' ? 0.86 : 0.64), radius],
      recipe.id === 'fox' ? 0.115 : horseHair ? 0.085 : 0.062);
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
    // The white throat is a STRIP down the front of the neck and a small patch
    // on the brisket — not a mass hanging off the sternum. The old bib was
    // 0.52m tall and sat 0.20 ahead of the shoulder, so it ballooned out in
    // front of the chest and swallowed the throat; this one is flat, narrow
    // and tucked against the surface it belongs to.
    const bib = [0.095, 0.150, 0.090];
    ellipsoidPart(parts, shapes, rig, 'body', 'cream',
      [0, torsoY - 0.02, recipe.shoulderZ + 0.02], bib, softBlend(bib, 0.052));
    // Long, flat throat strips so the white runs down the neck and feathers
    // into the coat rather than reading as attached spheres.
    const upperThroat = [0.070, recipe.neck.lengths[0] * 0.42, 0.058];
    ellipsoidPart(parts, shapes, rig, 'neckBase', 'cream',
      [0, recipe.neck.lengths[0] * 0.46, 0.115], upperThroat, softBlend(upperThroat, 0.070));
    const lowerThroat = [0.058, recipe.neck.lengths[1] * 0.34, 0.048];
    ellipsoidPart(parts, shapes, rig, 'neck', 'cream',
      [0, recipe.neck.lengths[1] * 0.30, 0.095], lowerThroat, softBlend(lowerThroat, 0.060));
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
  if (recipe.id === 'horse') {
    const neckLower = recipe.neck.lengths[0], neckUpper = recipe.neck.lengths[1];
    // --- the crest ------------------------------------------------------------
    // A horse's topline is not the neck capsule: the muscle of the crest sits
    // ON it, thickest at the base and running out toward the poll. Without it
    // the neck reads as a tube and the animal looks like a donkey no matter
    // what the head is doing.
    ellipsoidPart(parts, shapes, rig, 'neckBase', 'coat',
      [0, neckLower * 0.52, -recipe.neck.radii[0] * 0.52],
      [recipe.neck.radii[0] * 0.62, neckLower * 0.56, recipe.neck.radii[0] * 0.50], 0.075);
    ellipsoidPart(parts, shapes, rig, 'neck', 'coat',
      [0, neckUpper * 0.46, -recipe.neck.radii[1] * 0.46],
      [recipe.neck.radii[1] * 0.58, neckUpper * 0.52, recipe.neck.radii[1] * 0.44], 0.060);

    // --- the mane -------------------------------------------------------------
    // Laid ON the crest, not in it.
    //
    // The first attempt offset each row by 0.72 of the neck radius, which is
    // INSIDE the neck capsule — so the whole mane was swallowed by the coat and
    // all that survived were two stray lumps where a row happened to clear the
    // surface. The offset has to exceed the radius for the hair to sit proud of
    // the neck at all.
    //
    // Rows run from the withers to the poll with heavy overlap, each falling a
    // little further to one side than the last, so the mane breaks over the
    // neck the way hair does instead of standing up like a fin. Thin in x, deep
    // in z: a thin edge from the front, a curtain from the side.
    // Drawn as CAPSULES along the crest, not a row of ellipsoids.
    //
    // Discrete blobs were tried twice and beaded both times: the smooth-min
    // blend is capped at a fraction of the smallest axis, and a mane is thin in
    // x by definition, so the blend can never reach across the gap from one row
    // to the next. A capsule spans its whole run with no seam to close, so the
    // crest comes out as one fall of hair.
    //
    // Two runs per bone rather than one, so the mane tapers from a heavy base
    // at the withers to a finer edge at the poll.
    const maneRuns = [
      { bone: 'neckBase', radius: recipe.neck.radii[0], from: -0.26, to: 0.50, thick: 0.44 },
      { bone: 'neckBase', radius: recipe.neck.radii[0], from: 0.44, to: 1.04, thick: 0.40 },
      { bone: 'neck', radius: recipe.neck.radii[1], from: -0.06, to: 0.54, thick: 0.40 },
      { bone: 'neck', radius: recipe.neck.radii[1], from: 0.48, to: 1.02, thick: 0.32 },
    ];
    for (const run of maneRuns) {
      const span = run.bone === 'neckBase' ? neckLower : neckUpper;
      const lateral = run.radius * 0.24;
      // Standing clear of the crest, not resting on it. At exactly the radius
      // the mane sat half inside the neck, and the generous blend then melted
      // what was left into the coat — the crest read as a dark edge rather than
      // as hair. Out past the surface, with a blend small enough to keep its
      // own shape, it becomes a mass you can see from across a field.
      // Bracketed by eye in the lab: 1.16 left the mane buried in the coat and
      // 1.42 floated it off the neck as a row of detached tubes. The neck
      // capsule carries a blend of up to 0.55 of its own radius, so the visible
      // surface sits some way outside the bare radius — and near the withers
      // the scapular mass pushes it out further still.
      const back = -run.radius * 1.26;
      capsuleBetween(parts, shapes, rig, run.bone, 'dark',
        [lateral, run.from * span, back], [lateral, run.to * span, back],
        // Enough blend to fuse one run into the next, not enough to melt the
        // whole mane back into the neck.
        run.radius * run.thick, 0.05);
    }
    // The forelock, falling forward over the brow between the ears. Small — it
    // is a lock of hair, and at forelock scale a generous one reads as a hat.
    const forelock = [recipe.head[0] * 0.42, recipe.head[1] * 0.30, recipe.head[2] * 0.30];
    ellipsoidPart(parts, shapes, rig, 'head', 'dark',
      [0.01, recipe.head[1] * 0.52, -recipe.head[2] * 0.10], forelock,
      softBlend(forelock, 0.035), [0.34, 0, -0.12]);

    // --- muscling -------------------------------------------------------------
    // The shoulder and the haunch, which is where a horse's "toned" reads from.
    // Both are laid inside the silhouette so the smooth-min swells the surface
    // rather than hanging a lump off it.
    for (const side of [-1, 1]) {
      const shoulder = [recipe.chest[0] * 0.44, recipe.chest[1] * 0.40, recipe.chest[2] * 0.52];
      ellipsoidPart(parts, shapes, rig, 'body', 'coat',
        [side * recipe.chest[0] * 0.50, torsoY + recipe.body[1] * 0.06, recipe.shoulderZ - 0.12],
        shoulder, softBlend(shoulder, 0.11));
      const haunch = [recipe.rump[0] * 0.48, recipe.rump[1] * 0.52, recipe.rump[2] * 0.42];
      ellipsoidPart(parts, shapes, rig, 'body', 'coat',
        [side * recipe.rump[0] * 0.46, torsoY + recipe.body[1] * 0.10, recipe.hipZ + 0.10],
        haunch, softBlend(haunch, 0.12));
    }
    // The croup: the rounded rise over the hip that carries into the tail.
    const croup = [recipe.rump[0] * 0.78, recipe.rump[1] * 0.40, recipe.rump[2] * 0.60];
    ellipsoidPart(parts, shapes, rig, 'body', 'coat',
      [0, torsoY + recipe.body[1] * 0.46, recipe.hipZ + 0.04], croup, softBlend(croup, 0.14));

    // --- markings -----------------------------------------------------------
    //
    // The model is built ONCE per species and shared by every instance — only
    // the palette varies per horse. So markings cannot be added or removed per
    // animal; they are always in the geometry, and a horse that has none simply
    // has them painted its own coat colour.
    //
    // That buys two independent channels, because the horse leaves two palette
    // slots spare. `antler` is wholly unused (no antlers), so it carries the
    // face. `cream` is only the belly stripe, so it carries the legs — and a
    // horse with white socks having a pale belly is a real horse, while a solid
    // one just gets a belly matching its coat.
    const L = recipe.head[2];
    // Star on the forehead and a blaze running down the face. Drawn together:
    // one slot means they appear and vanish as a set, which is why they are
    // shaped as one continuous marking rather than as separate options.
    const star = [recipe.head[0] * 0.30, recipe.head[1] * 0.30, L * 0.16];
    ellipsoidPart(parts, shapes, rig, 'head', 'antler',
      [0, recipe.head[1] * 0.40, -L * 0.02], star, softBlend(star, 0.030));
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      const blaze = [recipe.muzzle[0] * (0.34 - t * 0.10), recipe.muzzle[1] * 0.34, L * 0.24];
      ellipsoidPart(parts, shapes, rig, 'head', 'antler',
        [0, recipe.head[1] * (0.30 - t * 0.22) - t * 0.02 * L, L * (0.34 + t * 0.42)],
        blaze, softBlend(blaze, 0.026));
    }
    // Socks. Height varies leg to leg, as they do on a real horse — a matched
    // set of four reads as painted on.
    const sockHeights = { frontLeft: 0.62, frontRight: 0.30, hindLeft: 0.78, hindRight: 0.46 };
    for (const legName of LEG_ORDER) {
      const chain = legName.startsWith('front') ? recipe.leg.front : recipe.leg.hind;
      const height = sockHeights[legName];
      const sock = [chain.radii[2] * 1.16, chain.lengths[2] * height * 0.5, chain.radii[2] * 1.16];
      ellipsoidPart(parts, shapes, rig, `${legName}Pastern`, 'cream',
        [0, -chain.lengths[2] * (1 - height * 0.5), 0], sock, softBlend(sock, 0.020));
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

function updateShapeTexture(rig, shapes, state, phenotype = null) {
  rig.root.updateMatrixWorld(true);
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    const antlerScale = shape.isAntler ? (phenotype?.antlerScale ?? 1) : 1;
    if (shape.isAntler && phenotype?.antlers === false) {
      const offset = i * SHAPE_TEXELS * 4;
      state.data[offset] = 0;
      state.data[offset + 1] = -1000;
      state.data[offset + 2] = 0;
      state.data[offset + 3] = shape.type + shape.colour * 4;
      state.data[offset + 4] = 0;
      state.data[offset + 5] = 0;
      state.data[offset + 6] = 0;
      state.data[offset + 7] = 1;
      state.data[offset + 8] = 0.002;
      state.data[offset + 9] = 0.002;
      state.data[offset + 10] = 0.002;
      state.data[offset + 11] = 0.001;
      continue;
    }
    if (shape.isAntler && antlerScale !== 1) {
      shape.localMatrix.decompose(tmpV, tmpQ, tmpScale);
      tmpV.multiplyScalar(antlerScale);
      tmpM2.compose(tmpV, tmpQ, tmpScale);
      tmpM.multiplyMatrices(rig.byName[shape.boneName].matrixWorld, tmpM2);
    } else {
      tmpM.multiplyMatrices(rig.byName[shape.boneName].matrixWorld, shape.localMatrix);
    }
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
    state.data[offset + 8] = shape.params.x * antlerScale;
    state.data[offset + 9] = shape.params.y * antlerScale;
    state.data[offset + 10] = shape.params.z * antlerScale;
    state.data[offset + 11] = shape.blend * antlerScale;
  }
  state.texture.needsUpdate = true;
}

function createAnimalMaterial(recipe, shapeState, neighbourState, shapeCount) {
  const palette = PALETTE_KEYS.map((key) => new THREE.Color(
    key === 'glint' ? 0xf8eed8 : recipe.palette[key],
  ));
  const material = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  material.name = `${recipe.id}-sdf-skin`;
  material.userData.palette = palette;
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
        // Three.js only declares `worldPosition` inside worldpos_vertex when
        // USE_ENVMAP/USE_SHADOWMAP/USE_TRANSMISSION or spot coords are
        // defined. The depth material used for shadow casting sets none of
        // those, which left this undeclared there — computed independently
        // so it compiles in every variant.
        `#include <worldpos_vertex>
         vAnimalWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
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
    this.stateDuration = 1;
    this.previewTimer = 0;
    // Behaviour runs on staggered 4–6Hz planning ticks. Locomotion, IK and
    // secondary motion still update each frame, but perception and contextual
    // world searches do not become a new sustained CPU cost.
    this.behaviourTimer = this.rng() * 0.22;
    this.behaviourElapsed = 0;
    this.alertness = 0;
    this.alertStage = 'calm';
    this.dangerTimer = 0;
    this.lastDanger = new THREE.Vector3();
    this.hasDanger = false;
    // A tame animal watches you in spells rather than continuously.
    this.regard = createRegard();
    this.playerInSight = false;
    this.minimumEscapeTimer = 0;
    this.escapeReplanTimer = 0;
    this.rareCooldown = 18 + this.rng() * 34;
    this.queuedPounce = false;
    this.goalType = 'home';
    this.goalArrival = null;
    this.needs = {
      food: 0.25 + this.rng() * 0.45,
      water: 0.12 + this.rng() * 0.28,
      cover: 0.15 + this.rng() * 0.30,
      rest: this.rng() * 0.25,
    };
    this.groupId = null;
    this.isSentinel = false;
    this.tailAlarm = 0;
    this.target = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.lean = { value: 0, velocity: 0 };
    this.look = { value: 0, velocity: 0 };
    // Head carriage and tail swish are self-directed rather than a function of
    // the behaviour state. See advanceHeadCarriage / advanceTailSwish.
    this.headMood = { carriage: 0, target: 0, yaw: 0, yawTarget: 0, timer: 0 };
    this.tailSwish = { timer: 0, remaining: 0, phase: 0, speed: 0, force: 0 };
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
    // A horse's tail is a long, heavy fall of loose hair, and it needs a much
    // looser rope than a deer's short flag. At the shared restStrength of 0.11
    // the spring back to the bind pose overwhelmed the swish almost entirely —
    // the tip travelled 16 cm over fifteen seconds on a 1.2 m tail, which is
    // invisible. Weak rest, heavy gravity and high damping let it hang, carry
    // its own momentum, and actually sweep when it is flicked.
    const horseTail = this.recipe.id === 'horse';
    this.tailRope = new VerletSdfRope(this.rig, this.mesh, this.rig.ropeChains.tail, {
      gravity: this.recipe.id === 'fox' ? 2.8 : horseTail ? 3.2 : 2.2,
      damping: this.recipe.id === 'fox' ? 0.935 : horseTail ? 0.948 : 0.90,
      restStrength: this.recipe.id === 'fox' ? 0.055 : horseTail ? 0.030 : 0.11,
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
    this.configurePhenotype(showcaseAnimalPhenotype(this.recipe.id));
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
    this.behaviourTimer = this.rng() * 0.22;
    this.behaviourElapsed = 0;
    this.alertness = 0;
    this.alertStage = 'calm';
    this.dangerTimer = 0;
    this.hasDanger = false;
    this.minimumEscapeTimer = 0;
    this.escapeReplanTimer = 0;
    this.rareCooldown = 18 + this.rng() * 34;
    this.queuedPounce = false;
    this.goalType = 'home';
    this.goalArrival = null;
    this.tailAlarm = 0;
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

  setState(state, duration) {
    this.state = state;
    this.stateTimer = duration;
    this.stateDuration = Math.max(duration, 0.001);
  }

  /**
   * Where the animal is choosing to carry its head, independent of what it is
   * doing.
   *
   * Head height was previously a step function of the behaviour state — down
   * for 'graze', up otherwise — with a ±0.01 rad wobble on top, which is
   * invisible. A real horse is never still above the neck: it lifts to look at
   * something, drops to crop grass, swings its nose across to the other side,
   * and holds each for a few seconds before changing its mind.
   *
   * The one hard rule is the walking clamp. A horse at a walk lowers and raises
   * its head freely, but it does NOT put its nose on the ground — it would trip
   * over it — so while moving the carriage is capped well short of grazing and
   * the side-to-side look narrows to the glance you would actually see.
   */
  advanceHeadCarriage(dt, moving) {
    const mood = this.headMood;
    mood.timer -= dt;
    if (mood.timer <= 0) {
      const roll = this.rng();
      // Hold a chosen carriage for a few seconds. Re-rolling every frame would
      // read as a tremor rather than as intent.
      mood.timer = 1.8 + this.rng() * 4.6;
      // Branched on moving rather than clamped afterwards. Sharing one set of
      // odds and capping the result meant a walking horse fell through the
      // grazing branch into "head up" and spent its whole walk with its head
      // raised — measured over 23 s it never once lowered.
      if (moving) {
        if (roll < 0.30) mood.target = -0.26 - this.rng() * 0.24;      // attentive
        else if (roll < 0.62) mood.target = 0.14 + this.rng() * 0.16;  // lowered
        else mood.target = (this.rng() - 0.5) * 0.26;                  // neutral
      } else if (roll < 0.36) {
        mood.target = 0.88 + this.rng() * 0.14;                        // down to the grass
      } else if (roll < 0.60) {
        mood.target = -0.28 - this.rng() * 0.26;
      } else {
        mood.target = (this.rng() - 0.4) * 0.40;
      }
      mood.yawTarget = (this.rng() - 0.5) * (moving ? 0.34 : 0.82);
    }
    // Grazing is an idle activity. At a walk the nose stays well clear.
    const target = moving ? Math.min(mood.target, 0.30) : mood.target;
    mood.carriage = damp(mood.carriage, target, moving ? 2.4 : 1.6, dt);
    mood.yaw = damp(mood.yaw, mood.yawTarget, 1.7, dt);
    // A slow drift laid OVER the damped pose rather than added into it — fold
    // it into the state and the damping integrates it, and the head wanders.
    // Small enough to read as breathing, not as indecision.
    mood.drift = Math.sin(this.age * 0.47 + this.seedPhase) * 0.035;
    mood.yawDrift = Math.sin(this.age * 0.31 + this.seedPhase * 1.7) * 0.045;
  }

  /**
   * The sideways impulse driving the tail rope, as a horse actually uses it.
   *
   * The shared `tailWave` is a single sine at a fixed amplitude, so every tail
   * in the world swishes forever at the same rate. A horse's tail spends most
   * of its time simply hanging — swaying from the body's own movement and
   * gravity, which the rope gives for free — punctuated by deliberate bursts:
   * one flick at a fly, or four hard ones at a cloud of them.
   *
   * Returning 0 is therefore a real answer, not an absence of one: the rope
   * keeps simulating and the tail keeps moving with the horse.
   */
  advanceTailSwish(dt) {
    const swish = this.tailSwish;
    if (swish.remaining <= 0) {
      swish.timer -= dt;
      if (swish.timer > 0) return 0;                   // hanging, gravity only
      // Decide between another quiet spell and a burst.
      if (this.rng() < 0.42) {
        swish.timer = 2.2 + this.rng() * 6.5;
        return 0;
      }
      // At least two swings, because the rope lags: a single cycle was over
      // before the tail had built any amplitude, and a burst that should have
      // been three swings came out as one slow arc across and back.
      swish.remaining = 2 + Math.floor(this.rng() * 3);
      // Each full cycle takes 2*pi/speed — roughly 0.8–1.3 s across and back.
      // Measured against this rope, that band tracks cleanly; much slower and
      // it drifts rather than swings.
      swish.speed = 5.0 + this.rng() * 3.0;
      // Sized against the rope, not picked by feel. At 1.3–4.3 the rest spring
      // swallowed it entirely; even at 6 the weaker bursts never got the tail
      // moving before they ended.
      swish.force = 10.0 + this.rng() * 9.0;
      swish.phase = 0;
    }
    swish.phase += dt * swish.speed;
    // A FULL cycle per swing, and the sine is allowed to go negative rather
    // than being rectified and flipped by hand.
    //
    // Half-cycles were tried first and are what made it twitch: each flick ran
    // the force 0 -> peak -> 0 and then reversed, so the drive died at both
    // ends of every pass and the tail was pushed, released, pushed back. A
    // whole sine carries force through the reversal, which is what makes a
    // pendulum swing instead of flicking twice.
    while (swish.phase >= TAU && swish.remaining > 0) {
      swish.phase -= TAU;
      swish.remaining--;
      if (swish.remaining <= 0) {
        swish.timer = 1.4 + this.rng() * 5.0;
        swish.phase = 0;
        return 0;
      }
    }
    return Math.sin(swish.phase) * swish.force;
  }

  /**
   * Hand the animal over to a rider, or take it back.
   *
   * `input` is `{ forward, steer }` — forward 0..1, steer -1..1 — or null to
   * return the animal to its own behaviour.
   */
  setRider(input) {
    const hadRider = !!this.rider;
    this.rider = input || null;
    if (this.rider && !hadRider) {
      this.riddenHeading = this.heading;
      this.rememberBehaviour?.();
    }
    if (!this.rider && hadRider) {
      this.motionPreviewSpeed = null;
      this.setState('alert', 1.4);
    }
  }

  /**
   * Steering and drive while ridden, in place of the behaviour tree.
   *
   * Deliberately expressed as a target and a speed rather than by writing
   * heading and velocity directly: everything that makes the animal move well —
   * the turn-radius arc, the terrain grade scaling, the gait entering on a
   * known hoof — lives downstream of those two inputs, and setting the pose by
   * hand would bypass all of it and give a horse that pivots like a turret.
   */
  updateRiddenIntent(dt) {
    const rider = this.rider;
    // A ridden animal is not deciding anything, and must not startle: the
    // player is on its back.
    this.alertness = 0;
    this.hasDanger = false;
    this.alertStage = 'calm';
    this.stateTimer = 1e9;
    const forward = clamp(rider.forward || 0, 0, 1);
    // Reining round is a rate, so holding the key sweeps the heading rather
    // than snapping it. Slower at speed, as a real horse turns wider the
    // faster it goes.
    const agility = 1 - 0.45 * clamp(this.speed / Math.max(0.001, this.recipe.motion.run), 0, 1);
    this.riddenHeading += (rider.steer || 0) * dt * this.recipe.motion.turn * agility;
    this.target.set(
      this.mesh.position.x + Math.sin(this.riddenHeading) * 60,
      this.mesh.position.y,
      this.mesh.position.z + Math.cos(this.riddenHeading) * 60,
    );
    // No reverse. A horse asked to back up under saddle does not, and the gait
    // solver has no backward walk — so the only choices are forward or halt.
    //
    // The ceiling comes from the rider rather than the recipe: how fast a horse
    // is worth riding is a question about the player's other options, not about
    // the animal, and the answer lives with the walking speeds it is measured
    // against. The recipe fraction stays as the fallback for a mount handed no
    // ceiling at all.
    const cruise = this.recipe.motion.cruise;
    const asked = Number.isFinite(rider.topSpeed) ? rider.topSpeed : this.recipe.motion.run * 0.72;
    const top = Math.max(asked, cruise);
    this.motionPreviewSpeed = forward > 0.04 ? cruise + (top - cruise) * forward : 0;
    this.state = forward > 0.04 ? 'roam' : 'idle';
  }

  configurePhenotype(phenotype) {
    this.phenotype = phenotype || showcaseAnimalPhenotype(this.recipe.id);
    this.mesh.scale.setScalar(this.phenotype.scale || 1);
    const palette = this.material.userData.palette;
    for (let i = 0; i < PALETTE_KEYS.length; i++) {
      const key = PALETTE_KEYS[i];
      palette[i].set(key === 'glint' ? 0xf8eed8 : this.recipe.palette[key]);
    }
    if (this.recipe.id === 'horse' && HORSE_COLOURS[this.phenotype.morph]) {
      // A horse's colour is a set, not a hue shift: body, points and soft parts
      // move together. `dark` carries the points — mane, tail and lower legs —
      // which is why a palomino's pale mane and a bay's black one need no
      // special casing anywhere in the model.
      const colours = HORSE_COLOURS[this.phenotype.morph];
      palette[PALETTE_INDEX.coat].set(colours.coat);
      palette[PALETTE_INDEX.dark].set(colours.dark);
      palette[PALETTE_INDEX.light].set(colours.light);
      palette[PALETTE_INDEX.cream].set(colours.cream);
      // The remaining jitter is deliberately tiny (see animalpopulation): it
      // separates two bays standing together without turning one of them roan.
      for (const key of ['coat', 'light']) {
        palette[PALETTE_INDEX[key]].offsetHSL(
          this.phenotype.coatHue || 0, this.phenotype.coatSaturation || 0,
          this.phenotype.coatLightness || 0,
        );
      }
      // White markings are in the geometry for every horse, because the mesh is
      // shared and cannot vary per animal. They are switched on by painting
      // them white and off by painting them the coat colour, which is why the
      // horse needed two spare palette slots for it: `antler` carries the face
      // (it has no antlers to want it) and `cream` the legs.
      const markings = this.phenotype.markings || { face: false, socks: false };
      const white = 0xf2ece1;
      palette[PALETTE_INDEX.antler].set(markings.face ? white : colours.coat);
      if (markings.face) {
        palette[PALETTE_INDEX.antler].offsetHSL(0, 0, (this.phenotype.coatLightness || 0) * 0.3);
      } else {
        palette[PALETTE_INDEX.antler].copy(palette[PALETTE_INDEX.coat]);
      }
      if (markings.socks) palette[PALETTE_INDEX.cream].set(white);
    } else if (this.recipe.id === 'fox' && this.phenotype.morph === 'white') {
      palette[PALETTE_INDEX.coat].set(0xe4e3dd);
      palette[PALETTE_INDEX.light].set(0xf1efe8);
      palette[PALETTE_INDEX.cream].set(0xfffbef);
      palette[PALETTE_INDEX.dark].set(0x999b9b);
      palette[PALETTE_INDEX.black].set(0x343638);
    } else if (this.recipe.id === 'fox' && this.phenotype.morph === 'black') {
      palette[PALETTE_INDEX.coat].set(0x292a2d);
      palette[PALETTE_INDEX.light].set(0x414145);
      palette[PALETTE_INDEX.cream].set(0x77746f);
      palette[PALETTE_INDEX.dark].set(0x17181a);
      palette[PALETTE_INDEX.black].set(0x090a0b);
    } else {
      for (const key of ['coat', 'light', 'dark']) {
        const colour = palette[PALETTE_INDEX[key]];
        colour.offsetHSL(
          this.phenotype.coatHue || 0,
          this.phenotype.coatSaturation || 0,
          this.phenotype.coatLightness || 0,
        );
      }
    }
    this.rareCooldown = this.phenotype.playfulPounces
      ? 2.5 + this.rng() * 5.5
      : 18 + this.rng() * 34;
    updateShapeTexture(this.rig, this.asset.shapes, this.shapeState, this.phenotype);
  }

  pickState(initial = false, context = null) {
    if (!initial && this.alertStage !== 'calm') return;

    // Signature actions are scheduled behind a long cooldown. They should feel
    // like sightings, not looping idles the animal performs for the camera.
    if (!initial && this.rareCooldown <= 0) {
      if (this.recipe.id === 'fox') {
        this.queuedPounce = true;
        this.goalType = 'food';
        this.setState('listen', 1.8 + this.rng() * 1.7);
        this.rareCooldown = this.phenotype?.playfulPounces
          ? 4 + this.rng() * 9 : 34 + this.rng() * 48;
        return;
      }
      if (this.recipe.id === 'moose') {
        const water = this.findContextDestination('water', context, true);
        if (water) {
          this.setTravelGoal(water, 'water', 'wade');
          this.rareCooldown = 48 + this.rng() * 70;
          return;
        }
      }
      this.rareCooldown = 22 + this.rng() * 32;
    }

    // A herd sentinel spends occasional calm intervals watching while its
    // companions feed. It still uses real alertness for danger reactions.
    if (!initial && this.recipe.id === 'whitetail' && this.isSentinel && this.rng() < 0.42) {
      this.goalType = 'cover';
      this.setState('sentinel', 4.5 + this.rng() * 5.5);
      return;
    }

    const distanceHome = Math.hypot(
      this.mesh.position.x - this.home.x,
      this.mesh.position.z - this.home.z,
    );
    const goal = initial ? 'home' : chooseAnimalGoal({
      food: 0.72 + this.needs.food * 1.6,
      water: 0.10 + this.needs.water * 0.85,
      cover: 0.18 + this.needs.cover * 0.75,
      trail: this.recipe.id === 'fox' ? 0.34 : 0.16,
      home: 0.12 + clamp((distanceHome - 18) / 32, 0, 1) * 1.8,
    }, this.rng());
    const destination = !initial ? this.findContextDestination(goal, context) : null;
    if (destination && Math.hypot(
      destination.x - this.mesh.position.x,
      destination.z - this.mesh.position.z,
    ) > 2.2) {
      this.setTravelGoal(destination, goal,
        goal === 'water' ? (this.recipe.id === 'moose' ? 'wade' : 'drink') : null);
      return;
    }

    const roll = this.rng();
    if (!initial && (goal === 'food' || roll < 0.27)) {
      this.goalType = 'food';
      this.setState(this.recipe.id === 'moose' ? 'browse' : 'graze', 4 + this.rng() * 7);
      this.needs.food = Math.max(0, this.needs.food - 0.28);
      return;
    }
    if (!initial && roll < 0.48) {
      this.goalType = 'rest';
      this.setState('idle', 2.2 + this.rng() * 5);
      this.needs.rest = Math.max(0, this.needs.rest - 0.22);
      return;
    }
    this.goalType = initial ? 'home' : goal;
    this.setState('roam', 5 + this.rng() * 9);
    const angle = this.rng() * TAU;
    const radius = 5 + this.rng() * 14;
    this.target.set(
      this.home.x + Math.sin(angle) * radius,
      0,
      this.home.z + Math.cos(angle) * radius,
    );
    this.routeTimer = 0;
  }

  setTravelGoal(destination, goalType, arrival = null) {
    this.goalType = goalType;
    this.goalArrival = arrival;
    this.target.set(destination.x, 0, destination.z);
    this.setState(goalType === 'water' && arrival === 'wade' ? 'wade' : 'travel',
      8 + Math.hypot(destination.x - this.mesh.position.x,
        destination.z - this.mesh.position.z) / Math.max(0.2, this.recipe.motion.cruise));
    this.routeTimer = 0;
  }

  findContextDestination(goal, context, requireWater = false) {
    if (goal === 'home') return { x: this.home.x, z: this.home.z };
    if (goal === 'trail' && context?.trails?.length) {
      const trail = nearestTrailPoint(
        context.trails, this.mesh.position.x, this.mesh.position.z, context.trailScratch || {},
      );
      if (trail.edgeId && trail.distance < 54) {
        const direction = this.rng() < 0.5 ? -1 : 1;
        const stride = 9 + this.rng() * 13;
        const x = trail.x + trail.tangentX * stride * direction;
        const z = trail.z + trail.tangentZ * stride * direction;
        if (this.safeAhead(x, z)) return { x, z };
      }
    }

    const originX = this.mesh.position.x;
    const originZ = this.mesh.position.z;
    let best = null;
    const phase = this.rng() * TAU;
    const samples = goal === 'water' ? 32 : 14;
    for (let i = 0; i < samples; i++) {
      const ring = goal === 'water' ? 6 + Math.floor(i / 8) * 8 : 7 + (i % 4) * 7;
      const angle = phase + (i % 8) / 8 * TAU + Math.floor(i / 8) * 0.29;
      const x = originX + Math.sin(angle) * ring;
      const z = originZ + Math.cos(angle) * ring;
      const biome = this.world.biomeAt(x, z);
      if (biome.h <= 0.35 || biome.slope > 0.48) continue;
      const river = this.world.riverAt(x, z);
      if (goal === 'water') {
        if (!river.wet || river.depth > (this.recipe.id === 'moose' ? 1.15 : 0.35)) continue;
        const score = 3 - ring * 0.025 - river.depth * 0.18;
        if (!best || score > best.score) {
          if (this.recipe.id === 'moose') {
            best = { x, z, score, wet: true };
          } else {
            // Stop on the dry bank facing the sampled water. Backtracking from
            // the wet point avoids asking ordinary animals to route through a
            // channel merely to satisfy thirst.
            const towardX = (originX - x) / Math.max(ring, 0.01);
            const towardZ = (originZ - z) / Math.max(ring, 0.01);
            let bankX = x;
            let bankZ = z;
            for (let step = 1; step <= 6; step++) {
              bankX = x + towardX * step;
              bankZ = z + towardZ * step;
              if (!this.world.riverAt(bankX, bankZ).wet) break;
            }
            if (!this.world.riverAt(bankX, bankZ).wet) {
              best = { x: bankX, z: bankZ, score, wet: false };
            }
          }
        }
        continue;
      }
      if (river.wet && river.depth > 0.04) continue;
      const wooded = biome.id === 'forest' || biome.id === 'taiga' || biome.id === 'jungle';
      const grove = this.world.groveFactor ? this.world.groveFactor(x, z) : (wooded ? 0.7 : 0.1);
      const openness = this.world.openFactor ? this.world.openFactor(x, z) : (wooded ? 0.3 : 0.8);
      let score = -ring * 0.012;
      if (goal === 'cover') score += (wooded ? 1.4 : 0) + grove * 1.5 - openness * 0.35;
      if (goal === 'food') {
        if (this.recipe.id === 'fox') {
          score += (biome.id === 'grassland' || biome.id === 'tundra' ? 1.25 : 0.45)
            + openness * 0.8 + (1 - Math.abs(grove - 0.45)) * 0.35;
        } else if (this.recipe.id === 'moose') {
          score += (wooded ? 1.25 : 0.25) + (biome.m ?? 0.5) * 0.8 + grove * 0.5;
        } else {
          score += (biome.id === 'grassland' ? 1.2 : wooded ? 0.75 : 0.15)
            + openness * 0.8;
        }
      }
      if (!best || score > best.score) best = { x, z, score, wet: false };
    }
    if (goal === 'water' && requireWater && !best) return null;
    return best;
  }

  arriveAtGoal() {
    if (this.queuedPounce && this.state === 'listen') return;
    if (this.goalType === 'water') {
      this.goalArrival = null;
      this.setState('drink', 4 + this.rng() * 4);
      this.needs.water = Math.max(0, this.needs.water - 0.50);
      return;
    }
    if (this.goalType === 'food') {
      this.setState(this.recipe.id === 'moose' ? 'browse' : 'graze', 4 + this.rng() * 7);
      this.needs.food = Math.max(0, this.needs.food - 0.35);
    } else {
      this.setState('idle', 2 + this.rng() * 4.5);
    }
  }

  startFoxPounce() {
    this.queuedPounce = false;
    const heading = this.heading + (this.rng() - 0.5) * 0.42;
    const distance = 3.6 + this.rng() * 2.2;
    const x = this.mesh.position.x + Math.sin(heading) * distance;
    const z = this.mesh.position.z + Math.cos(heading) * distance;
    if (!this.safeAhead(x, z)) {
      this.setState('idle', 1.2);
      return;
    }
    this.target.set(x, 0, z);
    this.setState('pounce', 1.15);
    this.routeTimer = 0;
  }

  safeAhead(x, z) {
    const height = this.world.height(x, z);
    const river = this.world.riverAt(x, z);
    const shallowMooseWater = this.recipe.id === 'moose'
      && (this.state === 'wade' || this.goalArrival === 'wade'
        || (this.phenotype?.role === 'calf' && this.state === 'follow'))
      && river.wet && river.depth <= 1.15;
    return height > 0.35 && (shallowMooseWater || !(river.wet && river.depth > 0.04));
  }

  rememberBehaviour() {
    if (this.resumeBehaviour || this.state === 'alert' || this.state === 'flee') return;
    this.resumeBehaviour = {
      state: this.state,
      timer: Math.max(0.5, this.stateTimer),
      target: this.target.clone(),
      goalType: this.goalType,
      goalArrival: this.goalArrival,
    };
  }

  resumePreviousBehaviour() {
    if (!this.resumeBehaviour) {
      this.pickState();
      return;
    }
    this.state = this.resumeBehaviour.state;
    this.stateTimer = this.resumeBehaviour.timer;
    this.stateDuration = Math.max(this.resumeBehaviour.timer, 0.001);
    this.target.copy(this.resumeBehaviour.target);
    this.goalType = this.resumeBehaviour.goalType;
    this.goalArrival = this.resumeBehaviour.goalArrival;
    this.resumeBehaviour = null;
    this.routeTimer = 0;
  }

  canSeePlayer(playerPosition) {
    const dx = playerPosition.x - this.mesh.position.x;
    const dz = playerPosition.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 5) return true;
    const eyeY = this.mesh.position.y + this.supportLegLength
      + this.recipe.body[1] * 0.85;
    const targetY = playerPosition.y + 1.35;
    for (const t of [0.25, 0.5, 0.75]) {
      const x = this.mesh.position.x + dx * t;
      const z = this.mesh.position.z + dz * t;
      const sightY = eyeY + (targetY - eyeY) * t;
      if (this.world.height(x, z) > sightY - 0.18) return false;
    }
    return true;
  }

  planEscapeTarget(context) {
    if (this.phenotype?.juvenile && context.familyLeader) {
      const leader = context.familyLeader;
      this.target.set(
        leader.mesh.position.x - Math.sin(leader.heading) * 1.8,
        0,
        leader.mesh.position.z - Math.cos(leader.heading) * 1.8,
      );
      this.routeTimer = 0;
      return;
    }
    const danger = this.hasDanger ? this.lastDanger : context.playerPosition;
    let awayX = this.mesh.position.x - danger.x;
    let awayZ = this.mesh.position.z - danger.z;
    const inverse = 1 / Math.max(0.01, Math.hypot(awayX, awayZ));
    awayX *= inverse;
    awayZ *= inverse;
    const cover = this.findContextDestination('cover', context);
    if (cover) {
      const coverX = cover.x - this.mesh.position.x;
      const coverZ = cover.z - this.mesh.position.z;
      const coverLength = Math.max(0.01, Math.hypot(coverX, coverZ));
      // Prefer nearby cover only when it does not send the animal back through
      // the threat. Otherwise retain the simple, robust escape vector.
      const awayAlignment = (coverX / coverLength) * awayX + (coverZ / coverLength) * awayZ;
      if (awayAlignment > 0.10) {
        awayX = awayX * 0.45 + coverX / coverLength * 0.55;
        awayZ = awayZ * 0.45 + coverZ / coverLength * 0.55;
        const mixedInverse = 1 / Math.max(0.01, Math.hypot(awayX, awayZ));
        awayX *= mixedInverse;
        awayZ *= mixedInverse;
      }
    }
    this.target.set(
      this.mesh.position.x + awayX * 32,
      0,
      this.mesh.position.z + awayZ * 32,
    );
    this.routeTimer = 0;
  }

  updateBehaviour(dt, playerPosition, context) {
    this.behaviourElapsed += dt;
    this.behaviourTimer -= dt;
    if (this.behaviourTimer > 0) return;
    const tickDt = Math.min(0.5, this.behaviourElapsed);
    this.behaviourElapsed = 0;
    this.behaviourTimer = 0.17 + this.rng() * 0.08;

    const senses = SPECIES_SENSES[this.recipe.id];
    const dx = playerPosition.x - this.mesh.position.x;
    const dz = playerPosition.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    const playerHeading = Math.atan2(dx, dz);
    const inView = Math.abs(angleDelta(this.heading, playerHeading)) <= senses.fov;
    const visible = this.previewTimer <= 0 && (inView || distance < 4.5) && distance < senses.sight
      && this.canSeePlayer(playerPosition);
    const playerSpeed = context.playerSpeed > 18 ? 0 : context.playerSpeed;
    this.alertness = this.previewTimer > 0 ? 0 : updateAnimalAlertness(this.alertness, {
      dt: tickDt,
      distance,
      sightRange: senses.sight,
      visible,
      inView,
      playerSpeed,
      groupAlarm: context.groupAlarm || 0,
      memory: this.dangerTimer,
      sensitivity: senses.sensitivity * (this.isSentinel ? 1.08 : 1),
    });
    this.alertStage = alertnessStage(this.alertness);
    // A domesticated animal is not wildlife: it watches you walk up to it and
    // stands its ground. The alert stage below escape is deliberately kept, so
    // it still lifts its head and turns to look — what it never does is bolt.
    if (this.recipe.tame && this.alertStage === 'escape') this.alertStage = 'alert';

    // Whether the player is there NOW, as opposed to `hasDanger`, which is a
    // ten-second memory and would hold a glance open long after they had left.
    this.playerInSight = visible && distance < REGARD_SIGHT;
    const perceived = visible || (playerSpeed > 0.2 && distance < 5 + playerSpeed * 4.2);
    if (perceived && this.alertness >= 0.12) {
      this.lastDanger.copy(playerPosition);
      this.hasDanger = true;
      this.dangerTimer = Math.max(this.dangerTimer,
        this.recipe.id === 'fox' ? 14 : 10 + this.rng() * 5);
    } else if (context.groupDanger && context.groupAlarm > 0.20) {
      this.lastDanger.copy(context.groupDanger);
      this.hasDanger = true;
      this.dangerTimer = Math.max(this.dangerTimer, 8);
    }

    if (this.alertStage === 'escape') {
      this.rememberBehaviour();
      if (this.state !== 'flee') {
        this.setState('flee', 4.5);
        this.minimumEscapeTimer = 3.2 + this.rng() * 1.8;
        this.escapeReplanTimer = 0;
      } else {
        this.stateTimer = Math.max(this.stateTimer, 1.0);
      }
      if (this.escapeReplanTimer <= 0) {
        this.planEscapeTarget(context);
        this.escapeReplanTimer = 0.75 + this.rng() * 0.45;
      }
      return;
    }
    if (this.minimumEscapeTimer > 0) {
      this.alertStage = 'escape';
      if (this.state !== 'flee') this.setState('flee', this.minimumEscapeTimer);
      return;
    }
    if (this.alertStage === 'alert') {
      this.rememberBehaviour();
      if (this.state !== 'alert') this.setState('alert', 1.2);
      else this.stateTimer = Math.max(this.stateTimer, 0.65);
      return;
    }
    if (this.alertStage === 'suspicious') {
      this.rememberBehaviour();
      if (this.recipe.id === 'fox' && this.hasDanger && !visible) {
        const stopShort = 6;
        const vx = this.lastDanger.x - this.mesh.position.x;
        const vz = this.lastDanger.z - this.mesh.position.z;
        const length = Math.max(stopShort, Math.hypot(vx, vz));
        this.target.set(
          this.lastDanger.x - vx / length * stopShort,
          0,
          this.lastDanger.z - vz / length * stopShort,
        );
        if (this.state !== 'investigate') this.setState('investigate', 4.5);
      } else if (this.state !== 'recover') {
        this.setState('recover', 2.2 + this.rng() * 1.8);
      }
      return;
    }
    if (this.state === 'alert' || this.state === 'flee'
      || this.state === 'investigate' || this.state === 'recover') {
      if (this.dangerTimer > 0) {
        this.setState('recover', Math.min(3, this.dangerTimer));
      } else {
        this.resumePreviousBehaviour();
      }
    }
    if (this.alertStage === 'calm' && this.phenotype?.juvenile && context.familyLeader
      && this.state !== 'pounce' && this.state !== 'listen') {
      const leader = context.familyLeader;
      const familyDistance = Math.hypot(
        leader.mesh.position.x - this.mesh.position.x,
        leader.mesh.position.z - this.mesh.position.z,
      );
      if (familyDistance > 6.5) {
        this.target.set(leader.mesh.position.x, 0, leader.mesh.position.z);
        if (this.state !== 'follow') this.setState('follow', 2.5);
        this.routeTimer = 0;
      }
    }
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
          { swingWindow: legPose.swingPortion, armOnInitialize: plannedSpeed > 0.02 },
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
      //
      // Widening this to buy a longer forelimb reach was tried and is the wrong
      // lever: it lengthens the stride by letting the hoof land further out, so
      // the limb arrives near full extension and hoof clearance collapses — at
      // 0.84 the horse's stride doubled, its forelimb IK sat at 95% and lift
      // fell to zero. Upper-limb swing belongs to gait.stride, which rotates
      // the limb without asking the foot to reach somewhere it cannot.
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
          swingWindow: legPose.swingPortion,
          stepDuration: strideDuration * (legPose.swingPortion / pose.swingPortion),
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
              && legPose.phase < legPose.swingPortion),
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

  update(dt, playerPosition, visible = true, behaviourContext = null) {
    this.mesh.visible = visible;
    if (!visible) return;
    const context = behaviourContext || {
      playerPosition,
      playerSpeed: 0,
      groupAlarm: 0,
      groupDanger: null,
      familyLeader: null,
      trails: [],
      trailScratch: {},
    };
    const networkPose = context.networkPose || null;
    if (networkPose) {
      this.state = String(networkPose.state || this.state || 'idle');
      this.heading = Number(networkPose.yaw ?? networkPose.heading) || this.heading;
      this.speed = Math.max(0, Number(networkPose.speed) || 0);
      this.alertness = Math.max(0, Math.min(1, Number(networkPose.alertness) || 0));
      this.mesh.position.set(
        Number(networkPose.x) || this.mesh.position.x,
        Number(networkPose.y) || this.mesh.position.y,
        Number(networkPose.z) || this.mesh.position.z,
      );
      this.mesh.rotation.y = this.heading;
    }
    this.age += dt;
    this.stateTimer -= dt;
    this.previewTimer = Math.max(0, this.previewTimer - dt);
    this.dangerTimer = Math.max(0, this.dangerTimer - dt);
    this.minimumEscapeTimer = Math.max(0, this.minimumEscapeTimer - dt);
    this.escapeReplanTimer = Math.max(0, this.escapeReplanTimer - dt);
    this.rareCooldown = Math.max(0, this.rareCooldown - dt);
    this.needs.food = clamp(this.needs.food + dt * 0.0040, 0, 1);
    this.needs.water = clamp(this.needs.water + dt * 0.0022, 0, 1);
    this.needs.cover = clamp(this.needs.cover + dt * 0.0011, 0, 1);
    this.needs.rest = clamp(this.needs.rest + dt * 0.0018, 0, 1);
    if (!networkPose) {
      if (this.rider) this.updateRiddenIntent(dt);
      else this.updateBehaviour(dt, playerPosition, context);
    }

    const movingState = this.state === 'roam' || this.state === 'travel'
      || this.state === 'wade' || this.state === 'investigate' || this.state === 'pounce'
      || this.state === 'follow';
    const targetDistance = Math.hypot(
      this.target.x - this.mesh.position.x,
      this.target.z - this.mesh.position.z,
    );
    if (!networkPose && this.alertStage === 'calm') {
      if (this.state === 'listen' && this.stateTimer <= 0 && this.queuedPounce) {
        this.startFoxPounce();
      } else if (movingState && targetDistance < (this.state === 'pounce' ? 0.8 : 1.5)) {
        if (this.state === 'pounce') {
          this.setState('listen', 0.9 + this.rng() * 0.8);
          this.needs.food = Math.max(0, this.needs.food - 0.18);
        } else {
          this.arriveAtGoal();
        }
      } else if (this.stateTimer <= 0) {
        this.pickState(false, context);
      }
    }

    let desiredSpeed = 0;
    if (this.state === 'roam') desiredSpeed = this.recipe.motion.cruise;
    if (this.state === 'travel') desiredSpeed = this.recipe.motion.cruise * 0.88;
    if (this.state === 'investigate') desiredSpeed = this.recipe.motion.cruise * 0.48;
    if (this.state === 'wade') desiredSpeed = this.recipe.motion.cruise * 0.42;
    if (this.state === 'pounce') desiredSpeed = this.recipe.motion.run * 0.78;
    if (this.state === 'follow') desiredSpeed = this.recipe.motion.cruise * 1.12;
    if (this.state === 'flee') desiredSpeed = this.recipe.motion.run;
    if (Number.isFinite(this.motionPreviewSpeed)) desiredSpeed = this.motionPreviewSpeed;
    const targetHeading = Math.atan2(
      this.target.x - this.mesh.position.x,
      this.target.z - this.mesh.position.z,
    );
    this.lastTurn = damp(this.lastTurn, 0, 5.5, dt);
    if (desiredSpeed > 0 && !networkPose) {
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

    const wantsLocomotion = networkPose ? this.speed > 0.025 : desiredSpeed > 0.025;
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
    if (!networkPose) {
      this.mesh.position.x += Math.sin(this.heading) * this.speed * dt;
      this.mesh.position.z += Math.cos(this.heading) * this.speed * dt;
    }
    // Slope probes are staggered at 8–10Hz. Root height itself is sampled every
    // frame so an uphill animal cannot outrun its torso and overextend/drag all
    // four stance legs before the next terrain probe.
    const liveGroundY = networkPose && Number.isFinite(Number(networkPose.y))
      ? Number(networkPose.y) : this.world.height(this.mesh.position.x, this.mesh.position.z);
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
    const stateProgress = clamp(1 - this.stateTimer / this.stateDuration, 0, 1);
    const pounceHop = this.state === 'pounce'
      ? Math.sin(stateProgress * Math.PI) * this.recipe.body[1] * 1.15
      : 0;
    this.mesh.position.y = damp(
      this.mesh.position.y,
      liveGroundY + pose.rootBob + pounceHop,
      26 + this.speed * 10,
      dt,
    );
    this.mesh.rotation.y = this.heading;
    // Keep the torso's up-axis aligned to world vertical. Each world-planted
    // hoof already samples its own terrain height, so the four IK chains—not a
    // tilted root—absorb the hill beneath the animal.
    this.mesh.rotation.x = damp(this.mesh.rotation.x, 0, 12, dt);
    this.mesh.rotation.z = damp(this.mesh.rotation.z, 0, 12, dt);

    // The host's transform is the final word after local presentation
    // animation has advanced. This removes packet-size-dependent drift while
    // preserving the procedural gait between authoritative updates.
    if (networkPose) {
      this.mesh.position.set(
        Number(networkPose.x) || this.mesh.position.x,
        Number(networkPose.y) || this.mesh.position.y,
        Number(networkPose.z) || this.mesh.position.z,
      );
      this.mesh.rotation.y = this.heading;
    }

    const body = this.rig.byName.body;
    const dynamicLean = springStep(this.lean, clamp(-this.lastTurn * 0.065, -0.14, 0.14), dt, 5.2, 0.95);
    const pouncePitch = this.state === 'pounce' ? Math.sin(stateProgress * Math.PI) * -0.16 : 0;
    body.rotation.x = body.userData.bindRotation.x + pose.bodyPitch + pose.spineFlex + pouncePitch;
    body.rotation.z = body.userData.bindRotation.z + pose.bodyRoll + dynamicLean;
    const locomotionCrouch = this.supportLegLength
      * (pose.locomotion * 0.018 + pose.running * pose.locomotionCrouch);
    body.position.y = body.userData.bindPosition.y + pose.breath * 0.009 - locomotionCrouch;

    const legActivity = this.updateReactiveLegs(dt, pose, speed01, plannedSpeed);
    if (wantsLocomotion && !this.gaitReady
      && (legActivity.startedStep || legActivity.activeSteps > 0)) this.gaitReady = true;
    this.wasLocomoting = wantsLocomotion;

    const selfDirected = this.recipe.id === 'horse';
    if (selfDirected) this.advanceHeadCarriage(dt, plannedSpeed > 0.08);
    const graze = this.state === 'graze' || this.state === 'drink' ? 1
      : this.state === 'browse' ? 0.46 : this.state === 'listen' ? 0.32 : 0;
    const alert = this.state === 'alert' || this.state === 'recover'
      || this.state === 'investigate' || this.state === 'sentinel' || this.state === 'listen'
      ? 1 : 0;
    const look = springStep(this.look, graze, dt, 4.0, 0.92);
    // The behaviour state sets the floor; the animal's own carriage rides on
    // top of it. Damped down while the state is already committed to grazing,
    // so a head that is deliberately on the ground does not also drift.
    const carriage = selfDirected
      ? (this.headMood.carriage + (this.headMood.drift || 0)) * (1 - look * 0.7) : 0;
    const neck = this.rig.byName.neck;
    const neckBase = this.rig.byName.neckBase;
    const head = this.rig.byName.head;
    neckBase.rotation.x = neckBase.userData.bindRotation.x + look * 0.46 - alert * 0.04
      + carriage * 0.40
      + Math.sin(this.age * 0.72 + this.seedPhase) * 0.010;
    neck.rotation.x = neck.userData.bindRotation.x + look * 0.68 - alert * 0.07
      + carriage * 0.62
      + Math.sin(this.age * 0.72 + this.seedPhase) * 0.018;
    head.rotation.x = head.userData.bindRotation.x + look * 0.58
      // The head levels off as the neck drops — a horse reaching down still
      // holds its muzzle to the ground rather than pointing it at its own chest.
      + carriage * 0.46
      + Math.sin(this.age * 1.1 + this.seedPhase) * 0.025 - pose.spineFlex * 0.42;
    // A tame animal looks up in spells and turns barely its head doing it; wild
    // game locks on for as long as it stays alarmed, and cranes round to do it.
    const tame = !!this.recipe.tame;
    const regard = tame
      ? advanceRegard(this.regard, dt, this.playerInSight, this.rng) : 1;
    let dangerLook = 0;
    if (this.hasDanger && (alert || (tame && regard > 0.01))) {
      const dangerHeading = Math.atan2(
        this.lastDanger.x - this.mesh.position.x,
        this.lastDanger.z - this.mesh.position.z,
      );
      const reach = tame ? REGARD_HEAD_TURN : 0.62;
      dangerLook = clamp(angleDelta(this.heading, dangerHeading), -reach, reach) * regard;
    }
    const sentinelScan = this.state === 'sentinel'
      ? Math.sin(this.age * 0.48 + this.seedPhase) * 0.42 : 0;
    head.rotation.y = head.userData.bindRotation.y + dangerLook + sentinelScan
      + (selfDirected ? this.headMood.yaw + (this.headMood.yawDrift || 0) : 0)
      + Math.sin(this.age * 0.43 + this.seedPhase) * (alert ? 0.10 : 0.035);
    head.rotation.z = head.userData.bindRotation.z
      + (this.state === 'listen' ? Math.sin(this.age * 0.72 + this.seedPhase) * 0.18 : 0);

    // Secondary appendages are simulated as world-space ropes. Body, head and
    // turning motion create real inertial lag; the small procedural impulses
    // supply alert/flee expression without reverting to angle clips.
    this.mesh.updateMatrixWorld(true);
    this.animationScratch.right.set(1, 0, 0).applyQuaternion(
      this.mesh.getWorldQuaternion(tmpQ),
    );
    // A horse drives its own tail (see advanceTailSwish); everything else keeps
    // the shared sine. Either way the impulse is only a nudge — the rope still
    // owns gravity and the inertia of the body carrying it, so a tail that is
    // not being swished is still very much in motion.
    const tailDrive = this.recipe.id === 'horse'
      ? this.advanceTailSwish(dt)
      : pose.tailWave * (this.recipe.id === 'fox' ? 4.8 : 2.0);
    this.animationScratch.external.copy(this.animationScratch.right)
      .multiplyScalar(tailDrive);
    const tailAlarmTarget = this.recipe.id === 'whitetail'
      && (this.state === 'flee' || this.alertness > 0.55) ? 1 : 0;
    this.tailAlarm = damp(this.tailAlarm, tailAlarmTarget, tailAlarmTarget ? 7 : 2.2, dt);
    if (this.state === 'flee') this.animationScratch.external.y += 2.0;
    if (this.recipe.id === 'whitetail') this.animationScratch.external.y += this.tailAlarm * 7.5;
    this.tailRope.step(dt, this.animationScratch.external);
    const earImpulse = pose.earFlick * 3.0 + alert * 0.65;
    this.animationScratch.external.copy(this.animationScratch.right).multiplyScalar(-earImpulse);
    this.earLeftRope.step(dt, this.animationScratch.external);
    this.animationScratch.external.copy(this.animationScratch.right).multiplyScalar(earImpulse);
    this.earRightRope.step(dt, this.animationScratch.external);

    updateShapeTexture(this.rig, this.asset.shapes, this.shapeState, this.phenotype);
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
    // Streaming state. `streamed` is the live world population keyed by spawn
    // cell; `pool` recycles idle meshes per species so roaming in and out of
    // range never churns GPU resources; `previews` are debug-staged animals.
    this.streamed = new Map();
    this.pool = new Map();
    this.previews = [];
    this.spawnCounter = 0;
    this.presentationOnly = false;
    // The world seed owns spawn identity. Every client can therefore derive the
    // same cell/family IDs; the host still owns the live behaviour and pose.
    this.sessionSalt = ((world.seed >>> 0) ^ 0x51f15e5d) >>> 0;
    this.surveyTimer = 0;
    this.lastSurveyX = Infinity;
    this.lastSurveyZ = Infinity;
    this.trailEdges = [];
    this.trailRefreshTimer = 0;
    this.lastTrailX = Infinity;
    this.lastTrailZ = Infinity;
    this.trailScratch = {};
    this.playerSample = new THREE.Vector3();
    this.playerSampleReady = false;
    this.playerSpeed = 0;
    this.startupContextDelay = 2;
    this.lastPlayer = new THREE.Vector3();
    this.behaviourContext = {
      playerPosition: this.lastPlayer,
      playerSpeed: 0,
      groupAlarm: 0,
      groupDanger: null,
      familyLeader: null,
      trails: this.trailEdges,
      trailScratch: this.trailScratch,
    };
    this.enabled = true;
    this.shadows = true;
    this.animationScale = 1.55;
    this.debug = {
      enabled: true,
      // User-tuned: 1.55x reads as more alive/confident than real-time gait.
      animationScale: 1.55,
      // Which species inhabit the world. Deer is off by default (still stageable
      // through the preview buttons); fox and moose roam.
      spawnFox: true,
      spawnMoose: true,
      spawnDeer: true,
      spawnHorses: true,
      // Per-cell spawn probability. User-tuned via the debug slider to 0.52 —
      // noticeably more present than the original ~6x-rarer estimate.
      spawnChance: 0.52,
      status: 'waiting for terrain',
    };

    for (const recipe of Object.values(ANIMAL_RECIPES)) {
      const model = buildAnimalModel(recipe);
      this.assets.set(recipe.id, { recipe, ...model });
    }
  }

  // Species allowed to inhabit the world right now (debug toggles; deer off by
  // default). Preview staging ignores this — it can show any species.
  activeSpecies() {
    const list = [];
    if (this.debug.spawnFox) list.push('fox');
    if (this.debug.spawnDeer) list.push('whitetail');
    if (this.debug.spawnMoose) list.push('moose');
    if (this.debug.spawnHorses) list.push('horse');
    return list;
  }

  liveAgents() {
    const out = [];
    for (const entry of this.streamed.values()) out.push(entry.agent);
    for (const preview of this.previews) out.push(preview.agent);
    return out;
  }

  // Pull an idle mesh for `species` from the pool, or build one. Reuse keeps
  // streaming in and out of range free of material/texture allocation churn.
  acquireAgent(species) {
    const idle = this.pool.get(species);
    let agent = idle && idle.length ? idle.pop() : null;
    if (!agent) {
      const seed = (this.world.seed ^ this.sessionSalt
        ^ Math.imul(this.spawnCounter++, 2654435761)) >>> 0;
      agent = new AnimalAgent(this.assets.get(species), this.world, seed);
    }
    agent.mesh.castShadow = this.shadows;
    this.group.add(agent.mesh);
    return agent;
  }

  releaseAgent(agent, species) {
    this.group.remove(agent.mesh);
    agent.groupId = null;
    agent.isSentinel = false;
    let idle = this.pool.get(species);
    if (!idle) this.pool.set(species, idle = []);
    idle.push(agent);
  }

  // Does spawn cell (cx,cz) host an animal this session? Deterministic per
  // (salt, cell) so a sighting stays put and reappears if revisited, yet the
  // salt reshuffles every run. Returns the resolved site or null.
  /**
   * Move a horse onto ground its village leaves open, or refuse it.
   *
   * Planning a settlement is not free, but this is only reached for a cell that
   * has already drawn a horse next to a settlement — a handful of cells in the
   * streamed radius — and station villages are planned at world generation, so
   * the usual case is a cache hit.
   */
  horseStanding(site, x, z, roll) {
    if (!site) return null;
    try {
      const plan = cachedSettlementPlan(this.world, site);
      if (!plan?.buildings?.length) return { x, z, plan: null };
      const spot = resolveHorseGround(plan, site, x, z, roll);
      // The plan travels with the spot so the rest of the family can be kept
      // out of the houses too, without planning the village a second time.
      return spot ? { ...spot, plan } : null;
    } catch (error) {
      // A settlement that cannot be planned is not a reason to lose the horse,
      // but it IS a reason not to trust the point, so stand it well outside.
      const bearing = Math.atan2(z - site.z, x - site.x);
      const radius = site.radius + OUTSIDE_MARGIN;
      return { x: site.x + Math.cos(bearing) * radius, z: site.z + Math.sin(bearing) * radius };
    }
  }

  cellSpawn(cx, cz, species) {
    const rng = mulberry32((this.sessionSalt
      ^ Math.imul(cx | 0, 0x9e3779b9) ^ Math.imul(cz | 0, 0x85ebca6b)) >>> 0);
    if (rng() >= this.debug.spawnChance) return null;
    let pick = species[Math.min(species.length - 1, Math.floor(rng() * species.length))];
    const x = (cx + rng()) * ANIMAL_SPAWN_CELL;
    const z = (cz + rng()) * ANIMAL_SPAWN_CELL;
    const heading = rng() * TAU;
    const biome = this.world.biomeAt(x, z);
    if (biome.h <= 0.5 || biome.slope > 0.55) return null;
    const river = this.world.riverAt(x, z);
    if (river.wet && river.depth > 0.04) return null;

    // A horse is not wildlife. It belongs to a settlement, and near one it is
    // the animal you expect to see — so on village ground the draw is weighted
    // hard toward horses instead of leaving them to a one-in-four lottery that
    // usually came up empty. It thins the deer and moose there at the same
    // time, which is right: game does not graze the common outside a village.
    //
    // The habitat test comes BEFORE the override, not after. Overriding first
    // and testing later meant a village cell in ground no horse lives in
    // produced nothing at all: the horse failed its habitat check and the deer
    // that would otherwise have stood there had already been displaced.
    const horseHome = species.includes('horse')
      && this.assets.get('horse').recipe.habitats.includes(biome.id)
      ? horseSettlementFor(this.world, x, z) : null;
    const horseFits = !!horseHome;
    if (horseFits && rng() < 0.92) pick = 'horse';
    // And away from a settlement there are none at all.
    if (pick === 'horse' && !horseFits) return null;

    let sx = x, sz = z;
    let homePlan = null;
    if (pick === 'horse') {
      // A random point in the halo lands on a house as readily as beside one,
      // so the horse is moved onto ground the village actually leaves open —
      // the square, or the common past the last building.
      const spot = this.horseStanding(horseHome, x, z, rng());
      if (!spot) return null;
      sx = spot.x;
      sz = spot.z;
      homePlan = spot.plan || null;
      // The ground it was moved TO has to be as good as the ground first
      // tested: relocating across a river bank or onto a cliff would trade one
      // bad spawn for another.
      const moved = this.world.biomeAt(sx, sz);
      if (moved.h <= 0.5 || moved.slope > 0.55) return null;
      const movedRiver = this.world.riverAt(sx, sz);
      if (movedRiver.wet && movedRiver.depth > 0.04) return null;
      if (!this.assets.get('horse').recipe.habitats.includes(moved.id)) return null;
    }

    // Species only appear in their own habitats, which also thins density.
    if (!this.assets.get(pick).recipe.habitats.includes(biome.id)) return null;
    const family = createAnimalFamily(pick, rng);
    return {
      cellX: cx,
      cellZ: cz,
      sharedId: sharedAnimalId(this.world.seed, cx, cz, 0),
      x: sx,
      z: sz,
      species: pick,
      heading,
      family,
      homePlan,
      herdPhase: rng() * TAU,
    };
  }

  // Reconcile the live population with the cells currently in range: retire
  // animals that fell out of range, spawn newly-visible ones. Cheap enough to
  // run a couple of times a second rather than every frame.
  survey(px, pz, { interestPositions = [] } = {}) {
    const species = this.activeSpecies();
    const radius = ANIMAL_STREAM_RADIUS;
    const radius2 = radius * radius;
    const despawn2 = (radius * 1.35) * (radius * 1.35);
    const desired = new Map();
    const points = [{ x: px, z: pz }, ...(Array.isArray(interestPositions) ? interestPositions : [])]
      .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.z)));
    if (species.length) {
      for (const point of points) {
        const c0 = Math.floor((point.x - radius) / ANIMAL_SPAWN_CELL);
        const c1 = Math.floor((point.x + radius) / ANIMAL_SPAWN_CELL);
        const r0 = Math.floor((point.z - radius) / ANIMAL_SPAWN_CELL);
        const r1 = Math.floor((point.z + radius) / ANIMAL_SPAWN_CELL);
        for (let cz = r0; cz <= r1; cz++) {
          for (let cx = c0; cx <= c1; cx++) {
            const site = this.cellSpawn(cx, cz, species);
            if (!site) continue;
            const dx = site.x - point.x, dz = site.z - point.z;
            if (dx * dx + dz * dz > radius2) continue;
            // The same cell can be in two players' halos. One shared ID keeps
            // it a single animal instead of spawning a copy for each visitor.
            const groupId = site.family.members.length > 1
              ? `${site.species}_${cx}_${cz}` : null;
            for (let member = 0; member < site.family.members.length; member++) {
              const phenotype = site.family.members[member];
              const baseAngle = site.herdPhase + member * 2.35;
              const baseRadius = member === 0 ? 0
                : phenotype.juvenile ? 2.8 + member * 1.3 : 4.5 + member * 2.2;
              const memberSite = {
                ...site,
                x: site.x,
                z: site.z,
                heading: site.heading + (member - 1) * 0.18,
                groupId,
                member,
                phenotype,
                familyKind: site.family.kind,
              };
              let validMember = member === 0;
              for (let attempt = 0; attempt < (member === 0 ? 1 : 5); attempt++) {
                const angle = baseAngle + attempt * 0.83;
                const radius = baseRadius * (1 - attempt * 0.14);
                memberSite.x = site.x + Math.sin(angle) * radius;
                memberSite.z = site.z + Math.cos(angle) * radius;
                const memberBiome = this.world.biomeAt(memberSite.x, memberSite.z);
                const memberRiver = this.world.riverAt(memberSite.x, memberSite.z);
                validMember = memberBiome.h > 0.5 && memberBiome.slope <= 0.55
                  && !(memberRiver.wet && memberRiver.depth > 0.04)
                  // Siting the group's centre clear of the houses is not enough:
                  // the rest of the family is offset from it by up to a dozen
                  // metres, which is far enough to put a mare through a wall.
                  && (!site.homePlan
                    || groundIsClear(site.homePlan, memberSite.x, memberSite.z));
                if (validMember) break;
              }
              if (!validMember) continue;
              memberSite.sharedId = sharedAnimalId(this.world.seed, cx, cz, member);
              desired.set(memberSite.sharedId, memberSite);
            }
          }
        }
      }
    }
    // Retire animals whose cell is gone or which drifted well out of range.
    for (const [key, entry] of this.streamed) {
      const nearAny = points.some((point) => {
        const dx = entry.agent.mesh.position.x - point.x, dz = entry.agent.mesh.position.z - point.z;
        return dx * dx + dz * dz <= despawn2;
      });
      if (!desired.has(key) || !nearAny) {
        this.releaseAgent(entry.agent, entry.species);
        this.streamed.delete(key);
      }
    }
    // Bring newly-visible cells to life, respecting the safety cap.
    const desiredFamilySizes = new Map();
    for (const site of desired.values()) {
      if (site.groupId) desiredFamilySizes.set(
        site.groupId, (desiredFamilySizes.get(site.groupId) || 0) + 1,
      );
    }
    const liveFamilySizes = new Map();
    for (const entry of this.streamed.values()) {
      if (entry.groupId) liveFamilySizes.set(
        entry.groupId, (liveFamilySizes.get(entry.groupId) || 0) + 1,
      );
    }
    const deferredFamilies = new Set();
    for (const [key, site] of desired) {
      if (this.streamed.has(key) || this.streamed.size >= ANIMAL_MAX_ACTIVE
        || deferredFamilies.has(site.groupId)) continue;
      if (site.groupId && !liveFamilySizes.has(site.groupId)) {
        const familySize = desiredFamilySizes.get(site.groupId) || 1;
        if (familySize > ANIMAL_MAX_ACTIVE - this.streamed.size) {
          deferredFamilies.add(site.groupId);
          continue;
        }
      }
      const agent = this.acquireAgent(site.species);
      agent.heading = site.heading;
      agent.place(site.x, site.z);
      agent.configurePhenotype(site.phenotype);
      agent.groupId = site.groupId;
      agent.isSentinel = site.species === 'whitetail' && site.member === 0;
      this.streamed.set(key, {
        agent,
        id: site.sharedId || sharedAnimalId(this.world.seed, site.cellX, site.cellZ, site.member),
        cellX: site.cellX,
        cellZ: site.cellZ,
        species: site.species,
        groupId: site.groupId,
        member: site.member,
        familyKind: site.familyKind,
      });
      if (site.groupId) liveFamilySizes.set(
        site.groupId, (liveFamilySizes.get(site.groupId) || 0) + 1,
      );
    }
    if (!species.length) {
      this.debug.status = 'no species enabled';
    } else if (!this.streamed.size) {
      this.debug.status = `0 nearby · ${species.join(' / ')}`;
    } else {
      const roles = new Map();
      for (const entry of this.streamed.values()) {
        const phenotype = entry.agent.phenotype;
        const label = phenotype?.morph && phenotype.morph !== 'normal'
          ? `${phenotype.morph} ${phenotype.role}` : phenotype?.role || entry.species;
        roles.set(label, (roles.get(label) || 0) + 1);
      }
      const roleLabel = Array.from(roles, ([role, count]) => count > 1 ? `${role} ×${count}` : role)
        .join(' + ');
      this.debug.status = `${this.streamed.size} nearby · ${roleLabel}`;
    }
  }

  // Re-roll the session salt and rebuild — a fresh random scattering. Wired to
  // the debug "resurvey" button for auditioning placements.
  resurvey(playerPosition) {
    this.sessionSalt = (Math.random() * 0x100000000) >>> 0;
    for (const entry of this.streamed.values()) this.releaseAgent(entry.agent, entry.species);
    this.streamed.clear();
    this.surveyTimer = 0;
    const p = playerPosition || this.lastPlayer;
    if (p) this.survey(p.x, p.z);
  }

  resetRegion(world = this.world) {
    this.world = world;
    for (const entry of this.streamed.values()) this.releaseAgent(entry.agent, entry.species);
    this.streamed.clear();
    for (const preview of this.previews) this.releaseAgent(preview.agent, preview.species);
    this.previews.length = 0;
    for (const agent of this._sheetAgents || []) this.releaseAgent(agent, agent.recipe.id);
    this._sheetAgents = null;
    this.sessionSalt = ((world.seed >>> 0) ^ 0x51f15e5d) >>> 0;
    this.presentationOnly = false;
    this.surveyTimer = 0;
    this.lastSurveyX = Infinity;
    this.lastSurveyZ = Infinity;
    this.trailEdges.length = 0;
    this.trailRefreshTimer = 0;
    this.lastTrailX = Infinity;
    this.lastTrailZ = Infinity;
    this.playerSampleReady = false;
    this.startupContextDelay = 2;
    this.debug.status = 'waiting for terrain';
    return this.world.seed;
  }

  setQuality(tier) {
    this.shadows = (tier?.shadowSize || 0) > 0;
    for (const agent of this.liveAgents()) agent.mesh.castShadow = this.shadows;
    for (const idle of this.pool.values()) for (const agent of idle) agent.mesh.castShadow = this.shadows;
  }

  /** Public wildlife poses emitted by the host each simulation tick. */
  sharedStateSnapshot() {
    const result = {};
    for (const entry of this.streamed.values()) {
      const agent = entry.agent;
      result[entry.id || entry.key || sharedAnimalId(this.world.seed, entry.cellX, entry.cellZ, entry.member)] = {
        id: entry.id || sharedAnimalId(this.world.seed, entry.cellX, entry.cellZ, entry.member),
        species: entry.species,
        pose: {
          x: agent.mesh.position.x,
          y: agent.mesh.position.y,
          z: agent.mesh.position.z,
          yaw: agent.heading,
        },
        state: agent.state,
        speed: agent.speed,
        alertness: agent.alertness,
        groupId: entry.groupId || null,
        member: entry.member || 0,
        phenotype: agent.phenotype,
      };
    }
    return result;
  }

  /**
   * Replace local wildlife decisions with the host's public animal read model.
   * Meshes are still created locally, but spawn identity, species, phenotype,
   * position, and reactions all come from the packet.
   */
  applySharedState(shared = null) {
    const animals = shared?.animals || {};
    this.presentationOnly = true;
    const desired = new Set(Object.keys(animals));
    for (const [id, entry] of [...this.streamed]) {
      if (desired.has(id)) continue;
      this.releaseAgent(entry.agent, entry.species);
      this.streamed.delete(id);
    }
    for (const [id, remote] of Object.entries(animals)) {
      if (!this.assets.has(remote.species)) continue;
      let entry = this.streamed.get(id);
      if (!entry || entry.species !== remote.species) {
        if (entry) this.releaseAgent(entry.agent, entry.species);
        const agent = this.acquireAgent(remote.species);
        if (!agent) continue;
        agent.configurePhenotype(remote.phenotype || showcaseAnimalPhenotype(remote.species));
        entry = {
          agent, id, cellX: 0, cellZ: 0, species: remote.species,
          groupId: remote.groupId || null, member: remote.member || 0,
          familyKind: null,
        };
        this.streamed.set(id, entry);
      }
      entry.remotePose = remote.pose ? { ...remote.pose, state: remote.state, speed: remote.speed, alertness: remote.alertness } : null;
      entry.groupId = remote.groupId || null;
      entry.member = remote.member || 0;
    }
    return this.presentationOnly;
  }

  // Debug staging: drop a single animal in front of the player for a few
  // seconds. Works for any species, spawn toggles notwithstanding.
  /**
   * Rebuild one species' model from an edited recipe, in place.
   *
   * For the lab's edit mode: anatomy is authored as data, so tuning it live is
   * a matter of rebuilding the model rather than of animating anything. Every
   * agent of that species is holding geometry that no longer describes it, so
   * they are disposed and left to be recreated from the new asset.
   *
   * Deliberately not a general runtime facility — the world builds its models
   * once at startup and never changes them.
   */
  rebuildSpecies(id, recipe) {
    const previous = this.assets.get(id);
    if (!previous) return null;
    const model = buildAnimalModel(recipe);
    for (const agent of this.liveAgents()) {
      if (agent.recipe.id !== id) continue;
      this.group.remove(agent.mesh);
      agent.dispose();
    }
    for (const [species, idle] of this.pool) {
      if (species !== id) continue;
      for (const agent of idle) agent.dispose();
      this.pool.set(species, []);
    }
    for (const agent of this._sheetAgents || []) {
      if (agent.recipe.id === id) this.group.remove(agent.mesh);
    }
    this._sheetAgents = null;
    this.previews.length = 0;
    previous.geometry.dispose();
    previous.neighbourState?.texture?.dispose();
    this.assets.set(id, { recipe, ...model });
    return this.assets.get(id);
  }

  /**
   * Stand one showcase animal of every species on the spot, for the model sheet.
   *
   * The lab calls this and then reads `agents`, and NEITHER existed on this
   * class — the lab was written against an older shape of it. The first call
   * threw, which aborted the lab's module before it drew anything, which is why
   * the sheet has been a blank stage for every species and nobody had looked at
   * a model in it.
   *
   * These are deliberately not previews. A preview expires on a timer and
   * vanishes mid-inspection, which is the last thing you want while measuring a
   * head against a reference.
   */
  populateNear(position = { x: 0, z: 0 }) {
    if (this._sheetAgents) return this._sheetAgents;
    this._sheetAgents = [];
    for (const species of this.assets.keys()) {
      const agent = this.acquireAgent(species);
      if (!agent) continue;
      // All on the same mark: the lab shows one at a time and frames the camera
      // on whichever is selected, so spreading them out only moves the subject.
      agent.place(position.x || 0, position.z || 0);
      agent.heading = 0;
      agent.configurePhenotype(showcaseAnimalPhenotype(species));
      agent.state = 'idle';
      agent.stateTimer = Infinity;
      agent.previewTimer = Infinity;
      this._sheetAgents.push(agent);
    }
    return this._sheetAgents;
  }

  get agents() {
    return this._sheetAgents || this.populateNear();
  }

  stagePreview(species, x, z, faceX, faceZ, hold) {
    const asset = this.assets.get(species);
    if (!asset) return null;
    const agent = this.acquireAgent(species);
    agent.heading = Math.atan2(faceX - x, faceZ - z);
    agent.place(x, z);
    agent.configurePhenotype(showcaseAnimalPhenotype(species));
    agent.state = 'alert';
    agent.stateTimer = hold;
    agent.previewTimer = hold;
    this.previews.push({ agent, species });
    return agent;
  }

  preview(species, playerPosition, playerYaw = 0) {
    const forwardX = -Math.sin(playerYaw), forwardZ = -Math.cos(playerYaw);
    const sideX = -forwardZ, sideZ = forwardX;
    const x = playerPosition.x + forwardX * 10 + sideX * 2.8;
    const z = playerPosition.z + forwardZ * 10 + sideZ * 2.8;
    return this.stagePreview(species, x, z, playerPosition.x, playerPosition.z, 6);
  }

  previewAll(playerPosition, playerYaw = 0) {
    const forwardX = -Math.sin(playerYaw), forwardZ = -Math.cos(playerYaw);
    const sideX = -forwardZ, sideZ = forwardX;
    const order = ['fox', 'whitetail', 'moose'];
    const staged = [];
    for (let i = 0; i < order.length; i++) {
      const lateral = (i - 1) * 4.5;
      const distance = 10.5 + Math.abs(i - 1) * 1.8;
      const x = playerPosition.x + forwardX * distance + sideX * lateral;
      const z = playerPosition.z + forwardZ * distance + sideZ * lateral;
      const agent = this.stagePreview(order[i], x, z, playerPosition.x, playerPosition.z, 7);
      if (agent) staged.push(agent);
    }
    this.debug.status = 'SDF showcase · fox / white-tail / moose';
    return staged;
  }

  update(dt, playerPosition, caveFactor = 0, worldReady = true, { interestPositions = [] } = {}) {
    this.enabled = this.debug.enabled;
    this.animationScale = this.debug.animationScale;
    this.group.visible = this.enabled && worldReady && caveFactor < 0.52;
    // Terrain assembly owns startup. Wildlife is invisible behind the loading
    // gate and must not spend that critical window surveying spawn cells,
    // querying trails, or running SDF animation. Give contextual trail work a
    // short grace period after readiness as well, so clicking into the world
    // cannot coincide with a cold trail-network query.
    if (!this.enabled || !worldReady) {
      if (!worldReady) this.startupContextDelay = 2;
      return;
    }
    if (this.presentationOnly) {
      const visible = caveFactor < 0.52;
      const step = dt * this.animationScale;
      const context = { ...this.behaviourContext, networkPose: null };
      for (const entry of this.streamed.values()) {
        context.networkPose = entry.remotePose;
        entry.agent.update(step, playerPosition, visible, context);
        if (entry.remotePose) {
          entry.agent.mesh.position.set(
            Number(entry.remotePose.x) || entry.agent.mesh.position.x,
            Number(entry.remotePose.y) || entry.agent.mesh.position.y,
            Number(entry.remotePose.z) || entry.agent.mesh.position.z,
          );
          entry.agent.mesh.rotation.y = Number(entry.remotePose.yaw ?? entry.agent.heading) || 0;
        }
      }
      return;
    }
    this.startupContextDelay = Math.max(0, this.startupContextDelay - dt);
    if (this.playerSampleReady && dt > 1e-4) {
      const rawPlayerSpeed = this.playerSample.distanceTo(playerPosition) / dt;
      // Location/debug jumps are silent discontinuities, not kilometre-loud
      // footsteps. Ordinary walking and sprinting remain distinguishable.
      const measured = rawPlayerSpeed > 18 ? 0 : rawPlayerSpeed;
      this.playerSpeed = damp(this.playerSpeed, measured, 7, dt);
    } else {
      this.playerSampleReady = true;
      this.playerSpeed = 0;
    }
    this.playerSample.copy(playerPosition);
    this.lastPlayer.copy(playerPosition);

    // Re-survey on a timer or after the player crosses a fraction of a cell —
    // not every frame, since the cell scan samples the world field.
    this.surveyTimer -= dt;
    const movedX = playerPosition.x - this.lastSurveyX;
    const movedZ = playerPosition.z - this.lastSurveyZ;
    if (this.surveyTimer <= 0
      || movedX * movedX + movedZ * movedZ > (ANIMAL_SPAWN_CELL * 0.4) ** 2) {
      this.survey(playerPosition.x, playerPosition.z, { interestPositions });
      this.surveyTimer = 0.5;
      this.lastSurveyX = playerPosition.x;
      this.lastSurveyZ = playerPosition.z;
    }

    // A single trail query is shared by every animal and refreshed only after
    // substantial travel. Context planning can therefore use actual paths
    // without regenerating the trail network from each agent's update.
    this.trailRefreshTimer -= dt;
    const trailDx = playerPosition.x - this.lastTrailX;
    const trailDz = playerPosition.z - this.lastTrailZ;
    if (this.startupContextDelay <= 0 && this.streamed.size > 0 && this.trailRefreshTimer <= 0
      && (trailDx * trailDx + trailDz * trailDz > 90 * 90 || !this.trailEdges.length)) {
      trailsAround(
        this.world, playerPosition.x, playerPosition.z,
        this.world.seed, ANIMAL_CONTEXT_RADIUS, this.trailEdges,
      );
      this.trailRefreshTimer = 16;
      this.lastTrailX = playerPosition.x;
      this.lastTrailZ = playerPosition.z;
    }

    const familyGroups = new Map();
    for (const entry of this.streamed.values()) {
      if (!entry.groupId) continue;
      let group = familyGroups.get(entry.groupId);
      if (!group) {
        group = { alarm: 0, danger: null, leader: null };
        familyGroups.set(entry.groupId, group);
      }
      if (entry.member === 0) group.leader = entry.agent;
      if (entry.agent.alertness > group.alarm) {
        group.alarm = entry.agent.alertness;
        group.danger = entry.agent.hasDanger ? entry.agent.lastDanger : group.danger;
      }
    }

    const visible = caveFactor < 0.52;
    const step = dt * this.animationScale;
    const observers = [{ position: playerPosition, speed: this.playerSpeed },
      ...(Array.isArray(interestPositions) ? interestPositions : [])
        .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.z)))
        .map((point) => ({ position: point, speed: point.moving ? 1 : 0 }))];
    for (const entry of this.streamed.values()) {
      const observer = observers.reduce((best, candidate) => {
        const d = Math.hypot(entry.agent.mesh.position.x - candidate.position.x,
          entry.agent.mesh.position.z - candidate.position.z);
        return !best || d < best.distance ? { candidate, distance: d } : best;
      }, null)?.candidate || observers[0];
      this.behaviourContext.playerPosition = observer.position;
      this.behaviourContext.playerSpeed = observer.speed;
      const group = entry.groupId ? familyGroups.get(entry.groupId) : null;
      this.behaviourContext.groupAlarm = group?.alarm || 0;
      this.behaviourContext.groupDanger = group?.danger || null;
      this.behaviourContext.familyLeader = group?.leader === entry.agent ? null : group?.leader || null;
      entry.agent.update(step, playerPosition, visible, this.behaviourContext);
    }
    // Preview animals live independently of streaming until their hold expires.
    for (let i = this.previews.length - 1; i >= 0; i--) {
      const preview = this.previews[i];
      this.behaviourContext.groupAlarm = 0;
      this.behaviourContext.groupDanger = null;
      this.behaviourContext.familyLeader = null;
      preview.agent.update(step, playerPosition, visible, this.behaviourContext);
      if (preview.agent.previewTimer <= 0) {
        this.releaseAgent(preview.agent, preview.species);
        this.previews.splice(i, 1);
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const agent of this.liveAgents()) agent.dispose();
    for (const idle of this.pool.values()) for (const agent of idle) agent.dispose();
    for (const asset of this.assets.values()) {
      asset.geometry.dispose();
      asset.neighbourState.texture.dispose();
    }
  }
}
