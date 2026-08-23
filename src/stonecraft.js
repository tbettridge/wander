// The stone vocabulary every masonry ruin in the world is cut from.
//
// A watchtower drum, a keep's curtain wall and an undercroft door are the same
// building at different scales, so they have to be the same stones: the same
// rounded, weathered block, the same quarry colour, the same edge wear, and the
// same rule for seating a part against terrain that renders lower than the
// smooth height field says it does. These lived inside landmarkmesh.js while
// the watchtower was the only thing built from them.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// mergeGeometries refuses to mix indexed (Box/Cylinder) with non-indexed
// (Icosahedron) inputs — normalise to non-indexed at the final merge
export function ni(geo) { return geo.index ? geo.toNonIndexed() : geo; }

// A worn stone block: rounded edges (so nothing is razor-sharp), a slight
// asymmetric skew, and enough subdivision that the weathering noise can bend
// the contours. `seg` trades silhouette softness for vertex count — 1 for the
// many small masonry courses, 2 for hero stones (megaliths, lintels, walls).
export function stoneBox(w, h, d, rng, seg = 1, amt = 0.07) {
  const r = Math.min(w, h, d) * (0.16 + rng() * 0.08);
  const geo = new RoundedBoxGeometry(w, h, d, seg, r);
  geo.scale(1 + (rng() - 0.5) * 0.08, 1 + (rng() - 0.5) * 0.06, 1 + (rng() - 0.5) * 0.10);
  weather(geo, rng, amt);
  return geo;
}

// Bake edge wear into the vertex colours: bevel-ring vertices (normals off the
// three face axes) darken slightly, so every block keeps a soft worn contour
// even under flat ambient light. Call AFTER paint().
export function ageStone(geo, amt = 0.28) {
  const nrm = geo.attributes.normal, col = geo.attributes.color;
  if (!col) return geo;
  for (let i = 0; i < col.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    const edge = 1 - Math.max(ax, Math.max(ay, az));   // 0 on faces, ~0.42 on bevels
    const k = 1 - Math.min(1, edge * 2.2) * amt;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return geo;
}

// coherent radial displacement → weathered, closed surfaces (no torn seams)
export function weather(geo, rng, amt) {
  const pos = geo.attributes.position;
  const f = 1.5 + rng() * 2, p = rng() * 6.28;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const len = v.length() || 1;
    const nx = v.x / len, ny = v.y / len, nz = v.z / len;
    const d = 1 + amt * (Math.sin(nx * f + p) * Math.sin(ny * f) * 0.6 + (hash3(nx, ny, nz) - 0.5));
    pos.setXYZ(i, v.x * d, v.y * d, v.z * d);
  }
  geo.computeVertexNormals();
  return geo;
}

export function paint(geo, color, rng, amt = 0.08) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = 1 + (rng() * 2 - 1) * amt;
    c[i * 3] = Math.min(1, color.r * j);
    c[i * 3 + 1] = Math.min(1, color.g * j);
    c[i * 3 + 2] = Math.min(1, color.b * j);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

export function stoneColor(rng) {
  return new THREE.Color().setHSL(0.08 + rng() * 0.05, 0.04 + rng() * 0.06, 0.47 + rng() * 0.13);
}

// Seat a part so its lowest vertex sits `bury` below the *rendered* terrain
// under its actual mass. The chunk mesh interpolates linearly between vertices
// (~1.25 m apart), so the visible surface can dip below the smooth world.height()
// curve — deep bury compensates for that. We sample at the geometry's own
// bounding-box centre (so a rotated/fallen stone seats where its mass actually
// lies, not where its pre-rotation pivot was) and use the MIN over a small
// ring, then translate so the true lowest vertex lands at terrain - bury.
export function seat(geo, ground, bury, radius = 1.2) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  let g = ground(cx, cz);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    g = Math.min(g, ground(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius));
  }
  geo.translate(0, g - bury - bb.min.y, 0);
  return geo;
}
