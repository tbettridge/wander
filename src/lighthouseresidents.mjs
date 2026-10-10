import { mulberry32 } from './noise.js';
import { buildingWorldPoint } from './buildingplan.mjs';

const SURNAMES = ['Alder', 'Beacon', 'Brine', 'Cliff', 'Driftwood', 'Firth', 'Gull', 'Harbour',
  'Marr', 'Reed', 'Salt', 'Seabrook', 'Shore', 'Tern', 'Thorne', 'Wick'];

/** A lighthouse household uses the same canonical identity and residence as a village. */
export function lighthouseResidentPlan(lighthouse) {
  const rng = mulberry32(lighthouse.seed ^ 0x4b454550);
  const roll = rng();
  const count = roll < 0.3 ? 1 : roll < 0.65 ? 2 : 3 + (rng() < 0.35 ? 1 : 0);
  const surname = SURNAMES[Math.floor(rng() * SURNAMES.length)];
  const home = { ...lighthouse.worldHouse,
    ownerHouseholdId: `${lighthouse.id}:keeper-household`, ownerSurname: surname,
    displayName: `${surname} lighthouse keeper's house`,
    householdTemplate: {
      form: count === 1 ? 'single' : 'partners', count,
      roles: Array.from({ length: count }, (_, i) => i === 0 ? 'lighthouse keeper' : i === 1 ? 'keeper\u2019s spouse' : 'keeper\u2019s child'),
      ageBands: Array.from({ length: count }, (_, i) => i < 2 ? 'adult' : 'child'),
      interactive: true,
    },
  };
  const entrance = buildingWorldPoint(home, 0, home.depth / 2 + 2.1);
  const key = `${lighthouse.id}:entrance`;
  const site = { id: lighthouse.id, kind: 'lighthouse', name: `${surname} Lighthouse`,
    seed: lighthouse.seed, x: home.x, y: home.y, z: home.z, yaw: home.yaw, radius: 24,
    regionalEntrance: { key, ...entrance, y: home.y },
  };
  // The house can be raised well above a coastal slope. Outdoor pauses stay
  // on its entrance ramp rather than the ordinary village's side-of-door ground.
  const residentOutdoorSpots = Array.from({ length: 4 }, (_, i) => {
    const lx = i % 2 ? .18 : -.18, lz = home.depth / 2 + .8 + i * .8;
    const point = buildingWorldPoint(home, lx, lz), ramp = lighthouse.ramp;
    const t = (lighthouse.house.x - lz - ramp.x0) / (ramp.x1 - ramp.x0);
    return { id: `${home.id}:ramp-pause:${i}`, kind: 'front', buildingId: home.id, nodeKey: key,
      ...point, y: lighthouse.y + ramp.y0 + (ramp.y1 - ramp.y0) * t, yaw: home.yaw, lx, lz };
  });
  return { site, buildings: [home], props: [], paths: [],
    residentOutdoorSpots,
    localGraph: { nodes: [{ key, kind: 'entrance', buildingId: home.id, ...entrance, y: home.y }], edges: [] },
  };
}
