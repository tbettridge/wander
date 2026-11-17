import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import {
  nameRegionalStations, RAILWAY_SERVICE_DEFAULTS, TrainScheduleModel,
} from '../src/railservice.mjs';
import {
  isRailwayStaff, projectRailCalls, railwayFallbackReply, railwayKnowledgeFor,
  railwayNowDigest, railwayOpeningLine, spokenDuration, spokenTime, mentionedRailStation,
} from '../src/railtimetable.mjs';
import { SKY_DAY_LENGTH, SKY_NIGHT_RATE, skyClockRate, skyTimeAfter } from '../src/skyclock.mjs';
import { buildStationDialogueContext } from '../src/livingworldcontext.mjs';
import {
  composeDialogueTurn, conversationSystemPrompt, fallbackChatReply, safeFallbackDialogue,
} from '../src/livingworld.mjs';

// --- the clock the keeper reads is the sky's clock --------------------------
assert.equal(SKY_DAY_LENGTH, 1867);
assert.equal(skyClockRate(0.5), 1, 'noon runs at the daytime rate');
assert.equal(skyClockRate(0), SKY_NIGHT_RATE, 'midnight runs at the night rate');
assert.ok(Math.abs(skyTimeAfter(0.5, SKY_DAY_LENGTH / 24) - (0.5 + 1 / 24)) < 1e-9,
  'an hour of daylight is DAY_LENGTH/24 real seconds');
assert.ok(skyTimeAfter(0.95, 60) - 0.95 > 5 * 60 / SKY_DAY_LENGTH, 'night passes faster');

// --- spoken phrases ------------------------------------------------------------
const at = (h, m) => (h * 60 + m) / 1440;
assert.equal(spokenTime(at(15, 51), at(13, 0)), 'about ten to four in the afternoon');
assert.equal(spokenTime(at(9, 15), at(8, 0)), 'about quarter past nine in the morning');
assert.equal(spokenTime(1 + at(17, 8), at(20, 0)), 'about ten past five tomorrow evening');
assert.equal(spokenTime(1 + at(2, 30), at(22, 0)), 'about half past two in the small hours');
assert.equal(spokenTime(at(12, 1), at(9, 0)), 'about noon');
assert.equal(spokenDuration(38), 'about forty minutes');
assert.equal(spokenDuration(62), 'about an hour');
assert.equal(spokenDuration(150), 'about two and a half hours');
assert.equal(spokenDuration(1530), 'about twenty-five and a half hours');

// --- who knows the timetable ------------------------------------------------
assert.ok(isRailwayStaff({ role: 'station keeper' }));
assert.ok(isRailwayStaff({ role: 'railway porter' }));
assert.ok(isRailwayStaff({ role: 'platform vendor' }));
assert.ok(!isRailwayStaff({ role: 'local resident' }));
assert.ok(!isRailwayStaff({ role: 'miller' }));
assert.ok(!isRailwayStaff(null));

// Drive a schedule the way the game does: small frame steps.
function runFrames(schedule, seconds, dt = 1 / 60) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) schedule.step(dt);
}

function secondsUntilDeparture(schedule, stationIndex, dt = 1 / 60) {
  const copy = TrainScheduleModel.restore(schedule.snapshot());
  for (let t = dt; t < 4 * 3600; t += dt) {
    copy.step(dt);
    if (copy.justDeparted && copy.departureEvent.stationIndex === stationIndex) return t;
  }
  return Infinity;
}

