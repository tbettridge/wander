import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { settlementsAround } from './settlementplacement.mjs';
import { createSettlementPlan, portalWorldPoint } from './settlementplan.mjs';
import { groundSettlementNpc } from './settlementnpcgrounding.mjs';
import { buildingWorldPoint } from './buildingplan.mjs';
import { generateHouseholds } from './npchousehold.mjs';
import { activateSettlementResidents } from './npcresidenceregistry.mjs';
import { createSettlementResidentIdentity } from './npcresidentidentity.mjs';
import { assignWorkplacesAndRoutines, advanceWorkRoutines } from './npcroutine.mjs';
import { advancePortals, closePortal, ensurePortalState, requestPortal } from './portalstate.mjs';
import { advanceSettlementEvolution, recordSettlementPressure } from './settlementevolution.mjs';
import { SETTLEMENT_BUDGETS } from './settlementquality.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { advanceNpcLocomotion, createNpcLocomotionState } from './npclocomotion.mjs';
import { deriveNpcLoadout, freeGestureHand } from './npcitems.mjs';
import { advanceGaze, createGazeState, NOTICE, noticeOnApproach } from './npcgaze.mjs';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  deliberationLookAway, gestureAmount, nodPitch, pointAmount, pulseDelivery, SOCIAL,
} from './npcsocial.mjs';
import { beginNpcConversation, exchangeRumors } from './npcrumor.mjs';
import { advanceNpcSteering, createNpcSteeringState } from './npcsteering.mjs';
import { settlementPathRibbon } from './settlementground.mjs';
import { settlementOrigin } from './settlementorigin.mjs';
import { settlementDialogueAnchor } from './livingworldcontext.mjs?v=pointplaces1';
import { STONE_KINDS } from './settlementprops.mjs';
import { settlementAuthoritativeWaterAt, settlementBuildBlocker } from './settlementspatial.mjs';
import { dirtPainter, settlementSurfaceMesh } from './settlementsurface.mjs';
import { trailSurfaceMaterial } from './trailsurface.js?v=3';
import { materialVariantFor } from './xrmaterialvariants.mjs?v=2';
import { mulberry32 } from './noise.js';
import { buildScatterGroup } from './vegetation.js?v=4';
import {
  buildFamilyMark,
  buildPartialFence,
  buildServiceCue,
  buildYardElement,
  createFrontageMaterialLibrary,
} from './settlementfrontagevisuals.mjs';
import { buildFrontageApplication } from './settlementfrontageapplicationvisuals.sol.mjs';
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
const QUERY_RADIUS = 4300;
const INTERIOR_RADIUS = 85;
const WALL_THICKNESS = 0.28;
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

