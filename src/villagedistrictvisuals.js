// What the village-centre district looks like.
//
// villagedistrict.mjs decides where every hedge, gate, yard prop and hanging
// line goes; this turns that plan into a handful of meshes. Everything here is
// baked into vertex-coloured geometry with ONE shared material, so a whole
// district — hundreds of props, a kilometre of boundary, every washing line and
// lantern string — costs four draws per village however much of it there is:
//
//   solid    props, boundaries, posts, gates, window boxes  (casts shadows)
//   flat     stepping stones and gutters                    (receives only)
//   lines    washing, bunting, lantern strings, garments    (no shadow)
//   lanterns the lantern bodies, glowing after dusk          (no shadow)
//
// Small things are only worth drawing close up, so the `detail` group (flat,
// lines, lanterns and the small props) is hidden past DETAIL_RADIUS by the
// settlement streamer; the boundaries and the big props that shape the plots
// stay with the rest of the village's static batch.

import * as THREE from 'three';

export const DISTRICT_DETAIL_RADIUS = 210;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rigid transform: position, then yaw, pitch and roll (YXZ). */
function frame(x, y, z, yaw = 0, pitch = 0, roll = 0) {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** `parent` then a local offset and rotation. */
function sub(parent, x, y, z, yaw = 0, pitch = 0, roll = 0) {
  return new THREE.Matrix4().multiplyMatrices(parent, frame(x, y, z, yaw, pitch, roll));
}

/**
 * A growing indexed geometry with position, normal and colour — the only three
 * attributes the settlement's static merge keeps.
 */
class Batch {
  constructor() { this.p = []; this.n = []; this.c = []; this.i = []; this.v = 0; }

  get triangles() { return this.i.length / 3; }

  colour(hex, jitter = 0, rng = null) {
    _c.setHex(hex);
    if (jitter && rng) {
      const k = 1 + (rng() - 0.5) * jitter;
      _c.r *= k; _c.g *= k; _c.b *= k;
    }
    return [_c.r, _c.g, _c.b];
  }

  /** A flat polygon (3 or 4 corners, counter-clockwise from outside). */
  face(m, corners, normal, rgb) {
    _n.set(normal[0], normal[1], normal[2]).transformDirection(m);
    const base = this.v;
    for (const corner of corners) {
      _v.set(corner[0], corner[1], corner[2]).applyMatrix4(m);
      this.p.push(_v.x, _v.y, _v.z); this.n.push(_n.x, _n.y, _n.z); this.c.push(rgb[0], rgb[1], rgb[2]);
      this.v++;
    }
    this.i.push(base, base + 1, base + 2);
    if (corners.length === 4) this.i.push(base, base + 2, base + 3);
  }

  /** A box centred at the origin of `m`, its bottom face left off unless asked. */
  box(m, sx, sy, sz, rgb, { bottom = false, top = true } = {}) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    this.face(m, [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [0, 0, 1], rgb);
    this.face(m, [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], [0, 0, -1], rgb);
    this.face(m, [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]], [1, 0, 0], rgb);
    this.face(m, [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]], [-1, 0, 0], rgb);
    if (top) this.face(m, [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]], [0, 1, 0], rgb);
    if (bottom) this.face(m, [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], [0, -1, 0], rgb);
  }

  /** A faceted cylinder along local y, centred; `cap` colours the top. */
  cylinder(m, rTop, rBottom, height, segments, rgb, { cap = rgb, bottom = false } = {}) {
    const h = height / 2;
    for (let k = 0; k < segments; k++) {
      const a0 = (k / segments) * Math.PI * 2, a1 = ((k + 1) / segments) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const slope = (rBottom - rTop) / height;
      const len = Math.hypot(1, slope);
      this.face(m, [
        [Math.cos(a0) * rBottom, -h, Math.sin(a0) * rBottom],
        [Math.cos(a0) * rTop, h, Math.sin(a0) * rTop],
        [Math.cos(a1) * rTop, h, Math.sin(a1) * rTop],
        [Math.cos(a1) * rBottom, -h, Math.sin(a1) * rBottom],
      ].reverse(), [Math.cos(am) / len, slope / len, Math.sin(am) / len], rgb);
    }
    if (cap && rTop > 0.001) {
      for (let k = 1; k < segments - 1; k++) {
        const a = (i) => [Math.cos((i / segments) * Math.PI * 2) * rTop, h, Math.sin((i / segments) * Math.PI * 2) * rTop];
        this.face(m, [a(0), a(k + 1), a(k)], [0, 1, 0], cap);
      }
    }
    if (bottom && rBottom > 0.001) {
      for (let k = 1; k < segments - 1; k++) {
        const a = (i) => [Math.cos((i / segments) * Math.PI * 2) * rBottom, -h, Math.sin((i / segments) * Math.PI * 2) * rBottom];
        this.face(m, [a(0), a(k), a(k + 1)], [0, -1, 0], cap);
      }
    }
  }

  /** A low-poly lump: an icosahedron, flat shaded, scaled per axis. */
  lump(m, rx, ry, rz, rgb) {
    for (const [a, b, c] of ICO_FACES) {
      const A = ICO[a], B = ICO[b], C = ICO[c];
      const pa = [A[0] * rx, A[1] * ry, A[2] * rz], pb = [B[0] * rx, B[1] * ry, B[2] * rz], pc = [C[0] * rx, C[1] * ry, C[2] * rz];
      const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      this.face(m, [pa, pb, pc], [nx / l, ny / l, nz / l], rgb);
    }
  }

  /** A thin card visible from both sides (flags, garments). */
  card(m, corners, rgb) {
    const [a, b, c, d] = corners;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = (d || c)[0] - a[0], vy = (d || c)[1] - a[1], vz = (d || c)[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.face(m, corners, [-nx, -ny, -nz], rgb);
    this.face(m, corners.slice().reverse(), [nx, ny, nz], rgb);
  }

  /** A three-sided tube through world points. */
  tube(points, radius, rgb) {
    const identity = IDENTITY;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      // Any vector not parallel to the run, then two perpendiculars to it.
      let px = -dz, py = 0, pz = dx;
      let pl = Math.hypot(px, py, pz);
      if (pl < 1e-6) { px = 1; py = 0; pz = 0; pl = 1; }
      px /= pl; py /= pl; pz /= pl;
      const qx = (dy * pz - dz * py) / len, qy = (dz * px - dx * pz) / len, qz = (dx * py - dy * px) / len;
      const ring = [0, 1, 2].map((k) => {
        const angle = (k / 3) * Math.PI * 2;
        const cx = Math.cos(angle), sz = Math.sin(angle);
        return [px * cx + qx * sz, py * cx + qy * sz, pz * cx + qz * sz];
      });
      for (let k = 0; k < 3; k++) {
        const o0 = ring[k], o1 = ring[(k + 1) % 3];
        const nm = [(o0[0] + o1[0]) / 2, (o0[1] + o1[1]) / 2, (o0[2] + o1[2]) / 2];
        const nl = Math.hypot(...nm) || 1;
        this.face(identity, [
          [a[0] + o0[0] * radius, a[1] + o0[1] * radius, a[2] + o0[2] * radius],
          [b[0] + o0[0] * radius, b[1] + o0[1] * radius, b[2] + o0[2] * radius],
          [b[0] + o1[0] * radius, b[1] + o1[1] * radius, b[2] + o1[2] * radius],
          [a[0] + o1[0] * radius, a[1] + o1[1] * radius, a[2] + o1[2] * radius],
        ].reverse(), [nm[0] / nl, nm[1] / nl, nm[2] / nl], rgb);
      }
    }
  }

  /** A ribbon lying on the ground through world points. */
  ribbon(points, width, offset, rgb, world, lift) {
    const identity = IDENTITY;
    const left = [], right = [];
    for (let i = 0; i < points.length; i++) {
      const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
      const dx = after.x - before.x, dz = after.z - before.z, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const cx = points[i].x + nx * offset, cz = points[i].z + nz * offset;
      for (const [list, side] of [[left, -1], [right, 1]]) {
        const x = cx + nx * side * width / 2, z = cz + nz * side * width / 2;
        list.push([x, (world ? world.height(x, z) : points[i].y) + lift, z]);
      }
    }
    for (let i = 1; i < points.length; i++) {
      this.face(identity, [left[i - 1], left[i], right[i], right[i - 1]], [0, 1, 0], rgb);
    }
  }

  geometry() {
    if (!this.i.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geometry.setIndex(this.v > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

const IDENTITY = new THREE.Matrix4();
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  return [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(...v); return v.map((c) => c / l); });
})();
const ICO_FACES = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

