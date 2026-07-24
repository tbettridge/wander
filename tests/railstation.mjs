import assert from 'node:assert/strict';
import {
  STATION_LAYOUT,
  stationCollisionModel,
  stationContains,
  stationFloorAt,
  stationConstrain,
} from '../src/railstation.mjs';

const P = STATION_LAYOUT;

// A station at the origin, track running along +Z (so across = +X).
const station = { id: 'station-1', index: 0, x: 0, z: 0, tangentX: 0, tangentZ: 1, formationY: 10 };
const m = stationCollisionModel(station);
assert.equal(m.rx, 1); assert.ok(Math.abs(m.rz) < 1e-9); // across == +X
assert.equal(m.platformY, 10 + P.platformTop);

const TERRAIN = 8;

// --- floor: platform surface on the platform, terrain off it ----------------
// Main platform centre (across = mainAcross, along = 0): full platform height.
assert.equal(
  stationFloorAt(m, P.mainAcross, 0, TERRAIN), m.platformY,
  'standing mid-platform should sit on the platform surface',
);
// Well off to the side: plain terrain.
assert.equal(stationFloorAt(m, 40, 0, TERRAIN), TERRAIN, 'off the platform is terrain');
// On the track centreline (between platforms): terrain, not platform.
assert.equal(stationFloorAt(m, 0, 0, TERRAIN), TERRAIN, 'the track itself is not a platform');
// Opposite platform is also walkable.
assert.equal(stationFloorAt(m, P.oppAcross, 0, TERRAIN), m.platformY);
// Ramp: at the very end the surface has fallen back toward terrain.
const endFloor = stationFloorAt(m, P.mainAcross, P.halfLength - 0.01, TERRAIN);
assert.ok(endFloor > TERRAIN && endFloor < m.platformY, `end ramp should be mid-height: ${endFloor}`);
// The floor helper never returns a non-finite value (would freeze the player).
for (const [x, z] of [[0, 0], [3.4, 5], [40, 40], [-3.3, -10]]) {
  assert.ok(Number.isFinite(stationFloorAt(m, x, z, TERRAIN)));
}

// --- collision: pushed out of the building, free elsewhere ------------------
// A point inside the building footprint is pushed to an edge and ends up out.
const inside = stationConstrain(m, P.building.across, 0, {});
assert.ok(inside, 'a point inside the building must be constrained');
const acrossAfter = inside.x; // track is along +Z so across == world X
const b = m.buildings[0];
assert.ok(
  acrossAfter <= b.c0 - P.playerRadius + 1e-6 || acrossAfter >= b.c1 + P.playerRadius - 1e-6,
  `pushed clear of the wall: ${acrossAfter} vs [${b.c0}, ${b.c1}]`,
);
// The platform in front of the building is walkable (not constrained).
assert.equal(stationConstrain(m, 2.2, 0, {}), null, 'the platform in front of the building is clear');
// Open ground is clear.
assert.equal(stationConstrain(m, 40, 40, {}), null);

// --- activation footprint ---------------------------------------------------
assert.ok(stationContains(m, P.mainAcross, 0));
assert.ok(stationContains(m, 0, P.halfLength - 2));
assert.ok(!stationContains(m, 0, 80), 'far down the line is outside the station');
assert.ok(!stationContains(m, 40, 0), 'far to the side is outside the station');

// --- an oriented station still resolves in world space ----------------------
const diag = { id: 's', index: 1, x: 100, z: -50, tangentX: 0.7071, tangentZ: 0.7071, formationY: 5 };
const dm = stationCollisionModel(diag);
// Building centre in world space, then constrain — must move to a wall edge.
const bx = dm.ox + dm.rx * dm.buildings[0].c0 + dm.rx * 0 /* along 0 */;
const wx = dm.ox + dm.rx * P.building.across;
const wz = dm.oz + dm.rz * P.building.across;
const moved = stationConstrain(dm, wx, wz, {});
assert.ok(moved, 'oriented building still constrains');
assert.ok(Math.hypot(moved.x - wx, moved.z - wz) > 0.5, 'and actually displaces the point');

console.log(`railstation PASS · platform ${P.platformTop}m · building ${P.building.half * 2}x${P.building.halfLength * 2}m · ramps ${P.endRamp}m`);
