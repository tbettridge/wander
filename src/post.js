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
import { InkLinePass, GodRayPass } from './signaturefx.js?v=4';
import {
  DESKTOP_LANTERN_GRADE,
  desktopLanternGradeProtection,
  resolveMsaaSamples,
} from './postquality.mjs?v=2';
import { LIGHT } from './palette.mjs';
import { SoftBufferPass } from './softbuffer.js?v=4';
import { WASH } from './softkernel.mjs?v=2';

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
    uGroup:      { value: 0.185 }, // soft value grouping (painted masses)
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
    // Protect the dim tail of the carried light from the desktop grade's cool
    // shadow pigment, contrast, and painted grouping. Zero while extinguished.
    uLocalLight: { value: 0.0 },
    // GTAO's denoised half-resolution occlusion, applied here instead of by the
    // pass's own copy + multiply composite (two full-resolution HDR passes).
    // uAO is the blend intensity; 0 skips the fetch entirely.
    tAO:         { value: null },
    uAO:         { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tSoft;
    uniform sampler2D tAO;
    uniform float uAO;
    uniform float uWet;
    uniform float uExposure, uContrast, uSaturation, uWarmth;
    uniform float uGhibli, uDay, uLift, uPastelVal, uPastelCon, uPaper, uGroup;
    uniform float uSharpen, uTintAmt, uLocalLight;
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
    // One non-finite pixel from any scene shader would otherwise reach ACES
    // as NaN (black), and every neighbourhood filter here would copy it.
    bool badColor(vec3 c){ return any(isnan(c)) || any(isinf(c)); }
    vec3 finiteOr(vec3 c, vec3 fallback){ return badColor(c) ? fallback : c; }
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
      vec3 nw = finiteOr(texture2D(tDiffuse, uv + uTexel * vec2(-1.0, -1.0)).rgb, center);
      vec3 ne = finiteOr(texture2D(tDiffuse, uv + uTexel * vec2( 1.0, -1.0)).rgb, center);
      vec3 sw = finiteOr(texture2D(tDiffuse, uv + uTexel * vec2(-1.0,  1.0)).rgb, center);
      vec3 se = finiteOr(texture2D(tDiffuse, uv + uTexel * vec2( 1.0,  1.0)).rgb, center);
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
    // Saturation that stops short of driving any channel negative.
    vec3 hueSafeSaturation(vec3 c, float l, float amount) {
      float lo = min(c.r, min(c.g, c.b));
      float limit = lo < l ? l / max(l - lo, 1e-5) : amount;
      return mix(vec3(l), c, amount > 1.0 ? min(amount, limit) : amount);
    }
    // Contrast on luminance with a soft toe, as a single scale for all three
    // channels: hue is kept, and the darkest values ease toward black instead
    // of being cut off at it.
    vec3 toeSafeContrast(vec3 c, float k) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (l <= 1e-6) return c;
      float shaped = l + (k - 1.0) * (l - 0.5) * smoothstep(0.0, 0.32, l);
      return c * (max(shaped, 0.0) / l);
    }
    void main() {
      // The soft buffer is sanitised where it is built, so its local average
      // is a stand-in for a non-finite scene pixel that nobody will notice.
      vec4 soft = texture2D(tSoft, vUv);
      vec3 c = finiteOr(texture2D(tDiffuse, vUv).rgb, soft.rgb);
      // upscale sharpen (only active when rendering below display resolution):
      // pull the centre away from its 4-neighbour average — cheap CAS-lite
      if (uSharpen > 0.001) {
        vec3 nb = finiteOr(texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb, c)
                + finiteOr(texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb, c)
                + finiteOr(texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb, c)
                + finiteOr(texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb, c);
        // FXAA follows this resolve and removes the unstable high-contrast
        // diagonals that sharpening can otherwise reintroduce into thin grass.
        c = max(c + (c - nb * 0.25) * uSharpen, 0.0);
      }
      if (uFxaaEnabled) c = fxaaResolve(vUv, c);
      // Ambient occlusion, exactly as GTAOPass's own multiply blend applied it:
      // the field is smooth and half resolution, so it is indifferent to
      // whether it lands before or after the edge resolve.
      if (uAO > 0.0) c *= mix(vec3(1.0), texture2D(tAO, vUv).rgb, uAO);

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
      float viewDistance = 0.0;
      float softDepthSignal = 0.0;
      {
        softDepthSignal = soft.a;
        viewDistance = clamp(soft.a, 0.0, 1.0) * ${WASH.far.toFixed(1)};
        float wet = smoothstep(${WASH.near.toFixed(1)}, ${WASH.far.toFixed(1)}, viewDistance)
          * ${WASH.maxWet} * uWet;
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
      // The lantern rides close to the camera, so linear view distance is a
      // useful conservative proxy for its lighting volume. Calculate this
      // before the dusk split-tone: otherwise that pass's injected blue is
      // mistaken for part of the physical amber signal.
      // Match the point light's infinite physical tail rather than ending the
      // grade protection at a finite screen-space radius. A hard endpoint was
      // visible as a red/purple shell against r185's darker night sky.
      float localGeometry = smoothstep(-0.25, 0.0, softDepthSignal);
      float localProximity = localGeometry / (1.0 + pow(
        viewDistance / ${DESKTOP_LANTERN_GRADE.proximityScale.toFixed(1)},
        ${DESKTOP_LANTERN_GRADE.proximityDecay.toFixed(2)}));
      float localSignal = smoothstep(
        ${DESKTOP_LANTERN_GRADE.signalStart.toFixed(3)},
        ${DESKTOP_LANTERN_GRADE.signalFull.toFixed(3)}, l);
      float localHueSignal = smoothstep(
        ${DESKTOP_LANTERN_GRADE.hueSignalStart.toFixed(4)},
        ${DESKTOP_LANTERN_GRADE.hueSignalFull.toFixed(3)}, l);
      // Even hue protection needs a tiny measured signal. Applying it to pure
      // black changed the authored night pigment inside a camera-centred disc.
      // And only as much as this pixel actually IS lantern light. Gated on a
      // luminance threshold, the protection stripped the violet night from
      // everything near the camera that caught a trace of light, so the
      // lantern's surroundings went blacker than the night beyond them and the
      // pool read as a bounded blob in a dark moat. Warmth — how far red leads
      // blue — falls away exactly as the flame's share of the light does, so
      // the hand-off from amber to night is as graduated as the light itself.
      float warmth = smoothstep(0.02, 0.5, (c.r - c.b) / max(c.r + c.g + c.b, 1e-4) * 2.4);
      float localHueProtection = uLocalLight * localProximity * localHueSignal * warmth;
      float localPaintProtection = localHueProtection * localSignal;
      // dusk split-tone: WARM the lit areas (golden rims), COOL the shadows
      // (dusk blue), scaled by uWarmth. The amount rides luminance so it can't
      // swamp dark dusk terrain — warming the SHADOWS (the old formula) reddened
      // the whole low-sun scene into a muddy red-out.
      c.r += uWarmth * (0.05 * l);
      c.g += uWarmth * (0.013 * l);
      // Cool ambient night shadows remain violet-blue, but a local flame must
      // not have blue injected into its amber pool.
      c.b += uWarmth * (
        0.022 * (1.0 - l) * (1.0 - localHueProtection) - 0.012 * l);
      // Saturation, capped so no channel is pushed below black. Faint amber
      // light is mostly red with a little green and almost no blue; pushed
      // apart per channel, the blue and green clipped to zero first, and the
      // lantern's pool came out as a hard red ribbon where it should fade.
      c = hueSafeSaturation(c, l, uSaturation);
      // A midpoint contrast curve turns very dim positive light into negative
      // values which the final output clamp converts to pure black. Preserve
      // that low-energy gradient around an active cave lantern so its falloff
      // keeps the smooth toe seen in the direct WebXR ACES path.
      float localShadow = localPaintProtection
        * (1.0 - smoothstep(0.08, 0.38, l));
      float localContrast = mix(uContrast, 1.0, localShadow);
      // Contrast about mid-grey, on luminance and applied as one scale for all
      // three channels, with a toe that eases the curve out toward black. The
      // per-channel form drove every dim value under 0.03 negative, so light
      // never faded: it stopped, channel by channel, at a hard edge.
      c = toeSafeContrast(c, localContrast);
      // --- Ghibli pastel: luminous gouache light ---------------------------
      // shadow-pigment lift (mix toward a cool blue-violet, NOT additive grey),
      // raised value, softened contrast; gated by day so nights stay deep.
      {
        vec3 g = c;
        float lg = dot(g, vec3(0.2126, 0.7152, 0.0722));
        float sh = 1.0 - smoothstep(0.0, 0.5, lg);           // shadow mask
        // The violet night pigment is attractive in ambient shadow, but mixing
        // it into weak amber illumination makes the lantern pool magenta.
        // Preserve the physical light hue wherever the carried light has a
        // nearby signal, while leaving unlit night shadows fully authored.
        //
        // The violet is not in the scene, though: the grade lays it in as a
        // floor under dark pixels. So it must not simply be withheld near the
        // lantern — there, the only real light is a trace of amber, and taking
        // the floor away left a black moat between the flame's pool and the
        // night. Near the lantern the floor is ADDED beneath the light instead
        // of replacing it: night plus flame, fading to plain night as the flame
        // fades, so the two meet in one continuous gradient.
        float pigmentProtection = localHueProtection
          * (1.0 - smoothstep(0.16, 0.52, lg));
        float pigmentMix = sh * uLift * 4.0;
        vec3 nightFloor = uShadowCol * (0.55 + 0.9 * lg);
        vec3 overNight = g + nightFloor * (1.0 - smoothstep(0.0, 0.32, lg));
        g = mix(g, mix(max(g, nightFloor), overNight, pigmentProtection), pigmentMix);
        g = pow(max(g, 0.0), vec3(uPastelVal));              // airy value raise
        g = toeSafeContrast(g, uPastelCon);                  // gentle contrast
        float lg2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
        g = hueSafeSaturation(g, lg2, 1.12);                 // keep colors lush
        c = mix(c, g, uGhibli * (0.25 + 0.75 * uDay));
      }
      // --- Phase 3-lite: painted surface (no Kuwahara — the art style is
      // already flat-shaded, so paper tooth + gentle value grouping is enough)
      if (uGhibli > 0.001) {
        float lp = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // soft value grouping: nudge luminance toward gentle bands so light
        // gathers into painted masses; skies/highlights stay smooth (gated)
        // A continuous staircase rather than floor(): values still gather into
        // painted masses, but every step is a ramp, so no edge in the image is
        // made by the grade itself. And none of it at night, where the only
        // light worth grouping is a flame's, and a flame's light is a gradient.
        float lx = lp * 7.0;
        float lq = (floor(lx) + smoothstep(0.2, 0.8, fract(lx))) / 7.0;
        float gAmt = uGroup * uGhibli * (1.0 - smoothstep(0.62, 0.85, lp))
          * smoothstep(0.15, 0.6, uDay);
        // Keep painted grouping in midtones and highlights, but do not turn a
        // continuous pool of lantern light into concentric value bands.
        float localGradient = localPaintProtection
          * (1.0 - smoothstep(0.22, 0.58, lp));
        gAmt *= 1.0 - localGradient * 0.92;
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

// Metres of scene the GTAO prepass draws (see the gtao.render wrapper).
const GTAO_RANGE = 300;

// The exact first line of the bloom high-pass shader in r165 and r185. Bloom
// is the filter that turns one NaN/Inf pixel into the largest black square
// (its mip chain blurs it at 1/32 resolution), so its input is sanitised.
const BLOOM_HIGH_PASS_FETCH = 'vec4 texel = texture2D( tDiffuse, vUv );';

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
    // The pass only computes and denoises the occlusion; the grade applies it.
    // Its Default output spent a full-resolution HDR copy plus a multiply
    // blend on what is a single texture fetch in a pass that already runs.
    gtao.output = GTAOPass.OUTPUT.Off;
    gtao.needsSwap = false;
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
    //
    // The prepass also only draws what AO can still resolve. A 0.5 m radius
    // spans about one half-resolution pixel by ~250 m, so beyond GTAO_RANGE
    // the prepass was re-submitting most of the visible world (~65% of its
    // draw calls) to compute nothing but depth-precision speckle on the far
    // horizon and occlusion on cloud banks. A nearer far plane, held for the
    // whole pass so the reconstruction matrices agree with the depth they
    // read, lets frustum culling drop all of it. Cleared depth reads as open
    // sky to the AO shader, exactly as the old distant result effectively was.
    const origGtaoRender = gtao.render.bind(gtao);
    const gtaoHidden = [];
    gtao.render = (r2, writeBuffer, readBuffer, deltaTime, maskActive) => {
      // Debug outputs (AO/normal/depth views) composite through the chain.
      gtao.needsSwap = gtao.output !== GTAOPass.OUTPUT.Off;
      gtaoHidden.length = 0;
      scene.traverse((o) => {
        if (!o.visible || !o.material) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if ((m.map && m.alphaTest > 0) || m.userData.excludeFromAO) { o.visible = false; gtaoHidden.push(o); return; }
        }
      });
      const far = camera.far;
      const clampFar = far > GTAO_RANGE;
      if (clampFar) { camera.far = GTAO_RANGE; camera.updateProjectionMatrix(); }
      try {
        origGtaoRender(r2, writeBuffer, readBuffer, deltaTime, maskActive);
      } finally {
        if (clampFar) { camera.far = far; camera.updateProjectionMatrix(); }
        for (const o of gtaoHidden) o.visible = true;
      }
    };

    composer.addPass(gtao);
  } catch (e) {
    console.warn('GTAO unavailable, skipping AO:', e);
  }

  const bloom = new UnrealBloomPass(size.clone(), 0.08, 0.5, 0.85); // strength, radius, threshold
  const highPass = bloom.materialHighPassFilter;
  if (highPass?.fragmentShader?.includes(BLOOM_HIGH_PASS_FETCH)) {
    highPass.fragmentShader = highPass.fragmentShader.replace(BLOOM_HIGH_PASS_FETCH, `${BLOOM_HIGH_PASS_FETCH}
      if (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0);`);
    highPass.needsUpdate = true;
  } else {
    console.warn('[post] bloom high-pass guard did not apply: UnrealBloomPass no longer '
      + 'matches BLOOM_HIGH_PASS_FETCH, so a non-finite pixel can bloom into a black square.');
  }
  composer.addPass(bloom);

  // Signature experiments live after bloom but before the final tonemap/grade,
  // so ink and warm shafts participate in the same painterly colour treatment.
  // Ink starts off for a true A/B review; rays are user-enabled by default but
  // their pass is skipped entirely outside the low, on-screen sun window.
  const ink = new InkLinePass(scene, camera, soft);
  composer.addPass(ink);
  // The shafts' bright-sky mask comes from the soft buffer and this frame's
  // scene depth rather than a second rasterisation of the whole world.
  const godRays = new GodRayPass(scene, camera, soft);
  composer.addPass(godRays);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  // ShaderPass clones GradeShader.uniforms, so the soft buffer has to be bound
  // on the clone the pass actually renders with.
  grade.uniforms.tSoft.value = soft.texture;
  if (gtao) grade.uniforms.tAO.value = gtao.pdRenderTarget.texture;

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
    render() {
      grade.uniforms.uAO.value = gtao?.enabled && gtao.output === GTAOPass.OUTPUT.Off
        ? gtao.blendIntensity : 0;
      composer.render();
    },
    gtao, bloom, ink, godRays, grade,   // exposed for debugging / tuning
    // Trailer production can pin a scene to the authored daytime default
    // without changing the game's normal dawn/night bloom response.
    bloomStrengthOverride: null,
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
      grade.uniforms.uLocalLight.value = desktopLanternGradeProtection(
        caveAtmosphere?.lanternIntensity ?? 0,
      );
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
      const dynamicBloom = 0.08 + (1 - grade.uniforms.uDay.value) * 0.10
        + (weather?.mist || 0) * dayness * 0.06 - caveFactor * 0.035;
      bloom.strength = Number.isFinite(this.bloomStrengthOverride)
        ? this.bloomStrengthOverride : dynamicBloom;
      // dusk goes PASTEL, not hyper-saturated — pull saturation down as the sun
      // drops so neither the warm sky nor the cool shadows blow out to neon.
      grade.uniforms.uSaturation.value = this.satBase - baseWarmth * 0.24
        - weatherShade * 0.10 - caveFactor * 0.10;
    },
  };
}
