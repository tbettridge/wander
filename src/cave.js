// Phase-3 seamless cave entrance and collision integration. Rare deterministic
// anchors feed worker-streamed fixed-resolution blocks; an open SDF throat,
// terrain-aligned portal and swept player collision join surface to interior.

import * as THREE from 'three';
import { landmarksAround } from './landmarks.js';
import { groundColor } from './world.js';
import { mulberry32 } from './noise.js';
import { buildGrassMesh, buildScatterGroup, buildUnderstoryMesh } from './vegetation.js';
import { GRASS_COLORS, GRASS_DENSITY, UNDERSTORY_RECIPES, UNDERSTORY_SCALE, rockTint } from './vegdata.js';
import {
  CAVE_CELL_SIZE,
  caveAnchorForCell,
  caveAnchorsAround,
  caveHash,
  caveReliefAt,
  caveGraphSignature,
  generateCaveGraph,
  scoreCaveEntrance,
} from './cavegen.mjs';
import { fitCaveToTerrain } from './cavefit.mjs';
import {
  CAVE_DEFAULT_RESOLUTION,
  CAVE_PLAYER_CROUCH_HEIGHT,
  CAVE_PLAYER_HEIGHT,
  CAVE_PLAYER_RADIUS,
  CAVE_PLAYER_SKIN,
  cavePortalInside,
  createCaveField,
} from './cavefield.mjs';
import {
  caveChunkCoordinatesAt,
  caveChunkKey,
  createCaveVisualFieldSampler,
  createCaveChunkPlan,
  meshImplicitBox,
} from './cavemesh.mjs';
import {
  entrancePortalNear,
  entranceShouldRecoverOutdoor,
  entranceThroatEngaged,
  entranceTransitionState,
  implicitBodyFits,
  implicitFloorHeightNear,
  resolveImplicitHorizontal,
} from './caveentrance.mjs';
import {
  adaptCaveExposure,
  caveEntranceLight,
  caveExposureTarget,
  caveFogRange,
  caveInteriorTarget,
  dampCaveValue,
} from './caveatmosphere.mjs';
import {
  CAVE_INTERIOR_MIN_LUMINANCE,
  caveMaterialPalette,
} from './cavematerial.mjs';
import {
  buildCaveDressingPlan,
  buildCaveDressingGeometry,
} from './cavedressing.mjs';
import {
  buildCaveHydrologyPlan,
  caveWaterProximity,
} from './cavehydrology.mjs';
import { setCaveEntranceVisual } from './cavevisual.js';
import { createTerrainPatchMaterial } from './terrain.js';

const CAVE_RENDER_LAYER = 2;
// The fine terrain/cave fold and the coarser streamed cave represent the same
// SDF at different resolutions. Keep both alive through a broad buried band:
// the stream sits underneath while the fold fades away before its open box edge.
const ENTRANCE_HANDOFF_STREAM_START = 18.5;
const ENTRANCE_HANDOFF_FADE_START = 19.0;
const ENTRANCE_HANDOFF_FADE_END = 24.0;
const ENTRANCE_HANDOFF_COLLAR_END = 26.5;
// Region-aware retention keeps the current region + graph neighbours resident
// (~30–70 blocks mid-network on a V4 graph), so the LRU needs headroom beyond
// the active set before it starts evicting blocks we still want.
const CACHE_LIMIT = 144;
// Worker messages arrive as independent browser tasks. Turning their typed
// arrays into Three.js objects inside those callbacks allowed both workers to
// create long tasks back-to-back. Admit only one completed block per rendered
// frame and spread cached scene reattachment over a few frames as well.
const CAVE_COMPLETIONS_PER_FRAME = 1;
const CAVE_ATTACHMENTS_PER_FRAME = 6;
// Terrain LOD can change several times while its chunks settle around a newly
// discovered entrance. Debounce the expensive implicit collar rebuild so a
// single approach does not remesh the same aperture repeatedly.
const ENTRANCE_INITIAL_SETTLE_MS = 180;
const ENTRANCE_REFRESH_SETTLE_MS = 850;
const ENTRANCE_ECOLOGY_DELAY_MS = 320;
const CAVE_HUMIDITY = Object.freeze({
  grotto: 1, limestone: 0.56, cathedral: 0.42, boulder: 0.30,
  fracture: 0.34, ice: 0.48, volcanic: 0.16,
});
const CAVE_FOG_RGB = Object.freeze({
  limestone: [0.014, 0.021, 0.024], cathedral: [0.014, 0.019, 0.026],
  boulder: [0.018, 0.019, 0.018], grotto: [0.010, 0.025, 0.027],
  fracture: [0.012, 0.017, 0.024], ice: [0.022, 0.034, 0.050],
  volcanic: [0.030, 0.014, 0.009],
});
const CAVE_AMBIENT_RGB = Object.freeze({
  limestone: [0.115, 0.140, 0.150], cathedral: [0.105, 0.125, 0.160],
  boulder: [0.125, 0.125, 0.115], grotto: [0.085, 0.140, 0.145],
  fracture: [0.095, 0.115, 0.145], ice: [0.135, 0.175, 0.225],
  volcanic: [0.145, 0.090, 0.065],
});

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function smoothstep(a, b, value) {
  const t = clamp01((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
}
function smoothMinimum(a, b, radius) {
  const h = clamp01(0.5 + 0.5 * (b - a) / radius);
  return b + (a - b) * h - radius * h * (1 - h);
}

function caveMaterial({ clipEntrance = false } = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    wireframe: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSurfaceDebug: { value: 0 },
      // Only meshes belonging to entrance-tagged streaming blocks enable this
      // clip. Keeping it off on ordinary blocks lets large caves bend behind
      // the mouth without a cave-wide local-Z discard deleting distant walls.
      uSurfacePreview: { value: clipEntrance ? 1 : 0 },
      uPreviewMinZ: { value: -35 },
      uEntranceWorldPosition: { value: new THREE.Vector3() },
      uEntranceLightColor: { value: new THREE.Color(0.68, 0.76, 0.88) },
      uEntranceIntensity: { value: 0.8 },
      uCaveAmbientColor: { value: new THREE.Color(0.12, 0.15, 0.18) },
      uNavigationFill: { value: 0.04 },
      uInteriorFactor: { value: 0 },
      uPainterlyStrength: { value: 0.88 },
      uRockDark: { value: new THREE.Color(0.055, 0.067, 0.066) },
      uRockMid: { value: new THREE.Color(0.255, 0.285, 0.250) },
      uRockLight: { value: new THREE.Color(0.455, 0.445, 0.345) },
      uSedimentColor: { value: new THREE.Color(0.315, 0.245, 0.145) },
      uMineralColor: { value: new THREE.Color(0.185, 0.385, 0.350) },
      uWetColor: { value: new THREE.Color(0.035, 0.105, 0.105) },
      // strata scale, mineral response, fracture response, crystalline lift
      uGeologyParams: { value: new THREE.Vector4(1.55, 0.68, 0.55, 0.05) },
    }]),
    vertexShader: /* glsl */`
      attribute vec4 aSurface;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPosition;
      varying vec4 vSurface;
      #include <fog_pars_vertex>
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 mvPosition = viewMatrix * world;
        vWorldPosition = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vLocalPosition = position;
        vSurface = aSurface;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uSurfaceDebug;
      uniform float uSurfacePreview;
      uniform float uPreviewMinZ;
      uniform vec3 uEntranceWorldPosition;
      uniform vec3 uEntranceLightColor;
      uniform vec3 uCaveAmbientColor;
      uniform float uEntranceIntensity;
      uniform float uNavigationFill;
      uniform float uInteriorFactor;
      uniform float uPainterlyStrength;
      uniform vec3 uRockDark;
      uniform vec3 uRockMid;
      uniform vec3 uRockLight;
      uniform vec3 uSedimentColor;
      uniform vec3 uMineralColor;
      uniform vec3 uWetColor;
      uniform vec4 uGeologyParams;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPosition;
      varying vec4 vSurface;
      #include <fog_pars_fragment>
      float hash31(vec3 p) {
        p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float noise3(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
              mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
              mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        if (uSurfacePreview > 0.5 && vLocalPosition.z < uPreviewMinZ) discard;
        vec3 n = normalize(vWorldNormal), toEye = normalize(cameraPosition - vWorldPosition);
        float distanceToEye = length(cameraPosition - vWorldPosition);
        vec3 p = vLocalPosition;
        float detailFade = 1.0 - smoothstep(48.0, 145.0, distanceToEye);
        float broad = noise3(p * 0.072 + vec3(2.1, 7.3, -4.8));
        float wash = noise3(p * 0.038 + vec3(-3.7, 12.0, 5.2));
        float tooth = noise3(p * 0.31 + vec3(-8.0, 1.5, 11.0));
        float strataWarp = noise3(p * 0.105 + vec3(5.4, -2.1, 8.6));
        float strata = 0.5 + 0.5 * sin((p.y + strataWarp * 1.45) * uGeologyParams.x * 3.2);
        float stoneValue = clamp(0.08 + broad * 0.78 + wash * 0.22 + strata * 0.10 * detailFade, 0.0, 1.0);
        // Broad five-value grouping reads like laid-in paint, but a small
        // continuous component preserves shape and prevents contour banding.
        float groupedValue = (floor(stoneValue * 5.0) + 0.5) / 5.0;
        stoneValue = mix(stoneValue, groupedValue, uPainterlyStrength * 0.48);
        vec3 base = mix(uRockDark, uRockMid, smoothstep(0.05, 0.68, stoneValue));
        base = mix(base, uRockLight, smoothstep(0.58, 0.96, stoneValue) * (0.58 + tooth * 0.32));

        float floorFacing = smoothstep(0.12, 0.72, n.y);
        float ceilingFacing = smoothstep(0.12, 0.78, -n.y);
        float sedimentMask = vSurface.y * floorFacing * (0.42 + wash * 0.58);
        base = mix(base, uSedimentColor, sedimentMask * (0.42 + uPainterlyStrength * 0.30));

        float veinNoise = abs(noise3(p * vec3(0.18, 0.32, 0.18) + vec3(1.1, 6.3, -2.7)) - 0.5);
        float veinLine = 1.0 - smoothstep(0.035, 0.145, veinNoise);
        float mineralMask = clamp(vSurface.z * (0.24 + veinLine * 0.92 * detailFade) * uGeologyParams.y, 0.0, 1.0);
        base = mix(base, uMineralColor, mineralMask * (0.40 + uPainterlyStrength * 0.36));

        float crackNoise = abs(noise3(p * 0.285 + vec3(-9.0, 4.2, 3.7)) - 0.5);
        float crackLine = 1.0 - smoothstep(0.020, 0.080, crackNoise);
        float fractureMask = clamp(vSurface.w * crackLine * uGeologyParams.z * detailFade
          * (1.0 - ceilingFacing * 0.48), 0.0, 1.0);
        base *= 1.0 - fractureMask * (0.25 + uPainterlyStrength * 0.30);
        float exposedEdge = vSurface.w * (1.0 - crackLine) * smoothstep(0.72, 0.96, tooth)
          * detailFade;
        base = mix(base, uRockLight, exposedEdge * 0.22);

        // Moist rock should remain recognisably rock. The previous broad,
        // near-black replacement made ceilings read as a suspended liquid
        // sheet. Break the semantic wet channel into narrow mineral streaks
        // and darken the local stone hue instead of painting over it.
        float wetBreakup = noise3(p * vec3(0.13, 0.045, 0.13) + vec3(4.6, -1.8, 9.2));
        float wetStreak = smoothstep(0.40, 0.78,
          noise3(p * vec3(0.23, 0.055, 0.23) + vec3(-2.4, 7.1, 1.8)));
        float wetMask = clamp(vSurface.x
          * (0.18 + ceilingFacing * 0.10 + floorFacing * 0.16)
          * (0.42 + wetBreakup * 0.38 + wetStreak * 0.20), 0.0, 1.0);
        vec3 wetStone = mix(base * 0.70, uWetColor, 0.12);
        base = mix(base, wetStone, wetMask * (0.30 + uPainterlyStrength * 0.16));
        // Downward-facing grotto facets previously multiplied the darkest
        // palette value by the weakest ambient term, forming near-black,
        // fluid-looking islands overhead. Retain a quiet reflected-rock wash
        // on ceilings while leaving wall/floor contrast untouched.
        vec3 reflectedCeilingRock = mix(base, uRockMid, 0.42);
        base = mix(base, reflectedCeilingRock,
          ceilingFacing * (0.18 + wash * 0.12));
        float dryDust = (1.0 - vSurface.x) * floorFacing * (0.10 + wash * 0.18);
        base = mix(base, uRockLight, dryDust * 0.13);
        float crystalSpark = smoothstep(0.86, 0.985, tooth) * uGeologyParams.w;
        base += uRockLight * crystalSpark * (0.18 + mineralMask * 0.32);
        float facing = max(dot(n, toEye), 0.0);
        vec3 entranceVector = uEntranceWorldPosition - vWorldPosition;
        float entranceDistance = length(entranceVector);
        vec3 toEntrance = entranceVector / max(0.001, entranceDistance);
        float entranceFacing = 0.18 + max(dot(n, toEntrance), 0.0) * 0.82;
        float entranceFalloff = 1.0 / (1.0 + entranceDistance * 0.070
          + entranceDistance * entranceDistance * 0.0024);
        vec3 entranceLight = uEntranceLightColor
          * (uEntranceIntensity * entranceFacing * entranceFalloff);
        // Accessibility fill replaces the former bright camera headlight. It
        // is broad, short-ranged and weakly view-facing, so it reveals nearby
        // footing without painting a circular beam onto every wall.
        vec3 navigationDirection = normalize(toEye + vec3(0.0, 0.55, 0.0));
        float navigationFacing = max(dot(n, navigationDirection), 0.0);
        float navigationFill = uNavigationFill * (0.22 + navigationFacing * 0.78)
          / (1.0 + distanceToEye * 0.14);
        vec3 ambientLight = uCaveAmbientColor
          * (0.60 + max(n.y, 0.0) * 0.40 + ceilingFacing * 0.12);
        float wetSheen = pow(max(dot(reflect(-toEye, n), normalize(toEntrance + vec3(0.0, 0.7, 0.0))), 0.0), 16.0);
        if (uSurfaceDebug > 0.5) {
          // false-colour semantics view: orientation from the normal (green
          // floors / grey walls / violet ceilings), then wet=blue,
          // sediment=ochre, mineral=teal, fracture=red
          vec3 orient = n.y > 0.35 ? vec3(0.30, 0.34, 0.22)
            : (n.y < -0.35 ? vec3(0.20, 0.16, 0.30) : vec3(0.24, 0.24, 0.24));
          vec3 debugColor = orient;
          debugColor = mix(debugColor, vec3(0.10, 0.38, 0.90), vSurface.x * 0.85);
          debugColor = mix(debugColor, vec3(0.62, 0.46, 0.24), vSurface.y * 0.55);
          debugColor = mix(debugColor, vec3(0.15, 0.95, 0.75), vSurface.z * 0.95);
          debugColor = mix(debugColor, vec3(0.90, 0.22, 0.18), vSurface.w * 0.75);
          gl_FragColor = vec4(debugColor * (0.45 + navigationFill), 1.0);
          return;
        }
        vec3 color = base * (ambientLight + entranceLight + vec3(navigationFill));
        color += mix(uRockDark, uRockMid, 0.32) * ceilingFacing
          * (0.045 + wash * 0.045) * uInteriorFactor;
        // the semantic wet channel scales the existing sheen — the first real
        // consumer of the Phase-A data; full painting arrives with Phase D
        color += mix(base, uRockLight, 0.34) * wetSheen * wetMask
          * (0.12 + uPainterlyStrength * 0.22);
        color *= 0.96 + groupedValue * 0.06;
        gl_FragColor = vec4(color, 1.0);
        #include <fog_fragment>
        // Absolute underground shadow floor. Semantic debug proved the former
        // black islands were valid wall fragments whose combined palette,
        // facing and fog terms collapsed to zero. Apply this after fog so the
        // guarantee survives every cave-material lighting path, but ramp it
        // away at the threshold so the entrance stays naturally dark outside.
        float interiorFloor = ${CAVE_INTERIOR_MIN_LUMINANCE.toFixed(4)}
          * smoothstep(0.46, 0.92, uInteriorFactor);
        vec3 shadowHue = mix(uCaveAmbientColor, uRockMid, 0.52);
        float outputLuminance = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        float shadowHueLuminance = max(
          dot(shadowHue, vec3(0.2126, 0.7152, 0.0722)), 0.001);
        gl_FragColor.rgb += shadowHue
          * (max(0.0, interiorFloor - outputLuminance) / shadowHueLuminance);
      }
    `,
  });
}

