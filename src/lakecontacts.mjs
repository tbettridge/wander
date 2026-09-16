// Explicit, terrain-owned transitions between fitted river reaches and lakes.
//
// Contacts are descriptive geometry. They do not lower a lake, extend its
// bounds, or condition terrain. In particular, lake membership always comes
// from wetBasinAt so a low but disconnected hollow cannot acquire a transition
// merely because it lies inside a basin's rectangular bounds.
import { wetBasinAt } from './basinmembership.mjs';

const EPSILON = 1e-9;
const DEFAULT_SAMPLE_STEP = 2;
const MAX_SAMPLE_STEP = 8;
const MAX_CONTACTS = 256;
const MAX_TRANSITION_LENGTH = 96;
const MAX_LATERAL_LENGTH = 48;

const finite = value => Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

function validBounds(bounds) {
  return bounds && [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(finite)
    && bounds.minX <= bounds.maxX && bounds.minZ <= bounds.maxZ;
}

function validGrid(grid, verifyValues = true) {
  const n = grid?.cols * grid?.rows;
  return grid && Number.isInteger(grid.cols) && Number.isInteger(grid.rows)
    && grid.cols >= 2 && grid.rows >= 2 && finite(grid.step) && grid.step > 0
    && finite(grid.x0) && finite(grid.z0) && Number.isSafeInteger(n)
    && grid.signed && grid.signed.length === n
    && (!verifyValues || [...grid.signed].every(finite));
}

function validBasin(basin, verifyGrid = true) {
  return basin && typeof basin.id === 'string' && basin.id.length > 0
    && finite(basin.level) && validBounds(basin.bounds) && validGrid(basin.grid, verifyGrid);
}

function validReach(reach) {
  return reach && reach.status === 'fitted' && typeof reach.id === 'string'
    && reach.id.length > 0 && Array.isArray(reach.points) && reach.points.length >= 2
    && validBounds(reach.bounds)
    && reach.points.every(point => point && [
      'x', 'z', 'tx', 'tz', 'arc', 'waterY', 'depth',
      'leftWidth', 'rightWidth', 'leftBankWidth', 'rightBankWidth',
      'leftBlendWidth', 'rightBlendWidth', 'leftBankY', 'rightBankY',
      'leftInner', 'rightInner', 'leftShoulder', 'rightShoulder',
    ].every(key => finite(point[key]))
      && Math.abs(Math.hypot(point.tx, point.tz) - 1) <= 1e-5);
}

function numberOr(value, fallback) {
  return finite(value) ? value : fallback;
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function interpolate(a, b, fraction) {
  const t = clamp(fraction, 0, 1);
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    arc: numberOr(a.arc, 0) + (numberOr(b.arc, numberOr(a.arc, 0) + pointDistance(a, b)) - numberOr(a.arc, 0)) * t,
    waterY: numberOr(a.waterY, 0) + (numberOr(b.waterY, numberOr(a.waterY, 0)) - numberOr(a.waterY, 0)) * t,
    tx: numberOr(a.tx, b.x - a.x) + (numberOr(b.tx, b.x - a.x) - numberOr(a.tx, b.x - a.x)) * t,
    tz: numberOr(a.tz, b.z - a.z) + (numberOr(b.tz, b.z - a.z) - numberOr(a.tz, b.z)) * t,
    depth: numberOr(a.depth, 0) + (numberOr(b.depth, numberOr(a.depth, 0)) - numberOr(a.depth, 0)) * t,
    leftWidth: numberOr(a.leftWidth, numberOr(a.width, 1)) + (numberOr(b.leftWidth, numberOr(b.width, 1)) - numberOr(a.leftWidth, numberOr(a.width, 1))) * t,
    rightWidth: numberOr(a.rightWidth, numberOr(a.width, 1)) + (numberOr(b.rightWidth, numberOr(b.width, 1)) - numberOr(a.rightWidth, numberOr(a.width, 1))) * t,
    leftBankWidth: numberOr(a.leftBankWidth, 0) + (numberOr(b.leftBankWidth, 0) - numberOr(a.leftBankWidth, 0)) * t,
    rightBankWidth: numberOr(a.rightBankWidth, 0) + (numberOr(b.rightBankWidth, 0) - numberOr(a.rightBankWidth, 0)) * t,
    leftBlendWidth: numberOr(a.leftBlendWidth, 0) + (numberOr(b.leftBlendWidth, 0) - numberOr(a.leftBlendWidth, 0)) * t,
    rightBlendWidth: numberOr(a.rightBlendWidth, 0) + (numberOr(b.rightBlendWidth, 0) - numberOr(a.rightBlendWidth, 0)) * t,
    leftBankY: numberOr(a.leftBankY, numberOr(a.waterY, 0)) + (numberOr(b.leftBankY, numberOr(b.waterY, 0)) - numberOr(a.leftBankY, numberOr(a.waterY, 0))) * t,
    rightBankY: numberOr(a.rightBankY, numberOr(a.waterY, 0)) + (numberOr(b.rightBankY, numberOr(b.waterY, 0)) - numberOr(a.rightBankY, numberOr(a.waterY, 0))) * t,
    leftInner: numberOr(a.leftInner, 0.5) + (numberOr(b.leftInner, 0.5) - numberOr(a.leftInner, 0.5)) * t,
    rightInner: numberOr(a.rightInner, 0.5) + (numberOr(b.rightInner, 0.5) - numberOr(a.rightInner, 0.5)) * t,
    leftShoulder: numberOr(a.leftShoulder, 0.3) + (numberOr(b.leftShoulder, 0.3) - numberOr(a.leftShoulder, 0.3)) * t,
    rightShoulder: numberOr(a.rightShoulder, 0.3) + (numberOr(b.rightShoulder, 0.3) - numberOr(a.rightShoulder, 0.3)) * t,
  };
}

function normalizeTangent(section, a, b) {
  let tx = section.tx, tz = section.tz;
  let length = Math.hypot(tx, tz);
  if (length < EPSILON) {
    tx = b.x - a.x; tz = b.z - a.z;
    length = Math.hypot(tx, tz);
  }
  if (length < EPSILON) return { x: 1, z: 0 };
  return { x: tx / length, z: tz / length };
}

function channelHalfWidth(section) {
  return Math.max(0.25, numberOr(section.leftWidth, 1), numberOr(section.rightWidth, 1));
}

function sectionArc(points, index, fraction) {
  const a = points[index - 1], b = points[index];
  const aArc = finite(a.arc) ? a.arc : 0;
  const bArc = finite(b.arc) ? b.arc : aArc + pointDistance(a, b);
  return aArc + (bArc - aArc) * fraction;
}

function samplePointOnSegment(a, b, index, fraction) {
  const section = interpolate(a, b, fraction);
  const tangent = normalizeTangent(section, a, b);
  const lateral = Math.max(channelHalfWidth(section), 0.5);
  const candidates = [0, -lateral * 0.5, lateral * 0.5, -lateral, lateral];
  return { ...section, tangent, sectionIndex: index, fraction, arc: sectionArc([a, b], 1, fraction), candidates };
}

function wetAt(basin, x, z) {
  // Keep the call in one place: this is the ownership boundary for every
  // contact and transition sample. A malformed grid is handled by the caller.
  return wetBasinAt([basin], x, z)?.id === basin.id;
}

function witnessAt(basin, sample) {
  const { x, z, tangent, candidates } = sample;
  for (const lateral of candidates) {
    const px = x - tangent.z * lateral;
    const pz = z + tangent.x * lateral;
    if (wetAt(basin, px, pz)) return { x: px, z: pz, lateral };
  }
  return null;
}

function transitionSamples(reach, basin, sampleStep) {
  const points = reach.points, samples = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], length = pointDistance(a, b);
    if (length < EPSILON) continue;
    const count = Math.max(1, Math.ceil(length / sampleStep));
    for (let k = 0; k <= count; k++) {
      // Segment boundaries are intentionally repeated. Removing them based
      // on floating point equality can make a contact depend on segmentation.
      if (index > 1 && k === 0) continue;
      const fraction = k / count;
      const sample = samplePointOnSegment(a, b, index, fraction);
      const centerWet = wetAt(basin, sample.x, sample.z);
      const witness = centerWet ? { x: sample.x, z: sample.z, lateral: 0 } : witnessAt(basin, sample);
      samples.push({ ...sample, centerWet, wet: Boolean(witness), witness });
    }
  }
  return samples;
}