// --- the palette ------------------------------------------------------------------
// Earth, timber and faded cloth: nothing here is brighter than a whitewashed
// pale or a geranium, so a lived-in street reads as busy rather than gaudy.
const P = Object.freeze({
  woodDark: 0x4d3a2a, wood: 0x6b543a, woodLight: 0x8a7050, woodGrey: 0x7a6e60, cut: 0xa8875a,
  iron: 0x3b3d3b, tin: 0x8d918d, stone: 0x8a8476, stoneDark: 0x6c675d, stonePale: 0xa8a191,
  clay: 0x9a5a3c, soil: 0x4e3d2e, straw: 0xb59a5c, hay: 0xb7a061, burlap: 0x9b8660,
  leafDeep: 0x34502c, leaf: 0x4f6e3a, leafLight: 0x6d8a48, leafPale: 0x86a05a,
  whitewash: 0xd6d0bd, rope: 0x5e5446, glass: 0xd8b878,
});
const FLOWERS = [0xc0485a, 0xe0d2b8, 0xd8b24a, 0x8a6cb0, 0xd9785a, 0xf0e6dc];
const CLOTH = [0xe8e4d8, 0xd9cfb5, 0x7d93a8, 0xc29a52, 0x9c5a44, 0x8c9a80, 0xb7b9b4];
const BUNTING = [0xa8483c, 0xe2d8bc, 0xc79a3c, 0x4f6d8c, 0x5f7d4a];
const LANTERN = [0xe9d6a8, 0xd8a050, 0xb8503c, 0xe6c27a];

// --- yard props -----------------------------------------------------------------------
// Each builder draws in the prop's own frame: +x along the frontage, +z out
// from the wall it stands against, y up from the ground it is seated on.

function barrel(b, m, rng, r = 0.3, h = 0.9) {
  const staves = b.colour(P.woodDark, 0.2, rng), hoop = b.colour(P.iron);
  b.cylinder(sub(m, 0, h / 2, 0), r * 0.92, r * 0.92, h, 8, staves, { cap: b.colour(P.wood, 0.15, rng) });
  b.cylinder(sub(m, 0, h / 2, 0), r, r, h * 0.62, 8, staves, { cap: null });
  for (const y of [0.12, h - 0.12]) b.cylinder(sub(m, 0, y, 0), r * 0.97, r * 0.97, 0.05, 8, hoop, { cap: null });
}

function plant(b, m, rng, size = 0.3, flower = true) {
  const leaf = b.colour([P.leaf, P.leafLight, P.leafDeep][Math.floor(rng() * 3)], 0.15, rng);
  b.lump(sub(m, 0, size * 0.7, 0, rng() * 3), size, size * 0.8, size, leaf);
  if (flower) {
    const petal = b.colour(FLOWERS[Math.floor(rng() * FLOWERS.length)], 0.1, rng);
    // Each bloom is one upturned quad: from any distance a flower is a fleck
    // of colour, and a box per petal was a third of a window box's triangles.
    for (let k = 0; k < 4; k++) {
      const a = rng() * Math.PI * 2, d = size * (0.35 + rng() * 0.5), r = 0.06;
      const at = sub(m, Math.cos(a) * d, size * (1.25 + rng() * 0.25), Math.sin(a) * d, a, (rng() - 0.5) * 0.5);
      b.face(at, [[-r, 0, r], [r, 0, r], [r, 0, -r], [-r, 0, -r]], [0, 1, 0], petal);
    }
  }
}

