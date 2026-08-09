// Static Three builders for settlementfrontagecatalog.mjs.
//
// Three is injected instead of imported so this module remains loadable in a
// worker or Node validation pass. A renderer calls createFrontageMaterialLibrary
// once, retains that Map, and passes it to every build. Builders never allocate
// or cache a material per household.
//
// Every returned child is an ordinary Mesh with a primitive BufferGeometry and
// a shared material. There are no lights, textures, particles, animations or
// update hooks, and the group is ready for the existing static merge pass.

import {
  FAMILY_MARK_SILHOUETTES,
  FAMILY_MARK_TREATMENTS,
  FRONTAGE_ASSETS,
  FRONTAGE_ASSET_IDS,
  FRONTAGE_MATERIALS,
  FRONTAGE_VISUAL_CATALOG_VERSION,
  HOUSEHOLD_PALETTE_IDS,
} from './settlementfrontagecatalog.mjs';
import {
  ELEMENT_VARIANTS,
  elementVariantMaterialId,
} from './settlementfrontageapplicationcatalog.sol.mjs';

const HALF_PI = Math.PI / 2;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function part(primitive, materialId, position, dimensions, {
  rotation = [0, 0, 0], radialSegments = 0, castShadow = true, receiveShadow = true, label = primitive,
} = {}) {
  return { primitive, materialId, position, rotation, dimensions, radialSegments, castShadow, receiveShadow, label };
}

function box(materialId, size, position, options) {
  return part('box', materialId, position, { size }, options);
}

function cylinder(materialId, radius, height, position, {
  topRadius = radius, radialSegments = 7, ...options
} = {}) {
  return part('cylinder', materialId, position, { topRadius, bottomRadius: radius, height }, { radialSegments, ...options });
}

function cone(materialId, radius, height, position, { radialSegments = 6, ...options } = {}) {
  return part('cone', materialId, position, { radius, height }, { radialSegments, ...options });
}

function stone(materialId, radius, position, options) {
  return part('dodecahedron', materialId, position, { radius }, options);
}

function strokeXY(materialId, from, to, width, depth, label = 'mark-stroke') {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  return box(materialId, [Math.hypot(dx, dy), width, depth],
    [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0], {
      rotation: [0, 0, Math.atan2(dy, dx)], castShadow: false, receiveShadow: false, label,
    });
}

function recipe(assetId, parts, options = {}) {
  return deepFreeze({
    catalogVersion: FRONTAGE_VISUAL_CATALOG_VERSION,
    assetId,
    category: FRONTAGE_ASSETS[assetId].category,
    static: true,
    mergeCompatible: true,
    parts,
    ...options,
  });
}

function familyMarkRecipe(assetId, { treatmentId = 'mark-treatment.incised', householdMaterialId = 'frontage.household.ochre' } = {}) {
  const mark = FAMILY_MARK_SILHOUETTES[assetId];
  const treatment = FAMILY_MARK_TREATMENTS[treatmentId];
  if (!treatment) throw new RangeError(`Unknown family-mark treatment: ${treatmentId}`);
  if (treatment.materialRole === 'household' && !HOUSEHOLD_PALETTE_IDS.includes(householdMaterialId)) {
    throw new RangeError(`Unknown household palette material: ${householdMaterialId}`);
  }
  const materialId = treatment.materialId || householdMaterialId;
  const parts = mark.strokes.map(({ from, to, width }, index) => strokeXY(
    materialId, from, to, width * treatment.widthScale, treatment.depth, `mark-stroke-${index}`,
  ));
  for (let index = 0; index < mark.pegs.length; index++) {
    const [x, y] = mark.pegs[index];
    parts.push(cylinder(materialId, 0.052 * treatment.widthScale, treatment.depth, [x, y, 0], {
      radialSegments: 6, rotation: [HALF_PI, 0, 0], castShadow: false, receiveShadow: false,
      label: `mark-peg-${index}`,
    }));
  }
  return recipe(assetId, parts, { treatmentId, householdMaterialId: treatment.materialRole === 'household' ? householdMaterialId : null });
}

function wattleGapRecipe(assetId) {
  const parts = [];
  for (const [index, x] of [-2.7, -0.72, 0.72, 2.7].entries()) {
    parts.push(box('frontage.wood.dark', [0.16, 1.06, 0.16], [x, 0.53, 0], { label: `post-${index}` }));
  }
  for (const [side, centre] of [['left', -1.71], ['right', 1.71]]) {
    for (let row = 0; row < 4; row++) {
      parts.push(box('frontage.wood.weathered', [2.08, 0.085, 0.1],
        [centre, 0.24 + row * 0.22, (row % 2 ? 1 : -1) * 0.035], {
          rotation: [0, 0, (row % 2 ? 1 : -1) * 0.018], label: `${side}-wattle-${row}`,
        }));
    }
  }
  return recipe(assetId, parts);
}

