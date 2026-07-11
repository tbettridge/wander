// Parametric landmark builders + a streaming manager. Each builder turns a
// variation seed into a THREE.Group (base at y=0); the manager streams the
// handful of landmarks within range around the player, building them from the
// shared deterministic placement (landmarks.js) so they line up with the
// vegetation clearing-halos the worker carves.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { landmarksAround } from './landmarks.js';
import { leafMaterial } from './vegetation.js';
import { injectAtmosphere } from './atmosphere.js';
import { groundDetailUniforms } from './grounddetail.js';

// A leaf material for non-instanced meshes (the giant landmark tree): reuses
// the same cluster texture as the regular broadleaf canopies, but WITHOUT the
// onBeforeCompile sway hook — that hook references instanceMatrix and silently
// fails on plain Meshes, leaving the canopy invisible.
const landmarkLeafMaterial = new THREE.MeshStandardMaterial({
  map: leafMaterial.map,
  // hard alphaTest only — same reasoning as leafMaterial (see vegetation.js)
  alphaTest: 0.5,
  side: THREE.DoubleSide,
  vertexColors: true,
  roughness: 0.9,
  metalness: 0,
});
// keep the double-sided normal trick from the original so the outward-from-
// crown normals shade consistently from every angle (soft canopy lighting)
landmarkLeafMaterial.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
     #ifdef DOUBLE_SIDED
       normal *= faceDirection;
     #endif`
  );
};

// Procedural noise helpers shared by all landmark surface shaders. World-space
// noise so the texture is tied to position in the world (not the UV layout) —
// rotating or scaling a stone doesn't slide the texture across its surface.
const GLSL_NOISE_3D = /* glsl */`
float h31(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h31(i + vec3(0,0,0)),  b = h31(i + vec3(1,0,0));
  float c = h31(i + vec3(0,1,0)),  d = h31(i + vec3(1,1,0));
  float e = h31(i + vec3(0,0,1)),  g = h31(i + vec3(1,0,1));
  float h = h31(i + vec3(0,1,1)),  k = h31(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y),
             mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  return vnoise3(p) * 0.55 + vnoise3(p * 2.3) * 0.27 + vnoise3(p * 5.1) * 0.13 + vnoise3(p * 9.7) * 0.05;
}
`;

export const landmarkMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.96, metalness: 0,
  // a faint emissive floor so upright faces turned away from a low sun read as
  // weathered stone rather than black voids (and keeps a hint of presence at night)
  emissive: new THREE.Color(0.10, 0.10, 0.11), emissiveIntensity: 1,
});

// Stone shares the terrain's painterly strength but uses a 3D mineral wash so
// the pattern wraps naturally over vertical faces. Continuous, low-amplitude
// fields replace the old ridge/crack mask that read as black marble veins.
landmarkMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uGroundDetail = groundDetailUniforms.strength;
  shader.vertexShader = 'varying vec3 vLWP;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
     vLWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`
  );
  shader.fragmentShader = ('varying vec3 vLWP;\nuniform float uGroundDetail;\n' + GLSL_NOISE_3D + shader.fragmentShader)
    .replace('#include <color_fragment>', `#include <color_fragment>
    {
      float detailFade = 1.0 - smoothstep(90.0, 300.0, length(cameraPosition - vLWP));
      float mineral = fbm3(vLWP * 0.11 + vec3(2.7, -4.1, 8.3)) - 0.5;
      float grain = vnoise3(vLWP * 0.82 - vec3(7.0, 1.3, 5.0)) - 0.5;
      float wash = (mineral * 0.24 + grain * 0.070) * uGroundDetail * detailFade;
      diffuseColor.rgb *= 1.0 + wash;
      float coolWash = (mineral + 0.5) * 0.024 * uGroundDetail * detailFade;
      diffuseColor.rgb = mix(diffuseColor.rgb,
        diffuseColor.rgb * vec3(0.985, 0.998, 1.018), coolWash);
    }`);
};

// Procedural bark for the giant landmark tree. The trunk is built in object
// space as a vertical cylinder around the local origin, so object-space cylin-
// drical coordinates (angle + height) give natural vertical grooves running
// along the trunk's growth axis — even when the wood mesh is merged with
// branches and roots, the grooves stay aligned with the trunk's main axis.
export const landmarkBarkMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.95, metalness: 0,
  emissive: new THREE.Color(0.04, 0.03, 0.02), emissiveIntensity: 1,
});
landmarkBarkMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = 'varying vec3 vLOP;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
     vLOP = transformed;`            // object-local position, before world tx
  );
  shader.fragmentShader = ('varying vec3 vLOP;\n' + GLSL_NOISE_3D + shader.fragmentShader)
    .replace('#include <color_fragment>', `#include <color_fragment>
    {
      float ang = atan(vLOP.z, vLOP.x);             // 0..2π around the trunk
      float hgt = vLOP.y;
      // vertical bark grooves: a noisy 1-D pattern in the angle direction
      float groove = abs(fract(ang * 4.8 + fbm3(vec3(ang * 1.2, hgt * 0.06, 0.0)) * 1.6) - 0.5) * 2.0;
      groove = smoothstep(0.18, 0.82, groove);      // ridges bright, grooves dark
      // cross-grain ripples and large rough blotches
      float blotch = fbm3(vec3(ang * 2.0, hgt * 0.18, 0.0)) - 0.5;
      float grain = vnoise3(vec3(ang * 22.0, hgt * 0.9, 0.0)) - 0.5;
      diffuseColor.rgb *= 1.0 + (blotch * 0.35 + grain * 0.25);
      diffuseColor.rgb *= 1.0 - (1.0 - groove) * 0.6;
      // moss creeping up the shaded side of the trunk near the base
      float moss = smoothstep(0.55, 0.9, blotch + 0.5) * (1.0 - smoothstep(0.0, 8.0, hgt));
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.7, 1.0, 0.65), moss * 0.4);
    }`);
};

