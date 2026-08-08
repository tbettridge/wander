// Where a village puts its buildings, once it has somewhere to put them around.
//
// The radial placer this replaces spreads lots evenly over a disc. That is the
// right answer for scattered homesteads and the wrong one for a village: no
// matter how tightly it is packed, evenly-distributed points read as a field of
// houses rather than a place. Tightening the disc made them closer together
// without making them a village, which is what said the problem was the layout
// and not the spacing.
//
// So a station settlement is laid out the way one grows: a square in the
// middle, streets leaving it, and buildings standing along those streets with
// their doors to the road. The civic buildings take the square frontage,
// because the roster puts them first and the square lots are offered first.
//
// Two things this owes the rest of the system:
//
//   * A lot is a POSITION AND A FACING. The yaw matters as much as the spot —
//     a building's door is at local +z, so a lot whose yaw is wrong is a house
//     that opens onto a wall or turns its back on the street it stands on.
//   * The square must stay empty. It is the one piece of ground the layout
//     exists to protect, and every lot is placed outside it by construction.
//
// THREE-free: the layout is asserted in Node without a renderer.

const TAU = Math.PI * 2;

// `lotSpacing` is deliberately tighter than a building is wide. Holding a lot's
// facing to its street costs the terrain fitter the four quarter-turns it used
// to try, so a lot on awkward ground is now simply refused — and the layout has
// to offer enough of them that being refused is survivable. Overlapping lots
// are not a problem: the first building to take one pushes its neighbours off
// the ones it covers.
export const LAYOUT_SPEC = Object.freeze({
  'station-village': Object.freeze({
    squareRadius: 26, streets: 5, streetWidth: 6.5, lotSetback: 9,
    lotSpacing: 9, lotDepth: 13, reach: 124,
  }),
  'station-halt': Object.freeze({
    squareRadius: 17, streets: 4, streetWidth: 5.5, lotSetback: 8,
    lotSpacing: 8.5, lotDepth: 12, reach: 86,
  }),
});

export function layoutSpecFor(kind) {
  return LAYOUT_SPEC[kind] || null;
}

/**
 * The facing that puts a building's door toward `(tx, tz)`.
 *
 * A building's front is its local +z, and buildingWorldPoint maps local +z onto
 * the world direction (sin yaw, cos yaw). So facing a point means solving that
 * for the direction to it — not, as looks natural, atan2(dz, dx).
 */
export function facingToward(x, z, tx, tz) {
  return Math.atan2(tx - x, tz - z);
}

/**
 * A village's streets and the lots along them, best frontage first.
 *
 * Lots are returned in the order they should be offered: the square first, so
 * the civic buildings at the head of the program roster take the frontage, then
 * the streets working outward from the middle, so a village that runs out of
 * buildable ground thins at its edges rather than in its centre.
 */