function splitRailCornerRecipe(assetId) {
  const parts = [];
  const postPoints = [[-2.35, 0], [-1.18, 0], [0, 0], [0, 1.18], [0, 2.35]];
  for (const [index, [x, z]] of postPoints.entries()) {
    parts.push(box('frontage.wood.dark', [0.18, 1.14, 0.18], [x, 0.57, z], { label: `post-${index}` }));
  }
  for (const [index, y] of [0.42, 0.88].entries()) {
    parts.push(box('frontage.wood.weathered', [2.4, 0.13, 0.13], [-1.18, y, 0], {
      rotation: [0, 0, index ? -0.018 : 0.012], label: `rail-x-${index}`,
    }));
    parts.push(box('frontage.wood.weathered', [0.13, 0.13, 2.4], [0, y, 1.18], {
      rotation: [index ? 0.016 : -0.012, 0, 0], label: `rail-z-${index}`,
    }));
  }
  return recipe(assetId, parts);
}

function lowPaleRunRecipe(assetId) {
  const parts = [];
  const xs = [-2.12, -1.76, -1.4, -1.04, -0.68, 0.68, 1.04, 1.4, 1.76, 2.12];
  for (const [index, x] of xs.entries()) {
    const height = 0.72 + (index % 3) * 0.07;
    parts.push(box('frontage.wood.weathered', [0.13, height, 0.12], [x, height / 2, 0], {
      label: `pale-${index}`,
    }));
  }
  for (const [side, centre] of [['left', -1.4], ['right', 1.4]]) for (const [index, y] of [0.27, 0.57].entries()) {
    parts.push(box('frontage.wood.dark', [1.56, 0.1, 0.14], [centre, y, -0.035], { label: `${side}-rail-${index}` }));
  }
  return recipe(assetId, parts);
}

function raisedBedPairRecipe(assetId) {
  const parts = [];
  for (const [bedIndex, cx] of [-0.86, 0.86].entries()) {
    parts.push(box('frontage.wood.weathered', [1.48, 0.26, 0.13], [cx, 0.2, -1.02], { label: `bed-${bedIndex}-back` }));
    parts.push(box('frontage.wood.weathered', [1.48, 0.26, 0.13], [cx, 0.2, 1.02], { label: `bed-${bedIndex}-front` }));
    parts.push(box('frontage.wood.weathered', [0.13, 0.26, 1.92], [cx - 0.675, 0.2, 0], { label: `bed-${bedIndex}-left` }));
    parts.push(box('frontage.wood.weathered', [0.13, 0.26, 1.92], [cx + 0.675, 0.2, 0], { label: `bed-${bedIndex}-right` }));
    parts.push(box('frontage.earth.loam', [1.2, 0.1, 1.76], [cx, 0.28, 0], { castShadow: false, label: `bed-${bedIndex}-soil` }));
    for (let row = 0; row < 3; row++) for (let column = 0; column < 2; column++) {
      const index = row * 2 + column;
      const x = cx + (column ? 0.29 : -0.29);
      const z = -0.55 + row * 0.55;
      parts.push(cylinder('frontage.plant.leaf', 0.025, 0.25, [x, 0.43, z], {
        radialSegments: 6, label: `bed-${bedIndex}-stem-${index}`,
      }));
      parts.push(cone('frontage.plant.leaf', 0.12, 0.24, [x, 0.62, z], {
        radialSegments: 6, label: `bed-${bedIndex}-leaf-${index}`,
      }));
    }
  }
  return recipe(assetId, parts);
}

function herbRingRecipe(assetId) {
  const parts = [];
  for (let index = 0; index < 10; index++) {
    const angle = index * Math.PI * 2 / 10;
    parts.push(stone(index % 3 ? 'frontage.stone.field' : 'frontage.stone.pale', 0.2,
      [Math.cos(angle) * 0.82, 0.16, Math.sin(angle) * 0.82], {
        rotation: [index * 0.17, angle * 0.31, index * 0.09], label: `ring-stone-${index}`,
      }));
  }
  parts.push(cylinder('frontage.earth.loam', 0.75, 0.08, [0, 0.07, 0], {
    radialSegments: 10, castShadow: false, label: 'contained-soil',
  }));
  for (let index = 0; index < 7; index++) {
    const angle = index * 2.399963;
    const radius = 0.2 + (index % 3) * 0.15;
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    const height = 0.24 + (index % 2) * 0.08;
    parts.push(cylinder('frontage.plant.leaf', 0.025, height, [x, 0.18 + height / 2, z], {
      radialSegments: 6, label: `herb-stem-${index}`,
    }));
    parts.push(cone('frontage.plant.leaf', 0.1, 0.18, [x, 0.18 + height + 0.07, z], {
      radialSegments: 6, label: `herb-leaf-${index}`,
    }));
  }
  return recipe(assetId, parts);
}

