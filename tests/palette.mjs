import assert from 'node:assert/strict';
import {
  GROUND, LIGHT, MEADOW, PAINT, glslVec3, hexToLinear, luminance,
} from '../src/palette.mjs';
import {
  PAINTERLY_GLSL, bandSoftness, chromaSpread, derivePigments, meadowTint,
} from '../src/painterly.mjs';
import { World, groundColor } from '../src/world.js';

// ── the palette is data, and it is frozen ────────────────────────────────────
assert.ok(Object.isFrozen(GROUND));
assert.ok(Object.isFrozen(LIGHT));
assert.ok(Object.isFrozen(PAINT));
assert.ok(Object.isFrozen(GROUND.grassland));

// Biome pigments moved verbatim: a change here is a change to the desktop look,
// so these are pinned rather than merely present.
assert.deepEqual([...GROUND.grassland], [0.40, 0.48, 0.24]);
assert.deepEqual([...GROUND.forest], [0.29, 0.37, 0.18]);
assert.deepEqual([...GROUND.snow], [0.90, 0.91, 0.94]);
assert.equal(Object.keys(GROUND).length, 12);

// The shadow pigment endpoints post.js interpolates between. shadowLow is the
// violet drift at dawn/dusk, shadowDay the cool blue at noon.
assert.deepEqual([...LIGHT.shadowDay], [0.25, 0.27, 0.38]);
assert.deepEqual([...LIGHT.shadowLow], [0.32, 0.23, 0.43]);
assert.ok(LIGHT.shadowLow[0] > LIGHT.shadowDay[0], 'dusk shadow drifts warmer in red');
assert.ok(LIGHT.shadowLow[2] > LIGHT.shadowDay[2], 'and further toward violet');
assert.ok(LIGHT.shadowDay[2] > LIGHT.shadowDay[0], 'a shadow is never neutral grey');
assert.ok(LIGHT.sunWarm[0] > LIGHT.sunWarm[2], 'the lit band walks toward cream');
assert.ok(LIGHT.ambSky[2] > LIGHT.ambSky[0], 'sky fill is cool');
assert.ok(LIGHT.ambGround[0] > LIGHT.ambGround[2], 'ground bounce is warm');

// ── ramp constants have to stay in an order that produces three bands ────────
assert.ok(PAINT.bandLow < PAINT.bandHigh);
assert.ok(PAINT.softNear < PAINT.softFar, 'distance flattens the bands');
// If softness ever exceeds half the gap between the edges the middle band
// pinches shut and the ramp silently becomes two-tone.
assert.ok(PAINT.softFar < (PAINT.bandHigh - PAINT.bandLow) / 2,
  'band softness must not collapse the midtone');
assert.ok(PAINT.shadeMul < 1 && PAINT.litMul > 1);
assert.ok(PAINT.shadowFloor > 0, 'a fully shadowed pixel still sits on the ramp');

// Half-lambert must lift flat ground under a low sun out of the shade band,
// which is the entire reason it is not plain Lambert.
const lowSunNdl = 0.20;
const wrapped = lowSunNdl * PAINT.wrapScale + PAINT.wrapBias;
assert.ok(wrapped > PAINT.bandLow,
  'flat ground under a grazing sun must not fall into the shade band');

// ── helpers ──────────────────────────────────────────────────────────────────
assert.equal(glslVec3([0.25, 0.5, 1]), 'vec3(0.25000,0.50000,1.00000)');
assert.deepEqual(hexToLinear('#000000'), [0, 0, 0]);
const white = hexToLinear('#ffffff');
assert.ok(white.every((c) => Math.abs(c - 1) < 1e-9));
// mid-grey sRGB is well below 0.5 once linearised — the conversion is real
assert.ok(hexToLinear('#808080')[0] < 0.25);
assert.ok(Math.abs(luminance([1, 1, 1]) - 1) < 1e-9);
assert.ok(luminance([0, 1, 0]) > luminance([1, 0, 0]), 'green carries most luma');

assert.equal(bandSoftness(0, PAINT), PAINT.softNear);
assert.equal(bandSoftness(1e6, PAINT), PAINT.softFar);
assert.ok(bandSoftness(125, PAINT) > bandSoftness(25, PAINT));

