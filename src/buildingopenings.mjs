// What kind of hole a building puts in its wall.
//
// There were two: a lancet, for a church, and a domestic sash for absolutely
// everything else — 1.28 by 1.38, sill at 0.86, repeated at the village's window
// rhythm. A barn got one of them and a granary four, so a grain store and a
// cottage said the same thing with their walls, and the only signal a player had
// left was size.
//
// That is a large loss for a small saving. Openings are the second thing read
// after silhouette and the first thing read up close, and they are the most
// honest signal a building has: a wall tells you what happens behind it because
// people cut holes where the work needed light and left it solid where it did
// not. A forge wants one wide dark mouth at working height. A granary wants
// slits too narrow for a rat and too high for damp. A schoolroom wants as much
// glass as the wall will carry.
//
// So: one vocabulary entry per program, and a shape that says what it is for.
//
// Renderer-independent on purpose. This computes rectangles in the building's
// own local frame; settlementstream cuts them out of walls and hangs frames in
// the glazed ones, and the Node suite audits the vocabulary without a renderer.

/**
 * Where the exposed frame posts stand on a wall.
 *
 * Corners, and a pair at the door jambs. There used to be one at x = 0, which
 * is where the front door is on every building in the world, so every
 * timber-framed house, barn and inn in every village carried a post running
 * floor to eaves straight across its own doorway. Posts flanking an opening is
 * also what a real frame does, because that is where the load around the
 * opening has to travel.
 *
 * Pure, and here rather than in the renderer, so the suite can assert that no
 * post ever lands on a way in again.
 */
export function planFramePosts(building, span) {
  const door = (building.portals || []).find((portal) => portal.kind === 'exterior-door');
  const posts = [-span / 2 + 0.12, span / 2 - 0.12];
  if (door) posts.push(door.x - door.width / 2 - 0.19, door.x + door.width / 2 + 0.19);
  else posts.push(0);
  return posts.filter((x) => Math.abs(x) <= span / 2 - 0.05).sort((a, b) => a - b);
}

/** Half-width of a frame post, so callers can reason about what it covers. */
export const FRAME_POST_HALF_WIDTH = 0.09;

/** How a program lights and vents itself. */
export const OPENING_KIND = Object.freeze({
  domestic: 'domestic',   // a sash you could stand at
  tall: 'tall',           // a civic room's window, floor-to-near-ceiling
  lancet: 'lancet',       // narrow, high, set well above the eye
  slit: 'slit',           // ventilation, not light
  shuttered: 'shuttered', // a real opening with boards to close it
  working: 'working',     // a wide unglazed mouth at working height
  none: 'none',
});

/**
 * The vocabulary, keyed by program.
 *
 * `spacing` is how far apart openings sit along a wall. `sill` is measured from
 * that floor's level. `glazed` decides whether settlementstream hangs a frame in
 * it — a forge mouth and a vent slit are holes, not windows, and framing them
 * is what made every building read as a house.
 *
 * `ground` overrides the spec on the ground floor only, which is where a
 * workshop and a smithy differ from the storey of living space above them.
 */