// cloud shadows + aerial haze on stone/bark; the giant tree's canopy also gets
// leaf back-lighting like the regular foliage
injectAtmosphere(landmarkMaterial, { clouds: true, aerial: true });
injectAtmosphere(landmarkBarkMaterial, { clouds: true, aerial: true });
injectAtmosphere(landmarkLeafMaterial, { clouds: true, aerial: true, backlight: true });


// --- small geometry helpers --------------------------------------------------

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// coherent radial displacement → weathered, closed surfaces (no torn seams)
function weather(geo, rng, amt) {
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

function paint(geo, color, rng, amt = 0.08) {
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

function stoneColor(rng) {
  return new THREE.Color().setHSL(0.08 + rng() * 0.05, 0.04 + rng() * 0.06, 0.47 + rng() * 0.13);
}

// Seat a part so its lowest vertex sits `bury` below the *rendered* terrain
// under its actual mass. The chunk mesh interpolates linearly between vertices
// (~1.25 m apart), so the visible surface can dip below the smooth world.height()
// curve — deep bury compensates for that. We sample at the geometry's own
// bounding-box centre (so a rotated/fallen stone seats where its mass actually
// lies, not where its pre-rotation pivot was) and use the MIN over a small
// ring, then translate so the true lowest vertex lands at terrain - bury.
function seat(geo, ground, bury, radius = 1.2) {
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

// --- builders ----------------------------------------------------------------

function buildGiantTree(seed, ground) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const H = 42 + rng() * 18;
  const bark = new THREE.Color().setHSL(0.08, 0.28, 0.19 + rng() * 0.05);
  const folHue = 0.26 + rng() * 0.06;

  const wood = [];
  const trunk = new THREE.CylinderGeometry(H * 0.03, H * 0.08, H * 0.62, 9, 3);
  trunk.translate(0, H * 0.31, 0);
  wood.push(paint(trunk, bark, rng));
  const roots = 5 + (rng() * 3 | 0);
  for (let i = 0; i < roots; i++) {
    const a = i / roots * Math.PI * 2 + rng() * 0.3;
    const rl = H * 0.13 * (0.8 + rng() * 0.5);
    const root = new THREE.CylinderGeometry(H * 0.012, H * 0.05, rl, 5);
    root.translate(0, rl * 0.5, 0);
    root.rotateZ(1.15 + rng() * 0.2);
    root.rotateY(a);
    root.translate(Math.cos(a) * H * 0.05, 0, Math.sin(a) * H * 0.05);
    wood.push(paint(root, bark, rng));
  }
  const branches = 3 + (rng() * 3 | 0);
  for (let i = 0; i < branches; i++) {
    const a = rng() * Math.PI * 2;
    const bl = H * 0.3 * (0.7 + rng() * 0.5);
    const br = new THREE.CylinderGeometry(H * 0.008, H * 0.025, bl, 5);
    br.translate(0, bl * 0.5, 0);
    br.rotateZ(0.5 + rng() * 0.5);
    br.rotateY(a);
    br.translate(0, H * (0.5 + rng() * 0.18), 0);
    wood.push(paint(br, bark, rng));
  }
  // sample a ring around the trunk so the buttress sits in the lowest spot
  let gmin = 0;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    gmin = Math.min(gmin, ground(Math.cos(a) * 2, Math.sin(a) * 2));
  }
  const woodMesh = new THREE.Mesh(mergeGeometries(wood), landmarkBarkMaterial);
  woodMesh.castShadow = true;
  woodMesh.position.y = gmin - 1.5;       // ride the lowest nearby terrain, buried
  g.add(woodMesh);

  // Canopy made from leaf-cluster cards (same texture and material as regular
  // broadleaf trees, so the giant reads as foliage instead of a solid polyhedron).
  // After merging, every leaf normal is set to point outward from the crown
  // centre, which gives soft, hemispherical canopy shading — same trick the
  // standard broadleaf builder uses.
  const leaves = [];
  // The crown sits high enough to envelop the upper trunk and the branch tips,
  // and uses a full ellipsoidal volume (with a slight outer-edge bias) so the
  // foliage reads as dense rather than as a thin shell.
  const crownY = H * 0.78, crownR = H * 0.52;
  const cards = 520 + (rng() * 120 | 0);
  for (let i = 0; i < cards; i++) {
    const size = H * (0.07 + rng() * 0.07);
    const card = new THREE.PlaneGeometry(size, size);
    card.rotateX((rng() - 0.5) * 1.2);
    card.rotateY(rng() * Math.PI * 2);
    card.rotateZ((rng() - 0.5) * 0.8);
    const u = rng() * Math.PI * 2;
    const v = Math.acos(2 * rng() - 1);
    // pow(rng, 0.5) biases the cube-root-uniform radius toward the outer half
    // of the ellipsoid → denser surface, lighter interior, like a real crown
    const rad = crownR * Math.pow(rng(), 0.35);
    const ox = rad * Math.sin(v) * Math.cos(u);
    const oy = rad * 0.85 * Math.cos(v);
    const oz = rad * Math.sin(v) * Math.sin(u);
    card.translate(ox, crownY + oy, oz);
    const c = new THREE.Color().setHSL(folHue + (rng() - 0.5) * 0.04, 0.4 + rng() * 0.15, 0.28 + rng() * 0.1);
    leaves.push(paint(card, c, rng, 0.16));
  }
  const leafGeo = mergeGeometries(leaves);
  // outward-pointing normals from the crown centre → soft hemispherical shading
  leafGeo.computeBoundingSphere();
  const crown = leafGeo.boundingSphere.center;
  const lp = leafGeo.attributes.position, ln = leafGeo.attributes.normal;
  const nrm = new THREE.Vector3();
  // strong upward bias (scaled to the giant's crown size, not the small +0.6
  // that broadleaves use) so leaves on the bottom and sides still catch sun
  const upBias = crownR * 0.9;
  for (let i = 0; i < lp.count; i++) {
    nrm.set(lp.getX(i) - crown.x, lp.getY(i) - crown.y + upBias, lp.getZ(i) - crown.z).normalize();
    ln.setXYZ(i, nrm.x, nrm.y, nrm.z);
  }
  const canopy = new THREE.Mesh(leafGeo, landmarkLeafMaterial);
  canopy.castShadow = true;
  canopy.position.y = gmin - 1.5; // sink with the trunk
  g.add(canopy);
  return g;
}

function buildStoneRing(seed, ground) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const parts = [];
  const N = 7 + (rng() * 7 | 0);
  const R = 6 + rng() * 5;

  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    const lx = Math.cos(a) * R, lz = Math.sin(a) * R;
    const fallen = rng() < 0.15;
    const h = 2.2 + rng() * 2.8, wd = 0.6 + rng() * 0.7, th = 0.4 + rng() * 0.4;
    const st = new THREE.BoxGeometry(wd, h, th, 1, 2, 1);
    weather(st, rng, 0.06);
    st.translate(0, h / 2, 0);
    if (fallen) st.rotateX(Math.PI * 0.45);
    st.rotateZ((rng() - 0.5) * 0.18);
    st.rotateY(a + (rng() - 0.5) * 0.3);
    st.translate(lx, 0, lz);
    // bury deep enough that the chunk mesh's linear-interp dip between
    // vertices (~30–50 cm on the new turbulent terrain) can never expose the
    // base; matches how real standing stones are set ~1/3 of their height down.
    seat(st, ground, fallen ? 0.9 : 1.5, fallen ? 1.6 : 1.0);
    parts.push(paint(st, stoneColor(rng), rng));
  }
  if (rng() < 0.6) {
    const al = new THREE.BoxGeometry(2.4 + rng(), 0.7, 1.4 + rng() * 0.6);
    weather(al, rng, 0.05);
    al.translate(0, 0.35, 0);
    seat(al, ground, 0.55, 1.2);
    parts.push(paint(al, stoneColor(rng), rng, 0.06));
  }
  // heel stone, set apart — marks the seeded "solstice" direction
  const ha = rng() * Math.PI * 2, hh = 3 + rng() * 2;
  const hlx = Math.cos(ha) * (R + 3.5), hlz = Math.sin(ha) * (R + 3.5);
  const heel = new THREE.BoxGeometry(0.9, hh, 0.7);
  weather(heel, rng, 0.06);
  heel.translate(0, hh / 2, 0);
  heel.rotateZ((rng() - 0.5) * 0.1);
  heel.rotateY(ha);
  heel.translate(hlx, 0, hlz);
  seat(heel, ground, 1.5, 1.0);
  parts.push(paint(heel, stoneColor(rng), rng));

  const mesh = new THREE.Mesh(mergeGeometries(parts), landmarkMaterial);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

