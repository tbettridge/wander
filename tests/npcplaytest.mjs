import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYTEST_VIGNETTES, scoreParticipant, summarizePlaytest } from '../src/npcplaytest.mjs';

function response(id, correct, frequency = 'rare-noticeable') {
  return { participantId: id, frequency, answers: Object.fromEntries(PLAYTEST_VIGNETTES.map((v, index) => [v.id, { correct: index < correct }])) };
}

test('participant legibility requires five of seven scenes', () => {
  assert.equal(scoreParticipant(response('P1', 5)).legibilityPass, true);
  assert.equal(scoreParticipant(response('P2', 4)).legibilityPass, false);
});

test('five-person gate requires four legibility and four pressure passes', () => {
  const passing = summarizePlaytest([response('1', 5), response('2', 6), response('3', 7), response('4', 5), response('5', 3, 'intrusive')]);
  assert.equal(passing.gates.legibility, true);
  assert.equal(passing.gates.interactionPressure, true);
  const failing = summarizePlaytest([response('1', 4), response('2', 4), response('3', 5), response('4', 5), response('5', 5)]);
  assert.equal(failing.gates.legibility, false);
});
