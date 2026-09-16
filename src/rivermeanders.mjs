/*
 * A bounded, terrain-aware centreline proposal.  This module deliberately
 * stops before hydraulic fitting or baking: the river fitter remains the
 * authority for levels, banks, and final terrain acceptance.
 */

import { channelProfileHalfWidthBound } from './rivercharacter.mjs';

const MIN_SAMPLE_SPACING = 24;
const TARGET_SAMPLE_SPACING = 32;
const MAX_SAMPLES = 512;
const MIN_REACH_LENGTH = 288;
const MIN_BEND_SPAN = 192;
const EPSILON = 1e-7;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function finite(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random01(seed, salt) {
  let value = hash32(`${seed}|${salt}`) + 0x9e3779b9;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function unit(x, z, fallback = { x: 1, z: 0 }) {
  const length = Math.hypot(x, z);
  return length > EPSILON ? { x: x / length, z: z / length } : fallback;
}

function terrainHeight(world, x, z) {
  return world?._naturalHeight?.(x, z) ?? NaN;
}

function cumulativeArc(points) {
  const arcs = [0];
  for (let i = 1; i < points.length; i++) {
    arcs.push(arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x,
      points[i].z - points[i - 1].z));
  }
  return arcs;
}

function routeValues(route) {
  if (!Array.isArray(route?.points) || route.points.length < 2) return null;
  const points = route.points;
  if (points.some(point => !point || ![point.x, point.z].every(Number.isFinite))) return null;
  const arcs = cumulativeArc(points);
  if (arcs.some((arc, index) => index && arc - arcs[index - 1] < EPSILON)) return null;
  const levels = points.map(point => finite(point.waterY, finite(point.preferredY, 0)));
  const preferred = points.map((point, index) => finite(point.preferredY, levels[index]));
  return { points, arcs, levels, preferred, length: arcs.at(-1) };
}

function tangentAt(values, distance) {
  const { points, arcs } = values;
  if (distance <= 0) return unit(points[1].x - points[0].x, points[1].z - points[0].z);
  if (distance >= values.length) {
    const a = points.at(-2), b = points.at(-1);
    return unit(b.x - a.x, b.z - a.z);
  }
  let hi = 1;
  while (hi < arcs.length - 1 && arcs[hi] < distance - EPSILON) hi++;
  const left = Math.max(0, hi - 1), right = Math.min(points.length - 1, hi);
  let tangent = unit(points[right].x - points[left].x, points[right].z - points[left].z);
  // A node tangent is the bisector of its adjacent route segments.  This
  // keeps a normal from jumping when 64 m routing nodes are resampled.
  if (right > 0 && right < points.length - 1 && Math.abs(arcs[right] - distance) < 1e-5) {
    const before = unit(points[right].x - points[right - 1].x, points[right].z - points[right - 1].z);
    const after = unit(points[right + 1].x - points[right].x, points[right + 1].z - points[right].z);
    tangent = unit(before.x + after.x, before.z + after.z, after);
  }
  return tangent;
}

function samplePolyline(values, distance) {
  const { points, arcs, levels, preferred } = values;
  const s = clamp(distance, 0, values.length);
  let hi = 1;
  while (hi < arcs.length - 1 && arcs[hi] < s - EPSILON) hi++;
  const left = Math.max(0, hi - 1), right = Math.min(points.length - 1, hi);
  const span = Math.max(EPSILON, arcs[right] - arcs[left]);
  const t = clamp((s - arcs[left]) / span, 0, 1);
  const tangent = tangentAt(values, s);
  return {
    x: lerp(points[left].x, points[right].x, t),
    z: lerp(points[left].z, points[right].z, t),
    waterY: lerp(levels[left], levels[right], t),
    preferredY: lerp(preferred[left], preferred[right], t),
    tangent,
    normal: { x: -tangent.z, z: tangent.x },
    left,
    right,
    t,
  };
}

function sourceIndexAtArc(arcs, distance) {
  let lo = 0, hi = arcs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arcs[mid] < distance) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arcs[lo - 1] - distance) < Math.abs(arcs[lo] - distance)) lo--;
  return Math.abs(arcs[lo] - distance) < 1e-5 ? lo : -1;
}

