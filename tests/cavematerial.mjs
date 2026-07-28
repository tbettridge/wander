import assert from 'node:assert/strict';
import {
  CAVE_INTERIOR_MIN_LUMINANCE,
  CAVE_MATERIAL_PALETTES,
  caveInteriorLuminanceFloor,
  caveMaterialPalette,
  cavePaletteSignature,
} from '../src/cavematerial.mjs';

const geologies = ['limestone', 'cathedral', 'boulder', 'grotto', 'fracture', 'ice', 'volcanic'];
assert.deepEqual(Object.keys(CAVE_MATERIAL_PALETTES).sort(), [...geologies].sort());

const luminance = (rgb) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
const signatures = new Set();
for (const geology of geologies) {
  const palette = caveMaterialPalette(geology);
  for (const key of ['dark', 'mid', 'light', 'sediment', 'mineral', 'wet']) {
    assert.equal(palette[key].length, 3, `${geology}.${key} is RGB`);
    assert.ok(palette[key].every((value) => value >= 0 && value <= 1), `${geology}.${key} in gamut`);
  }
  assert.ok(luminance(palette.dark) < luminance(palette.mid), `${geology} dark < mid`);
  assert.ok(luminance(palette.mid) < luminance(palette.light), `${geology} mid < light`);
  signatures.add(cavePaletteSignature(geology));
}
assert.equal(signatures.size, geologies.length, 'every geology has a distinct palette');
assert.equal(caveMaterialPalette('unknown'), CAVE_MATERIAL_PALETTES.limestone);
assert.ok(luminance(caveMaterialPalette('ice').light) > luminance(caveMaterialPalette('volcanic').light));
assert.ok(caveMaterialPalette('boulder').fractureStrength > caveMaterialPalette('grotto').fractureStrength);
assert.equal(caveInteriorLuminanceFloor(0), 0, 'surface entrance retains true darkness');
assert.equal(caveInteriorLuminanceFloor(1), CAVE_INTERIOR_MIN_LUMINANCE, 'interior reaches the absolute floor');
assert.ok(caveInteriorLuminanceFloor(0.7) > 0, 'threshold transition is continuous');
assert.ok(CAVE_INTERIOR_MIN_LUMINANCE >= 0.005 && CAVE_INTERIOR_MIN_LUMINANCE <= 0.012,
  'interior floor should prevent broken black facets without revealing the route');

console.log(`cavematerial PASS · ${geologies.length} distinct geology palettes`);
