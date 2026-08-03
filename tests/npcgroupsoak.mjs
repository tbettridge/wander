import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, registerLivingWorldEntity } from '../src/livingworldstate.mjs';
import { auditLivingWorldState, LIVING_WORLD_SNAPSHOT_BUDGET_BYTES } from '../src/livingworldquality.mjs';
import { advanceFormationFollower, applyGroupEpisodeEvent, createTravelGroup, formationOffset } from '../src/npcgroup.mjs';

test('a follower walks into a rotated formation slot instead of teleporting with it', () => {
  const leader = { x: 0, z: 0, heading: 0, phase: 'travel' };
  const offset = { forward: -0.75, side: -0.65 };
  const follower = { x: -0.65, z: -0.75, heading: 0, phase: 'loiter' };
  leader.heading = Math.PI / 2;
  const rotatedTarget = {
    x: leader.x + Math.cos(leader.heading) * offset.side + Math.sin(leader.heading) * offset.forward,
    z: leader.z - Math.sin(leader.heading) * offset.side + Math.cos(leader.heading) * offset.forward,
  };
  const teleportDistance = Math.hypot(rotatedTarget.x - follower.x, rotatedTarget.z - follower.z);
  assert.ok(teleportDistance > 1.3, 'the regression requires the former large formation rotation');
  let maximumFrameMove = 0;
  for (let frame = 0; frame < 120; frame++) {
    const before = { x: follower.x, z: follower.z };
    const result = advanceFormationFollower(follower, leader, offset, 1 / 60);
    maximumFrameMove = Math.max(maximumFrameMove, Math.hypot(follower.x - before.x, follower.z - before.z));
    assert.ok(result.accepted <= result.maxFollowSpeed / 60 + 1e-9);
  }
  assert.ok(maximumFrameMove < 0.055, `follower moved ${maximumFrameMove.toFixed(3)}m in one frame`);
  assert.equal(follower.phase, leader.phase, 'a grouped follower must expose the leader travel phase');
  assert.ok(Math.hypot(follower.x - rotatedTarget.x, follower.z - rotatedTarget.z) < 0.05,
    'follower did not converge on the rotated slot');
});

test('64-NPC, 1,000-hour group soak has no membership leaks, deadlocks, or budget overflow', () => {
  const state = createLivingWorldState({ worldSeed: 7007 });
  for (let i = 0; i < 64; i++) registerLivingWorldEntity(state, { id: `npc:${i}`, kind: 'npc', name: `NPC ${i}` });
  let groupCount = 0;
  for (let round = 0; round < 16; round++) {
    for (let block = 0; block < 16; block++) {
      const ids = Array.from({ length: 4 }, (_, offset) => `npc:${block * 4 + offset}`);
      const hour = round * 64 + block * 4;
      const group = createTravelGroup(state, { memberIds: ids }, { nowHour: hour });
      assert.ok(group);
      groupCount++;
      for (const [suffix, type, extra] of [
        ['meet', 'group.rendezvous', {}], ['risk', 'group.risk-entered', { riskScore: 0.7 }],
        ['safe', 'group.risk-cleared', {}], ['argue', 'group.argument-started', {}],
        ['resolve', 'group.argument-resolved', { split: true }], ['split', 'group.split-completed', {}],
      ]) applyGroupEpisodeEvent(state, group.id, { id: `event:${group.id}:${suffix}`, type, ...extra }, { nowHour: hour + 0.1 });
    }
  }
  state.clock.worldHours = 1000;
  const audit = auditLivingWorldState(state);
  assert.deepEqual(audit.errors, []);
  assert.equal(Object.values(state.groups).filter((group) => group.state !== 'dissolved').length, 0);
  assert.ok(Object.keys(state.groups).length <= 64);
  assert.ok(audit.metrics.snapshotBytes <= LIVING_WORLD_SNAPSHOT_BUDGET_BYTES,
    `${audit.metrics.snapshotBytes} exceeds ${LIVING_WORLD_SNAPSHOT_BUDGET_BYTES}`);
  assert.equal(groupCount, 256);
  for (const group of Object.values(state.groups)) for (const actorId of group.memberIds) {
    assert.ok(Math.abs(formationOffset(group, actorId).forward) <= 1.5);
  }
});
