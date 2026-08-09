import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carriagePassengerTarget,
  selectMobilityCandidates,
  stationPopulationTarget,
} from '../src/npcmobilitydemand.mjs';

test('ordinary daytime station targets stay between two and four people', () => {
  const values = [];
  for (let dayIndex = 0; dayIndex < 30; dayIndex++) {
    for (const hour of [7, 9.5, 12, 16.5, 19.5]) {
      const demand = stationPopulationTarget({
        worldSeed: 41, stationId: 'station:wren', dayIndex, hour,
      });
      assert.equal(demand.daytime, true);
      assert.ok(demand.target >= 2 && demand.target <= 4);
      values.push(demand.target);
    }
  }
  assert.deepEqual([...new Set(values)].sort(), [2, 3, 4]);
});

test('night targets are quiet and the 24-hour clock wraps', () => {
  for (const hour of [0, 4, 6.9, 20, 23.9, 24, -1]) {
    const demand = stationPopulationTarget({
      worldSeed: 9, stationId: 'station:ash', dayIndex: 3, hour,
    });
    assert.equal(demand.daytime, false);
    assert.ok(demand.target === 0 || demand.target === 1);
  }
});

test('each passenger carriage asks for one to three ordinary NPCs', () => {
  const values = [];
  for (let run = 0; run < 40; run++) for (let carriageIndex = 0; carriageIndex < 2; carriageIndex++) {
    const target = carriagePassengerTarget({
      worldSeed: 12, runId: `rail-run:regional:0:${run}`, carriageIndex,
    });
    assert.ok(target >= 1 && target <= 3);
    values.push(target);
  }
  assert.deepEqual([...new Set(values)].sort(), [1, 2, 3]);
});

test('selection is deterministic, input-order independent, and uses only real eligible people', () => {
  const candidates = [
    { personId: 'npc:a' },
    { personId: 'npc:b', committed: true },
    { personId: 'npc:c' },
    { personId: 'npc:d', tombstone: true },
    { personId: 'npc:e' },
    { personId: 'npc:f', eligible: false },
  ];
  const options = { worldSeed: 77, demandKey: 'station:wren:day:4:24', excludedIds: ['npc:e'] };
  const first = selectMobilityCandidates(candidates, 4, options);
  const reversed = selectMobilityCandidates(candidates.slice().reverse(), 4, options);
  assert.deepEqual(first, reversed);
  assert.deepEqual(new Set(first.map((entry) => entry.personId)), new Set(['npc:a', 'npc:c']));
  assert.equal(first.length, 2, 'a shortage remains a shortage instead of creating filler NPCs');
});

test('duplicate IDs cannot occupy multiple demand slots', () => {
  const candidates = [
    { personId: 'npc:a', source: 1 },
    { personId: 'npc:a', source: 2 },
    'npc:b',
  ];
  const options = { demandKey: 'fixture', worldSeed: 1 };
  const selected = selectMobilityCandidates(candidates, 3, options);
  assert.equal(selected.length, 2);
  assert.equal(selected.filter((entry) => (entry.personId ?? entry) === 'npc:a').length, 1);
  assert.deepEqual(
    selectMobilityCandidates(candidates.slice().reverse(), 3, options),
    selected,
    'duplicate representations resolve independently of input order',
  );
});
