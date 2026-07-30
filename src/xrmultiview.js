import {
  alternatingTrialOrder,
  calibratedRepeatCount,
  describeMultiviewCapability,
  formatMultiviewResult,
  summarizeMultiviewTrials,
} from './xrexperiments.mjs?v=3';

const BASELINE_VERTEX_SHADER = `#version 300 es
precision highp float;
uniform float uPhase;
uniform int uEye;
void main() {
  float id = float(gl_VertexID);
  float a = fract(sin(id * 12.9898 + uPhase) * 43758.5453);
  float b = fract(sin(id * 78.233 + uPhase * 0.73) * 24634.6345);
  float wobble = a;
  for (int i = 0; i < 5; i++) {
    wobble = fract(wobble * 1.6180339 + b * 0.381966);
  }
  float eye = float(uEye) * 2.0 - 1.0;
  gl_Position = vec4(a * 1.96 - 0.98 + eye * 0.002, b * 1.96 - 0.98, wobble * 0.1, 1.0);
  gl_PointSize = 1.0;
}`;

export const MULTIVIEW_VERTEX_SHADER = `#version 300 es
#extension GL_OVR_multiview2 : require
precision highp float;
layout(num_views=2) in;
uniform float uPhase;
void main() {
  float id = float(gl_VertexID);
  float a = fract(sin(id * 12.9898 + uPhase) * 43758.5453);
  float b = fract(sin(id * 78.233 + uPhase * 0.73) * 24634.6345);
  float wobble = a;
  for (int i = 0; i < 5; i++) {
    wobble = fract(wobble * 1.6180339 + b * 0.381966);
  }
  float eye = float(gl_ViewID_OVR) * 2.0 - 1.0;
  gl_Position = vec4(a * 1.96 - 0.98 + eye * 0.002, b * 1.96 - 0.98, wobble * 0.1, 1.0);
  gl_PointSize = 1.0;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
out vec4 outColor;
void main() { outColor = vec4(0.82, 0.48, 0.16, 1.0); }`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'shader compile failed';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl, vertexSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'program link failed';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function createArrayTexture(gl, size) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size, size, 2);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

function requireCompleteFramebuffer(gl, label) {
  const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`${label} framebuffer incomplete (0x${status.toString(16)})`);
  }
}

function captureState(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  gl.activeTexture(gl.TEXTURE0);
  const state = {
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    scissorBox: gl.getParameter(gl.SCISSOR_BOX),
    scissor: gl.isEnabled(gl.SCISSOR_TEST),
    blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST),
    cull: gl.isEnabled(gl.CULL_FACE),
    colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
    activeTexture,
    texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
    textureArray: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
  };
  gl.activeTexture(activeTexture);
  return state;
}

function setEnabled(gl, capability, enabled) {
  if (enabled) gl.enable(capability);
  else gl.disable(capability);
}

function restoreState(gl, state) {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  gl.viewport(...state.viewport);
  gl.scissor(...state.scissorBox);
  setEnabled(gl, gl.SCISSOR_TEST, state.scissor);
  setEnabled(gl, gl.BLEND, state.blend);
  setEnabled(gl, gl.DEPTH_TEST, state.depth);
  setEnabled(gl, gl.CULL_FACE, state.cull);
  gl.colorMask(...state.colorMask);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture2D);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.textureArray);
  gl.activeTexture(state.activeTexture);
}

function deleteResources(gl, resources) {
  if (!resources) return;
  gl.deleteFramebuffer(resources.stereoFramebuffer);
  gl.deleteFramebuffer(resources.multiviewFramebuffer);
  gl.deleteTexture(resources.stereoTexture);
  gl.deleteTexture(resources.multiviewTexture);
  gl.deleteProgram(resources.stereoProgram);
  gl.deleteProgram(resources.multiviewProgram);
  gl.deleteVertexArray(resources.vertexArray);
}

