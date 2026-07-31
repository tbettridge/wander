import assert from 'node:assert/strict';
import {
  bearingBetween, compassFromBearing, describeDistance, findMentionedTarget,
} from '../src/livingworldcontext.mjs';

// --- distances are spoken, not measured --------------------------------------
// A character leaning on a fence does not say "two thousand seven hundred and
// forty metres". Everything here must round hard and read aloud.
for (const [metres, expected] of [
  [0, 'just over there'],
  [55, 'just over there'],
  [140, 'about one hundred metres'],
  [420, 'about four hundred metres'],
  [2900, 'about three kilometres'],
  [2740, 'about two and a half kilometres'],
  [2400, 'about two and a half kilometres'],
  [1000, 'about one kilometre'],
  [11600, 'about 12 kilometres'],
]) {
  assert.equal(describeDistance(metres), expected, `${metres}m should be said as "${expected}"`);
}
for (const bad of [NaN, undefined, -50]) {
  assert.equal(describeDistance(bad), 'just over there', 'a nonsense distance must not produce nonsense speech');
}
// No spoken distance may leak an exact figure.
for (let m = 0; m < 15000; m += 137) {
  const said = describeDistance(m);
  assert.ok(!new RegExp(`\\b${m}\\b`).test(said), `"${said}" gave away the exact ${m}m`);
}

// --- bearings, and the words for them ----------------------------------------
// +Z is north, matching the heading convention a resident turns by.
assert.ok(Math.abs(bearingBetween(0, 0, 0, 10) - 0) < 1e-9, 'due +Z is a bearing of zero');
assert.ok(Math.abs(bearingBetween(0, 0, 10, 0) - Math.PI / 2) < 1e-9, 'due +X is a quarter turn');
assert.equal(compassFromBearing(0), 'north');
assert.equal(compassFromBearing(Math.PI / 2), 'east');
assert.equal(compassFromBearing(Math.PI), 'south');
assert.equal(compassFromBearing(-Math.PI / 2), 'west');
assert.equal(compassFromBearing(Math.PI / 4), 'north-east');
assert.equal(compassFromBearing(Math.PI * 2), 'north', 'a wrapped bearing still reads as north');

// --- finding the place a line is talking about --------------------------------
const targets = [
  { id: 'a', name: 'the great tree', worldX: 100, worldZ: 0 },
  { id: 'b', name: 'the high cairn', worldX: 0, worldZ: 200 },
  { id: 'c', name: 'Harrow Mill', worldX: 5, worldZ: 5 },
];
assert.equal(
  findMentionedTarget(targets, 'The great tree is about three kilometres that way.')?.id, 'a',
  'a named landmark in a reply should be found',
);
assert.equal(
  findMentionedTarget(targets, 'the GREAT TREE is old')?.id, 'a',
  'matching ignores case',
);
assert.equal(
  findMentionedTarget(targets, 'A great tree stood here once')?.id, 'a',
  'the article is optional — residents do not quote their own context',
);
assert.equal(
  findMentionedTarget(targets, 'Harrow Mill is the next stop')?.id, 'c',
  'stations count as places too',
);
assert.equal(
  findMentionedTarget(targets, 'Nothing worth seeing for miles.'), null,
  'a line about nowhere points at nothing',
);
assert.equal(findMentionedTarget([], 'the great tree'), null, 'no targets, no match');
assert.equal(findMentionedTarget(targets, ''), null, 'no text, no match');
// The longest name wins, so a short name inside a longer one cannot steal it.
{
  const overlapping = [
    { id: 'short', name: 'the tree' },
    { id: 'long', name: 'the great tree' },
  ];
  assert.equal(
    findMentionedTarget(overlapping, 'the great tree is that way')?.id, 'long',
    'the most specific name must win',
  );
}

console.log('livingworldcontext PASS · distances are rounded and spoken · never exact · '
  + 'bearings match the heading convention · a named place is found in a reply');
