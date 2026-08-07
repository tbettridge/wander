// Getting on a horse, and what the horse does about it.
//
// The riding logic is deliberately free of Three.js so the parts that decide
// behaviour — what can be mounted, where the rider sits, and what the reins are
// asking for — can be asserted without a renderer.

import assert from 'node:assert/strict';
import {
  EYE_ABOVE_SEAT, HorseRiding, JOSTLE_GALLOP, JOSTLE_WALK, MOUNT_REACH,
  nearestMount, riderIntent, saddleJostle, seatPose,
} from '../src/horseriding.mjs';
import {
  RIDDEN_GALLOP_SPEED, RIDDEN_TROT_SPEED, RIDING_SPEEDUP, SPRINT_SPEED, WALK_SPEED,
} from '../src/pace.mjs';

const agent = (id, x, z, { tame = true, speed = 0 } = {}) => ({
  id, recipe: { tame }, speed, heading: 0,
  mesh: { position: { x, y: 0, z }, parent: {} },
  setRider(input) { this.rider = input; },
  setState() {},
  rememberBehaviour() {},
});

// --- what can be mounted -------------------------------------------------------
{
  const here = { x: 0, z: 0 };
  assert.equal(nearestMount([agent('far', 40, 0)], here), null, 'out of reach');
  assert.equal(nearestMount([agent('wild', 1, 0, { tame: false })], here), null,
    'only a tame animal offers a leg up');
  assert.equal(nearestMount([agent('bolting', 1, 0, { speed: 3 })], here), null,
    'a horse already moving off is not standing to be mounted');
  const near = agent('near', 1.2, 0);
  const further = agent('further', 3.0, 0);
  assert.equal(nearestMount([further, near], here)?.id, 'near', 'nearest wins');
  assert.ok(nearestMount([agent('edge', MOUNT_REACH - 0.1, 0)], here), 'inside the reach');
  assert.equal(nearestMount([agent('edge', MOUNT_REACH + 0.1, 0)], here), null, 'outside it');
}

// --- no reverse, ever -----------------------------------------------------------
// The whole point of the control scheme: a horse under saddle does not walk
// backwards on request, and the gait solver has no backward walk to play.
{
  assert.equal(riderIntent({ backKey: true }).forward, 0, 'the back key asks for nothing');
  assert.equal(riderIntent({ stickY: 1 }).forward, 0, 'pulling the stick back asks for nothing');
  assert.ok(riderIntent({ forwardKey: true }).forward > 0.9, 'forward key drives');
  assert.ok(riderIntent({ stickY: -1 }).forward > 0.9, 'stick forward drives');
  // Partial stick is a partial ask, so a horse can be walked as well as ridden on.
  const half = riderIntent({ stickY: -0.5 }).forward;
  assert.ok(half > 0.4 && half < 0.6, `half stick should be a half ask, got ${half}`);
  // Steering is independent of drive: you can rein a standing horse round.
  assert.ok(riderIntent({ leftKey: true }).steer > 0.9);
  assert.ok(riderIntent({ rightKey: true }).steer < -0.9);
  assert.equal(riderIntent({ leftKey: true, rightKey: true }).steer, 0, 'both cancel');
  assert.ok(riderIntent({ stickX: 1 }).steer < -0.9, 'stick right steers right');
}

// --- a horse is worth getting on --------------------------------------------------
// The whole justification for the animal: every ridden pace beats doing it on
// your own legs, and by the same margin, so the sprint key keeps its meaning.
{
  assert.ok(RIDDEN_TROT_SPEED > WALK_SPEED,
    'riding at a walk must beat walking, or why mount');
  assert.ok(RIDDEN_GALLOP_SPEED > SPRINT_SPEED,
    'galloping must beat sprinting on foot');
  assert.equal(+(RIDDEN_TROT_SPEED / WALK_SPEED).toFixed(4), RIDING_SPEEDUP);
  assert.equal(+(RIDDEN_GALLOP_SPEED / SPRINT_SPEED).toFixed(4), RIDING_SPEEDUP);

  // The sprint key raises the ceiling the horse is allowed to reach.
  assert.equal(riderIntent({ forwardKey: true }).topSpeed, RIDDEN_TROT_SPEED);
  assert.equal(riderIntent({ forwardKey: true, sprintKey: true }).topSpeed, RIDDEN_GALLOP_SPEED);
  assert.equal(riderIntent({ forwardKey: true, sprintKey: true }).sprint, true);
  // But it is a ceiling, not a throttle: asking to gallop while asking the
  // horse for nothing must not set it off.
  assert.equal(riderIntent({ sprintKey: true }).forward, 0);
  assert.equal(riderIntent({ sprintKey: true }).sprint, false);
  // And it never smuggles in a reverse.
  assert.equal(riderIntent({ sprintKey: true, backKey: true }).forward, 0);
}

