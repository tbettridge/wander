// Parametric vegetation. Every plant and rock is generated from a small set
// of parameters + a seeded RNG — several variants per archetype, instanced
// per chunk, so the world gets variety with almost no draw-call cost.
//
// Deciduous trees and bushes use a recursive branching generator in the
// SpeedTree/ez-tree tradition: tapered branch tubes with per-section
// "gnarl" (random deviation, stronger as branches thin) and a growth force
// bending limbs toward the light, terminating in alpha-tested leaf-cluster
// cards whose normals point outward from the crown centre for soft shading.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp, lerp } from './noise.js';
import { VARIANT_COUNTS } from './vegdata.js';
import { injectAtmosphere } from './atmosphere.js';
import { windUniforms, WIND_GLSL_DECLS } from './wind.js';
import { caveEntranceUniforms, CAVE_EXCLUSION_GLSL } from './cavevisual.js';
import { ROCK_ARCHETYPES, makePlanarRockMesh } from './rockgeometry.mjs';
import { injectPainterFoliage } from './painterfoliage.js';

// --- materials ---------------------------------------------------------------

export const vegMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.95, metalness: 0,
});

// One shared, neutral painterly pigment map for every field rock and boulder.
// Biome/variant colours still come from vertex + instance colours; this texture
// contributes only broad mineral washes, so sandstone, granite and tundra rock
// retain their existing regional palette.
function makeRockSurfaceTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(0x524f434b);
  ctx.fillStyle = '#c8c5bb';
  ctx.fillRect(0, 0, size, size);
  const palette = [
    'rgba(78,84,72,0.12)', 'rgba(116,101,82,0.11)',
    'rgba(151,158,143,0.14)', 'rgba(225,217,198,0.16)',
    'rgba(94,101,105,0.09)',
  ];
  const wrapped = (x, y, draw) => {
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) draw(x + ox, y + oy);
  };
  // Layer broad translucent brush masses first, then a smaller number of dry-
  // brush dabs. Duplicating across tile edges makes the single canvas seamless.
  for (let i = 0; i < 105; i++) {
    const x = rng() * size, y = rng() * size;
    const rx = 10 + rng() * 34, ry = 4 + rng() * 17;
    const rotation = rng() * Math.PI;
    ctx.fillStyle = palette[(rng() * palette.length) | 0];
    wrapped(x, y, (px, py) => {
      ctx.beginPath(); ctx.ellipse(px, py, rx, ry, rotation, 0, Math.PI * 2); ctx.fill();
    });
  }
  for (let i = 0; i < 150; i++) {
    const x = rng() * size, y = rng() * size;
    const value = 110 + (rng() * 105 | 0);
    ctx.fillStyle = `rgba(${value},${value + (rng() * 5 | 0)},${value - (rng() * 7 | 0)},${0.025 + rng() * 0.055})`;
    const rx = 1.5 + rng() * 7, ry = 0.7 + rng() * 2.8;
    wrapped(x, y, (px, py) => {
      ctx.beginPath(); ctx.ellipse(px, py, rx, ry, rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  // Sampled manually in the rock shader as painterly pigment, not as encoded
  // display colour, so keep the values in their authored neutral range.
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const rockSurfaceTexture = typeof document !== 'undefined' ? makeRockSurfaceTexture() : null;
export const rockMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.97, metalness: 0,
});

// Small intertidal pools are geometry rather than part of the infinite ocean
// plane, so they can occupy rock shelves above mean sea level. A restrained
// physical highlight makes them catch sky light without becoming mirror discs.
export const tidePoolMaterial = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: 0.19, metalness: 0,
  transparent: true, opacity: 0.88, depthWrite: false,
  clearcoat: 0.48, clearcoatRoughness: 0.24,
});
tidePoolMaterial.userData.excludeFromAO = true;

// double-sided variant for palm fronds (thin ribbons seen from both sides)
export const frondMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true, side: THREE.DoubleSide,
});

// A 2×2 atlas of leaf-cluster styles in one texture. A card selects a cell by
// UV window (see LEAF_CELL / setCardCell), so one material + one draw call still
// covers every tree yet the forest gets four distinct foliage silhouettes:
//   0 round broadleaf · 1 fine dapple (birch) · 2 bold lobed (oak) · 3 spiky (willow/poplar)
// Shapes are near-white so the per-vertex leaf colour tints them per species.
const LEAF_ATLAS_COLS = 2;
function makeLeafAtlas() {
  const CELL = 128, S = CELL * LEAF_ATLAS_COLS;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const rng = mulberry32(515);

  const leaf = (len, wid, rot, shade, alpha) => {
    ctx.save(); ctx.rotate(rot);
    // neutral grey-white: per-leaf value variation only, so the per-vertex
    // species colour fully owns the hue (a green-tinted texture muddied
    // non-green canopies — pink blossoms multiplied out to sage-grey)
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${alpha})`;
    ctx.beginPath(); ctx.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
  const cell = (col, row, draw) => {
    ctx.save();
    ctx.translate(col * CELL, row * CELL);
    ctx.beginPath(); ctx.rect(1, 1, CELL - 2, CELL - 2); ctx.clip(); // never spill into neighbours
    draw();
    ctx.restore();
  };
  const scatter = (n, spread, drawOne) => {
    for (let i = 0; i < n; i++) {
      const r = 8 + rng() * spread, a = rng() * Math.PI * 2;
      ctx.save();
      ctx.translate(64 + Math.cos(a) * r * 0.85, 64 + Math.sin(a) * r * 0.85);
      drawOne(a);
      ctx.restore();
    }
  };

  // 0 — round broadleaf: medium leaves in a full rounded clump
  cell(0, 0, () => scatter(60, 40, () => {
    const len = 13 + rng() * 16;
    leaf(len, len * (0.38 + rng() * 0.2), rng() * Math.PI, 200 + (rng() * 55 | 0), 0.85 + rng() * 0.15);
  }));
  // 1 — fine dapple: many tiny near-round leaves (birch, aspen)
  cell(1, 0, () => scatter(140, 44, () => {
    const len = 5 + rng() * 7;
    leaf(len, len * (0.65 + rng() * 0.25), rng() * Math.PI, 205 + (rng() * 50 | 0), 0.8 + rng() * 0.2);
  }));
  // 2 — bold lobed: fewer large leaves, overlapping to read as lobes (oak, maple)
  cell(0, 1, () => scatter(26, 38, () => {
    const len = 22 + rng() * 18;
    leaf(len, len * (0.5 + rng() * 0.25), rng() * Math.PI, 198 + (rng() * 50 | 0), 0.9 + rng() * 0.1);
  }));
  // 3 — spiky: elongated pointed leaves splaying outward (willow, poplar)
  cell(1, 1, () => scatter(70, 42, (a) => {
    const len = 20 + rng() * 18;
    leaf(len, len * (0.14 + rng() * 0.08), a + (rng() - 0.5) * 0.7, 200 + (rng() * 55 | 0), 0.85 + rng() * 0.15);
  }));

  // Pre-bleed each cell's leaf RGB into its transparent pixels so the mip chain
  // only ever averages leaf-coloured pixels together (the classic alpha-test +
  // mipmap "translucent square" fix), done per-cell so styles don't cross-bleed.
  const img = ctx.getImageData(0, 0, S, S), data = img.data;
  for (let cy = 0; cy < LEAF_ATLAS_COLS; cy++) {
    for (let cx = 0; cx < LEAF_ATLAS_COLS; cx++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
        const i = (y * S + x) * 4, a = data[i + 3];
        if (a > 16) { sr += data[i] * a; sg += data[i + 1] * a; sb += data[i + 2] * a; sa += a; }
      }
      const lr = sa ? sr / sa : 165, lg = sa ? sg / sa : 195, lb = sa ? sb / sa : 125;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
        const i = (y * S + x) * 4;
        if (data[i + 3] < 16) { data[i] = lr; data[i + 1] = lg; data[i + 2] = lb; }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// Remap a leaf card's [0,1] UVs into atlas cell `style` (0..3), so it samples
// only that one cluster style. Rotations on the card leave UVs untouched.
function setCardCell(geo, style) {
  const col = style % LEAF_ATLAS_COLS, row = (style / LEAF_ATLAS_COLS) | 0;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) + col) / LEAF_ATLAS_COLS, (uv.getY(i) + row) / LEAF_ATLAS_COLS);
  }
}

export const leafMaterial = new THREE.MeshLambertMaterial({
  map: typeof document !== 'undefined' ? makeLeafAtlas() : null,
  // Hard alphaTest only — alphaToCoverage interprets the corner-bled alpha
  // gradient as partial-coverage pixels and renders the leaf-tinted pre-bleed
  // RGB on them, which read as visible rectangles around each leaf cluster.
  // The post pipeline's MSAA still anti-aliases the per-leaf silhouette via
  // per-fragment sampling, so leaf edges stay clean enough without A2C.
  alphaTest: 0.5,
  side: THREE.DoubleSide,
  vertexColors: true,
});
// Canopy sway. The per-instance high-frequency wiggle stays (good close-range
// detail), but it's multiplied by a coherent gust intensity sampled at the
// tree's world position, and a directional bend pushes the whole crown
// downwind — so passing gusts ripple across the forest in visible waves. Shared
// by the leaf cards and the solid blob crowns so both breathe together.
function addCanopySway(material, shader) {
  shader.uniforms.uTime = { value: 0 };
  for (const k in windUniforms) shader.uniforms[k] = windUniforms[k];
  shader.vertexShader = 'uniform float uTime;\n' + WIND_GLSL_DECLS +
    shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
     float lw = clamp(position.y * 0.12, 0.0, 0.6);
     vec2 lip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
     float lph = lip.x * 0.9 + lip.y * 1.3;
     float lgust = windGust(lip);                                       // 0..1
     float lamp = 0.18 + 1.2 * lgust * uWindStrength;                    // gusts swell amplitude
     float lwig = (sin(uTime * 1.1 + lph) * 0.6 + sin(uTime * 2.3 + lph * 1.7) * 0.4) * 0.06;
     transformed.x += (lwig + uWindDir.x * lgust * uWindStrength * 0.55) * lamp * lw;
     transformed.z += (cos(uTime * 1.4 + lph) * 0.04 + uWindDir.y * lgust * uWindStrength * 0.55) * lamp * lw;`
  );
  material.userData.shader = shader;
}
leafMaterial.onBeforeCompile = (shader) => {
  addCanopySway(leafMaterial, shader);
  // undo the double-sided normal flip so the crown-outward normals hold from
  // every viewing angle — keeps canopy shading soft instead of patchworked
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
     #ifdef DOUBLE_SIDED
       normal *= faceDirection;
     #endif`
  );
};

// --- small helpers -----------------------------------------------------------

function paintGeometry(geo, color, jitterRng, jitterAmt = 0.06) {
  if (geo.index) geo = geo.toNonIndexed(); // merge needs uniform indexing
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = 1 + (jitterRng() * 2 - 1) * jitterAmt;
    colors[i * 3] = clamp(color.r * j, 0, 1);
    colors[i * 3 + 1] = clamp(color.g * j, 0, 1);
    colors[i * 3 + 2] = clamp(color.b * j, 0, 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geo;
}

// --- rocks ---------------------------------------------------------------
// Coherent displacement keeps the surface closed: every vertex moves as a
// function of its direction only, so duplicated vertices (non-indexed
// icosahedra) displace identically and the mesh never tears. Low-frequency
// trig lobes shape the silhouette; a coordinate hash adds mineral grain.

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeRockGeometry(rng, { detail, smooth, lobe, grain, squash }) {
  let geo = new THREE.IcosahedronGeometry(1, detail);
  if (smooth) geo = mergeVertices(geo); // index it → smooth weathered normals
  const pos = geo.attributes.position;
  const f1 = 1.5 + rng() * 2.5, f2 = 1.5 + rng() * 2.5, f3 = 1.5 + rng() * 2.5;
  const p1 = rng() * 6.28, p2 = rng() * 6.28, p3 = rng() * 6.28;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const d = 1
      + lobe * (Math.sin(v.x * f1 + p1) * Math.sin(v.y * f2 + p2) * 0.6
              + Math.sin(v.z * f3 + p3) * Math.sin(v.x * f2 + p1) * 0.4)
      + grain * (hash3(v.x, v.y, v.z) - 0.5);
    pos.setXYZ(i, v.x * d, v.y * d, v.z * d);
  }
  geo.scale(1, squash, 1);
  geo.computeVertexNormals();
  return geo;
}

function buildPebble(rng) { // smooth, water-worn, flattened
  const geo = makeRockGeometry(rng, {
    detail: 1, smooth: true, lobe: 0.12, grain: 0.06, squash: 0.5 + rng() * 0.25,
  });
  const col = new THREE.Color().setHSL(0.07 + rng() * 0.06, 0.04 + rng() * 0.1, 0.52 + rng() * 0.18);
  return { geo: paintGeometry(geo, col, rng, 0.05), mats: [vegMaterial] };
}

