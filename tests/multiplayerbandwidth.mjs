// The host describes what changed, not the world, and only the part of the world
// the visitor is in.
//
// Measured on a live connection before this: 307 KB of state against 83 KB of
// movement over twenty seconds — four fifths of all traffic was a complete
// projection resent every five seconds whether or not anything had moved. On a
// world of four hundred residents that is 29 MiB per visitor-hour, and it is
// billed by the gigabyte the moment a visit goes through the relay.

import assert from 'node:assert/strict';
import { HostWorldAuthority, INTEREST_RADIUS, placePosition } from '../src/multiplayerauthority.mjs';
import { GuestWorldProjection } from '../src/multiplayerauthority.mjs';
import { applyStateDelta, createEnvelope, encodeEnvelope, quantizePose } from '../src/multiplayerprotocol.mjs';
import { diffProjections } from '../src/statediff.mjs';

function worldOf(npcs, { spread = 900 } = {}) {
  const state = { entities: {}, publicProjections: {}, narrativeFacts: {} };
  for (let i = 0; i < npcs; i++) {
    const angle = i * 2.39996, radius = 40 + (i % 7) * spread;
    state.entities[`npc:${i}`] = {
      id: `npc:${i}`, kind: 'npc', name: `Name ${i}`, role: 'resident',
      location: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
    };
  }
  return state;
}

// --- a quiet world costs nothing -------------------------------------------
{
  const state = worldOf(400);
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  authority.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });

  const join = authority.updateFor('player:g1');
  assert.equal(join.kind, 'snapshot', 'a visitor joins on a full snapshot');
  join.commit();

  const quiet = authority.updateFor('player:g1');
  assert.equal(quiet.kind, 'none', 'a tick where nothing changed must send nothing at all');
  assert.equal(quiet.payload, null);

  state.entities['npc:0'].location = { x: 11, y: 0, z: 9 };
  const moved = authority.updateFor('player:g1');
  assert.equal(moved.kind, 'delta', 'a change is described, not resent');
  moved.commit();
  const deltaBytes = JSON.stringify(moved.payload).length;
  const snapshotBytes = JSON.stringify(join.payload).length;
  assert.ok(deltaBytes < snapshotBytes / 50,
    `a one-npc change must be far smaller than the world, saw ${deltaBytes}B vs ${snapshotBytes}B`);
}

// --- the visitor only hears about their part of the world -------------------
{
  const state = worldOf(1200);
  const near = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  near.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });
  const culled = near.projectionFor('player:g1');
  const total = Object.keys(state.entities).length;
  const shown = Object.keys(culled.entities).length;
  assert.ok(shown < total * 0.5,
    `most of a large world must be out of interest, saw ${shown} of ${total}`);

  // Everything shown is genuinely within reach, and the visitor is always there.
  for (const [id, entity] of Object.entries(culled.entities)) {
    if (!entity.location || id.startsWith('player:')) continue;
    assert.ok(Math.hypot(entity.location.x, entity.location.z) <= INTEREST_RADIUS + 1,
      `${id} is outside the interest radius but was described`);
  }
  assert.ok(culled.entities['player:g1'], 'the visitor is always part of their own projection');

  // The radius has to outlast settlement streaming, or a village would stream in
  // around the visitor with nobody living in it.
  assert.ok(INTEREST_RADIUS > 720,
    'interest must reach beyond the 720m at which settlements stream in');
}

// --- a guest rebuilt from deltas matches the host exactly -------------------
{
  const state = worldOf(200);
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  authority.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });
  const guest = new GuestWorldProjection();

  const join = authority.updateFor('player:g1');
  guest.applySnapshot(join.payload);
  join.commit();

  // A busy minute: npcs move, one leaves, one arrives, the visitor walks.
  for (let tick = 0; tick < 12; tick++) {
    state.entities[`npc:${tick}`].location = { x: tick * 3, y: 0, z: tick * -2 };
    if (tick === 4) delete state.entities['npc:100'];
    if (tick === 6) state.entities['npc:new'] = { id: 'npc:new', kind: 'npc', name: 'Newcomer', role: 'resident', location: { x: 5, y: 0, z: 5 } };
    authority.receiveMotion('player:g1', quantizePose({ x: tick, y: 0, z: tick }));
    const update = authority.updateFor('player:g1');
    if (update.kind === 'none') continue;
    if (update.kind === 'snapshot') guest.applySnapshot(update.payload);
    else guest.applyDelta(update.payload, applyStateDelta);
    update.commit();
  }

  assert.deepEqual(
    guest.state,
    authority.projectionFor('player:g1'),
    'a guest rebuilt from deltas must be identical to what the host would have sent whole',
  );
}

