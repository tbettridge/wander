// Deterministic, presentation-agnostic weather timeline.
//
// A day rolls a broad scenario, then expands it into adjacent archetype
// keyframes. Numeric properties interpolate between those keyframes, so later
// rendering phases can consume one continuously evolving state instead of
// switching cloud/light presets. Midnight anchors are generated from the
// boundary index (not either adjoining day), making day N's end exactly equal
// to day N+1's beginning.

import { clamp, lerp, mulberry32, smoothstep } from './noise.js';

export const WEATHER_ORDER = Object.freeze([
  'clear', 'scattered', 'dramatic', 'overcast', 'storm',
]);

// These are the authored centres of each archetype. Small seeded variations
// are applied to internal keyframes so consecutive fair days do not feel
// identical. Nothing consumes these visually in Phase 1; they are the shared
// contract for the rendering/audio phases that follow.
export const WEATHER_PROFILES = Object.freeze({
  clear: Object.freeze({
    flatCover: 0.08, cumulusCover: 0.12, cirrusCover: 0.10,
    cloudShade: 0.05, cloudShadow: 0.08,
    turbidity: 4.0, rayleigh: 1.55, mie: 0.004,
    sunScale: 1.00, hemiScale: 1.00,
    fogNearScale: 0.70, fogFar: 6500,
    windStrength: 0.25, windSpeed: 4.0,
    rain: 0, storm: 0,
  }),
  scattered: Object.freeze({
    flatCover: 0.38, cumulusCover: 0.52, cirrusCover: 0.25,
    cloudShade: 0.12, cloudShadow: 0.65,
    turbidity: 4.5, rayleigh: 1.60, mie: 0.005,
    sunScale: 0.95, hemiScale: 1.04,
    fogNearScale: 0.65, fogFar: 6200,
    windStrength: 0.42, windSpeed: 6.5,
    rain: 0, storm: 0,
  }),
  dramatic: Object.freeze({
    flatCover: 0.66, cumulusCover: 0.85, cirrusCover: 0.58,
    cloudShade: 0.38, cloudShadow: 0.90,
    turbidity: 6.2, rayleigh: 1.75, mie: 0.009,
    sunScale: 0.78, hemiScale: 1.12,
    fogNearScale: 0.50, fogFar: 4800,
    windStrength: 0.68, windSpeed: 10.0,
    rain: 0, storm: 0,
  }),
  overcast: Object.freeze({
    flatCover: 0.95, cumulusCover: 0.28, cirrusCover: 0.12,
    cloudShade: 0.56, cloudShadow: 0.25,
    turbidity: 9.0, rayleigh: 1.35, mie: 0.016,
    sunScale: 0.60, hemiScale: 1.20,
    fogNearScale: 0.30, fogFar: 3500,
    windStrength: 0.55, windSpeed: 8.0,
    rain: 0.03, storm: 0,
  }),
  storm: Object.freeze({
    // Peak storms use the overhead cloud deck; billboard towers belong to the
    // dramatic build and clearing phases, where they remain near the horizon.
    flatCover: 1.00, cumulusCover: 0.38, cirrusCover: 0.35,
    cloudShade: 0.80, cloudShadow: 0.45,
    turbidity: 11.0, rayleigh: 1.20, mie: 0.022,
    sunScale: 0.28, hemiScale: 1.08,
    fogNearScale: 0.08, fogFar: 1800,
    windStrength: 0.92, windSpeed: 14.0,
    rain: 1, storm: 1,
  }),
});

const NUMERIC_FIELDS = Object.freeze(Object.keys(WEATHER_PROFILES.clear));
const TAU = Math.PI * 2;
const TRANSITION_HOURS = 2;

const PROFILE_VARIATION = Object.freeze({
  flatCover: 0.055, cumulusCover: 0.07, cirrusCover: 0.08,
  cloudShade: 0.035, cloudShadow: 0.06,
  turbidity: 0.45, rayleigh: 0.08, mie: 0.0012,
  sunScale: 0.025, hemiScale: 0.025,
  fogNearScale: 0.035, fogFar: 260,
  windStrength: 0.08, windSpeed: 1.1,
});

