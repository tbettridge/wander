import {
  DEFAULT_XR_PROFILE,
  XR_PROFILE_STORAGE_KEY,
  XR_PROFILES,
  chooseXRFrameRate,
  missedXRFrames,
  normalizeXRProfileName,
  normalizedSupportedFrameRates,
  xrProfileForName,
} from './xrprofiles.mjs?v=3';

const SAMPLE_LIMIT = 240;

function loadProfileName(storage) {
  try {
    return normalizeXRProfileName(storage?.getItem(XR_PROFILE_STORAGE_KEY));
  } catch (error) {
    return DEFAULT_XR_PROFILE;
  }
}

function storeProfileName(storage, name) {
  try { storage?.setItem(XR_PROFILE_STORAGE_KEY, name); } catch (error) { /* storage is optional */ }
}

function percentile(samples, amount) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

function fixedOrDash(value, digits = 1) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(digits) : '—';
}

export class XRPerformanceController {
  constructor(renderer, { storage } = {}) {
    if (storage === undefined) {
      try { storage = globalThis.localStorage; } catch (error) { storage = null; }
    }
    this.renderer = renderer;
    this.storage = storage;
    this.selectedName = loadProfileName(storage);
    this.activeName = null;
    this.activeProfile = null;
    this.session = null;
    this.onSelectionChange = null;
    this.onSample = null;
    this.lastSessionReport = null;
    this.debug = { profile: this.selectedName };

    this.telemetry = {
      state: 'desktop',
      profile: xrProfileForName(this.selectedName).label,
      display: 'waiting for XR',
      supportedRates: 'unknown',
      frame: '—',
      cpu: '—',
      gpu: 'checking…',
      missed: '—',
      render: '—',
      visuals: 'Phase 3 inactive',
      runtime: 'inactive',
      lastSession: 'none yet',
      fps: 0,
      frameP95Ms: 0,
      cpuP95Ms: 0,
      gpuMs: 0,
      gpuSampleSerial: 0,
      missedPercent: 0,
      refreshRate: 0,
      drawCalls: 0,
      triangles: 0,
    };

    this._frameSamples = [];
    this._cpuSamples = [];
    this._windowElapsed = 0;
    this._windowFrames = 0;
    this._windowMissed = 0;
    this._windowSlots = 0;
    this._gpuQuery = null;
    this._gpuQueryActive = false;
    this._gpuTimingPauses = new Map();
    this._sessionElapsed = 0;
    this._sessionSummary = null;
    this._runtimeStages = [];
    this._initGpuTimer();
    this.applyPreSession();
  }

  get selectedProfile() { return xrProfileForName(this.selectedName); }
  get label() { return (this.activeProfile || this.selectedProfile).label; }
  get presenting() { return !!this.session; }
  get gpuTimingPaused() { return this._gpuTimingPauses.size > 0; }
  get gpuTimingStatus() {
    if (this.gpuTimingPaused) {
      return `paused · ${[...this._gpuTimingPauses.values()].join(' + ')}`;
    }
    return this._timerExt ? 'active' : 'unsupported';
  }

  _initGpuTimer() {
    const gl = this.renderer.getContext();
    this._gl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
      ? gl : null;
    this._timerExt = this._gl?.getExtension('EXT_disjoint_timer_query_webgl2') || null;
    this.telemetry.gpu = this._timerExt ? 'waiting for sample' : 'unsupported';
  }

