/**
 * Pure family-frontage contract.
 *
 * WP0 deliberately contains no catalog, visual values, selection, or spatial
 * placement. The records below are the seam that the later visual catalog and
 * planner will consume. Keep these records serializable: frontage is regenerated
 * from the current settlement plan and is never living-world save state.
 */

export const FAMILY_FRONTAGE_VERSION = 1;

/** Programs that may be owned by a household. Civic buildings are excluded. */
export const FAMILY_OWNED_PROGRAMS = Object.freeze([
  'dwelling', 'barn', 'workshop', 'inn', 'smithy', 'granary',
]);

export const FAMILY_FRONTAGE_CHANNELS = Object.freeze([
  'palette', 'mark', 'mark-treatment', 'yard-habit', 'boundary-habit',
  'garden-habit', 'material-habit', 'facade-application', 'mark-mount',
  'yard-zone-order', 'service-variant', 'element-variant',
]);

/**
 * Semantic placeholders freeze the shape without pretending that a visual
 * catalog has been authored. Sol replaces these IDs in the later package.
 */
export const FAMILY_FRONTAGE_PLACEHOLDER_IDS = Object.freeze({
  paletteId: 'placeholder:family-palette:v1',
  markId: 'placeholder:family-mark:v1',
  markTreatmentId: 'placeholder:family-mark-treatment:v1',
  yardHabitId: 'placeholder:family-yard-habit:v1',
  boundaryHabitId: 'placeholder:family-boundary-habit:v1',
  gardenHabitId: 'placeholder:family-garden-habit:v1',
  materialHabitId: 'placeholder:family-material-habit:v1',
  facadeTreatmentId: 'placeholder:facade-treatment:v1',
  trimTargetId: 'placeholder:trim-target:v1',
  doorTreatmentId: 'placeholder:door-treatment:v1',
  elementVariantId: 'placeholder:element-variant:v1',
  markMountId: 'placeholder:mark-mount:v1',
  serviceCueId: 'placeholder:service-cue:v1',
});

/** Metadata required from a future visual catalog for each semantic asset ID. */
export const FAMILY_FRONTAGE_ASSET_METADATA_SCHEMA = Object.freeze({
  version: FAMILY_FRONTAGE_VERSION,
  fields: Object.freeze([
    'id', 'version', 'programs', 'zones', 'halfExtents', 'height', 'clearance',
    'slopeTolerance', 'reliefTolerance', 'wallAttached', 'groundSeated',
    'collider', 'meshBudget', 'groundCover',
  ]),
});