function caveWaterMaterial() {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uWaterColor: { value: new THREE.Color(0.09, 0.255, 0.255) },
      uDeepColor: { value: new THREE.Color(0.018, 0.08, 0.095) },
      uEntranceLightColor: { value: new THREE.Color(0.68, 0.76, 0.88) },
      uEntranceIntensity: { value: 0.8 },
      uAmbientColor: { value: new THREE.Color(0.115, 0.14, 0.15) },
      uInteriorFactor: { value: 0 },
      uFrozen: { value: 0 },
    }]),
    vertexShader: /* glsl */`
      attribute vec2 aFlow;
      attribute float aFlowCoord;
      attribute float aWaterKind;
      attribute float aWaterEdge;
      attribute float aFlowCross;
      uniform float uTime;
      varying vec3 vWorldPosition;
      varying vec3 vLocalPosition;
      varying vec2 vFlow;
      varying float vFlowCoord;
      varying float vWaterKind;
      varying float vWaterEdge;
      varying float vFlowCross;
      #include <fog_pars_vertex>
      void main() {
        vec3 transformed = position;
        float streamMask = 1.0 - smoothstep(0.25, 0.72, aWaterKind);
        float waterMotion = sin(aFlowCoord * 5.2 - uTime * 2.65 + aFlowCross * 0.8)
          + sin(aFlowCoord * 10.7 - uTime * 4.15 - aFlowCross * 1.4) * 0.34;
        transformed.y += waterMotion * 0.0038 * streamMask * (1.0 - aWaterEdge * 0.58);
        vec4 world = modelMatrix * vec4(transformed, 1.0);
        vec4 mvPosition = viewMatrix * world;
        vWorldPosition = world.xyz;
        vLocalPosition = transformed;
        vFlow = aFlow;
        vFlowCoord = aFlowCoord;
        vWaterKind = aWaterKind;
        vWaterEdge = aWaterEdge;
        vFlowCross = aFlowCross;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform vec3 uWaterColor;
      uniform vec3 uDeepColor;
      uniform vec3 uEntranceLightColor;
      uniform float uEntranceIntensity;
      uniform vec3 uAmbientColor;
      uniform float uInteriorFactor;
      uniform float uFrozen;
      varying vec3 vWorldPosition;
      varying vec3 vLocalPosition;
      varying vec2 vFlow;
      varying float vFlowCoord;
      varying float vWaterKind;
      varying float vWaterEdge;
      varying float vFlowCross;
      #include <fog_pars_fragment>
      void main() {
        vec3 toEye = normalize(cameraPosition - vWorldPosition);
        float streamMask = 1.0 - smoothstep(0.20, 0.72, vWaterKind);
        float fallMask = smoothstep(1.45, 1.90, vWaterKind);
        float poolMask = clamp(1.0 - streamMask - fallMask, 0.0, 1.0);
        vec2 flow = length(vFlow) > 0.1 ? normalize(vFlow) : vec2(0.707, 0.707);
        vec2 across = vec2(-flow.y, flow.x);
        // Rills travel downstream in graph distance. Pools retain slower,
        // crossing ripples and falls use vertical travelling streaks.
        float streamA = sin(vFlowCoord * 5.2 - uTime * 2.65 + vFlowCross * 0.8);
        float streamB = sin(vFlowCoord * 10.7 - uTime * 4.15 - vFlowCross * 1.4);
        float poolA = sin(vLocalPosition.x * 1.05 + vLocalPosition.z * 0.36 + uTime * 0.52);
        float poolB = sin(vLocalPosition.z * 0.84 - vLocalPosition.x * 0.29 - uTime * 0.41);
        float fallA = sin(vFlowCoord * 8.4 - uTime * 5.7 + vFlowCross * 1.1);
        float ripple = streamMask * (streamA * 0.68 + streamB * 0.32)
          + poolMask * (poolA + poolB) * 0.5 + fallMask * fallA;
        vec2 streamSlope = flow * (streamA * 0.075 + streamB * 0.038)
          + across * streamB * 0.026;
        vec2 poolSlope = vec2(poolA, poolB) * 0.065;
        vec2 rippleSlope = mix(poolSlope, streamSlope, streamMask);
        vec3 rippleNormal = normalize(vec3(-rippleSlope.x, 1.0, -rippleSlope.y));
        float fresnel = pow(1.0 - max(dot(rippleNormal, toEye), 0.0), 3.0);
        float iceGrain = 0.5 + 0.5 * sin(vLocalPosition.x * 2.7 + vLocalPosition.z * 1.9);
        float travellingGlint = smoothstep(0.72, 0.98, streamA * 0.5 + 0.5) * streamMask;
        float fallFoam = smoothstep(0.54, 0.96, fallA * 0.5 + 0.5) * fallMask;
        vec3 color = mix(uDeepColor, uWaterColor, 0.18 + fresnel * 0.34 + ripple * 0.020);
        color += uAmbientColor * (0.08 + fresnel * 0.10);
        color += uEntranceLightColor * uEntranceIntensity * (0.015 + fresnel * 0.045);
        color += uWaterColor * travellingGlint * 0.045;
        color += mix(uWaterColor, vec3(0.60, 0.72, 0.70), 0.32) * fallFoam * 0.10;
        color = mix(color, uWaterColor * (0.82 + iceGrain * 0.20), uFrozen * 0.44);
        color *= mix(0.62, 1.10, uFrozen);
        float alpha = mix(0.32 + fresnel * 0.16, 0.78 + fresnel * 0.11, uFrozen);
        float softBank = 0.10 + 0.90 * (1.0 - smoothstep(0.66, 1.0, vWaterEdge));
        alpha *= mix(softBank, 1.0, fallMask);
        alpha *= mix(0.82, 1.0, uInteriorFactor);
        if (alpha < 0.025) discard;
        gl_FragColor = vec4(color, alpha);
        #include <fog_fragment>
      }
    `,
  });
  material.userData.excludeFromAO = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  return material;
}

function caveDripMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uRain: { value: 0 },
      uInteriorFactor: { value: 0 },
      uWaterColor: { value: new THREE.Color(0.09, 0.255, 0.255) },
    }]),
    vertexShader: /* glsl */`
      attribute float aBottom;
      attribute float aPhase;
      attribute float aRate;
      attribute float aWeather;
      uniform float uTime;
      uniform float uRain;
      varying float vFade;
      #include <fog_pars_vertex>
      void main() {
        float speed = aRate * (1.0 + uRain * aWeather * 1.8);
        float travel = fract(uTime * speed + aPhase);
        vec3 transformed = position;
        transformed.y = mix(position.y, aBottom, travel);
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp(115.0 / max(1.0, -mvPosition.z), 1.2, 3.6);
        vFade = smoothstep(0.0, 0.10, travel) * smoothstep(1.0, 0.82, travel);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uWaterColor;
      uniform float uInteriorFactor;
      varying float vFade;
      #include <fog_pars_fragment>
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float alpha = smoothstep(0.5, 0.08, d) * vFade * mix(0.45, 0.82, uInteriorFactor);
        gl_FragColor = vec4(uWaterColor * 1.35, alpha);
        #include <fog_fragment>
      }
    `,
  });
  material.userData.excludeFromAO = true;
  return material;
}

function caveMistMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: THREE.NormalBlending,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uMistColor: { value: new THREE.Color(0.10, 0.20, 0.21) },
      uInteriorFactor: { value: 0 },
    }]),
    vertexShader: /* glsl */`
      attribute float aPhase;
      attribute float aRise;
      attribute float aStrength;
      uniform float uTime;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        float life = fract(uTime * 0.075 + aPhase);
        vec3 transformed = position;
        transformed.y += life * aRise;
        transformed.x += sin(life * 6.283 + aPhase * 9.0) * 0.18 * aStrength;
        transformed.z += cos(life * 5.1 + aPhase * 7.0) * 0.16 * aStrength;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp((130.0 + aStrength * 155.0) / max(1.0, -mvPosition.z), 5.0, 22.0);
        vAlpha = sin(life * 3.14159) * (0.045 + aStrength * 0.055);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uMistColor;
      uniform float uInteriorFactor;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float soft = exp(-d * d * 2.2);
        gl_FragColor = vec4(uMistColor, soft * vAlpha * uInteriorFactor);
        #include <fog_fragment>
      }
    `,
  });
  material.userData.excludeFromAO = true;
  return material;
}