function stationArcs(values, startCollar, endCollar, maxSamples) {
  const count = Math.min(maxSamples, Math.max(2,
    Math.ceil(values.length / TARGET_SAMPLE_SPACING) + 1));
  const spacing = values.length / Math.max(1, count - 1);
  const stations = Array.from({ length: count }, (_, index) => index * spacing);
  // Keep genuine routing turns in a collar. This preserves the tangent that a
  // later Hermite fitter sees while still collapsing a 4 m oversampled route.
  const roomForTurns = count < maxSamples - 4;
  if (roomForTurns) for (let i = 1; i < values.points.length - 1; i++) {
    const point = values.points[i], arc = values.arcs[i];
    const nearStartCollar = startCollar >= 64 && arc <= startCollar + 36;
    const nearEndCollar = endCollar >= 64 && arc >= values.length - endCollar - 36;
    if (!nearStartCollar && !nearEndCollar) continue;
    const before = unit(point.x - values.points[i - 1].x, point.z - values.points[i - 1].z);
    const after = unit(values.points[i + 1].x - point.x, values.points[i + 1].z - point.z);
    if (before.x * after.x + before.z * after.z < 0.995) stations.push(arc);
  }
  stations.sort((a, b) => a - b);
  if (stations.length > maxSamples) {
    return Array.from({ length: maxSamples }, (_, index) =>
      values.length * index / Math.max(1, maxSamples - 1));
  }
  return stations.filter((arc, index) => !index || arc - stations[index - 1] > 1e-5);
}

function scalarAt(arcs, values, distance) {
  if (distance <= arcs[0]) return values[0];
  if (distance >= arcs.at(-1)) return values.at(-1);
  let hi = 1;
  while (hi < arcs.length - 1 && arcs[hi] < distance) hi++;
  const lo = hi - 1, t = (distance - arcs[lo]) / Math.max(EPSILON, arcs[hi] - arcs[lo]);
  return lerp(values[lo], values[hi], smoothstep(0, 1, t));
}

function profileWidth(profile) {
  if (!profile) return 4 * 1.12 * 1.12;
  // Include the full trend, noise and outer-bank widening, not only the mean
  // half-width: distant portions of a bend must not fold their wider banks.
  return channelProfileHalfWidthBound(profile);
}

function contactNodes(segmented) {
  const junctions = Array.isArray(segmented.junctions) ? segmented.junctions : [];
  const ids = new Set(junctions.map(junction => junction?.nodeId ?? junction?.id).filter(Boolean));
  const lakeIds = new Set();
  for (const junction of junctions) {
    const kind = String(junction?.kind ?? junction?.type ?? '').toLowerCase();
    if (kind === 'lake' || kind === 'pond' || kind === 'basin'
      || junction?.basinId || junction?.lakeId) {
      if (junction.nodeId) lakeIds.add(junction.nodeId);
    }
  }
  return { junctions, ids, lakeIds };
}

function endpointMatches(endpoint, junctions, ids) {
  if (endpoint?.id && ids.has(endpoint.id)) return true;
  return junctions.some(junction => Number.isFinite(junction?.x) && Number.isFinite(junction?.z)
    && Math.hypot(junction.x - endpoint.x, junction.z - endpoint.z) < 1e-5);
}

function endpointHasLakeContact(route, endpoint, junctions, lakeIds) {
  if (route.basinId || route.basinIds?.length || endpoint?.basinId) return true;
  return endpoint?.id ? lakeIds.has(endpoint.id) : junctions.some(junction =>
    junction?.basinId && Math.hypot(junction.x - endpoint.x, junction.z - endpoint.z) < 1e-5);
}

