// GPU-driven grass field (the "clipmap" approach): ONE InstancedMesh whose
// blades are placed entirely in the vertex shader — a hash of gl_InstanceID
// scatters them over a square field that follows the player, and each blade
// seats itself by sampling a small height+density texture refreshed
// incrementally from the world model (same pattern as water.js). Zero per-blade
// CPU or memory cost: density, size, wind and culling are all shader-side.
// The near-field per-chunk patch grass stays for close-up lushness; this field
// carries coverage out to ~COVER metres so grassy biomes read grassy everywhere.

import * as THREE from 'three';
import { windUniforms, WIND_GLSL_DECLS } from './wind.js';
import { atmoUniforms } from './atmosphere.js';
import { GRASS_DENSITY } from './vegdata.js';
import { groundColor, WATER_LEVEL } from './world.js';
import { smoothstep } from './noise.js';
import { caveEntranceUniforms, CAVE_EXCLUSION_GLSL } from './cavevisual.js';
import { GRASS_SHADOW_TAPS } from './shadowquality.mjs';
import { GrassTrailCache } from './grasstrailcache.js';
import {
  GRASS_FIELD_COVER,
  GRASS_FIELD_SIZE,
  GRASS_TRAIL_MASK_SIZE,
  grassFieldAnchorForPlayer,
} from './grasstrailprep.mjs';

const TEX = GRASS_FIELD_SIZE;             // data texture resolution (TEX² texels)
const TRAIL_TEX = GRASS_TRAIL_MASK_SIZE;  // dedicated ~0.68m trail mask
const COVER = GRASS_FIELD_COVER;           // metres of world covered by the field
const COUNT = 960000;  // max blades (tier-scaled via mesh.count)
const TPF = 400;       // texels refreshed per frame (bounds main-thread cost)

