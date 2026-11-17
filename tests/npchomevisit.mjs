import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HOME_NOTICE_SECONDS, HOME_REENTRY_GRACE_SECONDS, HOME_WAKE_RANGE,
  HomeVisitLedger, HomeVisitTracker, homeTemper, homeVisitContext, homeVisitFallbackReply,
  homeVisitInstructions, homeVisitOpeningPrompt, homeVisitReaction, isPrivateHome,
} from '../src/npchomevisit.mjs';
import {
  conversationSystemPrompt, fallbackChatReply, openingPrompt, safeFallbackDialogue,
} from '../src/livingworld.mjs';

const SEED = 4242;
// Residents with each temper under SEED, found rather than assumed.
const byTemper = {};
for (let i = 0; i < 400 && Object.keys(byTemper).length < 3; i++) {
  const id = `npc:test:${i}`;
  byTemper[homeTemper(SEED, id)] ||= id;
}

test('only dwellings are private homes; the inn, shops and halls are open to callers', () => {
  for (const program of ['dwelling', 'row-house', 'infill-house']) assert.equal(isPrivateHome({ program }), true);
  for (const program of ['inn', 'general-store', 'smithy', 'workshop', 'church', 'school', 'community-hall',
    'hall', 'market-hall', 'station-house', 'barn', 'granary']) assert.equal(isPrivateHome({ program }), false, program);
  assert.equal(isPrivateHome(null), false);
});

test('a resident’s temper is fixed by the world seed and who they are, and all three occur', () => {
  assert.deepEqual(Object.keys(byTemper).sort(), ['easygoing', 'fiery', 'prickly']);
  for (const id of Object.values(byTemper)) assert.equal(homeTemper(SEED, id), homeTemper(SEED, id));
  const counts = { easygoing: 0, prickly: 0, fiery: 0 };
  for (let i = 0; i < 2000; i++) counts[homeTemper(SEED, `npc:count:${i}`)]++;
  // Roughly 45 / 35 / 20.
  assert.ok(counts.easygoing > 800 && counts.easygoing < 1000, JSON.stringify(counts));
  assert.ok(counts.fiery > 300 && counts.fiery < 500, JSON.stringify(counts));
});

test('awake residents either ask what you need or ask why you did not knock', () => {
  const easy = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.easygoing, situation: 'intruding' });
  assert.equal(easy.mood, 'welcoming');
  assert.match(easy.line, /help|need|do for you|looking for/i);
  assert.equal(easy.approach, true);
  for (const temper of ['prickly', 'fiery']) {
    const cross = homeVisitReaction({ worldSeed: SEED, actorId: byTemper[temper], situation: 'intruding' });
    assert.equal(cross.mood, 'annoyed', temper);
    assert.match(cross.line, /knock|home|house|inn|invit|let you in|said you could/i);
  }
  // Someone who knows the traveller well takes it in good part.
  assert.equal(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.prickly, familiar: true }).mood, 'welcoming');
});

test('woken sleepers are cross, the fiery ones furious', () => {
  assert.equal(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.easygoing, situation: 'woke' }).mood, 'annoyed');
  assert.equal(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.prickly, situation: 'woke' }).mood, 'annoyed');
  const fiery = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, situation: 'woke' });
  assert.equal(fiery.mood, 'angry');
  assert.match(fiery.line, /out|nerve|mind|asleep/i);
  assert.equal(fiery.approach, true);
});

test('repeat visits are remembered: "you again", then they stop getting up; a second waking is angry', () => {
  const ledger = new HomeVisitLedger();
  const id = byTemper.prickly;
  const first = homeVisitReaction({ worldSeed: SEED, actorId: id, ledger, worldHours: 10 });
  ledger.record(id, 'intruding', 10);
  const second = homeVisitReaction({ worldSeed: SEED, actorId: id, ledger, worldHours: 11 });
  ledger.record(id, 'intruding', 11);
  const third = homeVisitReaction({ worldSeed: SEED, actorId: id, ledger, worldHours: 12 });
  assert.equal(first.repeat, false);
  assert.equal(second.repeat, true);
  assert.notEqual(second.line, first.line);
  assert.match(second.line, /again|twice/i);
  assert.equal(second.approach, true);
  assert.equal(third.approach, false);
  assert.equal(third.visitsToday, 3);
  // A new day starts fresh.
  const tomorrow = homeVisitReaction({ worldSeed: SEED, actorId: id, ledger, worldHours: 40 });
  assert.equal(tomorrow.repeat, false);
  assert.equal(tomorrow.approach, true);

  const sleeper = byTemper.easygoing;
  ledger.record(sleeper, 'woke', 2);
  const again = homeVisitReaction({ worldSeed: SEED, actorId: sleeper, situation: 'woke', ledger, worldHours: 3 });
  assert.equal(again.mood, 'angry');
  assert.match(again.line, /again|twice/i);
});

