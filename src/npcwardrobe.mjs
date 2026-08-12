// What a resident is wearing, decided from who they are.
//
// `role` has been on every identity since the beginning and the renderer never
// read it, so a miller and a signaller were the same person in different
// colours. Work dress is derived from it here: an apron is what you wear
// because of what you do all day, not a random draw.
//
// Everything is a decision, not geometry. The renderer turns these into
// primitives on bones; this module has no THREE, no DOM, and no opinion about
// how an apron is shaped — which is also what makes it testable and what the
// eventual authored wardrobe catalog would slot into.

export const NPC_GARMENTS = Object.freeze(['trousers', 'skirt', 'tunic']);
export const NPC_LAYERS = Object.freeze(['none', 'waistcoat', 'shawl', 'coat']);
export const NPC_WORK_DRESS = Object.freeze([
  'apron', 'armband', 'rolled-sleeves', 'satchel-strap',
]);

// Matched against the role string rather than an enum. Roles arrive from three
// places — households, work routines, and station slots — and new ones appear
// whenever a building program is added, so an unrecognised role should quietly
// get no work dress instead of throwing or guessing wrong.
// Anchored on word boundaries. Bare substrings looked fine until `keeper`
// matched `innkeeper` and put a railway armband on the publican.
const WORK_DRESS_RULES = Object.freeze([
  Object.freeze({ pattern: /\b(?:smith|forge|blacksmith)\b/, dress: ['apron', 'rolled-sleeves'] }),
  Object.freeze({ pattern: /\b(?:miller|granary|baker|bakery)\b/, dress: ['apron', 'rolled-sleeves'] }),
  Object.freeze({ pattern: /\b(?:innkeeper|vendor|cook)\b/, dress: ['apron'] }),
  Object.freeze({ pattern: /\b(?:craftsperson|weaver|carpenter|potter)\b/, dress: ['apron'] }),
  Object.freeze({ pattern: /\b(?:farmer|shepherd|herder)\b/, dress: ['rolled-sleeves'] }),
  Object.freeze({ pattern: /\b(?:clerk|keeper|signaller|station)\b/, dress: ['armband'] }),
  Object.freeze({ pattern: /\bporter\b/, dress: ['armband', 'satchel-strap', 'rolled-sleeves'] }),
  Object.freeze({ pattern: /\b(?:carter|driver|drover)\b/, dress: ['rolled-sleeves'] }),
  Object.freeze({ pattern: /\b(?:pedlar|courier|messenger|storyteller)\b/, dress: ['satchel-strap'] }),
  Object.freeze({ pattern: /\b(?:rambler|traveller)\b/, dress: ['satchel-strap'] }),
]);

/** Every piece of working kit this role implies, in a stable order. */
export function workDressForRole(role) {
  const text = String(role || '').toLocaleLowerCase();
  if (!text) return Object.freeze([]);
  const dress = new Set();
  for (const rule of WORK_DRESS_RULES) {
    if (rule.pattern.test(text)) for (const item of rule.dress) dress.add(item);
  }
  return Object.freeze([...dress].sort());
}

/**
 * Choose one resident's clothes.
 *
 * `presentation` leans the silhouette without deciding it: a skirt is more
 * likely at one end of the range and never exclusive to it, the same way the
 * hair rules work. `rng` is the identity's own stream, so a resident dresses
 * the same way every time the world is rebuilt.
 */
export function chooseNpcWardrobe({
  role = '',
  presentation = 0.5,
  family = 'storybook',
  age = 'adult',
  rng = () => 0.5,
} = {}) {
  // A robe is already a whole silhouette. Layering a waistcoat under it, or
  // trim onto it, would only be visible as z-fighting.
  if (family === 'cloaked') {
    return Object.freeze({
      garment: 'trousers',
      layer: 'none',
      workDress: Object.freeze([]),
      trim: Object.freeze({ collar: false, cuffs: false, hem: false }),
    });
  }

  const lean = clamp01(presentation);
  const garment = weighted(rng, [
    ['trousers', 1.6 - lean * 0.5],
    ['skirt', 0.25 + lean * 1.25],
    ['tunic', 0.55],
  ]);
  const layer = weighted(rng, [
    ['none', 2.4],
    ['waistcoat', 0.85],
    // A shawl is for the cold and for the old, in about equal measure.
    ['shawl', 0.2 + lean * 0.7 + (age === 'elder' ? 0.9 : 0)],
    ['coat', 0.55],
  ]);

  // Working kit is not a draw. It is what the job requires, minus the pieces
  // the rest of the outfit already rules out.
  const workDress = workDressForRole(role)
    .filter((item) => !(item === 'apron' && layer === 'coat'))
    .filter((item) => !(item === 'satchel-strap' && layer === 'shawl'));

  return Object.freeze({
    garment,
    layer,
    workDress: Object.freeze(workDress),
    // Contrast bands at the collar, cuffs and hem. Six palettes read as far
    // more than six outfits once a second colour is allowed to edge the first.
    trim: Object.freeze({
      collar: rng() < 0.34,
      cuffs: rng() < 0.28,
      hem: rng() < 0.24 && garment !== 'trousers',
    }),
  });
}

function weighted(rng, entries) {
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) return entries[0][0];
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= Math.max(0, weight);
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}