const PROP_BUILDERS = {
  'water-butt': (b, m, rng) => {
    barrel(b, m, rng, 0.3, 0.92);
    b.box(sub(m, 0, 0.18, 0.3), 0.06, 0.06, 0.1, b.colour(P.iron));
  },
  bench: (b, m, rng, prop) => {
    const plank = b.colour(P.wood, 0.15, rng), leg = b.colour(P.woodDark, 0.1, rng);
    b.box(sub(m, 0, 0.46, 0), prop.w - 0.08, 0.07, prop.d, plank);
    for (const x of [-1, 1]) b.box(sub(m, x * (prop.w / 2 - 0.2), 0.21, 0), 0.09, 0.42, prop.d * 0.78, leg);
  },
  'planter-tub': (b, m, rng) => {
    b.cylinder(sub(m, 0, 0.22, 0), 0.3, 0.26, 0.44, 8, b.colour(P.woodDark, 0.2, rng), { cap: b.colour(P.soil) });
    b.cylinder(sub(m, 0, 0.32, 0), 0.31, 0.31, 0.05, 8, b.colour(P.iron), { cap: null });
    plant(b, sub(m, 0, 0.35, 0), rng, 0.3, rng() < 0.8);
  },
  pots: (b, m, rng) => {
    for (const x of [-0.3, 0.05, 0.32]) {
      const r = 0.12 + rng() * 0.07;
      b.cylinder(sub(m, x, r, (rng() - 0.5) * 0.1), r, r * 0.72, r * 2, 6, b.colour(P.clay, 0.2, rng), { cap: b.colour(P.soil) });
      plant(b, sub(m, x, r * 1.6, 0), rng, r * 1.2, rng() < 0.6);
    }
  },
  'boot-scraper': (b, m) => {
    const iron = b.colour(P.iron);
    for (const x of [-0.12, 0.12]) b.box(sub(m, x, 0.12, 0), 0.03, 0.24, 0.05, iron);
    b.box(sub(m, 0, 0.18, 0), 0.26, 0.025, 0.05, iron);
    b.box(sub(m, 0, 0.02, 0), 0.32, 0.04, 0.18, b.colour(P.stoneDark));
  },
  'flower-bed': (b, m, rng, prop) => {
    b.box(sub(m, 0, 0.05, 0), prop.w, 0.1, prop.d, b.colour(P.soil, 0.1, rng));
    const count = Math.round(prop.w / 0.36);
    for (let k = 0; k < count; k++) {
      const x = -prop.w / 2 + (k + 0.5) * (prop.w / count);
      plant(b, sub(m, x, 0.06, (rng() - 0.5) * 0.18), rng, 0.15 + rng() * 0.07, rng() < 0.75);
    }
  },
  'lamp-post': () => {},   // drawn into the lantern batch, see buildDistrictVisuals
  skep: (b, m, rng) => {
    const wood = b.colour(P.woodGrey, 0.1, rng);
    b.box(sub(m, 0, 0.47, 0), 0.6, 0.06, 0.6, wood);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.box(sub(m, x * 0.24, 0.22, z * 0.24), 0.06, 0.44, 0.06, wood);
    const straw = b.colour(P.straw, 0.12, rng);
    b.cylinder(sub(m, 0, 0.58, 0), 0.24, 0.27, 0.16, 8, straw, { cap: null });
    b.cylinder(sub(m, 0, 0.72, 0), 0.19, 0.24, 0.14, 8, straw, { cap: null });
    b.cylinder(sub(m, 0, 0.85, 0), 0.04, 0.19, 0.14, 8, straw);
    b.box(sub(m, 0, 0.53, 0.25), 0.08, 0.05, 0.04, b.colour(P.woodDark));
  },
  barrel: (b, m, rng) => barrel(b, m, rng),
  'barrel-pair': (b, m, rng) => { barrel(b, sub(m, -0.36, 0, 0), rng); barrel(b, sub(m, 0.36, 0, 0.04), rng, 0.27, 0.8); },
  firewood: (b, m, rng, prop) => {
    const bark = b.colour(P.woodDark, 0.15, rng), end = b.colour(P.cut, 0.15, rng);
    const rail = b.colour(P.woodGrey, 0.1, rng);
    for (const x of [-0.7, 0.7]) b.box(sub(m, x, 0.05, 0), 0.1, 0.1, prop.d, rail);
    const rows = 3, perRow = 4, r = 0.13;
    for (let row = 0; row < rows; row++) {
      const across = perRow - (row === rows - 1 ? 1 : 0);
      for (let k = 0; k < across; k++) {
        const x = -((across - 1) * 0.42) / 2 + k * 0.42 + (row % 2) * 0.05;
        const log = sub(m, x, 0.1 + r + row * r * 1.75, 0, rng() * 0.3, Math.PI / 2, 0);
        b.cylinder(log, r * (0.85 + rng() * 0.3), r * (0.85 + rng() * 0.3), prop.d * 0.95, 5, bark, { cap: end, bottom: true });
      }
    }
    if (rng() < 0.5) {
      // A slab of bark laid over the top against the rain.
      b.box(sub(m, 0, 0.12 + rows * r * 1.75 + 0.06, -0.04, 0, 0.18, 0), prop.w * 0.95, 0.04, prop.d + 0.2, b.colour(P.woodGrey, 0.15, rng));
    }
  },
  'chopping-block': (b, m, rng) => {
    b.cylinder(sub(m, -0.15, 0.22, 0), 0.25, 0.27, 0.44, 7, b.colour(P.woodDark, 0.1, rng), { cap: b.colour(P.cut) });
    b.box(sub(m, -0.15, 0.62, 0.02, 0.4, 0.25, 0.3), 0.045, 0.6, 0.045, b.colour(P.woodLight));
    b.box(sub(m, -0.08, 0.47, 0.06, 0.4, 0.25, 0.3), 0.16, 0.09, 0.035, b.colour(P.iron));
    for (let k = 0; k < 3; k++) b.box(sub(m, 0.2 + k * 0.08, 0.06, (rng() - 0.5) * 0.3, rng() * 3), 0.12, 0.12, 0.38, b.colour(P.cut, 0.2, rng));
  },
  handcart: (b, m, rng) => {
    const wood = b.colour(P.wood, 0.15, rng), dark = b.colour(P.woodDark);
    b.box(sub(m, -0.3, 0.58, 0), 1.2, 0.08, 0.86, wood);
    for (const z of [-0.43, 0.43]) b.box(sub(m, -0.3, 0.72, z), 1.2, 0.22, 0.05, wood);
    b.box(sub(m, -0.88, 0.72, 0), 0.05, 0.22, 0.86, wood);
    for (const z of [-0.36, 0.36]) b.box(sub(m, 0.6, 0.38, z, 0, 0, -0.38), 0.95, 0.06, 0.06, dark);
    for (const z of [-0.52, 0.52]) {
      const wheel = sub(m, -0.35, 0.44, z, 0, Math.PI / 2, 0);
      b.cylinder(wheel, 0.44, 0.44, 0.06, 10, dark, { cap: b.colour(P.woodGrey), bottom: true });
    }
    if (rng() < 0.6) b.lump(sub(m, -0.35, 0.72, 0), 0.4, 0.2, 0.3, b.colour(P.burlap, 0.15, rng));
  },
  wheelbarrow: (b, m, rng) => {
    const wood = b.colour(P.woodGrey, 0.15, rng), dark = b.colour(P.woodDark);
    b.box(sub(m, 0, 0.38, 0, 0, 0, 0.1), 0.85, 0.24, 0.52, wood);
    b.cylinder(sub(m, 0.58, 0.18, 0, 0, Math.PI / 2, 0), 0.18, 0.18, 0.06, 8, dark, { cap: dark, bottom: true });
    for (const z of [-0.2, 0.2]) {
      b.box(sub(m, -0.25, 0.42, z, 0, 0, 0.12), 1.05, 0.05, 0.05, dark);
      b.box(sub(m, -0.25, 0.14, z), 0.05, 0.28, 0.05, dark);
    }
  },
  'drying-rack': (b, m, rng, prop) => {
    const pole = b.colour(P.woodGrey, 0.1, rng);
    for (const x of [-prop.w / 2 + 0.1, prop.w / 2 - 0.1]) {
      for (const z of [-1, 1]) b.box(sub(m, x, 0.8, z * 0.2, 0, z * 0.24, 0), 0.05, 1.65, 0.05, pole);
    }
    for (const y of [1.15, 1.55]) b.box(sub(m, 0, y, 0), prop.w - 0.1, 0.04, 0.04, pole);
    const hang = Math.floor(prop.w / 0.32);
    for (let k = 0; k < hang; k++) {
      const x = -prop.w / 2 + 0.3 + k * ((prop.w - 0.6) / Math.max(1, hang - 1));
      const herbs = rng() < 0.5;
      const rgb = herbs ? b.colour([P.leafPale, P.hay, P.leaf][Math.floor(rng() * 3)], 0.1, rng) : b.colour(CLOTH[Math.floor(rng() * CLOTH.length)], 0.1, rng);
      const y = rng() < 0.5 ? 1.55 : 1.15, h = herbs ? 0.32 : 0.5;
      if (herbs) b.lump(sub(m, x, y - h / 2, 0), 0.08, h / 2, 0.08, rgb);
      else b.card(m, [[x - 0.13, y, 0.01], [x + 0.13, y, 0.01], [x + 0.13, y - h, 0.0], [x - 0.13, y - h, 0.0]], rgb);
    }
  },
  crates: (b, m, rng) => {
    const wood = () => b.colour(P.woodLight, 0.25, rng);
    b.box(sub(m, -0.26, 0.24, 0, rng() * 0.1), 0.52, 0.48, 0.55, wood());
    b.box(sub(m, 0.29, 0.21, 0.02, rng() * 0.15), 0.5, 0.42, 0.5, wood());
    b.box(sub(m, -0.2, 0.69, 0, rng() * 0.3), 0.46, 0.42, 0.46, wood());
  },
  sacks: (b, m, rng) => {
    const cloth = () => b.colour(P.burlap, 0.15, rng);
    b.lump(sub(m, -0.25, 0.24, 0, rng() * 3), 0.27, 0.26, 0.22, cloth());
    b.lump(sub(m, 0.22, 0.22, 0.02, rng() * 3, 0, 0.3), 0.26, 0.24, 0.21, cloth());
  },
  'milk-churns': (b, m, rng) => {
    for (const x of [-0.22, 0.22]) {
      const tin = b.colour(P.tin, 0.1, rng);
      b.cylinder(sub(m, x, 0.24, 0), 0.16, 0.17, 0.48, 8, tin, { cap: null });
      b.cylinder(sub(m, x, 0.55, 0), 0.09, 0.16, 0.14, 8, tin, { cap: null });
      b.cylinder(sub(m, x, 0.66, 0), 0.1, 0.1, 0.08, 8, tin);
    }
  },
  washtub: (b, m, rng) => {
    const wood = b.colour(P.woodGrey, 0.1, rng);
    b.box(sub(m, -0.3, 0.2, 0), 0.6, 0.4, 0.5, wood);
    b.cylinder(sub(m, -0.3, 0.55, 0), 0.32, 0.27, 0.32, 8, b.colour(P.woodDark, 0.1, rng), { cap: b.colour(0x5c6a70) });
    // The mangle: two rollers in a frame, and its wheel.
    const iron = b.colour(P.iron);
    for (const z of [-0.2, 0.2]) b.box(sub(m, 0.32, 0.52, z), 0.07, 1.04, 0.07, iron);
    for (const y of [0.78, 0.9]) b.cylinder(sub(m, 0.32, y, 0, 0, Math.PI / 2, 0), 0.06, 0.06, 0.4, 6, b.colour(P.woodLight), { cap: null });
    b.cylinder(sub(m, 0.32, 0.86, 0.26, 0, Math.PI / 2, 0), 0.2, 0.2, 0.03, 8, iron, { cap: iron, bottom: true });
  },
  ladder: (b, m, rng) => {
    const wood = b.colour(P.woodGrey, 0.15, rng);
    const lean = sub(m, 0, 0, 0.15, 0, -0.17, 0);
    for (const x of [-0.21, 0.21]) b.box(sub(lean, x, 1.5, 0), 0.05, 3.0, 0.06, wood);
    for (let k = 0; k < 9; k++) b.box(sub(lean, 0, 0.3 + k * 0.32, 0), 0.42, 0.04, 0.04, wood);
  },
  broom: (b, m, rng) => {
    const lean = sub(m, 0, 0, 0.08, 0, -0.14, 0.1);
    b.box(sub(lean, 0, 0.75, 0), 0.035, 1.3, 0.035, b.colour(P.woodLight));
    b.lump(sub(lean, 0, 0.12, 0), 0.12, 0.16, 0.08, b.colour(P.straw, 0.1, rng));
  },
  privy: (b, m, rng) => {
    const boards = b.colour(P.woodGrey, 0.18, rng);
    b.box(sub(m, 0, 0.04, 0), 1.24, 0.08, 1.24, b.colour(P.stoneDark), { top: true });
    b.box(sub(m, 0, 1.0, 0), 1.08, 1.92, 1.08, boards);
    b.box(sub(m, 0, 2.02, -0.04, 0, 0.16, 0), 1.3, 0.07, 1.36, b.colour(P.woodDark, 0.1, rng));
    b.box(sub(m, 0.05, 0.98, 0.55), 0.68, 1.72, 0.04, b.colour(P.woodDark, 0.15, rng));
    b.box(sub(m, 0.05, 1.6, 0.575), 0.12, 0.12, 0.02, b.colour(0x2a221c));
  },
  'hen-coop': (b, m, rng) => {
    const boards = b.colour(P.woodGrey, 0.15, rng);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.box(sub(m, x * 0.62, 0.13, z * 0.34), 0.07, 0.26, 0.07, boards);
    b.box(sub(m, 0, 0.6, 0), 1.36, 0.66, 0.78, boards);
    for (const side of [-1, 1]) b.box(sub(m, 0, 1.03, side * 0.2, 0, side * 0.6, 0), 1.48, 0.05, 0.54, b.colour(P.woodDark, 0.1, rng));
    b.box(sub(m, 0.4, 0.62, 0.395), 0.4, 0.4, 0.02, b.colour(0x2c2a26));
    b.box(sub(m, 0.35, 0.18, 0.62, 0, 0.75, 0), 0.3, 0.03, 0.56, boards);
  },
  'veg-rows': (b, m, rng, prop) => {
    b.box(sub(m, 0, 0.05, 0), prop.w, 0.1, prop.d, b.colour(P.soil, 0.1, rng));
    const rows = 3;
    for (let row = 0; row < rows; row++) {
      const z = -prop.d / 2 + (row + 0.5) * (prop.d / rows);
      if (row === 1 && rng() < 0.5) {
        // Beans on poles.
        for (let k = 0; k < 4; k++) {
          const x = -prop.w / 2 + 0.4 + k * ((prop.w - 0.8) / 3);
          b.box(sub(m, x, 0.85, z, 0, 0, (rng() - 0.5) * 0.1), 0.035, 1.6, 0.035, b.colour(P.woodLight));
          b.lump(sub(m, x, 0.95, z), 0.13, 0.5, 0.13, b.colour(P.leafLight, 0.15, rng));
        }
        continue;
      }
      for (let k = 0; k < 4; k++) {
        const x = -prop.w / 2 + 0.35 + k * ((prop.w - 0.7) / 3);
        b.lump(sub(m, x, 0.2, z, rng() * 3), 0.17, 0.13, 0.17, b.colour([P.leaf, P.leafPale, 0x5d7a5a][row % 3], 0.15, rng));
      }
    }
  },
  'hay-rick': (b, m, rng) => {
    const hay = b.colour(P.hay, 0.1, rng);
    b.cylinder(sub(m, 0, 0.55, 0), 0.78, 0.72, 1.1, 9, hay, { cap: null });
    b.cylinder(sub(m, 0, 1.45, 0), 0.06, 0.78, 0.7, 9, b.colour(P.straw, 0.1, rng));
  },
  'notice-board': (b, m, rng) => {
    const wood = b.colour(P.woodDark, 0.1, rng);
    for (const x of [-0.6, 0.6]) b.box(sub(m, x, 0.95, 0), 0.09, 1.9, 0.09, wood);
    b.box(sub(m, 0, 1.35, 0), 1.3, 0.8, 0.06, b.colour(P.wood));
    b.box(sub(m, 0, 1.84, -0.03, 0, -0.35, 0), 1.45, 0.05, 0.3, wood);
    for (let k = 0; k < 4; k++) {
      b.box(sub(m, -0.4 + k * 0.27 + (rng() - 0.5) * 0.05, 1.3 + (rng() - 0.5) * 0.3, 0.035, 0, 0, (rng() - 0.5) * 0.2),
        0.2, 0.26, 0.01, b.colour([0xe8e0c8, 0xd8ccae, 0xc9b98e][k % 3]));
    }
  },
};

