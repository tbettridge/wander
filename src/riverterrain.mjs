// Metre-based channel sections shared by planning, terrain and water queries.
// This module never projects a river noise band or bends water down a bank.
import { clamp, lerp, smoothstep } from './noise.js';
import { solveRiverProfile } from './riverprofile.mjs';

export function riverSectionFloor(section, lateral, naturalHeight, waterY = section.waterY) {
  const side = lateral < 0 ? 'left' : 'right';
  const distance = Math.abs(lateral), width = section[`${side}Width`];
  if (distance <= width) {
    const q = distance / width;
    const shoulder = section[`${side}Shoulder`];
    return waterY - section.depth * (1 - smoothstep(shoulder, 1, q));
  }
  const bankWidth = section[`${side}BankWidth`], bankY = section[`${side}BankY`];
  const t = (distance - width) / bankWidth;
  if (t <= 1) return lerp(waterY, bankY, lerp(t, smoothstep(0, 1, t), section[`${side}Inner`]));
  return lerp(bankY, naturalHeight, smoothstep(0, section[`${side}BlendWidth`], distance - width - bankWidth));
}

// A modest Hermite fit removes the 45-degree routing lattice without making
// unconstrained loops. Feasibility is checked on the fitted path, not on the
// original coarse survey points.
export function fittedRiverPath(points, spacing = 4) {
  if (!Array.isArray(points) || points.length < 2 || !(spacing > 0)) throw new Error('Invalid river path');
  for (let i = 0; i < points.length; i++) {
    const p = points[i], previous = points[i - 1];
    if (![p.x, p.z, p.waterY].every(Number.isFinite)
      || (previous && Math.hypot(p.x - previous.x, p.z - previous.z) < 1e-6)) {
      throw new Error('Invalid river path point');
    }
  }
  const tangentAt = index => {
    if (index === 0) return { x: points[1].x - points[0].x, z: points[1].z - points[0].z };
    if (index === points.length - 1) return { x: points[index].x - points[index - 1].x,
      z: points[index].z - points[index - 1].z };
    const previous = points[index - 1], point = points[index], next = points[index + 1];
    const ax = point.x - previous.x, az = point.z - previous.z;
    const bx = next.x - point.x, bz = next.z - point.z;
    const al = Math.hypot(ax, az), bl = Math.hypot(bx, bz);
    const sx = ax / al + bx / bl, sz = az / al + bz / bl, sl = Math.hypot(sx, sz);
    if (sl < 1e-6) return { x: bx * 0.5, z: bz * 0.5 };
    // Geometric mean keeps a half-cell valley nudge from collapsing the
    // derivative to nearly zero between two full routing segments. Cap it to
    // prevent a long/short pair from overshooting the routed corridor.
    const shortest = Math.min(al, bl);
    const magnitude = Math.min(shortest * 1.6, Math.sqrt(al * bl) * 0.8);
    return { x: sx / sl * magnitude, z: sz / sl * magnitude };
  };
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], tangentA = tangentAt(i), tangentB = tangentAt(i + 1);
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
    for (let k = 0; k < count; k++) {
      const t = k / count, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push({
        nodeId: k === 0 ? a.id ?? null : null,
        x: h00 * a.x + h10 * tangentA.x + h01 * b.x + h11 * tangentB.x,
        z: h00 * a.z + h10 * tangentA.z + h01 * b.z + h11 * tangentB.z,
        preferredY: lerp(a.waterY, b.waterY, t),
      });
    }
  }
  out.push({ nodeId: points.at(-1).id ?? null, x: points.at(-1).x, z: points.at(-1).z, preferredY: points.at(-1).waterY });
  return out;
}

