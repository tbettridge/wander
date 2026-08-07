// The things in a village that are not buildings.
//
// A square is only a square because of what stands in it. An empty paved disc
// reads as a gap between houses; a well in the middle of it and stalls along
// one side read as the place people go. These are the props that do that work.
//
// Each prop is a position, a facing and a kind. It carries its own collision
// footprint where it has one, and — the part Phase 4 depends on — an anchor
// kind, so a villager can be sent to the well or to a stall rather than to a
// coordinate that happens to have geometry near it.
//
// THREE-free: the renderer reads these and builds meshes, the tests read these
// and assert positions, and neither knows about the other.

import { mulberry32 } from './noise.js';

export const PROP_KIND = Object.freeze({
  well: 'well',
  stall: 'market-stall',
  bench: 'bench',
  trough: 'trough',
  noticeboard: 'noticeboard',
});

// Props a walker cannot pass through, with the radius they occupy. A bench is
// deliberately absent: stepping over one is better than being caught on it.
const SOLID = Object.freeze({
  [PROP_KIND.well]: 1.5,
  [PROP_KIND.stall]: 1.25,
  [PROP_KIND.trough]: 1.1,
});

export function propCollisionRadius(prop) {
  return SOLID[prop.kind] || 0;
}

/**
 * What stands in this settlement's square.
 *
 * The well goes dead centre — it is the reason the square is where it is, and
 * off-centre it reads as an obstacle rather than a landmark. Stalls line one
 * arc of the square so the rest stays open to walk across; a market that
 * surrounds you is a maze, not a market.
 */
export function createSettlementProps(site, layout, { heightAt = null } = {}) {
  if (!layout) return [];
  const rng = mulberry32((site.seed ^ 0x9e11) >>> 0);
  const y = (x, z) => (heightAt ? heightAt(x, z) : site.y);
  const props = [];
  const square = layout.square;

  props.push({
    id: `${site.id}:well`, kind: PROP_KIND.well,
    x: square.x, y: y(square.x, square.z), z: square.z,
    yaw: rng() * Math.PI * 2,
    radius: 1.5, height: 1.05,
    anchorKind: 'well',
    // Room for a couple of people to draw water at once without standing in
    // each other's way.
    capacity: 3,
  });

  // The market: an arc of stalls set inside the square's edge, all facing in.
  const stallCount = site.kind === 'station-village' ? 6 : 3;
  const stallRadius = square.radius * 0.66;
  // Anchored to a street mouth so the market sits along the busiest side rather
  // than in an arbitrary quarter.
  const arcCentre = (layout.streets[0]?.angle ?? site.yaw) + Math.PI * 0.62;
  const arcSpan = Math.PI * 0.78;
  for (let i = 0; i < stallCount; i++) {
    const t = stallCount === 1 ? 0.5 : i / (stallCount - 1);
    const angle = arcCentre - arcSpan / 2 + t * arcSpan;
    const x = square.x + Math.cos(angle) * stallRadius;
    const z = square.z + Math.sin(angle) * stallRadius;
    props.push({
      id: `${site.id}:stall:${i}`, kind: PROP_KIND.stall,
      x, y: y(x, z), z,
      // Facing the middle of the square, so the counter is toward the crowd.
      yaw: Math.atan2(square.x - x, square.z - z),
      width: 2.4 + rng() * 0.7, depth: 1.5, height: 2.25,
      awning: rng() < 0.78,
      goods: ['produce', 'cloth', 'fish', 'bread', 'pots', 'tools'][i % 6],
      anchorKind: 'market-stall',
      capacity: 2,
    });
  }

  // A trough and a noticeboard by the main street's mouth: small things that
  // say the square is used rather than decorated.
  const mouth = layout.streets[0];
  if (mouth) {
    const mx = square.x + Math.cos(mouth.angle) * (square.radius * 0.82);
    const mz = square.z + Math.sin(mouth.angle) * (square.radius * 0.82);
    props.push({
      id: `${site.id}:trough`, kind: PROP_KIND.trough,
      x: mx, y: y(mx, mz), z: mz, yaw: mouth.angle,
      width: 2.6, depth: 0.85, height: 0.62, anchorKind: null, capacity: 1,
    });
    const nx = square.x + Math.cos(mouth.angle + 0.5) * (square.radius * 0.7);
    const nz = square.z + Math.sin(mouth.angle + 0.5) * (square.radius * 0.7);
    props.push({
      id: `${site.id}:noticeboard`, kind: PROP_KIND.noticeboard,
      x: nx, y: y(nx, nz), z: nz,
      yaw: Math.atan2(square.x - nx, square.z - nz),
      width: 1.6, depth: 0.18, height: 2.0, anchorKind: 'map-point', capacity: 1,
    });
  }

  // Benches around the square's edge, between the stalls and the frontage.
  const benchCount = site.kind === 'station-village' ? 4 : 2;
  for (let i = 0; i < benchCount; i++) {
    const angle = arcCentre + Math.PI + (i / benchCount - 0.5) * Math.PI * 0.8;
    const x = square.x + Math.cos(angle) * (square.radius * 0.78);
    const z = square.z + Math.sin(angle) * (square.radius * 0.78);
    props.push({
      id: `${site.id}:bench:${i}`, kind: PROP_KIND.bench,
      x, y: y(x, z), z, yaw: Math.atan2(square.x - x, square.z - z),
      width: 1.8, depth: 0.5, height: 0.46, anchorKind: 'shelter', capacity: 2,
    });
  }

  return props;
}