const VERT = /* glsl */`
uniform sampler2D uHTex;   // R = ground height, G = density, B = trail height scale
uniform sampler2D uCTex;   // grass tint per texel
uniform sampler2D uTrailTex; // R = analytical trail grass coverage (0 tread → 1 verge)
uniform vec2 uAnchor;      // field min corner (world xz)
uniform float uCover;
uniform vec3 uCam;
uniform float uTime;
uniform mat4 uShadowMatrix;      // world -> sun shadow-map UV/depth space
uniform mat4 uPreviousShadowMatrix;
uniform float uShadowNormalBias; // push the sample up off the ground (anti-acne)
${WIND_GLSL_DECLS}
${CAVE_EXCLUSION_GLSL}
varying vec3 vGroundCol;
varying float vY;
varying vec3 vWPos;
varying float vShim;
varying vec4 vShadowCoord;
varying vec4 vPreviousShadowCoord;
// PCG-style integer hash for placement. The previous X/Z sine hashes both
// advanced linearly from gl_InstanceID, which exposed diagonal rows at grazing
// view angles. Independent integer streams remove that cross-axis correlation.
uint grassHash(uint state) {
  state = state * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float grassRandom(uint state) {
  return float(grassHash(state)) * (1.0 / 4294967296.0);
}
// DataTexture defaults to nearest-neighbour filtering. On slopes that seats
// every blade within a ~2.7m texel at the same elevation, creating visible
// contour rows despite random X/Z placement. Fetch and interpolate explicitly
// so height, density and ground pigment vary continuously across the hillside.
vec4 sampleGrassField(sampler2D fieldTexture, vec2 uv) {
  ivec2 dimensions = textureSize(fieldTexture, 0);
  vec2 texelPosition = clamp(uv, 0.0, 1.0) * vec2(dimensions - ivec2(1));
  ivec2 lower = ivec2(floor(texelPosition));
  ivec2 upper = min(lower + ivec2(1), dimensions - ivec2(1));
  vec2 blend = fract(texelPosition);
  vec4 row0 = mix(
    texelFetch(fieldTexture, ivec2(lower.x, lower.y), 0),
    texelFetch(fieldTexture, ivec2(upper.x, lower.y), 0),
    blend.x
  );
  vec4 row1 = mix(
    texelFetch(fieldTexture, ivec2(lower.x, upper.y), 0),
    texelFetch(fieldTexture, ivec2(upper.x, upper.y), 0),
    blend.x
  );
  return mix(row0, row1, blend.y);
}
void main() {
  // WORLD-FIXED toroidal lattice: each blade has a fixed world position that
  // repeats every uCover metres; we render the copy nearest the camera. Blade
  // positions therefore never move as the player walks — they only wrap at
  // >uCover/2 away, where the distance fade has already culled them. (Deriving
  // positions from the anchor made the whole field reshuffle at each re-anchor
  // — invisible on flat grass, an obvious pop in the foothills.)
  uint instanceId = uint(gl_InstanceID);
  vec2 seed = vec2(
    grassRandom(instanceId * 2u + 0x68bc21ebu),
    grassRandom(instanceId * 2u + 0x02e5be93u)
  ) * uCover;
  vec2 base = seed + uCover * floor((uCam.xz - seed) / uCover + 0.5);
  vec2 uvT = clamp((base - uAnchor) / uCover, 0.0, 1.0);
  vec4 ht = sampleGrassField(uHTex, uvT);
  float h = ht.r, dens = ht.g, trailHeight = max(ht.b, 0.05);
  float trailMask = texture(uTrailTex, uvT).r;
  float dist = distance(base, uCam.xz);
  // keep-test: density thins with distance; field edge fades to nothing
  float keep = dens * (1.0 - smoothstep(uCover * 0.26, uCover * 0.48, dist) * 0.9);
  keep *= trailMask;
  keep *= 1.0 + (1.0 - smoothstep(5.0, 45.0, dist));   // double density near the player
  // smooth threshold: blades near their cutoff scale up/down gradually as
  // keep changes with distance — no pop-in/pop-out
  float ok = clamp((keep - grassRandom(instanceId * 3u + 0xa511e9b3u)) * 5.0, 0.0, 1.0);
  // far blades grow wider/taller so sparser coverage still reads dense
  float far = smoothstep(30.0, uCover * 0.45, dist);
  float s = (0.45 + 0.55 * grassRandom(instanceId * 5u + 0x63d83595u))
          * ok * (1.0 - caveEntranceMask(base));
  float bladeHeight = s * (1.5 + far * 0.5) * trailHeight;
  vec3 p = vec3(position.x * 0.11 * (1.0 + far * 2.2), position.y * bladeHeight, 0.0);
  float yaw = grassRandom(instanceId * 7u + 0xb8f3a789u) * 6.2831;
  p = vec3(p.x * cos(yaw), p.y, p.x * sin(yaw));
  // coherent patch sway: same 8m cell scheme as the near patch grass
  float gw = position.y;
  vec2 gcell = (floor(base / 8.0) + 0.5) * 8.0;
  float ph = gcell.x * 1.71 + gcell.y * 2.13;
  float ggust = windGust(gcell);
  float gamp = 0.25 + 1.4 * ggust * uWindStrength;
  // gust front shimmer: leaning blades catch the light, so the passing gust
  // reads as a travelling brightness band — wind made visible
  vShim = ggust * uWindStrength;
  float gwig = (sin(uTime * 1.6 + ph) + sin(uTime * 2.7 + ph * 1.7) * 0.5) * 0.09
             + sin(uTime * 3.3 + base.x * 7.0 + base.y * 5.0) * 0.018;
  p.x += (gwig + uWindDir.x * ggust * uWindStrength * 0.8) * gamp * gw * s;
  p.z += (cos(uTime * 1.3 + ph) * 0.06 + uWindDir.y * ggust * uWindStrength * 0.8) * gamp * gw * s;
  vec3 wpos = vec3(base.x, h - 0.45, base.y) + p;   // origin sunk below terrain
  // Ground pigment does not affect placement, so its cheaper nearest lookup is
  // sufficient; only the height/density field needs slope reconstruction.
  vGroundCol = texture2D(uCTex, uvT).rgb;
  // The blanket blade begins 0.45m below the terrain. Measure the colour
  // gradient only over the visible portion so its first visible pixel is still
  // the terrain pigment, regardless of random blade height or distance LOD.
  vY = clamp((p.y - 0.45) / max(bladeHeight - 0.45, 0.05), 0.0, 1.0);
  vWPos = wpos;
  // Cast-shadow lookup coordinate. Sample at the blade's STABLE ground base
  // (world-fixed lattice xz + terrain height), not the wind-swayed vertex — a
  // per-blade constant that removes the crawling acne stripes the moving
  // vertices produced. Lift well up along +Y so the base can't self-shadow
  // against the terrain it grows from.
  vec3 shadowBase = vec3(base.x, h + uShadowNormalBias, base.y);
  vShadowCoord = uShadowMatrix * vec4(shadowBase, 1.0);
  vPreviousShadowCoord = uPreviousShadowMatrix * vec4(shadowBase, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
}`;

