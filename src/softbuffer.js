// A quarter-resolution blurred copy of the scene, tapped before bloom.
//
// The grade pass mixes toward this with distance, so far ground dissolves the
// way a wash spreads on wet paper instead of resolving into pixel detail that
// no atmosphere would have preserved. Paint runs; pixels do not.
//
// Distance comes from the DEPTH buffer, read during the downsample and written
// into the small buffer's alpha, so the blur carries colour and distance
// together and the grade pass gets both from one fetch.
//
// The composer's alpha channel would have been cheaper still, but it is not
// actually free: Three forces alpha to 1.0 for every OPAQUE material,
// transparent materials blend their opacity through it, and custom
// ShaderMaterials write their own — three conflicting meanings already in the
// channel, which would have to be reconciled across every material in the
// renderer. Depth is written once, by the rasteriser, with one meaning, and it
// costs no per-material changes at all.
//
// The blurred image is the part that is NOT free: one downsample and two
// separable blur taps. At quarter resolution that is ~1/16th of a full-screen
// pass each in fragments, so roughly a fifth of one full-screen pass in total.
//
// It is deliberately a tap rather than a link in the chain: needsSwap is false
// and the read buffer is passed through untouched. It sits immediately after
// the scene render so it sees authoritative scene depth before GTAO's
// composite, and before bloom adds light that has no business bleeding into a
// distance wash.
//
// Alpha is carried through the blur alongside colour, so one texture fetch in
// the grade pass yields both the softened colour and the distance that decides
// how much of it to use.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  BLUR_WEIGHTS,
  DOWN_WEIGHTS,
  SOFT_BACKGROUND_ALPHA,
  WASH,
} from './softkernel.mjs?v=2';

const DW = DOWN_WEIGHTS;
const BW = BLUR_WEIGHTS;

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 13-tap box-ish downsample (the Call of Duty / Jimenez dual-filter kernel).
// Chosen over a naive bilinear halving because it does not alias thin bright
// grass blades into crawling speckle when the camera moves — the whole point is
// a stable wash, and a flickering one would read as noise rather than paint.
const DOWN_FRAG = /* glsl */`
  #include <packing>
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uCameraNear;
  uniform float uCameraFar;
  varying vec2 vUv;

  // Preserve linear view distance in alpha. The grade derives its wash amount
  // from this and can also distinguish nearby lamplight from distant darkness
  // without allocating another depth-aware post pass.
  float distanceAt(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    // Background: nothing was rasterised. The sky dome does not write depth, so
    // this is where the sky lands. A negative sentinel still means zero wash,
    // but lets local-light grading distinguish sky from genuinely near ground.
    if (d >= ${WASH.skyDepth.toFixed(1)}) return ${SOFT_BACKGROUND_ALPHA.toFixed(1)};
    float viewZ = perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
    float dist = -viewZ;
    return min(dist / ${WASH.far.toFixed(1)}, 1.0);
  }

  // A non-finite scene pixel (NaN/Inf from any material) must not enter the
  // blur: two separable passes would spread it over a 7x7 quarter-resolution
  // block, and the grade's mix() propagates NaN even at zero wash weight, so
  // one bad pixel became a ~28px black square. Drop it from the average.
  vec4 tap(vec2 uv) {
    vec4 c = texture2D(tDiffuse, uv);
    return (any(isnan(c)) || any(isinf(c))) ? vec4(0.0) : c;
  }

  void main() {
    vec2 t = uTexel;
    vec4 a = tap(vUv + t * vec2(-2.0, -2.0));
    vec4 b = tap(vUv + t * vec2( 0.0, -2.0));
    vec4 c = tap(vUv + t * vec2( 2.0, -2.0));
    vec4 d = tap(vUv + t * vec2(-2.0,  0.0));
    vec4 e = tap(vUv);
    vec4 f = tap(vUv + t * vec2( 2.0,  0.0));
    vec4 g = tap(vUv + t * vec2(-2.0,  2.0));
    vec4 h = tap(vUv + t * vec2( 0.0,  2.0));
    vec4 i = tap(vUv + t * vec2( 2.0,  2.0));
    vec4 j = tap(vUv + t * vec2(-1.0, -1.0));
    vec4 k = tap(vUv + t * vec2( 1.0, -1.0));
    vec4 l = tap(vUv + t * vec2(-1.0,  1.0));
    vec4 m = tap(vUv + t * vec2( 1.0,  1.0));
    gl_FragColor = e * ${DW.centre}
                 + (a + c + g + i) * ${DW.corners}
                 + (b + d + f + h) * ${DW.edges}
                 + (j + k + l + m) * ${DW.inner};
    // Colour and normalized distance travel together through the blur so the
    // grade pass still needs only one texture fetch.
    gl_FragColor.a = distanceAt(vUv);
  }
`;

