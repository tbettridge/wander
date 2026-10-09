import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('const npcRetrievalSetting =');
const end = main.indexOf('const createLivingWorldAI =', start);
assert.ok(start >= 0 && end > start);

function settings(saved) {
  const writes = [], configurations = [];
  const context = vm.createContext({
    localStorage: { getItem: () => saved == null ? null : JSON.stringify(saved), setItem: (_key, value) => writes.push(JSON.parse(value)) },
    npcSemanticRetrieval: { configure: value => configurations.push(JSON.parse(JSON.stringify(value))) },
    openNpcRetrievalDebug: () => {},
  });
  vm.runInContext(`${main.slice(start, end)}\nglobalThis.settings = npcRetrievalSetting; globalThis.actions = npcRetrievalActions;`, context);
  return { context, writes, configurations };
}

test('embeddings default off and legacy preferences cannot enable automatic paid comparison', () => {
  for (const saved of [null, { provider: 'gemini', compare: true }, { provider: 'qwen' }]) {
    const { context, configurations } = settings(saved);
    assert.equal(context.settings.enabled, false);
    assert.deepEqual(configurations.at(-1), { provider: 'baseline', compare: false });
  }
});

test('toggle gates both retrieval and comparison while retaining the selected model', () => {
  const { context, writes, configurations } = settings(null);
  context.settings.provider = 'gemini'; context.settings.compare = true;
  context.actions.apply();
  assert.deepEqual(configurations.at(-1), { provider: 'baseline', compare: false });
  context.settings.enabled = true; context.actions.apply();
  assert.deepEqual(configurations.at(-1), { provider: 'gemini', compare: true });
  context.settings.enabled = false; context.actions.apply();
  assert.deepEqual(configurations.at(-1), { provider: 'baseline', compare: false });
  assert.deepEqual(writes.at(-1), { enabled: false, provider: 'gemini', compare: true });
  assert.deepEqual(settings(writes.at(-1)).configurations.at(-1), { provider: 'baseline', compare: false });
});

test('only explicit saved opt-in restores embeddings', () => {
  assert.deepEqual(settings({ enabled: true, provider: 'gemini', compare: false }).configurations.at(-1), { provider: 'gemini', compare: false });
});
