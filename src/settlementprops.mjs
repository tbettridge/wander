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
  foundingStone: 'founding-stone',
});

// Props a walker cannot pass through, with the radius they occupy. A bench is
// deliberately absent: stepping over one is better than being caught on it.
const SOLID = Object.freeze({
  [PROP_KIND.well]: 1.5,
  [PROP_KIND.stall]: 1.25,
  [PROP_KIND.trough]: 1.1,
  [PROP_KIND.foundingStone]: 0.9,
});

// The stone a village marks itself with. Local rock, because the one material
// every settlement has to hand is the ground it stands on — so villages in a
// region share a stone and villages over the mountain do not.
export const STONE_KINDS = Object.freeze({
  granite: 0x6f6a63,
  sandstone: 0x9a7a56,
  limestone: 0x9d9887,
  slate: 0x4c5359,
  chalk: 0xc3c0b2,
});

/** The rock this ground would have given them. */
export function localStone(biome) {
  if (!biome) return 'granite';
  if (biome.coastType === 'chalk') return 'chalk';
  if (biome.h > 90 || biome.id === 'snow' || biome.id === 'tundra') return 'granite';
  if (biome.id === 'desert' || biome.id === 'savanna' || biome.id === 'beach') return 'sandstone';
  if (biome.id === 'taiga' || biome.slope > 0.35) return 'slate';
  return 'limestone';
}

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
export function createSettlementProps(site, layout, {
  heightAt = null, origin = null, blockedAt = null,
} = {}) {
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

  // The founding stone, at the far end of the main street.
  //
  // The main street points at whatever the village is FOR, so the stone stands
  // at the end of it looking back down the road, with the ford or the stones or
  // the summit behind it.
  //
  // It is walked back from THE REASON, not from the end of the street.
  //
  // The street runs the full built reach — 124 m for a village — while a ford is
  // often only 50 or 60 m out, so the road crosses the water and carries on.
  // Anchoring at the street's end put two of five stones in the channel, one of
  // them over a metre deep; walking back from that end then found no dry ground
  // at all on those two, because the railway blocks the rest of the run. Walking
  // back from the ford instead lands on the near bank beside the crossing, which
  // is where a village would actually have raised the thing.
  // The rule is simply: as far out along the main street as the ground allows.
  // Walking OUTWARD and stopping at the first blocked step is what makes that
  // work for a close ford — there is no dry gap between the square and a
  // crossing 44 m out, so the stone settles on the near bank, right at the
  // water. Searching inward from the far end instead either drowned it or, on
  // the villages where the railway blocks the rest of the run, produced no
  // stone at all.
  //
  // Streets are tried in order and the first with room wins, so the founding
  // axis gets it whenever it can. A village whose reason lies across water can
  // have that whole road under the channel — one did, and raised no stone at
  // all — and such a place would simply have put its marker on another way out.
  const stoneSpot = (() => {
    if (!origin) return null;
    for (let s = 0; s < layout.streets.length; s++) {
      const street = layout.streets[s];
      const dirX = Math.cos(street.angle), dirZ = Math.sin(street.angle);
      // Off the carriageway, or it stands in the road.
      const aside = street.width * 0.9 + 1.4;
      const streetEnd = Math.hypot(street.toX - square.x, street.toZ - square.z);
      let best = null;
      for (let out = square.radius + 8; out <= streetEnd - 3; out += 3.5) {
        const x = square.x + dirX * out + -dirZ * aside;
        const z = square.z + dirZ * out + dirX * aside;
        if (blockedAt && blockedAt(x, z)) {
          // The first obstruction past open ground is the edge of the village.
          if (best) break;
          continue;                  // still looking for anywhere to start
        }
        best = { x, z, street: s };
      }
      if (best) return best;
    }
    return null;
  })();
  if (stoneSpot) {
    const { x: sx, z: sz } = stoneSpot;
    // A place with a strong reason to exist raised a bigger stone for it.
    const tier = site.kind === 'station-village' || site.kind === 'town' ? 1
      : site.kind === 'station-halt' || site.kind === 'village' ? 0.82 : 0.66;
    const height = (1.15 + (origin.strength || 0) * 1.75) * tier;
    props.push({
      id: `${site.id}:founding-stone`, kind: PROP_KIND.foundingStone,
      x: sx, y: y(sx, sz), z: sz,
      // Its face turned back toward the square, so it reads to someone walking
      // out of the village rather than to the empty country beyond it.
      yaw: Math.atan2(square.x - sx, square.z - sz),
      height,
      width: 0.42 + height * 0.30,
      depth: 0.26 + height * 0.13,
      // A raised stone is never quite plumb after a few centuries.
      lean: (rng() - 0.5) * 0.16,
      stone: origin.stone || 'granite',
      foundedOn: origin.kind,
      // Which road it ended up on — 0 is the founding axis, anything else means
      // that axis had no dry ground to stand on.
      street: stoneSpot.street,
      anchorKind: 'landmark',
      capacity: 1,
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
