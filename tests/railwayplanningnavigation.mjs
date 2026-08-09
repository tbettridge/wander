import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resumeDesktopAfterFastTravel } from '../src/desktopfasttravel.mjs';

const calls = [];
assert.equal(resumeDesktopAfterFastTravel({
  active: false,
  locked: false,
  enterPlaying: () => calls.push('playing'),
  enterResuming: () => calls.push('resuming'),
  requestLock: () => calls.push('request'),
  onFailure: () => calls.push('failure'),
}), 'inactive');
assert.deepEqual(calls, []);

assert.equal(resumeDesktopAfterFastTravel({
  active: true,
  locked: true,
  enterPlaying: () => calls.push('playing'),
  enterResuming: () => calls.push('resuming'),
  requestLock: () => calls.push('request'),
  onFailure: () => calls.push('failure'),
}), 'playing');
assert.deepEqual(calls, ['playing']);

assert.equal(resumeDesktopAfterFastTravel({
  active: true,
  locked: false,
  enterPlaying: () => calls.push('playing'),
  enterResuming: () => calls.push('resuming'),
  requestLock: () => {
    calls.push('request');
    return Promise.resolve();
  },
  onFailure: () => calls.push('failure'),
}), 'requesting');
assert.deepEqual(calls, ['playing', 'resuming', 'request']);

const failure = new Error('pointer lock unavailable');
assert.equal(resumeDesktopAfterFastTravel({
  active: true,
  locked: false,
  enterPlaying: () => calls.push('playing'),
  enterResuming: () => calls.push('resuming-again'),
  requestLock: () => { throw failure; },
  onFailure: (error) => calls.push(error),
}), 'requesting');
assert.equal(calls.at(-2), 'resuming-again');
assert.equal(calls.at(-1), failure);

const planningSource = await readFile(new URL('../src/railwayplanning.js', import.meta.url), 'utf8');
assert.match(planningSource, /this\.onAfterTravel\?\.\(\{ label, station \}\)/,
  'debug station travel must synchronously hand control restoration to the host');

console.log('railwayplanningnavigation PASS · station travel restores pointer lock in its click gesture');
