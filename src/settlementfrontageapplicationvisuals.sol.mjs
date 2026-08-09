// Sol-owned builders for restrained family-frontage architectural treatments.
//
// Three is injected. The static group is compatible with the settlement merge
// pass; the door group borrows the same catalog materials and is attached by the
// caller beneath the existing door pivot. No selection, placement, animation,
// light, particle, texture or per-household material state lives here.

import {
  DOOR_TREATMENTS,
  ELEMENT_VARIANTS,
  FACADE_TREATMENTS,
  FRONTAGE_APPLICATION_CATALOG_VERSION,
  FRONTAGE_APPLICATION_CATALOG_VALIDATION,
  TRIM_TARGETS,
} from './settlementfrontageapplicationcatalog.sol.mjs';
import { FRONTAGE_MATERIALS } from './settlementfrontagecatalog.mjs';

const HALF_PI = Math.PI / 2;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function box(materialId, size, position, {
  rotation = [0, 0, 0], label = 'box', castShadow = true, receiveShadow = true,
} = {}) {
  return { primitive: 'box', materialId, dimensions: { size }, position, rotation, label, castShadow, receiveShadow };
}

function cylinder(materialId, radius, height, position, {
  rotation = [0, 0, 0], radialSegments = 8, label = 'cylinder', castShadow = true, receiveShadow = true,
} = {}) {
  return {
    primitive: 'cylinder', materialId,
    dimensions: { topRadius: radius, bottomRadius: radius, height },
    position, rotation, radialSegments, label, castShadow, receiveShadow,
  };
}

function frontDoor(building) {
  return building?.portals?.find((portal) => portal.kind === 'exterior-door') || null;
}

function buildingShape(building) {
  const width = Number(building?.width);
  const depth = Number(building?.depth);
  const height = Number(building?.height ?? (building?.floorCount * building?.floorHeight));
  const door = frontDoor(building);
  if (!(width > 0) || !(depth > 0) || !(height > 0) || !door
    || ![door.x, door.width, door.height].every(Number.isFinite)
    || !(door.width > 0) || !(door.height > 0)) {
    throw new TypeError('A family building with positive dimensions and an exterior door is required.');
  }
  return { width, depth, height, door };
}

function wallIntervals(width, door, gap = 0.24) {
  const edge = 0.24;
  const intervals = [
    [-width / 2 + edge, door.x - door.width / 2 - gap],
    [door.x + door.width / 2 + gap, width / 2 - edge],
  ];
  return intervals.filter(([from, to]) => to - from >= 0.3);
}

function facadeParts(id, shape) {
  const spec = FACADE_TREATMENTS[id];
  if (!spec) throw new RangeError(`Unknown facade application: ${id}`);
  const { width, depth, height, door } = shape;
  // Stay behind the existing surname-business sign plane at +0.20 while
  // clearing the wall/window frame surface. The sign remains authoritative.
  const z = depth / 2 + 0.17;
  const parts = [];
  if (spec.builder === 'mended-course') {
    for (const [side, [from, to]] of wallIntervals(width, door).entries()) {
      const count = Math.min(4, Math.max(2, Math.floor((to - from) / 1.15)));
      const cell = (to - from) / count;
      for (let index = 0; index < count; index++) {
        const blockWidth = Math.min(0.72, cell * 0.68);
        parts.push(box(index % 3 ? 'frontage.stone.field' : 'frontage.stone.pale',
          [blockWidth, 0.21, 0.055],
          [from + cell * (index + 0.5), 0.22 + ((index + side) % 2) * 0.23, z], {
            rotation: [0, 0, ((index + side) % 2 ? 1 : -1) * 0.018],
            label: `mended-course-${side}-${index}`,
          }));
      }
    }
  } else if (spec.builder === 'shoulder-stones') {
    const xInset = Math.min(0.32, width * 0.035);
    for (const side of [-1, 1]) for (let row = 0; row < 3; row++) {
      parts.push(box('frontage.stone.field', [0.48, 0.24, 0.055],
        [side * (width / 2 - xInset), 0.38 + row * 0.46, z], {
          rotation: [0, 0, side * (row % 2 ? -0.014 : 0.01)],
          label: `shoulder-${side}-${row}`,
        }));
    }
  } else if (spec.builder === 'lime-pins') {
    const inner = door.width / 2 + 0.28;
    const outer = width / 2 - 0.28;
    for (const [index, x] of [-outer, -inner, inner, outer].entries()) {
      parts.push(box('frontage.mark.lime', [0.16, Math.min(0.68, height * 0.22), 0.055],
        [x + door.x, 0.78 + (index % 2) * 0.2, z], {
          rotation: [0, 0, index % 2 ? 0.018 : -0.012], castShadow: false,
          label: `lime-pin-${index}`,
        }));
    }
  }
  return parts;
}

