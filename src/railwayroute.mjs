const EPSILON = 1e-9;

function wrap(value, length) {
  if (!(length > 0)) return 0;
  return ((value % length) + length) % length;
}

function catmull(a, b, c, d, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b
    + (-a + c) * t
    + (2 * a - 5 * b + 4 * c - d) * t2
    + (-a + 3 * b - 3 * c + d) * t3
  );
}

function closedControlPoint(points, t, out) {
  const count = points.length;
  const scaled = wrap(t, 1) * count;
  const i1 = Math.floor(scaled) % count;
  const localT = scaled - Math.floor(scaled);
  const p0 = points[(i1 - 1 + count) % count];
  const p1 = points[i1];
  const p2 = points[(i1 + 1) % count];
  const p3 = points[(i1 + 2) % count];
  out.x = catmull(p0.x, p1.x, p2.x, p3.x, localT);
  out.z = catmull(p0.z, p1.z, p2.z, p3.z, localT);
  return out;
}

/**
 * Arc-length sampled closed route. It deliberately has no THREE dependency so
 * the route math can run in workers and Node tests as the railway grows.
 */
export class ClosedRailRoute {
  constructor(positions) {
    if (!positions || positions.length < 12 || positions.length % 3 !== 0) {
      throw new Error('ClosedRailRoute needs at least four xyz samples');
    }
    this.positions = positions instanceof Float64Array
      ? positions
      : Float64Array.from(positions);
    this.sampleCount = this.positions.length / 3;
    this.arc = new Float64Array(this.sampleCount + 1);
    this.tangents = new Float64Array(this.positions.length);
    this.maxGrade = 0;
    let horizontalLength = 0;
    let absoluteRise = 0;

    for (let i = 0; i < this.sampleCount; i++) {
      const j = (i + 1) % this.sampleCount;
      const dx = this.positions[j * 3] - this.positions[i * 3];
      const dy = this.positions[j * 3 + 1] - this.positions[i * 3 + 1];
      const dz = this.positions[j * 3 + 2] - this.positions[i * 3 + 2];
      const horizontal = Math.hypot(dx, dz);
      horizontalLength += horizontal;
      absoluteRise += Math.abs(dy);
      this.maxGrade = Math.max(this.maxGrade, Math.abs(dy) / Math.max(EPSILON, horizontal));
      this.arc[i + 1] = this.arc[i] + Math.hypot(dx, dy, dz);
    }
    this.length = this.arc[this.sampleCount];
    this.meanGrade = absoluteRise / Math.max(EPSILON, horizontalLength);

    for (let i = 0; i < this.sampleCount; i++) {
      const prev = (i - 1 + this.sampleCount) % this.sampleCount;
      const next = (i + 1) % this.sampleCount;
      let tx = this.positions[next * 3] - this.positions[prev * 3];
      let ty = this.positions[next * 3 + 1] - this.positions[prev * 3 + 1];
      let tz = this.positions[next * 3 + 2] - this.positions[prev * 3 + 2];
      const inv = 1 / Math.max(EPSILON, Math.hypot(tx, ty, tz));
      tx *= inv; ty *= inv; tz *= inv;
      this.tangents[i * 3] = tx;
      this.tangents[i * 3 + 1] = ty;
      this.tangents[i * 3 + 2] = tz;
    }
  }

  sampleAtDistance(distance, out = {}) {
    const d = wrap(distance, this.length);
    let low = 0, high = this.sampleCount;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (this.arc[mid] <= d) low = mid;
      else high = mid;
    }
    const i = Math.min(low, this.sampleCount - 1);
    const j = (i + 1) % this.sampleCount;
    const segmentLength = this.arc[i + 1] - this.arc[i];
    const f = segmentLength > EPSILON ? (d - this.arc[i]) / segmentLength : 0;
    const a = i * 3, b = j * 3;

    out.x = this.positions[a] + (this.positions[b] - this.positions[a]) * f;
    out.y = this.positions[a + 1] + (this.positions[b + 1] - this.positions[a + 1]) * f;
    out.z = this.positions[a + 2] + (this.positions[b + 2] - this.positions[a + 2]) * f;

    let tx = this.tangents[a] + (this.tangents[b] - this.tangents[a]) * f;
    let ty = this.tangents[a + 1] + (this.tangents[b + 1] - this.tangents[a + 1]) * f;
    let tz = this.tangents[a + 2] + (this.tangents[b + 2] - this.tangents[a + 2]) * f;
    const invT = 1 / Math.max(EPSILON, Math.hypot(tx, ty, tz));
    tx *= invT; ty *= invT; tz *= invT;
    out.tangentX = tx; out.tangentY = ty; out.tangentZ = tz;

    let rx = tz, rz = -tx;
    const invR = 1 / Math.max(EPSILON, Math.hypot(rx, rz));
    rx *= invR; rz *= invR;
    out.rightX = rx; out.rightY = 0; out.rightZ = rz;

    // forward × right gives a stable, minimally banked local up vector.
    let ux = ty * rz;
    let uy = tz * rx - tx * rz;
    let uz = -ty * rx;
    const invU = 1 / Math.max(EPSILON, Math.hypot(ux, uy, uz));
    ux *= invU; uy *= invU; uz *= invU;
    out.upX = ux; out.upY = uy; out.upZ = uz;
    out.distance = d;
    return out;
  }

  nearestDistance(x, z) {
    let bestDistance = 0;
    let bestSq = Infinity;
    for (let i = 0; i < this.sampleCount; i++) {
      const dx = this.positions[i * 3] - x;
      const dz = this.positions[i * 3 + 2] - z;
      const sq = dx * dx + dz * dz;
      if (sq < bestSq) {
        bestSq = sq;
        bestDistance = this.arc[i];
      }
    }
    return bestDistance;
  }
}

/** Build a manual closed spline, seat it on terrain, and soften only its
 * vertical profile. The route remains above every sampled terrain point so the
 * Phase-1 laboratory does not expose buried rails before earthworks exist. */
export function createClosedRailRoute(controlPoints, heightAt, {
  sampleCount = 720,
  formationClearance = 0.28,
  verticalSmoothPasses = 3,
  verticalWindow = 4,
} = {}) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 4) {
    throw new Error('createClosedRailRoute needs at least four control points');
  }
  const count = Math.max(32, Math.floor(sampleCount));
  const positions = new Float64Array(count * 3);
  const rawHeight = new Float64Array(count);
  const point = { x: 0, z: 0 };

  for (let i = 0; i < count; i++) {
    closedControlPoint(controlPoints, i / count, point);
    const terrainY = Number(heightAt(point.x, point.z));
    const y = (Number.isFinite(terrainY) ? terrainY : 0) + formationClearance;
    positions[i * 3] = point.x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = point.z;
    rawHeight[i] = y;
  }

  let source = Float64Array.from(rawHeight);
  for (let pass = 0; pass < verticalSmoothPasses; pass++) {
    const smoothed = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let total = 0, weight = 0;
      for (let k = -verticalWindow; k <= verticalWindow; k++) {
        const w = verticalWindow + 1 - Math.abs(k);
        total += source[(i + k + count) % count] * w;
        weight += w;
      }
      // Never let smoothing bury the formation in the source terrain.
      smoothed[i] = Math.max(rawHeight[i] - 0.08, total / weight);
    }
    source = smoothed;
  }
  for (let i = 0; i < count; i++) positions[i * 3 + 1] = source[i];
  return new ClosedRailRoute(positions);
}