// The props too small to be worth drawing from across the village.
const SMALL_PROPS = new Set(['pots', 'boot-scraper', 'flower-bed', 'skep', 'broom', 'ladder', 'chopping-block',
  'sacks', 'milk-churns', 'washtub', 'planter-tub', 'veg-rows', 'drying-rack', 'wheelbarrow']);

// --- boundaries ------------------------------------------------------------------------

function boundaryRun(b, record, world) {
  const rng = mulberry(record.seed);
  const dx = record.bx - record.ax, dz = record.bz - record.az;
  const length = Math.hypot(dx, dz);
  if (length < 0.2) return;
  const yaw = Math.atan2(dx, dz);
  const ground = (t) => {
    const x = record.ax + dx * t, z = record.az + dz * t;
    return world ? world.height(x, z) : record.ay + (record.by - record.ay) * t;
  };
  const piece = record.kind === 'hedge' ? 1.3 : record.kind === 'stone-wall' ? 0.9 : 2.0;
  const pieces = Math.max(1, Math.round(length / piece));
  const step = length / pieces;
  const at = (t, y, lift = 0) => frame(record.ax + dx * t, y + lift, record.az + dz * t, yaw);
  const h = record.height;
  if (record.kind === 'hedge') {
    const body = b.colour(P.leafDeep, 0.12, rng);
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces, y = ground(t) - 0.08;
      const hh = h * (0.94 + rng() * 0.1);
      b.box(sub(at(t, y), 0, hh / 2, 0, (rng() - 0.5) * 0.04), record.thickness * (0.84 + rng() * 0.12), hh, step + 0.08, body);
      // The broken surface: a few lumps on the clipped top and the faces, in
      // two tones, so the ink pass draws a hedge rather than a row of balls.
      for (let j = 0; j < 2; j++) {
        const along = (j - 0.5) * step * 0.5 + (rng() - 0.5) * 0.2;
        b.lump(sub(at(t, y), (rng() - 0.5) * record.thickness * 0.4, hh - 0.02, along, rng() * 3),
          record.thickness * (0.42 + rng() * 0.12), 0.16 + rng() * 0.06, 0.42 + rng() * 0.12,
          b.colour(j ? P.leaf : P.leafLight, 0.14, rng));
      }
      if (k % 2) continue;
      const side = rng() < 0.5 ? -1 : 1;
      b.lump(sub(at(t, y), side * record.thickness * 0.42, hh * (0.4 + rng() * 0.3), (rng() - 0.5) * step * 0.6, rng() * 3),
        0.14, 0.24, 0.3, b.colour(P.leaf, 0.14, rng));
    }
  } else if (record.kind === 'stone-wall') {
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces, y = ground(t) - 0.1;
      const hh = h * (0.92 + rng() * 0.1) - 0.16;
      b.box(sub(at(t, y), 0, hh / 2, 0), record.thickness * (0.95 + rng() * 0.08), hh, step + 0.03, b.colour(P.stone, 0.18, rng));
      // Coping: stones on edge along the top.
      for (let j = 0; j < 3; j++) {
        const along = -step / 2 + (j + 0.5) * (step / 3);
        b.box(sub(at(t, y), 0, hh + 0.09, along, 0, 0, (rng() - 0.5) * 0.15),
          record.thickness * 0.8, 0.2 + rng() * 0.05, step / 3 - 0.03, b.colour(P.stoneDark, 0.2, rng));
      }
    }
  } else if (record.kind === 'pales') {
    const paint = rng() < 0.6 ? P.whitewash : P.woodGrey;
    const wood = b.colour(paint, 0.08, rng);
    const posts = Math.max(1, Math.round(length / 2.0));
    for (let k = 0; k <= posts; k++) {
      const t = k / posts;
      b.box(sub(at(t, ground(t) - 0.1), 0, (h + 0.2) / 2, 0), 0.1, h + 0.2, 0.1, b.colour(P.woodDark));
    }
    for (const y of [h * 0.3, h * 0.78]) {
      for (let k = 0; k < posts; k++) {
        const t0 = k / posts, t1 = (k + 1) / posts, tm = (t0 + t1) / 2;
        const y0 = ground(t0), y1 = ground(t1);
        const pitch = Math.atan2(y1 - y0, length / posts);
        b.box(sub(at(tm, (y0 + y1) / 2), -0.06, y, 0, 0, -pitch, 0), 0.04, 0.07, length / posts, wood);
      }
    }
    const count = Math.max(2, Math.round(length / 0.17));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const ph = h * (0.96 + rng() * 0.04);
      b.box(sub(at(t, ground(t) - 0.05), 0.0, ph / 2, 0), 0.025, ph, 0.075, wood);
    }
  } else if (record.kind === 'wattle') {
    const stake = b.colour(P.woodDark, 0.1, rng);
    const count = Math.max(2, Math.round(length / 0.5));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      b.cylinder(sub(at(t, ground(t) - 0.05), 0, (h + 0.12) / 2, 0), 0.03, 0.035, h + 0.12, 4, stake, { cap: stake });
    }
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces, y = ground(t) - 0.05;
      for (let band = 0; band < 3; band++) {
        const bh = h / 3 - 0.03;
        b.box(sub(at(t, y), (band % 2 ? 1 : -1) * 0.015, bh / 2 + band * (h / 3) + 0.02, 0),
          record.thickness, bh, step + 0.02, b.colour(band % 2 ? 0x8a7350 : 0x7a6444, 0.12, rng));
      }
    }
  } else {
    const wood = b.colour(P.woodGrey, 0.12, rng);
    const posts = Math.max(1, Math.round(length / 2.2));
    for (let k = 0; k <= posts; k++) {
      const t = k / posts;
      b.box(sub(at(t, ground(t) - 0.1), 0, (h + 0.15) / 2, 0), 0.13, h + 0.15, 0.13, b.colour(P.woodDark, 0.1, rng));
    }
    for (const y of [h * 0.42, h * 0.88]) {
      for (let k = 0; k < posts; k++) {
        const t0 = k / posts, t1 = (k + 1) / posts, tm = (t0 + t1) / 2;
        const y0 = ground(t0), y1 = ground(t1);
        const pitch = Math.atan2(y1 - y0, length / posts);
        b.box(sub(at(tm, (y0 + y1) / 2), 0, y, 0, 0, -pitch, 0), 0.07, 0.1, length / posts + 0.1, wood);
      }
    }
  }
}

