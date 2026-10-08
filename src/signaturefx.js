// Optional signature-style post effects.
//
// A1 — depth-only ink contours.  This deliberately does not inspect normals:
// terrain facets and leaf-card normals must never become lines.  A structural
// depth prepass also omits alpha-cutout/thin foliage, avoiding noisy leaf edges.
//
// A2 — low-sun shafts.  A quarter-resolution bright-sky mask with real
// canopy/terrain occlusion is blurred radially toward the projected sun, then
// added back into the linear-HDR image.  The mask reads the distance wash's
// quarter-resolution scene colour and this frame's depth, both already paid
// for; only without them does it fall back to rasterising the scene again.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function depthTarget(width, height, type = THREE.UnsignedByteType) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
  target.depthTexture.format = THREE.DepthFormat;
  target.depthTexture.minFilter = THREE.NearestFilter;
  target.depthTexture.magFilter = THREE.NearestFilter;
  return target;
}

function colorTarget(width, height) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

const InkShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 11000 },
    uThreshold: { value: 0.042 },
    uStrength: { value: 0.52 },
    uFadeStart: { value: 125 },
    uFadeEnd: { value: 205 },
    uInkColor: { value: new THREE.Color(0.055, 0.065, 0.085) },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uTexel;
    uniform float uCameraNear, uCameraFar, uThreshold, uStrength;
    uniform float uFadeStart, uFadeEnd;
    uniform vec3 uInkColor;
    varying vec2 vUv;

    float viewDistance(float depth) {
      float viewZ = (uCameraNear * uCameraFar)
        / ((uCameraFar - uCameraNear) * depth - uCameraFar);
      return -viewZ;
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float center = viewDistance(texture2D(tDepth, vUv).x);
      float right = viewDistance(texture2D(tDepth, vUv + vec2(uTexel.x, 0.0)).x);
      float left  = viewDistance(texture2D(tDepth, vUv - vec2(uTexel.x, 0.0)).x);
      float up    = viewDistance(texture2D(tDepth, vUv + vec2(0.0, uTexel.y)).x);
      float down  = viewDistance(texture2D(tDepth, vUv - vec2(0.0, uTexel.y)).x);

      // One-sided test: only the foreground pixel receives ink.  That keeps a
      // silhouette to roughly one physical pixel instead of a two-pixel halo.
      float jump = max(max(right - center, left - center),
                       max(up - center, down - center));
      float relativeJump = max(jump, 0.0) / max(center, 1.0);
      float edge = smoothstep(uThreshold, uThreshold * 2.8, relativeJump);
      float distanceFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, center);
      float amount = edge * distanceFade * uStrength;
      gl_FragColor = vec4(mix(color, uInkColor, amount), 1.0);
    }
  `,
};

// Ink from the CURVATURE of this frame's scene depth (Sakura Crossing's
// approach): the second difference of linear depth is flat across any plane
// however obliquely it is seen, so it fires only on real silhouettes and
// creases. Convex (near side of a silhouette, a ridge) inks strongly; concave
// (inside corners, contact) inks faintly, like an animator's lighter contact
// lines. It reads the depth the main pass already wrote, so unlike the
// structural mode it costs no second rasterisation of the world.
const InkCurvatureShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 11000 },
    uThickness: { value: 1.25 },
    uSens: { value: 0.0042 },
    uConcave: { value: 0.026 },
    uConcaveAmount: { value: 0.42 },
    uFadeStart: { value: 45 },
    uFadeEnd: { value: 140 },
    uStrength: { value: 0.8 },
    uInkColor: { value: new THREE.Color(0.10, 0.085, 0.16) },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uTexel;
    uniform float uCameraNear, uCameraFar, uThickness, uSens, uConcave, uConcaveAmount;
    uniform float uFadeStart, uFadeEnd, uStrength;
    uniform vec3 uInkColor;
    varying vec2 vUv;

    float linearDepth(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uCameraNear, uCameraFar);
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float raw = texture2D(tDepth, vUv).x;
      if (raw >= 1.0) { gl_FragColor = vec4(color, 1.0); return; }   // sky
      vec2 t = uTexel * uThickness;
      float dc = linearDepth(vUv);
      float dl = linearDepth(vUv - vec2(t.x, 0.0)), dr = linearDepth(vUv + vec2(t.x, 0.0));
      float du = linearDepth(vUv + vec2(0.0, t.y)), dd = linearDepth(vUv - vec2(0.0, t.y));
      float sx = (dl + dr - 2.0 * dc) / dc;
      float sy = (du + dd - 2.0 * dc) / dc;
      // A grass blade or twig thinner than the kernel has open space on BOTH
      // sides of one axis, and would ink as a solid dark stroke — a meadow
      // of them is noise. A silhouette or crease is one-sided; keep those.
      float gap = 0.06 * dc;
      float thin = max(step(gap, dl - dc) * step(gap, dr - dc), step(gap, du - dc) * step(gap, dd - dc));
      sx *= 1.0 - thin * step(gap, dl - dc) * step(gap, dr - dc);
      sy *= 1.0 - thin * step(gap, du - dc) * step(gap, dd - dc);
      float convex = max(0.0, sx) + max(0.0, sy);
      float concave = max(0.0, -sx) + max(0.0, -sy);
      float edge = smoothstep(uSens * 0.32, uSens, convex);
      edge = max(edge, smoothstep(uConcave, uConcave * 3.4, concave) * uConcaveAmount);
      edge *= (1.0 - smoothstep(uFadeStart, uFadeEnd, dc)) * uStrength;
      // the line keeps a whisper of the hue under it, so it never looks pasted on
      vec3 line = mix(uInkColor, color * 0.42, 0.22);
      gl_FragColor = vec4(mix(color, line, clamp(edge, 0.0, 1.0)), 1.0);
    }
  `,
};