function corridorTerrain(world, sample, footprint) {
  const center = terrainHeight(world, sample.x, sample.z);
  if (!Number.isFinite(center)) return null;
  const step = 8;
  const alongA = terrainHeight(world, sample.x - sample.tangent.x * step,
    sample.z - sample.tangent.z * step);
  const alongB = terrainHeight(world, sample.x + sample.tangent.x * step,
    sample.z + sample.tangent.z * step);
  const acrossA = terrainHeight(world, sample.x - sample.normal.x * step,
    sample.z - sample.normal.z * step);
  const acrossB = terrainHeight(world, sample.x + sample.normal.x * step,
    sample.z + sample.normal.z * step);
  const localSlope = [alongA, alongB, acrossA, acrossB].every(Number.isFinite)
    ? Math.max(Math.abs(alongA - alongB), Math.abs(acrossA - acrossB)) / (step * 2)
    : 1;
  const radii = [footprint + 8, footprint + 20, footprint + 34, footprint + 50];
  let lateralSlope = 0, wideRelief = 0, clearance = 80;
  for (const radius of radii) {
    const left = terrainHeight(world, sample.x + sample.normal.x * radius,
      sample.z + sample.normal.z * radius);
    const right = terrainHeight(world, sample.x - sample.normal.x * radius,
      sample.z - sample.normal.z * radius);
    if (![left, right].every(Number.isFinite)) return null;
    const rise = Math.max(Math.abs(left - center), Math.abs(right - center));
    const grade = rise / radius;
    lateralSlope = Math.max(lateralSlope, grade);
    wideRelief = Math.max(wideRelief, rise);
    // A sharp rise marks a valley wall or an escarpment.  It is a hard
    // amplitude limit; final bank acceptance is intentionally left to fitting.
    if (grade > 0.22 || rise > 14) clearance = Math.min(clearance, radius);
  }
  const slopeFactor = 1 - smoothstep(0.025, 0.18, localSlope);
  const lateralFactor = 1 - smoothstep(0.035, 0.2, lateralSlope);
  const reliefFactor = 1 - smoothstep(3, 14, wideRelief);
  const clearanceFactor = smoothstep(footprint + 8, footprint + 44, clearance);
  return {
    factor: clamp(slopeFactor * lateralFactor * reliefFactor * clearanceFactor, 0, 1),
    slope: localSlope,
    lateralSlope,
    relief: wideRelief,
    clearance,
  };
}

function collarLength(route, endpoint, atStart, contacts, junctionLength, mouthLength) {
  const junction = endpointMatches(endpoint, contacts.junctions, contacts.ids);
  const lake = endpointHasLakeContact(route, endpoint, contacts.junctions, contacts.lakeIds);
  const mouth = !atStart && route.oceanMouth === true;
  let length = 0;
  if (junction) length = Math.max(length, junctionLength);
  if (mouth) length = Math.max(length, mouthLength);
  if (lake) length = Math.max(length, junctionLength, mouthLength);
  // Even a free source/outlet gets a short zero-derivative nose.  This avoids
  // an abrupt heading change when the proposal is later fitted at 4 m cells.
  if (length === 0) length = 24;
  return length;
}

function hermite(a, b, da, db, distance) {
  const span = b.s - a.s;
  const t = clamp((distance - a.s) / Math.max(EPSILON, span), 0, 1);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * a.v + h10 * da * span + h01 * b.v + h11 * db * span;
}

function makeBendKnots(route, values, factorAt, seed, amplitude, startCollar, endCollar) {
  const length = values.length;
  const innerStart = clamp(startCollar, 0, length);
  const innerEnd = clamp(length - endCollar, 0, length);
  const span = innerEnd - innerStart;
  if (span < MIN_BEND_SPAN) return null;
  const count = clamp(Math.round(span / 210), 2, 6);
  const knots = [{ s: 0, v: 0, fixed: true }];
  if (innerStart > EPSILON) knots.push({ s: innerStart, v: 0, fixed: true });
  const positions = [];
  for (let i = 0; i < count; i++) {
    const base = (i + 1) / (count + 1);
    const jitter = (random01(seed, `${route.id}:position:${i}`) - 0.5) * 0.16;
    positions.push(innerStart + span * clamp(base + jitter, 0.08, 0.92));
  }
  positions.sort((a, b) => a - b);
  const signs = [];
  for (let i = 0; i < positions.length; i++) signs.push(random01(seed, `${route.id}:sign:${i}`) < 0.5 ? -1 : 1);
  if (new Set(signs).size === 1 && signs.length > 1) signs[Math.floor(signs.length / 2)] *= -1;
  positions.forEach((s, i) => {
    const base = 0.82 + random01(seed, `${route.id}:magnitude:${i}`) * 0.18;
    const terrain = factorAt(s);
    knots.push({ s, v: signs[i] * amplitude * base * terrain });
  });
  if (innerEnd > innerStart + EPSILON) knots.push({ s: innerEnd, v: 0, fixed: true });
  knots.push({ s: length, v: 0, fixed: true });
  knots.sort((a, b) => a.s - b.s);
  const unique = [];
  for (const knot of knots) {
    if (unique.length && knot.s - unique.at(-1).s < EPSILON) {
      unique[unique.length - 1].v = knot.v;
      unique[unique.length - 1].fixed ||= knot.fixed;
    } else unique.push(knot);
  }
  for (let i = 0; i < unique.length; i++) {
    const knot = unique[i];
    if (knot.fixed || i === 0 || i === unique.length - 1) knot.d = 0;
    else {
      const left = unique[i - 1], right = unique[i + 1];
      const derivative = (right.v - left.v) / Math.max(EPSILON, right.s - left.s);
      knot.d = clamp(derivative, -0.28, 0.28);
    }
  }
  return unique;
}

