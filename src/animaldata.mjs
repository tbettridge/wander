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

// Recipe bodies below are authored in "sheet units" — the proportions traced
// from the reference art. `scale` converts each species to real-world metres
// (shoulder height: whitetail ~0.95 m, red fox ~0.42 m, bull moose ~1.80 m).
// Scaling here rather than on the mesh keeps every downstream consumer — IK
// reach caps, hoof clearance, world-space foot targets — in the same units.
// Angles (bind, headPitch, gait.stride/lift, tail.angle) and ratios (bodyLift,
// tail.root, dutyFactor) are dimensionless and deliberately left alone.
function scaleVec(vec, k) {
  return Object.freeze(vec.map((value) => value * k));
}

function scaleChain(chain, k) {
  return Object.freeze({
    ...chain,
    lengths: scaleVec(chain.lengths, k),
    radii: scaleVec(chain.radii, k),
    x: chain.x * k,
    stagger: chain.stagger * k,
  });
}

function scaleAntlers(antlers, k) {
  return Object.freeze(antlers.map(([from, to, radius]) => Object.freeze([
    scaleVec(from, k), scaleVec(to, k), radius * k,
  ])));
}

function metricRecipe(raw) {
  const k = raw.scale ?? 1;
  if (k === 1) return Object.freeze(raw);
  return Object.freeze({
    ...raw,
    body: scaleVec(raw.body, k),
    chest: scaleVec(raw.chest, k),
    rump: scaleVec(raw.rump, k),
    torsoY: raw.torsoY * k,
    leg: Object.freeze({
      front: scaleChain(raw.leg.front, k),
      hind: scaleChain(raw.leg.hind, k),
      hoof: scaleVec(raw.leg.hoof, k),
    }),
    neck: Object.freeze({
      ...raw.neck,
      lengths: scaleVec(raw.neck.lengths, k),
      radii: scaleVec(raw.neck.radii, k),
    }),
    head: scaleVec(raw.head, k),
    muzzle: scaleVec(raw.muzzle, k),
    ear: scaleVec(raw.ear, k),
    tail: Object.freeze({
      ...raw.tail,
      length: raw.tail.length * k,
      radius: raw.tail.radius * k,
      tipRadius: raw.tail.tipRadius * k,
      lift: (raw.tail.lift ?? 0) * k,
    }),
    shoulderZ: raw.shoulderZ * k,
    hipZ: raw.hipZ * k,
    antlers: scaleAntlers(raw.antlers, k),
    gait: Object.freeze({ ...raw.gait, bob: raw.gait.bob * k }),
    motion: Object.freeze({ ...raw.motion, turnRadius: raw.motion.turnRadius * k }),
  });
}

