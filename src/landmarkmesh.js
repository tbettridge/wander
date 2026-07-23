// Parametric landmark builders + a streaming manager. Each builder turns a
// variation seed into a THREE.Group (base at y=0); the manager streams the
// handful of landmarks within range around the player, building them from the
// shared deterministic placement (landmarks.js) so they line up with the
// vegetation clearing-halos the worker carves.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from './noise.js';
import { greatTreeArchetype, landmarksAround, majorLandmarksAround } from './landmarks.js';
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
      float stoneDist = length(cameraPosition - vLWP);
      float detailFade = 1.0 - smoothstep(90.0, 300.0, stoneDist);
      float mineral = fbm3(vLWP * 0.11 + vec3(2.7, -4.1, 8.3)) - 0.5;
      float grain = vnoise3(vLWP * 0.82 - vec3(7.0, 1.3, 5.0)) - 0.5;
      float wash = (mineral * 0.30 + grain * 0.11) * uGroundDetail * detailFade;
      diffuseColor.rgb *= 1.0 + wash;
      float coolWash = (mineral + 0.5) * 0.024 * uGroundDetail * detailFade;
      diffuseColor.rgb = mix(diffuseColor.rgb,
        diffuseColor.rgb * vec3(0.985, 0.998, 1.018), coolWash);
      // close-range erosion: small dark pocks + a fine salt-and-pepper speckle,
      // so worn faces read as pitted stone rather than smooth plaster
      float nearFade = (1.0 - smoothstep(22.0, 70.0, stoneDist)) * uGroundDetail;
      float pit = smoothstep(0.60, 0.82, vnoise3(vLWP * 3.1 + vec3(5.0, 9.0, 1.0)));
      float speck = vnoise3(vLWP * 6.5 + vec3(1.0, 3.0, 7.0)) - 0.5;
      diffuseColor.rgb *= 1.0 - pit * 0.13 * nearFade;
      diffuseColor.rgb *= 1.0 + speck * 0.10 * nearFade;
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

// mergeGeometries refuses to mix indexed (Box/Cylinder) with non-indexed
// (Icosahedron) inputs — normalise to non-indexed at the final merge
function ni(geo) { return geo.index ? geo.toNonIndexed() : geo; }

// A worn stone block: rounded edges (so nothing is razor-sharp), a slight
// asymmetric skew, and enough subdivision that the weathering noise can bend
// the contours. `seg` trades silhouette softness for vertex count — 1 for the
// many small masonry courses, 2 for hero stones (megaliths, lintels, walls).
function stoneBox(w, h, d, rng, seg = 1, amt = 0.07) {
  const r = Math.min(w, h, d) * (0.16 + rng() * 0.08);
  const geo = new RoundedBoxGeometry(w, h, d, seg, r);
  geo.scale(1 + (rng() - 0.5) * 0.08, 1 + (rng() - 0.5) * 0.06, 1 + (rng() - 0.5) * 0.10);
  weather(geo, rng, amt);
  return geo;
}

// Bake edge wear into the vertex colours: bevel-ring vertices (normals off the
// three face axes) darken slightly, so every block keeps a soft worn contour
// even under flat ambient light. Call AFTER paint().
function ageStone(geo, amt = 0.28) {
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

// A tapered cylinder aligned between arbitrary endpoints. Great-tree wood is
// assembled from short overlapping growth segments: the resulting low-frequency
// bends read as accumulated growth, while each finished tree still merges to a
// single bark draw call.
function taperedSegment(a, b, radiusA, radiusB, radialSegments = 7) {
  const direction = b.clone().sub(a);
  const length = direction.length();
  if (length < 1e-4) return null;
  const geo = new THREE.CylinderGeometry(radiusB, radiusA, length * 1.025, radialSegments, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), direction.multiplyScalar(1 / length),
  );
  geo.applyQuaternion(q);
  geo.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  return geo;
}

function addWoodPath(out, points, radiusA, radiusB, color, rng, radialSegments = 7) {
  const count = Math.max(1, points.length - 1);
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count;
    const r0 = THREE.MathUtils.lerp(radiusA, radiusB, Math.pow(t0, 0.82));
    const r1 = THREE.MathUtils.lerp(radiusA, radiusB, Math.pow(t1, 0.82));
    const segment = taperedSegment(points[i], points[i + 1], r0, r1, radialSegments);
    if (segment) out.push(paint(segment, color, rng, 0.10));
  }
}

