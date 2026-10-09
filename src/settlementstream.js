import { refreshNpcPointTarget, npcPointOptions } from './npcpointing.mjs';
import * as THREE from 'three';
import { VillageLightingSystem, bakeVillageLighting } from './villagelighting.js';
import { InteriorStream } from './interiorstream.js';
import { buildInteriorStructure } from './interiormesh.js';
import { routeInterior } from './interiorplan.mjs';
import { npcGesturePose } from './npcexpression.mjs?v=2';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeRigidParts } from './rigidmerge.js';
import { planFramePosts, planOpenings } from './buildingopenings.mjs';
import { settlementsAround } from './settlementplacement.mjs';
import { BUILDING_FLOOR_SURFACE, FOUNDATION_MARGIN, doorstepBlocks, pointInsideBuilding, portalWorldPoint } from './settlementplan.mjs';
import { groundSettlementNpc } from './settlementnpcgrounding.mjs';
import { buildingWorldPoint } from './buildingplan.mjs';
import { generateHouseholds } from './npchousehold.mjs?v=2';
import { activateSettlementResidents } from './npcresidenceregistry.mjs?v=2';
import { createSettlementResidentIdentity } from './npcresidentidentity.mjs?v=2';
import { householdAgeBand } from './npcpopulation.mjs?v=2';
import { assignWorkplacesAndRoutines, advanceWorkRoutines } from './npcroutine.mjs';
import { advancePortals, closePortal, ensurePortalState, requestPortal } from './portalstate.mjs';
import { advanceSettlementEvolution, recordSettlementPressure } from './settlementevolution.mjs';
import { SETTLEMENT_BUDGETS } from './settlementquality.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js?v=7';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { advanceNpcLocomotion, createNpcLocomotionState } from './npclocomotion.mjs';
import { deriveNpcLoadout, freeGestureHand } from './npcitems.mjs';
import { advanceGaze, createGazeState, NOTICE } from './npcgaze.mjs';
import { ATTENTION, knowsPlayerCached, playerAttention } from './npcattention.mjs';
import { blockAt, dayPlanFor, gatheringTonight } from './npcdayplan.mjs';
import { planVenues } from './npcvenues.mjs';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  deliberationLookAway, gestureAmount, nodPitch, pointAmount, pulseDelivery, SOCIAL,
} from './npcsocial.mjs';
import { beginNpcConversation, exchangeRumors } from './npcrumor.mjs';
import { advanceNpcSteering, createNpcSteeringState } from './npcsteering.mjs';
import { settlementPathRibbon } from './settlementground.mjs';
import { settlementDialogueAnchor } from './livingworldcontext.mjs?v=pointplaces2';
import { STONE_KINDS } from './settlementprops.mjs';
import { cachedSettlementPlan } from './settlementspatial.mjs';
import { dirtPainter, settlementSurfaceMesh } from './settlementsurface.mjs';
import { trailSurfaceMaterial } from './trailsurface.js?v=3';
import { materialVariantFor } from './xrmaterialvariants.mjs?v=2';
import { mulberry32 } from './noise.js';
import { buildScatterGroup } from './vegetation.js?v=11';
import {
  buildFamilyMark,
  buildPartialFence,
  buildServiceCue,
  buildYardElement,
  createFrontageMaterialLibrary,
} from './settlementfrontagevisuals.mjs';
import { buildFrontageApplication } from './settlementfrontageapplicationvisuals.sol.mjs';
import { buildDistrictVisuals, DISTRICT_DETAIL_RADIUS, districtNight } from './villagedistrictvisuals.js';
import {
  managedVegetationVisualRecipe,
} from './managedvegetationvisuals.sol.mjs';
import { managedVegetationAssetMetadata } from './managedvegetationcatalog.sol.mjs';
import { managedVegetationHash } from './managedvegetationplanner.mjs';
import {
  planSettlementBusinessSigns,
  SIGN_PALETTES,
  SIGN_TYPOGRAPHY,
  signageHash,
} from './settlementsignage.mjs';

const FULL_RADIUS = 720;
// Main-thread time a village build may take per frame (see _loadSteps).
const SETTLEMENT_LOAD_BUDGET_MS = 2;
const QUERY_RADIUS = 4300;
const INTERIOR_RADIUS = 85;
const WALL_THICKNESS = 0.28;
const LEAF_THICKNESS = 0.07;
// Avatars brought into the world per frame while a village populates. Three
// costs well under a millisecond and fills a forty-five person village inside
// about fifteen frames — a quarter of a second, and invisible next to the hitch
// that building them all at once produced.
const RESIDENT_BUILD_PER_FRAME = 3;
// Distance bands for how often a resident is simulated. Inside NEAR every
// frame; out to MID every other; beyond that every fourth. A village is about
// 240 m across, so standing in its square still leaves most of its people in
// the cheap bands.
const RESIDENT_LOD_NEAR = 45;
const RESIDENT_LOD_MID = 100;
const materialCache = new Map();

/**
 * The colours a wall material is rendered in.
 *
 * `board` is painted timber cladding, and it is the one wall in a village that
 * is a chosen colour rather than the colour of what it is made of. Iron oxide
 * is cheap, it is what stopped the boards rotting, and it is why a barn is a
 * red no house on the street is. Weathering fades it toward chalk rather than
 * darkening it, which is what paint on timber actually does.
 */
function mixHex(from, to, t) {
  const clamped = Math.min(1, Math.max(0, t));
  const lerp = (shift) => {
    const a = (from >> shift) & 0xff, b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * clamped) << shift;
  };
  return lerp(16) | lerp(8) | lerp(0);
}

function wallColors(building) {
  if (building.materials.wall === 'board') {
    const weathering = Number(building.style?.weathering) || 0;
    return {
      wall: mixHex(0x6d3029, 0x92665d, weathering),
      accent: mixHex(0x54241f, 0x744841, weathering),
      trim: 0x3a2320,
    };
  }
  if (building.materials.wall === 'stone') {
    return { wall: 0x817b6e, accent: 0x8a8375, trim: 0x574b3d };
  }
  return { wall: 0xc6b995, accent: 0xb3a88c, trim: 0x5d4630 };
}

function material(color, roughness = 0.9) {
  const key = `${color}:${roughness}`;
  if (!materialCache.has(key)) materialCache.set(key, new THREE.MeshStandardMaterial({ color, roughness }));
  return materialCache.get(key);
}

