// The world model: pure functions from (x, z) world coordinates to height,
// climate and biome. Everything (terrain meshes, vegetation, audio, the
// player's feet) samples this one deterministic model, so all systems agree.

import { Noise2D, clamp, lerp, smoothstep } from './noise.js';

export const WATER_LEVEL = 0;

// Piecewise-linear spline for continental elevation: maps continent noise
// (-1..1) to base elevation in metres. Shapes ocean shelves, coastal plains
// and uplands the way hypsometric curves of real continents do.
const CONT_SPLINE = [
  [-1.0, -52], [-0.45, -22], [-0.18, -4], [-0.04, 1.5],
  [0.08, 6], [0.32, 20], [0.62, 42], [1.0, 72],
];

function splineEval(spline, v) {
  if (v <= spline[0][0]) return spline[0][1];
  for (let i = 1; i < spline.length; i++) {
    if (v <= spline[i][0]) {
      const [x0, y0] = spline[i - 1];
      const [x1, y1] = spline[i];
      return lerp(y0, y1, (v - x0) / (x1 - x0));
    }
  }
  return spline[spline.length - 1][1];
}

// Soft terracing for mesa / plateau country
function terrace(h, step) {
  const k = Math.floor(h / step);
  let f = (h - k * step) / step;
  f = f * f * (3 - 2 * f);
  f = f * f * (3 - 2 * f); // applied twice → wide flats, steep risers
  return (k + f) * step;
}

function coastTypeForCode(code) {
  if (code < 0.36) return 'dune';
  if (code < 0.50) return 'shingle';
  if (code < 0.64) return 'rocky';
  return 'chalk';
}

export class World {
  constructor(seed = 20260612) {
    this.seed = seed;
    this.warpA = new Noise2D(seed + 1);
    this.warpB = new Noise2D(seed + 2);
    this.continent = new Noise2D(seed + 3);
    this.mountainMask = new Noise2D(seed + 4);
    this.ridge = new Noise2D(seed + 5);
    this.plateau = new Noise2D(seed + 6);
    this.erosion = new Noise2D(seed + 7);
    this.detail = new Noise2D(seed + 8);
    this.river = new Noise2D(seed + 9);
    this.tempN = new Noise2D(seed + 10);
    this.moistN = new Noise2D(seed + 11);
    this.jitter = new Noise2D(seed + 12);
    this.outcrop = new Noise2D(seed + 13);
    this.glade = new Noise2D(seed + 14);
    this.rockN = new Noise2D(seed + 15);  // regional bedrock colour
    this.coastN = new Noise2D(seed + 16); // long coastal provinces / shore type
    this.coastDetail = new Noise2D(seed + 17); // strand, shelf and cliff irregularity
  }

  // Long coastal provinces give the shoreline a geological identity instead
  // of treating every water/land intersection as the same sandy beach. The
  // scalar form is also packed into the ocean depth texture so surf and shallow
  // colour can respond without duplicating the CPU noise function in GLSL.
  coastCodeAt(x, z) {
    return clamp(0.5 + 0.5 * this.coastN.noise(x * 0.00042 + 17.3, z * 0.00042 - 9.1), 0, 1);
  }

  coastTypeAt(x, z) {
    return coastTypeForCode(this.coastCodeAt(x, z));
  }

