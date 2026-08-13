import test from 'node:test';
import assert from 'node:assert/strict';
import { groundSettlementNpc } from '../src/settlementnpcgrounding.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';

test('settlement NPC grounding uses a building plinth claim after horizontal movement', () => {
  const world = { seed: 1, height: () => 4 };
  const surface = new WalkableSurface(world);
  surface.debug = false;
  surface.registerClaim({
    id: 'house:floor', kind: 'floor', y: 5.25,
    contains: (x, z) => x >= 0 && x <= 2 && z >= 0 && z <= 2,
  });

  // This is the state produced when steering began on terrain and horizontal
  // collision then accepted a point on the foundation in the same frame.
  const position = { x: 0.1, y: 4, z: 1 };
  assert.equal(groundSettlementNpc(position, surface), 5.25);
  assert.equal(position.y, 5.25);
});

test('settlement NPC grounding returns to terrain outside a plinth', () => {
  const world = { seed: 1, height: () => 4 };
  const surface = new WalkableSurface(world);
  surface.debug = false;
  surface.registerClaim({
    id: 'house:floor', kind: 'floor', y: 5.25,
    contains: (x, z) => x >= 0 && x <= 2 && z >= 0 && z <= 2,
  });
  const position = { x: -0.1, y: 5.25, z: 1 };

  assert.equal(groundSettlementNpc(position, surface), 4);
  assert.equal(position.y, 4);
});