function buildCairn(seed, ground) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const parts = [];
  const layers = 6 + (rng() * 5 | 0);
  const baseR = 1.4 + rng() * 1.2;
  // Stones taper from largest at the bottom to smallest at the top, like a
  // real hand-stacked cairn. Layer height scales with stone size so each tier
  // sits naturally on top of the one below.
  let y = 0;
  for (let i = 0; i < layers; i++) {
    const t = i / Math.max(1, layers - 1);     // 0 at bottom, 1 at top
    const r = baseR * (1 - t * 0.8);
    const stones = Math.max(1, Math.round((1 - t) * 6));
    const stoneScale = 1 - t * 0.65;            // big → small with height
    const sBase = 0.5 * stoneScale;
    const ly = (0.42 + rng() * 0.12) * stoneScale;
    for (let s = 0; s < stones; s++) {
      const a = s / stones * Math.PI * 2 + rng();
      const sz = sBase * (0.85 + rng() * 0.3);
      const rock = new THREE.IcosahedronGeometry(sz, 0);
      weather(rock, rng, 0.25);
      rock.scale(1, 0.7, 1);
      const rr = r * (0.3 + rng() * 0.5);
      rock.translate(Math.cos(a) * rr, y + ly * 0.5, Math.sin(a) * rr);
      const c = new THREE.Color().setHSL(0.09 + rng() * 0.05, 0.05 + rng() * 0.06, 0.44 + rng() * 0.13);
      parts.push(paint(rock, c, rng, 0.1));
    }
    y += ly;
  }
  // capstone: smaller than the top layer's stones (≈0.25 m), tops the stack
  const cap = new THREE.IcosahedronGeometry(0.2 + rng() * 0.08, 0);
  weather(cap, rng, 0.2);
  cap.scale(1, 0.6, 1);
  cap.translate(0, y + 0.12, 0);
  parts.push(paint(cap, new THREE.Color().setHSL(0.09, 0.06, 0.54), rng, 0.08));

  const merged = seat(mergeGeometries(parts), ground, 0.9, baseR + 0.5);
  const mesh = new THREE.Mesh(merged, landmarkMaterial);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

