// Plan-form shaping for drainage-tree rivers.
//
// A drainage survey gives each channel as a chain of 16 m lattice cells. This
// module turns those chains into river centrelines: it removes the lattice
// zigzag, lets each line settle into its valley floor, adds meanders where the
// valley is flat and wide enough to hold them, and brings each feeder into its
// receiving river at a natural, downstream-pointing angle. Everything here is
// geometry only; hydraulic fitting and terrain validation happen afterwards.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

function mix32(value) {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

// Quintic value noise in [0, 1]; lattice values are unrelated, so long rivers
// never repeat one bend pattern.
function valueNoise(x, seed) {
  const lower = Math.floor(x), f = x - lower, t = f * f * f * (f * (f * 6 - 15) + 10);
  const at = n => mix32(seed ^ Math.imul(n | 0, 0x9e3779b9)) / 4294967296;
  return at(lower) + (at(lower + 1) - at(lower)) * t;
}

/** River half-width for a contributing area in square metres. */
export function riverHalfWidth(area) {
  return clamp(0.4 + 20 * Math.pow(Math.max(0, area) / 1e6, 0.55), 1.2, 42);
}

export function polylineArcs(points) {
  const arcs = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    arcs[i] = arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return arcs;
}

/** Uniformly resample along arc length; numeric attributes interpolate. */
export function resamplePolyline(points, spacing) {
  const arcs = polylineArcs(points), length = arcs[arcs.length - 1];
  const count = Math.max(2, Math.round(length / spacing) + 1), out = [];
  const keys = Object.keys(points[0]).filter(key => key !== 'x' && key !== 'z' && key !== 'id'
    && points.every(point => Number.isFinite(point[key])));
  let j = 1;
  for (let i = 0; i < count; i++) {
    const s = length * i / (count - 1);
    while (j < points.length - 1 && arcs[j] < s) j++;
    const a = points[j - 1], b = points[j], span = arcs[j] - arcs[j - 1];
    const t = span > 1e-9 ? clamp((s - arcs[j - 1]) / span, 0, 1) : 0;
    const point = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    for (const key of keys) point[key] = a[key] + (b[key] - a[key]) * t;
    out.push(point);
  }
  out[0] = { ...out[0], x: points[0].x, z: points[0].z };
  out[count - 1] = { ...out[count - 1], x: points.at(-1).x, z: points.at(-1).z };
  return out;
}

export function gaussianPolyline(points, sigma) {
  const arcs = polylineArcs(points), length = arcs[arcs.length - 1];
  return points.map((point, i) => {
    if (i === 0 || i === points.length - 1) return { ...point };
    // Narrow the kernel near both ends so the endpoints and their tangents
    // stay where the drainage put them.
    const s = Math.max(1, Math.min(sigma, arcs[i] * 0.5 + 1, (length - arcs[i]) * 0.5 + 1));
    let x = 0, z = 0, weight = 0;
    for (let j = 0; j < points.length; j++) {
      const d = arcs[j] - arcs[i];
      if (d < -3 * s) continue;
      if (d > 3 * s) break;
      const w = Math.exp(-d * d / (2 * s * s));
      x += points[j].x * w; z += points[j].z * w; weight += w;
    }
    return { ...point, x: x / weight, z: z / weight };
  });
}

// An active contour: each pass relaxes the line toward its neighbours and lets
// it slide down the cross-valley slope. The two forces settle on a smooth line
// along the valley floor rather than the lattice staircase. A broad river
// measures that slope across its own banks, so it keeps clear of knolls that
// would stand inside its floodplain.
function snapToValley(world, input, { iterations = 24, pull = 0.25, push = 10, probe = () => 6, spacing = 16 } = {}) {
  let points = input.map(point => ({ ...point }));
  for (let pass = 0; pass < iterations; pass++) {
    const next = points.map(point => ({ ...point }));
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i + 1];
      const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
      const nx = -tz / length, nz = tx / length;
      const x = points[i].x + ((a.x + b.x) / 2 - points[i].x) * pull;
      const z = points[i].z + ((a.z + b.z) / 2 - points[i].z) * pull;
      let lateral = 0, weight = 0;
      for (const distance of new Set([6, probe(points[i])])) {
        lateral += (world._naturalHeight(x + nx * distance, z + nz * distance)
          - world._naturalHeight(x - nx * distance, z - nz * distance)) / (2 * distance);
        weight++;
      }
      const move = clamp(-lateral / weight * push, -2.5, 2.5);
      next[i].x = x + nx * move; next[i].z = z + nz * move;
    }
    points = next;
    if (pass % 6 === 5) points = resamplePolyline(points, spacing);
  }
  return resamplePolyline(points, spacing);
}