// Field rocks deliberately do NOT reuse the pebble's displaced icosphere. A
// convex volume clipped by a handful of planes produces the broad top/side
// facets, shouldered silhouettes and chipped corners seen in exposed stone.
// Faces remain polygons until the final triangulation, and every triangle from
// one polygon receives the same normal and pigment so no hidden triangulation
// pattern breaks up the plane.
function paintPlanarRock(geometry, color, rng) {
  const normal = geometry.attributes.normal;
  const colors = new Float32Array(normal.count * 3);
  const mineralSeed = rng() * 17.0;
  for (let i = 0; i < normal.count; i++) {
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    const mineral = hash3(
      Math.round(nx * 100) + mineralSeed,
      Math.round(ny * 100) - mineralSeed,
      Math.round(nz * 100) + mineralSeed * 0.5,
    );
    const shade = 0.88 + Math.max(0, ny) * 0.13 + mineral * 0.07;
    colors[i * 3] = clamp(color.r * shade, 0, 1);
    colors[i * 3 + 1] = clamp(color.g * shade, 0, 1);
    colors[i * 3 + 2] = clamp(color.b * shade, 0, 1);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function makePlanarRockGeometry(rng, archetype, boulder) {
  const mesh = makePlanarRockMesh(rng, archetype, boulder);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mesh.positions.length / 3 * 2), 2));
  return geometry;
}

function buildRock(rng, archetype = 'block') {
  const geo = makePlanarRockGeometry(rng, archetype, false);
  const col = new THREE.Color().setHSL(0.08 + rng() * 0.04, 0.05 + rng() * 0.06, 0.36 + rng() * 0.09);
  return { geo: paintPlanarRock(geo, col, rng), mats: [rockMaterial] };
}

function buildBoulder(rng, archetype = 'block') {
  const geo = makePlanarRockGeometry(rng, archetype, true);
  const col = new THREE.Color().setHSL(0.08 + rng() * 0.05, 0.05 + rng() * 0.07, 0.34 + rng() * 0.10);
  return { geo: paintPlanarRock(geo, col, rng), mats: [rockMaterial] };
}

// Tapered tube along a point path using parallel-transport frames (no twist),
// closed with a tip fan. The workhorse for trunks and branches.
function tubeGeometry(pts, radii, radialSegs) {
  const rings = pts.length;
  const positions = [], normals = [], uvs = [], indices = [];
  const tangent = new THREE.Vector3();
  const u = new THREE.Vector3(), w = new THREE.Vector3(), n = new THREE.Vector3();

  // initial frame
  tangent.subVectors(pts[1], pts[0]).normalize();
  u.set(1, 0, 0);
  if (Math.abs(tangent.x) > 0.9) u.set(0, 0, 1);
  u.cross(tangent).normalize();

  for (let i = 0; i < rings; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(rings - 1, i + 1)];
    tangent.subVectors(next, prev).normalize();
    // parallel transport: keep u perpendicular to the new tangent
    u.addScaledVector(tangent, -u.dot(tangent)).normalize();
    w.crossVectors(tangent, u);
    for (let j = 0; j < radialSegs; j++) {
      const a = (j / radialSegs) * Math.PI * 2;
      n.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
      positions.push(
        pts[i].x + n.x * radii[i],
        pts[i].y + n.y * radii[i],
        pts[i].z + n.z * radii[i]
      );
      normals.push(n.x, n.y, n.z);
      uvs.push(j / radialSegs, i / (rings - 1));
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * radialSegs + j;
      const b = i * radialSegs + ((j + 1) % radialSegs);
      const c = a + radialSegs, d = b + radialSegs;
      indices.push(a, c, b, b, c, d);
    }
  }
  // tip
  const tipIdx = positions.length / 3;
  const last = pts[rings - 1];
  tangent.subVectors(last, pts[rings - 2]).normalize();
  positions.push(last.x + tangent.x * radii[rings - 1], last.y + tangent.y * radii[rings - 1], last.z + tangent.z * radii[rings - 1]);
  normals.push(tangent.x, tangent.y, tangent.z);
  uvs.push(0.5, 1);
  for (let j = 0; j < radialSegs; j++) {
    const a = (rings - 1) * radialSegs + j;
    const b = (rings - 1) * radialSegs + ((j + 1) % radialSegs);
    indices.push(a, tipIdx, b);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// --- recursive branching tree -------------------------------------------------
// Species presets. Angles in radians; gnarl is per-section random deviation,
// scaled up as branches thin; "up" is the phototropic pull toward the sky.

const SPECIES = {
  temperate: {
    levels: 2,
    trunkLen: [4.5, 8], trunkRadius: [0.16, 0.3],
    sections: [6, 4, 3], radialSegs: [7, 5, 4],
    taper: 0.62, gnarl: 0.16, up: 0.10,
    children: [[3, 5], [2, 4]],
    spawnRange: [0.35, 0.95],
    angle: [0.55, 1.0],
    radiusRatio: 0.58, lengthRatio: 0.66,
    leafCards: [11, 16], leafSize: [1.3, 2.1], leafFlat: 1, leafStyles: [0, 2], // round / bold-lobed
    bark: (rng) => new THREE.Color().setHSL(0.07 + rng() * 0.03, 0.22 + rng() * 0.12, 0.26 + rng() * 0.1),
    leaf: (rng) => new THREE.Color().setHSL(0.24 + rng() * 0.1, 0.45 + rng() * 0.2, 0.32 + rng() * 0.12),
  },
  acacia: { // savanna: slender trunk, umbrella crown
    levels: 2,
    trunkLen: [3.8, 6], trunkRadius: [0.12, 0.2],
    sections: [5, 4, 3], radialSegs: [6, 5, 4],
    taper: 0.55, gnarl: 0.22, up: 0.06,
    children: [[3, 4], [2, 3]],
    spawnRange: [0.78, 1.0],          // branches only near the top
    angle: [1.05, 1.4],               // spread wide
    radiusRatio: 0.55, lengthRatio: 0.6,
    leafCards: [4, 7], leafSize: [1.2, 1.9], leafFlat: 0.32, leafStyles: [3, 1], // flat crown, spiky/fine
    bark: (rng) => new THREE.Color().setHSL(0.07, 0.18 + rng() * 0.1, 0.24 + rng() * 0.08),
    leaf: (rng) => new THREE.Color().setHSL(0.18 + rng() * 0.06, 0.42 + rng() * 0.15, 0.3 + rng() * 0.08),
  },
  bush: {
    levels: 1,
    trunkLen: [0.9, 1.7], trunkRadius: [0.045, 0.08],
    sections: [4, 3], radialSegs: [5, 4],
    taper: 0.6, gnarl: 0.3, up: 0.12,
    children: [[2, 4]],
    spawnRange: [0.25, 0.9],
    angle: [0.5, 1.1],
    radiusRatio: 0.6, lengthRatio: 0.75,
    leafCards: [5, 8], leafSize: [0.7, 1.15], leafFlat: 0.9, leafStyles: [0, 1],
    bark: (rng) => new THREE.Color().setHSL(0.08, 0.2, 0.24 + rng() * 0.08),
    leaf: (rng) => new THREE.Color().setHSL(0.26 + rng() * 0.08, 0.42 + rng() * 0.18, 0.3 + rng() * 0.1),
    stems: [2, 4], // bushes grow several stems from the ground
  },
  drybush: {
    levels: 1,
    trunkLen: [0.7, 1.3], trunkRadius: [0.035, 0.06],
    sections: [4, 3], radialSegs: [5, 4],
    taper: 0.6, gnarl: 0.42, up: 0.05,
    children: [[2, 3]],
    spawnRange: [0.2, 0.9],
    angle: [0.6, 1.2],
    radiusRatio: 0.62, lengthRatio: 0.8,
    leafCards: [2, 4], leafSize: [0.45, 0.75], leafFlat: 0.9, leafStyles: [1, 3],
    bark: (rng) => new THREE.Color().setHSL(0.09, 0.15, 0.3 + rng() * 0.08),
    leaf: (rng) => new THREE.Color().setHSL(0.13 + rng() * 0.05, 0.32 + rng() * 0.12, 0.34 + rng() * 0.08),
    stems: [2, 4],
  },
  dead: {
    levels: 2,
    trunkLen: [2.8, 5.5], trunkRadius: [0.1, 0.18],
    sections: [5, 4, 3], radialSegs: [6, 4, 4],
    taper: 0.7, gnarl: 0.45, up: 0.02,
    children: [[2, 4], [1, 3]],
    spawnRange: [0.3, 0.95],
    angle: [0.6, 1.3],
    radiusRatio: 0.5, lengthRatio: 0.62,
    leafCards: [0, 0], leafSize: [0, 0], leafFlat: 1, // bare
    bark: (rng) => new THREE.Color().setHSL(0.08, 0.1, 0.32 + rng() * 0.1),
    leaf: () => new THREE.Color(),
  },
  oak: { // low fork, gnarled spreading limbs, broad flattened crown
    levels: 2,
    trunkLen: [2.4, 3.8], trunkRadius: [0.3, 0.46],
    sections: [5, 4, 3], radialSegs: [8, 6, 4],
    taper: 0.55, gnarl: 0.3, up: 0.05,
    children: [[3, 5], [2, 4]],
    spawnRange: [0.3, 0.85],          // limbs fork low on the bole
    angle: [0.8, 1.3],                // and spread wide
    radiusRatio: 0.6, lengthRatio: 0.85,
    leafCards: [13, 18], leafSize: [1.5, 2.3], leafFlat: 0.75, leafStyles: [2], // bold lobed
    bark: (rng) => new THREE.Color().setHSL(0.07 + rng() * 0.02, 0.22 + rng() * 0.08, 0.2 + rng() * 0.07),
    leaf: (rng) => new THREE.Color().setHSL(0.22 + rng() * 0.06, 0.42 + rng() * 0.15, 0.28 + rng() * 0.08),
  },
  birch: { // slender pale bole, upright narrow crown of fine trembling leaves
    levels: 2,
    trunkLen: [5.5, 8.5], trunkRadius: [0.09, 0.15],
    sections: [6, 4, 3], radialSegs: [6, 5, 4],
    taper: 0.66, gnarl: 0.12, up: 0.16,
    children: [[2, 4], [2, 3]],
    spawnRange: [0.45, 0.95],
    angle: [0.4, 0.75],               // held close to the trunk
    radiusRatio: 0.48, lengthRatio: 0.5,
    leafCards: [8, 12], leafSize: [0.9, 1.5], leafFlat: 1, leafStyles: [1], // fine dapple
    bark: (rng) => new THREE.Color().setHSL(0.1, 0.04 + rng() * 0.04, 0.66 + rng() * 0.12), // paper white
    leaf: (rng) => new THREE.Color().setHSL(0.23 + rng() * 0.07, 0.42 + rng() * 0.15, 0.34 + rng() * 0.1),
  },
  willow: { // riverside weeper: limbs rise from a stout bole then trail down
    levels: 2,
    trunkLen: [2.6, 4.2], trunkRadius: [0.22, 0.34],
    sections: [5, 5, 4], radialSegs: [7, 5, 4],
    taper: 0.55, gnarl: 0.2, up: [0.14, -0.05, -0.2], // trunk up, limbs sag, tips pour
    children: [[4, 6], [2, 3]],
    spawnRange: [0.55, 1.0],
    angle: [0.8, 1.25],
    radiusRatio: 0.55, lengthRatio: 0.95, // long trailing limbs
    leafCards: [10, 15], leafSize: [1.0, 1.6], leafFlat: 0.6, leafStyles: [3], // spiky streamers
    bark: (rng) => new THREE.Color().setHSL(0.08, 0.16 + rng() * 0.08, 0.24 + rng() * 0.08),
    leaf: (rng) => new THREE.Color().setHSL(0.21 + rng() * 0.05, 0.3 + rng() * 0.12, 0.36 + rng() * 0.08), // silvery green
  },
  poplar: { // columnar: tall, branches short and steep all along the bole
    levels: 1,
    trunkLen: [7, 10.5], trunkRadius: [0.16, 0.24],
    sections: [7, 4], radialSegs: [6, 4],
    taper: 0.7, gnarl: 0.1, up: 0.2,
    children: [[6, 9]],
    spawnRange: [0.12, 0.92],         // clothed in branches nearly to the ground
    angle: [0.3, 0.55],               // hugging the trunk → tight column
    radiusRatio: 0.4, lengthRatio: 0.32,
    leafCards: [3, 5], leafSize: [0.9, 1.4], leafFlat: 1.4, leafStyles: [1, 3], // stretched tall
    bark: (rng) => new THREE.Color().setHSL(0.09, 0.1 + rng() * 0.06, 0.36 + rng() * 0.1),
    leaf: (rng) => new THREE.Color().setHSL(0.23 + rng() * 0.05, 0.45 + rng() * 0.12, 0.3 + rng() * 0.08),
  },
  baobab: { // savanna upside-down tree: massive bottle trunk, stubby top tuft
    levels: 2,
    trunkLen: [3.2, 4.6], trunkRadius: [0.55, 0.85],
    sections: [5, 3, 2], radialSegs: [9, 5, 4],
    taper: 0.5, gnarl: 0.1, up: 0.06,
    children: [[4, 6], [2, 3]],
    spawnRange: [0.88, 1.0],          // branches only at the very top
    angle: [0.7, 1.15],
    radiusRatio: 0.28, lengthRatio: 0.3, // abruptly thin, stubby limbs
    leafCards: [3, 5], leafSize: [0.8, 1.2], leafFlat: 0.45, leafStyles: [1],
    bark: (rng) => new THREE.Color().setHSL(0.06 + rng() * 0.02, 0.14 + rng() * 0.06, 0.4 + rng() * 0.1),
    leaf: (rng) => new THREE.Color().setHSL(0.2 + rng() * 0.05, 0.38 + rng() * 0.12, 0.3 + rng() * 0.08),
  },
  blossom: { // hero tree: picturesque low crooked form under a pink cloud
    levels: 2,
    trunkLen: [2.2, 3.4], trunkRadius: [0.15, 0.24],
    sections: [5, 4, 3], radialSegs: [7, 5, 4],
    taper: 0.6, gnarl: 0.34, up: 0.04,
    children: [[3, 4], [2, 3]],
    spawnRange: [0.35, 0.9],
    angle: [0.7, 1.2],
    radiusRatio: 0.58, lengthRatio: 0.72,
    leafCards: [11, 15], leafSize: [1.1, 1.8], leafFlat: 0.85, leafStyles: [1], // fine petal dapple
    bark: (rng) => new THREE.Color().setHSL(0.05, 0.18 + rng() * 0.08, 0.17 + rng() * 0.06), // dark cherry
    leaf: (rng) => new THREE.Color().setHSL(0.93 + rng() * 0.05, 0.38 + rng() * 0.14, 0.66 + rng() * 0.1), // pink
  },
};

// Grow one limb: a gnarled tube that curves out of its parent, then either
// forks into children or hangs leaf cards. Organic junctions come from three
// things working together — the child departs ALONG the parent and curves to
// its target over its first half (no hard elbow), its base swells into a collar
// that merges with the parent surface (hiding the tube-through-tube seam), and
// every limb obeys area conservation (the parent carries the summed cross-
// section of its children) so trunks visibly thin above forks and flare into a
// buttress at the root. opts: { curveTarget, flareRadius }.
function growBranch(ctx, start, startDir, radius, length, level, opts) {
  const P = ctx.species;
  const rng = ctx.rng;
  const sections = P.sections[Math.min(level, P.sections.length - 1)];
  const radial = P.radialSegs[Math.min(level, P.radialSegs.length - 1)];
  const segLen = length / sections;
  const curveTarget = opts && opts.curveTarget;
  const curveEnd = Math.max(1, Math.round(sections * 0.5)); // curve done by mid-limb

  // --- guide path: curved departure, then accumulating gnarl + phototropism --
  const pts = [start.clone()];
  const dir = startDir.clone();
  const axis = new THREE.Vector3();
  const rand = new THREE.Vector3();
  for (let i = 1; i <= sections; i++) {
    // ease from the parent tangent toward the branch's target, closing the
    // remaining angle evenly over the curve zone so the limb flows out smoothly
    if (curveTarget && i <= curveEnd) {
      const ang = dir.angleTo(curveTarget);
      if (ang > 1e-4) {
        axis.crossVectors(dir, curveTarget).normalize();
        dir.applyAxisAngle(axis, ang / (curveEnd - i + 1));
      }
    }
    // gnarl grows as the limb thins — thin branches wander and twist
    const thin = 1 - radius / ctx.trunkRadius;
    const g = P.gnarl * (0.5 + thin) * (0.6 + 0.7 * (i / sections));
    rand.set(rng() - 0.5, rng() - 0.5, rng() - 0.5);
    axis.crossVectors(dir, rand).normalize();
    dir.applyAxisAngle(axis, (rng() * 2 - 1) * g);
    // phototropism: pull toward the sky, more on the trunk. An array `up` gives
    // per-level pull instead — negative values droop (weeping willows).
    dir.y += Array.isArray(P.up)
      ? P.up[Math.min(level, P.up.length - 1)]
      : P.up * (level === 0 ? 1.3 : 0.7);
    dir.normalize();
    pts.push(pts[i - 1].clone().addScaledVector(dir, segLen));
  }

  // --- decide children first, so the parent can thin above each fork ---------
  const estR = (idx) => radius * (1 - P.taper * (idx / sections)); // linear-taper estimate
  const kids = [];
  if (level < P.levels) {
    const [cMin, cMax] = P.children[Math.min(level, P.children.length - 1)];
    const nKids = cMin + Math.round(rng() * (cMax - cMin));
    const azim0 = rng() * Math.PI * 2;
    for (let k = 0; k < nKids; k++) {
      const t = P.spawnRange[0] + rng() * (P.spawnRange[1] - P.spawnRange[0]);
      const idx = Math.min(sections - 1, Math.floor(t * sections));
      const baseDir = pts[idx + 1].clone().sub(pts[idx]).normalize();
      // child leaves the parent at a wide angle, azimuths spread evenly
      const azim = azim0 + (k / nKids) * Math.PI * 2 + (rng() - 0.5) * 0.9;
      rand.set(Math.cos(azim), 0.15 * (rng() - 0.5), Math.sin(azim));
      axis.crossVectors(baseDir, rand).normalize();
      const angle = P.angle[0] + rng() * (P.angle[1] - P.angle[0]);
      const childDir = baseDir.clone().applyAxisAngle(axis, angle);
      const childRadius = Math.max(estR(idx) * P.radiusRatio * (0.85 + rng() * 0.3), 0.015);
      const childLen = length * P.lengthRatio * (0.75 + rng() * 0.5);
      kids.push({ idx, baseDir, childDir, childRadius, childLen });
    }
  }

  // --- radii: linear taper, thickened below each fork by the carried branch
  //     area (pipe model), normalised so the base stays the requested radius --
  const radii = new Array(sections + 1);
  let carried = 0; // summed cross-section area of branches above this ring
  for (let i = sections; i >= 0; i--) {
    for (const kid of kids) if (kid.idx === i) carried += kid.childRadius * kid.childRadius;
    const b = estR(i);
    radii[i] = Math.sqrt(b * b + carried);
  }
  const norm = radius / radii[0];
  for (let i = 0; i <= sections; i++) radii[i] *= norm;
  // base flare: swell the first rings into a collar (branch→trunk) or buttress
  // (trunk→ground), decaying back to the profile by ring ~2.4
  const flareR = (opts && opts.flareRadius) || radii[0];
  for (let i = 0; i <= sections; i++) {
    const w = Math.max(0, 1 - i / 2.4);
    radii[i] = radii[i] * (1 - w) + Math.max(radii[i], flareR) * w;
  }

  ctx.barkParts.push(paintGeometry(tubeGeometry(pts, radii, radial), ctx.barkCol, rng, 0.08));

  // --- recurse into children: each departs along the parent (curveTarget is
  //     its real angled direction) and gets a collar sized to the trunk here --
  for (const kid of kids) {
    growBranch(ctx, pts[kid.idx], kid.baseDir, kid.childRadius, kid.childLen, level + 1, {
      curveTarget: kid.childDir,
      flareRadius: radii[kid.idx] * 0.92,
    });
  }

  // --- terminal branch: a tuft of leaf cards clustered at the tip -----------
  // Ghibli canopies read as a few big soft clumps, not confetti strewn down the
  // whole limb — so cards concentrate over the outer third around the tip point,
  // and each samples the tree's chosen atlas style.
  if (level >= P.levels) {
    const [lMin, lMax] = P.leafCards;
    const nLeaves = lMin + Math.round(rng() * (lMax - lMin));
    for (let k = 0; k < nLeaves; k++) {
      // the first card anchors right at the tip; the rest fill the outer half of
      // the limb, tip-weighted — a full soft clump without gaps between branches
      const t = k === 0 ? 1.0 : 0.5 + rng() * 0.5;
      const idx = Math.min(sections, Math.round(t * sections));
      const anchor = pts[idx];
      const size = (P.leafSize[0] + rng() * (P.leafSize[1] - P.leafSize[0])) * (k === 0 ? 1.15 : 1.0);
      const card = new THREE.PlaneGeometry(size, size);
      card.rotateX((rng() - 0.5) * 1.2);
      card.rotateY(rng() * Math.PI * 2);
      card.rotateZ((rng() - 0.5) * 0.8);
      setCardCell(card, ctx.leafStyle);
      // moderate spatial spread so cards read as one soft clump, not a point
      const off = new THREE.Vector3(
        (rng() - 0.5) * size * 0.6,
        (rng() - 0.5) * size * 0.6 * P.leafFlat,
        (rng() - 0.5) * size * 0.6
      );
      card.translate(anchor.x + off.x, anchor.y + off.y, anchor.z + off.z);
      ctx.leafParts.push(paintGeometry(card, ctx.leafCol, rng, 0.16));
    }
  }
}

// Soft canopy shading, shared by leaf cards and blob crowns: every vertex normal
// points outward from the crown centre (with a +y floor so undersides never go
// pure black), and a two-tone value ramp is baked into the vertex colour (inner
// darker, outer brighter) so the mass reads as volume, not a flat blob.
function shadeCanopy(geo, crown, crownR) {
  const p = geo.attributes.position, n = geo.attributes.normal, c = geo.attributes.color;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i) - crown.x, dy = p.getY(i) - crown.y, dz = p.getZ(i) - crown.z;
    v.set(dx, dy + 0.6, dz).normalize();
    if (v.y < 0.22) { v.y = 0.22; v.normalize(); }
    n.setXYZ(i, v.x, v.y, v.z);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / crownR;
    const s = Math.max(0, Math.min(1, (d - 0.15) / 0.8));
    const f = 0.6 + 0.55 * (s * s * (3 - 2 * s));
    c.setXYZ(i, c.getX(i) * f, c.getY(i) * f, c.getZ(i) * f);
  }
}

