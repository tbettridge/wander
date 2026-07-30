import * as THREE from 'three';
import {
  describeMultiviewCapability,
  describeProductionMultiviewReadiness,
  injectMultiviewVertexShader,
} from './xrexperiments.mjs?v=3';

const MULTIVIEW_PROGRAM_KEY = 'wander-ovr-multiview-scene-v1';

function materialList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function glErrorLabel(gl, value) {
  const labels = new Map([
    [gl.INVALID_ENUM, 'INVALID_ENUM'],
    [gl.INVALID_VALUE, 'INVALID_VALUE'],
    [gl.INVALID_OPERATION, 'INVALID_OPERATION'],
    [gl.INVALID_FRAMEBUFFER_OPERATION, 'INVALID_FRAMEBUFFER_OPERATION'],
    [gl.OUT_OF_MEMORY, 'OUT_OF_MEMORY'],
    [gl.CONTEXT_LOST_WEBGL, 'CONTEXT_LOST_WEBGL'],
  ]);
  return labels.get(value) || `WebGL error 0x${Number(value).toString(16)}`;
}

function completeFramebuffer(gl, target, label) {
  const status = gl.checkFramebufferStatus(target);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`${label} framebuffer incomplete (0x${status.toString(16)})`);
  }
}

/**
 * Experimental full-scene OVR_multiview2 renderer.
 *
 * Three's stable WebGL XR path owns the compositor render target and renders an
 * ArrayCamera sequentially. This class leaves that path intact. When explicitly
 * requested it renders the scene once into a two-layer texture array, then
 * blits each layer into the current r185 XRProjectionLayer texture. Any failed
 * capability, shader, framebuffer or WebGL check tears the experiment down and
 * lets the caller render the same frame with Three's normal stereo path.
 */
export class XRMultiviewSceneRenderer {
  constructor(renderer, xrPerformance) {
    this.renderer = renderer;
    this.xrPerformance = xrPerformance;
    this.gl = renderer.getContext();
    this.extension = null;
    this.capability = null;
    this.requested = false;
    this.session = null;
    this.armed = false;
    this.active = false;
    this.resources = null;
    this.releaseGpuTimingPause = null;
    this._sceneRenderActive = false;
    this._failurePending = null;
    this._frameSerial = 0;
    this._matrixData = new Float32Array(32);
    this._eyeClip = [new THREE.Matrix4(), new THREE.Matrix4()];
    this._eyeFromUnion = new THREE.Matrix4();
    this._materialPatches = new Map();
    this._shaderOriginals = new WeakMap();
    this._patchedShaders = new WeakSet();
    this._uniformLocations = new WeakMap();
    this._uniformFrames = new WeakMap();
    this._glOriginals = null;
    this._boundDrawFramebuffer = null;
    this._currentProgram = null;
    this.debug = {
      requested: false,
      active: false,
      status: 'full-scene renderer disabled',
      fallback: 'none',
      views: 'stereo baseline',
    };
    this.refreshCapability();
  }

  setRequested(requested) {
    this.requested = !!requested;
    this.debug.requested = this.requested;
    if (this.session) {
      this.debug.status = this.requested
        ? 'requested · restart XR session to apply'
        : 'disabled · restart XR session to restore GPU timing';
    } else {
      this.debug.status = this.requested
        ? 'requested for next XR session'
        : 'full-scene renderer disabled';
    }
  }

  refreshCapability() {
    const gl = this.gl;
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
      && gl instanceof WebGL2RenderingContext;
    this.extension = isWebGL2 && !gl.isContextLost?.()
      ? gl.getExtension('OVR_multiview2') : null;
    const maxViews = this.extension
      ? Number(gl.getParameter(this.extension.MAX_VIEWS_OVR)) || 0 : 0;
    this.capability = describeMultiviewCapability({
      isWebGL2,
      extensionPresent: !!this.extension,
      maxViews,
      contextLost: gl.isContextLost?.() || false,
    });
    return this.capability;
  }