function box(parent, geometry, mat, x, y, z, yaw = 0) {
  const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(x, y, z); mesh.rotation.y = yaw; mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

function addRoof(root, width, depth, rise, kind, roofMaterial, baseY) {
  const thickness = 0.24;
  if (kind === 'hip') {
    // A capped square cone is a closed hip roof: the exterior slopes and the
    // underside remain visible regardless of camera angle or face culling.
    const roof = box(root, new THREE.ConeGeometry(1, rise, 4, 1, false, Math.PI / 4), roofMaterial, 0, baseY + rise / 2, 0);
    roof.scale.set(width / Math.SQRT2, 1, depth / Math.SQRT2);
    return;
  }
  // Each gable slope is a closed, slightly overlapping solid. This avoids the
  // open seams and one-sided triangles of the former hand-authored roof shell.
  const halfSpan = width / 2;
  const slopeLength = Math.hypot(halfSpan, rise) + 0.16;
  const angle = Math.atan2(rise, halfSpan);
  for (const side of [-1, 1]) {
    const roof = box(root, new THREE.BoxGeometry(slopeLength, thickness, depth), roofMaterial, side * halfSpan / 2, baseY + rise / 2, 0);
    roof.rotation.z = -side * angle;
  }
}

function addGableEnds(root, width, depth, rise, wallMaterial, baseY, ends = [-1, 1]) {
  const v = [
    [-width / 2, 0, -WALL_THICKNESS / 2], [width / 2, 0, -WALL_THICKNESS / 2], [0, rise, -WALL_THICKNESS / 2],
    [-width / 2, 0, WALL_THICKNESS / 2], [width / 2, 0, WALL_THICKNESS / 2], [0, rise, WALL_THICKNESS / 2],
  ];
  const faces = [
    [3, 4, 5], [0, 2, 1],
    [0, 1, 4], [0, 4, 3],
    [0, 3, 5], [0, 5, 2],
    [1, 2, 5], [1, 5, 4],
  ];
  for (const z of ends.map((end) => end * depth / 2)) {
    // Use an indexed closed prism, matching BoxGeometry's index contract. A
    // non-indexed ExtrudeGeometry in this material batch caused Three's merge
    // utility to reject the whole batch, which made every wall disappear.
    const positions = [], indices = [];
    for (const face of faces) for (const vertex of face) { indices.push(indices.length); positions.push(...v[vertex]); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    box(root, geometry, wallMaterial, 0, baseY, z);
  }
}

// Openings come from buildingopenings, which is renderer-independent so the
// Node suite can audit what a program cuts in its walls. Everything here does
// is turn those rectangles into geometry.
function windowOpenings(building, span) {
  return planOpenings(building, span);
}

function addWallWithOpenings(root, length, height, z, wallMaterial, openings) {
  const clipped = openings.map((opening) => ({
    left: Math.max(-length / 2, opening.x - opening.width / 2),
    right: Math.min(length / 2, opening.x + opening.width / 2),
    bottom: Math.max(0, opening.bottom),
    top: Math.min(height, opening.bottom + opening.height),
  })).filter((opening) => opening.right > opening.left && opening.top > opening.bottom);
  const xs = [...new Set([-length / 2, length / 2, ...clipped.flatMap((opening) => [opening.left, opening.right])])].sort((a, b) => a - b);
  const ys = [...new Set([0, height, ...clipped.flatMap((opening) => [opening.bottom, opening.top])])].sort((a, b) => a - b);
  for (let xi = 1; xi < xs.length; xi++) for (let yi = 1; yi < ys.length; yi++) {
    const left = xs[xi - 1], right = xs[xi], bottom = ys[yi - 1], top = ys[yi];
    const centerX = (left + right) / 2, centerY = (bottom + top) / 2;
    if (clipped.some((opening) => centerX > opening.left && centerX < opening.right && centerY > opening.bottom && centerY < opening.top)) continue;
    box(root, new THREE.BoxGeometry(right - left, top - bottom, WALL_THICKNESS), wallMaterial, centerX, centerY, z);
  }
}

/**
 * Boards hung either side of an unglazed opening, folded back against the wall.
 *
 * Open rather than closed on purpose: a closed shutter is a rectangle of timber
 * and reads as a door, where an open pair frames a dark hole and says the
 * building is in use. The dark backing is what makes the hole read as depth —
 * without it you see the far wall lit through the opening and it looks like a
 * panel rather than a way in.
 */
function shutterAssembly(root, opening, z, shutterColor) {
  const boards = material(shutterColor, 0.94);
  const leafWidth = opening.width * 0.52;
  const centerY = opening.bottom + opening.height / 2;
  const face = z > 0 ? 1 : -1;
  // Measured from the wall's OUTER face, not its centre line. `z` is the middle
  // of a wall 0.28 thick, so leaves hung 0.075 out from it sat entirely inside
  // the masonry and rendered as nothing at all — the openings came back looking
  // exactly like the plain punched holes the shutters were meant to replace.
  const leafOffset = WALL_THICKNESS / 2 + LEAF_THICKNESS / 2 + 0.015;
  const strap = material(0x2e1f1a, 0.86);
  for (const side of [-1, 1]) {
    const leafX = opening.x + side * (opening.width / 2 + leafWidth / 2 - 0.03);
    box(root, new THREE.BoxGeometry(leafWidth, opening.height * 1.06, LEAF_THICKNESS), boards,
      leafX, centerY, z + face * leafOffset);
    // Two strap hinges. Small, but they are what stops a leaf reading as a
    // painted panel on the wall behind it.
    for (const rung of [-0.3, 0.3]) {
      box(root, new THREE.BoxGeometry(leafWidth * 0.88, 0.075, 0.03), strap,
        leafX, centerY + opening.height * rung, z + face * (leafOffset + LEAF_THICKNESS / 2 + 0.02));
    }
  }
  // The dark inside, set just behind the wall face.
  box(root, new THREE.BoxGeometry(opening.width, opening.height, 0.05),
    material(0x241a15, 1), opening.x, centerY, z - face * (WALL_THICKNESS / 2));
}

function windowAssembly(root, opening, z, trimColor) {
  const frame = material(trimColor), frameWidth = 0.14, frameDepth = WALL_THICKNESS + 0.12;
  const centerY = opening.bottom + opening.height / 2;
  box(root, new THREE.BoxGeometry(frameWidth, opening.height, frameDepth), frame, opening.x - opening.width / 2 + frameWidth / 2, centerY, z);
  box(root, new THREE.BoxGeometry(frameWidth, opening.height, frameDepth), frame, opening.x + opening.width / 2 - frameWidth / 2, centerY, z);
  box(root, new THREE.BoxGeometry(opening.width - frameWidth * 2, frameWidth, frameDepth), frame, opening.x, opening.bottom + frameWidth / 2, z);
  box(root, new THREE.BoxGeometry(opening.width - frameWidth * 2, frameWidth, frameDepth), frame, opening.x, opening.bottom + opening.height - frameWidth / 2, z);
}

/**
 * A solid volume hung off the core — a wing, a tower, an apse, a lean-to.
 *
 * Deliberately not the same code path as the core: these have no interior, so
 * they are a closed block with a roof rather than walls, floor, ceiling and
 * partitions. A spire is the exception and tapers to a point.
 */
/**
 * A square-based pyramid with flat faces.
 *
 * A four-segment cone is the same solid and was what stood here, but it is
 * built as a cone: the normals are generated for a surface of revolution, so
 * the four faces shade as though they were curved and the spire reads soft and
 * round instead of crisply faceted. Four triangles with their own vertices
 * shade flat, and a spire wants its edges.
 *
 * Vertices are duplicated per face and the index is sequential, matching the
 * contract the gable ends already use — the merge utility rejects a whole
 * material batch if one geometry in it disagrees.
 */
function pyramidGeometry(width, depth, height) {
  const w = width / 2, d = depth / 2;
  const apex = [0, height, 0];
  const base = [[-w, 0, -d], [w, 0, -d], [w, 0, d], [-w, 0, d]];
  const triangles = [];
  // Wound so the faces look outward; the reverse order shades the spire inside
  // out and it disappears against the sky from every angle but one.
  for (let i = 0; i < 4; i++) triangles.push([base[(i + 1) % 4], base[i], apex]);
  triangles.push([base[0], base[1], base[2]], [base[0], base[2], base[3]]);
  const positions = [], indices = [];
  for (const triangle of triangles) {
    for (const vertex of triangle) { indices.push(indices.length); positions.push(...vertex); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** The cross on top of a spire, with the ball it rises from. */
function addFinialCross(root, x, y, z, scale, metal) {
  const bar = 0.1 * scale;
  box(root, new THREE.SphereGeometry(0.16 * scale, 8, 6), metal, x, y + 0.12 * scale, z);
  box(root, new THREE.BoxGeometry(bar, 1.3 * scale, bar), metal, x, y + 0.9 * scale, z);
  box(root, new THREE.BoxGeometry(0.68 * scale, bar, bar), metal, x, y + 1.16 * scale, z);
}

function addMass(root, item, wallMaterial, roofMaterial, building = null) {
  if (item.role === 'spire') {
    const isChurch = building?.program === 'church';
    const spire = box(root, pyramidGeometry(item.width, item.depth, item.height),
      roofMaterial, item.dx, item.baseY, item.dz);
    spire.castShadow = true;
    if (isChurch) {
      // A course of stone under the spire reads as the parapet it springs from,
      // and stops the pyramid appearing balanced on thin air.
      box(root, new THREE.BoxGeometry(item.width * 1.12, 0.34, item.depth * 1.12),
        wallMaterial, item.dx, item.baseY - 0.17, item.dz);
      addFinialCross(root, item.dx, item.baseY + item.height, item.dz,
        Math.max(0.8, item.width * 0.32), material(0x4a4640));
    }
    return;
  }
  box(root, new THREE.BoxGeometry(item.width, item.height, item.depth), wallMaterial,
    item.dx, item.baseY + item.height / 2, item.dz);
  if (item.roof) {
    const rise = Math.max(0.9, item.width * item.roof.pitch * 0.32);
    const sub = new THREE.Group();
    sub.position.set(item.dx, 0, item.dz);
    root.add(sub);
    addRoof(sub, item.width + 0.7, item.depth + 0.7, rise, item.roof.kind, roofMaterial,
      item.baseY + item.height);
  }
}

/**
 * The things that make a church read as one up close.
 *
 * The massing carries it from across the village — a long nave and a tower are
 * legible at any distance. None of that survives being walked up to, where a
 * church is a flat box with regular holes in it. What is added here is the
 * grammar of the building rather than ornament for its own sake: buttresses
 * because a tall thin wall needs them, a string course where the stonework
 * changes, louvres because a belfry must let its sound out, a porch because a
 * door in a wall this high is otherwise a hole.
 *
 * All of it is plain boxes, and all of it is added before the static merge, so
 * a fully detailed church costs no more to draw than the box it replaces.
 */
function addChurchDetail(root, building, h, w, d, wall, roof) {
  const stone = material(wallColors(building).accent);
  const shadowStone = material(0x4f4a42);
  const wood = material(0x4a3220);
  const tower = (building.masses || []).find((item) => item.role === 'tower');

  // --- buttresses along the nave -------------------------------------------------
  // Stepped: a deeper foot and a shallower shoulder, capped by a slope that
  // throws water off. Spaced on the window rhythm so they land between the
  // lancets rather than across them.
  const bays = Math.max(2, Math.round(d / 4.2));
  for (let bay = 1; bay < bays; bay++) {
    const z = -d / 2 + (bay / bays) * d;
    for (const side of [-1, 1]) {
      const x = side * (w / 2 + 0.32);
      const footHeight = h * 0.62, shoulderHeight = h * 0.84;
      box(root, new THREE.BoxGeometry(0.78, footHeight, 0.95), stone, x, footHeight / 2, z);
      box(root, new THREE.BoxGeometry(0.5, shoulderHeight, 0.72), stone,
        side * (w / 2 + 0.2), shoulderHeight / 2, z);
      // The weathering slope on top, tilted toward the wall.
      const cap = box(root, new THREE.BoxGeometry(0.62, 0.16, 1.15), shadowStone,
        x, shoulderHeight + 0.06, z);
      cap.rotation.z = side * 0.55;
    }
  }

  // --- a string course where the wall changes ---------------------------------------
  for (const z of [-d / 2 - 0.02, d / 2 + 0.02]) {
    box(root, new THREE.BoxGeometry(w + 0.5, 0.17, 0.2), stone, 0, h * 0.34, z);
  }
  for (const side of [-1, 1]) {
    box(root, new THREE.BoxGeometry(0.2, 0.17, d + 0.5), stone, side * (w / 2 + 0.02), h * 0.34, 0);
  }

  // --- west porch over the door ---------------------------------------------------------
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  if (door) {
    const porchWidth = door.width + 1.5, porchDepth = 1.5;
    for (const side of [-1, 1]) {
      box(root, new THREE.BoxGeometry(0.34, door.height + 0.5, 0.34), stone,
        door.x + side * porchWidth / 2, (door.height + 0.5) / 2, d / 2 + porchDepth - 0.2);
    }
    box(root, new THREE.BoxGeometry(porchWidth + 0.5, 0.28, porchDepth + 0.4), stone,
      door.x, door.height + 0.62, d / 2 + porchDepth * 0.55);
    // A little gable over it, echoing the nave roof.
    const gableRise = 0.85;
    const sub = new THREE.Group();
    sub.position.set(door.x, 0, d / 2 + porchDepth * 0.55);
    root.add(sub);
    addRoof(sub, porchWidth + 0.7, porchDepth + 0.6, gableRise, 'gable', roof, door.height + 0.76);
    // Deep reveal around the doorway, so the door sits in a wall rather than on it.
    box(root, new THREE.BoxGeometry(door.width + 0.7, 0.28, 0.3), stone,
      door.x, door.height + 0.14, d / 2 + 0.16);
  }

  // --- a rose window above the door --------------------------------------------------------
  if (h > 4.2) {
    const rose = box(root, new THREE.CylinderGeometry(0.82, 0.82, 0.22, 12), stone,
      door ? door.x : 0, h * 0.76, d / 2 + 0.06);
    rose.rotation.x = Math.PI / 2;
    // Named for what it is rather than what it is made of. A corrections test
    // guards against reintroducing the old window-pane geometry by matching the
    // identifier that implementation used; this is a solid disc set in a stone
    // surround, which is a different thing, and it should not answer to that
    // name or trip the guard.
    const roseFill = box(root, new THREE.CylinderGeometry(0.6, 0.6, 0.12, 12), material(0x3f4a5c),
      door ? door.x : 0, h * 0.76, d / 2 + 0.12);
    roseFill.rotation.x = Math.PI / 2;
    // Tracery: two crossed bars, which at this scale is all that reads.
    for (const angle of [0, Math.PI / 2]) {
      const bar = box(root, new THREE.BoxGeometry(1.2, 0.11, 0.16), stone,
        door ? door.x : 0, h * 0.76, d / 2 + 0.16);
      bar.rotation.z = angle;
    }
  }

  if (!tower) return;

  // --- the tower ------------------------------------------------------------------------------
  const side = tower.width, top = tower.baseY + tower.height;
  // Corner pilasters: the tower's own buttresses, running its full height.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box(root, new THREE.BoxGeometry(0.46, tower.height, 0.46), stone,
      tower.dx + sx * (side / 2 - 0.12), tower.height / 2, tower.dz + sz * (side / 2 - 0.12));
  }
  // Two string courses, dividing the stage the bells hang in from the one below.
  for (const level of [0.42, 0.74]) {
    box(root, new THREE.BoxGeometry(side + 0.42, 0.2, side + 0.42), stone,
      tower.dx, tower.height * level, tower.dz);
  }
  // Belfry louvres on all four faces: a recessed dark opening with a sill.
  const belfryY = tower.height * 0.86;
  for (let face = 0; face < 4; face++) {
    const angle = face * Math.PI / 2;
    const nx = Math.sin(angle), nz = Math.cos(angle);
    const opening = box(root, new THREE.BoxGeometry(side * 0.34, 1.5, side * 0.34),
      shadowStone, tower.dx + nx * (side / 2 - 0.16), belfryY, tower.dz + nz * (side / 2 - 0.16));
    opening.rotation.y = angle;
    const sill = box(root, new THREE.BoxGeometry(side * 0.5, 0.16, 0.34), stone,
      tower.dx + nx * (side / 2 + 0.04), belfryY - 0.83, tower.dz + nz * (side / 2 + 0.04));
    sill.rotation.y = angle;
  }
  // A parapet at the top, so the spire springs from masonry.
  for (let face = 0; face < 4; face++) {
    const angle = face * Math.PI / 2;
    const nx = Math.sin(angle), nz = Math.cos(angle);
    const wallTop = box(root, new THREE.BoxGeometry(side + 0.3, 0.5, 0.22), stone,
      tower.dx + nx * (side / 2 + 0.1), top + 0.25, tower.dz + nz * (side / 2 + 0.1));
    wallTop.rotation.y = angle;
  }
  // Clock face on the side that looks down the nave, where it would be read from.
  const clock = box(root, new THREE.CylinderGeometry(side * 0.19, side * 0.19, 0.16, 12),
    material(0xd9d2be), tower.dx, tower.height * 0.62, tower.dz + side / 2 + 0.06);
  clock.rotation.x = Math.PI / 2;
  for (const [len, ang, off] of [[side * 0.13, 1.1, 0.02], [side * 0.09, -0.4, 0.04]]) {
    const hand = box(root, new THREE.BoxGeometry(len, 0.07, 0.06), wood,
      tower.dx + Math.cos(ang) * len * 0.4, tower.height * 0.62 + Math.sin(ang) * len * 0.4,
      tower.dz + side / 2 + 0.1 + off);
    hand.rotation.z = ang;
  }
}

function addBuildingDetails(root, building, h, w, d, frontWindows, backWindows) {
  const palette = wallColors(building);
  const trimColor = palette.trim;
  // Shutters take the wall's own darker tone, not the trim.
  //
  // Trim on a boarded barn is near-black, and hung beside an opening that is
  // also near-black the leaves vanished into the hole: the whole assembly read
  // as one dark rectangle, which is exactly the plain punched opening the
  // shutters were added to replace. Three tones are needed for the boards to be
  // legible at all — wall, shutter, and the dark behind them.
  const shutterColor = palette.accent;
  const trim = material(trimColor), stone = material(0x625d52), wood = material(0x553720);
  const foundationDepth = Math.max(0.32, building.foundationDepth || 0.48);
  // Sized to the whole footprint, not the core, so a wing is seated on the same
  // plinth rather than appearing to float beside one.
  const fp = building.footprint || { halfWidth: w / 2, halfDepth: d / 2 };
  // Drawn at the margin the claim and the collision walls use, not at a
  // hardcoded 0.5 that worked out to half of it. The plinth you can see is now
  // the plinth you can stand on.
  // A terrace unit's plinth stops at its party walls, where the next house's
  // begins; carried through, the two would overlap at the same height and
  // shimmer along every front.
  const marginLeft = building.row?.left?.shared ? 0 : FOUNDATION_MARGIN;
  const marginRight = building.row?.right?.shared ? 0 : FOUNDATION_MARGIN;
  box(root, new THREE.BoxGeometry(
    fp.halfWidth * 2 + marginLeft + marginRight, foundationDepth, fp.halfDepth * 2 + FOUNDATION_MARGIN * 2,
  ), stone, (marginRight - marginLeft) / 2, BUILDING_FLOOR_SURFACE - foundationDepth / 2, 0);
  // A frame is what makes an opening read as a window, so only the glazed ones
  // get one. Framing a forge mouth and a granary's vent slits is most of what
  // made every building in a village look like somebody's house.
  for (const opening of frontWindows) {
    if (opening.glazed !== false) windowAssembly(root, opening, d / 2, trimColor);
    else if (opening.shutters) shutterAssembly(root, opening, d / 2, shutterColor);
  }
  for (const opening of backWindows) {
    if (opening.glazed !== false) windowAssembly(root, opening, -d / 2, trimColor);
    else if (opening.shutters) shutterAssembly(root, opening, -d / 2, shutterColor);
  }
  if (building.style.timberFrame) {
    // Corner posts and door jambs, from buildingopenings so the suite can assert
    // that nothing ever stands across a doorway again.
    for (const x of planFramePosts(building, w)) {
      box(root, new THREE.BoxGeometry(0.18, h, 0.18), trim, x, h / 2, d / 2 + 0.17);
    }
    for (let floor = 1; floor <= building.floorCount; floor++) box(root, new THREE.BoxGeometry(w, 0.16, 0.18), trim, 0, floor * building.floorHeight - 0.12, d / 2 + 0.17);
  }
  if (building.style.porch) {
    box(root, new THREE.BoxGeometry(Math.min(5.5, w * 0.62), 0.2, 1.8), wood, 0, 0.22, d / 2 + 0.8);
    for (const x of [-Math.min(2.2, w * 0.24), Math.min(2.2, w * 0.24)]) box(root, new THREE.BoxGeometry(0.18, 2.15, 0.18), wood, x, 1.25, d / 2 + 1.35);
    const canopy = box(root, new THREE.BoxGeometry(Math.min(6, w * 0.68), 0.18, 2.0), material(0x494238), 0, 2.35, d / 2 + 0.82);
    canopy.rotation.x = -0.08;
  }
  if (building.row) {
    // Stacks stand on the ridge at the party walls, one shared by each pair,
    // which is the rhythm a terrace roofline is read by.
    const rise = building.row.rise;
    const stack = material(0x61564a);
    if (building.style.chimney && building.row.right.shared && building.row.index % 2 === 0) {
      box(root, new THREE.BoxGeometry(0.9, rise + 0.95, 0.62), stack, w / 2, h + (rise + 0.95) / 2, 0);
    }
    for (const [end, side] of [[building.row.left, -1], [building.row.right, 1]]) {
      if (end.shared || !building.style.chimney) continue;
      box(root, new THREE.BoxGeometry(0.62, rise + 0.85, 0.62), stack, side * (w / 2 - 0.42), h + (rise + 0.85) / 2, 0);
    }
  } else if (building.style.chimney) box(root, new THREE.BoxGeometry(0.72, 2.3, 0.72), material(0x61564a), w * 0.24, h + 1.15, -d * 0.12);
  if (building.program === 'row-house' || building.program === 'infill-house') {
    // A hood over the door on two brackets: no room for a porch on a front
    // this narrow, and a bare door in a terrace reads as a back door.
    const door = building.portals.find((portal) => portal.kind === 'exterior-door');
    const hood = box(root, new THREE.BoxGeometry(door.width + 0.5, 0.1, 0.55), material(0x494238), door.x, 2.42, d / 2 + 0.27);
    hood.rotation.x = -0.12;
    for (const side of [-1, 1]) box(root, new THREE.BoxGeometry(0.07, 0.3, 0.4), wood, door.x + side * (door.width / 2 + 0.17), 2.25, d / 2 + 0.2);
  }
  if (building.program === 'inn') {
    box(root, new THREE.BoxGeometry(1.1, 0.75, 0.12), material(0x784a2e), w * 0.28, 2.45, d / 2 + 0.55);
    box(root, new THREE.BoxGeometry(0.08, 1.2, 0.08), wood, w * 0.28, 3.05, d / 2 + 0.5);
  }
  if (building.program === 'workshop' || building.program === 'barn') {
    const lean = box(root, new THREE.BoxGeometry(w * 0.42, 0.18, d * 0.45), material(0x5b5040), -w * 0.28, 2.0, -d / 2 - d * 0.2);
    lean.rotation.x = 0.17;
  }
}

function transformedSignText(value, typography) {
  if (typography.transform === 'upper') return value.toLocaleUpperCase();
  return value;
}

function fitSignFont(context, text, maxWidth, startSize, typography) {
  let size = startSize;
  do {
    context.font = `${typography.weight} ${size}px ${typography.family}`;
    if (context.measureText(text).width <= maxWidth) return size;
    size -= 2;
  } while (size >= 28);
  return Math.max(28, size);
}

function drawTrackedSignText(context, text, x, y, maxWidth, size, typography, color) {
  const characters = [...text];
  context.font = `${typography.weight} ${size}px ${typography.family}`;
  const tracking = size * typography.tracking;
  const widths = characters.map((character) => context.measureText(character).width);
  const natural = widths.reduce((sum, width) => sum + width, 0);
  const spacing = characters.length > 1 ? Math.min(tracking, Math.max(0, (maxWidth - natural) / (characters.length - 1))) : 0;
  const total = natural + spacing * Math.max(0, characters.length - 1);
  let cursor = x - total / 2;
  context.fillStyle = color;
  context.textAlign = 'left'; context.textBaseline = 'middle';
  for (let index = 0; index < characters.length; index++) {
    context.fillText(characters[index], cursor, y);
    cursor += widths[index] + spacing;
  }
}

function signTexture(spec) {
  const { dimensions } = spec.placement;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = Math.max(180, Math.round(512 * dimensions.height / dimensions.width));
  const context = canvas.getContext('2d');
  const palette = SIGN_PALETTES[spec.paletteId], typography = SIGN_TYPOGRAPHY[spec.typographyId];
  const w = canvas.width, h = canvas.height, padding = Math.round(w * spec.paddingRatio);
  context.fillStyle = palette.board; context.fillRect(0, 0, w, h);
  context.strokeStyle = palette.edge; context.lineWidth = Math.max(7, Math.round(w * 0.018));
  const inset = Math.round(w * 0.035);
  if (spec.layoutId === 'arched-name') {
    context.beginPath();
    context.moveTo(inset, h - inset); context.lineTo(inset, h * 0.32);
    context.quadraticCurveTo(w / 2, -h * 0.02, w - inset, h * 0.32);
    context.lineTo(w - inset, h - inset); context.closePath(); context.stroke();
  } else if (spec.layoutId === 'double-frame') {
    context.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    context.lineWidth *= 0.45;
    context.strokeRect(inset * 1.65, inset * 1.65, w - inset * 3.3, h - inset * 3.3);
  } else {
    context.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  }
  const name = transformedSignText(spec.displayName, typography);
  const label = transformedSignText(spec.programLabel, { ...typography, transform: 'upper' });
  const maxTextWidth = w - padding * 2;
  if (spec.layoutId === 'left-flourish') {
    const size = fitSignFont(context, name, maxTextWidth * 0.82, h * 0.32, typography);
    drawTrackedSignText(context, name, w * 0.56, h * 0.45, maxTextWidth * 0.82, size, typography, palette.ink);
    context.strokeStyle = palette.accent; context.lineWidth = Math.max(4, w * 0.008);
    context.beginPath(); context.moveTo(padding, h * 0.3); context.quadraticCurveTo(w * 0.16, h * 0.5, padding, h * 0.7); context.stroke();
    drawTrackedSignText(context, label, w * 0.56, h * 0.72, maxTextWidth * 0.68, Math.max(24, h * 0.12), typography, palette.accent);
  } else if (spec.layoutId === 'centred-rule') {
    const size = fitSignFont(context, name, maxTextWidth, h * 0.34, typography);
    drawTrackedSignText(context, name, w / 2, h * 0.42, maxTextWidth, size, typography, palette.ink);
    context.strokeStyle = palette.accent; context.lineWidth = Math.max(3, w * 0.006);
    context.beginPath(); context.moveTo(padding * 1.25, h * 0.64); context.lineTo(w - padding * 1.25, h * 0.64); context.stroke();
    drawTrackedSignText(context, label, w / 2, h * 0.76, maxTextWidth * 0.7, Math.max(23, h * 0.105), typography, palette.accent);
  } else {
    const nameY = spec.layoutId === 'arched-name' ? h * 0.47 : h * 0.4;
    const size = fitSignFont(context, name, maxTextWidth, h * (spec.layoutId === 'arched-name' ? 0.31 : 0.3), typography);
    drawTrackedSignText(context, name, w / 2, nameY, maxTextWidth, size, typography, palette.ink);
    drawTrackedSignText(context, label, w / 2, h * 0.7, maxTextWidth * 0.76, Math.max(24, h * 0.12), typography, palette.accent);
    if (spec.layoutId === 'divided-two-line') {
      context.strokeStyle = palette.accent; context.lineWidth = Math.max(3, w * 0.006);
      context.beginPath(); context.moveTo(padding * 1.3, h * 0.57); context.lineTo(w - padding * 1.3, h * 0.57); context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addOwnershipSign(root, signSpec) {
  if (!signSpec) return;
  const placement = signSpec.placement;
  const signRoot = new THREE.Group();
  signRoot.name = signSpec.id; signRoot.userData.dynamicStructure = true;
  signRoot.position.set(placement.localX, placement.localY, placement.localZ);
  signRoot.rotation.y = placement.yaw;
  root.add(signRoot);
  const boardY = placement.boardCenterY || 0;
  const palette = SIGN_PALETTES[signSpec.paletteId];
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: palette.edge, roughness: 0.92, metalness: 0 });
  const faceMaterial = new THREE.MeshBasicMaterial({ map: signTexture(signSpec), side: THREE.DoubleSide });
  const { width, height, depth } = placement.dimensions;
  const backing = box(signRoot, new THREE.BoxGeometry(width, height, depth), edgeMaterial, 0, boardY, 0);
  backing.castShadow = true; backing.receiveShadow = true; backing.userData.settlementOwnedMaterial = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.94, height * 0.9), faceMaterial);
  face.position.set(0, boardY, depth / 2 + 0.006);
  face.userData.settlementOwnedMaterial = true; signRoot.add(face);
  const hardware = new THREE.MeshStandardMaterial({ color: 0x342f28, roughness: 0.78, metalness: 0.22 });
  if (placement.mount === 'post') {
    for (const x of [-width * 0.32, width * 0.32]) {
      const post = box(signRoot, new THREE.BoxGeometry(0.095, boardY + height * 0.24, 0.095), hardware,
        x, (boardY - height / 2) / 2, -depth * 0.08);
      post.userData.settlementOwnedMaterial = true;
    }
    signRoot.rotation.z = (signageHash(signSpec.id) % 3 - 1) * 0.008;
  } else if (placement.mount === 'projecting') {
    const arm = box(signRoot, new THREE.BoxGeometry(0.09, 0.09, 0.62), hardware,
      width / 2 + 0.24, height * 0.34, 0);
    arm.rotation.y = Math.PI / 2; arm.userData.settlementOwnedMaterial = true;
    const brace = box(signRoot, new THREE.BoxGeometry(0.055, 0.42, 0.055), hardware,
      width / 2 + 0.5, height * 0.17, 0);
    brace.rotation.z = -0.52; brace.userData.settlementOwnedMaterial = true;
  } else {
    for (const x of [-width * 0.34, width * 0.34]) {
      const peg = box(signRoot, new THREE.CylinderGeometry(0.035, 0.035, 0.12, 7), hardware, x, 0, -depth / 2 - 0.045);
      peg.rotation.x = Math.PI / 2; peg.userData.settlementOwnedMaterial = true;
    }
  }
}

// Exported for the building lab, which lays one of each program out on a sheet
// so their architecture can be compared side by side rather than one at a time
// across a valley. Nothing in the streaming path calls it through the export.
export function buildBuilding(group, building, doorMeshes, signSpec = null) {
  // A core that stands clear of the ground takes the whole building up with it.
  //
  // Everything below is drawn relative to the root at y=0 — floor, walls, roof,
  // windows, door — so lifting the root is what actually raises a granary onto
  // its staddle stones. Without this the plan says the core is lifted, the
  // burial check agrees, and the rendered building is still flat on the earth
  // with six stones buried in its floor. Attached masses are drawn in the
  // building's own frame and so are shifted back down by the same amount, which
  // leaves the stones on the ground where they belong.
  const coreLift = (building.masses || []).find((item) => item.role === 'core')?.baseY || 0;
  const root = new THREE.Group(); root.position.set(building.x, building.y + coreLift, building.z); root.rotation.y = building.yaw; root.userData.buildingId = building.id; group.add(root);
  const wall = material(wallColors(building).wall);
  const roof = material(building.materials.roof === 'slate' ? 0x41494c : 0x7c6541);
  const wood = material(0x5a3925); const floor = material(0x76654d);
  const h = building.floorCount * building.floorHeight, w = building.width, d = building.depth;
  const frontDoor = building.portals.find((portal) => portal.kind === 'exterior-door');
  const allWindows = windowOpenings(building, w);
  const frontWindows = allWindows.filter((opening) => Math.abs(opening.x - frontDoor.x) > (opening.width + frontDoor.width) / 2 + 0.12 || opening.bottom >= frontDoor.height);
  const backDoor = building.portals.find((portal) => portal.kind === 'back-door');
  const backWindows = backDoor
    ? allWindows.filter((opening) => Math.abs(opening.x - backDoor.x) > (opening.width + backDoor.width) / 2 + 0.12 || opening.bottom >= backDoor.height)
    : allWindows;
  addBuildingDetails(root, building, h, w, d, frontWindows, backWindows);
  addOwnershipSign(root, signSpec);
  box(root, new THREE.BoxGeometry(w, 0.16, d), floor, 0, 0.08, 0);
  // A real ceiling seals the playable interior independently of roof style.
  box(root, new THREE.BoxGeometry(w - WALL_THICKNESS, 0.16, d - WALL_THICKNESS), floor, 0, h - 0.08, 0);
  if (building.program === 'church') {
    // The nave's long walls carry its windows. Every other building here has
    // solid sides and its openings on the short ends, which for a church puts
    // the light in the two walls a church does not have any, and leaves the
    // forty feet of wall you actually walk past completely blank.
    //
    // Built inside a quarter-turned group so the same wall builder can run
    // along the depth axis rather than reimplementing it sideways.
    const lancets = windowOpenings(building, d);
    for (const side of [-1, 1]) {
      const sideWall = new THREE.Group();
      sideWall.rotation.y = Math.PI / 2;
      root.add(sideWall);
      addWallWithOpenings(sideWall, d, h, side * w / 2, wall, lancets);
      for (const opening of lancets) windowAssembly(sideWall, opening, side * w / 2, 0x6a6255);
    }
  } else {
    box(root, new THREE.BoxGeometry(WALL_THICKNESS, h, d), wall, -w / 2, h / 2, 0);
    box(root, new THREE.BoxGeometry(WALL_THICKNESS, h, d), wall, w / 2, h / 2, 0);
  }
  addWallWithOpenings(root, w, h, -d / 2, wall, backDoor
    ? [...backWindows, { x: backDoor.x, bottom: 0, width: backDoor.width, height: backDoor.height }]
    : backWindows);
  if (backDoor) {
    // Hung the same way as the front door, turned to face the yard, so it
    // swings out under the same portal progress.
    const turn = new THREE.Group(); turn.position.set(backDoor.x, 0, -d / 2); turn.rotation.y = Math.PI; root.add(turn);
    const pivot = new THREE.Group(); pivot.position.set(-backDoor.width / 2, 0, 0); turn.add(pivot);
    const leaf = box(pivot, new THREE.BoxGeometry(backDoor.width, backDoor.height, 0.1), wood, backDoor.width / 2, backDoor.height / 2, 0);
    leaf.castShadow = true; pivot.userData.dynamicStructure = true; doorMeshes.set(backDoor.id, pivot);
  }
  addWallWithOpenings(root, w, h, d / 2, wall, [...frontWindows, { x: frontDoor.x, bottom: 0, width: frontDoor.width, height: frontDoor.height }]);
  const doorPivot = new THREE.Group(); doorPivot.position.set(frontDoor.x - frontDoor.width / 2, 0, d / 2); root.add(doorPivot);
  const door = box(doorPivot, new THREE.BoxGeometry(frontDoor.width, frontDoor.height, 0.12), wood, frontDoor.width / 2, frontDoor.height / 2, 0);
  door.castShadow = true; doorPivot.userData.dynamicStructure = true; doorMeshes.set(frontDoor.id, doorPivot);
  if (building.interior) for (const part of building.interior.partitions) {
    const level = new THREE.Group(); level.position.y = part.y; root.add(level);
    addWallWithOpenings(level, w, part.height, part.z, wall, part.openings.map(o => ({ ...o, bottom: 0 })));
  }
  else for (let i = 1; i < building.rooms.length; i++) {
    const z = -d / 2 + d / building.rooms.length * i;
    const portal = building.portals.find((p) => p.kind === 'interior-door' && p.toRoomId === building.rooms[i].id);
    addWallWithOpenings(root, w, building.floorHeight, z, wall, [{
      x: portal.x, bottom: 0, width: portal.width, height: portal.height,
    }]);
  }
  buildInteriorStructure(root, building, wood, floor);
  if (building.row) {
    // A terrace's ridge runs along the row, so the roof is the ordinary gable
    // turned a quarter: slopes to the street and the yard, gables only at the
    // ends of the row or where it steps down a hill. Each unit roofs its own
    // width with no overhang at a party wall, so neighbours meet in one line.
    const { left, right, rise } = building.row;
    const length = w + left.overhang + right.overhang;
    const turned = new THREE.Group();
    turned.position.x = (right.overhang - left.overhang) / 2;
    turned.rotation.y = Math.PI / 2;
    root.add(turned);
    addRoof(turned, d + 1.0, length, rise, 'gable', roof, h);
    // In the turned frame local z is the row's x, measured from turned's origin.
    const ends = [];
    if (left.gable) ends.push(-1);
    if (right.gable) ends.push(1);
    for (const end of ends) {
      const gable = new THREE.Group();
      gable.position.z = end * w / 2 - turned.position.x * 1;
      turned.add(gable);
      addGableEnds(gable, d, 0, rise, wall, h, [0]);
    }
  } else {
    const rise = Math.max(1.3, w * building.roof.pitch * 0.34);
    addRoof(root, w + 1.0, d + 1.0, rise, building.roof.kind, roof, h);
    if (building.roof.kind !== 'hip') addGableEnds(root, w, d, rise, wall, h);
  }
  // Wings, towers, spires and lean-tos. Drawn after the core so a mass that
  // abuts it overlaps rather than leaving a seam at the join.
  for (const item of building.masses || []) {
    if (item.role === 'core') continue;
    addMass(root, coreLift ? { ...item, baseY: item.baseY - coreLift } : item, wall, roof, building);
  }
  if (building.program === 'church') addChurchDetail(root, building, h, w, d, wall, roof);
  return root;
}

function buildFamilyFrontage(root, building, frontage, materials, doorPivot) {
  if (!frontage) return 0;
  const applicationVisuals = buildFrontageApplication(THREE, building, frontage.application, { materials });
  root.add(applicationVisuals.staticVisual);
  if (doorPivot) doorPivot.add(applicationVisuals.doorVisual);
  let built = 0;
  for (const entry of [...(frontage.attachments || []), ...(frontage.yardElements || [])]) {
    let visual;
    const options = {
      materials,
      treatmentId: entry.treatmentId,
      householdMaterialId: entry.householdMaterialId,
      elementVariantId: frontage.application.elementVariantId,
    };
    if (entry.category === 'family-mark') visual = buildFamilyMark(THREE, entry.assetId, options);
    else if (entry.category === 'partial-fence') visual = buildPartialFence(THREE, entry.assetId, options);
    else if (entry.category === 'service-cue') visual = buildServiceCue(THREE, entry.assetId, options);
    else visual = buildYardElement(THREE, entry.assetId, options);
    visual.position.set(
      entry.placement.localX,
      entry.placement.localY,
      entry.placement.localZ,
    );
    visual.rotation.y = entry.placement.yaw || 0;
    visual.userData.frontagePlacementId = entry.id || `${frontage.id}:${entry.assetId}`;
    root.add(visual);
    built++;
  }
  return built;
}

export function pathGeometry(world, path) {
  const { positions, indices } = settlementPathRibbon(world, path);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

/**
 * The well, the stalls and the small furniture of a square.
 *
 * Built from the plan's props rather than invented here, so a Node test can
 * assert where the well is without a renderer, and the collision index can
 * agree with what is drawn.
 */
/**
 * The flight up onto a raised plot, as masonry you can see.
 *
 * The plan claims a walkable ramp from the ground outside the rim to the
 * surface of the plot, and without this the player climbs it through open air:
 * on the steepest plots in a region the claim carries them nearly three metres
 * up a hillside with nothing under their feet. Drawing the flight is what makes
 * the claim honest.
 *
 * Built as solid blocks rather than floating treads. A tread with daylight
 * under it reads as scaffolding; a step whose riser goes down into the bank is
 * what a flight cut into a plinth actually looks like.
 */
function buildDoorsteps(group, plan) {
  const tread = material(0x6c665a), riser = material(0x5c5750);
  for (const flight of plan.doorsteps || []) {
    // doorstepBlocks already works in world space, so the blocks hang straight
    // off the settlement group with no frame of their own to get wrong.
    for (const block of doorstepBlocks(flight)) {
      const mesh = box(group, new THREE.BoxGeometry(block.width, block.height, block.going),
        block.tread ? tread : riser, block.x, block.y, block.z, block.yaw);
      mesh.userData.doorstepId = flight.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  }
}

function buildProps(group, plan) {
  const stone = material(0x6f6a5e), darkStone = material(0x585349);
  const wood = material(0x5a3925), plank = material(0x6b543a);
  const cloth = [material(0x8d5f4a), material(0x5c6b57), material(0x7a6c8a)];
  for (const prop of plan.props || []) {
    const root = new THREE.Group();
    root.position.set(prop.x, prop.y, prop.z);
    root.rotation.y = prop.yaw;
    root.userData.propId = prop.id;
    group.add(root);
    if (prop.kind === 'well') {
      // A drum of stone, a pair of posts and a little roof: the shape reads as
      // a well from across the square, which is the whole job.
      const drum = box(root, new THREE.CylinderGeometry(prop.radius, prop.radius * 1.06, prop.height, 12), stone, 0, prop.height / 2, 0);
      drum.castShadow = true;
      box(root, new THREE.TorusGeometry(prop.radius, 0.09, 6, 14), darkStone, 0, prop.height, 0).rotation.x = Math.PI / 2;
      for (const side of [-1, 1]) box(root, new THREE.BoxGeometry(0.16, 2.1, 0.16), wood, side * prop.radius * 0.82, prop.height + 1.05, 0);
      box(root, new THREE.BoxGeometry(0.14, 0.14, prop.radius * 1.5), wood, 0, prop.height + 2.05, 0);
      const roof = box(root, new THREE.ConeGeometry(prop.radius * 1.35, 0.75, 4, 1, false, Math.PI / 4), plank, 0, prop.height + 2.5, 0);
      roof.castShadow = true;
    } else if (prop.kind === 'market-stall') {
      const w = prop.width, d = prop.depth;
      box(root, new THREE.BoxGeometry(w, 0.12, d), plank, 0, 0.92, 0);          // counter
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        box(root, new THREE.BoxGeometry(0.1, 0.9, 0.1), wood, sx * (w / 2 - 0.16), 0.45, sz * (d / 2 - 0.14));
      }
      if (prop.awning) {
        for (const sx of [-1, 1]) box(root, new THREE.BoxGeometry(0.1, prop.height, 0.1), wood, sx * (w / 2 - 0.1), prop.height / 2, -d / 2 + 0.12);
        const awning = box(root, new THREE.BoxGeometry(w + 0.5, 0.08, d + 0.7),
          cloth[Math.abs(Math.round(prop.x + prop.z)) % cloth.length], 0, prop.height, 0.1);
        awning.rotation.x = -0.16; awning.castShadow = true;
      }
      // Goods as a low heap on the counter — enough to say the stall is worked.
      box(root, new THREE.BoxGeometry(w * 0.5, 0.22, d * 0.5), material(0x7d6a45), 0, 1.09, 0);
    } else if (prop.kind === 'bench') {
      box(root, new THREE.BoxGeometry(prop.width, 0.09, prop.depth), plank, 0, prop.height, 0);
      for (const sx of [-1, 1]) box(root, new THREE.BoxGeometry(0.12, prop.height, prop.depth * 0.8), wood, sx * (prop.width / 2 - 0.14), prop.height / 2, 0);
    } else if (prop.kind === 'trough') {
      box(root, new THREE.BoxGeometry(prop.width, prop.height, prop.depth), stone, 0, prop.height / 2, 0);
      box(root, new THREE.BoxGeometry(prop.width - 0.3, 0.06, prop.depth - 0.25), material(0x3f5560), 0, prop.height - 0.08, 0);
    } else if (prop.kind === 'founding-stone') {
      // A rough pillar, wider at the foot than the head and never quite plumb.
      // Four sides rather than a cylinder: a raised stone was split, not turned.
      const rock = material(STONE_KINDS[prop.stone] ?? STONE_KINDS.granite);
      const shaft = box(root, new THREE.CylinderGeometry(
        prop.width * 0.34, prop.width * 0.5, prop.height, 5, 1,
      ), rock, 0, prop.height / 2, 0);
      shaft.rotation.z = prop.lean;
      shaft.rotation.y = prop.yaw * 0.5;
      shaft.castShadow = true;
      // Packing stones at the foot, which is how you keep one upright.
      for (let i = 0; i < 3; i++) {
        const angle = prop.yaw + i * 2.1;
        box(root, new THREE.BoxGeometry(prop.depth * 0.9, prop.depth * 0.5, prop.depth * 0.8), rock,
          Math.cos(angle) * prop.width * 0.42, prop.depth * 0.16, Math.sin(angle) * prop.width * 0.42);
      }
    } else if (prop.kind === 'noticeboard') {
      for (const sx of [-1, 1]) box(root, new THREE.BoxGeometry(0.11, prop.height, 0.11), wood, sx * (prop.width / 2 - 0.1), prop.height / 2, 0);
      box(root, new THREE.BoxGeometry(prop.width, 0.9, prop.depth), plank, 0, prop.height - 0.62, 0);
    }
  }
}

// A generator so a village build can pause between pieces (see _loadSteps):
// on fresh ground every ribbon samples terrain that has never been sampled.
function* buildGroundTreatment(group, plan, world) {
  const pathMat = material(0x745e41);
  // The square and the streets are one dirt surface, drawn the way a trail is:
  // per-vertex colour AND alpha, so the edges dissolve into the biome instead
  // of ending on the hard rectangle border that made them read as asphalt. The
  // trail material also carries the painterly stroke shader and its XR variant,
  // so village ground and country path are lit and grained identically.
  const surface = settlementSurfaceMesh(world, plan, dirtPainter(world, plan.site));
  if (surface.indices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(surface.colors, 4));
    geometry.setIndex(surface.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materialVariantFor(trailSurfaceMaterial));
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.renderOrder = 1;
    group.add(mesh);
  }
  yield;
  for (const [index, path] of plan.paths.entries()) {
    if (index % 6 === 5) yield;
    const mesh = new THREE.Mesh(pathGeometry(world, path), pathMat);
    // These ribbons only tint the terrain. They must never enter the sun's
    // shadow pass: even a centimetre-high overlay otherwise produces the dark
    // duplicate band visible beneath settlement lanes.
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.renderOrder = 2; group.add(mesh);
  }
}

/**
 * Every plain door leaf in a village, drawn as one instanced mesh.
 *
 * A door swings, so it has always stayed out of the static batch, and that
 * made each one its own draw in every pass — fine for thirty doors, a real
 * cost for the hundred a village-centre district brings. A leaf that is a
 * single box is replaced by an instance whose matrix follows its pivot; the
 * pivot still swings exactly as before and nothing that reads doorMeshes
 * notices. Leaves dressed by a family frontage keep their own meshes.
 */
const _doorMatrix = new THREE.Matrix4();
const _doorInverse = new THREE.Matrix4();
function batchDoorLeaves(group, doorMeshes) {
  const byMaterial = new Map();
  for (const pivot of doorMeshes.values()) {
    const leaves = [];
    pivot.traverse((child) => { if (child.isMesh) leaves.push(child); });
    if (leaves.length !== 1) continue;
    const leaf = leaves[0];
    const box = leaf.geometry.parameters;
    if (leaf.parent !== pivot || !(box?.width > 0 && box.height > 0 && box.depth > 0)) continue;
    leaf.updateMatrix();
    const local = new THREE.Matrix4().multiplyMatrices(leaf.matrix,
      new THREE.Matrix4().makeScale(box.width, box.height, box.depth));
    const list = byMaterial.get(leaf.material) || [];
    list.push({ pivot, local, castShadow: leaf.castShadow });
    byMaterial.set(leaf.material, list);
    pivot.remove(leaf);
    leaf.geometry.dispose();
  }
  const batches = [];
  for (const [mat, entries] of byMaterial) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, entries.length);
    mesh.name = 'door-leaves';
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.dynamicStructure = true;
    group.add(mesh);
    const batch = { mesh, entries, last: new Float32Array(entries.length).fill(NaN) };
    syncDoorLeaves(batch, group, true);
    batches.push(batch);
  }
  return batches;
}

