import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paint, ni } from './stonecraft.js';
import { mulberry32 } from './noise.js';
import { buildBuilding } from './settlementstream.js';
import { createLighthousePlan, lighthouseRadiusAt } from './lighthouseplan.mjs';

const TAU = Math.PI * 2;
// Annular solids supply real inner faces and openings, including the staircase
// aperture in the gallery. No opaque cylinder cap seals the playable tower.
function sector(inner, outer, y0, y1, a0, a1, count = 1) {
  const vertices = [];
  const point = (r, a, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
  const quad = (a, b, c, d) => vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < count; i++) {
    const a = a0 + (a1 - a0) * i / count, b = a0 + (a1 - a0) * (i + 1) / count;
    quad(point(inner, a, y1), point(inner, b, y1), point(outer, b, y1), point(outer, a, y1));
    quad(point(inner, a, y0), point(outer, a, y0), point(outer, b, y0), point(inner, b, y0));
    quad(point(outer, a, y0), point(outer, a, y1), point(outer, b, y1), point(outer, b, y0));
    quad(point(inner, b, y0), point(inner, b, y1), point(inner, a, y1), point(inner, a, y0));
  }
  quad(point(inner, a0, y0), point(inner, a0, y1), point(outer, a0, y1), point(outer, a0, y0));
  quad(point(outer, a1, y0), point(outer, a1, y1), point(inner, a1, y1), point(inner, a1, y0));
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.computeVertexNormals(); return geo;
}
function towerWall(plan) {
  const positions = [], colors = [], rng = mulberry32(plan.seed ^ 0x57414c4c);
  const levels = [plan.shaftY, plan.floorY, plan.floorY + plan.doorHeight, plan.shaftY + plan.height];
  for (let y = plan.shaftY + 1; y < plan.shaftY + plan.height; y++) levels.push(y);
  const ys = [...new Set(levels)].sort((a, b) => a - b);
  const point = (a, y, inset) => { const r = lighthouseRadiusAt(plan, y) - inset; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
  const quad = (a, b, c, d, inside = false) => {
    for (const p of [a, b, c, a, c, d]) {
      positions.push(...p);
      const rel = Math.max(0, Math.min(1, (p[1] - plan.shaftY) / plan.height)), band = (rel * 3.1 + .18) % 1;
      const col = new THREE.Color(inside ? 0xb0a58e : band < .27 && rel > .06 && rel < .96 ? 0x944536 : 0xded9cc);
      col.multiplyScalar((.88 + rng() * .1) * (1 - (1 - rel) * .1)); colors.push(col.r, col.g, col.b);
    }
  };
  for (let j = 1; j < ys.length; j++) for (let i = 0; i < 64; i++) {
    const a = i / 64 * TAU, b = (i + 1) / 64 * TAU, y0 = ys[j - 1], y1 = ys[j];
    const doorAngle = Math.abs(Math.atan2(Math.sin((a + b) / 2 - Math.PI), Math.cos((a + b) / 2 - Math.PI)));
    const hole = y0 >= plan.floorY - .001 && y1 <= plan.floorY + plan.doorHeight + .001
      && doorAngle < Math.asin(plan.doorWidth / (2 * lighthouseRadiusAt(plan, (y0 + y1) / 2))) + TAU / 128;
    if (hole) continue;
    quad(point(a, y0, 0), point(a, y1, 0), point(b, y1, 0), point(b, y0, 0));
    quad(point(b, y0, .24), point(b, y1, .24), point(a, y1, .24), point(a, y0, .24), true);
    // Wall reveals close each strip's thickness at door edges and the rim.
    quad(point(a, y0, .24), point(a, y1, .24), point(a, y1, 0), point(a, y0, 0), true);
    quad(point(b, y0, 0), point(b, y1, 0), point(b, y1, .24), point(b, y0, .24), true);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
  g.computeVertexNormals(); return g;
}

export function buildEnterableLighthouse(seed, ground, lm, material, lampMaterial) {
  const plan = createLighthousePlan({ ...lm, seed, towerH: lm?.towerH || 22 + mulberry32(seed)() * 8 }, ground);
  const rng = mulberry32(seed), group = new THREE.Group(), parts = [];
  const stone = new THREE.Color(0x8e8980), iron = new THREE.Color(0x303337), tread = new THREE.Color(0x786956);
  const add = (geo, color) => { parts.push(paint(geo, color, rng, .04)); };
  const box = (w, h, d, x, y, z, color = stone) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); add(g, color); };
  const beam = (a, b, radius = .035) => {
    const p = new THREE.Vector3(...a), q = new THREE.Vector3(...b), delta = q.clone().sub(p);
    const geo = new THREE.CylinderGeometry(radius, radius, delta.length(), 5);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    geo.translate(...p.add(q).multiplyScalar(.5).toArray()); add(geo, iron);
  };
  const foundation = new THREE.CylinderGeometry(plan.legacyBaseRadius + .9, plan.legacyBaseRadius + 1.4, 2.6, 32);
  foundation.translate(0, plan.baseY + 1.3, 0); add(foundation, stone);
  const floor = new THREE.CylinderGeometry(plan.baseRadius - .15, plan.baseRadius - .15, .16, 64);
  floor.translate(0, plan.floorY - .08, 0); add(floor, tread);
  parts.push(towerWall(plan));
  const newel = new THREE.CylinderGeometry(.17, .17, plan.galleryY - plan.floorY, 10);
  newel.translate(0, (plan.galleryY + plan.floorY) / 2, 0); add(newel, iron);
  for (const [i, s] of plan.stairs.entries()) {
    add(sector(s.innerR, s.outerR, s.y - .10, s.y, s.a0, s.a1 + .004), tread);
    const previous = plan.stairs[Math.max(0, i - 1)];
    for (const r of [s.innerR, s.outerR]) {
      if (r === s.outerR && i < 2) continue;
      const r0 = r === s.innerR ? previous.innerR : previous.outerR;
      beam([Math.cos(s.a0) * r0, s.y - plan.rise + .98, Math.sin(s.a0) * r0],
        [Math.cos(s.a1) * r, s.y + .98, Math.sin(s.a1) * r]);
      if (i % 4 === 0) beam([Math.cos(s.a0) * r, s.y, Math.sin(s.a0) * r],
        [Math.cos(s.a0) * r, s.y + .98, Math.sin(s.a0) * r], .025);
    }
  }
  const holeEnd = plan.stairEndAngle, holeStart = holeEnd - plan.galleryHoleAngle, last = plan.stairs.at(-1);
  add(sector(0, plan.lampRadius, plan.galleryY - .55, plan.galleryY, 0, TAU, 64), stone);
  add(sector(last.outerR + .12, plan.galleryRadius, plan.galleryY - .55, plan.galleryY, 0, TAU, 64), stone);
  add(sector(plan.lampRadius, last.outerR + .12, plan.galleryY - .55, plan.galleryY, holeEnd, holeStart + TAU, 32), stone);
  for (const r of [plan.galleryRadius - .07, plan.lampRadius + .06]) {
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * TAU, b = (i + 1) / 32 * TAU;
      for (const y of [.5, 1.05]) beam([Math.cos(a) * r, plan.galleryY + y, Math.sin(a) * r],
        [Math.cos(b) * r, plan.galleryY + y, Math.sin(b) * r]);
      if (i % 2 === 0) beam([Math.cos(a) * r, plan.galleryY, Math.sin(a) * r],
        [Math.cos(a) * r, plan.galleryY + 1.05, Math.sin(a) * r]);
    }
  }
  const guardCount = Math.ceil(plan.galleryHoleAngle / .1), guardR = last.outerR + .12;
  for (let i = 0; i < guardCount; i++) {
    const a = holeStart + i / guardCount * plan.galleryHoleAngle, b = holeStart + (i + 1) / guardCount * plan.galleryHoleAngle;
    beam([Math.cos(a) * guardR, plan.galleryY + 1, Math.sin(a) * guardR], [Math.cos(b) * guardR, plan.galleryY + 1, Math.sin(b) * guardR]);
    if (i % 6 === 0) beam([Math.cos(a) * guardR, plan.galleryY, Math.sin(a) * guardR], [Math.cos(a) * guardR, plan.galleryY + 1, Math.sin(a) * guardR]);
  }
  beam([Math.cos(holeStart) * plan.lampRadius, plan.galleryY + 1, Math.sin(holeStart) * plan.lampRadius],
    [Math.cos(holeStart) * guardR, plan.galleryY + 1, Math.sin(holeStart) * guardR]);

  // Keep the original lamp assembly, material and anchor, including its exact
  // relative height. LighthouseFx continues to find it through lampAnchor.
  const oldR = plan.legacyTopRadius;
  const lamp = new THREE.CylinderGeometry(oldR * .55, oldR * .62, 1.9, 10);
  lamp.translate(0, plan.lampY, 0);
  const lampMesh = new THREE.Mesh(lamp, lampMaterial); lampMesh.name = 'lighthouse beacon'; group.add(lampMesh);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + .4;
    box(.09, 1.95, .09, Math.cos(a) * oldR * .60, plan.lampY, Math.sin(a) * oldR * .60, iron); }
  const roof = new THREE.ConeGeometry(oldR * .78, 1.8, 10); roof.translate(0, plan.lampY + 1.85, 0); add(roof, new THREE.Color(0x4c6d61));
  const finial = new THREE.SphereGeometry(.15, 6, 5); finial.translate(0, plan.lampY + 2.87, 0); add(finial, iron);
  const anchor = new THREE.Object3D(); anchor.name = 'lampAnchor'; anchor.position.set(0, plan.lampY, 0); group.add(anchor);

  const h = plan.house, doors = new Map();
  buildBuilding(group, h, doors);
  for (const pivot of doors.values()) pivot.rotation.y = -Math.PI / 2;
  const plinthHeight = Math.max(.2, plan.floorY - plan.baseY);
  box(h.depth, plinthHeight, h.width, h.x, plan.floorY - .16 - plinthHeight / 2, 0);
  const ramp = plan.ramp, n = Math.max(1, Math.ceil((ramp.y1 - ramp.y0) / .14));
  for (let i = 0; i < n; i++) {
    const x0 = ramp.x0 + (ramp.x1 - ramp.x0) * i / n, x1 = ramp.x0 + (ramp.x1 - ramp.x0) * (i + 1) / n;
    const y = ramp.y0 + (ramp.y1 - ramp.y0) * (i + 1) / n;
    box(x1 - x0 + .01, .14, ramp.width, (x0 + x1) / 2, y - .07, 0);
  }
  for (let y = plan.floorY + 1.5; y < plan.galleryY - 1; y += plan.pitch) {
    const r = lighthouseRadiusAt(plan, y) - .4;
    box(.15, .24, .18, 0, y, -r, new THREE.Color(0xffcc7f));
  }
  const merged = mergeGeometries(parts.map(ni));
  for (const geometry of parts) geometry.dispose();
  const mesh = new THREE.Mesh(merged, material); mesh.name = 'lighthouse tower and circulation'; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  group.userData.lighthouse = true; group.userData.lighthousePlan = plan;
  return group;
}
