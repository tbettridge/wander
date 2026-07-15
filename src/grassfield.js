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
import { GRASS_COLORS, GRASS_DENSITY } from './vegdata.js';
import { WATER_LEVEL } from './world.js';
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
varying vec3 vCol;
varying float vY;
varying vec3 vWPos;
varying float vShim;
float gh(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float id = float(gl_InstanceID);
  // WORLD-FIXED toroidal lattice: each blade has a fixed world position that
  // repeats every uCover metres; we render the copy nearest the camera. Blade
  // positions therefore never move as the player walks — they only wrap at
  // >uCover/2 away, where the distance fade has already culled them. (Deriving
  // positions from the anchor made the whole field reshuffle at each re-anchor
  // — invisible on flat grass, an obvious pop in the foothills.)
  vec2 seed = vec2(gh(id * 1.31 + 1.7), gh(id * 2.73 + 9.2)) * uCover;
  vec2 base = seed + uCover * floor((uCam.xz - seed) / uCover + 0.5);
  vec2 uvT = clamp((base - uAnchor) / uCover, 0.0, 1.0);
  vec4 ht = texture2D(uHTex, uvT);
  float h = ht.r, dens = ht.g, trailHeight = max(ht.b, 0.05);
  float dist = distance(base, uCam.xz);
  // keep-test: density thins with distance; field edge fades to nothing
  float keep = dens * (1.0 - smoothstep(uCover * 0.26, uCover * 0.48, dist) * 0.9);
  keep *= 1.0 + (1.0 - smoothstep(5.0, 45.0, dist));   // double density near the player
  // smooth threshold: blades near their cutoff scale up/down gradually as
  // keep changes with distance — no pop-in/pop-out
  float ok = clamp((keep - gh(id * 3.77 + 0.13)) * 5.0, 0.0, 1.0);
  // far blades grow wider/taller so sparser coverage still reads dense
  float far = smoothstep(30.0, uCover * 0.45, dist);
  float s = (0.45 + 0.55 * gh(id * 5.13)) * ok * (1.0 - caveEntranceMask(base));
  vec3 p = vec3(position.x * 0.11 * (1.0 + far * 2.2), position.y * s * (1.5 + far * 0.5) * trailHeight, 0.0);
  float yaw = gh(id * 7.71) * 6.2831;
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
  vCol = texture2D(uCTex, uvT).rgb * (0.55 + 0.4 * gh(id * 9.31));
  vY = position.y;
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
varying vec3 vCol;
varying float vY;
varying vec3 vWPos;
varying float vShim;
void main() {
  // lit like the ground beneath (up-facing lambert) + hemisphere ambient
  vec3 lit = vCol * (uAtmoSunCol * max(uAtmoSunDir.y, 0.0) * 1.3 + vec3(0.22 + 0.16 * uAtmoDay));
  lit *= 1.0 + vShim * 0.16 * uAtmoDay;   // gust-front light band
  lit *= 0.8 + 0.25 * vY;   // slight base-to-tip AO gradient
  // Same weather-driven, wind-carried cloud field as the terrain/vegetation.
  vec2 cp = (vWPos.xz - uWindOffset * 0.70) * 0.0016;
  float threshold = mix(0.70, 0.38, uAtmoCloudCover);
  float cloudMask = smoothstep(threshold - 0.08, threshold + 0.08, gfFbm(cp));
  lit *= 1.0 - cloudMask * (0.40 * uAtmoCloudShadow * uAtmoDay);
  // aerial haze with distance
  float d = length(cameraPosition - vWPos);
  float a = (1.0 - exp(-max(d - 300.0, 0.0) * 0.0003)) * 0.55 * uAtmoDay;
  lit = mix(lit, uAtmoAerial, clamp(a, 0.0, 0.55));
  // linear output: the HDR composer stays linear; the grade pass tonemaps
  outColor = vec4(lit, 1.0);
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
        const c = GRASS_COLORS[b.id] || this._c;
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