test('a courier with post for the house gets a softer welcome, and never fury', () => {
  const errand = { kind: 'delivery', title: 'the seed basket' };
  const awake = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, errand });
  assert.equal(awake.mood, 'welcoming');
  assert.match(awake.line, /the seed basket/);
  const woke = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, situation: 'woke', errand });
  assert.equal(woke.mood, 'annoyed');
  assert.match(woke.line, /the seed basket/);
  assert.equal(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.prickly, errand: { kind: 'contact' } }).mood, 'welcoming');
});

test('the tracker: one awake host walks over after a moment; sleepers wake only when you come close', () => {
  const tracker = new HomeVisitTracker();
  const hosts = [
    { id: 'far', awake: true, eligible: true, busy: false, distance: 6, sameFloor: true },
    { id: 'near-upstairs', awake: true, eligible: true, busy: false, distance: 2, sameFloor: false },
    { id: 'near', awake: true, eligible: true, busy: false, distance: 3, sameFloor: true },
    { id: 'child', awake: true, eligible: false, busy: false, distance: 1, sameFloor: true },
    { id: 'sleeper', awake: false, eligible: true, busy: false, distance: HOME_WAKE_RANGE + 1, sameFloor: true },
  ];
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts, simSeconds: 100 }), []);
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts, simSeconds: 100 + HOME_NOTICE_SECONDS }),
    [{ actorId: 'near', situation: 'intruding' }]);
  // Nobody else comes over in the same visit.
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts, simSeconds: 105 }), []);
  // Into the bedroom: within reach of the bed, but upstairs does not count.
  const bedside = hosts.map((host) => host.id === 'sleeper' ? { ...host, distance: 1.5 } : host);
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts: bedside.map((host) => host.id === 'sleeper'
    ? { ...host, sameFloor: false } : host), simSeconds: 106 }), []);
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts: bedside, simSeconds: 107 }),
    [{ actorId: 'sleeper', situation: 'woke' }]);
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts: bedside, simSeconds: 108 }), []);
});

test('the tracker: stepping out and back is the same visit; a later visit is a new one', () => {
  const tracker = new HomeVisitTracker();
  const hosts = [{ id: 'a', awake: true, eligible: true, busy: false, distance: 3, sameFloor: true }];
  tracker.update({ buildingId: 'house', hosts, simSeconds: 0 });
  assert.equal(tracker.update({ buildingId: 'house', hosts, simSeconds: 1 }).length, 1);
  tracker.update({ buildingId: null, simSeconds: 10 });
  assert.deepEqual(tracker.update({ buildingId: 'house', hosts, simSeconds: 20 }), []);
  tracker.update({ buildingId: null, simSeconds: 30 });
  tracker.update({ buildingId: 'house', hosts, simSeconds: 30 + HOME_REENTRY_GRACE_SECONDS + 1 });
  assert.equal(tracker.update({ buildingId: 'house', hosts, simSeconds: 32 + HOME_REENTRY_GRACE_SECONDS }).length, 1);
  // Mid-conversation elsewhere, nobody starts.
  const busy = new HomeVisitTracker();
  busy.update({ buildingId: 'house', hosts, simSeconds: 0, playerBusy: true });
  assert.deepEqual(busy.update({ buildingId: 'house', hosts, simSeconds: 5, playerBusy: true }), []);
  assert.equal(busy.update({ buildingId: 'house', hosts, simSeconds: 6 }).length, 1);
});

const residentContext = {
  npc: { id: 'npc:home:1', name: 'Bram Flint', role: 'resident' },
  station: { id: 'anchor', name: 'Bram Flint’s place' },
  targets: [{ id: 'anchor', name: 'Ravenkeld', kind: 'settlement' }],
  biome: 'meadow', weather: 'clear', timeOfDay: 'at night', encounterBand: 'new', memory: null,
};

test('the dialogue opens with what they already said, and the courier’s errand still follows', () => {
  const reaction = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, situation: 'woke' });
  reaction.spoken = true;
  const homeVisit = homeVisitContext(reaction, { homeName: 'the Flint household' });
  assert.equal(homeVisit.situation, 'woke-you');
  assert.equal(homeVisit.mood, 'angry');
  assert.equal(safeFallbackDialogue({ ...residentContext, homeVisit }).text, reaction.line);
  const courier = { responsibility: 'courier contact', deliveries: [{ id: 'j', title: 'Seed basket' }], offers: [] };
  const merged = safeFallbackDialogue({ ...residentContext, homeVisit, courier }).text;
  assert.ok(merged.startsWith(reaction.line));
  assert.match(merged, /Deliver Seed basket/);
  // Talking again in the same visit: no replayed outburst.
  const again = homeVisitContext(reaction, { opening: false });
  assert.equal(again.opening, null);
  assert.notEqual(safeFallbackDialogue({ ...residentContext, homeVisit: again }).text, reaction.line);
});

