// Classic small-station geometry, built in the station's local frame (X =
// across, +X toward the building; Z = along the track; Y up, relative to the
// rail formation) and returned as a Group the tile streamer positions and
// orients. All stations share one design for now. Collision lives in the pure
// railstation.mjs; this file is purely visual.

import * as THREE from 'three';
import { STATION_LAYOUT } from './railstation.mjs';

const P = STATION_LAYOUT;

function box(group, mat, w, h, d, x, y, z, rotZ = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (rotZ) mesh.rotation.z = rotZ;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.railOwnsGeometry = true;
  group.add(mesh);
  return mesh;
}

// A flat, double-sided triangle at a fixed along-Z (gable ends, valance teeth).
function triangleZ(group, mat, ax, ay, bx, by, cx, cy, z) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    ax, ay, z, bx, by, z, cx, cy, z,
  ]), 3));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.railOwnsGeometry = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** Draw the station name onto a canvas for a running-in name board. Returns a
 * MeshStandardMaterial; the caller caches it per station so tile reloads reuse
 * it and it is disposed once, with the whole service. */
export function makeSignMaterial(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#123528';                 // classic dark bottle-green
  ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = '#efe8d2'; ctx.lineWidth = 7;
  ctx.strokeRect(7, 7, 498, 82);
  ctx.fillStyle = '#f4eeda';
  ctx.font = '600 50px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || 'STATION').toUpperCase(), 256, 53, 470);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: 0.7,
    emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.18,
  });
  material.userData.signTexture = texture;
  return material;
}

function addBuilding(group, mats) {
  const b = P.building;
  const base = P.platformTop;                 // building floor sits on the platform
  const wallTop = base + b.wallHeight;
  const cx = b.across, len = b.halfLength * 2, depth = b.half * 2;
  const front = b.across - b.half;            // track-facing wall (−X face)
  const backX = b.across + b.half;

  // Plinth, main brick mass, and a pale cornice band under the eaves.
  box(group, mats.stationTrim, depth + 0.3, 0.5, len + 0.3, cx, base + 0.25, 0);
  box(group, mats.brick, depth, b.wallHeight, len, cx, base + b.wallHeight / 2, 0);
  box(group, mats.stationTrim, depth + 0.14, 0.28, len + 0.14, cx, wallTop - 0.05, 0);

  // Corner pilasters (quoins) in pale stone.
  for (const sx of [front + 0.12, backX - 0.12]) {
    for (const sz of [-b.halfLength + 0.12, b.halfLength - 0.12]) {
      box(group, mats.stationTrim, 0.28, b.wallHeight, 0.28, sx, base + b.wallHeight / 2, sz);
    }
  }

  // Front wall: door in the centre, tall sash windows either side.
  box(group, mats.stationTimber, 0.1, 2.2, 1.1, front + 0.01, base + 1.1, 0);   // door
  box(group, mats.glass, 0.08, 1.3, 0.95, front + 0.02, base + 1.55, -2.7);
  box(group, mats.glass, 0.08, 1.3, 0.95, front + 0.02, base + 1.55, 2.7);
  // Gable-end windows.
  for (const sz of [-b.halfLength + 0.02, b.halfLength - 0.02]) {
    box(group, mats.glass, 1.0, 1.1, 0.08, cx, base + 1.7, sz);
  }

  // Pitched roof, ridge running along the track; two slate slopes + gable
  // triangles closing the ends, with an overhang.
  const ridgeY = wallTop + b.ridgeRise;
  const eaveOver = 0.55;
  const eaveL = front - eaveOver, eaveR = backX + eaveOver;
  const eaveY = wallTop - 0.12;
  const roofLen = len + 1.1;
  for (const ex of [eaveL, eaveR]) {
    const dx = ex - cx, dy = eaveY - ridgeY;       // ridge → eave direction
    const slopeLen = Math.hypot(dx, dy);
    box(group, mats.slate, slopeLen, 0.14, roofLen, (cx + ex) / 2, (ridgeY + eaveY) / 2, 0, Math.atan2(dy, dx));
  }
  for (const sz of [-b.halfLength, b.halfLength]) {
    triangleZ(group, mats.brick, eaveL, eaveY, eaveR, eaveY, cx, ridgeY, sz);
  }

  // Chimney with a pale cap.
  box(group, mats.brick, 0.72, 1.9, 0.72, cx + 0.4, ridgeY + 0.6, b.halfLength - 1.6);
  box(group, mats.stationTrim, 0.92, 0.22, 0.92, cx + 0.4, ridgeY + 1.6, b.halfLength - 1.6);
}

