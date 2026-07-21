// Procedural quadruped recipes.  The renderer consumes only these dimensions,
// colours and accents, so adding a new animal is data work rather than a new
// modelling/animation pipeline.

export const LEG_ORDER = Object.freeze([
  'frontLeft', 'frontRight', 'hindLeft', 'hindRight',
]);

const whitetailAntlers = [
  // Main beams sweep backward in side view while progressively branching
  // outward in front view, matching the compact whitetail rack in the sheet.
  [[-0.12, 0.17, -0.03], [-0.22, 0.34, -0.09], 0.037],
  [[-0.22, 0.34, -0.09], [-0.34, 0.49, -0.18], 0.032],
  [[-0.34, 0.49, -0.18], [-0.48, 0.63, -0.26], 0.027],
  [[-0.48, 0.63, -0.26], [-0.60, 0.78, -0.32], 0.022],
  [[-0.20, 0.32, -0.08], [-0.48, 0.39, 0.10], 0.025],
  [[-0.31, 0.46, -0.15], [-0.29, 0.70, 0.00], 0.022],
  [[-0.43, 0.59, -0.23], [-0.40, 0.84, -0.08], 0.019],
  [[-0.55, 0.72, -0.29], [-0.61, 0.92, -0.18], 0.016],
  [[0.12, 0.17, -0.03], [0.22, 0.34, -0.09], 0.037],
  [[0.22, 0.34, -0.09], [0.34, 0.49, -0.18], 0.032],
  [[0.34, 0.49, -0.18], [0.48, 0.63, -0.26], 0.027],
  [[0.48, 0.63, -0.26], [0.60, 0.78, -0.32], 0.022],
  [[0.20, 0.32, -0.08], [0.48, 0.39, 0.10], 0.025],
  [[0.31, 0.46, -0.15], [0.29, 0.70, 0.00], 0.022],
  [[0.43, 0.59, -0.23], [0.40, 0.84, -0.08], 0.019],
  [[0.55, 0.72, -0.29], [0.61, 0.92, -0.18], 0.016],
];

const mooseAntlers = [
  [[-0.25, 0.18, 0.02], [-0.57, 0.42, -0.02], 0.065],
  [[-0.55, 0.40, -0.02], [-0.98, 0.55, 0.06], 0.095],
  [[-0.82, 0.50, 0.06], [-1.38, 0.66, 0.24], 0.105],
  [[-0.58, 0.43, 0.01], [-1.13, 0.73, 0.19], 0.085],
  [[-1.00, 0.56, 0.12], [-1.12, 1.12, 0.22], 0.060],
  [[-0.72, 0.46, 0.04], [-0.76, 1.03, 0.18], 0.060],
  [[-1.20, 0.60, 0.17], [-1.38, 0.98, 0.27], 0.052],
  [[0.25, 0.18, 0.02], [0.57, 0.42, -0.02], 0.065],
  [[0.55, 0.40, -0.02], [0.98, 0.55, 0.06], 0.095],
  [[0.82, 0.50, 0.06], [1.38, 0.66, 0.24], 0.105],
  [[0.58, 0.43, 0.01], [1.13, 0.73, 0.19], 0.085],
  [[1.00, 0.56, 0.12], [1.12, 1.12, 0.22], 0.060],
  [[0.72, 0.46, 0.04], [0.76, 1.03, 0.18], 0.060],
  [[1.20, 0.60, 0.17], [1.38, 0.98, 0.27], 0.052],
];

