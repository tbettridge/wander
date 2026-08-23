// The stones of a tower site.
//
// One builder lays every wall on the site, from the lone drum on a hilltop to a
// keep's curtain, because they are the same building at different scales. It
// consumes the semantic plan's piece list and nothing else — collision and
// walkable surfaces never look at a triangle, and this never invents a piece the
// plan did not author.
//
// Everything is built in the site's LOCAL frame; the stream positions and yaws
// the group. `ground(localX, localZ)` is the yaw-aware terrain height relative
// to the site origin, so masonry seats against the hillside it stands on.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { landmarkMaterial } from './landmarkmesh.js';
import { ni, stoneBox, ageStone, paint, seat } from './stonecraft.js';
import { mulberry32 } from './noise.js';
import {
  siteQuarry, courseDrum, courseWall, archOpening, flagstones, stoneSteps,
} from './keepmasonry.js';
import { fortifiedOutpostRenderRecipes, donjonRimCourses } from './fortifiedoutpost.mjs';

// Beyond this the individual stones stop resolving, so we stop cutting them.
// The far build keeps the same runs, the same break profile and the same quarry
// colour — only the block size changes, so a keep does not visibly pop.
export const OUTPOST_DETAIL_RANGE = 500;

// A pathological seed must not be able to spend a frame's whole budget on one
// hillside. Walls are laid outermost-first, so a truncated site loses interior
// detail rather than its silhouette.
const MAX_STONES = 2400;

function buildTower(tower, quarry, rng, ground, detail) {
  const parts = courseDrum({
    quarry, rng, x: tower.x, z: tower.z,
    radius: tower.radius, courses: tower.courses, courseHeight: tower.courseHeight,
    rim: (angle) => donjonRimCourses(tower, angle),
    doorAngle: tower.doorwayAngle ?? null, doorCourses: tower.doorCourses || 0,
    slitAngle: tower.role === 'donjon' ? tower.tallAngle : null,
    detail,
  });
  if (!parts.length) return [];
  // Seated as one rigid stack: a drum whose courses each found their own ground
  // would shear apart on a slope.
  const drum = mergeGeometries(parts.map(ni));
  for (const part of parts) part.dispose();
  seat(drum, ground, 0.6, tower.radius + 0.3);
  return [drum];
}

function buildCurtainRun(piece, plan, quarry, rng, ground, detail) {
  const style = plan.intact.style;
  // The gate needs no opening cut here: the plan already stops the two gate-side
  // runs short of it, so the gap is in the wall's own endpoints. Cutting again
  // from the gate's centre widened it by another gate's worth.
  // Parapet and wall are laid in one pass so the crenellations sit on the crest
  // the wall actually reached, which on sloping ground is not a level line.
  const parapetSurvives = plan.survivingPieces.some((item) => item.id === `${piece.id}:parapet`);
  return courseWall({
    quarry, rng, ax: piece.ax, az: piece.az, bx: piece.bx, bz: piece.bz,
    height: piece.height + (parapetSurvives ? style.wallHeight * 0.14 + 0.62 : 0),
    thickness: piece.thickness, ground,
    merlonTop: parapetSurvives, detail,
  });
}

function buildRubble(piece, quarry, rng, ground) {
  const block = stoneBox(piece.width, piece.height, piece.depth, rng, 1, 0.22);
  block.rotateY(piece.yaw || 0);
  block.translate(piece.x, piece.height * 0.5, piece.z);
  // Buried deeper than half its own height, and sampled over a wide enough ring
  // to find the low corner. A fallen block resting exactly on the height field
  // hangs in the air wherever the rendered mesh dips below it, which on a slope
  // is everywhere.
  if (ground) seat(block, ground, piece.height * 0.5 + 0.2, Math.max(1.2, piece.width));
  return [ageStone(paint(block, quarry.color.clone()
    .offsetHSL(0, 0, (rng() - 0.5) * 0.1), rng, 0.1))];
}

function buildUndercroft(piece, quarry, rng, ground, sealed) {
  const parts = [];
  const sill = ground(piece.x, piece.z) - piece.sillDrop;
  // A retaining wall holding the bank back either side of the door, so the
  // opening reads as cut into the hill rather than resting on it.
  const c = Math.cos(piece.yaw), s = Math.sin(piece.yaw);
  const half = piece.width / 2 + 2.6;
  parts.push(...courseWall({
    quarry, rng,
    ax: piece.x - half * c, az: piece.z + half * s,
    bx: piece.x + half * c, bz: piece.z - half * s,
    height: piece.height + 1.1, thickness: 0.8, baseY: sill,
    crest: () => sill + piece.height + 1.1,
    openings: [{ t: 0.5, halfWidth: piece.width / 2 + 0.1, height: piece.height + 1.1 }],
  }));
  parts.push(...archOpening({
    quarry, rng, x: piece.x, z: piece.z, yaw: piece.yaw,
    width: piece.width, height: piece.height, thickness: 0.8, baseY: sill,
  }));
  // Steps down from the bailey to the sill: the visible invitation.
  parts.push(...stoneSteps({
    quarry, rng,
    ax: piece.stepAx, az: piece.stepAz, ay: ground(piece.stepAx, piece.stepAz) - 0.1,
    bx: piece.x - c * 0.6, bz: piece.z + s * 0.6, by: sill,
    width: piece.width + 0.5, steps: 7,
  }));
  // Where the hill behind the door will not hold a passage, the passage fell in
  // long ago. An arch choked with its own vault is a better answer than a door
  // standing open onto solid ground.
  if (sealed) {
    for (let index = 0; index < 9; index++) {
      const along = (rng() - 0.5) * piece.width * 0.9;
      const size = 0.45 + rng() * 0.55;
      const fall = stoneBox(size * 1.5, size, size * 1.2, rng, 1, 0.24);
      fall.rotateY(piece.yaw + (rng() - 0.5) * 1.2);
      fall.rotateZ((rng() - 0.5) * 0.5);
      fall.translate(
        piece.x + along * c + (rng() - 0.3) * 0.8 * s,
        sill + size * 0.45 + index * 0.22,
        piece.z - along * s + (rng() - 0.3) * 0.8 * c,
      );
      parts.push(ageStone(paint(fall, quarry.color.clone()
        .offsetHSL(0, 0, (rng() - 0.5) * 0.12), rng, 0.1)));
    }
  }
  return parts;
}