function boundaryBetween(a, b, basin, beforeWet, sampleStep) {
  let lo = a, hi = b;
  // A membership boundary is a triangle interpolation boundary. Bisection on
  // the authoritative wet query gives a stable point without making terrain
  // assumptions about the basin's shape or connected lobes.
  for (let i = 0; i < 34; i++) {
    const span = pointDistance(lo, hi);
    if (span <= Math.max(1e-6, sampleStep * 1e-5)) break;
    const fraction = 0.5;
    const mid = {
      ...interpolate(lo, hi, fraction),
      tangent: normalizeTangent(interpolate(lo, hi, fraction), lo, hi),
    };
    const midWet = Boolean(witnessAt(basin, {
      x: mid.x, z: mid.z, tangent: mid.tangent,
      candidates: [0, -channelHalfWidth(mid) * 0.5, channelHalfWidth(mid) * 0.5,
        -channelHalfWidth(mid), channelHalfWidth(mid)],
    }));
    if (midWet === beforeWet) lo = mid;
    else hi = mid;
  }
  const point = interpolate(lo, hi, 0.5);
  const tangent = normalizeTangent(point, lo, hi);
  return { ...point, tangent, witness: witnessAt(basin, {
    x: point.x, z: point.z, tangent,
    candidates: [0, -channelHalfWidth(point) * 0.5, channelHalfWidth(point) * 0.5,
      -channelHalfWidth(point), channelHalfWidth(point)],
  }) };
}

