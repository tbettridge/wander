export const THREE_RUNTIME_STORAGE_KEY = 'wander.xrExperiments.threeRuntime.v2';
export const XR_COMPOSITOR_STORAGE_KEY = 'wander.xrExperiments.compositorHud';
export const XR_MULTIVIEW_STORAGE_KEY = 'wander.xrExperiments.multiviewProbe';
export const DEFAULT_THREE_RUNTIME = 'candidate';

export const THREE_RUNTIMES = Object.freeze({
  baseline: Object.freeze({
    id: 'baseline',
    label: 'r165 fallback',
    revision: '165',
    version: '0.165.0',
  }),
  candidate: Object.freeze({
    id: 'candidate',
    label: 'r185 default · XR recommended',
    revision: '185',
    version: '0.185.0',
  }),
});

export function normalizeThreeRuntime(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'baseline' || key === 'fallback' || key === 'r165' || key === '165') {
    return 'baseline';
  }
  return DEFAULT_THREE_RUNTIME;
}

export function selectedThreeRuntime(search = '', stored = DEFAULT_THREE_RUNTIME) {
  const query = new URLSearchParams(search).get('three');
  return normalizeThreeRuntime(query == null ? stored : query);
}

export function urlWithThreeRuntime(url, value) {
  const next = new URL(url, 'https://wander.invalid/');
  const runtime = normalizeThreeRuntime(value);
  if (runtime === DEFAULT_THREE_RUNTIME) next.searchParams.delete('three');
  else next.searchParams.set('three', 'r165');
  return `${next.pathname}${next.search}${next.hash}`;
}

export function normalizeCompositorMode(value) {
  return value === true || value === 'quad' || value === 'on' ? 'quad' : 'scene';
}

export function normalizeMultiviewMode(value) {
  if (value === 'probe') return 'probe';
  if (value === true || value === 'on' || value === 'render'
      || value === 'scene' || value === 'production') return 'render';
  return 'off';
}

export function injectMultiviewVertexShader(source = '') {
  const shader = String(source);
  if (!shader.includes('gl_Position') || shader.includes('GL_OVR_multiview2')) return shader;
  const versionPattern = /^(#version\s+300\s+es\s*\n)/;
  const mainPattern = /void\s+main\s*\(\s*\)\s*\{/;
  if (!versionPattern.test(shader) || !mainPattern.test(shader)) return shader;
  const withExtension = shader.replace(
    versionPattern,
    '$1#extension GL_OVR_multiview2 : require\n',
  );
  const renamed = withExtension.replace(mainPattern, (match) => (
    'layout(num_views=2) in;\n'
    + 'uniform mat4 wanderMultiviewClip[2];\n'
    + '#define main wanderMultiviewOriginalMain\n'
    + match
  ));
  return `${renamed}\n#undef main\nvoid main() {\n`
    + '  wanderMultiviewOriginalMain();\n'
    + '  gl_Position = wanderMultiviewClip[int(gl_ViewID_OVR)] * gl_Position;\n'
    + '}\n';
}

export function describeProductionMultiviewReadiness({
  requested = false,
  immersive = false,
  capability = null,
  viewCount = 0,
  equalViewports = false,
  projectionLayer = false,
  framebufferApi = false,
  timerQueryActive = false,
} = {}) {
  if (!requested) return { ready: false, reason: 'scene renderer disabled' };
  if (!immersive) return { ready: false, reason: 'requires an immersive XR session' };
  if (!capability?.supported) {
    return { ready: false, reason: capability?.reason || 'OVR_multiview2 unavailable' };
  }
  if (timerQueryActive) return { ready: false, reason: 'GPU timer query is active' };
  if (!framebufferApi) return { ready: false, reason: 'Three.js external framebuffer API unavailable' };
  if (!projectionLayer) return { ready: false, reason: 'WebXR projection-layer textures unavailable' };
  if (viewCount !== 2) return { ready: false, reason: `requires 2 XR views (received ${viewCount})` };
  if (!equalViewports) return { ready: false, reason: 'XR eye buffers have unequal dimensions' };
  return { ready: true, reason: 'two-eye scene renderer ready' };
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
  targetMs = 12,
  minimum = 4,
  maximum = 16384,
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
  const confidence = result.measurementReliable === false ? ' · low timing confidence' : '';
  return `${result.multiviewP50.toFixed(2)} ms multiview vs ${result.stereoP50.toFixed(2)} ms stereo · ${Math.abs(result.savingsPercent).toFixed(1)}% ${direction}${confidence}`;
}
