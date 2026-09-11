// The world model: pure functions from (x, z) world coordinates to height,
// climate and biome. Everything (terrain meshes, vegetation, audio, the
// player's feet) samples this one deterministic model, so all systems agree.

import { Noise2D, clamp, lerp, smoothstep } from './noise.js';
import { GROUND } from './palette.mjs';
import { WaterField } from './waterfield.mjs';
import { CrossingReservations } from './crossingregistry.mjs';
import { setWorldRailwayTerrain } from './railwayterrain.mjs';

export const WATER_LEVEL = 0;
export const WORLD_GENERATION_VERSION = 2;

// River geometry is described by one continuous cross-section field. The
// values are in the river noise domain rather than metres because the gradient
// of that field naturally widens slow, flat reaches into pools.
const RIVER_WATER_BAND = 0.040;
const RIVER_INFLUENCE_BAND = RIVER_WATER_BAND * 2;
const RIVER_BED_DEPTH = 1.4;
const RIVER_BANK_CREST = 0.55;
const RIVER_MAX_BANK_FILL = 2.0;
const RIVER_SECTION_EPSILON = 4;
const RIVER_PLAN_CELL = 24;

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
  constructor(seed = 20260612, { waterPlans = null, crossingManifests = [] } = {}) {
    this.seed = seed;
    this.generationVersion = WORLD_GENERATION_VERSION;
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
    if (waterPlans) this.installWaterPlans(waterPlans, crossingManifests);
  }

  installWaterPlans(plans, crossingManifests = []) {
    // Construct/validate before publishing. Failure leaves the previous whole
    // world active. A layout world never contains the experimental water field.
    const field = new WaterField(this.seed, plans);
    const crossings = new CrossingReservations(crossingManifests);
    if (crossings.seed !== undefined && crossings.seed !== this.seed) throw new Error('Crossing manifest seed mismatch');
    for (const plan of field.plans) {
      if (plan.crossingManifestHash && !crossings.manifests.some(manifest => manifest.hash === plan.crossingManifestHash)) {
        throw new Error('Missing crossing manifest for water plan');
      }
    }
    if (!this.layoutWorld) {
      const layoutWorld = new World(this.seed);
      if (this.railwayTerrain) setWorldRailwayTerrain(layoutWorld, this.railwayTerrain);
      this.layoutWorld = layoutWorld;
    }
    crossings.bind(this);
    this.waterField = field;
    this.waterPlanHash = field.hash;
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

  _naturalHeight(x, z, out) {
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

    if (out) {
      out.h = h;
      out.base = base;
      out.wx = wx;
      out.wz = wz;
    }
    return h;
  }

  _riverSignalAt(x, z) {
    const wx = x + 150 * this.warpA.fbm(x * 0.0007, z * 0.0007, 2);
    const wz = z + 150 * this.warpB.fbm(x * 0.0007 + 7.3, z * 0.0007 - 3.1, 2);
    return this.river.fbm(wx * 0.0005 + 41, wz * 0.0005, 3);
  }

  _riverBaseAt(x, z) {
    const wx = x + 150 * this.warpA.fbm(x * 0.0007, z * 0.0007, 2);
    const wz = z + 150 * this.warpB.fbm(x * 0.0007 + 7.3, z * 0.0007 - 3.1, 2);
    return splineEval(CONT_SPLINE, this.continent.fbm(wx * 0.00022, wz * 0.00022, 4));
  }

  _riverPlanSample(ix, iz) {
    const cache = this._riverPlanCache || (this._riverPlanCache = new Map());
    const key = `${ix},${iz}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const x = ix * RIVER_PLAN_CELL, z = iz * RIVER_PLAN_CELL;
    const e = RIVER_SECTION_EPSILON;
    let centerX = x, centerZ = z, gx = 0, gz = 0, gradient = 0;
    for (let iteration = 0; iteration < 4; iteration++) {
      gx = (this._riverSignalAt(centerX + e, centerZ) - this._riverSignalAt(centerX - e, centerZ)) / (2 * e);
      gz = (this._riverSignalAt(centerX, centerZ + e) - this._riverSignalAt(centerX, centerZ - e)) / (2 * e);
      gradient = Math.hypot(gx, gz);
      if (gradient < 1e-7) break;
      const residual = this._riverSignalAt(centerX, centerZ);
      const correction = clamp(residual / gradient, -28, 28);
      centerX -= (gx / gradient) * correction;
      centerZ -= (gz / gradient) * correction;
      if (Math.abs(residual) < 1e-5) break;
    }
    if (gradient < 1e-7) { gx = 1; gz = 0; gradient = 1; }

    const centerBase = this._riverBaseAt(centerX, centerZ);
    const lowland = 1 - smoothstep(50, 85, centerBase);
    const centerNatural = {};
    this._naturalHeight(centerX, centerZ, centerNatural);
    const valley = 1 - smoothstep(14, 34, centerNatural.h - centerNatural.base);
    const route = lowland * valley;
    const nx = gx / gradient, nz = gz / gradient;
    const halfWidth = clamp(RIVER_WATER_BAND / gradient, 6, 80);
    const bankOffset = halfWidth + Math.min(12, halfWidth * 0.35 + 3);
    let naturalBank = Infinity;
    for (let side = -1; side <= 1; side += 2) {
      const bank = {};
      this._naturalHeight(centerX + nx * bankOffset * side, centerZ + nz * bankOffset * side, bank);
      naturalBank = Math.min(naturalBank, bank.h);
    }
    // Lower the section's whole surface to a level its surroundings can hold.
    // Suppressing individual planning cells instead fragments a continuous
    // channel into angular pools. This level is shared by bed and both banks;
    // it never depends on distance to the lateral water edge.
    const waterY = Math.min(centerBase - 0.8, naturalBank + RIVER_MAX_BANK_FILL - RIVER_BANK_CREST);
    const sample = { waterY, route, centerX, centerZ };
    // A worker naturally revisits a small streaming neighbourhood. Bound the
    // cache so debug teleports through many regions cannot retain the world.
    if (cache.size >= 8192) cache.clear();
    cache.set(key, sample);
    return sample;
  }

  _riverPlanAt(x, z, out, centerline = false) {
    const gx = x / RIVER_PLAN_CELL, gz = z / RIVER_PLAN_CELL;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    // Adjacent terrain vertices usually share a planning cell. Keep its four
    // immutable samples in each query domain to avoid eight Map/string-key
    // lookups per height sample. This is bounded memoization, not new state.
    const slot = centerline ? '_riverCenterCell' : '_riverLocalCell';
    let cell = this[slot];
    if (!cell || cell.ix !== ix || cell.iz !== iz) {
      cell = this[slot] = { ix, iz,
        a: this._riverPlanSample(ix, iz),
        b: this._riverPlanSample(ix + 1, iz),
        c: this._riverPlanSample(ix, iz + 1),
        d: this._riverPlanSample(ix + 1, iz + 1),
      };
    }
    const { a, b, c, d } = cell;
    out.waterY = lerp(lerp(a.waterY, b.waterY, fx), lerp(c.waterY, d.waterY, fx), fz);
    out.route = lerp(lerp(a.route, b.route, fx), lerp(c.route, d.route, fx), fz);
    out.centerX = lerp(lerp(a.centerX, b.centerX, fx), lerp(c.centerX, d.centerX, fx), fz);
    out.centerZ = lerp(lerp(a.centerZ, b.centerZ, fx), lerp(c.centerZ, d.centerZ, fx), fz);
    return out;
  }

  _riverSectionAt(x, z, natural, out) {
    const signal = this.river.fbm(natural.wx * 0.0005 + 41, natural.wz * 0.0005, 3);
    const absSignal = Math.abs(signal);
    const fallbackHead = natural.base - 0.8;
    if (absSignal >= RIVER_INFLUENCE_BAND || natural.base >= 85) {
      out.base = natural.h;
      out.ch = 0;
      out.floor = natural.h;
      out.head = fallbackHead;
      out.waterY = fallbackHead;
      out.domainDepth = -RIVER_BED_DEPTH;
      out.signedDepth = -RIVER_BED_DEPTH;
      out.riverInfluence = false;
      return natural.h;
    }

    // Expensive centreline projection and bank feasibility are evaluated on a
    // globally anchored planning grid and bilinearly interpolated here. Terrain
    // generation then pays the planning cost once per 24m cell instead of once
    // per vertex, while neighbouring chunks receive identical values.
    const plan = this._riverPlanAt(x, z, this._riverPlanScratch || (this._riverPlanScratch = {}));
    // Query the common centreline level, rather than the planning cell under
    // the bank. Both sides then use the same section even where neighbouring
    // cells have different feasible levels.
    this._riverPlanAt(plan.centerX, plan.centerZ, plan, true);
    const waterY = plan.waterY;
    const route = plan.route;

    // q=0 is the centre and q=1 the shoreline. Use the same linear signed
    // profile immediately inside and outside q=1, so interpolation on a coarse
    // terrain triangle puts the zero-depth water vertex exactly on its ground
    // intersection rather than merely near the analytic shoreline.
    // Fading the route raises q longitudinally too, so sources and interrupted
    // reaches close with solid terrain rather than an exposed water edge.
    const lateralQ = absSignal / RIVER_WATER_BAND;
    const routeQ = (1 - route) * 2;
    const q = Math.max(lateralQ, routeQ);
    const bedShoulderQ = 0.48;
    const shoreSlope = RIVER_BED_DEPTH / (1 - bedShoulderQ);
    const crestQ = 1 + RIVER_BANK_CREST / shoreSlope;
    let floor = natural.h;
    if (q <= bedShoulderQ) {
      floor = waterY - RIVER_BED_DEPTH;
    } else if (q < crestQ) {
      floor = waterY - shoreSlope * (1 - q);
    } else if (q < 2) {
      floor = lerp(waterY + RIVER_BANK_CREST, natural.h, smoothstep(crestQ, 2, q));
    }

    const domainDepth = shoreSlope * (1 - q);
    out.base = natural.h;
    out.ch = clamp(1 - q, 0, 1);
    out.floor = floor;
    out.head = waterY;
    out.waterY = waterY;
    out.domainDepth = domainDepth;
    const actualDepth = waterY - floor;
    out.signedDepth = actualDepth <= 0 || q < 1
      ? actualDepth
      : Math.min(-1e-4, domainDepth);
    out.riverInfluence = q < 2;
    return floor;
  }

  height(x, z, riverOut) {
    const natural = this._naturalScratch || (this._naturalScratch = {});
    this._naturalHeight(x, z, natural);
    const river = riverOut || this._riverScratchHeight || (this._riverScratchHeight = {});
    if (this.waterField) {
      river.bodyId = null; river.bodyKind = 'river'; river.waterKind = 0;
      river.flowX = river.flowZ = NaN;
      river.turbidity = 0.25; river.exposure = 0.2; river.turbulence = 0;
      river.estuary = 1; // legacy reaches keep their existing mouth treatment
      if (this.waterField.sample(x, z, natural.h, river)) return river.floor;
    }
    return this._riverSectionAt(x, z, natural, river);
  }

  // River water-surface query for a point: whether it's in a wet channel (above
  // sea level — the ocean covers the rest), the surface height, and its depth.
  riverAt(x, z) {
    const o = this._riverScratch || (this._riverScratch = { base: 0, ch: 0, floor: 0, head: 0, waterY: 0 });
    this.height(x, z, o);
    const submerge = o.waterY - o.floor;
    const wet = o.signedDepth > 0.03 && o.waterY > WATER_LEVEL + 0.25 && o.ch > 0.001;
    if (!this.waterField) return { wet, y: o.waterY, ySmooth: o.head, depth: wet ? submerge : 0, floor: o.floor };
    return { wet, y: o.waterY, ySmooth: o.head, depth: wet ? submerge : 0, floor: o.floor,
      bodyId: o.bodyId || null, kind: o.bodyKind || 'river',
      flowX: o.flowX, flowZ: o.flowZ, turbulence: o.turbulence || 0,
      turbidity: o.turbidity ?? 0.25, exposure: o.exposure ?? 0.2 };
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

// One shared meadow-scale field for terrain and both grass renderers.
// 0 = lush/deep green, 1 = dry/pale. The low-frequency spatial component makes
// coherent 20–70 m painterly patches, while climate biases arid country toward
// straw without erasing local variation. Keeping this CPU-side lets workers
// bake it into terrain vertices and grass instances instead of asking either
// fragment shader to synthesize an unrelated noise field.
export function groundMacroPatch(world, x, z, t, m) {
  const broad = 0.5 + 0.5 * world.jitter.fbm(
    x * 0.018 + 43.7,
    z * 0.018 - 19.1,
    2,
    2.15,
    0.52,
  );
  const stroke = 0.5 + 0.5 * world.jitter.noise(
    (x + z * 0.38) * 0.034 - 71.0,
    (z - x * 0.22) * 0.021 + 37.0,
  );
  const patch = clamp(broad * 0.72 + stroke * 0.28, 0, 1);
  const moistureDry = 1 - smoothstep(0.20, 0.62, m);
  const heatDry = smoothstep(16, 28, t) * (0.35 + moistureDry * 0.65);
  return clamp(patch * 0.70 + moistureDry * 0.22 + heatDry * 0.08, 0, 1);
}

// Biome base pigments now live in palette.mjs with the rest of the palette, so
// ground, blade, canopy and shadow colour can be tuned as one image.
const C = GROUND;

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