function climbingFrameRecipe(assetId) {
  const parts = [];
  for (const x of [-1.08, 1.08]) for (const z of [-0.3, 0.3]) {
    parts.push(box('frontage.wood.weathered', [0.09, 1.58, 0.09], [x, 0.79, z], {
      rotation: [z > 0 ? -0.08 : 0.08, 0, 0], label: `frame-post-${x}-${z}`,
    }));
  }
  parts.push(box('frontage.wood.weathered', [2.35, 0.1, 0.1], [0, 1.57, 0], { label: 'frame-ridge' }));
  parts.push(box('frontage.earth.loam', [2.3, 0.07, 0.55], [0, 0.06, 0], { castShadow: false, label: 'contained-row' }));
  for (let index = 0; index < 5; index++) {
    const x = -0.84 + index * 0.42;
    parts.push(box('frontage.plant.leaf', [0.045, 1.28, 0.045], [x, 0.68, 0.04], {
      rotation: [0.03, 0, index % 2 ? 0.1 : -0.1], label: `vine-${index}`,
    }));
    parts.push(cone('frontage.plant.leaf', 0.11, 0.22, [x + (index % 2 ? 0.07 : -0.07), 0.72 + index * 0.12, 0.06], {
      radialSegments: 5, rotation: [0, 0, HALF_PI], label: `vine-leaf-${index}`,
    }));
  }
  return recipe(assetId, parts);
}

function firewoodRickRecipe(assetId) {
  const parts = [];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
    const x = (column % 2 ? 0.035 : -0.035);
    const z = -0.3 + (column % 3) * 0.3;
    parts.push(cylinder('frontage.wood.dark', 0.12, 2.55 - (column % 3) * 0.06,
      [x, 0.15 + row * 0.31, z], {
        radialSegments: 7, rotation: [0, 0, HALF_PI], label: `log-${row}-${column}`,
      }));
  }
  for (const x of [-1.36, 1.36]) {
    parts.push(box('frontage.wood.weathered', [0.12, 1.08, 0.12], [x, 0.54, 0], {
      rotation: [0, 0, x < 0 ? -0.04 : 0.04], label: `end-stake-${x}`,
    }));
  }
  return recipe(assetId, parts);
}

function timberOffcutsRecipe(assetId) {
  const parts = [];
  const boards = [
    [2.8, 0.18, 0.28, 0, 0.15, 0, 0.02], [2.55, 0.2, 0.3, -0.12, 0.34, 0.08, -0.025],
    [2.7, 0.16, 0.25, 0.08, 0.52, -0.1, 0.03], [2.3, 0.2, 0.32, -0.18, 0.68, 0.1, -0.02],
    [1.7, 0.16, 0.22, 0.45, 0.2, 0.43, -0.04], [1.45, 0.18, 0.24, -0.62, 0.39, -0.4, 0.045],
    [1.15, 0.14, 0.2, 0.75, 0.57, 0.36, -0.03], [1.25, 0.15, 0.2, -0.7, 0.6, -0.32, 0.035],
  ];
  for (const [index, [w, h, d, x, y, z, roll]] of boards.entries()) {
    parts.push(box(index < 4 ? 'frontage.wood.weathered' : 'frontage.wood.cut', [w, h, d], [x, y, z], {
      rotation: [0, index < 4 ? 0 : (z > 0 ? -0.13 : 0.13), roll], label: `offcut-${index}`,
    }));
  }
  for (const x of [-0.95, 0.95]) parts.push(box('frontage.wood.dark', [0.22, 0.18, 1.1], [x, 0.09, 0], { label: `chock-${x}` }));
  return recipe(assetId, parts);
}

function fieldstoneStackRecipe(assetId) {
  const parts = [];
  const stones = [
    [-0.82, 0.15, -0.3, 0.52, 0.3, 0.48], [-0.28, 0.18, -0.32, 0.5, 0.36, 0.44],
    [0.28, 0.16, -0.3, 0.52, 0.32, 0.48], [0.82, 0.17, -0.28, 0.46, 0.34, 0.46],
    [-0.72, 0.16, 0.25, 0.5, 0.32, 0.44], [-0.18, 0.19, 0.28, 0.54, 0.38, 0.48],
    [0.4, 0.16, 0.26, 0.56, 0.32, 0.42], [0.88, 0.14, 0.24, 0.4, 0.28, 0.38],
    [-0.48, 0.45, -0.08, 0.5, 0.3, 0.45], [0.05, 0.46, 0.02, 0.54, 0.32, 0.42],
    [0.58, 0.43, -0.02, 0.5, 0.28, 0.4], [0.02, 0.67, 0, 0.48, 0.22, 0.36],
  ];
  for (const [index, [x, y, z, w, h, d]] of stones.entries()) {
    parts.push(box(index % 4 ? 'frontage.stone.field' : 'frontage.stone.pale', [w, h, d], [x, y, z], {
      rotation: [0.04 * (index % 3), 0.12 * (index % 5), index % 2 ? 0.05 : -0.04], label: `fieldstone-${index}`,
    }));
  }
  return recipe(assetId, parts);
}