function offsetAt(knots, distance) {
  if (distance <= knots[0].s) return knots[0].v;
  for (let i = 1; i < knots.length; i++) {
    if (distance <= knots[i].s + EPSILON) return hermite(knots[i - 1], knots[i],
      knots[i - 1].d, knots[i].d, distance);
  }
  return knots.at(-1).v;
}

function segmentDistance(a, b, c, d) {
  const distanceToSegment = (p, q, r) => {
    const dx = r.x - q.x, dz = r.z - q.z;
    const t = clamp(((p.x - q.x) * dx + (p.z - q.z) * dz) / Math.max(EPSILON, dx * dx + dz * dz), 0, 1);
    return Math.hypot(p.x - (q.x + dx * t), p.z - (q.z + dz * t));
  };
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d),
    distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

function intersects(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const ab1 = orient(a, b, c), ab2 = orient(a, b, d), cd1 = orient(c, d, a), cd2 = orient(c, d, b);
  return (ab1 > EPSILON && ab2 < -EPSILON || ab1 < -EPSILON && ab2 > EPSILON)
    && (cd1 > EPSILON && cd2 < -EPSILON || cd1 < -EPSILON && cd2 > EPSILON);
}

function curveSafe(points, clearances, footprint) {
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    if (length < MIN_SAMPLE_SPACING * 0.22) return false;
    if (clearances[i] < Infinity && Math.abs(points[i].offset) + footprint + 4 > clearances[i] + 1e-6) return false;
    if (i < points.length - 1) {
      const ax = points[i].x - points[i - 1].x, az = points[i].z - points[i - 1].z;
      const bx = points[i + 1].x - points[i].x, bz = points[i + 1].z - points[i].z;
      const turn = Math.abs(2 * (ax * bz - az * bx)
        / Math.max(EPSILON, Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz)));
      if (turn * (footprint + 2) >= 0.72) return false;
      if ((ax * bx + az * bz) <= 0) return false;
    }
  }
  for (let i = 0; i < points.length - 2; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      if (j === i + 1) continue;
      if (intersects(points[i], points[i + 1], points[j], points[j + 1])) return false;
      if (j > i + 2 && segmentDistance(points[i], points[i + 1], points[j], points[j + 1])
        < footprint * 1.65) return false;
    }
  }
  return true;
}

function copyRoute(route, length) {
  return { ...route, points: route.points.map(point => ({ ...point })),
    profileArcLength: length };
}

function boundedStraightRoute(route, values, maxSamples) {
  if (values.points.length <= maxSamples
    && values.points.slice(1).every((point, index) => Math.hypot(
      point.x - values.points[index].x, point.z - values.points[index].z) >= MIN_SAMPLE_SPACING * 0.7)) {
    return copyRoute(route, values.length);
  }
  const count = Math.min(maxSamples, Math.max(2, Math.ceil(values.length / TARGET_SAMPLE_SPACING) + 1));
  const spacing = values.length / Math.max(1, count - 1);
  const points = Array.from({ length: count }, (_, index) => {
    const distance = index * spacing, sample = samplePolyline(values, distance);
    const exactIndex = sourceIndexAtArc(values.arcs, distance);
    const source = exactIndex < 0 ? null : values.points[exactIndex];
    const point = source ? { ...source } : {
      x: sample.x, z: sample.z, waterY: sample.waterY, preferredY: sample.preferredY,
    };
    point.x = sample.x; point.z = sample.z; point.waterY = sample.waterY;
    point.preferredY = sample.preferredY;
    point.arc = distance;
    if (!source) delete point.id;
    return point;
  });
  return { ...route, points, profileArcLength: values.length };
}