/** A smooth valley-floor centreline through lattice cells (head first). */
export function valleyCentreline(world, points, { sigma = 32, spacing = 16, probe = () => 6 } = {}) {
  if (points.length < 2) throw new Error('Invalid drainage path');
  const raw = resamplePolyline(points, 8);
  const rawHeights = raw.map(p => world._naturalHeight(p.x, p.z)), rawArcs = polylineArcs(raw);
  let path = gaussianPolyline(raw, sigma);
  // Smoothing must not cut a corner across a knoll the drainage went round:
  // where the smoothed line rides above the drained ground, ease it back.
  for (let pass = 0; pass < 4; pass++) {
    const arcs = polylineArcs(path), scale = rawArcs.at(-1) / Math.max(1, arcs.at(-1));
    path = path.map((p, i) => {
      if (i === 0 || i === path.length - 1) return p;
      const j = Math.min(raw.length - 1, Math.round(arcs[i] * scale / 8));
      let best = j, distance = Infinity;
      for (let k = Math.max(0, j - 6); k <= Math.min(raw.length - 1, j + 6); k++) {
        const d = (raw[k].x - p.x) ** 2 + (raw[k].z - p.z) ** 2;
        if (d < distance) { distance = d; best = k; }
      }
      const rise = world._naturalHeight(p.x, p.z) - rawHeights[best];
      if (rise <= 1.2) return p;
      const t = clamp((rise - 1.2) / 3, 0.25, 0.8);
      return { ...p, x: p.x + (raw[best].x - p.x) * t, z: p.z + (raw[best].z - p.z) * t };
    });
  }
  path = resamplePolyline(path, spacing);
  return snapToValley(world, path, { spacing, probe, iterations: 30 });
}

function frames(points) {
  const n = points.length;
  return points.map((_, i) => {
    const a = points[Math.max(0, i - 2)], b = points[Math.min(n - 1, i + 2)];
    const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
    return { tx: tx / length, tz: tz / length, nx: -tz / length, nz: tx / length };
  });
}

// Signed curvature (inverse metres) from tangents a few samples apart.
function curvatures(points, reach = 2) {
  const n = points.length, arcs = polylineArcs(points), basis = frames(points);
  return points.map((_, i) => {
    const a = Math.max(0, i - reach), b = Math.min(n - 1, i + reach);
    if (b - a < 2) return 0;
    const ta = basis[a], tb = basis[b];
    const turn = Math.atan2(ta.tx * tb.tz - ta.tz * tb.tx, ta.tx * tb.tx + ta.tz * tb.tz);
    return turn / Math.max(1e-6, arcs[b] - arcs[a]);
  });
}

function gaussianValues(values, arcs, sigma) {
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    for (let j = 0; j < values.length; j++) {
      const d = arcs[j] - arcs[i];
      if (d < -3 * sigma) continue;
      if (d > 3 * sigma) break;
      const w = Math.exp(-d * d / (2 * sigma * sigma));
      sum += values[j] * w; weight += w;
    }
    return sum / weight;
  });
}

/** Conservative bank-to-bank radius of a fitted section of this half-width. */
export function riverFootprint(halfWidth, broad = false) {
  return halfWidth * 1.45 + (broad ? 42 : 17);
}

/**
 * Meander a valley centreline. Bends grow only where the valley is flat and
 * there is low ground beside the channel, scale with channel width, and are
 * limited by the axis curvature so the bank envelope cannot fold.
 */