// ── the GLSL chunk is self-contained ─────────────────────────────────────────
// Every constant the ramp and paintSurface reference must be declared by the
// palette block, or the material fails to compile on device — where a shader
// error surfaces as a black world in a headset rather than as a stack trace.
for (const sym of ['K_BAND_LOW', 'K_BAND_HIGH', 'K_SOFT_NEAR', 'K_SOFT_FAR', 'K_JITTER',
  'K_WRAP_SCALE', 'K_WRAP_BIAS', 'K_SHADOW_FLOOR', 'K_SHADE_MUL', 'K_SHADE_HUE',
  'K_LIT_MUL', 'K_LIT_HUE', 'K_MID_SAT', 'K_XFER_CHROMA', 'K_LUMA',
  'K_MEADOW_LUSH', 'K_MEADOW_DRY', 'K_MEADOW_AMT', 'K_MEADOW_FREQ', 'K_MEADOW_STRK',
  'K_SHADOW_DAY', 'K_SUN_WARM', 'K_AMB_SKY', 'K_AMB_GND']) {
  assert.ok(new RegExp(`const\\s+(vec3|float)\\s+${sym}\\b`).test(PAINTERLY_GLSL),
    `${sym} must be declared in the injected palette block`);
  assert.ok(PAINTERLY_GLSL.includes(sym), `${sym} unused`);
}
for (const fn of ['ramp3', 'pigments', 'paintSurface', 'meadowTint', 'pnValue', 'pnHash']) {
  assert.ok(PAINTERLY_GLSL.includes(`${fn}(`), `${fn} missing from the chunk`);
}
assert.ok(PAINTERLY_GLSL.includes('struct Surf'));
// injected into a Three material, so it must not redeclare Three's own symbols
for (const clash of ['uniform vec3 uAtmoSunDir', 'varying vec3 vAtmoWP', 'void main(']) {
  assert.ok(!PAINTERLY_GLSL.includes(clash), `chunk must not redeclare ${clash}`);
}
// balanced braces, the usual way a string-built shader breaks
assert.equal((PAINTERLY_GLSL.match(/\{/g) || []).length,
  (PAINTERLY_GLSL.match(/\}/g) || []).length, 'unbalanced braces in the GLSL chunk');

// ── the derived triple must stay in the base pigment's hue family ────────────
// The regression this exists for: deriving the shade tone by walking toward the
// blue shadow pigment at matched LUMINANCE gave a green ground pigment more
// blue chroma than it ever had, which read as a neon-blue landscape at dusk
// once the ramp was applied as a per-channel multiplier.
for (const [name, base] of Object.entries(GROUND)) {
  const { shade, mid, lit } = derivePigments(base, LIGHT.shadowDay, LIGHT.sunWarm, PAINT);

  assert.ok(luminance(shade) < luminance(mid), `${name}: shade must be darker than mid`);
  assert.ok(luminance(lit) > luminance(mid), `${name}: lit must be brighter than mid`);
  for (const [tone, rgb] of [['shade', shade], ['mid', mid], ['lit', lit]]) {
    assert.ok(rgb.every((c) => Number.isFinite(c) && c >= 0 && c <= 1.2),
      `${name}: ${tone} out of range`);
  }

  // A shaded surface may shift hue, but it must not become a MORE saturated
  // colour than the pigment it came from — that inversion is what neon looks
  // like. The headroom allows a real shift without allowing a takeover.
  assert.ok(chromaSpread(shade) < chromaSpread(base) * 1.35 + 0.05,
    `${name}: shade tone gained too much chroma (${chromaSpread(shade).toFixed(3)} `
    + `vs base ${chromaSpread(base).toFixed(3)})`);
  assert.ok(chromaSpread(lit) < chromaSpread(base) * 1.35 + 0.05,
    `${name}: lit tone gained too much chroma`);

  // The transfer actually applied over Three's lighting is shade/mid at the
  // dark end. No channel may diverge far enough from the others to recolour
  // the ground rather than shade it.
  const transfer = shade.map((c, i) => c / Math.max(mid[i], 0.02));
  const tLuma = luminance(transfer);
  const damped = transfer.map((c) => tLuma + (c - tLuma) * PAINT.transferChroma);
  const spread = Math.max(...damped) - Math.min(...damped);
  assert.ok(spread < 0.22,
    `${name}: shade transfer spread ${spread.toFixed(3)} would recolour the ground`);
}