function post(b, glow, record, rng) {
  const m = frame(record.x, record.y - 0.08, record.z, rng() * Math.PI);
  const h = record.height + 0.08;
  if (record.kind === 'pier') {
    b.box(sub(m, 0, h / 2, 0), 0.42, h, 0.42, b.colour(P.stone, 0.15, rng));
    b.box(sub(m, 0, h + 0.05, 0), 0.5, 0.1, 0.5, b.colour(P.stonePale, 0.1, rng));
    b.lump(sub(m, 0, h + 0.2, 0), 0.13, 0.13, 0.13, b.colour(P.stonePale, 0.1, rng));
  } else if (record.kind === 'bollard') {
    b.cylinder(sub(m, 0, h / 2, 0), 0.14, 0.17, h, 6, b.colour(P.stone, 0.15, rng));
    b.lump(sub(m, 0, h, 0), 0.14, 0.07, 0.14, b.colour(P.stonePale, 0.1, rng));
  } else if (record.kind === 'line-post') {
    const wood = b.colour(P.woodGrey, 0.12, rng);
    b.box(sub(m, 0, h / 2, 0), 0.1, h, 0.1, wood);
    b.box(sub(m, 0, h - 0.12, 0), 0.62, 0.07, 0.07, wood);
  } else if (record.kind === 'lantern-post') {
    const wood = b.colour(P.woodDark, 0.1, rng);
    b.box(sub(m, 0, 0.15, 0), 0.32, 0.3, 0.32, b.colour(P.stoneDark));
    b.box(sub(m, 0, h / 2, 0), 0.14, h, 0.14, wood);
    b.box(sub(m, 0, h + 0.04, 0), 0.24, 0.08, 0.24, wood);
    b.box(sub(m, 0.32, h - 0.25, 0), 0.62, 0.06, 0.06, wood);
    lantern(glow, sub(m, 0.58, h - 0.55, 0), rng, true);
  } else {
    const wood = b.colour(P.woodDark, 0.1, rng);
    b.box(sub(m, 0, h / 2, 0), 0.14, h, 0.14, wood);
    b.box(sub(m, 0, h + 0.03, 0), 0.18, 0.06, 0.18, wood);
  }
}