function createResources(gl, extension, size) {
  const resources = {
    stereoProgram: createProgram(gl, BASELINE_VERTEX_SHADER),
    multiviewProgram: createProgram(gl, MULTIVIEW_VERTEX_SHADER),
    stereoFramebuffer: gl.createFramebuffer(),
    multiviewFramebuffer: gl.createFramebuffer(),
    stereoTexture: null,
    multiviewTexture: null,
    vertexArray: gl.createVertexArray(),
  };
  gl.activeTexture(gl.TEXTURE0);
  resources.stereoTexture = createArrayTexture(gl, size);
  resources.multiviewTexture = createArrayTexture(gl, size);

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.stereoFramebuffer);
  gl.framebufferTextureLayer(
    gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, resources.stereoTexture, 0, 0,
  );
  requireCompleteFramebuffer(gl, 'stereo');

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.multiviewFramebuffer);
  extension.framebufferTextureMultiviewOVR(
    gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, resources.multiviewTexture, 0, 0, 2,
  );
  requireCompleteFramebuffer(gl, 'multiview');
  return resources;
}

function measureFinished(gl, draw) {
  gl.finish();
  const start = performance.now();
  draw();
  gl.finish();
  return performance.now() - start;
}

export class XRMultiviewExperiment {
  constructor(renderer, xrPerformance, {
    isSceneBenchmarkRunning = () => false,
    targetSize = 256,
    vertexCount = 8192,
    targetMeasurementMs = 12,
    maxRepeats = 16384,
    trialCount = 11,
  } = {}) {
    this.renderer = renderer;
    this.xrPerformance = xrPerformance;
    this.isSceneBenchmarkRunning = isSceneBenchmarkRunning;
    this.targetSize = targetSize;
    this.vertexCount = vertexCount;
    this.targetMeasurementMs = targetMeasurementMs;
    this.maxRepeats = maxRepeats;
    this.trialCount = trialCount;
    this.enabled = false;
    this.running = false;
    this.lastResult = null;
    this.extension = null;
    this.debug = {
      enabled: false,
      capability: 'not checked',
      status: 'isolated probe disabled',
      latest: 'none',
      run: () => this.run(),
    };
    this.refreshCapability();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.debug.enabled = this.enabled;
    this.debug.status = this.enabled
      ? 'ready for isolated A/B probe'
      : 'isolated probe disabled';
    this.refreshCapability();
  }

  refreshCapability() {
    const gl = this.renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
      && gl instanceof WebGL2RenderingContext;
    this.extension = isWebGL2 && !gl.isContextLost()
      ? gl.getExtension('OVR_multiview2') : null;
    const maxViews = this.extension
      ? Number(gl.getParameter(this.extension.MAX_VIEWS_OVR)) || 0 : 0;
    const capability = describeMultiviewCapability({
      isWebGL2,
      extensionPresent: !!this.extension,
      maxViews,
      contextLost: gl.isContextLost?.() || false,
    });
    this.capability = capability;
    this.debug.capability = capability.reason;
    return capability;
  }

  run() {
    if (!this.enabled) {
      this.debug.status = 'enable the isolated probe first';
      return null;
    }
    if (this.running) return null;
    if (this.isSceneBenchmarkRunning()) {
      this.debug.status = 'stop the Quest scene benchmark first';
      return null;
    }
    const capability = this.refreshCapability();
    if (!capability.supported) {
      this.debug.status = `unsupported · ${capability.reason}`;
      return null;
    }

    this.running = true;
    this.debug.status = 'running · brief compositor hitch expected';
    // Yield once so lil-gui can paint the running status before gl.finish()
    // intentionally stalls for the isolated, timer-query-free measurements.
    setTimeout(() => this._runNow(), 0);
    return true;
  }

