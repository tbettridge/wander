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
  // +X is west: the renderer puts +X on the left of someone facing +Z (north).
  assert.equal(compassReadingFromDirection(-1, 0).point, 'E');
  assert.equal(compassReadingFromDirection(0, -1).point, 'S');
  assert.equal(compassReadingFromDirection(1, 0).point, 'W');
  assert.equal(compassReadingFromDirection(-1, 1).point, 'NE');
});

test('the compass agrees with the sky: the sun rises in the east and stands south at noon', async () => {
  const sky = await readFile(new URL('../src/sky.js', import.meta.url), 'utf8');
  // sky.js sets the sun direction from azim = time * 2PI + PI / 2 as (cos azim, *, sin azim).
  assert.match(sky, /const azim = this\.time \* Math\.PI \* 2 \+ Math\.PI \/ 2;/);
  assert.match(sky, /this\._sunDir\.set\(Math\.cos\(alt\) \* Math\.cos\(azim\), Math\.sin\(alt\), Math\.cos\(alt\) \* Math\.sin\(azim\)\)/);
  const sunAt = time => { const azim = time * Math.PI * 2 + Math.PI / 2; return compassReadingFromDirection(Math.cos(azim), Math.sin(azim)).point; };
  assert.equal(sunAt(0.25), 'E', 'sunrise');
  assert.equal(sunAt(0.5), 'S', 'noon');
  assert.equal(sunAt(0.75), 'W', 'sunset');
});

test('turning to your right turns the compass clockwise, as the renderer turns', () => {
  // A camera's right hand is forward x up = (-forward.z, forward.x) in x/z.
  for (const [x, z] of [[0, 1], [1, 0], [0.6, -0.8], [-0.3, 0.95]]) {
    const ahead = compassReadingFromDirection(x, z).heading, right = compassReadingFromDirection(-z, x).heading;
    assert.ok(Math.abs(((right - ahead) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI / 2) < 1e-9);
  }
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
  // The loop body is renderFrame(), which setAnimationLoop runs (guarded so a
  // failing frame cannot stop the loop).
  assert.match(main, /function renderFrame\(\)[\s\S]*compassReadingFromDirection/);
  assert.match(main, /renderer\.setAnimationLoop\([\s\S]*renderFrame\(\)/);
  assert.match(main, /compassNeedle\.style\.transform/);
  assert.match(main, /hudStatus\.innerHTML/);
});