export function prepareRiverReach(world, route, { id = `reach:${world.seed}:${route.source}`, halfWidth = 4,
  depth = 1.2, maxFill = 2, maxCut = 6, maxGrade = 0.025, fixedLevels = [],
  protectedApproaches = [], approachTolerance = 0.25,
  sourceClosure = true, oceanMouth = true } = {}) {
  if (route.status !== 'candidate') return route;
  if (!(halfWidth >= 1 && halfWidth <= 22.5) || !(depth > 0) || maxFill < 0 || maxCut < 0
    || typeof sourceClosure !== 'boolean' || typeof oceanMouth !== 'boolean') throw new Error('Invalid river section budget');
  const points = fittedRiverPath(route.points, 4);
  let arc = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    if (i) arc += Math.hypot(p.x - a.x, p.z - a.z);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) return { status: 'retain-legacy', reason: 'degenerate-river-route' };
    p.arc = arc; p.tx = (b.x - a.x) / length; p.tz = (b.z - a.z) / length;
    const before = Math.hypot(p.x - a.x, p.z - a.z), after = Math.hypot(b.x - p.x, b.z - p.z);
    const cross = (p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x);
    // Signed circumcircle curvature, in inverse metres. Check the entire
    // sculpted bank footprint against the bend radius to prevent folded banks.
    const curvature = before * after > 1e-6 ? 2 * cross / (before * after * length) : 0;
    const constriction = smoothstep(0.015, 0.08, Math.abs(curvature));
    const bend = clamp(curvature * 80, -1, 1);
    const variation = 1 + 0.12 * Math.sin(arc / 110);
    p.depth = depth * (0.85 + 0.15 * Math.sin(arc / 36)) * (sourceClosure ? smoothstep(0, 24, arc) : 1);
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1;
      // Positive lateral coordinates point inside a counterclockwise bend.
      // Continuous weights avoid a width/bed jump at curvature inflections.
      const inner = (1 + sign * bend) / 2;
      p[`${side}Inner`] = inner;
      p[`${side}Shoulder`] = lerp(0.48, 0.12, inner);
      p[`${side}Width`] = halfWidth * variation * lerp(0.92, 1.12, inner) * lerp(1, 0.75, constriction);
      p[`${side}BankWidth`] = lerp(lerp(5, 8, inner), 3, constriction);
      p[`${side}BlendWidth`] = lerp(8, 2, constriction);
      const offset = (p[`${side}Width`] + p[`${side}BankWidth`]) * sign;
      p[`${side}BankY`] = world._naturalHeight(p.x - p.tz * offset, p.z + p.tx * offset);
    }
    const footprint = Math.max(p.leftWidth + p.leftBankWidth + p.leftBlendWidth,
      p.rightWidth + p.rightBankWidth + p.rightBlendWidth);
    if (Math.abs(curvature) * footprint >= 0.8) {
      return { status: 'retain-legacy', reason: 'river-bend-too-tight', section: i, x: p.x, z: p.z };
    }
    p.minY = 0;
    // At sea level submerged banks belong to the ocean. Inland water must
    // remain below both bank crests; only the ocean can relax that constraint.
    p.maxY = Math.max(0, Math.min(p.leftBankY, p.rightBankY) - 0.2);
    // All changed ground in the section is budgeted, including the bank
    // transitions. The floor is affine in water level, so each probe gives an
    // exact feasible interval instead of a later vertex-by-vertex water curl.
    const reach = Math.max(p.leftWidth + p.leftBankWidth + p.leftBlendWidth,
      p.rightWidth + p.rightBankWidth + p.rightBlendWidth);
    for (let offset = -reach; offset <= reach; offset += 2) {
      const natural = world._naturalHeight(p.x - p.tz * offset, p.z + p.tx * offset);
      const base = riverSectionFloor(p, offset, natural, 0);
      const coefficient = riverSectionFloor(p, offset, natural, 1) - base;
      if (coefficient < 1e-6) {
        if (base > natural + maxFill || base < natural - maxCut) return { status: 'retain-legacy', reason: 'bank-earthwork-budget', section: i };
        continue;
      }
      p.minY = Math.max(p.minY, (natural - maxCut - base) / coefficient);
      p.maxY = Math.min(p.maxY, (natural + maxFill - base) / coefficient);
    }
  }
  // The mouth has an explicit ocean identity. The source is a gently closing
  // spring section; its bed depth starts at zero instead of a floating end cap.
  if (oceanMouth) {
    points.at(-1).minY = Math.max(points.at(-1).minY, 0);
    points.at(-1).maxY = Math.min(points.at(-1).maxY, 0);
  }
  for (const anchor of fixedLevels) {
    let index = 0, best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const distance = Math.hypot(points[i].x - anchor.x, points[i].z - anchor.z);
      if (distance < best) { best = distance; index = i; }
    }
    if (best > 4) return { status: 'retain-legacy', reason: 'missed-crossing-anchor', id: anchor.id };
    points[index].minY = Math.max(points[index].minY, anchor.minY);
    points[index].maxY = Math.min(points[index].maxY, anchor.maxY);
  }
  const protection = constrainRiverApproaches(world, points, protectedApproaches, approachTolerance);
  if (protection) return protection;
  const margin = halfWidth * 1.3 + 16;
  return { status: 'prepared', id, kind: 'river', points, maxFill, maxCut, maxGrade,
    sourceClosure, oceanMouth,
    bounds: { minX: Math.min(...points.map(p => p.x)) - margin, minZ: Math.min(...points.map(p => p.z)) - margin,
      maxX: Math.max(...points.map(p => p.x)) + margin, maxZ: Math.max(...points.map(p => p.z)) + margin } };
}