function pointOnPolyline(points, t) {
  const scaled = Math.max(0, Math.min(1, t)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  return points[index].clone().lerp(points[index + 1], scaled - index);
}

// --- builders ----------------------------------------------------------------

function buildGiantTree(seed, ground) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const forms = {
    cathedral: { h: 1.10, width: 0.92, top: 0.95, low: 0.52, branches: 5, base: 1.00, damage: 0.03 },
    forked:    { h: 1.02, width: 1.04, top: 0.63, low: 0.40, branches: 6, base: 1.08, damage: 0.06 },
    open:      { h: 0.88, width: 1.24, top: 0.76, low: 0.33, branches: 7, base: 1.12, damage: 0.05 },
    storm:     { h: 0.96, width: 1.10, top: 0.80, low: 0.42, branches: 6, base: 1.04, damage: 0.27 },
    hollow:    { h: 1.00, width: 1.02, top: 0.82, low: 0.39, branches: 6, base: 1.24, damage: 0.18 },
  };
  const archetype = greatTreeArchetype(seed);
  rng(); // keep the builder's seeded stream aligned with the archetype roll
  const form = forms[archetype];
  const H = (46 + rng() * 15) * form.h;
  const bark = new THREE.Color().setHSL(0.08, 0.28, 0.19 + rng() * 0.05);
  const folHue = 0.26 + rng() * 0.06;
  const growthAngle = rng() * Math.PI * 2;

  // Infer the local slope from the same rendered terrain sampler used to seat
  // the landmark. Roots reinforce the downhill side, while the bole makes a
  // subtle compensating lean uphill.
  const probe = Math.max(5, H * 0.10);
  const slopeX = (ground(probe, 0) - ground(-probe, 0)) / (probe * 2);
  const slopeZ = (ground(0, probe) - ground(0, -probe)) / (probe * 2);
  const downhill = new THREE.Vector2(-slopeX, -slopeZ);
  const slopeStrength = Math.min(1, downhill.length() * 5.5);
  if (downhill.lengthSq() > 1e-7) downhill.normalize();
  else downhill.set(Math.cos(growthAngle), Math.sin(growthAngle));

  let baseGround = ground(0, 0);
  const baseProbe = H * 0.065;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    baseGround = Math.min(baseGround, ground(Math.cos(a) * baseProbe, Math.sin(a) * baseProbe));
  }
  const baseY = baseGround - H * 0.025;
  const baseRadius = H * (0.072 + rng() * 0.012) * form.base;
  const wood = [];

  // A segmented, gently wandering bole replaces the perfectly straight cone.
  const trunkPoints = [];
  const trunkSegments = 8;
  const trunkLean = H * (archetype === 'storm' ? 0.085 : 0.025 + rng() * 0.025);
  const leanAngle = archetype === 'storm'
    ? growthAngle
    : Math.atan2(-downhill.y, -downhill.x) + (rng() - 0.5) * 0.8;
  const bendPhase = rng() * Math.PI * 2;
  for (let i = 0; i <= trunkSegments; i++) {
    const t = i / trunkSegments;
    const lean = trunkLean * Math.pow(t, 1.55);
    const wander = Math.sin(t * Math.PI * 2.2 + bendPhase) * H * 0.008 * t;
    trunkPoints.push(new THREE.Vector3(
      Math.cos(leanAngle) * lean + Math.cos(leanAngle + Math.PI * 0.5) * wander,
      baseY + H * form.top * t,
      Math.sin(leanAngle) * lean + Math.sin(leanAngle + Math.PI * 0.5) * wander,
    ));
  }
  addWoodPath(wood, trunkPoints, baseRadius, H * 0.018, bark, rng, 10);

  // Irregular terrain-following buttresses replace the radial root spokes.
  const rootCount = 7 + (rng() * 4 | 0);
  for (let i = 0; i < rootCount; i++) {
    const a = growthAngle + i * 2.399963 + (rng() - 0.5) * 0.34;
    const ux = Math.cos(a), uz = Math.sin(a);
    const affinity = Math.max(0, ux * downhill.x + uz * downhill.y);
    const length = H * (0.15 + rng() * 0.075) * (1 + affinity * slopeStrength * 0.55);
    const side = (rng() - 0.5) * length * 0.16;
    const points = [];
    for (let j = 0; j <= 4; j++) {
      const t = j / 4;
      const distance = length * Math.pow(t, 0.86);
      const x = ux * distance - uz * side * Math.sin(t * Math.PI);
      const z = uz * distance + ux * side * Math.sin(t * Math.PI);
      const arch = H * 0.052 * Math.pow(1 - t, 2.2);
      points.push(new THREE.Vector3(x, Math.max(ground(x, z) - H * 0.006, baseY + arch), z));
    }
    addWoodPath(wood, points, baseRadius * (0.48 + rng() * 0.16), H * 0.006, bark, rng, 7);
  }

  const lobes = [];
  const branchCount = form.branches + (rng() < 0.48 ? 1 : 0);
  const crownShift = archetype === 'storm' ? H * 0.11 : 0;
  const shiftX = Math.cos(growthAngle) * crownShift;
  const shiftZ = Math.sin(growthAngle) * crownShift;

  // Forked elders keep the same branch grammar but split into two dominant
  // leaders, giving them a categorical silhouette without becoming a new species.
  if (archetype === 'forked') {
    const fork = pointOnPolyline(trunkPoints, 0.58);
    for (const side of [-1, 1]) {
      const a = growthAngle + side * (0.56 + rng() * 0.16);
      const end = new THREE.Vector3(
        fork.x + Math.cos(a) * H * (0.13 + rng() * 0.035),
        baseY + H * (0.88 + rng() * 0.07),
        fork.z + Math.sin(a) * H * (0.13 + rng() * 0.035),
      );
      const control = fork.clone().lerp(end, 0.48); control.y += H * 0.06;
      addWoodPath(wood, new THREE.QuadraticBezierCurve3(fork, control, end).getPoints(5),
        baseRadius * 0.44, H * 0.014, bark, rng, 8);
      lobes.push({ center: end, rx: H * 0.17, ry: H * 0.15, rz: H * 0.17 });
    }
  }

  const branchMax = Math.min(0.77, form.top - 0.04);
  let liveTips = 0;
  for (let i = 0; i < branchCount; i++) {
    const t = form.low + (branchMax - form.low) * ((i + 0.35 + rng() * 0.3) / branchCount);
    const start = pointOnPolyline(trunkPoints, t);
    let a = growthAngle + i * 2.399963 + (rng() - 0.5) * 0.42;
    if (archetype === 'storm') {
      a = Math.atan2(Math.sin(a) * 0.58 + Math.sin(growthAngle) * 0.42,
        Math.cos(a) * 0.58 + Math.cos(growthAngle) * 0.42);
    }
    const lowBoost = 1 + (1 - t) * (archetype === 'open' ? 0.55 : 0.22);
    const length = H * (0.22 + rng() * 0.105) * form.width * lowBoost;
    const rise = H * (0.10 + rng() * 0.12) - (i === 0 && archetype === 'open' ? H * 0.055 : 0);
    const end = new THREE.Vector3(
      start.x + Math.cos(a) * length + shiftX * 0.35,
      start.y + rise,
      start.z + Math.sin(a) * length + shiftZ * 0.35,
    );
    const control = start.clone().lerp(end, 0.48);
    const sideBend = (rng() - 0.5) * H * 0.055;
    control.x -= Math.sin(a) * sideBend;
    control.z += Math.cos(a) * sideBend;
    control.y += H * (0.075 + rng() * 0.045);
    const path = new THREE.QuadraticBezierCurve3(start, control, end).getPoints(5);
    const branchRadius = H * (0.026 + (1 - t) * 0.020);
    addWoodPath(wood, path, branchRadius, H * 0.007, bark, rng, 7);

    const damaged = rng() < form.damage && i !== branchCount - 1;
    if (!damaged) {
      liveTips++;
      lobes.push({
        center: end.clone(),
        rx: H * (0.145 + rng() * 0.045) * form.width,
        ry: H * (0.115 + rng() * 0.045),
        rz: H * (0.145 + rng() * 0.045) * form.width,
      });
    }
    if (!damaged && rng() < 0.72) {
      const forkStart = path[3];
      const forkAngle = a + (rng() < 0.5 ? -1 : 1) * (0.42 + rng() * 0.35);
      const forkLength = length * (0.30 + rng() * 0.16);
      const forkEnd = new THREE.Vector3(
        forkStart.x + Math.cos(forkAngle) * forkLength,
        forkStart.y + H * (0.045 + rng() * 0.055),
        forkStart.z + Math.sin(forkAngle) * forkLength,
      );
      const forkControl = forkStart.clone().lerp(forkEnd, 0.5); forkControl.y += H * 0.035;
      addWoodPath(wood, new THREE.QuadraticBezierCurve3(forkStart, forkControl, forkEnd).getPoints(3),
        branchRadius * 0.58, H * 0.0045, bark, rng, 6);
      lobes.push({ center: forkEnd, rx: H * (0.11 + rng() * 0.035),
        ry: H * (0.09 + rng() * 0.03), rz: H * (0.11 + rng() * 0.035) });
    }
  }

  // A few upper masses retain the species' broad domed crown while leaving
  // negative space between branch-tip clusters.
  const trunkTop = trunkPoints[trunkPoints.length - 1];
  const topLobes = archetype === 'cathedral' ? 4 : 3;
  for (let i = 0; i < topLobes; i++) {
    const a = growthAngle + i * 2.399963 + rng() * 0.45;
    const spread = H * form.width * (i === 0 ? 0.02 : 0.08 + rng() * 0.05);
    lobes.push({
      center: new THREE.Vector3(trunkTop.x + Math.cos(a) * spread + shiftX,
        Math.max(trunkTop.y, baseY + H * (0.77 + rng() * 0.11)),
        trunkTop.z + Math.sin(a) * spread + shiftZ),
      rx: H * (0.15 + rng() * 0.05) * form.width,
      ry: H * (0.13 + rng() * 0.045) * (archetype === 'cathedral' ? 1.12 : 1),
      rz: H * (0.15 + rng() * 0.05) * form.width,
    });
  }

  // Storm-shaped and hollow elders sometimes retain a fallen limb in their
  // clearing, giving the landmark a small, readable history at ground level.
  if ((archetype === 'storm' || archetype === 'hollow') && rng() < 0.78) {
    const a = growthAngle + Math.PI * (0.65 + rng() * 0.7);
    const length = H * (0.18 + rng() * 0.10);
    const fallen = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const x = Math.cos(a) * (H * 0.10 + length * t);
      const z = Math.sin(a) * (H * 0.10 + length * t);
      fallen.push(new THREE.Vector3(x, ground(x, z) + H * (0.010 - t * 0.004), z));
    }
    addWoodPath(wood, fallen, H * 0.018, H * 0.004,
      bark.clone().multiplyScalar(0.82), rng, 6);
  }

  const woodMesh = new THREE.Mesh(mergeGeometries(wood), landmarkBarkMaterial);
  woodMesh.castShadow = true;
  g.add(woodMesh);

  // Cards are allocated between foliage lobes by volume. They still use the
  // regular broadleaf texture/material, preserving species continuity and one
  // merged canopy draw call.
  const weights = [];
  let totalWeight = 0;
  for (const lobe of lobes) {
    totalWeight += lobe.rx * lobe.ry * lobe.rz;
    weights.push(totalWeight);
  }
  const leaves = [];
  const cards = 560 + (rng() * 150 | 0);
  for (let i = 0; i < cards; i++) {
    const pick = rng() * totalWeight;
    let index = 0;
    while (index < weights.length - 1 && pick > weights[index]) index++;
    const lobe = lobes[index];
    const size = H * (0.045 + rng() * 0.050);
    const card = new THREE.PlaneGeometry(size, size);
    card.rotateX((rng() - 0.5) * 1.2);
    card.rotateY(rng() * Math.PI * 2);
    card.rotateZ((rng() - 0.5) * 0.8);
    const u = rng() * Math.PI * 2, v = Math.acos(2 * rng() - 1);
    const radius = Math.pow(rng(), 0.42);
    card.translate(
      lobe.center.x + lobe.rx * radius * Math.sin(v) * Math.cos(u),
      lobe.center.y + lobe.ry * radius * Math.cos(v),
      lobe.center.z + lobe.rz * radius * Math.sin(v) * Math.sin(u),
    );
    const color = new THREE.Color().setHSL(folHue + (rng() - 0.5) * 0.04,
      0.4 + rng() * 0.15, 0.28 + rng() * 0.1);
    leaves.push(paint(card, color, rng, 0.16));
  }
  const leafGeo = mergeGeometries(leaves);
  const lp = leafGeo.attributes.position, ln = leafGeo.attributes.normal;
  const normal = new THREE.Vector3();
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i), y = lp.getY(i), z = lp.getZ(i);
    let nearest = lobes[0], best = Infinity;
    for (const lobe of lobes) {
      const dx = (x - lobe.center.x) / lobe.rx;
      const dy = (y - lobe.center.y) / lobe.ry;
      const dz = (z - lobe.center.z) / lobe.rz;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < best) { best = distance; nearest = lobe; }
    }
    normal.set((x - nearest.center.x) / nearest.rx,
      (y - nearest.center.y + nearest.ry * 0.72) / nearest.ry,
      (z - nearest.center.z) / nearest.rz).normalize();
    ln.setXYZ(i, normal.x, normal.y, normal.z);
  }
  const canopy = new THREE.Mesh(leafGeo, landmarkLeafMaterial);
  canopy.castShadow = true;
  g.add(canopy);

  g.userData.giantTree = { archetype, height: H, branchCount, growthAngle, liveTips };
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
    const st = stoneBox(wd, h, th, rng, 2, 0.09);
    st.translate(0, h / 2, 0);
    if (fallen) st.rotateX(Math.PI * 0.45);
    st.rotateZ((rng() - 0.5) * 0.18);
    st.rotateY(a + (rng() - 0.5) * 0.3);
    st.translate(lx, 0, lz);
    // bury deep enough that the chunk mesh's linear-interp dip between
    // vertices (~30–50 cm on the new turbulent terrain) can never expose the
    // base; matches how real standing stones are set ~1/3 of their height down.
    seat(st, ground, fallen ? 0.9 : 1.5, fallen ? 1.6 : 1.0);
    parts.push(ageStone(paint(st, stoneColor(rng), rng)));
  }
  if (rng() < 0.6) {
    const al = stoneBox(2.4 + rng(), 0.7, 1.4 + rng() * 0.6, rng, 2, 0.07);
    al.translate(0, 0.35, 0);
    seat(al, ground, 0.55, 1.2);
    parts.push(ageStone(paint(al, stoneColor(rng), rng, 0.06)));
  }
  // heel stone, set apart — marks the seeded "solstice" direction
  const ha = rng() * Math.PI * 2, hh = 3 + rng() * 2;
  const hlx = Math.cos(ha) * (R + 3.5), hlz = Math.sin(ha) * (R + 3.5);
  const heel = stoneBox(0.9, hh, 0.7, rng, 2, 0.09);
  heel.translate(0, hh / 2, 0);
  heel.rotateZ((rng() - 0.5) * 0.1);
  heel.rotateY(ha);
  heel.translate(hlx, 0, hlz);
  seat(heel, ground, 1.5, 1.0);
  parts.push(ageStone(paint(heel, stoneColor(rng), rng)));

  const mesh = new THREE.Mesh(mergeGeometries(parts.map(ni)), landmarkMaterial);
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
      const rock = new THREE.IcosahedronGeometry(sz, 1);
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
  const cap = new THREE.IcosahedronGeometry(0.2 + rng() * 0.08, 1);
  weather(cap, rng, 0.2);
  cap.scale(1, 0.6, 1);
  cap.translate(0, y + 0.12, 0);
  parts.push(paint(cap, new THREE.Color().setHSL(0.09, 0.06, 0.54), rng, 0.08));

  const merged = seat(mergeGeometries(parts.map(ni)), ground, 0.9, baseR + 0.5);
  const mesh = new THREE.Mesh(merged, landmarkMaterial);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

