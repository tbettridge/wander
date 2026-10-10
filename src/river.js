// River water material — one shared ShaderMaterial for all per-chunk river
// ribbon meshes (built in chunkgen.buildRiver). Vertices are already in world
// space at the channel water-surface height and carry aWet (submerged depth)
// and aFlow (downstream direction × surface slope). The shader animates ripples
// scrolling downstream, reflects the sky (Fresnel), adds sun glint, foams the
// shoreline and rapids, and matches the scene's day/night lighting + fog.

import * as THREE from 'three';
import { WATER_LEVEL } from './world.js';
import { waterUniforms, WATER_COMMON_GLSL } from './watercommon.js';

const VERT = /* glsl */`
attribute float aWet;
attribute vec2 aFlow;
attribute vec4 aBody;
varying vec3 vWP;
varying float vWet;
varying vec2 vFlow;
varying vec4 vBody;
void main() {
  vWP = position;            // river verts are authored in world space
  vWet = aWet;
  vFlow = aFlow;
  vBody = aBody;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = WATER_COMMON_GLSL + /* glsl */`
uniform sampler2D uLakeReflectionMap;
uniform mat4 uLakeReflectionMatrix;
uniform vec4 uLakeReflectionBounds;
uniform float uLakeReflectionLevel, uLakeReflectionReady;
varying vec3 vWP;
varying float vWet;
varying vec2 vFlow;
varying vec4 vBody;

// Analytic wave slopes replace three finite-difference height evaluations.
// Their phases remain in world space even where neighbouring currents turn.
float rippleDerivative(float phase) {
  float footprint = fwidth(phase);
  return cos(phase) * exp(-footprint * footprint * 0.28);
}
vec2 rippleSlope(vec2 p, float t) {
  vec2 along = vec2(0.94, 0.342), across = vec2(-0.342, 0.94);
  float a = dot(p, along), b = dot(p, across);
  float phase = wcNoise(p * 0.12) * 3.0;
  float breeze = mix(0.65, 1.0, uWaterWindStrength);
  float bend = b * 0.21, curl = b * 0.8 - t * 0.13;
  float longPhase = a * 0.95 - t * 0.16 + sin(bend) * 0.4 + phase;
  float smallPhase = a * 2.4 - t * 0.30 + sin(curl) * 0.4 + phase * 0.7;
  float crossPhase = dot(p, vec2(0.72, 0.69)) * 4.8 - t * 0.7 + phase * 0.6;
  return rippleDerivative(longPhase) * (along * 0.95 + across * cos(bend) * 0.084) * 0.18 * breeze
    + rippleDerivative(smallPhase) * (along * 2.4 + across * cos(curl) * 0.32) * 0.045
    + rippleDerivative(crossPhase) * vec2(0.72, 0.69) * 4.8 * 0.018;
}
vec2 flowingSlope(vec2 p, float t, vec2 flow) {
  if (length(flow) < 0.001) return rippleSlope(p, t);
  // Two bounded advection phases cross-fade while each resets invisibly.
  // Flow changes therefore cannot stretch the shading indefinitely over time.
  float phase = fract(t * 0.09), second = fract(phase + 0.5);
  vec2 velocity = flow * 6.0;
  vec2 firstField = rippleSlope(p - velocity * phase, t);
  vec2 secondField = rippleSlope(p - velocity * second, t);
  return mix(firstField, secondField, abs(phase * 2.0 - 1.0));
}