// Planning-only projection uses the same nearest segment, interpolated cross
// section and endpoint exclusion as RiverReachField. Constraining both adjacent
// heads to the allowed interval conservatively constrains their interpolation.
function constrainRiverApproaches(world, points, approaches, tolerance) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Invalid approach tolerance');
  for (const point of approaches) {
    if (point.wet) continue;
    if (![point.x, point.z, point.floor].every(Number.isFinite)) throw new Error('Invalid protected approach');
    let best = Infinity, index = -1, fraction = 0;
    const binX = Math.floor(point.x / 32), binZ = Math.floor(point.z / 32);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b.x - a.x, dz = b.z - a.z;
      const margin = Math.max(a.leftWidth + a.leftBankWidth + a.leftBlendWidth,
        a.rightWidth + a.rightBankWidth + a.rightBlendWidth,
        b.leftWidth + b.leftBankWidth + b.leftBlendWidth,
        b.rightWidth + b.rightBankWidth + b.rightBlendWidth);
      if (binX < Math.floor((Math.min(a.x, b.x) - margin) / 32)
        || binX > Math.floor((Math.max(a.x, b.x) + margin) / 32)
        || binZ < Math.floor((Math.min(a.z, b.z) - margin) / 32)
        || binZ > Math.floor((Math.max(a.z, b.z) + margin) / 32)) continue;
      const t = clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      const d2 = (point.x - a.x - dx * t) ** 2 + (point.z - a.z - dz * t) ** 2;
      if (d2 < best) { best = d2; index = i; fraction = t; }
    }
    if (index < 0) continue;
    const a = points[index - 1], b = points[index], section = {};
    for (const key of ['x', 'z', 'tx', 'tz', 'depth', 'leftWidth', 'rightWidth',
      'leftBankWidth', 'rightBankWidth', 'leftBlendWidth', 'rightBlendWidth', 'leftBankY', 'rightBankY',
      'leftInner', 'rightInner', 'leftShoulder', 'rightShoulder']) section[key] = lerp(a[key], b[key], fraction);
    const length = Math.hypot(section.tx, section.tz);
    section.tx /= length; section.tz /= length;
    const lateral = (point.x - section.x) * -section.tz + (point.z - section.z) * section.tx;
    const side = lateral < 0 ? 'left' : 'right';
    if (Math.sqrt(best) >= section[`${side}Width`] + section[`${side}BankWidth`] + section[`${side}BlendWidth`]) continue;
    const longitudinal = (point.x - section.x) * section.tx + (point.z - section.z) * section.tz;
    if ((index === 1 && fraction === 0 && longitudinal < 0)
      || (index === points.length - 1 && fraction === 1 && longitudinal > 0)) continue;
    const natural = world._naturalHeight(point.x, point.z);
    const base = riverSectionFloor(section, lateral, natural, 0);
    const coefficient = riverSectionFloor(section, lateral, natural, 1) - base;
    const failure = reason => ({ status: 'retain-legacy', reason, crossingId: point.crossingId ?? null,
      x: point.x, z: point.z, section: index });
    if (coefficient >= 1 - 1e-9) return failure('protected-approach-in-channel');
    if (coefficient < 1e-9 && Math.abs(base - point.floor) > tolerance) return failure('protected-approach-bank-height');
    const minimum = coefficient > 1e-9 ? (point.floor - tolerance - base) / coefficient : -Infinity;
    const maximum = Math.min((base - 0.03) / (1 - coefficient),
      coefficient > 1e-9 ? (point.floor + tolerance - base) / coefficient : Infinity);
    // At an exact sample only that sample contributes. Interior samples use
    // both heads; this is conservative and may reject a feasible alternative.
    const affected = fraction === 0 ? [a] : fraction === 1 ? [b] : [a, b];
    for (const p of affected) {
      p.minY = Math.max(p.minY, minimum); p.maxY = Math.min(p.maxY, maximum);
      if (p.minY > p.maxY + 1e-9) return failure('protected-approach-water-interval');
    }
  }
  return null;
}