function syncDoorLeaves(batch, group, force = false) {
  let dirty = false;
  for (let i = 0; i < batch.entries.length; i++) {
    const entry = batch.entries[i];
    const angle = entry.pivot.rotation.y;
    if (!force && angle === batch.last[i]) continue;
    if (!dirty) { group.updateWorldMatrix(true, false); _doorInverse.copy(group.matrixWorld).invert(); }
    batch.last[i] = angle;
    entry.pivot.updateWorldMatrix(true, false);
    _doorMatrix.multiplyMatrices(_doorInverse, entry.pivot.matrixWorld).multiply(entry.local);
    batch.mesh.setMatrixAt(i, _doorMatrix);
    dirty = true;
  }
  if (!dirty) return;
  batch.mesh.instanceMatrix.needsUpdate = true;
  if (force) batch.mesh.computeBoundingSphere();
}

/**
 * Every glazed window in a village as one instanced pane of warm light.
 *
 * Additive and depth-test only, so a lit window glows over the dark room
 * behind it without hiding whoever is standing in it, and an unlit one adds
 * nothing at all. Which windows are lit follows who is actually inside and
 * awake (syncWindowGlow), so a full inn blazes, a sleeping house goes dark,
 * and the whole village costs one draw however many windows it has.
 */
const _paneMatrix = new THREE.Matrix4();
const _paneQuat = new THREE.Quaternion();
const _paneScale = new THREE.Vector3();
const _panePos = new THREE.Vector3();
const _paneUp = new THREE.Vector3(0, 1, 0);
let paneMaterial = null;
function buildWindowGlow(group, plan) {
  const panes = [];
  for (const building of plan.buildings) {
    if (building.program === 'church' || building.program === 'granary' || building.program === 'barn') continue;
    const door = building.portals.find((portal) => portal.kind === 'exterior-door');
    const backDoor = building.portals.find((portal) => portal.kind === 'back-door');
    const lift = (building.masses || []).find((m) => m.role === 'core')?.baseY || 0;
    for (const opening of planOpenings(building, building.width)) {
      if (opening.glazed === false) continue;
      for (const side of [1, -1]) {
        if (side > 0 && door && opening.bottom < door.height
          && Math.abs(opening.x - door.x) <= (opening.width + door.width) / 2 + 0.12) continue;
        if (side < 0 && backDoor && opening.bottom < backDoor.height
          && Math.abs(opening.x - backDoor.x) <= (opening.width + backDoor.width) / 2 + 0.12) continue;
        panes.push({ building, opening, side, lift });
      }
    }
  }
  if (!panes.length) return null;
  paneMaterial ||= new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), paneMaterial, panes.length);
  mesh.name = 'window-glow';
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.userData.dynamicStructure = true;
  const dark = new THREE.Color(0, 0, 0);
  const byBuilding = new Map();
  panes.forEach((pane, index) => {
    const { building, opening, side, lift } = pane;
    const lz = side * (building.depth / 2 - 0.16);
    const p = buildingWorldPoint(building, opening.x, lz);
    _panePos.set(p.x, building.y + lift + opening.bottom + opening.height / 2, p.z);
    _paneQuat.setFromAxisAngle(_paneUp, building.yaw + (side > 0 ? 0 : Math.PI));
    _paneScale.set(opening.width * 0.84, opening.height * 0.84, 1);
    mesh.setMatrixAt(index, _paneMatrix.compose(_panePos, _paneQuat, _paneScale));
    mesh.setColorAt(index, dark);
    const list = byBuilding.get(building.id) || [];
    list.push(index);
    byBuilding.set(building.id, list);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.visible = false;
  group.add(mesh);
  return { mesh, byBuilding, lit: new Map(), timer: 0 };
}

const _warm = new THREE.Color();
function syncWindowGlow(current, dt) {
  const glow = current.windowGlow;
  if (!glow) return;
  const night = districtNight();
  glow.mesh.visible = night > 0.12;
  if (!glow.mesh.visible) return;
  glow.timer -= dt;
  if (glow.timer > 0 && glow.night === night) return;
  glow.timer = 0.8;
  glow.night = night;
  // Who is in, and awake.
  const occupied = new Map();
  for (const resident of current.residents) {
    const spot = resident.task?.spot;
    const inside = resident.insideBuildingId || (spot?.indoor && resident.task?.phase === 'act' ? spot.buildingId : null);
    if (!inside || resident.block?.activity === 'sleep') continue;
    occupied.set(inside, (occupied.get(inside) || 0) + 1);
  }
  let changed = false;
  for (const [buildingId, indices] of glow.byBuilding) {
    const people = occupied.get(buildingId) || 0;
    // A busy room is brighter than one person reading by a lamp.
    const level = people ? Math.min(1, 0.62 + people * 0.12) * night : 0;
    if (glow.lit.get(buildingId) === level) continue;
    glow.lit.set(buildingId, level);
    // lamplight, not daylight: deep amber with the blue nearly gone
    _warm.setRGB(1.2 * level, 0.56 * level, 0.13 * level);
    for (const index of indices) glow.mesh.setColorAt(index, _warm);
    changed = true;
  }
  if (changed) glow.mesh.instanceColor.needsUpdate = true;
}

export function mergeStaticSettlementMeshes(group) {
  group.updateMatrixWorld(true);
  const byMaterial = new Map(), originals = [];
  group.traverse((child) => {
    if (!child.isMesh) return;
    let parent = child;
    while (parent && parent !== group) { if (parent.userData.dynamicStructure) return; parent = parent.parent; }
    const geometry = child.geometry.clone(); geometry.applyMatrix4(child.matrixWorld);
    // `color` survives. The village's dirt surface carries its pigment and its
    // edge alpha per vertex, exactly as a trail does, so stripping colour here
    // would merge the square and streets into one flat untinted sheet — and the
    // alpha that feathers their edges would go with it.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') geometry.deleteAttribute(name);
    }
    // Shadow participation is part of a mesh's semantics. Grouping only by
    // material previously merged ground overlays with ordinary static meshes
    // and then promoted every result to a shadow caster.
    const key = `${child.material.uuid}:${child.castShadow ? 1 : 0}:${child.receiveShadow ? 1 : 0}`;
    const entry = byMaterial.get(key) || {
      material: child.material, geometries: [], renderOrder: child.renderOrder,
      castShadow: child.castShadow, receiveShadow: child.receiveShadow,
    };
    entry.geometries.push(geometry); entry.renderOrder = Math.max(entry.renderOrder, child.renderOrder); byMaterial.set(key, entry); originals.push(child);
  });
  for (const mesh of originals) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
  for (const entry of byMaterial.values()) {
    const geometry = mergeGeometries(entry.geometries, false);
    entry.geometries.forEach((item) => item.dispose());
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, entry.material);
    mesh.castShadow = entry.castShadow; mesh.receiveShadow = entry.receiveShadow;
    mesh.renderOrder = entry.renderOrder; group.add(mesh);
  }
}

