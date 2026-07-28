// The painted shading model, as an injectable GLSL chunk.
//
// Wander shades physically and then grades the result toward paint in post.js.
// That works on value but not on form: a screen-space posterize groups luma
// ACROSS shapes, because by then the shader no longer knows which pixels belong
// to the same surface. This does the grouping where the normal, the pigment and
// the distance are still in hand, so the bands land on forms instead of over
// them.
//
// The ramp is three tones — shade / mid / lit — with a world-space wobble on
// the band edges. The wobble is the whole trick: a hard smoothstep edge reads
// as a toon shader, the same edge jittered by low-frequency noise reads as a
// brush.
//
// THREE-free string module: it is injected via onBeforeCompile, so it must not
// import the renderer.

import { MEADOW, PAINT, luminance, paletteGlsl } from './palette.mjs';

// Cheap value noise. Two hashes per call, which is what a +/-5% wobble on a
// band edge is worth — anything more expensive belongs in a texture.
const HASH_GLSL = /* glsl */`
float pnHash(vec2 p){
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float pnValue(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = pnHash(i), b = pnHash(i + vec2(1.0, 0.0));
  float c = pnHash(i + vec2(0.0, 1.0)), d = pnHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const RAMP_GLSL = /* glsl */`
// Three-colour ramp. Transitions are soft but visibly banded; jit moves both
// edges together so a band never pinches shut.
vec3 ramp3(float t, vec3 shade, vec3 mid, vec3 lit, float soft, float jit){
  float a = smoothstep(K_BAND_LOW  - soft + jit, K_BAND_LOW  + soft + jit, t);
  float b = smoothstep(K_BAND_HIGH - soft + jit, K_BAND_HIGH + soft + jit, t);
  return mix(mix(shade, mid, a), lit, b);
}

// Derive a shade/mid/lit triple from one authored pigment.
//
// The pen this is modelled on hand-authors all three per material, which it can
// afford with a fixed palette and one hour of the day. Wander's ground colour
// is biome-driven and continuous, so the triple is walked out of the base along
// a hue path instead: down toward the shadow pigment, up toward sun warmth.
// Biome chroma survives; the painted structure is added on top of it.
void pigments(vec3 base, vec3 shadowPigment, out vec3 shd, out vec3 mid, out vec3 lit){
  float l = max(dot(base, K_LUMA), 1e-4);

  // midtone: the base with a touch more chroma, so the middle band is not the
  // washed-out average of the two it sits between
  mid = clamp(mix(vec3(l), base, K_MID_SAT), 0.0, 1.0);

  // shade: darkened, then walked toward the shadow pigment at matched value so
  // the hue shifts without the tone collapsing to grey
  vec3 s = base * K_SHADE_MUL;
  vec3 sTint = shadowPigment * (l * K_SHADE_MUL / max(dot(shadowPigment, K_LUMA), 1e-3));
  shd = clamp(mix(s, sTint, K_SHADE_HUE), 0.0, 1.0);

  // lit: brightened and warmed, but never all the way to white — a blown
  // highlight is the one thing that reads as CG rather than as pigment
  vec3 t = base * K_LIT_MUL;
  vec3 tTint = K_SUN_WARM * (l * K_LIT_MUL / max(dot(K_SUN_WARM, K_LUMA), 1e-3));
  lit = clamp(mix(t, tTint, K_LIT_HUE), 0.0, 1.2);
}

// Vary a ground pigment with the field the grass was planted from.
//
// Returns a per-channel MULTIPLIER near 1.0, not a varied pigment. That is
// forced by how the ramp is applied: the transfer is painted/mid, and both
// sides derive from the base — so folding the variation into the base would
// divide straight back out and the mosaic would be invisible. As a separate
// multiplier it survives, and it stays orthogonal to the banding.
//
// The grassy term gates the whole thing on the pigment actually being green,
// so sand, chalk, scree and snow never acquire a meadow mosaic.
vec3 meadowTint(vec3 base, float dryness, float grassy){
  float l = max(dot(base, K_LUMA), 1e-4);
  vec3 lush = K_MEADOW_LUSH * (l / max(dot(K_MEADOW_LUSH, K_LUMA), 1e-3));
  vec3 dry  = K_MEADOW_DRY  * (l / max(dot(K_MEADOW_DRY,  K_LUMA), 1e-3));
  vec3 varied = mix(base, mix(lush, dry, clamp(dryness, 0.0, 1.0)),
                    clamp(grassy, 0.0, 1.0) * K_MEADOW_AMT);
  return varied / max(base, vec3(0.02));
}