function leaningRackRecipe(assetId) {
  const parts = [
    box('frontage.wood.dark', [0.13, 1.48, 0.13], [-0.9, 0.74, 0], { label: 'left-post' }),
    box('frontage.wood.dark', [0.13, 1.48, 0.13], [0.9, 0.74, 0], { label: 'right-post' }),
    box('frontage.wood.weathered', [1.95, 0.14, 0.15], [0, 1.34, 0], { label: 'top-rail' }),
    box('frontage.wood.weathered', [1.95, 0.12, 0.14], [0, 0.68, 0], { label: 'lower-rail' }),
  ];
  for (const [index, x] of [-0.55, 0, 0.52].entries()) {
    const lean = index === 1 ? 0.09 : index === 0 ? -0.12 : 0.13;
    parts.push(box('frontage.wood.weathered', [0.07, 1.38, 0.07], [x, 0.73, 0.12], {
      rotation: [0, 0, lean], label: `tool-handle-${index}`,
    }));
    parts.push(box('frontage.metal.dull', index === 1 ? [0.5, 0.12, 0.09] : [0.24, 0.2, 0.08],
      [x - Math.sin(lean) * 0.63, 1.43, 0.12], {
        rotation: [0, 0, lean + (index === 1 ? 0 : 0.2)], label: `tool-head-${index}`,
      }));
  }
  return recipe(assetId, parts);
}

function dwellingThresholdRecipe(assetId) {
  const parts = [
    box('frontage.wood.weathered', [1.65, 0.16, 0.42], [-0.18, 0.49, 0], { label: 'bench-seat' }),
    box('frontage.wood.dark', [0.15, 0.48, 0.34], [-0.78, 0.24, 0], { label: 'bench-leg-left' }),
    box('frontage.wood.dark', [0.15, 0.48, 0.34], [0.42, 0.24, 0], { label: 'bench-leg-right' }),
    box('frontage.wood.weathered', [1.62, 0.12, 0.12], [-0.18, 0.72, -0.12], { label: 'bench-back' }),
    box('frontage.wood.dark', [0.1, 0.38, 0.1], [-0.75, 0.61, -0.12], { label: 'back-stay-left' }),
    box('frontage.wood.dark', [0.1, 0.38, 0.1], [0.39, 0.61, -0.12], { label: 'back-stay-right' }),
    cylinder('frontage.clay', 0.27, 0.42, [0.86, 0.21, 0.04], { topRadius: 0.22, radialSegments: 8, label: 'covered-crock' }),
    cylinder('frontage.clay', 0.22, 0.08, [0.86, 0.46, 0.04], { radialSegments: 8, label: 'crock-lid' }),
  ];
  return recipe(assetId, parts);
}

function barnFeedRecipe(assetId) {
  const parts = [
    box('frontage.wood.weathered', [2.75, 0.16, 0.8], [-0.2, 0.22, 0], { label: 'trough-bottom' }),
    box('frontage.wood.weathered', [2.75, 0.5, 0.12], [-0.2, 0.48, -0.4], { rotation: [0.08, 0, 0], label: 'trough-back' }),
    box('frontage.wood.weathered', [2.75, 0.5, 0.12], [-0.2, 0.48, 0.4], { rotation: [-0.08, 0, 0], label: 'trough-front' }),
    box('frontage.wood.dark', [0.14, 0.46, 0.78], [-1.53, 0.45, 0], { label: 'trough-end-left' }),
    box('frontage.wood.dark', [0.14, 0.46, 0.78], [1.13, 0.45, 0], { label: 'trough-end-right' }),
  ];
  for (const x of [-1.22, 0.82]) for (const z of [-0.3, 0.3]) {
    parts.push(box('frontage.wood.dark', [0.13, 0.38, 0.13], [x, 0.19, z], { label: `trough-leg-${x}-${z}` }));
  }
  for (const [index, x] of [-0.92, -0.28, 0.36].entries()) {
    parts.push(cone('frontage.plant.dry', 0.25, 0.36, [x, 0.58, 0], { radialSegments: 6, label: `feed-${index}` }));
  }
  parts.push(box('frontage.wood.weathered', [0.07, 1.4, 0.07], [1.45, 0.76, -0.05], {
    rotation: [0, 0, -0.12], label: 'fork-handle',
  }));
  parts.push(box('frontage.metal.dull', [0.38, 0.08, 0.08], [1.54, 1.45, -0.05], { rotation: [0, 0, -0.12], label: 'fork-head' }));
  for (const x of [1.4, 1.52, 1.64]) parts.push(box('frontage.metal.dull', [0.035, 0.28, 0.035], [x, 1.34, -0.05], { label: `fork-tine-${x}` }));
  return recipe(assetId, parts);
}