  height(x, z, riverOut) {
    // Domain warp bends every downstream feature so nothing looks gridded
    const wx = x + 150 * this.warpA.fbm(x * 0.0007, z * 0.0007, 2);
    const wz = z + 150 * this.warpB.fbm(x * 0.0007 + 7.3, z * 0.0007 - 3.1, 2);

    const c = this.continent.fbm(wx * 0.00022, wz * 0.00022, 4);
    const base = splineEval(CONT_SPLINE, c);
    const coastal = base > -12 && base < 24;
    const coastCode = coastal ? this.coastCodeAt(x, z) : 0;
    const chalkCoast = coastal ? smoothstep(0.64, 0.75, coastCode) : 0;
    const rockyCoast = coastal
      ? smoothstep(0.43, 0.54, coastCode) * (1 - smoothstep(0.65, 0.76, coastCode))
      : 0;
    let h = base;

    // Chalk provinces lift the first dry ground into a clean turf-capped
    // escarpment and flatten the shallow seabed into a wave-cut platform. A
    // little coastDetail breaks the top line without turning it into mountain
    // noise. Rocky provinces retain more local relief close to the water.
    if (chalkCoast > 0.001) {
      const edgeJitter = this.coastDetail.noise(x * 0.006 + 31, z * 0.006 - 17) * 0.55;
      const landSide = smoothstep(-0.9 + edgeJitter, 0.75 + edgeJitter, base);
      // Confine the escarpment to the first coastal rise. Extending the cap
      // into ordinary 10–20m inland terrain produced abrupt humps far beyond
      // sight of the sea and could distort otherwise valid cave entrances.
      const inlandFade = 1 - smoothstep(3, 9, base);
      const capHeight = 10.5 + 5.5 * (0.5 + 0.5 * this.coastDetail.noise(x * 0.0015, z * 0.0015));
      h += landSide * inlandFade * capHeight * chalkCoast;

      const shelfBand = smoothstep(-9.0, -3.0, base) * (1 - smoothstep(-1.4, 0.2, base));
      const shelfY = -1.15 + this.coastDetail.noise(x * 0.018, z * 0.018) * 0.28;
      h = lerp(h, shelfY, shelfBand * chalkCoast * 0.92);
    }

    // Mountain ranges: ridged multifractal gated by a low-frequency mask and
    // tapered near coasts so peaks rise from inland uplands
    const mShape = this.mountainMask.fbm(x * 0.00033, z * 0.00033, 3);
    const mMask = smoothstep(0.16, 0.6, mShape) * smoothstep(3, 16, base);
    if (mMask > 0.001) {
      const r = this.ridge.ridged(wx * 0.0016, wz * 0.0016, 5);
      h += Math.pow(r, 1.5) * 330 * mMask;
    }

    // Mesa / plateau country where mountains are absent
    const pm = smoothstep(0.5, 0.78, this.plateau.fbm(x * 0.00028 + 9.7, z * 0.00028, 3)) * (1 - mMask);
    if (pm > 0.01) {
      h = lerp(h, terrace(h * 1.35, 17) + 3, pm * 0.9);
    }

    // --- Local relief: a fractal tail across the ~10–160 m band so the ground
    // has knolls, dips, crests and gullies at human scale, not just broad swells.
    const ero = 0.5 + 0.5 * this.erosion.fbm(x * 0.0011, z * 0.0011, 3);
    const calmCoastDamp = smoothstep(1, 9, base); // dune/shingle beaches stay broad and walkable
    const ruggedCoastDamp = smoothstep(-2.5, 5.0, base);
    const coastDamp = lerp(calmCoastDamp, ruggedCoastDamp,
      clamp(rockyCoast * 0.78 + chalkCoast * 0.22, 0, 1));

    // regional character: smooth-rolling country vs broken, craggy country
    const rugged = smoothstep(0.4, 0.72, 0.5 + 0.5 * this.erosion.noise(x * 0.0007 + 19, z * 0.0007));

    const roll = this.detail.fbm(x * 0.006, z * 0.006, 4, 2.0, 0.55);            // billowy
    const turb = (this.ridge.ridged(x * 0.011 + 50, z * 0.011, 4) - 0.45) * 1.8;  // crests/gullies
    const relief = lerp(roll, roll * 0.45 + turb, rugged);
    h += relief * (3 + 15 * ero) * coastDamp;

    // mid + micro relief — the bands you feel underfoot
    h += this.detail.fbm(x * 0.022 + 100, z * 0.022, 3) * 2.2 * coastDamp;
    h += this.detail.fbm(x * 0.07 + 200, z * 0.07, 2) * 0.7 * coastDamp;

    // --- Rock outcrops & tors: scattered steep-sided bedrock rises. Their steep
    // flanks read as rock via groundColor, making discrete local landmarks.
    const ocMask = smoothstep(0.52, 0.74, this.outcrop.fbm(x * 0.004 + 71, z * 0.004 - 33, 2)) * coastDamp;
    if (ocMask > 0.001) {
      h += (4 + 13 * ocMask) * this.outcrop.ridged(x * 0.024 + 5, z * 0.024, 3);
    }

    // --- Rivers: water that flows downhill. The channel path is still the
    // warped-fbm zero-set, but the WATER SURFACE follows a smooth, large-scale
    // "hydraulic head" (the continental base elevation), NOT the local bank
    // height. The head only varies over kilometres at the continental slope
    // (a few degrees), so the surface descends/stays-flat and never climbs a
    // hill. Rivers are gated to lowland valley floors (gentle, low ground), so
    // they thread the low terrain and cut at most shallow valleys — they no
    // longer run up and over hills and mountains.
    const head = base;                                    // smooth descending water level
    // Nearness to the channel centreline. The band naturally balloons where the
    // noise field is flat — that's a feature: it pools into broad lakes/basins
    // in flat lowlands while staying a ribbon where the field has gradient.
    const rv = Math.abs(this.river.fbm(wx * 0.0005 + 41, wz * 0.0005, 3));
    const chRaw = 1 - smoothstep(0.0, 0.05, rv);
    const lowland = 1 - smoothstep(50, 85, base);         // big rivers belong to lowlands
    const incision = h - head;                            // how far local ground rises above valley level
    const valleyMask = 1 - smoothstep(14, 34, incision);  // thread valley floors, fade off high ground
    const ch = chRaw * lowland * valleyMask;

    const headY = head - 0.8;                             // channel water surface (smooth)
    let carve = 0;
    if (ch > 0.001) {
      const targetFloor = headY - 1.4;                    // channel bed sits below the surface
      carve = Math.max(h - targetFloor, 0) * Math.pow(ch, 1.6);
    }
    const floor = h - carve;

    if (riverOut) {
      // The EFFECTIVE water surface sinks below the terrain as the channel mask
      // fades, so the water sheet always dives underground before the mesh is
      // cut — shorelines are the true water/terrain intersection and banks
      // terminate naturally into the ground (no floating, stepped edges where
      // the old hard ch-cutoff landed over lower terrain). `head` stays the
      // pure smooth surface for flow direction / slope probes.
      const edge = smoothstep(0.0, 0.18, ch);
      riverOut.base = h;
      riverOut.ch = ch;
      riverOut.floor = floor;
      riverOut.head = headY;
      riverOut.waterY = lerp(floor - 1.2, headY, edge);
    }

    return floor;
  }

