// Masonry laid in courses: the shared grammar for every wall on a tower site.
//
// A watchtower drum and the curtain wall around it are the same building. That
// only reads if they are cut from the same quarry, laid to the same course
// height, broken by the same kind of jagged collapse, and mossed at the same
// height off the ground. So the drum loop that used to live inside
// buildWatchtower is here, generalised, and a straight wall run is the same
// loop walked along a line instead of around a circle.
//
// Everything here works in the site's LOCAL frame and returns bare geometries.
// The caller merges them, picks the material, and places the group.

import * as THREE from 'three';
import {
  hash3, stoneBox, ageStone, weather, paint, stoneColor, seat,
} from './stonecraft.js';
import { mulberry32 } from './noise.js';

// One quarry per site. Every wall, the drum, the gate arch and the undercroft
// door all draw their colour and their course height from this, which is what
// actually makes a keep read as one building rather than a collection.
export function siteQuarry(seed) {
  const rng = mulberry32((seed >>> 0) ^ 0x5155_4152);
  return {
    color: stoneColor(rng),
    courseHeight: 0.52 + rng() * 0.10,   // overridden by the plan's own drum
    blockLength: 0.95 + rng() * 0.15,
    seed: seed >>> 0,
  };
}

// A single block's colour: the quarry, jittered, mossed near the ground, with
// the occasional darker plug stone to break up the mass.
function blockColor(quarry, rng, heightAboveFoot) {
  const base = quarry.color;
  const moss = Math.max(0, 1 - heightAboveFoot / 2.3) * 0.4;
  const col = base.clone().offsetHSL((rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.09)
    .lerp(new THREE.Color(base.r * 0.70, base.g, base.b * 0.58), moss);
  if (rng() < 0.16) col.multiplyScalar(0.78);
  return col;
}

// One block. Up close it is a worn, rounded, weathered stone; at range it is a
// box, because at range that is all it ever was — and a distant keep should not
// cost eight times the triangles to say the same thing.
function block(width, height, depth, rng, detail) {
  if (detail === 'far') {
    // Still jittered, so a far wall keeps its irregular line.
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.scale(1 + (rng() - 0.5) * 0.08, 1, 1 + (rng() - 0.5) * 0.1);
    return geometry;
  }
  return stoneBox(width, height, depth, rng, 1, 0.06);
}

function angleDistance(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/**
 * A round tower laid in running-bond courses — the watchtower drum.
 *
 * `rim(angle)` returns the surviving height in courses at that bearing, which
 * is where a ruin's silhouette comes from: full-height over one arc, a steep
 * jagged break, then a low stub.
 */
export function courseDrum({
  quarry, rng, x = 0, z = 0, radius, courses, courseHeight = quarry.courseHeight,
  rim = () => courses, doorAngle = null, doorCourses = 3, slitAngle = null,
  baseY = 0, detail = 'full',
}) {
  const parts = [];
  // Blocks are longer than their angular spacing, so neighbours overlap and the
  // wall reads as solid. Gaps between chord-boxes on a circle otherwise open
  // into a checkerboard of holes.
  const length = quarry.blockLength * (detail === 'far' ? 3.0 : 1.0);
  const count = Math.max(6, Math.round((Math.PI * 2 * radius) / (length * 0.74)));
  for (let c = 0; c < courses; c++) {
    for (let k = 0; k < count; k++) {
      const a = ((k + (c % 2) * 0.5) / count) * Math.PI * 2;
      if (c + 0.5 > rim(a)) continue;                                  // collapsed here
      if (doorAngle !== null && c < doorCourses
        && angleDistance(a, doorAngle) < 0.34) continue;               // doorway gap
      if (slitAngle !== null && courses >= 10 && (c === 5 || c === 6)
        && angleDistance(a, slitAngle) < 0.10) continue;               // window slit
      const st = block(length, courseHeight * 1.01, 0.82, rng, detail);
      st.rotateY(a + Math.PI / 2 + (rng() - 0.5) * 0.02);              // long axis tangent
      const rr = radius - c * 0.035 + (rng() - 0.5) * 0.06;            // gentle inward batter
      st.translate(x + Math.cos(a) * rr, baseY + c * courseHeight + courseHeight * 0.5,
        z + Math.sin(a) * rr);
      parts.push(ageStone(paint(st, blockColor(quarry, rng, c * courseHeight), rng, 0.1)));
    }
  }
  return parts;
}

/**
 * A straight wall run laid in running-bond courses.
 *
 * The crest follows the ground rather than sitting level, because a curtain
 * wall on a slope is built in steps — a level top over rising terrain reads as
 * a floating slab. `openings` are gate and door gaps in run-local terms.
 */
export function courseWall({
  quarry, rng, ax, az, bx, bz, height, thickness = 0.9, ground = null,
  courseHeight = quarry.courseHeight, openings = [], crest = null,
  merlonTop = false, baseY = null, detail = 'full',
}) {
  const dx = bx - ax, dz = bz - az;
  const runLength = Math.hypot(dx, dz);
  if (runLength < 0.4) return [];
  const yaw = Math.atan2(dx, dz);
  const ux = dx / runLength, uz = dz / runLength;

  // Ground under the run.
  //
  // The chunk mesh interpolates linearly between vertices about 1.25 m apart,
  // so the surface you can see dips below the smooth height field on any slope.
  // Sampling the height field alone puts a wall's foot in the air; take the low
  // point of a small span across the wall instead, the way seat() does for a
  // single part, and bury the bottom course under it.
  const foot = ground ? (t) => {
    const px = ax + dx * t, pz = az + dz * t;
    let low = ground(px, pz);
    for (const offset of [-1.1, 1.1]) {
      low = Math.min(low, ground(px + -uz * offset, pz + ux * offset));
      low = Math.min(low, ground(px + ux * offset * 0.6, pz + uz * offset * 0.6));
    }
    return low;
  } : () => 0;
  let footMin = Infinity;
  for (let i = 0; i <= 16; i++) footMin = Math.min(footMin, foot(i / 16));
  const startY = Number.isFinite(baseY) ? baseY : footMin - 0.55;

  const far = detail === 'far';
  const length = far ? quarry.blockLength * 3.0 : quarry.blockLength;
  const step = far ? length * 0.94 : length * 0.80;   // overlap, so no checkerboard
  const count = Math.max(1, Math.round(runLength / step));
  const courses = Math.ceil((height + 1.2) / courseHeight) + 1;

  // A ruin's crest is ragged. Keyed on the run's own coordinates so the same
  // wall breaks the same way every time it streams in — and quantised to whole
  // block positions, because running bond offsets every other course by half a
  // block: a crest sampled at the exact centre of each stone would give the
  // course above a different answer from the course below, and leave merlons
  // standing on air.
  const crestAt = crest || ((t) => {
    const bin = Math.round(t * count) / count;
    const jag = (hash3(ax * 0.7 + bin * runLength * 0.9, az * 0.7, quarry.seed % 97) - 0.5);
    return foot(bin) + height + jag * courseHeight * 2.6;
  });

  const parts = [];
  for (let c = 0; c < courses; c++) {
    const bottom = startY + c * courseHeight;
    const mid = bottom + courseHeight * 0.5;
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5 + (c % 2) * 0.5) / count;
      if (t < 0 || t > 1) continue;
      const crestHere = crestAt(t);
      if (mid > crestHere) continue;                      // above what survived
      const localFoot = foot(t);
      // Courses well below the ground are not worth cutting — except where the
      // caller has said where the base is. A revetment lining a cutting stands
      // below grade on purpose, and culling its lower courses against the
      // uncut terrain left the upper ones hanging in the air.
      if (!Number.isFinite(baseY) && bottom + courseHeight < localFoot - 0.9) continue;
      // Crenellations: gaps through the top two courses, so a merlon reads as a
      // merlon at ashlar scale. Keyed on position rather than block index for
      // the same reason the crest is — running bond shifts the index by half a
      // block each course, and an index-keyed gap would stagger up the wall.
      if (merlonTop && mid > crestHere - courseHeight * 2
        && Math.round(t * count) % 2 === 1) continue;
      const open = openings.find((o) => Math.abs(t - o.t) * runLength < o.halfWidth
        && mid < localFoot + (o.height ?? 2.2));
      if (open) continue;
      const st = block(length, courseHeight * 1.01, thickness, rng, detail);
      st.rotateY(yaw + (rng() - 0.5) * 0.02);
      const drift = (rng() - 0.5) * 0.05;                 // gentle inward batter + jitter
      const nx = -uz, nz = ux;
      st.translate(
        ax + dx * t + nx * drift, mid,
        az + dz * t + nz * drift,
      );
      parts.push(ageStone(paint(
        st, blockColor(quarry, rng, mid - localFoot), rng, 0.1,
      )));
    }
  }
  return parts;
}

