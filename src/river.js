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

// ripple height field. Flowing water gets wavelets stretched ALONG the flow
// and scrolling downstream (at a rate set by speed); still water (lakes/ponds)
// gets only a slow, gentle, omni-directional ripple — a breeze on a mirror.
float waterWave(float phase) {
  float footprint = fwidth(phase);
  return sin(phase) * exp(-footprint * footprint * 0.28);
}
float wh(vec2 p, float t, vec2 dir, vec2 perp, float spd) {
  float a = dot(p, dir), b = dot(p, perp);
  // Long wavelets carry the current; crossed capillary ripples break their
  // crests. All motion is in the shading normal, leaving the solved shore fixed.
  float drift = t * (0.28 + spd * 1.9);
  float phase = wcNoise(p * 0.11) * 2.4;
  float longWave = waterWave(a * 1.35 - drift + sin(b * 0.31) * 0.65 + phase) * 0.38;
  float wavelet = waterWave(a * 3.7 - drift * 1.65 + sin(b * 1.15 - t * 0.19) * 0.55) * 0.18;
  float crossWave = waterWave(dot(p, vec2(0.72, 0.69)) * 5.6 - t * 1.1 + phase) * 0.075;
  float micro = waterWave(a * 11.0 + b * 4.0 - drift * 2.4) * 0.025;
  return longWave + wavelet + crossWave + micro;
}

vec3 inlandSky(vec3 N, vec3 V) {
  vec3 R = reflect(-V, N);
  vec3 sky = wcSkyReflect(N, V);
  // Broad sky patches give the ripple normals something to reflect. The
  // horizon stays tied to scene fog, and the effect fades out at night.
  vec2 cloudUV = R.xz / max(0.18, abs(R.y) + 0.18);
  float clouds = smoothstep(0.48, 0.77, wcFbm(cloudUV * 1.8 + vec2(uTime * 0.002, 5.0)));
  return mix(sky, uSkyHorizon * 1.13, clouds * 0.38 * uDay * smoothstep(0.03, 0.4, R.y));
}

