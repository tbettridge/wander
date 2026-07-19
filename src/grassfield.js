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
import { trailsAround, trailEcologyAt } from './trails.js';
import { caveEntranceUniforms, CAVE_EXCLUSION_GLSL } from './cavevisual.js';

const TEX = 96;        // data texture resolution (TEX² texels)
const COVER = 260;     // metres of world covered by the field
const COUNT = 960000;  // max blades (tier-scaled via mesh.count)
const TPF = 400;       // texels refreshed per frame (bounds main-thread cost)

const VERT = /* glsl */`
uniform sampler2D uHTex;   // R = ground height, G = density, B = trail height scale
uniform sampler2D uCTex;   // grass tint per texel
uniform vec2 uAnchor;      // field min corner (world xz)
uniform float uCover;
uniform vec3 uCam;
uniform float uTime;
${WIND_GLSL_DECLS}
${CAVE_EXCLUSION_GLSL}
varying vec3 vGroundCol;
varying float vY;
varying vec3 vWPos;
varying float vShim;
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
  float dist = distance(base, uCam.xz);
  // keep-test: density thins with distance; field edge fades to nothing
  float keep = dens * (1.0 - smoothstep(uCover * 0.26, uCover * 0.48, dist) * 0.9);
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
  gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
}`;

const FRAG = /* glsl */`
layout(location = 0) out highp vec4 outColor;
uniform vec3 uAtmoSunDir, uAtmoSunCol, uAtmoAerial;
uniform float uAtmoDay, uAtmoTime, uAtmoCloudCover, uAtmoCloudShadow;
uniform vec2 uWindOffset;
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
  vec3 lit = blade * (uAtmoSunCol * max(uAtmoSunDir.y, 0.0) * 1.3 + vec3(0.22 + 0.16 * uAtmoDay));
  lit *= 1.0 + vShim * 0.16 * uAtmoDay;   // gust-front light band
  // Do not darken the root: it must retain the same light response as the
  // ground. A very small tip lift keeps the blade shape readable.
  lit *= 1.0 + 0.05 * vY;
  // Same weather-driven, wind-carried cloud field as the terrain/vegetation.
  vec2 cp = (vWPos.xz - uWindOffset * 0.70) * 0.0016;
  float threshold = mix(0.70, 0.38, uAtmoCloudCover);
  float cloudMask = smoothstep(threshold - 0.08, threshold + 0.08, gfFbm(cp));
  lit *= 1.0 - cloudMask * (0.40 * uAtmoCloudShadow * uAtmoDay);
  // aerial haze with distance
  float d = length(cameraPosition - vWPos);
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
    this.hTex.needsUpdate = this.cTex.needsUpdate = true;
    this.anchor = new THREE.Vector2(1e9, 1e9);
    this.pending = new THREE.Vector2(1e9, 1e9);
    this.scratchH = new Float32Array(TEX * TEX * 4);
    this.scratchC = new Uint8Array(TEX * TEX * 4);
    this.refresh = TEX * TEX;

    this.uniforms = {
      uHTex: { value: this.hTex },
      uCTex: { value: this.cTex },
      uAnchor: { value: this.anchor },
      uCover: { value: COVER },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
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
    this._trailEco = {};
  }

  setQuality(tier) {
    const f = { potato: 0, low: 0.2, medium: 0.4, high: 0.65, ultra: 1 }[tier.name] ?? 1;
    this.mesh.count = Math.floor(COUNT * f);
    this.mesh.visible = f > 0;
  }

  update(dt, playerPos) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(playerPos);

    // Re-anchor when the player nears the field edge — but DOUBLE-BUFFERED:
    // the new field is painted into scratch arrays over many frames while the
    // shader keeps rendering the old anchor+textures, then swapped atomically.
    // (Swapping uAnchor immediately made the whole field jump/blank for the
    // ~23 frames the repaint took — a visible reset every few dozen metres.)
    const done = this.refresh >= TEX * TEX;
    const cx = this.anchor.x + COVER / 2, cz = this.anchor.y + COVER / 2;
    if (done && (Math.abs(playerPos.x - cx) > 34 || Math.abs(playerPos.z - cz) > 34)) {
      const texel = COVER / (TEX - 1);   // world-aligned texel grid: identical
      this.pending.set(                   // height samples across swaps (no wiggle)
        Math.round((playerPos.x - COVER / 2) / texel) * texel,
        Math.round((playerPos.z - COVER / 2) / texel) * texel
      );
      this.refresh = 0;
      this._trails = this._trails || [];
      trailsAround(this.world, this.pending.x + COVER / 2, this.pending.y + COVER / 2,
        this.world.seed, COVER * 0.6, this._trails);
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
          if (dens > 0 && world.riverAt(wx, wz).wet) dens = 0;
          // blanket grass ONLY in the low, gentle meadows & rolling hills; it
          // fades out as the terrain rises/steepens into the foothills (where
          // the CPU patch grass takes over) and is gone on the mountains.
          dens *= (1 - smoothstep(38, 72, b.h)) * (1 - smoothstep(0.18, 0.33, b.slope));
          // thin the blanket grass under forest canopy: groves are floored with
          // understory + leaf litter + shade, not open meadow grass
          dens *= 1 - 0.85 * world.groveFactor(wx, wz);
          if (this._trails && this._trails.length) {
            const eco = trailEcologyAt(this._trails, wx, wz, this._trailEco);
            if (eco.zone !== 'none') {
              dens *= eco.grassDensity;
              trailHeight = eco.grassHeight;
            }
          }
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
        this.hTex.needsUpdate = this.cTex.needsUpdate = true;
        this.anchor.copy(this.pending);
      }
    }
  }
}