function workshopBenchRecipe(assetId) {
  const parts = [
    box('frontage.wood.weathered', [2.75, 0.18, 0.82], [0, 0.86, 0], { label: 'bench-top' }),
    box('frontage.wood.dark', [0.18, 0.82, 0.62], [-1.08, 0.41, 0], { label: 'trestle-left' }),
    box('frontage.wood.dark', [0.18, 0.82, 0.62], [1.08, 0.41, 0], { label: 'trestle-right' }),
    box('frontage.wood.dark', [2.2, 0.12, 0.16], [0, 0.27, 0], { label: 'trestle-stretcher' }),
    box('frontage.wood.cut', [1.05, 0.12, 0.22], [-0.62, 1.04, 0.02], { rotation: [0, 0.08, 0.035], label: 'workpiece-long' }),
    box('frontage.wood.cut', [0.66, 0.14, 0.25], [0.42, 1.05, -0.08], { rotation: [0, -0.13, -0.02], label: 'workpiece-short' }),
    box('frontage.metal.dull', [0.36, 0.22, 0.24], [1.02, 1.06, 0.1], { label: 'vice-body' }),
    box('frontage.metal.dull', [0.46, 0.09, 0.18], [1.02, 1.22, 0.1], { label: 'vice-jaw' }),
    box('frontage.metal.dull', [0.62, 0.055, 0.055], [1.02, 0.99, 0.25], { rotation: [0, 0.18, 0], label: 'vice-handle' }),
    box('frontage.wood.weathered', [2.15, 0.12, 0.56], [0, 0.16, 0], { label: 'lower-shelf' }),
  ];
  return recipe(assetId, parts);
}

function innHitchingRailRecipe(assetId) {
  const parts = [];
  for (const [index, x] of [-1.9, 0, 1.9].entries()) {
    parts.push(box('frontage.wood.dark', [0.19, 1.28, 0.19], [x, 0.64, 0], { label: `hitch-post-${index}` }));
    parts.push(cylinder('frontage.metal.dull', 0.055, 0.22, [x, 0.92, 0.12], {
      radialSegments: 7, rotation: [HALF_PI, 0, 0], label: `hitch-peg-${index}`,
    }));
  }
  parts.push(box('frontage.wood.weathered', [3.92, 0.17, 0.18], [0, 1.04, 0], { label: 'hitch-rail' }));
  parts.push(box('frontage.metal.dull', [0.12, 0.12, 3.88], [0, 1.04, 0], { rotation: [0, HALF_PI, 0], label: 'rail-strap' }));
  return recipe(assetId, parts);
}

function smithyQuenchRecipe(assetId) {
  const parts = [
    box('frontage.wood.dark', [1.45, 0.15, 0.9], [-0.66, 0.2, 0], { label: 'quench-bottom' }),
    box('frontage.wood.dark', [1.45, 0.5, 0.12], [-0.66, 0.48, -0.45], { label: 'quench-back' }),
    box('frontage.wood.dark', [1.45, 0.5, 0.12], [-0.66, 0.48, 0.45], { label: 'quench-front' }),
    box('frontage.wood.dark', [0.12, 0.5, 0.82], [-1.33, 0.48, 0], { label: 'quench-left' }),
    box('frontage.wood.dark', [0.12, 0.5, 0.82], [0.01, 0.48, 0], { label: 'quench-right' }),
    box('frontage.stone.field', [0.72, 0.5, 0.6], [0.83, 0.25, 0], { label: 'anvil-block' }),
    box('frontage.metal.iron', [0.92, 0.24, 0.32], [0.83, 0.72, 0], { label: 'anvil-face' }),
    box('frontage.metal.iron', [0.48, 0.36, 0.28], [0.63, 0.51, 0], { label: 'anvil-waist' }),
    box('frontage.metal.iron', [0.28, 0.22, 0.26], [1.27, 0.72, 0], { rotation: [0, 0, -0.18], label: 'anvil-horn' }),
    box('frontage.wood.weathered', [0.06, 0.82, 0.06], [1.25, 0.54, 0.48], { rotation: [0, 0, 0.76], label: 'hammer-handle' }),
    box('frontage.metal.dull', [0.42, 0.16, 0.18], [0.98, 0.82, 0.48], { rotation: [0, 0, 0.76], label: 'hammer-head' }),
    cylinder('frontage.metal.dull', 0.34, 0.35, [0.55, 0.18, -0.58], { topRadius: 0.4, radialSegments: 8, label: 'coal-basket' }),
  ];
  for (const [index, [x, z]] of [[0.42, -0.56], [0.62, -0.58], [0.78, -0.54], [0.55, -0.68]].entries()) {
    parts.push(stone('frontage.metal.iron', 0.13, [x, 0.4 + (index % 2) * 0.05, z], {
      rotation: [index * 0.2, index * 0.3, index * 0.1], label: `coal-${index}`,
    }));
  }
  return recipe(assetId, parts);
}

