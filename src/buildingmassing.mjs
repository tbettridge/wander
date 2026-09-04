// What shape a building is, before anything decides what it is made of.
//
// Until now a building was one box with flags on it — a porch boolean, a
// chimney boolean — so every settlement was the same rectangle at forty
// different sizes. Variety has to come from the massing, not the trim: a church
// reads as a church because of a tower and a long nave, and no amount of
// window rhythm makes a box read as one.
//
// THE ONE RULE THAT SHAPES EVERYTHING HERE: the core is the interior.
//
// A building's core is a single rectangle, and it stays that way. It carries
// the rooms, the partitions, the working front door, the floor claim the player
// stands on and the wall segments they collide with — all of which assume one
// rectangle today and are correct in that assumption. Everything else attached
// here is SOLID: a wing, a tower, an apse. They change the silhouette and they
// stop you walking through them, but you do not go inside them.
//
// That is a deliberate trade. Carving real L-shaped interiors would mean
// reworking room subdivision, partition collision, floor claims and interior
// pathing together, and the reward would be invisible to a player who mostly
// sees these from the outside. The cost is that a building's interior is
// smaller than its exterior implies, which is a compromise the fidelity here
// comfortably absorbs.
//
// Local space matches buildingplan: +x is the width axis, +z is the depth axis,
// and the front door is at +z. Nothing solid may be attached across the front —
// the door approach and its path route through there.

const TAU = Math.PI * 2;

export const MASS_ROLE = Object.freeze({
  core: 'core',
  wing: 'wing',
  tower: 'tower',
  spire: 'spire',
  apse: 'apse',
  leanTo: 'lean-to',
  stair: 'stair',
});

// Roles that are solid enough to stop a walker. A spire sits on top of a tower
// and never meets the ground, so it is excluded rather than forgotten.
const COLLIDING_ROLES = new Set([MASS_ROLE.core, MASS_ROLE.wing, MASS_ROLE.tower, MASS_ROLE.apse, MASS_ROLE.leanTo]);

export function massCollides(mass) {
  return COLLIDING_ROLES.has(mass.role) && mass.baseY < 0.6;
}

function mass(role, { dx = 0, dz = 0, width, depth, height, baseY = 0, roof = null, taper = 0 }) {
  return Object.freeze({ role, dx, dz, width, depth, height, baseY, roof, taper });
}

function pick(rng, list) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/**
 * The bounding box of a whole building in its own local space.
 *
 * Spatial code — lot overlap, path routing, the ground apron — has to reason
 * about the shape a building actually occupies, not the core it is entered
 * through. Kept separate from width/depth precisely so the interior code that
 * relies on those keeps working untouched.
 *
 * ASYMMETRIC ON PURPOSE. Half-extents were tried first and are quietly wrong:
 * a wing on the back inflates |minZ|, and a symmetric box mirrors that onto the
 * front, swallowing the door approach and its path. The settlement soak caught
 * it as a lane crossing a structure. `halfWidth`/`halfDepth` remain for the
 * radius checks that genuinely want a conservative circle.
 */
export function massingFootprint(masses) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const item of masses) {
    if (item.role === MASS_ROLE.spire) continue;      // never reaches the ground
    minX = Math.min(minX, item.dx - item.width / 2);
    maxX = Math.max(maxX, item.dx + item.width / 2);
    minZ = Math.min(minZ, item.dz - item.depth / 2);
    maxZ = Math.max(maxZ, item.dz + item.depth / 2);
  }
  return {
    minX, maxX, minZ, maxZ,
    halfWidth: Math.max(Math.abs(minX), Math.abs(maxX)),
    halfDepth: Math.max(Math.abs(minZ), Math.abs(maxZ)),
  };
}

/**
 * Does this attachment sit clear of the doorway and the ground in front of it?
 *
 * Height matters as much as position: a platform canopy or a market roof
 * deliberately reaches out over the front, and at head height it shelters the
 * approach rather than blocking it. Only what stands on the ground can wall a
 * door up.
 */
