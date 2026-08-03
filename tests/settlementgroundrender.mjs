import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SETTLEMENT_GROUND_SURFACE_OFFSET,
  settlementPathRibbon,
} from '../src/settlementground.mjs';

test('settlement path ribbons conform to terrain instead of spanning floating chords', () => {
  const world = { height: (x, z) => Math.sin(x * 0.45) * 1.8 + Math.cos(z * 0.3) * 0.4 };
  const ribbon = settlementPathRibbon(world, {
    width: 1.8,
    points: [{ x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 12 }],
  });
  const { positions, samples } = ribbon;

  assert.ok(samples.length > 25, 'long path segments were not terrain-sampled');
  for (let index = 0; index < positions.length; index += 3) {
    const expected = world.height(positions[index], positions[index + 2]) + SETTLEMENT_GROUND_SURFACE_OFFSET;
    assert.ok(Math.abs(positions[index + 1] - expected) < 1e-9,
      `path vertex ${index / 3} floats ${Math.abs(positions[index + 1] - expected).toFixed(4)}m from terrain`);
  }
  for (let index = 1; index < samples.length; index++) {
    const spacing = Math.hypot(samples[index].x - samples[index - 1].x, samples[index].z - samples[index - 1].z);
    assert.ok(spacing <= 1.26, `path has a ${spacing.toFixed(2)}m unsupported chord`);
  }
});

test('settlement renderer keeps ground overlays out of the shadow-caster batch', async () => {
  const source = await readFile(new URL('../src/settlementstream.js', import.meta.url), 'utf8');
  assert.match(source, /mesh\.castShadow = false; mesh\.receiveShadow = true/);
  assert.match(source, /child\.material\.uuid.*child\.castShadow.*child\.receiveShadow/);
  assert.match(source, /mesh\.castShadow = entry\.castShadow; mesh\.receiveShadow = entry\.receiveShadow/);
  assert.doesNotMatch(source, /mesh\.castShadow = true; mesh\.receiveShadow = true; mesh\.renderOrder = entry\.renderOrder/);
});
