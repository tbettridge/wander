// Ocean / lake surface. A single plane that follows the player, shaded with
// animated noise-gradient ripples, Fresnel sky reflection, sun glint, and
// depth-based colour + shore foam. Depth comes from a small floating-point
// height texture around the player, refreshed incrementally from the world
// model (a few hundred samples per frame, never a hitch).

import * as THREE from 'three';
import { WATER_LEVEL } from './world.js';
import { waterUniforms, WATER_COMMON_GLSL } from './watercommon.js';

const TEX_SIZE = 320;
const COVERAGE = 2000; // metres covered by the height texture (~6.3 m/texel)
const TEXELS_PER_FRAME = 2000;

// Coarse far-field height texture: covers the whole visible ocean plane so the
// soft-alpha shoreline fade works at ANY distance. Without it, coasts beyond
// the fine texture were resolved purely by the depth buffer against the far
// terrain mesh (which is sunk ~1.5 m, i.e. near-coplanar with the sea along
// every distant shoreline) — a wide shimmering z-fight band from any lookout.
const COARSE_SIZE = 256;
const COARSE_COVERAGE = 12000; // ~47 m/texel — plenty for a 1.5 m alpha ramp
const COARSE_TEXELS_PER_FRAME = 2400;

const VERT = /* glsl */`
uniform float uTide, uNearField;
varying vec3 vWP;
varying float vFar;
void main() {
  // Freeze the tide in the far field: beyond the streamed chunks the plane
  // eases back to mean sea level. A ±18 cm tide is imperceptible at 1 km, but
  // on near-flat distant coasts it sweeps the waterline across hundreds of
  // metres — huge bands of sea pulsing in and out. Near water still breathes.
  vFar = smoothstep(uNearField * 0.9, uNearField * 1.15, length(position.xy));
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y -= uTide * vFar;
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = WATER_COMMON_GLSL + /* glsl */`
uniform float uCoverage, uWaterLevel, uNearField;
uniform vec2 uTexCenter, uCoarseCenter;
uniform float uCoarseCoverage;
uniform sampler2D uHeightTex, uCoarseTex;
varying vec3 vWP;
varying float vFar;