export function planSettlementLayout(site, spec, origin = null) {
  // The main street runs to whatever the village is FOR — the ford, the stones,
  // the summit — not to whichever compass bearing the site happened to be given.
  // That is the whole visible payoff of a founding reason: walk the main street
  // of a place and it takes you to the thing that put it there.
  //
  // `origin.bearing` is already in this project's (sin, cos) convention, which
  // is what the street angles below are measured in.
  const foundingAngle = Number.isFinite(origin?.bearing) ? origin.bearing : site.yaw;
  const squareRadius = spec.squareRadius;
  // The square drifts toward the reason, so it sits between the village and the
  // thing it grew around rather than dead centre of an abstract disc. Bounded
  // hard: past a third of its own radius the lots start falling off the far side
  // of the built area.
  const pull = origin && origin.distance > squareRadius
    ? Math.min(0.35, origin.strength * 0.35) * squareRadius : 0;
  const square = {
    id: `${site.id}:square`,
    x: site.x + Math.cos(foundingAngle) * pull,
    z: site.z + Math.sin(foundingAngle) * pull,
    radius: squareRadius, yaw: site.yaw,
  };

  // Streets fan out from the founding axis. Where the village has a station on
  // a different bearing, the approach from it is kept as a street of its own —
  // a railway village's two axes coincide anyway, which is exactly how a place
  // the line invented should read.
  const angles = [foundingAngle];
  const stationAngle = site.yaw;
  const apart = Math.abs(Math.atan2(
    Math.sin(stationAngle - foundingAngle), Math.cos(stationAngle - foundingAngle),
  ));
  if (site.isStationSettlement && apart > 0.55) angles.push(stationAngle);
  for (let i = 1; angles.length < spec.streets; i++) {
    angles.push(foundingAngle + (i / spec.streets) * TAU);
  }

  const streets = [];
  for (let i = 0; i < spec.streets; i++) {
    const angle = angles[i];
    streets.push({
      id: `${site.id}:street:${i}`,
      angle,
      width: i === 0 ? spec.streetWidth : spec.streetWidth * 0.82,
      // The carriageway itself, from the square's edge outward. Measured from
      // the SQUARE, not the site: the square is the middle of the village, and
      // once it drifts toward the founding reason, streets struck from the site
      // no longer meet it.
      fromX: square.x + Math.cos(angle) * squareRadius,
      fromZ: square.z + Math.sin(angle) * squareRadius,
      toX: square.x + Math.cos(angle) * spec.reach,
      toZ: square.z + Math.sin(angle) * spec.reach,
    });
  }

  const lots = [];

  // --- frontage on the square -------------------------------------------------
  // Set back far enough that a door opens onto the square rather than into it,
  // and spaced by arc so a bigger square carries more frontage.
  const frontRadius = squareRadius + spec.lotSetback + spec.lotDepth / 2;
  const frontCount = Math.max(4, Math.round((TAU * frontRadius) / (spec.lotSpacing * 1.5)));
  for (let i = 0; i < frontCount; i++) {
    // Offset by half a step from the street angles so a square lot never sits
    // in the mouth of a street.
    const angle = foundingAngle + ((i + 0.5) / frontCount) * TAU;
    const x = square.x + Math.cos(angle) * frontRadius;
    const z = square.z + Math.sin(angle) * frontRadius;
    lots.push({
      id: `${site.id}:lot:square:${i}`, kind: 'square-front',
      x, z, yaw: facingToward(x, z, square.x, square.z),
      distance: frontRadius,
    });
  }

  // --- frontage along the streets ---------------------------------------------
  // Both sides, working outward. The offset is measured from the carriageway
  // edge, so widening a street pushes its houses back rather than burying them.
  for (let s = 0; s < streets.length; s++) {
    const street = streets[s];
    const dirX = Math.cos(street.angle), dirZ = Math.sin(street.angle);
    const normX = -dirZ, normZ = dirX;
    const offset = street.width / 2 + spec.lotSetback * 0.5 + spec.lotDepth / 2;
    const first = squareRadius + spec.lotSetback + spec.lotSpacing * 0.5;
    for (let distance = first; distance <= spec.reach; distance += spec.lotSpacing) {
      for (const side of [-1, 1]) {
        const x = square.x + dirX * distance + normX * side * offset;
        const z = square.z + dirZ * distance + normZ * side * offset;
        // Face the middle of the road it stands on, not the village centre.
        const roadX = square.x + dirX * distance, roadZ = square.z + dirZ * distance;
        lots.push({
          id: `${site.id}:lot:street:${s}:${Math.round(distance)}:${side > 0 ? 'r' : 'l'}`,
          kind: 'street-front', street: s, side,
          x, z, yaw: facingToward(x, z, roadX, roadZ),
          distance,
        });
      }
    }
  }

  // Square frontage first, then streets nearest the middle outward.
  lots.sort((a, b) => {
    if ((a.kind === 'square-front') !== (b.kind === 'square-front')) return a.kind === 'square-front' ? -1 : 1;
    return a.distance - b.distance || a.id.localeCompare(b.id);
  });

  return { square, streets, lots };
}

/** Is this point inside the square that must stay open? */
export function insideSquare(square, x, z, padding = 0) {
  return Math.hypot(x - square.x, z - square.z) < square.radius + padding;
}

export { TAU as LAYOUT_TAU };