// Ruined watchtower: a broken masonry cylinder on a rise. Individual stone
// blocks laid in running-bond courses; a seeded "break profile" leaves one
// side standing tall while the opposite arc crumbles to a couple of courses.
// A doorway gap (with lintel) faces the ruined side, and fallen blocks litter
// the ground where the wall came down.
function buildWatchtower(seed, ground) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const R = 2.7 + rng() * 0.5;                 // slim drum (~5.5–6.5 m across) → reads tall
  const courses = 13 + (rng() * 4 | 0);        // tallest surviving height, in courses
  const bh = 0.92 + rng() * 0.18;              // course height → tall side ~12–16 m
  const tallA = rng() * Math.PI * 2;           // best-preserved direction
  const doorA = tallA + (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.3); // pierces the standing shell
  const angDist = (a, b) => {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  // surviving height (in courses) around the rim: classic ruin profile — a
  // full-height shell over ~1/3 of the drum, then a steep, jagged break down
  // to a low stub (a smooth cosine lobe reads as a mound when the tall side
  // faces the viewer; a wedge + step keeps a vertical tower from every angle)
  const wedge = 0.95 + rng() * 0.3;            // half-width of the surviving shell
  const rim = (a) => {
    const t = Math.min(1, Math.max(0, (angDist(a, tallA) - wedge) / 0.6));
    const p = 1 - t * t * (3 - 2 * t);
    const jag = (hash3(Math.round(a * 9), (seed % 89) * 0.13, 1.7) - 0.5) * 2.6;
    return courses * (0.14 + 0.86 * p) + jag;
  };

  const towerParts = [];
  const baseCol = stoneColor(rng);
  // blocks are longer than their angular spacing, so neighbours overlap and
  // the wall reads as solid masonry (gaps between chord-boxes on a circle
  // otherwise open into a checkerboard of holes)
  const nBlocks = Math.round((Math.PI * 2 * R) / 1.0);
  for (let c = 0; c < courses; c++) {
    for (let k = 0; k < nBlocks; k++) {
      const a = ((k + (c % 2) * 0.5) / nBlocks) * Math.PI * 2;
      if (c + 0.5 > rim(a)) continue;                          // collapsed here
      if (c < 3 && angDist(a, doorA) < 0.34) continue;         // doorway gap
      if (courses >= 10 && (c === 5 || c === 6) && angDist(a, tallA) < 0.10) continue; // window slit
      const st = stoneBox(1.38, bh * 1.01, 0.82, rng, 1, 0.06);
      st.rotateY(a + Math.PI / 2 + (rng() - 0.5) * 0.02);      // long axis tangent
      const rr = R - c * 0.035 + (rng() - 0.5) * 0.06;         // gentle inward batter
      st.translate(Math.cos(a) * rr, c * bh + bh * 0.5, Math.sin(a) * rr);
      // moss climbs the lowest courses; the odd darker plug stone breaks the mass
      const moss = Math.max(0, 1 - c / 2.5) * 0.4;
      const col = baseCol.clone().offsetHSL((rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.09)
        .lerp(new THREE.Color(baseCol.r * 0.70, baseCol.g, baseCol.b * 0.58), moss);
      if (rng() < 0.16) col.multiplyScalar(0.78);
      towerParts.push(ageStone(paint(st, col, rng, 0.1)));
    }
  }
  // lintel over the doorway (only if the wall above it survived)
  if (rim(doorA) > 4) {
    const lin = stoneBox(2.6, 0.36, 1.0, rng, 2, 0.05);
    lin.rotateY(doorA + Math.PI / 2);
    lin.translate(Math.cos(doorA) * R, 3 * bh + 0.18, Math.sin(doorA) * R);
    towerParts.push(ageStone(paint(lin, stoneColor(rng), rng, 0.05)));
  }
  const tower = mergeGeometries(towerParts.map(ni));
  seat(tower, ground, 0.6, R + 0.3);

  // fallen blocks: most tumbled outward below the collapsed arc, a few inside
  const rubbleParts = [];
  const rubble = 9 + (rng() * 8 | 0);
  for (let i = 0; i < rubble; i++) {
    const inside = rng() < 0.22;
    const a = inside ? rng() * Math.PI * 2
      : tallA + Math.PI + (rng() - 0.5) * 3.2;                 // ruined side
    const rr = inside ? rng() * R * 0.6 : R + 0.8 + rng() * 4.2;
    const sz = 0.3 + rng() * 0.42;
    const rock = new THREE.IcosahedronGeometry(sz, 1);
    weather(rock, rng, 0.3);
    rock.scale(1, 0.7, 1);
    rock.rotateY(rng() * Math.PI * 2);
    rock.translate(Math.cos(a) * rr, sz * 0.5, Math.sin(a) * rr);
    seat(rock, ground, sz * 0.45, 0.9);
    rubbleParts.push(paint(rock, stoneColor(rng), rng, 0.1));
  }

  const mesh = new THREE.Mesh(mergeGeometries([tower, ...rubbleParts].map(ni)), landmarkMaterial);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

// Lighthouse ruin on a headland: limewashed tower with faded rust bands,
// gallery + lamp room (the lamp material's emissive is pulsed at night by
// LighthouseFx), a roofless keeper's cottage and rubble on the land side.
// "Ruin" reads through the weathering + cottage — the tower itself stands.
export const lighthouseLampMaterial = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.16, 0.12, 0.08),
  emissive: new THREE.Color(1.0, 0.76, 0.42),
  emissiveIntensity: 0.15,
  roughness: 0.35, metalness: 0,
});