  // River water-surface query for a point: whether it's in a wet channel (above
  // sea level — the ocean covers the rest), the surface height, and its depth.
  riverAt(x, z) {
    const o = this._riverScratch || (this._riverScratch = { base: 0, ch: 0, floor: 0, head: 0, waterY: 0 });
    this.height(x, z, o);
    const submerge = o.waterY - o.floor;
    // The sinking waterY guarantees submerge <= 0 outside the channel, so the
    // ch gate is only a cheap bound (skip candidates far from any channel).
    const wet = submerge > 0.03 && o.waterY > WATER_LEVEL + 0.25 && o.ch > 0.001;
    // y: effective surface (sinks at margins). ySmooth: the pure channel head —
    // use it for flow direction / slope / rapids so shoreline sinking doesn't
    // read as false gradients.
    return { wet, y: o.waterY, ySmooth: o.head, depth: wet ? submerge : 0, floor: o.floor };
  }

  // Approximate surface normal by central differences on the height field
  normal(x, z, out) {
    const e = 1.5;
    const hx = this.height(x - e, z) - this.height(x + e, z);
    const hz = this.height(x, z - e) - this.height(x, z + e);
    const len = Math.hypot(hx, 2 * e, hz);
    out.set(hx / len, (2 * e) / len, hz / len);
    return out;
  }

  // Temperature (°C, includes altitude lapse rate) and moisture (0..1)
  climate(x, z, h) {
    const t = 15 + 17 * this.tempN.fbm(x * 0.00009, z * 0.00009, 3) - Math.max(0, h) * 0.055;
    const m = clamp(0.5 + 0.55 * this.moistN.fbm(x * 0.00013 + 31, z * 0.00013, 3), 0, 1);
    return { t, m };
  }

  // 0 = dense stand, 1 = open glade/meadow. A low-frequency field (~400 m) used
  // to thin trees into clearings and copses, so forests breathe with open and
  // closed spaces instead of a uniform carpet.
  openFactor(x, z) {
    return smoothstep(0.18, 0.55, this.glade.fbm(x * 0.0025 + 60, z * 0.0025, 3));
  }

  // 0 = open gap, 1 = inside a stand. A mid-frequency field (~70 m) that gathers
  // trees into copses with open ground between — the open/closed alternation
  // that makes a forest read as a sequence of rooms rather than a flat carpet.
  groveFactor(x, z) {
    return smoothstep(0.4, 0.72, 0.5 + 0.5 * this.glade.fbm(x * 0.014 - 120, z * 0.014 + 80, 3));
  }