export const ANIMAL_RECIPES = Object.freeze({
  whitetail: Object.freeze({
    id: 'whitetail', name: 'white-tail deer', seed: 0x5748544c,
    body: [0.31, 0.39, 1.50], chest: [0.34, 0.46, 0.60], rump: [0.37, 0.45, 0.68], torsoY: 0.005,
    leg: {
      // Long upper segments deliberately bury the femur head / scapula pivot
      // inside the torso (see bodyLift), so the visible rotation happens high
      // on the body and each stride sweeps a longer arc. Distal segments stay
      // shorter so overall height matches the reference sheet.
      front: { lengths: [0.50, 0.42, 0.38], radii: [0.088, 0.056, 0.040], bind: [0.08, -0.18, 0.10], x: 0.19, stagger: 0.035 },
      hind: { lengths: [0.58, 0.44, 0.40], radii: [0.118, 0.064, 0.042], bind: [-0.44, 0.86, -0.42], x: 0.21, stagger: 0.11 },
      hoof: [0.068, 0.075, 0.10],
    },
    bodyLift: 0.28,
    neck: { lengths: [0.55, 0.48], radii: [0.21, 0.155], bind: [0.72, -0.25] },
    head: [0.21, 0.23, 0.44], headPitch: -0.36, muzzle: [0.13, 0.10, 0.42],
    ear: [0.27, 0.68, 0.21], earAngle: 0.85, earSweep: -0.80,
    tail: { length: 0.50, radius: 0.060, tipRadius: 0.042, segments: 4, root: 0.62, lift: 0.16, angle: -2.25, bend: -0.08 },
    shoulderZ: 0.70, hipZ: -0.70,
    palette: {
      coat: 0x9a6847, dark: 0x49342d, light: 0xd8c5a6,
      cream: 0xf1e8d6, black: 0x171819, eye: 0x11100f, antler: 0x9b8060,
    },
    antlers: whitetailAntlers,
    gait: { class: 'ungulate', walkHz: 0.74, runHz: 1.62, dutyFactor: 0.69, stride: 0.34, lift: 0.46, bob: 0.026 },
    motion: { cruise: 0.78, run: 3.25, turn: 1.08, turnRadius: 1.55 },
    habitats: ['grassland', 'forest', 'taiga'],
  }),

  fox: Object.freeze({
    id: 'fox', name: 'red fox', seed: 0x464f5821,
    body: [0.235, 0.245, 1.02], chest: [0.265, 0.32, 0.44], rump: [0.285, 0.24, 0.44], torsoY: -0.075,
    leg: {
      front: { lengths: [0.32, 0.23, 0.24], radii: [0.092, 0.060, 0.044], bind: [0.10, -0.22, 0.12], x: 0.155, stagger: 0.04 },
      hind: { lengths: [0.38, 0.26, 0.25], radii: [0.110, 0.064, 0.045], bind: [-0.55, 1.02, -0.47], x: 0.17, stagger: 0.18 },
      hoof: [0.060, 0.045, 0.105],
    },
    bodyLift: 0.32,
    neck: { lengths: [0.23, 0.21], radii: [0.19, 0.14], bind: [0.60, -0.10] },
    head: [0.21, 0.22, 0.30], headPitch: -0.30, muzzle: [0.13, 0.11, 0.38],
    ear: [0.135, 0.285, 0.13], earAngle: 0.10,
    tail: { length: 1.12, radius: 0.21, tipRadius: 0.14, segments: 5, lift: 0.06, angle: -2.30, bend: -0.10 },
    shoulderZ: 0.52, hipZ: -0.50,
    palette: {
      coat: 0xc45f2f, dark: 0x3c2925, light: 0xe99050,
      cream: 0xf3dfc4, black: 0x171719, eye: 0x7a5218, antler: 0x6c5b48,
    },
    antlers: [],
    gait: { class: 'canid', walkHz: 0.98, runHz: 2.02, dutyFactor: 0.66, stride: 0.40, lift: 0.43, bob: 0.022 },
    motion: { cruise: 0.92, run: 2.80, turn: 1.42, turnRadius: 0.82 },
    habitats: ['grassland', 'forest', 'taiga', 'tundra', 'desert'],
  }),

  moose: Object.freeze({
    id: 'moose', name: 'bull moose', seed: 0x4d4f4f53,
    body: [0.63, 0.62, 2.42], chest: [0.70, 0.78, 0.92], rump: [0.70, 0.68, 0.94], torsoY: -0.09,
    leg: {
      // A moose's true femur is almost entirely inside the body silhouette;
      // the visible mid-limb hinge is the actual knee. Long upper segments
      // plus a low bodyLift reproduce that high, hidden pivot.
      front: { lengths: [0.66, 0.52, 0.52], radii: [0.185, 0.112, 0.075], bind: [0.10, -0.18, 0.08], x: 0.36, stagger: 0.03 },
      hind: { lengths: [0.74, 0.52, 0.52], radii: [0.220, 0.128, 0.078], bind: [-0.34, 0.65, -0.30], x: 0.39, stagger: 0.11 },
      hoof: [0.115, 0.090, 0.19],
    },
    bodyLift: 0.24,
    neck: { lengths: [0.55, 0.44], radii: [0.40, 0.28], bind: [1.05, -0.10] },
    head: [0.40, 0.40, 0.68], headPitch: -0.72, muzzle: [0.38, 0.32, 0.90],
    ear: [0.22, 0.28, 0.15], earAngle: 0.82,
    // Slim and rooted high on the back of the rump so it protrudes past the
    // rump SDF instead of being swallowed by its blend radius.
    tail: { length: 0.34, radius: 0.075, tipRadius: 0.050, segments: 3, root: 0.56, lift: 0.30, angle: -2.60, bend: -0.10 },
    shoulderZ: 0.99, hipZ: -0.99,
    palette: {
      coat: 0x564438, dark: 0x241f1c, light: 0x806758,
      cream: 0xb49a78, black: 0x141414, eye: 0x0e0d0c, antler: 0xb19b77,
    },
    antlers: mooseAntlers,
    gait: { class: 'ungulate', walkHz: 0.60, runHz: 1.34, dutyFactor: 0.72, stride: 0.29, lift: 0.39, bob: 0.031 },
    motion: { cruise: 0.82, run: 2.85, turn: 0.78, turnRadius: 2.15 },
    habitats: ['taiga', 'forest', 'grassland'],
  }),
});

