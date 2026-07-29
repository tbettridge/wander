import assert from 'node:assert/strict';
import { xrGrassPlan, xrGrassPlanLabel } from '../src/xrgrass.mjs';
import { xrProfileForName } from '../src/xrprofiles.mjs';

const painterly = xrProfileForName('painterly');
const full = xrGrassPlan(painterly, 1);
const recovery = xrGrassPlan(painterly, 0.62);

assert.equal(full.near.full, 34);
assert.equal(full.near.fade, 60);
assert.equal(full.mid.instances, 90000);
assert.equal(full.mid.near, 22);
assert.equal(full.mid.far, 118);
assert.equal(full.far.fade, 190);
assert.ok(full.mid.near < full.near.fade,
  'mid single quads must overlap the detailed near patch fade');
assert.ok(full.far.near < full.mid.far,
  'far terrain treatment must overlap the mid geometry fade');
assert.ok(recovery.mid.instances < full.mid.instances);
assert.ok(recovery.mid.far < full.mid.far);
assert.equal(recovery.near.full, full.near.full,
  'runtime pressure must preserve the fully grown near radius');
assert.ok(recovery.near.fade > recovery.mid.near,
  'recovery must retain a gap-free near/mid handoff');
assert.match(xrGrassPlanLabel(full), /90,000 blades/);

console.log('xrgrass PASS · protected near tufts · compact mid instances · geometry-free far overlap');