  startSession(session, requested = this.requested) {
    this.endSession();
    this.session = session;
    this.requested = !!requested;
    this.debug.requested = this.requested;
    this.debug.active = false;
    this.debug.fallback = 'none';
    this.debug.views = 'stereo baseline';
    if (!this.requested) {
      this.debug.status = 'full-scene renderer disabled';
      return false;
    }

    const capability = this.refreshCapability();
    if (!capability.supported) {
      this._fallback(capability.reason, { teardown: false });
      return false;
    }
    if (typeof this.renderer.setRenderTargetFramebuffer !== 'function') {
      this._fallback('Three.js external framebuffer API unavailable', { teardown: false });
      return false;
    }

    try {
      this.releaseGpuTimingPause = this.xrPerformance.acquireGpuTimingPause(
        'OVR multiview scene renderer',
      );
      const timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (timer && this.gl.getQuery(timer.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null) {
        throw new Error('GPU timer query remained active');
      }
      this._installGLHooks();
      this.armed = true;
      this.debug.status = 'armed · waiting for two XR views';
      return true;
    } catch (error) {
      this._fallback(error?.message || error);
      return false;
    }
  }

  endSession() {
    this._teardown();
    this.session = null;
    this.active = false;
    this.armed = false;
    this.debug.active = false;
    this.debug.views = 'stereo baseline';
    if (!this.requested) this.debug.status = 'full-scene renderer disabled';
  }

  _fallback(reason, { teardown = true } = {}) {
    const message = String(reason || 'unknown failure');
    if (teardown) this._teardown();
    this.active = false;
    this.armed = false;
    this.debug.active = false;
    this.debug.views = 'normal stereo fallback';
    this.debug.fallback = message;
    this.debug.status = `fallback · ${message}`;
    console.warn(`WANDER multiview fallback: ${message}`);
  }

  _teardown() {
    this._sceneRenderActive = false;
    this._restoreMaterials();
    this._restoreGLHooks();
    this._deleteResources();
    if (this.releaseGpuTimingPause) {
      this.releaseGpuTimingPause();
      this.releaseGpuTimingPause = null;
    }
  }

  _installGLHooks() {
    if (this._glOriginals) return;
    const gl = this.gl;
    const owner = this;
    const originals = {
      shaderSource: gl.shaderSource.bind(gl),
      compileShader: gl.compileShader.bind(gl),
      linkProgram: gl.linkProgram.bind(gl),
      bindFramebuffer: gl.bindFramebuffer.bind(gl),
      useProgram: gl.useProgram.bind(gl),
      drawArrays: gl.drawArrays.bind(gl),
      drawElements: gl.drawElements.bind(gl),
      drawArraysInstanced: gl.drawArraysInstanced.bind(gl),
      drawElementsInstanced: gl.drawElementsInstanced.bind(gl),
      uniformMatrix4fv: gl.uniformMatrix4fv.bind(gl),
    };
    this._glOriginals = originals;
    this._boundDrawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    this._currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);

    gl.bindFramebuffer = function bindFramebuffer(target, framebuffer) {
      originals.bindFramebuffer(target, framebuffer);
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) {
        owner._boundDrawFramebuffer = framebuffer;
      }
    };
    gl.useProgram = function useProgram(program) {
      originals.useProgram(program);
      owner._currentProgram = program;
    };
    gl.shaderSource = function shaderSource(shader, source) {
      let nextSource = source;
      if (owner._sceneRenderActive
          && owner.resources
          && owner._boundDrawFramebuffer === owner.resources.multiviewFramebuffer
          && gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER) {
        nextSource = injectMultiviewVertexShader(source);
        if (nextSource !== source) {
          owner._shaderOriginals.set(shader, source);
          owner._patchedShaders.add(shader);
        }
      }
      originals.shaderSource(shader, nextSource);
    };
    gl.compileShader = function compileShader(shader) {
      originals.compileShader(shader);
      if (owner._patchedShaders.has(shader)
          && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'multiview vertex shader compilation failed';
        const source = owner._shaderOriginals.get(shader);
        if (source) {
          originals.shaderSource(shader, source);
          originals.compileShader(shader);
        }
        owner._failurePending ||= `shader compilation failed · ${log}`;
      }
    };
    gl.linkProgram = function linkProgram(program) {
      originals.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) return;
      const attached = gl.getAttachedShaders(program) || [];
      const patched = attached.filter((shader) => owner._patchedShaders.has(shader));
      if (!patched.length) return;
      const log = gl.getProgramInfoLog(program) || 'multiview shader link failed';
      for (const shader of patched) {
        const source = owner._shaderOriginals.get(shader);
        if (!source) continue;
        originals.shaderSource(shader, source);
        originals.compileShader(shader);
      }
      originals.linkProgram(program);
      owner._failurePending ||= `shader link failed · ${log}`;
    };

    const wrapDraw = (original) => function wrappedDraw(...args) {
      owner._prepareDraw();
      return original(...args);
    };
    gl.drawArrays = wrapDraw(originals.drawArrays);
    gl.drawElements = wrapDraw(originals.drawElements);
    gl.drawArraysInstanced = wrapDraw(originals.drawArraysInstanced);
    gl.drawElementsInstanced = wrapDraw(originals.drawElementsInstanced);
  }

  _restoreGLHooks() {
    const originals = this._glOriginals;
    if (!originals) return;
    const gl = this.gl;
    gl.shaderSource = originals.shaderSource;
    gl.compileShader = originals.compileShader;
    gl.linkProgram = originals.linkProgram;
    gl.bindFramebuffer = originals.bindFramebuffer;
    gl.useProgram = originals.useProgram;
    gl.drawArrays = originals.drawArrays;
    gl.drawElements = originals.drawElements;
    gl.drawArraysInstanced = originals.drawArraysInstanced;
    gl.drawElementsInstanced = originals.drawElementsInstanced;
    this._glOriginals = null;
    this._boundDrawFramebuffer = null;
    this._currentProgram = null;
    this.renderer.resetState?.();
  }

  _prepareDraw() {
    if (!this._sceneRenderActive || !this.resources
        || this._boundDrawFramebuffer !== this.resources.multiviewFramebuffer) return;
    const gl = this.gl;
    const program = this._currentProgram;
    if (!program) {
      this._failurePending ||= 'multiview draw had no active shader program';
      return;
    }
    if (this._uniformFrames.get(program) === this._frameSerial) return;
    let location = this._uniformLocations.get(program);
    if (location === undefined) {
      location = gl.getUniformLocation(program, 'wanderMultiviewClip[0]')
        || gl.getUniformLocation(program, 'wanderMultiviewClip');
      this._uniformLocations.set(program, location);
    }
    if (location === null) {
      this._failurePending ||= 'scene material did not compile a multiview shader';
      return;
    }
    this._glOriginals.uniformMatrix4fv(location, false, this._matrixData);
    this._uniformFrames.set(program, this._frameSerial);
  }

  _patchSceneMaterials(scene) {
    const owner = this;
    const patchMaterial = (material) => {
      if (!material || this._materialPatches.has(material)) return;
      const original = material.customProgramCacheKey;
      this._materialPatches.set(material, original);
      material.customProgramCacheKey = function wanderMultiviewProgramKey() {
        let base = '';
        try { base = original.call(this); } catch (error) { base = ''; }
        const lane = owner._sceneRenderActive ? MULTIVIEW_PROGRAM_KEY : 'wander-normal-stereo';
        return `${base}|${lane}`;
      };
      material.needsUpdate = true;
    };
    patchMaterial(scene.overrideMaterial);
    scene.traverse((object) => {
      for (const material of materialList(object.material)) {
        patchMaterial(material);
      }
    });
  }

  _restoreMaterials() {
    for (const [material, original] of this._materialPatches) {
      material.customProgramCacheKey = original;
      material.needsUpdate = true;
    }
    this._materialPatches.clear();
  }

  _deleteResources() {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    try { resources.target.dispose(); } catch (error) { /* context may be lost */ }
    try { gl.deleteFramebuffer(resources.multiviewFramebuffer); } catch (error) { /* noop */ }
    try { gl.deleteFramebuffer(resources.readFramebuffer); } catch (error) { /* noop */ }
    try { gl.deleteFramebuffer(resources.copyFramebuffer); } catch (error) { /* noop */ }
    try { gl.deleteTexture(resources.colorTexture); } catch (error) { /* noop */ }
    try { gl.deleteTexture(resources.depthTexture); } catch (error) { /* noop */ }
    this.resources = null;
    this.renderer.resetState?.();
  }

  _createResources(width, height) {
    this._deleteResources();
    const gl = this.gl;
    const extension = this.extension;
    const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);

    const colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, colorTexture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, 2);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const depthTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthTexture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, width, height, 2);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const multiviewFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, multiviewFramebuffer);
    extension.framebufferTextureMultiviewOVR(
      gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, colorTexture, 0, 0, 2,
    );
    extension.framebufferTextureMultiviewOVR(
      gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depthTexture, 0, 0, 2,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    completeFramebuffer(gl, gl.DRAW_FRAMEBUFFER, 'scene multiview');

    const readFramebuffer = gl.createFramebuffer();
    const copyFramebuffer = gl.createFramebuffer();
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.name = 'WANDER OVR multiview scene target';
    target.viewport.set(0, 0, width, height);
    target.scissor.set(0, 0, width, height);
    target.scissorTest = false;
    this.renderer.setRenderTargetFramebuffer(target, multiviewFramebuffer);

    this.resources = {
      width,
      height,
      target,
      colorTexture,
      depthTexture,
      multiviewFramebuffer,
      readFramebuffer,
      copyFramebuffer,
    };
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
    gl.activeTexture(previousActiveTexture);
    this.renderer.resetState?.();
  }

  _ensureResources(width, height) {
    if (this.resources?.width === width && this.resources?.height === height) return;
    this._createResources(width, height);
  }

  _frameViews(frame) {
    if (!frame) return null;
    const referenceSpace = this.renderer.xr.getReferenceSpace?.();
    const pose = referenceSpace ? frame.getViewerPose(referenceSpace) : null;
    if (!pose) return null;
    const baseLayer = this.renderer.xr.getBaseLayer?.();
    const binding = this.renderer.xr.getBinding?.();
    if (!baseLayer || !binding || typeof binding.getViewSubImage !== 'function') {
      return { pose, baseLayer, binding, subImages: [] };
    }
    let subImages = [];
    try {
      subImages = pose.views.map((view) => binding.getViewSubImage(baseLayer, view));
    } catch (error) {
      return { pose, baseLayer, binding, subImages: [], error };
    }
    return { pose, baseLayer, binding, subImages };
  }

  _updateEyeMatrices(camera, eyeCameras) {
    for (let eye = 0; eye < 2; eye++) {
      const eyeCamera = eyeCameras[eye];
      this._eyeFromUnion.multiplyMatrices(eyeCamera.matrixWorldInverse, camera.matrixWorld);
      this._eyeClip[eye]
        .multiplyMatrices(eyeCamera.projectionMatrix, this._eyeFromUnion)
        .multiply(camera.projectionMatrixInverse)
        .toArray(this._matrixData, eye * 16);
    }
  }

  _copyLayersToProjection(subImages) {
    const gl = this.gl;
    const resources = this.resources;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resources.readFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.copyFramebuffer);
    for (let eye = 0; eye < 2; eye++) {
      const subImage = subImages[eye];
      const viewport = subImage.viewport;
      gl.framebufferTextureLayer(
        gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, resources.colorTexture, 0, eye,
      );
      if (Number.isInteger(subImage.imageIndex)) {
        gl.framebufferTextureLayer(
          gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          subImage.colorTexture, 0, subImage.imageIndex,
        );
      } else {
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D, subImage.colorTexture, 0,
        );
      }
      completeFramebuffer(gl, gl.READ_FRAMEBUFFER, `multiview eye ${eye}`);
      completeFramebuffer(gl, gl.DRAW_FRAMEBUFFER, `XR eye ${eye}`);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.blitFramebuffer(
        0, 0, resources.width, resources.height,
        viewport.x, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height,
        gl.COLOR_BUFFER_BIT, gl.LINEAR,
      );
    }
  }

  render(scene, camera, frame) {
    if (!this.requested || !this.armed || !this.session) return false;
    if (!frame) {
      this.debug.status = 'armed · waiting for XR frame';
      return false;
    }

    let originalTarget = null;
    let originalXREnabled = this.renderer.xr.enabled;
    try {
      this.renderer.xr.updateCamera(camera);
      const xrCamera = this.renderer.xr.getCamera();
      const eyeCameras = xrCamera?.cameras || [];
      const frameViews = this._frameViews(frame);
      if (!frameViews?.pose) {
        this.debug.status = 'armed · viewer pose unavailable this frame';
        return false;
      }
      const subImages = frameViews.subImages || [];
      const viewports = subImages.map((subImage) => subImage?.viewport).filter(Boolean);
      const width = Number(viewports[0]?.width) || 0;
      const height = Number(viewports[0]?.height) || 0;
      const equalViewports = width > 0 && height > 0 && viewports.length === 2
        && viewports.every((viewport) => viewport.width === width && viewport.height === height);
      const timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const timerQueryActive = !!timer
        && this.gl.getQuery(timer.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null;
      const readiness = describeProductionMultiviewReadiness({
        requested: true,
        immersive: this.renderer.xr.isPresenting,
        capability: this.capability,
        viewCount: Math.min(frameViews.pose.views.length, eyeCameras.length, subImages.length),
        equalViewports,
        projectionLayer: !!frameViews.binding && subImages.length === 2
          && subImages.every((subImage) => !!subImage?.colorTexture),
        framebufferApi: typeof this.renderer.setRenderTargetFramebuffer === 'function',
        timerQueryActive,
      });
      if (!readiness.ready) {
        this._fallback(frameViews.error?.message || readiness.reason);
        return false;
      }

      this._ensureResources(width, height);
      this._patchSceneMaterials(scene);
      this._updateEyeMatrices(camera, eyeCameras);
      this._failurePending = null;
      this._frameSerial++;
      originalTarget = this.renderer.getRenderTarget();

      // Discard any pre-existing error so this frame's fallback decision is
      // attributable to the experiment rather than an unrelated prior pass.
      while (this.gl.getError() !== this.gl.NO_ERROR) { /* drain */ }
      this._sceneRenderActive = true;
      this.renderer.xr.enabled = false;
      this.renderer.setRenderTarget(this.resources.target);
      this.renderer.render(scene, camera);
      this._sceneRenderActive = false;

      if (this._failurePending) throw new Error(this._failurePending);
      this._copyLayersToProjection(subImages);
      const glError = this.gl.getError();
      if (glError !== this.gl.NO_ERROR) throw new Error(glErrorLabel(this.gl, glError));

      this.renderer.resetState?.();
      this.renderer.setRenderTarget(originalTarget);
      this.renderer.xr.enabled = originalXREnabled;
      this.active = true;
      this.debug.active = true;
      this.debug.views = '2 eyes · 1 scene submission';
      this.debug.status = `active · ${width}×${height} per eye · GPU timer disabled`;
      return true;
    } catch (error) {
      this._sceneRenderActive = false;
      this.renderer.xr.enabled = originalXREnabled;
      try {
        this.renderer.resetState?.();
        if (originalTarget) this.renderer.setRenderTarget(originalTarget);
      } catch (restoreError) { /* normal stereo will rebuild renderer state */ }
      this._fallback(error?.message || error);
      return false;
    }
  }

  snapshot() {
    return {
      requested: this.requested,
      armed: this.armed,
      active: this.active,
      status: this.debug.status,
      fallback: this.debug.fallback,
      views: this.debug.views,
      width: this.resources?.width || 0,
      height: this.resources?.height || 0,
      gpuTimingPaused: !!this.releaseGpuTimingPause,
    };
  }
}
