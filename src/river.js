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
varying vec3 vWP;
varying float vWet;
varying vec2 vFlow;
void main() {
  vWP = position;            // river verts are authored in world space
  vWet = aWet;
  vFlow = aFlow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = WATER_COMMON_GLSL + /* glsl */`
varying vec3 vWP;
varying float vWet;
varying vec2 vFlow;

// ripple height field. Flowing water gets wavelets stretched ALONG the flow
// and scrolling downstream (at a rate set by speed); still water (lakes/ponds)
// gets only a slow, gentle, omni-directional ripple — a breeze on a mirror.
float wh(vec2 p, float t, vec2 dir, vec2 perp, float spd) {
  float a = dot(p, dir), b = dot(p, perp);
  float flowR = wcFbm(vec2(a * 0.32 - t * 1.6 * spd, b * 0.95)) * 0.6
              + wcFbm(vec2(a * 0.70 - t * 2.6 * spd, b * 2.00) + 11.0) * 0.4;
  float calmR = wcFbm(p * 0.5 + vec2(t * 0.04, -t * 0.03)) * 0.5;
  return mix(calmR, flowR, smoothstep(0.05, 0.45, spd));
}

void main() {
  vec2 p = vWP.xz;
  float t = uTime;
  vec2 flow = vFlow;
  float spd = length(flow);
  float still = 1.0 - smoothstep(0.18, 0.55, spd);   // 1 = lake/pond, 0 = stream
  vec2 dir = spd > 1e-3 ? flow / spd : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec3 V = normalize(cameraPosition - vWP);

  float e = 0.25;
  float h0 = wh(p, t, dir, perp, spd);
  float bump = 0.10 + spd * 0.7;                     // flatter (more mirror) when still
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
  depthF = mix(depthF, seaDepthF, seaMix);
  vec3 waterCol = wcPalette(depthF, still * 0.5 * (1.0 - seaMix));

  float fres = wcFresnel(N, V);
  vec3 col = mix(waterCol, wcSkyReflect(N, V), fres * mix(0.6, 0.95, still)); // mirror when still
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
  col = mix(col, vec3(0.95, 0.97, 0.98) * dayLight, clamp(foam, 0.0, 1.0));

  float alpha = mix(0.4, 0.9, depthF);
  alpha = max(max(alpha, foam), fres * 0.5);

  // distance LOD: converge to the ocean's EXACT surface — same wave field
  // (wcOceanH), same palette/fresnel/glint assembly, same alpha curve — so
  // from afar river and sea are one water and the delta has no boundary. The
  // flow ripples, mirror stillness and directional foam are close-range
  // effects only.
  float distF = smoothstep(140.0, 420.0, length(cameraPosition - vWP));
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
  alpha *= smoothstep(0.0, 0.30, vWet);
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
  seaOwn = max(seaOwn, farOwn);
  alpha *= (1.0 - seaOwn) * smoothstep(uTide - 0.25, uTide + 0.05, vWP.y);

  // distance sheen — identical term to the ocean shader, so river and sea
  // converge to the same pale reflected-sky tone at range: one blue surface
  float wDist = length(cameraPosition - vWP);
  col = mix(col, uSkyHorizon, smoothstep(300.0, 1200.0, wDist) * 0.55);

  float fogF = smoothstep(uFogNear, uFogFar, wDist);
  gl_FragColor = vec4(mix(col, uFogColor, fogF), alpha);
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