function granaryStagingRecipe(assetId) {
  const parts = [
    box('frontage.wood.weathered', [2.35, 0.16, 1.15], [-0.12, 0.18, 0], { label: 'loading-board' }),
    box('frontage.wood.dark', [2.2, 0.16, 0.18], [-0.12, 0.08, -0.42], { label: 'rear-skid' }),
    box('frontage.wood.dark', [2.2, 0.16, 0.18], [-0.12, 0.08, 0.42], { label: 'front-skid' }),
  ];
  const sacks = [[-0.75, 0.48, -0.2], [-0.2, 0.48, -0.18], [0.36, 0.48, -0.16],
    [-0.5, 0.82, 0.12], [0.08, 0.82, 0.14], [-0.2, 1.12, 0.08]];
  for (const [index, [x, y, z]] of sacks.entries()) {
    parts.push(stone('frontage.grain', 0.34, [x, y, z], {
      rotation: [HALF_PI, index * 0.28, index % 2 ? 0.12 : -0.08], label: `grain-sack-${index}`,
    }));
  }
  parts.push(cylinder('frontage.wood.dark', 0.34, 0.48, [0.86, 0.48, 0.12], {
    topRadius: 0.28, radialSegments: 8, label: 'measure-bin',
  }));
  parts.push(cylinder('frontage.grain', 0.27, 0.07, [0.86, 0.74, 0.12], {
    radialSegments: 8, castShadow: false, label: 'measure-grain',
  }));
  return recipe(assetId, parts);
}

const RECIPES = Object.freeze({
  'wattle-gap': wattleGapRecipe,
  'split-rail-corner': splitRailCornerRecipe,
  'low-pale-run': lowPaleRunRecipe,
  'raised-bed-pair': raisedBedPairRecipe,
  'herb-ring': herbRingRecipe,
  'climbing-frame': climbingFrameRecipe,
  'firewood-rick': firewoodRickRecipe,
  'timber-offcuts': timberOffcutsRecipe,
  'fieldstone-stack': fieldstoneStackRecipe,
  'leaning-rack': leaningRackRecipe,
  'dwelling-threshold': dwellingThresholdRecipe,
  'barn-feed': barnFeedRecipe,
  'workshop-bench': workshopBenchRecipe,
  'inn-hitching-rail': innHitchingRailRecipe,
  'smithy-quench': smithyQuenchRecipe,
  'granary-staging': granaryStagingRecipe,
});

export function frontageVisualRecipe(assetId, options = {}) {
  const metadata = FRONTAGE_ASSETS[assetId];
  if (!metadata) throw new RangeError(`Unknown frontage visual asset: ${assetId}`);
  if (metadata.builder === 'family-mark') return familyMarkRecipe(assetId, options);
  const builder = RECIPES[metadata.builder];
  if (!builder) throw new Error(`No frontage visual builder for ${assetId} (${metadata.builder})`);
  const elementVariantId = options.elementVariantId || 'element-variant.even';
  if (!ELEMENT_VARIANTS[elementVariantId]) throw new RangeError(`Unknown frontage element variant: ${elementVariantId}`);
  const authored = builder(assetId, options);
  return deepFreeze({
    ...authored,
    elementVariantId,
    parts: authored.parts.map((entry, index) => ({
      ...entry,
      materialId: elementVariantMaterialId(elementVariantId, entry.materialId, metadata.materialIds, index),
    })),
  });
}

export function requiredFrontageMaterialIds(assetId, options = {}) {
  return Object.freeze([...new Set(frontageVisualRecipe(assetId, options).parts.map((entry) => entry.materialId))]);
}

/**
 * Construct one shared palette for a settlement renderer or render tier.
 * The returned Map is keyed only by catalog IDs and is intentionally not kept
 * in module state. The caller owns its lifetime and disposes it once.
 */
export function createFrontageMaterialLibrary(THREE, { Material = THREE?.MeshStandardMaterial } = {}) {
  if (typeof Material !== 'function') throw new TypeError('A Three MeshStandardMaterial constructor is required.');
  const materials = new Map();
  for (const [id, spec] of Object.entries(FRONTAGE_MATERIALS)) {
    const instance = new Material({
      color: spec.color, roughness: spec.roughness, metalness: spec.metalness, flatShading: spec.flatShading,
    });
    instance.name = id;
    instance.userData ||= {};
    Object.assign(instance.userData, { frontageMaterialId: id, catalogVersion: FRONTAGE_VISUAL_CATALOG_VERSION, shared: true });
    materials.set(id, instance);
  }
  return materials;
}