function headAtContact(reach, basin, boundary, tolerance) {
  // The fitted reach's section heads are interpolated at the actual crossing;
  // descriptor waterY is published only after this agrees with the lake head.
  if (!finite(boundary.waterY) || Math.abs(boundary.waterY - basin.level) > tolerance) return false;
  return true;
}

function profileFor(boundary) {
  const leftWidth = Math.max(0.25, numberOr(boundary.leftWidth, 1));
  const rightWidth = Math.max(0.25, numberOr(boundary.rightWidth, 1));
  const leftBankWidth = Math.max(0, numberOr(boundary.leftBankWidth, 0));
  const rightBankWidth = Math.max(0, numberOr(boundary.rightBankWidth, 0));
  const leftBlendWidth = Math.max(0, numberOr(boundary.leftBlendWidth, 0));
  const rightBlendWidth = Math.max(0, numberOr(boundary.rightBlendWidth, 0));
  return {
    depth: Math.max(0, numberOr(boundary.depth, 0)),
    leftWidth, rightWidth, leftBankWidth, rightBankWidth,
    leftBlendWidth, rightBlendWidth,
    leftBankY: numberOr(boundary.leftBankY, boundary.waterY),
    rightBankY: numberOr(boundary.rightBankY, boundary.waterY),
    leftInner: clamp(numberOr(boundary.leftInner, 0.5), 0, 1),
    rightInner: clamp(numberOr(boundary.rightInner, 0.5), 0, 1),
    leftShoulder: clamp(numberOr(boundary.leftShoulder, 0.3), 0, 1),
    rightShoulder: clamp(numberOr(boundary.rightShoulder, 0.3), 0, 1),
    totalWidth: leftWidth + rightWidth,
    channelHalfWidth: Math.max(leftWidth, rightWidth),
  };
}

