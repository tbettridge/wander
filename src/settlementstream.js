import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { settlementsAround } from './settlementplacement.mjs';
import { createSettlementPlan, portalWorldPoint } from './settlementplan.mjs';
import { buildingWorldPoint } from './buildingplan.mjs';
import { generateHouseholds } from './npchousehold.mjs';
import { assignWorkplacesAndRoutines, advanceWorkRoutines } from './npcroutine.mjs';
import { advancePortals, closePortal, ensurePortalState, requestPortal } from './portalstate.mjs';
import { advanceSettlementEvolution, recordSettlementPressure } from './settlementevolution.mjs';
import { SETTLEMENT_BUDGETS } from './settlementquality.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { createNpcIdentity } from './npcpopulation.mjs';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { advanceNpcLocomotion, createNpcLocomotionState } from './npclocomotion.mjs';
import { deriveNpcLoadout } from './npcitems.mjs';
import { advanceGaze, createGazeState } from './npcgaze.mjs';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  gestureAmount, nodPitch, pulseDelivery, SOCIAL,
} from './npcsocial.mjs';
import { beginNpcConversation, exchangeRumors } from './npcrumor.mjs';
import { advanceNpcSteering, createNpcSteeringState } from './npcsteering.mjs';
import { settlementGroundGrid, settlementPathRibbon } from './settlementground.mjs';

const FULL_RADIUS = 720;
const QUERY_RADIUS = 4300;
const INTERIOR_RADIUS = 85;
const WALL_THICKNESS = 0.28;
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