function buildBranchingPlant(rng, speciesName) {
  const P = SPECIES[speciesName];
  const ctx = {
    species: P, rng,
    barkParts: [], leafParts: [],
    barkCol: P.bark(rng), leafCol: P.leaf(rng),
    // one leaf-atlas style per tree (coherent foliage), drawn from the species' set
    leafStyle: P.leafStyles ? P.leafStyles[(rng() * P.leafStyles.length) | 0] : 0,
    trunkRadius: 0,
  };
  const stems = P.stems ? P.stems[0] + Math.round(rng() * (P.stems[1] - P.stems[0])) : 1;
  for (let s = 0; s < stems; s++) {
    const radius = P.trunkRadius[0] + rng() * (P.trunkRadius[1] - P.trunkRadius[0]);
    const len = P.trunkLen[0] + rng() * (P.trunkLen[1] - P.trunkLen[0]);
    ctx.trunkRadius = radius;
    const tilt = stems > 1 ? 0.25 + rng() * 0.5 : (rng() - 0.5) * 0.12;
    const azim = rng() * Math.PI * 2;
    const dir = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(azim), Math.cos(tilt), Math.sin(tilt) * Math.sin(azim)
    );
    growBranch(ctx, new THREE.Vector3(0, -0.1, 0), dir, radius, len, 0, { flareRadius: radius * 1.7 });
  }

  const bark = mergeGeometries(ctx.barkParts);
  if (ctx.leafParts.length === 0) {
    return { geo: bark, mats: [vegMaterial] };
  }
  const leaves = mergeGeometries(ctx.leafParts);
  leaves.computeBoundingSphere();
  const crown = leaves.boundingSphere.center;
  const crownR = Math.max(leaves.boundingSphere.radius, 0.001);
  shadeCanopy(leaves, crown, crownR);

  const geo = mergeGeometries([bark, leaves], true); // groups: [bark, leaves]
  return { geo, mats: [vegMaterial, leafMaterial] };
}

// --- other archetypes (unchanged styles) --------------------------------------