export function meanderCentreline(world, points, {
  seed = 0, strength = 1, ratio = 0.17, wavelength = 13, startFade = 160, endFade = 260,
  quiet = [], halfWidthAt = p => riverHalfWidth(p.area), footAt = p => riverFootprint(riverHalfWidth(p.area)),
} = {}) {
  const n = points.length;
  if (n < 6 || strength <= 0) return points.map(point => ({ ...point }));
  const arcs = polylineArcs(points), length = arcs[n - 1];
  const basis = frames(points), axisCurvature = gaussianValues(curvatures(points, 3), arcs, 32);
  const heights = points.map(p => world._naturalHeight(p.x, p.z));
  const valley = gaussianValues(heights, arcs, 64);
  const halfWidths = points.map(p => halfWidthAt(p)), feet = points.map(p => footAt(p));
  const grade = valley.map((_, i) => {
    const a = Math.max(0, i - 6), b = Math.min(n - 1, i + 6);
    return Math.max(0, (valley[a] - valley[b]) / Math.max(1, arcs[b] - arcs[a]));
  });
  // Lateral room on each side: how far the ground stays near the water.
  const room = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    // A bend may swing onto ground a few metres above the water, cutting a
    // low bank there, but not into a hillside or out to sea.
    const p = points[i], reference = Number.isFinite(p.level) ? p.level + 1.5 : Math.min(heights[i], valley[i]);
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1;
      let offset = 8;
      for (; offset <= 420; offset += 8) {
        const h = world._naturalHeight(p.x + basis[i].nx * offset * side, p.z + basis[i].nz * offset * side);
        if (h < -0.25 || h > reference + 2 + offset * 0.006) break;
      }
      room[s][i] = offset - 8;
    }
  }
  const smoothRoom = room.map(values => {
    const minimum = Array.from(values, (_, i) => {
      let low = Infinity;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) low = Math.min(low, values[j]);
      return low;
    });
    return gaussianValues(minimum, arcs, 40);
  });
  const quietAt = arc => quiet.reduce((q, zone) => Math.min(q,
    smoothstep(zone.radius, zone.radius * 1.8, Math.abs(arc - zone.arc))), 1);
  // Per-side displacement limits: the room beside the channel, the inside of
  // an axis bend, and half a wavelength. A Lipschitz envelope then lets each
  // limit fade in gradually along the river, so a knoll beside one bend
  // softens the loop instead of kinking it.
  const lambdas = halfWidths.map(hw => clamp(wavelength * 2 * hw, 150, 1100));
  const envelope = [-1, 1].map(side => {
    const env = halfWidths.map((hw, i) => {
      let limit = Math.max(0, smoothRoom[side > 0 ? 1 : 0][i] - hw * 0.8 - 8);
      if (side * axisCurvature[i] > 0) limit = Math.min(limit, 0.4 / Math.max(1e-6, Math.abs(axisCurvature[i])));
      return Math.min(limit, Math.max(0, 0.5 * lambdas[i] - feet[i]));
    });
    for (let i = 1; i < n; i++) env[i] = Math.min(env[i], env[i - 1] + 0.3 * (arcs[i] - arcs[i - 1]));
    for (let i = n - 2; i >= 0; i--) env[i] = Math.min(env[i], env[i + 1] + 0.3 * (arcs[i + 1] - arcs[i]));
    return env;
  });
  const target = new Float64Array(n);
  let phase = valueNoise(0.5, seed) * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const lambda = lambdas[i];
    if (i) phase += 2 * Math.PI * (arcs[i] - arcs[i - 1]) / lambda
      * (0.75 + 0.5 * valueNoise(arcs[i] / 650, seed + 7));
    const lowland = 1 - smoothstep(0.004, 0.02, grade[i]);
    const fade = smoothstep(0, startFade, arcs[i]) * smoothstep(0, endFade, length - arcs[i]);
    const amplitude = strength * ratio * lambda * lowland * fade * quietAt(arcs[i])
      * (0.4 + 0.6 * valueNoise(arcs[i] / 850, seed + 13));
    // A third harmonic skews and fattens each loop like a real meander train.
    const shape = Math.sin(phase) + 0.2 * Math.sin(3 * phase + 0.7);
    const side = shape >= 0 ? 1 : -1, limit = envelope[side > 0 ? 1 : 0][i];
    target[i] = side * Math.min(Math.abs(shape) * amplitude, limit);
  }
  let displacement = gaussianValues(Array.from(target), arcs, 28);
  // Only new folds count: the caller has already faired the axis itself.
  const baseline = foldedSections(points, footAt);
  const fresh = bad => bad.filter(arc => !baseline.some(base => Math.abs(base - arc) < 48));
  for (let attempt = 0; attempt < 10; attempt++) {
    const shaped = resamplePolyline(points.map((p, i) => ({ ...p,
      x: p.x + basis[i].nx * displacement[i], z: p.z + basis[i].nz * displacement[i] })), 16);
    const shapedArcs = polylineArcs(shaped);
    const bad = fresh(foldedSections(shaped, footAt));
    if (!bad.length) return shaped;
    // Soften only around the problem and try again; the last attempts flatten it.
    const keep = attempt < 7 ? 0.45 : 0;
    displacement = displacement.map((d, i) => bad.some(arc => Math.abs(arc - arcs[i] / length * shapedArcs.at(-1)) < 200)
      ? d * keep : d);
  }
  return points.map(point => ({ ...point }));
}