function lantern(glow, m, rng, glass = false) {
  if (glass) {
    glow.box(sub(m, 0, 0, 0), 0.2, 0.28, 0.2, glow.colour(P.glass));
    glow.box(sub(m, 0, 0.17, 0), 0.26, 0.06, 0.26, glow.colour(P.iron));
    glow.cylinder(sub(m, 0, 0.26, 0), 0.0, 0.13, 0.14, 4, glow.colour(P.iron));
    return;
  }
  glow.lump(sub(m, 0, 0, 0, rng() * 3), 0.13, 0.16, 0.13, glow.colour(LANTERN[Math.floor(rng() * LANTERN.length)], 0.08, rng));
  glow.box(sub(m, 0, 0.17, 0), 0.1, 0.05, 0.1, glow.colour(P.iron));
}

function gate(b, record, rng) {
  const m = frame(record.x, record.y, record.z, record.yaw);
  const wood = b.colour(record.kind === 'pales' ? P.whitewash : P.woodGrey, 0.1, rng);
  const w = record.width, h = record.height;
  for (const x of [0.05, w - 0.05]) b.box(sub(m, x, h / 2 + 0.06, 0), 0.07, h, 0.06, wood);
  for (const y of [0.2, h - 0.05]) b.box(sub(m, w / 2, y + 0.06, 0), w, 0.08, 0.05, wood);
  if (record.kind === 'pales') {
    const n = Math.max(3, Math.round(w / 0.17));
    for (let k = 1; k < n; k++) b.box(sub(m, (k / n) * w, h / 2 + 0.04, 0.02), 0.06, h - 0.04, 0.02, wood);
  } else {
    const diag = Math.hypot(w, h - 0.25);
    b.box(sub(m, w / 2, h / 2 + 0.06, 0, 0, 0, Math.atan2(h - 0.25, w)), diag, 0.06, 0.04, wood);
  }
}