// Conifer: gently wandering trunk tube + overlapping irregular foliage
// skirts. Each skirt is a cone displaced coherently (hash of vertex
// direction, so seam duplicates agree and the surface stays closed) with a
// drooping outer rim; tiers lighten toward the top like the deciduous crowns.
function buildConifer(rng) {
  const h = 6 + rng() * 8;
  const trunkCol = new THREE.Color().setHSL(0.07 + rng() * 0.02, 0.3 + rng() * 0.1, 0.22 + rng() * 0.06);
  const baseHue = 0.3 + rng() * 0.06;
  const baseSat = 0.32 + rng() * 0.15;
  const baseLit = 0.2 + rng() * 0.06;

  // trunk: tapered tube with a slight wander
  const pts = [], radii = [];
  const segs = 5;
  let wx = 0, wz = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    wx += (rng() - 0.5) * h * 0.02;
    wz += (rng() - 0.5) * h * 0.02;
    pts.push(new THREE.Vector3(wx * t, -0.15 + t * h * 0.97, wz * t));
    radii.push(h * 0.032 * (1 - t * 0.85));
  }
  const parts = [paintGeometry(tubeGeometry(pts, radii, 7), trunkCol, rng, 0.08)];

  const tiers = 5 + (rng() * 3 | 0);
  const seed = rng() * 100;
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);
    const r = h * 0.26 * (1 - f * 0.78) * (0.85 + rng() * 0.3);
    const ch = (h / tiers) * (1.7 - f * 0.4);
    const cone = new THREE.ConeGeometry(r, ch, 9, 2);
    const cp = cone.attributes.position;
    const v = new THREE.Vector3();
    for (let k = 0; k < cp.count; k++) {
      const x = cp.getX(k), y = cp.getY(k), z = cp.getZ(k);
      const rad = Math.hypot(x, z);
      if (rad < 1e-5) continue;
      v.set(x, y * 0.25, z).normalize();
      // ragged silhouette + drooping rim, deterministic per direction
      const m = 1 + 0.2 * (hash3(v.x, v.y + seed + i, v.z) - 0.5);
      const droop = (rad / r) * (rad / r) * ch * 0.22;
      cp.setXYZ(k, x * m, y - droop, z * m);
    }
    cone.computeVertexNormals();
    const yc = h * (0.22 + 0.74 * f) + ch * 0.3;
    cone.translate(pts[Math.floor(f * segs)].x * 0.6 + (rng() - 0.5) * 0.2, yc, pts[Math.floor(f * segs)].z * 0.6 + (rng() - 0.5) * 0.2);
    const tierCol = new THREE.Color().setHSL(baseHue, baseSat, baseLit + f * 0.07);
    parts.push(paintGeometry(cone, tierCol, rng, 0.1));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

// Palm frond: a folded, tapering ribbon that droops along its length.
// Built in local space extending +z, then tilted/rotated into place.
function frondGeometry(len, w0, tilt, droopTotal, segs = 7) {
  const positions = [], indices = [];
  let y = 0, z = 0;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const theta = tilt - droopTotal * Math.pow(t, 1.6);
    if (s > 0) {
      const ds = len / segs;
      y += Math.sin(theta) * ds;
      z += Math.cos(theta) * ds;
    }
    const w = w0 * (1 - t * 0.82) + 0.02;
    const fold = w * 0.4 * (1 - t * 0.4); // inverted-V cross-section
    positions.push(-w / 2, y - fold, z, 0, y, z, w / 2, y - fold, z);
    if (s > 0) {
      const a = (s - 1) * 3, b = s * 3;
      indices.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildPalm(rng) {
  const h = 5 + rng() * 4;
  const bend = 0.25 + rng() * 0.45;
  const azim = rng() * Math.PI * 2;
  const trunkCol = new THREE.Color().setHSL(0.09 + rng() * 0.02, 0.18 + rng() * 0.08, 0.38 + rng() * 0.07);
  const folCol = new THREE.Color().setHSL(0.26 + rng() * 0.05, 0.45 + rng() * 0.12, 0.28 + rng() * 0.06);

  // curved trunk
  const pts = [], radii = [];
  const segs = 6;
  let px = 0, py = -0.15, pz = 0, theta = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(px, py, pz));
    radii.push((0.13 - t * 0.05) * (h / 6) * (1 + (i === 0 ? 0.35 : 0))); // flared base
    const sl = h / segs;
    theta += (bend / segs) * (0.6 + t); // bend increases up the trunk
    px += Math.sin(theta) * Math.cos(azim) * sl;
    pz += Math.sin(theta) * Math.sin(azim) * sl;
    py += Math.cos(theta) * sl;
  }
  const barkParts = [paintGeometry(tubeGeometry(pts, radii, 7), trunkCol, rng, 0.1)];
  const top = pts[segs];

  // coconuts tucked under the crown
  const nuts = 2 + (rng() * 3 | 0);
  const nutCol = new THREE.Color().setHSL(0.08, 0.3, 0.22 + rng() * 0.05);
  for (let i = 0; i < nuts; i++) {
    const nut = new THREE.IcosahedronGeometry(0.11 + rng() * 0.04, 0);
    const a = rng() * Math.PI * 2;
    nut.translate(top.x + Math.cos(a) * 0.18, top.y - 0.18, top.z + Math.sin(a) * 0.18);
    barkParts.push(paintGeometry(nut, nutCol, rng, 0.08));
  }

  // crown of drooping fronds
  const frondParts = [];
  const fronds = 7 + (rng() * 4 | 0);
  for (let i = 0; i < fronds; i++) {
    const fa = (i / fronds) * Math.PI * 2 + rng() * 0.5;
    const tilt = 0.5 - rng() * 0.3;           // start angle above horizontal
    const droop = 1.0 + rng() * 0.9;          // total curl downward
    const len = (2.2 + rng() * 1.3) * (h / 7);
    const fr = frondGeometry(len, 0.55, tilt, droop);
    fr.rotateY(fa);
    fr.translate(top.x, top.y, top.z);
    const c = folCol.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.08);
    frondParts.push(paintGeometry(fr, c, rng, 0.1));
  }

  const bark = mergeGeometries(barkParts);
  const leaves = mergeGeometries(frondParts);
  const geo = mergeGeometries([bark, leaves], true); // groups: [bark, fronds]
  return { geo, mats: [vegMaterial, frondMaterial] };
}