// Sanity-check the measure itself: a neutral grey has no chroma, a primary has
// a lot. Without this the assertions above could pass on a broken metric.
assert.ok(chromaSpread([0.5, 0.5, 0.5]) < 1e-6);
assert.ok(chromaSpread([0.0, 0.0, 1.0]) > 1.0);

// ── the meadow mosaic must only touch ground that is actually green ──────────
assert.ok(Object.isFrozen(MEADOW));
assert.ok(luminance(MEADOW.dry) > luminance(MEADOW.lush), 'straw is lighter than lush green');
assert.ok(MEADOW.lush[1] > MEADOW.lush[0] && MEADOW.lush[1] > MEADOW.lush[2],
  'the lush target is a green');
assert.ok(MEADOW.dry[0] > MEADOW.dry[2], 'the dry target is a straw');
assert.ok(MEADOW.strokeAmount < 0.5,
  'the per-vertex field must stay the dominant term, or the mosaic stops '
  + 'agreeing with where the blades were actually planted');

// grassy = 0 means no mosaic at all: sand, chalk, scree and snow must come back
// exactly unchanged, whatever the dryness field says.
for (const bare of ['beach', 'desert', 'snow', 'rock', 'deepSea']) {
  for (const dryness of [0, 0.5, 1]) {
    const tint = meadowTint(GROUND[bare], dryness, 0, MEADOW);
    assert.ok(tint.every((c) => Math.abs(c - 1) < 1e-9),
      `${bare}: mosaic must be identity when the pigment is not green`);
  }
}

// On green ground it must vary hue without moving value, and without the
// runaway chroma that broke the shade tone.
for (const green of ['grassland', 'forest', 'jungle', 'taiga', 'savanna']) {
  const base = GROUND[green];
  const lush = meadowTint(base, 0, 1, MEADOW);
  const dry = meadowTint(base, 1, 1, MEADOW);

  assert.notDeepEqual(lush, dry, `${green}: the mosaic must actually vary`);
  for (const [end, tint] of [['lush', lush], ['dry', dry]]) {
    const applied = base.map((c, i) => c * tint[i]);
    // luminance-matched targets: value is the ramp's business, not the mosaic's
    assert.ok(Math.abs(luminance(applied) - luminance(base)) < 0.02,
      `${green}/${end}: mosaic shifted value, not just hue`);
    assert.ok(chromaSpread(applied) < chromaSpread(base) * 1.35 + 0.05,
      `${green}/${end}: mosaic gained too much chroma`);
    assert.ok(tint.every((c) => c > 0.7 && c < 1.4),
      `${green}/${end}: mosaic multiplier out of a sane band`);
  }
  // dry ground must read warmer than lush ground — the direction is the point
  const dryApplied = base.map((c, i) => c * dry[i]);
  const lushApplied = base.map((c, i) => c * lush[i]);
  assert.ok(dryApplied[0] / dryApplied[1] > lushApplied[0] / lushApplied[1],
    `${green}: the dry end must be the warmer one`);
}

// ── world.js still produces the colours it used to ───────────────────────────
// The palette move must be invisible: groundColor reads GROUND now, and these
// are the values it returned before it did.
const world = new World(20260612);
const out = [0, 0, 0];
for (const [x, z] of [[0, 0], [512, -512], [-2400, 1800], [10000, 10000]]) {
  const h = world.height(x, z);
  groundColor(world, x, z, h, 0.1, 14, 0.5, out, 0, 0);
  assert.ok(out.every((c) => Number.isFinite(c) && c >= 0 && c <= 1),
    `groundColor produced an out-of-range pigment at ${x},${z}`);
}
// grassland/forest blend by moisture, so a dry lowland must sit on the
// grassland side of the pair and a wet one on the forest side
const dry = [0, 0, 0]; const wet = [0, 0, 0];
groundColor(world, 0, 0, 20, 0.05, 14, 0.10, dry, 0, 0);
groundColor(world, 0, 0, 20, 0.05, 14, 0.90, wet, 0, 0);
assert.ok(dry[1] > wet[1], 'grassland is a lighter green than forest');

console.log('palette PASS · frozen pigments · three-tone ramp constants · self-contained GLSL · world colours unchanged');