// --- a key that cannot round-trip falls back to a snapshot ------------------
{
  // Dot-joined paths are split by the receiver, so a key containing a dot would
  // land somewhere the host never wrote. Refusing the diff is the safe answer.
  const before = { entities: { 'npc:1': { name: 'A' } } };
  const after = { entities: { 'npc:1': { name: 'A' }, 'npc.2': { name: 'B' } } };
  assert.equal(diffProjections(before, after), null, 'a dotted key must refuse the diff');

  // And too much change is a snapshot too, rather than an oversized delta.
  const wide = { entities: {} }, wider = { entities: {} };
  for (let i = 0; i < 400; i++) wider.entities[`npc:${i}`] = { name: `N${i}` };
  assert.equal(diffProjections(wide, wider), null, 'more operations than the protocol allows must refuse');
}

// --- motion carries the pose and nothing it can do without ------------------
{
  const pose = quantizePose({ x: 1234.56, y: 12.3, z: -987.65, yaw: 1.234, pitch: 0.1, moving: true });
  const fat = encodeEnvelope(createEnvelope('motion',
    { playerId: 'player:9cb8f2d1-6ad1-4c7a-9664-fce4c86b14f7', displayName: 'Traveller', pose },
    { from: 'player:9cb8f2d1-6ad1-4c7a-9664-fce4c86b14f7', sequence: 1234 })).length;
  const lean = encodeEnvelope(createEnvelope('motion', { pose }, {})).length;
  assert.ok(lean <= fat * 0.6, `motion must be substantially leaner, saw ${lean}B vs ${fat}B`);

  // It still has to be a legal envelope, or the receiver drops it silently.
  const { validateEnvelope, decodeEnvelope } = await import('../src/multiplayerprotocol.mjs');
  const wire = encodeEnvelope(createEnvelope('motion', { pose }, {}));
  const back = decodeEnvelope(wire);
  assert.equal(validateEnvelope(back).ok, true, 'a stripped motion envelope must still validate');
  assert.deepEqual(back.payload.pose, pose);
}

// --- leaving takes the baseline with it -------------------------------------
{
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state: worldOf(20) });
  authority.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });
  authority.updateFor('player:g1').commit();
  assert.equal(authority.baselines.size, 1);
  authority.remove('player:g1');
  assert.equal(authority.baselines.size, 0, 'a departed visitor must not leave a baseline behind');
}

// --- an update that was never sent is not a baseline ------------------------
// Found live, not in a test: a guest sat in a completely empty region while the
// host reported it had everything. The state channel had not finished opening
// when the join snapshot was produced, the send was refused, and producing the
// snapshot had already recorded it as delivered. Every later diff was taken
// against a world the guest had never been given, came back empty, and so the
// host said nothing at all for the rest of the visit.
{
  const state = worldOf(30);
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  authority.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });

  const refused = authority.updateFor('player:g1');
  assert.equal(refused.kind, 'snapshot');
  // The channel refuses it, so commit is never called.
  assert.equal(authority.baselines.size, 0, 'an unsent snapshot must not become a baseline');

  const retry = authority.updateFor('player:g1');
  assert.equal(retry.kind, 'snapshot', 'the next tick must offer the whole world again');
  retry.commit();

  const guest = new GuestWorldProjection();
  guest.applySnapshot(retry.payload);
  assert.deepEqual(guest.state, authority.projectionFor('player:g1'),
    'the guest ends up with the world the host meant to send');
  assert.ok(Object.keys(guest.state.entities).length > 1, 'and that world is not empty');

  // Producing a snapshot on its own still records nothing.
  authority.snapshotFor('player:g1');
  state.entities['npc:1'].location = { x: 3, y: 0, z: 3 };
  const next = authority.updateFor('player:g1');
  assert.equal(next.kind, 'delta', 'snapshotFor must not have moved the baseline');
  next.commit();
  guest.applyDelta(next.payload, applyStateDelta);
  assert.deepEqual(guest.state, authority.projectionFor('player:g1'));
}

// --- two visitors do not share a revision chain -----------------------------
// Deltas are per-visitor now, because what a visitor is shown depends on where
// they stand. A single global counter therefore handed the second visitor a
// baseRevision belonging to the first, and applyDelta refuses anything that is
// not contiguous — both guests would have desynchronised on the first change.
{
  const state = worldOf(60);
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  authority.admit('player:a', { pose: { x: 0, y: 0, z: 0 } });
  authority.admit('player:b', { pose: { x: 60, y: 0, z: 60 } });
  const guests = { 'player:a': new GuestWorldProjection(), 'player:b': new GuestWorldProjection() };

  for (const id of ['player:a', 'player:b']) {
    const join = authority.updateFor(id);
    guests[id].applySnapshot(join.payload);
    join.commit();
  }

  for (let tick = 0; tick < 8; tick++) {
    // Everything that moves this tick moves before anyone is served, so that a
    // difference between the two guests is a desynchronisation and not simply
    // one of them having been served first.
    state.entities[`npc:${tick}`].location = { x: tick * 4, y: 0, z: tick };
    for (const id of ['player:a', 'player:b']) {
      authority.receiveMotion(id, quantizePose({ x: tick, y: 0, z: tick }));
    }
    for (const id of ['player:a', 'player:b']) {
      const update = authority.updateFor(id);
      if (update.kind === 'none') continue;
      // The throw here is the regression: a shared counter makes this
      // "needs a contiguous delta" the moment the second visitor is served.
      if (update.kind === 'snapshot') guests[id].applySnapshot(update.payload);
      else guests[id].applyDelta(update.payload, applyStateDelta);
      update.commit();
    }
  }

  for (const id of ['player:a', 'player:b']) {
    assert.deepEqual(guests[id].state, authority.projectionFor(id),
      `${id} must be exactly what the host would have sent whole`);
  }
}