function transitionExtent(profile, role) {
  const channel = Math.max(profile.channelHalfWidth, profile.totalWidth * 0.5);
  const bankEnvelope = Math.max(
    profile.leftWidth + profile.leftBankWidth + profile.leftBlendWidth,
    profile.rightWidth + profile.rightBankWidth + profile.rightBlendWidth,
  );
  const approach = clamp(4 + channel * 2.5, 8, MAX_TRANSITION_LENGTH);
  const openWater = clamp(8 + channel * 4, 12, MAX_TRANSITION_LENGTH);
  const lateral = clamp(Math.max(bankEnvelope, channel + 3), 4, MAX_LATERAL_LENGTH);
  return role === 'inlet'
    ? { upstream: approach, downstream: openWater, lateral, total: approach + openWater }
    : { upstream: openWater, downstream: approach, lateral, total: approach + openWater };
}

function contactBounds(position, tangent, extent) {
  const longitudinal = Math.max(extent.upstream, extent.downstream);
  const minX = position.x - Math.abs(tangent.x) * longitudinal - Math.abs(tangent.z) * extent.lateral;
  const maxX = position.x + Math.abs(tangent.x) * longitudinal + Math.abs(tangent.z) * extent.lateral;
  const minZ = position.z - Math.abs(tangent.z) * longitudinal - Math.abs(tangent.x) * extent.lateral;
  const maxZ = position.z + Math.abs(tangent.z) * longitudinal + Math.abs(tangent.x) * extent.lateral;
  return { minX, minZ, maxX, maxZ };
}

function flowSpeed(reach, samples, index) {
  const sample = samples[index], previous = samples[Math.max(0, index - 1)], next = samples[Math.min(samples.length - 1, index + 1)];
  const before = previous?.waterY, after = next?.waterY;
  const distance = previous && next ? Math.max(EPSILON, pointDistance(previous, next)) : 0;
  const slope = finite(before) && finite(after) && distance > EPSILON ? Math.max(0, (before - after) / distance) : 0;
  // Match RiverReachField's stable minimum current for flat fitted sections;
  // the transition only attenuates this existing reach flow.
  return clamp(slope * 16, 0.12, 0.7);
}

function makeContact(reach, basin, boundary, role, ordinal, samples, sampleIndex, headTolerance) {
  if (!headAtContact(reach, basin, boundary, headTolerance)) return null;
  const tangent = boundary.tangent;
  const profile = profileFor(boundary);
  const extent = transitionExtent(profile, role);
  const position = { x: boundary.x, z: boundary.z };
  const speed = flowSpeed(reach, samples, sampleIndex);
  const ownershipKey = `${basin.id}|${reach.id}`;
  const id = `lake-contact:${basin.id}:${reach.id}:${role}:${ordinal}`;
  return {
    id, lakeId: basin.id, reachId: reach.id, role,
    position, tangent: { x: tangent.x, z: tangent.z },
    arc: finite(boundary.arc) ? boundary.arc : 0,
    sectionIndex: boundary.sectionIndex ?? null,
    sectionFraction: finite(boundary.fraction) ? boundary.fraction : 0.5,
    lakeHead: basin.level, waterY: basin.level,
    channelProfile: profile,
    transitionExtent: extent,
    bounds: contactBounds(position, tangent, extent),
    flowSpeed: speed,
    flow: { x: tangent.x * speed, z: tangent.z * speed },
    // A contact owns one lake/reach pair. The ID is unique even if a valid
    // through-flow reach contributes one inlet and one outlet.
    ownerId: id,
    ownershipKey,
    ownership: { ownerId: id, lakeId: basin.id, reachId: reach.id, key: ownershipKey },
    connectedWet: true,
    membership: 'wetBasinAt',
  };
}