void main() {
  // MSAA shades a partly covered edge pixel at its centre, which on the thin
  // slivers left by the shoreline clip can sit well outside the triangle. The
  // varyings are then extrapolated far past anything authored: a large
  // negative depth overflowed exp(-wet * k) below to Inf, mix() turned that
  // into NaN, and bloom plus the distance-wash blur spread the one bad pixel
  // into a black square. Clamp back to the authored ranges before any use.
  float wet = max(vWet, 0.0);
  vec4 body = clamp(vBody, vec4(-1.0, 0.0, 0.0, 0.0), vec4(1.0));
  vec2 p = vWP.xz;
  float t = uTime;
  vec2 flow = vFlow;
  float spd = length(flow);
  if (spd > 1.5) { flow *= 1.5 / spd; spd = 1.5; }
  float basin = smoothstep(0.0, 0.8, body.x);
  float channel = step(0.5, -body.x);
  float still = mix(1.0 - smoothstep(0.18, 0.55, spd), 1.0, basin);
  vec3 V = normalize(cameraPosition - vWP);

  vec2 slope = flowingSlope(p, t, flow);
  float bump = 0.10 + spd * 0.7;                     // flatter (more mirror) when still
  bump = mix(bump, 0.042 + spd * 0.065, channel);
  float breeze = mix(0.65, 1.3, uWaterWindStrength);
  bump = mix(bump, mix(0.018, 0.11, body.y) * breeze * smoothstep(0.0, 0.45, wet), basin);
  vec3 N = normalize(vec3(-slope.x * bump, 1.0, -slope.y * bump));

  float dayLight = wcDayLight();
  float depthF = clamp(wet / 2.0, 0.0, 1.0);
  // estuary: as the surface nears sea level, re-base the palette on the SEA's
  // depth over the riverbed — the exact input the ocean shader computes at the
  // same spot (world.height includes the carve) — so the river's deep-channel
  // colour eases into the ocean's shallow-water colour instead of jumping.
  float bed = vWP.y - wet;
  float seaDepthF = smoothstep(0.5, 9.0, (${WATER_LEVEL.toFixed(1)} + uTide) - bed);
  float seaMix = 1.0 - smoothstep(${WATER_LEVEL.toFixed(1)} + uTide + 0.10,
                                  ${WATER_LEVEL.toFixed(1)} + uTide + 2.2, vWP.y);
  seaMix *= body.w;
  depthF = mix(depthF, seaDepthF, seaMix);
  vec3 waterCol = wcPalette(depthF, still * 0.5 * (1.0 - seaMix));
  // Quiet basins absorb through their own water column. Soft olive/tea shallows
  // turn deeper blue-green gradually, without a bright cyan perimeter ring.
  float absorb = 1.0 - exp(-wet * mix(0.20, 0.65, body.z));
  waterCol = mix(waterCol, wcFreshPalette(wet, body.z), basin);

  float inland = max(basin, channel) * (1.0 - seaMix);
  waterCol = mix(waterCol, wcFreshPalette(wet, body.z * 0.7), channel * (1.0 - seaMix));
  // The same wind normal takes over before the ocean owns the mouth, including
  // at bank height. Colour and reflected light meet across the same boundary.
  if (seaMix > 0.001) N = normalize(mix(N, wcOceanNormal(p, t), seaMix));
  float fres = mix(wcFresnel(N, V), 0.025 + 0.975 * pow(1.0 - max(dot(V, N), 0.0), 5.0), inland);
  vec3 reflected = wcSkyReflect(N, V);
  if (uLakeReflectionReady > 0.5 && abs(vWP.y - uLakeReflectionLevel) < 0.025
    && p.x > uLakeReflectionBounds.x && p.y > uLakeReflectionBounds.y
    && p.x < uLakeReflectionBounds.z && p.y < uLakeReflectionBounds.w) {
    vec4 projected = uLakeReflectionMatrix * vec4(vWP, 1.0);
    vec2 uv = projected.xy / max(projected.w, 0.001);
    uv += N.xz * 0.025 * smoothstep(0.0, 0.5, wet);
    float edge = smoothstep(0.0, 0.035, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    reflected = mix(reflected, texture2D(uLakeReflectionMap, clamp(uv, 0.001, 0.999)).rgb, edge * basin);
  }
  vec3 col = mix(waterCol, reflected, fres * mix(0.7, 0.94, still));
  col += wcGlint(N, V);
  if (wet < 1.0 && uDay > 0.05) {
    col += uSunColor * wcCaustics(p, t, wet) * (1.0 - body.z) * 0.045 * (1.0 - seaMix);
  }

  // foam: a bright line along the shoreline + whitewater on rapids, broken up
  // by streaks stretched along the flow (isotropic in still water, drawn into
  // long downstream streaks as the current speeds up — reads as direction).
  float shore = 1.0 - smoothstep(0.0, 0.5, wet);
  float rapid = smoothstep(0.38, 0.68, spd) * (1.0 - smoothstep(0.45, 1.8, wet));
  float foam = 0.0;
  if (basin < 0.99 && max(shore, rapid) > 0.001) {
    float foamTex = wcFlowTexture(p, flow * 7.0, 1.5, t);
    foam = max(shore * smoothstep(0.42, 0.72, foamTex + 0.28),
      rapid * smoothstep(0.45, 0.7, foamTex));
    foam *= (1.0 - seaMix * 0.8) * mix(1.0, 0.055 + rapid * 0.72, channel) * (1.0 - basin);
  }
  col = mix(col, vec3(0.95, 0.97, 0.98) * dayLight, clamp(foam, 0.0, 1.0));

  float alpha = mix(0.4, 0.9, depthF);
  alpha = mix(alpha, mix(0.43, 0.94, absorb), basin);
  alpha = mix(alpha, mix(0.34, 0.90, 1.0 - exp(-wet * 0.95)), channel * (1.0 - seaMix));
  alpha = max(max(alpha, foam), fres * mix(0.5, 0.92, inland));

  // distance LOD: converge to the ocean's EXACT surface — same wave field
  // (wcOceanH), same palette/fresnel/glint assembly, same alpha curve — so
  // from afar river and sea are one water and the delta has no boundary. The
  // flow ripples, mirror stillness and directional foam are close-range
  // effects only.
  float distF = smoothstep(140.0, 420.0, length(cameraPosition - vWP));
  distF *= (1.0 - basin) * mix(1.0, seaMix, channel);
  if (distF > 0.001) {
    vec3 No = wcOceanNormal(p, t);
    float fresO = wcFresnel(No, V);
    vec3 colO = mix(wcPalette(smoothstep(0.5, 9.0, wet), 0.0), wcSkyReflect(No, V), fresO);
    colO += wcGlint(No, V);
    float alphaO = max(mix(0.55, 0.93, smoothstep(0.0, 6.0, wet)), fresO * 0.9);
    // at range water is visually opaque — without this, the dark carved bed
    // bleeds through and the river still reads darker than the sea (whose bed
    // is pale sand) even when the surface colours match exactly
    alphaO = mix(alphaO, 0.93, distF);
    col = mix(col, colO, distF);
    alpha = mix(alpha, alphaO, distF);
  }
  // soft waterline: fade to transparent as the water shallows to nothing, so
  // shorelines melt into the wet bank instead of ending in a hard line
      alpha *= smoothstep(0.0, mix(0.30, 0.18, inland), wet);
  // estuary: hand the surface over to the ocean where the SEA is deep enough
  // over the riverbed to own the water. Keyed to bed depth — not surface
  // height — because flat lagoons put their whole surface at one height, and
  // a height-keyed fade made entire pools pulse in and out with the tide.
  // Bed depth is stable per-location; the tide only breathes the rim. The
  // palette convergence above means both waters are already the same colour
  // by the time the swap happens — water flowing into water.
  // (gated by seaMix so a deep pool that happens to sit a metre above the sea
  // with a sub-sea bed doesn't dissolve into a hole in the water)
  float seaOwn = smoothstep(0.15, 0.9, (${WATER_LEVEL.toFixed(1)} + uTide) - bed) * seaMix;
  // from a distance the ocean plane owns the whole estuary outright — including
  // the final reach that still stands ~1 m above sea level. Left proportional
  // (distF * seaMix), that reach kept a 20-35% ribbon stacked over the ocean
  // plane and read as a dark slab at the mouth. The ~1 m surface drop when the
  // ocean takes over is invisible at these ranges.
  float farOwn = distF * (1.0 - smoothstep(uTide + 1.2, uTide + 2.4, vWP.y));
  farOwn *= body.w;
  seaOwn = max(seaOwn, farOwn);
  alpha *= (1.0 - seaOwn) * mix(1.0, smoothstep(uTide - 0.25, uTide + 0.05, vWP.y), body.w);

  // distance sheen — identical term to the ocean shader, so river and sea
  // converge to the same pale reflected-sky tone at range: one blue surface
  float wDist = length(cameraPosition - vWP);
  col = mix(col, uSkyHorizon, smoothstep(300.0, 1200.0, wDist) * 0.55);

  // Transparent fragments still write depth. Completely handed-off water
  // must relinquish the depth buffer as well as its colour at an estuary.
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(wcApplyAir(col, vWP, wDist), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const riverMaterial = new THREE.ShaderMaterial({
  vertexShader: VERT,
  fragmentShader: FRAG,
  uniforms: { ...waterUniforms },   // shared with the ocean — one look, one update
  transparent: true,
  depthWrite: true,
  side: THREE.DoubleSide,
  // On flat deltas the ribbon shallows to centimetres above its carved bed over
  // wide areas; at distance the depth buffer can't separate them (metres of
  // quantisation at km range) and the whole mouth shimmers. Pull the water
  // decisively in front of the sand it's grazing.
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -2,
});
// Keep the ribbon out of the GTAO depth pass: it writes depth even where its
// alpha has faded to nothing (the estuary handoff), and the AO pass then
// shades that phantom surface hovering over the carved bed — a dark slab at
// every river mouth, shimmering with depth precision at distance.
riverMaterial.userData.excludeFromAO = true;
riverMaterial.userData.waterSurface = true;
// Returning browsers can briefly pair a cached geometry module with this
// material. Missing semantics must retain legacy river visibility.
riverMaterial.defaultAttributeValues.aBody = [0, 0.2, 0.25, 1];
