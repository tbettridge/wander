import assert from 'node:assert/strict';
import { XRCompositorHUD } from '../src/xrcompositorhud.js';

const canvasContext = {
  clearRect() {},
  save() {},
  restore() {},
  drawImage() {},
  set globalAlpha(value) { this._globalAlpha = value; },
};
const originalDocument = globalThis.document;
const originalBinding = globalThis.XRWebGLBinding;
const originalTransform = globalThis.XRRigidTransform;
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }),
};

const events = { compositor: [], renderStates: [], destroyed: 0 };
const quadLayer = {
  opacity: 1,
  quality: 'default',
  needsRedraw: false,
  destroy() { events.destroyed++; },
};
const binding = {
  createQuadLayer(init) {
    this.init = init;
    return quadLayer;
  },
  getSubImage() { return null; },
};
const projectionLayer = { projection: true };
const gl = {
  RGBA8: 0x8058,
  ACTIVE_TEXTURE: 0x84e0,
  TEXTURE_BINDING_2D: 0x8069,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  getParameter(parameter) {
    if (parameter === this.ACTIVE_TEXTURE) return this.TEXTURE0;
    return null;
  },
  activeTexture() {},
  bindTexture() {},
  pixelStorei() {},
  texSubImage2D() {},
};
const renderer = {
  xr: {
    getBinding: () => binding,
    getBaseLayer: () => projectionLayer,
  },
  getContext: () => gl,
  resetState() {},
};
const actionHud = {
  canvas: { width: 1024, height: 152 },
  setCompositorActive(value) { events.compositor.push(value); },
  get presentation() {
    return { canvas: this.canvas, revision: 1, signature: 'intro', visible: true, opacity: 1 };
  },
};
const session = {
  renderState: { layers: [projectionLayer] },
  requestReferenceSpace: async (type) => ({ type }),
  updateRenderState(state) { events.renderStates.push(state); },
};

try {
  globalThis.XRWebGLBinding = class XRWebGLBinding {};
  globalThis.XRRigidTransform = class XRRigidTransform {
    constructor(position) { this.position = position; }
  };
  const compositor = new XRCompositorHUD(renderer, actionHud);
  assert.equal(await compositor.startSession(session, true), true);
  assert.equal(compositor.debug.active, true);
  assert.deepEqual(binding.init.space, { type: 'viewer' });
  assert.equal(binding.init.layout, 'mono');
  assert.equal(binding.init.isStatic, false, 'changing action prompts require a dynamic layer');
  assert.equal(events.renderStates[0].layers[0], projectionLayer);
  assert.equal(events.renderStates[0].layers[1], quadLayer);
  assert.equal(events.compositor.at(-1), true, 'scene sprite hides only after layer install');

  compositor.update({});
  assert.equal(compositor.debug.active, false, 'a failed upload disables the compositor path');
  assert.match(compositor.debug.status, /^fallback · upload failed/);
  assert.deepEqual(events.renderStates.at(-1).layers, [projectionLayer]);
  assert.equal(events.compositor.at(-1), false);

  compositor.endSession({ sessionEnded: false });
  assert.equal(events.compositor.at(-1), false);
  assert.equal(events.destroyed, 1);
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalBinding === undefined) delete globalThis.XRWebGLBinding;
  else globalThis.XRWebGLBinding = originalBinding;
  if (originalTransform === undefined) delete globalThis.XRRigidTransform;
  else globalThis.XRRigidTransform = originalTransform;
}

console.log('xrcompositor PASS · viewer-space quad · projection preserved · scene sprite fallback restored');
