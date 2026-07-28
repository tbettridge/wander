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
import { InkLinePass, GodRayPass } from './signaturefx.js';
import { resolveMsaaSamples } from './postquality.mjs';
import { LIGHT } from './palette.mjs';
import { SoftBufferPass } from './softbuffer.js';

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
    // internal render scale: when the scene renders below display resolution, a
    // light contrast-adaptive sharpen recovers edge crispness in the upscale
    uTexel:      { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uSharpen:    { value: 0.0 },
    uFxaaEnabled:{ value: true },
    // wet-in-wet distance softening: the blurred scene, and how much of it to
    // use. uWet is the master amount so the whole effect can be A/B'd to zero.
    tSoft:       { value: null },
    uWet:        { value: 1.0 },
    // biome grade tint: the world subtly re-grades by region (humid teal
    // jungles, warm dry deserts, cold blue tundra) — eased, never a hard cut
    uTint:       { value: new THREE.Color(1, 1, 1) },
    uTintAmt:    { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tSoft;
    uniform float uWet;
    uniform float uExposure, uContrast, uSaturation, uWarmth;
    uniform float uGhibli, uDay, uLift, uPastelVal, uPastelCon, uPaper, uGroup;
    uniform float uSharpen, uTintAmt;
    uniform bool uFxaaEnabled;
    uniform vec2 uTexel;
    uniform vec3 uShadowCol, uTint;
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
    // FXAA 3-style directional luma resolve, thresholded on a Reinhard-folded
    // luma. All colour mixing stays linear and still precedes the single
    // ACES/grade encode; only the edge DETECTOR sees the folded value.
    //
    // The composer buffer is linear HDR, where a sunlit blade can sit near 1.5
    // and a shaded one near 0.03. FXAA's threshold is partly relative
    // (lmax * k), so on raw linear luma it means something completely
    // different at the two ends: it fires almost nowhere in the light and
    // everywhere in the dark. sqrt (what this used to fold with) compresses in
    // the right direction but is unbounded, so highlights still outrun the
    // relative term. Folding through the same Reinhard shape the eye will
    // eventually see puts every threshold back in the range the algorithm was
    // designed for — which is the difference between it resolving a meadow of
    // grass blades and not.
    //
    // Rec.709 weights, matching the linear working space and the rest of the
    // luma in this file; the old Rec.601 set predated that.
    float fxaaLuma(vec3 c){
      c = max(c, vec3(0.0));
      c = c / (c + vec3(1.0));
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }
    vec3 fxaaResolve(vec2 uv, vec3 center){
      vec3 nw = texture2D(tDiffuse, uv + uTexel * vec2(-1.0, -1.0)).rgb;
      vec3 ne = texture2D(tDiffuse, uv + uTexel * vec2( 1.0, -1.0)).rgb;
      vec3 sw = texture2D(tDiffuse, uv + uTexel * vec2(-1.0,  1.0)).rgb;
      vec3 se = texture2D(tDiffuse, uv + uTexel * vec2( 1.0,  1.0)).rgb;
      float lm = fxaaLuma(center);
      float lnw = fxaaLuma(nw), lne = fxaaLuma(ne);
      float lsw = fxaaLuma(sw), lse = fxaaLuma(se);
      float lmin = min(lm, min(min(lnw, lne), min(lsw, lse)));
      float lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
      // Reinhard caps luma at 1.0 where sqrt did not, so the whole detector is
      // recalibrated to that range together — thresholds, the direction-reduce
      // floor and the span clamp. Folding the luma without moving these would
      // leave a detector tuned for a range that no longer exists.
      if (lmax - lmin < max(0.016, lmax * 0.055)) return center;

      vec2 dir;
      dir.x = -((lnw + lne) - (lsw + lse));
      dir.y =  ((lnw + lsw) - (lne + lse));
      float reduce = max((lnw + lne + lsw + lse) * 0.0156, 0.0039);
      float invMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * invMin, vec2(-6.0), vec2(6.0)) * uTexel;

      vec3 a = 0.5 * (
        texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 b = a * 0.5 + 0.25 * (
        texture2D(tDiffuse, uv + dir * -0.5).rgb +
        texture2D(tDiffuse, uv + dir *  0.5).rgb);
      float lb = fxaaLuma(b);
      return (lb < lmin || lb > lmax) ? a : b;
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // upscale sharpen (only active when rendering below display resolution):
      // pull the centre away from its 4-neighbour average — cheap CAS-lite
      if (uSharpen > 0.001) {
        vec3 nb = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb
                + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
                + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb
                + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        // FXAA follows this resolve and removes the unstable high-contrast
        // diagonals that sharpening can otherwise reintroduce into thin grass.
        c = max(c + (c - nb * 0.25) * uSharpen, 0.0);
      }
      if (uFxaaEnabled) c = fxaaResolve(vUv, c);

      // --- wet-in-wet distance softening -----------------------------------
      // One fetch carries both halves: the blurred scene in rgb, and how far
      // away this pixel is in alpha — resolved from the depth buffer by
      // softbuffer.js, so it needs nothing from any material in the scene.
      //
      // This is watercolour behaviour, not depth of field. There is no focal
      // plane and no bokeh: everything near stays sharp and the wash grows
      // monotonically with distance, which is what atmosphere actually does to
      // detail and what a painted background does to a far hillside.
      //
      // It runs here — after the edge resolve, still in linear HDR, before
      // exposure and the ACES encode — so the softening participates in the
      // same single tonemap as everything else rather than being smeared on
      // top of an already-graded image.
      {
        vec4 soft = texture2D(tSoft, vUv);
        float wet = clamp(soft.a, 0.0, 1.0) * uWet;   // already curved by WASH
        c = mix(c, soft.rgb, wet * 0.42);

        // Chroma bleed: at distance, colour spreads further than luminance —
        // paint runs, pixels do not. Keep this pixel's own value and take the
        // neighbourhood's hue.
        //
        // Purely distance-gated, with no flat baseline term. A constant bleed
        // would quietly desaturate near detail too, and Wander's saturation is
        // already tuned in this pass; distance is the only thing that has
        // earned the right to smear colour.
        float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec3 chroma = soft.rgb - vec3(dot(soft.rgb, vec3(0.2126, 0.7152, 0.0722)));
        c = mix(c, vec3(lc) + chroma, wet * 0.17);
      }

      c *= uExposure;
      c = aces(c);
      c *= mix(vec3(1.0), uTint, uTintAmt);        // regional grade tint
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

  // HDR linear target. Tier policy applies 0x/2x MSAA below; starting at zero
  // ensures low/medium never allocate the former 4-sample buffers even once.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
  const composer = new EffectComposer(renderer, target);

  // Scene depth, for the distance wash in the grade pass.
  //
  // EffectComposer ping-pongs two targets and does not reset which is which
  // between frames, so the scene can land in either one. Both therefore get a
  // depth attachment, and SoftBufferPass reads whichever buffer it is handed —
  // no assumption about parity, which would otherwise show up as the wash
  // flickering on alternate frames.
  function attachDepth(rt) {
    if (rt.depthTexture) return;
    const d = new THREE.DepthTexture(rt.width, rt.height, THREE.UnsignedIntType);
    d.minFilter = THREE.NearestFilter;
    d.magFilter = THREE.NearestFilter;
    rt.depthTexture = d;
  }
  attachDepth(composer.renderTarget1);
  attachDepth(composer.renderTarget2);

  let tierName = 'medium';
  let msaaMode = 'auto';
  let activeMsaaSamples = 0;
  function applyMsaaPolicy() {
    const requested = resolveMsaaSamples(tierName, msaaMode);
    const maxSamples = renderer.capabilities.maxSamples;
    const supported = renderer.capabilities.isWebGL2
      ? Math.min(requested, Number.isFinite(maxSamples) ? maxSamples : requested)
      : 0;
    if (supported === activeMsaaSamples) return;
    // EffectComposer owns two ping-pong targets cloned from `target`. Changing
    // samples plus dispose releases the old multisample attachments; Three
    // lazily recreates them with the new count on the next render.
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      rt.samples = supported;
      rt.dispose();
    }
    activeMsaaSamples = supported;
  }

  composer.addPass(new RenderPass(scene, camera));

  // Tapped immediately after the scene render, before bloom: a distance haze
  // softens what is there, it does not smear sun-bright bloom across the
  // horizon. RenderPass has needsSwap = false, so the buffer handed to this
  // pass is still the one the scene (and its depth) was rasterised into.
  const soft = new SoftBufferPass(size.x, size.y);
  soft.setCamera(camera);
  composer.addPass(soft);

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

    // GTAO is intentionally half-resolution. Its Poisson denoiser removes the
    // low-resolution stipple, and the final blend linearly upsamples the smooth
    // AO field into the full composer target. Keep the public setSize contract
    // in full-resolution pixels so EffectComposer can resize it normally.
    const setGtaoInternalSize = gtao.setSize.bind(gtao);
    gtao.resolutionScale = 0.5;
    gtao.fullWidth = size.x;
    gtao.fullHeight = size.y;
    gtao.setSize = (width, height) => {
      gtao.fullWidth = width;
      gtao.fullHeight = height;
      setGtaoInternalSize(
        Math.max(1, Math.ceil(width * gtao.resolutionScale)),
        Math.max(1, Math.ceil(height * gtao.resolutionScale))
      );
    };
    gtao.setResolutionScale = (value) => {
      gtao.resolutionScale = THREE.MathUtils.clamp(value, 0.25, 1);
      gtao.setSize(gtao.fullWidth, gtao.fullHeight);
    };

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

  // Signature experiments live after bloom but before the final tonemap/grade,
  // so ink and warm shafts participate in the same painterly colour treatment.
  // Ink starts off for a true A/B review; rays are user-enabled by default but
  // their pass is skipped entirely outside the low, on-screen sun window.
  const ink = new InkLinePass(scene, camera);
  composer.addPass(ink);
  const godRays = new GodRayPass(scene, camera);
  composer.addPass(godRays);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  // ShaderPass clones GradeShader.uniforms, so the soft buffer has to be bound
  // on the clone the pass actually renders with.
  grade.uniforms.tSoft.value = soft.texture;

  // Internal render scale: the 3D scene (and every pass) renders at
  // displayRes × scale; the final grade pass samples that smaller buffer while
  // drawing to the full canvas, so the upscale is free — and the shader's
  // sharpen term recovers the crispness. Huge fill-rate savings on hiDPI.
  let renderScale = 1;
  let lastW = size.x, lastH = size.y;
  function setSize(w, h) {
    lastW = w; lastH = h;
    const pr = renderer.getPixelRatio() * renderScale;
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    grade.uniforms.uTexel.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
    grade.uniforms.uSharpen.value = Math.min(0.6, Math.max(0, (1 - renderScale) * 1.3));
  }
  setSize(size.x, size.y);

  // regional grade tint targets (eased toward in update)
  const BIOME_TINT = {
    jungle:  { c: new THREE.Color(0.95, 1.03, 1.00), a: 0.45 },
    desert:  { c: new THREE.Color(1.06, 1.00, 0.92), a: 0.50 },
    savanna: { c: new THREE.Color(1.04, 1.00, 0.94), a: 0.40 },
    tundra:  { c: new THREE.Color(0.96, 0.99, 1.06), a: 0.45 },
    snow:    { c: new THREE.Color(0.97, 1.00, 1.07), a: 0.40 },
    beach:   { c: new THREE.Color(1.03, 1.01, 0.97), a: 0.30 },
  };
  const tintTarget = { c: new THREE.Color(1, 1, 1), a: 0 };
  const cameraWorld = new THREE.Vector3();
  const sunWorld = new THREE.Vector3();
  const sunNdc = new THREE.Vector3();
  const sunUv = new THREE.Vector2();

  return {
    render() { composer.render(); },
    gtao, bloom, ink, godRays, grade,   // exposed for debugging / tuning
    autoShadowCol: true,  // GUI can pin a manual shadow colour
    satBase: GradeShader.uniforms.uSaturation.value, // daytime saturation; dusk pulls below it
    get inkEnabled() { return ink.userEnabled; },
    set inkEnabled(value) {
      ink.userEnabled = !!value;
      ink.enabled = ink.userEnabled;
    },
    get godRaysEnabled() { return godRays.userEnabled; },
    set godRaysEnabled(value) {
      godRays.userEnabled = !!value;
      if (!godRays.userEnabled) godRays.enabled = false;
    },
    get gtaoResolutionScale() { return gtao?.resolutionScale ?? 0.5; },
    set gtaoResolutionScale(value) { if (gtao) gtao.setResolutionScale(value); },
    get fxaaEnabled() { return grade.uniforms.uFxaaEnabled.value; },
    set fxaaEnabled(value) { grade.uniforms.uFxaaEnabled.value = !!value; },
    // 0..1 master for the wet-in-wet distance wash. At 0 the soft buffer is
    // still produced but contributes nothing, which is what makes it a clean
    // A/B; setting `soft.enabled = false` as well skips the passes entirely.
    get wetness() { return grade.uniforms.uWet.value; },
    set wetness(value) { grade.uniforms.uWet.value = THREE.MathUtils.clamp(value, 0, 1); },
    softBuffer: soft,
    get msaaMode() { return msaaMode; },
    set msaaMode(value) { msaaMode = value; applyMsaaPolicy(); },
    get msaaSamples() { return activeMsaaSamples; },
    setSize,
    get renderScale() { return renderScale; },
    set renderScale(v) {
      renderScale = Math.min(1, Math.max(0.5, v));
      setSize(lastW, lastH);
    },
    // called at 4 Hz from the main loop's slow probe
    setBiomeTint(id) {
      const t = BIOME_TINT[id];
      if (t) { tintTarget.c.copy(t.c); tintTarget.a = t.a; }
      else { tintTarget.c.setRGB(1, 1, 1); tintTarget.a = 0; }
    },
    setQuality(tier) {
      const lvl = TIER_ORDER.indexOf(tier.name);
      tierName = tier.name;
      applyMsaaPolicy();
      if (gtao) gtao.enabled = lvl >= 3;   // SSAO on high/ultra
      bloom.enabled = lvl >= 2;            // bloom on medium and up
      if (Number.isFinite(tier.renderScale) && renderScale !== tier.renderScale) {
        renderScale = THREE.MathUtils.clamp(tier.renderScale, 0.5, 1);
        setSize(lastW, lastH);
      }
    },
    update(exposure, sunElevation, duskWarmthScale = 1, weather = null, dt = 0.016, sky = null, caveAtmosphere = null) {
      // A1 costs exactly nothing while its experiment toggle is off: disabled
      // EffectComposer passes are not invoked and allocate no per-frame work.
      ink.enabled = ink.userEnabled;

      // A2 only enters the composer when the low sun is both above the horizon
      // and inside the viewport.  Weather visibility suppresses shafts under
      // overcast/storm light where a distinct solar source would look false.
      godRays.enabled = false;
      if (godRays.userEnabled && sky && sunElevation > 0.012 && sunElevation < 0.42) {
        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(cameraWorld);
        sunWorld.copy(cameraWorld).addScaledVector(sky.sunDir, Math.min(4000, camera.far * 0.7));
        sunNdc.copy(sunWorld).project(camera);
        sunUv.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5);
        const onScreen = sunNdc.z > -1 && sunNdc.z < 1
          && sunUv.x >= 0 && sunUv.x <= 1 && sunUv.y >= 0 && sunUv.y <= 1;
        const visibility = weather?.sunVisibility ?? 1;
        const storm = weather?.storm ?? 0;
        const cloudShade = weather?.cloudShade ?? 0;
        const rise = THREE.MathUtils.smoothstep(sunElevation, 0.012, 0.075);
        const highFade = 1 - THREE.MathUtils.smoothstep(sunElevation, 0.27, 0.42);
        const strengthScale = rise * highFade * Math.pow(Math.max(0, visibility), 0.7)
          * (1 - cloudShade * 0.45) * (1 - storm * 0.9);
        if (onScreen && strengthScale > 0.012) {
          godRays.setSun(sunUv, sky.sun.color, strengthScale);
          godRays.enabled = true;
        }
      }

      // ease the regional tint (slow — a new region greets you over ~4 s)
      const tk = 1 - Math.exp(-dt * 0.8);
      grade.uniforms.uTint.value.lerp(tintTarget.c, tk);
      const caveFactor = THREE.MathUtils.clamp(caveAtmosphere?.factor ?? 0, 0, 1);
      const caveExposure = caveAtmosphere?.exposureScale ?? 1;
      const effectiveTint = tintTarget.a * (1 - caveFactor * 0.82);
      grade.uniforms.uTintAmt.value += (effectiveTint - grade.uniforms.uTintAmt.value) * tk;
      const dayness = THREE.MathUtils.smoothstep(sunElevation, -0.04, 0.12);
      const weatherShade = (weather?.cloudShade || 0) * dayness;
      grade.uniforms.uExposure.value = exposure * (1 - weatherShade * 0.06) * caveExposure;
      // Deep caves retain painted colour grouping, but not the lifted outdoor
      // daytime black point. This keeps recesses deep while exposure adapts.
      grade.uniforms.uDay.value = THREE.MathUtils.lerp(dayness, 0.08, caveFactor);
      // day-driven palette: shadow pigment drifts violet at the rims of the
      // day (dawn/dusk), settles to cool blue at midday (unless pinned via GUI)
      if (this.autoShadowCol) {
        const lo = 1 - THREE.MathUtils.smoothstep(sunElevation, 0.05, 0.4);
        const day = LIGHT.shadowDay, low = LIGHT.shadowLow, cave = LIGHT.shadowCave;
        grade.uniforms.uShadowCol.value.setRGB(
          THREE.MathUtils.lerp(THREE.MathUtils.lerp(day[0], low[0], lo), cave[0], caveFactor),
          THREE.MathUtils.lerp(THREE.MathUtils.lerp(day[1], low[1], lo), cave[1], caveFactor),
          THREE.MathUtils.lerp(THREE.MathUtils.lerp(day[2], low[2], lo), cave[2], caveFactor));
      }
      // warmer grade as the sun drops toward the horizon (golden hour), amplified
      // on dramatic evenings by the day roll (sky.duskWarmthScale)
      const baseWarmth = 1.0 - THREE.MathUtils.smoothstep(sunElevation, -0.05, 0.35);
      const weatherWarmth = 1 - weatherShade * 0.55 - (weather?.storm || 0) * dayness * 0.20;
      grade.uniforms.uWarmth.value = Math.min(1.3,
        baseWarmth * duskWarmthScale * weatherWarmth * (1 - caveFactor * 0.88));
      // night: let the stars/moon/fireflies halo a little more generously
      bloom.strength = 0.08 + (1 - grade.uniforms.uDay.value) * 0.10
        + (weather?.mist || 0) * dayness * 0.06 - caveFactor * 0.035;
      // dusk goes PASTEL, not hyper-saturated — pull saturation down as the sun
      // drops so neither the warm sky nor the cool shadows blow out to neon.
      grade.uniforms.uSaturation.value = this.satBase - baseWarmth * 0.24
        - weatherShade * 0.10 - caveFactor * 0.10;
    },
  };
}
