// Painted-light options for the Ghibli look (debug panel → "Ghibli look").
//
// Wander's existing painterly passes (the grade's value grouping, the foliage
// painter) work from a pixel's FINAL brightness, so a dark leaf in full sun is
// treated as if it were in shade. The options here work inside the lighting:
//
//   light bands   — the sun's light on every built-in lit material (terrain,
//                   buildings, foliage, NPCs) is split into a few soft steps,
//                   and the darker steps are tinted toward a cool shadow
//                   pigment rather than simply dimmed. That hue shift in shade
//                   is most of what separates painted cel light from 3D.
//   fill lights   — the anime background rig: a strong cool, shadowless fill
//                   from the side opposite the sun, a weak light from below,
//                   and a violet ground tint on the sky ambient, so shadows
//                   are coloured rather than dark.
//   canopy style  — treetops that cast shadows but neither receive them nor
//                   darken on their turned-away cards (flat high-key masses
//                   instead of mottled lumps),
//                   and a simplify control that merges leaf cards into
//                   smoother painted clumps.
//
// Everything defaults OFF and is opt-in from the panel; choices persist.

import * as THREE from 'three';

// v2: only choices that differ from DEFAULTS are stored. v1 saved every value
// on every load, which pinned anyone who had ever opened the game to the
// defaults of that day.
const STORAGE_KEY = 'wander.ghibliStyle.v2';

// The tuned look, on by default (chosen 2026-10-08). Saved choices from the
// debug panel still override these; "reset painted-light options" returns here.
const DEFAULTS = Object.freeze({
  lightBands: true,
  bandStrength: 0.85,
  bands: 3,
  bandSoftness: 0.35,
  bandLift: 0.22,
  bandTint: '#8a7fc0',
  fillLight: true,
  fillIntensity: 0.9,
  fillColor: '#a9bdf5',
  bounceIntensity: 0.3,
  groundViolet: 0.41,
  canopyUnshadowed: true,
  foliageSimplify: 1,
  grassCoverage: 0.79,
  inkCurvature: true,
  inkStrength: 0.65,
});

// --- light bands: one shared struct uniform on the built-in lit shaders -----
//
// A struct uniform's value is a plain object, which three copies BY REFERENCE
// when it clones a built-in material's uniforms, so every material in the
// world reads this one object and a slider moves them all at once.
export const lightBand = {
  strength: 0,
  bands: DEFAULTS.bands,
  softness: DEFAULTS.bandSoftness,
  lift: DEFAULTS.bandLift,
  tint: new THREE.Color(DEFAULTS.bandTint),
};

const BAND_DECLS = /* glsl */`
#define WANDER_LIGHT_BAND
struct WanderLightBand { float strength; float bands; float softness; float lift; vec3 tint; };
uniform WanderLightBand wanderLightBand;
`;

// Inserted just before each directional light's RE_Direct. `wanderLitColor`
// is the light before its shadow. Bands are chosen the way a toon ramp chooses
// them — half-Lambert × shadow — so a face turned to the sun lands in the top
// band at full strength and only genuinely turned-away or shadowed faces step
// down. Each step is a flat level (`bands` levels from shade to light), and
// the lower ones are tinted toward the shadow pigment. The banded diffuse is
// added directly (it is defined on back faces too, which is how a lifted,
// tinted shade band can exist) and the physical term fades by the same
// strength. Only the first directional light — the sun, which three sorts
// first as the shadow caster — is lifted in its darkest band.
const BAND_APPLY = /* glsl */`
#ifdef WANDER_LIGHT_BAND
if ( wanderLightBand.strength > 0.0 ) {
	float wHalf = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5 );
	float wPeak = max( max( wanderLitColor.r, wanderLitColor.g ), max( wanderLitColor.b, 1e-5 ) );
	float wShade = max( max( directLight.color.r, directLight.color.g ), directLight.color.b ) / wPeak;
	float wSteps = max( wanderLightBand.bands, 2.0 );
	float wX = min( wHalf * wShade * wSteps, wSteps - 0.001 );
	float wEdge = clamp( wanderLightBand.softness, 0.001, 1.0 ) * 0.5;
	float wBand = min( floor( wX ) + smoothstep( 1.0 - wEdge, 1.0, fract( wX ) ), wSteps - 1.0 ) / ( wSteps - 1.0 );
	#if UNROLLED_LOOP_INDEX == 0
	float wLevel = mix( wanderLightBand.lift, 1.0, wBand );
	#else
	float wLevel = wBand;
	#endif
	vec3 wTint = mix( wanderLightBand.tint, vec3( 1.0 ), wBand );
	reflectedLight.directDiffuse += wanderLightBand.strength * wLevel * wTint * wanderLitColor
		* BRDF_Lambert( material.diffuseColor );
	directLight.color *= 1.0 - wanderLightBand.strength;
}
#endif
`;