function proposeReach(world, route, options, contacts) {
  if (route?.status !== 'candidate') return {
    route: { ...route, points: Array.isArray(route?.points) ? route.points.map(point => ({ ...point })) : [] },
    diagnostic: { id: route?.id, meandered: false, reason: 'noncandidate-reach' },
  };
  const values = routeValues(route);
  if (!values) return {
    route: { ...route, points: Array.isArray(route?.points) ? route.points.map(point => ({ ...point })) : [] },
    diagnostic: { id: route?.id, meandered: false, reason: 'invalid-reach' },
  };
  const { length } = values;
  const profile = options.channelProfiles?.[route.id];
  const width = profileWidth(profile);
  // Extra room reserved for point bars must not itself increase the bend's
  // excursion. Base channel size controls the path; the full envelope controls safety.
  const amplitudeWidth = profile?.morphology ? channelProfileHalfWidthBound({ ...profile, morphology: false }) : width;
  const footprint = width + 8 + 8;
  const startCollar = collarLength(route, values.points[0], true, contacts,
    options.junctionLength, options.mouthLength);
  const endCollar = collarLength(route, values.points.at(-1), false, contacts,
    options.junctionLength, options.mouthLength);
  const baseCopy = boundedStraightRoute(route, values, options.maxSamples);
  const diagnostic = {
    id: route.id, originalLength: length, profileArcLength: length,
    collars: { start: Math.min(startCollar, length), end: Math.min(endCollar, length) },
    sampleCount: route.points.length, meandered: false,
  };
  if (length < MIN_REACH_LENGTH || length - startCollar - endCollar < MIN_BEND_SPAN) {
    diagnostic.reason = 'short-reach';
    return { route: baseCopy, diagnostic };
  }
  const grade = Math.abs(values.levels[0] - values.levels.at(-1)) / Math.max(1, length);
  const stations = stationArcs(values, startCollar, endCollar, options.maxSamples);
  const baseSamples = stations.map(distance => samplePolyline(values, distance));
  const terrain = baseSamples.map(sample => corridorTerrain(world, sample, footprint));
  const factors = terrain.map(sample => sample?.factor ?? 0);
  const terrainKnown = terrain.every(Boolean);
  const terrainMean = factors.reduce((sum, value) => sum + value, 0) / factors.length;
  const gradeFactor = 1 - smoothstep(0.012, 0.045, grade);
  diagnostic.grade = grade;
  diagnostic.gradeFactor = gradeFactor;
  diagnostic.terrainSuitability = terrainMean;
  diagnostic.terrainSlope = terrainKnown ? Math.max(...terrain.map(sample => sample.slope)) : null;
  diagnostic.lateralRelief = terrainKnown ? Math.max(...terrain.map(sample => sample.relief)) : null;
  diagnostic.clearance = terrainKnown ? Math.min(...terrain.map(sample => sample.clearance)) : null;
  const factorAt = distance => scalarAt(stations, factors, distance);
  const usableFactor = clamp(terrainMean * gradeFactor * options.strength, 0, 1);
  if (!terrainKnown || usableFactor < 0.08) {
    diagnostic.reason = !terrainKnown ? 'terrain-unavailable' : 'steep-or-confined';
    return { route: baseCopy, diagnostic };
  }
  const amplitude = clamp((22 + Math.min(10, amplitudeWidth * 0.35)) * options.strength
    * gradeFactor, 0, 32);
  const knots = makeBendKnots(route, values, distance => factorAt(distance) * gradeFactor,
    `${options.seed}:${route.id}:${values.points[0].x},${values.points[0].z}`, amplitude,
    startCollar, endCollar);
  if (!knots || amplitude < 1) {
    diagnostic.reason = 'insufficient-bend-span';
    return { route: baseCopy, diagnostic };
  }
  let proposed = null;
  let scale = 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    proposed = baseSamples.map((sample, index) => {
      const offset = offsetAt(knots, stations[index]) * scale;
      return { ...sample, offset, x: sample.x + sample.normal.x * offset,
        z: sample.z + sample.normal.z * offset };
    });
    const clearances = terrain.map(sample => sample?.clearance ?? Infinity);
    if (curveSafe(proposed, clearances, footprint)) break;
    scale *= 0.62;
  }
  if (!proposed || !curveSafe(proposed, terrain.map(sample => sample?.clearance ?? Infinity), footprint)) {
    diagnostic.reason = 'unsafe-footprint';
    return { route: baseCopy, diagnostic };
  }
  const maxOffset = Math.max(...proposed.map(point => Math.abs(point.offset)));
  if (maxOffset < 1.5) {
    diagnostic.reason = 'low-amplitude-terrain';
    return { route: baseCopy, diagnostic };
  }
  const points = proposed.map((sample, index) => {
    const distance = stations[index];
    const exactIndex = sourceIndexAtArc(values.arcs, distance);
    const source = exactIndex < 0 ? null : values.points[exactIndex];
    const unchanged = Math.abs(sample.offset) < 1e-6;
    const point = source && unchanged ? { ...source } : {
      x: sample.x, z: sample.z, waterY: sample.waterY, preferredY: sample.preferredY,
    };
    point.x = sample.x; point.z = sample.z;
    point.waterY = sample.waterY; point.preferredY = sample.preferredY;
    point.arc = distance;
    if (!source || !unchanged) delete point.id;
    return point;
  });
  points[0] = { ...values.points[0], x: values.points[0].x, z: values.points[0].z,
    waterY: values.levels[0], preferredY: values.preferred[0], arc: 0 };
  points.at(-1).id = values.points.at(-1).id;
  points.at(-1).x = values.points.at(-1).x; points.at(-1).z = values.points.at(-1).z;
  points.at(-1).waterY = values.levels.at(-1); points.at(-1).preferredY = values.preferred.at(-1);
  points.at(-1).arc = length;
  const proposedLength = points.slice(1).reduce((sum, point, index) => sum
    + Math.hypot(point.x - points[index].x, point.z - points[index].z), 0);
  diagnostic.sampleCount = points.length;
  diagnostic.proposedLength = proposedLength;
  diagnostic.lengthRatio = proposedLength / Math.max(EPSILON, length);
  const chord = Math.hypot(values.points.at(-1).x - values.points[0].x,
    values.points.at(-1).z - values.points[0].z);
  diagnostic.sinuosity = proposedLength / Math.max(EPSILON, chord);
  diagnostic.maxOffset = maxOffset;
  diagnostic.amplitudeScale = scale;
  diagnostic.meandered = true;
  diagnostic.reason = 'terrain-supported';
  return { route: { ...route, points, profileArcLength: length }, diagnostic };
}