function buildCactus(rng) {
  const parts = [];
  const h = 2 + rng() * 2.5;
  const col = new THREE.Color().setHSL(0.32, 0.32 + rng() * 0.1, 0.3 + rng() * 0.06);
  const body = new THREE.CylinderGeometry(0.22, 0.26, h, 7);
  body.translate(0, h / 2, 0);
  parts.push(paintGeometry(body, col, rng));
  const arms = rng() * 3 | 0;
  for (let i = 0; i < arms; i++) {
    const ay = h * (0.35 + rng() * 0.3);
    const a = rng() * Math.PI * 2;
    const elbow = new THREE.CylinderGeometry(0.13, 0.13, 0.55, 6);
    elbow.rotateZ(Math.PI / 2);
    elbow.rotateY(a);
    elbow.translate(Math.cos(a) * 0.35, ay, -Math.sin(a) * 0.35);
    parts.push(paintGeometry(elbow, col, rng));
    const up = new THREE.CylinderGeometry(0.13, 0.14, 0.8 + rng() * 0.8, 6);
    up.translate(Math.cos(a) * 0.62, ay + 0.45, -Math.sin(a) * 0.62);
    parts.push(paintGeometry(up, col, rng));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

// Reeds / cattails: a clump of thin tapered blades plus a few cattail spikes
// with brown seed heads. Stands in shallow water at the river margin.
function buildReed(rng) {
  const parts = [];
  const green = new THREE.Color().setHSL(0.26 + rng() * 0.06, 0.42 + rng() * 0.12, 0.30 + rng() * 0.07);
  const blades = 7 + (rng() * 8 | 0);
  for (let i = 0; i < blades; i++) {
    const h = 0.9 + rng() * 1.3;
    const blade = new THREE.ConeGeometry(0.03, h, 4);
    blade.translate(0, h / 2, 0);
    blade.rotateZ((rng() - 0.5) * 0.5);              // lean
    blade.rotateY(rng() * Math.PI * 2);
    blade.translate((rng() - 0.5) * 0.35, 0, (rng() - 0.5) * 0.35);
    parts.push(paintGeometry(blade, green, rng, 0.12));
  }
  const cats = rng() * 3 | 0;
  const brown = new THREE.Color().setHSL(0.07, 0.45, 0.22 + rng() * 0.04);
  for (let i = 0; i < cats; i++) {
    const h = 1.3 + rng() * 0.8;
    const ox = (rng() - 0.5) * 0.25, oz = (rng() - 0.5) * 0.25;
    const stalk = new THREE.ConeGeometry(0.018, h, 4);
    stalk.translate(0, h / 2, 0);
    stalk.translate(ox, 0, oz);
    parts.push(paintGeometry(stalk, green, rng, 0.08));
    const head = new THREE.CylinderGeometry(0.045, 0.04, 0.3, 6);
    head.translate(ox, h - 0.2, oz);
    parts.push(paintGeometry(head, brown, rng, 0.06));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

// --- ground clutter ---------------------------------------------------------
// Small props that break up empty ground: mushrooms in damp forest, pebbles +
// driftwood on beaches, fallen logs and bleached snags. All vertex-coloured,
// instanced per chunk. (Ferns and wildflowers moved to the understory billboard
// layer — cheaper and more painterly than 3D mini-geometry.)

function buildMushroom(rng) {
  // a clump of 1–4 mushrooms: short cylinder stem + capsule cap (squashed
  // half-ellipsoid). Colours pick from common forest-floor palettes
  const parts = [];
  const stemCol = new THREE.Color().setHSL(0.10, 0.10, 0.85);   // off-white
  const capPicks = [
    [0.66, 0.18, 0.16], // toadstool red
    [0.72, 0.50, 0.20], // tan
    [0.40, 0.26, 0.16], // brown
    [0.85, 0.80, 0.55], // pale cream
  ];
  const count = 1 + (rng() * 3 | 0);
  for (let i = 0; i < count; i++) {
    const sh = 0.06 + rng() * 0.12;
    const cr = 0.05 + rng() * 0.08;
    const ox = (rng() - 0.5) * 0.25, oz = (rng() - 0.5) * 0.25;
    const stem = new THREE.CylinderGeometry(cr * 0.4, cr * 0.55, sh, 5);
    stem.translate(ox, sh / 2, oz);
    parts.push(paintGeometry(stem, stemCol, rng, 0.08));
    const cap = new THREE.SphereGeometry(cr, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1);
    cap.translate(ox, sh + cr * 0.1, oz);
    const cp = capPicks[(rng() * capPicks.length) | 0];
    parts.push(paintGeometry(cap, new THREE.Color(cp[0], cp[1], cp[2]), rng, 0.10));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildFallenLog(rng) {
  // a horizontal log: a tapered cylinder lying along x, with some moss-tinted
  // colour variation and a few small broken-off branch stubs
  const parts = [];
  const len = 1.6 + rng() * 2.2;
  const rad = 0.16 + rng() * 0.12;
  const barkCol = new THREE.Color().setHSL(0.08, 0.10, 0.28 + rng() * 0.08);
  const log = new THREE.CylinderGeometry(rad * 0.85, rad, len, 7);
  log.rotateZ(Math.PI / 2);                    // lay horizontally
  parts.push(paintGeometry(log, barkCol, rng, 0.10));
  const stubs = rng() * 3 | 0;
  for (let i = 0; i < stubs; i++) {
    const sl = 0.18 + rng() * 0.25;
    const stub = new THREE.CylinderGeometry(0.035, 0.05, sl, 5);
    stub.translate(0, sl / 2, 0);
    stub.rotateZ((rng() - 0.5) * 0.6);
    stub.rotateX((rng() - 0.5) * 0.8);
    stub.translate((rng() - 0.5) * len * 0.7, rad * 0.6, (rng() - 0.5) * rad * 1.2);
    parts.push(paintGeometry(stub, barkCol, rng, 0.10));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildSnag(rng) {
  // a bleached upright snag — a short broken trunk left standing, leaning a
  // bit. Pale grey-tan from sun bleaching
  const parts = [];
  const h = 0.55 + rng() * 1.2;
  const wood = new THREE.Color().setHSL(0.10, 0.05, 0.55 + rng() * 0.10);
  const trunk = new THREE.CylinderGeometry(0.05 + rng() * 0.03, 0.08 + rng() * 0.04, h, 5);
  trunk.translate(0, h / 2, 0);
  trunk.rotateZ((rng() - 0.5) * 0.4);
  parts.push(paintGeometry(trunk, wood, rng, 0.10));
  if (rng() < 0.6) {
    const bl = 0.2 + rng() * 0.4;
    const branch = new THREE.CylinderGeometry(0.025, 0.04, bl, 4);
    branch.translate(0, bl / 2, 0);
    branch.rotateZ(0.6 + rng() * 0.5);
    branch.rotateY(rng() * Math.PI * 2);
    branch.translate(0, h * (0.5 + rng() * 0.35), 0);
    parts.push(paintGeometry(branch, wood, rng, 0.10));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildLitter(rng) {
  // a low patch of leaf/needle litter: a flattened, multi-lobed mat of dark
  // organic matter. Sits flush with the ground, breaks up bare soil under canopy
  const parts = [];
  const litterCol = new THREE.Color().setHSL(0.08, 0.30, 0.18 + rng() * 0.06);
  const blobs = 3 + (rng() * 3 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = 0.22 + rng() * 0.20;
    const blob = new THREE.IcosahedronGeometry(r, 0);
    blob.scale(1.1 + rng() * 0.4, 0.18, 1.1 + rng() * 0.4);   // very flat
    blob.translate((rng() - 0.5) * 0.45, r * 0.08, (rng() - 0.5) * 0.45);
    parts.push(paintGeometry(blob, litterCol, rng, 0.16));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildDriftwood(rng) {
  // sun-bleached driftwood: a horizontal twisted limb, paler than fallen logs.
  // A few jutting nubs of broken-off side limbs make the silhouette interesting
  const parts = [];
  const len = 1.4 + rng() * 2.0;
  const rad = 0.10 + rng() * 0.08;
  const bone = new THREE.Color().setHSL(0.10, 0.07, 0.70 + rng() * 0.08);
  const main = new THREE.CylinderGeometry(rad * 0.7, rad, len, 7);
  main.rotateZ(Math.PI / 2);
  main.rotateY((rng() - 0.5) * 0.3);
  parts.push(paintGeometry(main, bone, rng, 0.12));
  const nubs = 1 + (rng() * 3 | 0);
  for (let i = 0; i < nubs; i++) {
    const sl = 0.25 + rng() * 0.35;
    const nub = new THREE.CylinderGeometry(0.04, 0.06, sl, 5);
    nub.translate(0, sl / 2, 0);
    nub.rotateZ(0.4 + rng() * 0.8);
    nub.rotateY(rng() * Math.PI * 2);
    nub.translate((rng() - 0.5) * len * 0.7, rad * 0.4, (rng() - 0.5) * rad * 1.2);
    parts.push(paintGeometry(nub, bone, rng, 0.10));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildSeaweed(rng) {
  // A tide-thrown knot of flattened kelp ribbons. It lies almost flush with
  // the sand, with bulbous tips and overlapping dark olive blades so strand
  // lines read as organic material rather than another pebble colour.
  const parts = [];
  const kelp = new THREE.Color().setHSL(0.20 + rng() * 0.05, 0.34, 0.16 + rng() * 0.07);
  const blades = 4 + (rng() * 5 | 0);
  for (let i = 0; i < blades; i++) {
    const len = 0.45 + rng() * 0.85;
    const width = 0.055 + rng() * 0.075;
    const ribbon = new THREE.BoxGeometry(len, 0.018, width, 5, 1, 1);
    ribbon.rotateY(rng() * Math.PI * 2);
    ribbon.rotateZ((rng() - 0.5) * 0.10);
    ribbon.translate((rng() - 0.5) * 0.35, 0.015 + i * 0.004, (rng() - 0.5) * 0.35);
    parts.push(paintGeometry(ribbon, kelp, rng, 0.14));
    if (rng() < 0.65) {
      const bulb = new THREE.SphereGeometry(width * 0.72, 5, 3);
      bulb.scale(1.0, 0.42, 1.0);
      bulb.translate((rng() - 0.5) * 0.7, 0.035, (rng() - 0.5) * 0.7);
      parts.push(paintGeometry(bulb, kelp, rng, 0.10));
    }
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildTidePool(rng) {
  // An irregular dark rock lip surrounding a slightly raised water lens. Both
  // pieces share the translucent pool material and use vertex colour to keep
  // batching cheap; the lip's near-black teal reads as wet stone beneath it.
  const segments = 11 + (rng() * 4 | 0);
  const lip = new THREE.RingGeometry(0.78, 1.05, segments);
  const lipPos = lip.attributes.position;
  for (let i = 0; i < lipPos.count; i++) {
    const x = lipPos.getX(i), y = lipPos.getY(i);
    const wobble = 0.90 + 0.12 * Math.sin(Math.atan2(y, x) * 3 + rng() * 4);
    lipPos.setXY(i, x * wobble, y * (0.82 + rng() * 0.10));
  }
  lip.rotateX(-Math.PI / 2);
  lip.translate(0, 0.012, 0);
  const lipCol = new THREE.Color().setHSL(0.48, 0.18, 0.12 + rng() * 0.035);
  paintGeometry(lip, lipCol, rng, 0.07);

  const water = new THREE.CircleGeometry(0.88, segments);
  const waterPos = water.attributes.position;
  for (let i = 0; i < waterPos.count; i++) {
    const x = waterPos.getX(i), y = waterPos.getY(i);
    const wobble = 0.92 + 0.10 * Math.sin(Math.atan2(y, x) * 3 + 1.7);
    waterPos.setXY(i, x * wobble, y * (0.84 + rng() * 0.08));
  }
  water.rotateX(-Math.PI / 2);
  water.translate(0, 0.032, 0);
  const waterCol = new THREE.Color().setHSL(0.48 + rng() * 0.035, 0.36, 0.25 + rng() * 0.045);
  paintGeometry(water, waterCol, rng, 0.035);
  return { geo: mergeGeometries([lip, water]), mats: [tidePoolMaterial] };
}

function buildPlank(rng) {
  const parts = [];
  const wood = new THREE.Color().setHSL(0.075, 0.28, 0.30 + rng() * 0.07);
  const board = new THREE.BoxGeometry(1.8, 0.12, 0.34 + rng() * 0.05, 3, 1, 1);
  // A tiny yaw/roll imperfection keeps a row of boards handmade rather than
  // reading as one perfect industrial slab.
  board.rotateY((rng() - 0.5) * 0.035);
  board.rotateX((rng() - 0.5) * 0.025);
  board.translate(0, 0.06, 0);
  parts.push(paintGeometry(board, wood, rng, 0.10));
  const end = new THREE.Color().setHSL(0.08, 0.18, 0.19 + rng() * 0.04);
  for (const side of [-1, 1]) {
    const nail = new THREE.CylinderGeometry(0.025, 0.025, 0.016, 5);
    nail.translate(side * 0.68, 0.128, 0);
    parts.push(paintGeometry(nail, end, rng, 0.03));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildTrailPost(rng) {
  const parts = [];
  const h = 0.95 + rng() * 0.35;
  const wood = new THREE.Color().setHSL(0.075, 0.25, 0.28 + rng() * 0.06);
  const post = new THREE.BoxGeometry(0.15, h, 0.15);
  post.translate(0, h * 0.5, 0);
  post.rotateY((rng() - 0.5) * 0.16);
  parts.push(paintGeometry(post, wood, rng, 0.11));
  // A pale hand-painted band: readable without becoming signage/UI.
  const paintCol = new THREE.Color().setHSL(0.12, 0.12, 0.78 + rng() * 0.08);
  const band = new THREE.BoxGeometry(0.165, 0.13, 0.165);
  band.translate(0, h * 0.76, 0);
  parts.push(paintGeometry(band, paintCol, rng, 0.05));
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildTrailRoot(rng) {
  const parts = [];
  const rootCol = new THREE.Color().setHSL(0.075, 0.30, 0.19 + rng() * 0.045);
  let x = -0.7, z = 0;
  const pieces = 2 + (rng() * 2 | 0);
  for (let i = 0; i < pieces; i++) {
    const len = 0.48 + rng() * 0.32;
    const r0 = 0.075 - i * 0.012, r1 = Math.max(0.025, r0 * 0.62);
    const root = new THREE.CylinderGeometry(r1, r0, len, 5);
    root.rotateZ(Math.PI / 2);
    root.rotateY((rng() - 0.5) * 0.34);
    root.translate(x + len * 0.5, r0 * 0.35, z);
    parts.push(paintGeometry(root, rootCol, rng, 0.12));
    x += len * 0.88; z += (rng() - 0.5) * 0.16;
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildBranchStack(rng) {
  const parts = [];
  const wood = new THREE.Color().setHSL(0.075, 0.22, 0.27 + rng() * 0.07);
  for (let i = 0; i < 4; i++) {
    const len = 0.7 + rng() * 0.35;
    const branch = new THREE.CylinderGeometry(0.025, 0.045, len, 5);
    branch.rotateZ(Math.PI / 2);
    branch.rotateY((i % 2 ? 0.65 : -0.55) + (rng() - 0.5) * 0.2);
    branch.translate(0, 0.05 + i * 0.055, 0);
    parts.push(paintGeometry(branch, wood, rng, 0.10));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

function buildTrailMud(rng) {
  const parts = [];
  const mud = new THREE.Color().setHSL(0.075, 0.30, 0.16 + rng() * 0.035);
  const blobs = 3 + (rng() * 3 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = 0.34 + rng() * 0.24;
    const patch = new THREE.IcosahedronGeometry(r, 1);
    patch.scale(1.25 + rng() * 0.55, 0.035, 0.75 + rng() * 0.35);
    patch.translate((rng() - 0.5) * 0.7, 0.012, (rng() - 0.5) * 0.4);
    parts.push(paintGeometry(patch, mud, rng, 0.09));
  }
  return { geo: mergeGeometries(parts), mats: [vegMaterial] };
}

// ---------------------------------------------------------------------------

export function createVegetationLibrary(seed = 7) {
  const rng = mulberry32(seed);
  const V = VARIANT_COUNTS;
  const variants = (n, fn) => Array.from({ length: n }, () => fn(rng));
  const rockVariants = (n, fn) => Array.from(
    { length: n }, (_, index) => fn(rng, ROCK_ARCHETYPES[index % ROCK_ARCHETYPES.length]),
  );
  return {
    conifer: variants(V.conifer, buildConifer),
    broadleaf: variants(V.broadleaf, (r) => buildBranchingPlant(r, 'temperate')),
    oak: variants(V.oak, (r) => buildBranchingPlant(r, 'oak')),
    birch: variants(V.birch, (r) => buildBranchingPlant(r, 'birch')),
    willow: variants(V.willow, (r) => buildBranchingPlant(r, 'willow')),
    poplar: variants(V.poplar, (r) => buildBranchingPlant(r, 'poplar')),
    baobab: variants(V.baobab, (r) => buildBranchingPlant(r, 'baobab')),
    blossom: variants(V.blossom, (r) => buildBranchingPlant(r, 'blossom')),
    drytree: variants(V.drytree, (r) => buildBranchingPlant(r, 'acacia')),
    palm: variants(V.palm, buildPalm),
    cactus: variants(V.cactus, buildCactus),
    reed: variants(V.reed, buildReed),
    shrub: variants(V.shrub, (r) => buildBranchingPlant(r, 'bush')),
    dryshrub: variants(V.dryshrub, (r) => buildBranchingPlant(r, 'drybush')),
    deadtree: variants(V.deadtree, (r) => buildBranchingPlant(r, 'dead')),
    rock: rockVariants(V.rock, buildRock),
    boulder: rockVariants(V.boulder, buildBoulder),
    pebble: variants(V.pebble, buildPebble),
    mushroom: variants(V.mushroom, buildMushroom),
    fallenLog: variants(V.fallenLog, buildFallenLog),
    snag: variants(V.snag, buildSnag),
    litter: variants(V.litter, buildLitter),
    driftwood: variants(V.driftwood, buildDriftwood),
    seaweed: variants(V.seaweed, buildSeaweed),
    tidepool: variants(V.tidepool, buildTidePool),
    plank: variants(V.plank, buildPlank),
    trailPost: variants(V.trailPost, buildTrailPost),
    trailRoot: variants(V.trailRoot, buildTrailRoot),
    branchStack: variants(V.branchStack, buildBranchStack),
    trailMud: variants(V.trailMud, buildTrailMud),
  };
}

// Static, single-material, modest-geometry props are good BatchedMesh targets:
// their many type/variant buckets otherwise cost one draw each. Animated and
// multi-material foliage stays instanced so canopy sway, alpha cutouts and the
// zero-copy instance buffers retain their existing behavior. r165 BatchedMesh
// stores one geometry entry per transformed object, so cap source complexity to
// avoid trading too much memory for draw calls.
const STATIC_BATCH_TYPES = new Set([
  // Woody clutter stays instanced because its root must remain addressable by
  // the cave-mouth shader. BatchedMesh hides per-object transforms from the
  // ordinary instancing hook and previously let logs/snags evade exclusion.
  'rock', 'boulder', 'pebble', 'mushroom', 'litter', 'seaweed', 'tidepool',
  'plank', 'trailPost', 'trailRoot', 'trailMud',
]);
const MAX_BATCH_SOURCE_VERTICES = 480;
const MAX_STATIC_BATCH_OBJECTS = 24;

function batchKey(entry, castShadow) {
  const geo = entry.geo;
  const attrs = Object.keys(geo.attributes).sort().map((name) => {
    const a = geo.attributes[name];
    return `${name}:${a.itemSize}:${a.normalized ? 1 : 0}`;
  }).join('|');
  return `${entry.mats[0].uuid}/${geo.index ? 'indexed' : 'plain'}/${attrs}/${castShadow ? 'shadow' : 'no-shadow'}`;
}

// Authored entrance dressing must survive the cave vegetation exclusion (it is
// placed deliberately on the folded surface, including boulders that frame the
// mouth). Give it cave-exempt material clones — same geometry, cave sink
// permanently disabled — so only stray world scatter over the void is culled.
const caveExemptCache = new WeakMap();
function caveExemptMaterial(mat) {
  if (!caveExemptCache.has(mat)) caveExemptCache.set(mat, caveDressingMaterial(mat));
  return caveExemptCache.get(mat);
}
function bucketMaterials(entry, opts) {
  const mats = entry.mats;
  if (!opts.caveDressing) return mats.length === 1 ? mats[0] : mats;
  const exempt = mats.map(caveExemptMaterial);
  return exempt.length === 1 ? exempt[0] : exempt;
}

function addInstancedBucket(group, entry, bucket, opts) {
  const count = bucket.matrices.length / 16;
  const mesh = new THREE.InstancedMesh(
    entry.geo,
    bucketMaterials(entry, opts),
    count
  );
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(bucket.matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  if (bucket.colors) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(bucket.colors, 3);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.name = bucket.type + '/' + bucket.variant;
  mesh.castShadow = opts.shadows && bucket.type !== 'pebble' && bucket.type !== 'tidepool';
  mesh.userData.shadowEligible = bucket.type !== 'pebble' && bucket.type !== 'tidepool';
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
}

function addStaticBatch(group, library, batch, opts) {
  let instanceCount = 0, vertexCount = 0, indexCount = 0;
  for (const bucket of batch.buckets) {
    const geo = library[bucket.type][bucket.variant].geo;
    const count = bucket.matrices.length / 16;
    instanceCount += count;
    vertexCount += geo.attributes.position.count * count;
    indexCount += (geo.index?.count || 0) * count;
  }
  const material = library[batch.buckets[0].type][batch.buckets[0].variant].mats[0];
  const mesh = new THREE.BatchedMesh(
    instanceCount,
    vertexCount,
    Math.max(indexCount, vertexCount * 2),
    material
  );
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (const bucket of batch.buckets) {
    const entry = library[bucket.type][bucket.variant];
    const count = bucket.matrices.length / 16;
    for (let i = 0; i < count; i++) {
      const id = mesh.addGeometry(entry.geo);
      matrix.fromArray(bucket.matrices, i * 16);
      mesh.setMatrixAt(id, matrix);
      if (bucket.colors) {
        color.fromArray(bucket.colors, i * 3);
        mesh.setColorAt(id, color);
      }
    }
  }
  mesh.name = `batched-static/${batch.buckets.length}-buckets`;
  mesh.castShadow = opts.shadows && batch.castsShadow;
  mesh.userData.shadowEligible = batch.castsShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  // Every batch belongs to one 140m streamed chunk and already has a combined
  // bounding sphere. Per-object culling made r165 rebuild hundreds of draw
  // ranges on the CPU every rendered frame in clutter-heavy coastal chunks.
  mesh.perObjectFrustumCulled = false;
  mesh.sortObjects = false;
  mesh.computeBoundingSphere();
  mesh.userData.batchedObjectCount = instanceCount;
  mesh.userData.replacedDrawCalls = batch.buckets.length;
  group.add(mesh);
}

// Assemble a chunk's vegetation from worker-computed buckets. Each bucket is
// { type, variant, matrices (count*16), colors (count*3 | null) }. Dynamic and
// complex buckets remain zero-copy InstancedMeshes; compatible static buckets
// collapse into one BatchedMesh draw per material/index/shadow signature.
export function buildScatterGroup(library, buckets, opts) {
  const group = new THREE.Group();
  // Cave-exempt dressing skips static batching: its clones carry a disabled
  // cave uniform, so keep them as plain instanced draws rather than merging
  // into shared BatchedMeshes keyed on the base material.
  if (opts.caveDressing) {
    for (const bucket of buckets) {
      addInstancedBucket(group, library[bucket.type][bucket.variant], bucket, opts);
    }
    return group;
  }
  const batches = new Map();
  const instanced = [];
  for (const b of buckets) {
    const entry = library[b.type][b.variant];
    const castShadow = opts.shadows && b.type !== 'pebble' && b.type !== 'tidepool';
    const canBatch = !opts.coastal
      && STATIC_BATCH_TYPES.has(b.type)
      && entry.mats.length === 1
      && entry.geo.attributes.position.count <= MAX_BATCH_SOURCE_VERTICES;
    if (!canBatch) {
      instanced.push(b);
      continue;
    }
    const key = batchKey(entry, castShadow);
    if (!batches.has(key)) batches.set(key, { castsShadow: castShadow, buckets: [] });
    batches.get(key).buckets.push(b);
  }

  // A single bucket is already one efficient instanced draw; batching only
  // pays when it replaces two or more existing bucket draws.
  for (const batch of batches.values()) {
    const objectCount = batch.buckets.reduce((sum, bucket) => sum + bucket.matrices.length / 16, 0);
    // Three r165 stores one transformed geometry entry per batched object. For
    // large pebble/seaweed populations that means a costly geometry expansion
    // during chunk assembly; several true instanced draws are cheaper and use
    // dramatically less upload memory.
    if (batch.buckets.length < 2 || objectCount > MAX_STATIC_BATCH_OBJECTS) instanced.push(...batch.buckets);
    else addStaticBatch(group, library, batch, opts);
  }
  for (const bucket of instanced) {
    addInstancedBucket(group, library[bucket.type][bucket.variant], bucket, opts);
  }
  return group;
}

// --- Grass -----------------------------------------------------------------

let grassGeometry = null;
function getGrassGeometry() {
  if (grassGeometry) return grassGeometry;
  // a small crossed tuft of tapered blades, 1m tall before instance scaling
  const blade = (rotY, lean) => {
    const g = new THREE.PlaneGeometry(0.14, 1, 1, 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) + 0.5); // 0 at base, 1 at tip
      pos.setX(i, pos.getX(i) * (1 - t * 0.8));
    }
    g.translate(0, 0.5, 0);
    g.rotateX(lean);
    g.rotateY(rotY);
    return g;
  };
  grassGeometry = mergeGeometries([
    blade(0, 0.12), blade(Math.PI / 3, -0.1), blade((Math.PI * 2) / 3, 0.08),
  ]);
  // light grass like the ground it grows from: all normals point up
  const norm = grassGeometry.attributes.normal;
  for (let i = 0; i < norm.count; i++) norm.setXYZ(i, 0, 1, 0);
  return grassGeometry;
}

// Lambert (not Standard): grass needs no specular/roughness BRDF, so this
// halves the fragment cost while keeping sun response, vertexColors, instancing,
// the wind hook and the atmosphere injection. excludeFromAO keeps the thin
// blades out of the GTAO prepass (they contribute no meaningful occlusion).
export const grassMaterial = new THREE.MeshLambertMaterial({
  color: 0xffffff, side: THREE.DoubleSide, alphaTest: 0, transparent: true,
});
grassMaterial.userData.excludeFromAO = true;
grassMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  for (const k in windUniforms) shader.uniforms[k] = windUniforms[k];
  for (const k in caveEntranceUniforms) shader.uniforms[k] = caveEntranceUniforms[k];
  shader.vertexShader = 'uniform float uTime;\nattribute float aGroundMacro;\nvarying float vGroundMacro;\nvarying float vGustShim;\nvarying float vGrassHeight;\n'
    + WIND_GLSL_DECLS + CAVE_EXCLUSION_GLSL +
    shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
     float gw = position.y;            // blade height 0..1 = sway weight
     vec2 gip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
     transformed.y -= caveEntranceMask(gip) * 1000.0;
     // Snap to the 8m patch cell (must match GRASS_SWAY_CELL in chunkgen.js):
     // every blade in a patch shares one phase + gust, so the whole stand sways
     // together instead of each blade fluttering out of step.
     vec2 gcell = (floor(gip / 8.0) + 0.5) * 8.0;
     float ph = gcell.x * 1.71 + gcell.y * 2.13;
     float ggust = windGust(gcell);
     float gamp = 0.25 + 1.4 * ggust * uWindStrength;
     vGustShim = ggust * uWindStrength;   // gust-front light band (matches the GPU field)
     vGroundMacro = aGroundMacro;
     // Chunk grass is seated 0.04m below the surface. Normalize from that
     // actual intersection so the first visible part of every scaled blade is
     // still pure ground colour.
     float grassScaleY = length(instanceMatrix[1].xyz);
     vGrassHeight = clamp((position.y * grassScaleY - 0.04) /
                          max(grassScaleY - 0.04, 0.05), 0.0, 1.0);
     float gwig = (sin(uTime * 1.6 + ph) + sin(uTime * 2.7 + ph * 1.7) * 0.5) * 0.09;
     // faint per-blade flutter so the coherent patch still has individual life
     gwig += sin(uTime * 3.3 + gip.x * 7.0 + gip.y * 5.0) * 0.018;
     transformed.x += (gwig + uWindDir.x * ggust * uWindStrength * 0.8) * gamp * gw;
     transformed.z += (cos(uTime * 1.3 + ph) * 0.06 + uWindDir.y * ggust * uWindStrength * 0.8) * gamp * gw;`
  );
  // light every blade as if it were the ground beneath it (no dark backfaces),
  // and brighten with the passing gust so wind reads as travelling light
  shader.fragmentShader = `varying float vGustShim;
varying float vGrassHeight;
varying float vGroundMacro;
vec3 grassBladeGradient(vec3 ground, float height, float dryness) {
  float luma = dot(ground, vec3(0.299, 0.587, 0.114));
  vec3 lushTip = mix(ground * vec3(0.96, 1.10, 0.72),
                     vec3(luma * 0.82, luma * 1.16, luma * 0.48), 0.38);
  vec3 dryTip = vec3(luma * 1.18, luma * 1.05, luma * 0.68);
  vec3 grassTip = mix(lushTip, dryTip, dryness * 0.58);
  return mix(ground, grassTip, smoothstep(0.0, 0.50, height));
}
` + shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
     normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`
  ).replace(
    '#include <color_fragment>',
     `#include <color_fragment>
     vec3 grassGroundPigment = diffuseColor.rgb;
     diffuseColor.rgb = grassBladeGradient(grassGroundPigment, vGrassHeight, vGroundMacro);
     // Reveal the already-lit terrain at the contact edge. This keeps the root
     // seamless even when the terrain receives a shadow the grass does not.
     diffuseColor.a *= smoothstep(0.0, 0.50, vGrassHeight);
     diffuseColor.rgb *= 1.0 + vGustShim * mix(0.12, 0.22, vGroundMacro);
     float seedHead = smoothstep(0.72, 1.0, vGrassHeight) * smoothstep(0.52, 0.88, vGroundMacro);
     diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.09, 0.84), seedHead * 0.28);`
  );
  grassMaterial.userData.shader = shader;
};

// --- Understory billboard layer ----------------------------------------------
// One painter-style atlas (4×3 cells) of forest-floor plants; every instance is
// a crossed quad (4 tris) that picks its plant via a per-instance aCell
// attribute — so an entire chunk's understory is ONE InstancedMesh and ONE draw
// call regardless of how many species it mixes. Painted in full colour (unlike
// the tintable leaf atlas) because plants like lupins carry two hues at once.
// Row 3 is the meadow-wildflower set that replaced the old diamond-petal
// grass-field flowers: poppies, daisies, harebells, buttercups.
const UND_COLS = 4, UND_ROWS = 3;
function makeUnderstoryAtlas() {
  const CELL = 128;
  const c = document.createElement('canvas');
  c.width = CELL * UND_COLS; c.height = CELL * UND_ROWS;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const rng = mulberry32(1213);
  const R = (a, b) => a + rng() * (b - a);

  // strokes are drawn in cell-local coords: x 0..128, y 0 at TOP, ground = 126
  const G = 126;
  const stroke = (x0, y0, x1, y1, w, col, alpha = 1) => {
    ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.globalAlpha = 1;
  };
  const dot = (x, y, r, col, alpha = 1) => {
    ctx.fillStyle = col; ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * R(0.7, 1), R(0, 3.2), 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  };
  const grn = (l) => `rgb(${(l * 0.62) | 0},${l | 0},${(l * 0.45) | 0})`;

  const cells = [
    () => { // 0 bracken: arching fronds with paired leaflets
      for (let f = 0; f < 7; f++) {
        const dir = R(-1, 1), lean = dir * R(0.35, 0.9), len = R(58, 88), l = R(95, 150);
        let x = 64 + R(-8, 8), y = G;
        for (let s = 0; s < 9; s++) {
          const t = s / 9, nx = x + lean * 9 * (t + 0.3), ny = y - (len / 9) * (1 - t * 0.45);
          stroke(x, y, nx, ny, 2.2 - t * 1.4, grn(l * (0.8 + t * 0.35)));
          if (s > 1) { const lw = (1 - t) * R(8, 13);
            stroke(nx, ny, nx - lw, ny - lw * 0.25, 1.6, grn(l * 1.08), 0.9);
            stroke(nx, ny, nx + lw, ny - lw * 0.2, 1.6, grn(l * 0.95), 0.9); }
          x = nx; y = ny;
        }
      }
    },
    () => { // 1 lupin: leafy base + violet flower spikes
      for (let s = 0; s < 4; s++) { const bx = 64 + R(-26, 26);
        for (let k = 0; k < 5; k++) { const a = R(0, 6.28), r = R(6, 15);
          stroke(bx, G, bx + Math.cos(a) * r, G - Math.abs(Math.sin(a)) * r * 0.6 - 3, 2, grn(R(100, 140)), 0.9); } }
      for (let s = 0; s < 5; s++) {
        const bx = 64 + R(-24, 24), h = R(62, 100), tip = G - h;
        stroke(bx, G, bx + R(-4, 4), tip + 18, 1.8, grn(R(90, 120)));
        const vio = () => `rgb(${R(115, 150) | 0},${R(78, 105) | 0},${R(165, 205) | 0})`;
        for (let y = tip + 30; y > tip; y -= 3.5) dot(bx + R(-4.5, 4.5), y, R(2.2, 3.6) * (0.6 + (y - tip) / 34), vio(), 0.95);
      }
    },
    () => { // 2 cow-parsley: tall stems under lacy white umbels
      for (let s = 0; s < 5; s++) {
        const bx = 64 + R(-30, 30), h = R(70, 104), tx = bx + R(-10, 10), ty = G - h;
        stroke(bx, G, tx, ty + 8, 1.6, grn(R(85, 115)));
        stroke(bx, G, bx + R(-14, 14), G - R(16, 30), 1.2, grn(R(95, 125)), 0.8); // basal leaf
        for (let u = 0; u < 4; u++) { const ua = R(0, 6.28), ur = R(3, 11);
          for (let d = 0; d < 5; d++) dot(tx + Math.cos(ua) * ur + R(-3, 3), ty + Math.sin(ua) * ur * 0.45 + R(-2, 2), R(1.4, 2.4), `rgb(238,240,228)`, 0.95); }
      }
    },
    () => { // 3 pampas: dry fountain of blades + cream plumes
      const tan = (l) => `rgb(${l | 0},${(l * 0.88) | 0},${(l * 0.55) | 0})`;
      for (let b = 0; b < 16; b++) { const a = R(-1.15, 1.15), len = R(40, 74);
        const tx = 64 + Math.sin(a) * len, ty = G - Math.cos(a) * len * R(0.7, 1);
        stroke(64 + R(-4, 4), G, tx, ty, 1.5, tan(R(150, 205)), 0.95); }
      for (let p = 0; p < 3; p++) { const bx = 64 + R(-14, 14), h = R(78, 108), ty = G - h;
        stroke(bx, G, bx + R(-6, 6), ty + 10, 1.6, tan(180));
        for (let d = 0; d < 14; d++) dot(bx + R(-6, 6), ty + R(-4, 22), R(2.5, 4.5), `rgb(${R(225, 248) | 0},${R(214, 236) | 0},${R(188, 212) | 0})`, 0.8); }
    },
    () => { // 4 sapling: whip stem with a few small leaf clumps
      const bx = 64 + R(-6, 6), h = R(84, 112), tx = bx + R(-8, 8), ty = G - h;
      stroke(bx, G, tx, ty, 2.6, `rgb(88,66,48)`);
      const clump = (cx, cy, r) => { for (let d = 0; d < 9; d++) dot(cx + R(-r, r), cy + R(-r * 0.7, r * 0.7), R(3, 5.5), grn(R(95, 150)), 0.95); };
      clump(tx, ty + 4, 11);
      clump(bx + (tx - bx) * 0.6 + R(-10, 10), G - h * 0.62, 8);
      clump(bx + (tx - bx) * 0.3 - R(-10, 10), G - h * 0.38, 7);
    },
    () => { // 5 horsetail: segmented vertical shoots
      for (let s = 0; s < 8; s++) {
        const bx = 64 + R(-30, 30), h = R(46, 86), lean = R(-6, 6);
        for (let k = 0; k < 6; k++) { const t0 = k / 6, t1 = (k + 1) / 6;
          stroke(bx + lean * t0, G - h * t0, bx + lean * t1, G - h * t1, 2.4 - t1 * 1.5, grn(R(88, 128) * (k % 2 ? 1 : 0.78))); }
        dot(bx + lean, G - h - 2, 2, grn(80), 0.9);
      }
    },
    () => { // 6 thistle: spiky rosette + purple pompom heads
      for (let b = 0; b < 12; b++) { const a = R(-1.3, 1.3), len = R(16, 34);
        stroke(64 + R(-5, 5), G, 64 + Math.sin(a) * len, G - Math.cos(a) * len * 0.75, 1.8, grn(R(78, 118)), 0.95); }
      for (let s = 0; s < 3; s++) { const bx = 64 + R(-16, 16), h = R(46, 76), ty = G - h;
        stroke(bx, G, bx + R(-4, 4), ty + 6, 1.7, grn(R(80, 105)));
        for (let d = 0; d < 8; d++) dot(bx + R(-4, 4), ty + R(-4, 3), R(1.8, 3.2), `rgb(${R(140, 175) | 0},${R(70, 100) | 0},${R(160, 200) | 0})`, 0.95);
        dot(bx, ty + 6, 3, grn(70), 0.9); }
    },
    () => { // 7 bramble: low tangled arcs with tiny white flowers
      for (let b = 0; b < 9; b++) {
        let x = 64 + R(-34, 34), y = G; const dir = R(-1, 1);
        for (let k = 0; k < 5; k++) { const nx = x + dir * R(6, 14), ny = y - R(2, 10) + k * 1.5;
          stroke(x, y, nx, ny, 1.7, grn(R(58, 92)), 0.95);
          if (rng() < 0.6) dot(nx, ny - 2, R(2.2, 3.6), grn(R(70, 105)), 0.9);
          x = nx; y = Math.min(ny, G - 2); }
      }
      for (let d = 0; d < 7; d++) dot(64 + R(-38, 38), G - R(6, 26), R(1.3, 2), `rgb(240,238,230)`, 0.95);
    },
    () => { // 8 poppies: wiry stems under red-orange cups with dark hearts
      for (let b = 0; b < 8; b++) { const a = R(-1.1, 1.1), len = R(12, 26);
        stroke(64 + R(-16, 16), G, 64 + Math.sin(a) * len, G - Math.cos(a) * len * 0.8, 1.4, grn(R(85, 120)), 0.9); }
      for (let s = 0; s < 6; s++) {
        const bx = 64 + R(-30, 30), h = R(42, 84), tx = bx + R(-7, 7), ty = G - h;
        stroke(bx, G, tx, ty + 4, 1.3, grn(R(80, 110)));
        const r = R(4, 6.5);
        dot(tx, ty, r, `rgb(${R(200, 235) | 0},${R(48, 82) | 0},${R(30, 52) | 0})`, 0.97);
        dot(tx + R(-1, 1), ty + R(-1, 1), r * 0.34, `rgb(48,30,38)`, 0.9);
      }
    },
    () => { // 9 daisies: white many-petal heads with yellow centres over a leafy base
      for (let b = 0; b < 8; b++) { const a = R(-1.2, 1.2), len = R(10, 22);
        stroke(64 + R(-18, 18), G, 64 + Math.sin(a) * len, G - Math.cos(a) * len * 0.75, 1.5, grn(R(90, 130)), 0.9); }
      for (let s = 0; s < 7; s++) {
        const bx = 64 + R(-32, 32), h = R(34, 70), tx = bx + R(-5, 5), ty = G - h;
        stroke(bx, G, tx, ty + 3, 1.2, grn(R(85, 118)));
        const r = R(3.4, 5.4);
        for (let p = 0; p < 7; p++) { const pa = (p / 7) * 6.283 + R(0, 0.6);
          dot(tx + Math.cos(pa) * r * 0.72, ty + Math.sin(pa) * r * 0.72, r * 0.42, `rgb(${R(235, 250) | 0},${R(235, 248) | 0},${R(225, 240) | 0})`, 0.95); }
        dot(tx, ty, r * 0.36, `rgb(${R(230, 250) | 0},${R(185, 210) | 0},${R(55, 85) | 0})`, 0.97);
      }
    },
    () => { // 10 harebells: slender stems with nodding blue-violet bells
      for (let s = 0; s < 8; s++) {
        const bx = 64 + R(-30, 30), h = R(40, 82), lean = R(-10, 10), tx = bx + lean, ty = G - h;
        stroke(bx, G, tx, ty + 6, 1.1, grn(R(88, 120)));
        stroke(bx, G, bx + R(-9, 9), G - R(8, 18), 1.1, grn(R(95, 128)), 0.8); // basal grass-leaf
        const bells = 1 + (rng() * 2 | 0);
        for (let k = 0; k < bells; k++) {
          const by = ty + k * R(7, 12), bxx = tx + R(-3, 3) + k * R(-3, 3);
          ctx.fillStyle = `rgb(${R(120, 155) | 0},${R(120, 150) | 0},${R(205, 235) | 0})`;
          ctx.globalAlpha = 0.95;
          ctx.beginPath(); ctx.moveTo(bxx, by);
          ctx.lineTo(bxx - R(2.6, 3.6), by + R(4.5, 6.5));
          ctx.lineTo(bxx + R(2.6, 3.6), by + R(4.5, 6.5));
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
      }
    },
    () => { // 11 buttercups: a low leafy mound sprinkled with small gold cups
      for (let b = 0; b < 14; b++) { const a = R(-1.25, 1.25), len = R(8, 20);
        stroke(64 + R(-26, 26), G, 64 + Math.sin(a) * len, G - Math.cos(a) * len * 0.7, 1.5, grn(R(88, 132)), 0.92); }
      for (let s = 0; s < 12; s++) {
        const bx = 64 + R(-34, 34), h = R(20, 52), tx = bx + R(-4, 4), ty = G - h;
        stroke(bx, G, tx, ty + 2, 1.0, grn(R(85, 115)), 0.9);
        dot(tx, ty, R(2.2, 3.4), `rgb(${R(240, 255) | 0},${R(195, 225) | 0},${R(30, 60) | 0})`, 0.97);
      }
    },
  ];
  for (let i = 0; i < cells.length; i++) {
    const col = i % UND_COLS, row = (i / UND_COLS) | 0;
    ctx.save();
    ctx.translate(col * CELL, row * CELL);
    ctx.beginPath(); ctx.rect(1, 1, CELL - 2, CELL - 2); ctx.clip();
    cells[i]();
    ctx.restore();
  }

  // per-cell mip pre-bleed (same fix as the leaf atlas: transparent pixels take
  // the cell's average colour so mips never average foliage against black)
  const S = c.width, H = c.height;
  const img = ctx.getImageData(0, 0, S, H), data = img.data;
  for (let cy = 0; cy < UND_ROWS; cy++) for (let cx = 0; cx < UND_COLS; cx++) {
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
      const i = (y * S + x) * 4, a = data[i + 3];
      if (a > 16) { sr += data[i] * a; sg += data[i + 1] * a; sb += data[i + 2] * a; sa += a; }
    }
    const lr = sa ? sr / sa : 110, lg = sa ? sg / sa : 130, lb = sa ? sb / sa : 80;
    for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
      const i = (y * S + x) * 4;
      if (data[i + 3] < 16) { data[i] = lr; data[i + 1] = lg; data[i + 2] = lb; }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// crossed quads, 1m tall, anchored at the ground (shared; per-chunk clones only
// add the tiny per-instance aCell attribute)
let understoryGeometry = null;
function getUnderstoryGeometry() {
  if (understoryGeometry) return understoryGeometry;
  const quad = (rotY) => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    g.rotateY(rotY);
    return g;
  };
  understoryGeometry = mergeGeometries([quad(0), quad(Math.PI / 2)]);
  return understoryGeometry;
}

// Lambert like the grass (no specular BRDF needed), lit with ground-up normals
// so thin quads never go black, swaying with the same wind field as the grass.
export const understoryMaterial = new THREE.MeshLambertMaterial({
  map: typeof document !== 'undefined' ? makeUnderstoryAtlas() : null,
  alphaTest: 0.5, side: THREE.DoubleSide,
});
understoryMaterial.userData.excludeFromAO = true;
understoryMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  for (const k in windUniforms) shader.uniforms[k] = windUniforms[k];
  for (const k in caveEntranceUniforms) shader.uniforms[k] = caveEntranceUniforms[k];
  shader.vertexShader = 'uniform float uTime;\nattribute float aCell;\n' + WIND_GLSL_DECLS + CAVE_EXCLUSION_GLSL +
    shader.vertexShader
    // per-instance atlas cell: remap the quad's 0..1 UVs into its plant's window
    .replace('#include <uv_vertex>', `#include <uv_vertex>
     #ifdef USE_MAP
       vMapUv = (vMapUv + vec2(mod(aCell, ${UND_COLS}.0), floor(aCell / ${UND_COLS}.0))) / vec2(${UND_COLS}.0, ${UND_ROWS}.0);
     #endif`)
    // the grass wind term, sampled at the instance position, weighted by height
    // up the quad — the understory breathes with the grass field around it
    .replace('#include <begin_vertex>', `#include <begin_vertex>
     float uw = position.y;                           // 0 ground → 1 top
     vec2 uip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
     transformed.y -= caveEntranceMask(uip) * 1000.0;
     vec2 ucell = (floor(uip / 8.0) + 0.5) * 8.0;     // same 8m cell as the grass
     float uph = ucell.x * 1.71 + ucell.y * 2.13;
     float ugust = windGust(ucell);
     float uamp = 0.25 + 1.4 * ugust * uWindStrength;
     float uwig = (sin(uTime * 1.6 + uph) + sin(uTime * 2.7 + uph * 1.7) * 0.5) * 0.07;
     uwig += sin(uTime * 3.1 + uip.x * 6.0 + uip.y * 4.4) * 0.02;
     transformed.x += (uwig + uWindDir.x * ugust * uWindStrength * 0.8) * uamp * uw;
     transformed.z += (cos(uTime * 1.3 + uph) * 0.05 + uWindDir.y * ugust * uWindStrength * 0.8) * uamp * uw;`);
  // light like the ground it grows from (no dark backfaces on thin quads)
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
     normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`
  );
  understoryMaterial.userData.shader = shader;
};

// Assemble a chunk's understory: one InstancedMesh from worker-computed
// { matrices, cells, colors } (zero-copy wraps). The geometry is a cheap clone
// of the shared crossed quad so each chunk carries its own aCell buffer.
export function buildUnderstoryMesh(data, { caveDressing = false } = {}) {
  const count = data.matrices.length / 16;
  const geo = getUnderstoryGeometry().clone();
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(data.cells, 1));
  const mesh = new THREE.InstancedMesh(
    geo,
    caveDressing ? entranceUnderstoryMaterial : understoryMaterial,
    count,
  );
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(data.matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  if (data.colors) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.name = 'understory';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// Per-instance hue/season variety: each tree gets a small hue rotation from a
// hash of its world position, so a forest reads as many individuals instead of
// one cloned green. A green gate limits the shift to foliage, leaving bark/wood
// untouched — important for vegMaterial, which conifers/shrubs share with their
// trunks. leafMaterial (broadleaf canopies) additionally turns a fraction of
// trees to autumn gold/red. No new instance data — driven entirely by the
// instanceMatrix position already on the GPU.
export function injectHueJitter(material, { autumn = false } = {}) {
  const au = autumn ? '1.0' : '0.0';
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.vertexShader = 'varying float vHue;\nvarying float vAutumn;\n' +
      shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        #ifdef USE_INSTANCING
          vec2 _hip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float _h1 = fract(sin(dot(_hip, vec2(12.9898, 78.233))) * 43758.5453);
          float _h2 = fract(sin(dot(_hip, vec2(39.346, 11.135))) * 24634.633);
          vHue = (_h1 - 0.5) * 0.7;                                  // ±0.35 rad
          vAutumn = ${au} * smoothstep(0.90, 0.99, _h2) * (0.55 + 0.45 * _h1);
        #else
          vHue = 0.0; vAutumn = 0.0;
        #endif
      }`);
    shader.fragmentShader = 'varying float vHue;\nvarying float vAutumn;\n' +
      shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        float _grn = smoothstep(0.0, 0.05, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
        float _a = vHue * _grn;
        const vec3 _k = vec3(0.57735);
        float _c = cos(_a), _s = sin(_a);
        diffuseColor.rgb = diffuseColor.rgb * _c + cross(_k, diffuseColor.rgb) * _s + _k * dot(_k, diffuseColor.rgb) * (1.0 - _c);
        float _lu = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 _au = mix(vec3(0.80, 0.46, 0.11), vec3(0.62, 0.16, 0.06), fract(vAutumn * 6.0)); // gold↔red
        diffuseColor.rgb = mix(diffuseColor.rgb, _au * (0.45 + 0.9 * _lu), vAutumn * _grn);
      }`);
  };
  material.needsUpdate = true;
}

// World-space triplanar projection keeps the one shared texture consistent on
// slabs, wedges and monoliths without UV seams or stretched faces. Two scales
// are softly combined to suppress obvious tiling; the result modulates rather
// than replaces the biome/instance pigment.
function injectRockSurface(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.uniforms.uRockSurface = { value: rockSurfaceTexture };
    shader.vertexShader = 'varying vec3 vRockWorldNormal;\n' + shader.vertexShader.replace(
      '#include <defaultnormal_vertex>',
      `#include <defaultnormal_vertex>
       vRockWorldNormal = normalize(inverseTransformDirection(transformedNormal, viewMatrix));`,
    );
    shader.fragmentShader = 'uniform sampler2D uRockSurface;\nvarying vec3 vRockWorldNormal;\n'
      + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       {
         vec3 _rwn = abs(normalize(vRockWorldNormal));
         vec3 _rw = pow(_rwn, vec3(5.0));
         _rw /= max(_rw.x + _rw.y + _rw.z, 0.0001);
         vec3 _rp = vAtmoWP * 0.22;
         vec3 _ra = texture2D(uRockSurface, _rp.yz).rgb * _rw.x
                  + texture2D(uRockSurface, _rp.zx).rgb * _rw.y
                  + texture2D(uRockSurface, _rp.xy).rgb * _rw.z;
         vec3 _rq = vAtmoWP * 0.071 + vec3(3.7, 8.9, 2.4);
         vec3 _rb = texture2D(uRockSurface, _rq.yz).rgb * _rw.x
                  + texture2D(uRockSurface, _rq.zx).rgb * _rw.y
                  + texture2D(uRockSurface, _rq.xy).rgb * _rw.z;
         vec3 _rockPigment = mix(_ra, _rb, 0.32) * 1.10;
         diffuseColor.rgb *= mix(vec3(1.0), _rockPigment, 0.46);
       }`,
      );
  };
  material.customProgramCacheKey = () => 'planar-rock-painterly-v1';
  material.needsUpdate = true;
}

// Atmosphere: cloud shadows + aerial haze on everything; leaf back-lighting on
// the foliage materials (broadleaf cards, palm fronds, grass — not trunks/rocks).
injectAtmosphere(vegMaterial, { clouds: true, aerial: true });
injectAtmosphere(rockMaterial, { clouds: true, aerial: true });
injectAtmosphere(tidePoolMaterial, { clouds: true, aerial: true });
injectAtmosphere(frondMaterial, { clouds: true, aerial: true, backlight: true });
injectAtmosphere(leafMaterial, { clouds: true, aerial: true, backlight: true });
injectAtmosphere(grassMaterial, { clouds: true, aerial: true, backlight: true });
injectAtmosphere(understoryMaterial, { clouds: true, aerial: true, backlight: true });
injectHueJitter(leafMaterial, { autumn: true });   // broadleaf canopies + autumn
injectHueJitter(vegMaterial, { autumn: false });    // conifer needles / shrub leaves
injectPainterFoliage(leafMaterial);
injectPainterFoliage(frondMaterial);
injectPainterFoliage(understoryMaterial);
// Conifer needles and shrub leaves share their draw/material with woody parts;
// colour-gate the painter so bark and neutral clutter keep their original look.
injectPainterFoliage(vegMaterial, { greenGate: true });

// Sink instanced objects far below ground wherever they stand over a carved cave
// mouth or the corridor that runs under the surface. Trees use the broad woody
// clearing; stone uses only the original corridor footprint. The hook anchors
// at <skinning_vertex> (untouched by the sway/hue/atmosphere injectors that own
// <begin_vertex>/<project_vertex>) so it composes onto whole trees cleanly.
export function injectCaveSink(material, { woody = true } = {}) {
  const mask = woody ? 'caveWoodyMask' : 'caveEntranceMask';
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    for (const k in caveEntranceUniforms) shader.uniforms[k] = caveEntranceUniforms[k];
    if (!shader.vertexShader.includes(mask)) {
      shader.vertexShader = CAVE_EXCLUSION_GLSL + '\n' + shader.vertexShader;
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>
       #ifdef USE_INSTANCING
       transformed.y -= ${mask}(vec2(instanceMatrix[3][0], instanceMatrix[3][2])) * 2000.0;
       #endif`,
    );
  };
  material.needsUpdate = true;
}

injectCaveSink(vegMaterial);    // trunks, conifers, shrubs and shared clutter
injectCaveSink(rockMaterial, { woody: false }); // stone clears only the carved corridor
injectCaveSink(frondMaterial);  // palm fronds
injectCaveSink(leafMaterial);   // broadleaf canopies
injectRockSurface(rockMaterial);

// Entrance dressing reuses the exact grass/understory shaders and atlases but
// must remain visible inside the broad procedural vegetation exclusion. Give
// those authored meshes private materials whose cave uniform is permanently
// disabled; wind, atmosphere, backlighting and atlas behavior stay identical.
function caveDressingMaterial(base) {
  const material = base.clone();
  const compileBase = base.onBeforeCompile;
  material.userData = { ...base.userData, shader: null, caveDressing: true };
  material.onBeforeCompile = (shader, renderer) => {
    compileBase.call(material, shader, renderer);
    shader.uniforms.uCaveEntrance = {
      value: caveEntranceUniforms.uCaveEntrance.value.clone().setW(0),
    };
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => `${base.customProgramCacheKey?.() || ''}:cave-dressing`;
  material.needsUpdate = true;
  return material;
}

const entranceGrassMaterial = caveDressingMaterial(grassMaterial);
const entranceUnderstoryMaterial = caveDressingMaterial(understoryMaterial);

// Bark micro-streaks: within ~40 m, brown surfaces (trunks, dead wood, logs)
// get faint vertical grain streaks so hero trees hold up at point-blank range.
// Colour-gated to brown (r>g>b), which naturally skips rocks (grey), needles
// (green) and snow. Chained LAST so the atmosphere injection has already
// declared vAtmoWP; the noise is namespaced (_bk*) to avoid collisions.
function injectBarkDetail(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
      float _bkd = length(cameraPosition - vAtmoWP);
      float _bkf = 1.0 - smoothstep(16.0, 42.0, _bkd);
      if (_bkf > 0.001) {
        float _brown = smoothstep(0.015, 0.055, diffuseColor.r - diffuseColor.g)
                     * smoothstep(0.0, 0.035, diffuseColor.g - diffuseColor.b);
        if (_brown > 0.001) {
          // anisotropic value noise: fast around the trunk, slow along it →
          // elongated vertical grain
          vec2 _bp = vec2((vAtmoWP.x + vAtmoWP.z) * 5.0, vAtmoWP.y * 0.85);
          vec2 _bi = floor(_bp), _bfr = fract(_bp);
          _bfr = _bfr * _bfr * (3.0 - 2.0 * _bfr);
          float _ba = fract(sin(dot(_bi, vec2(127.1, 311.7))) * 43758.5453);
          float _bb = fract(sin(dot(_bi + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
          float _bc = fract(sin(dot(_bi + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
          float _bd2 = fract(sin(dot(_bi + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
          float _bs = mix(mix(_ba, _bb, _bfr.x), mix(_bc, _bd2, _bfr.x), _bfr.y);
          diffuseColor.rgb *= 1.0 + (_bs - 0.5) * 0.34 * _brown * _bkf;
        }
      }
    }`);
  };
  material.needsUpdate = true;
}
injectBarkDetail(vegMaterial);

export function updateGrassTime(t) {
  if (grassMaterial.userData.shader) grassMaterial.userData.shader.uniforms.uTime.value = t;
  if (entranceGrassMaterial.userData.shader) entranceGrassMaterial.userData.shader.uniforms.uTime.value = t;
  if (leafMaterial.userData.shader) leafMaterial.userData.shader.uniforms.uTime.value = t;
  if (understoryMaterial.userData.shader) understoryMaterial.userData.shader.uniforms.uTime.value = t;
  if (entranceUnderstoryMaterial.userData.shader) entranceUnderstoryMaterial.userData.shader.uniforms.uTime.value = t;
}

// Assemble a grass InstancedMesh from worker-computed { matrices, colors }.
export function buildGrassMesh(data, { caveDressing = false } = {}) {
  const count = data.matrices.length / 16;
  const geometry = getGrassGeometry().clone();
  const macros = data.macros || new Float32Array(count).fill(0.35);
  geometry.setAttribute('aGroundMacro', new THREE.InstancedBufferAttribute(macros, 1));
  const mesh = new THREE.InstancedMesh(
    geometry,
    caveDressing ? entranceGrassMaterial : grassMaterial,
    count,
  );
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(data.matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3);
  mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.computeBoundingSphere();
  return mesh;
}