function buildHydrologyGeometry(plan) {
  const positions = [], normals = [], flows = [], flowCoords = [], waterKinds = [];
  const waterEdges = [], flowCrosses = [], indices = [];
  const pushVertex = (point, {
    flowX = 0, flowZ = 0, flowCoord = 0, kind = 1, edge = 0, cross = 0,
  } = {}) => {
    positions.push(point.x, point.y, point.z);
    normals.push(0, 1, 0);
    flows.push(flowX, flowZ);
    flowCoords.push(flowCoord);
    waterKinds.push(kind);
    waterEdges.push(edge);
    flowCrosses.push(cross);
    return positions.length / 3 - 1;
  };
  for (const stream of plan.streams) {
    const rows = [];
    for (const point of stream.points) {
      // Use the sampled curve tangent rather than the original passage axis,
      // so the banks turn with the meander instead of shearing across it.
      const lateralX = -point.fz, lateralZ = point.fx;
      const meta = { flowX: point.fx, flowZ: point.fz, flowCoord: point.flowDistance, kind: 0 };
      rows.push([-1, 0, 1].map((cross) => pushVertex({
        x: point.x + lateralX * point.halfWidth * cross,
        y: point.y,
        z: point.z + lateralZ * point.halfWidth * cross,
      }, { ...meta, edge: Math.abs(cross), cross })));
    }
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1], current = rows[i];
      for (let side = 0; side < 2; side++) {
        const al = previous[side], ar = previous[side + 1];
        const bl = current[side], br = current[side + 1];
        indices.push(al, ar, bl, ar, br, bl);
      }
    }
  }
  // Incident rills terminate at an exact shared height. A soft circular patch
  // hides the individual ribbon caps and makes forks/merges read as one body
  // of water rather than intersecting strips.
  for (const junction of plan.junctions || []) {
    const center = pushVertex(junction, { kind: 1, edge: 0 });
    const segments = 18;
    const ring = [];
    for (let i = 0; i < segments; i++) {
      const angle = i / segments * Math.PI * 2;
      ring.push(pushVertex({
        x: junction.x + Math.cos(angle) * junction.radius,
        y: junction.y + 0.0015,
        z: junction.z + Math.sin(angle) * junction.radius,
      }, { kind: 1, edge: 1, cross: Math.sin(angle) }));
    }
    for (let i = 0; i < ring.length; i++) indices.push(center, ring[i], ring[(i + 1) % ring.length]);
  }
  for (const pool of plan.pools) {
    const center = pushVertex(pool.center, { kind: 1, edge: 0 });
    const ring = pool.points.map((point, index) => pushVertex(point, {
      kind: 1, edge: 1, cross: Math.sin(index / pool.points.length * Math.PI * 2),
    }));
    for (let i = 0; i < ring.length; i++) {
      indices.push(center, ring[i], ring[(i + 1) % ring.length]);
    }
  }
  for (const fall of plan.waterfalls || []) {
    const rows = [
      { y: fall.top, coord: 0 },
      { y: (fall.top + fall.bottom) * 0.5, coord: (fall.top - fall.bottom) * 0.5 },
      { y: fall.bottom, coord: fall.top - fall.bottom },
    ].map(({ y, coord }) => [-1, 0, 1].map((cross) => pushVertex({
      x: fall.x + fall.px * fall.halfWidth * cross,
      y,
      z: fall.z + fall.pz * fall.halfWidth * cross,
    }, { flowX: fall.px, flowZ: fall.pz, flowCoord: coord, kind: 2, edge: Math.abs(cross), cross })));
    for (let row = 1; row < rows.length; row++) {
      for (let side = 0; side < 2; side++) {
        const al = rows[row - 1][side], ar = rows[row - 1][side + 1];
        const bl = rows[row][side], br = rows[row][side + 1];
        indices.push(al, ar, bl, ar, br, bl);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2));
  geometry.setAttribute('aFlowCoord', new THREE.Float32BufferAttribute(flowCoords, 1));
  geometry.setAttribute('aWaterKind', new THREE.Float32BufferAttribute(waterKinds, 1));
  geometry.setAttribute('aWaterEdge', new THREE.Float32BufferAttribute(waterEdges, 1));
  geometry.setAttribute('aFlowCross', new THREE.Float32BufferAttribute(flowCrosses, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function buildDripGeometry(plan) {
  const drips = plan.drips || [];
  const positions = new Float32Array(drips.length * 3);
  const bottoms = new Float32Array(drips.length);
  const phases = new Float32Array(drips.length);
  const rates = new Float32Array(drips.length);
  const weather = new Float32Array(drips.length);
  for (let i = 0; i < drips.length; i++) {
    const drip = drips[i];
    positions.set([drip.x, drip.top, drip.z], i * 3);
    bottoms[i] = drip.bottom;
    phases[i] = drip.phase;
    rates[i] = drip.rate;
    weather[i] = drip.weather;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aBottom', new THREE.BufferAttribute(bottoms, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aRate', new THREE.BufferAttribute(rates, 1));
  geometry.setAttribute('aWeather', new THREE.BufferAttribute(weather, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildMistGeometry(plan) {
  const mist = plan.mist || [];
  const positions = new Float32Array(mist.length * 3);
  const phases = new Float32Array(mist.length);
  const rises = new Float32Array(mist.length);
  const strengths = new Float32Array(mist.length);
  for (let i = 0; i < mist.length; i++) {
    const wisp = mist[i];
    positions.set([wisp.x, wisp.y, wisp.z], i * 3);
    phases[i] = wisp.phase;
    rises[i] = wisp.rise;
    strengths[i] = wisp.strength;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
  geometry.setAttribute('aStrength', new THREE.BufferAttribute(strengths, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose?.();
  });
}

export class CaveExperiment {
  constructor(scene, world, controls, { x = -4129, z = -809, terrain = null, library = null } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.terrain = terrain;
    this.library = library;
    this.surfaceCameraNear = controls.camera.near;
    this.searchOrigin = { x, z };
    this.group = new THREE.Group();
    this.group.name = 'phase-3-seamless-cave';
    this.group.visible = false;
    scene.add(this.group);
    this.material = caveMaterial();
    this.entranceStreamMaterial = caveMaterial({ clipEntrance: true });
    this.materialStyle = { strength: 0.88 };
    this.waterMaterial = caveWaterMaterial();
    this.dripMaterial = caveDripMaterial();
    this.mistMaterial = caveMistMaterial();
    this.fungiGlowMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uGlowColor: { value: new THREE.Color(0.42, 1.0, 0.66) },
        uInteriorFactor: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute float aGlow;
        varying float vGlow;
        varying float vPhase;
        void main() {
          vGlow = aGlow;
          vPhase = fract(position.x * 0.731 + position.z * 0.577) * 6.2831;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(240.0 * aGlow / max(1.0, -mvPosition.z), 4.0, 54.0);
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uGlowColor;
        uniform float uInteriorFactor;
        varying float vGlow;
        varying float vPhase;
        void main() {
          // Soft round sprite: bright core, wide falloff so each cap wears a
          // halo rather than a hard dot. Additive, so bioluminescence only
          // reads once the cave darkens — gate it on the interior factor.
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = 1.0 - smoothstep(0.0, 0.35, d);
          float halo = (1.0 - smoothstep(0.2, 1.0, d)) * 0.55;
          float pulse = 0.7 + 0.3 * sin(uTime * 1.6 + vPhase);
          float intensity = (core + halo) * vGlow * pulse * (0.5 + 1.9 * uInteriorFactor);
          gl_FragColor = vec4(uGlowColor * intensity, intensity);
        }`,
    });
    this.fungiGlowMaterial.userData.excludeFromAO = true;
    this.hydrology = { enabled: true, plan: null, mesh: null, dripMesh: null, mistMesh: null };
    this.dressing = { enabled: true, plan: null, mesh: null, glowMesh: null };
    this.atmosphere = {
      enabled: true,
      factor: 0,
      target: 0,
      exposureScale: 1,
      entranceIntensity: 0,
      navigationFill: 0.68,
      entranceColor: new THREE.Color(0.68, 0.76, 0.88),
      ambientColor: new THREE.Color(0.115, 0.14, 0.15),
      fogColor: new THREE.Color(0.014, 0.021, 0.024),
      surfaceFogColor: new THREE.Color(),
      nightColor: new THREE.Color(0.30, 0.40, 0.62),
      state: 'surface',
    };

    this.graphDebug = null;
    this.entranceFacade = null;
    this.entranceMaterial = null;
    this.entranceImplicitField = null;
    this.entranceCollisionField = null;
    this.entranceImplicitBounds = null;
    this.entranceEcology = null;
    this.entranceTerrainSignature = null;
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.active = false;
    this.inside = false;
    this.openingActive = false;
    this.collisionFloorLocal = null;
    this.elapsed = 0;
    this.landmarkScratch = [];
    this.anchorCandidates = [];
    this.chunkCache = new Map();
    this.attachedKeys = new Set();
    this.desiredKeys = new Set();
    this.pendingKeys = new Map();
    this.requestById = new Map();
    this.queuedKeys = new Set();
    this.jobQueue = [];
    this.completedResults = [];
    this.attachmentQueue = [];
    this.queuedAttachments = new Set();
    this.metricsDirty = false;
    this.pendingEntranceTerrainSignature = null;
    this.entranceTerrainStableSince = 0;
    this.entranceEcologySignature = null;
    this.entranceEcologyDueAt = 0;
    this.nextRequestId = 1;
    this.generationEpoch = 0;
    this.lastStreamCell = '';
    this.inspection = { active: false };
    this.auditPending = null;
    this.streamStartedAt = 0;
    this.workerErrors = 0;
    this.workers = [];
    this.createWorkers();
    this.collectAnchors();

    this.debug = {
      resolution: CAVE_DEFAULT_RESOLUTION,
      wireframe: false,
      surfaceDebug: false,
      lightingEnabled: true,
      inspect: false,
      showGraph: false,
      state: 'not streamed', collision: '—', atmosphere: 'surface', hydrology: '—', dressing: '—',
      anchor: '—', placement: '—', topology: '—', graph: '—',
      streaming: '—', metrics: '—', auditResult: '—',
      previousAnchor: () => this.stepAnchor(-1),
      nextAnchor: () => this.stepAnchor(1),
      nextGeology: () => this.stepGeology(),
      previousChamber: () => this.stepChamber(-1),
      nextChamber: () => this.stepChamber(1),
      reviewLighting: () => this.reviewEntranceLighting(),
      reviewWater: () => this.reviewHydrology(),
      previewSurface: () => this.previewSurface(),
      enter: () => this.enter(),
      exit: () => this.exit(),
      rebuild: () => this.rebuild(),
      audit: () => this.audit(true),
    };

    this.anchorIndex = 0;
    this.chamberIndex = 0;
    this.configureAnchor(0);
    this.environment = {
      isIndoor: () => this.inside,
      floorHeight: (worldX, worldZ) => {
        return this.entranceFloorHeightWorld(worldX, worldZ);
      },
      resolveMovement: (position, previous) => this.resolveMovement(position, previous),
    };
  }

  createWorkers() {
    const count = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./caveworker.js', import.meta.url), { type: 'module' });
      const slot = { worker, busy: false, requestId: 0, initializedGraphHash: null };
      worker.onmessage = (event) => this.onWorkerMessage(slot, event.data);
      worker.onerror = (event) => {
        const job = this.requestById.get(slot.requestId);
        this.requestById.delete(slot.requestId);
        if (job) this.pendingKeys.delete(job.cacheKey);
        slot.busy = false;
        slot.requestId = 0;
        // The error may have happened before the worker accepted the graph.
        // Send the finalized graph again on this slot's next request.
        slot.initializedGraphHash = null;
        if (!job || job.epoch === this.generationEpoch) {
          this.workerErrors++;
          this.debug.state = `worker error · ${event.message || 'unknown'}`;
        }
        this.metricsDirty = true;
        this.pumpWorkers();
      };
      this.workers.push(slot);
    }
  }

  collectAnchors() {
    for (const radius of [7000, 14000, 22000]) {
      caveAnchorsAround(this.world, this.searchOrigin.x, this.searchOrigin.z, this.world.seed, radius, this.anchorCandidates);
      this.anchorCandidates = this.anchorCandidates.filter((anchor) => {
        landmarksAround(this.world, anchor.x, anchor.z, this.world.seed, 180, this.landmarkScratch);
        return !this.landmarkScratch.some((landmark) => {
          const dx = anchor.x - landmark.x, dz = anchor.z - landmark.z;
          const clearance = landmark.halo + 70;
          return dx * dx + dz * dz < clearance * clearance;
        });
      });
      if (this.anchorCandidates.length >= 3) break;
    }
    if (this.anchorCandidates.length === 0) {
      const fallback = scoreCaveEntrance(this.world, this.searchOrigin.x, this.searchOrigin.z, this.world.seed);
      this.anchorCandidates.push({
        ...fallback, id: 'cave:debug:fallback', key: 'debug_fallback', cellX: 0, cellZ: 0,
        seed: this.world.seed >>> 0, valid: false,
        reasons: [...fallback.reasons, 'no valid macro-cell anchor found in search radius'],
      });
    }
  }

  configureAnchor(index) {
    this.generationEpoch++;
    this.auditPending = null;
    if (this.debug) this.debug.auditResult = '—';
    this.jobQueue.length = 0;
    this.queuedKeys.clear();
    this.completedResults.length = 0;
    this.attachmentQueue.length = 0;
    this.queuedAttachments.clear();
    this.disposeEntranceFacade();
    this.disposeEntranceEcology();
    this.disposeHydrology();
    this.disposeDressing();
    this.entranceImplicitField = null;
    this.entranceCollisionField = null;
    this.entranceImplicitBounds = null;
    this.entranceTerrainSignature = null;
    this.pendingEntranceTerrainSignature = null;
    this.entranceTerrainStableSince = 0;
    this.entranceEcologySignature = null;
    this.entranceEcologyDueAt = 0;
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.collisionFloorLocal = null;
    const count = this.anchorCandidates.length;
    this.anchorIndex = ((index % count) + count) % count;
    this.anchor = this.anchorCandidates[this.anchorIndex];
    this.chamberIndex = 0;
    // biome gates the rare geologies (ice tubes in snow, lava tubes in desert);
    // hill class steers small-hill sites toward deep multi-level descents,
    // which fit under modest cover far better than long horizontal networks
    this.hillClass = caveReliefAt(this.world, this.anchor.x, this.anchor.z) < 26 ? 'low' : 'high';
    const generatedGraph = generateCaveGraph(this.anchor.seed, {
      biome: this.anchor.biome, hillClass: this.hillClass,
    });
    const generatedField = createCaveField(generatedGraph);
    const mouth = generatedGraph.entrance.mouth;
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    const mouthWorldX = cos * mouth[0] + sin * mouth[2];
    const mouthWorldZ = -sin * mouth[0] + cos * mouth[2];
    this.entranceFloorLocal = generatedField.floorHeight(mouth[0], mouth[2]);
    if (this.entranceFloorLocal === null) throw new Error(`Generated cave at ${this.anchor.id} has no entrance floor`);
    // A natural cave mouth cuts into the slope; aligning its floor to the top
    // of the heightfield made every facade sit on the ground like a pipe. Sink
    // the threshold under the hillside while preserving ample headroom/cover.
    this.entranceInset = Math.max(1.8, Math.min(3.2,
      this.anchor.coverRise * 0.18 + this.anchor.slope * 2.0));
    this.origin = new THREE.Vector3(
      this.anchor.x - mouthWorldX,
      this.anchor.surfaceY - this.entranceInset - this.entranceFloorLocal,
      this.anchor.z - mouthWorldZ,
    );
    const surfaceYAtLocal = (localX, localZ) => {
      const worldX = this.origin.x + cos * localX + sin * localZ;
      const worldZ = this.origin.z - sin * localX + cos * localZ;
      return this.world.height(worldX, worldZ) - this.origin.y;
    };
    const fitStartedAt = performance.now();
    this.graph = fitCaveToTerrain(generatedGraph, surfaceYAtLocal);
    this.terrainFitMs = performance.now() - fitStartedAt;
    this.graphSignature = caveGraphSignature(this.graph);
    this.field = createCaveField(this.graph);
    const fittedEntranceFloor = this.field.floorHeight(mouth[0], mouth[2]);
    if (fittedEntranceFloor === null || Math.abs(fittedEntranceFloor - this.entranceFloorLocal) > 0.02) {
      throw new Error(`Terrain fitting changed cave entrance floor ${this.graphSignature}`);
    }
    this.entranceFloorLocal = fittedEntranceFloor;
    this.fieldBaseline = this.field.hashField(24);
    const entranceSpec = {
      x: this.anchor.x,
      y: this.anchor.surfaceY - this.entranceInset,
      z: this.anchor.z,
      inwardX: this.anchor.inwardX,
      inwardZ: this.anchor.inwardZ,
      // Only the actual aperture/core clears ordinary chunk vegetation. The
      // outer verge remains available for both world scatter and authored
      // entrance dressing, avoiding a conspicuous sterile oval.
      width: 4.45,
      depth: 5.6,
      // Procedural chunk vegetation needs a slightly broader safety margin
      // than the cut itself; authored entrance dressing fills this verge back
      // in after it has been sampled against the final folded surface.
      vegetationWidth: 4.6,
      vegetationDepth: 7.2,
      // Terrain and the marching-cubes fold are independently tessellated.
      // Keep a small signed-field overlap at their shared lip so sub-voxel
      // interpolation differences cannot expose a sawtooth background crack.
      terrainCutOverlap: 0.30,
      cut: {
        minAlong: -4.2,
        maxAlong: 3.1,
        outerHalfWidth: 2.0,
        middleHalfWidth: 2.25,
        innerHalfWidth: 2.0,
      },
      signature: `${this.graphSignature}:${Math.round(this.anchor.surfaceY * 100)}:collar-v3`,
    };
    const supportLocal = {
      minX: -7.2, maxX: 7.2,
      // Carry the authored terrain-minus-cave throat past the entrance root.
      // The old +10.2m support ended while the generic round passage was still
      // visible from outside, leaving the renderer to choose between a pipe
      // shell and an open view through the hillside.
      minZ: mouth[2] - 5.6, maxZ: mouth[2] + 26.0,
    };
    entranceSpec.supportLocalBounds = supportLocal;
    entranceSpec.boundedCaveAirAtLocal = (localX, localY, localZ) => {
      const along = localZ - mouth[2];
      // The generated entrance passage is an open ray. Bound only its outward
      // end; inward it must remain the same cave field that streamed chunks use.
      return Math.max(
        (this.field.entranceSdf || this.field.sdf)(localX, localY, localZ),
        entranceSpec.cut.minAlong - along,
      );
    };
    entranceSpec.implicitValueAtLocal = (localX, localY, localZ, terrainLocalY) => smoothMinimum(
      entranceSpec.boundedCaveAirAtLocal(localX, localY, localZ),
      terrainLocalY - localY,
      0.72,
    );
    entranceSpec.collarWeightAt = (worldX, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const b = supportLocal;
      if (local.x <= b.minX || local.x >= b.maxX || local.z <= b.minZ || local.z >= b.maxZ) return 0;
      const continuousY = this.world.height(worldX, worldZ) - this.origin.y;
      const caveDistance = entranceSpec.boundedCaveAirAtLocal(local.x, continuousY, local.z);
      const fieldWeight = 1 - smoothstep(0.40, 3.20, caveDistance);
      const edge = Math.min(local.x - b.minX, b.maxX - local.x, local.z - b.minZ, b.maxZ - local.z);
      return fieldWeight * smoothstep(0, 0.85, edge);
    };
    entranceSpec.cutValueAt = (worldX, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const surfaceWorldY = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, entranceSpec)
        ?? this.world.height(worldX, worldZ);
      const surfaceLocalY = surfaceWorldY - this.origin.y;
      return entranceSpec.implicitValueAtLocal(local.x, surfaceLocalY, local.z, surfaceLocalY);
    };
    entranceSpec.solidValueAt = (worldX, worldY, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const surfaceWorldY = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, entranceSpec)
        ?? this.world.height(worldX, worldZ);
      return entranceSpec.implicitValueAtLocal(
        local.x,
        worldY - this.origin.y,
        local.z,
        surfaceWorldY - this.origin.y,
      );
    };
    const supportCorners = [
      [supportLocal.minX, supportLocal.minZ], [supportLocal.maxX, supportLocal.minZ],
      [supportLocal.minX, supportLocal.maxZ], [supportLocal.maxX, supportLocal.maxZ],
    ].map(([localX, localZ]) => this.localToWorldXZ(localX, localZ));
    entranceSpec.worldBounds = {
      minX: Math.min(...supportCorners.map((point) => point.x)),
      maxX: Math.max(...supportCorners.map((point) => point.x)),
      minZ: Math.min(...supportCorners.map((point) => point.z)),
      maxZ: Math.max(...supportCorners.map((point) => point.z)),
    };
    // Measure how far inward the terrain cut actually runs, so the vegetation
    // exclusion corridor covers the whole opening (mouth + the passage beneath
    // the surface) rather than just the aperture. Partial-wall geologies cut a
    // long, sometimes lopsided footprint; scanning it keeps grass and trees
    // from floating over the void without over-clearing intact ground.
    {
      const overlap = entranceSpec.terrainCutOverlap || 0;
      const sideX = entranceSpec.inwardZ, sideZ = -entranceSpec.inwardX;
      let reach = 6;
      for (let along = 2; along <= 32; along += 1.5) {
        let cutHere = false;
        for (let s = -5; s <= 5; s += 1.5) {
          const wx = entranceSpec.x + entranceSpec.inwardX * along + sideX * s;
          const wz = entranceSpec.z + entranceSpec.inwardZ * along + sideZ * s;
          if (entranceSpec.cutValueAt(wx, wz) + overlap < 0.2) { cutHere = true; break; }
        }
        if (cutHere) reach = along;
      }
      entranceSpec.vegetationReach = Math.min(reach + 1.5, 32);
    }
    this.entranceSpec = entranceSpec;
    this.group.position.copy(this.origin);
    this.group.rotation.y = this.anchor.yaw;
    // A bespoke irregular throat renders the first metres; the generic SDF
    // begins only after its visibly cylindrical entrance segment is hidden.
    // Entrance-tagged blocks alone carry this clip, so it can extend beyond
    // the collar and suppress the first generic passage shell until the cave
    // is genuinely behind the hillside. Ordinary/distant blocks are untouched.
    const previewMinZ = mouth[2] + ENTRANCE_HANDOFF_STREAM_START;
    this.material.uniforms.uPreviewMinZ.value = previewMinZ;
    this.material.uniforms.uSurfacePreview.value = 0;
    this.entranceStreamMaterial.uniforms.uPreviewMinZ.value = previewMinZ;
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    const entranceWorld = this.localToWorld(mouth[0], mouth[1], mouth[2]);
    for (const material of [this.material, this.entranceStreamMaterial]) {
      material.uniforms.uEntranceWorldPosition.value.copy(entranceWorld);
    }
    this.applyMaterialPalette();
    this.rebuildHydrology();
    this.rebuildDressing();
    this.configurePlans();
    this.rebuildGraphDebug();
    this.refreshDebugReadout();
  }

  // Streamed blocks share ONE resolution across the whole network, by design.
  // Adaptive aperture detail is provided instead by the fine (~0.33 m) collar
  // mesh at the mouth (rebuildEntranceFacade), which needs no seam agreement
  // with the streamed blocks because they clip their surface behind it.
  // Per-block adaptive resolution is deliberately NOT used: every block is a
  // fixed 16-cell cube, so a different resolution means a different block size
  // and grid, which cannot share faces with its neighbours — it would crack
  // the seams the worker seam-audit guarantees. Silhouette-adaptive detail is
  // likewise declined: being view-dependent it would break the deterministic,
  // cache-keyed streaming and the identical-seed-identical-geometry contract.
  configurePlans() {
    const resolution = Number(this.debug.resolution);
    this.visualCameraField = createCaveVisualFieldSampler(this.field, resolution);
    this.plans = createCaveChunkPlan(this.graph, resolution).map((plan) => ({
      ...plan,
      cacheKey: `${this.graphSignature}:${resolution}:${plan.key}`,
    }));
    this.planByKey = new Map(this.plans.map((plan) => [plan.key, plan]));
    this.lastStreamCell = '';
  }

  refreshDebugReadout() {
    const v = this.graph.validation;
    const fit = this.graph.terrainFit;
    const fitLabel = fit
      ? ` · cover ${fit.minCover.toFixed(1)}m${fit.angleDegrees ? ` · bend ${fit.angleDegrees.toFixed(0)}°` : ''}${fit.drop ? ` · deepen ${fit.drop.toFixed(1)}m` : ''}`
      : '';
    this.debug.anchor = `${this.anchorIndex + 1}/${this.anchorCandidates.length} · ${this.anchor.id} · ${Math.round(this.anchor.x)}, ${Math.round(this.anchor.z)}`;
    this.debug.placement = `${this.anchor.valid ? 'valid' : 'fallback'} · ${this.anchor.biome} · score ${this.anchor.score.toFixed(2)} · slope ${this.anchor.slope.toFixed(2)} · inset ${this.entranceInset.toFixed(1)}m${fitLabel}`;
    this.debug.topology = `${this.graph.geology} · ${this.graph.archetype} · ${v.nodes} nodes · ${v.chambers} chambers · ${v.branches} choices · ${v.loops} loops · ${v.mainLength.toFixed(0)}m route · ${v.verticalRelief.toFixed(1)}m relief · grade ${(v.maxGrade * 100).toFixed(1)}%`;
    this.debug.graph = `${this.graphSignature} · ${this.plans.length} sparse blocks · seed ${this.anchor.seed.toString(16).padStart(8, '0')} · fit ${this.terrainFitMs.toFixed(0)}ms`;
    const hydro = this.hydrology.plan;
    this.debug.hydrology = hydro
      ? `${hydro.streams.length} rills · ${hydro.pools.length} ${hydro.profile.frozen ? 'ice sheets' : 'pools'} · ${hydro.drips.length} drips · ${hydro.waterfalls.length} falls`
      : 'dry';
    this.updateMetrics();
  }

  worldToLocalXZ(worldX, worldZ) {
    const dx = worldX - this.origin.x, dz = worldZ - this.origin.z;
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    return { x: cos * dx - sin * dz, z: sin * dx + cos * dz };
  }

  localToWorldXZ(localX, localZ) {
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    return {
      x: this.origin.x + cos * localX + sin * localZ,
      z: this.origin.z - sin * localX + cos * localZ,
    };
  }

  worldToLocal(worldPosition) {
    const xz = this.worldToLocalXZ(worldPosition.x, worldPosition.z);
    return { x: xz.x, y: worldPosition.y - this.origin.y, z: xz.z };
  }

  disposeHydrology() {
    if (this.hydrology?.mesh) {
      this.group.remove(this.hydrology.mesh);
      this.hydrology.mesh.geometry.dispose();
    }
    if (this.hydrology?.dripMesh) {
      this.group.remove(this.hydrology.dripMesh);
      this.hydrology.dripMesh.geometry.dispose();
    }
    if (this.hydrology?.mistMesh) {
      this.group.remove(this.hydrology.mistMesh);
      this.hydrology.mistMesh.geometry.dispose();
    }
    if (this.hydrology) {
      this.hydrology.mesh = null;
      this.hydrology.dripMesh = null;
      this.hydrology.mistMesh = null;
      this.hydrology.plan = null;
    }
  }

  disposeDressing() {
    for (const key of ['mesh', 'glowMesh']) {
      if (this.dressing?.[key]) {
        this.group.remove(this.dressing[key]);
        this.dressing[key].geometry.dispose();
        this.dressing[key] = null;
      }
    }
    if (this.dressing) this.dressing.plan = null;
  }

  // Interior dressing streams like hydrology: planned once per configured
  // cave, purely visual (no collision), rendered with the SAME cave material
  // as the streamed rock so palette, wet streaks, entrance light and the
  // underground shadow floor all apply to props automatically.
  rebuildDressing() {
    this.disposeDressing();
    // Ceiling-hung dressing must not hang in the open entrance mouth: the same
    // terrain cut that removes the surface roof there would leave stalactites,
    // columns and roots dangling in daylight with no rock above them. Cull any
    // whose local XZ falls inside the cut footprint (cheap bbox reject first).
    const spec = this.entranceSpec;
    let exposedAt = null;
    if (spec && typeof spec.cutValueAt === 'function') {
      const bounds = spec.worldBounds;
      const overlap = spec.terrainCutOverlap || 0;
      exposedAt = (localX, localZ) => {
        const world = this.localToWorldXZ(localX, localZ);
        if (world.x < bounds.minX || world.x > bounds.maxX
          || world.z < bounds.minZ || world.z > bounds.maxZ) return false;
        return spec.cutValueAt(world.x, world.z) + overlap < 0.5;
      };
    }
    const plan = buildCaveDressingPlan(this.graph, this.field, this.hydrology.plan, {
      biome: this.anchor?.biome,
      exposedAt,
    });
    this.dressing.plan = plan;
    const built = buildCaveDressingGeometry(plan, this.field);
    if (built.triangles > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3));
      geometry.setAttribute('aSurface', new THREE.BufferAttribute(built.surfaces, 4, true));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `cave-dressing-${this.graphSignature}`;
      mesh.layers.set(CAVE_RENDER_LAYER);
      mesh.layers.enable(0);
      mesh.visible = this.dressing.enabled;
      this.group.add(mesh);
      this.dressing.mesh = mesh;
    }
    if (built.glowPoints.length) {
      const glowGeometry = new THREE.BufferGeometry();
      const points = built.glowPoints.length / 4;
      const glowPositions = new Float32Array(points * 3);
      const glowStrength = new Float32Array(points);
      for (let i = 0; i < points; i++) {
        glowPositions[i * 3] = built.glowPoints[i * 4];
        glowPositions[i * 3 + 1] = built.glowPoints[i * 4 + 1];
        glowPositions[i * 3 + 2] = built.glowPoints[i * 4 + 2];
        glowStrength[i] = built.glowPoints[i * 4 + 3];
      }
      glowGeometry.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));
      glowGeometry.setAttribute('aGlow', new THREE.BufferAttribute(glowStrength, 1));
      const glowMesh = new THREE.Points(glowGeometry, this.fungiGlowMaterial);
      glowMesh.name = `cave-fungi-glow-${this.graphSignature}`;
      glowMesh.renderOrder = 6;
      glowMesh.layers.set(CAVE_RENDER_LAYER);
      glowMesh.layers.enable(0);
      glowMesh.userData.excludeFromAO = true;
      glowMesh.visible = this.dressing.enabled;
      this.group.add(glowMesh);
      this.dressing.glowMesh = glowMesh;
    }
    this.debug.dressing = `${plan.stalactites.length}↓ ${plan.stalagmites.length}↑ ${plan.columns.length}∥`
      + ` · ${plan.rubble.length} rubble · ${plan.fungi.length} fungi · ${plan.roots.length} roots`;
  }

  setDressingEnabled(value) {
    this.dressing.enabled = !!value;
    if (this.dressing.mesh) this.dressing.mesh.visible = this.dressing.enabled;
    if (this.dressing.glowMesh) this.dressing.glowMesh.visible = this.dressing.enabled;
  }

  rebuildHydrology() {
    this.disposeHydrology();
    const plan = buildCaveHydrologyPlan(this.graph, this.field);
    this.hydrology.plan = plan;
    const profile = plan.profile;
    const uniforms = this.waterMaterial.uniforms;
    uniforms.uWaterColor.value.fromArray(profile.color);
    uniforms.uDeepColor.value.fromArray(profile.deep);
    uniforms.uFrozen.value = profile.frozen ? 1 : 0;
    this.dripMaterial.uniforms.uWaterColor.value.fromArray(profile.color);
    if (plan.streams.length || plan.pools.length || plan.waterfalls.length) {
      const mesh = new THREE.Mesh(buildHydrologyGeometry(plan), this.waterMaterial);
      mesh.name = `cave-hydrology-${this.graphSignature}`;
      mesh.renderOrder = 3;
      mesh.layers.set(CAVE_RENDER_LAYER);
      mesh.layers.enable(0);
      mesh.userData.excludeFromAO = true;
      mesh.visible = this.hydrology.enabled;
      this.group.add(mesh);
      this.hydrology.mesh = mesh;
    }
    if (plan.drips.length) {
      const dripMesh = new THREE.Points(buildDripGeometry(plan), this.dripMaterial);
      dripMesh.name = `cave-drips-${this.graphSignature}`;
      dripMesh.renderOrder = 4;
      dripMesh.layers.set(CAVE_RENDER_LAYER);
      dripMesh.layers.enable(0);
      dripMesh.userData.excludeFromAO = true;
      dripMesh.visible = this.hydrology.enabled;
      this.group.add(dripMesh);
      this.hydrology.dripMesh = dripMesh;
    }
    if (plan.mist.length) {
      const mistMesh = new THREE.Points(buildMistGeometry(plan), this.mistMaterial);
      mistMesh.name = `cave-mist-${this.graphSignature}`;
      mistMesh.renderOrder = 5;
      mistMesh.layers.set(CAVE_RENDER_LAYER);
      mistMesh.layers.enable(0);
      mistMesh.userData.excludeFromAO = true;
      mistMesh.visible = this.hydrology.enabled;
      this.group.add(mistMesh);
      this.hydrology.mistMesh = mistMesh;
    }
  }

  waterProximity(worldPosition) {
    if (!this.active || !this.hydrology.enabled || !this.hydrology.plan) return 0;
    return caveWaterProximity(this.hydrology.plan, this.worldToLocal(worldPosition));
  }

  localToWorld(localX, localY, localZ) {
    const xz = this.localToWorldXZ(localX, localZ);
    return { x: xz.x, y: this.origin.y + localY, z: xz.z };
  }

  disposeEntranceFacade() {
    if (this.entranceFacade) {
      this.group.remove(this.entranceFacade);
      disposeObject(this.entranceFacade);
    }
    this.entranceFacade = null;
    this.entranceMaterial = null;
  }

  disposeEntranceEcology() {
    if (!this.entranceEcology) return;
    this.scene.remove(this.entranceEcology);
    for (const child of this.entranceEcology.children) {
      if (child.name === 'cave-entrance-understory') child.geometry.dispose();
      if (child.name === 'cave-approach-boulders') child.children.forEach((mesh) => mesh.dispose?.());
      child.dispose?.();
    }
    this.entranceEcology = null;
    this.entranceEcologySignature = null;
  }

  // Despite the historical "facade" name, this builds the EXACT terrain collar:
  // a marching-cubes mesh of the shared terrain-minus-cave implicit field at
  // ~0.33 m, rendering the recessed throat that the streamed cave SDF clips
  // away (uPreviewMinZ). It is load-bearing, not a backing plane or a legacy
  // mask — removing it would re-expose the cylindrical SDF entrance as a pipe.
  rebuildEntranceFacade() {
    const startedAt = performance.now();
    this.disposeEntranceFacade();
    const facade = new THREE.Group();
    facade.name = 'implicit-terrain-cave-entrance';
    const mouth = this.graph.entrance.mouth;
    const floor = this.entranceFloorLocal;
    const surfaceHeightCache = new Map();
    const surfaceWorldY = (x, z) => {
      // SDF sampling revisits each x/z column for every y slice. Terrain
      // evaluation is the expensive part, so cache columns to avoid tens of
      // thousands of identical procedural-height calls during this one build.
      const key = `${Math.round(x * 1e8)},${Math.round(z * 1e8)}`;
      const cached = surfaceHeightCache.get(key);
      if (cached !== undefined) return cached;
      const worldXZ = this.localToWorldXZ(x, z);
      const height = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
        ?? this.world.height(worldXZ.x, worldXZ.z);
      surfaceHeightCache.set(key, height);
      return height;
    };
    const terrainLocalY = (x, z) => surfaceWorldY(x, z) - this.origin.y;
    const surfaceColorAt = (x, z) => {
      const worldXZ = this.localToWorldXZ(x, z);
      const h = surfaceWorldY(x, z);
      const e = 0.7;
      const sampleWorld = (sampleX, sampleZ) => this.terrain?.caveSurfaceHeightAt(
        sampleX, sampleZ, this.entranceSpec,
      ) ?? this.world.height(sampleX, sampleZ);
      const dx = sampleWorld(worldXZ.x - e, worldXZ.z) - sampleWorld(worldXZ.x + e, worldXZ.z);
      const dz = sampleWorld(worldXZ.x, worldXZ.z - e) - sampleWorld(worldXZ.x, worldXZ.z + e);
      const length = Math.hypot(dx, e * 2, dz) || 1;
      const climate = this.world.climate(worldXZ.x, worldXZ.z, h);
      const rgb = [0, 0, 0];
      groundColor(this.world, worldXZ.x, worldXZ.z, h, 1 - (e * 2) / length,
        climate.t, climate.m, rgb, dx / length, dz / length);
      const biomeId = this.world.classify(h, 1 - (e * 2) / length, climate.t, climate.m);
      if (biomeId === 'forest' || biomeId === 'taiga' || biomeId === 'jungle') {
        const darken = 1 - 0.34 * this.world.groveFactor(worldXZ.x, worldXZ.z);
        rgb[0] *= darken; rgb[1] *= darken; rgb[2] *= darken;
      }
      return new THREE.Color(rgb[0], rgb[1], rgb[2]);
    };
    const collarExtent = {
      minX: -6.35, maxX: 6.35,
      // Continue beyond the visual fade. Marching-cubes transition volumes are
      // open at their box boundary; keeping that boundary fully transparent
      // prevents its irregular terminal ring from ever entering the image.
      minZ: mouth[2] - 4.9, maxZ: mouth[2] + ENTRANCE_HANDOFF_COLLAR_END,
    };
    let maxTerrain = -Infinity;
    let minWalkableFloor = floor;
    // The first passage is allowed to descend and bend under the hillside.
    // The old collar extended 25m inward in X/Z but retained the mouth's Y
    // minimum, so the descending floor eventually left both the mesh box and
    // its collision scan. Sample the same fitted cave collision field across
    // the whole handoff and carry the collar beneath every reachable floor.
    for (let iz = 0; iz <= 30; iz++) {
      const z = collarExtent.minZ + iz / 30 * (collarExtent.maxZ - collarExtent.minZ);
      for (let ix = 0; ix <= 12; ix++) {
        const x = collarExtent.minX + ix / 12 * (collarExtent.maxX - collarExtent.minX);
        maxTerrain = Math.max(maxTerrain, terrainLocalY(x, z));
        const caveFloor = this.field.floorHeightNear(x, z, floor, 4.0, 14.0);
        if (Number.isFinite(caveFloor)) minWalkableFloor = Math.min(minWalkableFloor, caveFloor);
      }
    }
    // This is the canonical terrain-minus-cave field. The streamed collar is
    // clipped by this same field evaluated on its surface, so their aperture
    // boundary is shared instead of guessed twice with triangle centroids.
    const implicit = (x, y, z) => this.entranceSpec.implicitValueAtLocal(
      x, y, z, terrainLocalY(x, z),
    );
    // Navigation keeps the smoother standing-height profile, but preserves
    // visible wall recesses. This prevents the collision shell from protruding
    // invisibly into an apparently open entrance or chamber threshold.
    const collisionImplicit = (x, y, z) => smoothMinimum(
      Math.max(
        (this.field.entranceSdfNavigable
          || this.field.entranceSdfWalk
          || this.field.sdfNavigable
          || this.field.sdfWalk)(x, y, z),
        this.entranceSpec.cut.minAlong - (z - mouth[2]),
      ),
      terrainLocalY(x, z) - y,
      0.72,
    );
    const implicitBounds = {
      ...collarExtent,
      minY: minWalkableFloor - 1.50, maxY: maxTerrain + 1.0,
    };
    this.entranceImplicitField = implicit;
    this.entranceCollisionField = collisionImplicit;
    this.entranceImplicitBounds = implicitBounds;
    const meshStartedAt = performance.now();
    // Keep full cross-section detail at the lip; the axial cells relax toward
    // ~0.55m in the buried handoff where the silhouette is no longer seen.
    const verticalCells = Math.max(33, Math.ceil((implicitBounds.maxY - implicitBounds.minY) / 0.35));
    const raw = meshImplicitBox(implicit, implicitBounds, { nx: 38, ny: verticalCells, nz: 54 });
    this.entranceMeshMs = performance.now() - meshStartedAt;

    const colors = new Float32Array(raw.positions.length);
    const retainedVertex = new Uint8Array(raw.positions.length / 3);
    const inner = new THREE.Color(0x202923);
    const soil = new THREE.Color(0x514638);
    for (let i = 0; i < raw.positions.length; i += 3) {
      const x = raw.positions[i], y = raw.positions[i + 1], z = raw.positions[i + 2];
      const localCover = Math.max(0, terrainLocalY(x, z) - y);
      const worldXZ = this.localToWorldXZ(x, z);
      // Keep every recessed cave wall/roof plus only the narrow top-surface
      // overlap that participates in the shared collar. This avoids painting a
      // duplicate rectangular terrain patch around the mouth while preserving
      // a watertight overlap at the clipped aperture boundary.
      retainedVertex[i / 3] = localCover > 0.045
        || this.entranceSpec.collarWeightAt(worldXZ.x, worldXZ.z) > 1e-5;
      const blend = clamp01((localCover - 0.65) / 1.85);
      const color = surfaceColorAt(x, z);
      color.lerp(soil, blend * 0.46).lerp(inner, blend * blend * 0.58);
      colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b;
    }
    const retainedIndices = [];
    for (let i = 0; i < raw.indices.length; i += 3) {
      const a = raw.indices[i], b = raw.indices[i + 1], c = raw.indices[i + 2];
      if (retainedVertex[a] || retainedVertex[b] || retainedVertex[c]) retainedIndices.push(a, b, c);
    }
    const IndexArray = raw.indices.constructor;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(raw.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(retainedIndices), 1));
    geometry.computeBoundingSphere();
    const material = createTerrainPatchMaterial();
    const compileTerrainPatch = material.onBeforeCompile;
    const handoffRange = new THREE.Vector2(
      mouth[2] + ENTRANCE_HANDOFF_FADE_START,
      mouth[2] + ENTRANCE_HANDOFF_FADE_END,
    );
    material.onBeforeCompile = (shader, renderer) => {
      compileTerrainPatch.call(material, shader, renderer);
      shader.uniforms.uCollarHandoff = { value: handoffRange };
      shader.vertexShader = 'varying float vCollarLocalZ;\n' + shader.vertexShader.replace(
        'void main() {',
        `void main() {
         vCollarLocalZ = position.z;`,
      );
      shader.fragmentShader = 'varying float vCollarLocalZ;\nuniform vec2 uCollarHandoff;\n'
        + shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
           // The streamed cave is already opaque beneath this band. Fade the
           // fine collar over it instead of letting two mismatched tessellations
           // terminate against one another or z-fight at a single plane.
           float collarOpacity = 1.0 - smoothstep(
             uCollarHandoff.x, uCollarHandoff.y, vCollarLocalZ
           );
           if (collarOpacity <= 0.002) discard;
           gl_FragColor.a *= collarOpacity;`,
        );
    };
    material.customProgramCacheKey = () => 'terrain-cave-patch-handoff-v2';
    material.side = THREE.DoubleSide;
    material.transparent = true;
    // Three.js normally renders transparent DoubleSide materials twice. A
    // single pass avoids compounding the collar opacity where front/back faces
    // overlap inside the throat.
    material.forceSinglePass = true;
    // Opaque cave blocks render first and supply depth/colour below the fade.
    // The collar then composites over them without punching a depth-writing
    // translucent shell through the underlying cave surface.
    material.depthWrite = false;
    material.wireframe = this.debug.wireframe;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'cave-implicit-terrain-fold';
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.layers.enable(0);
    mesh.layers.enable(CAVE_RENDER_LAYER);
    facade.add(mesh);
    this.group.add(facade);
    this.entranceMaterial = material;
    this.entranceFacade = facade;
    this.entranceFacade.visible = this.openingActive;
    this.entranceBuildMs = performance.now() - startedAt;
    this.updateMetrics();
  }

  entranceSurfaceAtLocal(localX, localZ) {
    const worldXZ = this.localToWorldXZ(localX, localZ);
    const fallback = () => {
      const worldY = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
        ?? this.world.height(worldXZ.x, worldXZ.z);
      const e = 0.45;
      const sample = (x, z) => this.terrain?.caveSurfaceHeightAt(x, z, this.entranceSpec)
        ?? this.world.height(x, z);
      const dx = sample(worldXZ.x - e, worldXZ.z) - sample(worldXZ.x + e, worldXZ.z);
      const dz = sample(worldXZ.x, worldXZ.z - e) - sample(worldXZ.x, worldXZ.z + e);
      const normalY = (e * 2) / (Math.hypot(dx, e * 2, dz) || 1);
      const biome = this.world.biomeAt(worldXZ.x, worldXZ.z);
      return { worldY, normalY, biome, worldXZ, cover: 0, source: 'fallback' };
    };
    const field = this.entranceImplicitField;
    const bounds = this.entranceImplicitBounds;
    if (!field || !bounds || localX < bounds.minX || localX > bounds.maxX
      || localZ < bounds.minZ || localZ > bounds.maxZ) return fallback();

    // Most authored entrance vegetation lives on ordinary exterior terrain.
    // A sample just below that terrain tells us immediately whether the cave
    // cut is absent there. Avoiding a 58-step vertical SDF march for those
    // common sites removes tens of thousands of field evaluations from the
    // one-time ecology build; only actual lip/fold sites take the full path.
    const exteriorWorldY = this.terrain?.caveSurfaceHeightAt(
      worldXZ.x, worldXZ.z, this.entranceSpec,
    ) ?? this.world.height(worldXZ.x, worldXZ.z);
    const exteriorLocalY = exteriorWorldY - this.origin.y;
    if (field(localX, exteriorLocalY - 0.055, localZ) >= 0.01) return fallback();

    const steps = 58;
    let previousY = bounds.maxY;
    let previousD = field(localX, previousY, localZ);
    for (let i = 1; i <= steps; i++) {
      const y = bounds.maxY + (bounds.minY - bounds.maxY) * i / steps;
      const d = field(localX, y, localZ);
      if (previousD < 0 && d >= 0) {
        const t = previousD / (previousD - d);
        const localY = previousY + (y - previousY) * t;
        const e = 0.18;
        const nx = -(field(localX + e, localY, localZ) - field(localX - e, localY, localZ));
        const ny = -(field(localX, localY + e, localZ) - field(localX, localY - e, localZ));
        const nz = -(field(localX, localY, localZ + e) - field(localX, localY, localZ - e));
        const length = Math.hypot(nx, ny, nz) || 1;
        const biome = this.world.biomeAt(worldXZ.x, worldXZ.z);
        const exteriorWorldY = this.terrain?.caveSurfaceHeightAt(
          worldXZ.x, worldXZ.z, this.entranceSpec,
        ) ?? this.world.height(worldXZ.x, worldXZ.z);
        const worldY = this.origin.y + localY;
        return {
          worldY,
          normalY: ny / length,
          biome,
          worldXZ,
          cover: Math.max(0, exteriorWorldY - worldY),
          source: 'implicit',
        };
      }
      previousY = y;
      previousD = d;
    }
    return fallback();
  }

  entranceFloorLocalNear(localX, localZ, referenceY = null, maxStep = Infinity, maxDrop = Infinity) {
    return implicitFloorHeightNear(
      this.entranceCollisionField || this.entranceImplicitField,
      this.entranceImplicitBounds,
      localX,
      localZ,
      referenceY,
      maxStep,
      maxDrop,
    );
  }

  entranceBodyFits(localX, localZ, floorY, radius = 0.30, height = 1.72, skin = 0.035) {
    return implicitBodyFits(
      this.entranceCollisionField || this.entranceImplicitField,
      localX,
      localZ,
      floorY,
      radius,
      height,
      skin,
    );
  }

  resolveEntranceHorizontal(fromX, fromZ, toX, toZ, referenceY, options = {}) {
    return resolveImplicitHorizontal(
      this.entranceCollisionField || this.entranceImplicitField,
      this.entranceImplicitBounds,
      fromX,
      fromZ,
      toX,
      toZ,
      referenceY,
      { ...options, cameraField: this.entranceImplicitField },
    );
  }

  rebuildEntranceEcology() {
    this.disposeEntranceEcology();

    const ecology = new THREE.Group();
    ecology.name = 'cave-entrance-ecology';
    const mouth = this.graph.entrance.mouth;
    const rng = mulberry32(caveHash(this.anchor.seed, 0x45434f4c));
    const grassMats = [], grassCols = [];
    const plantMats = [], plantCells = [], plantCols = [];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const pushMatrix = (out, x, y, z, ex, ey, ez, sx, sy, sz) => {
      position.set(x, y, z);
      euler.set(ex, ey, ez);
      quaternion.setFromEuler(euler);
      scale.set(sx, sy, sz);
      matrix.compose(position, quaternion, scale);
      out.push(...matrix.elements);
    };
    const choosePlant = (recipe) => {
      let pick = rng(), cell = recipe.mix[0][0];
      for (const [candidate, weight] of recipe.mix) {
        pick -= weight;
        if (pick <= 0) { cell = candidate; break; }
      }
      return cell;
    };
    const preferredSide = rng() < 0.5 ? -1 : 1;
    const withRadius = (x, z) => ({
      radius: Math.hypot(
        x / this.entranceSpec.width,
        (z - mouth[2] - 0.75) / this.entranceSpec.depth,
      ),
      x, z,
    });
    const candidate = (outer = 1) => {
      let x, z;
      if (rng() < 0.76) {
        const side = rng() < 0.64 ? preferredSide : -preferredSide;
        x = side * (3.15 + rng() * (2.6 + outer * 0.75));
        z = mouth[2] - 3.5 + rng() * (5.6 + outer * 0.9);
      } else {
        const angle = rng() * Math.PI * 2;
        const radius = 0.74 + Math.sqrt(rng()) * (0.42 + outer * 0.22);
        x = Math.cos(angle) * this.entranceSpec.width * radius;
        z = mouth[2] + 0.75 + Math.sin(angle) * this.entranceSpec.depth * radius;
      }
      return withRadius(x, z);
    };
    const foregroundCandidate = () => {
      // Concentrate dressing on the first few metres of approach, but split
      // it around a generous central walking line rather than filling it.
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (2.25 + Math.pow(rng(), 1.35) * 4.9);
      const z = mouth[2] - 8.0 + Math.sqrt(rng()) * 6.35;
      return withRadius(x, z);
    };
    const lipCandidate = () => {
      // This band is intentionally on the smooth entrance apron itself. The
      // earlier scatter began too far down the slope and left the most visible
      // few metres sterile.
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (0.18 + Math.pow(rng(), 0.82) * 4.55);
      const z = mouth[2] - 4.55 + Math.sqrt(rng()) * 4.08;
      return withRadius(x, z);
    };
    const validSite = (local, minNormal = 0.64, routeClearance = 1.9, minRadius = 0.70) => {
      // Taller dressing keeps a readable route; low, non-colliding grass gets
      // a much narrower clearance so the apron no longer reads as sterile.
      if (local.z < mouth[2] + 2.0 && Math.abs(local.x) < routeClearance) return null;
      if (local.radius < minRadius) return null;
      const surface = this.entranceSurfaceAtLocal(local.x, local.z);
      // A top-down implicit query can find the cave floor through the open
      // aperture. That is a valid walkable surface but not an exterior planting
      // site; placing a tuft there reads as floating/clipping vegetation when
      // viewed from outside. Keep dressing on the rim and shallow fold only.
      if (!surface || surface.normalY < minNormal || surface.worldY < 0.5
        || (surface.cover ?? 0) > 1.25) return null;
      const river = this.world.riverAt(surface.worldXZ.x, surface.worldXZ.z);
      if (river.wet && river.depth > 0.05) return null;
      return surface;
    };
    // Short inner-verge grass hides small surface seams; taller outer tufts
    // merge the authored entrance back into the world's existing grass field.
    for (let i = 0; i < 790; i++) {
      const onLip = i >= 500;
      const local = i < 290 ? candidate(i > 205 ? 1.35 : 0.55)
        : i < 500 ? foregroundCandidate() : lipCandidate();
      const site = validSite(local, onLip ? 0.42 : 0.61, onLip ? 0.16 : 1.9, onLip ? 0.12 : 0.70);
      if (!site) continue;
      const baseDensity = GRASS_DENSITY[site.biome.id] || 0;
      if (rng() > (onLip ? Math.max(0.76, baseDensity) : baseDensity)) continue;
      const color = GRASS_COLORS[site.biome.id];
      if (!color) continue;
      const inner = Math.max(0, Math.min(1, (local.radius - 0.72) / 0.52));
      const s = onLip ? 0.28 + rng() * 0.28 : 0.30 + rng() * 0.31 + inner * 0.20;
      const height = onLip ? s * (0.52 + rng() * 0.42) : s * (0.48 + rng() * 0.48 + inner * 0.30);
      pushMatrix(grassMats, site.worldXZ.x, site.worldY - 0.070, site.worldXZ.z,
        (rng() - 0.5) * 0.20, rng() * Math.PI * 2, (rng() - 0.5) * 0.20,
        s, height, s);
      const value = 0.64 + rng() * 0.30;
      grassCols.push(color[0] * value, color[1] * value, color[2] * value);
    }

    // Biome recipes own the species choice: ferns and horsetails in damp
    // forests, flowers in meadow biomes, sparse dry plants in exposed sites.
    let saplings = 0, flowers = 0, lipFlowers = 0;
    const flowerCells = new Set([1, 2, 8, 9, 10, 11]);
    for (let i = 0; i < 246; i++) {
      const onLip = i >= 158;
      const local = i < 92 ? candidate(i > 64 ? 1.45 : 0.65)
        : i < 158 ? foregroundCandidate() : lipCandidate();
      const site = validSite(local, onLip ? 0.48 : 0.68, onLip ? 0.72 : 1.9, onLip ? 0.16 : 0.70);
      if (!site) continue;
      const recipe = UNDERSTORY_RECIPES[site.biome.id];
      const density = onLip ? Math.max(0.54, recipe?.density || 0) : Math.min(0.82, (recipe?.density || 0) * 1.12);
      if (!recipe || rng() > density) continue;
      const cell = choosePlant(recipe);
      if (cell === 4) {
        if (saplings >= 2 || local.radius < 1.02 || local.z < mouth[2] + 0.4) continue;
        saplings++;
      }
      if (flowerCells.has(cell)) {
        if (flowers >= 18 || (onLip && lipFlowers >= 6) || local.z > mouth[2] + 1.0) continue;
        flowers++;
        if (onLip) lipFlowers++;
      }
      const range = UNDERSTORY_SCALE[cell];
      const s = (range[0] + rng() * (range[1] - range[0]))
        * (onLip ? 0.48 + rng() * 0.20 : 0.68 + rng() * 0.24);
      pushMatrix(plantMats, site.worldXZ.x, site.worldY - 0.060, site.worldXZ.z,
        (rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08,
        s, s * (0.88 + rng() * 0.24), s);
      plantCells.push(cell);
      const value = 0.84 + rng() * 0.27;
      plantCols.push(value * (0.96 + rng() * 0.07), value, value * (0.93 + rng() * 0.10));
    }

    // A few small, half-buried rocks sit down the approach rather than on the
    // aperture. They help the planted foreground feel established without
    // being asked to conceal the actual terrain seam or narrowing the route.
    const boulderBuckets = new Map();
    if (this.library?.boulder?.length) {
      const boulderSites = [
        [-3.35, -5.8], [4.15, -5.0], [-5.45, -2.85],
      ];
      const tint = [1, 1, 1];
      for (let i = 0; i < boulderSites.length; i++) {
        const [baseX, dz] = boulderSites[i];
        const local = withRadius(
          baseX + (rng() - 0.5) * 0.65,
          mouth[2] + dz + (rng() - 0.5) * 0.6,
        );
        const site = validSite(local, 0.48);
        if (!site) continue;
        const variant = caveHash(this.anchor.seed, i, 0x4150524f) % this.library.boulder.length;
        if (!boulderBuckets.has(variant)) boulderBuckets.set(variant, { mats: [], colors: [] });
        const bucket = boulderBuckets.get(variant);
        const s = 0.46 + rng() * 0.34;
        pushMatrix(bucket.mats, site.worldXZ.x, site.worldY - s * (0.28 + rng() * 0.12), site.worldXZ.z,
          (rng() - 0.5) * 0.20, rng() * Math.PI * 2, (rng() - 0.5) * 0.20,
          s * (0.88 + rng() * 0.22), s * (0.72 + rng() * 0.25), s * (0.88 + rng() * 0.22));
        rockTint(site.biome.id, rng, tint);
        bucket.colors.push(tint[0], tint[1], tint[2]);
      }
    }

    if (grassMats.length) {
      const grass = buildGrassMesh({
        matrices: new Float32Array(grassMats),
        colors: new Float32Array(grassCols),
      }, { caveDressing: true });
      grass.name = 'cave-entrance-grass';
      ecology.add(grass);
    }
    if (plantMats.length) {
      const plants = buildUnderstoryMesh({
        matrices: new Float32Array(plantMats),
        cells: new Float32Array(plantCells),
        colors: new Float32Array(plantCols),
      }, { caveDressing: true });
      plants.name = 'cave-entrance-understory';
      ecology.add(plants);
    }
    if (boulderBuckets.size) {
      const buckets = [...boulderBuckets.entries()].map(([variant, bucket]) => ({
        type: 'boulder', variant,
        matrices: new Float32Array(bucket.mats),
        colors: new Float32Array(bucket.colors),
      }));
      const boulders = buildScatterGroup(this.library, buckets, { shadows: true, caveDressing: true });
      boulders.name = 'cave-approach-boulders';
      ecology.add(boulders);
    }
    ecology.visible = this.openingActive;
    this.scene.add(ecology);
    this.entranceEcology = ecology;
    this.entranceEcologySignature = this.entranceTerrainSignature;
  }

  rebuildGraphDebug() {
    if (this.graphDebug) {
      this.group.remove(this.graphDebug);
      disposeObject(this.graphDebug);
    }
    const debugGroup = new THREE.Group();
    const nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const linePositions = [];
    for (const edge of this.graph.edges) linePositions.push(...nodeById.get(edge.a).p, ...nodeById.get(edge.b).p);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
      color: 0x63e6ff, transparent: true, opacity: 0.9, depthTest: false,
    }));
    lines.layers.set(CAVE_RENDER_LAYER); lines.renderOrder = 20; debugGroup.add(lines);
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(this.graph.nodes.flatMap((node) => node.p), 3));
    const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({
      color: 0xffd36b, size: 0.48, sizeAttenuation: true, depthTest: false,
    }));
    points.layers.set(CAVE_RENDER_LAYER); points.renderOrder = 21; debugGroup.add(points);
    debugGroup.visible = this.debug?.showGraph ?? false;
    this.group.add(debugGroup);
    this.graphDebug = debugGroup;
  }

  // The V4 region the player currently occupies: nearest region AABB in cave-
  // local space (zero distance inside a box; ties break on the lower id).
  currentRegionAt(localX, localY, localZ) {
    const regions = this.graph?.regions;
    if (!Array.isArray(regions) || !regions.length) return null;
    let best = null, bestDistance = Infinity;
    for (const region of regions) {
      const b = region.bounds;
      if (!b) continue;
      const dx = Math.max(b.minX - localX, 0, localX - b.maxX);
      const dy = Math.max(b.minY - localY, 0, localY - b.maxY);
      const dz = Math.max(b.minZ - localZ, 0, localZ - b.maxZ);
      const distance = Math.hypot(dx, dy, dz);
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && best && region.id < best.id)) {
        bestDistance = distance;
        best = region;
      }
    }
    return best;
  }

  desiredPlansAtPlayer() {
    const p = this.controls.rig.position;
    const localXZ = this.worldToLocalXZ(p.x, p.z);
    const localY = p.y - this.origin.y;
    const { ix, iy, iz } = caveChunkCoordinatesAt(
      Number(this.debug.resolution), localXZ.x, localY, localXZ.z,
    );
    // Caves in the current grammar are compact sparse networks (typically
    // 30–55 blocks). Keeping the complete planned shell resident costs only a
    // few MB and prevents a much more damaging failure: analytic collision can
    // continue through an unloaded render block, exposing white sky, surface
    // grass, or an apparent wall hole at the end/side of a long sightline.
    const current = this.currentRegionAt(localXZ.x, localY, localXZ.z);
    this.regionDebug = `${current ? current.id : '—'} · whole cave`;
    const cellKey = `${ix}_${iy}_${iz}:${current ? current.id : 'none'}`;
    const plans = [...this.plans]
      .sort((a, b) => ((a.ix - ix) ** 2 + (a.iy - iy) ** 2 + (a.iz - iz) ** 2)
        - ((b.ix - ix) ** 2 + (b.iy - iy) ** 2 + (b.iz - iz) ** 2));
    return { cellKey, plans };
  }

  updateStreaming(force = false) {
    if (!this.active) return;
    const { cellKey, plans } = this.desiredPlansAtPlayer();
    if (!force && cellKey === this.lastStreamCell) return;
    this.lastStreamCell = cellKey;
    this.desiredKeys = new Set(plans.map((plan) => plan.cacheKey));
    // Movement changes are allowed to overtake background audits. Old graph
    // jobs can never become useful after an anchor/rebuild epoch changes.
    this.jobQueue = this.jobQueue.filter((job) => job.epoch === this.generationEpoch);
    this.queuedKeys = new Set(this.jobQueue.map((job) => job.cacheKey));
    for (const cacheKey of [...this.attachedKeys]) {
      if (!this.desiredKeys.has(cacheKey)) this.detachEntry(cacheKey);
    }
    this.enqueuePlans(plans, 0);
    for (const plan of plans) {
      const entry = this.chunkCache.get(plan.cacheKey);
      if (entry) this.queueAttachment(entry);
    }
    this.pumpWorkers();
    this.metricsDirty = true;
  }

  enqueuePlans(plans, priorityBase = 0) {
    plans.forEach((plan, index) => {
      if (this.chunkCache.has(plan.cacheKey) || this.pendingKeys.has(plan.cacheKey) || this.queuedKeys.has(plan.cacheKey)) return;
      this.queuedKeys.add(plan.cacheKey);
      this.jobQueue.push({
        plan, cacheKey: plan.cacheKey, graphHash: this.graphSignature,
        graph: this.graph, epoch: this.generationEpoch,
        resolution: Number(this.debug.resolution),
        priority: priorityBase + index,
      });
    });
    this.jobQueue.sort((a, b) => a.priority - b.priority);
  }

  pumpWorkers() {
    // Walking away from a discovered cave must stop its background population.
    // At most the already-running request on each worker is allowed to finish.
    if (!this.active && !this.auditPending) return;
    // Backpressure: transferred geometry waiting for main-thread admission is
    // still memory. Do not let fast workers build an unbounded queue behind the
    // one-block-per-frame renderer budget.
    if (this.completedResults.length >= Math.max(2, this.workers.length)) return;
    for (const slot of this.workers) {
      if (slot.busy || this.jobQueue.length === 0) continue;
      const job = this.jobQueue.shift();
      this.queuedKeys.delete(job.cacheKey);
      if (this.chunkCache.has(job.cacheKey) || this.pendingKeys.has(job.cacheKey)) continue;
      const requestId = this.nextRequestId++;
      slot.busy = true; slot.requestId = requestId;
      this.pendingKeys.set(job.cacheKey, requestId);
      this.requestById.set(requestId, job);
      const includeGraph = slot.initializedGraphHash !== job.graphHash;
      slot.worker.postMessage({
        type: 'mesh', requestId, cacheKey: job.cacheKey,
        graphHash: job.graphHash,
        // A worker retains a verified field by content hash. Sending the graph
        // only once per slot avoids repeatedly structured-cloning the complete
        // network on the main thread for every 16-cell block.
        ...(includeGraph ? { graph: job.graph } : {}),
        epoch: job.epoch,
        resolution: job.resolution, plan: job.plan,
        // Positional coordinates remain for compatibility with an old worker
        // during hot reload; the signed explicit plan is authoritative.
        ix: job.plan.ix, iy: job.plan.iy, iz: job.plan.iz,
      });
      if (includeGraph) slot.initializedGraphHash = job.graphHash;
    }
  }

  onWorkerMessage(slot, result) {
    slot.busy = false;
    slot.requestId = 0;
    const job = this.requestById.get(result.requestId);
    this.requestById.delete(result.requestId);
    if (job) this.pendingKeys.delete(job.cacheKey);
    if (!job) { this.pumpWorkers(); return; }
    const staleEpoch = job.epoch !== this.generationEpoch
      || job.graphHash !== this.graphSignature
      || result.epoch !== job.epoch;
    if (staleEpoch) { this.pumpWorkers(); return; }
    if (result.graphHash !== job.graphHash) {
      slot.initializedGraphHash = null;
      this.workerErrors++;
      this.debug.state = `worker graph verification failed · ${result.actualGraphHash || 'no hash'}`;
      this.metricsDirty = true;
      this.pumpWorkers();
      return;
    }
    if (result.type === 'mesh-error') {
      slot.initializedGraphHash = null;
      this.workerErrors++;
      this.debug.state = `worker mesh error · ${result.message}`;
      this.metricsDirty = true;
      this.pumpWorkers();
      return;
    }

    // Do not finish populating a cave after the player has walked away. The
    // transferred arrays are simply released; reactivation can request the
    // missing block again. Audits are the sole intentional background client.
    if (!this.active && !this.auditPending) {
      this.metricsDirty = true;
      this.pumpWorkers();
      return;
    }

    // Keep the worker hot, but defer BufferGeometry creation and scene changes
    // to update(), where the renderer can enforce a per-frame admission budget.
    this.completedResults.push({ job, result });
    this.metricsDirty = true;
    this.pumpWorkers();
  }

  assembleWorkerResult(job, result) {
    const staleEpoch = job.epoch !== this.generationEpoch
      || job.graphHash !== this.graphSignature
      || result.epoch !== job.epoch;
    if (staleEpoch || this.chunkCache.has(job.cacheKey)) return false;

    let mesh = null;
    if (result.positions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
      if (result.surfaces?.length) {
        // Phase-A semantics: [wet, sediment, mineral, fracture], normalized
        geometry.setAttribute('aSurface', new THREE.BufferAttribute(result.surfaces, 4, true));
      }
      // The signed plan bounds conservatively contain every generated vertex,
      // so use their sphere directly instead of rescanning a large position
      // buffer on the main thread.
      const bounds = result.bounds || job.plan.bounds;
      const center = new THREE.Vector3(
        (bounds.minX + bounds.maxX) * 0.5,
        (bounds.minY + bounds.maxY) * 0.5,
        (bounds.minZ + bounds.maxZ) * 0.5,
      );
      geometry.boundingSphere = new THREE.Sphere(center, 0.5 * Math.hypot(
        bounds.maxX - bounds.minX,
        bounds.maxY - bounds.minY,
        bounds.maxZ - bounds.minZ,
      ));
      // The terrain-minus-cave collar replaces the generic rounded portal in
      // entrance blocks. Those blocks use the full handoff-depth clip that
      // produced the approved natural mouth; ordinary blocks never clip by Z,
      // so distant passages that curve back toward the entrance stay intact.
      mesh = new THREE.Mesh(
        geometry,
        job.plan.entrance ? this.entranceStreamMaterial : this.material,
      );
      mesh.name = `cave-block-${result.key}`;
      mesh.layers.set(CAVE_RENDER_LAYER);
      // Surface and cave coexist at the threshold. The preview clipping in the
      // cave material hides the exterior half of the open SDF tube, leaving
      // the real streamed interior visible through the terrain aperture.
      mesh.layers.enable(0);
    }
    const entry = {
      cacheKey: job.cacheKey, graphHash: job.graphHash,
      resolution: job.resolution, key: result.key,
      entrance: !!job.plan.entrance,
      ix: result.ix, iy: result.iy, iz: result.iz,
      bounds: result.bounds || job.plan.bounds,
      mesh, triangles: result.triangles, bytes: result.bytes,
      generationMs: result.generationMs, faceHashes: result.faceHashes,
      audit: result.audit, lastUsed: performance.now(),
    };
    this.chunkCache.set(job.cacheKey, entry);
    if (job.graphHash === this.graphSignature && job.resolution === Number(this.debug.resolution) && this.desiredKeys.has(job.cacheKey)) {
      this.queueAttachment(entry);
    }
    this.metricsDirty = true;
    return true;
  }

  drainWorkerResults(limit = CAVE_COMPLETIONS_PER_FRAME) {
    if (!this.active && !this.auditPending) {
      this.completedResults.length = 0;
      return;
    }
    let assembled = 0;
    while (assembled < limit && this.completedResults.length) {
      const completion = this.completedResults.shift();
      if (this.assembleWorkerResult(completion.job, completion.result)) assembled++;
    }
    if (!assembled) return;
    this.evictCache();
    if (this.auditPending && this.auditPending.graphHash === this.graphSignature
      && this.allCurrentPlansCached()) this.finishAudit();
  }

  queueAttachment(entry) {
    if (this.attachedKeys.has(entry.cacheKey) || this.queuedAttachments.has(entry.cacheKey)) return;
    this.queuedAttachments.add(entry.cacheKey);
    this.attachmentQueue.push(entry.cacheKey);
  }

  drainAttachments(limit = CAVE_ATTACHMENTS_PER_FRAME) {
    let attached = 0;
    while (attached < limit && this.attachmentQueue.length) {
      const cacheKey = this.attachmentQueue.shift();
      this.queuedAttachments.delete(cacheKey);
      if (!this.active || !this.desiredKeys.has(cacheKey)) continue;
      const entry = this.chunkCache.get(cacheKey);
      if (!entry) continue;
      this.attachEntry(entry);
      attached++;
    }
    if (attached) {
      this.metricsDirty = true;
    }
  }

  attachEntry(entry) {
    entry.lastUsed = performance.now();
    if (this.attachedKeys.has(entry.cacheKey)) return;
    if (entry.mesh) this.group.add(entry.mesh);
    this.attachedKeys.add(entry.cacheKey);
  }

  detachEntry(cacheKey) {
    const entry = this.chunkCache.get(cacheKey);
    if (entry?.mesh) this.group.remove(entry.mesh);
    this.attachedKeys.delete(cacheKey);
    this.queuedAttachments.delete(cacheKey);
  }

  detachAll() {
    for (const cacheKey of [...this.attachedKeys]) this.detachEntry(cacheKey);
    this.desiredKeys.clear();
    this.attachmentQueue.length = 0;
    this.queuedAttachments.clear();
    this.lastStreamCell = '';
    this.metricsDirty = true;
  }

  evictCache() {
    const limit = this.auditPending?.graphHash === this.graphSignature
      ? Math.max(CACHE_LIMIT, this.plans.length)
      : CACHE_LIMIT;
    if (this.chunkCache.size <= limit) return;
    const candidates = [...this.chunkCache.values()]
      .filter((entry) => !this.attachedKeys.has(entry.cacheKey) && !this.desiredKeys.has(entry.cacheKey))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.chunkCache.size > limit && candidates.length) {
      const entry = candidates.shift();
      entry.mesh?.geometry.dispose();
      this.chunkCache.delete(entry.cacheKey);
    }
  }

  currentEntries() {
    const prefix = `${this.graphSignature}:${Number(this.debug.resolution)}:`;
    return [...this.chunkCache.values()].filter((entry) => entry.cacheKey.startsWith(prefix));
  }

  updateMetrics() {
    const entries = this.currentEntries();
    const triangles = entries.reduce((sum, entry) => sum + entry.triangles, 0);
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const workerMs = entries.reduce((sum, entry) => sum + entry.generationMs, 0);
    const prefix = `${this.graphSignature}:${Number(this.debug.resolution)}:`;
    const currentPending = [...this.pendingKeys.keys()].filter((key) => key.startsWith(prefix)).length;
    const currentCompleted = this.completedResults.filter(({ job }) => job.cacheKey.startsWith(prefix)).length;
    const currentQueued = this.jobQueue.filter((job) => job.cacheKey.startsWith(prefix)).length;
    const currentAttaching = this.attachmentQueue.filter((key) => key.startsWith(prefix)).length;
    const attachedSurface = [...this.attachedKeys].filter((key) => this.chunkCache.get(key)?.mesh).length;
    const cacheLimit = this.auditPending?.graphHash === this.graphSignature
      ? Math.max(CACHE_LIMIT, this.plans.length)
      : CACHE_LIMIT;
    const regionLabel = this.regionDebug ? ` · region ${this.regionDebug}` : '';
    this.debug.streaming = `${this.attachedKeys.size}/${this.desiredKeys.size} ready · ${attachedSurface} surfaces · ${currentPending} worker + ${currentCompleted} frame + ${currentQueued} queued + ${currentAttaching} attach · ${this.chunkCache.size}/${cacheLimit} LRU${regionLabel}`;
    const entranceTiming = this.entranceBuildMs > 0
      ? ` · lip ${this.entranceBuildMs.toFixed(0)} ms (${this.entranceMeshMs.toFixed(0)} mesh)`
      : '';
    this.debug.metrics = `${entries.length}/${this.plans.length} blocks · ${triangles.toLocaleString()} tris · ${(bytes / 1048576).toFixed(2)} MB · ${workerMs.toFixed(0)} ms worker${entranceTiming}`;
    if (this.active && currentPending === 0 && currentCompleted === 0
      && currentQueued === 0 && currentAttaching === 0) {
      this.debug.state = this.inside ? 'inside — collision active' : 'approach — entrance ready';
    }
    this.metricsDirty = false;
  }

  entranceReady() {
    // Do not open the terrain aperture onto a partially rendered network. The
    // complete sparse cave is small enough to prepare as one visual contract.
    return this.plans.length > 0 && this.plans.every((plan) =>
      this.chunkCache.has(plan.cacheKey) && this.attachedKeys.has(plan.cacheKey));
  }

  interiorReadyAt(local) {
    const coordinates = caveChunkCoordinatesAt(
      Number(this.debug.resolution), local.x, local.y, local.z,
    );
    const plan = this.planByKey.get(caveChunkKey(coordinates.ix, coordinates.iy, coordinates.iz));
    // A location outside every conservative primitive AABB is solid rock, so
    // the analytic collider may reject it without waiting for render geometry.
    return !plan || this.chunkCache.has(plan.cacheKey);
  }

  entranceThroatEngagedAt(local, engageDistance = 0.18) {
    return entranceThroatEngaged(
      this.entranceSpec?.boundedCaveAirAtLocal,
      local,
      { engageDistance },
    );
  }

  outdoorSurfaceLocalY(localX, localZ) {
    const worldXZ = this.localToWorldXZ(localX, localZ);
    const worldY = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
      ?? this.world.height(worldXZ.x, worldXZ.z);
    return worldY - this.origin.y;
  }

  recoverOutdoorStateIfNeeded(local, throatEngaged = this.entranceThroatEngagedAt(local)) {
    if (!entranceShouldRecoverOutdoor(
      this.inside,
      throatEngaged,
      local.y,
      this.outdoorSurfaceLocalY(local.x, local.z),
    )) return false;
    this.setInside(false);
    return true;
  }

  entranceFloorHeightWorld(worldX, worldZ) {
    const local = this.worldToLocalXZ(worldX, worldZ);
    const outdoor = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, this.entranceSpec)
      ?? this.world.height(worldX, worldZ);
    const referenceLocalY = this.controls.rig.position.y - this.origin.y;
    // Roof and side approaches stay ordinary terrain. Previously every X/Z
    // point inside the collar footprint searched the implicit entrance for a
    // floor, so a walker above the aperture could snap toward a buried floor
    // or freeze when no crossing was close enough.
    if (!this.inside && !this.entranceThroatEngagedAt({
      x: local.x, y: referenceLocalY, z: local.z,
    })) return outdoor;
    const mouthZ = this.graph.entrance.mouth[2];
    const useTerrainSeam = entrancePortalNear(this.entranceImplicitBounds, local, {
      xMargin: 0,
      zMargin: 0,
    })
      && (!this.inside || local.z <= mouthZ + 4.0);
    if (useTerrainSeam) {
      const entranceFloor = this.entranceFloorLocalNear(
        local.x, local.z, referenceLocalY, 0.70, 1.45,
      );
      if (entranceFloor !== null) return this.origin.y + entranceFloor;
    }
    if (!this.inside) return outdoor;
    const caveFloor = this.field.floorHeightNear(local.x, local.z, referenceLocalY, 0.65, 1.4);
    if (caveFloor === null) return this.inside ? this.controls.rig.position.y : outdoor;
    return this.origin.y + caveFloor;
  }

  resolveMovement(position, previous) {
    const from = this.worldToLocal({ x: previous.x, y: previous.y, z: previous.z });
    const target = this.worldToLocal(position);
    const cachedFloor = this.collisionFloorLocal;
    const collisionReferenceY = cachedFloor
      && Math.hypot(from.x - cachedFloor.x, from.z - cachedFloor.z) < 0.75
      ? cachedFloor.y
      : from.y;
    const mouthZ = this.graph.entrance.mouth[2];
    const entranceBounds = this.entranceImplicitBounds;
    // X/Z proximity is insufficient: the same footprint includes the hillside
    // above the mouth and its side banks. Sample the cave-only throat at torso
    // height so outdoor air over the roof cannot opt into cave collision.
    const fromThroat = this.entranceThroatEngagedAt(from, 0.22);
    const targetThroat = this.entranceThroatEngagedAt(target, 0.22);
    if (this.recoverOutdoorStateIfNeeded(from, fromThroat)) {
      this.collisionFloorLocal = null;
      return {
        acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z),
        blocked: false,
        recoveredOutdoor: true,
      };
    }
    const transition = entranceTransitionState(entranceBounds, this.inside, from, target, {
      fromThroat, targetThroat,
    });
    // While still outdoors, terrain collision remains authoritative everywhere
    // outside the compact transition volume. Without this guard, the buried
    // cave SDF could incorrectly block someone simply walking over/around it.
    if (transition.outdoorAuthoritative) {
      this.collisionFloorLocal = null;
      return { acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z), blocked: false };
    }
    // Do not let the analytic collider lead the player into geometry that has
    // not arrived yet. The barrier disappears as soon as every throat block is
    // cached, normally before the player reaches the arch.
    if (transition.active && !this.entranceReady() && target.z > mouthZ - 0.5) {
      position.x = previous.x; position.z = previous.z;
      return { acceptedDistance: 0, blocked: true };
    }
    if (this.inside && !this.interiorReadyAt(target)) {
      position.x = previous.x; position.z = previous.z;
      this.updateStreaming(true);
      return { acceptedDistance: 0, blocked: true, streaming: true };
    }
    const collisionOptions = {
      maxSubstep: 0.20, radius: CAVE_PLAYER_RADIUS, height: CAVE_PLAYER_HEIGHT,
      crouchHeight: CAVE_PLAYER_CROUCH_HEIGHT,
      cameraField: this.visualCameraField,
      skin: CAVE_PLAYER_SKIN, maxStep: 0.50, maxDrop: 1.05,
    };
    // The terrain-minus-cave collider is only needed across the actual portal.
    // The collar remains visually authored for 25m, but once safely inside we
    // use the cave's calmer collision SDF instead of carrying render-detail
    // noise deep into the route. On exit, crossing back into this band restores
    // the exact terrain seam before the portal state changes.
    const movementNearPortal = entrancePortalNear(entranceBounds, from)
      || entrancePortalNear(entranceBounds, target);
    const useTerrainSeam = movementNearPortal && transition.active && (!this.inside
      || Math.min(from.z, target.z) <= mouthZ + 4.0);
    const resolved = useTerrainSeam
      ? this.resolveEntranceHorizontal(from.x, from.z, target.x, target.z, collisionReferenceY, collisionOptions)
      : this.field.resolveHorizontal(from.x, from.z, target.x, target.z, collisionReferenceY, collisionOptions);
    const colliderLabel = useTerrainSeam ? 'portal' : 'interior';
    const worldXZ = this.localToWorldXZ(resolved.x, resolved.z);
    position.x = worldXZ.x;
    position.z = worldXZ.z;
    if (Number.isFinite(resolved.floorY)) {
      this.collisionFloorLocal = { x: resolved.x, z: resolved.z, y: resolved.floorY };
      // Let controls ground against the exact floor branch collision accepted
      // this frame. Re-querying the SDF at a converging shelf could select the
      // other crossing and strand the next frame between two valid surfaces.
      resolved.floorHeight = this.origin.y + resolved.floorY;
    }
    // PlayerControls eases back to standing in open space, but ducks
    // immediately when the resolver reports low headroom so the rendered eye
    // never clips through the same keyhole ceiling we just accepted.
    resolved.eyeHeight = Math.max(1.05, Math.min(1.70,
      (resolved.stanceHeight ?? CAVE_PLAYER_HEIGHT) - 0.02));
    const requested = Math.hypot(target.x - from.x, target.z - from.z);
    if (resolved.crouched) {
      const assist = resolved.forgiving ? ' + route assist' : '';
      this.debug.collision = `${colliderLabel} · ducking ${resolved.stanceHeight.toFixed(2)}m${assist} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (resolved.recovered || resolved.forgiving) {
      this.debug.collision = `${colliderLabel} · ${resolved.recovered ? 'recovered' : 'route assist'} · ${resolved.blockReason || 'clear'} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (resolved.blocked && requested > 1e-4) {
      const stuck = resolved.acceptedDistance < Math.min(0.01, requested * 0.1);
      this.debug.collision = `${colliderLabel} · ${stuck ? 'STUCK' : 'contact'} · ${resolved.blockReason || 'body'} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (requested > 1e-4) {
      // Keep the last contact visible after the player releases a movement
      // key.  Clearing this every idle frame made the useful STUCK location
      // disappear before it could be read from the debug panel.
      this.debug.collision = `${colliderLabel} · clear`;
    }
    return resolved;
  }

  setInside(value) {
    const inside = !!value;
    if (inside === this.inside) return;
    this.inside = inside;
    // A real hole allows ordinary depth to resolve both worlds. Keeping the
    // surface layer enabled means the player can look back out naturally.
    this.controls.camera.layers.enable(0);
    this.controls.camera.layers.enable(CAVE_RENDER_LAYER);
    // Keep the analytic entrance tube hidden in both directions; the custom
    // throat is the visible surface all the way to the first chamber.
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.debug.state = inside ? 'inside — collision active' : 'approach — surface transition';
  }

  updatePortalTransition() {
    if (!this.active) return;
    const local = this.worldToLocal(this.controls.rig.position);
    const mouthZ = this.graph.entrance.mouth[2];
    const bounds = this.entranceImplicitBounds;
    // A terrain-fitted long cave may bend back across the mouth's local Z
    // plane while remaining tens of metres sideways and deep underground.
    // Portal state is meaningful only inside the compact entrance envelope.
    if (bounds && !entrancePortalNear(bounds, local)) return;
    const throatEngaged = this.entranceThroatEngagedAt(local, 0.04);
    // Correct any stale/misclassified state before asking the Z-plane
    // hysteresis to update it. This is the actual escape hatch for a player
    // already stranded on the roof or side by an earlier portal flip.
    if (this.recoverOutdoorStateIfNeeded(local, throatEngaged)) return;
    // Entering requires real overlap with the cave throat. Exiting remains
    // available to an existing interior occupant throughout the portal band.
    if (!this.inside && !throatEngaged) return;
    this.setInside(cavePortalInside(this.inside, local.z, mouthZ, this.entranceReady()));
  }

  allCurrentPlansCached() {
    return this.plans.every((plan) => this.chunkCache.has(plan.cacheKey));
  }

  audit(checkDeterminism = false) {
    this.auditPending = { graphHash: this.graphSignature, checkDeterminism };
    if (!this.allCurrentPlansCached()) {
      this.debug.auditResult = `loading ${this.plans.length - this.currentEntries().length} blocks for seam audit…`;
      this.enqueuePlans(this.plans, 10000);
      this.pumpWorkers();
      return { pending: true };
    }
    return this.finishAudit();
  }

  finishAudit() {
    const entries = new Map(this.currentEntries().map((entry) => [entry.key, entry]));
    let seamPairs = 0, seamMismatches = 0, finite = true, errorSum = 0, errorSamples = 0;
    for (const plan of this.plans) {
      const entry = entries.get(plan.key);
      if (!entry) continue;
      finite = finite && entry.audit.finite;
      errorSum += entry.audit.meanSurfaceError * entry.audit.samples;
      errorSamples += entry.audit.samples;
      for (const [dx, dy, dz, face, opposite] of [
        [1, 0, 0, 'xmax', 'xmin'], [0, 1, 0, 'ymax', 'ymin'], [0, 0, 1, 'zmax', 'zmin'],
      ]) {
        const neighbor = entries.get(caveChunkKey(plan.ix + dx, plan.iy + dy, plan.iz + dz));
        if (!neighbor) continue;
        seamPairs++;
        if (entry.faceHashes[face] !== neighbor.faceHashes[opposite]) seamMismatches++;
      }
    }
    const meanError = errorSamples ? errorSum / errorSamples : 0;
    const deterministic = !this.auditPending?.checkDeterminism || this.field.hashField(24) === this.fieldBaseline;
    const passed = this.graph.validation.valid && finite && seamMismatches === 0 && meanError < 0.05 && deterministic && this.workerErrors === 0;
    const report = { passed, seamPairs, seamMismatches, finite, meanError, deterministic, graphValid: this.graph.validation.valid };
    this.debug.auditResult = `${passed ? 'PASS' : 'FAIL'} · ${seamPairs} seams/${seamMismatches} mismatches · error ${meanError.toFixed(3)}m${deterministic ? ' · deterministic' : ''}`;
    this.auditPending = null;
    return report;
  }

  rebuild() {
    const wasActive = this.active;
    this.generationEpoch++;
    this.auditPending = null;
    this.debug.auditResult = '—';
    this.setEntranceOpening(false);
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.detachAll();
    this.completedResults.length = 0;
    this.jobQueue.length = 0;
    this.queuedKeys.clear();
    this.configurePlans();
    this.refreshDebugReadout();
    if (wasActive) {
      this.streamStartedAt = performance.now();
      this.updateStreaming(true);
      this.debug.state = 'active — streaming rebuilt blocks';
    }
  }

  deactivate() {
    this.setEntranceOpening(false);
    this.active = false;
    this.inside = false;
    this.collisionFloorLocal = null;
    this.group.visible = false;
    this.controls.camera.layers.disable(CAVE_RENDER_LAYER);
    this.controls.camera.layers.enable(0);
    this.controls.camera.near = this.surfaceCameraNear;
    this.controls.camera.updateProjectionMatrix();
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.controls.setEnvironment(null);
    setCaveEntranceVisual(null);
    // Stop queued cave work immediately. In-flight workers cannot be cancelled
    // safely, but their at-most-two late results are discarded on arrival.
    this.jobQueue.length = 0;
    this.queuedKeys.clear();
    this.completedResults.length = 0;
    this.pendingEntranceTerrainSignature = null;
    this.entranceTerrainStableSince = 0;
    this.detachAll();
  }

  // Memoized per-cell anchor lookup for walk-up discovery. Cells are pure
  // functions of the world, so each is probed once and remembered (null too).
  // The landmark-clearance filter matches collectAnchors, keeping discovered
  // caves out of landmark halos.
  discoveryAnchorsNear(px, pz, radius) {
    this._anchorMemo = this._anchorMemo || new Map();
    const out = [];
    const c0x = Math.floor((px - radius) / CAVE_CELL_SIZE);
    const c1x = Math.floor((px + radius) / CAVE_CELL_SIZE);
    const c0z = Math.floor((pz - radius) / CAVE_CELL_SIZE);
    const c1z = Math.floor((pz + radius) / CAVE_CELL_SIZE);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = `${cx}_${cz}`;
        let anchor;
        if (this._anchorMemo.has(key)) {
          anchor = this._anchorMemo.get(key);
        } else {
          anchor = caveAnchorForCell(this.world, cx, cz, this.world.seed);
          if (anchor && anchor.valid) {
            landmarksAround(this.world, anchor.x, anchor.z, this.world.seed, 180, this.landmarkScratch);
            const blocked = this.landmarkScratch.some((landmark) => {
              const dx = anchor.x - landmark.x, dz = anchor.z - landmark.z;
              const clearance = landmark.halo + 70;
              return dx * dx + dz * dz < clearance * clearance;
            });
            if (blocked) anchor = null;
          } else {
            anchor = null;
          }
          if (this._anchorMemo.size >= 768) {
            this._anchorMemo.delete(this._anchorMemo.keys().next().value);
          }
          this._anchorMemo.set(key, anchor);
        }
        if (!anchor) continue;
        const dx = anchor.x - px, dz = anchor.z - pz;
        if (dx * dx + dz * dz <= radius * radius) out.push(anchor);
      }
    }
    out.sort((a, b) => ((a.x - px) ** 2 + (a.z - pz) ** 2) - ((b.x - px) ** 2 + (b.z - pz) ** 2));
    return out;
  }

  // Walk-up discovery: called from the game's slow probe. When the player
  // wanders within reach of a valid anchor, that cave configures and activates
  // IN PLACE — its entrance appears in the hillside ahead — and releases with
  // hysteresis once they wander far enough away. Never swaps a cave out from
  // under someone inside it or mid-inspection.
  discoverNear(px, pz) {
    if (this.inside || this.inspection?.active) return;
    const movedX = px - (this._discoverX ?? 1e9), movedZ = pz - (this._discoverZ ?? 1e9);
    if (movedX * movedX + movedZ * movedZ < 80 * 80) return;
    this._discoverX = px;
    this._discoverZ = pz;
    const DISCOVER_RADIUS = 620, RELEASE_RADIUS = 900;
    const currentDistance = this.active && this.anchor
      ? Math.hypot(this.anchor.x - px, this.anchor.z - pz)
      : Infinity;
    // hold the active cave while the player is anywhere near it
    if (this.active && currentDistance < RELEASE_RADIUS * 0.7) return;
    const nearest = this.discoveryAnchorsNear(px, pz, DISCOVER_RADIUS)[0] ?? null;
    if (!nearest || Math.hypot(nearest.x - px, nearest.z - pz) > DISCOVER_RADIUS) {
      if (this.active && this._discovered && currentDistance > RELEASE_RADIUS) {
        this.deactivate();
        this._discovered = false;
        this.debug.state = 'released — wandered away';
      }
      return;
    }
    if (this.active && this.anchor?.id === nearest.id) return;
    // adopt into the candidates list so every debug flow stays coherent
    let index = this.anchorCandidates.findIndex((candidate) => candidate.id === nearest.id);
    if (index < 0) {
      this.anchorCandidates.unshift(nearest);
      index = 0;
    }
    this.deactivate();
    this.configureAnchor(index);
    this.activate();
    this._discovered = true;
  }

  // Bring the configured cave to life IN PLACE: streaming, collar, collision
  // environment — everything enter() does except moving the player. This is
  // what walk-up discovery uses, so a cave appears in the hillside you are
  // already looking at instead of teleporting you to it.
  activate() {
    this.active = true;
    this.inside = false;
    this.collisionFloorLocal = null;
    this.group.visible = true;
    this.controls.camera.layers.enable(0);
    this.controls.camera.layers.enable(CAVE_RENDER_LAYER);
    // A smaller near plane is scoped to cave activity. It prevents the near
    // plane corners from slicing through a wall during close turns without
    // sacrificing outdoor far-distance depth precision for the whole game.
    this.controls.camera.near = Math.min(this.surfaceCameraNear, 0.04);
    this.controls.camera.updateProjectionMatrix();
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.setEntranceOpening(false);
    this.controls.setEnvironment(this.environment);
    setCaveEntranceVisual(this.entranceSpec);
    this.streamStartedAt = performance.now();
    this.debug.state = 'approach — streaming entrance blocks';
    this.updateStreaming(true);
  }

  enter() {
    this.activate();
    const mouth = this.graph.entrance.mouth;
    // Place the debug view on the dense replacement surface. On steep anchors
    // the coarse streamed heightfield can sit metres above world.height()
    // between vertices, putting a true-height teleport under a triangle.
    const spawnLocal = { x: mouth[0], z: mouth[2] - 5.8 };
    const worldXZ = this.localToWorldXZ(spawnLocal.x, spawnLocal.z);
    const floor = this.terrain?.renderedHeightAt(worldXZ.x, worldXZ.z)
      ?? this.world.height(worldXZ.x, worldXZ.z);
    this.controls.placeAt(worldXZ.x, floor, worldXZ.z);
    this.controls.yaw = Math.PI + this.anchor.yaw;
    this.controls.pitch = 0.12;
    return { anchor: this.anchor, graph: this.graph, floor };
  }

  exit() {
    this.deactivate();
    const x = this.anchor.x - this.anchor.inwardX * 14;
    const z = this.anchor.z - this.anchor.inwardZ * 14;
    this.controls.place(x, z);
    this.controls.yaw = Math.PI + this.anchor.yaw;
    this.debug.state = 'cached — surface';
  }

  previewSurface() {
    const result = this.enter();
    this.controls.pitch = -0.08;
    this.debug.state = 'approach — surface placement preview';
    return result;
  }

  stepAnchor(direction) {
    const wasActive = this.active;
    this.deactivate();
    this.configureAnchor(this.anchorIndex + direction);
    if (wasActive) return this.enter();
    return this.previewSurface();
  }

  stepGeology() {
    const current = this.graph?.geology;
    const count = this.anchorCandidates.length;
    for (let offset = 1; offset < count; offset++) {
      const index = (this.anchorIndex + offset) % count;
      const candidate = this.anchorCandidates[index];
      const hillClass = caveReliefAt(this.world, candidate.x, candidate.z) < 26 ? 'low' : 'high';
      const geology = generateCaveGraph(candidate.seed, { biome: candidate.biome, hillClass }).geology;
      if (geology === current) continue;
      const wasActive = this.active;
      this.deactivate();
      this.configureAnchor(index);
      if (wasActive) return this.reviewEntranceLighting();
      return this.previewSurface();
    }
    return this.stepAnchor(1);
  }

  stepChamber(direction) {
    if (!this.graph.chambers.length) return null;
    const count = this.graph.chambers.length;
    this.chamberIndex = ((this.chamberIndex + direction) % count + count) % count;
    if (!this.active) this.enter();
    const chamber = this.graph.chambers[this.chamberIndex];
    const referenceY = Number.isFinite(chamber.floorY)
      ? chamber.floorY + 0.08
      : chamber.c[1] - chamber.r[1] + 0.7;
    const floorY = this.field.floorHeightNear(
      chamber.c[0], chamber.c[2], referenceY, chamber.r[1] + 2, chamber.r[1] + 2,
    ) ?? this.field.floorHeight(chamber.c[0], chamber.c[2]);
    if (floorY === null) {
      this.debug.state = `chamber ${this.chamberIndex + 1} has no navigable floor`;
      return null;
    }
    const world = this.localToWorld(chamber.c[0], floorY, chamber.c[2]);
    this.controls.placeAt(world.x, world.y, world.z);
    this.collisionFloorLocal = { x: chamber.c[0], z: chamber.c[2], y: floorY };
    const nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const mainIndex = this.graph.mainPath.indexOf(chamber.nodeId);
    let lookNode = null;
    if (mainIndex >= 0) {
      const lookIndex = mainIndex < this.graph.mainPath.length - 1 ? mainIndex + 1 : mainIndex - 1;
      lookNode = nodeById.get(this.graph.mainPath[lookIndex]);
    } else {
      const edge = this.graph.edges.find((candidate) => candidate.a === chamber.nodeId || candidate.b === chamber.nodeId);
      lookNode = edge ? nodeById.get(edge.a === chamber.nodeId ? edge.b : edge.a) : null;
    }
    if (lookNode) {
      const target = this.localToWorld(lookNode.p[0], lookNode.p[1], lookNode.p[2]);
      this.controls.yaw = Math.atan2(-(target.x - world.x), -(target.z - world.z));
    } else {
      this.controls.yaw = Math.PI + this.anchor.yaw;
    }
    this.controls.pitch = 0.04;
    this.setInside(true);
    this.lastStreamCell = '';
    this.updateStreaming(true);
    this.debug.state = `chamber ${this.chamberIndex + 1}/${count} · ${chamber.role || chamber.kind || chamber.type || 'room'}`;
    return { chamber, floorY, world };
  }

  reviewEntranceLighting() {
    if (!this.graph.chambers.length) return null;
    const mouth = this.graph.entrance.mouth;
    let nearestIndex = 0, nearestDistance = Infinity;
    for (let i = 0; i < this.graph.chambers.length; i++) {
      const chamber = this.graph.chambers[i];
      const distance = Math.hypot(
        chamber.c[0] - mouth[0], chamber.c[1] - mouth[1], chamber.c[2] - mouth[2],
      );
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = i; }
    }
    this.chamberIndex = (nearestIndex - 1 + this.graph.chambers.length) % this.graph.chambers.length;
    const result = this.stepChamber(1);
    if (!result) return null;
    const entranceWorld = this.localToWorld(mouth[0], mouth[1], mouth[2]);
    const dx = entranceWorld.x - result.world.x;
    const dz = entranceWorld.z - result.world.z;
    const dy = entranceWorld.y + 1.2 - (result.world.y + this.controls.camera.position.y);
    this.controls.yaw = Math.atan2(-dx, -dz);
    this.controls.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.debug.state = `lighting review · first chamber → entrance · ${nearestDistance.toFixed(0)}m`;
    return result;
  }

  reviewHydrology() {
    const plan = this.hydrology.plan;
    const feature = plan?.pools?.[0] || plan?.streams?.[0];
    if (!feature) {
      this.debug.state = `hydrology review · ${this.graph.geology} cave is dry`;
      return null;
    }
    if (!this.active) this.activate();
    const point = feature.center || feature.points[Math.floor(feature.points.length * 0.5)];
    let viewX = point.x, viewZ = point.z;
    if (feature.center && feature.points.length) {
      // Choose the quietest pool edge for review, away from any feeding rill,
      // so the camera presents the pool as a basin rather than looking
      // directly down the stream ribbon.
      let edge = feature.points[0], bestClearance = -1;
      for (const candidate of feature.points) {
        let clearance = Infinity;
        for (const stream of plan.streams) {
          for (let i = 0; i < stream.points.length; i += 3) {
            const sample = stream.points[i];
            clearance = Math.min(clearance, Math.hypot(candidate.x - sample.x, candidate.z - sample.z));
          }
        }
        if (clearance > bestClearance) { bestClearance = clearance; edge = candidate; }
      }
      const dx = edge.x - point.x, dz = edge.z - point.z;
      const radius = Math.max(0.1, Math.hypot(dx, dz));
      // Stand inside the shallow edge rather than outside its conservative
      // polygon: some bowl chambers leave very little dry shelf between the
      // water and wall, and a review teleport must always remain navigable.
      viewX = point.x + dx * 0.72;
      viewZ = point.z + dz * 0.72;
    }
    const floorY = this.field.floorHeightNear(viewX, viewZ, point.y - 0.08, 3, 3)
      ?? point.y - 0.08;
    const world = this.localToWorld(viewX, floorY, viewZ);
    this.controls.placeAt(world.x, world.y, world.z);
    const target = this.localToWorld(point.x, point.y, point.z);
    this.controls.yaw = Math.atan2(-(target.x - world.x), -(target.z - world.z));
    this.controls.pitch = 0.23;
    this.collisionFloorLocal = { x: viewX, z: viewZ, y: floorY };
    this.setInside(true);
    this.lastStreamCell = '';
    this.updateStreaming(true);
    this.debug.state = `hydrology review · ${feature.center ? 'pool' : 'rill'} · ${this.graph.geology}`;
    return { feature, world };
  }

  setWireframe(value) {
    this.debug.wireframe = !!value;
    this.material.wireframe = this.debug.wireframe;
    this.entranceStreamMaterial.wireframe = this.debug.wireframe;
    if (this.entranceMaterial) this.entranceMaterial.wireframe = this.debug.wireframe;
  }

  setSurfaceDebug(value) {
    this.debug.surfaceDebug = !!value;
    this.material.uniforms.uSurfaceDebug.value = this.debug.surfaceDebug ? 1 : 0;
    this.entranceStreamMaterial.uniforms.uSurfaceDebug.value = this.debug.surfaceDebug ? 1 : 0;
  }

  applyMaterialPalette() {
    const palette = caveMaterialPalette(this.graph?.geology);
    for (const material of [this.material, this.entranceStreamMaterial]) {
      const uniforms = material.uniforms;
      uniforms.uRockDark.value.fromArray(palette.dark);
      uniforms.uRockMid.value.fromArray(palette.mid);
      uniforms.uRockLight.value.fromArray(palette.light);
      uniforms.uSedimentColor.value.fromArray(palette.sediment);
      uniforms.uMineralColor.value.fromArray(palette.mineral);
      uniforms.uWetColor.value.fromArray(palette.wet);
      uniforms.uGeologyParams.value.set(
        palette.strata, palette.mineralStrength, palette.fractureStrength, palette.crystal,
      );
      uniforms.uPainterlyStrength.value = this.materialStyle.strength;
    }
  }

  setMaterialStrength(value) {
    this.materialStyle.strength = clamp01(value);
    for (const material of [this.material, this.entranceStreamMaterial]) {
      material.uniforms.uPainterlyStrength.value = this.materialStyle.strength;
    }
  }

  setShowGraph(value) {
    this.debug.showGraph = !!value;
    if (this.graphDebug) this.graphDebug.visible = this.debug.showGraph;
  }

  setEntranceOpening(open) {
    const shouldOpen = !!open;
    if (shouldOpen === this.openingActive) return;
    this.openingActive = shouldOpen;
    this.terrain?.setCaveCut(shouldOpen ? this.entranceSpec : null);
    if (this.entranceFacade) this.entranceFacade.visible = shouldOpen;
    if (this.entranceEcology) this.entranceEcology.visible = shouldOpen;
  }

  entranceTerrainReady() {
    if (!this.terrain?.hasTerrainAt) return true;
    const mouth = this.graph.entrance.mouth;
    return [
      [0, mouth[2] - 4.6], [-5.8, mouth[2] - 3.2], [5.8, mouth[2] - 3.2],
      [-5.8, mouth[2] + 5.5], [5.8, mouth[2] + 5.5],
      [-5.8, mouth[2] + 14.0], [5.8, mouth[2] + 14.0],
      [-5.8, mouth[2] + 21.0], [5.8, mouth[2] + 21.0], [0, mouth[2] + 24.0],
    ].every(([x, z]) => {
      const worldXZ = this.localToWorldXZ(x, z);
      return this.terrain.hasTerrainAt(worldXZ.x, worldXZ.z);
    });
  }

  syncEntranceOpening() {
    const shouldOpen = this.active && this.entranceReady() && this.entranceTerrainReady();
    const terrainSignature = shouldOpen
      ? (this.terrain?.caveTerrainSignature?.(this.entranceSpec.worldBounds) || 'procedural')
      : null;
    if (!shouldOpen) {
      this.pendingEntranceTerrainSignature = null;
      this.entranceTerrainStableSince = 0;
      this.setEntranceOpening(false);
      return;
    }

    const now = performance.now();
    const facadeNeedsRefresh = !this.entranceFacade
      || terrainSignature !== this.entranceTerrainSignature;
    if (facadeNeedsRefresh) {
      if (terrainSignature !== this.pendingEntranceTerrainSignature) {
        this.pendingEntranceTerrainSignature = terrainSignature;
        this.entranceTerrainStableSince = now;
      }
      const settleMs = this.entranceFacade
        ? ENTRANCE_REFRESH_SETTLE_MS
        : ENTRANCE_INITIAL_SETTLE_MS;
      const frameQueuesBusy = this.completedResults.length > 0 || this.attachmentQueue.length > 0;
      if (!frameQueuesBusy && now - this.entranceTerrainStableSince >= settleMs) {
        // Build only after destination terrain and cave scene admission have
        // settled. Adaptive quality can replace several affected terrain
        // chunks in succession; debouncing collapses that churn to one rebuild.
        this.rebuildEntranceFacade();
        this.entranceTerrainSignature = terrainSignature;
        this.pendingEntranceTerrainSignature = null;
        this.entranceTerrainStableSince = 0;
        this.entranceEcologyDueAt = now + ENTRANCE_ECOLOGY_DELAY_MS;
      }
    }

    // The implicit collar is load-bearing, so the terrain aperture remains
    // closed during its initial build delay. A previously built collar stays
    // visible while a replacement terrain LOD settles.
    this.setEntranceOpening(!!this.entranceFacade);

    // Entrance ecology performs hundreds of folded-surface probes. Separate
    // it from collar meshing so those two main-thread costs never land in the
    // same rendered frame.
    if (this.entranceFacade
      && this.entranceTerrainSignature === terrainSignature
      && !this.entranceEcology
      && now >= this.entranceEcologyDueAt
      && this.completedResults.length === 0
      && this.attachmentQueue.length === 0) {
      this.rebuildEntranceEcology();
      this.entranceEcologySignature = terrainSignature;
    }
  }

  setLightingEnabled(value) {
    this.atmosphere.enabled = !!value;
    this.debug.lightingEnabled = this.atmosphere.enabled;
  }

  setHydrologyEnabled(value) {
    this.hydrology.enabled = !!value;
    if (this.hydrology.mesh) this.hydrology.mesh.visible = this.hydrology.enabled;
    if (this.hydrology.dripMesh) this.hydrology.dripMesh.visible = this.hydrology.enabled;
    if (this.hydrology.mistMesh) this.hydrology.mistMesh.visible = this.hydrology.enabled;
  }

  // Called immediately after SkySystem.update, while scene.fog still contains
  // the authoritative outdoor day/weather state. The cave then blends that
  // surface atmosphere into dark, local air without making SkySystem aware of
  // cave topology. On the next frame SkySystem writes a fresh outdoor baseline
  // again, so this override can never leak permanently onto the surface.
  updateAtmosphere(dt, sky, weather, fog = this.scene.fog) {
    const atmosphere = this.atmosphere;
    const local = this.active ? this.worldToLocal(this.controls.rig.position) : null;
    const target = atmosphere.enabled && this.active
      ? caveInteriorTarget(this.inside, local, this.graph?.entrance?.mouth)
      : 0;
    atmosphere.target = target;
    atmosphere.factor = dampCaveValue(
      atmosphere.factor,
      target,
      dt,
      target > atmosphere.factor ? 0.85 : 0.52,
    );
    atmosphere.exposureScale = adaptCaveExposure(
      atmosphere.exposureScale,
      caveExposureTarget(atmosphere.factor),
      dt,
    );

    const light = caveEntranceLight(sky?.sunElevation ?? 0, sky?.moonIllum ?? 0, weather);
    atmosphere.entranceIntensity = light.intensity;
    if (sky?.hemi?.color && sky?.sun?.color) {
      atmosphere.entranceColor.copy(sky.hemi.color)
        .lerp(sky.sun.color, 0.20 + light.warmth * 0.62);
    }
    if (light.night > 0.001) {
      atmosphere.entranceColor.lerp(atmosphere.nightColor, light.night * 0.82);
    }

    const geology = this.graph?.geology || 'limestone';
    const fogRgb = CAVE_FOG_RGB[geology] || CAVE_FOG_RGB.limestone;
    const ambientRgb = CAVE_AMBIENT_RGB[geology] || CAVE_AMBIENT_RGB.limestone;
    atmosphere.fogColor.setRGB(...fogRgb);
    atmosphere.ambientColor.setRGB(...ambientRgb);
    const humidity = CAVE_HUMIDITY[geology] ?? 0.45;
    const caveFog = caveFogRange(atmosphere.factor, humidity);

    // Keep the aperture dark from outside; the navigation fill arrives only
    // after the walker is actually underground and never becomes a flashlight.
    const navigationFill = THREE.MathUtils.lerp(0.035, atmosphere.navigationFill, atmosphere.factor);
    for (const material of [this.material, this.entranceStreamMaterial]) {
      const uniforms = material.uniforms;
      uniforms.uEntranceLightColor.value.copy(atmosphere.entranceColor);
      uniforms.uEntranceIntensity.value = atmosphere.entranceIntensity;
      uniforms.uCaveAmbientColor.value.copy(atmosphere.ambientColor);
      uniforms.uNavigationFill.value = navigationFill;
      uniforms.uInteriorFactor.value = atmosphere.factor;
    }
    const waterUniforms = this.waterMaterial.uniforms;
    waterUniforms.uEntranceLightColor.value.copy(atmosphere.entranceColor);
    waterUniforms.uEntranceIntensity.value = atmosphere.entranceIntensity;
    waterUniforms.uAmbientColor.value.copy(atmosphere.ambientColor);
    waterUniforms.uInteriorFactor.value = atmosphere.factor;
    this.dripMaterial.uniforms.uRain.value = clamp01(weather?.rain ?? 0);
    this.dripMaterial.uniforms.uInteriorFactor.value = atmosphere.factor;
    this.mistMaterial.uniforms.uMistColor.value.copy(atmosphere.fogColor).lerp(
      this.waterMaterial.uniforms.uWaterColor.value, 0.34,
    );
    this.mistMaterial.uniforms.uInteriorFactor.value = atmosphere.factor;
    this.fungiGlowMaterial.uniforms.uInteriorFactor.value = atmosphere.factor;

    if (fog) {
      atmosphere.surfaceFogColor.copy(fog.color);
      const surfaceNear = fog.near, surfaceFar = fog.far;
      fog.color.lerp(atmosphere.fogColor, atmosphere.factor);
      fog.near = THREE.MathUtils.lerp(surfaceNear, caveFog.near, atmosphere.factor);
      fog.far = THREE.MathUtils.lerp(surfaceFar, caveFog.far, atmosphere.factor);
    }

    atmosphere.state = atmosphere.factor < 0.02
      ? 'surface'
      : atmosphere.factor < 0.92 ? 'threshold blend' : 'underground';
    this.debug.atmosphere = `${atmosphere.state} · ${(atmosphere.factor * 100).toFixed(0)}% · daylight ${light.intensity.toFixed(2)} · exposure ${atmosphere.exposureScale.toFixed(2)}`;
    return atmosphere;
  }

  update(dt) {
    this.elapsed += dt;
    this.material.uniforms.uTime.value = this.elapsed;
    this.entranceStreamMaterial.uniforms.uTime.value = this.elapsed;
    this.waterMaterial.uniforms.uTime.value = this.elapsed;
    this.dripMaterial.uniforms.uTime.value = this.elapsed;
    this.mistMaterial.uniforms.uTime.value = this.elapsed;
    this.fungiGlowMaterial.uniforms.uTime.value = this.elapsed;
    if (this.active) this.updateStreaming(false);
    this.drainWorkerResults();
    if (this.active) this.drainAttachments();
    // Draining a completion releases backpressure and lets a free worker begin
    // the next closest block without doing any more scene work this frame.
    this.pumpWorkers();
    if (this.active) {
      this.syncEntranceOpening();
      if (this.inspection?.active) this.updateInspectionOrbit(dt);
      else this.updatePortalTransition();
    }
    if (this.metricsDirty) this.updateMetrics();
  }

  // 360° entrance inspection: a slow debug orbit that circles the mouth from
  // outside so the collar, aperture and silhouette can be reviewed from every
  // angle without walking. Drives the same rig/yaw/pitch that controls.update
  // writes, but runs AFTER it each frame, so the override always wins for the
  // rendered frame without any reparenting or input fighting.
  setInspection(value) {
    const on = !!value;
    if (on && !this.active) this.enter();
    this.inspection = this.inspection || {};
    if (on && !this.inspection.active) {
      // remember the player's framing so leaving inspection never jumps
      this.inspection.saved = {
        yaw: this.controls.yaw, pitch: this.controls.pitch,
        pos: this.controls.rig.position.clone(),
        camY: this.controls.camera.position.y,
      };
      const mouth = this.graph.entrance.mouth;
      this.inspection.target = this.localToWorld(mouth[0], mouth[1], mouth[2]);
      const aperture = Math.max(this.graph.entrance.rx, this.graph.entrance.ry);
      this.inspection.radius = aperture * 2.4 + 11;
      this.inspection.height = aperture * 1.2 + 4.5;
      this.inspection.angle = 0;
      this.inspection.speed = 0.32;         // radians / second
    } else if (!on && this.inspection.active && this.inspection.saved) {
      const s = this.inspection.saved;
      this.controls.yaw = s.yaw; this.controls.pitch = s.pitch;
      this.controls.rig.position.copy(s.pos);
      this.controls.camera.position.y = s.camY;
      this.inspection.saved = null;
    }
    this.inspection.active = on;
    this.debug.inspect = on;
    if (on) this.debug.state = 'inspection — entrance orbit';
  }

  updateInspectionOrbit(dt) {
    const insp = this.inspection;
    insp.angle += dt * insp.speed;
    const target = insp.target;
    const camX = target.x + Math.cos(insp.angle) * insp.radius;
    const camZ = target.z + Math.sin(insp.angle) * insp.radius;
    const camY = target.y + insp.height;
    const dx = target.x - camX, dz = target.z - camZ, dy = target.y - camY;
    const horizontal = Math.hypot(dx, dz);
    // controls' forward is the rig's local -Z; solve rig yaw + camera pitch to
    // aim it at the mouth (matches the sign conventions in controls.update)
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horizontal);
    this.controls.yaw = yaw;
    this.controls.pitch = pitch;
    this.controls.rig.position.set(camX, camY, camZ);
    this.controls.rig.rotation.y = yaw;
    this.controls.camera.rotation.set(pitch, 0, 0);
    this.controls.camera.position.y = 0;   // orbit uses rig Y directly; cancel eye/bob
  }
}
