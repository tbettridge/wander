import assert from 'node:assert/strict';
import { generateCaveGraph } from '../src/cavegen.mjs';
import { cavePortalInside, createCaveField } from '../src/cavefield.mjs';

const graph = generateCaveGraph(0x51deca7e);
const field = createCaveField(graph);
const mouth = field.entrance.b;

for (const hz of [10, 20, 60]) {
  let x = 0, z = mouth[2] - 1.25;
  let floor = field.floorHeight(x, z);
  let sawBlock = false;
  for (let frame = 0; frame < hz; frame++) {
    const targetX = x + 10.5 / hz;
    const result = field.resolveHorizontal(x, z, targetX, z, floor, { maxSubstep: 0.20 });
    x = result.x; z = result.z; floor = result.floorY;
    sawBlock ||= result.blocked;
    assert.ok(field.bodyFits(x, z, floor), `${hz}Hz resolver left the capsule outside the cave`);
  }
  assert.ok(sawBlock, `${hz}Hz sprint never contacted the wall`);
  assert.ok(x < field.entrance.rx, `${hz}Hz sprint tunnelled through the entrance wall (${x.toFixed(2)}m)`);
}

const slideZ = mouth[2] - 0.75;
const slideFloor = field.floorHeight(0, slideZ);
const slide = field.resolveHorizontal(0, slideZ, 10, slideZ + 5, slideFloor, { maxSubstep: 0.20 });
assert.ok(slide.blocked, 'oblique wall approach should make contact');
assert.ok(slide.z > slideZ + 3.0, 'oblique wall contact should retain tangential motion');
assert.ok(slide.x < field.entrance.rx, 'oblique wall slide escaped through the wall');
assert.ok(field.bodyFits(slide.x, slide.z, slide.floorY), 'wall slide ended without capsule clearance');

const mz = mouth[2];
let inside = false;
inside = cavePortalInside(inside, mz + 0.6, mz, true);
assert.equal(inside, false, 'portal entered before the inward hysteresis threshold');
inside = cavePortalInside(inside, mz + 1.3, mz, false);
assert.equal(inside, false, 'portal entered before entrance chunks were ready');
inside = cavePortalInside(inside, mz + 1.3, mz, true);
assert.equal(inside, true, 'portal did not enter after crossing a ready threshold');
inside = cavePortalInside(inside, mz, mz, true);
assert.equal(inside, true, 'portal flickered while inside the hysteresis band');
inside = cavePortalInside(inside, mz - 0.7, mz, true);
assert.equal(inside, false, 'portal did not return to the surface after crossing outward');

console.log(`cavecollision PASS · swept 10/20/60Hz · slide ${(slide.z - slideZ).toFixed(2)}m · hysteresis`);