const RayMaskShader = {
  uniforms: {
    tScene: { value: null },
    tDepth: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 11000 },
    uSkyStart: { value: 900 },
    uSkyFull: { value: 2200 },
    uThreshold: { value: 0.38 },
    uMaskGain: { value: 1 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tScene, tDepth;
    uniform vec2 uSun;
    uniform float uCameraNear, uCameraFar, uSkyStart, uSkyFull, uThreshold, uMaskGain;
    varying vec2 vUv;

    float viewDistance(float depth) {
      float viewZ = (uCameraNear * uCameraFar)
        / ((uCameraFar - uCameraNear) * depth - uCameraFar);
      return -viewZ;
    }

    void main() {
      vec3 c = texture2D(tScene, vUv).rgb;
      float luminance = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float sky = smoothstep(uSkyStart, uSkyFull,
                             viewDistance(texture2D(tDepth, vUv).x));
      float aroundSun = 1.0 - smoothstep(0.045, 0.34, distance(vUv, uSun));
      float bright = smoothstep(uThreshold, uThreshold + 0.75, luminance);
      gl_FragColor = vec4(vec3(bright * sky * aroundSun * uMaskGain), 1.0);
    }
  `,
};

const RadialBlurShader = {
  uniforms: {
    tMask: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.92 },
    uDecay: { value: 0.945 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tMask;
    uniform vec2 uSun;
    uniform float uDensity, uDecay;
    varying vec2 vUv;

    void main() {
      const int SAMPLES = 24;
      vec2 stepToSun = (uSun - vUv) * (uDensity / float(SAMPLES));
      vec2 sampleUv = vUv;
      float illumination = 1.0;
      float total = 0.0;
      float weight = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        sampleUv += stepToSun;
        float inside = step(0.0, sampleUv.x) * step(sampleUv.x, 1.0)
                     * step(0.0, sampleUv.y) * step(sampleUv.y, 1.0);
        total += texture2D(tMask, clamp(sampleUv, 0.0, 1.0)).r * illumination * inside;
        weight += illumination * inside;
        illumination *= uDecay;
      }
      gl_FragColor = vec4(vec3(total / max(weight, 0.001)), 1.0);
    }
  `,
};

const RayCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tRays: { value: null },
    uColor: { value: new THREE.Color(1.0, 0.72, 0.38) },
    uStrength: { value: 0.16 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tRays;
    uniform vec3 uColor;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;
      float rays = texture2D(tRays, vUv).r;
      gl_FragColor = vec4(sceneColor + uColor * rays * uStrength, 1.0);
    }
  `,
};

export class InkLinePass extends Pass {
  constructor(scene, camera, softBuffer = null) {
    super();
    this.scene = scene;
    this.camera = camera;
    // 'structural' re-renders a foliage-free depth prepass; 'curvature' reads
    // the main pass's depth (via the soft buffer) and costs no extra raster.
    this.mode = 'structural';
    this.softBuffer = softBuffer;
    this.curvatureMaterial = new THREE.ShaderMaterial(InkCurvatureShader);
    this.userEnabled = false;
    this.enabled = false;
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial(InkShader);
    this.fsQuad = new FullScreenQuad(this.material);
    this.depthMaterial = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.depthMaterial.colorWrite = false;
    this.depth = depthTarget(1, 1);
    this.depth.texture.name = 'WANDER.InkDepthColor';
    this.depth.depthTexture.name = 'WANDER.InkDepth';
    this._hidden = [];
  }

  get strength() { return this.material.uniforms.uStrength.value; }
  set strength(value) { this.material.uniforms.uStrength.value = value; }
  get threshold() { return this.material.uniforms.uThreshold.value; }
  set threshold(value) { this.material.uniforms.uThreshold.value = value; }
  get fadeDistance() { return this.material.uniforms.uFadeEnd.value; }
  set fadeDistance(value) {
    this.material.uniforms.uFadeEnd.value = value;
    this.material.uniforms.uFadeStart.value = value * 0.61;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    this.depth.setSize(w, h);
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  _renderStructuralDepth(renderer) {
    this._hidden.length = 0;
    this.scene.traverse((object) => {
      if (!object.visible || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const exclude = materials.some((material) => material && (
        material.alphaTest > 0
        || material.userData?.excludeFromAO
        || (material.transparent && !material.depthWrite)
      ));
      if (exclude) {
        object.visible = false;
        this._hidden.push(object);
      }
    });

    const oldOverride = this.scene.overrideMaterial;
    try {
      this.scene.overrideMaterial = this.depthMaterial;
      renderer.setRenderTarget(this.depth);
      renderer.clear(false, true, false);
      renderer.render(this.scene, this.camera);
    } finally {
      this.scene.overrideMaterial = oldOverride;
      for (const object of this._hidden) object.visible = true;
    }
  }

  get curvatureStrength() { return this.curvatureMaterial.uniforms.uStrength.value; }
  set curvatureStrength(value) { this.curvatureMaterial.uniforms.uStrength.value = value; }

  render(renderer, writeBuffer, readBuffer) {
    const sceneDepth = this.mode === 'curvature' ? this.softBuffer?.sceneDepth : null;
    if (sceneDepth) {
      const u = this.curvatureMaterial.uniforms;
      u.tDiffuse.value = readBuffer.texture;
      u.tDepth.value = sceneDepth;
      u.uTexel.value.set(1 / sceneDepth.image.width, 1 / sceneDepth.image.height);
      u.uCameraNear.value = this.camera.near;
      u.uCameraFar.value = this.camera.far;
      this.fsQuad.material = this.curvatureMaterial;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
      return;
    }
    this.fsQuad.material = this.material;
    this._renderStructuralDepth(renderer);
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = this.depth.depthTexture;
    this.material.uniforms.uCameraNear.value = this.camera.near;
    this.material.uniforms.uCameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.depth.dispose();
    this.depthMaterial.dispose();
    this.material.dispose();
    this.curvatureMaterial.dispose();
    this.fsQuad.dispose();
  }
}

export class GodRayPass extends Pass {
  constructor(scene, camera, softBuffer = null) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.softBuffer = softBuffer;
    this.userEnabled = true;
    this.enabled = false; // update() enables it only during the useful solar window
    this.needsSwap = true;
    this.baseStrength = 0.16;
    this.sceneTarget = depthTarget(1, 1, THREE.HalfFloatType);
    this.maskTarget = colorTarget(1, 1);
    this.rayTarget = colorTarget(1, 1);
    this.maskMaterial = new THREE.ShaderMaterial(RayMaskShader);
    this.blurMaterial = new THREE.ShaderMaterial(RadialBlurShader);
    this.compositeMaterial = new THREE.ShaderMaterial(RayCompositeShader);
    this.fsQuad = new FullScreenQuad(this.maskMaterial);
    this.sunScreen = new THREE.Vector2(0.5, 0.5);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width * 0.25));
    const h = Math.max(1, Math.ceil(height * 0.25));
    this.sceneTarget.setSize(w, h);
    this.maskTarget.setSize(w, h);
    this.rayTarget.setSize(w, h);
  }

  setSun(screenPosition, color, strengthScale) {
    this.sunScreen.copy(screenPosition);
    this.maskMaterial.uniforms.uSun.value.copy(screenPosition);
    this.blurMaterial.uniforms.uSun.value.copy(screenPosition);
    this.compositeMaterial.uniforms.uColor.value.copy(color);
    this.compositeMaterial.uniforms.uStrength.value = this.baseStrength * strengthScale;
  }

  render(renderer, writeBuffer, readBuffer) {
    // The mask needs the scene's colour and depth with native materials, so
    // alphaTest foliage occludes as real canopy and shafts come through the
    // leaf gaps. The main pass already rasterised exactly that: the soft
    // buffer holds it at quarter resolution, before bloom and before its wash
    // blur (which would fill the small canopy gaps), and its pass records
    // which depth attachment it came from. Rendering the world a
    // second time for this cost ~730 draw calls and 5M triangles a frame
    // through every sunrise and sunset.
    const sceneDepth = this.softBuffer?.sceneDepth;
    if (sceneDepth) {
      this.maskMaterial.uniforms.tScene.value = this.softBuffer.sharpTexture;
      this.maskMaterial.uniforms.tDepth.value = sceneDepth;
      // The 13-tap downsample is a touch softer than a direct quarter-res
      // raster, which measured ~5% less shaft energy across sunrise/sunset
      // views; restore it so the switch is not a visual change.
      this.maskMaterial.uniforms.uMaskGain.value = 1.05;
    } else {
      this.maskMaterial.uniforms.uMaskGain.value = 1;
      renderer.setRenderTarget(this.sceneTarget);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      this.maskMaterial.uniforms.tScene.value = this.sceneTarget.texture;
      this.maskMaterial.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    }
    this.maskMaterial.uniforms.uCameraNear.value = this.camera.near;
    this.maskMaterial.uniforms.uCameraFar.value = this.camera.far;
    this.fsQuad.material = this.maskMaterial;
    renderer.setRenderTarget(this.maskTarget);
    renderer.clear();
    this.fsQuad.render(renderer);

    this.blurMaterial.uniforms.tMask.value = this.maskTarget.texture;
    this.fsQuad.material = this.blurMaterial;
    renderer.setRenderTarget(this.rayTarget);
    renderer.clear();
    this.fsQuad.render(renderer);

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tRays.value = this.rayTarget.texture;
    this.fsQuad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.maskTarget.dispose();
    this.rayTarget.dispose();
    this.maskMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}