// Separable 5-tap gaussian, run once horizontally and once vertically.
const BLUR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec2 d = uTexel * uDir;
    vec4 c = texture2D(tDiffuse, vUv) * ${BW.centre};
    c += (texture2D(tDiffuse, vUv + d * 1.3846) + texture2D(tDiffuse, vUv - d * 1.3846)) * ${BW.near};
    c += (texture2D(tDiffuse, vUv + d * 3.2308) + texture2D(tDiffuse, vUv - d * 3.2308)) * ${BW.far};
    gl_FragColor = c;
  }
`;

function softTarget(width, height) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class SoftBufferPass extends Pass {
  constructor(width, height, scale = 0.25) {
    super();
    // A tap, not a link: the chain's image is handed on exactly as it arrived.
    this.needsSwap = false;
    this.scale = scale;
    this.enabled = true;
    this._sceneDepth = null;

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    this.targetA = softTarget(w, h);
    this.targetB = softTarget(w, h);
    // The unblurred downsample keeps its own target so other effects can use
    // a quarter-resolution scene that still resolves canopy gaps (see
    // `sharpTexture`). It costs memory only: the blur reads from it in place
    // of the copy it used to overwrite.
    this.targetDown = softTarget(w, h);

    this.downMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 1000 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uDir: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.downMaterial);
    this.setSize(width, height);
  }

  /** The blurred scene + normalized view distance, for the grade pass. */
  get texture() {
    return this.targetA.texture;
  }

  /** This frame's quarter-resolution scene before the wash blur, same alpha. */
  get sharpTexture() {
    return this.targetDown.texture;
  }

  /**
   * This frame's full-resolution scene depth, or null before the first frame.
   * The composer ping-pongs its targets, so only this pass knows which of the
   * two depth attachments the scene was actually rasterised into.
   */
  get sceneDepth() {
    return this.enabled ? this._sceneDepth : null;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.targetA.setSize(w, h);
    this.targetB.setSize(w, h);
    this.targetDown.setSize(w, h);
    this.fullTexel = this.fullTexel || new THREE.Vector2();
    this.fullTexel.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.smallTexel = this.smallTexel || new THREE.Vector2();
    this.smallTexel.set(1 / w, 1 / h);
  }

  /** The scene camera, for depth linearisation. Set once by post.js. */
  setCamera(camera) {
    this.downMaterial.uniforms.uCameraNear.value = camera.near;
    this.downMaterial.uniforms.uCameraFar.value = camera.far;
  }

  render(renderer, writeBuffer, readBuffer) {
    // RenderPass has needsSwap = false, so readBuffer is still the target the
    // scene was rasterised into — its depthTexture is this frame's depth,
    // whichever of the composer's two ping-pong buffers it happens to be.
    const depth = readBuffer.depthTexture;
    this._sceneDepth = depth || null;
    if (!depth) return;   // no depth attached: leave the buffer alone rather
                          // than washing the frame with a stale distance

    const prevTarget = renderer.getRenderTarget();

    // full res -> quarter res
    this.quad.material = this.downMaterial;
    this.downMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.downMaterial.uniforms.tDepth.value = depth;
    this.downMaterial.uniforms.uTexel.value.copy(this.fullTexel);
    renderer.setRenderTarget(this.targetDown);
    this.quad.render(renderer);

    // separable blur, down -> B (horizontal) -> A (vertical), so the finished
    // wash always ends up in targetA and `texture` needs no ping-pong tracking
    this.quad.material = this.blurMaterial;
    this.blurMaterial.uniforms.uTexel.value.copy(this.smallTexel);

    this.blurMaterial.uniforms.tDiffuse.value = this.targetDown.texture;
    this.blurMaterial.uniforms.uDir.value.set(1, 0);
    renderer.setRenderTarget(this.targetB);
    this.quad.render(renderer);

    this.blurMaterial.uniforms.tDiffuse.value = this.targetB.texture;
    this.blurMaterial.uniforms.uDir.value.set(0, 1);
    renderer.setRenderTarget(this.targetA);
    this.quad.render(renderer);

    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.targetA.dispose();
    this.targetB.dispose();
    this.targetDown.dispose();
    this.downMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.dispose();
  }
}