function clearOfFront(item, coreDepth, doorHalfWidth) {
  if (item.baseY > 2.2) return true;                          // overhead, not underfoot
  const front = item.dz + item.depth / 2;
  if (front <= coreDepth / 2 + 0.01) return true;             // does not reach the front face
  return Math.abs(item.dx) - item.width / 2 > doorHalfWidth + 1.6;
}

/**
 * The masses a building is made of, core first.
 *
 * `style` is the village's own taste — see settlementplan. It biases how
 * elaborate the massing gets, so two villages built from the same programs
 * still look like different places rather than the same kit reshuffled.
 */
/**
 * How far a program's core stands clear of the ground.
 *
 * Almost everything is built on the earth. A granary is the exception, and the
 * gap of daylight under its floor is the entire reason it is recognisable at a
 * distance: staddle stones hold the store up so the damp and the rats cannot
 * reach it. Planning the stones without lifting the core, which is what
 * happened here, leaves four stumps standing INSIDE the building and a shed on
 * the ground wearing the data of a granary.
 */
const CORE_LIFT = Object.freeze({ granary: 0.95 });

export function planMasses({ program, width, depth, height, floorHeight, roof, rng, style = {}, doorWidth = 1.2 }) {
  const complexity = style.massingComplexity ?? 0.5;
  const lift = CORE_LIFT[program] || 0;
  const core = mass(MASS_ROLE.core, { width, depth, height, baseY: lift, roof });
  const extras = [];
  const add = (item) => {
    if (clearOfFront(item, depth, doorWidth / 2)) extras.push(item);
  };

  // A rear or side wing is what turns a rectangle into an L or a T. Sized off
  // the core so it reads as part of the same building rather than a shed that
  // happens to touch it.
  const wantsWing = rng() < 0.18 + complexity * 0.5
    && (program === 'dwelling' || program === 'inn' || program === 'hall'
      || program === 'school' || program === 'workshop');
  if (wantsWing) {
    const side = pick(rng, [-1, 1]);
    const along = rng() < 0.55;                              // side wing, else rear wing
    const wingWidth = width * (0.34 + rng() * 0.24);
    const wingDepth = depth * (0.42 + rng() * 0.3);
    const wingHeight = height * (rng() < 0.4 ? 1 : 0.66);
    add(along
      ? mass(MASS_ROLE.wing, {
        dx: side * (width / 2 + wingWidth / 2 - 0.4), dz: -depth * 0.12,
        width: wingWidth, depth: wingDepth, height: wingHeight,
        roof: { kind: roof.kind, pitch: roof.pitch * 0.9 },
      })
      : mass(MASS_ROLE.wing, {
        dx: side * width * 0.16, dz: -(depth / 2 + wingDepth / 2 - 0.4),
        width: wingWidth, depth: wingDepth, height: wingHeight,
        roof: { kind: roof.kind, pitch: roof.pitch * 0.9 },
      }));
  }

  if (program === 'inn') {
    // The stable range. An inn is the one house in a village that has to put up
    // other people's horses, so it always carries a lower range off the back —
    // which is also the thing that stops it reading as a large cottage.
    const rangeWidth = width * (0.52 + rng() * 0.2);
    const rangeDepth = depth * (0.4 + rng() * 0.22);
    add(mass(MASS_ROLE.leanTo, {
      dx: pick(rng, [-1, 1]) * width * 0.18,
      dz: -(depth / 2 + rangeDepth / 2 - 0.4),
      width: rangeWidth, depth: rangeDepth, height: height * 0.46,
      roof: { kind: roof.kind, pitch: roof.pitch * 0.8 },
    }));
  }

  if (program === 'church') {
    // The tower is the whole silhouette. Set at the end away from the door so
    // the nave is entered along its length rather than through the tower.
    const towerSide = width * 0.52;
    const towerHeight = height * (1.5 + rng() * 0.9);
    const towerZ = -(depth / 2 + towerSide / 2 - 0.5);
    add(mass(MASS_ROLE.tower, {
      dx: 0, dz: towerZ,
      width: towerSide, depth: towerSide, height: towerHeight,
      roof: null,
    }));
    // A broach spire: a pyramid that springs from the tower's parapet. Steep,
    // because a shallow one reads as a hat rather than a spire, and the whole
    // point of it is the line it draws against the sky from the next valley.
    // A squat tower keeps its parapet and goes without, so not every church in
    // the world is the same postcard.
    if (rng() < 0.62 + complexity * 0.25) {
      add(mass(MASS_ROLE.spire, {
        dx: 0, dz: towerZ,
        width: towerSide * 0.86, depth: towerSide * 0.86,
        height: towerHeight * (0.85 + rng() * 0.55),
        baseY: towerHeight + 0.5, taper: 1,
      }));
    }
    // A side chapel rather than an east end: the door is fixed at +z here, so
    // an apse opposite the tower would sit across the way in. Hung off the
    // flank toward the back, it breaks the nave's long wall — which is the
    // silhouette that was actually wanted.
    if (rng() < 0.5) {
      const chapelWidth = width * 0.42, chapelDepth = depth * 0.26;
      add(mass(MASS_ROLE.apse, {
        dx: pick(rng, [-1, 1]) * (width / 2 + chapelWidth / 2 - 0.4), dz: -depth * 0.22,
        width: chapelWidth, depth: chapelDepth, height: height * 0.62,
        roof: { kind: 'gable', pitch: roof.pitch * 0.85 },
      }));
    }
  }

  if (program === 'hall') {
    // A stair bay on the flank, not a portico on the front.
    //
    // A projecting porch over the door was tried first and is exactly what the
    // rule at the top of this file forbids: it inflates the footprint forward
    // across the door approach, and the settlement soak caught a lane running
    // through it. Nothing may be attached across the front, however far above
    // head height it is held, because the footprint that spatial code reasons
    // about is a box and a box has no idea you can walk under things.
    //
    // Hung off the flank it does the same civic work — a hall you enter through
    // something rather than straight off the street — and leaves the way in
    // clear. The tall single storey and the stone it is built of carry the rest.
    const bayWidth = Math.min(width * 0.26, 3.4);
    const bayDepth = Math.min(depth * 0.44, 4.2);
    add(mass(MASS_ROLE.wing, {
      dx: pick(rng, [-1, 1]) * (width / 2 + bayWidth / 2 - 0.35), dz: -depth * 0.06,
      width: bayWidth, depth: bayDepth, height: height * 1.12,
      roof: { kind: roof.kind, pitch: roof.pitch * 0.95 },
    }));
  }

  if (program === 'school' && rng() < 0.7) {
    // A bell cote, not a tower: a school is a hall with something small and
    // civic on the ridge.
    const coteSide = Math.min(1.5, width * 0.16);
    add(mass(MASS_ROLE.spire, {
      dx: 0, dz: -depth * 0.3, width: coteSide, depth: coteSide,
      height: 1.9 + rng() * 0.8, baseY: height + Math.max(1.3, width * roof.pitch * 0.34) * 0.6,
      taper: 0.35,
    }));
  }

  if (program === 'granary') {
    // Raised on staddle stones against the damp and the rats. The core is
    // lifted by CORE_LIFT above, so these are what it stands on rather than
    // four stumps hidden inside it.
    //
    // Six, not four: a mushroom-topped stone under the middle of each long side
    // is what a granary this size actually needed, and the pair of them stops
    // the underside reading as a table.
    const stump = 0.58;
    const insetX = width / 2 - 0.85, insetZ = depth / 2 - 0.85;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(mass(MASS_ROLE.stair, {
        dx: sx * insetX, dz: sz * insetZ,
        width: stump, depth: stump, height: lift, roof: null,
      }));
    }
    for (const sx of [-1, 1]) {
      add(mass(MASS_ROLE.stair, {
        dx: sx * insetX, dz: 0, width: stump * 0.9, depth: stump * 0.9, height: lift, roof: null,
      }));
    }
    // The step up to the door, which is now a stride off the ground.
    add(mass(MASS_ROLE.stair, {
      dx: 0, dz: depth / 2 + 0.42, width: Math.min(width * 0.5, 2.2), depth: 0.84,
      height: lift * 0.62, roof: null,
    }));
  }

  if ((program === 'smithy' || program === 'workshop' || program === 'barn') && rng() < 0.75) {
    const leanWidth = width * (0.4 + rng() * 0.26);
    const leanDepth = depth * 0.34;
    add(mass(MASS_ROLE.leanTo, {
      dx: pick(rng, [-1, 1]) * width * 0.2, dz: -(depth / 2 + leanDepth / 2 - 0.3),
      width: leanWidth, depth: leanDepth, height: height * 0.52,
      roof: { kind: 'gable', pitch: roof.pitch * 0.7 },
    }));
  }

  if (program === 'market-hall') {
    // An open hall is a big roof on posts with a small locked middle, and the
    // covered ground under the eaves is the entire point of it.
    //
    // This used to be a single slab 22% wider than the core, sitting at the top
    // of a fully walled box. Rendered, that is a cornice on a bungalow: there
    // was no covered floor, nothing was open, and the market read as a house.
    // The roof plate now oversails far enough to shelter ground the core does
    // not occupy, and stands on posts that reach it, so the space between them
    // is somewhere a market could actually happen.
    const oversail = 1.38;
    const plateY = height * 0.86;
    add(mass(MASS_ROLE.wing, {
      dx: 0, dz: 0, width: width * oversail, depth: depth * oversail,
      height: 0.36, baseY: plateY, roof: null,
    }));
    const postX = (width * oversail) / 2 - 0.55;
    const postZ = (depth * oversail) / 2 - 0.55;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(mass(MASS_ROLE.stair, {
        dx: sx * postX, dz: sz * postZ,
        width: 0.42, depth: 0.42, height: plateY, roof: null,
      }));
    }
  }

  if (program === 'station-house' && rng() < 0.85) {
    // The platform canopy. Held above head height and off to the track side so
    // it shelters without walling the approach in.
    //
    // It was a plate in the air: set back two thirds of its own depth clear of
    // the building, with nothing beneath it and nothing touching it. A canopy
    // is a roof carried on something, so it now reaches back far enough to meet
    // the building it belongs to and stands on posts at its outer edge.
    const canopyDepth = depth * 0.62;
    const canopyZ = -(depth / 2 + canopyDepth / 2 - 0.45);
    const canopyY = height * 0.74;
    add(mass(MASS_ROLE.wing, {
      dx: 0, dz: canopyZ, width: width * 0.94, depth: canopyDepth,
      height: 0.3, baseY: canopyY, roof: null,
    }));
    for (const sx of [-1, 1]) {
      add(mass(MASS_ROLE.stair, {
        dx: sx * (width * 0.94 / 2 - 0.5), dz: canopyZ - canopyDepth / 2 + 0.5,
        width: 0.34, depth: 0.34, height: canopyY, roof: null,
      }));
    }
  }

  const masses = [core, ...extras];
  return { masses, footprint: massingFootprint(masses) };
}

export function validateMasses(masses) {
  const errors = [];
  if (!masses?.length) return { valid: false, errors: ['no-masses'] };
  if (masses[0].role !== MASS_ROLE.core) errors.push('first-mass-not-core');
  if (masses.filter((item) => item.role === MASS_ROLE.core).length !== 1) errors.push('multiple-cores');
  for (const item of masses) {
    if (!(item.width > 0.2 && item.depth > 0.2 && item.height > 0.2)) errors.push(`degenerate-mass:${item.role}`);
    if (!Number.isFinite(item.dx) || !Number.isFinite(item.dz)) errors.push(`unplaced-mass:${item.role}`);
  }
  return { valid: errors.length === 0, errors };
}

export { TAU as MASSING_TAU };