function buildLighthouse(seed, ground, lm) {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const H = (lm && lm.towerH) || (22 + rng() * 8);
  const baseR = Math.max(2.9, H * 0.13), topR = baseR * 0.6;

  // one shared base height for the whole tower stack: the LOWEST rendered
  // terrain under the foundation ring, buried so the drum never floats
  let gmin = ground(0, 0);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    gmin = Math.min(gmin, ground(Math.cos(a) * (baseR + 1.4), Math.sin(a) * (baseR + 1.4)));
  }
  const baseY = gmin - 1.3;

  const towerParts = [];   // translated to baseY as a rigid stack
  const groundParts = [];  // seated on the terrain individually

  // foundation drum
  const found = new THREE.CylinderGeometry(baseR + 0.9, baseR + 1.4, 2.6, 14, 1);
  found.translate(0, 1.3, 0);
  towerParts.push(paint(found, new THREE.Color(0.52, 0.50, 0.47), rng, 0.08));

  // shaft: limewash white with two faded rust bands, grime creeping up the base
  const shaft = new THREE.CylinderGeometry(topR, baseR, H, 14, 10);
  shaft.translate(0, 2.6 + H * 0.5, 0);
  {
    const pos = shaft.attributes.position;
    const n = pos.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const rel = Math.max(0, Math.min(1, (pos.getY(i) - 2.6) / H));
      const band = ((rel * 3.1 + 0.18) % 1 + 1) % 1;
      const isBand = band < 0.27 && rel > 0.06 && rel < 0.96;
      const j = 1 + (rng() * 2 - 1) * 0.05;
      let r, gg, b;
      if (isBand) { r = 0.58; gg = 0.27; b = 0.21; }            // faded rust red
      else { r = 0.87; gg = 0.85; b = 0.80; }                   // weathered limewash
      const grime = (1 - rel) * 0.16;                           // salt + moss at the foot
      r *= (1 - grime) * j; gg *= (1 - grime * 0.7) * j; b *= (1 - grime) * j;
      cols[i * 3] = r; cols[i * 3 + 1] = gg; cols[i * 3 + 2] = b;
    }
    shaft.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    if (!shaft.attributes.uv) shaft.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  towerParts.push(shaft);

  // gallery deck + railing
  const iron = new THREE.Color(0.15, 0.15, 0.16);
  const deckY = 2.6 + H;
  const deck = new THREE.CylinderGeometry(topR + 1.0, topR + 1.25, 0.55, 14, 1);
  deck.translate(0, deckY + 0.27, 0);
  towerParts.push(paint(deck, new THREE.Color(0.45, 0.44, 0.42), rng, 0.06));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const post = new THREE.BoxGeometry(0.07, 1.05, 0.07);
    post.translate(Math.cos(a) * (topR + 0.92), deckY + 0.55 + 0.52, Math.sin(a) * (topR + 0.92));
    towerParts.push(paint(post, iron, rng, 0.05));
  }
  const rail = new THREE.TorusGeometry(topR + 0.92, 0.045, 6, 20);
  rail.rotateX(Math.PI / 2);
  rail.translate(0, deckY + 1.6, 0);
  towerParts.push(paint(rail, iron, rng, 0.05));

  // lamp room: emissive glass drum (separate mesh — LighthouseFx pulses it)
  const lampY = deckY + 0.55 + 1.0;
  const lamp = new THREE.CylinderGeometry(topR * 0.55, topR * 0.62, 1.9, 10, 1);
  lamp.translate(0, lampY, 0);
  const lampMesh = new THREE.Mesh(lamp, lighthouseLampMaterial);
  lampMesh.position.y = baseY;
  g.add(lampMesh);
  for (let i = 0; i < 4; i++) {                                  // mullions
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const mul = new THREE.BoxGeometry(0.09, 1.95, 0.09);
    mul.translate(Math.cos(a) * topR * 0.60, lampY, Math.sin(a) * topR * 0.60);
    towerParts.push(paint(mul, iron, rng, 0.05));
  }

  // roof: weathered-copper cone + finial
  const roof = new THREE.ConeGeometry(topR * 0.78, 1.8, 10);
  roof.translate(0, lampY + 0.95 + 0.9, 0);
  towerParts.push(paint(roof, new THREE.Color(0.30, 0.43, 0.38), rng, 0.07));
  const fin = new THREE.SphereGeometry(0.15, 6, 5);
  fin.translate(0, lampY + 0.95 + 1.8 + 0.12, 0);
  towerParts.push(paint(fin, iron, rng, 0.05));

  // doorway on the land side (local −X; placement aims +X at the open sea)
  const doorX = -(baseR + 1.05);
  const recess = new THREE.BoxGeometry(0.5, 2.0, 1.05);
  recess.translate(doorX + 0.15, 2.6 + 1.0, 0);
  towerParts.push(paint(recess, new THREE.Color(0.07, 0.065, 0.06), rng, 0.03));
  const lintel = stoneBox(0.75, 0.3, 1.5, rng, 2, 0.05);
  lintel.translate(doorX + 0.2, 2.6 + 2.15, 0);
  towerParts.push(ageStone(paint(lintel, new THREE.Color(0.5, 0.48, 0.45), rng, 0.06)));

  const towerGeo = mergeGeometries(towerParts.map(ni));
  towerGeo.translate(0, baseY, 0);

  // keeper's cottage, roofless, further inland — walls seat on the terrain
  const cotA = (rng() - 0.5) * 0.9;                              // bearing jitter off −X
  const cotD = baseR + 6.5 + rng() * 2.5;
  const cx = -Math.cos(cotA) * cotD, cz = Math.sin(cotA) * cotD;
  const cotYaw = cotA + (rng() - 0.5) * 0.6;
  const wallCol = stoneColor(rng).multiplyScalar(0.82);   // weathered, not whitewashed
  // moss climbs from the ground rather than tinting whole walls — a per-vertex
  // gradient keeps big faces from reading as one flat green slab
  const mossGrade = (geo) => {
    geo.computeBoundingBox();
    const y0 = geo.boundingBox.min.y;
    const pos = geo.attributes.position, col = geo.attributes.color;
    for (let i = 0; i < col.count; i++) {
      const k = Math.max(0, 1 - (pos.getY(i) - y0) / 1.4) * 0.32;
      col.setXYZ(i, col.getX(i) * (1 - k * 0.38), col.getY(i) * (1 - k * 0.04), col.getZ(i) * (1 - k * 0.45));
    }
    return geo;
  };
  const addWall = (w, h, d, lx, lz, extraYaw = 0) => {
    // rounded + subdivided so the rubble-wall edges wear soft and the sag
    // below can bend the silhouette instead of shearing flat facets
    const wall = new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.18);
    // ruin the top edge: sag the upper vertices unevenly so the wall line is
    // broken masonry, not fresh construction
    {
      const pos = wall.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > h * 0.16) {
          const t = (y / (h * 0.5) + 1) * 0.5;              // 0 at base → 1 at top
          const sag = hash3(pos.getX(i) * 2.7, pos.getZ(i) * 3.1, h) * 0.38 * h * t;
          pos.setY(i, y - sag);
        }
      }
      wall.computeVertexNormals();
    }
    weather(wall, rng, 0.09);
    wall.translate(0, h / 2, 0);
    wall.rotateY(cotYaw + extraYaw);
    const wx = cx + lx * Math.cos(cotYaw) + lz * Math.sin(cotYaw);
    const wz = cz - lx * Math.sin(cotYaw) + lz * Math.cos(cotYaw);
    wall.translate(wx, 0, wz);
    seat(wall, ground, 0.5, 0.8);
    groundParts.push(mossGrade(ageStone(paint(wall, wallCol, rng, 0.2))));
  };
  // two long walls (one mostly collapsed), two gable ends (one keeps its peak)
  addWall(5.2, 1.7 + rng() * 0.5, 0.55, 0, -1.9);
  addWall(2.1, 0.7 + rng() * 0.3, 0.55, -1.4, 1.9);              // collapsed front, door gap
  addWall(1.4, 0.8 + rng() * 0.3, 0.55, 1.8, 1.9);
  addWall(0.55, 2.9 + rng() * 0.5, 3.6, -2.6, 0);                // gable with peak remnant
  addWall(0.55, 1.2 + rng() * 0.4, 3.6, 2.6, 0);

  // rubble strewn around the base and the cottage
  const rubble = 10 + (rng() * 7 | 0);
  for (let i = 0; i < rubble; i++) {
    const a = rng() * Math.PI * 2;
    const rr = baseR + 1.8 + rng() * 7.5;
    const sz = 0.26 + rng() * 0.4;
    const rock = new THREE.IcosahedronGeometry(sz, 1);
    weather(rock, rng, 0.3);
    rock.scale(1, 0.68, 1);
    rock.rotateY(rng() * Math.PI * 2);
    rock.translate(Math.cos(a) * rr, sz * 0.5, Math.sin(a) * rr);
    seat(rock, ground, sz * 0.45, 0.9);
    groundParts.push(paint(rock, stoneColor(rng), rng, 0.1));
  }

  const mesh = new THREE.Mesh(mergeGeometries([towerGeo, ...groundParts].map(ni)), landmarkMaterial);
  mesh.castShadow = true;
  g.add(mesh);

  // anchor for the beam/glow fx — world-positioned lamp centre
  const anchor = new THREE.Object3D();
  anchor.name = 'lampAnchor';
  anchor.position.set(0, baseY + lampY, 0);
  g.add(anchor);
  g.userData.lighthouse = true;
  return g;
}