// --- interest is measured against where an entity actually is ---------------
// The living world stores a location as a place, not a point: a room, in a
// building, in a settlement. Reading `.x` off one gives undefined, so culling
// compared NaN against the radius -- false for every entity -- and nothing was
// ever culled, while every resident was described to visitors as standing on
// the origin. Both only showed up against real world data.
{
  const symbolic = { kind: 'building', settlementId: 'station-settlement:0', buildingId: 'b:5', nodeId: 'r:0' };
  assert.equal(placePosition(symbolic, null), null,
    'an unresolvable place is unplaced, never the origin');
  assert.deepEqual(placePosition(symbolic, () => ({ x: 12, y: 3, z: -4 })), { x: 12, y: 3, z: -4 },
    'a symbolic place is resolved through the host settlement index');
  assert.deepEqual(placePosition({ x: 1, y: 2, z: 3 }, null), { x: 1, y: 2, z: 3 },
    'a place that already carries coordinates needs no resolver');
  assert.ok(Object.is(placePosition({ x: -0, y: 0, z: -0 }, null).z, 0),
    'negative zero must not survive: JSON cannot encode it and the guest would disagree');

  const state = { entities: {}, publicProjections: {} };
  const homes = { far: { x: 9000, y: 0, z: 9000 }, near: { x: 30, y: 0, z: 30 } };
  for (let i = 0; i < 40; i++) {
    state.entities[`npc:${i}`] = {
      id: `npc:${i}`, kind: 'npc', name: `N${i}`, role: 'resident',
      location: { kind: 'building', settlementId: i % 2 ? 'far' : 'near' },
    };
  }
  const resolvePlace = (location) => homes[location?.settlementId] || null;

  const blind = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state });
  blind.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });
  assert.equal(Object.keys(blind.projectionFor('player:g1').entities).length, 41,
    'with no resolver nothing can be culled, and that is the honest answer');
  assert.equal(blind.projectionFor('player:g1').entities['npc:0'].location, null,
    'an entity that cannot be placed is unplaced, not piled onto the origin');

  const seeing = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state, resolvePlace });
  seeing.admit('player:g1', { pose: { x: 0, y: 0, z: 0 } });
  const projection = seeing.projectionFor('player:g1');
  const ids = Object.keys(projection.entities);
  assert.equal(ids.length, 21, `half the world is out of interest, saw ${ids.length}`);
  assert.deepEqual(projection.entities['npc:0'].location, { x: 30, y: 0, z: 30 },
    'a resolved resident is described where their settlement actually stands');
  assert.ok(!projection.entities['npc:1'], 'the far settlement is not described at all');
}

// --- a visitor who has not spoken yet is assumed to be beside the host -------
// The join snapshot is the largest payload of a visit and it is sent before the
// guest has reported a single position, so interest had nothing to measure from
// and the one payload worth narrowing was the one that never was.
{
  const state = { entities: {}, publicProjections: {} };
  const homes = { far: { x: 9000, y: 0, z: 9000 }, near: { x: 30, y: 0, z: 30 } };
  for (let i = 0; i < 40; i++) {
    state.entities[`npc:${i}`] = {
      id: `npc:${i}`, kind: 'npc', name: `N${i}`, role: 'resident',
      location: { kind: 'building', settlementId: i % 2 ? 'far' : 'near' },
    };
  }
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state,
    resolvePlace: (location) => homes[location?.settlementId] || null });
  authority.admit('player:g1');

  assert.equal(Object.keys(authority.projectionFor('player:g1').entities).length, 41,
    'with nowhere to measure from, nothing can be culled');
  authority.setDefaultViewpoint({ x: 0, y: 0, z: 0 });
  assert.equal(Object.keys(authority.projectionFor('player:g1').entities).length, 21,
    'the host position stands in until the visitor reports their own');

  // Once they do speak, it is their position that counts, not the host's.
  authority.receiveMotion('player:g1', quantizePose({ x: 9000, y: 0, z: 9000 }));
  const ids = Object.keys(authority.projectionFor('player:g1').entities);
  assert.ok(ids.includes('npc:1'), 'a visitor who walked to the far settlement is shown it');
  assert.ok(!ids.includes('npc:0'), 'and is no longer shown the one they left');
}

console.log('multiplayerbandwidth PASS · quiet ticks send nothing · deltas replace snapshots · '
  + 'interest culled beyond streaming range · guest reconstruction is exact · '
  + 'unsafe diffs fall back to snapshots · motion halved · '
  + 'an unsent update is not a baseline · per-visitor revision chains · '
  + 'symbolic places resolved before interest is measured · '
  + 'the join snapshot is narrowed from the host viewpoint');