void main() {
  vec2 p = vWP.xz;
  float t = uTime;
  vec3 V = normalize(cameraPosition - vWP);

  // wave field + surface normal — the shared open-water surface (wcOceanH),
  // which the river shader converges to at distance so deltas are seamless
  float h0 = wcOceanH(p, t);
  vec3 N = wcOceanNormal(p, t);

  // terrain depth under this fragment. Fine texture near the player; a coarse
  // texture covering the whole plane takes over beyond it, so the shoreline
  // fade below never runs out of data at distant coasts. The sea level
  // rises/falls with the tide, so depth breathes and the whole shore band
  // migrates in and out.
  vec2 uvT = (p - uTexCenter) / uCoverage + 0.5;
  float th = -50.0, thX = -50.0, thZ = -50.0, coastCode = 0.0;
  bool inTex = uvT.x > 0.0 && uvT.x < 1.0 && uvT.y > 0.0 && uvT.y < 1.0;
  if (inTex) {
    float tx = 2.0 / ${TEX_SIZE}.0;                 // ~2-texel offsets for the shore gradient
    vec2 fineCoast = texture2D(uHeightTex, uvT).rg;
    th  = fineCoast.r;
    coastCode = fineCoast.g;
    thX = texture2D(uHeightTex, uvT + vec2(tx, 0.0)).r;
    thZ = texture2D(uHeightTex, uvT + vec2(0.0, tx)).r;
  }
  vec2 uvC = clamp((p - uCoarseCenter) / uCoarseCoverage + 0.5, 0.0, 1.0);
  vec2 coarseCoast = texture2D(uCoarseTex, uvC).rg;
  float thC = coarseCoast.r;
  // blend fine → coarse over the fine texture's outer edge so the two never pop
  float cheb = max(abs(uvT.x - 0.5), abs(uvT.y - 0.5));
  float fineW = inTex ? 1.0 - smoothstep(0.30, 0.48, cheb) : 0.0;
  th = mix(thC, th, fineW);
  coastCode = mix(coarseCoast.g, coastCode, fineW);
  // tide contribution matches the vertex displacement: full near, zero far
  float depth = (uWaterLevel + uTide * (1.0 - vFar)) - th;

  float dayLight = wcDayLight();
  vec3 waterCol = wcPalette(smoothstep(0.5, 9.0, depth), 0.0);
  float chalkCoast = smoothstep(0.64, 0.77, coastCode);
  float rockyCoast = smoothstep(0.43, 0.56, coastCode) * (1.0 - chalkCoast);
  float shingleCoast = smoothstep(0.28, 0.39, coastCode) * (1.0 - smoothstep(0.50, 0.58, coastCode));
  vec3 shallowCoast = vec3(0.20, 0.40, 0.34);
  shallowCoast = mix(shallowCoast, vec3(0.17, 0.31, 0.34), rockyCoast * 0.78 + shingleCoast * 0.45);
  shallowCoast = mix(shallowCoast, vec3(0.30, 0.55, 0.52), chalkCoast * 0.88);
  waterCol = mix(waterCol, shallowCoast * dayLight,
    (1.0 - smoothstep(0.35, 5.5, depth)) * 0.52);

  float fres = wcFresnel(N, V);
  vec3 col = mix(waterCol, wcSkyReflect(N, V), fres);
  col += wcGlint(N, V);

  // breaking foam where the water shallows out, animated and noise-broken
  float exposedCoast = smoothstep(0.43, 0.76, coastCode);
  float shoreExposure = mix(0.78, 1.25, exposedCoast);
  float foamBand = 1.0 - smoothstep(0.05, mix(1.25, 2.0, exposedCoast), depth + h0 * 0.45);
  float foamTex = wcFbm(p * 1.4 + vec2(t * 0.10, -t * 0.07));
  float foam = foamBand * smoothstep(0.45, 0.7, foamTex + foamBand * 0.55);

  // rolling breakers: low-frequency crests marching shoreward. Crest phase is
  // keyed to DEPTH, not to dot(p, shoreDir) — bilinear filtering makes the
  // texture's gradient piecewise-constant per texel, so direction-based bands
  // staircased into pixelated diamonds; depth itself interpolates smoothly, so
  // depth-contour crests hug the bathymetry in clean curves. The gradient is
  // still used (magnitude only) to gate breakers to beach-ish slopes.
  if (inTex && depth > 0.05 && depth < 6.0) {
    vec2 g = vec2(thX - th, thZ - th);
    float gl = length(g);
    if (gl > 1e-4) {
      float bandA = sin(depth * 4.25 - t * 1.18) * 0.5 + 0.5;
      float bandB = sin(depth * 6.4 - t * 1.62 + 1.7) * 0.5 + 0.5;
      float band = max(pow(bandA, 3.2), pow(bandB, 5.0) * 0.48);
      float slopeF = smoothstep(0.015, 0.09, gl);     // needs a beach-ish slope
      float shallowF = smoothstep(5.0, 0.4, depth);   // strongest near the shore
      float streak = smoothstep(0.35, 0.75, wcFbm(p * 0.6 - vec2(t * 0.35, t * 0.28)));
      float broken = 0.72 + 0.28 * wcNoise(p * 0.19 + vec2(t * 0.04, -t * 0.025));
      foam = max(foam, band * slopeF * shallowF * streak * broken * shoreExposure);
    }
  }
  col = mix(col, vec3(0.93, 0.96, 0.97) * dayLight, clamp(foam, 0.0, 1.0));

  // sun-dappled caustics: bright filaments dancing on the shallow seabed where
  // two drifting noise fields agree (a cheap voronoi-web stand-in), fading out
  // by ~1.3 m of depth and gone at night.
  if (inTex && depth > 0.04 && depth < 1.35) {
    vec2 cq = p * 1.9;
    float ca1 = wcNoise(cq + vec2(t * 0.14, -t * 0.11));
    float ca2 = wcNoise(cq * 1.83 - vec2(t * 0.16, t * 0.09));
    float web = 1.0 - abs(ca1 - ca2) * 2.4;
    float caust = smoothstep(0.62, 0.97, web) * smoothstep(1.35, 0.30, depth) * uDay;
    col += uSunColor * caust * 0.5;
  }

  float alpha = mix(0.55, 0.93, smoothstep(0.0, 6.0, depth));
  alpha = max(alpha, fres * 0.9);
  alpha = max(alpha, foam);
  // at range the sea reads as an opaque surface — hides the dark wet seabed
  // that otherwise bleeds through over channels/deeps and breaks the "one
  // flat blue" read against the (equally opaque-at-range) river
  alpha = mix(alpha, 0.93, smoothstep(250.0, 650.0, length(cameraPosition - vWP)));
  // soft waterline: fade to nothing over the last ~25 cm of depth so the sea
  // dissolves into the wet sand instead of a coplanar edge contesting the beach
  // (fixes the z-fighting shimmer) — the blend does the antialiasing.
  // Beyond the streamed chunks the ground is the far-terrain mesh, which is
  // sunk 1.5 m — so terrain up to 1.5 m above sea level renders near-coplanar
  // with this plane. Shift + widen the fade there so the water is fully gone
  // before that ambiguity, killing the wide flickering band at distant coasts.
  // Two separate widenings, one shared fade:
  //  - degraded height data (fine→coarse blend) WIDENS the fade so 47 m texels
  //    that can't resolve sandbars don't hand the contest to the depth buffer;
  //  - only the far-terrain sink SHIFTS it negative (that land really does
  //    render below the plane out there). Shifting it over real chunks painted
  //    a ghost water sheet onto sandbars that sit above the waterline.
  float dataW = smoothstep(0.30, 0.48, cheb);
  alpha *= smoothstep(mix(0.0, -1.0, vFar), mix(0.25, 0.6, max(dataW, vFar)), depth);

  // distance sheen: distant water reads as pale reflected sky long before fog
  // range — lifts deep channels/bays to the same pale blue as the far sea so
  // all water at range converges to ONE tone (the river applies the same term)
  float wDist = length(cameraPosition - vWP);
  col = mix(col, uSkyHorizon, smoothstep(300.0, 1200.0, wDist) * 0.55);

  gl_FragColor = vec4(wcApplyAir(col, vWP, wDist), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaterSystem {
  constructor(scene, world) {
    this.world = world;

    this.heights = new Float32Array(TEX_SIZE * TEX_SIZE * 2).fill(-50);
    this.tex = new THREE.DataTexture(
      this.heights, TEX_SIZE, TEX_SIZE, THREE.RGFormat, THREE.FloatType
    );
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;

    this.texCenter = new THREE.Vector2(1e9, 1e9); // force initial refresh
    this.refreshIndex = TEX_SIZE * TEX_SIZE;

    this.coarseHeights = new Float32Array(COARSE_SIZE * COARSE_SIZE * 2).fill(-50);
    this.coarseTex = new THREE.DataTexture(
      this.coarseHeights, COARSE_SIZE, COARSE_SIZE, THREE.RGFormat, THREE.FloatType
    );
    this.coarseTex.minFilter = THREE.LinearFilter;
    this.coarseTex.magFilter = THREE.LinearFilter;
    this.coarseTex.needsUpdate = true;

    this.coarseCenter = new THREE.Vector2(1e9, 1e9); // force initial refresh
    this.coarseIndex = COARSE_SIZE * COARSE_SIZE;
    this.primed = false; // first update() fills both textures completely

    this.uniforms = {
      ...waterUniforms,   // shared look/lighting, updated by updateWaterCommon
      uWaterLevel: { value: WATER_LEVEL },
      uCoverage: { value: COVERAGE },
      uTexCenter: { value: this.texCenter },
      uHeightTex: { value: this.tex },
      uCoarseCenter: { value: this.coarseCenter },
      uCoarseCoverage: { value: COARSE_COVERAGE },
      uCoarseTex: { value: this.coarseTex },
      uNearField: { value: 800 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      // belt-and-braces against grazing-angle z-fighting where near-coplanar
      // with beaches; kept gentle — too strong and the sea punches through
      // land that sits just above the waterline.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    // segmented so the vertex shader can ease the far field back to mean sea
    // level (the tide-freeze above) — a flat 2-triangle plane can't bend
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 128, 128), mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = WATER_LEVEL - 0.02;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  update(dt, playerPos) {
    // lighting/fog/time are driven by updateWaterCommon (shared with rivers);
    // this only maintains the ocean's depth texture + follows the player and
    // rises/falls with the tide (which the fragment shader also reads for depth).
    this.mesh.position.x = playerPos.x;
    this.mesh.position.z = playerPos.z;
    this.mesh.position.y = WATER_LEVEL - 0.02 + this.uniforms.uTide.value;

    // Prime: on the very first frame, fill BOTH depth textures completely in one
    // pass (rather than the incremental ~78-frame drip). This runs while the
    // loading overlay is still up, so its one-off cost is invisible — and it
    // means the ocean shows correct depth, shorelines and the shared delta look
    // from the first frame the player sees. Without it, on a CPU-saturated cold
    // load the incremental fill takes ~8-10 s at low FPS, during which the sea
    // reads its -50 init (deep everywhere: no shore fade, hard coplanar coasts,
    // stark delta) and then visibly "pops in" the moment it finishes.
    if (!this.primed) {
      this.primed = true;
      this.texCenter.set(Math.round(playerPos.x / 50) * 50, Math.round(playerPos.z / 50) * 50);
      this.coarseCenter.set(Math.round(playerPos.x / 100) * 100, Math.round(playerPos.z / 100) * 100);
      this._fill(this.heights, TEX_SIZE, this.texCenter, COVERAGE, 0, TEX_SIZE * TEX_SIZE);
      this._fill(this.coarseHeights, COARSE_SIZE, this.coarseCenter, COARSE_COVERAGE, 0, COARSE_SIZE * COARSE_SIZE);
      this.refreshIndex = TEX_SIZE * TEX_SIZE;
      this.coarseIndex = COARSE_SIZE * COARSE_SIZE;
      this.tex.needsUpdate = true;
      this.coarseTex.needsUpdate = true;
      return;
    }

    // recenter the depth texture when the player strays from its middle
    const dx = playerPos.x - this.texCenter.x, dz = playerPos.z - this.texCenter.y;
    if (dx * dx + dz * dz > 300 * 300) {
      this.texCenter.set(
        Math.round(playerPos.x / 50) * 50,
        Math.round(playerPos.z / 50) * 50
      );
      this.refreshIndex = 0;
    }
    // incremental refresh: a few hundred height samples per frame
    if (this.refreshIndex < TEX_SIZE * TEX_SIZE) {
      const end = Math.min(this.refreshIndex + TEXELS_PER_FRAME, TEX_SIZE * TEX_SIZE);
      this._fill(this.heights, TEX_SIZE, this.texCenter, COVERAGE, this.refreshIndex, end);
      this.refreshIndex = end;
      this.tex.needsUpdate = true;
    }

    // coarse far-field texture: same scheme, much bigger footprint, recenters
    // rarely (its margin over the 9000 m plane allows ~1500 m of player drift)
    const cdx = playerPos.x - this.coarseCenter.x, cdz = playerPos.z - this.coarseCenter.y;
    if (cdx * cdx + cdz * cdz > 1200 * 1200) {
      this.coarseCenter.set(
        Math.round(playerPos.x / 100) * 100,
        Math.round(playerPos.z / 100) * 100
      );
      this.coarseIndex = 0;
    }
    if (this.coarseIndex < COARSE_SIZE * COARSE_SIZE) {
      const end = Math.min(this.coarseIndex + COARSE_TEXELS_PER_FRAME, COARSE_SIZE * COARSE_SIZE);
      this._fill(this.coarseHeights, COARSE_SIZE, this.coarseCenter, COARSE_COVERAGE, this.coarseIndex, end);
      this.coarseIndex = end;
      this.coarseTex.needsUpdate = true;
    }
  }

  // sample world height into a depth-texture row range [start, end)
  _fill(arr, N, center, coverage, start, end) {
    for (let i = start; i < end; i++) {
      const xi = i % N, zi = (i / N) | 0;
      const wx = center.x + (xi / (N - 1) - 0.5) * coverage;
      const wz = center.y + (zi / (N - 1) - 0.5) * coverage;
      arr[i * 2] = this.world.height(wx, wz);
      arr[i * 2 + 1] = this.world.coastCodeAt(wx, wz);
    }
  }

  // extent of the streamed chunks (set by the quality tier): beyond this the
  // visible ground is the sunk far-terrain mesh, so the shader widens/offsets
  // the shoreline alpha fade to match.
  setNearField(d) {
    this.uniforms.uNearField.value = d;
  }
}