export const ANIMAL_RECIPES = Object.freeze({
  whitetail: metricRecipe({
    id: 'whitetail', name: 'white-tail deer', seed: 0x5748544c, scale: 0.68,
    // Torso lengthened relative to leg height: a whitetail's body is ~1.2x its
    // shoulder height, where the old recipe was nearly square (1.07) and read
    // as too leggy and short-coupled next to the reference sheet.
    // Chest and rump must not stand taller than the torso they blend into, or
    // they bulge through the back and read as balloons rather than as the
    // barrel and haunch of one body. The rump stays the widest point.
    // The chest is a mass inside the barrel, not a sphere on the front of it:
    // shortened so it stops protruding ahead of the shoulder and shallowed so
    // it no longer sags below the brisket line.
    body: [0.31, 0.39, 1.72], chest: [0.270, 0.330, 0.34], rump: [0.330, 0.385, 0.78], torsoY: 0.005,
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
    // A whitetail's head is small and narrow — about a third of shoulder
    // height — on a neck that tapers rather than swelling into a balloon
    // throat. Ears are large for a deer but nowhere near half a metre.
    // Longer and slimmer so the throat reads as a tapering neck running down
    // into the chest, rather than a ball sitting under the jaw.
    // Radii are closer together than before so the taper up the neck is gradual
    // rather than a step down at the joint.
    neck: { lengths: [0.66, 0.54], radii: [0.150, 0.128], bind: [0.72, -0.25] },
    // Cranium mass raised substantially — the skull had shrunk to a nub between
    // the antlers and the muzzle. Length grows only a little, since the snout
    // itself is already the right length; the muzzle gains height, not reach.
    // Cranium laid on its side: height and length swapped (the same result as
    // rotating the ellipsoid 90 deg about X) so the skull is a long wedge
    // rather than a tall egg, then scaled to 0.85.
    head: [0.215, 0.138, 0.493], headPitch: -0.36, muzzle: [0.082, 0.090, 0.42],
    ear: [0.115, 0.235, 0.060], earAngle: 0.85, earSweep: -0.80,
    // A whitetail's tail is short — ~0.28 m with hair, not the half-metre brush
    // the old value produced.
    tail: { length: 0.41, radius: 0.060, tipRadius: 0.042, segments: 4, root: 0.62, lift: 0.16, angle: -2.25, bend: -0.08 },
    shoulderZ: 0.80, hipZ: -0.80,
    palette: {
      coat: 0x9a6847, dark: 0x49342d, light: 0xd8c5a6,
      cream: 0xf1e8d6, black: 0x171819, eye: 0x050505, antler: 0x9b8060,
    },
    antlers: whitetailAntlers,
    gait: { class: 'ungulate', walkHz: 0.74, runHz: 1.62, dutyFactor: 0.69, stride: 0.34, lift: 0.46, bob: 0.026 },
    motion: { cruise: 0.78, run: 3.25, turn: 1.08, turnRadius: 1.55 },
    habitats: ['grassland', 'forest', 'taiga'],
  }),

  fox: metricRecipe({
    id: 'fox', name: 'red fox', seed: 0x464f5821, scale: 0.49,
    // Foxes are long-bodied and short-legged: torso ~1.35x shoulder height.
    body: [0.235, 0.245, 1.15], chest: [0.265, 0.32, 0.50], rump: [0.285, 0.24, 0.50], torsoY: -0.075,
    leg: {
      front: { lengths: [0.32, 0.23, 0.24], radii: [0.092, 0.060, 0.044], bind: [0.10, -0.22, 0.12], x: 0.155, stagger: 0.04 },
      hind: { lengths: [0.38, 0.26, 0.25], radii: [0.110, 0.064, 0.045], bind: [-0.55, 1.02, -0.47], x: 0.17, stagger: 0.18 },
      hoof: [0.060, 0.045, 0.105],
    },
    bodyLift: 0.32,
    // A fox's head is small and fine-boned — roughly 0.45x shoulder height and
    // clearly narrower than the chest. The neck carries a ruff but is longer
    // and slimmer than the skull is wide, so the head reads as a separate mass
    // rather than merging straight into the shoulders.
    neck: { lengths: [0.30, 0.27], radii: [0.135, 0.100], bind: [0.60, -0.10] },
    head: [0.163, 0.141, 0.297], headPitch: -0.30, muzzle: [0.101, 0.086, 0.38],
    // Ears stay large relative to the now-smaller skull, as a fox's are.
    ear: [0.112, 0.235, 0.105], earAngle: 0.10,
    // The brush is thick but not thicker than the fox: the old radius made it
    // ~0.9x the body's own radius, where the sheet shows nearer 0.55x. Length
    // lands at ~0.43 m, matching a real brush rather than exceeding the body.
    tail: { length: 1.05, radius: 0.135, tipRadius: 0.10, segments: 5, lift: 0.06, angle: -2.30, bend: -0.10 },
    shoulderZ: 0.59, hipZ: -0.56,
    palette: {
      coat: 0xc45f2f, dark: 0x3c2925, light: 0xe99050,
      cream: 0xf3dfc4, black: 0x171719, eye: 0x7a5218, antler: 0x6c5b48,
    },
    antlers: [],
    gait: { class: 'canid', walkHz: 0.98, runHz: 2.02, dutyFactor: 0.66, stride: 0.40, lift: 0.43, bob: 0.022 },
    motion: { cruise: 0.92, run: 2.80, turn: 1.42, turnRadius: 0.82 },
    habitats: ['grassland', 'forest', 'taiga', 'tundra', 'desert'],
  }),

  // The moose was already close to a real bull (1.82 m shoulder), so it only
  // needs a nudge; the other two shrink toward it.
  moose: metricRecipe({
    id: 'moose', name: 'bull moose', seed: 0x4d4f4f53, scale: 0.99,
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
    // A moose tail is a stub — barely past the rump, not a third of a metre.
    tail: { length: 0.17, radius: 0.075, tipRadius: 0.050, segments: 3, root: 0.56, lift: 0.30, angle: -2.60, bend: -0.10 },
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