function addCanopy(group, mats) {
  const c = P.canopy;
  const y = P.platformTop + c.height;
  const midX = (c.front + c.back) / 2;
  const width = c.back - c.front;
  const len = c.halfLength * 2;
  // Slightly sloped awning falling toward the track.
  box(group, mats.slate, width + 0.3, 0.12, len, midX, y, 0, 0.055);
  // Support posts along the platform edge.
  for (let z = -c.halfLength + 1; z <= c.halfLength - 1; z += 3.4) {
    box(group, mats.stationTimber, 0.16, c.height, 0.16, c.front + 0.1, P.platformTop + c.height / 2, z);
  }
  // Scalloped valance hanging off the front edge — a row of downward teeth.
  const teeth = Math.round(len / 0.7);
  const step = len / teeth;
  const topY = y - 0.06, botY = y - 0.5;
  for (let i = 0; i < teeth; i++) {
    const z0 = -c.halfLength + i * step, z1 = z0 + step;
    triangleZatX(group, mats.stationTimber, c.front, topY, botY, z0, z1);
  }
}

// A downward valance tooth in the Y-Z plane at a fixed across-X.
function triangleZatX(group, mat, x, topY, botY, z0, z1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    x, topY, z0, x, topY, z1, x, botY, (z0 + z1) / 2,
  ]), 3));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);   // mat is created DoubleSide by the caller
  mesh.userData.railOwnsGeometry = true;
  group.add(mesh);
}

function addPlatforms(group, mats) {
  const base = (P.platformBase + P.platformTop) / 2;
  const h = P.platformTop - P.platformBase;
  // Main (building) platform and the shorter opposite platform.
  box(group, mats.platform, P.mainHalf * 2, h, P.halfLength * 2, P.mainAcross, base, 0);
  box(group, mats.platform, P.oppHalf * 2, h, P.oppHalfLength * 2, P.oppAcross, base, 0);
  // Painted safety stripe along each platform edge nearest the track.
  box(group, mats.stationTrim, 0.18, 0.03, P.halfLength * 2, P.mainAcross - P.mainHalf + 0.12, P.platformTop + 0.02, 0);
  box(group, mats.stationTrim, 0.18, 0.03, P.oppHalfLength * 2, P.oppAcross + P.oppHalf - 0.12, P.platformTop + 0.02, 0);

  // A modest open-fronted shelter on the opposite platform.
  const ox = P.oppAcross;
  box(group, mats.stationTimber, P.oppHalf * 1.6, 2.1, 0.1, ox - 0.6, P.platformTop + 1.05, 0);   // back wall
  box(group, mats.stationTimber, 0.1, 2.1, 4.0, ox - 0.6 + P.oppHalf * 0.8, P.platformTop + 1.05, 0); // side
  box(group, mats.slate, P.oppHalf * 2, 0.1, 4.6, ox, P.platformTop + 2.15, 0, -0.05);              // roof
  box(group, mats.stationTimber, P.oppHalf * 1.4, 0.35, 0.4, ox, P.platformTop + 0.22, 0);          // bench
}

function addFurniture(group, mats, signMaterial) {
  // Running-in name board on the building's track-facing wall.
  const front = P.building.across - P.building.half;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.64), signMaterial);
  sign.position.set(front - 0.03, P.platformTop + 2.35, 0);
  sign.rotation.y = -Math.PI / 2;              // face the track (−X)
  sign.userData.railOwnsGeometry = true;
  group.add(sign);

  // A bench against the building front and a pair of platform lamps.
  box(group, mats.stationTimber, 0.5, 0.4, 2.0, P.building.across - P.building.half - 0.45, P.platformTop + 0.28, -3);
  for (const z of [-P.halfLength * 0.55, P.halfLength * 0.55]) {
    box(group, mats.lamp, 0.12, 3.0, 0.12, P.mainAcross - P.mainHalf + 0.4, P.platformTop + 1.5, z);
    const lantern = box(group, mats.lantern, 0.34, 0.42, 0.34, P.mainAcross - P.mainHalf + 0.4, P.platformTop + 3.1, z);
    lantern.castShadow = false;
  }
}

/**
 * Build the full station in local space. `signMaterial` is created and cached
 * by the caller (per station name). Returns a Group to be positioned at the
 * station and rotated so local +Z runs with the track tangent.
 */
export function buildStationGroup(station, name, mats, signMaterial) {
  const group = new THREE.Group();
  group.name = `regional station ${(name || station.id)}`;
  addPlatforms(group, mats);
  addBuilding(group, mats);
  addCanopy(group, mats);
  addFurniture(group, mats, signMaterial);
  return group;
}
