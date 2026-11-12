// Brook water and brook bed — the render side of forestbrooks.mjs.
//
// A brook is not a band laid on the ground. Its water wanders from one bank
// to the other and is never the same width twice; around it lies a bed of
// wet stones and gravel that spreads into a little beach on one side and
// shrinks to nothing on the other, then gives way to mud and moss. Two
// layers draw it:
//
//   the bed    lit like the ground (shadows, fog, the painterly air), hugging
//              the banks: dark stones under the water, wet pebbles and grit at
//              the margin, mud and moss further out, a ragged outer edge.
//   the water  clear and quick over it: a tint, the sky glancing off it,
//              ripples running downstream, white water over the drops.
//
// Both read the same shape (BROOK_SHAPE_GLSL) from the ribbon's aBrook =
// (u metres across from the centre line, v metres along, hw the brook's half
// width there). The ribbons are built in the worker (chunkgen.buildBrooks).

import * as THREE from 'three';
import { waterUniforms, WATER_COMMON_GLSL } from './watercommon.js';
import { injectAtmosphere } from './atmosphere.js';

// brookShape(u, v, hw) → x: metres outside the water's edge (negative in the
// water), y: 0 at the water's edge to 1 at the bed's outer edge, z: 1 beyond
// the bed. Each side has its own edges, and the water drifts within the bed.
const BROOK_SHAPE_GLSL = /* glsl */`
float bkH(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float bkN(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bkH(i), bkH(i + vec2(1.0, 0.0)), f.x), mix(bkH(i + vec2(0.0, 1.0)), bkH(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 brookShape(float u, float v, float hw) {
  float shift = (bkN(vec2(v * 0.08, 1.7)) - 0.5) * hw * 0.6;
  float d = u - shift;
  float s = step(0.0, d);
  float ad = abs(d);
  // Riffle and pool: every so often the water spreads into a slack reach,
  // then draws in again to a quick narrow one. (All of it stays inside the
  // ribbon: 0.3 + 0.56 + 0.5 + 0.3 = 1.66 half-widths at the very most.)
  float slack = smoothstep(0.55, 0.9, bkN(vec2(v * 0.043, 11.0)));
  float wEdge = hw * (0.56 + 0.5 * bkN(vec2(v * 0.21, 4.0 + s * 9.0)) + 0.3 * slack)
    + (bkN(vec2(v * 1.3, 20.0 + s * 5.0)) - 0.5) * 0.14;
  // the bed: a gravel beach in places, elsewhere nothing at all, the moss
  // and grass running straight down to the water; its edge ragged
  float outer = wEdge + max(0.04, -0.35 + 1.9 * bkN(vec2(v * 0.11, 30.0 + s * 7.0)))
    + (bkN(vec2(v * 1.9 + u * 0.7, 50.0 + s * 3.0)) - 0.5) * 0.5
    + (bkN(vec2(v * 5.3 + u * 2.1, 70.0 + s)) - 0.5) * 0.18;
  return vec3(ad - wEdge, clamp((ad - wEdge) / max(outer - wEdge, 0.01), 0.0, 1.0), ad > outer ? 1.0 : 0.0);
}
`;

// ---------------------------------------------------------------------------
// The water

const WATER_VERT = /* glsl */`
attribute vec3 aBrook;
attribute vec2 aFlow;
varying vec3 vWP;
varying vec3 vBrook;
varying vec2 vFlow;
void main() {
  vWP = position;              // authored in world space
  vBrook = aBrook;
  vFlow = aFlow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WATER_FRAG = WATER_COMMON_GLSL + BROOK_SHAPE_GLSL + /* glsl */`
varying vec3 vWP;
varying vec3 vBrook;
varying vec2 vFlow;