const BUILDERS = { giant: buildGiantTree, ring: buildStoneRing, cairn: buildCairn };

// --- streaming manager -------------------------------------------------------

export class LandmarkManager {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.seed = world.seed;
    this.radius = 2200;       // landmarks build out to ~2.2 km (horizon goals)
    this.active = new Map();  // key -> Group
    this._list = [];
    this._px = 1e9;
    this._pz = 1e9;
  }

  update(px, pz) {
    const dx = px - this._px, dz = pz - this._pz;
    if (dx * dx + dz * dz < 60 * 60) return; // rescan only when the player moves
    this._px = px; this._pz = pz;

    landmarksAround(this.world, px, pz, this.seed, this.radius, this._list);
    const want = new Set();
    for (const lm of this._list) {
      want.add(lm.key);
      if (!this.active.has(lm.key)) this._build(lm);
    }
    for (const [key, obj] of this.active) {
      if (!want.has(key)) { this.scene.remove(obj); this._dispose(obj); this.active.delete(key); }
    }
  }

  _build(lm) {
    const fn = BUILDERS[lm.type];
    if (!fn) return;
    // local terrain height under an element offset (lx, lz) from the base
    const ground = (lx, lz) => this.world.height(lm.x + lx, lm.z + lz) - lm.y;
    const g = fn(lm.seed, ground);
    g.position.set(lm.x, lm.y, lm.z);
    g.rotation.y = lm.yaw;
    this.scene.add(g);
    this.active.set(lm.key, g);
  }

  _dispose(obj) {
    obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  // nearest landmark to a point (for debug teleport / a future compass)
  nearest(px, pz) {
    landmarksAround(this.world, px, pz, this.seed, this.radius, this._list);
    let best = null, bd = Infinity;
    for (const lm of this._list) {
      const d = (lm.x - px) ** 2 + (lm.z - pz) ** 2;
      if (d < bd) { bd = d; best = lm; }
    }
    return best;
  }
}