function materialFrom(library, materialId) {
  const value = library instanceof Map ? library.get(materialId) : library?.[materialId];
  if (!value) throw new RangeError(`Frontage material library is missing catalog ID: ${materialId}`);
  return value;
}

function geometryFor(THREE, entry) {
  let geometry;
  if (entry.primitive === 'box') geometry = new THREE.BoxGeometry(...entry.dimensions.size);
  else if (entry.primitive === 'cylinder') geometry = new THREE.CylinderGeometry(
    entry.dimensions.topRadius, entry.dimensions.bottomRadius, entry.dimensions.height, entry.radialSegments, 1, false,
  );
  else if (entry.primitive === 'cone') geometry = new THREE.ConeGeometry(
    entry.dimensions.radius, entry.dimensions.height, entry.radialSegments, 1, false,
  );
  else if (entry.primitive === 'dodecahedron') geometry = new THREE.DodecahedronGeometry(entry.dimensions.radius, 0);
  else throw new RangeError(`Unsupported frontage primitive: ${entry.primitive}`);

  // BufferGeometryUtils refuses to merge indexed and non-indexed sources in
  // one material batch. Box/Cylinder are indexed while Polyhedron geometry is
  // not, so normalize every part at this boundary. UVs are intentionally
  // dropped: the catalog uses no textures and the settlement merge path keeps
  // position/normal only for these meshes.
  if (geometry.index && typeof geometry.toNonIndexed === 'function') geometry = geometry.toNonIndexed();
  if (geometry.attributes && typeof geometry.deleteAttribute === 'function') {
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
  }
  return geometry;
}

/** Build an ordinary static Three.Group. Materials are borrowed, not owned. */
export function buildFrontageVisual(THREE, assetId, { materials, ...recipeOptions } = {}) {
  if (!THREE?.Group || !THREE?.Mesh || !THREE?.BoxGeometry) throw new TypeError('A complete Three namespace is required.');
  if (!materials) throw new TypeError('A shared frontage material Map is required.');
  const visualRecipe = frontageVisualRecipe(assetId, recipeOptions);
  const group = new THREE.Group();
  group.name = `frontage:${assetId}`;
  group.userData = {
    frontageAssetId: assetId,
    catalogVersion: FRONTAGE_VISUAL_CATALOG_VERSION,
    staticStructure: true,
    mergeCompatible: true,
    geometryEncoding: 'non-indexed-position-normal',
    materialOwnership: 'borrowed',
  };
  for (let index = 0; index < visualRecipe.parts.length; index++) {
    const entry = visualRecipe.parts[index];
    const mesh = new THREE.Mesh(geometryFor(THREE, entry), materialFrom(materials, entry.materialId));
    mesh.name = `frontage:${assetId}:${entry.label}:${index}`;
    mesh.position.set(...entry.position);
    mesh.rotation.set(...entry.rotation);
    mesh.castShadow = entry.castShadow;
    mesh.receiveShadow = entry.receiveShadow;
    mesh.userData = { frontageMaterialId: entry.materialId, staticStructure: true };
    group.add(mesh);
  }
  return group;
}

function buildCategory(THREE, category, assetId, options) {
  const actual = FRONTAGE_ASSETS[assetId]?.category;
  if (actual !== category) throw new RangeError(`${assetId} is ${actual || 'unknown'}, not ${category}`);
  return buildFrontageVisual(THREE, assetId, options);
}

export function buildFamilyMark(THREE, assetId, options) {
  return buildCategory(THREE, 'family-mark', assetId, options);
}

export function buildPartialFence(THREE, assetId, options) {
  return buildCategory(THREE, 'partial-fence', assetId, options);
}

export function buildYardElement(THREE, assetId, options) {
  const category = FRONTAGE_ASSETS[assetId]?.category;
  if (!['garden', 'material-stack', 'tool-stack'].includes(category)) {
    throw new RangeError(`${assetId} is ${category || 'unknown'}, not a yard element`);
  }
  return buildFrontageVisual(THREE, assetId, options);
}

export function buildServiceCue(THREE, assetId, options) {
  return buildCategory(THREE, 'service-cue', assetId, options);
}

function triangleCount(entry) {
  if (entry.primitive === 'box') return 12;
  if (entry.primitive === 'dodecahedron') return 36;
  // ConeGeometry is CylinderGeometry with a zero top radius. Three still emits
  // two side indices per segment plus the bottom cap, so budget the indexed
  // geometry it actually sends through the merge path (including degenerates).
  if (entry.primitive === 'cone') return entry.radialSegments * 3;
  if (entry.primitive === 'cylinder') return entry.radialSegments * 4;
  return Infinity;
}