function addBuildingDetails(root, building, h, w, d, frontWindows, backWindows) {
  const trimColor = building.materials.wall === 'stone' ? 0x574b3d : 0x5d4630;
  const trim = material(trimColor), stone = material(0x625d52), wood = material(0x553720);
  const foundationDepth = Math.max(0.32, building.foundationDepth || 0.48);
  box(root, new THREE.BoxGeometry(w + 0.5, foundationDepth, d + 0.5), stone,
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

function buildBuilding(group, building, doorMeshes) {
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
  box(root, new THREE.BoxGeometry(w, 0.16, d), floor, 0, 0.08, 0);
  // A real ceiling seals the playable interior independently of roof style.
  box(root, new THREE.BoxGeometry(w - WALL_THICKNESS, 0.16, d - WALL_THICKNESS), floor, 0, h - 0.08, 0);
  box(root, new THREE.BoxGeometry(WALL_THICKNESS, h, d), wall, -w / 2, h / 2, 0);
  box(root, new THREE.BoxGeometry(WALL_THICKNESS, h, d), wall, w / 2, h / 2, 0);
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
  return root;
}

function groundRectGeometry(world, zone) {
  // Ground treatment is an overlay, not a platform. Sample it densely enough
  // that each triangle follows the same terrain the player walks on instead of
  // spanning a long chord that can float above a hollow or cut through a rise.
  const { positions, indices } = settlementGroundGrid(world, zone);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

export function pathGeometry(world, path) {
  const { positions, indices } = settlementPathRibbon(world, path);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function buildGroundTreatment(group, plan, world) {
  const dirt = material(0x6c583d), yard = material(0x665a48), pathMat = material(0x745e41);
  for (const zone of plan.groundZones) {
    const mesh = new THREE.Mesh(groundRectGeometry(world, zone), zone.kind === 'work-yard' ? yard : dirt);
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.renderOrder = 1; group.add(mesh);
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
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
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

function settlementResidentIdentity(entity, building, index, worldSeed) {
  const base = createNpcIdentity({
    worldSeed,
    stationId: building.id,
    stationName: building.id,
    slot: {
      key: `household-resident-${index}`,
      role: entity.role || 'resident',
      family: 'storybook',
      activity: 'wait',
      accessory: index % 2 ? 'book' : 'basket',
    },
  });
  return Object.freeze({ ...base, id: entity.id, name: entity.name, role: entity.role || base.role });
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
  resident.root.position.y = walkableSurface.groundAt(
    resident.root.position.x, resident.root.position.z, resident.root.position.y + 0.8,
  );
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
  if (movement.arrived) {
    loiter.index = (loiter.index + loiter.direction + loiter.points.length) % loiter.points.length;
    loiter.dwell = 0.35 + resident.emote.rng() * 1.35;
    stopResidentSteering(resident);
  }
}

function buildResident(group, entity, building, index, assets, worldSeed) {
  const identity = settlementResidentIdentity(entity, building, index, worldSeed);
  const avatar = createNpcAvatar(identity, assets), root = avatar.root;
  root.userData.actorId = entity.id;
  const portal = building.portals.find((entry) => entry.kind === 'exterior-door');
  const outside = portalWorldPoint(building, { ...portal, z: building.depth / 2 + 2.1 });
  root.position.set(outside.x + (index ? 1.1 : -1.1), building.y, outside.z);
  root.rotation.y = building.yaw;
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
    playerWasNear: false, greetingDelay: -1, greetingLock: 0,
  };
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
  if (playerDistance < 10 && !resident.playerWasNear) {
    resident.playerWasNear = true;
    resident.greetingDelay = (resident.identity.seed % 5) * 0.14;
  } else if (playerDistance > 16) resident.playerWasNear = false;
  if (resident.greetingDelay >= 0) {
    resident.greetingDelay -= Math.max(0, dt);
    if (resident.greetingDelay <= 0) { resident.greetingDelay = -1; resident.greetingLock = 3.2; pulseDelivery(resident.emote); }
  }
  resident.greetingLock = Math.max(0, resident.greetingLock - Math.max(0, dt));
  advanceEmote(resident.emote, dt);
  const partner = resident.conversation?.actors[1 - resident.conversationSide] || null;
  const socialMotion = residentSocialMotion(resident, talkingToPlayer, moving);
  if (socialMotion.faceWithRoot) {
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
  resident.avatar.setIntentLoadout(deriveNpcLoadout(state, resident.actorId));
  resident.avatar.applyPose(pose, root.position.y, {
    gesture: gestureAmount(resident.emote), gestureHand: resident.identity.animation.gestureHand,
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
    lockOn: partner ? 'neighbour' : (resident.greetingLock > 0 || talkingToPlayer ? 'player' : null),
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
  root.traverse((child) => child.geometry?.dispose?.());
}

export class SettlementSystem {
  constructor(scene, world, walkableSurface, state, collisionIndex = null, { isActorInDialogue = () => false } = {}) {
    this.scene = scene; this.world = world; this.walkableSurface = walkableSurface; this.state = state; this.collisionIndex = collisionIndex;
    this.root = new THREE.Group(); this.root.name = 'living-settlements'; scene.add(this.root);
    this.npcAssets = new NpcAssetLibrary();
    this.isActorInDialogue = isActorInDialogue;
    this.active = new Map(); this.markers = new Map(); this.summaries = []; this.lastQueryX = Infinity; this.lastQueryZ = Infinity; this.evolutionTimer = 0;
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

  _load(site) {
    const plan = createSettlementPlan(site, { heightAt: (x, z) => this.world.height(x, z) });
    const group = new THREE.Group(); group.name = site.id; this.root.add(group);
    buildGroundTreatment(group, plan, this.world);
    const doorMeshes = new Map(); for (const building of plan.buildings) buildBuilding(group, building, doorMeshes);
    mergeStaticSettlementMeshes(group);
    const releases = plan.claims.map((claim) => this.walkableSurface.registerClaim(claim));
    if (this.collisionIndex) releases.push(this.collisionIndex.registerPlan(plan));
    let residents = [];
    if (this.state.features.householdsEnabled) {
      const households = generateHouseholds(plan, this.state);
      if (this.state.features.workRoutinesEnabled) assignWorkplacesAndRoutines(plan, this.state);
      const byId = new Map(plan.buildings.map((b) => [b.id, b]));
      residents = households.flatMap((household) => household.memberIds.slice(0, 2).map((id, index) => buildResident(
        group, this.state.entities[id], byId.get(household.homeBuildingId), index, this.npcAssets, this.state.worldSeed,
      )));
    }
    for (const building of plan.buildings) for (const portal of building.portals) ensurePortalState(this.state, portal);
    recordSettlementPressure(this.state, site.id);
    this.state.metrics.settlementsGenerated++;
    const station = {
      id: site.id, name: site.kind === 'farmstead' ? 'the farmstead' : `the ${site.kind}`,
      x: site.x, y: site.y, z: site.z, index: 0, biome: site.biome?.id || 'country',
    };
    for (const resident of residents) {
      resident.root.position.y = this.walkableSurface.groundAt(
        resident.root.position.x, resident.root.position.z, resident.root.position.y + 0.8,
      );
      resident.station = station; resident.journey = null; resident.groundY = resident.root.position.y;
    }
    return { site, plan, group, doorMeshes, releases, residents, conversations: [], socialTimer: 2.4 };
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
    for (const site of desired) if (!this.active.has(site.id)) this.active.set(site.id, this._load(site));
    for (const [id, marker] of this.markers) {
      const site = this.summaries.find((item) => item.id === id);
      const allowed = this.state.features.largeSettlementsEnabled || (site?.kind !== 'village' && site?.kind !== 'town');
      marker.visible = allowed && !this.active.has(id);
    }
    const started = performance.now();
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
      const buildings = new Map(current.plan.buildings.map((building) => [building.id, building]));
      updateResidentConversations(current, dt, this.state, this.isActorInDialogue);
      for (const resident of current.residents) {
        const entity = this.state.entities[resident.actorId];
        const routine = Object.values(this.state.routines || {}).find((item) => item.actorId === resident.actorId);
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
              dt, maxSpeed: 1.35, arrivalRadius: 0.85, stopRadius: 0.14,
              neighbours: current.residents.filter((other) => other !== resident).map((other) => other.root.position),
              resolveMovement: this.collisionIndex
                ? (position, previous) => this.collisionIndex.resolveMovement(position, previous, 0.29) : null,
            });
            resident.heading = movement.heading; resident.root.rotation.y = resident.heading;
            if (movement.arrived) resident.routeIndex++;
            if (resident.routeIndex >= resident.route.length) resident.currentBuildingId = resident.targetBuildingId;
          }
          resident.root.position.y = this.walkableSurface.groundAt(
            resident.root.position.x, resident.root.position.z, resident.root.position.y + 0.8,
          );
        } else {
          advanceResidentLoiter(resident, target, dt, this.world, this.walkableSurface, !!resident.conversation || resident.greetingLock > 0 || talkingToPlayer, current.residents, this.collisionIndex);
          const door = target.portals.find((portal) => portal.kind === 'exterior-door');
          const doorPoint = portalWorldPoint(target, door);
          if (door && Math.hypot(resident.root.position.x - doorPoint.x, resident.root.position.z - doorPoint.z) < 1.7) requestPortal(this.state, door, resident.actorId);
        }
        const movingThisFrame = Math.hypot(
          resident.root.position.x - previousX, resident.root.position.z - previousZ,
        ) > 1e-5;
        resident.groundY = resident.root.position.y;
        animateResident(resident, current.residents, dt, this.state, player, this.walkableSurface.queryProvider(), talkingToPlayer, movingThisFrame);
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
  }

  interactiveActors() {
    return [...this.active.values()].flatMap((current) => current.residents);
  }
}