/**
 * A doorway: two jambs and a head. A voussoir arch where there is room for one,
 * a flat lintel where there is not — which is the same choice the watchtower's
 * own doorway makes.
 */
export function archOpening({
  quarry, rng, x, z, yaw, width = 2.4, height = 2.4, thickness = 0.9,
  baseY = 0, arched = true,
}) {
  const parts = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const place = (geo, along, up, across) => {
    geo.rotateY(yaw);
    geo.translate(x + along * c + across * s, baseY + up, z - along * s + across * c);
    return geo;
  };
  const jambCourses = Math.max(2, Math.round(height / quarry.courseHeight));
  for (const side of [-1, 1]) {
    for (let i = 0; i < jambCourses; i++) {
      const st = stoneBox(0.62, quarry.courseHeight * 1.01, thickness * 1.05, rng, 1, 0.05);
      parts.push(ageStone(paint(
        place(st, side * (width / 2 + 0.28), i * quarry.courseHeight + quarry.courseHeight * 0.5, 0),
        blockColor(quarry, rng, i * quarry.courseHeight), rng, 0.08,
      )));
    }
  }
  if (arched && width >= 1.6) {
    const voussoirs = Math.max(5, Math.round(width * 3));
    const radius = width / 2 + 0.3;
    for (let i = 0; i < voussoirs; i++) {
      const a = Math.PI * (i + 0.5) / voussoirs;                 // 0..π across the head
      const st = stoneBox(0.46, 0.62, thickness * 1.05, rng, 1, 0.05);
      st.rotateZ(a - Math.PI / 2);
      parts.push(ageStone(paint(
        place(st, -Math.cos(a) * radius, height + Math.sin(a) * radius * 0.62, 0),
        blockColor(quarry, rng, height), rng, 0.06,
      )));
    }
  } else {
    const lintel = stoneBox(width + 0.9, 0.38, thickness * 1.1, rng, 2, 0.05);
    parts.push(ageStone(paint(
      place(lintel, 0, height + 0.19, 0), blockColor(quarry, rng, height), rng, 0.05,
    )));
  }
  return parts;
}

