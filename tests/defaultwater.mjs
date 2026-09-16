import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareWaterPreview } from '../src/hydrologypreview.mjs';
import { createWaterAgreement, supportsWaterAgreement } from '../src/wateragreement.mjs';
import { WaterField } from '../src/waterfield.mjs';
import { descriptorHash, WATER_CACHE_REVISION } from '../src/hydrologyformat.mjs';

function emptyPlan(seed, regionX, regionZ) {
  const plan = {
    version: 1,
    generationVersion: 3,
    regional: 1,
    preview: true,
    seed,
    regionX,
    regionZ,
    basins: [],
    components: [],
  };
  return { ...plan, hash: descriptorHash(plan) };
}

function emptyWindow(seed, regionX, regionZ) {
  const plans = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      plans.push(emptyPlan(seed, regionX + dx, regionZ + dz));
    }
  }
  return plans;
}

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'plan-water-window') {
      queueMicrotask(() => this.onmessage?.({
        data: {
          ...message,
          type: 'water-window-planned',
          plans: emptyWindow(message.seed, message.regionX, message.regionZ),
        },
      }));
    } else if (message.type === 'plan-network-preview') {
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'network-preview-planned',
          id: message.id,
          plan: { preview: true, seed: message.seed },
        },
      }));
    }
  }

  terminate() {
    this.terminated = true;
  }
}

function workerFactoryFor(workers) {
  return url => {
    const worker = new FakeWorker();
    workers.push({ worker, url: String(url) });
    return worker;
  };
}

test('no-query startup defaults to regional water and supports the current agreement revision', async () => {
  const workers = [];
  const result = await prepareWaterPreview(42, '', { workerFactory: workerFactoryFor(workers) });

  try {
    assert.equal(result.explicitPreview, false);
    assert.equal(result.generationVersion, 3);
    assert.equal(result.waterPlans.length, 9);
    assert.ok(result.preparedField instanceof WaterField);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].worker.messages[0].type, 'plan-water-window');
    assert.equal(workers[0].worker.messages[0].startup, true);

    const agreement = createWaterAgreement(42, 0, 0, result.waterPlans);
    assert.equal(agreement.generation.hydrology, WATER_CACHE_REVISION);
    assert.equal(agreement.generation.layout, 'regional');
    assert.equal(agreement.regions.length, 9);
    assert.equal(supportsWaterAgreement({ version: agreement.version, ...agreement.generation }), true);
  } finally {
    result.stream.dispose();
  }
});

test('unrelated query parameters retain regional startup', async () => {
  const workers = [];
  const result = await prepareWaterPreview(43, '?foo=bar', { workerFactory: workerFactoryFor(workers) });

  try {
    assert.equal(result.explicitPreview, false);
    assert.equal(result.waterPlans.length, 9);
    assert.equal(workers[0].worker.messages[0].type, 'plan-water-window');
    assert.equal(workers[0].worker.messages[0].regionX, 0);
    assert.equal(workers[0].worker.messages[0].regionZ, 0);
  } finally {
    result.stream.dispose();
  }
});

test('recognized preview mode remains explicit and dispatches its preview request', async () => {
  const workers = [];
  const result = await prepareWaterPreview(44, '?waterPreview=character&waterPreviewRegionX=2&waterPreviewRegionZ=-1', {
    workerFactory: workerFactoryFor(workers),
  });

  assert.equal(result.explicitPreview, true);
  assert.deepEqual(result.waterPlans, [{ preview: true, seed: 44 }]);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].worker.messages[0].type, 'plan-network-preview');
  assert.equal(workers[0].worker.messages[0].regionX, 2);
  assert.equal(workers[0].worker.messages[0].regionZ, -1);
  assert.equal(workers[0].worker.messages[0].riverCharacter, true);
  assert.equal(workers[0].worker.terminated, true);
});
