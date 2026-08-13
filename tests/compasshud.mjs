import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compassHeadingFromDirection,
  compassReading,
  compassReadingFromDirection,
  normalizeCompassHeading,
} from '../src/compasshud.mjs';

test('world directions map to the expected cardinal headings', () => {
  assert.deepEqual(compassReadingFromDirection(0, 1), { heading: 0, degrees: 0, point: 'N' });
  assert.equal(compassReadingFromDirection(1, 0).point, 'E');
  assert.equal(compassReadingFromDirection(0, -1).point, 'S');
  assert.equal(compassReadingFromDirection(-1, 0).point, 'W');
  assert.equal(compassReadingFromDirection(1, 1).point, 'NE');
});

test('headings wrap and report stable sixteen-point compass labels', () => {
  assert.equal(normalizeCompassHeading(-Math.PI / 2), Math.PI * 1.5);
  assert.equal(compassReading(Math.PI * 2).point, 'N');
  assert.equal(compassReading(Math.PI / 8).point, 'NNE');
  assert.equal(compassReading(Math.PI * 15 / 8).point, 'NNW');
});

test('invalid or vertical-only directions fail safely to north', () => {
  assert.equal(compassHeadingFromDirection(0, 0), 0);
  assert.equal(compassReadingFromDirection(Number.NaN, 1).point, 'N');
});

test('the top-left HUD owns a live compass updated by the existing render loop', async () => {
  const [html, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /#hud \{[\s\S]*top: 10px; left: 12px/);
  assert.match(html, /id="compass"[\s\S]*id="compass-needle"[\s\S]*id="compass-point"/);
  assert.match(main, /renderer\.setAnimationLoop\([\s\S]*compassReadingFromDirection/);
  assert.match(main, /compassNeedle\.style\.transform/);
  assert.match(main, /hudStatus\.innerHTML/);
});
