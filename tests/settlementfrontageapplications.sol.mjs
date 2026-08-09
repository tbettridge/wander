import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DOOR_TREATMENTS,
  ELEMENT_VARIANTS,
  FACADE_TREATMENTS,
  FRONTAGE_APPLICATION_CATALOG_VALIDATION,
  FRONTAGE_APPLICATION_OPTIONS,
  FRONTAGE_PALETTE_GUIDANCE,
  TRIM_TARGETS,
} from '../src/settlementfrontageapplicationcatalog.sol.mjs';
import {
  FRONTAGE_APPLICATION_RECIPE_VALIDATION,
  buildFrontageApplication,
  frontageApplicationRecipe,
} from '../src/settlementfrontageapplicationvisuals.sol.mjs';
import {
  FRONTAGE_ASSETS,
  FRONTAGE_MATERIALS,
  HOUSEHOLD_PALETTE_IDS,
} from '../src/settlementfrontagecatalog.mjs';
import {
  createFrontageMaterialLibrary,
  frontageVisualRecipe,
} from '../src/settlementfrontagevisuals.mjs';

const building = Object.freeze({
  id: 'building:application-test',
  program: 'dwelling',
  width: 9,
  depth: 7,
  height: 5.6,
  floorCount: 2,
  floorHeight: 2.8,
  portals: Object.freeze([
    Object.freeze({ id: 'door:front', kind: 'exterior-door', x: 0, width: 1.15, height: 2.15 }),
  ]),
});

const application = Object.freeze({
  facadeTreatmentId: 'facade-application.mended-course',
  trimTargetId: 'trim-target.door-head',
  doorTreatmentId: 'door-treatment.cross-brace',
  elementVariantId: 'element-variant.weathered',
});

function relativeLuminance(color) {
  const rgb = [color >> 16, (color >> 8) & 0xff, color & 0xff].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test('Sol architectural catalog closes every explicit visual placeholder channel', () => {
  assert.deepEqual(FRONTAGE_APPLICATION_CATALOG_VALIDATION, { valid: true, errors: [] });
  assert.deepEqual(FRONTAGE_APPLICATION_RECIPE_VALIDATION, { valid: true, errors: [] });
  for (const ids of Object.values(FRONTAGE_APPLICATION_OPTIONS)) {
    assert.ok(ids.length >= 3);
    assert.ok(ids.every((id) => !id.startsWith('placeholder:')));
  }
  for (const group of [FACADE_TREATMENTS, TRIM_TARGETS, DOOR_TREATMENTS, ELEMENT_VARIANTS]) {
    assert.ok(Object.isFrozen(group));
    assert.ok(Object.values(group).every((entry) => entry.identityRole === 'supporting'
      || entry.channel === 'element-variant'));
  }
});

test('palette guidance keeps identity quiet and legible in grayscale', () => {
  const band = FRONTAGE_PALETTE_GUIDANCE.householdAccentRelativeLuminance;
  assert.equal(FRONTAGE_PALETTE_GUIDANCE.householdAccentFacadeCoverageMax, 0);
  assert.equal(FRONTAGE_PALETTE_GUIDANCE.grayscalePrimaryCue, 'family-mark-topology');
  assert.ok(FRONTAGE_PALETTE_GUIDANCE.prohibited.includes('faction-banding'));
  for (const id of HOUSEHOLD_PALETTE_IDS) {
    const luminance = relativeLuminance(FRONTAGE_MATERIALS[id].color);
    assert.ok(luminance >= band.min && luminance <= band.max, `${id} luminance ${luminance}`);
  }
  for (const group of [FACADE_TREATMENTS, TRIM_TARGETS, DOOR_TREATMENTS]) {
    const cues = Object.values(group).map((entry) => entry.grayscaleCue);
    assert.equal(new Set(cues).size, cues.length);
    assert.ok(Object.values(group).every((entry) => entry.materialIds
      .every((id) => !HOUSEHOLD_PALETTE_IDS.includes(id))));
  }
});

test('facade, trim and door recipes are stable, bounded and never skin the whole facade', () => {
  const first = frontageApplicationRecipe(building, application);
  const second = frontageApplicationRecipe(building, application);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(first.staticParts.length > 0 && first.doorParts.length > 0);
  assert.ok(first.components.facade.projectedCoverage <= FACADE_TREATMENTS[application.facadeTreatmentId].coverageMax);
  assert.ok(first.components.trim.projectedCoverage <= TRIM_TARGETS[application.trimTargetId].coverageMax);
  assert.ok(first.components.door.projectedCoverage <= DOOR_TREATMENTS[application.doorTreatmentId].coverageMax);
  assert.ok(first.staticParts.every((part) => part.position[2] > building.depth / 2));
  assert.ok(first.doorParts.every((part) => part.position[0] >= 0 && part.position[0] <= building.portals[0].width));
  assert.ok(first.staticParts.every((part) => !HOUSEHOLD_PALETTE_IDS.includes(part.materialId)));
});

test('element variants alter shared catalog materials only, never geometry or collision truth', () => {
  const assetId = 'fence.wattle-gap';
  const recipes = Object.keys(ELEMENT_VARIANTS).map((elementVariantId) => frontageVisualRecipe(assetId, { elementVariantId }));
  const geometrySignature = (recipe) => JSON.stringify(recipe.parts.map(({ primitive, position, rotation, dimensions }) => ({
    primitive, position, rotation, dimensions,
  })));
  assert.equal(new Set(recipes.map(geometrySignature)).size, 1);
  assert.ok(new Set(recipes.map((recipe) => JSON.stringify(recipe.parts.map((part) => part.materialId)))).size > 1);
  for (const recipe of recipes) for (const part of recipe.parts) {
    assert.ok(FRONTAGE_ASSETS[assetId].materialIds.includes(part.materialId));
  }
  assert.ok(Object.values(ELEMENT_VARIANTS).every((variant) => variant.geometryInvariant && variant.collisionInvariant));
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
  Group: FakeGroup,
  Mesh: FakeMesh,
});

test('builders return merge-safe static work and shared-material door-pivot work', () => {
  const materials = createFrontageMaterialLibrary(FakeThree);
  const built = buildFrontageApplication(FakeThree, building, application, { materials });
  assert.equal(built.staticVisual.userData.staticStructure, true);
  assert.equal(built.staticVisual.userData.mergeCompatible, true);
  assert.equal(built.doorVisual.userData.followsDoorPivot, true);
  assert.equal(built.staticVisual.userData.materialOwnership, 'borrowed');
  for (const group of [built.staticVisual, built.doorVisual]) for (const mesh of group.children) {
    const id = mesh.userData.frontageMaterialId;
    assert.equal(mesh.material, materials.get(id));
    assert.equal(mesh.geometry.index, null);
    assert.deepEqual(Object.keys(mesh.geometry.attributes), ['position', 'normal']);
  }
});

test('Sol visual modules contain no random, Three import, light, particle or update hook', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/settlementfrontageapplicationcatalog.sol.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/settlementfrontageapplicationvisuals.sol.mjs', import.meta.url), 'utf8'),
  ]);
  const source = sources.join('\n');
  assert.doesNotMatch(source, /Math\.random|from\s+['"]three(?:\/|['"])/);
  assert.doesNotMatch(source, /new\s+THREE\.(?:PointLight|SpotLight|DirectionalLight|AnimationMixer|Particle)/);
  assert.doesNotMatch(source, /requestAnimationFrame|\.onBeforeRender\s*=/);
});
