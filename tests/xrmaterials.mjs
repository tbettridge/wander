import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyXRMaterialVariants,
  materialVariantFor,
  registerXRMaterialVariant,
  setXRMaterialVariants,
  xrMaterialVariantDebug,
} from '../src/xrmaterialvariants.mjs';

const desktop = { name: 'desktop' };
const xr = { name: 'xr' };
registerXRMaterialVariant(desktop, xr);
setXRMaterialVariants(true);
assert.equal(materialVariantFor(desktop), xr);
setXRMaterialVariants(false);
assert.equal(materialVariantFor(xr), desktop);

const single = { material: desktop };
const multi = { material: [desktop, { name: 'unmapped' }] };
const root = { traverse(visitor) { visitor(single); visitor(multi); } };
setXRMaterialVariants(true);
assert.equal(applyXRMaterialVariants(root), 2);
assert.equal(single.material, xr);
assert.equal(multi.material[0], xr);
assert.ok(xrMaterialVariantDebug.routedAssignments >= 2);
setXRMaterialVariants(false);
assert.equal(applyXRMaterialVariants(root), 2);
assert.equal(single.material, desktop);
assert.equal(multi.material[0], desktop);
assert.ok(xrMaterialVariantDebug.registered >= 1);

const [vegetation, trail, terrain, main] = await Promise.all([
  readFile(new URL('../src/vegetation.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/trailsurface.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/xrterrain.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.match(vegetation, /xrVegMaterial = new THREE\.MeshLambertMaterial/);
assert.match(vegetation, /xrRockMaterial = new THREE\.MeshLambertMaterial/);
assert.match(vegetation, /xrLeafMaterial = new THREE\.MeshLambertMaterial/);
assert.match(vegetation, /registerXRMaterialVariant\(rockMaterial, xrRockMaterial\)/);
assert.match(vegetation, /materialVariantFor\([\s\S]*batch\.buckets\[0\]/,
  'new streamed static batches should choose the active material variant');
assert.match(trail, /xrTrailSurfaceMaterial = new THREE\.MeshLambertMaterial/);
assert.match(trail, /vXRTrailWash = _xrTrailStroke/,
  'XR trail brush noise should be evaluated by vertices');

const fragmentStart = terrain.indexOf('shader.fragmentShader =');
const terrainVertexSource = terrain.slice(0, fragmentStart);
const terrainFragmentSource = terrain.slice(fragmentStart);
assert.match(terrainVertexSource, /float _xrStroke = xrTerrainNoise/);
assert.match(terrainVertexSource, /float _xrFarMeadow = smoothstep/);
assert.match(terrainVertexSource, /float _xrWave = sin/);
assert.match(terrainVertexSource, /vXRMeadowPaint = vec4/);
assert.match(terrainVertexSource, /vXRShadeTone = clamp/,
  'terrain pigment triples should be derived by vertices');
assert.match(terrainFragmentSource, /_xrS\.shade = vXRShadeTone/);
assert.doesNotMatch(terrainFragmentSource, /pigments\(diffuseColor\.rgb/,
  'terrain pigment derivation must not run per fragment');
assert.doesNotMatch(terrainFragmentSource, /pnValue\(vXRWorldPosition/,
  'terrain noise must not return to the per-fragment path');
assert.doesNotMatch(terrainFragmentSource, /float _xrWave = sin/,
  'far-meadow animation must remain vertex-evaluated');
assert.match(main, /setXRMaterialVariants\(true\);[\s\S]*applyXRMaterialVariants\(scene, true\)/);
assert.match(main, /setXRMaterialVariants\(false\);[\s\S]*applyXRMaterialVariants\(scene, false\)/);

console.log('xrmaterials PASS · reversible world variants · Lambert vegetation/trails · vertex terrain fields');