let bandsInstalled = false;
/** Patch three's built-in lit shaders. Must run before any material compiles. */
export function installLightBands() {
  if (bandsInstalled) return true;
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const declare = 'DirectionalLight directionalLight;';
  const info = 'getDirectionalLightInfo( directionalLight, directLight );';
  const infoAt = chunk.indexOf(info);
  const reAt = infoAt < 0 ? -1 : chunk.indexOf('RE_Direct(', infoAt);
  if (!chunk.includes(declare) || infoAt < 0 || reAt < 0) {
    console.warn('[ghibli] light bands unavailable: three\'s lights_fragment_begin no longer matches.');
    return false;
  }
  const lineStart = chunk.lastIndexOf('\n', reAt) + 1;
  let patched = chunk.slice(0, lineStart) + BAND_APPLY + chunk.slice(lineStart);
  patched = patched.replace(info, `${info}\n\t\t#ifdef WANDER_LIGHT_BAND\n\t\twanderLitColor = directLight.color;\n\t\t#endif`);
  patched = patched.replace(declare, `${declare}\n\t#ifdef WANDER_LIGHT_BAND\n\tvec3 wanderLitColor;\n\t#endif`);
  THREE.ShaderChunk.lights_fragment_begin = patched;
  // Only three's own lit materials opt in, so custom ShaderMaterials that pull
  // in the lighting chunks are untouched.
  for (const name of ['lambert', 'phong', 'standard', 'physical', 'toon']) {
    const lib = THREE.ShaderLib[name];
    if (!lib) continue;
    lib.fragmentShader = BAND_DECLS + lib.fragmentShader;
    lib.uniforms.wanderLightBand = { value: lightBand };
  }
  bandsInstalled = true;
  return true;
}

// --- canopy style -------------------------------------------------------------
export const canopyUniforms = {
  unshadowed: { value: false },
  simplify: { value: 0 },
};

// The simplified leaf reads its colour and coverage from a coarser mip, so the
// card's individual leaves merge into one soft clump with closed gaps — fewer,
// calmer shapes for the eye and for the ink pass.
const SIMPLIFIED_MAP = /* glsl */`
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	if ( uWanderFoliageSimplify > 0.001 ) {
		vec4 wClump = texture2D( map, vMapUv, uWanderFoliageSimplify * 2.5 );
		sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, wClump.rgb, uWanderFoliageSimplify );
		sampledDiffuseColor.a = mix( sampledDiffuseColor.a, smoothstep( 0.16, 0.40, wClump.a ), uWanderFoliageSimplify );
	}
	diffuseColor *= sampledDiffuseColor;
#endif
`;