// --- the saddle is never still -----------------------------------------------------
{
  const sample = (cycles, speed) => saddleJostle(cycles, speed);
  // A standing horse does not bounce the view.
  assert.deepEqual(sample(3.2, 0), { lift: 0, lateral: 0, surge: 0 });
  const peak = (speed, terms = 400) => {
    let most = 0;
    for (let i = 0; i < terms; i++) most = Math.max(most, Math.abs(sample(i * 0.037, speed).lift));
    return most;
  };
  const walk = peak(RIDDEN_TROT_SPEED * 0.4);
  const trot = peak(RIDDEN_TROT_SPEED);
  const gallop = peak(RIDDEN_GALLOP_SPEED);
  assert.ok(walk < trot && trot < gallop, `throw must grow with pace (${walk}/${trot}/${gallop})`);
  assert.ok(walk < 0.03, `a walk should barely register, got ${walk.toFixed(3)}m`);
  assert.ok(gallop > 0.05 && gallop < JOSTLE_GALLOP * 1.7,
    `a gallop should be felt but not throw the camera, got ${gallop.toFixed(3)}m`);
  assert.ok(JOSTLE_WALK < JOSTLE_GALLOP);

  // Irregular: no two consecutive strides land identically, so it never reads
  // as a loop. Compare the same point of the cycle across successive strides.
  const atStride = (n) => sample(n, RIDDEN_GALLOP_SPEED).lift;
  const a = atStride(10), b = atStride(11), c = atStride(12);
  assert.ok(Math.abs(a - b) > 1e-4 && Math.abs(b - c) > 1e-4,
    'the bounce repeats stride for stride — that reads as a rumble, not a horse');

  // Deterministic, so a replayed ride is identical and this stays testable.
  assert.equal(sample(7.3, 6).lift, sample(7.3, 6).lift);

  // Comfort scale is authoritative: zero means zero.
  assert.deepEqual(saddleJostle(4.4, RIDDEN_GALLOP_SPEED, 0), { lift: 0, lateral: 0, surge: 0 });
  const halved = saddleJostle(4.4, RIDDEN_GALLOP_SPEED, 0.5).lift;
  const full = saddleJostle(4.4, RIDDEN_GALLOP_SPEED, 1).lift;
  assert.ok(Math.abs(halved * 2 - full) < 1e-9, 'scale must be linear');
}

// --- the seat -------------------------------------------------------------------
{
  const horse = agent('h', 10, -4);
  horse.heading = 0;
  const shoulder = 1.6;
  const seat = seatPose(horse, shoulder);
  // Above the withers by most of the animal's height plus the rider's own.
  assert.ok(seat.y > horse.mesh.position.y + shoulder,
    'the rider sits above the horse, not inside it');
  assert.ok(seat.y < horse.mesh.position.y + shoulder + EYE_ABOVE_SEAT + 0.6,
    'and not floating above it');
  // Set BACK from the centre along the facing, so the neck is ahead of the eye
  // and shows at the bottom of frame.
  assert.ok(seat.z < horse.mesh.position.z, 'seat sits behind the withers');
  // Scales with the animal: a foal carries the rider lower than a full horse.
  assert.ok(seatPose(horse, 1.0).y < seat.y, 'a smaller animal seats lower');
}

// --- mounting takes the controls, dismounting gives them back ---------------------
{
  const controls = {
    inputLocked: false, allowLook: false, placed: null, at: null,
    setInputLocked(v) { this.inputLocked = v; },
    place(x, z) { this.placed = { x, z }; },
    placeAt(x, y, z) { this.at = { x, y, z }; },
  };
  const riding = new HorseRiding(controls);
  const horse = agent('h', 1, 0);
  horse.dimensions = { shoulderY: 1.6 };

  assert.equal(riding.riding, false);
  assert.equal(riding.tryMount([horse], { x: 0, z: 0 }), true);
  assert.equal(riding.riding, true);
  // Movement off, look on — a rider steers the horse but still looks around.
  assert.equal(controls.inputLocked, true, 'walking is switched off while mounted');
  assert.equal(controls.allowLook, true, 'but mouselook stays free');
  assert.ok(horse.rider, 'the horse knows it is being ridden');

  riding.drive({ forwardKey: true });
  assert.ok(horse.rider.forward > 0.9);
  riding.carry();
  assert.ok(controls.at && controls.at.y > 1.6, 'the camera was placed in the saddle');
  // Standing still, the seat is exactly the seat.
  const settled = controls.at.y;
  horse.gaitClock = 5.25;
  riding.carry(1 / 60);
  assert.equal(controls.at.y, settled, 'a halted horse must not bounce the view');
  // Under way, it is not.
  horse.speed = RIDDEN_GALLOP_SPEED;
  riding.carry(1 / 60);
  assert.ok(Math.abs(controls.at.y - settled) > 1e-3, 'a galloping horse throws the rider about');
  assert.ok(Math.abs(controls.at.y - settled) < 0.2, 'but not that far');

  assert.equal(riding.dismount(), true);
  assert.equal(controls.inputLocked, false, 'walking comes back');
  assert.equal(horse.rider, null, 'and the horse has itself back');
  assert.ok(controls.placed, 'the rider is set down on the ground');
  const offset = Math.hypot(controls.placed.x - horse.mesh.position.x,
    controls.placed.z - horse.mesh.position.z);
  assert.ok(offset > 1, `dismount beside the horse, not inside it (${offset.toFixed(2)}m)`);
}

// --- a mount that streams away does not strand the rider ---------------------------
{
  const controls = {
    inputLocked: false, allowLook: false,
    setInputLocked(v) { this.inputLocked = v; },
    place() {}, placeAt() {},
  };
  const riding = new HorseRiding(controls);
  const horse = agent('h', 1, 0);
  riding.tryMount([horse], { x: 0, z: 0 });
  horse.mesh.parent = null;              // despawned out from under the player
  riding.drive({ forwardKey: true });
  assert.equal(riding.riding, false, 'losing the mount dismounts rather than riding a ghost');
  assert.equal(controls.inputLocked, false, 'and hands the controls back');
}

console.log('horse riding ok');