// Sections where the fitted bank envelope would fold or touch another part of
// the same river. Returns arc positions of the offending samples.
function foldedSections(points, footAt) {
  const arcs = polylineArcs(points), bad = [];
  const feet = points.map(p => footAt(p));
  // Only folds are fatal here; the caller fairs bends that are merely tight.
  for (const sample of fittedCurvatures(points)) {
    if (Math.abs(sample.curvature) * feet[sample.source] >= 0.78) bad.push(arcs[sample.source]);
  }
  for (let i = 0; i < points.length; i += 2) for (let j = i + 4; j < points.length; j += 2) {
    const clearance = (feet[i] + feet[j]) * 1.05;
    if (arcs[j] - arcs[i] < clearance * 2) continue;
    if (Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z) < clearance) bad.push(arcs[i], arcs[j]);
  }
  return bad;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const t = length > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / length, 0, 1) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

function nearestIndex(points, x, z, from = 0, to = points.length - 1) {
  let best = -1, distance = Infinity;
  for (let j = from; j <= to; j++) {
    const d = (points[j].x - x) ** 2 + (points[j].z - z) ** 2;
    if (d < distance) { distance = d; best = j; }
  }
  return { index: best, distance: Math.sqrt(distance) };
}

/**
 * Bring a feeder into its receiving river. The feeder keeps its own valley
 * line until it nears the receiving banks, then swings in on a Hermite curve
 * that meets one parent station at a downstream-pointing angle. Returns the
 * feeder's new points (ending exactly on the station) and the station index,
 * or null when no clean confluence exists.
 */