/** Fallen blocks, tumbled where a wall came down. */
export function rubbleField({
  quarry, rng, ground = null, count = 10,
  x = 0, z = 0, radius = 4, spread = Math.PI * 2, bearing = 0, inwardChance = 0,
}) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const inside = rng() < inwardChance;
    const a = inside ? rng() * Math.PI * 2 : bearing + (rng() - 0.5) * spread;
    const rr = inside ? rng() * radius * 0.6 : radius + 0.8 + rng() * 4.2;
    const size = 0.3 + rng() * 0.42;
    const rock = new THREE.IcosahedronGeometry(size, 1);
    weather(rock, rng, 0.3);
    rock.scale(1, 0.7, 1);
    rock.rotateY(rng() * Math.PI * 2);
    rock.translate(x + Math.cos(a) * rr, size * 0.5, z + Math.sin(a) * rr);
    if (ground) seat(rock, ground, size * 0.75, 1.4);
    parts.push(paint(rock, quarry.color.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.1), rng, 0.1));
  }
  return parts;
}

/** Flagstones: a floor or a wall-walk landing, laid as slabs rather than a slab. */
export function flagstones({
  quarry, rng, x, z, width, depth, yaw = 0, y = 0, thickness = 0.18,
}) {
  const parts = [];
  const nx = Math.max(1, Math.round(width / 1.1));
  const nz = Math.max(1, Math.round(depth / 1.1));
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const lx = (-width / 2) + width * (i + 0.5) / nx;
      const lz = (-depth / 2) + depth * (k + 0.5) / nz;
      const slab = stoneBox(width / nx * 0.97, thickness, depth / nz * 0.97, rng, 1, 0.04);
      slab.rotateY(yaw + (rng() - 0.5) * 0.03);
      slab.translate(x + lx * c + lz * s, y + thickness * 0.5, z - lx * s + lz * c);
      parts.push(ageStone(paint(slab, blockColor(quarry, rng, 3), rng, 0.07), 0.2));
    }
  }
  return parts;
}

/** Steps cut into a bank, or a stair up to a wall-walk. */
export function stoneSteps({
  quarry, rng, ax, az, ay, bx, bz, by, width = 2.1, steps = 9,
}) {
  const parts = [];
  const dx = bx - ax, dz = bz - az, dy = by - ay;
  const yaw = Math.atan2(dx, dz);
  const runLength = Math.hypot(dx, dz) || 1;
  const count = Math.max(3, steps);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const rise = Math.max(0.14, Math.abs(dy) / count + 0.1);
    const tread = stoneBox(width, rise, runLength / count + 0.16, rng, 1, 0.04);
    tread.rotateY(yaw);
    tread.translate(ax + dx * t, ay + dy * t + rise * 0.5, az + dz * t);
    parts.push(ageStone(paint(tread, blockColor(quarry, rng, 2.4), rng, 0.07), 0.22));
  }
  return parts;
}
