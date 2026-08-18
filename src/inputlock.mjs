/**
 * The rule that a player always gets their feet back.
 *
 * Travel takes the input lock and hands the release to a condition somewhere
 * else — terrain finishing, a train arriving. Both releases used to funnel
 * through a single line in the render loop guarded by `if (!ready …)`, which the
 * train case could never reach, because the train is summoned while `ready` is
 * still true. A journey that stalled therefore froze the player for the rest of
 * the session, with no timeout and no way out but a reload.
 *
 * A deadline is not a substitute for the real release. It is what makes the
 * absence of one survivable, and it belongs here rather than inside the
 * controller so the timing can be tested without a browser.
 */

/** A lock with no deadline, which is what scripted and benchmark paths want. */
export const INDEFINITE = 0;

export function createInputLock() {
  return { locked: false, reason: null, remaining: INDEFINITE };
}

export function engageInputLock(lock, locked, { reason = null, timeoutSeconds = INDEFINITE } = {}) {
  if (!locked) {
    lock.locked = false;
    lock.reason = null;
    lock.remaining = INDEFINITE;
    return lock;
  }
  lock.locked = true;
  lock.reason = reason;
  lock.remaining = Math.max(0, Number(timeoutSeconds) || INDEFINITE);
  return lock;
}

/**
 * Advance the deadline. Returns the reason if the lock just expired, else null,
 * so the caller can say which wait gave up instead of releasing silently.
 */
export function tickInputLock(lock, dt) {
  if (!lock.locked || lock.remaining <= 0) return null;
  lock.remaining -= Math.max(0, Number(dt) || 0);
  if (lock.remaining > 0) return null;
  const reason = lock.reason;
  engageInputLock(lock, false);
  return reason ?? 'unknown wait';
}