function collectContactsForPair(reach, basin, options) {
  const samples = transitionSamples(reach, basin, options.sampleStep);
  if (samples.length < 2) return [];
  const contacts = [], seenRoles = new Map();
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], after = samples[i];
    if (before.wet === after.wet) continue;
    const role = before.wet ? 'outlet' : 'inlet';
    const boundary = boundaryBetween(before, after, basin, before.wet, options.sampleStep);
    boundary.sectionIndex = after.sectionIndex;
    boundary.fraction = after.fraction;
    const prior = seenRoles.get(role);
    // A narrow shoreline contact can be witnessed by two neighbouring lateral
    // samples. Keep one deterministic contact per role and pair, while still
    // allowing a true through-flow to have an inlet and an outlet.
    if (prior && Math.abs(prior.arc - boundary.arc) <= Math.max(2, options.sampleStep * 2)) continue;
    const contact = makeContact(reach, basin, boundary, role, (seenRoles.get(role)?.ordinal || 0), samples, i, options.headTolerance);
    if (!contact) continue;
    contact.sectionIndex = after.sectionIndex;
    contact.sectionFraction = after.fraction;
    contacts.push(contact);
    seenRoles.set(role, { arc: contact.arc, ordinal: contact.ordinal ?? contacts.length - 1 });
  }
  return contacts.sort((a, b) => a.arc - b.arc || a.role.localeCompare(b.role));
}