/**
 * Propose smooth, terrain-aware bends for a segmented candidate river.
 * The returned graph keeps all topology and canonical route identity intact;
 * callers still have to fit and bake it before publication.
 */
export function proposeRiverMeanders(world, segmented, {
  seed = world?.seed ?? 0,
  channelProfiles = null,
  junctionLength = 128,
  mouthLength = 64,
  strength = 1,
  maxSamples = MAX_SAMPLES,
} = {}) {
  if (segmented?.status !== 'candidate') return segmented;
  if (!Array.isArray(segmented.reaches) || !Array.isArray(segmented.junctions)) {
    throw new Error('Invalid segmented river candidate');
  }
  if (![junctionLength, mouthLength, strength].every(Number.isFinite)
    || junctionLength < 0 || junctionLength > 512 || mouthLength < 0 || mouthLength > 512
    || strength < 0 || strength > 2
    || !Number.isInteger(maxSamples) || maxSamples < 16 || maxSamples > MAX_SAMPLES) {
    throw new Error('Invalid river meander budget');
  }
  if (channelProfiles !== null && (!channelProfiles || typeof channelProfiles !== 'object'
    || Array.isArray(channelProfiles))) throw new Error('Invalid river channel profiles');
  const options = { seed, channelProfiles, junctionLength, mouthLength, strength, maxSamples };
  const contacts = contactNodes(segmented);
  const diagnostics = [];
  const reaches = segmented.reaches.map(route => {
    const result = proposeReach(world, route, options, contacts);
    diagnostics.push(result.diagnostic);
    return result.route;
  });
  const proposed = diagnostics.filter(item => item.meandered).length;
  return {
    ...segmented,
    reaches,
    junctions: segmented.junctions.map(junction => ({ ...junction })),
    diagnostics: {
      reaches: diagnostics,
      proposed,
      retained: diagnostics.length - proposed,
      samples: reaches.reduce((sum, reach) => sum + reach.points.length, 0),
      maxSamples,
      seed,
    },
  };
}