test('the model is told it is their home, how they feel, and what they already said', () => {
  const reaction = homeVisitReaction({ worldSeed: SEED, actorId: byTemper.prickly, situation: 'intruding' });
  reaction.spoken = true;
  const homeVisit = homeVisitContext(reaction);
  const prompt = conversationSystemPrompt({ ...residentContext, homeVisit });
  assert.match(prompt, /homeVisit is authoritative/);
  assert.match(prompt, /walked into your own home without knocking/);
  assert.match(prompt, /annoyed/);
  assert.ok(prompt.includes(reaction.line));
  assert.match(prompt, /never refuse a delivery/);
  assert.match(prompt, /"homeVisit":\{"situation":"intruding"/);
  assert.equal(homeVisitInstructions(null), '');
  assert.doesNotMatch(conversationSystemPrompt(residentContext), /homeVisit is authoritative/);
  // Not yet said aloud (the traveller spoke first): the model opens in that mood.
  const unspoken = homeVisitContext({ ...reaction, spoken: false });
  assert.equal(openingPrompt({ ...residentContext, homeVisit: unspoken }), homeVisitOpeningPrompt(unspoken));
  assert.match(homeVisitOpeningPrompt(unspoken), /walked into your home uninvited/);
  assert.match(openingPrompt({ ...residentContext, homeVisit: homeVisitContext(reaction, { opening: false }) }), /still in your home/);
  assert.match(homeVisitOpeningPrompt(homeVisitContext(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, situation: 'woke' }))), /angrily/);
});

test('without a model, apologies, excuses and goodbyes get answers in the same mood', () => {
  const angry = homeVisitContext(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.fiery, situation: 'woke' }));
  const kind = homeVisitContext(homeVisitReaction({ worldSeed: SEED, actorId: byTemper.easygoing }));
  assert.match(fallbackChatReply({ ...residentContext, homeVisit: angry }, 'Sorry, I didn’t mean to wake you').text, /knock/);
  assert.match(fallbackChatReply({ ...residentContext, homeVisit: kind }, 'sorry!').text, /No harm done/);
  assert.match(fallbackChatReply({ ...residentContext, homeVisit: angry }, 'Hello').text, /my house/);
  assert.match(fallbackChatReply({ ...residentContext, homeVisit: angry }, "I'll go").text, /door/);
  assert.match(fallbackChatReply({ ...residentContext, homeVisit: kind }, 'The door was open').text, /not the inn/);
  // Anything else falls through to ordinary replies, directions included.
  assert.equal(homeVisitFallbackReply(angry, 'Where is the station?'), null);
  assert.doesNotMatch(fallbackChatReply({ ...residentContext, homeVisit: angry }, 'Where is Ravenkeld?').text, /my house/);
});

test('settlement residents walk over, wake, and hand the situation to dialogue', async () => {
  const [stream, population, main, runtime] = await Promise.all([
    readFile(new URL('../src/settlementstream.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/courierruntime.js', import.meta.url), 'utf8'),
  ]);
  assert.match(stream, /if \(simulate\) this\._updateHomeVisits\(player\)/);
  // Standing on the step or in the open doorway does not count as being in.
  assert.match(stream, /pointInsideBuilding\(building, player\.x, player\.z, -0\.15\)/);
  assert.match(stream, /if \(resident\.homeVisit && this\._advanceHomeVisit\(current, resident, dt, neighbours, player\)\) return;/);
  assert.match(stream, /routeInterior\(building, position, goal\)/);
  assert.match(stream, /!talkingToPlayer && !resident\.homeVisit\?\.up/);
  assert.match(population, /const homeOpening = context\.homeVisit\?\.opening && context\.homeVisit\.spoken/);
  assert.match(population, /this\.promptLineFor\?\.\(this\.activeNpc\)/);
  assert.match(main, /augmentContext: \(context, actor\) => withHomeVisit\(/);
  assert.match(main, /getHomeVisitErrand: \(actorId, household\) => courierRuntime\?\.homeVisitErrand/);
  assert.match(runtime, /homeVisitErrand\(actorId, household = \[\]\)/);
});
