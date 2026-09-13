// Seeded 2D gradient noise + fractal helpers. Deterministic for a given seed,
// so every chunk of the infinite world regenerates identically.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export class Noise2D {
  constructor(seed = 0) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  // Classic Perlin, output roughly -1..1
  noise(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const p = this.perm;
    const g00 = GRAD[p[p[xi] + yi] & 7];
    const g10 = GRAD[p[p[xi + 1] + yi] & 7];
    const g01 = GRAD[p[p[xi] + yi + 1] & 7];
    const g11 = GRAD[p[p[xi + 1] + yi + 1] & 7];
    const n00 = g00[0] * xf + g00[1] * yf;
    const n10 = g10[0] * (xf - 1) + g10[1] * yf;
    const n01 = g01[0] * xf + g01[1] * (yf - 1);
    const n11 = g11[0] * (xf - 1) + g11[1] * (yf - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.42;
  }

  // Fractional Brownian motion, normalized to roughly -1..1
  fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      x *= lacunarity; y *= lacunarity;
    }
    return sum / norm;
  }

  // Conservative range over a rectangle, including between sample points.
  // Each gradient component is <= 1. Across a cell, adjacent dot products
  // differ by <= 3; quintic fade has maximum derivative 1.875. Thus each
  // partial derivative of noise is bounded by 1.42 * (1 + 3 * 1.875).
  // Cell boundaries are continuous, so the same bound spans multiple cells.
  fbmBounds(minX, minY, maxX, maxY, octaves = 4, lacunarity = 2, gain = 0.5) {
    if (![minX, minY, maxX, maxY, lacunarity, gain].every(Number.isFinite)
      || minX > maxX || minY > maxY || !Number.isInteger(octaves) || octaves < 1 || octaves > 16
      || lacunarity < 1 || gain < 0 || gain > 1) throw new Error('Invalid noise bounds');
    let amplitude = 1, frequency = 1, norm = 0, derivative = 0, lower = 0, upper = 0;
    for (let i = 0; i < octaves; i++) {
      norm += amplitude; derivative += amplitude * frequency;
      const range = this.noiseBounds(minX * frequency, minY * frequency, maxX * frequency, maxY * frequency);
      lower += amplitude * range[0]; upper += amplitude * range[1];
      amplitude *= gain; frequency *= lacunarity;
    }
    const value = this.fbm((minX + maxX) / 2, (minY + maxY) / 2, octaves, lacunarity, gain);
    const radius = 1.42 * (1 + 3 * 1.875) * derivative / norm
      * ((maxX - minX + maxY - minY) / 2);
    return [Math.max(lower / norm, value - radius) - 1e-12,
      Math.min(upper / norm, value + radius) + 1e-12];
  }

  // Interval evaluation of the actual lattice gradients is much tighter than
  // a global derivative bound in flat parts of the field. Quintic fade is
  // monotone on [0,1]; interpolation extrema occur at interval endpoints.
  // Split across lattice boundaries so no interval uses the wrong gradients.
  noiseBounds(minX, minY, maxX, maxY) {
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX > maxX || minY > maxY) {
      throw new Error('Invalid noise rectangle');
    }
    const x0 = Math.floor(minX), y0 = Math.floor(minY), x1 = Math.floor(maxX), y1 = Math.floor(maxY);
    // Each corner dot product is in [-2,2], and all interpolation weights
    // are nonnegative. Bound cost even for very large input rectangles.
    if (!Number.isSafeInteger(x0) || !Number.isSafeInteger(y0)
      || !Number.isSafeInteger(x1 + 1) || !Number.isSafeInteger(y1 + 1)
      || (x1 - x0 + 1) * (y1 - y0 + 1) > 64) return [-2.84, 2.84];
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const mix = (a, b, lo, hi) => [
      Math.min(a[0] * (1 - lo) + b[0] * lo, a[0] * (1 - hi) + b[0] * hi),
      Math.max(a[1] * (1 - lo) + b[1] * lo, a[1] * (1 - hi) + b[1] * hi),
    ];
    let lower = Infinity, upper = -Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const xl = Math.max(0, minX - x), xh = Math.min(1, maxX - x);
      const yl = Math.max(0, minY - y), yh = Math.min(1, maxY - y);
      const dot = (dx, dy) => {
        const g = GRAD[this.perm[this.perm[(x & 255) + dx] + (y & 255) + dy] & 7];
        const a = g[0] * (xl - dx), b = g[0] * (xh - dx);
        const c = g[1] * (yl - dy), d = g[1] * (yh - dy);
        return [Math.min(a, b) + Math.min(c, d), Math.max(a, b) + Math.max(c, d)];
      };
      const u0 = fade(xl), u1 = fade(xh);
      const range = mix(mix(dot(0, 0), dot(1, 0), u0, u1),
        mix(dot(0, 1), dot(1, 1), u0, u1), fade(yl), fade(yh));
      lower = Math.min(lower, range[0] * 1.42); upper = Math.max(upper, range[1] * 1.42);
    }
    return [lower - 1e-12, upper + 1e-12];
  }

  // Ridged multifractal, output 0..1 — sharp crests, good for mountain ranges
  ridged(x, y, octaves = 5, lacunarity = 2.1, gain = 0.5) {
    let sum = 0, amp = 0.6, freqX = x, freqY = y, prev = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise(freqX, freqY));
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      amp *= gain;
      freqX *= lacunarity; freqY *= lacunarity;
    }
    return sum / norm;
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
