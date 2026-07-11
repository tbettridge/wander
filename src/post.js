// Post-processing pipeline: SSAO (GTAO) + bloom + tonemap & colour grading.
//
// The whole chain runs in LINEAR HDR. To make that work cleanly the renderer's
// tone mapping is turned OFF (set in main.js) so the scene — including the
// custom water/atmosphere shaders, whose <tonemapping_fragment> then becomes a
// no-op — renders linear into the composer. A single final grade pass applies
// exposure, the ACES curve, colour grading, and the sRGB encode, so nothing is
// double-tonemapped. (WebXR bypasses all of this — see main.js.)

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

// final pass: exposure → ACES tonemap → grade (saturation / contrast / warmth) → sRGB
const GradeShader = {
  uniforms: {
    tDiffuse:    { value: null },
    uExposure:   { value: 0.55 },
    uContrast:   { value: 1.06 },
    uSaturation: { value: 1.14 },
    uWarmth:     { value: 0.0 },
    // --- Ghibli pastel look (A/B via uGhibli 0..1, live-tunable) ---
    uGhibli:     { value: 1.0 },   // master blend: 0 = realistic, 1 = pastel
    uDay:        { value: 1.0 },   // gates the lift (nights stay deep blue)
    uShadowCol:  { value: new THREE.Color(0.25, 0.27, 0.38) }, // shadow pigment
    uLift:       { value: 0.09 },  // black-point lift toward pigment
    uPastelVal:  { value: 0.94 },  // <1 raises overall value (gamma)
    uPastelCon:  { value: 0.97 },  // <1 softens contrast
    uPaper:      { value: 0.42 },  // gouache paper tooth strength
    uGroup:      { value: 0.16 },  // soft value grouping (painted masses)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uContrast, uSaturation, uWarmth;
    uniform float uGhibli, uDay, uLift, uPastelVal, uPastelCon, uPaper, uGroup;
    uniform vec3 uShadowCol;
    varying vec2 vUv;
    vec3 aces(vec3 x){
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }
    float pH(vec2 p){ p = fract(p * vec2(127.31, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y); }
    float pN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(pH(i), pH(i+vec2(1,0)), f.x), mix(pH(i+vec2(0,1)), pH(i+vec2(1,1)), f.x), f.y); }
    vec3 lin2srgb(vec3 c){
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c *= uExposure;
      c = aces(c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // dusk split-tone: WARM the lit areas (golden rims), COOL the shadows
      // (dusk blue), scaled by uWarmth. The amount rides luminance so it can't
      // swamp dark dusk terrain — warming the SHADOWS (the old formula) reddened
      // the whole low-sun scene into a muddy red-out.
      c.r += uWarmth * (0.05 * l);
      c.g += uWarmth * (0.013 * l);
      c.b += uWarmth * (0.022 * (1.0 - l) - 0.012 * l);
      c = mix(vec3(l), c, uSaturation);            // saturation
      c = (c - 0.5) * uContrast + 0.5;             // contrast
      // --- Ghibli pastel: luminous gouache light ---------------------------
      // shadow-pigment lift (mix toward a cool blue-violet, NOT additive grey),
      // raised value, softened contrast; gated by day so nights stay deep.
      {
        vec3 g = c;
        float lg = dot(g, vec3(0.2126, 0.7152, 0.0722));
        float sh = 1.0 - smoothstep(0.0, 0.5, lg);           // shadow mask
        g = mix(g, max(g, uShadowCol * (0.55 + 0.9 * lg)), sh * uLift * 4.0);
        g = pow(max(g, 0.0), vec3(uPastelVal));              // airy value raise
        g = (g - 0.5) * uPastelCon + 0.5;                    // gentle contrast
        float lg2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
        g = mix(vec3(lg2), g, 1.12);                         // keep colors lush
        c = mix(c, g, uGhibli * (0.25 + 0.75 * uDay));
      }
      // --- Phase 3-lite: painted surface (no Kuwahara — the art style is
      // already flat-shaded, so paper tooth + gentle value grouping is enough)
      if (uGhibli > 0.001) {
        float lp = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // soft value grouping: nudge luminance toward gentle bands so light
        // gathers into painted masses; skies/highlights stay smooth (gated)
        float lq = (floor(lp * 7.0) + 0.5) / 7.0;
        float gAmt = uGroup * uGhibli * (1.0 - smoothstep(0.62, 0.85, lp));
        float grouped = mix(lp, lq, gAmt);
        c *= lp > 0.002 ? grouped / lp : 1.0;
        // gouache paper tooth: two-scale grain that settles into the shadows,
        // with a barely-there warm paper cast
        vec2 pp = vUv * vec2(920.0, 575.0);
        float tooth = pN(pp) * 0.6 + pN(pp * 3.3) * 0.4;
        float pAmt = uPaper * uGhibli * (0.3 + 0.7 * (1.0 - lp)) * 0.14;
        c *= 1.0 + (tooth - 0.5) * pAmt;
        c = mix(c, c * vec3(1.0, 0.995, 0.972), uPaper * uGhibli * 0.3);
      }
      gl_FragColor = vec4(lin2srgb(clamp(c, 0.0, 1.0)), 1.0);
    }
  `,
};

const TIER_ORDER = ['potato', 'low', 'medium', 'high', 'ultra'];

export function createPostFX(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());

  // HDR linear, multisampled (MSAA) intermediate target
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);

  composer.addPass(new RenderPass(scene, camera));

  let gtao = null;
  try {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;       // beauty × ambient occlusion
    // Subtle, contact-scale AO. On an open bumpy heightfield a big radius
    // bulk-darkens slopes and a tiny one speckles, so we use a moderate radius
    // at LOW intensity — a gentle deepening of crevices and where trees/rocks
    // meet the ground, kept smooth by the denoise.
    gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.0, thickness: 1.0, scale: 0.4, samples: 16, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 12, depthPhi: 2.5, normalPhi: 4, radius: 8, radiusExponent: 1.2, rings: 3, samples: 16 });
    gtao.blendIntensity = 0.6;

    // GTAO's depth/normal prepass renders the scene with an override material
    // that ignores alphaTest cutouts, so the FULL rectangles of leaf cards and
    // impostor billboards stamp the AO depth buffer and cast card-shaped AO
    // "tinted squares" onto whatever is behind them. Hide alpha-cutout foliage
    // while the AO pass runs — the beauty pass keeps the leaves; AO simply
    // doesn't consider them (their thin cards contribute no meaningful AO).
    const origGtaoRender = gtao.render.bind(gtao);
    const gtaoHidden = [];
    gtao.render = (r2, writeBuffer, readBuffer, deltaTime, maskActive) => {
      gtaoHidden.length = 0;
      scene.traverse((o) => {
        if (!o.visible || !o.material) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if ((m.map && m.alphaTest > 0) || m.userData.excludeFromAO) { o.visible = false; gtaoHidden.push(o); return; }
        }
      });
      origGtaoRender(r2, writeBuffer, readBuffer, deltaTime, maskActive);
      for (const o of gtaoHidden) o.visible = true;
    };

    composer.addPass(gtao);
  } catch (e) {
    console.warn('GTAO unavailable, skipping AO:', e);
  }

  const bloom = new UnrealBloomPass(size.clone(), 0.08, 0.5, 0.85); // strength, radius, threshold
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  function setSize(w, h) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
  }
  setSize(size.x, size.y);

  return {
    render() { composer.render(); },
    gtao, bloom, grade,   // exposed for debugging / tuning
    autoShadowCol: true,  // GUI can pin a manual shadow colour
    satBase: GradeShader.uniforms.uSaturation.value, // daytime saturation; dusk pulls below it
    setSize,
    setQuality(tier) {
      const lvl = TIER_ORDER.indexOf(tier.name);
      if (gtao) gtao.enabled = lvl >= 3;   // SSAO on high/ultra
      bloom.enabled = lvl >= 2;            // bloom on medium and up
    },
    update(exposure, sunElevation, duskWarmthScale = 1, weather = null) {
      const dayness = THREE.MathUtils.smoothstep(sunElevation, -0.04, 0.12);
      const weatherShade = (weather?.cloudShade || 0) * dayness;
      grade.uniforms.uExposure.value = exposure * (1 - weatherShade * 0.06);
      grade.uniforms.uDay.value = dayness;
      // day-driven palette: shadow pigment drifts violet at the rims of the
      // day (dawn/dusk), settles to cool blue at midday (unless pinned via GUI)
      if (this.autoShadowCol) {
        const lo = 1 - THREE.MathUtils.smoothstep(sunElevation, 0.05, 0.4);
        grade.uniforms.uShadowCol.value.setRGB(
          0.25 + 0.07 * lo, 0.27 - 0.04 * lo, 0.38 + 0.05 * lo);
      }
      // warmer grade as the sun drops toward the horizon (golden hour), amplified
      // on dramatic evenings by the day roll (sky.duskWarmthScale)
      const baseWarmth = 1.0 - THREE.MathUtils.smoothstep(sunElevation, -0.05, 0.35);
      const weatherWarmth = 1 - weatherShade * 0.55 - (weather?.storm || 0) * dayness * 0.20;
      grade.uniforms.uWarmth.value = Math.min(1.3, baseWarmth * duskWarmthScale * weatherWarmth);
      // night: let the stars/moon/fireflies halo a little more generously
      bloom.strength = 0.08 + (1 - grade.uniforms.uDay.value) * 0.10
        + (weather?.mist || 0) * dayness * 0.06;
      // dusk goes PASTEL, not hyper-saturated — pull saturation down as the sun
      // drops so neither the warm sky nor the cool shadows blow out to neon.
      grade.uniforms.uSaturation.value = this.satBase - baseWarmth * 0.24 - weatherShade * 0.10;
    },
  };
}