export function attachBranch(child, parent, {
  parentFoot, parentHalfWidth, childFoot, minIndex = 2, maxIndex = parent.length - 3, spacing = 8,
} = {}) {
  if (child.length < 4 || maxIndex < minIndex) return null;
  const zone = (j, i) => parentFoot(j) + childFoot(i);
  const tangent = j => {
    const a = parent[Math.max(0, j - 1)], b = parent[Math.min(parent.length - 1, j + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
    return { x: tx / length, z: tz / length };
  };
  let cut = -1;
  for (let i = 0; i < child.length; i++) {
    const near = nearestIndex(parent, child[i].x, child[i].z);
    if (near.distance < zone(near.index, i) + 24) { cut = i - 1; break; }
  }
  if (cut < 0) cut = child.length - 2;
  if (cut < 3) return null;
  const tail = child[cut], before = child[cut - 2];
  const inX = tail.x - before.x, inZ = tail.z - before.z, inLength = Math.hypot(inX, inZ) || 1;
  const start = nearestIndex(parent, tail.x, tail.z);
  const candidates = [];
  for (let j = Math.max(minIndex, start.index - 3); j <= Math.min(maxIndex, start.index + 20); j++) {
    const p = parent[j], t = tangent(j);
    const cx = p.x - tail.x, cz = p.z - tail.z, chord = Math.hypot(cx, cz);
    // A long swing would run beside the receiving river before it joins.
    if (chord < 24 || chord > zone(j, cut) * 1.7 + 40) continue;
    // Angle between the incoming chord and the receiving current.
    const angle = Math.acos(clamp((cx * t.x + cz * t.z) / chord, -1, 1)) * 180 / Math.PI;
    if (angle < 25 || angle > 80) continue;
    const turn = Math.acos(clamp((cx * inX + cz * inZ) / (chord * inLength), -1, 1)) * 180 / Math.PI;
    if (turn > 70) continue;
    candidates.push({ j, t, chord, score: Math.abs(angle - 50) + turn * 0.5 + chord / zone(j, cut) * 6 });
  }
  candidates.sort((a, b) => a.score - b.score || a.j - b.j);
  for (const candidate of candidates.slice(0, 6)) {
    const target = parent[candidate.j], chord = candidate.chord;
    const startX = inX / inLength * chord, startZ = inZ / inLength * chord;
    let endX = (target.x - tail.x) / chord + candidate.t.x * 0.9, endZ = (target.z - tail.z) / chord + candidate.t.z * 0.9;
    const endLength = Math.hypot(endX, endZ) || 1;
    endX = endX / endLength * chord; endZ = endZ / endLength * chord;
    const points = child.slice(0, cut + 1).map(point => ({ ...point }));
    const count = Math.max(2, Math.ceil(chord / spacing));
    for (let k = 1; k <= count; k++) {
      const t = k / count, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      points.push({ x: h00 * tail.x + h10 * startX + h01 * target.x + h11 * endX,
        z: h00 * tail.z + h10 * startZ + h01 * target.z + h11 * endZ, area: tail.area });
    }
    points[points.length - 1] = { ...points.at(-1), x: target.x, z: target.z };
    // The swing may not cross the receiving river or run through its water
    // anywhere but at its own station.
    let clean = true;
    const guard = Math.ceil((parentHalfWidth(candidate.j) + 24) / 16) + 1;
    for (let k = cut + 1; k < points.length && clean; k++) {
      const p = points[k], q = points[k - 1];
      for (let j = 1; j < parent.length && clean; j++) {
        if (Math.abs(j - candidate.j) <= guard) continue;
        const a = parent[j - 1], b = parent[j];
        if (segmentsCross(q, p, a, b)) clean = false;
        else if (k < points.length - 1 && pointSegmentDistance(p, a, b) < parentHalfWidth(j) + 6) clean = false;
      }
    }
    if (clean) return { points, index: candidate.j };
  }
  return null;
}

// Circumcircle curvature of a Hermite-resampled route, matching the section
// fitter's own fold guard, together with the source point of each sample.
function fittedCurvatures(points, spacing = 4) {
  const samples = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
    const ta = hermiteTangent(points, i), tb = hermiteTangent(points, i + 1);
    for (let k = 0; k < count; k++) {
      const t = k / count, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      samples.push({ x: h00 * a.x + h10 * ta.x + h01 * b.x + h11 * tb.x,
        z: h00 * a.z + h10 * ta.z + h01 * b.z + h11 * tb.z, source: t < 0.5 ? i : i + 1 });
    }
  }
  samples.push({ x: points.at(-1).x, z: points.at(-1).z, source: points.length - 1 });
  return samples.map((p, i) => {
    const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const before = Math.hypot(p.x - a.x, p.z - a.z), after = Math.hypot(b.x - p.x, b.z - p.z);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const cross = (p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x);
    return { source: p.source, curvature: before * after * span > 1e-9 ? 2 * cross / (before * after * span) : 0 };
  });
}

// Same tangent rule as riverterrain's fittedRiverPath.
function hermiteTangent(points, index) {
  if (index === 0) return { x: points[1].x - points[0].x, z: points[1].z - points[0].z };
  if (index === points.length - 1) return { x: points[index].x - points[index - 1].x, z: points[index].z - points[index - 1].z };
  const previous = points[index - 1], point = points[index], next = points[index + 1];
  const ax = point.x - previous.x, az = point.z - previous.z, bx = next.x - point.x, bz = next.z - point.z;
  const al = Math.hypot(ax, az), bl = Math.hypot(bx, bz);
  const sx = ax / al + bx / bl, sz = az / al + bz / bl, sl = Math.hypot(sx, sz);
  if (sl < 1e-6) return { x: bx * 0.5, z: bz * 0.5 };
  const magnitude = Math.min(Math.min(al, bl) * 1.6, Math.sqrt(al * bl) * 0.8);
  return { x: sx / sl * magnitude, z: sz / sl * magnitude };
}

/**
 * Ease any bend that is too tight for the bank envelope expected there.
 * Fixed points (by index) never move. Returns the faired copy, or null when
 * the bends cannot be opened without moving a fixed point. `strict` holds the
 * evenly spaced result itself to the limit.
 */
export function fairCentreline(points, footAt, { fixed = new Set([0, points.length - 1]), limit = 0.6, passes = 60, strict = false } = {}) {
  let route = points.map(point => ({ ...point }));
  const tight = candidate => {
    const bad = new Set();
    for (const sample of fittedCurvatures(candidate)) {
      if (Math.abs(sample.curvature) * footAt(candidate[sample.source], sample.source) >= limit) bad.add(sample.source);
    }
    return bad;
  };
  for (let pass = 0; pass < passes; pass++) {
    const bad = tight(route);
    if (!bad.size) {
      if (!pass) return route;
      // Even spacing moves the vertices along the faired line and can set a
      // corner back into it. A strict caller needs the evenly spaced line to
      // pass the same check.
      const even = resamplePolyline(route, 16);
      if (!strict || !tight(even).size) return even;
      route = even;
      continue;
    }
    // Blend a broad Gaussian smoothing into the neighbourhood of each tight
    // bend. Wide kernels open a bend's radius quickly without flattening the
    // rest of the river.
    const arcs = polylineArcs(route), smooth = gaussianPolyline(route, 28), badArcs = [...bad].map(i => arcs[i]);
    route = route.map((point, i) => {
      if (fixed.has(i)) return point;
      let weight = 0;
      for (const arc of badArcs) weight = Math.max(weight, Math.exp(-((arcs[i] - arc) ** 2) / (2 * 40 * 40)));
      return weight > 1e-3 ? { ...point, x: point.x + (smooth[i].x - point.x) * weight,
        z: point.z + (smooth[i].z - point.z) * weight } : point;
    });
  }
  return tight(route).size ? null : resamplePolyline(route, 16);
}
