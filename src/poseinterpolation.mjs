/**
 * Drawing a remote player at a moment that has actually happened.
 *
 * Poses arrive about ten times a second and the network does not deliver them
 * evenly. Rendering the newest one the instant it lands means a late packet is a
 * stall and the packet after it is a lurch — the rubber-banding that remote
 * players used to show. Holding the render clock slightly in the past means
 * there are almost always two poses bracketing the moment being drawn, so the
 * body moves between two things that were really reported rather than toward one
 * that has not arrived. The cost is exactly that delay, and nothing else.
 *
 * Kept free of any renderer so the timing can be tested without a browser.
 */

/** Sized above the 100ms send interval: one late pose still leaves a pair. */
export const INTERPOLATION_DELAY_MS = 150;
/** Poses older than this cannot bracket anything worth drawing. */
export const POSE_HISTORY_MS = 2_000;
/** Beyond this gap a visitor was moved, not walked, and is placed instead. */
export const TELEPORT_DISTANCE = 12;

export function recordPose(history, sample) {
  const previous = history[history.length - 1];
  // A visitor who crossed the world did not run there. Interpolating that gap
  // would drag the body across the landscape at an impossible speed, and the
  // gait — which reads speed from displacement — would try to match it.
  const teleported = !!previous
    && Math.hypot(sample.x - previous.x, sample.z - previous.z) > TELEPORT_DISTANCE;
  if (teleported) history.length = 0;
  history.push(sample);
  while (history.length > 2 && sample.at - history[0].at > POSE_HISTORY_MS) history.shift();
  return teleported;
}

/**
 * The pose at `renderTime`, interpolated between its two neighbours.
 *
 * Before two samples exist, or once the render clock runs off the end of what
 * has arrived, the nearest known pose is held. Holding still is the honest
 * answer to "nothing has arrived yet": extrapolating would invent movement the
 * other player never made and then have to take it back.
 */
export function sampleAt(history, renderTime) {
  if (!history?.length) return null;
  const first = history[0];
  if (history.length === 1 || renderTime <= first.at) return pose(first);
  const newest = history[history.length - 1];
  if (renderTime >= newest.at) return pose(newest);
  for (let i = history.length - 1; i > 0; i--) {
    const after = history[i], before = history[i - 1];
    if (renderTime < before.at) continue;
    const span = after.at - before.at;
    const t = span > 0 ? (renderTime - before.at) / span : 1;
    return {
      x: before.x + (after.x - before.x) * t,
      y: before.y + (after.y - before.y) * t,
      z: before.z + (after.z - before.z) * t,
      yaw: before.yaw + angleDelta(before.yaw, after.yaw) * t,
    };
  }
  return pose(first);
}

function pose({ x, y, z, yaw }) { return { x, y, z, yaw }; }

export function angleDelta(from, to) {
  return (to - from + Math.PI) % (Math.PI * 2) - Math.PI;
}

/**
 * A playout clock, so the buffer is driven by the sender's timeline.
 *
 * Keying the history on arrival time makes the buffer only as smooth as the
 * network: a pose delayed 55ms lands 55ms late in the history and is drawn late,
 * which is the jitter this exists to remove. Every envelope already carries the
 * moment its sender stamped it, and those stamps are evenly spaced because the
 * sender emits on a fixed interval — so the history is keyed on those instead,
 * and a local clock plays them out.
 *
 * The two clocks are never compared directly, which is what makes this safe
 * without knowing the offset between two machines: the playout clock is only
 * ever steered toward `newest stamp - delay`, so any constant difference between
 * the peers' clocks is absorbed once and never has to be measured.
 *
 * Drift is corrected by nudging the rate rather than jumping the clock. A jump
 * is a visible skip; running a few percent fast or slow for a moment is not.
 */
export function createPlayoutClock() {
  return { time: null, rate: 1, drift: 0 };
}

/** The largest catch-up before a jump is cheaper than a long wrong-speed run. */
const RESYNC_THRESHOLD_MS = 900;

export function advancePlayout(clock, history, dtMs) {
  if (!history?.length) return clock.time;
  const target = history[history.length - 1].at - INTERPOLATION_DELAY_MS;
  if (clock.time === null) { clock.time = target; clock.rate = 1; return clock.time; }
  const drift = target - clock.time;
  // A stream that stopped and restarted, or a peer that reconnected, is not
  // drift — catching that up smoothly would take seconds of wrong-speed motion.
  if (Math.abs(drift) > RESYNC_THRESHOLD_MS) {
    clock.time = target; clock.rate = 1; clock.drift = 0;
    return clock.time;
  }
  // Steer on smoothed drift, never on the instantaneous figure. The target only
  // moves when a pose lands, so raw drift sawtooths by a whole send interval
  // between arrivals; following that would make the clock — and therefore the
  // body — speed up and slow down once per pose, reintroducing the unevenness
  // the buffer exists to remove. Averaged, that sawtooth is flat, and what is
  // left is the real difference between the two machines' clock rates.
  clock.drift += (drift - clock.drift) * 0.05;
  const correction = Math.max(-0.04, Math.min(0.04, clock.drift / 2_000));
  clock.rate = 1 + correction;
  clock.time += Math.max(0, dtMs) * clock.rate;
  return clock.time;
}