void main() {
  vec2 p = vWP.xz;
  float t = uTime;
  vec2 flow = vFlow;
  float spd = length(flow);
  float basin = smoothstep(0.0, 0.8, vBody.x);
  float channel = step(0.5, -vBody.x);
  float still = mix(1.0 - smoothstep(0.18, 0.55, spd), 1.0, basin);
  vec2 dir = spd > 1e-3 ? flow / spd : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec3 V = normalize(cameraPosition - vWP);

  float e = 0.08;
  float h0 = wh(p, t, dir, perp, spd);
  float bump = 0.10 + spd * 0.7;                     // flatter (more mirror) when still
  bump = mix(bump, 0.09 + spd * 0.12, channel);
  bump = mix(bump, mix(0.035, 0.095, vBody.y) * smoothstep(0.0, 0.45, vWet), basin);
  vec3 N = normalize(vec3(
    -(wh(p + vec2(e, 0.0), t, dir, perp, spd) - h0) / e * bump,
    1.0,
    -(wh(p + vec2(0.0, e), t, dir, perp, spd) - h0) / e * bump
  ));

  float dayLight = wcDayLight();
  float depthF = clamp(vWet / 2.0, 0.0, 1.0);
  // estuary: as the surface nears sea level, re-base the palette on the SEA's
  // depth over the riverbed — the exact input the ocean shader computes at the
  // same spot (world.height includes the carve) — so the river's deep-channel
  // colour eases into the ocean's shallow-water colour instead of jumping.
  float bed = vWP.y - vWet;
  float seaDepthF = smoothstep(0.5, 9.0, (${WATER_LEVEL.toFixed(1)} + uTide) - bed);
  float seaMix = 1.0 - smoothstep(${WATER_LEVEL.toFixed(1)} + uTide + 0.10,
                                  ${WATER_LEVEL.toFixed(1)} + uTide + 2.2, vWP.y);
  seaMix *= vBody.w;
  depthF = mix(depthF, seaDepthF, seaMix);
  vec3 waterCol = wcPalette(depthF, still * 0.5 * (1.0 - seaMix));
  // Quiet basins absorb through their own water column. Soft olive/tea shallows
  // turn deeper blue-green gradually, without a bright cyan perimeter ring.
  float absorb = 1.0 - exp(-vWet * mix(0.20, 0.65, vBody.z));
  vec3 basinShallow = mix(vec3(0.055, 0.19, 0.17), vec3(0.15, 0.19, 0.075), vBody.z);
  vec3 basinDeep = mix(vec3(0.012, 0.073, 0.095), vec3(0.028, 0.080, 0.047), vBody.z);
  waterCol = mix(waterCol, mix(basinShallow, basinDeep, absorb) * dayLight, basin);

  float inland = max(basin, channel) * (1.0 - seaMix);
  vec3 channelCol = mix(vec3(0.10, 0.235, 0.20), vec3(0.018, 0.095, 0.115), 1.0 - exp(-vWet * 0.85));
  waterCol = mix(waterCol, channelCol * dayLight, channel * (1.0 - seaMix));
  float fres = mix(wcFresnel(N, V), 0.025 + 0.975 * pow(1.0 - max(dot(V, N), 0.0), 5.0), inland);
  vec3 reflected = mix(wcSkyReflect(N, V), inlandSky(N, V), inland);
  if (uLakeReflectionReady > 0.5 && abs(vWP.y - uLakeReflectionLevel) < 0.025
    && p.x > uLakeReflectionBounds.x && p.y > uLakeReflectionBounds.y
    && p.x < uLakeReflectionBounds.z && p.y < uLakeReflectionBounds.w) {
    vec4 projected = uLakeReflectionMatrix * vec4(vWP, 1.0);
    vec2 uv = projected.xy / max(projected.w, 0.001);
    uv += N.xz * 0.025 * smoothstep(0.0, 0.5, vWet);
    float edge = smoothstep(0.0, 0.035, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    reflected = mix(reflected, texture2D(uLakeReflectionMap, clamp(uv, 0.001, 0.999)).rgb, edge * basin);
  }
  vec3 col = mix(waterCol, reflected, fres * mix(0.7, 0.94, still));
  col += wcGlint(N, V);

  // foam: a bright line along the shoreline + whitewater on rapids, broken up
  // by streaks stretched along the flow (isotropic in still water, drawn into
  // long downstream streaks as the current speeds up — reads as direction).
  float shore = 1.0 - smoothstep(0.0, 0.5, vWet);
  float rapid = smoothstep(0.6, 0.92, spd);
  float aniso = mix(1.0, 0.28, smoothstep(0.05, 0.4, spd));
  float fa = dot(p, dir), fb = dot(p, perp);
  float foamTex = wcFbm(vec2(fa * 2.0 * aniso - t * 2.8, fb * 2.0));
  float foam = max(shore * smoothstep(0.42, 0.72, foamTex + 0.28),
                   rapid * smoothstep(0.45, 0.7, foamTex));
  foam *= 1.0 - seaMix * 0.8;   // the sea's own foam takes over at the mouth
  foam *= mix(1.0, 0.10 + rapid * 0.7, channel);
  foam *= 1.0 - basin;         // sheltered ponds do not have a foamy necklace
  col = mix(col, vec3(0.95, 0.97, 0.98) * dayLight, clamp(foam, 0.0, 1.0));

  float alpha = mix(0.4, 0.9, depthF);
  alpha = mix(alpha, mix(0.36, 0.92, absorb), basin);
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
    vec3 colO = mix(wcPalette(smoothstep(0.5, 9.0, vWet), 0.0), wcSkyReflect(No, V), fresO);
    colO += wcGlint(No, V);
    float alphaO = max(mix(0.55, 0.93, smoothstep(0.0, 6.0, vWet)), fresO * 0.9);
    // at range water is visually opaque — without this, the dark carved bed
    // bleeds through and the river still reads darker than the sea (whose bed
    // is pale sand) even when the surface colours match exactly
    alphaO = mix(alphaO, 0.93, distF);
    col = mix(col, colO, distF);
    alpha = mix(alpha, alphaO, distF);
  }
  // soft waterline: fade to transparent as the water shallows to nothing, so
  // shorelines melt into the wet bank instead of ending in a hard line
  alpha *= smoothstep(0.0, mix(0.30, 0.09, inland), vWet);
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
  farOwn *= vBody.w;
  seaOwn = max(seaOwn, farOwn);
  alpha *= (1.0 - seaOwn) * mix(1.0, smoothstep(uTide - 0.25, uTide + 0.05, vWP.y), vBody.w);

  // distance sheen — identical term to the ocean shader, so river and sea
  // converge to the same pale reflected-sky tone at range: one blue surface
  float wDist = length(cameraPosition - vWP);
  col = mix(col, uSkyHorizon, smoothstep(300.0, 1200.0, wDist) * 0.55);

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
