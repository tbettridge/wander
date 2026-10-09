import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeInteriorFurniturePose } from '../src/interiornpcpose.mjs';
import { applyStateDelta } from '../src/multiplayerprotocol.mjs';
import { HostWorldAuthority, GuestWorldProjection } from '../src/multiplayerauthority.mjs';
import {
  createSharedWorldState,
  SHARED_WORLD_PROJECTED_ENTITY_LIMIT,
} from '../src/multiplayersharedworld.mjs';

test('public resident furniture poses survive projection with bounded offsets',()=>{
  const pose={kind:'sleep',height:.66,offsetX:.3,offsetZ:-.6};
  const snapshot=createSharedWorldState({settlements:{home:{id:'home',x:0,z:0,residents:{resident:{pose:{x:1,y:3,z:2},furniturePose:pose,hidden:true}}}}});
  assert.deepEqual(snapshot.settlements.home.residents.resident.furniturePose,pose);
  // Host dormancy is a local rendering decision. A visitor in this house must
  // still see its residents even when the host is on the other side of town.
  assert.equal(snapshot.settlements.home.residents.resident.hidden,undefined);
  const host=new HostWorldAuthority({regionId:'interior-shared',worldSeed:0});
  host.admit('visitor',{pose:{x:0,y:0,z:0}});host.publishSharedWorld(snapshot);
  assert.deepEqual(host.snapshotFor('visitor').state.sharedWorld.settlements.home.residents.resident.furniturePose,pose);
  assert.equal(normalizeInteriorFurniturePose({kind:'invalid'}),null);
  assert.deepEqual(normalizeInteriorFurniturePose({kind:'sit',height:Infinity,offsetX:100,offsetZ:NaN}),{kind:'sit',height:.55,offsetX:4,offsetZ:0});
});

test('shared world snapshots carry public simulation state and preserve private ledger fields', () => {
  const host = new HostWorldAuthority({
    regionId: 'region-shared', worldSeed: 42,
    state: {
      memories: { 'npc:a': [{ summary: 'private' }] },
      entities: { 'npc:a': { id: 'npc:a', kind: 'npc', name: 'A', location: { x: 0, z: 0 } } },
    },
  });
  host.admit('player:guest', { pose: { x: 0, y: 0, z: 0 } });
  host.publishSharedWorld(createSharedWorldState({
    worldSeed: 42,
    clock: { dayIndex: 2, time: 0.5, worldHours: 50 },
    entities: {
      'npc:a': {
        id: 'npc:a', kind: 'npc', name: 'A', pose: { x: 1, y: 2, z: 3, yaw: 0.4 }, state: 'walking',
        identity: {
          seed: 3, family: 'storybook', palette: { primary: 1 }, proportions: { height: 1 },
          appearance: { hat: 'none' }, animation: { phase: 0 }, wardrobe: { garment: 'coat' },
        },
      },
      'npc:far': { id: 'npc:far', kind: 'npc', pose: { x: 5000, y: 0, z: 0 } },
    },
    animals: { 'animal:1': { id: 'animal:1', species: 'fox', pose: { x: 4, y: 0, z: 2 } } },
  }));
  const snapshot = host.snapshotFor('player:guest');
  assert.equal(snapshot.state.sharedWorld.clock.dayIndex, 2);
  assert.ok(snapshot.state.sharedWorld.entities['npc:a']);
  assert.equal(snapshot.state.sharedWorld.entities['npc:far'], undefined);
  assert.equal(snapshot.state.sharedWorld.entities['npc:a'].identity.family, 'storybook');
  assert.equal(snapshot.state.sharedWorld.entities['npc:a'].identity.palette.primary, 1);
  assert.equal(snapshot.state.memories, undefined);
  assert.equal(snapshot.state.entities['npc:a'].name, 'A');
});

test('shared world revisions produce contiguous guest deltas', () => {
  const host = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state: {} });
  host.admit('player:guest');
  const guest = new GuestWorldProjection();
  guest.applySnapshot(host.snapshotFor('player:guest'));
  host.updateFor('player:guest', { force: true }).commit();
  host.publishSharedWorld(createSharedWorldState({ worldSeed: 1, simTick: 1, clock: { time: 0.3 } }));
  const first = host.updateFor('player:guest');
  assert.equal(first.kind, 'delta');
  assert.ok(Math.abs(guest.applyDelta(first.payload, applyStateDelta).sharedWorld.clock.time - 0.3) < 1e-9);
  first.commit();
  host.publishSharedWorld(createSharedWorldState({ worldSeed: 1, simTick: 2, clock: { time: 0.4 } }));
  const second = host.updateFor('player:guest');
  assert.equal(second.payload.baseRevision, guest.revision);
  guest.applyDelta(second.payload, applyStateDelta);
});

test('shared state rejects packets from an older host session', () => {
  const host = new HostWorldAuthority({
    regionId: 'r', worldSeed: 1, sessionEpoch: 'epoch-a', state: {},
  });
  host.admit('player:guest');
  const guest = new GuestWorldProjection();
  guest.applySnapshot(host.snapshotFor('player:guest'));
  assert.equal(guest.sessionEpoch, 'epoch-a');
  assert.throws(() => guest.applyDelta({
    schemaVersion: 1,
    baseRevision: guest.revision,
    revision: guest.revision + 1,
    regionId: 'r',
    sessionEpoch: 'epoch-old',
    operations: [],
  }, applyStateDelta), /contiguous/);
  assert.throws(() => guest.applySnapshot({
    schemaVersion: 1,
    revision: 0,
    regionId: 'r',
    sessionEpoch: 'epoch-old',
    state: {},
  }), /another host session/);
});

test('visitor projections keep the nearest public entities within the snapshot budget', () => {
  const entities = {};
  for (let index = 0; index < SHARED_WORLD_PROJECTED_ENTITY_LIMIT + 32; index += 1) {
    entities[`npc:${String(index).padStart(3, '0')}`] = {
      id: `npc:${String(index).padStart(3, '0')}`,
      kind: 'npc',
      pose: { x: index * 2, y: 0, z: 0 },
      identity: { family: 'storybook', palette: { primary: index } },
    };
  }
  const host = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state: {} });
  host.publishSharedWorld(createSharedWorldState({ worldSeed: 1, entities }));
  host.admit('player:guest', { pose: { x: 0, y: 0, z: 0 } });
  const projection = host.projectionFor('player:guest');
  assert.equal(Object.keys(projection.sharedWorld.entities).length, SHARED_WORLD_PROJECTED_ENTITY_LIMIT);
  assert.ok(projection.sharedWorld.entities['npc:000']);
  assert.equal(projection.sharedWorld.entities['npc:287'], undefined);
  assert.doesNotThrow(() => host.snapshotFor('player:guest'));
});
