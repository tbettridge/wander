const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const LANTERN_SWING_LIMIT = 0.24;
export const LANTERN_EXTINGUISHED_LEVEL = 0.025;

const smoothstep = (min, max, value) => {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
};

export function createLanternSwingState() {
  return { pitch: 0, roll: 0, pitchVelocity: 0, rollVelocity: 0 };
}

// Three incommensurate ripples read as a living flame without the hard jumps
// of frame-to-frame random noise. The narrow range is deliberately gentle:
// this is lamplight breathing, not a faulty electric bulb.
export function lanternFlicker(timeSeconds) {
  const t = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const value = 0.968
    + Math.sin(t * 8.7 + 0.35) * 0.016
    + Math.sin(t * 17.13 + 1.72) * 0.009
    + Math.sin(t * 31.7 + 0.4) * 0.006;
  return clamp(value, 0.93, 1.0);
}

export function lanternLightIntensity(level, timeSeconds, baseIntensity = 4.2) {
  return Math.max(0, baseIntensity) * clamp(level, 0, 1) * lanternFlicker(timeSeconds);
}

// Shutdown is deliberately serial: hold the lantern in place until its light
// has faded, then withdraw it. Ignition is the inverse choreography, beginning
// only once the object has nearly reached its presented position.
export function lanternPresenceTarget(enabled, lightLevel) {
  return enabled || lightLevel > LANTERN_EXTINGUISHED_LEVEL ? 1 : 0;
}

export function lanternIgnitionTarget(enabled, presence) {
  return enabled ? smoothstep(0.88, 0.995, presence) : 0;
}

// Convert tracked/camera acceleration plus walking cadence into a modest
// pendulum target. X acceleration drives roll; Z acceleration drives pitch.
export function lanternSwingTarget({
  accelerationX = 0,
  accelerationZ = 0,
  speed = 0,
  walkPhase = 0,
} = {}) {
  const stride = clamp(Math.max(0, speed) / 4.8, 0, 1.35);
  return {
    pitch: clamp(
      accelerationZ * 0.012 + Math.sin(walkPhase) * 0.042 * stride,
      -LANTERN_SWING_LIMIT,
      LANTERN_SWING_LIMIT,
    ),
    roll: clamp(
      -accelerationX * 0.012 + Math.sin(walkPhase * 0.5 + 0.8) * 0.024 * stride,
      -LANTERN_SWING_LIMIT,
      LANTERN_SWING_LIMIT,
    ),
  };
}

// Semi-implicit spring integration supplies weight and a short, natural
// after-swing whenever the hand or camera stops. State is mutated to avoid a
// per-frame allocation in the render loop.
export function stepLanternSwing(state, dt, target = { pitch: 0, roll: 0 }) {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
  if (step <= 0) return state;
  const stiffness = 21;
  const damping = 7.2;

  state.pitchVelocity += (
    (clamp(target.pitch ?? 0, -LANTERN_SWING_LIMIT, LANTERN_SWING_LIMIT) - state.pitch) * stiffness
    - state.pitchVelocity * damping
  ) * step;
  state.rollVelocity += (
    (clamp(target.roll ?? 0, -LANTERN_SWING_LIMIT, LANTERN_SWING_LIMIT) - state.roll) * stiffness
    - state.rollVelocity * damping
  ) * step;
  state.pitch = clamp(
    state.pitch + state.pitchVelocity * step,
    -LANTERN_SWING_LIMIT,
    LANTERN_SWING_LIMIT,
  );
  state.roll = clamp(
    state.roll + state.rollVelocity * step,
    -LANTERN_SWING_LIMIT,
    LANTERN_SWING_LIMIT,
  );
  return state;
}
