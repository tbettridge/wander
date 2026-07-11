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