const seeds = [20260612, 812731, 41];
const examples = [];
for (const seed of seeds) {
  const world = new World(seed);
  const plan = planRegionalRailway(world, { center: { x: 0, z: 0 }, seed, stationCount: 5 });
  nameRegionalStations(plan, { world, seed });
  const stations = plan.stations;
  const names = stations.map((station) => station.name);
  const schedule = new TrainScheduleModel(plan.route.length, stations.map((s) => s.routeDistance),
    { ...RAILWAY_SERVICE_DEFAULTS });
  // Somewhere mid-run, at a seed-dependent moment.
  runFrames(schedule, 90 + (seed % 400));
  const skyTime = 0.3 + (seed % 7) / 20;

  const projection = projectRailCalls(schedule, { skyTime });
  assert.ok(projection.events.length > stations.length * 2, `seed ${seed}: projection is too short`);
  assert.equal(schedule.serviceSeconds > 0, true, 'projecting must not advance the live schedule');
  const before = schedule.snapshot();
  railwayKnowledgeFor({ schedule, stations, stationId: stations[0].id, skyTime });
  assert.deepEqual(schedule.snapshot(), before, `seed ${seed}: reading the timetable moved the train`);

  for (const home of stations) {
    const railway = railwayKnowledgeFor({ schedule, stations, stationId: home.id, skyTime });
    assert.ok(railway, `seed ${seed}: ${home.name} keeper has no timetable`);
    assert.equal(railway.yourStation, home.name);
    // Every other station on the line, once, in calling order, never home.
    assert.deepEqual([...railway.callingOrderFromHere].sort(),
      names.filter((name) => name !== home.name).sort(), `seed ${seed}: wrong stations from ${home.name}`);
    const order = [...schedule.stops.map((stop) => stop.index)];
    const homeAt = order.indexOf(home.index);
    const expectedNext = stations.find((s) => s.index === order[(homeAt + 1) % order.length]).name;
    assert.equal(railway.callingOrderFromHere[0], expectedNext, `seed ${seed}: wrong next stop from ${home.name}`);
    assert.match(railway.howItRuns, /always the same way round/);
    assert.ok(railway.leavesHeading, 'a keeper knows which way trains leave');

    // Departures are in the future, in order, and match the live schedule.
    assert.equal(railway.nextDepartures.length, 2);
    const [first, second] = railway.nextDepartures;
    assert.ok(first.inMinutes >= 0 && second.inMinutes > first.inMinutes);
    const realSeconds = secondsUntilDeparture(schedule, home.index);
    const truthDay = skyTimeAfter(skyTime, realSeconds, 1 / 4);
    const truthMinutes = Math.round((truthDay - skyTime) * 1440);
    assert.ok(Math.abs(truthMinutes - first.inMinutes) <= Math.max(2, truthMinutes * 0.005),
      `seed ${seed}: ${home.name} says ${first.inMinutes} game minutes, the train takes ${truthMinutes}`);
    assert.equal(first.at, spokenTime(skyTime + first.inMinutes / 1440, skyTime));

    // Rides lengthen stop by stop and every destination is reachable.
    assert.equal(railway.destinations.length, stations.length - 1);
    for (const [index, entry] of railway.destinations.entries()) {
      assert.equal(entry.stopsBetween, index);
      assert.equal(entry.station, railway.callingOrderFromHere[index]);
      assert.ok(entry.ride && entry.arrivesOnNextTrain && entry.direction && entry.distancePhrase);
    }
    assert.ok(railway.roundTrip);
    assert.ok(JSON.stringify(railway).length < 2200, `seed ${seed}: the timetable is bloating prompts`);

    // The no-AI voice answers from the same facts.
    const next = railwayFallbackReply(railway, 'When is the next train?').text;
    assert.ok(next.includes(expectedNext) && next.includes(first.at.replace(/^about /, '')),
      `seed ${seed}: next-train reply disagrees with the timetable: ${next}`);
    const far = railway.destinations.at(-1);
    const howLong = railwayFallbackReply(railway, `How long is the train to ${far.station}?`).text;
    assert.ok(howLong.includes(far.ride), `seed ${seed}: ride time missing: ${howLong}`);
    assert.ok(howLong.includes(far.arrivesOnNextTrain));
    const getTo = railwayFallbackReply(railway, `How do I get to ${far.station.toLowerCase()}`).text;
    assert.ok(getTo.includes(far.station) && getTo.includes(far.arrivesOnNextTrain));
    const line = railwayFallbackReply(railway, 'Where does this line go?').text;
    for (const name of railway.callingOrderFromHere) assert.ok(line.includes(name), `line reply misses ${name}`);
    assert.match(railwayFallbackReply(railway, 'Do I need to change trains?').text, /No changing needed/);
    assert.equal(railwayFallbackReply(railway, 'Lovely weather today.'), null);
    assert.equal(railwayFallbackReply(railway, 'When did you move here?'), null,
      'a question about the keeper is not a timetable question');
    assert.ok(railwayOpeningLine(railway).includes(expectedNext));
    examples.push({ seed, home: home.name, railway });
  }

  // A train standing at the platform with its doors open is "in now".
  const dwelling = new TrainScheduleModel(plan.route.length, stations.map((s) => s.routeDistance),
    { ...RAILWAY_SERVICE_DEFAULTS, startIndex: 2 });
  const standing = stations.find((s) => s.index === dwelling.currentStationIndex);
  const boarding = railwayKnowledgeFor({ schedule: dwelling, stations, stationId: standing.id, skyTime: 0.5 });
  assert.equal(boarding.nextDepartures[0].boardingNow, true);
  assert.ok(boarding.nextDepartures[0].inMinutes <= 15, 'the dwelling train leaves within its dwell');
  assert.match(boarding.trainNow, /doors open/);
  assert.match(railwayFallbackReply(boarding, 'when does the train leave?').text, /The train is in now/);
}

