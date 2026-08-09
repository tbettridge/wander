import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackgroundQueueOverflowError,
  LivingWorldAIRuntime,
} from '../src/livingworldairuntime.mjs';

function enabledRuntime(options = {}) {
  const runtime = new LivingWorldAIRuntime(options);
  runtime.setEnabled(true);
  runtime.setAvailability('ready');
  return runtime;
}

test('runtime serializes inference and preserves FIFO within a priority', async () => {
  const runtime = enabledRuntime();
  let active = 0;
  let peak = 0;
  const order = [];
  const run = (label) => runtime.enqueue({
    priority: 'normal',
    kind: label,
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      order.push(label);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return label;
    },
  });

  assert.deepEqual(await Promise.all([run('one'), run('two'), run('three')]),
    ['one', 'two', 'three']);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['one', 'two', 'three']);
});

test('foreground dialogue preempts and requeues background synthesis once', async () => {
  const runtime = enabledRuntime();
  const order = [];
  let lowAttempts = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const low = runtime.enqueue({
    priority: 'low',
    kind: 'memory',
    activity: 'remembering',
    background: true,
    run: ({ signal }) => {
      lowAttempts++;
      order.push(`memory-${lowAttempts}`);
      if (lowAttempts > 1) return Promise.resolve('remembered');
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('preempted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  await started;
  const high = runtime.enqueue({
    priority: 'high',
    kind: 'reply',
    run: async () => { order.push('reply'); return 'spoken'; },
  });

  assert.equal(await high, 'spoken');
  assert.equal(await low, 'remembered');
  assert.deepEqual(order, ['memory-1', 'reply', 'memory-2']);
  assert.equal(runtime.snapshot().metrics.preempted, 1);
});

test('background queue is bounded without dropping player-facing jobs', async () => {
  const runtime = enabledRuntime({ backgroundLimit: 1 });
  let release;
  const first = runtime.enqueue({
    priority: 'low', background: true, kind: 'memory',
    run: () => new Promise((resolve) => { release = resolve; }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(runtime.enqueue({
    priority: 'low', background: true, kind: 'memory', run: async () => null,
  }), BackgroundQueueOverflowError);
  const foreground = runtime.enqueue({
    priority: 'high', kind: 'reply', run: async () => 'reply',
  });
  release?.('memory');
  assert.equal(await foreground, 'reply');
  await first;
});

test('three runtime failures open a bounded circuit breaker', () => {
  let now = 1000;
  const runtime = enabledRuntime({ now: () => now, cooldownMs: 30000 });
  runtime.recordFailure(new Error('one'));
  runtime.recordFailure(new Error('two'));
  assert.equal(runtime.isCoolingDown(), false);
  runtime.recordFailure(new Error('three'));
  assert.equal(runtime.isCoolingDown(), true);
  assert.equal(runtime.snapshot().availability, 'cooldown');
  now += 30001;
  assert.equal(runtime.isCoolingDown(), false);
  assert.equal(runtime.snapshot().availability, 'probing');
});

test('disabling AI aborts active work and clears pending work', async () => {
  const runtime = enabledRuntime();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const active = runtime.enqueue({
    priority: 'high', kind: 'reply',
    run: ({ signal }) => new Promise((resolve, reject) => {
      markStarted();
      signal.addEventListener('abort', () => {
        const error = new Error('disabled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const pending = runtime.enqueue({
    priority: 'normal', kind: 'quest', run: async () => 'never',
  });
  await started;
  runtime.setEnabled(false);
  await assert.rejects(active, { name: 'AbortError' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(runtime.queueDepth(), 0);
  assert.equal(runtime.snapshot().availability, 'disabled');
});