function addGableEnds(root, width, depth, rise, wallMaterial, baseY) {
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
  for (const z of [-depth / 2, depth / 2]) {
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

function windowOpenings(building, width) {
  // A church is lit by lancets: tall, narrow and set high, which is most of
  // what makes a nave wall read as a nave wall rather than a long cottage.
  if (building.program === 'church') {
    const height = building.floorCount * building.floorHeight;
    const count = Math.max(2, Math.floor(width / 3.4));
    const openings = [];
    for (let index = 0; index < count; index++) {
      const x = -width / 2 + (index + 0.5) * (width / count);
      openings.push({ x, bottom: height * 0.34, width: 0.86, height: height * 0.44 });
    }
    return openings;
  }
  const count = building.program === 'barn' ? 1 : Math.max(2, Math.floor(width / building.style.windowRhythm));
  const openings = [];
  for (let floor = 0; floor < building.floorCount; floor++) for (let index = 0; index < count; index++) {
    const x = -width / 2 + (index + 0.5) * (width / count);
    if (Math.abs(x) > 0.95 || floor > 0) openings.push({ x, bottom: floor * building.floorHeight + 0.86, width: 1.28, height: 1.38 });
  }
  return openings;
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
  const stone = material(building.materials.wall === 'stone' ? 0x8a8375 : 0xb3a88c);
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
  const trimColor = building.materials.wall === 'stone' ? 0x574b3d : 0x5d4630;
  const trim = material(trimColor), stone = material(0x625d52), wood = material(0x553720);
  const foundationDepth = Math.max(0.32, building.foundationDepth || 0.48);
  // Sized to the whole footprint, not the core, so a wing is seated on the same
  // plinth rather than appearing to float beside one.
  const fp = building.footprint || { halfWidth: w / 2, halfDepth: d / 2 };
  box(root, new THREE.BoxGeometry(fp.halfWidth * 2 + 0.5, foundationDepth, fp.halfDepth * 2 + 0.5), stone,
    0, 0.16 - foundationDepth / 2, 0);
  for (const opening of frontWindows) windowAssembly(root, opening, d / 2, trimColor);
  for (const opening of backWindows) windowAssembly(root, opening, -d / 2, trimColor);
  if (building.style.timberFrame) {
    for (const x of [-w / 2 + 0.12, 0, w / 2 - 0.12]) box(root, new THREE.BoxGeometry(0.18, h, 0.18), trim, x, h / 2, d / 2 + 0.17);
    for (let floor = 1; floor <= building.floorCount; floor++) box(root, new THREE.BoxGeometry(w, 0.16, 0.18), trim, 0, floor * building.floorHeight - 0.12, d / 2 + 0.17);
  }
  if (building.style.porch) {
    box(root, new THREE.BoxGeometry(Math.min(5.5, w * 0.62), 0.2, 1.8), wood, 0, 0.22, d / 2 + 0.8);
    for (const x of [-Math.min(2.2, w * 0.24), Math.min(2.2, w * 0.24)]) box(root, new THREE.BoxGeometry(0.18, 2.15, 0.18), wood, x, 1.25, d / 2 + 1.35);
    const canopy = box(root, new THREE.BoxGeometry(Math.min(6, w * 0.68), 0.18, 2.0), material(0x494238), 0, 2.35, d / 2 + 0.82);
    canopy.rotation.x = -0.08;
  }
  if (building.style.chimney) box(root, new THREE.BoxGeometry(0.72, 2.3, 0.72), material(0x61564a), w * 0.24, h + 1.15, -d * 0.12);
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

function buildBuilding(group, building, doorMeshes, signSpec = null) {
  const root = new THREE.Group(); root.position.set(building.x, building.y, building.z); root.rotation.y = building.yaw; root.userData.buildingId = building.id; group.add(root);
  const wall = material(building.materials.wall === 'stone' ? 0x817b6e : 0xc6b995);
  const roof = material(building.materials.roof === 'slate' ? 0x41494c : 0x7c6541);
  const wood = material(0x5a3925); const floor = material(0x76654d);
  const h = building.floorCount * building.floorHeight, w = building.width, d = building.depth;
  const frontDoor = building.portals.find((portal) => portal.kind === 'exterior-door');
  const allWindows = windowOpenings(building, w);
  const frontWindows = allWindows.filter((opening) => Math.abs(opening.x - frontDoor.x) > (opening.width + frontDoor.width) / 2 + 0.12 || opening.bottom >= frontDoor.height);
  const backWindows = allWindows;
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
  addWallWithOpenings(root, w, h, -d / 2, wall, backWindows);
  addWallWithOpenings(root, w, h, d / 2, wall, [...frontWindows, { x: frontDoor.x, bottom: 0, width: frontDoor.width, height: frontDoor.height }]);
  const doorPivot = new THREE.Group(); doorPivot.position.set(frontDoor.x - frontDoor.width / 2, 0, d / 2); root.add(doorPivot);
  const door = box(doorPivot, new THREE.BoxGeometry(frontDoor.width, frontDoor.height, 0.12), wood, frontDoor.width / 2, frontDoor.height / 2, 0);
  door.castShadow = true; doorPivot.userData.dynamicStructure = true; doorMeshes.set(frontDoor.id, doorPivot);
  for (let i = 1; i < building.rooms.length; i++) {
    const z = -d / 2 + d / building.rooms.length * i;
    const portal = building.portals.find((p) => p.kind === 'interior-door' && p.toRoomId === building.rooms[i].id);
    addWallWithOpenings(root, w, building.floorHeight, z, wall, [{
      x: portal.x, bottom: 0, width: portal.width, height: portal.height,
    }]);
  }
  const rise = Math.max(1.3, w * building.roof.pitch * 0.34);
  addRoof(root, w + 1.0, d + 1.0, rise, building.roof.kind, roof, h);
  if (building.roof.kind !== 'hip') addGableEnds(root, w, d, rise, wall, h);
  // Wings, towers, spires and lean-tos. Drawn after the core so a mass that
  // abuts it overlaps rather than leaving a seam at the join.
  for (const item of building.masses || []) {
    if (item.role === 'core') continue;
    addMass(root, item, wall, roof, building);
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

function buildGroundTreatment(group, plan, world) {
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
  for (const path of plan.paths) {
    const mesh = new THREE.Mesh(pathGeometry(world, path), pathMat);
    // These ribbons only tint the terrain. They must never enter the sun's
    // shadow pass: even a centimetre-high overlay otherwise produces the dark
    // duplicate band visible beneath settlement lanes.
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.renderOrder = 2; group.add(mesh);
  }
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

function homeLoiterWaypoints(building) {
  const points = [], outside = (x, z) => ({ x, z, inside: false }), inside = (x, z) => ({ x, z, inside: true });
  const rooms = building.rooms;
  const roomCenter = (room) => inside((room.bounds.minX + room.bounds.maxX) / 2, (room.bounds.minZ + room.bounds.maxZ) / 2);
  points.push(roomCenter(rooms[0]));
  for (let index = 1; index < rooms.length; index++) {
    const portal = building.portals.find((entry) => entry.kind === 'interior-door' && entry.toRoomId === rooms[index].id);
    points.push(inside(portal.x, portal.z - 0.58), inside(portal.x, portal.z + 0.58), roomCenter(rooms[index]));
  }
  const door = building.portals.find((entry) => entry.kind === 'exterior-door');
  points.push(inside(door.x, building.depth / 2 - 0.72), outside(door.x, building.depth / 2 + 0.82));
  const edgeX = building.width / 2 + 1.35, edgeZ = building.depth / 2 + 1.35;
  points.push(
    outside(-edgeX, edgeZ), outside(-edgeX, -edgeZ), outside(0, -edgeZ - 0.5),
    outside(edgeX, -edgeZ), outside(edgeX, edgeZ), outside(door.x, building.depth / 2 + 0.82),
    inside(door.x, building.depth / 2 - 0.72), roomCenter(rooms[rooms.length - 1]),
  );
  for (let index = rooms.length - 1; index >= 1; index--) {
    const portal = building.portals.find((entry) => entry.kind === 'interior-door' && entry.toRoomId === rooms[index].id);
    points.push(inside(portal.x, portal.z + 0.58), inside(portal.x, portal.z - 0.58), roomCenter(rooms[index - 1]));
  }
  return points.map((point) => ({ ...buildingWorldPoint(building, point.x, point.z), inside: point.inside }));
}

function resetLoiterRoute(resident, building) {
  const points = homeLoiterWaypoints(building);
  let nearest = 0, nearestDistance = Infinity;
  for (let index = 0; index < points.length; index++) {
    const distance = Math.hypot(points[index].x - resident.root.position.x, points[index].z - resident.root.position.z);
    if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
  }
  resident.loiter = {
    buildingId: building.id, points, index: nearest,
    direction: resident.householdIndex % 2 ? -1 : 1,
    dwell: 0.25 + resident.identity.animation.phase % 0.65,
  };
}

/** A point behind a stall's counter, where the person selling would stand. */
function behindStall(stall, across = 0, back = 1.05) {
  // The stall faces the square, so its local +z is toward the crowd and the
  // trader's side is -z.
  const c = Math.cos(stall.yaw), s = Math.sin(stall.yaw);
  return { x: stall.x + across * c - back * s, z: stall.z - across * s - back * c };
}

/** A point in front of a stall, where someone buying would stand. */
function beforeStall(stall, across = 0, out = 1.5) {
  const c = Math.cos(stall.yaw), s = Math.sin(stall.yaw);
  return { x: stall.x + across * c + out * s, z: stall.z - across * s + out * c };
}

/**
 * The round a villager posted to the square walks.
 *
 * A merchant barely moves: a step either way behind their own counter is the
 * whole of it, because someone selling fish who wanders off is not selling
 * fish. A customer walks the market — the fronts of several stalls, the well,
 * back again — which is what makes the square look busy rather than occupied.
 */
function squarePostWaypoints(post, plan, seed) {
  const rng = mulberry32(seed >>> 0);
  if (post.kind === 'merchant' && post.stall) {
    return [
      behindStall(post.stall, -0.45), behindStall(post.stall, 0.4),
      behindStall(post.stall, 0.1, 1.25), behindStall(post.stall, -0.2),
    ];
  }
  const stalls = plan.props.filter((prop) => prop.kind === 'market-stall');
  const well = plan.props.find((prop) => prop.kind === 'well');
  const points = [];
  if (stalls.length) {
    // A different handful of stalls per customer, so the market does not turn
    // into a queue of people walking the same circuit in step.
    const start = Math.floor(rng() * stalls.length);
    const visits = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < visits; i++) {
      const stall = stalls[(start + i * (1 + Math.floor(rng() * 2))) % stalls.length];
      points.push(beforeStall(stall, (rng() - 0.5) * 1.2, 1.4 + rng() * 0.8));
    }
  }
  if (well) {
    const angle = rng() * Math.PI * 2, radius = well.radius + 1.5 + rng() * 1.6;
    points.push({ x: well.x + Math.cos(angle) * radius, z: well.z + Math.sin(angle) * radius });
  }
  // Somewhere out in the open, so nobody is only ever pressed against furniture.
  const drift = rng() * Math.PI * 2, out = plan.square.radius * (0.35 + rng() * 0.4);
  points.push({ x: plan.square.x + Math.cos(drift) * out, z: plan.square.z + Math.sin(drift) * out });
  return points.length >= 2 ? points : [
    { x: plan.square.x + 2, z: plan.square.z },
    { x: plan.square.x - 2, z: plan.square.z },
  ];
}

/**
 * Advance someone whose business is the square rather than a building.
 *
 * Shares the steering and the ground query with the house-dwellers' loiter, but
 * walks a list of square points instead of a circuit around one building.
 */
function advanceSquarePost(resident, dt, walkableSurface, held, neighbours, collisionIndex) {
  const post = resident.post;
  groundSettlementNpc(resident.root.position, walkableSurface);
  if (held) { stopResidentSteering(resident); return; }
  if (post.dwell > 0) {
    stopResidentSteering(resident);
    post.dwell -= Math.max(0, dt);
    return;
  }
  const waypoint = post.points[post.index];
  const nextIndex = (post.index + 1) % post.points.length;
  const movement = advanceNpcSteering(resident.steering, {
    position: resident.root.position, target: waypoint, nextTarget: post.points[nextIndex],
    dt, maxSpeed: post.kind === 'merchant' ? 0.72 : 1.02,
    arrivalRadius: 0.55, stopRadius: 0.1,
    neighbours,
    resolveMovement: collisionIndex
      ? (position, previous) => collisionIndex.resolveMovement(position, previous, 0.29) : null,
  });
  resident.heading = movement.heading;
  resident.root.rotation.y = resident.heading;
  // Collision may have accepted a point on an authored square fixture or
  // nearby foundation. Never carry the height from the start of the step.
  groundSettlementNpc(resident.root.position, walkableSurface);
  if (movement.arrived) {
    post.index = nextIndex;
    // A trader stands still for a long time; a shopper pauses to look and moves on.
    post.dwell = post.kind === 'merchant'
      ? 4.5 + resident.emote.rng() * 7
      : 1.6 + resident.emote.rng() * 4.5;
    stopResidentSteering(resident);
  }
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

function advanceResidentLoiter(resident, building, dt, world, walkableSurface, held = false, neighbours = [], collisionIndex = null) {
  if (resident.loiter?.buildingId !== building.id) resetLoiterRoute(resident, building);
  groundSettlementNpc(resident.root.position, walkableSurface);
  if (held) { stopResidentSteering(resident); return; }
  const loiter = resident.loiter;
  if (loiter.dwell > 0) {
    stopResidentSteering(resident);
    loiter.dwell -= Math.max(0, dt);
    return;
  }
  const waypoint = loiter.points[loiter.index];
  const nextIndex = (loiter.index + loiter.direction + loiter.points.length) % loiter.points.length;
  const movement = advanceNpcSteering(resident.steering, {
    position: resident.root.position, target: waypoint, nextTarget: loiter.points[nextIndex], dt, maxSpeed: 1.08,
    arrivalRadius: 0.62, stopRadius: 0.1,
    neighbours: neighbours.filter((other) => other !== resident).map((other) => other.root.position),
    resolveMovement: collisionIndex ? (position, previous) => collisionIndex.resolveMovement(position, previous, 0.29) : null,
  });
  resident.heading = movement.heading; resident.root.rotation.y = resident.heading;
  // Home routes cross the visible foundation at the doorway. Re-sample after
  // collision so residents walking onto it stand on its claim immediately,
  // rather than clipping through it at the old terrain height.
  groundSettlementNpc(resident.root.position, walkableSurface);
  if (movement.arrived) {
    loiter.index = (loiter.index + loiter.direction + loiter.points.length) % loiter.points.length;
    loiter.dwell = 0.35 + resident.emote.rng() * 1.35;
    stopResidentSteering(resident);
  }
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
    homeBuildingId: building.id, currentBuildingId: building.id, targetBuildingId: building.id,
    householdIndex: index,
    route: [], routeIndex: 0, phase: index * 1.7,
    locomotion: createNpcLocomotionState(identity.animation.phase / (Math.PI * 2)),
    steering: createNpcSteeringState(building.yaw),
    worldDims: npcWorldDimensions(avatar.dims, identity.proportions),
    gaze: createGazeState(identity.seed ^ 0x9e37, identity.animation.phase),
    emote: createEmote(identity.seed ^ 0x5eed),
    conversation: null, conversationSide: 0,
    heading: building.yaw, loiter: null,
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

function animateResident(resident, neighbours, dt, state, player, surfaceQuery, talkingToPlayer = false, moving = false) {
  const root = resident.root;
  const playerDistance = Math.hypot(root.position.x - player.x, root.position.z - player.z);
  if (playerDistance < NOTICE.nearRange && !resident.playerWasNear) {
    resident.playerWasNear = true;
    let crowd = 0;
    for (const other of neighbours) {
      if (other === resident) continue;
      if (Math.hypot(other.root.position.x - root.position.x,
        other.root.position.z - root.position.z) < NOTICE.crowdRadius) crowd++;
    }
    const notice = noticeOnApproach(resident.gaze.rng, crowd);
    resident.greetingDelay = notice ? notice.delay : -1;
    resident.greetingHold = notice ? notice.hold : 0;
  } else if (playerDistance > NOTICE.forgetRange) resident.playerWasNear = false;
  if (resident.greetingDelay >= 0) {
    resident.greetingDelay -= Math.max(0, dt);
    if (resident.greetingDelay <= 0) {
      resident.greetingDelay = -1;
      // A look scheduled for later EXPIRES if you have moved on by the time it
      // comes round. Someone turning to watch you from across the square
      // seconds after you left is worse than not looking at all.
      if (playerDistance < NOTICE.nearRange) {
        resident.greetingLock = resident.greetingHold || NOTICE.holdMin;
        pulseDelivery(resident.emote);
      }
    }
  }
  resident.greetingLock = Math.max(0, resident.greetingLock - Math.max(0, dt));
  advanceEmote(resident.emote, dt);
  const partner = resident.conversation?.actors[1 - resident.conversationSide] || null;
  const socialMotion = residentSocialMotion(resident, talkingToPlayer, moving);
  // Pointing outranks facing a conversation partner. The arm aims straight
  // ahead of the body, so the body is what actually carries the direction --
  // squaring up is the gesture, and the raised arm only reads it out.
  const pointing = pointAmount(resident.emote);
  if (pointing > 0.01) {
    resident.heading = dampAngle(resident.heading, resident.emote.pointBearing, 7, dt);
    root.rotation.y = resident.heading;
  } else if (socialMotion.faceWithRoot) {
    const target = partner?.root.position || player;
    resident.heading = dampAngle(resident.heading, Math.atan2(target.x - root.position.x, target.z - root.position.z), 5.5, dt);
    root.rotation.y = resident.heading;
  }
  const pose = advanceNpcLocomotion(resident.locomotion, {
    dims: resident.worldDims,
    dt: Math.max(0, dt),
    position: [root.position.x, root.position.y, root.position.z],
    heading: root.rotation.y,
    surfaceQuery,
    distance: playerDistance,
    held: socialMotion.held,
    talking: !!partner || talkingToPlayer,
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
    pointPitch: 0.10,
    pointHand: freeHand || resident.identity.animation.gestureHand,
  });
  let nearest = null, nearestDistance = 9;
  for (const other of neighbours) if (other !== resident) {
    const separation = Math.hypot(other.root.position.x - root.position.x, other.root.position.z - root.position.z);
    if (separation < nearestDistance) { nearest = other; nearestDistance = separation; }
  }
  const gaze = advanceGaze(resident.gaze, dt, {
    player: playerDistance < 14 ? residentLookAt(resident, player.x, player.y + 1.62, player.z) : null,
    neighbour: nearest ? residentLookAt(resident, nearest.root.position.x, residentEyeHeight(nearest), nearest.root.position.z) : null,
    vista: { yaw: 0, pitch: -0.04 },
    // Composing an answer looks like looking away. Village residents get the
    // same rhythm as platform residents; without it the several seconds an
    // on-device reply takes are several seconds of an unbroken stare.
    lockOn: talkingToPlayer && deliberationLookAway(resident.emote) ? 'glance'
      : (partner ? 'neighbour' : (resident.greetingLock > 0 || talkingToPlayer ? 'player' : null)),
    playerInterest: Math.max(0, Math.min(1, 1 - (playerDistance - 3) / 11)),
    moving: speed > 0.12,
  });
  resident.avatar.rig.head.rotation.set(gaze.pitch + nodPitch(resident.emote), gaze.yaw, Math.sin(resident.gaze.t * 0.47) * 0.018);
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
    if (a.conversation || b.conversation || a.homeBuildingId !== b.homeBuildingId) continue;
    if (isActorInDialogue(a.actorId) || isActorInDialogue(b.actorId)) continue;
    if (a.routeIndex < a.route.length || b.routeIndex < b.route.length) continue;
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

function routeBetweenBuildings(plan, fromBuildingId, toBuildingId) {
  const nodes = new Map(plan.localGraph.nodes.map((node) => [node.key, node]));
  const from = plan.localGraph.nodes.find((node) => node.buildingId === fromBuildingId);
  const to = plan.localGraph.nodes.find((node) => node.buildingId === toBuildingId);
  if (!from || !to) return [];
  if (from.key === to.key) return [{ x: to.x, y: to.y, z: to.z }];
  const edges = new Map([...nodes.keys()].map((key) => [key, []]));
  for (const path of plan.paths) {
    const cost = path.points.reduce((sum, point, index) => index ? sum + Math.hypot(point.x - path.points[index - 1].x, point.z - path.points[index - 1].z) : 0, 0);
    edges.get(path.from)?.push({ to: path.to, cost, points: path.points });
    edges.get(path.to)?.push({ to: path.from, cost, points: path.points.slice().reverse() });
  }
  const open = [{ key: from.key, cost: 0 }], best = new Map([[from.key, 0]]), previous = new Map();
  while (open.length) {
    open.sort((a, b) => a.cost - b.cost); const current = open.shift();
    if (current.key === to.key) break;
    if (current.cost !== best.get(current.key)) continue;
    for (const edge of edges.get(current.key) || []) {
      const cost = current.cost + edge.cost;
      if (cost >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, cost); previous.set(edge.to, { from: current.key, edge }); open.push({ key: edge.to, cost });
    }
  }
  if (!previous.has(to.key)) return [{ x: to.x, y: to.y, z: to.z }];
  const legs = [];
  for (let key = to.key; key !== from.key;) { const item = previous.get(key); legs.push(item.edge.points); key = item.from; }
  return legs.reverse().flatMap((points, index) => index ? points.slice(1) : points);
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
    isActorInDialogue = () => false, vegetationLibrary = null,
    onPlanActivated = null,
  } = {}) {
    this.scene = scene; this.world = world; this.walkableSurface = walkableSurface; this.state = state; this.collisionIndex = collisionIndex;
    this.root = new THREE.Group(); this.root.name = 'living-settlements'; scene.add(this.root);
    this.npcAssets = new NpcAssetLibrary();
    this.frontageMaterials = createFrontageMaterialLibrary(THREE);
    this.vegetationLibrary = vegetationLibrary;
    this.frontageEnabled = this.state.features?.familyFrontageEnabled !== false;
    this.managedVegetationEnabled = this.state.features?.managedVegetationEnabled !== false;
    this.isActorInDialogue = isActorInDialogue;
    this.onPlanActivated = typeof onPlanActivated === 'function' ? onPlanActivated : null;
    this.active = new Map(); this.markers = new Map(); this.summaries = []; this.lastQueryX = Infinity; this.lastQueryZ = Infinity; this.evolutionTimer = 0;
    this.frameIndex = 0;
  }

  resetRegion(world = this.world, state = this.state) {
    for (const id of [...this.active.keys()]) this._unload(id);
    for (const marker of this.markers.values()) disposeTree(marker);
    this.markers.clear();
    this.world = world;
    this.state = state;
    this.frontageEnabled = this.state.features?.familyFrontageEnabled !== false;
    this.managedVegetationEnabled = this.state.features?.managedVegetationEnabled !== false;
    this.summaries.length = 0;
    this.lastQueryX = Infinity;
    this.lastQueryZ = Infinity;
    this.evolutionTimer = 0;
    this.frameIndex = 0;
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

  _load(site, viewer = null) {
    // The same blocker the vegetation layer plans against. Two systems building
    // the same settlement from different rules is how grass ends up cleared
    // around houses that were moved somewhere else.
    const origin = settlementOrigin(this.world, site);
    const basePlan = createSettlementPlan(site, {
      heightAt: (x, z) => this.world.height(x, z),
      blockedAt: settlementBuildBlocker(this.world, site),
      authoritativeWaterAt: (x, z) => settlementAuthoritativeWaterAt(this.world, x, z),
      // Must match what the vegetation layer plans against, or the two build
      // different villages and grass is cleared around houses that moved.
      origin,
    });
    const plan = { ...basePlan };
    plan.businessSigns = planSettlementBusinessSigns(plan);
    const group = new THREE.Group(); group.name = site.id; this.root.add(group);
    buildGroundTreatment(group, plan, this.world);
    const doorMeshes = new Map();
    const buildingRoots = new Map();
    const signByBuilding = new Map(plan.businessSigns.map((sign) => [sign.buildingId, sign]));
    for (const building of plan.buildings) buildingRoots.set(
      building.id, buildBuilding(group, building, doorMeshes, signByBuilding.get(building.id) || null),
    );
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
      }
    }
    // Before the merge, deliberately. A well and six stalls are around sixty
    // small meshes; left out of the static batch they would be sixty draw calls
    // per village, every frame, for scenery that never moves.
    buildProps(group, plan);
    mergeStaticSettlementMeshes(group);
    // Managed vegetation is a separate static batch so catalog LOD crossings
    // can rebuild scenery without unloading residents or touching their state.
    const managedVegetationRoot = new THREE.Group();
    managedVegetationRoot.name = `${site.id}:managed-vegetation`; group.add(managedVegetationRoot);
    const managedVegetationDebug = this.managedVegetationEnabled
      ? buildManagedVegetation(managedVegetationRoot, plan, this.vegetationLibrary, viewer)
      : { placements: 0, meshes: 0, triangles: 0, near: 0, far: 0, culled: 0, lodSignature: 'disabled' };
    const releases = plan.claims.map((claim) => this.walkableSurface.registerClaim(claim));
    if (this.collisionIndex) {
      const collisionPlan = {
        ...plan,
        familyFrontages: this.frontageEnabled ? plan.familyFrontages : [],
        managedVegetation: this.managedVegetationEnabled ? plan.managedVegetation : { placements: [] },
      };
      releases.push(this.collisionIndex.registerPlan(collisionPlan));
    }
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
          }
        });
      });
      if (thinned) {
        // Half the village is in the square: one trader behind each stall, and
        // the rest walking the market. Taken from the back of the list so the
        // households at the front keep both of theirs and the thinning is not
        // doubled up on the same houses.
        const wanted = Math.floor(pending.length / 2);
        const stallCount = squarePosts.length;
        for (let i = 0; i < wanted; i++) {
          const entry = pending[pending.length - 1 - i];
          if (!entry) break;
          const merchant = i < stallCount;
          entry.post = merchant
            ? { kind: 'merchant', stall: squarePosts[i] }
            : { kind: 'customer', stall: null };
        }
      }
    }
    for (const building of plan.buildings) for (const portal of building.portals) ensurePortalState(this.state, portal);
    recordSettlementPressure(this.state, site.id);
    this.state.metrics.settlementsGenerated++;
    try { this.onPlanActivated?.(plan, activatedPopulation); } catch { /* cataloging is optional */ }
    const station = settlementDialogueAnchor(site, origin);
    return {
      site, plan, group, doorMeshes, releases, residents: [], pending,
      residentBlueprints, station,
      frontageBuilt, frontageDebug, managedVegetationRoot, managedVegetationDebug,
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
  _drainPendingResidents(current, budget = RESIDENT_BUILD_PER_FRAME) {
    if (!current.pending.length) return;
    const count = Math.min(budget, current.pending.length);
    for (let i = 0; i < count; i++) {
      const item = current.pending.shift();
      const entity = this.state.entities[item.id];
      if (!entity || !canonicalResidentIsLocal(this.state, entity, current.site.id)) continue;
      let spawn = null;
      if (item.post) {
        spawn = item.post.kind === 'merchant'
          ? behindStall(item.post.stall)
          : beforeStall(current.plan.props.find((p) => p.kind === 'market-stall'), 0, 3.2);
        spawn = { ...spawn, y: item.home.y, yaw: item.post.stall?.yaw ?? 0 };
      }
      const resident = buildResident(
        current.group, entity, item.home, item.index, this.npcAssets, this.state.worldSeed, this.state, spawn,
      );
      if (item.post) {
        const seed = (resident.identity.seed ^ 0x5a1e) >>> 0;
        resident.post = {
          ...item.post, index: 0, dwell: (seed % 900) / 300,
          points: squarePostWaypoints(item.post, current.plan, seed),
        };
      }
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

  _unload(id) {
    const active = this.active.get(id); if (!active) return;
    active.releases.forEach((release) => release());
    for (const resident of active.residents) resident.avatar.dispose();
    this.root.remove(active.group); disposeTree(active.group); this.active.delete(id);
  }

  update(dt, player, { hours = 0, active = true } = {}) {
    if (!this.state.features.settlementsEnabled) {
      for (const id of [...this.active.keys()]) this._unload(id);
      for (const marker of this.markers.values()) marker.visible = false;
      return;
    }
    const frontageEnabled = this.state.features.familyFrontageEnabled !== false;
    const managedVegetationEnabled = this.state.features.managedVegetationEnabled !== false;
    if (frontageEnabled !== this.frontageEnabled || managedVegetationEnabled !== this.managedVegetationEnabled) {
      for (const id of [...this.active.keys()]) this._unload(id);
      this.frontageEnabled = frontageEnabled;
      this.managedVegetationEnabled = managedVegetationEnabled;
    }
    if (Math.hypot(player.x - this.lastQueryX, player.z - this.lastQueryZ) > 120 || !Number.isFinite(this.lastQueryX)) {
      settlementsAround(this.world, player.x, player.z, this.world.seed, QUERY_RADIUS, this.summaries);
      this._syncMarkers();
      this.lastQueryX = player.x; this.lastQueryZ = player.z;
    }
    const desired = this.summaries.filter((site) => {
      if (!this.state.features.largeSettlementsEnabled && (site.kind === 'village' || site.kind === 'town')) return false;
      return Math.hypot(site.x - player.x, site.z - player.z) < FULL_RADIUS + site.radius;
    }).sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z)).slice(0, SETTLEMENT_BUDGETS.maxFullSettlements);
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
    for (const site of desired) if (!this.active.has(site.id)) this.active.set(site.id, this._load(site, player));
    for (const [id, marker] of this.markers) {
      const site = this.summaries.find((item) => item.id === id);
      const allowed = this.state.features.largeSettlementsEnabled || (site?.kind !== 'village' && site?.kind !== 'town');
      marker.visible = allowed && !this.active.has(id);
    }
    const started = performance.now();
    this.frameIndex++;
    advancePortals(this.state, dt);
    if (active && this.state.features.workRoutinesEnabled) advanceWorkRoutines(this.state, hours);
    for (const current of this.active.values()) for (const building of current.plan.buildings) {
      for (const portal of building.portals.filter((p) => p.kind === 'exterior-door')) {
        const point = portalWorldPoint(building, portal), d = Math.hypot(point.x - player.x, point.z - player.z);
        if (this.state.features.enterableBuildingsEnabled && d < 2.4) requestPortal(this.state, portal, 'player');
        else if (d > 4.5) closePortal(this.state, portal.id);
        const record = this.state.portals[portal.id], pivot = current.doorMeshes.get(portal.id);
        if (pivot) pivot.rotation.y = -Math.PI * 0.52 * (record?.progress || 0);
      }
      const nearInterior = Math.hypot(building.x - player.x, building.z - player.z) < INTERIOR_RADIUS;
      current.group.visible = nearInterior || Math.hypot(current.site.x - player.x, current.site.z - player.z) < FULL_RADIUS;
    }
    for (const current of this.active.values()) {
      this._reconcileCanonicalResidents(current);
      // Populate a little at a time. Nearest settlement first is implicit: the
      // desired list is sorted by distance, so the village you are walking into
      // fills before one two ridges away.
      this._drainPendingResidents(current);
      const buildings = new Map(current.plan.buildings.map((building) => [building.id, building]));
      updateResidentConversations(current, dt, this.state, this.isActorInDialogue);
      // Neighbour positions, gathered once for the whole settlement.
      //
      // This used to be a filter+map per resident per frame: forty-five little
      // arrays built and thrown away every frame, times three villages. The
      // scratch buffer is refilled in place instead, and self is skipped by
      // index rather than by rebuilding the list without it.
      const neighbourPositions = current.neighbourScratch || (current.neighbourScratch = []);
      neighbourPositions.length = 0;
      for (const other of current.residents) neighbourPositions.push(other.root.position);

      for (let residentIndex = 0; residentIndex < current.residents.length; residentIndex++) {
        const resident = current.residents[residentIndex];
        // How often this one gets a turn. A villager on the far side of the
        // village moves at a quarter rate and nobody can tell; the same villager
        // updated every frame is a quarter of the frame budget spent on someone
        // who is forty metres away and facing the other way.
        const viewDistance = Math.hypot(
          resident.root.position.x - player.x, resident.root.position.z - player.z,
        );
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

        // Someone posted to the square has no commute: their day is the market.
        if (resident.post) {
          const previousSquareX = resident.root.position.x, previousSquareZ = resident.root.position.z;
          advanceSquarePost(
            resident, residentDt, this.walkableSurface,
            !!resident.conversation || resident.greetingLock > 0 || talkingToPlayerNow,
            neighbourPositions, this.collisionIndex,
          );
          resident.groundY = resident.root.position.y;
          const movedInSquare = Math.hypot(
            resident.root.position.x - previousSquareX, resident.root.position.z - previousSquareZ,
          ) > 1e-5;
          animateResident(resident, current.residents, residentDt, this.state, player,
            this.walkableSurface.queryProvider(), talkingToPlayerNow, movedInSquare);
          continue;
        }

        // Keyed, not scanned. assignWorkplacesAndRoutines names this
        // `routine:<actorId>:work`, so the old Object.values(...).find() walked
        // every routine in every loaded settlement once per resident per frame.
        const routine = this.state.routines?.[`routine:${resident.actorId}:work`];
        const home = buildings.get(resident.homeBuildingId);
        const workplace = buildings.get(routine?.workplaceId);
        const target = routine?.state === 'working' && workplace ? workplace : home;
        if (!target) continue;
        if (target.id !== resident.targetBuildingId) {
          resident.targetBuildingId = target.id;
          resident.route = routeBetweenBuildings(current.plan, resident.currentBuildingId, target.id);
          resident.routeIndex = 0;
        }
        const talkingToPlayer = this.isActorInDialogue(resident.actorId);
        const socialStop = !!resident.conversation || talkingToPlayer;
        const previousX = resident.root.position.x, previousZ = resident.root.position.z;
        if (resident.routeIndex < resident.route.length) {
          if (socialStop) {
            // Preserve the active waypoint while dialogue/conversation owns the
            // resident. Locomotion will be held below because the root remains
            // stationary; the route resumes from this exact index afterward.
            stopResidentSteering(resident);
          } else {
            const waypoint = resident.route[resident.routeIndex];
            const movement = advanceNpcSteering(resident.steering, {
              position: resident.root.position, target: waypoint,
              nextTarget: resident.route[resident.routeIndex + 1] || null,
              dt: residentDt, maxSpeed: 1.35, arrivalRadius: 0.85, stopRadius: 0.14,
              neighbours: neighbourPositions,
              resolveMovement: this.collisionIndex
                ? (position, previous) => this.collisionIndex.resolveMovement(position, previous, 0.29) : null,
            });
            resident.heading = movement.heading; resident.root.rotation.y = resident.heading;
            if (movement.arrived) resident.routeIndex++;
            if (resident.routeIndex >= resident.route.length) resident.currentBuildingId = resident.targetBuildingId;
          }
          groundSettlementNpc(resident.root.position, this.walkableSurface);
        } else {
          advanceResidentLoiter(resident, target, residentDt, this.world, this.walkableSurface, !!resident.conversation || resident.greetingLock > 0 || talkingToPlayer, current.residents, this.collisionIndex);
          const door = target.portals.find((portal) => portal.kind === 'exterior-door');
          const doorPoint = portalWorldPoint(target, door);
          if (door && Math.hypot(resident.root.position.x - doorPoint.x, resident.root.position.z - doorPoint.z) < 1.7) requestPortal(this.state, door, resident.actorId);
        }
        const movingThisFrame = Math.hypot(
          resident.root.position.x - previousX, resident.root.position.z - previousZ,
        ) > 1e-5;
        resident.groundY = resident.root.position.y;
        animateResident(resident, current.residents, residentDt, this.state, player, this.walkableSurface.queryProvider(), talkingToPlayer, movingThisFrame);
      }
    }
    this.evolutionTimer += dt;
    if (this.evolutionTimer >= 5 && this.state.features.settlementEvolutionEnabled) { this.evolutionTimer = 0; advanceSettlementEvolution(this.state, hours); }
    this.state.metrics.settlementSimulationMs += performance.now() - started; this.state.metrics.settlementSimulationSamples++;
  }

  dispose() {
    for (const id of [...this.active.keys()]) this._unload(id);
    for (const marker of this.markers.values()) disposeTree(marker);
    this.markers.clear(); this.scene.remove(this.root);
    for (const instance of this.frontageMaterials.values()) instance.dispose?.();
    this.frontageMaterials.clear();
  }

  interactiveActors() {
    return [...this.active.values()].flatMap((current) => current.residents);
  }

  materializedActorIds() {
    return this.interactiveActors().map((resident) => resident.actorId);
  }
}
