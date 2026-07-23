// Pure cave-lighting policy. Rendering owns colours and uniforms; this module
// owns the deterministic transitions so entrance/day/weather behavior can be
// audited without WebGL or Three.js.

export const CAVE_ATMOSPHERE_DEFAULTS = Object.freeze({
  // Begin the visual transition just outside the mouth. The gameplay portal
  // can then switch collision/streaming ownership without also switching the
  // grade, fog, and exposure target on that exact frame.
  depthStart: -2.5,
  depthFull: 20,
  // Lift the deep interior enough for painterly forms to read without
  // bleaching the surface view framed by the cave mouth.
  deepExposure: 1.42,
  fogNear: 95,
  fogFar: 420,
});

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function smoothstep(a, b, value) {
  const t = clamp01((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
}

export function caveInteriorTarget(inside, local, mouth, options = {}) {
  if (!local || !mouth) return 0;
  // `inside` remains a useful fallback for deep cave positions, but entrance
  // lighting follows the physical throat instead of the portal boolean. This
  // makes a position's visual result identical on both sides of the portal's
  // collision hysteresis.
  const throatEngaged = options.throatEngaged ?? inside;
  if (!inside && !throatEngaged) return 0;
  const depthStart = options.depthStart ?? CAVE_ATMOSPHERE_DEFAULTS.depthStart;
  const depthFull = options.depthFull ?? CAVE_ATMOSPHERE_DEFAULTS.depthFull;
  const dx = local.x - mouth[0];
  const dy = (local.y - mouth[1]) * 0.75;
  const dz = local.z - mouth[2];
  // Through the entrance, progress is measured along the throat so walking
  // near an aperture edge cannot darken faster than walking through its
  // centre. Once the route bends or changes level, radial depth preserves the
  // fully-underground result used by non-linear cave layouts.
  const radialDepth = Math.hypot(dx, dy, dz);
  const apertureAllowance = options.apertureAllowance ?? 2.5;
  const depth = dz >= 0 ? Math.max(dz, radialDepth - apertureAllowance) : dz;
  return smoothstep(depthStart, depthFull, depth);
}

export function caveEntranceLight(sunElevation, moonIllum = 0, weather = null) {
  const day = smoothstep(-0.08, 0.18, sunElevation);
  const night = 1 - smoothstep(-0.15, -0.02, sunElevation);
  const horizon = Math.exp(-(sunElevation * sunElevation) / (2 * 0.10 * 0.10));
  const sunVisibility = clamp01(weather?.sunVisibility ?? weather?.sunScale ?? 1);
  const moonVisibility = clamp01(weather?.moonVisibility ?? 1);
  const hemiScale = Math.max(0.4, Math.min(1.5, weather?.hemiScale ?? 1));
  const cloudShade = clamp01(weather?.cloudShade ?? 0);
  const storm = clamp01(weather?.storm ?? 0);
  const rain = clamp01(weather?.rain ?? 0);

  // Overcast still provides broad skylight even though it loses the solar
  // beam. Storms suppress both; moonlight remains genuinely phase/weather-led.
  const broadDaylight = day * (0.48 * hemiScale + 0.52 * sunVisibility)
    * (1 - storm * 0.58) * (1 - rain * 0.18);
  const twilight = horizon * (0.20 + sunVisibility * 0.34)
    * (1 - cloudShade * 0.55) * (1 - storm * 0.72);
  const moonlight = night * clamp01(moonIllum) * moonVisibility * 0.16;
  return {
    day,
    night,
    warmth: clamp01(horizon * (0.35 + sunVisibility * 0.65)
      * (1 - cloudShade * 0.65) * (1 - storm * 0.80)),
    intensity: Math.max(0.025, 0.055 + broadDaylight * 1.05 + twilight + moonlight),
  };
}

export function caveExposureTarget(interiorFactor, options = {}) {
  const deepExposure = options.deepExposure ?? CAVE_ATMOSPHERE_DEFAULTS.deepExposure;
  return 1 + clamp01(interiorFactor) * (deepExposure - 1);
}

export function dampCaveValue(current, target, dt, timeConstant) {
  if (!Number.isFinite(current)) return target;
  if (!(dt > 0)) return current;
  const response = 1 - Math.exp(-dt / Math.max(1e-4, timeConstant));
  return current + (target - current) * response;
}

export function adaptCaveExposure(current, target, dt) {
  // Dark adaptation is intentionally slower than returning to daylight.
  return dampCaveValue(current, target, dt, target > current ? 2.6 : 0.75);
}

export function caveFogRange(interiorFactor, humidity = 0, options = {}) {
  const factor = clamp01(interiorFactor);
  const wet = clamp01(humidity);
  const near = (options.fogNear ?? CAVE_ATMOSPHERE_DEFAULTS.fogNear) - wet * 30;
  const far = (options.fogFar ?? CAVE_ATMOSPHERE_DEFAULTS.fogFar) - wet * 120;
  return { near, far, factor };
}