const FRAG = /* glsl */`
layout(location = 0) out highp vec4 outColor;
uniform vec3 uAtmoSunDir, uAtmoSunCol, uAtmoAerial;
uniform float uAtmoDay, uAtmoTime, uAtmoCloudCover, uAtmoCloudShadow;
uniform vec2 uWindOffset;
uniform sampler2D uShadowMap;
uniform sampler2D uPreviousShadowMap;
uniform float uShadowEnabled;    // 0 on tiers that render no shadows
uniform float uShadowPacked;     // 1 for the RGBA8 fallback, 0 for linear R32F
uniform float uShadowBlend;      // previous -> current cache crossfade
uniform float uShadowKernel;     // filter radius measured in cache texels
uniform float uShadowStrength;   // direct-sun fraction kept in shadow (0 = none)
uniform float uShadowRange;      // metres; beyond this the lookup is skipped
uniform float uShadowBias;
uniform vec2 uShadowTexel;       // 1 / shadow-map size, for the PCF kernel
varying vec4 vShadowCoord;
varying vec4 vPreviousShadowCoord;
// Matches three's unpackRGBAToDepth. The packed map stores its most-significant
// depth component in A and its least-significant component in R; reversing
// those weights makes almost every real caster sample appear fully lit.
float gfUnpackDepth(vec4 rgba) {
  const float unpackDownscale = 255.0 / 256.0;
  return dot(rgba, unpackDownscale / vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0));
}
// A centre sample plus a rotated four-point ring. Temporal blending between
// snapshots supplies stability, so the old twelve-tap spatial filter is no
// longer needed on every nearby grass fragment.
const vec2 GRASS_PCF[${GRASS_SHADOW_TAPS}] = vec2[](
  vec2(0.0, 0.0), vec2(-0.72, -0.32), vec2(0.31, -0.78),
  vec2(0.78, 0.28), vec2(-0.26, 0.82)
);
float grassDepth(vec4 texel) {
  return mix(texel.r, gfUnpackDepth(texel), uShadowPacked);
}
float currentGrassShadow(vec3 sc, float compare) {
  float lit = 0.0;
  vec2 radius = uShadowTexel * uShadowKernel;
  for (int i = 0; i < ${GRASS_SHADOW_TAPS}; i++) {
    lit += step(compare, grassDepth(texture(uShadowMap, sc.xy + GRASS_PCF[i] * radius)));
  }
  return lit * (1.0 / float(${GRASS_SHADOW_TAPS}));
}
float previousGrassShadow(vec3 sc, float compare) {
  float lit = 0.0;
  vec2 radius = uShadowTexel * uShadowKernel;
  for (int i = 0; i < ${GRASS_SHADOW_TAPS}; i++) {
    lit += step(compare, grassDepth(texture(uPreviousShadowMap, sc.xy + GRASS_PCF[i] * radius)));
  }
  return lit * (1.0 / float(${GRASS_SHADOW_TAPS}));
}
// 1.0 = fully lit, 0.0 = occluded. Reuses the already-rendered sun shadow map
// (no extra pass); early-outs off-tier, out-of-frustum and beyond range so the
// cost is a single texture fetch only for near blades that can be shadowed.
float grassCastShadow(float viewDist) {
  if (uShadowEnabled < 0.5 || viewDist > uShadowRange) return 1.0;
  vec3 sc = vShadowCoord.xyz / vShadowCoord.w;
  if (sc.z > 1.0 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 1.0;
  float compare = sc.z + uShadowBias;
  float lit = currentGrassShadow(sc, compare);
  if (uShadowBlend < 0.999) {
    vec3 previousSc = vPreviousShadowCoord.xyz / vPreviousShadowCoord.w;
    bool previousInside = previousSc.z <= 1.0
      && previousSc.x >= 0.0 && previousSc.x <= 1.0
      && previousSc.y >= 0.0 && previousSc.y <= 1.0;
    if (previousInside) {
      float previousCompare = previousSc.z + uShadowBias;
      lit = mix(previousGrassShadow(previousSc, previousCompare), lit,
        smoothstep(0.0, 1.0, uShadowBlend));
    }
  }
  // Soft fade near the range edge so shadows do not pop as blades cross it.
  float edge = 1.0 - smoothstep(uShadowRange * 0.85, uShadowRange, viewDist);
  return mix(1.0, lit, edge);
}
float gfH(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
float gfN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(gfH(i), gfH(i+vec2(1,0)), f.x), mix(gfH(i+vec2(0,1)), gfH(i+vec2(1,1)), f.x), f.y); }
float gfFbm(vec2 p){ return gfN(p) * 0.65 + gfN(p * 2.7) * 0.35; }
varying vec3 vGroundCol;
varying float vY;
varying vec3 vWPos;
varying float vShim;
vec3 grassBladeGradient(vec3 ground, float height) {
  float luma = dot(ground, vec3(0.299, 0.587, 0.114));
  vec3 grassTip = mix(ground * vec3(0.96, 1.10, 0.72),
                      vec3(luma * 0.82, luma * 1.16, luma * 0.48), 0.38);
  return mix(ground, grassTip, smoothstep(0.0, 0.50, height));
}
void main() {
  // lit like the ground beneath (up-facing lambert) + hemisphere ambient
  vec3 blade = grassBladeGradient(vGroundCol, vY);
  float d = length(cameraPosition - vWPos);
  // Direct sun is fully occluded. Shade also mutes a little of the broad sky
  // fill so tree shadows stay readable around dawn/dusk, when there is too
  // little direct light for removing it alone to produce visible contrast.
  float castLit = grassCastShadow(d);
  float sunMul = mix(uShadowStrength, 1.0, castLit);
  vec3 direct = uAtmoSunCol * max(uAtmoSunDir.y, 0.0) * 1.3 * sunMul;
  vec3 ambient = vec3(0.22 + 0.16 * uAtmoDay) * mix(0.72, 1.0, castLit);
  vec3 lit = blade * (direct + ambient);
  lit *= 1.0 + vShim * 0.16 * uAtmoDay;   // gust-front light band
  // Do not darken the root: it must retain the same light response as the
  // ground. A very small tip lift keeps the blade shape readable.
  lit *= 1.0 + 0.05 * vY;
  // Same weather-driven, wind-carried cloud field as the terrain/vegetation.
  vec2 cp = (vWPos.xz - uWindOffset * 0.70) * 0.0016;
  float threshold = mix(0.70, 0.38, uAtmoCloudCover);
  float cloudMask = smoothstep(threshold - 0.08, threshold + 0.08, gfFbm(cp));
  lit *= 1.0 - cloudMask * (0.40 * uAtmoCloudShadow * uAtmoDay);
  // aerial haze with distance (d computed above for the shadow range test)
  float a = (1.0 - exp(-max(d - 300.0, 0.0) * 0.0003)) * 0.55 * uAtmoDay;
  lit = mix(lit, uAtmoAerial, clamp(a, 0.0, 0.55));
  // Colour alone cannot match terrain that is receiving tree shadows and
  // painterly surface lighting the grass shader does not evaluate. Fade blade
  // coverage through the lower half so the actual rendered ground supplies the
  // contact colour, becoming fully opaque where the colour gradient finishes.
  float groundBlend = smoothstep(0.0, 0.50, vY);
  // linear output: the HDR composer stays linear; the grade pass tonemaps
  outColor = vec4(lit, groundBlend);
}`;

