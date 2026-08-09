import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_FRONTAGE_VISUAL_OPTIONS,
  FAMILY_MARK_SILHOUETTES,
  FRONTAGE_ASSETS,
  FRONTAGE_ASSET_IDS,
  FRONTAGE_MATERIALS,
  FRONTAGE_VISUAL_CATALOG_VALIDATION,
  HOUSEHOLD_PALETTE_IDS,
  frontageAssetsFor,
} from '../src/settlementfrontagecatalog.mjs';
import {
  FRONTAGE_VISUAL_RECIPE_VALIDATION,
  buildFamilyMark,
  buildFrontageVisual,
  buildPartialFence,
  buildServiceCue,
  buildYardElement,
  createFrontageMaterialLibrary,
  frontageVisualRecipe,
} from '../src/settlementfrontagevisuals.mjs';
import { FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA, FAMILY_FRONTAGE_VERSION } from '../src/familyfrontage.mjs';

test('Sol catalog and every static recipe self-validate', () => {
  assert.deepEqual(FRONTAGE_VISUAL_CATALOG_VALIDATION, { valid: true, errors: [] });
  assert.deepEqual(FRONTAGE_VISUAL_RECIPE_VALIDATION, { valid: true, errors: [] });
  assert.equal(FRONTAGE_ASSET_IDS.length, 22);
  assert.ok(FRONTAGE_ASSET_IDS.every((id) => Object.isFrozen(FRONTAGE_ASSETS[id])));
});

test('asset metadata supplies every Luna WP0 field and forbids ground aprons', () => {
  for (const asset of Object.values(FRONTAGE_ASSETS)) {
    assert.equal(asset.version, FAMILY_FRONTAGE_VERSION);
    for (const field of FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA.fields) {
      assert.ok(Object.hasOwn(asset, field), `${asset.id} missing ${field}`);
    }
    assert.equal(asset.groundCover, 'none');
    assert.notEqual(asset.wallAttached, asset.groundSeated);
    assert.ok(asset.programs.length > 0 && asset.zones.length > 0);
    assert.ok(asset.meshBudget > 0 && asset.triangleBudget > 0);
  }
});

test('family marks are topologically distinct without relying on colour', () => {
  const signatures = Object.values(FAMILY_MARK_SILHOUETTES).map((mark) => JSON.stringify({
    strokes: mark.strokes.map(({ from, to }) => [from, to]), pegs: mark.pegs,
  }));
  assert.equal(new Set(signatures).size, signatures.length);
  assert.equal(signatures.length, 6);
  assert.equal(HOUSEHOLD_PALETTE_IDS.length, 6);
  for (const paletteId of HOUSEHOLD_PALETTE_IDS) assert.ok(FRONTAGE_MATERIALS[paletteId]);
});

test('recipes are byte-stable and use catalog-keyed materials only', () => {
  for (const assetId of FRONTAGE_ASSET_IDS) {
    const first = JSON.stringify(frontageVisualRecipe(assetId));
    const second = JSON.stringify(frontageVisualRecipe(assetId));
    assert.equal(first, second, assetId);
    for (const part of frontageVisualRecipe(assetId).parts) assert.ok(FRONTAGE_MATERIALS[part.materialId]);
  }
  const washed = frontageVisualRecipe('family-mark.cleft', {
    treatmentId: 'mark-treatment.washed', householdMaterialId: 'frontage.household.slate',
  });
  assert.ok(washed.parts.every((part) => part.materialId === 'frontage.household.slate'));
});

test('program and zone filtering exposes planner-ready catalog records', () => {
  const smithy = frontageAssetsFor({ program: 'smithy', category: 'service-cue' });
  assert.deepEqual(smithy.map((asset) => asset.id), ['service.smithy-quench']);
  assert.equal(FAMILY_FRONTAGE_VISUAL_OPTIONS.serviceCueIds.inn, 'service.inn-hitching-rail');
  assert.ok(frontageAssetsFor({ zone: 'work-yard' }).length >= 6);
});

class FakeMaterial {
  constructor(options) { this.options = options; this.userData = {}; }
}
class FakeGeometry {
  constructor(...parameters) {
    this.parameters = parameters;
    this.index = {};
    this.attributes = { position: {}, normal: {}, uv: {} };
  }
  toNonIndexed() {
    const result = new FakeGeometry(...this.parameters);
    result.index = null;
    return result;
  }
  deleteAttribute(name) { delete this.attributes[name]; }
}
class FakeNode {
  constructor() {
    this.children = [];
    this.userData = {};
    this.position = { set: (...value) => { this.position.value = value; } };
    this.rotation = { set: (...value) => { this.rotation.value = value; } };
  }
  add(child) { this.children.push(child); }
}
class FakeGroup extends FakeNode {}
class FakeMesh extends FakeNode {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
const FakeThree = Object.freeze({
  MeshStandardMaterial: FakeMaterial,
  BoxGeometry: FakeGeometry,
  CylinderGeometry: FakeGeometry,
  ConeGeometry: FakeGeometry,
  DodecahedronGeometry: FakeGeometry,
  Group: FakeGroup,
  Mesh: FakeMesh,
});

test('Three builders borrow one shared material library and return static groups', () => {
  const materials = createFrontageMaterialLibrary(FakeThree);
  assert.deepEqual([...materials.keys()], Object.keys(FRONTAGE_MATERIALS));
  const built = FRONTAGE_ASSET_IDS.map((assetId) => buildFrontageVisual(FakeThree, assetId, { materials }));
  for (const group of built) {
    assert.equal(group.userData.staticStructure, true);
    assert.equal(group.userData.mergeCompatible, true);
    assert.equal(group.userData.geometryEncoding, 'non-indexed-position-normal');
    assert.equal(group.userData.materialOwnership, 'borrowed');
    for (const mesh of group.children) {
      const id = mesh.userData.frontageMaterialId;
      assert.equal(mesh.material, materials.get(id));
      assert.equal(mesh.geometry.index, null);
      assert.deepEqual(Object.keys(mesh.geometry.attributes), ['position', 'normal']);
    }
  }
  assert.doesNotThrow(() => buildFamilyMark(FakeThree, 'family-mark.open-arch', { materials }));
  assert.doesNotThrow(() => buildPartialFence(FakeThree, 'fence.wattle-gap', { materials }));
  assert.doesNotThrow(() => buildYardElement(FakeThree, 'yard.herb-ring', { materials }));
  assert.doesNotThrow(() => buildServiceCue(FakeThree, 'service.granary-staging', { materials }));
});