struct Surf {
  vec3 N;                     // world normal
  vec3 V;                     // surface -> eye
  vec3 shade; vec3 mid; vec3 lit;
  float soft;                 // band softness
  float jit;                  // painterly wobble of the band edges
  float shadow;               // 0 shadowed .. 1 lit
  float rim;                  // backlight strength
  float ao;                   // baked curvature / cavity
};

vec3 paintSurface(Surf s, vec3 sunDir){
  float ndl = dot(s.N, sunDir);
  // Half-lambert. A low sun grazes flat ground at ndl ~ 0.2; plain Lambert
  // would drop the whole valley floor into the shade band and golden hour would
  // read as dusk.
  float wrap = clamp(ndl * K_WRAP_SCALE + K_WRAP_BIAS, 0.0, 1.0);
  float t = wrap * mix(K_SHADOW_FLOOR, 1.0, s.shadow);

  vec3 col = ramp3(t, s.shade, s.mid, s.lit, s.soft, s.jit);

  // Hemispheric ambient TINTS rather than washes: normalised to unit luminance
  // so it can rotate hue (cool from the sky, warm from the ground bounce)
  // without ever bleaching the pigment.
  float litAmt = smoothstep(K_BAND_LOW, K_BAND_HIGH + 0.28, t);
  vec3 hemi = mix(K_AMB_GND, K_AMB_SKY, s.N.y * 0.5 + 0.5);
  vec3 hueOnly = hemi / max(dot(hemi, K_LUMA), 1e-3);
  col *= mix(vec3(1.0), hueOnly, 0.22 * (1.0 - litAmt * 0.55));

  // backlight rim — the connective tissue of the whole image
  float back = smoothstep(0.05, 0.85, dot(s.V, -sunDir));
  float fres = pow(1.0 - clamp(dot(s.N, s.V), 0.0, 1.0), 4.2);
  col += K_SUN_WARM * (fres * back * s.rim * s.shadow);

  return col * s.ao;
}
`;

// The full chunk: palette constants, noise, ramp and paintSurface(). Injected
// once per material that paints.
export const PAINTERLY_GLSL = paletteGlsl() + HASH_GLSL + RAMP_GLSL;

// Band softness widens with distance so far hills go flat and near ground keeps
// a crisp edge — the same reason a background matte is painted with fewer
// strokes than a foreground cel.
export function bandSoftness(distance, paint) {
  const t = Math.min(Math.max(distance * 0.004, 0), 1);
  return paint.softNear + (paint.softFar - paint.softNear) * t;
}

// A JS mirror of the GLSL pigments() above, so the derivation can be checked
// without a GPU. It exists because the first version of this shipped a shade
// tone that gained more blue chroma than the base pigment ever had — which no
// unit test could see, and which only showed up as a neon-blue dusk landscape
// in the preview. Any change to the GLSL must be made here too; the test
// asserts the properties both versions have to hold, not their exact output.
export function derivePigments(base, shadowPigment, sunWarm, paint = PAINT) {
  const l = Math.max(luminance(base), 1e-4);
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  const mix = (a, b, t) => a + (b - a) * t;

  const mid = base.map((c) => clamp01(mix(l, c, paint.midSat)));

  const shadowLuma = Math.max(luminance(shadowPigment), 1e-3);
  const shade = base.map((c, i) => clamp01(mix(
    c * paint.shadeMul,
    shadowPigment[i] * (l * paint.shadeMul / shadowLuma),
    paint.shadeHue,
  )));

  const warmLuma = Math.max(luminance(sunWarm), 1e-3);
  const lit = base.map((c, i) => Math.min(mix(
    c * paint.litMul,
    sunWarm[i] * (l * paint.litMul / warmLuma),
    paint.litHue,
  ), 1.2));

  return { shade, mid, lit };
}

// A JS mirror of the GLSL meadowTint() above, for the same reason as
// derivePigments: the multiplier it returns is the thing that can quietly
// recolour the ground, and it needs to be checkable without a GPU.
export function meadowTint(base, dryness, grassy, meadow = MEADOW) {
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  const mix = (a, b, t) => a + (b - a) * t;
  const l = Math.max(luminance(base), 1e-4);

  const lushScale = l / Math.max(luminance(meadow.lush), 1e-3);
  const dryScale = l / Math.max(luminance(meadow.dry), 1e-3);
  const d = clamp01(dryness);
  const g = clamp01(grassy);

  return base.map((c, i) => {
    const target = mix(meadow.lush[i] * lushScale, meadow.dry[i] * dryScale, d);
    return mix(c, target, g * meadow.amount) / Math.max(c, 0.02);
  });
}

// Chroma as the largest per-channel deviation from a colour's own luminance,
// normalised. The measure the shade tone has to stay bounded by.
export function chromaSpread(rgb) {
  const l = Math.max(luminance(rgb), 1e-4);
  return Math.max(...rgb.map((c) => Math.abs(c - l))) / l;
}
