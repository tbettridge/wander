import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VARIANT_COUNTS } from '../src/vegdata.js';
import {
  MANAGED_VEGETATION_ASSETS,
  MANAGED_VEGETATION_ASSET_IDS,
  MANAGED_VEGETATION_ASSET_SCHEMA,
  MANAGED_VEGETATION_CATALOG_VALIDATION,
  MANAGED_VEGETATION_CATALOG_VERSION,
} from '../src/managedvegetationcatalog.sol.mjs';
import {
  MANAGED_VEGETATION_VISUAL_RECIPE_VALIDATION,
  managedVegetationVisualRecipe,
  managedVegetationVisualStats,
} from '../src/managedvegetationvisuals.sol.mjs';

test('domestic catalog contains only natural shrub and apple arrangements', () => {
  assert.deepEqual(MANAGED_VEGETATION_CATALOG_VALIDATION, { valid: true, errors: [] });
  assert.deepEqual(MANAGED_VEGETATION_VISUAL_RECIPE_VALIDATION, { valid: true, errors: [] });
  assert.equal(MANAGED_VEGETATION_ASSET_IDS.length, 4);
  assert.deepEqual(new Set(Object.values(MANAGED_VEGETATION_ASSETS)
    .flatMap((asset) => asset.foliageTypes)), new Set(['shrub', 'apple']));
  for (const asset of Object.values(MANAGED_VEGETATION_ASSETS)) {
    assert.equal(asset.version, MANAGED_VEGETATION_CATALOG_VERSION);
    assert.equal(asset.draw.mode, 'shared-natural-instancing');
    assert.equal(asset.draw.geometryOwner, 'vegetation-library');
    assert.equal(asset.capabilities.sharedNaturalFoliage, true);
    assert.equal(asset.capabilities.instanced, true);
    assert.equal(asset.capabilities.staticMerge, false);
    assert.equal(asset.groundCover.mode, 'none');
    for (const field of MANAGED_VEGETATION_ASSET_SCHEMA.requiredFields) {
      assert.ok(Object.hasOwn(asset, field), `${asset.id}:${field}`);
    }
  }
});

test('garden and coppice recipes use shrubs; orchard recipes use apple trees', () => {
  for (const assetId of MANAGED_VEGETATION_ASSET_IDS) for (const lodId of ['near', 'far']) {
    const first = managedVegetationVisualRecipe(assetId, { lodId });
    const second = managedVegetationVisualRecipe(assetId, { lodId });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    const expected = assetId.includes('orchard') ? 'apple' : 'shrub';
    assert.ok(first.instances.length > 0);
    assert.ok(first.instances.every((entry) => entry.type === expected), `${assetId}:${lodId}`);
    assert.deepEqual(managedVegetationVisualStats(assetId, { lodId }).types, [expected]);
  }
});

test('apple is a fruiting variant in the shared procedural vegetation framework', async () => {
  assert.equal(VARIANT_COUNTS.apple, 3);
  const source = await readFile(new URL('../src/vegetation.js', import.meta.url), 'utf8');
  assert.match(source, /apple:\s*\{[^]*?fruit:\s*\{/);
  assert.match(source, /apple:\s*variants\(V\.apple,\s*\(r\)\s*=>\s*buildBranchingPlant\(r,\s*'apple'\)\)/);
  assert.match(source, /ctx\.fruitParts\.push\(paintGeometry\(fruit,/);
  assert.match(source, /mergeGeometries\(\[\.\.\.ctx\.barkParts,\s*\.\.\.ctx\.fruitParts\]\)/);
});

test('domestic visual source defines no replacement primitive geometry or material library', async () => {
  const source = await readFile(new URL('../src/managedvegetationvisuals.sol.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /BoxGeometry|ConeGeometry|CylinderGeometry|DodecahedronGeometry|IcosahedronGeometry/);
  assert.doesNotMatch(source, /MeshStandardMaterial|MeshLambertMaterial|from\s+['"]three['"]/);
  assert.doesNotMatch(source, /Math\.random/);
});
