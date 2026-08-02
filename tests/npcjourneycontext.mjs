// What a traveller can say about its own journey.
//
// Asserted against real journeys over the real trail network, because the thing
// that matters is whether an NPC caught mid-walk has anything true to say — not
// whether a builder function returns the shape it was written to return.
//
// The failure being prevented: with no journey facts, "where are you headed?"
// has no answer, so the model invents one — and invents a different one two
// questions later, in the same conversation.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { buildNavGraph } from '../src/npcnavgraph.mjs';
import {
  advanceJourney, createJourneyState, JOURNEY_PURPOSES,
} from '../src/npcjourney.mjs';
import {
  describeJourney, describeLandmark, describeWalkingTime,
} from '../src/npcjourneycontext.mjs';

const world = new World(20260612);
clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, 20000, edges);
const graph = buildNavGraph(edges);
const home = [...graph.nodes.keys()].find((k) => graph.nodes.get(k).links.length >= 2);

// Stops PART WAY along, not after a fixed number of ticks: routes vary from a
// few hundred metres to several kilometres, so a fixed tick count arrives on the
// short ones and the traveller is no longer travelling when it is asked.
function walkingTraveller(seed = 4242, stopAfterMetres = 250) {
  const state = createJourneyState(seed, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  for (let i = 0; i < 200000; i++) {
    if (state.arrivals || state.coveredM >= stopAfterMetres) break;
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
  }
  return state;
}

// --- a traveller mid-walk can answer the obvious questions --------------------
{
  const state = walkingTraveller();
  const said = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  assert.ok(said, 'a traveller must have something to say about its journey');
  assert.equal(said.travelling, true);
  assert.ok(said.from && said.from.name, 'it knows where it set out from');
  assert.ok(said.to && said.to.name, 'and where it is going');
  assert.notEqual(said.from.key, said.to.key, 'and those are different places');
  assert.ok(JOURNEY_PURPOSES.includes(said.purpose),
    `the errand must be a real one, got ${said.purpose}`);
  assert.ok(said.remainingTimePhrase, 'and how much walking is left');
  assert.ok(said.headingDirection, 'and which way it is going');
}

// --- the errand is fixed for the journey, not re-rolled per question ----------
// An NPC that invents a fresh reason each time it is asked contradicts itself
// inside a single conversation.
{
  const state = walkingTraveller(77);
  const first = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  for (let i = 0; i < 200; i++) advanceJourney(state, { dt: 0.5, hours: 0, graph });
  const later = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  assert.equal(first.purpose, later.purpose, 'the reason for the walk does not change mid-walk');
  assert.equal(first.from.key, later.from.key, 'nor does where they came from');
  assert.equal(first.to.key, later.to.key, 'nor where they are going');
}

// --- no metre figures escape into the context --------------------------------
// Anything precise here is something the model will quote back, and nobody
// crossing country answers in metres.
{
  const state = walkingTraveller(9);
  const said = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  for (const key of ['coveredPhrase', 'remainingPhrase', 'remainingTimePhrase', 'walkedTimePhrase']) {
    const value = said[key];
    if (value === null) continue;
    assert.equal(typeof value, 'string', `${key} must be words, not a number`);
    assert.ok(!/\d{4,}/.test(value),
      `${key} leaked a precise figure: "${value}"`);
  }
}

// --- progress moves forward as they walk --------------------------------------
{
  const state = walkingTraveller(21, 120);
  const early = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  for (let i = 0; i < 3000 && !state.arrivals; i++) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
  }
  const late = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
  assert.ok(late.progressPercent >= early.progressPercent,
    'progress cannot go backwards while walking');
  assert.ok(late.progressPercent > 0, 'and it does move');
}

// --- a resident who has never travelled has no journey to describe ------------
// Better a null than an object of empty strings: the prompt keys off its
// absence to stop an NPC inventing a walk it is not on.
{
  const resting = createJourneyState(5, home);
  assert.equal(describeJourney(resting, { world, seed: world.seed, nodes: graph.nodes }), null,
    'someone who has never left has no journey');
  assert.equal(describeJourney(null, { world, seed: world.seed }), null,
    'and neither does a resident with no journey state at all');
}

// --- someone who has arrived still knows where they came from -----------------
{
  const state = createJourneyState(31, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  for (let i = 0; i < 200000 && !state.arrivals; i++) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
  }
  if (state.arrivals > 0) {
    const said = describeJourney(state, { world, seed: world.seed, nodes: graph.nodes });
    assert.ok(said, 'an arrival still has a journey to talk about');
    assert.equal(said.travelling, false, 'but is no longer walking it');
    assert.ok(said.from && said.from.name,
      'and can still say where they came from today');
  }
}

// --- landmarks get names, and unnamed country says so -------------------------
{
  const node = [...graph.nodes.values()].find((n) => Number.isFinite(n.x));
  const place = describeLandmark(world, world.seed, node.key, node.x, node.z);
  assert.ok(place.name && place.name.length > 2, 'a landmark is named');
  assert.ok(place.country, 'and sits in some country');
  assert.equal(describeLandmark(world, world.seed, 'x', undefined, undefined), null,
    'a node with no position cannot be described, and says null rather than guessing');
}

// --- walking time is spoken, not calculated ----------------------------------
{
  assert.equal(describeWalkingTime(100), 'less than half an hour');
  assert.ok(describeWalkingTime(50000).includes('day'), 'a long walk reads as days');
  const ordered = [200, 2000, 5000, 12000, 30000, 60000].map(describeWalkingTime);
  assert.equal(new Set(ordered).size > 3, true, 'distances map to varied phrasing');
}

console.log('npcjourneycontext PASS · a traveller knows where it came from, where it '
  + 'is going and why · the errand is stable for the whole journey · no metre '
  + 'figures escape · a resident who never left has no journey to invent');
