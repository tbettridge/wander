// Optional WebXR compositor path for the controller-action HUD. The existing
// camera sprite remains the unconditional fallback. This module only takes
// ownership after a quad layer has been created and installed successfully.

function errorMessage(error) {
  return error?.message || error?.name || String(error || 'unknown error');
}

export class XRCompositorHUD {
  constructor(renderer, actionHud) {
    this.renderer = renderer;
    this.actionHud = actionHud;
    this.session = null;
    this.binding = null;
    this.layer = null;
    this.baseLayers = [];
    this.lastRevision = -1;
    this.lastVisible = null;
    this.lastOpacity = -1;
    this.usesLayerOpacity = false;
    this.stagingCanvas = document.createElement('canvas');
    this.stagingCanvas.width = actionHud.canvas.width;
    this.stagingCanvas.height = actionHud.canvas.height;
    this.stagingContext = this.stagingCanvas.getContext('2d');
    this.debug = {
      requested: false,
      capability: 'not checked',
      status: 'scene sprite baseline',
      uploads: 0,
      active: false,
    };
  }

  _capability(session) {
    if (!session) return { supported: false, reason: 'no XR session' };
    if (typeof globalThis.XRWebGLBinding === 'undefined') {
      return { supported: false, reason: 'XRWebGLBinding unavailable' };
    }
    if (typeof globalThis.XRRigidTransform === 'undefined') {
      return { supported: false, reason: 'XRRigidTransform unavailable' };
    }
    if (session.renderState?.layers === undefined) {
      return { supported: false, reason: 'session did not enable WebXR Layers' };
    }
    const binding = this.renderer.xr.getBinding?.();
    if (!binding || typeof binding.createQuadLayer !== 'function'
        || typeof binding.getSubImage !== 'function') {
      return { supported: false, reason: 'quad-layer binding unavailable' };
    }
    return { supported: true, binding, reason: 'quad layer available' };
  }

  async startSession(session, requested = this.debug.requested) {
    this.debug.requested = !!requested;
    this.session = session;
    if (!this.debug.requested) {
      this.debug.capability = 'not requested';
      this.debug.status = 'scene sprite baseline';
      return false;
    }

    const capability = this._capability(session);
    this.debug.capability = capability.reason;
    if (!capability.supported) {
      this.debug.status = `fallback · ${capability.reason}`;
      this.actionHud.setCompositorActive(false);
      return false;
    }

    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (this.session !== session) return false;
      const gl = this.renderer.getContext();
      const baseLayer = this.renderer.xr.getBaseLayer?.();
      const activeLayers = Array.from(session.renderState.layers || []);
      this.baseLayers = activeLayers.length ? activeLayers : (baseLayer ? [baseLayer] : []);
      if (baseLayer && !this.baseLayers.includes(baseLayer)) this.baseLayers.unshift(baseLayer);
      if (!this.baseLayers.length) throw new Error('Three projection layer unavailable');

      this.binding = capability.binding;
      this.layer = this.binding.createQuadLayer({
        space: viewerSpace,
        transform: new XRRigidTransform({ x: 0, y: -0.48, z: -1.65 }),
        viewPixelWidth: this.actionHud.canvas.width,
        viewPixelHeight: this.actionHud.canvas.height,
        width: 1.55,
        height: 0.23,
        layout: 'mono',
        textureType: 'texture',
        colorFormat: gl.RGBA8,
        mipLevels: 1,
        isStatic: false,
      });
      this.layer.blendTextureSourceAlpha = true;
      if ('quality' in this.layer) {
        try { this.layer.quality = 'text-optimized'; } catch (error) { /* optional hint */ }
      }
      this.usesLayerOpacity = 'opacity' in this.layer;
      session.updateRenderState({ layers: [...this.baseLayers, this.layer] });
      this.lastRevision = -1;
      this.lastVisible = null;
      this.lastOpacity = -1;
      this.debug.active = true;
      this.debug.status = this.usesLayerOpacity
        ? 'active · compositor opacity · dirty uploads'
        : 'active · canvas opacity fallback';
      this.actionHud.setCompositorActive(true);
      return true;
    } catch (error) {
      this.debug.status = `fallback · ${errorMessage(error)}`;
      this.debug.active = false;
      this.actionHud.setCompositorActive(false);
      this._destroyLayer();
      return false;
    }
  }

  async setRequested(requested) {
    this.debug.requested = !!requested;
    if (!this.session) {
      this.debug.status = this.debug.requested
        ? 'quad requested for next XR session'
        : 'scene sprite baseline';
      return;
    }
    if (this.debug.requested && !this.layer) await this.startSession(this.session, true);
    else if (!this.debug.requested && this.layer) this.endSession({ sessionEnded: false });
  }

  _drawStaging(presentation) {
    const ctx = this.stagingContext;
    ctx.clearRect(0, 0, this.stagingCanvas.width, this.stagingCanvas.height);
    if (!presentation.visible || presentation.opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha = presentation.opacity;
    ctx.drawImage(presentation.canvas, 0, 0);
    ctx.restore();
  }

  update(frame) {
    if (!this.layer || !this.binding || !frame || !this.debug.active) return;
    const presentation = this.actionHud.presentation;
    const opacity = presentation.visible ? presentation.opacity : 0;
    if (this.usesLayerOpacity && opacity !== this.lastOpacity) {
      try { this.layer.opacity = opacity; } catch (error) { this.usesLayerOpacity = false; }
    }
    const appearanceChanged = presentation.visible !== this.lastVisible
      || Math.abs(opacity - this.lastOpacity) > 0.002;
    const mustUpload = presentation.revision !== this.lastRevision
      || (!this.usesLayerOpacity && appearanceChanged)
      || this.layer.needsRedraw === true;
    this.lastVisible = presentation.visible;
    this.lastOpacity = opacity;
    if (!mustUpload) return;

    const gl = this.renderer.getContext();
    const source = this.usesLayerOpacity ? presentation.canvas : this.stagingCanvas;
    if (!this.usesLayerOpacity) this._drawStaging(presentation);
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const previousFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    try {
      const subImage = this.binding.getSubImage(this.layer, frame);
      gl.bindTexture(gl.TEXTURE_2D, subImage.colorTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.lastRevision = presentation.revision;
      this.debug.uploads++;
    } catch (error) {
      const failureStatus = `fallback · upload failed · ${errorMessage(error)}`;
      this.actionHud.setCompositorActive(false);
      if (this.session && this.baseLayers.length) {
        try { this.session.updateRenderState({ layers: [...this.baseLayers] }); } catch (restoreError) { /* sprite fallback remains */ }
      }
      this._destroyLayer();
      this.debug.status = failureStatus;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
      gl.activeTexture(previousActiveTexture);
      this.renderer.resetState?.();
    }
  }

  _destroyLayer() {
    if (this.layer) {
      try { this.layer.destroy?.(); } catch (error) { /* session may already be gone */ }
    }
    this.layer = null;
    this.binding = null;
    this.baseLayers = [];
    this.debug.active = false;
  }

  endSession({ sessionEnded = true } = {}) {
    const session = this.session;
    if (!sessionEnded && session && this.layer) {
      try { session.updateRenderState({ layers: [...this.baseLayers] }); } catch (error) { /* fallback below */ }
    }
    this.actionHud.setCompositorActive(false);
    this._destroyLayer();
    this.session = sessionEnded ? null : session;
    this.debug.status = this.debug.requested && sessionEnded
      ? 'quad requested for next XR session'
      : 'scene sprite baseline';
  }
}
