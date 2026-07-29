export const THREE_RUNTIME_STORAGE_KEY = 'wander.xrExperiments.threeRuntime';
export const XR_COMPOSITOR_STORAGE_KEY = 'wander.xrExperiments.compositorHud';
export const XR_MULTIVIEW_STORAGE_KEY = 'wander.xrExperiments.multiviewProbe';

export const THREE_RUNTIMES = Object.freeze({
  baseline: Object.freeze({
    id: 'baseline',
    label: 'r165 baseline',
    revision: '165',
    version: '0.165.0',
  }),
  candidate: Object.freeze({
    id: 'candidate',
    label: 'r185 candidate',
    revision: '185',
    version: '0.185.0',
  }),
});

export function normalizeThreeRuntime(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'candidate' || key === 'next' || key === 'r185' || key === '185') {
    return 'candidate';
  }
  return 'baseline';
}

export function selectedThreeRuntime(search = '', stored = 'baseline') {
  const query = new URLSearchParams(search).get('three');
  return normalizeThreeRuntime(query == null ? stored : query);
}

export function urlWithThreeRuntime(url, value) {
  const next = new URL(url, 'https://wander.invalid/');
  const runtime = normalizeThreeRuntime(value);
  if (runtime === 'baseline') next.searchParams.delete('three');
  else next.searchParams.set('three', 'r185');
  return `${next.pathname}${next.search}${next.hash}`;
}

export function normalizeCompositorMode(value) {
  return value === true || value === 'quad' || value === 'on' ? 'quad' : 'scene';
}

export function normalizeMultiviewMode(value) {
  return value === true || value === 'probe' || value === 'on' ? 'probe' : 'off';
}

export function describeMultiviewCapability({
  isWebGL2 = false,
  extensionPresent = false,
  maxViews = 0,
  contextLost = false,
} = {}) {
  if (contextLost) return { supported: false, reason: 'WebGL context is lost' };
  if (!isWebGL2) return { supported: false, reason: 'requires WebGL 2' };
  if (!extensionPresent) return { supported: false, reason: 'OVR_multiview2 unavailable' };
  if (maxViews < 2) return { supported: false, reason: `only ${maxViews || 0} view supported` };
  return { supported: true, reason: `${maxViews} simultaneous views` };
}

export function alternatingTrialOrder(index) {
  return index % 2 === 0 ? ['stereo', 'multiview'] : ['multiview', 'stereo'];
}

export function calibratedRepeatCount(
  calibrationMs,
  calibrationRepeats,
  targetMs = 5,
  minimum = 2,
  maximum = 96,
) {
  const elapsed = Math.max(0.01, Number(calibrationMs) || 0.01);
  const repeats = Math.max(1, Number(calibrationRepeats) || 1);
  const estimate = Math.round(targetMs / (elapsed / repeats));
  return Math.max(minimum, Math.min(maximum, estimate));
}

function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount));
  return sorted[index];
}

export function summarizeMultiviewTrials(trials = []) {
  const stereo = trials.map((trial) => trial.stereo).filter(Number.isFinite);
  const multiview = trials.map((trial) => trial.multiview).filter(Number.isFinite);
  if (!stereo.length || stereo.length !== multiview.length) return null;
  const stereoP50 = percentile(stereo, 0.5);
  const multiviewP50 = percentile(multiview, 0.5);
  const ratio = stereoP50 > 0 ? multiviewP50 / stereoP50 : 0;
  return {
    trials: stereo.length,
    stereoP50,
    stereoP95: percentile(stereo, 0.95),
    multiviewP50,
    multiviewP95: percentile(multiview, 0.95),
    ratio,
    savingsPercent: (1 - ratio) * 100,
  };
}

export function formatMultiviewResult(result) {
  if (!result) return 'no result';
  const direction = result.savingsPercent >= 0 ? 'faster' : 'slower';
  return `${result.multiviewP50.toFixed(2)} ms multiview vs ${result.stereoP50.toFixed(2)} ms stereo · ${Math.abs(result.savingsPercent).toFixed(1)}% ${direction}`;
}