function requiredId(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty ID.`);
  return value;
}

function idFor(suffix, value) {
  return `${requiredId(value, suffix)}:family-frontage:v${FAMILY_FRONTAGE_VERSION}`;
}

export function familyFrontageProfileId(householdId) {
  return idFor('householdId', householdId);
}

export function buildingFamilyFrontageId(buildingId) {
  return idFor('buildingId', buildingId);
}

/**
 * Create a contract-shaped profile using only semantic placeholders.
 * This is a fixture/compatibility helper, not the future visual selector.
 */
export function createFamilyFrontageProfile({
  householdId,
  surname,
  homeBuildingId,
  ownedBuildingIds = [],
  seed = 0,
  placeholders = FAMILY_FRONTAGE_PLACEHOLDER_IDS,
} = {}) {
  requiredId(householdId, 'householdId');
  requiredId(surname, 'surname');
  requiredId(homeBuildingId, 'homeBuildingId');
  if (!Array.isArray(ownedBuildingIds) || ownedBuildingIds.some((id) => typeof id !== 'string' || !id)) {
    throw new TypeError('ownedBuildingIds must be an array of non-empty IDs.');
  }
  return Object.freeze({
    version: FAMILY_FRONTAGE_VERSION,
    id: familyFrontageProfileId(householdId),
    householdId,
    surname,
    homeBuildingId,
    ownedBuildingIds: Object.freeze([...ownedBuildingIds]),
    seed: Number(seed) >>> 0,
    paletteId: requiredId(placeholders.paletteId, 'paletteId'),
    markId: requiredId(placeholders.markId, 'markId'),
    markTreatmentId: requiredId(placeholders.markTreatmentId, 'markTreatmentId'),
    yardHabitId: requiredId(placeholders.yardHabitId, 'yardHabitId'),
    boundaryHabitId: requiredId(placeholders.boundaryHabitId, 'boundaryHabitId'),
    gardenHabitId: requiredId(placeholders.gardenHabitId, 'gardenHabitId'),
    materialHabitId: requiredId(placeholders.materialHabitId, 'materialHabitId'),
  });
}

/**
 * Create one building application with no attachments or yard placement yet.
 * The empty arrays are intentional: WP2 will populate them from Sol metadata.
 */
export function createBuildingFamilyFrontage({
  buildingId,
  householdId,
  profileId = familyFrontageProfileId(householdId),
  program,
  placeholders = FAMILY_FRONTAGE_PLACEHOLDER_IDS,
} = {}) {
  requiredId(buildingId, 'buildingId');
  requiredId(householdId, 'householdId');
  requiredId(profileId, 'profileId');
  if (!FAMILY_OWNED_PROGRAMS.includes(program)) throw new TypeError(`Unsupported family-owned program: ${program}`);
  return Object.freeze({
    version: FAMILY_FRONTAGE_VERSION,
    id: buildingFamilyFrontageId(buildingId),
    buildingId,
    householdId,
    profileId,
    role: program === 'dwelling' ? 'home' : 'business',
    program,
    application: Object.freeze({
      facadeTreatmentId: requiredId(placeholders.facadeTreatmentId, 'facadeTreatmentId'),
      trimTargetId: requiredId(placeholders.trimTargetId, 'trimTargetId'),
      doorTreatmentId: requiredId(placeholders.doorTreatmentId, 'doorTreatmentId'),
      elementVariantId: requiredId(placeholders.elementVariantId, 'elementVariantId'),
      markMountId: requiredId(placeholders.markMountId, 'markMountId'),
      serviceCueId: program === 'dwelling' ? null : requiredId(placeholders.serviceCueId, 'serviceCueId'),
    }),
    attachments: Object.freeze([]),
    yardElements: Object.freeze([]),
    omittedReasons: Object.freeze([]),
  });
}

/**
 * Validate the serializable contract without knowing Sol's eventual catalog.
 * Visual IDs are intentionally only checked for identity shape here.
 */
export function validateFamilyFrontagePlan({ familyFrontageProfiles = [], familyFrontages = [] } = {}) {
  const errors = [];
  if (!Array.isArray(familyFrontageProfiles)) errors.push('profiles-not-array');
  if (!Array.isArray(familyFrontages)) errors.push('frontages-not-array');
  if (errors.length) return { valid: false, errors };

  const profiles = new Map();
  const buildings = new Map();
  for (const profile of familyFrontageProfiles) {
    if (!profile || profile.version !== FAMILY_FRONTAGE_VERSION) errors.push('profile-version');
    if (!profile?.id || !profile?.householdId || !profile?.surname || !profile?.homeBuildingId) errors.push('profile-identity');
    if (profiles.has(profile?.id)) errors.push(`duplicate-profile:${profile.id}`);
    else if (profile?.id) profiles.set(profile.id, profile);
    if (!Array.isArray(profile?.ownedBuildingIds)) errors.push(`profile-buildings:${profile?.id || 'unknown'}`);
    else if (!profile.ownedBuildingIds.includes(profile.homeBuildingId)) errors.push(`profile-home:${profile.id}`);
    for (const key of ['paletteId', 'markId', 'markTreatmentId', 'yardHabitId', 'boundaryHabitId', 'gardenHabitId', 'materialHabitId']) {
      if (!profile?.[key]) errors.push(`profile-${key}:${profile?.id || 'unknown'}`);
    }
  }
  for (const frontage of familyFrontages) {
    if (!frontage || frontage.version !== FAMILY_FRONTAGE_VERSION) errors.push('frontage-version');
    if (!frontage?.id || !frontage?.buildingId || !frontage?.householdId || !frontage?.profileId) errors.push('frontage-identity');
    if (buildings.has(frontage?.buildingId)) errors.push(`duplicate-frontage:${frontage.buildingId}`);
    else if (frontage?.buildingId) buildings.set(frontage.buildingId, frontage);
    if (frontage?.profileId && !profiles.has(frontage.profileId)) errors.push(`orphan-profile:${frontage.profileId}`);
    if (!['home', 'business'].includes(frontage?.role)) errors.push(`frontage-role:${frontage?.id || 'unknown'}`);
    if (!FAMILY_OWNED_PROGRAMS.includes(frontage?.program)) errors.push(`frontage-program:${frontage?.id || 'unknown'}`);
    const application = frontage?.application;
    for (const key of ['facadeTreatmentId', 'trimTargetId', 'doorTreatmentId', 'elementVariantId', 'markMountId']) {
      if (!application?.[key]) errors.push(`frontage-${key}:${frontage?.id || 'unknown'}`);
    }
    if (frontage?.program === 'dwelling' && application?.serviceCueId !== null) errors.push(`home-service-cue:${frontage.id}`);
    if (frontage?.program !== 'dwelling' && !application?.serviceCueId) errors.push(`business-service-cue:${frontage?.id || 'unknown'}`);
    if (!Array.isArray(frontage?.attachments)) errors.push(`attachments:${frontage?.id || 'unknown'}`);
    if (!Array.isArray(frontage?.yardElements)) errors.push(`yard-elements:${frontage?.id || 'unknown'}`);
  }
  for (const frontage of familyFrontages) {
    const profile = profiles.get(frontage.profileId);
    if (profile && profile.householdId !== frontage.householdId) errors.push(`household-mismatch:${frontage.id}`);
    if (profile && !profile.ownedBuildingIds.includes(frontage.buildingId)) errors.push(`unlisted-building:${frontage.id}`);
  }
  return { valid: errors.length === 0, errors };
}
