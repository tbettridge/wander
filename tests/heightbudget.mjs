// The sampling ceiling that keeps a filling region from stuttering.
//
// The requirement was explicit: budget height sampling rather than letting it
// emerge. What makes that worth testing is the failure mode — not a crash, but
// a stutter that arrives gradually as NPCs accumulate, which is the hardest
// kind of regression to attribute to a cause.

import assert from 'node:assert/strict';
import {
  beginFrame, createHeightBudget, dueForSample, releaseHeight, sampleHeight,
  worstStaleness,
} from '../src/heightbudget.mjs';

// --- the ceiling actually holds -----------------------------------------------
{
  const budget = createHeightBudget({ samplesPerFrame: 5 });
  const keys = Array.from({ length: 40 }, (_, i) => `npc-${i}`);
  // First frame: every key is new, and a new key is always paid for — a walker
  // with no height cannot be placed at all.
  beginFrame(budget);
  for (const key of keys) sampleHeight(budget, key, () => 1);
  assert.equal(budget.cache.size, 40, 'every newcomer gets a height immediately');

  // Steady state: the ceiling binds.
  let calls = 0;
  beginFrame(budget);
  for (const key of keys) sampleHeight(budget, key, () => { calls++; return 2; });
  assert.equal(calls, 5, `the ceiling must hold, ${calls} samples were taken`);
  assert.equal(budget.deferred, 35, 'and the rest are deferred, not dropped');
}

// --- a deferred actor keeps its last height, it does not fall through ---------
{
  const budget = createHeightBudget({ samplesPerFrame: 1 });
  beginFrame(budget);
  sampleHeight(budget, 'a', () => 10);
  sampleHeight(budget, 'b', () => 20);
  beginFrame(budget);
  sampleHeight(budget, 'a', () => 11);          // spends the budget
  const held = sampleHeight(budget, 'b', () => 99);   // deferred
  assert.equal(held, 20,
    'a deferred sample returns the last known height — never zero, never null, '
    + 'because either would drop an NPC through the world for a frame');
}

// --- nobody is starved --------------------------------------------------------
// Serving the queue from the top every frame would refresh the same few keys
// forever while the tail never moved. The cursor is what stops that.
{
  const budget = createHeightBudget({ samplesPerFrame: 3 });
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
  beginFrame(budget);
  for (const key of keys) sampleHeight(budget, key, () => 0);

  const servedCount = new Map(keys.map((k) => [k, 0]));
  for (let frame = 0; frame < 12; frame++) {
    beginFrame(budget);
    for (const key of dueForSample(budget)) {
      servedCount.set(key, servedCount.get(key) + 1);
      sampleHeight(budget, key, () => frame);
    }
  }
  const served = [...servedCount.values()];
  const least = Math.min(...served);
  const most = Math.max(...served);
  assert.ok(least > 0, 'every key must be served at least once over 12 frames');
  assert.ok(most - least <= 1,
    `service must be even, but one key was served ${most} times and another ${least}`);
}

// --- staleness stays bounded --------------------------------------------------
{
  const budget = createHeightBudget({ samplesPerFrame: 4 });
  const keys = Array.from({ length: 16 }, (_, i) => `s${i}`);
  beginFrame(budget);
  for (const key of keys) sampleHeight(budget, key, () => 0);
  for (let frame = 0; frame < 20; frame++) {
    beginFrame(budget);
    for (const key of dueForSample(budget)) sampleHeight(budget, key, () => frame);
  }
  // 16 keys at 4 a frame is a full sweep every 4 frames; nothing should be
  // sitting on a height much older than that.
  assert.ok(worstStaleness(budget) <= 1,
    `worst staleness was ${worstStaleness(budget)} frames, which means the queue is not sweeping`);
}

// --- released keys do not leak, and do not break the cursor -------------------
{
  const budget = createHeightBudget({ samplesPerFrame: 2 });
  beginFrame(budget);
  for (const key of ['a', 'b', 'c', 'd']) sampleHeight(budget, key, () => 1);
  assert.equal(releaseHeight(budget, 'b'), true, 'a departed NPC is released');
  assert.equal(releaseHeight(budget, 'b'), false, 'and releasing it twice is a no-op');
  assert.equal(budget.order.length, 3, 'the queue shrinks with it');
  assert.ok(budget.cursor < budget.order.length, 'and the cursor stays in range');

  for (const key of ['a', 'c', 'd']) releaseHeight(budget, key);
  assert.equal(budget.cursor, 0, 'an emptied queue resets rather than wrapping oddly');
  assert.deepEqual(dueForSample(budget), [], 'and asks for no work');
}

console.log('heightbudget PASS · the per-frame ceiling holds · deferred samples keep '
  + 'their last height rather than dropping · service is even across actors · '
  + 'staleness stays bounded · released keys leave cleanly');