function trimParts(id, shape) {
  const spec = TRIM_TARGETS[id];
  if (!spec) throw new RangeError(`Unknown frontage trim target: ${id}`);
  const { width, depth, height, door } = shape;
  const z = depth / 2 + 0.17;
  const parts = [];
  if (spec.builder === 'door-head') {
    parts.push(box('frontage.wood.weathered', [door.width + 0.46, 0.14, 0.055],
      [door.x, door.height + 0.1, z], { label: 'door-head-lintel' }));
    for (const side of [-1, 1]) parts.push(box('frontage.wood.weathered', [0.13, 0.34, 0.055],
      [door.x + side * (door.width / 2 + 0.14), door.height - 0.04, z], { label: `door-head-cap-${side}` }));
  } else if (spec.builder === 'corner-stops') {
    const x = width / 2 - 0.1;
    const stopHeight = Math.min(0.55, height * 0.18);
    for (const side of [-1, 1]) for (let tier = 0; tier < 2; tier++) {
      parts.push(box('frontage.wood.dark', [0.13, stopHeight, 0.055],
        [side * x, 0.4 + tier * (stopHeight + 0.2), z], { label: `corner-stop-${side}-${tier}` }));
    }
  } else if (spec.builder === 'low-sills') {
    for (const [side, [from, to]] of wallIntervals(width, door, 0.34).entries()) {
      const run = Math.min(2.2, Math.max(0.35, (to - from) * 0.5));
      const centre = side ? to - run / 2 : from + run / 2;
      parts.push(box('frontage.wood.mid', [run, 0.11, 0.055],
        [centre, Math.min(0.72, height * 0.24), z], {
          rotation: [0, 0, side ? -0.012 : 0.012], label: `low-sill-${side}`,
        }));
    }
  }
  return parts;
}

function diagonalDoorBrace(materialId, width, height, from, to, label) {
  const dx = (to[0] - from[0]) * width;
  const dy = (to[1] - from[1]) * height;
  return box(materialId, [Math.hypot(dx, dy), 0.1, 0.045],
    [(from[0] + to[0]) * width / 2, (from[1] + to[1]) * height / 2, 0.09], {
      rotation: [0, 0, Math.atan2(dy, dx)], label,
    });
}

function doorParts(id, shape) {
  const spec = DOOR_TREATMENTS[id];
  if (!spec) throw new RangeError(`Unknown frontage door treatment: ${id}`);
  const { width, height } = shape.door;
  const parts = [];
  if (spec.builder === 'vertical-battens') {
    for (let index = 0; index < 4; index++) {
      parts.push(box('frontage.wood.weathered', [0.065, height * 0.82, 0.045],
        [width * (index + 0.5) / 4, height * 0.5, 0.09], { label: `door-batten-${index}` }));
    }
  } else if (spec.builder === 'cross-brace') {
    parts.push(diagonalDoorBrace('frontage.wood.mid', width, height, [0.1, 0.18], [0.9, 0.82], 'door-brace-rising'));
    parts.push(diagonalDoorBrace('frontage.wood.mid', width, height, [0.1, 0.82], [0.9, 0.18], 'door-brace-falling'));
  } else if (spec.builder === 'iron-studs') {
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      parts.push(cylinder('frontage.metal.iron', 0.038, 0.045,
        [width * (0.2 + column * 0.3), height * (0.22 + row * 0.28), 0.09], {
          radialSegments: 6, rotation: [HALF_PI, 0, 0], label: `door-stud-${row}-${column}`,
        }));
    }
  }
  return parts;
}