function normalizeInputs(reaches, basins) {
  if (!Array.isArray(reaches) && reaches && Array.isArray(reaches.reaches)) {
    basins = Array.isArray(reaches.basins) ? reaches.basins : basins;
    reaches = reaches.reaches;
  }
  if (!Array.isArray(reaches) || !Array.isArray(basins)) throw new Error('Invalid lake contact inputs');
  if (reaches.some(reach => !validReach(reach))) {
    return { error: 'invalid-fitted-reach' };
  }
  if (basins.some(basin => !validBasin(basin))) return { error: 'invalid-lake-membership' };
  const fitted = reaches;
  if (new Set(fitted.map(reach => reach.id)).size !== fitted.length) return { error: 'duplicate-reach-id' };
  if (new Set(basins.map(basin => basin.id)).size !== basins.length) return { error: 'duplicate-lake-id' };
  return {
    reaches: [...fitted].sort((a, b) => a.id.localeCompare(b.id)),
    basins: [...basins].filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

export function buildLakeRiverContacts(reaches, basins, {
  sampleStep = DEFAULT_SAMPLE_STEP,
  maxContacts = MAX_CONTACTS,
  headTolerance = 1e-6,
} = {}) {
  if (!finite(sampleStep) || sampleStep <= 0 || sampleStep > MAX_SAMPLE_STEP
    || !Number.isInteger(maxContacts) || maxContacts < 1 || maxContacts > MAX_CONTACTS
    || !finite(headTolerance) || headTolerance < 0 || headTolerance > 1) {
    throw new Error('Invalid lake contact budget');
  }
  const inputs = normalizeInputs(reaches, basins);
  if (inputs.error) return { status: 'rejected', reason: inputs.error, contacts: [] };
  const contacts = [];
  try {
    for (const reach of inputs.reaches) {
      for (const basin of inputs.basins) {
        const pair = collectContactsForPair(reach, basin, { sampleStep, headTolerance });
        contacts.push(...pair);
        if (contacts.length > maxContacts) return { status: 'rejected', reason: 'lake-contact-budget', contacts: [] };
      }
    }
  } catch (error) {
    if (error?.message === 'Overlapping lake ownership') {
      return { status: 'rejected', reason: 'overlapping-lake-ownership', contacts: [] };
    }
    throw error;
  }
  contacts.sort((a, b) => a.lakeId.localeCompare(b.lakeId) || a.reachId.localeCompare(b.reachId)
    || a.arc - b.arc || a.role.localeCompare(b.role));
  // Re-number after sorting so IDs do not depend on the order in which a
  // caller supplied reaches or basins.
  const counters = new Map();
  for (const contact of contacts) {
    const key = `${contact.lakeId}|${contact.reachId}|${contact.role}`;
    const ordinal = counters.get(key) || 0;
    counters.set(key, ordinal + 1);
    contact.id = `lake-contact:${contact.lakeId}:${contact.reachId}:${contact.role}:${ordinal}`;
    contact.ownerId = contact.id;
    contact.ownership.ownerId = contact.id;
    contact.ownershipKey = `${contact.lakeId}|${contact.reachId}`;
    contact.ownership.key = contact.ownershipKey;
  }
  const ownership = Object.fromEntries(contacts.map(contact => [contact.id, {
    ownerId: contact.ownerId, lakeId: contact.lakeId, reachId: contact.reachId,
    role: contact.role, key: contact.ownershipKey,
  }]));
  return {
    status: 'built', contacts, ownership,
    lakeIds: [...new Set(contacts.map(contact => contact.lakeId))],
    reachIds: [...new Set(contacts.map(contact => contact.reachId))],
  };
}

export function sampleLakeRiverTransition(contact, basin, x, z, out = {}) {
  if (!contact || !validBasin(basin, false) || basin.id !== contact.lakeId
    || !finite(x) || !finite(z) || !validBounds(contact.bounds)
    || !contact.position || !finite(contact.position.x) || !finite(contact.position.z)
    || !contact.tangent || !finite(contact.tangent.x) || !finite(contact.tangent.z)) return false;
  const tangentLength = Math.hypot(contact.tangent.x, contact.tangent.z);
  if (tangentLength < EPSILON) return false;
  const tx = contact.tangent.x / tangentLength, tz = contact.tangent.z / tangentLength;
  const extent = contact.transitionExtent;
  if (!extent || ![extent.upstream, extent.downstream, extent.lateral].every(finite)
    || extent.upstream < 0 || extent.downstream < 0 || extent.lateral < 0) return false;
  const dx = x - contact.position.x, dz = z - contact.position.z;
  const longitudinal = dx * tx + dz * tz;
  const lateral = -dx * tz + dz * tx;
  if (longitudinal < -extent.upstream - 1e-7 || longitudinal > extent.downstream + 1e-7
    || Math.abs(lateral) > extent.lateral + 1e-7) return false;
  // A rectangular transition envelope is only a candidate region. The
  // connected wet query is what grants it ownership and prevents dry shore
  // erasure or false contacts in an unconnected low hollow.
  if (!wetAt(basin, x, z)) return false;
  const profile = contact.channelProfile || {};
  const channel = Math.max(0.25, numberOr(profile.channelHalfWidth,
    Math.max(numberOr(profile.leftWidth, 1), numberOr(profile.rightWidth, 1))));
  const attenuation = contact.role === 'inlet'
    ? (longitudinal <= 0 ? 0 : smoothstep(0, Math.max(EPSILON, extent.downstream), longitudinal))
    : (longitudinal >= 0 ? 0 : 1 - smoothstep(-Math.max(EPSILON, extent.upstream), 0, longitudinal));
  const bankTaper = contact.role === 'inlet'
    ? (longitudinal <= 0 ? 0 : smoothstep(0, Math.max(EPSILON, extent.downstream), longitudinal))
    : (longitudinal >= 0 ? 0 : 1 - smoothstep(-Math.max(EPSILON, extent.upstream), 0, longitudinal));
  const speed = clamp(numberOr(contact.flowSpeed, 0.12), 0, 0.7);
  const transmission = 1 - attenuation;
  const bankDistance = Math.max(0, Math.abs(lateral) - channel);
  const lateralTaper = 1 - smoothstep(0, Math.max(1, extent.lateral - channel), bankDistance);
  const turbulence = clamp(numberOr(contact.turbulence, 0.15) * (1 - 0.75 * bankTaper)
    * lateralTaper, 0, 1);
  Object.assign(out, {
    active: true, wet: true, inLake: true, bodyKind: basin.kind || 'lake', bodyId: basin.id,
    lakeId: basin.id, reachId: contact.reachId, contactId: contact.id, role: contact.role,
    waterY: basin.level, head: basin.level,
    bankTaper, flowAttenuation: attenuation, flowTransmission: transmission,
    flowX: tx * speed * transmission * lateralTaper,
    flowZ: tz * speed * transmission * lateralTaper,
    turbulence, transitionLongitudinal: longitudinal, transitionLateral: lateral,
  });
  return true;
}