function windowBox(b, record, rng) {
  const m = frame(record.x, record.y, record.z, record.yaw);
  const paint = b.colour([0x5a4434, 0x4e5a52, 0x6b5440, 0x56504a][record.seed % 4], 0.1, rng);
  b.box(sub(m, 0, 0, 0), record.width, 0.2, 0.24, paint, { bottom: true });
  for (const x of [-record.width * 0.35, record.width * 0.35]) b.box(sub(m, x, -0.14, -0.05), 0.05, 0.12, 0.14, paint);
  const n = Math.max(3, Math.round(record.width / 0.22));
  for (let k = 0; k < n; k++) {
    const x = -record.width / 2 + (k + 0.5) * (record.width / n);
    plant(b, sub(m, x, 0.06, 0.02), rng, 0.11 + rng() * 0.04, rng() < 0.8);
  }
  // Something trailing over the front.
  b.lump(sub(m, -record.width * 0.25, -0.08, 0.13), 0.12, 0.16, 0.06, b.colour(P.leaf, 0.12, rng));
}

// --- hanging lines -----------------------------------------------------------------------

function sagPoints(line, segments) {
  const points = [];
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    points.push([
      line.ax + (line.bx - line.ax) * t,
      line.ay + (line.by - line.ay) * t - line.sag * 4 * t * (1 - t),
      line.az + (line.bz - line.az) * t,
    ]);
  }
  return points;
}

function pointOnSag(line, t) {
  return [
    line.ax + (line.bx - line.ax) * t,
    line.ay + (line.by - line.ay) * t - line.sag * 4 * t * (1 - t),
    line.az + (line.bz - line.az) * t,
  ];
}