  // slope: 0 = flat, 1 = vertical (1 - normalY)
  classify(h, slope, t, m) {
    if (h < 0.25) return 'ocean';
    if (t < -4.5) return 'snow';
    if (h < 2.8 && slope < 0.35 && t > 0) return 'beach';
    if (t < 0.5) return 'tundra';
    if (t < 6.5) return 'taiga';
    if (t > 19) {
      if (m < 0.34) return 'desert';
      if (m < 0.55) return 'savanna';
      return 'jungle';
    }
    if (m < 0.44) return 'grassland';
    return 'forest';
  }

  biomeAt(x, z) {
    const h = this.height(x, z);
    const e = 1.5;
    const hx = this.height(x - e, z) - this.height(x + e, z);
    const hz = this.height(x, z - e) - this.height(x, z + e);
    const ny = (2 * e) / Math.hypot(hx, 2 * e, hz);
    const { t, m } = this.climate(x, z, h);
    const coastCode = this.coastCodeAt(x, z);
    return {
      h, slope: 1 - ny, t, m,
      id: this.classify(h, 1 - ny, t, m),
      coastType: coastTypeForCode(coastCode),
      coastCode,
    };
  }
}

// ---------------------------------------------------------------------------
// Ground colouring (terrain vertex colours)

const C = {
  deepSea:   [0.10, 0.16, 0.18],
  shallows:  [0.55, 0.52, 0.38],
  beach:     [0.76, 0.72, 0.59],
  desert:    [0.77, 0.64, 0.42],
  savanna:   [0.58, 0.52, 0.28],
  jungle:    [0.20, 0.33, 0.13],
  grassland: [0.40, 0.48, 0.24],
  forest:    [0.29, 0.37, 0.18],
  taiga:     [0.30, 0.36, 0.25],
  tundra:    [0.48, 0.46, 0.36],
  snow:      [0.90, 0.91, 0.94],
  rock:      [0.44, 0.41, 0.38],
};