function dampAngle(current, target, lambda, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * Math.max(0, dt)));
}

// --- the day, walked ------------------------------------------------------
//
// Each resident lives a day plan (npcdayplan.mjs) through the village's
// activity spots (npcvenues.mjs): walk to the spot over the village's own
// paths, through the door if it is indoors and round the house if it is in
// the back yard, then stand there doing the thing the spot is for, moving to
// another spot of the same kind now and then, until the plan moves on.

/** When a spot cannot be had, the next best thing to stand in. */
const SPOT_FALLBACK = Object.freeze({
  window: ['inside'], doorway: ['inside'], yard: ['front', 'inside'], front: ['inside'], inside: ['front'],
});
/** How long someone stays on one spot before moving to another of its kind. */
const REPICK_SECONDS = Object.freeze({
  inside: [18, 55], window: [25, 70], doorway: [25, 60], yard: [50, 150], front: [40, 120],
  customer: [14, 40], stroll: [10, 30], gathering: [80, 220], cluster: [60, 180], stall: [40, 90],
  play: [1.5, 5],
});
/** Where a companion walks relative to the one leading. */
const FORMATION = Object.freeze([
  { right: 0.85, ahead: 0 }, { right: -0.85, ahead: 0 }, { right: 0.45, ahead: -0.95 },
]);
/** Activities that people set out for together. */
const SOCIAL_ACTIVITIES = new Set(['market', 'inn', 'inn-out', 'gathering', 'stroll', 'church', 'play', 'school']);
/** Indoors and further than this from the player, a resident goes out of sight. */
const DORMANT_RANGE = 26;

function spotPool(spots, kind) {
  if (!spots) return [];
  if (spots[kind]?.length) return spots[kind];
  for (const fallback of SPOT_FALLBACK[kind] || []) if (spots[fallback]?.length) return spots[fallback];
  return [];
}

function doorLegs(building) {
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  if (!door) return null;
  return {
    building, door,
    point: portalWorldPoint(building, door),
    outside: buildingWorldPoint(building, door.x, building.depth / 2 + 0.95),
    inside: buildingWorldPoint(building, door.x, building.depth / 2 - 0.8),
  };
}

/** From the front of a house round its side to a spot behind the front wall. */
function aroundLegs(building, spot) {
  const fp = building.footprint || { minX: -building.width / 2, maxX: building.width / 2, minZ: -building.depth / 2, maxZ: building.depth / 2 };
  const side = (spot.lx ?? 0) >= 0 ? 1 : -1;
  const edge = side > 0 ? fp.maxX + 1.35 : fp.minX - 1.35;
  return [
    buildingWorldPoint(building, edge, fp.maxZ + 1.35),
    buildingWorldPoint(building, edge, Math.min(fp.maxZ, spot.lz ?? 0)),
  ];
}

/** A world point's depth in a building's own frame (+ toward the front). */
function localZ(building, point) {
  return (point.x - building.x) * Math.sin(building.yaw) + (point.z - building.z) * Math.cos(building.yaw);
}

/**
 * Waypoints through the interior doorways between two depths in a building:
 * a step either side of each partition it crosses, at that partition's door.
 */
function partitionLegs(building, fromZ, toZ) {
  const rooms = building.rooms || [];
  if (rooms.length < 2 || !Number.isFinite(fromZ) || !Number.isFinite(toZ)) return [];
  const roomDepth = building.depth / rooms.length;
  const legs = [];
  const dir = toZ > fromZ ? 1 : -1;
  const order = rooms.map((_, i) => i).slice(1);
  if (dir < 0) order.reverse();
  for (const i of order) {
    const z = -building.depth / 2 + i * roomDepth;
    if ((z - fromZ) * dir <= 0.05 || (toZ - z) * dir <= 0.05) continue;
    const portal = building.portals.find((entry) => entry.kind === 'interior-door' && entry.toRoomId === rooms[i].id);
    if (!portal) continue;
    legs.push(buildingWorldPoint(building, portal.x, z - dir * 0.55), buildingWorldPoint(building, portal.x, z + dir * 0.55));
  }
  return legs;
}

/**
 * A back yard reached through the back door is walked to in a straight line
 * from the back step, so a spot with the water butt or the woodpile between
 * it and the step would leave its resident pressed against the barrel. Such
 * spots are dropped once, when the village loads, against the real collision.
 */
function pruneUnreachableYards(venues, plan, index) {
  if (!index) return;
  for (const building of plan.buildings) {
    const back = backDoorLegs(building);
    const spots = back && venues.buildings[building.id];
    if (!spots) continue;
    spots.yard = spots.yard.filter((spot) => !behindFront(building, spot) || straightWalk(index, back.outside, spot, building.y));
  }
}

function straightWalk(index, from, to, y) {
  const steps = Math.max(4, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.3));
  let pos = { x: from.x, y: y + 0.3, z: from.z };
  for (let k = 1; k <= steps; k++) {
    const next = { x: from.x + (to.x - from.x) * k / steps, y: pos.y, z: from.z + (to.z - from.z) * k / steps };
    index.resolveMovement(next, pos, 0.29);
    pos = next;
  }
  return Math.hypot(pos.x - to.x, pos.z - to.z) < 0.35;
}

/** The way out through the back door, for a house that has one. */
function backDoorLegs(building) {
  const door = building?.portals.find((portal) => portal.kind === 'back-door');
  if (!door) return null;
  return {
    building, door,
    point: portalWorldPoint(building, door),
    outside: buildingWorldPoint(building, door.x, -building.depth / 2 - 0.95),
    inside: buildingWorldPoint(building, door.x, -building.depth / 2 + 0.8),
  };
}

function behindFront(building, spot) {
  if (!spot || spot.indoor || !building || spot.buildingId !== building.id) return false;
  const fp = building.footprint || { maxZ: building.depth / 2 };
  return (spot.lz ?? Infinity) < fp.maxZ - 0.3;
}

/** The village's path graph, built once per load. */
function graphFor(current) {
  if (current.graph) return current.graph;
  const nodes = new Map(current.plan.localGraph.nodes.map((node) => [node.key, node]));
  const edges = new Map([...nodes.keys()].map((key) => [key, []]));
  for (const path of current.plan.paths) {
    if (!edges.has(path.from) || !edges.has(path.to)) continue;
    let cost = 0;
    for (let i = 1; i < path.points.length; i++) cost += Math.hypot(path.points[i].x - path.points[i - 1].x, path.points[i].z - path.points[i - 1].z);
    edges.get(path.from).push({ to: path.to, cost, points: path.points });
    edges.get(path.to).push({ to: path.from, cost, points: path.points.slice().reverse() });
  }
  current.graph = { nodes, edges, cache: new Map() };
  return current.graph;
}

/** Points along the village paths from one graph node to another. */
function routeBetweenNodes(graph, fromKey, toKey) {
  if (!graph.nodes.has(fromKey) || !graph.nodes.has(toKey)) return [];
  const key = `${fromKey}>${toKey}`;
  const cached = graph.cache.get(key);
  if (cached) return cached;
  const open = [{ key: fromKey, cost: 0 }], best = new Map([[fromKey, 0]]), previous = new Map();
  while (open.length) {
    let at = 0;
    for (let i = 1; i < open.length; i++) if (open[i].cost < open[at].cost) at = i;
    const node = open.splice(at, 1)[0];
    if (node.key === toKey) break;
    if (node.cost !== best.get(node.key)) continue;
    for (const edge of graph.edges.get(node.key) || []) {
      const cost = node.cost + edge.cost;
      if (cost >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, cost); previous.set(edge.to, { from: node.key, edge }); open.push({ key: edge.to, cost });
    }
  }
  let points = [];
  if (previous.has(toKey)) {
    const legs = [];
    for (let k = toKey; k !== fromKey;) { const item = previous.get(k); legs.push(item.edge.points); k = item.from; }
    points = legs.reverse().flatMap((list, index) => (index ? list.slice(1) : list));
  } else {
    const to = graph.nodes.get(toKey);
    points = [{ x: to.x, y: to.y, z: to.z }];
  }
  if (graph.cache.size > 512) graph.cache.clear();
  graph.cache.set(key, points);
  return points;
}

// A resident's age band. Identities name it `age`; reading `ageBand` instead
// made every child, teenager and elder in a village live an adult's day.
function residentAgeBand(resident) {
  return resident.identity?.age || resident.identity?.ageBand || 'adult';
}

function stopResidentSteering(resident) {
  // A held locomotion pose is only valid while its root is stationary. Clear
  // the behaviour velocity at the same boundary that stops route movement so
  // a conversation cannot drag planted feet, and resuming starts from rest
  // instead of replaying the velocity cached before the interruption.
  resident.steering.vx = 0;
  resident.steering.vz = 0;
  resident.steering.speed = 0;
  resident.steering.blockedTime = 0;
  resident.steering.slideSign = 0;
  // Standing still for a conversation is not a stall: clear the progress clock
  // so a long exchange does not spend the resident's route waypoint for it.
  resident.steering.stallTime = 0;
  resident.steering.bestDistance = Infinity;
  resident.steering.targetX = NaN;
  resident.steering.targetZ = NaN;
  resident.steering.heading = resident.root.rotation.y;
}

function residentSocialMotion(resident, talkingToPlayer, moving) {
  const socialStop = !!resident.conversation || talkingToPlayer;
  // A greeting is upper-body attention while the resident is in motion. It
  // may turn the whole body only after the root has actually stopped. This
  // keeps the gait's travel frame aligned with the avatar's root frame.
  const held = !moving && (socialStop || resident.greetingLock > 0);
  return { socialStop, held, faceWithRoot: held };
}

function buildResident(group, entity, building, index, assets, worldSeed, state, spawn = null) {
  const identity = createSettlementResidentIdentity({
    entity, state, worldSeed, homeBuildingId: entity.residence?.homeBuildingId || building.id,
    householdIndex: index,
  });
  const avatar = createNpcAvatar(identity, assets), root = avatar.root;
  root.userData.actorId = entity.id;
  const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
  const outside = portalWorldPoint(building, { ...portal, z: building.depth / 2 + 2.1 });
  // Someone posted to the square starts there. Spawning them at their own front
  // door and letting them walk in would be more honest, but a village that
  // materialises with everyone streaming out of their houses at once reads as a
  // fire drill rather than a market morning.
  if (spawn) root.position.set(spawn.x, spawn.y ?? building.y, spawn.z);
  else root.position.set(outside.x + (index ? 1.1 : -1.1), building.y, outside.z);
  root.rotation.y = spawn?.yaw ?? building.yaw;
  group.add(root);
  return {
    root, avatar, identity, actorId: entity.id,
    homeBuildingId: building.id,
    householdIndex: index,
    phase: index * 1.7,
    locomotion: createNpcLocomotionState(identity.animation.phase / (Math.PI * 2)),
    steering: createNpcSteeringState(building.yaw),
    worldDims: npcWorldDimensions(avatar.dims, identity.proportions),
    gaze: createGazeState(identity.seed ^ 0x9e37, identity.animation.phase),
    emote: createEmote(identity.seed ^ 0x5eed),
    conversation: null, conversationSide: 0,
    heading: building.yaw,
    playerWasNear: false, greetingDelay: -1, greetingLock: 0, greetingHold: 0,
  };
}

function canonicalResidentIsLocal(state, entity, settlementId) {
  if (!state.features?.unifiedNpcMobilityEnabled) return true;
  if (entity?.itineraryId && entity.activity?.legKind === 'local-walk') return false;
  return entity?.location?.kind === 'building'
    && entity.location.settlementId === settlementId;
}