/** Treetop shadow + simplify controls for a canopy material. */
export function injectCanopyStyle(material) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous.call(material, shader, renderer);
    shader.uniforms.uWanderCanopyUnshadowed = canopyUniforms.unshadowed;
    shader.uniforms.uWanderFoliageSimplify = canopyUniforms.simplify;
    shader.fragmentShader = 'uniform bool uWanderCanopyUnshadowed;\nuniform float uWanderFoliageSimplify;\n'
      + shader.fragmentShader
        // Still a caster, so the canopy keeps dappling the ground beneath it.
        // Wander's scatter already skips receiving; the dark that remains is
        // leaf cards turned from the sun. Bending the shading normal toward
        // the key light makes the crown one high-key painted mass whose form
        // comes from its tones, as blossom is painted, not from dark lumps.
        .replace('#include <lights_fragment_begin>', `#if NUM_DIR_LIGHTS > 0
if ( uWanderCanopyUnshadowed ) normal = normalize( mix( normal, directionalLights[ 0 ].direction, 0.65 ) );
#endif
#define receiveShadow ( receiveShadow && !uWanderCanopyUnshadowed )
#include <lights_fragment_begin>
#undef receiveShadow`)
        .replace('#include <map_fragment>', SIMPLIFIED_MAP);
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previousKey?.() || ''}:canopy-style`;
  material.needsUpdate = true;
  return material;
}

// --- grass coverage ---------------------------------------------------------------
// Simplifies grass by COVERAGE, not density: a world-space patch field decides
// where grass grows at all. As the control rises only the field's peaks keep
// their grass, so meadows break into patches that shrink and spread apart
// until, at the far end, there is none. Both grass systems (the GPU blanket
// field and the per-chunk tufts) sample the same field at each blade's world
// position, so their patches coincide, and blades taper in height at a patch
// edge rather than popping.
export const grassCoverageUniform = { value: 0 };

export const GRASS_COVERAGE_GLSL = /* glsl */`
uniform float uGrassCoverage;
float wgHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float wgNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wgHash(i), wgHash(i + vec2(1.0, 0.0)), f.x),
             mix(wgHash(i + vec2(0.0, 1.0)), wgHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float grassPatchKeep(vec2 xz) {
  if (uGrassCoverage <= 0.0) return 1.0;
  if (uGrassCoverage >= 0.999) return 0.0;
  float n = wgNoise(xz / 26.0) * 0.65 + wgNoise(xz / 9.0 + 17.3) * 0.35;
  // The field lives mostly in 0.2..0.85; spread the slider across that so
  // each step removes a similar share of the meadow.
  float t = mix(0.16, 0.90, uGrassCoverage);
  return smoothstep(t, t + 0.08, n);
}
`;

// --- fill lights ---------------------------------------------------------------
const _toSun = new THREE.Vector3();
const _violet = new THREE.Color(0x9a86c8);

class AnimeFillLights {
  constructor(scene) {
    this.fill = new THREE.DirectionalLight(DEFAULTS.fillColor, 0);
    this.fill.name = 'ghibli-fill';
    this.bounce = new THREE.DirectionalLight(0xd8cbe8, 0);
    this.bounce.name = 'ghibli-bounce';
    for (const light of [this.fill, this.bounce]) {
      light.castShadow = false;
      // Hidden lights are not counted, so the off state costs nothing per
      // fragment. Toggling changes the light count and recompiles programs.
      light.visible = false;
      scene.add(light, light.target);
    }
    this.groundBase = null;
  }

  update(sky, playerPos, settings) {
    const on = settings.fillLight;
    this.fill.visible = this.bounce.visible = on;
    const hemi = sky.hemi;
    if (hemi) {
      this.groundBase ||= hemi.groundColor.clone();
      hemi.groundColor.copy(this.groundBase);
      if (on) hemi.groundColor.lerp(_violet, settings.groundViolet);
    }
    if (!on) return;
    const elevation = sky.sunElevation ?? 0;
    const day = THREE.MathUtils.smoothstep(elevation, -0.06, 0.12);
    const sunScale = Math.min(1, (sky.sun?.intensity ?? 0) / 3.1);
    _toSun.copy(sky.sunDir || _toSun.set(0, 1, 0));
    // Opposite the sun in azimuth, from a steady 35° up: it fills exactly the
    // faces the sun leaves in shade.
    const fx = -_toSun.x, fz = -_toSun.z, h = Math.hypot(fx, fz) || 1;
    this.fill.position.set(playerPos.x + (fx / h) * 300, playerPos.y + 210, playerPos.z + (fz / h) * 300);
    this.fill.target.position.copy(playerPos);
    this.fill.color.set(settings.fillColor);
    this.fill.intensity = settings.fillIntensity * day * (0.35 + 0.65 * sunScale);
    // From below, on the sun's side: lifts undersides (eaves, chins, canopy
    // bellies) that the fill cannot reach.
    this.bounce.position.set(playerPos.x - (fx / h) * 200, playerPos.y - 260, playerPos.z - (fz / h) * 200);
    this.bounce.target.position.copy(playerPos);
    this.bounce.intensity = settings.bounceIntensity * day;
  }
}

// --- settings, persistence and the controller the panel drives ------------------
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function createGhibliStyle(scene, { post = null } = {}) {
  const settings = loadSettings();
  const lights = new AnimeFillLights(scene);
  const controller = {
    settings,
    defaults: DEFAULTS,
    apply() {
      lightBand.strength = settings.lightBands ? settings.bandStrength : 0;
      lightBand.bands = Math.round(settings.bands);
      lightBand.softness = settings.bandSoftness;
      lightBand.lift = settings.bandLift;
      lightBand.tint.set(settings.bandTint);
      canopyUniforms.unshadowed.value = !!settings.canopyUnshadowed;
      canopyUniforms.simplify.value = settings.foliageSimplify;
      grassCoverageUniform.value = settings.grassCoverage;
      if (post?.ink) {
        if (settings.inkCurvature) {
          post.ink.mode = 'curvature';
          post.ink.curvatureStrength = settings.inkStrength;
          post.inkEnabled = true;
        } else if (post.ink.mode === 'curvature') {
          post.ink.mode = 'structural';
          post.inkEnabled = false;
        }
      }
      const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => DEFAULTS[key] !== value));
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(changed)); } catch { /* optional */ }
    },
    reset() {
      Object.assign(settings, DEFAULTS);
      this.apply();
    },
    update(sky, playerPos) {
      lights.update(sky, playerPos, settings);
    },
    lights,
  };
  controller.apply();
  return controller;
}
