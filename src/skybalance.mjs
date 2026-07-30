const clamp01 = (value) => Math.max(0, Math.min(1, value));

// Three r185's Sky addon emits the solar disc as raw linear HDR. Wander's
// bloom was tuned against r165, whose Sky shader applied a strong shoulder
// curve before the disc reached the composer. Keep the modern linear sky, but
// trim only that tiny HDR source so the surrounding landscape retains detail.
export const MODERN_SKY_SUN_DISC = Object.freeze({
  highSunGain: 0.002,
  horizonGain: 0.009,
  horizonWidth: 0.16,
  overcastFloor: 0.18,
  hdrShoulder: 0.8,
  hdrKnee: 0.75,
  nightToePower: 0.55,
  nightToeStrength: 0.78,
});

export function modernSkySunDiscGain(sunElevation, sunVisibility = 1) {
  const elevation = Number.isFinite(sunElevation) ? sunElevation : 0;
  const width = MODERN_SKY_SUN_DISC.horizonWidth;
  const horizon = Math.exp(-(elevation * elevation) / (2 * width * width));
  const clearGain = MODERN_SKY_SUN_DISC.highSunGain
    + (MODERN_SKY_SUN_DISC.horizonGain - MODERN_SKY_SUN_DISC.highSunGain) * horizon;
  const visibility = clamp01(Number.isFinite(sunVisibility) ? sunVisibility : 1);
  return clearGain * (MODERN_SKY_SUN_DISC.overcastFloor
    + (1 - MODERN_SKY_SUN_DISC.overcastFloor) * visibility);
}

export function modernSkyHighlightShoulder(value) {
  const linear = Math.max(0, Number.isFinite(value) ? value : 0);
  const excess = Math.max(0, linear - MODERN_SKY_SUN_DISC.hdrKnee);
  return linear / (1 + excess * MODERN_SKY_SUN_DISC.hdrShoulder);
}

// The exact line r185's Sky addon ends its fragment shader with. The rebalance
// below is a string replacement against it, which means a future revision that
// rewords this line would silently no-op — leaving the solar disc unbounded and
// blowing out bloom, with no error and nothing to catch it. Keeping the marker
// and the patch here makes both testable without a renderer, and
// balancedSkyFragment reports whether it actually applied so the caller can say
// so out loud instead of failing quietly.
export const MODERN_SKY_OUTPUT_MARKER = 'gl_FragColor = vec4( texColor, 1.0 );';

/**
 * Rebalance r185's raw linear-HDR sky output for Wander's composer.
 * Returns { patched, shader }: patched is false (and shader is returned
 * untouched) when the marker is absent, which is the upgrade-canary case.
 */
export function balancedSkyFragment(source) {
  const shader = typeof source === 'string' ? source : '';
  if (!shader.includes(MODERN_SKY_OUTPUT_MARKER)) return { patched: false, shader };
  const balanced = `
        // Wander's composer expects linear HDR, but bloom needs a finite solar
        // source. This shoulder is effectively transparent through ordinary
        // sky values and smoothly caps only the disc/Mie highlight energy.
        vec3 wanderSkyExcess = max(texColor - vec3(${MODERN_SKY_SUN_DISC.hdrKnee.toFixed(3)}), vec3(0.0));
        vec3 wanderSkyColor = texColor / (vec3(1.0) + wanderSkyExcess * ${MODERN_SKY_SUN_DISC.hdrShoulder.toFixed(3)});
        // r185 also removed the legacy sky's very strong low-end power curve.
        // Restore only a restrained night toe so silhouettes and the horizon
        // remain legible without turning midnight back into purple daylight.
        float wanderNight = 1.0 - smoothstep(-0.12, 0.04, vSunDirection.y);
        vec3 wanderNightSky = pow(max(wanderSkyColor, vec3(0.0)), vec3(${MODERN_SKY_SUN_DISC.nightToePower.toFixed(3)}));
        wanderSkyColor = mix(wanderSkyColor, wanderNightSky,
          wanderNight * ${MODERN_SKY_SUN_DISC.nightToeStrength.toFixed(3)});
        gl_FragColor = vec4(wanderSkyColor, 1.0);`;
  return { patched: true, shader: shader.replace(MODERN_SKY_OUTPUT_MARKER, balanced) };
}

export function modernSkyNightToe(value, nightAmount = 1) {
  const linear = Math.max(0, Number.isFinite(value) ? value : 0);
  const night = clamp01(Number.isFinite(nightAmount) ? nightAmount : 1);
  const lifted = Math.pow(linear, MODERN_SKY_SUN_DISC.nightToePower);
  return linear + (lifted - linear) * night * MODERN_SKY_SUN_DISC.nightToeStrength;
}