function residentEyeHeight(resident) {
  return resident.root.position.y + resident.worldDims.hipHeight * 1.72;
}

function residentLookAt(resident, x, y, z) {
  const dx = x - resident.root.position.x, dz = z - resident.root.position.z, flat = Math.hypot(dx, dz);
  if (flat < 0.05) return null;
  const relative = Math.atan2(dx, dz) - resident.heading;
  return { yaw: Math.atan2(Math.sin(relative), Math.cos(relative)), pitch: -Math.atan2(y - residentEyeHeight(resident), flat) };
}

function animateResident(resident, neighbours, dt, state, player, surfaceQuery, talkingToPlayer = false, moving = false, speech = null) {
  const root = resident.root;
  const playerDistance = Math.hypot(root.position.x - player.x, root.position.z - player.z);
  // Attention is earned (npcattention.mjs). Strangers carry on with what they
  // are doing and at most glance as you pass close; only someone who knows
  // you stops, turns and waves.
  const knows = knowsPlayerCached(resident, state, resident.actorId, dt);
  const attention = playerAttention({
    knows, child: residentAgeBand(resident) === 'child', distance: playerDistance,
  });
  if (attention.greet && !resident.playerWasNear) {
    resident.playerWasNear = true;
    resident.greetingDelay = resident.gaze.rng() * 0.5;
    resident.greetingHold = NOTICE.holdMin + resident.gaze.rng() * (NOTICE.holdMax - NOTICE.holdMin);
  } else if (playerDistance > NOTICE.forgetRange) resident.playerWasNear = false;
  if (resident.greetingDelay >= 0) {
    resident.greetingDelay -= Math.max(0, dt);
    if (resident.greetingDelay <= 0) {
      resident.greetingDelay = -1;
      // A look scheduled for later EXPIRES if you have moved on by the time it
      // comes round. Someone turning to watch you from across the square
      // seconds after you left is worse than not looking at all.
      if (playerDistance < ATTENTION.knownRange) {
        resident.greetingLock = resident.greetingHold || NOTICE.holdMin;
        pulseDelivery(resident.emote);
        // A wave, carried on the same channel speech gestures use.
        resident.greetingGesture = { gestureName: 'wave', gestureElapsed: 0, gestureDuration: 1.9, mouthOpen: 0 };
      }
    }
  }
  resident.greetingLock = Math.max(0, resident.greetingLock - Math.max(0, dt));
  if (resident.greetingGesture) {
    resident.greetingGesture.gestureElapsed += Math.max(0, dt);
    if (resident.greetingGesture.gestureElapsed > resident.greetingGesture.gestureDuration) resident.greetingGesture = null;
  }
  if (!speech && resident.greetingGesture) speech = resident.greetingGesture;
  advanceEmote(resident.emote, dt);
  const partner = resident.conversation?.actors[1 - resident.conversationSide] || null;
  const socialMotion = residentSocialMotion(resident, talkingToPlayer, moving);
  // Turn toward a pointed-out landmark; the arm also compensates for the
  // heading difference while that turn is still settling.
  refreshNpcPointTarget(resident.emote, root.position);
  const pointing = pointAmount(resident.emote);
  if (pointing > 0.01) {
    resident.heading = dampAngle(resident.heading, resident.emote.pointBearing, 7, dt);
    root.rotation.y = resident.heading;
  } else if (socialMotion.faceWithRoot) {
    const target = partner?.root.position || player;
    resident.heading = dampAngle(resident.heading, Math.atan2(target.x - root.position.x, target.z - root.position.z), 5.5, dt);
    root.rotation.y = resident.heading;
  }
  // What their hands are doing at the spot they stand in — unless someone has
  // their attention, which always comes first.
  const actionKind = moving || talkingToPlayer || resident.greetingLock > 0 || partner ? null : (resident.actionKind || null);
  const pose = advanceNpcLocomotion(resident.locomotion, {
    dims: resident.worldDims,
    dt: Math.max(0, dt),
    position: [root.position.x, root.position.y, root.position.z],
    heading: root.rotation.y,
    surfaceQuery,
    distance: playerDistance,
    held: socialMotion.held,
    talking: !!partner || talkingToPlayer,
    actionKind,
  });
  if (!pose) return;
  const speed = pose.locomotion?.speed || 0;
  const loadout = deriveNpcLoadout(state, resident.actorId);
  resident.avatar.setIntentLoadout(loadout);
  const freeHand = freeGestureHand(loadout);
  resident.avatar.applyPose(pose, root.position.y, {
    gesture: gestureAmount(resident.emote),
    gestureHand: freeHand || resident.identity.animation.gestureHand,
    // A village resident's emote already carried a live point -- the dialogue
    // sets it on the shared emote state -- but nothing here ever read it, so
    // the arm never came up. Same treatment the platform residents get.
    point: pointing,
    ...npcPointOptions(resident.emote),
    actionKind,
    pointHand: freeHand || resident.identity.animation.gestureHand,
    speech, speechGestureHand: freeHand,
    furniturePose: state.features.interiorsEnabled !== false && !moving && !talkingToPlayer
      ? resident.remotePose ? resident.remoteState?.furniturePose
        : resident.task?.phase === 'act' ? resident.task.spot.furniturePose : null : null,
  });
  let nearest = null, nearestDistance = 9;
  for (const other of neighbours) if (other !== resident) {
    const separation = Math.hypot(other.root.position.x - root.position.x, other.root.position.z - root.position.z);
    if (separation < nearestDistance) { nearest = other; nearestDistance = separation; }
  }
  const gaze = advanceGaze(resident.gaze, dt, {
    player: attention.look || talkingToPlayer || resident.greetingLock > 0
      ? residentLookAt(resident, player.x, player.y + 1.62, player.z) : null,
    neighbour: nearest ? residentLookAt(resident, nearest.root.position.x, residentEyeHeight(nearest), nearest.root.position.z) : null,
    vista: { yaw: 0, pitch: -0.04 },
    // Composing an answer looks like looking away. Village residents get the
    // same rhythm as platform residents; without it the several seconds an
    // on-device reply takes are several seconds of an unbroken stare.
    lockOn: talkingToPlayer && deliberationLookAway(resident.emote) ? 'glance'
      : (partner ? 'neighbour' : (resident.greetingLock > 0 || talkingToPlayer ? 'player' : null)),
    playerInterest: attention.interest,
    playerHoldMax: talkingToPlayer || resident.greetingLock > 0 ? Infinity : attention.holdMax,
    moving: speed > 0.12,
  });
  const expression = npcGesturePose(speech?.gestureName, speech?.gestureElapsed, resident.identity.animation.gestureHand, speech?.gestureDuration)?.head || [0, 0, 0];
  resident.avatar.rig.head.rotation.set(gaze.pitch + nodPitch(resident.emote) + expression[0], gaze.yaw + expression[1], Math.sin(resident.gaze.t * 0.47) * 0.018 + expression[2]);
  resident.avatar.setDetail(playerDistance);
}

function updateResidentConversations(current, dt, state, isActorInDialogue) {
  for (let index = current.conversations.length - 1; index >= 0; index--) {
    const conversation = current.conversations[index], [a, b] = conversation.actors;
    advanceConversation(conversation, dt, [a.emote, b.emote]);
    if (conversation.exchangeReady && !conversation.exchangeDone) {
      if (state.features.socialMemoryEnabled && state.features.rumorExchangeEnabled) {
        exchangeRumors(state, conversation, { nowHour: state.clock.worldHours });
      }
      conversation.exchangeDone = true; conversation.exchangeReady = false;
    }
    const separated = Math.hypot(a.root.position.x - b.root.position.x, a.root.position.z - b.root.position.z) > SOCIAL.breakRange;
    if (conversation.done || separated || isActorInDialogue(a.actorId) || isActorInDialogue(b.actorId)) {
      a.conversation = null; b.conversation = null; current.conversations.splice(index, 1);
    }
  }
  current.socialTimer -= Math.max(0, dt);
  if (current.socialTimer > 0) return;
  current.socialTimer = 3.2;
  for (let aIndex = 0; aIndex < current.residents.length; aIndex++) for (let bIndex = aIndex + 1; bIndex < current.residents.length; bIndex++) {
    const a = current.residents[aIndex], b = current.residents[bIndex];
    if (a.conversation || b.conversation || a.dormant || b.dormant || a.presence || b.presence) continue;
    // Household members talk at home; anyone may stop and talk when both are
    // out and about — at the market, the well, the inn door, a gate.
    const outAndAbout = !a.task?.spot?.indoor && !b.task?.spot?.indoor;
    if (a.homeBuildingId !== b.homeBuildingId && !outAndAbout) continue;
    if (isActorInDialogue(a.actorId) || isActorInDialogue(b.actorId)) continue;
    if (a.task?.phase === 'travel' || b.task?.phase === 'travel') continue;
    const separation = Math.hypot(a.root.position.x - b.root.position.x, a.root.position.z - b.root.position.z);
    // A passing exchange keeps ordinary personal space. Residents who happen
    // to overlap keep walking instead of freezing nose-to-nose.
    if (separation < 1.75 || separation > 3.8) continue;
    if (a.emote.rng() > 0.18) continue;
    const record = beginNpcConversation(state, [a.actorId, b.actorId], { nowHour: state.clock.worldHours });
    const conversation = createConversation(a.identity.seed ^ b.identity.seed, record);
    conversation.life = 4.5 + conversation.rng() * 5.5;
    conversation.actors = [a, b]; a.conversation = conversation; a.conversationSide = 0; b.conversation = conversation; b.conversationSide = 1;
    current.conversations.push(conversation);
  }
}

function disposeTree(root) {
  // Geometry is settlement-local; materials are deliberately shared through
  // materialCache and remain valid for subsequent stream-in cycles.
  root.traverse((child) => {
    if (child.userData?.sharedVegetationGeometry) child.dispose?.();
    else child.geometry?.dispose?.();
    if (child.userData?.settlementOwnedMaterial) {
      child.material?.map?.dispose?.(); child.material?.dispose?.();
    }
  });
}

function managedVegetationLodId(asset, placement, viewer) {
  if (!viewer) return asset.lod.defaultLevel;
  const distance = Math.hypot(placement.x - viewer.x, placement.z - viewer.z);
  const near = asset.lod.levels.find((level) => level.id === 'near');
  const far = asset.lod.levels.find((level) => level.id === 'far');
  if (distance <= near.maxDistanceMeters) return 'near';
  if (distance <= far.maxDistanceMeters) return 'far';
  return null;
}

function managedVegetationLodSignature(plan, viewer) {
  return (plan.managedVegetation?.placements || []).map((placement) => {
    const asset = managedVegetationAssetMetadata(placement.assetId);
    return asset ? (managedVegetationLodId(asset, placement, viewer) || 'culled') : 'missing';
  }).join(',');
}

function buildManagedVegetation(group, plan, vegetationLibrary, viewer = null) {
  if (!vegetationLibrary) throw new TypeError('Managed vegetation requires the shared natural vegetation library.');
  let meshes = 0, triangles = 0, near = 0, far = 0, culled = 0;
  const bucketsByLod = new Map([['near', new Map()], ['far', new Map()]]);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler();
  for (const placement of plan.managedVegetation?.placements || []) {
    const asset = managedVegetationAssetMetadata(placement.assetId);
    if (!asset) continue;
    const lodId = managedVegetationLodId(asset, placement, viewer);
    if (!lodId) { culled++; continue; }
    const recipe = managedVegetationVisualRecipe(placement.assetId, { lodId });
    const c = Math.cos(placement.yaw), s = Math.sin(placement.yaw);
    for (const item of recipe.instances) {
      const variants = vegetationLibrary[item.type];
      if (!variants?.length) throw new RangeError(`Natural vegetation library is missing ${item.type}.`);
      const variant = managedVegetationHash(`${placement.id}:${item.id}`) % variants.length;
      const key = `${item.type}:${variant}`;
      const lodBuckets = bucketsByLod.get(lodId);
      if (!lodBuckets.has(key)) lodBuckets.set(key, { type: item.type, variant, matrices: [], colors: null });
      const [localX, localY, localZ] = item.position;
      position.set(
        placement.x + localX * c + localZ * s,
        placement.y + localY,
        placement.z - localX * s + localZ * c,
      );
      euler.set(0, placement.yaw + item.yaw, 0);
      rotation.setFromEuler(euler);
      scale.setScalar((placement.scale || 1) * item.scale);
      matrix.compose(position, rotation, scale);
      lodBuckets.get(key).matrices.push(...matrix.elements);
      const geometry = variants[variant].geo;
      triangles += (geometry.index?.count || geometry.attributes.position.count) / 3;
    }
    if (lodId === 'near') near++; else far++;
  }
  for (const [lodId, bucketMap] of bucketsByLod) {
    if (!bucketMap.size) continue;
    const buckets = [...bucketMap.values()].map((bucket) => ({
      ...bucket, matrices: new Float32Array(bucket.matrices),
    }));
    const foliage = buildScatterGroup(vegetationLibrary, buckets, {
      shadows: lodId === 'near', coastal: false,
    });
    foliage.name = `managed-natural-foliage:${lodId}`;
    foliage.traverse((child) => {
      if (!child.geometry) return;
      child.userData.sharedVegetationGeometry = true;
      child.userData.managedVegetation = true;
    });
    meshes += foliage.children.length;
    group.add(foliage);
  }
  return {
    placements: near + far, meshes, triangles, near, far, culled,
    lodSignature: managedVegetationLodSignature(plan, viewer),
  };
}

export class SettlementSystem {
  constructor(scene, world, walkableSurface, state, collisionIndex = null, {
    isActorInDialogue = () => false, vegetationLibrary = null, getSpeechPerformance = () => null,
    onPlanActivated = null, requestInteraction = null,
  } = {}) {
    this.scene = scene; this.world = world; this.walkableSurface = walkableSurface; this.state = state; this.collisionIndex = collisionIndex;
    this.root = new THREE.Group(); this.root.name = 'living-settlements'; scene.add(this.root);
    this.npcAssets = new NpcAssetLibrary();
    this.lighting = new VillageLightingSystem(scene);
    this.interiors = new InteriorStream();
    this.frontageMaterials = createFrontageMaterialLibrary(THREE);
    this.vegetationLibrary = vegetationLibrary;
    this.frontageEnabled = this.state.features?.familyFrontageEnabled !== false;
    this.managedVegetationEnabled = this.state.features?.managedVegetationEnabled !== false;
    this.isActorInDialogue = isActorInDialogue;
    this.getSpeechPerformance = getSpeechPerformance;
    this.onPlanActivated = typeof onPlanActivated === 'function' ? onPlanActivated : null;
    this.requestInteraction = typeof requestInteraction === 'function' ? requestInteraction : null;
    this.active = new Map(); this.markers = new Map(); this.summaries = []; this.lastQueryX = Infinity; this.lastQueryZ = Infinity; this.lastInterestSignature = ''; this.evolutionTimer = 0;
    this.frameIndex = 0;
    this.sharedPresentation = null;
    this.portalRequestAt = new Map();
  }

  resetRegion(world = this.world, state = this.state) {
    this._finishLoading();
    for (const id of [...this.active.keys()]) this._unload(id);
    for (const marker of this.markers.values()) disposeTree(marker);
    this.markers.clear();
    this.world = world;
    this.state = state;
    this.frontageEnabled = this.state.features?.familyFrontageEnabled !== false;
    this.managedVegetationEnabled = this.state.features?.managedVegetationEnabled !== false;
    this.summaries.length = 0;
    this.lastQueryX = Infinity;
    this.lastInterestSignature = '';
    this.lastQueryZ = Infinity;
    this.evolutionTimer = 0;
    this.frameIndex = 0;
    this.sharedPresentation = null;
    this.portalRequestAt.clear();
  }

  setInteractionRequester(requester = null) {
    this.requestInteraction = typeof requester === 'function' ? requester : null;
    return this.requestInteraction;
  }

  _marker(site) {
    const root = new THREE.Group(); root.position.set(site.x, site.y, site.z); root.rotation.y = site.yaw; root.name = `${site.id}:lod`;
    const scale = site.kind === 'town' ? 2.2 : site.kind === 'village' ? 1.65 : site.kind === 'hamlet' ? 1.25 : 1;
    const walls = material(0x8f8773), roofs = material(0x4e4941);
    for (let i = 0; i < 3; i++) {
      box(root, new THREE.BoxGeometry(7 * scale, 3.5 * scale, 5 * scale), walls, (i - 1) * 8 * scale, 1.75 * scale, i % 2 ? 3 : 0);
      box(root, new THREE.BoxGeometry(7.8 * scale, 0.7 * scale, 5.8 * scale), roofs, (i - 1) * 8 * scale, 3.85 * scale, i % 2 ? 3 : 0);
    }
    this.root.add(root); return root;
  }

  _syncMarkers() {
    const wanted = new Set(this.summaries.map((site) => site.id));
    for (const [id, marker] of this.markers) if (!wanted.has(id)) { this.root.remove(marker); disposeTree(marker); this.markers.delete(id); }
    for (const site of this.summaries) if (!this.markers.has(site.id)) this.markers.set(site.id, this._marker(site));
  }

  /** Complete a village build in progress, so it can be unloaded properly. */
  _finishLoading() {
    if (!this.loading) return;
    const { site, steps } = this.loading;
    this.loading = null;
    for (;;) {
      const step = steps.next();
      if (step.done) { this.active.set(site.id, step.value); return; }
    }
  }

