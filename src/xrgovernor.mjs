// Runtime WebXR budget governor. Framebuffer scale is immutable once an XR
// session begins, so this adjusts only cheap, reversible presentation knobs.
// Nearby grass, terrain lighting, trees, sky and water are protected in every
// stage; progressively less important mid-field/detail work yields first.

export const XR_RUNTIME_STAGES = Object.freeze([
  Object.freeze({
    index: 0,
    name: 'full',
    label: 'Full',
    nearGrassScale: 1,
    midGrassScale: 1,
    shadowHzScale: 1,
    foveationBoost: 0,
    detailBudget: 'full',
    rainScale: 1,
    ambientLifeScale: 1,
  }),
  Object.freeze({
    index: 1,
    name: 'assisted',
    label: 'Assisted',
    nearGrassScale: 1,
    midGrassScale: 0.78,
    shadowHzScale: 0.72,
    foveationBoost: 0.10,
    detailBudget: 'reduced',
    rainScale: 0.72,
    ambientLifeScale: 0.75,
  }),
  Object.freeze({
    index: 2,
    name: 'recovery',
    label: 'Recovery',
    nearGrassScale: 0.88,
    midGrassScale: 0.52,
    shadowHzScale: 0.45,
    foveationBoost: 0.22,
    detailBudget: 'minimal',
    rainScale: 0.45,
    ambientLifeScale: 0.50,
  }),
]);

export const XR_GOVERNOR_MODES = Object.freeze({
  auto: 'auto',
  full: 'full',
  assisted: 'assisted',
  recovery: 'recovery',
});

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function xrRuntimePressure(metrics = {}, preferredFrameRate = 72) {
  const refreshRate = finitePositive(metrics.refreshRate, preferredFrameRate);
  const budgetMs = 1000 / refreshRate;
  const frameP95 = finitePositive(metrics.frameP95Ms, budgetMs);
  const cpuP95 = finitePositive(metrics.cpuP95Ms, 0);
  const gpuMs = finitePositive(metrics.gpuMs, 0);
  const missed = Math.max(0, Number(metrics.missedPercent) || 0);

  const severe = missed >= 16
    || frameP95 >= budgetMs * 1.52
    || cpuP95 >= budgetMs * 1.18
    || gpuMs >= budgetMs * 1.20;
  const strained = severe || missed >= 4
    || frameP95 >= budgetMs * 1.18
    || cpuP95 >= budgetMs * 0.94
    || gpuMs >= budgetMs * 0.98;
  const healthy = missed <= 1
    && frameP95 <= budgetMs * 1.08
    && (cpuP95 <= 0 || cpuP95 <= budgetMs * 0.78)
    && (gpuMs <= 0 || gpuMs <= budgetMs * 0.82);

  return {
    level: severe ? 2 : strained ? 1 : 0,
    healthy,
    budgetMs,
    headroomMs: budgetMs - Math.max(frameP95, cpuP95, gpuMs),
  };
}

export class XRRuntimeGovernor {
  constructor({ warmupWindows = 6, slowWindows = 2, recoveryWindows = 10 } = {}) {
    this.warmupTarget = warmupWindows;
    this.slowTarget = slowWindows;
    this.recoveryTarget = recoveryWindows;
    this.active = false;
    this.profile = null;
    this.stageIndex = 0;
    this.mode = 'auto';
    this.onChange = null;
    this._warmup = 0;
    this._slow = 0;
    this._healthy = 0;
    this.debug = {
      mode: 'auto',
      stage: 'inactive',
      pressure: 'waiting for XR',
      transitions: 0,
    };
  }

  get stage() { return XR_RUNTIME_STAGES[this.stageIndex]; }

  start(profile) {
    this.active = true;
    this.profile = profile;
    this.stageIndex = this.mode === 'auto' ? 0 : XR_RUNTIME_STAGES
      .findIndex((stage) => stage.name === this.mode);
    if (this.stageIndex < 0) this.stageIndex = 0;
    this._warmup = 0;
    this._slow = 0;
    this._healthy = 0;
    this.debug.stage = this.stage.label;
    this.debug.pressure = this.mode === 'auto' ? 'warming up' : 'manual override';
    this.debug.transitions = 0;
    return this.stage;
  }

  stop() {
    this.active = false;
    this.profile = null;
    this.stageIndex = 0;
    this._warmup = 0;
    this._slow = 0;
    this._healthy = 0;
    this.debug.stage = 'inactive';
    this.debug.pressure = 'waiting for XR';
  }

  setMode(mode) {
    this.mode = Object.hasOwn(XR_GOVERNOR_MODES, mode) ? mode : 'auto';
    this.debug.mode = this.mode;
    if (!this.active) return null;
    const nextIndex = this.mode === 'auto' ? 0 : XR_RUNTIME_STAGES
      .findIndex((stage) => stage.name === this.mode);
    this._warmup = 0;
    this._slow = 0;
    this._healthy = 0;
    this.debug.pressure = this.mode === 'auto' ? 'warming up' : 'manual override';
    return this._setStage(Math.max(0, nextIndex), `mode: ${this.mode}`);
  }

  _setStage(index, reason) {
    const next = Math.max(0, Math.min(XR_RUNTIME_STAGES.length - 1, index));
    if (next === this.stageIndex) {
      this.debug.stage = this.stage.label;
      return null;
    }
    const previous = this.stage;
    this.stageIndex = next;
    this.debug.stage = this.stage.label;
    this.debug.transitions++;
    const change = { previous, stage: this.stage, reason };
    this.onChange?.(change);
    return change;
  }

  sample(metrics = {}) {
    if (!this.active || this.mode !== 'auto') return null;
    const pressure = xrRuntimePressure(metrics, this.profile?.preferredFrameRate || 72);
    this.debug.pressure = `${pressure.headroomMs >= 0 ? '+' : ''}${pressure.headroomMs.toFixed(1)} ms headroom · ${Number(metrics.missedPercent || 0).toFixed(1)}% missed`;

    if (this._warmup < this.warmupTarget) {
      this._warmup++;
      this.debug.pressure = `warming up ${this._warmup}/${this.warmupTarget}`;
      return null;
    }

    if (pressure.level > 0) {
      this._healthy = 0;
      this._slow += pressure.level === 2 ? 2 : 1;
      if (this._slow >= this.slowTarget && this.stageIndex < XR_RUNTIME_STAGES.length - 1) {
        this._slow = 0;
        return this._setStage(this.stageIndex + 1,
          pressure.level === 2 ? 'severe frame pressure' : 'sustained frame pressure');
      }
      return null;
    }

    this._slow = 0;
    if (pressure.healthy) this._healthy++;
    else this._healthy = 0;
    if (this._healthy >= this.recoveryTarget && this.stageIndex > 0) {
      this._healthy = 0;
      return this._setStage(this.stageIndex - 1, 'sustained headroom');
    }
    return null;
  }
}