export const OPENINGS_BY_PROGRAM = Object.freeze({
  dwelling: Object.freeze({
    kind: OPENING_KIND.domestic, width: 1.28, height: 1.38, sill: 0.86, glazed: true,
  }),
  inn: Object.freeze({
    // Taller and a little narrower than a cottage's, at the village's own
    // rhythm: an inn is lit like a large house because that is what it is, and
    // its extra windows come from being wider rather than from a denser wall.
    kind: OPENING_KIND.domestic, width: 1.22, height: 1.44, sill: 0.82, glazed: true,
  }),
  'station-house': Object.freeze({
    kind: OPENING_KIND.domestic, width: 1.24, height: 1.42, sill: 0.88, glazed: true,
  }),
  hall: Object.freeze({
    // One tall room wants tall windows. Domestic sashes in a four-metre wall
    // leave two metres of blank render above them and read as a house that grew.
    kind: OPENING_KIND.tall, width: 1.32, height: 2.45, sill: 1.05, glazed: true, spacing: 3.1,
  }),
  school: Object.freeze({
    // A schoolroom is a wall of glass on the long side, because that is what a
    // room full of children reading needs and what schools are remembered for.
    kind: OPENING_KIND.tall, width: 1.78, height: 1.95, sill: 1.02, glazed: true, spacing: 2.5,
  }),
  church: Object.freeze({
    kind: OPENING_KIND.lancet, width: 0.86, glazed: true, spacing: 3.4,
    // Proportions of the wall rather than fixed metres: a lancet is a lancet at
    // any nave height.
    sillFraction: 0.34, heightFraction: 0.44,
  }),
  'market-hall': Object.freeze({
    // The ground floor is an arcade and needs no windows at all; the loft above
    // it takes light high up where the goods are not.
    kind: OPENING_KIND.slit, width: 0.62, height: 0.78, sill: 1.9, glazed: false, spacing: 2.8,
  }),
  granary: Object.freeze({
    // Narrow enough to keep a rat out and high enough to keep the damp off the
    // grain. The single most recognisable thing about a granary wall.
    kind: OPENING_KIND.slit, width: 0.34, height: 0.92, sill: 1.35, glazed: false, spacing: 1.5,
  }),
  barn: Object.freeze({
    // Openings you could pitch a bale through, with boards to close them.
    //
    // These were vent gaps, 0.42 by 0.55 up under the eaves, on the reasoning
    // that a barn is lit by its doors. On a wall four and a half metres tall
    // they render as four specks and read as an oversight rather than a
    // decision. A barn window is a real hole with real shutters: big enough to
    // work through, unglazed because nobody glazes a barn, and shuttered
    // because the weather has to be kept off the crop.
    kind: OPENING_KIND.shuttered, width: 1.05, height: 1.25, sill: 1.5,
    glazed: false, shutters: true, spacing: 2.9,
  }),
  smithy: Object.freeze({
    kind: OPENING_KIND.working, width: 2.4, height: 1.75, sill: 0.55, glazed: false, spacing: 5.5,
  }),
  workshop: Object.freeze({
    // A wide working mouth at street level, ordinary windows over it where
    // somebody lives.
    kind: OPENING_KIND.domestic, width: 1.26, height: 1.4, sill: 0.86, glazed: true,
    ground: Object.freeze({
      kind: OPENING_KIND.working, width: 2.1, height: 1.85, sill: 0.5, glazed: false, spacing: 4.6,
    }),
  }),
});

const DEFAULT_SPEC = OPENINGS_BY_PROGRAM.dwelling;

/** The spec a program uses on a given floor. */
export function openingSpecFor(program, floor = 0) {
  const spec = OPENINGS_BY_PROGRAM[program] || DEFAULT_SPEC;
  return floor === 0 && spec.ground ? spec.ground : spec;
}

/**
 * The openings along one wall of `span` metres.
 *
 * `span` is passed rather than read off the building because a church's nave
 * takes its lancets along the DEPTH axis: the long wall is the one worth
 * puncturing, and it is not the one `width` names.
 */
export function planOpenings(building, span) {
  const height = building.floorCount * building.floorHeight;
  const openings = [];
  const rhythm = building.style?.windowRhythm || 2.2;

  for (let floor = 0; floor < building.floorCount; floor++) {
    const spec = openingSpecFor(building.program, floor);
    if (spec.kind === OPENING_KIND.none) continue;
    // A lancet is sized from the wall it pierces; everything else is sized in
    // metres, because a window is a window whatever it is set into.
    const openingHeight = spec.heightFraction ? height * spec.heightFraction : spec.height;
    const sill = spec.sillFraction ? height * spec.sillFraction : floor * building.floorHeight + spec.sill;
    const spacing = spec.spacing || rhythm;
    // A forge has one mouth, not a rhythm of them.
    const single = spec.kind === OPENING_KIND.working;
    const count = single
      ? Math.max(1, Math.min(2, Math.floor(span / spacing)))
      : Math.max(2, Math.floor(span / spacing));
    for (let index = 0; index < count; index++) {
      // A lone working mouth sits to one side. Centred, it lands exactly where
      // the door is and gets dropped, which is why every smithy came out blank.
      const x = count === 1 && single
        ? -span / 4
        : -span / 2 + (index + 0.5) * (span / count);
      openings.push({
        x, bottom: sill, width: spec.width, height: openingHeight,
        glazed: spec.glazed !== false, shutters: spec.shutters === true,
        kind: spec.kind,
      });
    }
    // Nothing here removes an opening that lands on the front door. The mesh
    // already does that against the door's real width and head height, and
    // doing it twice — once here against a guessed half-metre — is what cost
    // the church its middle lancet, which sits well above any doorway.
    // A lancet band is drawn once for the whole wall, not once per storey: a
    // nave is one volume however many notional floors it is counted as.
    if (spec.sillFraction) break;
  }
  return openings;
}