  /** Build a village in one go (see _loadSteps for the staged build). */
  _load(site, viewer = null) {
    const steps = this._loadSteps(site, viewer);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  // A village is built in steps, each `yield` a point where the build may
  // pause until the next frame. Built all at once it was a 200+ ms frame —
  // the moment a village came into range, which from a train is every station
  // on the line. The group stays hidden until the build is complete, so the
  // village appears whole, a few frames later, still most of a kilometre away.
  *_loadSteps(site, viewer = null) {
    // Through the shared cache, not a fresh plan every time.
    //
    // Laying out a village is 100-200ms of main-thread work, and this used to
    // pay it on every stream-in — so walking back past a village, or along the
    // load boundary where one streams out and straight back in, bought the whole
    // layout a second and third time. The vegetation and animal layers already
    // read their plans from this cache for the same sites with the same options,
    // so the first of the three to ask is the one that pays. That sharing is
    // also what keeps them building the SAME village: two systems planning one
    // settlement from different rules is how grass ends up cleared around houses
    // that were moved somewhere else.
    const plan = { ...cachedSettlementPlan(this.world, site) };
    plan.businessSigns = planSettlementBusinessSigns(plan);
    const group = new THREE.Group(); group.name = site.id; group.visible = false; this.root.add(group);
    yield* buildGroundTreatment(group, plan, this.world);
    yield;
    const doorMeshes = new Map();
    const buildingRoots = new Map();
    const signByBuilding = new Map(plan.businessSigns.map((sign) => [sign.buildingId, sign]));
    for (const building of plan.buildings) {
      buildingRoots.set(building.id, buildBuilding(group, building, doorMeshes, signByBuilding.get(building.id) || null));
      yield;
    }
    const buildingById = new Map(plan.buildings.map((building) => [building.id, building]));
    let frontageBuilt = 0;
    if (this.frontageEnabled) {
      for (const frontage of plan.familyFrontages || []) {
        const root = buildingRoots.get(frontage.buildingId);
        const building = buildingById.get(frontage.buildingId);
        const door = building?.portals?.find((portal) => portal.kind === 'exterior-door');
        if (root && building) frontageBuilt += buildFamilyFrontage(
          root, building, frontage, this.frontageMaterials, door ? doorMeshes.get(door.id) : null,
        );
        yield;
      }
    }
    // Doors stay out of the static batch because they swing, but everything
    // on a door swings with it: a studded or battened leaf was up to ten
    // separate draws. Collapse each pivot to one draw per material.
    // Plain leaves (most of them, and every one in a district) become a single
    // instanced draw per village; dressed leaves keep their own meshes.
    group.updateMatrixWorld(true);
    const doorBatches = batchDoorLeaves(group, doorMeshes);
    for (const pivot of doorMeshes.values()) mergeRigidParts(pivot);
    yield;
    // Before the merge, deliberately. A well and six stalls are around sixty
    // small meshes; left out of the static batch they would be sixty draw calls
    // per village, every frame, for scenery that never moves.
    buildProps(group, plan);
    buildDoorsteps(group, plan);
    yield;
    // The district's boundaries and big yard props join the static batch; the
    // small things — clutter, stones, lines, lanterns — live in a detail group
    // of their own that is only drawn when the player is near the village.
    const districtDetail = new THREE.Group();
    districtDetail.name = `${site.id}:district-detail`;
    districtDetail.userData.dynamicStructure = true;
    const districtDebug = buildDistrictVisuals(group, districtDetail, plan.district, this.world);
    group.add(districtDetail);
    yield;
    mergeStaticSettlementMeshes(group);
    yield;
    const lightingBake = yield* bakeVillageLighting(group, plan, this.world, districtDebug.lightSources);
    yield;
    const windowGlow = buildWindowGlow(group, plan);
    const releaseInteriors = this.interiors.register(plan, group);
    // Managed vegetation is a separate static batch so catalog LOD crossings
    // can rebuild scenery without unloading residents or touching their state.
    const managedVegetationRoot = new THREE.Group();
    managedVegetationRoot.name = `${site.id}:managed-vegetation`; group.add(managedVegetationRoot);
    const managedVegetationDebug = this.managedVegetationEnabled
      ? buildManagedVegetation(managedVegetationRoot, plan, this.vegetationLibrary, viewer)
      : { placements: 0, meshes: 0, triangles: 0, near: 0, far: 0, culled: 0, lodSignature: 'disabled' };
    yield;
    const releases = plan.claims.map((claim) => this.walkableSurface.registerClaim(claim));
    releases.push(this.lighting.register(site.id, group, districtDetail, lightingBake));
    releases.push(releaseInteriors);
    if (this.collisionIndex) {
      const collisionPlan = {
        ...plan,
        familyFrontages: this.frontageEnabled ? plan.familyFrontages : [],
        managedVegetation: this.managedVegetationEnabled ? plan.managedVegetation : { placements: [] },
      };
      releases.push(this.collisionIndex.registerPlan(collisionPlan));
    }
    yield;
    this.state.metrics ||= {};
    const frontageDebug = plan.familyFrontageDiagnostics || {};
    if (this.frontageEnabled) {
      this.state.metrics.settlementFrontagePlacements = (this.state.metrics.settlementFrontagePlacements || 0) + (frontageDebug.placedAssets || 0);
      this.state.metrics.settlementFrontageOmissions = (this.state.metrics.settlementFrontageOmissions || 0) + (frontageDebug.omittedAssets || 0);
      this.state.metrics.settlementFrontageCollisionSegments = (this.state.metrics.settlementFrontageCollisionSegments || 0) + (frontageDebug.collisionAssets || 0);
      this.state.metrics.settlementFrontageMeshes = (this.state.metrics.settlementFrontageMeshes || 0) + (frontageDebug.meshes || 0);
      this.state.metrics.settlementFrontageTriangles = (this.state.metrics.settlementFrontageTriangles || 0) + (frontageDebug.triangles || 0);
    }
    if (this.managedVegetationEnabled) {
      const planned = plan.managedVegetation?.diagnostics || {};
      this.state.metrics.settlementManagedVegetationPlacements = (this.state.metrics.settlementManagedVegetationPlacements || 0) + managedVegetationDebug.placements;
      this.state.metrics.settlementManagedVegetationOmissions = (this.state.metrics.settlementManagedVegetationOmissions || 0) + (planned.omitted || 0);
      this.state.metrics.settlementManagedVegetationMeshes = (this.state.metrics.settlementManagedVegetationMeshes || 0) + managedVegetationDebug.meshes;
      this.state.metrics.settlementManagedVegetationTriangles = (this.state.metrics.settlementManagedVegetationTriangles || 0) + managedVegetationDebug.triangles;
      this.state.metrics.settlementManagedVegetationFarLod = (this.state.metrics.settlementManagedVegetationFarLod || 0) + managedVegetationDebug.far;
      this.state.metrics.settlementManagedVegetationCulled = (this.state.metrics.settlementManagedVegetationCulled || 0) + managedVegetationDebug.culled;
    }
    // Residents are QUEUED, not built.
    //
    // A village of forty buildings houses around forty-five people, and each
    // avatar is roughly thirty meshes with a skeleton behind it. Building them
    // all inside _load put a ~200 ms stall in the frame where a village came
    // into range — which is precisely the frame the player is walking toward
    // it. The queue is drained a few per frame in update() instead, so the
    // village populates over the second or so after it appears rather than all
    // at once. Nobody notices someone arriving; everybody notices a hitch.
    const pending = [];
    const residentBlueprints = new Map();
    let activatedPopulation = null;
    if (this.state.features.householdsEnabled) {
      let households;
      if (this.state.features.unifiedNpcMobilityEnabled) {
        activatedPopulation = activateSettlementResidents(plan, this.state);
        const householdIds = new Set(activatedPopulation.residents.map((resident) => resident.householdId));
        households = [...householdIds]
          .map((householdId) => this.state.households[householdId])
          .filter(Boolean);
      } else {
        households = generateHouseholds(plan, this.state);
        if (this.state.features.workRoutinesEnabled) assignWorkplacesAndRoutines(plan, this.state);
      }
      const byId = new Map(plan.buildings.map((b) => [b.id, b]));
      // A station village keeps fewer people at home. Two per house everywhere
      // put a crowd in the lanes and left the square — the one place a village
      // is supposed to gather — empty. Alternating two and one gives an average
      // of one and a half, a quarter down, and the people saved are the ones
      // who go to market below.
      const squarePosts = plan.props ? plan.props.filter((p) => p.kind === 'market-stall') : [];
      const thinned = plan.site.isStationSettlement && squarePosts.length > 0;
      households.forEach((household, householdIndex) => {
        const take = thinned ? (householdIndex % 4 < 2 ? 2 : 1) : 2;
        household.memberIds.forEach((id, index) => {
          const home = byId.get(household.homeBuildingId);
          const entity = this.state.entities[id];
          // Until the unified actor materializer owns cross-zone handoffs, this
          // settlement renderer may only build residents whose canonical place
          // is a building in this settlement. An away trail/train/platform NPC
          // must never be duplicated at their front door.
          const canonicalHere = !this.state.features.unifiedNpcMobilityEnabled
            || canonicalResidentIsLocal(this.state, entity, plan.site.id);
          if (home && entity) {
            const blueprint = { id, home, index };
            residentBlueprints.set(id, blueprint);
            // Keep the initial visual population cap, but retain a blueprint
            // for every canonical resident. A less-visible household member
            // may be selected for station duty or a journey; when they return
            // home the handoff must be able to materialize that same person.
            if (index < take && canonicalHere) pending.push(blueprint);
            // Children are always about, beyond the cap: they are much of a
            // village's daytime life, and there are only a handful of them.
            else if (canonicalHere && householdAgeBand(household.form, index, household.memberIds.length, id) === 'child') {
              blueprint.child = true;
              pending.push(blueprint);
            }
          }
        });
      });
      if (thinned) {
        // One trader for each stall, taken from the back of the list so the
        // households at the front keep both of theirs. Everyone else comes to
        // the market when their own day takes them there (npcdayplan.mjs),
        // which is what makes it busy at ten and empty at midnight; posting
        // half the village to it made it equally busy at both.
        const traders = pending.filter((entry) => !entry.child);
        for (let i = 0; i < squarePosts.length; i++) {
          const entry = traders[traders.length - 1 - i];
          if (!entry) break;
          entry.post = { kind: 'merchant', stall: squarePosts[i], stallIndex: i };
        }
      }
    }
    yield;
    for (const building of plan.buildings) for (const portal of building.portals) ensurePortalState(this.state, portal);
    recordSettlementPressure(this.state, site.id);
    this.state.metrics.settlementsGenerated++;
    try { this.onPlanActivated?.(plan, activatedPopulation); } catch { /* cataloging is optional */ }
    const venues = planVenues(plan);
    pruneUnreachableYards(venues, plan, this.collisionIndex);
    const { lodgers: lodging, presence } = this._planRowHouseLife(plan);
    const station = settlementDialogueAnchor(site, origin);
    return {
      site, plan, group, doorMeshes, releases, residents: [], pending,
      residentBlueprints, station,
      frontageBuilt, frontageDebug, managedVegetationRoot, managedVegetationDebug,
      districtDetail, districtDebug, doorBatches, lightingBake,
      venues, windowGlow, buildingById: new Map(plan.buildings.map((building) => [building.id, building])),
      spotOwners: new Map(), age: 0, lodging, presence,
      conversations: [], socialTimer: 2.4,
    };
  }

  /**
   * Bring a few queued residents into the world.
   *
   * Deliberately a small fixed number per frame rather than a time budget: a
   * time budget measured on a fast frame happily spends the whole of a slow
   * one, and the point here is to never be the reason a frame is slow.
   */
  /**
   * Who lives in the village centre's row houses.
   *
   * Some take a lodger: an adult from a household of siblings or a lodger's
   * household, who keeps their family, name and memories and simply sleeps
   * nearer the square. Some of the rest have a presence-only occupant, seen
   * at the window, in the doorway and the garden when the player is near.
   * The remainder stand empty, doors shut and windows dark.
   */
  _planRowHouseLife(plan) {
    const lodgers = new Map(), presence = [];
    const rowHomes = plan.buildings.filter((b) => b.program === 'row-house' || b.program === 'infill-house');
    if (!rowHomes.length) return { lodgers, presence };
    const byId = new Map(plan.buildings.map((b) => [b.id, b]));
    const taken = new Set();
    const households = Object.values(this.state.households || {})
      .filter((household) => byId.has(household.homeBuildingId))
      .sort((a, b) => a.id.localeCompare(b.id));
    const maxLodgers = Math.floor(rowHomes.length * 0.45);
    for (const household of households) {
      if (lodgers.size >= maxLodgers) break;
      if (!(household.form === 'siblings' || household.form === 'lodger') || (household.memberIds?.length || 0) < 2) continue;
      const home = byId.get(household.homeBuildingId);
      const nearest = rowHomes.filter((b) => !taken.has(b.id))
        .map((b) => ({ b, d: Math.hypot(b.x - home.x, b.z - home.z) }))
        .filter((entry) => entry.d < 170).sort((a, b) => a.d - b.d)[0];
      if (!nearest) continue;
      taken.add(nearest.b.id);
      lodgers.set(household.memberIds[1], nearest.b.id);
    }
    for (const building of rowHomes) {
      if (taken.has(building.id)) continue;
      let h = 2166136261;
      for (const character of building.id) { h ^= character.charCodeAt(0); h = Math.imul(h, 16777619); }
      if (((h >>> 0) % 100) < 55) presence.push({ buildingId: building.id, id: `${building.id}:presence`, resident: null });
    }
    return { lodgers, presence };
  }

  /** Bring presence-only occupants in as the player nears their house, and out as they leave. */
  _syncPresence(current, player) {
    if (!current.presence?.length) return;
    let built = 0;
    for (const entry of current.presence) {
      const building = current.buildingById.get(entry.buildingId);
      const distance = Math.hypot(building.x - player.x, building.z - player.z);
      if (!entry.resident && distance < 70 && built < 1 && !current.pending.length) {
        const entity = { id: entry.id, kind: 'npc', name: 'Neighbour', role: 'resident' };
        const resident = buildResident(current.group, entity, building, 0, this.npcAssets, this.state.worldSeed, this.state, null);
        resident.presence = true;
        this._assignDay(current, resident, entity, {});
        this._placeAtBlock(current, resident);
        groundSettlementNpc(resident.root.position, this.walkableSurface);
        resident.groundY = resident.root.position.y;
        current.residents.push(resident);
        entry.resident = resident;
        built++;
      } else if (entry.resident && distance > 110) {
        const resident = entry.resident;
        const index = current.residents.indexOf(resident);
        if (index >= 0) current.residents.splice(index, 1);
        if (resident.task?.spot && current.spotOwners.get(resident.task.spot.id) === resident.actorId) current.spotOwners.delete(resident.task.spot.id);
        resident.root.removeFromParent();
        resident.avatar.dispose();
        entry.resident = null;
      }
    }
  }

  /** Who this resident is for the day: their role, trade and hours. */
  _assignDay(current, resident, entity, item) {
    const routine = this.state.routines?.[`routine:${resident.actorId}:work`];
    const workplace = routine ? current.buildingById.get(routine.workplaceId) : null;
    const ageBand = residentAgeBand(resident);
    const ownsWork = !!workplace && !!workplace.ownerHouseholdId && workplace.ownerHouseholdId === entity?.householdId;
    let role = 'home';
    if (ageBand === 'child') role = 'child';
    else if (item.post?.kind === 'merchant') role = 'merchant';
    else if (ownsWork && workplace.program === 'inn') role = 'innkeeper';
    // Not everybody goes out to work: the owners of a trade do, and about half
    // of everyone else; the rest keep the house, which is who is about the
    // lanes and the market in the middle of the day.
    else if (workplace && ageBand !== 'elder' && (ownsWork || (resident.identity.seed % 100) < 50)) role = 'worker';
    resident.day = {
      role, ageBand, workplaceId: workplace?.id || null, workKind: workplace?.program || null,
      stallIndex: item.post?.stallIndex ?? 0,
      shift: routine ? { start: routine.startHour, end: routine.endHour } : null,
      householdKey: entity?.householdId || null,
      planDay: null, blocks: null,
    };
    // A lodger in one of the village-centre's row houses keeps their family
    // and their memories; it is only where they sleep that has moved.
    const lodging = current.lodging?.get(resident.actorId);
    if (lodging) resident.homeBuildingId = lodging;
    resident.nodeKey = this._nodeOf(current, resident.homeBuildingId);
    resident.insideBuildingId = null;
    resident.block = null; resident.task = null; resident.actionKind = null; resident.dormant = false;
  }

  _nodeOf(current, buildingId) {
    const spots = current.venues.buildings[buildingId];
    return spots?.inside?.[0]?.nodeKey || spots?.front?.[0]?.nodeKey || spots?.doorway?.[0]?.nodeKey || null;
  }

  _dayBlocks(current, resident) {
    const day = this.dayIndex || 0;
    if (resident.day.planDay !== day) {
      if (current.villageDay?.day !== day) {
        current.villageDay = {
          day, settlementId: current.site.id,
          hasMarket: !!current.venues.market, hasInn: !!current.venues.inn, hasChurch: !!current.venues.church,
          hasSchool: !!current.venues.school,
          gathering: gatheringTonight(current.site.id, day),
        };
      }
      // A presence-only occupant keeps to their own house and garden.
      const village = resident.presence
        ? { ...current.villageDay, hasMarket: false, hasInn: false, hasChurch: false, gathering: false }
        : current.villageDay;
      let blocks = dayPlanFor({
        actorId: resident.actorId, role: resident.day.role, ageBand: resident.day.ageBand,
        shift: resident.day.shift, workKind: resident.day.workKind, householdKey: resident.day.householdKey,
      }, village, day);
      if (resident.presence) {
        blocks = blocks.map((block) => (block.venue === 'home' ? block
          : { ...block, activity: 'chores', venue: 'home', spot: 'yard', indoor: false }));
      }
      resident.day.blocks = blocks;
      resident.day.planDay = day;
    }
    return resident.day.blocks;
  }

  /** A free spot for this block, or the nearest thing to one. */
  _chooseSpot(current, resident, block, exclude = null) {
    const venues = current.venues;
    const own = (id) => venues.buildings[id];
    let pool = [];
    if (block.venue === 'home') pool = spotPool(own(resident.homeBuildingId), block.spot);
    else if (block.venue === 'work') pool = spotPool(own(resident.day.workplaceId), block.spot);
    else if (block.venue === 'market' && venues.market) {
      pool = block.spot === 'stall'
        ? [venues.market.stalls[resident.day.stallIndex % venues.market.stalls.length].merchant]
        : [...venues.market.stalls.flatMap((stall) => stall.customers), ...venues.market.well];
    } else if (block.venue === 'inn' && venues.inn) {
      pool = block.spot === 'cluster' ? venues.inn.cluster : spotPool(own(venues.inn.buildingId), 'inside');
    } else if (block.venue === 'church' && venues.church) pool = spotPool(own(venues.church.buildingId), 'inside');
    else if (block.venue === 'square') pool = block.spot === 'gathering' && venues.gathering.length ? venues.gathering : venues.stroll;
    else if (block.venue === 'school' && venues.school) pool = spotPool(own(venues.school.buildingId), 'inside');
    else if (block.venue === 'play' && venues.play.length) {
      // Children play where other children already are; the first out picks
      // the patch nearest home.
      const busy = venues.play.find((area) => current.residents.some((other) => other !== resident
        && other.task?.spot?.kind === 'play' && area.spots.includes(other.task.spot)));
      let area = busy;
      if (!area) {
        const home = current.buildingById.get(resident.homeBuildingId);
        area = venues.play.slice().sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z))[0];
      }
      pool = area.spots;
      // Running between spots is the game: never pick the one already held.
      if (exclude && pool.length > 1) pool = pool.filter((candidate) => candidate !== exclude);
    }
    if (!pool.length) pool = spotPool(own(resident.homeBuildingId), 'inside');
    const standingPool = pool.filter(s => !s.furniturePose);
    if (block.activity === 'sleep') {
      const beds = pool.filter(s => s.furnitureAction === 'sleep');
      if (beds.length) pool = beds;
    } else if (block.venue === 'work') {
      const working = pool.filter(s => s.furnitureAction === 'work' || s.furnitureAction === 'read');
      if (working.length) pool = working;
    } else if (block.indoor || block.spot === 'inside') {
      const awake = pool.filter(s => s.purpose !== 'sleeping' && s.furnitureAction !== 'sleep');
      if (awake.length) pool = awake;
    }
    if (!pool.length) return null;
    const start = Math.floor(resident.emote.rng() * pool.length);
    let fallback = null;
    for (let k = 0; k < pool.length; k++) {
      const candidate = pool[(start + k) % pool.length];
      if (candidate === exclude) { fallback ||= candidate; continue; }
      const owner = current.spotOwners.get(candidate.id);
      if (!owner || owner === resident.actorId) return candidate;
      fallback ||= candidate;
    }
    // Furniture slots are exclusive. A crowded household can use a free floor
    // anchor until a bed/seat is available instead of stacking bodies in it.
    const standing = standingPool.find(s => !current.spotOwners.has(s.id) || current.spotOwners.get(s.id) === resident.actorId);
    if (standing) return standing;
    return fallback ? { ...fallback, furniturePose: null } : null;
  }

  /** Waypoints from where the resident is to `spot`, and the doors on the way. */
  _routeTo(current, resident, spot, previous) {
    const byId = current.buildingById;
    const points = [], doors = [];
    const from = resident.insideBuildingId ? byId.get(resident.insideBuildingId) : null;
    const target = spot.buildingId ? byId.get(spot.buildingId) : null;
    const here = resident.root.position;
    // Inside a house, every move between its rooms goes through the doorway
    // in the partition, not through the wall beside it.
    const rooms = (building, a, b) => points.push(...(routeInterior(building, a, b)
      || partitionLegs(building, localZ(building, a), localZ(building, b))));
    if (from && spot.indoor && spot.buildingId === from.id) {
      rooms(from, here, spot);
      points.push(spot);
      return { points, doors };
    }
    const previousBuilding = previous?.buildingId ? byId.get(previous.buildingId) : null;
    // Between a house and its own back yard: straight through the back door.
    if (from && from === target && behindFront(target, spot)) {
      const back = backDoorLegs(from);
      if (back) {
        rooms(from, here, back.inside);
        points.push(back.inside, back.outside, spot);
        return { points, doors: [back] };
      }
    }
    if (!from && spot.indoor && target && previousBuilding === target && behindFront(target, previous)) {
      const back = backDoorLegs(target);
      if (back) {
        points.push(back.outside, back.inside);
        rooms(target, back.inside, spot);
        points.push(spot);
        return { points, doors: [back] };
      }
    }
    if (behindFront(previousBuilding, previous) && behindFront(target, spot) && previousBuilding === target) {
      return { points: [spot], doors };
    }
    if (from) {
      const legs = doorLegs(from);
      if (legs) {
        rooms(from, here, legs.inside);
        points.push(legs.inside, legs.outside); doors.push(legs);
      }
    } else if (behindFront(previousBuilding, previous)) {
      // Back in through the back door and out of the front, or round the side.
      const back = backDoorLegs(previousBuilding), front = doorLegs(previousBuilding);
      if (back && front) {
        points.push(back.outside, back.inside);
        rooms(previousBuilding, back.inside, front.inside);
        points.push(front.inside, front.outside);
        doors.push(back, front);
      } else points.push(...aroundLegs(previousBuilding, previous).reverse());
    }
    const toKey = spot.nodeKey;
    if (resident.nodeKey && toKey && resident.nodeKey !== toKey) {
      points.push(...routeBetweenNodes(graphFor(current), resident.nodeKey, toKey));
    }
    if (spot.indoor && target) {
      const legs = doorLegs(target);
      if (legs) {
        points.push(legs.outside, legs.inside); doors.push(legs);
        rooms(target, legs.inside, spot);
      }
    } else if (behindFront(target, spot)) {
      const back = backDoorLegs(target), front = doorLegs(target);
      if (back && front) {
        points.push(front.outside, front.inside);
        rooms(target, front.inside, back.inside);
        points.push(back.inside, back.outside);
        doors.push(front, back);
      } else points.push(...aroundLegs(target, spot));
    }
    points.push(spot);
    return { points, doors };
  }

  _startTask(current, resident, block, { repick = false } = {}) {
    const previous = resident.task?.spot || null;
    if (previous && current.spotOwners.get(previous.id) === resident.actorId) current.spotOwners.delete(previous.id);
    const spot = this._chooseSpot(current, resident, block, repick ? previous : null);
    if (!spot) { resident.task = null; return; }
    current.spotOwners.set(spot.id, resident.actorId);
    if (repick && spot === previous) {
      resident.task.repickAt = this._dwellFor(resident, spot);
      return;
    }
    const route = this._routeTo(current, resident, spot, previous);
    const leisurely = block.activity === 'market' || block.activity === 'stroll' || block.activity === 'gathering';
    resident.task = {
      spot, phase: 'travel', points: route.points, doors: route.doors, index: 0,
      speed: block.activity === 'play' ? 2.1 : leisurely ? 0.95 : 1.22, repickAt: 0, elapsed: 0, reroutes: 0,
    };
    resident.actionKind = null;
    resident.follow = null;
    if (!repick && SOCIAL_ACTIVITIES.has(block.activity)) this._findCompanion(current, resident, block);
  }

  /**
   * Someone setting off for the same place at the same moment: a partner,
   * a child's playmate, a neighbour heading the same way. Walk with them.
   * Groups stay small — four at most — so the lanes see pairs and threes,
   * never a procession.
   */
  _findCompanion(current, resident, block) {
    let best = null, bestDistance = 22;
    for (const other of current.residents) {
      if (other === resident || other.follow || other.dormant || other.presence) continue;
      const task = other.task;
      if (!task || task.phase !== 'travel' || task.elapsed > 12) continue;
      if (other.block?.venue !== block.venue || other.block?.activity !== block.activity) continue;
      const followers = current.residents.filter((r) => r.follow?.leader === other).length;
      if (followers >= 3) continue;
      const household = other.day?.householdKey && other.day.householdKey === resident.day?.householdKey;
      const children = other.day?.role === 'child' && resident.day?.role === 'child';
      if (!household && !children && resident.emote.rng() > 0.35) continue;
      const d = Math.hypot(other.root.position.x - resident.root.position.x, other.root.position.z - resident.root.position.z);
      if (d < bestDistance) { bestDistance = d; best = { other, followers }; }
    }
    if (best) resident.follow = { leader: best.other, slot: best.followers };
  }

  _dwellFor(resident, spot) {
    const [low, high] = REPICK_SECONDS[spot.kind] || [30, 90];
    return low + resident.emote.rng() * (high - low);
  }

  _nearestNode(current, position) {
    let best = null, bestDistance = Infinity;
    for (const node of graphFor(current).nodes.values()) {
      const d = Math.hypot(node.x - position.x, node.z - position.z);
      if (d < bestDistance) { bestDistance = d; best = node.key; }
    }
    return best;
  }

  _snapToSpot(resident, spot) {
    resident.root.position.set(spot.x, spot.y ?? resident.root.position.y, spot.z);
    groundSettlementNpc(resident.root.position, this.walkableSurface);
    resident.heading = spot.yaw; resident.root.rotation.y = spot.yaw;
    stopResidentSteering(resident);
  }

  /** Put a freshly built resident straight into their current block. */
  _placeAtBlock(current, resident) {
    const block = blockAt(this._dayBlocks(current, resident), this.dayHour ?? 12);
    resident.block = block;
    const spot = this._chooseSpot(current, resident, block);
    if (!spot) return;
    current.spotOwners.set(spot.id, resident.actorId);
    resident.root.position.set(spot.x, spot.y ?? resident.root.position.y, spot.z);
    resident.heading = spot.yaw; resident.root.rotation.y = spot.yaw;
    resident.steering.heading = spot.yaw;
    resident.insideBuildingId = spot.indoor ? spot.buildingId : null;
    resident.nodeKey = spot.nodeKey || resident.nodeKey;
    resident.task = { spot, phase: 'act', points: [], doors: [], index: 0, speed: 1.1, repickAt: this._dwellFor(resident, spot) };
    resident.actionKind = spot.pose || null;
  }

  /** One step of a resident's day. */
  _advanceDay(current, resident, dt, neighbours, player, held) {
    const block = blockAt(this._dayBlocks(current, resident), this.dayHour ?? 12);
    if (resident.block !== block) {
      resident.block = block;
      this._startTask(current, resident, block);
    }
    const task = resident.task;
    groundSettlementNpc(resident.root.position, this.walkableSurface);
    if (!task) { resident.dormant = false; resident.root.visible = true; return; }
    if (held) {
      stopResidentSteering(resident);
      resident.dormant = false; resident.root.visible = true;
      return;
    }
    if (task.phase === 'travel' && resident.follow) {
      const leader = resident.follow.leader;
      const position = resident.root.position;
      const apart = Math.hypot(leader.root.position.x - position.x, leader.root.position.z - position.z);
      if (leader.task?.phase === 'travel' && !leader.dormant && apart < 26 && current.residents.includes(leader)) {
        // Abreast on the right, then the left, then a step behind: how two or
        // three people walk and talk.
        const slot = FORMATION[resident.follow.slot] || FORMATION[FORMATION.length - 1];
        const h = leader.heading;
        const fx = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
        const target = {
          x: leader.root.position.x + rx * slot.right + fx * slot.ahead,
          z: leader.root.position.z + rz * slot.right + fz * slot.ahead,
        };
        for (const legs of leader.task.doors) {
          if (Math.hypot(position.x - legs.point.x, position.z - legs.point.z) < 2.4) {
            requestPortal(this.state, legs.door, resident.actorId);
            this.doorHolds.set(legs.door.id, this.simSeconds + 1.5);
          }
        }
        const movement = advanceNpcSteering(resident.steering, {
          position, target, dt, maxSpeed: leader.task.speed + 0.3, arrivalRadius: 0.9, stopRadius: 0.12,
          neighbours: neighbours.filter((n) => n.pos !== leader.root.position),
          resolveMovement: this.collisionIndex
            ? (next, previous) => this.collisionIndex.resolveMovement(next, previous, 0.29) : null,
        });
        resident.heading = movement.speed > 0.15 ? movement.heading : dampAngle(resident.heading, h, 4, dt);
        resident.root.rotation.y = resident.heading;
        groundSettlementNpc(position, this.walkableSurface);
        task.elapsed += dt;
        resident.actionKind = null; resident.dormant = false; resident.root.visible = true;
        return;
      }
      // The walk together is over: on to their own spot from here.
      resident.follow = null;
      resident.insideBuildingId = leader.insideBuildingId && apart < 3 ? leader.insideBuildingId : null;
      resident.nodeKey = this._nearestNode(current, position);
      const route = this._routeTo(current, resident, task.spot, null);
      task.points = route.points; task.doors = route.doors; task.index = 0;
    }
    if (task.phase === 'travel') {
      resident.actionKind = null;
      const position = resident.root.position;
      for (const legs of task.doors) {
        if (Math.hypot(position.x - legs.point.x, position.z - legs.point.z) < 2.4) {
          requestPortal(this.state, legs.door, resident.actorId);
          this.doorHolds.set(legs.door.id, this.simSeconds + 1.5);
        }
      }
      const target = task.points[task.index];
      const last = task.index >= task.points.length - 1;
      const movement = advanceNpcSteering(resident.steering, {
        position, target, nextTarget: target.interior ? null : task.points[task.index + 1] || null,
        dt, maxSpeed: task.speed, arrivalRadius: target.interior ? 0.12 : last ? 0.55 : 0.85,
        stopRadius: target.interior ? 0.04 : last ? 0.25 : 0.14,
        neighbours,
        resolveMovement: this.collisionIndex
          ? (next, previous) => this.collisionIndex.resolveMovement(next, previous, 0.29) : null,
      });
      resident.heading = movement.heading; resident.root.rotation.y = resident.heading;
      groundSettlementNpc(resident.root.position, this.walkableSurface);
      if (movement.arrived) task.index++;
      task.elapsed += dt;
      const playerDistance = Math.hypot(position.x - player.x, position.z - player.z);
      const unseen = playerDistance > 35;
      if (task.index >= task.points.length
        && Math.hypot(position.x - task.spot.x, position.z - task.spot.z) > 1.2) {
        // "Arrived" without being there: the steering wrote a blocked waypoint
        // off. Find the paths again from where they actually are.
        if (task.reroutes < 2 && !unseen) {
          task.reroutes++;
          resident.insideBuildingId = null;
          resident.nodeKey = this._nearestNode(current, position);
          const route = this._routeTo(current, resident, task.spot, null);
          task.points = route.points; task.doors = route.doors; task.index = 0;
          return;
        }
        this._snapToSpot(resident, task.spot);
      } else if (task.elapsed > 75 && unseen) {
        // Out of everyone's sight and still not there: they got there.
        this._snapToSpot(resident, task.spot);
        task.index = task.points.length;
      }
      if (task.index >= task.points.length) {
        task.phase = 'act';
        task.repickAt = this._dwellFor(resident, task.spot);
        resident.insideBuildingId = task.spot.indoor ? task.spot.buildingId : null;
        resident.nodeKey = task.spot.nodeKey || resident.nodeKey;
        stopResidentSteering(resident);
      }
      resident.dormant = false; resident.root.visible = true;
      return;
    }
    // Acting: settle onto the spot's facing and hold its pose.
    stopResidentSteering(resident);
    resident.heading = dampAngle(resident.heading, task.spot.yaw, 3, dt);
    resident.root.rotation.y = resident.heading;
    resident.actionKind = task.spot.pose || null;
    if (task.spot.kind === 'doorway') {
      const legs = doorLegs(current.buildingById.get(task.spot.buildingId));
      if (legs) { requestPortal(this.state, legs.door, resident.actorId); this.doorHolds.set(legs.door.id, this.simSeconds + 1.5); }
    }
    // Sleepers stay where they lie.
    if (block.activity !== 'sleep') {
      task.repickAt -= dt;
      if (task.repickAt <= 0) this._startTask(current, resident, block, { repick: true });
    }
    // Indoors and out of the player's way, a resident is out of sight and out
    // of the simulation; asleep, they are out of sight whoever is near,
    // unless the player is in the house with them.
    let dormant = false;
    if (task.phase === 'act' && task.spot.indoor) {
      const building = current.buildingById.get(task.spot.buildingId);
      const playerInside = building && pointInsideBuilding(building, player.x, player.z, 0.4);
      const distance = Math.hypot(resident.root.position.x - player.x, resident.root.position.z - player.z);
      dormant = !playerInside && (block.activity === 'sleep' || distance > DORMANT_RANGE);
    }
    resident.dormant = dormant;
    resident.root.visible = !dormant;
  }

  _drainPendingResidents(current, budget = RESIDENT_BUILD_PER_FRAME) {
    if (!current.pending.length) return;
    const count = Math.min(budget, current.pending.length);
    for (let i = 0; i < count; i++) {
      const item = current.pending.shift();
      const entity = this.state.entities[item.id];
      if (!entity || !canonicalResidentIsLocal(this.state, entity, current.site.id)) continue;
      const resident = buildResident(
        current.group, entity, item.home, item.index, this.npcAssets, this.state.worldSeed, this.state, null,
      );
      this._assignDay(current, resident, entity, item);
      // A village that has just come into view is already going about its
      // day: everyone starts where their plan has them. Someone arriving
      // later (back from a journey) walks in from their front door instead.
      if (current.age < 5) this._placeAtBlock(current, resident);
      groundSettlementNpc(resident.root.position, this.walkableSurface);
      resident.station = current.station;
      resident.journey = null;
      resident.groundY = resident.root.position.y;
      current.residents.push(resident);
    }
  }

  _reconcileCanonicalResidents(current) {
    if (!this.state.features.unifiedNpcMobilityEnabled) return;
    current.pending = current.pending.filter((item) => (
      canonicalResidentIsLocal(this.state, this.state.entities[item.id], current.site.id)
    ));
    for (let index = current.residents.length - 1; index >= 0; index--) {
      const resident = current.residents[index];
      if (resident.presence) continue;   // no canonical record
      const entity = this.state.entities[resident.actorId];
      if (canonicalResidentIsLocal(this.state, entity, current.site.id)) continue;
      // Someone the player is talking to keeps their body until the
      // conversation ends. This runs every frame, so the removal they are owed
      // lands on the first frame after the dialogue closes — but taking it now
      // would delete the speaker mid-sentence.
      if (this.isActorInDialogue(resident.actorId)) continue;
      for (let conversationIndex = current.conversations.length - 1;
        conversationIndex >= 0; conversationIndex--) {
        const conversation = current.conversations[conversationIndex];
        if (!conversation.actors.includes(resident)) continue;
        for (const actor of conversation.actors) actor.conversation = null;
        current.conversations.splice(conversationIndex, 1);
      }
      resident.root.removeFromParent();
      resident.avatar.dispose();
      current.residents.splice(index, 1);
      if (current.spotOwners.get(resident.task?.spot?.id) === resident.actorId) current.spotOwners.delete(resident.task.spot.id);
    }
    const claimed = new Set([
      ...current.residents.map((resident) => resident.actorId),
      ...current.pending.map((item) => item.id),
    ]);
    for (const [actorId, blueprint] of current.residentBlueprints || []) {
      if (claimed.has(actorId)
        || !canonicalResidentIsLocal(this.state, this.state.entities[actorId], current.site.id)) continue;
      current.pending.push(blueprint);
      claimed.add(actorId);
    }
  }

  reconcileCanonicalResidents() {
    for (const current of this.active.values()) this._reconcileCanonicalResidents(current);
  }

  /** Public settlement poses and persistent public changes for multiplayer. */
  sharedStateSnapshot() {
    const result = {};
    for (const current of this.active.values()) {
      const residents = {};
      for (const resident of current.residents || []) {
        if (resident.presence) continue;
        residents[resident.actorId] = {
          pose: {
            x: resident.root.position.x,
            y: resident.root.position.y,
            z: resident.root.position.z,
            yaw: resident.heading || resident.root.rotation.y || 0,
          },
          moving: !!resident.steering?.speed,
          state: resident.task?.phase === 'travel' ? 'walking' : resident.block?.activity || 'home',
          action: resident.actionKind || '',
          furniturePose: this.state.features.interiorsEnabled !== false && resident.task?.phase === 'act'
            && !this.isActorInDialogue(resident.actorId) ? resident.task.spot.furniturePose || null : null,
          hidden: !!resident.dormant,
        };
      }
      result[current.site.id] = {
        id: current.site.id,
        kind: current.site.kind,
        x: current.site.x,
        y: current.site.y,
        z: current.site.z,
        radius: current.site.radius,
        yaw: current.site.yaw || 0,
        generationVersion: current.site.generationVersion || 1,
        planHash: current.site.planHash || `${current.site.seed || 0}:${current.site.id}`,
        residents,
        publicState: {
          evolution: this.state.settlementEvolution?.[current.site.id] || null,
          delta: this.state.settlementDeltas?.[current.site.id] || null,
        },
      };
    }
    return result;
  }

  /** Apply public resident poses; geometry and identity remain local/deterministic. */
  applySharedState(shared = null) {
    this.sharedPresentation = shared && typeof shared === 'object' ? shared : null;
    const byId = {};
    for (const settlement of Object.values(this.sharedPresentation?.settlements || {})) {
      for (const [id, resident] of Object.entries(settlement.residents || {})) byId[id] = resident;
    }
    for (const current of this.active.values()) {
      for (const resident of current.residents || []) {
        const remote = byId[resident.actorId];
        resident.remotePose = remote?.pose ? { ...remote.pose } : null;
        resident.remoteState = remote ? { ...remote } : null;
      }
    }
    return this.sharedPresentation;
  }

  _unload(id) {
    const active = this.active.get(id); if (!active) return;
    active.releases.forEach((release) => release());
    for (const resident of active.residents) resident.avatar.dispose();
    this.root.remove(active.group); disposeTree(active.group); this.active.delete(id);
  }

  update(dt, player, {
    hours = 0, dayHour = null, dayIndex = null, active = true, simulate = active, interestPositions = [],
    interiorDay = 1, xr = false,
  } = {}) {
    // Time of day is the sky's, the one the player can see. The living-world
    // clock (`hours`) started at zero while the sky starts at dawn and never
    // follows a debug time jump, so routines keyed on it ran at arbitrary
    // visible hours — work at midnight, nobody about at noon.
    const visibleHours = Number.isFinite(dayHour)
      ? (Number.isFinite(dayIndex) ? dayIndex : 0) * 24 + dayHour : hours;
    this.dayHour = Number.isFinite(dayHour) ? dayHour : ((hours % 24) + 24) % 24;
    this.dayIndex = Number.isFinite(dayIndex) ? dayIndex : Math.floor(hours / 24);
    if (!this.state.features.settlementsEnabled) {
      this._finishLoading();
      for (const id of [...this.active.keys()]) this._unload(id);
      for (const marker of this.markers.values()) marker.visible = false;
      this.interiors.update(dt, player, { enabled: false });
      return;
    }
    const frontageEnabled = this.state.features.familyFrontageEnabled !== false;
    const managedVegetationEnabled = this.state.features.managedVegetationEnabled !== false;
    if (frontageEnabled !== this.frontageEnabled || managedVegetationEnabled !== this.managedVegetationEnabled) {
      this._finishLoading();
      for (const id of [...this.active.keys()]) this._unload(id);
      this.frontageEnabled = frontageEnabled;
      this.managedVegetationEnabled = managedVegetationEnabled;
    }
    const points = [player, ...(Array.isArray(interestPositions) ? interestPositions : [])]
      .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.z)));
    const interestSignature = points.map((point) => `${Math.round(point.x / 80)}:${Math.round(point.z / 80)}`).join('|');
    if (interestSignature !== this.lastInterestSignature
      || Math.hypot(player.x - this.lastQueryX, player.z - this.lastQueryZ) > 120
      || !Number.isFinite(this.lastQueryX)) {
      const byId = new Map();
      for (const point of points) {
        const found = [];
        settlementsAround(this.world, point.x, point.z, this.world.seed, QUERY_RADIUS, found);
        for (const site of found) if (!byId.has(site.id)) byId.set(site.id, site);
      }
      this.summaries = [...byId.values()];
      this._syncMarkers();
      this.lastQueryX = player.x; this.lastQueryZ = player.z;
      this.lastInterestSignature = interestSignature;
    }
    const distanceToInterest = (site) => points.reduce((best, point) => Math.min(best,
      Math.hypot(site.x - point.x, site.z - point.z)), Infinity);
    const desired = this.summaries.filter((site) => {
      if (!this.state.features.largeSettlementsEnabled && (site.kind === 'village' || site.kind === 'town')) return false;
      return distanceToInterest(site) < FULL_RADIUS + site.radius;
    }).sort((a, b) => distanceToInterest(a) - distanceToInterest(b)).slice(0, SETTLEMENT_BUDGETS.maxFullSettlements);
    const desiredIds = new Set(desired.map((site) => site.id));
    for (const id of [...this.active.keys()]) if (!desiredIds.has(id)) this._unload(id);
    // Rebuild only the managed static batch when a catalog LOD boundary is
    // crossed. Household, resident, frontage, and living-world lifecycles are
    // intentionally untouched.
    if (this.managedVegetationEnabled) for (const site of desired) {
      const current = this.active.get(site.id);
      if (current && current.managedVegetationDebug.lodSignature !== managedVegetationLodSignature(current.plan, player)) {
        current.group.remove(current.managedVegetationRoot);
        disposeTree(current.managedVegetationRoot);
        current.managedVegetationRoot = new THREE.Group();
        current.managedVegetationRoot.name = `${site.id}:managed-vegetation`;
        current.group.add(current.managedVegetationRoot);
        current.managedVegetationDebug = buildManagedVegetation(
          current.managedVegetationRoot, current.plan, this.vegetationLibrary, player,
        );
      }
    }
    // One village per frame, nearest first.
    //
    // Crossing a boundary can make two or three settlements desirable on the
    // same frame, and building them all in that frame is a visible stall even
    // when the layouts are cached — the geometry, batching and walkable claims
    // are the rest of the cost. `desired` is already sorted nearest-first, so
    // the one the player is walking towards is always the one that lands, and
    // the next follows on the next frame.
    //
    // And that one is built a few milliseconds a frame (_loadSteps) rather than
    // in one frame, unless the player is already at its edge — a spawn or a
    // jump into a village must not leave them standing in empty fields.
    if (!this.loading) {
      for (const site of desired) {
        if (this.active.has(site.id)) continue;
        this.loading = { site, steps: this._loadSteps(site, player) };
        break;
      }
    }
    const assemblyStarted = performance.now();
    if (this.loading) {
      const { site } = this.loading;
      // Only a genuinely occupied/spawned settlement may need synchronous
      // shell readiness. Interior geometry never takes this urgent path.
      const urgent = !this.active.size && distanceToInterest(site) < site.radius;
      const started = performance.now();
      for (;;) {
        const step = this.loading.steps.next();
        if (step.done) { this.active.set(site.id, step.value); this.loading = null; break; }
        if (!urgent && performance.now() - started > SETTLEMENT_LOAD_BUDGET_MS) break;
      }
    }
    this.interiors.update(dt, player, { day: interiorDay, time: this.simSeconds || 0, xr,
      enabled: this.state.features.interiorsEnabled !== false,
      decorations: this.state.features.interiorDecorationsEnabled !== false,
      budgetMs: Math.max(0, SETTLEMENT_LOAD_BUDGET_MS - (performance.now() - assemblyStarted)) });
    this.state.metrics.interior = { ...this.interiors.metrics };
    for (const [id, marker] of this.markers) {
      const site = this.summaries.find((item) => item.id === id);
      const allowed = this.state.features.largeSettlementsEnabled || (site?.kind !== 'village' && site?.kind !== 'town');
      marker.visible = allowed && !this.active.has(id);
    }
    const started = performance.now();
    this.frameIndex++;
    this.simSeconds = (this.simSeconds || 0) + Math.max(0, dt);
    this.doorHolds ||= new Map();
    if (simulate) advancePortals(this.state, dt);
    if (simulate && active && this.state.features.workRoutinesEnabled) advanceWorkRoutines(this.state, visibleHours);
    for (const current of this.active.values()) {
      // Every exterior door with its world point, worked out once per load
      // rather than refiltered for every building every frame — a denser
      // village core would otherwise make this loop the price of the density.
      current.doors ||= current.plan.buildings.flatMap((building) => building.portals
        .filter((p) => p.kind === 'exterior-door' || p.kind === 'back-door')
        .map((portal) => ({ building, portal, point: portalWorldPoint(building, portal) })));
      let nearInterior = false;
      for (const { building, portal, point } of current.doors) {
        let d = Infinity;
        for (const observer of points) d = Math.min(d, Math.hypot(point.x - observer.x, point.z - observer.z));
        // A guest may render the host's portal progress, but cannot mutate the
        // canonical door state from its own proximity loop. Accepted changes
        // arrive through the shared interaction branch on the next checkpoint.
        if (simulate) {
          if (this.state.features.enterableBuildingsEnabled && d < 2.4) requestPortal(this.state, portal, 'player');
          else if (d > 4.5 && !((this.doorHolds?.get(portal.id) || 0) > this.simSeconds)) closePortal(this.state, portal.id);
        } else if (this.state.features.enterableBuildingsEnabled && d < 2.4
          && this.requestInteraction) {
          const now = Date.now();
          const last = this.portalRequestAt.get(portal.id) || 0;
          if (now - last >= 750) {
            this.portalRequestAt.set(portal.id, now);
            this.requestInteraction({ kind: 'portal-open', portalId: portal.id });
          }
        }
        const record = this.state.portals[portal.id], pivot = current.doorMeshes.get(portal.id);
        if (pivot) pivot.rotation.y = -Math.PI * 0.52 * (record?.progress || 0);
        if (!nearInterior && Math.hypot(building.x - player.x, building.z - player.z) < INTERIOR_RADIUS) nearInterior = true;
      }
      current.group.visible = nearInterior || distanceToInterest(current.site) < FULL_RADIUS;
      for (const batch of current.doorBatches || []) syncDoorLeaves(batch, current.group);
      if (current.districtDetail) {
        const centre = current.plan.square || current.site;
        current.districtDetail.visible = Math.hypot(centre.x - player.x, centre.z - player.z) < DISTRICT_DETAIL_RADIUS;
      }
    }
    for (const current of this.active.values()) {
      this._reconcileCanonicalResidents(current);
      // Populate a little at a time. Nearest settlement first is implicit: the
      // desired list is sorted by distance, so the village you are walking into
      // fills before one two ridges away.
      this._drainPendingResidents(current);
      this._syncPresence(current, player);
      if (this.sharedPresentation) this.applySharedState(this.sharedPresentation);
      const buildings = new Map(current.plan.buildings.map((building) => [building.id, building]));
      current.age += Math.max(0, dt);
      syncWindowGlow(current, Math.max(0, dt));
      if (simulate) updateResidentConversations(current, dt, this.state, this.isActorInDialogue);
      // Neighbour positions, gathered once for the whole settlement.
      //
      // This used to be a filter+map per resident per frame: forty-five little
      // arrays built and thrown away every frame, times three villages. The
      // scratch buffer is refilled in place instead, and self is skipped by
      // index rather than by rebuilding the list without it.
      // Each entry is a live position plus the velocity it is walking at, so
      // steering can see people coming rather than only bump into them, and
      // the player is one of them: residents step round you instead of
      // through you.
      const neighbourPositions = current.neighbourScratch || (current.neighbourScratch = []);
      const records = current.neighbourRecords || (current.neighbourRecords = []);
      neighbourPositions.length = 0;
      for (let index = 0; index < current.residents.length; index++) {
        const other = current.residents[index];
        const record = records[index] || (records[index] = { pos: null, vx: 0, vz: 0, speed: 0 });
        record.pos = other.root.position;
        record.vx = other.steering.vx; record.vz = other.steering.vz; record.speed = other.steering.speed;
        neighbourPositions.push(record);
      }
      const playerRecord = this.playerRecord || (this.playerRecord = {
        x: player.x, z: player.z, vx: 0, vz: 0, speed: 0, radius: 0.38, minSeparation: 0.75, heavy: true,
      });
      if (dt > 1e-4 && playerRecord.frame !== this.frameIndex) {
        playerRecord.frame = this.frameIndex;
        playerRecord.vx = (player.x - playerRecord.x) / dt; playerRecord.vz = (player.z - playerRecord.z) / dt;
        playerRecord.speed = Math.hypot(playerRecord.vx, playerRecord.vz);
        if (playerRecord.speed > 8) { playerRecord.vx = 0; playerRecord.vz = 0; playerRecord.speed = 0; }   // a teleport, not a walk
      }
      playerRecord.x = player.x; playerRecord.z = player.z;
      playerRecord.y = player.y;
      neighbourPositions.push(playerRecord);

      for (let residentIndex = 0; residentIndex < current.residents.length; residentIndex++) {
        const resident = current.residents[residentIndex];
        // How often this one gets a turn. A villager on the far side of the
        // village moves at a quarter rate and nobody can tell; the same villager
        // updated every frame is a quarter of the frame budget spent on someone
        // who is forty metres away and facing the other way.
        const viewX = resident.remotePose?.x ?? resident.root.position.x;
        const viewZ = resident.remotePose?.z ?? resident.root.position.z;
        const viewDistance = Math.hypot(viewX - player.x, viewZ - player.z);
        const stride = viewDistance < RESIDENT_LOD_NEAR ? 1
          : viewDistance < RESIDENT_LOD_MID ? 2 : 4;
        resident.lodAccum = (resident.lodAccum || 0) + dt;
        // Phase by index so a village's residents do not all fall due together
        // and turn the saving back into a spike every fourth frame.
        if (stride > 1 && (this.frameIndex + residentIndex) % stride !== 0) continue;
        // Time is accumulated rather than dropped, so a strided resident walks
        // at the same speed — it just takes its steps in fewer, larger pieces.
        const residentDt = resident.lodAccum;
        resident.lodAccum = 0;

        const entity = this.state.entities[resident.actorId];
        const talkingToPlayerNow = this.isActorInDialogue(resident.actorId);

        if (resident.remotePose) {
          const previousX = resident.root.position.x, previousZ = resident.root.position.z;
          resident.root.position.set(
            Number(resident.remotePose.x) || 0,
            Number(resident.remotePose.y) || resident.root.position.y,
            Number(resident.remotePose.z) || 0,
          );
          resident.heading = Number(resident.remotePose.yaw) || resident.heading || 0;
          resident.root.visible = !resident.remoteState?.hidden;
          if (resident.remoteState?.hidden) continue;
          resident.root.rotation.y = resident.heading;
          resident.groundY = resident.root.position.y;
          const movedRemotely = Math.hypot(
            resident.root.position.x - previousX, resident.root.position.z - previousZ,
          ) > 1e-5;
          animateResident(resident, current.residents, residentDt, this.state, player,
            this.walkableSurface.queryProvider(), talkingToPlayerNow, movedRemotely, this.getSpeechPerformance(resident.actorId));
          continue;
        }

        // Their day, walked: where the plan has them now, how they get there,
        // and what they do once they arrive.
        const talkingToPlayer = this.isActorInDialogue(resident.actorId);
        const socialStop = !!resident.conversation || talkingToPlayer;
        const previousX = resident.root.position.x, previousZ = resident.root.position.z;
        const floorNeighbours = resident.floorNeighbourScratch || (resident.floorNeighbourScratch = []);
        floorNeighbours.length = 0;
        for (const other of neighbourPositions) if (Math.abs((other.pos?.y ?? other.y ?? 0) - resident.root.position.y) < 1.25) floorNeighbours.push(other);
        this._advanceDay(current, resident, residentDt, floorNeighbours, player, socialStop || resident.greetingLock > 0);
        if (resident.dormant) continue;
        const movingThisFrame = Math.hypot(
          resident.root.position.x - previousX, resident.root.position.z - previousZ,
        ) > 1e-5;
        resident.groundY = resident.root.position.y;
        animateResident(resident, current.residents, residentDt, this.state, player, this.walkableSurface.queryProvider(), talkingToPlayer, movingThisFrame, this.getSpeechPerformance(resident.actorId));
      }
    }
    if (simulate) this.evolutionTimer += dt;
    if (simulate && this.evolutionTimer >= 5 && this.state.features.settlementEvolutionEnabled) { this.evolutionTimer = 0; advanceSettlementEvolution(this.state, hours); }
    this.state.metrics.settlementSimulationMs += performance.now() - started; this.state.metrics.settlementSimulationSamples++;
  }

  updateLighting(dt, player, options = {}) {
    const actors = [...(options.actors || [])];
    for (const current of this.active.values()) actors.push(...current.residents);
    const debug = this.lighting.update(dt, player, { ...options, actors });
    this.state.metrics.villageLighting = { ...debug };
    return debug;
  }

  dispose() {
    this.interiors.dispose();
    this._finishLoading();
    for (const id of [...this.active.keys()]) this._unload(id);
    for (const marker of this.markers.values()) disposeTree(marker);
    this.markers.clear(); this.scene.remove(this.root);
    this.lighting.dispose();
    for (const instance of this.frontageMaterials.values()) instance.dispose?.();
    this.frontageMaterials.clear();
  }

  interactiveActors() {
    // Children look at you but do not talk; presence-only occupants are
    // scenery with a pulse.
    return [...this.active.values()].flatMap((current) => current.residents
      .filter((resident) => !resident.presence && residentAgeBand(resident) !== 'child'));
  }

  materializedActorIds() {
    return [...this.active.values()].flatMap((current) => current.residents
      .filter((resident) => !resident.presence).map((resident) => resident.actorId));
  }
}