function projectedArea(part) {
  if (part.primitive === 'box') return part.dimensions.size[0] * part.dimensions.size[1];
  return Math.PI * part.dimensions.bottomRadius ** 2;
}

function componentStats(parts, denominator) {
  return deepFreeze({
    meshes: parts.length,
    triangles: parts.reduce((sum, part) => sum + (part.primitive === 'box' ? 12 : part.radialSegments * 4), 0),
    materialIds: [...new Set(parts.map((part) => part.materialId))],
    projectedCoverage: parts.reduce((sum, part) => sum + projectedArea(part), 0) / denominator,
  });
}

export function frontageApplicationRecipe(building, application) {
  if (!FRONTAGE_APPLICATION_CATALOG_VALIDATION.valid) throw new Error('Frontage application catalog is invalid.');
  const shape = buildingShape(building);
  const facadeTreatmentId = application?.facadeTreatmentId;
  const trimTargetId = application?.trimTargetId;
  const doorTreatmentId = application?.doorTreatmentId;
  const elementVariantId = application?.elementVariantId;
  if (!ELEMENT_VARIANTS[elementVariantId]) throw new RangeError(`Unknown frontage element variant: ${elementVariantId}`);
  const facade = facadeParts(facadeTreatmentId, shape);
  const trim = trimParts(trimTargetId, shape);
  const door = doorParts(doorTreatmentId, shape);
  const wallArea = shape.width * shape.height;
  const doorArea = shape.door.width * shape.door.height;
  return deepFreeze({
    catalogVersion: FRONTAGE_APPLICATION_CATALOG_VERSION,
    facadeTreatmentId,
    trimTargetId,
    doorTreatmentId,
    elementVariantId,
    localFrame: 'building-core-centre-at-floor',
    doorLocalFrame: 'exterior-door-left-hinge-at-floor',
    staticParts: [...facade, ...trim],
    doorParts: door,
    components: {
      facade: componentStats(facade, wallArea),
      trim: componentStats(trim, wallArea),
      door: componentStats(door, doorArea),
    },
  });
}

function materialFrom(library, materialId) {
  const value = library instanceof Map ? library.get(materialId) : library?.[materialId];
  if (!value) throw new RangeError(`Frontage material library is missing catalog ID: ${materialId}`);
  return value;
}

function geometryFor(THREE, part) {
  let geometry;
  if (part.primitive === 'box') geometry = new THREE.BoxGeometry(...part.dimensions.size);
  else geometry = new THREE.CylinderGeometry(
    part.dimensions.topRadius, part.dimensions.bottomRadius, part.dimensions.height,
    part.radialSegments, 1, false,
  );
  if (geometry.index && typeof geometry.toNonIndexed === 'function') geometry = geometry.toNonIndexed();
  if (geometry.attributes && typeof geometry.deleteAttribute === 'function') {
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
  }
  return geometry;
}

function buildParts(THREE, parts, materials, name, userData) {
  const group = new THREE.Group();
  group.name = name;
  group.userData = {
    catalogVersion: FRONTAGE_APPLICATION_CATALOG_VERSION,
    geometryEncoding: 'non-indexed-position-normal',
    materialOwnership: 'borrowed',
    ...userData,
  };
  for (const [index, part] of parts.entries()) {
    const mesh = new THREE.Mesh(geometryFor(THREE, part), materialFrom(materials, part.materialId));
    mesh.name = `${name}:${part.label}:${index}`;
    mesh.position.set(...part.position);
    mesh.rotation.set(...part.rotation);
    mesh.castShadow = part.castShadow;
    mesh.receiveShadow = part.receiveShadow;
    mesh.userData = { frontageMaterialId: part.materialId, staticStructure: userData.staticStructure };
    group.add(mesh);
  }
  return group;
}

