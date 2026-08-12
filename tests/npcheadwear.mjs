import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bunKnotHeight,
  HAIR_SHELLS,
  HAT_RIM,
  NPC_SKULL_RADII,
  shellRadiiAt,
  shellTop,
  tuckedHairShell,
} from '../src/npcheadwear.mjs';
import { NPC_HAIR_STYLES, NPC_HAT_STYLES } from '../src/npcpopulation.mjs';

const HATS = Object.keys(HAT_RIM);

test('every hair style the generator can pick has a shell to draw', () => {
  for (const style of NPC_HAIR_STYLES) {
    if (style === 'none') continue;
    assert.ok(HAIR_SHELLS[style], `${style} has no shell`);
  }
  // A hood covers the head outright and draws no hair, so it needs no rim.
  for (const hat of NPC_HAT_STYLES) {
    if (hat === 'none' || hat === 'hood') continue;
    assert.ok(HAT_RIM[hat] !== undefined, `${hat} has no rim height`);
  }
});

test('hair is wider than the head, which is why a hat cannot simply be skull-sized', () => {
  for (const [style, shell] of Object.entries(HAIR_SHELLS)) {
    assert.ok(shell.radii[0] > NPC_SKULL_RADII[0],
      `${style} is narrower than the skull and would not read as hair`);
  }
});

test('a bare head keeps the hair it was authored with', () => {
  for (const style of Object.keys(HAIR_SHELLS)) {
    assert.equal(tuckedHairShell(style, 'none'), HAIR_SHELLS[style]);
    assert.equal(tuckedHairShell(style, undefined), HAIR_SHELLS[style]);
  }
  assert.equal(tuckedHairShell('bald', 'cap'), null);
});

test('no hair survives above a hat rim, for any hair under any hat', () => {
  for (const hat of HATS) {
    const rim = HAT_RIM[hat];
    for (const style of Object.keys(HAIR_SHELLS)) {
      const tucked = tuckedHairShell(style, hat);
      assert.ok(shellTop(tucked) <= rim + 1e-9,
        `${style} under a ${hat} reaches ${shellTop(tucked).toFixed(3)}, above the rim ${rim}`);
      // Nothing may exist above the rim at all: sampling proves the ellipsoid
      // really has ended rather than merely having its centre low enough.
      for (let y = rim + 0.005; y <= 0.5; y += 0.005) {
        assert.equal(shellRadiiAt(tucked, y), null,
          `${style} under a ${hat} still has width at y=${y.toFixed(3)}`);
      }
    }
  }
});

test('tucking takes the top off and leaves the hair you are meant to see', () => {
  for (const hat of HATS) {
    for (const [style, shell] of Object.entries(HAIR_SHELLS)) {
      const tucked = tuckedHairShell(style, hat);
      const bottom = (entry) => entry.centre[1] - entry.radii[1];
      assert.ok(Math.abs(bottom(tucked) - bottom(shell)) < 1e-9,
        `${style} under a ${hat} moved its underside`);
      // Width is untouched: the hair that emerges below the rim is as full as
      // it ever was, which is what stops a hatted resident looking shaven.
      assert.equal(tucked.radii[0], shell.radii[0]);
      assert.equal(tucked.radii[2], shell.radii[2]);
      assert.equal(tucked.centre[2], shell.centre[2]);
      assert.ok(tucked.radii[1] > 0);
    }
  }
});

test('hair still shows below every rim rather than vanishing under the hat', () => {
  for (const hat of HATS) {
    const rim = HAT_RIM[hat];
    for (const style of Object.keys(HAIR_SHELLS)) {
      const tucked = tuckedHairShell(style, hat);
      const widest = Math.max(...[...Array(40)].map((value, index) => {
        const radii = shellRadiiAt(tucked, rim - 0.005 - index * 0.005);
        return radii ? radii[0] : 0;
      }));
      assert.ok(widest > NPC_SKULL_RADII[0] * 0.85,
        `${style} under a ${hat} is only ${widest.toFixed(3)} wide below the rim`);
    }
  }
});

test('a bun rides high bare-headed and drops to the nape under a hat', () => {
  assert.equal(bunKnotHeight('none'), 0.22);
  assert.equal(bunKnotHeight(undefined), 0.22);
  for (const hat of HATS) {
    const knot = bunKnotHeight(hat);
    assert.ok(knot < HAT_RIM[hat], `a bun under a ${hat} sits at ${knot}, at or above the rim`);
    // The knot is a 0.11 sphere, so its own top has to clear the rim too.
    assert.ok(knot + 0.11 <= HAT_RIM[hat] + 0.005,
      `a bun knot under a ${hat} pushes through the crown`);
  }
});