export class GrassField {
  constructor(scene, world) {
    this.world = world;
    this.hData = new Float32Array(TEX * TEX * 4);
    this.hTex = new THREE.DataTexture(this.hData, TEX, TEX, THREE.RGBAFormat, THREE.FloatType);
    this.cData = new Uint8Array(TEX * TEX * 4).fill(255);
    this.cTex = new THREE.DataTexture(this.cData, TEX, TEX, THREE.RGBAFormat);
    this.trailData = new Uint8Array(TRAIL_TEX * TRAIL_TEX).fill(255);
    this.trailTex = new THREE.DataTexture(
      this.trailData, TRAIL_TEX, TRAIL_TEX, THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.trailTex.minFilter = this.trailTex.magFilter = THREE.LinearFilter;
    this.trailTex.generateMipmaps = false;
    this.hTex.needsUpdate = this.cTex.needsUpdate = this.trailTex.needsUpdate = true;
    this.anchor = new THREE.Vector2(1e9, 1e9);
    this.pending = new THREE.Vector2(1e9, 1e9);
    this.scratchH = new Float32Array(TEX * TEX * 4);
    this.scratchC = new Uint8Array(TEX * TEX * 4);
    this.scratchTrail = new Uint8Array(TRAIL_TEX * TRAIL_TEX).fill(255);
    this.refresh = TEX * TEX;
    this.trailBundles = new GrassTrailCache(world.seed);
    this.trailDebug = this.trailBundles.debug;
    this._trailHeight = null;
    this._lateTrailKey = null;
    this._prewarmTrailKey = null;
    this._previousPlayerX = NaN;
    this._previousPlayerZ = NaN;
    this._motionX = 0;
    this._motionZ = 0;

    // 1×1 white stand-in bound when a tier renders no shadow map, so the
    // sampler is always valid (uShadowEnabled gates the actual lookup).
    this._shadowFallback = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this._shadowFallback.needsUpdate = true;

    this.uniforms = {
      uHTex: { value: this.hTex },
      uCTex: { value: this.cTex },
      uTrailTex: { value: this.trailTex },
      uAnchor: { value: this.anchor },
      uCover: { value: COVER },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      // Cast-shadow sampling of the sun's existing depth map.
      uShadowMap: { value: this._shadowFallback },
      uPreviousShadowMap: { value: this._shadowFallback },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uPreviousShadowMatrix: { value: new THREE.Matrix4() },
      uShadowEnabled: { value: 0 },
      uShadowPacked: { value: 1 },
      uShadowBlend: { value: 1 },
      uShadowKernel: { value: 3 },
      uShadowStrength: { value: 0.0 },   // fully drop direct sun in shadow (matches terrain)
      uShadowRange: { value: 88 },       // ~ the ±95 m sun ortho box
      uShadowNormalBias: { value: 0.5 }, // lift the sample well clear of terrain
      uShadowBias: { value: -0.0016 },
      uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      ...windUniforms,
      ...caveEntranceUniforms,
      uAtmoSunDir: atmoUniforms.uAtmoSunDir,
      uAtmoSunCol: atmoUniforms.uAtmoSunCol,
      uAtmoAerial: atmoUniforms.uAtmoAerial,
      uAtmoDay: atmoUniforms.uAtmoDay,
      uAtmoTime: atmoUniforms.uAtmoTime,
      uAtmoCloudCover: atmoUniforms.uAtmoCloudCover,
      uAtmoCloudShadow: atmoUniforms.uAtmoCloudShadow,
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      glslVersion: THREE.GLSL3,   // gl_InstanceID needs GLSL ES 3.0
    });
    // single tapered blade quad (1m tall pre-scale), tip pinched in shader x-taper
    const g = new THREE.PlaneGeometry(1, 1, 1, 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) + 0.5;
      pos.setX(i, pos.getX(i) * (1 - t * 0.85));
      pos.setY(i, t);
    }
    this.mesh = new THREE.InstancedMesh(g, mat, COUNT);
    this.mesh.frustumCulled = false;      // field follows the camera anyway
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    mat.userData.excludeFromAO = true;    // thin blades: skip the GTAO prepass
    scene.add(this.mesh);
    // (meadow wildflowers live in the understory billboard layer now — the old
    // diamond-petal flower mesh that rode this field is gone)