const BUILDERS = { giant: buildGiantTree, ring: buildStoneRing, cairn: buildCairn,
                   tower: buildWatchtower, lighthouse: buildLighthouse };

// --- streaming manager -------------------------------------------------------

export class LandmarkManager {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.seed = world.seed;
    this.radius = 2200;       // landmarks build out to ~2.2 km (horizon goals)
    this.majorRadius = 4200;  // majors (lighthouse) reach further — they're the draw
    this.active = new Map();  // key -> Group
    this._list = [];
    this._mlist = [];
    this._px = 1e9;
    this._pz = 1e9;
  }

  update(px, pz) {
    const dx = px - this._px, dz = pz - this._pz;
    if (dx * dx + dz * dz < 60 * 60) return; // rescan only when the player moves
    this._px = px; this._pz = pz;

    landmarksAround(this.world, px, pz, this.seed, this.radius, this._list);
    majorLandmarksAround(this.world, px, pz, this.seed, this.majorRadius, this._mlist);
    const want = new Set();
    for (const list of [this._list, this._mlist]) {
      for (const lm of list) {
        want.add(lm.key);
        if (!this.active.has(lm.key)) this._build(lm);
      }
    }
    for (const [key, obj] of this.active) {
      if (!want.has(key)) { this.scene.remove(obj); this._dispose(obj); this.active.delete(key); }
    }
  }

  _build(lm) {
    const fn = BUILDERS[lm.type];
    if (!fn) return;
    // local terrain height under an element offset (lx, lz) from the base —
    // yaw-aware, so parts seat against the terrain where they actually render
    // after the group's rotation (rotation.y maps local (x,z) → (x·c+z·s, −x·s+z·c))
    const c = Math.cos(lm.yaw), s = Math.sin(lm.yaw);
    const ground = (lx, lz) =>
      this.world.height(lm.x + lx * c + lz * s, lm.z - lx * s + lz * c) - lm.y;
    const g = fn(lm.seed, ground, lm);
    g.position.set(lm.x, lm.y, lm.z);
    g.rotation.y = lm.yaw;
    this.scene.add(g);
    this.active.set(lm.key, g);
  }

  // active lighthouse groups (for LighthouseFx) — cheap scan over a tiny map
  eachLighthouse(fn) {
    for (const obj of this.active.values()) {
      if (obj.userData.lighthouse) fn(obj);
    }
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