const FIELD_LIMITS = Object.freeze({
  flatCover: [0, 1], cumulusCover: [0, 1], cirrusCover: [0, 1],
  cloudShade: [0, 1], cloudShadow: [0, 1],
  turbidity: [2, 14], rayleigh: [0.5, 3], mie: [0.001, 0.03],
  sunScale: [0, 1.1], hemiScale: [0.5, 1.4],
  fogNearScale: [0.02, 0.85], fogFar: [900, 7000],
  windStrength: [0.05, 1], windSpeed: [1.5, 18],
  rain: [0, 1], storm: [0, 1],
});

function seedFor(seed, index, salt) {
  return ((seed >>> 0) ^ (Math.imul(index | 0, 0x9e3779b1) >>> 0) ^ salt) >>> 0;
}

function wrapAngle(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

function angleDelta(a, b) {
  return ((b - a + Math.PI * 3) % TAU) - Math.PI;
}

function variedProfile(archetype, rng) {
  const base = WEATHER_PROFILES[archetype];
  const out = {};
  for (const field of NUMERIC_FIELDS) {
    const amount = PROFILE_VARIATION[field] || 0;
    const limits = FIELD_LIMITS[field];
    out[field] = clamp(base[field] + (rng() * 2 - 1) * amount, limits[0], limits[1]);
  }
  return out;
}

function baseProfile(archetype) {
  return { ...WEATHER_PROFILES[archetype] };
}

function archetypeIndex(name) {
  return WEATHER_ORDER.indexOf(name);
}

function archetypeDistance(a, b) {
  return Math.abs(archetypeIndex(a) - archetypeIndex(b));
}

function boundaryArchetype(r) {
  // Severe weather can persist across midnight, but storm peaks themselves are
  // scripted inside a day so there is room for a readable build and clearing.
  if (r < 0.35) return 'clear';
  if (r < 0.85) return 'scattered';
  if (r < 0.95) return 'dramatic';
  return 'overcast';
}

function scenarioFor(r) {
  if (r < 0.28) return 'settled-clear';
  if (r < 0.76) return 'fair-mixed';
  if (r < 0.89) return 'unsettled';
  if (r < 0.95) return 'overcast-front';
  return 'storm-front';
}

// Scenario cores leave six hours around midnight for adjacent-state paths.
// Repeated archetypes are intentional holds; the transition spans between the
// repeated hold and the next state instead of consuming the whole day.
function scenarioCore(name, rng) {
  switch (name) {
    case 'settled-clear':
      return [
        [6, 'clear'], [12, 'clear'], [14, 'scattered'],
        [16, 'scattered'], [18, 'clear'],
      ];
    case 'fair-mixed': {
      const midday = rng() < 0.55 ? 'clear' : 'scattered';
      return [
        [6, 'scattered'], [10, 'scattered'], [12, midday],
        [14, midday], [16, 'scattered'], [18, 'scattered'],
      ];
    }
    case 'unsettled':
      return [
        [6, 'scattered'], [10, 'scattered'], [12, 'dramatic'],
        [16, 'dramatic'], [18, 'scattered'],
      ];
    case 'overcast-front':
      return [
        [6, 'dramatic'], [8, 'overcast'], [16, 'overcast'],
        [18, 'dramatic'],
      ];
    case 'storm-front':
      return [
        [6, 'scattered'], [9, 'scattered'], [11, 'dramatic'],
        [12, 'dramatic'], [13.5, 'overcast'], [15, 'storm'],
        [16.5, 'storm'], [18, 'overcast'],
      ];
    default:
      return [[6, 'scattered'], [18, 'scattered']];
  }
}

function appendAdjacentPath(specs, target) {
  const from = specs[specs.length - 1];
  const a = archetypeIndex(from.archetype);
  const b = archetypeIndex(target.archetype);
  const steps = Math.abs(b - a);
  if (steps === 0) {
    specs.push(target);
    return;
  }
  const sign = Math.sign(b - a);
  for (let i = 1; i <= steps; i++) {
    specs.push({
      hour: lerp(from.hour, target.hour, i / steps),
      archetype: WEATHER_ORDER[a + sign * i],
      source: i === steps ? target.source : 'generated',
    });
  }
}

function solarWeights(time, sunElevation) {
  const rising = time < 0.5;
  const nightWeight = 1 - smoothstep(-0.18, -0.05, sunElevation);
  const dayWeight = smoothstep(0.05, 0.35, sunElevation);
  const blueHourWeight = smoothstep(-0.24, -0.16, sunElevation)
    * (1 - smoothstep(-0.04, 0.03, sunElevation));
  const horizonWeight = Math.exp(-(sunElevation * sunElevation) / (2 * 0.075 * 0.075));
  const goldenHourWeight = smoothstep(0.02, 0.10, sunElevation)
    * (1 - smoothstep(0.32, 0.50, sunElevation));
  const twilightWeight = Math.max(blueHourWeight, horizonWeight, goldenHourWeight);
  const dawnWeight = rising ? twilightWeight : 0;
  const duskWeight = rising ? 0 : twilightWeight;

  let solarPhase = 'day';
  if (nightWeight > 0.75) solarPhase = 'deep-night';
  else if (blueHourWeight > 0.05 && blueHourWeight > Math.max(horizonWeight, goldenHourWeight)) solarPhase = rising ? 'dawn-blue-hour' : 'dusk-blue-hour';
  else if (horizonWeight > 0.05 && horizonWeight > goldenHourWeight) solarPhase = rising ? 'sunrise' : 'sunset';
  else if (goldenHourWeight > 0.05) solarPhase = rising ? 'morning-golden' : 'evening-golden';

  return {
    sunRising: rising,
    solarPhase,
    dawnWeight,
    dayWeight,
    duskWeight,
    blueHourWeight,
    goldenHourWeight,
    horizonWeight,
    nightWeight,
  };
}

export class WeatherSystem {
  constructor(seed = 12345) {
    this.seed = seed >>> 0;
    this.plans = new Map();
    this.forcedArchetype = null;
    this.forcedMistyDawn = false;
    this.current = null;
    this._last = { dayIndex: 0, time: 9.5 / 24, sunElevation: 0, moonIllum: 0 };
    this.update(0, this._last.time);
  }

  boundary(boundaryIndex, hour) {
    const rng = mulberry32(seedFor(this.seed, boundaryIndex, 0x51f15e5d));
    const archetype = boundaryArchetype(rng());
    return {
      hour,
      archetype,
      values: variedProfile(archetype, rng),
      windAngle: rng() * TAU,
    };
  }

  buildPlan(dayIndex) {
    const rng = mulberry32(seedFor(this.seed, dayIndex, 0x7a2d39c7));
    const scenario = scenarioFor(rng());
    const mistRoll = rng();
    const mist = {
      enabled: mistRoll < 0.12,
      intensity: mistRoll < 0.12 ? 0.55 + rng() * 0.45 : 0,
    };
    const start = this.boundary(dayIndex, 0);
    const end = this.boundary(dayIndex + 1, 24);
    const core = scenarioCore(scenario, rng).map(([hour, archetype]) => ({
      hour, archetype, source: 'generated',
    }));

    const specs = [{ hour: 0, archetype: start.archetype, source: 'start' }];
    const first = core[0];
    const startDistance = archetypeDistance(start.archetype, first.archetype);
    if (startDistance > 0) {
      const transitionStart = Math.max(0, first.hour - startDistance * TRANSITION_HOURS);
      if (transitionStart > 0) specs.push({
        hour: transitionStart, archetype: start.archetype, source: 'start',
      });
    }
    appendAdjacentPath(specs, first);
    for (let i = 1; i < core.length; i++) appendAdjacentPath(specs, core[i]);

    const last = specs[specs.length - 1];
    const endDistance = archetypeDistance(last.archetype, end.archetype);
    const arrival = Math.min(24, last.hour + endDistance * TRANSITION_HOURS);
    appendAdjacentPath(specs, { hour: endDistance > 0 ? arrival : 24, archetype: end.archetype, source: 'end' });
    if (arrival < 24 && endDistance > 0) {
      specs.push({ hour: 24, archetype: end.archetype, source: 'end' });
    }

    let previousAngle = start.windAngle;
    const knots = specs.map((spec) => {
      if (spec.source === 'start') {
        previousAngle = start.windAngle;
        return { ...spec, values: { ...start.values }, windAngle: start.windAngle };
      }
      if (spec.source === 'end') {
        previousAngle = end.windAngle;
        return { ...spec, values: { ...end.values }, windAngle: end.windAngle };
      }
      const turn = spec.archetype === 'storm' ? 0.55 : 0.32;
      previousAngle = wrapAngle(previousAngle + (rng() * 2 - 1) * turn);
      return {
        ...spec,
        values: variedProfile(spec.archetype, rng),
        windAngle: previousAngle,
      };
    });

    return { dayIndex, scenario, mist, knots };
  }

  planForDay(dayIndex) {
    if (!this.plans.has(dayIndex)) {
      this.plans.set(dayIndex, this.buildPlan(dayIndex));
      if (this.plans.size > 10) {
        const oldest = this.plans.keys().next().value;
        this.plans.delete(oldest);
      }
    }
    return this.plans.get(dayIndex);
  }

  samplePlan(plan, time) {
    const hour = clamp(time, 0, 1) * 24;
    const knots = plan.knots;
    let right = 1;
    while (right < knots.length - 1 && hour > knots[right].hour) right++;
    const from = knots[Math.max(0, right - 1)];
    const to = knots[right];
    const span = Math.max(1e-6, to.hour - from.hour);
    const rawMix = clamp((hour - from.hour) / span, 0, 1);
    const mix = smoothstep(0, 1, rawMix);
    const state = {};
    for (const field of NUMERIC_FIELDS) state[field] = lerp(from.values[field], to.values[field], mix);
    state.windAngle = wrapAngle(from.windAngle + angleDelta(from.windAngle, to.windAngle) * mix);
    state.windX = Math.cos(state.windAngle);
    state.windZ = Math.sin(state.windAngle);
    state.fromArchetype = from.archetype;
    state.toArchetype = to.archetype;
    state.transition = mix;
    state.archetype = mix < 0.5 ? from.archetype : to.archetype;
    state.hour = hour;
    return state;
  }

  mistAt(plan, hour) {
    if (!plan.mist.enabled) return 0;
    return this.mistWindow(hour, plan.mist.intensity);
  }

  mistWindow(hour, intensity = 1) {
    const form = smoothstep(4.5, 5.75, hour);
    const burn = 1 - smoothstep(7.0, 10.0, hour);
    return intensity * form * burn;
  }

  setForced(archetype) {
    this.forcedArchetype = WEATHER_ORDER.includes(archetype) ? archetype : null;
    this.update(this._last.dayIndex, this._last.time, this._last.sunElevation, this._last.moonIllum);
  }

  setForcedMistyDawn(enabled) {
    this.forcedMistyDawn = !!enabled;
    this.update(this._last.dayIndex, this._last.time, this._last.sunElevation, this._last.moonIllum);
  }

  update(dayIndex, time, sunElevation, moonIllum = 0) {
    // Preserve exactly 1.0 for the debug scrubber: it represents the current
    // day's end anchor, while normal runtime time remains in [0, 1).
    if (time < 0 || time > 1) time = ((time % 1) + 1) % 1;
    if (sunElevation === undefined) sunElevation = Math.sin((time - 0.25) * TAU);
    this._last = { dayIndex, time, sunElevation, moonIllum };
    const plan = this.planForDay(dayIndex);
    let state;

    if (this.forcedArchetype) {
      state = {
        ...baseProfile(this.forcedArchetype),
        windAngle: this.current?.windAngle ?? 0,
        fromArchetype: this.forcedArchetype,
        toArchetype: this.forcedArchetype,
        transition: 1,
        archetype: this.forcedArchetype,
        hour: time * 24,
      };
      state.windX = Math.cos(state.windAngle);
      state.windZ = Math.sin(state.windAngle);
    } else {
      state = this.samplePlan(plan, time);
    }

    state.dayIndex = dayIndex;
    state.scenario = this.forcedArchetype ? 'forced' : plan.scenario;
    state.mist = this.forcedMistyDawn
      ? this.mistWindow(state.hour)
      : this.forcedArchetype ? 0 : this.mistAt(plan, state.hour);
    state.cloudCover = clamp(1
      - (1 - state.flatCover) * (1 - state.cumulusCover * 0.45) * (1 - state.cirrusCover * 0.20), 0, 1);

    Object.assign(state, solarWeights(time, sunElevation));

    // Shared presentation/ecology gates. Later phases consume these rather
    // than each module inventing a different definition of night or bad weather.
    state.openSky = clamp(1 - state.cloudCover * 0.95, 0, 1);
    state.sunVisibility = clamp(state.sunScale * (1 - state.rain * 0.2), 0, 1);
    state.moonVisibility = clamp(Math.pow(state.openSky, 1.25) * (1 - state.rain * 0.95), 0, 1);
    state.starVisibility = clamp(Math.pow(state.openSky, 1.6) * (1 - state.mist * 0.7) * (1 - state.rain), 0, 1);
    const calm = 1 - smoothstep(0.45, 0.85, state.windStrength);
    const dry = 1 - smoothstep(0.05, 0.35, state.rain);
    const safe = 1 - state.storm;
    state.fireflyActivity = state.nightWeight * calm * dry * safe;
    // Night sound and visible insects obey the same calm/dry gate. This is
    // intentionally separate from moon/star visibility: a bright clear night
    // may make fireflies harder to see, but it does not send them indoors.
    state.nocturnalActivity = state.nightWeight * (0.30 + calm * 0.70) * dry * safe;
    state.butterflyActivity = state.dayWeight * dry * safe * clamp(state.sunScale, 0, 1);
    state.birdActivity = clamp(state.dayWeight + state.dawnWeight * 0.35, 0, 1)
      * (0.35 + state.sunVisibility * 0.65) * dry * (1 - state.storm * 0.9);

    this.current = state;
    return state;
  }

  // Console/debug audit: verifies authored paths and reports deterministic roll
  // frequencies without touching renderer state.
  audit(days = 1000, startDay = 0) {
    const scenarios = {};
    const daylightArchetypes = {};
    let daylightSamples = 0, fairDaylightSamples = 0;
    let mistDays = 0, invalidTransitions = 0, boundaryMismatches = 0;
    for (let day = startDay; day < startDay + days; day++) {
      const plan = this.planForDay(day);
      scenarios[plan.scenario] = (scenarios[plan.scenario] || 0) + 1;
      if (plan.mist.enabled) mistDays++;
      for (let i = 1; i < plan.knots.length; i++) {
        if (archetypeDistance(plan.knots[i - 1].archetype, plan.knots[i].archetype) > 1) invalidTransitions++;
      }
      const next = this.planForDay(day + 1);
      const a = plan.knots[plan.knots.length - 1];
      const b = next.knots[0];
      let mismatch = a.archetype !== b.archetype || Math.abs(angleDelta(a.windAngle, b.windAngle)) > 1e-8;
      for (const field of NUMERIC_FIELDS) mismatch ||= Math.abs(a.values[field] - b.values[field]) > 1e-8;
      if (mismatch) boundaryMismatches++;
      for (let hour = 6; hour <= 18; hour++) {
        const state = this.samplePlan(plan, hour / 24);
        daylightArchetypes[state.archetype] = (daylightArchetypes[state.archetype] || 0) + 1;
        daylightSamples++;
        if (state.archetype === 'clear' || state.archetype === 'scattered') fairDaylightSamples++;
      }
    }
    return {
      days,
      scenarios,
      mistDays,
      mistRate: mistDays / Math.max(1, days),
      daylightArchetypes,
      fairDaylightRate: fairDaylightSamples / Math.max(1, daylightSamples),
      invalidTransitions,
      boundaryMismatches,
    };
  }
}
