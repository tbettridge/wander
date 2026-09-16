import { WATER_CACHE_REVISION } from '../src/hydrologyformat.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldGenerationFor, worldGenerationScope } from '../src/worldgeneration.mjs';
import { LivingWorldStateStore, serializeLivingWorldState, parseLivingWorldState } from '../src/livingworldstate.mjs';
import { NpcMemoryStore } from '../src/npcmemory.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';
import { createLocalIdentity } from '../src/multiplayeridentity.mjs';
const fresh = { terrain: 3, hydrology: WATER_CACHE_REVISION, layout: 'regional' };
function storage() {
  const data = new Map();
  return { data, getItem(k) { return data.get(k) ?? null; }, setItem(k, v) { data.set(k, v); } };
}

test('regional save identity is stable across streamed windows and separate from fixed previews', () => {
  const a = worldGenerationFor({ generationVersion: 3, waterPlanHash: '12345678', waterField: { plans: [{ regional: 1 }] } });
  const b = worldGenerationFor({ generationVersion: 3, waterPlanHash: '87654321', waterField: { plans: [{ regional: 1 }] } });
  assert.deepEqual(a, b);
  assert.notEqual(worldGenerationScope(a), worldGenerationScope(worldGenerationFor({ generationVersion: 3, waterPlanHash: '12345678' })));
  assert.notEqual(worldGenerationScope(a), worldGenerationScope({ ...a, hydrology: WATER_CACHE_REVISION + 1 }));
  assert.notEqual(worldGenerationScope(a), worldGenerationScope({ ...a, hydrology: 1 }));
});

test('fresh saves roundtrip without importing or overwriting same-seed legacy progress', () => {
  const disk = storage();
  const old = new LivingWorldStateStore({ worldSeed: 42, storage: disk });
  const state = old.load(); state.revision = 29; assert.ok(old.save(state));
  const untouched = disk.getItem(old.key());
  const modern = new LivingWorldStateStore({ worldSeed: 42, worldGeneration: fresh, storage: disk });
  const freshState = modern.load(); assert.equal(freshState.revision, 0);
  assert.deepEqual(freshState.worldGeneration, fresh);
  freshState.revision = 9; assert.ok(modern.save(freshState));
  assert.equal(modern.load().revision, 9);
  assert.deepEqual(parseLivingWorldState(serializeLivingWorldState(freshState), { worldSeed: 42 }).worldGeneration, fresh);
  assert.equal(disk.getItem(old.key()), untouched);
  assert.equal(old.load().revision, 29);
  assert.equal(modern.save(state), false, 'mismatched state must not overwrite fresh progress');
  assert.equal(modern.load().revision, 9);
  disk.setItem(modern.key(), untouched);
  assert.equal(modern.load().revision, 0, 'mismatched identity in a scoped record must reject');
  assert.match(modern.lastError.message, /generation mismatch/);
});

test('legacy records without generation metadata still load under unchanged keys', () => {
  const disk = storage(), old = new LivingWorldStateStore({ worldSeed: 42, storage: disk });
  const state = old.load(); state.revision = 12; delete state.worldGeneration;
  disk.setItem(old.key(), JSON.stringify(state));
  assert.equal(old.load().revision, 12);
  assert.equal(worldGenerationScope(old.load().worldGeneration), '');
});

test('NPC memory does not migrate across landscape generations or back on return', () => {
  const disk = storage(), legacy = new NpcMemoryStore({ storage: disk, worldSeed: 42, playerId: 'p' });
  legacy.save('npc:1', { lastConversationSummary: 'An old-map meeting.' });
  const modern = new NpcMemoryStore({ storage: disk, worldSeed: 42, playerId: 'p', worldGeneration: fresh, migrateLegacy: true });
  assert.equal(modern.load('npc:1').lastConversationSummary, '');
  modern.save('npc:1', { lastConversationSummary: 'A lake-side meeting.' });
  assert.equal(modern.load('npc:1').lastConversationSummary, 'A lake-side meeting.');
  assert.equal(legacy.load('npc:1').lastConversationSummary, 'An old-map meeting.');
  modern.setWorldSeed(42);
  assert.equal(modern.load('npc:1').lastConversationSummary, 'An old-map meeting.');
  modern.setWorldSeed(42, { worldGeneration: fresh });
  assert.equal(modern.load('npc:1').lastConversationSummary, 'A lake-side meeting.');
});

test('preview hosting and visits reject before directory calls or travel mutation', async () => {
  let registrations = 0;
  const session = new MultiplayerSession({ seed: 42, identity: createLocalIdentity({ storage: null }),
    getWorldGeneration: () => fresh, directory: { register() { registrations++; } } });
  const region = session.region;
  await assert.rejects(session.openRegion(), /single-player/);
  await assert.rejects(session.requestVisit(), /single-player/);
  assert.equal(registrations, 0);
  assert.equal(session.region, region);
  assert.equal(session.ticket, null);
});