    this._c = [0, 0, 0];
    this._railClearance = {};
    this._forceTerrainRefresh = false;
  }

  invalidateTerrain() {
    this._forceTerrainRefresh = true;
  }

  beginRefresh(anchor, bundle) {
    this.pending.set(anchor.x, anchor.z);
    this.scratchTrail.set(bundle.coverage);
    this._trailHeight = bundle.height;
    this.refresh = 0;
    this._lateTrailKey = null;
    this._prewarmTrailKey = null;
  }

  requestRequiredAnchor(playerPos, activeField) {
    const anchor = grassFieldAnchorForPlayer(playerPos.x, playerPos.z, COVER, TEX);
    const bundle = this.trailBundles.get(anchor.key);
    if (bundle) {
      this.beginRefresh(anchor, bundle);
      return true;
    }
    this.trailBundles.request(anchor, 2);
    if (activeField && this._lateTrailKey !== anchor.key) {
      this._lateTrailKey = anchor.key;
      this.trailBundles.markLate();
    }
    return false;
  }

  prewarmNextAnchor(playerPos, centerX, centerZ) {
    const vx = this._motionX, vz = this._motionZ;
    if (Math.hypot(vx, vz) < 0.25) return;
    let crossingTime = Infinity;
    if (vx > 0.05) crossingTime = Math.min(crossingTime, (centerX + 34 - playerPos.x) / vx);
    else if (vx < -0.05) crossingTime = Math.min(crossingTime, (centerX - 34 - playerPos.x) / vx);
    if (vz > 0.05) crossingTime = Math.min(crossingTime, (centerZ + 34 - playerPos.z) / vz);
    else if (vz < -0.05) crossingTime = Math.min(crossingTime, (centerZ - 34 - playerPos.z) / vz);
    if (!Number.isFinite(crossingTime) || crossingTime < 0 || crossingTime > 12) return;
    // Step a fraction beyond the boundary so the same strict >34 test and
    // world-grid rounding used at reanchor select an identical destination.
    const speed = Math.hypot(vx, vz) || 1;
    const x = playerPos.x + vx * crossingTime + vx / speed * 0.25;
    const z = playerPos.z + vz * crossingTime + vz / speed * 0.25;
    const anchor = grassFieldAnchorForPlayer(x, z, COVER, TEX);
    if (anchor.key === this._prewarmTrailKey) return;
    this._prewarmTrailKey = anchor.key;
    this.trailBundles.request(anchor, 0);
  }

  setQuality(tier) {
    const f = { potato: 0, low: 0.2, medium: 0.4, high: 0.65, ultra: 1 }[tier.name] ?? 1;
    this.mesh.count = Math.floor(COUNT * f);
    this.mesh.visible = f > 0;
  }

  update(dt, playerPos, shadow = null) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(playerPos);

    if (Number.isFinite(this._previousPlayerX) && dt > 1e-4) {
      const instantX = (playerPos.x - this._previousPlayerX) / dt;
      const instantZ = (playerPos.z - this._previousPlayerZ) / dt;
      const blend = 1 - Math.exp(-5 * dt);
      this._motionX += (instantX - this._motionX) * blend;
      this._motionZ += (instantZ - this._motionZ) * blend;
    }
    this._previousPlayerX = playerPos.x;
    this._previousPlayerZ = playerPos.z;

    // Bind the grass's compact, double-buffered shadow cache (see main.js).
    // The previous and current snapshots crossfade after each guarded refresh,
    // avoiding both crawling live-map edges and hard four-second transitions.
    if (shadow && shadow.enabled && shadow.texture && shadow.previousTexture) {
      u.uShadowMap.value = shadow.texture;
      u.uPreviousShadowMap.value = shadow.previousTexture;
      u.uShadowMatrix.value.copy(shadow.matrix);
      u.uPreviousShadowMatrix.value.copy(shadow.previousMatrix);
      u.uShadowTexel.value.set(1 / shadow.mapSize, 1 / shadow.mapSize);
      const worldTexel = shadow.worldSize / shadow.mapSize;
      u.uShadowKernel.value = 0.72 / worldTexel;
      u.uShadowRange.value = shadow.range;
      u.uShadowPacked.value = shadow.packed ? 1 : 0;
      u.uShadowBlend.value = shadow.blend;
      u.uShadowEnabled.value = 1;
    } else {
      u.uShadowMap.value = this._shadowFallback;
      u.uPreviousShadowMap.value = this._shadowFallback;
      u.uShadowBlend.value = 1;
      u.uShadowEnabled.value = 0;
    }

    // Re-anchor when the player nears the field edge — but DOUBLE-BUFFERED:
    // the new field is painted into scratch arrays over many frames while the
    // shader keeps rendering the old anchor+textures, then swapped atomically.
    // (Swapping uAnchor immediately made the whole field jump/blank for the
    // ~23 frames the repaint took — a visible reset every few dozen metres.)
    const done = this.refresh >= TEX * TEX;
    const cx = this.anchor.x + COVER / 2, cz = this.anchor.y + COVER / 2;
    const activeField = Math.abs(this.anchor.x) < 1e8 && Math.abs(this.anchor.y) < 1e8;
    const offsetX = activeField ? Math.abs(playerPos.x - cx) : Infinity;
    const offsetZ = activeField ? Math.abs(playerPos.z - cz) : Infinity;
    if (done && this._forceTerrainRefresh) {
      this._forceTerrainRefresh = false;
      this.requestRequiredAnchor(playerPos, activeField);
    } else if (done && (!activeField || offsetX > 34 || offsetZ > 34)) {
      this.requestRequiredAnchor(playerPos, activeField);
    } else if (done && Math.max(offsetX, offsetZ) > 14) {
      this.prewarmNextAnchor(playerPos, cx, cz);
    }
    // incremental texel refresh into the scratch buffers (pending anchor)
    if (this.refresh < TEX * TEX) {
      const end = Math.min(this.refresh + TPF, TEX * TEX);
      const world = this.world;
      for (let i = this.refresh; i < end; i++) {
        const xi = i % TEX, zi = (i / TEX) | 0;
        const wx = this.pending.x + (xi / (TEX - 1)) * COVER;
        const wz = this.pending.y + (zi / (TEX - 1)) * COVER;
        const b = world.biomeAt(wx, wz);
        let dens = 0;
        let trailHeight = 1;
        if (b.h > WATER_LEVEL + 0.5 && b.slope <= 0.42) {
          dens = (GRASS_DENSITY[b.id] || 0) * (0.85 + world.openFactor(wx, wz) * 0.5);
          // Keep the active beach and wet strand bare. Temperate beach grass
          // belongs on the dry upper shore, with dense marram-like cover on
          // dunes and much sparser tufts on shingle and rocky coasts.
          if (b.id === 'beach') {
            if (b.h < WATER_LEVEL + 1.25) dens = 0;
            else if (b.coastType === 'dune') dens *= 1.25;
            else if (b.coastType === 'shingle') dens *= 0.38;
            else dens *= 0.65;
          }
          if (dens > 0 && world.riverAt(wx, wz).wet) dens = 0;
          // blanket grass ONLY in the low, gentle meadows & rolling hills; it
          // fades out as the terrain rises/steepens into the foothills (where
          // the CPU patch grass takes over) and is gone on the mountains.
          dens *= (1 - smoothstep(38, 72, b.h)) * (1 - smoothstep(0.18, 0.33, b.slope));
          // thin the blanket grass under forest canopy: groves are floored with
          // understory + leaf litter + shade, not open meadow grass
          dens *= 1 - 0.85 * world.groveFactor(wx, wz);
          if (dens > 0 && world.railwayClearanceAt) {
            const railway = world.railwayClearanceAt(wx, wz, this._railClearance);
            dens *= 1 - railway.grassClearance;
          }
          if (this._trailHeight) trailHeight = this._trailHeight[i] / 255;
        }
        this.scratchH[i * 4] = b.h;
        this.scratchH[i * 4 + 1] = dens;
        this.scratchH[i * 4 + 2] = trailHeight;
        // Cache the real terrain pigment so the blade base can match it exactly.
        groundColor(world, wx, wz, b.h, b.slope, b.t, b.m, this._c);
        const c = this._c;
        this.scratchC[i * 4] = c[0] * 255; this.scratchC[i * 4 + 1] = c[1] * 255; this.scratchC[i * 4 + 2] = c[2] * 255;
      }
      this.refresh = end;
      if (this.refresh >= TEX * TEX) {
        // atomic swap: textures + anchor change in the same frame
        this.hData.set(this.scratchH);
        this.cData.set(this.scratchC);
        this.trailData.set(this.scratchTrail);
        this.hTex.needsUpdate = this.cTex.needsUpdate = this.trailTex.needsUpdate = true;
        this.anchor.copy(this.pending);
        this._trailHeight = null;
      }
    }
  }
}