export function finishRiverReach(prepared, levels) {
  if (prepared.status !== 'prepared' || levels.length !== prepared.points.length) throw new Error('Invalid prepared river');
  const points = prepared.points.map((point, i) => {
    const waterY = levels[i], previous = prepared.points[i - 1];
    if (!Number.isFinite(waterY) || waterY < point.minY - 1e-9 || waterY > point.maxY + 1e-9
      || (i && (waterY > levels[i - 1] + 1e-9
        || levels[i - 1] - waterY > (point.arc - previous.arc) * prepared.maxGrade + 1e-9))) {
      throw new Error('Solved river violates terrain constraints');
    }
    return { ...point, waterY };
  });
  return { ...prepared, status: 'fitted', points };
}

export function fitRiverReach(world, route, options = {}) {
  const prepared = prepareRiverReach(world, route, options);
  if (prepared.status !== 'prepared') return prepared;
  const profile = solveRiverProfile(prepared.points, { maxGrade: prepared.maxGrade });
  if (profile.status !== 'accepted') {
    const section = Number.isInteger(profile.section) ? prepared.points[profile.section] : null;
    return { ...profile, x: section?.x, z: section?.z };
  }
  return finishRiverReach(prepared, profile.levels);
}

export class RiverReachField {
  constructor(reach) {
    if (reach.status !== 'fitted') throw new Error('River reach has not passed section fitting');
    const keys = ['x', 'z', 'tx', 'tz', 'arc', 'waterY', 'depth', 'leftWidth', 'rightWidth',
      'leftBankWidth', 'rightBankWidth', 'leftBlendWidth', 'rightBlendWidth', 'leftBankY', 'rightBankY',
      'leftInner', 'rightInner', 'leftShoulder', 'rightShoulder'];
    if (typeof reach.id !== 'string' || !Array.isArray(reach.points) || reach.points.length < 2
      || ![reach.maxGrade, reach.maxFill, reach.maxCut].every(n => Number.isFinite(n) && n >= 0)
      || !reach.bounds || !['minX', 'minZ', 'maxX', 'maxZ'].every(k => Number.isFinite(reach.bounds[k]))) {
      throw new Error('Malformed river reach');
    }
    for (let i = 0; i < reach.points.length; i++) {
      const p = reach.points[i], previous = reach.points[i - 1];
      if (!keys.every(k => Number.isFinite(p[k])) || p.leftWidth <= 0 || p.rightWidth <= 0
        || p.leftBankWidth <= 0 || p.rightBankWidth <= 0 || p.leftBlendWidth <= 0 || p.rightBlendWidth <= 0 || p.depth < 0
        || Math.abs(Math.hypot(p.tx, p.tz) - 1) > 1e-6
        || p.x < reach.bounds.minX || p.x > reach.bounds.maxX || p.z < reach.bounds.minZ || p.z > reach.bounds.maxZ
        || (previous && (p.arc <= previous.arc || p.waterY > previous.waterY + 1e-9
          || previous.waterY - p.waterY > (p.arc - previous.arc) * reach.maxGrade + 1e-9))) {
        throw new Error('Malformed river section');
      }
    }
    this.reach = reach;
    this.bins = new Map();
    const points = reach.points, binSize = 32;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const margin = Math.max(a.leftWidth + a.leftBankWidth + a.leftBlendWidth,
        a.rightWidth + a.rightBankWidth + a.rightBlendWidth,
        b.leftWidth + b.leftBankWidth + b.leftBlendWidth,
        b.rightWidth + b.rightBankWidth + b.rightBlendWidth);
      for (let z = Math.floor((Math.min(a.z, b.z) - margin) / binSize); z <= Math.floor((Math.max(a.z, b.z) + margin) / binSize); z++) {
        for (let x = Math.floor((Math.min(a.x, b.x) - margin) / binSize); x <= Math.floor((Math.max(a.x, b.x) + margin) / binSize); x++) {
          const key = `${x},${z}`;
          if (!this.bins.has(key)) this.bins.set(key, []);
          this.bins.get(key).push(i);
        }
      }
    }
    this.local = null;
  }

  sample(x, z, natural, out = {}) {
    const ix = Math.floor(x / 32), iz = Math.floor(z / 32);
    if (!this.local || this.local.ix !== ix || this.local.iz !== iz) this.local = { ix, iz, segments: this.bins.get(`${ix},${iz}`) || [] };
    let best = Infinity, index = -1, fraction = 0;
    const points = this.reach.points;
    for (const i of this.local.segments) {
      const a = points[i - 1], b = points[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      const d2 = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
      if (d2 < best) { best = d2; index = i; fraction = t; }
    }
    if (index < 0) return false;
    const a = points[index - 1], b = points[index], section = this.section || (this.section = {});
    for (const key of ['x', 'z', 'tx', 'tz', 'arc', 'waterY', 'depth', 'leftWidth', 'rightWidth',
      'leftBankWidth', 'rightBankWidth', 'leftBlendWidth', 'rightBlendWidth', 'leftBankY', 'rightBankY',
      'leftInner', 'rightInner', 'leftShoulder', 'rightShoulder']) {
      section[key] = lerp(a[key], b[key], fraction);
    }
    const tangentLength = Math.hypot(section.tx, section.tz);
    section.tx /= tangentLength; section.tz /= tangentLength;
    const lateral = (x - section.x) * -section.tz + (z - section.z) * section.tx;
    const side = lateral < 0 ? 'left' : 'right';
    const influence = section[`${side}Width`] + section[`${side}BankWidth`] + section[`${side}BlendWidth`];
    if (Math.sqrt(best) >= influence) return false;
    const longitudinal = (x - section.x) * section.tx + (z - section.z) * section.tz;
    // No infinite extrusion past the first/last section.
    if ((index === 1 && fraction === 0 && longitudinal < 0)
      || (index === points.length - 1 && fraction === 1 && longitudinal > 0)) return false;
    const floor = riverSectionFloor(section, lateral, natural);
    const signed = section.waterY - floor;
    const speed = clamp((a.waterY - b.waterY) / (b.arc - a.arc) * 16, 0.12, 0.7);
    Object.assign(out, { floor, waterY: section.waterY, head: section.waterY, signedDepth: signed,
      domainDepth: signed, ch: signed > 0 ? 1 : 0, riverInfluence: true, bodyId: this.reach.id,
      bodyKind: 'river', waterKind: -1, flowX: section.tx * speed, flowZ: section.tz * speed,
      turbulence: Math.max(0, speed - 0.45), turbidity: 0.25, exposure: 0.15,
      estuary: this.reach.oceanMouth === false ? 0
        : smoothstep(points.at(-1).arc - 120, points.at(-1).arc, section.arc) });
    return true;
  }
}