  _runNow() {
    const gl = this.renderer.getContext();
    const releaseTimer = this.xrPerformance.acquireGpuTimingPause('multiview probe');
    let state = null;
    let resources = null;
    try {
      const timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (timerExtension
          && gl.getQuery(timerExtension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== null) {
        throw new Error('GPU timer query remained active');
      }
      state = captureState(gl);
      resources = createResources(gl, this.extension, this.targetSize);
      gl.bindVertexArray(resources.vertexArray);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, this.targetSize, this.targetSize);

      const stereoPhase = gl.getUniformLocation(resources.stereoProgram, 'uPhase');
      const stereoEye = gl.getUniformLocation(resources.stereoProgram, 'uEye');
      const multiviewPhase = gl.getUniformLocation(resources.multiviewProgram, 'uPhase');
      let phase = 0;
      const drawStereo = (repeats) => {
        gl.useProgram(resources.stereoProgram);
        for (let repeat = 0; repeat < repeats; repeat++) {
          gl.uniform1f(stereoPhase, phase += 0.013);
          for (let eye = 0; eye < 2; eye++) {
            gl.framebufferTextureLayer(
              gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, resources.stereoTexture, 0, eye,
            );
            gl.uniform1i(stereoEye, eye);
            gl.drawArrays(gl.POINTS, 0, this.vertexCount);
          }
        }
      };
      const drawMultiview = (repeats) => {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.multiviewFramebuffer);
        gl.useProgram(resources.multiviewProgram);
        for (let repeat = 0; repeat < repeats; repeat++) {
          gl.uniform1f(multiviewPhase, phase += 0.013);
          gl.drawArrays(gl.POINTS, 0, this.vertexCount);
        }
      };
      const stereoLane = (repeats) => {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.stereoFramebuffer);
        drawStereo(repeats);
      };

      let repeats = 4;
      let stereoCalibrationMs = 0;
      let multiviewCalibrationMs = 0;
      let calibrationAttempts = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        calibrationAttempts = attempt + 1;
        stereoCalibrationMs = measureFinished(gl, () => stereoLane(repeats));
        multiviewCalibrationMs = measureFinished(gl, () => drawMultiview(repeats));
        const calibrationFloorMs = Math.min(stereoCalibrationMs, multiviewCalibrationMs);
        const nextRepeats = calibratedRepeatCount(
          calibrationFloorMs,
          repeats,
          this.targetMeasurementMs,
          4,
          this.maxRepeats,
        );
        if (calibrationFloorMs >= this.targetMeasurementMs * 0.8
            || nextRepeats === repeats || attempt === 4) break;
        repeats = nextRepeats;
      }
      const calibrationFloorMs = Math.min(stereoCalibrationMs, multiviewCalibrationMs);
      const measurementReliable = calibrationFloorMs >= this.targetMeasurementMs * 0.65;
      measureFinished(gl, () => stereoLane(repeats));
      measureFinished(gl, () => drawMultiview(repeats));
      const trials = [];
      for (let index = 0; index < this.trialCount; index++) {
        const trial = {};
        for (const lane of alternatingTrialOrder(index)) {
          trial[lane] = measureFinished(gl, () => {
            if (lane === 'stereo') stereoLane(repeats);
            else drawMultiview(repeats);
          });
        }
        trials.push(trial);
      }
      const result = summarizeMultiviewTrials(trials);
      this.lastResult = {
        ...result,
        repeats,
        verticesPerView: this.vertexCount,
        targetSize: this.targetSize,
        targetMeasurementMs: this.targetMeasurementMs,
        calibration: {
          attempts: calibrationAttempts,
          stereoMs: stereoCalibrationMs,
          multiviewMs: multiviewCalibrationMs,
          floorMs: calibrationFloorMs,
        },
        measurementReliable,
        measuredAt: new Date().toISOString(),
        immersive: !!this.renderer.xr.isPresenting,
      };
      this.debug.latest = formatMultiviewResult(this.lastResult);
      this.debug.status = `complete · ${result.trials} alternating trials · ${measurementReliable ? 'calibrated' : 'timing floor not reached'}`;
      console.table({
        stereoP50Ms: result.stereoP50,
        multiviewP50Ms: result.multiviewP50,
        savingsPercent: result.savingsPercent,
        repeats,
        calibrationFloorMs,
        measurementReliable,
      });
    } catch (error) {
      this.debug.status = `failed · ${error?.message || error}`;
    } finally {
      try { deleteResources(gl, resources); } catch (error) { /* context may be lost */ }
      try { if (state) restoreState(gl, state); } catch (error) { /* Three resets below */ }
      this.renderer.resetState?.();
      releaseTimer();
      this.running = false;
    }
  }
}