function hangingLine(lines, glow, line) {
  const rng = mulberry(line.seed);
  const length = Math.hypot(line.bx - line.ax, line.bz - line.az);
  const segments = Math.max(6, Math.ceil(length / 0.7));
  lines.tube(sagPoints(line, segments), line.kind === 'lanterns' ? 0.014 : 0.011, lines.colour(P.rope));
  const yaw = Math.atan2(line.bx - line.ax, line.bz - line.az);
  // Cards hang in the plane of the line: across it is local x.
  const hang = (t, draw) => {
    const [x, y, z] = pointOnSag(line, t);
    const ahead = pointOnSag(line, Math.min(1, t + 0.02)), behind = pointOnSag(line, Math.max(0, t - 0.02));
    const slope = Math.atan2(ahead[1] - behind[1], Math.hypot(ahead[0] - behind[0], ahead[2] - behind[2]));
    draw(frame(x, y, z, yaw - Math.PI / 2, 0, slope));
  };
  if (line.kind === 'washing') {
    let t = 0.1;
    while (t < 0.9) {
      const roll = rng();
      const kind = roll < 0.3 ? 'sheet' : roll < 0.7 ? 'shirt' : 'small';
      const w = kind === 'sheet' ? 0.9 + rng() * 0.5 : kind === 'shirt' ? 0.5 : 0.22;
      const h = kind === 'sheet' ? 0.8 + rng() * 0.35 : kind === 'shirt' ? 0.62 : 0.3;
      const dt = w / length;
      if (t + dt > 0.92) break;
      const rgb = lines.colour(CLOTH[Math.floor(rng() * CLOTH.length)], 0.08, rng);
      hang(t + dt / 2, (m) => {
        const sway = sub(m, 0, 0, 0, 0, (rng() - 0.5) * 0.25, 0);
        lines.card(sway, [[-w / 2, 0, 0], [w / 2, 0, 0], [w / 2, -h, 0.02], [-w / 2, -h, 0.02]], rgb);
        if (kind === 'shirt') {
          for (const side of [-1, 1]) {
            lines.card(sway, [[side * w / 2, -0.02, 0], [side * (w / 2 + 0.22), -0.12, 0.01], [side * (w / 2 + 0.16), -0.3, 0.02], [side * w / 2, -0.24, 0.01]], rgb);
          }
        }
        // A peg either side.
        for (const px of [-w / 2 + 0.04, w / 2 - 0.04]) lines.box(sub(m, px, 0.0, 0), 0.025, 0.07, 0.025, lines.colour(P.woodLight));
      });
      t += dt + 0.03 + rng() * 0.06;
    }
  } else if (line.kind === 'bunting') {
    const count = Math.floor(length / 0.42);
    for (let k = 1; k < count; k++) {
      const rgb = lines.colour(BUNTING[k % BUNTING.length], 0.06, rng);
      hang(k / count, (m) => lines.card(m, [[-0.14, 0, 0], [0.14, 0, 0], [0, -0.32, 0.01]], rgb));
    }
  } else {
    const count = Math.max(2, Math.floor(length / 1.6));
    for (let k = 1; k < count; k++) {
      hang(k / count, (m) => {
        lines.box(sub(m, 0, -0.08, 0), 0.012, 0.16, 0.012, lines.colour(P.rope));
        lantern(glow, sub(m, 0, -0.3, 0), rng);
      });
    }
  }
}

// --- materials ------------------------------------------------------------------------

let sharedMaterial = null;
let lanternMaterial = null;

export function districtMaterial() {
  sharedMaterial ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  sharedMaterial.name = 'district';
  return sharedMaterial;
}

export function districtLanternMaterial() {
  lanternMaterial ||= new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0, emissive: 0xffb45e, emissiveIntensity: 0,
  });
  lanternMaterial.name = 'district-lanterns';
  return lanternMaterial;
}

/** Light the lanterns as the sky darkens; called once a frame with sky.nightAmt. */
export function setDistrictNight(night) {
  const material = districtLanternMaterial();
  const target = Math.max(0, Math.min(1, (night - 0.25) / 0.45)) * 1.6;
  if (Math.abs(material.emissiveIntensity - target) > 0.005) material.emissiveIntensity = target;
}

/**
 * Build a district's meshes into `group` (the structure, merged with the rest
 * of the village's static batch) and `detail` (hidden at range).
 */
export function buildDistrictVisuals(group, detail, district, world) {
  if (!district) return { triangles: 0, meshes: 0 };
  const solid = new Batch(), small = new Batch(), flat = new Batch(), lines = new Batch(), glow = new Batch();
  for (const record of district.boundaries) boundaryRun(solid, record, world);
  for (const record of district.posts) post(solid, glow, record, mulberry(Math.round(record.x * 131 + record.z * 977)));
  for (const record of district.gates) gate(solid, record, mulberry(Math.round(record.x * 71 + record.z * 313)));
  for (const prop of district.props) {
    const rng = mulberry(Math.round(prop.x * 997 + prop.z * 389) ^ prop.variant);
    const target = SMALL_PROPS.has(prop.kind) ? small : solid;
    const m = frame(prop.x, prop.y, prop.z, prop.yaw);
    if (prop.kind === 'lamp-post') {
      post(target, glow, { ...prop, kind: 'lantern-post', height: 2.4 }, rng);
      continue;
    }
    PROP_BUILDERS[prop.kind]?.(target, m, rng, prop);
  }
  for (const record of district.windowBoxes) windowBox(small, record, mulberry(record.seed));
  for (const stone of district.stones) {
    const rng = mulberry(Math.round(stone.x * 577 + stone.z * 211));
    flat.cylinder(frame(stone.x, stone.y + 0.01, stone.z, stone.yaw), stone.r, stone.r * 1.05, 0.07, 7,
      flat.colour(P.stonePale, 0.2, rng));
  }
  for (const gutter of district.gutters) {
    const points = [];
    for (let i = 1; i < gutter.points.length; i++) {
      const a = gutter.points[i - 1], b = gutter.points[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.2));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) points.push({ x: a.x + (b.x - a.x) * k / n, y: a.y, z: a.z + (b.z - a.z) * k / n });
    }
    if (points.length < 2) continue;
    flat.ribbon(points, gutter.width, gutter.offset, flat.colour(0x4a463f), world, 0.045);
    for (const side of [-1, 1]) flat.ribbon(points, 0.07, gutter.offset + side * (gutter.width / 2 + 0.035), flat.colour(P.stonePale), world, 0.06);
  }
  for (const line of district.lines) hangingLine(lines, glow, line);

  const material = districtMaterial();
  let meshes = 0, triangles = 0;
  const add = (parent, batch, { cast, receive, name, mat = material }) => {
    const geometry = batch.geometry();
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = name; mesh.castShadow = cast; mesh.receiveShadow = receive;
    parent.add(mesh);
    meshes++; triangles += batch.triangles;
  };
  add(group, solid, { cast: true, receive: true, name: 'district-structure' });
  add(detail, small, { cast: true, receive: true, name: 'district-small' });
  add(detail, flat, { cast: false, receive: true, name: 'district-ground' });
  add(detail, lines, { cast: false, receive: true, name: 'district-lines' });
  add(detail, glow, { cast: false, receive: false, name: 'district-lanterns', mat: districtLanternMaterial() });
  return { meshes, triangles };
}