export function legVerticalDrop(chain) {
  let angle = 0;
  let drop = 0;
  for (let i = 0; i < chain.lengths.length; i++) {
    angle += chain.bind[i];
    drop += Math.cos(angle) * chain.lengths[i];
  }
  return drop;
}

export function neckReach(neck) {
  let angle = 0;
  let rise = 0;
  let forward = 0;
  for (let i = 0; i < neck.lengths.length; i++) {
    angle += neck.bind[i];
    rise += Math.cos(angle) * neck.lengths[i];
    forward += Math.sin(angle) * neck.lengths[i];
  }
  return { rise, forward };
}

export function animalBindDimensions(recipe) {
  const hoofClearance = recipe.leg.hoof[1] * 1.38;
  const frontDrop = legVerticalDrop(recipe.leg.front);
  const hindDrop = legVerticalDrop(recipe.leg.hind);
  const frontRootY = frontDrop + hoofClearance;
  const hindRootY = hindDrop + hoofClearance;
  const legHeight = Math.max(frontRootY, hindRootY);
  // bodyLift is how far the torso centre rides above the tallest leg root, as
  // a fraction of the torso half-height. Small values sink the femur head and
  // scapula pivot deep into the body volume — the anatomically high pivot that
  // lets the upper limb sweep a long, natural stride under the skin.
  const bodyY = legHeight + recipe.body[1] * (recipe.bodyLift ?? 0.68);
  const neck = neckReach(recipe.neck);
  return {
    legHeight,
    bodyY,
    shoulderY: frontRootY,
    hipY: hindRootY,
    headY: bodyY + neck.rise,
    headZ: recipe.shoulderZ + neck.forward,
  };
}

export function validateAnimalRecipe(recipe) {
  const errors = [];
  if (!recipe?.id || !recipe?.name) errors.push('identity');
  for (const key of ['body', 'chest', 'rump', 'head', 'muzzle', 'ear']) {
    if (!Array.isArray(recipe?.[key]) || recipe[key].length !== 3
      || recipe[key].some((value) => !Number.isFinite(value) || value <= 0)) errors.push(key);
  }
  for (const end of ['front', 'hind']) {
    const chain = recipe?.leg?.[end];
    for (const key of ['lengths', 'radii']) {
      if (!Array.isArray(chain?.[key]) || chain[key].length !== 3
        || chain[key].some((value) => !Number.isFinite(value) || value <= 0)) {
        errors.push(`leg.${end}.${key}`);
      }
    }
    if (!Array.isArray(chain?.bind) || chain.bind.length !== 3
      || chain.bind.some((value) => !Number.isFinite(value))) errors.push(`leg.${end}.bind`);
  }
  for (const key of ['lengths', 'radii']) {
    if (!Array.isArray(recipe?.neck?.[key]) || recipe.neck[key].length !== 2
      || recipe.neck[key].some((value) => !Number.isFinite(value) || value <= 0)) {
      errors.push(`neck.${key}`);
    }
  }
  if (!Array.isArray(recipe?.neck?.bind) || recipe.neck.bind.length !== 2
    || recipe.neck.bind.some((value) => !Number.isFinite(value))) errors.push('neck.bind');
  if (!Number.isInteger(recipe?.tail?.segments) || recipe.tail.segments < 2
    || !Number.isFinite(recipe?.tail?.length) || recipe.tail.length <= 0) errors.push('tail');
  if (!Number.isFinite(recipe?.gait?.dutyFactor)
    || recipe.gait.dutyFactor <= 0.5 || recipe.gait.dutyFactor >= 0.8) errors.push('gait.dutyFactor');
  if (!['ungulate', 'canid'].includes(recipe?.gait?.class)) errors.push('gait.class');
  if (!Number.isFinite(recipe?.motion?.turnRadius) || recipe.motion.turnRadius <= 0) errors.push('motion.turnRadius');
  if (!Number.isFinite(recipe?.bodyLift) || recipe.bodyLift <= 0 || recipe.bodyLift >= 1) errors.push('bodyLift');
  for (const key of ['coat', 'dark', 'light', 'cream', 'black', 'eye', 'antler']) {
    if (!Number.isInteger(recipe?.palette?.[key])) errors.push(`palette.${key}`);
  }
  if (!Array.isArray(recipe?.habitats) || !recipe.habitats.length) errors.push('habitats');
  return errors;
}