// Writes ground RGB into out[]. Blends biome base colour with slope aspect,
// regional bedrock, exposed/alpine/scree rock, a patchy snowline and shoreline
// wetness, plus high-frequency jitter. nx/nz are the horizontal terrain normal
// (optional) used for sun-aspect shading.
export function groundColor(world, x, z, h, slope, t, m, out, nx, nz) {
  const id = world.classify(h, slope, t, m);
  const base = C[id] || C.grassland;
  let r = base[0], g = base[1], b = base[2];

  if (id === 'ocean') {
    // Coastal geology tints the visible seabed: pale aqua below chalk, cool
    // slate around rocky/shingle shores, warmer green over dune sand.
    const d = smoothstep(0, 26, -h);
    const coastCode = world.coastCodeAt(x, z);
    const chalk = smoothstep(0.64, 0.77, coastCode);
    const rocky = smoothstep(0.43, 0.56, coastCode) * (1 - chalk);
    const shallowR = lerp(lerp(0.50, 0.37, rocky), 0.66, chalk);
    const shallowG = lerp(lerp(0.55, 0.47, rocky), 0.70, chalk);
    const shallowB = lerp(lerp(0.43, 0.48, rocky), 0.62, chalk);
    r = lerp(shallowR, C.deepSea[0], d);
    g = lerp(shallowG, C.deepSea[1], d);
    b = lerp(shallowB, C.deepSea[2], d);
    const jo = 1 + world.jitter.noise(x * 0.15, z * 0.15) * 0.07;
    out[0] = clamp(r * jo, 0, 1); out[1] = clamp(g * jo, 0, 1); out[2] = clamp(b * jo, 0, 1);
    return;
  }

  // temperate biomes blend into each other with moisture
  if (id === 'grassland' || id === 'forest') {
    const f = smoothstep(0.34, 0.54, m);
    r = lerp(C.grassland[0], C.forest[0], f);
    g = lerp(C.grassland[1], C.forest[1], f);
    b = lerp(C.grassland[2], C.forest[2], f);
  }

  if (id === 'beach') {
    const coastCode = world.coastCodeAt(x, z);
    const shingle = smoothstep(0.28, 0.39, coastCode) * (1 - smoothstep(0.50, 0.58, coastCode));
    const rocky = smoothstep(0.47, 0.56, coastCode) * (1 - smoothstep(0.65, 0.74, coastCode));
    const chalk = smoothstep(0.64, 0.75, coastCode);
    r = lerp(r, 0.56, shingle * 0.65 + rocky * 0.38);
    g = lerp(g, 0.56, shingle * 0.65 + rocky * 0.38);
    b = lerp(b, 0.54, shingle * 0.65 + rocky * 0.38);
    r = lerp(r, 0.82, chalk * 0.72);
    g = lerp(g, 0.80, chalk * 0.72);
    b = lerp(b, 0.70, chalk * 0.72);

    // A dark, irregular wrack/strand line sits above the ordinary wet-sand
    // band. Geometry dressing follows the same approximate height envelope.
    const strandY = 1.02 + world.coastDetail.noise(x * 0.018 + 41, z * 0.018) * 0.24;
    const strand = 1 - smoothstep(0.08, 0.42, Math.abs(h - strandY));
    r = lerp(r, 0.24, strand * 0.28);
    g = lerp(g, 0.27, strand * 0.28);
    b = lerp(b, 0.18, strand * 0.28);
  }

  // aspect: equator-facing slopes (here −z) are sun-baked & drier/browner,
  // poleward (+z) slopes stay cooler, greener and mossier — only on real slopes
  const az = nz || 0;
  const slp = smoothstep(0.12, 0.5, slope);
  const sunny = clamp(-az, 0, 1) * slp;
  const shade = clamp(az, 0, 1) * slp;
  r *= 1 + sunny * 0.12 - shade * 0.04;
  g *= 1 + sunny * 0.02 + shade * 0.05;
  b *= 1 - sunny * 0.14 + shade * 0.04;

  // regional bedrock: dark basalt → grey granite → red sandstone by a slow field
  const rk = world.rockN.fbm(x * 0.00022 + 13, z * 0.00022, 2);
  const ab = smoothstep(-0.45, -0.1, rk);   // basalt → granite
  const sb = smoothstep(0.10, 0.50, rk);    // granite → sandstone
  const rkR = lerp(lerp(0.25, 0.44, ab), 0.60, sb);
  const rkG = lerp(lerp(0.24, 0.41, ab), 0.40, sb);
  const rkB = lerp(lerp(0.26, 0.38, ab), 0.29, sb);

  // exposed rock on steep ground, plus a little on very high ground
  const rockF = Math.max(smoothstep(0.42, 0.72, slope), smoothstep(160, 240, h) * 0.6);
  r = lerp(r, rkR, rockF); g = lerp(g, rkG, rockF); b = lerp(b, rkB, rockF);

  // Low chalk faces stay pale and horizontally banded with occasional flint.
  // This applies after generic bedrock so the coastal geology remains legible.
  if (world.coastTypeAt(x, z) === 'chalk' && h < 34) {
    const face = smoothstep(0.20, 0.58, slope);
    const bandNoise = world.coastDetail.noise(x * 0.035 + 5, z * 0.035 - 11) * 0.7;
    const flint = smoothstep(0.78, 0.96, Math.sin(h * 1.72 + bandNoise) * 0.5 + 0.5) * face;
    r = lerp(r, 0.82, face * 0.88); g = lerp(g, 0.83, face * 0.88); b = lerp(b, 0.78, face * 0.88);
    r = lerp(r, 0.24, flint * 0.46); g = lerp(g, 0.26, flint * 0.46); b = lerp(b, 0.27, flint * 0.46);
  }

  // scree: paler, broken rubble on steep high alpine slopes
  const screeF = smoothstep(0.5, 0.78, slope) * smoothstep(115, 185, h) * 0.55;
  r = lerp(r, rkR * 1.28 + 0.07, screeF);
  g = lerp(g, rkG * 1.28 + 0.07, screeF);
  b = lerp(b, rkB * 1.28 + 0.07, screeF);

  // snow caps: accumulate on cold ground, mostly on gentle slopes, with a
  // patchy, noise-broken snowline (steep faces stay bare rock)
  const snowJ = world.jitter.noise(x * 0.012 + 9, z * 0.012) * 1.9;
  const snowGentle = 1 - smoothstep(0.5, 0.82, slope);
  const snowF = smoothstep(2.0, -4.5, t + snowJ) * snowGentle;
  r = lerp(r, 0.93, snowF); g = lerp(g, 0.945, snowF); b = lerp(b, 0.98, snowF);

  // wet darkening right at the shore
  const wetF = smoothstep(1.6, 0.4, h);
  r *= 1 - wetF * 0.25; g *= 1 - wetF * 0.25; b *= 1 - wetF * 0.2;

  const j = 1 + world.jitter.noise(x * 0.15, z * 0.15) * 0.07
              + world.jitter.noise(x * 0.018, z * 0.018) * 0.05;
  out[0] = clamp(r * j, 0, 1);
  out[1] = clamp(g * j, 0, 1);
  out[2] = clamp(b * j, 0, 1);
}
