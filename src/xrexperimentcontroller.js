import {
  THREE_RUNTIME_STORAGE_KEY,
  XR_COMPOSITOR_STORAGE_KEY,
  XR_MULTIVIEW_STORAGE_KEY,
  normalizeCompositorMode,
  normalizeMultiviewMode,
  normalizeThreeRuntime,
  urlWithThreeRuntime,
} from './xrexperiments.mjs';
import { XRCompositorHUD } from './xrcompositorhud.js';
import { XRMultiviewExperiment } from './xrmultiview.js';

function load(storage, key, fallback) {
  try { return storage?.getItem(key) ?? fallback; } catch (error) { return fallback; }
}

function save(storage, key, value) {
  try { storage?.setItem(key, value); } catch (error) { /* storage is optional */ }
}

export class XRExperimentController {
  constructor({
    renderer,
    actionHud,
    xrPerformance,
    storage,
    isSceneBenchmarkRunning = () => false,
    runtime = globalThis.__WANDER_THREE_RUNTIME__,
    threeRevision = 'unknown',
  }) {
    if (storage === undefined) {
      try { storage = globalThis.localStorage; } catch (error) { storage = null; }
    }
    this.renderer = renderer;
    this.storage = storage;
    this.runtime = runtime || { id: 'baseline', label: 'r165 baseline', revision: '165' };
    this.threeRevision = String(threeRevision);
    this.compositor = new XRCompositorHUD(renderer, actionHud);
    this.multiview = new XRMultiviewExperiment(renderer, xrPerformance, {
      isSceneBenchmarkRunning,
    });

    const compositorMode = normalizeCompositorMode(
      load(storage, XR_COMPOSITOR_STORAGE_KEY, 'scene'),
    );
    const multiviewMode = normalizeMultiviewMode(
      load(storage, XR_MULTIVIEW_STORAGE_KEY, 'off'),
    );
    this.compositor.debug.requested = compositorMode === 'quad';
    this.compositor.debug.status = compositorMode === 'quad'
      ? 'quad requested for next XR session' : 'scene sprite baseline';
    this.multiview.setEnabled(multiviewMode === 'probe');

    this.debug = {
      threeRuntime: this.runtime.id,
      activeThree: `${this.runtime.label} · THREE.REVISION ${this.threeRevision}`,
      runtimeAction: 'select a lane, then reload',
      compositorMode,
      multiviewMode,
      applyThreeRuntime: () => this.applyThreeRuntime(),
      reset: () => this.reset(),
    };
  }

  selectThreeRuntime(value) {
    this.debug.threeRuntime = normalizeThreeRuntime(value);
    this.debug.runtimeAction = this.debug.threeRuntime === this.runtime.id
      ? 'selected lane is active'
      : 'reload required to apply selection';
  }

  applyThreeRuntime() {
    const selected = normalizeThreeRuntime(this.debug.threeRuntime);
    save(this.storage, THREE_RUNTIME_STORAGE_KEY, selected);
    const next = urlWithThreeRuntime(globalThis.location.href, selected);
    this.debug.runtimeAction = `loading ${selected === 'candidate' ? 'r185' : 'r165'}…`;
    globalThis.location.assign(next);
  }

  setCompositorMode(value) {
    const mode = normalizeCompositorMode(value);
    this.debug.compositorMode = mode;
    save(this.storage, XR_COMPOSITOR_STORAGE_KEY, mode);
    this.compositor.setRequested(mode === 'quad');
  }

  setMultiviewMode(value) {
    const mode = normalizeMultiviewMode(value);
    this.debug.multiviewMode = mode;
    save(this.storage, XR_MULTIVIEW_STORAGE_KEY, mode);
    this.multiview.setEnabled(mode === 'probe');
  }

  async startSession(session) {
    this.multiview.refreshCapability();
    return this.compositor.startSession(session, this.debug.compositorMode === 'quad');
  }

  endSession() {
    this.compositor.endSession({ sessionEnded: true });
  }

  beforeXRRender(frame) {
    this.compositor.update(frame);
  }

  snapshot() {
    return {
      three: {
        lane: this.runtime.id,
        label: this.runtime.label,
        revision: this.threeRevision,
      },
      compositorHud: {
        requested: this.compositor.debug.requested,
        active: this.compositor.debug.active,
        capability: this.compositor.debug.capability,
        uploads: this.compositor.debug.uploads,
      },
      multiview: {
        enabled: this.multiview.enabled,
        capability: this.multiview.debug.capability,
        latest: this.multiview.lastResult,
      },
    };
  }

  reset() {
    this.selectThreeRuntime('baseline');
    this.setCompositorMode('scene');
    this.setMultiviewMode('off');
    this.debug.runtimeAction = this.runtime.id === 'baseline'
      ? 'experiments reset'
      : 'experiments reset · reload to return to r165';
  }
}