  // OVR_multiview2 forbids drawing to a multiview framebuffer while a GPU
  // timer query is active. Pause tokens make that exclusion nest-safe for
  // isolated experiments and ensure an in-flight/pending query is discarded.
  acquireGpuTimingPause(label = 'external WebGL work') {
    const token = Symbol(label);
    this._gpuTimingPauses.set(token, label);
    this._discardGpuQuery();
    this.telemetry.gpuMs = 0;
    this.telemetry.gpu = this.gpuTimingStatus;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._gpuTimingPauses.delete(token);
      this.telemetry.gpu = this.gpuTimingPaused
        ? this.gpuTimingStatus
        : (this._timerExt ? 'waiting for sample' : 'unsupported');
    };
  }

  _notifySelection() {
    this.onSelectionChange?.({
      name: this.selectedName,
      profile: this.selectedProfile,
      pending: this.presenting && this.selectedName !== this.activeName,
    });
  }

  selectProfile(name, { persist = true } = {}) {
    this.selectedName = normalizeXRProfileName(name);
    this.debug.profile = this.selectedName;
    if (persist) storeProfileName(this.storage, this.selectedName);
    if (!this.presenting) this.applyPreSession();
    this._notifySelection();
    return this.selectedProfile;
  }

  // Three requires the XR framebuffer scale to be selected before presenting.
  // This method is called at startup, whenever the pre-entry selector changes,
  // and after a session ends in preparation for the next one.
  applyPreSession() {
    if (this.renderer.xr.isPresenting || this.presenting) return false;
    const profile = this.selectedProfile;
    try {
      this.renderer.xr.setFramebufferScaleFactor(profile.framebufferScale);
      this.telemetry.profile = profile.label;
      this.telemetry.display = `${profile.framebufferScale.toFixed(2)}× framebuffer · foveation ${profile.foveation.toFixed(2)} · prefers ${profile.preferredFrameRate} Hz`;
      return true;
    } catch (error) {
      this.telemetry.display = `framebuffer scale unavailable · ${error?.message || 'browser error'}`;
      return false;
    }
  }

  _resetWindow() {
    this._frameSamples.length = 0;
    this._cpuSamples.length = 0;
    this._windowElapsed = 0;
    this._windowFrames = 0;
    this._windowMissed = 0;
    this._windowSlots = 0;
    this.telemetry.fps = 0;
    this.telemetry.frameP95Ms = 0;
    this.telemetry.cpuP95Ms = 0;
    this.telemetry.missedPercent = 0;
  }

  async startSession(session) {
    if (!session) return;
    this.session = session;
    this.activeName = this.selectedName;
    this.activeProfile = xrProfileForName(this.activeName);
    this._resetWindow();
    this._sessionElapsed = 0;
    this._sessionSummary = {
      windows: 0,
      fpsTotal: 0,
      missedTotal: 0,
      worstFrameP95Ms: 0,
      worstCpuP95Ms: 0,
      worstGpuMs: 0,
      maxDrawCalls: 0,
      maxTriangles: 0,
    };
    this._runtimeStages = [];
    this.telemetry.gpuMs = 0;
    this.telemetry.gpuSampleSerial = 0;
    this.telemetry.state = 'starting';
    this.telemetry.profile = this.activeProfile.label;
    this.telemetry.gpu = this.gpuTimingPaused
      ? this.gpuTimingStatus
      : (this._timerExt ? 'waiting for sample' : 'unsupported');

    let appliedFoveation = this.activeProfile.foveation;
    try {
      this.renderer.xr.setFoveation(appliedFoveation);
      if (typeof this.renderer.xr.getFoveation === 'function') {
        appliedFoveation = this.renderer.xr.getFoveation();
      }
    } catch (error) {
      appliedFoveation = 0;
    }

    const supported = normalizedSupportedFrameRates(session.supportedFrameRates);
    const target = chooseXRFrameRate(supported, this.activeProfile.preferredFrameRate);
    this.telemetry.supportedRates = supported.length ? supported.map((rate) => `${rate}`).join(' / ') : 'browser default';
    if (target != null && typeof session.updateTargetFrameRate === 'function'
        && Math.abs((session.frameRate || 0) - target) > 0.1) {
      try { await session.updateTargetFrameRate(target); } catch (error) { /* retain browser default */ }
    }
    if (this.session !== session) return;

    this.telemetry.refreshRate = session.frameRate || target || 0;
    const refreshLabel = this.telemetry.refreshRate > 0
      ? `${fixedOrDash(this.telemetry.refreshRate, 0)} Hz` : 'browser refresh';
    this.telemetry.display = `${this.activeProfile.framebufferScale.toFixed(2)}× framebuffer · foveation ${Number(appliedFoveation).toFixed(2)} · ${refreshLabel}`;
    this.telemetry.state = 'active';
    this._notifySelection();
  }

  endSession() {
    this._finalizeSessionReport();
    this._discardGpuQuery();
    this.session = null;
    this.activeName = null;
    this.activeProfile = null;
    this.telemetry.state = 'desktop';
    this.telemetry.frame = '—';
    this.telemetry.cpu = '—';
    this.telemetry.missed = '—';
    this.telemetry.render = '—';
    this.telemetry.visuals = 'Phase 3 inactive';
    this.telemetry.runtime = 'inactive';
    this.applyPreSession();
    this._notifySelection();
  }

  setRuntimeFoveation(value) {
    if (!this.presenting) return null;
    let applied = Math.max(0, Math.min(1, Number(value) || 0));
    try {
      this.renderer.xr.setFoveation(applied);
      if (typeof this.renderer.xr.getFoveation === 'function') {
        applied = this.renderer.xr.getFoveation();
      }
    } catch (error) {
      return null;
    }
    const profile = this.activeProfile || this.selectedProfile;
    const refreshLabel = this.telemetry.refreshRate > 0
      ? `${fixedOrDash(this.telemetry.refreshRate, 0)} Hz` : 'browser refresh';
    this.telemetry.display = `${profile.framebufferScale.toFixed(2)}× framebuffer · foveation ${Number(applied).toFixed(2)} · ${refreshLabel}`;
    return applied;
  }

  setRuntimeStage(label) {
    this.telemetry.runtime = label || 'inactive';
    if (!this.presenting || !label) return;
    if (this._runtimeStages.at(-1)?.label === label) return;
    this._runtimeStages.push({ label, atSeconds: this._sessionElapsed });
  }

  _finalizeSessionReport() {
    const summary = this._sessionSummary;
    if (!summary) return;
    const windows = Math.max(1, summary.windows);
    const report = {
      profile: this.activeProfile?.name || this.activeName || this.selectedName,
      durationSeconds: this._sessionElapsed,
      refreshRate: this.telemetry.refreshRate,
      averageFps: summary.windows ? summary.fpsTotal / windows : 0,
      averageMissedPercent: summary.windows ? summary.missedTotal / windows : 0,
      worstFrameP95Ms: summary.worstFrameP95Ms,
      worstCpuP95Ms: summary.worstCpuP95Ms,
      worstGpuMs: summary.worstGpuMs,
      maxDrawCalls: summary.maxDrawCalls,
      maxTriangles: summary.maxTriangles,
      runtimeStages: this._runtimeStages.map((entry) => ({ ...entry })),
    };
    this.lastSessionReport = report;
    const stagePath = report.runtimeStages.map((entry) => entry.label).join(' → ') || 'no runtime samples';
    this.telemetry.lastSession = `${report.durationSeconds.toFixed(0)}s · ${report.averageFps.toFixed(0)} fps avg · ${report.averageMissedPercent.toFixed(1)}% missed · ${stagePath}`;
    this._sessionSummary = null;
  }

  beginGpuFrame() {
    if (!this.presenting || !this._timerExt || this.gpuTimingPaused || this._gpuQueryActive) return;
    this._pollGpuQuery();
    if (this._gpuQuery) return;
    try {
      this._gpuQuery = this._gl.createQuery();
      this._gl.beginQuery(this._timerExt.TIME_ELAPSED_EXT, this._gpuQuery);
      this._gpuQueryActive = true;
    } catch (error) {
      this._discardGpuQuery();
    }
  }

  endGpuFrame() {
    if (!this._gpuQueryActive) return;
    try {
      this._gl.endQuery(this._timerExt.TIME_ELAPSED_EXT);
    } catch (error) {
      this._discardGpuQuery();
      return;
    }
    this._gpuQueryActive = false;
  }

  _pollGpuQuery() {
    if (this.gpuTimingPaused || !this._gpuQuery || this._gpuQueryActive || !this._timerExt) return;
    try {
      const available = this._gl.getQueryParameter(this._gpuQuery, this._gl.QUERY_RESULT_AVAILABLE);
      const disjoint = this._gl.getParameter(this._timerExt.GPU_DISJOINT_EXT);
      if (!available) return;
      if (!disjoint) {
        const gpuMs = this._gl.getQueryParameter(this._gpuQuery, this._gl.QUERY_RESULT) / 1e6;
        this.telemetry.gpuMs = gpuMs;
        this.telemetry.gpuSampleSerial++;
        this.telemetry.gpu = `${gpuMs.toFixed(2)} ms scene`;
      } else {
        this.telemetry.gpu = 'sample disjoint';
      }
      this._gl.deleteQuery(this._gpuQuery);
      this._gpuQuery = null;
    } catch (error) {
      this._discardGpuQuery();
    }
  }

  _discardGpuQuery() {
    if (this._gpuQuery && this._gl) {
      try {
        if (this._gpuQueryActive) this._gl.endQuery(this._timerExt.TIME_ELAPSED_EXT);
        this._gl.deleteQuery(this._gpuQuery);
      } catch (error) { /* context may already be gone */ }
    }
    this._gpuQuery = null;
    this._gpuQueryActive = false;
  }

  tick(intervalSeconds, cpuMs, rendererInfo) {
    if (!this.presenting) return;
    this._sessionElapsed += Math.max(0, intervalSeconds);
    this._pollGpuQuery();
    const frameMs = Math.max(0, intervalSeconds * 1000);
    const measuredCpuMs = Math.max(0, Number(cpuMs) || 0);
    this._frameSamples.push(frameMs);
    this._cpuSamples.push(measuredCpuMs);
    if (this._frameSamples.length > SAMPLE_LIMIT) this._frameSamples.shift();
    if (this._cpuSamples.length > SAMPLE_LIMIT) this._cpuSamples.shift();

    const hasRefreshRate = this.telemetry.refreshRate > 0;
    const missed = hasRefreshRate
      ? missedXRFrames(intervalSeconds, this.telemetry.refreshRate) : 0;
    this._windowElapsed += intervalSeconds;
    this._windowFrames++;
    if (hasRefreshRate) {
      this._windowMissed += missed;
      this._windowSlots += missed + 1;
    }
    this.telemetry.drawCalls = rendererInfo?.render?.calls || 0;
    this.telemetry.triangles = rendererInfo?.render?.triangles || 0;

    if (this._windowElapsed < 0.75) return;
    this.telemetry.fps = this._windowFrames / this._windowElapsed;
    this.telemetry.frameP95Ms = percentile(this._frameSamples, 0.95);
    this.telemetry.cpuP95Ms = percentile(this._cpuSamples, 0.95);
    this.telemetry.missedPercent = this._windowSlots > 0
      ? this._windowMissed / this._windowSlots * 100 : 0;
    this.telemetry.frame = `${this.telemetry.fps.toFixed(0)} fps · p95 ${this.telemetry.frameP95Ms.toFixed(1)} ms`;
    this.telemetry.cpu = `p95 ${this.telemetry.cpuP95Ms.toFixed(1)} ms main loop`;
    this.telemetry.missed = hasRefreshRate
      ? `${this.telemetry.missedPercent.toFixed(1)}% estimated` : 'refresh rate unavailable';
    this.telemetry.render = `${this.telemetry.drawCalls} calls · ${this.telemetry.triangles.toLocaleString()} triangles`;
    const sample = {
      refreshRate: this.telemetry.refreshRate,
      fps: this.telemetry.fps,
      frameP95Ms: this.telemetry.frameP95Ms,
      cpuP95Ms: this.telemetry.cpuP95Ms,
      gpuMs: this.telemetry.gpuMs,
      missedPercent: this.telemetry.missedPercent,
      drawCalls: this.telemetry.drawCalls,
      triangles: this.telemetry.triangles,
    };
    if (this._sessionSummary) {
      const summary = this._sessionSummary;
      summary.windows++;
      summary.fpsTotal += sample.fps;
      summary.missedTotal += sample.missedPercent;
      summary.worstFrameP95Ms = Math.max(summary.worstFrameP95Ms, sample.frameP95Ms);
      summary.worstCpuP95Ms = Math.max(summary.worstCpuP95Ms, sample.cpuP95Ms);
      summary.worstGpuMs = Math.max(summary.worstGpuMs, sample.gpuMs);
      summary.maxDrawCalls = Math.max(summary.maxDrawCalls, sample.drawCalls);
      summary.maxTriangles = Math.max(summary.maxTriangles, sample.triangles);
    }
    this.onSample?.(sample);
    this._windowElapsed = 0;
    this._windowFrames = 0;
    this._windowMissed = 0;
    this._windowSlots = 0;
  }
}

export { XR_PROFILES };
