// A hard ceiling on terrain samples per frame, shared across everyone who wants
// one.
//
// Height sampling is the cost that scales with population. One NPC asking where
// the ground is costs nothing; forty of them asking every frame — each sample
// walking the noise stack, and now the walkable surface and its crossings on top
// — is the frame budget. The failure mode is not a crash but a stutter that
// arrives gradually as a region fills, which is the hardest kind to attribute.
//
// So the ceiling is explicit and the work is DEFERRED rather than dropped. An
// actor that cannot be sampled this frame keeps the height it had and moves to
// the front of the queue for the next one. Nobody is starved, because the queue
// is served round-robin from where it left off rather than from the top.
//
// The alternative — sampling on demand and hoping — is what this exists to stop
// happening quietly.

/**
 * @param {object} options
 * @param {number} options.samplesPerFrame  hard ceiling, shared by all callers
 */
export function createHeightBudget({ samplesPerFrame = 12 } = {}) {
  return {
    samplesPerFrame,
    // Last known height per key, and how many frames stale it is.
    cache: new Map(),
    spent: 0,
    // Where the round-robin resumes, so late keys are not permanently starved
    // by early ones.
    cursor: 0,
    order: [],
    deferred: 0,
    frames: 0,
  };
}

/** Start a frame. Resets the spend, keeps the cache and the queue position. */
export function beginFrame(budget) {
  budget.spent = 0;
  budget.deferred = 0;
  budget.frames++;
}

/**
 * The height for `key`, sampled if there is budget left and reused if not.
 *
 * `sample` is only called when the budget allows, so it can be as expensive as
 * it likes. A key asked for the first time is always sampled: a traveller with
 * no height at all cannot be placed, and one frame of a wrong position is worse
 * than one frame of a slightly late one.
 */
export function sampleHeight(budget, key, sample) {
  const held = budget.cache.get(key);
  if (held === undefined) {
    // First sight of this key. Always pay for it, and register it in the queue.
    const value = sample();
    budget.cache.set(key, { value, age: 0 });
    budget.order.push(key);
    budget.spent++;
    return value;
  }
  if (budget.spent >= budget.samplesPerFrame) {
    held.age++;
    budget.deferred++;
    return held.value;
  }
  budget.spent++;
  held.value = sample();
  held.age = 0;
  return held.value;
}

/**
 * Keys worth refreshing this frame, oldest first, up to what the budget allows.
 *
 * Callers that can choose WHICH actors to update — rather than asking for each
 * in turn — should drive from this, so the budget is spent on whatever has gone
 * stalest rather than on whoever happens to be first in an array.
 */
export function dueForSample(budget, limit = budget.samplesPerFrame) {
  const due = [];
  const count = budget.order.length;
  if (count === 0) return due;
  for (let i = 0; i < count && due.length < limit; i++) {
    const key = budget.order[(budget.cursor + i) % count];
    if (budget.cache.has(key)) due.push(key);
  }
  budget.cursor = count ? (budget.cursor + due.length) % count : 0;
  return due;
}

/** Drop a key that no longer exists, so the queue does not grow without bound. */
export function releaseHeight(budget, key) {
  if (!budget.cache.delete(key)) return false;
  const at = budget.order.indexOf(key);
  if (at >= 0) {
    budget.order.splice(at, 1);
    if (budget.cursor > at) budget.cursor--;
    if (budget.order.length === 0) budget.cursor = 0;
    else budget.cursor %= budget.order.length;
  }
  return true;
}

/** How stale the worst-served key currently is, in frames. */
export function worstStaleness(budget) {
  let worst = 0;
  for (const held of budget.cache.values()) worst = Math.max(worst, held.age);
  return worst;
}