/** Build static facade/trim plus door-pivot-local detail using borrowed materials. */
export function buildFrontageApplication(THREE, building, application, { materials } = {}) {
  if (!THREE?.Group || !THREE?.Mesh || !THREE?.BoxGeometry || !THREE?.CylinderGeometry) {
    throw new TypeError('A complete Three namespace is required.');
  }
  if (!materials) throw new TypeError('A shared frontage material Map is required.');
  const recipe = frontageApplicationRecipe(building, application);
  return Object.freeze({
    staticVisual: buildParts(THREE, recipe.staticParts, materials, 'frontage:application:static', {
      staticStructure: true, mergeCompatible: true, followsDoorPivot: false,
    }),
    doorVisual: buildParts(THREE, recipe.doorParts, materials, 'frontage:application:door', {
      staticStructure: false, mergeCompatible: false, followsDoorPivot: true,
    }),
    recipe,
  });
}

export function validateFrontageApplicationRecipes(building = {
  width: 9,
  depth: 7,
  height: 5.6,
  portals: [{ kind: 'exterior-door', x: 0, width: 1.15, height: 2.15 }],
}) {
  const errors = [];
  const materials = new Set(Object.keys(FRONTAGE_MATERIALS));
  for (const facadeTreatmentId of Object.keys(FACADE_TREATMENTS)) {
    for (const trimTargetId of Object.keys(TRIM_TARGETS)) {
      for (const doorTreatmentId of Object.keys(DOOR_TREATMENTS)) {
        const application = {
          facadeTreatmentId, trimTargetId, doorTreatmentId,
          elementVariantId: 'element-variant.even',
        };
        let recipe;
        try { recipe = frontageApplicationRecipe(building, application); } catch (error) {
          errors.push(`recipe:${facadeTreatmentId}:${trimTargetId}:${doorTreatmentId}:${error.message}`); continue;
        }
        for (const part of [...recipe.staticParts, ...recipe.doorParts]) {
          if (!materials.has(part.materialId)) errors.push(`material:${part.materialId}`);
          if (!['box', 'cylinder'].includes(part.primitive)) errors.push(`primitive:${part.primitive}`);
          if (![...part.position, ...part.rotation].every(Number.isFinite)) errors.push(`transform:${part.label}`);
        }
        const components = [
          [FACADE_TREATMENTS[facadeTreatmentId], recipe.components.facade],
          [TRIM_TARGETS[trimTargetId], recipe.components.trim],
          [DOOR_TREATMENTS[doorTreatmentId], recipe.components.door],
        ];
        for (const [spec, stats] of components) {
          if (!stats.meshes || stats.meshes > spec.meshBudget) errors.push(`mesh-budget:${spec.id}:${stats.meshes}`);
          if (stats.triangles > spec.triangleBudget) errors.push(`triangle-budget:${spec.id}:${stats.triangles}`);
          if (stats.projectedCoverage > spec.coverageMax + 1e-6) errors.push(`coverage:${spec.id}:${stats.projectedCoverage}`);
          if (stats.materialIds.some((id) => !spec.materialIds.includes(id))) errors.push(`undeclared-material:${spec.id}`);
        }
      }
    }
  }
  return deepFreeze({ valid: errors.length === 0, errors: [...new Set(errors)] });
}

export const FRONTAGE_APPLICATION_RECIPE_VALIDATION = validateFrontageApplicationRecipes();
if (!FRONTAGE_APPLICATION_RECIPE_VALIDATION.valid) {
  throw new Error(`Invalid frontage application recipes: ${FRONTAGE_APPLICATION_RECIPE_VALIDATION.errors.join(', ')}`);
}