// Partial names: a unique word resolves, a shared one asks which.
{
  const railway = { yourStation: 'Dune Point', callingOrderFromHere: ['Fernden Fields', 'Fernden Ford', 'Shell Halt'] };
  assert.deepEqual(mentionedRailStation(railway, 'train to shell?'), { status: 'resolved', name: 'Shell Halt' });
  assert.equal(mentionedRailStation(railway, 'how far is fernden').status, 'ambiguous');
  assert.equal(mentionedRailStation(railway, 'which halt?').status, 'none', 'a generic suffix names nothing');
}

// --- wiring into the dialogue layer -------------------------------------------
{
  const { railway } = examples[0];
  const world = new World(examples[0].seed);
  const station = { id: 'station-1', name: railway.yourStation, x: 0, z: 0, index: 0 };
  const base = buildStationDialogueContext({
    world, station, player: { x: 4, z: 0 }, sky: { time: 0.5 }, weather: null,
    npc: { id: 'npc:keeper', name: 'Ada Wren', role: 'station keeper', family: 'cloaked' },
  });
  const keeper = { ...base, railway };
  const prompt = conversationSystemPrompt(keeper);
  assert.match(prompt, /You work this station, so you know the railway/);
  assert.ok(prompt.includes(JSON.stringify(railway.callingOrderFromHere)), 'the prompt carries the calling order');
  const plain = conversationSystemPrompt(base);
  assert.doesNotMatch(plain, /"railway"|You work this station/, 'non-staff prompts are unchanged');

  const turn = composeDialogueTurn('When is the next train?', null, keeper);
  assert.match(turn, /\[GAME_RAILWAY_NOW\]/);
  assert.ok(turn.includes(JSON.stringify(railwayNowDigest(railway))));
  assert.equal(composeDialogueTurn('hello', null, base), 'hello');

  const reply = fallbackChatReply(keeper, 'When is the next train?');
  assert.ok(reply.text.includes(railway.callingOrderFromHere[0]));
  assert.ok(reply.text.includes(railway.nextDepartures[0].at.replace(/^about /, '')));
  const opening = safeFallbackDialogue(keeper);
  assert.ok(opening.text.includes(railwayOpeningLine(railway)), opening.text);
  assert.doesNotMatch(safeFallbackDialogue(base).text, /Next train out/);
  // Questions that are not about the railway still get the ordinary answer.
  assert.equal(fallbackChatReply(keeper, 'What is your job?').text, fallbackChatReply(base, 'What is your job?').text);
}

if (process.env.SHOW_KEEPER_EXAMPLE) {
  console.log(JSON.stringify(examples[0].railway, null, 2));
  for (const q of ['When is the next train?', `How long to ${examples[0].railway.destinations[1].station}?`, 'Where does this line go?']) {
    console.log(`> ${q}\n  ${railwayFallbackReply(examples[0].railway, q).text}`);
  }
}
console.log(`railtimetable: ${examples.length} station keepers across ${seeds.length} seeds read the live timetable`);