/** Build one batched stone mesh with the semantic piece IDs retained. */
export function buildFortifiedOutpostVisual(plan, {
  material = landmarkMaterial, ground = () => 0, detail = 'full',
  undercroftSealed = false, name = `${plan?.id || 'outpost'}:visual`,
} = {}) {
  if (!plan?.id) throw new TypeError('A fortified outpost plan is required.');
  const group = new THREE.Group();
  group.name = name;
  const quarry = siteQuarry(plan.intact.donjon.jagSeed ^ plan.seed);
  const rng = mulberry32((plan.seed >>> 0) ^ 0x4d41_534e);

  // Outermost first, so a stone budget spent early still leaves the silhouette.
  const order = { 'curtain-wall': 0, tower: 1, gate: 2, undercroft: 3, 'room-wall': 4 };
  const pieces = [...fortifiedOutpostRenderRecipes(plan)]
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  const parts = [];
  let truncated = false;
  for (const piece of pieces) {
    if (parts.length >= MAX_STONES) { truncated = true; break; }
    let built = null;
    if (piece.kind === 'tower') built = buildTower(piece, quarry, rng, ground, detail);
    else if (piece.kind === 'curtain-wall') built = buildCurtainRun(piece, plan, quarry, rng, ground, detail);
    else if (piece.kind === 'room-wall') {
      built = courseWall({
        quarry, rng, ax: piece.ax, az: piece.az, bx: piece.bx, bz: piece.bz,
        height: piece.height, thickness: piece.thickness, ground, detail,
      });
    } else if (piece.kind === 'gate') {
      built = archOpening({
        quarry, rng, x: piece.x, z: piece.z, yaw: piece.yaw,
        width: piece.width, height: piece.height, thickness: piece.thickness,
        baseY: ground(piece.x, piece.z) - 0.3,
      });
    } else if (piece.kind === 'lintel') {
      const lintel = stoneBox(piece.width, piece.height, piece.depth, rng, 2, 0.05);
      lintel.translate(piece.x, ground(piece.x, piece.z) + piece.y + piece.height / 2, piece.z);
      built = [ageStone(paint(lintel, quarry.color.clone(), rng, 0.05))];
    } else if (piece.kind === 'undercroft') built = buildUndercroft(piece, quarry, rng, ground);
    else if (piece.kind === 'stair') {
      built = stoneSteps({
        quarry, rng,
        ax: piece.ax, az: piece.az, ay: ground(piece.ax, piece.az) + piece.ay,
        bx: piece.bx, bz: piece.bz, by: ground(piece.ax, piece.az) + piece.by,
        width: piece.width, steps: piece.steps,
      });
    } else if (piece.kind === 'floor' || piece.kind === 'landing') {
      built = flagstones({
        quarry, rng, x: piece.x, z: piece.z,
        width: piece.width, depth: piece.depth,
        y: piece.kind === 'landing'
          ? ground(piece.x, piece.z) + piece.y : ground(piece.x, piece.z) + 0.02,
      });
    } else if (piece.kind === 'large-rubble' || piece.kind === 'small-rubble') {
      built = buildRubble(piece, quarry, rng, ground);
    }
    if (built?.length) parts.push(...built);
  }

  if (parts.length) {
    const merged = mergeGeometries(parts.map(ni), false);
    for (const part of parts) part.dispose();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${name}:masonry`;
    mesh.userData.sourcePlanId = plan.id;
    group.add(mesh);
  }
  group.userData.semanticPlanId = plan.id;
  group.userData.tier = plan.tier;
  group.userData.detail = detail;
  group.userData.undercroftSealed = undercroftSealed;
  group.userData.stoneCount = parts.length;
  group.userData.truncated = truncated;
  group.userData.architectureHash = plan.architectureHash;
  group.userData.entropyHash = plan.entropyHash;
  group.userData.dungeonSeam = plan.dungeonSeam;
  return group;
}

export function disposeFortifiedOutpostVisual(group) {
  if (!group) return;
  group.traverse((object) => { object.geometry?.dispose?.(); });
  group.parent?.remove(group);
}