export function frontageVisualStats(assetId, options = {}) {
  const visualRecipe = frontageVisualRecipe(assetId, options);
  return deepFreeze({
    meshes: visualRecipe.parts.length,
    triangles: visualRecipe.parts.reduce((sum, entry) => sum + triangleCount(entry), 0),
    materialIds: [...new Set(visualRecipe.parts.map((entry) => entry.materialId))],
  });
}

function rotateXYZ([x, y, z], [rx, ry, rz]) {
  let a = y * Math.cos(rx) - z * Math.sin(rx);
  let b = y * Math.sin(rx) + z * Math.cos(rx);
  y = a; z = b;
  a = x * Math.cos(ry) + z * Math.sin(ry);
  b = -x * Math.sin(ry) + z * Math.cos(ry);
  x = a; z = b;
  a = x * Math.cos(rz) - y * Math.sin(rz);
  b = x * Math.sin(rz) + y * Math.cos(rz);
  return [a, b, z];
}

function primitiveHalfExtents(entry) {
  if (entry.primitive === 'box') return entry.dimensions.size.map((value) => value / 2);
  if (entry.primitive === 'dodecahedron') return [entry.dimensions.radius, entry.dimensions.radius, entry.dimensions.radius];
  if (entry.primitive === 'cone') return [entry.dimensions.radius, entry.dimensions.height / 2, entry.dimensions.radius];
  const radius = Math.max(entry.dimensions.topRadius, entry.dimensions.bottomRadius);
  return [radius, entry.dimensions.height / 2, radius];
}

// Conservative rotated AABB, used without Three so module import can prove
// every recipe fits its authored local bounds and declared budgets.
function partBounds(entry) {
  // A regular dodecahedron is enclosed by its circumscribed sphere. Its AABB
  // is therefore invariant under the small authored rotations above; rotating
  // a cube-shaped proxy would substantially overstate its bounds.
  if (entry.primitive === 'dodecahedron') {
    const r = entry.dimensions.radius;
    return {
      min: entry.position.map((value) => value - r),
      max: entry.position.map((value) => value + r),
    };
  }
  const [hx, hy, hz] = primitiveHalfExtents(entry);
  const points = [];
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) {
    const rotated = rotateXYZ([x, y, z], entry.rotation);
    points.push(rotated.map((value, axis) => value + entry.position[axis]));
  }
  return {
    min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
  };
}

export function validateFrontageVisualRecipes() {
  const errors = [];
  const materials = new Set(Object.keys(FRONTAGE_MATERIALS));
  for (const assetId of FRONTAGE_ASSET_IDS) {
    let visualRecipe;
    try { visualRecipe = frontageVisualRecipe(assetId); } catch (error) {
      errors.push(`recipe-failed:${assetId}:${error.message}`); continue;
    }
    const metadata = FRONTAGE_ASSETS[assetId];
    if (!visualRecipe.parts.length) errors.push(`empty-recipe:${assetId}`);
    if (visualRecipe.parts.length > metadata.meshBudget) errors.push(`mesh-budget:${assetId}:${visualRecipe.parts.length}>${metadata.meshBudget}`);
    const triangles = frontageVisualStats(assetId).triangles;
    if (triangles > metadata.triangleBudget) errors.push(`triangle-budget:${assetId}:${triangles}>${metadata.triangleBudget}`);
    for (const [index, entry] of visualRecipe.parts.entries()) {
      if (!materials.has(entry.materialId)) errors.push(`unknown-material:${assetId}:${index}:${entry.materialId}`);
      if (!['box', 'cylinder', 'cone', 'dodecahedron'].includes(entry.primitive)) errors.push(`unknown-primitive:${assetId}:${index}`);
      if (![...entry.position, ...entry.rotation].every(Number.isFinite)) errors.push(`invalid-transform:${assetId}:${index}`);
      const actual = partBounds(entry);
      for (let axis = 0; axis < 3; axis++) {
        if (actual.min[axis] < metadata.localBounds.min[axis] - 1e-6
          || actual.max[axis] > metadata.localBounds.max[axis] + 1e-6) {
          errors.push(`bounds:${assetId}:${index}:axis${axis}`);
        }
      }
    }
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}

export const FRONTAGE_VISUAL_RECIPE_VALIDATION = validateFrontageVisualRecipes();
if (!FRONTAGE_VISUAL_RECIPE_VALIDATION.valid) {
  throw new Error(`Invalid settlement frontage recipes: ${FRONTAGE_VISUAL_RECIPE_VALIDATION.errors.join(', ')}`);
}