void main() {
  vec3 shape = brookShape(vBrook.x, vBrook.y, vBrook.z);
  if (shape.x > 0.02) discard;
  float edge = smoothstep(0.02, -0.22, shape.x);
  float slope = vFlow.x, foamAmt = max(0.0, vFlow.y);
  float receiving = max(0.0, -vFlow.y);
  float speed = 0.5 + slope * 6.0;
  float t = uTime;
  // How deep the water stands here: nothing at its edge, the brook's full
  // (small) depth in the middle of the thread.
  float inside = max(0.0, -shape.x);
  float depth = smoothstep(0.0, max(0.35, vBrook.z * 0.85), inside);
  // Long threads of current drawn out down the stream, bent a little by a
  // slower swirl so no lattice shows, and a finer chatter over the quick runs.
  vec2 q = vec2(vBrook.x, vBrook.y);
  float swirl = wcNoise(q * vec2(0.9, 0.23) + vec2(3.7, -t * 0.05));
  float threads = wcFbm(vec2(q.x * 1.5 + swirl * 1.3, q.y * 0.3 - t * speed * 0.3));
  float chatter = wcNoise(vec2(q.x * 3.4 - swirl, q.y * 1.1 - t * speed * 0.8));
  float lively = clamp(0.25 + slope * 5.0, 0.0, 1.0);
  float h0 = threads * 0.7 + chatter * 0.3 * lively;
  // Derivatives transform the ribbon's across/along ripples into its actual
  // world direction; a turning creek must not keep an axis-aligned normal.
  vec3 surface = vWP + vec3(0.0, h0 * mix(0.018, 0.05, lively), 0.0);
  vec3 N = normalize(cross(dFdx(surface), dFdy(surface)));
  if (N.y < 0.0) N = -N;

  vec3 V = normalize(cameraPosition - vWP);
  float dl = wcDayLight();
  // The same fresh water as the river it feeds, only shallower: clear over
  // the stones at its margins, taking the river's green in its deeper thread.
  vec3 tint = wcFreshPalette(0.12 + depth * 0.75, 0.1);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
  vec3 sky = wcSkyReflect(N, V);
  vec3 col = mix(tint, sky * 0.8, clamp(fres * 0.7, 0.0, 0.7));
  col += wcGlint(N, V) * 0.22;
  col += uSunColor * wcCaustics(vWP.xz, t, 0.25) * edge * (1.0 - depth * 0.6) * 0.1;
  // soft lights riding the threads of current: what makes a brook read as moving
  float crest = smoothstep(0.62, 0.9, h0) * edge * lively;
  col += sky * crest * 0.1;
  // shallower, so clearer, toward its edges
  float alpha = edge * mix(0.3, 0.8, depth) + fres * 0.12 * edge + 0.1 * crest;

  // white water over the drops, streaked down the flow
  float streak = wcNoise(vec2(vBrook.x * 4.0, vBrook.y * 1.6 - t * speed * 1.4));
  float foam = foamAmt * smoothstep(0.45, 0.78, streak + foamAmt * 0.25) * edge;
  col = mix(col, vec3(0.82, 0.86, 0.86) * dl, clamp(foam, 0.0, 0.75));
  alpha = max(alpha, foam * 0.85);
  alpha *= 1.0 - receiving;

  float dist = length(cameraPosition - vWP);
  gl_FragColor = vec4(wcApplyAir(col, vWP, dist), clamp(alpha, 0.0, 0.95));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const brookMaterial = new THREE.ShaderMaterial({
  vertexShader: WATER_VERT,
  fragmentShader: WATER_FRAG,
  uniforms: { ...waterUniforms },
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -2,
});
brookMaterial.userData.excludeFromAO = true;
brookMaterial.userData.waterSurface = true;

// ---------------------------------------------------------------------------
// The bed: lit like the ground, so the shadows of the trees fall across it

// The same physically based material as the ground (and so the same sky and
// environment light): a Lambert bed beside a standard-material terrain came
// out nearly black, missing the light the ground around it gets.
export const brookBedMaterial = new THREE.MeshStandardMaterial({
  // single-sided and wound to face up (chunkgen.buildBrooks): drawn double-
  // sided, a downward face takes its normal flipped and lies unlit
  color: 0xffffff, roughness: 1, metalness: 0, transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
brookBedMaterial.name = 'brook-bed';
brookBedMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = 'attribute vec3 aBrook;\nvarying vec3 vBrook;\n' + shader.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBrook = aBrook;');
  shader.fragmentShader = 'varying vec3 vBrook;\n' + BROOK_SHAPE_GLSL + shader.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 shape = brookShape(vBrook.x, vBrook.y, vBrook.z);
    if (shape.z > 0.5) discard;
    vec2 p = vec2(vBrook.x, vBrook.y);
    // stones: at most one per cell of a jittered grid, most cells empty, each
    // its own size, a little long in the line of the flow, the cells
    // themselves warped so no grid shows
    vec2 sp = p * vec2(2.6, 2.1) + vec2(bkN(p * 0.7) * 1.7, bkN(p * 0.7 + 9.0) * 1.7);
    vec2 cell = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float r = bkH(cell);
    vec2 o = vec2(bkH(cell + 3.1), bkH(cell + 7.7)) - 0.5;
    vec2 q2 = (f - o * 0.55) * vec2(1.0, 0.75 + r * 0.4);
    float size = 0.07 + r * 0.17;
    float stone = (1.0 - smoothstep(size, size + 0.06, length(q2))) * step(0.52, r);
    // rounded: lit on the crown, dark where it meets the bed
    float crown = 1.0 - clamp(length(q2) / (size + 0.06), 0.0, 1.0);
    float grain = bkN(p * 9.0);
    // under the water: dark wet stones; at the margin: wet grit and pebbles,
    // grading out through mud to moss
    vec3 under = mix(vec3(0.1, 0.095, 0.07), vec3(0.17, 0.165, 0.13) * (0.7 + 0.5 * r) * (0.55 + 0.7 * crown), stone);
    vec3 grit = mix(vec3(0.2, 0.18, 0.13), vec3(0.27, 0.26, 0.22) * (0.75 + 0.4 * r),
      stone * (1.0 - smoothstep(0.25, 0.6, shape.y)) * (0.55 + 0.45 * grain));
    vec3 mud = vec3(0.17, 0.145, 0.095);
    vec3 moss = vec3(0.15, 0.22, 0.085);
    vec3 bank = mix(grit, mud, smoothstep(0.35, 0.75, shape.y + (grain - 0.5) * 0.3));
    bank = mix(bank, moss, smoothstep(0.65, 1.0, shape.y + (grain - 0.5) * 0.25));
    // wet and dark right at the water's edge
    bank *= mix(0.6, 1.0, smoothstep(0.0, 0.35, shape.y + (grain - 0.5) * 0.15));
    vec3 bed = shape.x < 0.0 ? under : bank;
    diffuseColor.rgb = bed * (0.9 + 0.2 * grain);
    diffuseColor.a = 1.0 - smoothstep(0.6, 1.0, shape.y + (grain - 0.5) * 0.3);
  }`);
};
injectAtmosphere(brookBedMaterial);
brookBedMaterial.userData.excludeFromAO = true;

function ribbonGeometry(data, flow = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('aBrook', new THREE.BufferAttribute(data.brook, 3));
  const normals = new Float32Array(data.positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (flow) geometry.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A chunk's brooks: the bed and the water over it, from the worker's arrays. */
export function buildBrookGroup(brooks) {
  const group = new THREE.Group();
  group.name = 'brooks';
  if (brooks.bed) {
    const bed = new THREE.Mesh(ribbonGeometry(brooks.bed), brookBedMaterial);
    bed.name = 'brook-bed';
    bed.renderOrder = 1;
    bed.receiveShadow = true;
    bed.castShadow = false;
    bed.userData.reflectionRange = 0;
    group.add(bed);
  }
  if (brooks.ribbon) {
    const water = new THREE.Mesh(ribbonGeometry(brooks.ribbon, brooks.ribbon.flow), brookMaterial);
    water.name = 'brook-water';
    water.renderOrder = 2;
    water.castShadow = false;
    water.receiveShadow = false;
    water.userData.reflectionRange = 0;
    group.add(water);
  }
  return group;
}
