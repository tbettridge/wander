import { mulberry32 } from './noise.js';

const SURNAMES = Object.freeze([
  'Ash', 'Bell', 'Briar', 'Brook', 'Cairn', 'Cobb', 'Dale', 'Elder',
  'Ember', 'Fallow', 'Fenn', 'Finch', 'Grove', 'Hearth', 'Moss', 'Reed',
  'Rook', 'Thorne', 'Vale', 'Wick', 'Alder', 'Barrow', 'Flint', 'Kirk',
  'Mere', 'Pike', 'Shaw', 'Tarn', 'Venn', 'Yew', 'Crow', 'Dunn',
  'Abbey', 'Avery', 'Barton', 'Bexley', 'Clarke', 'Darrow', 'Ellis', 'Firth',
  'Gable', 'Grange', 'Harrow', 'Keen', 'Lark', 'Marlow', 'Norris', 'Pryce',
  'Quill', 'Ravel', 'Sutton', 'Tanner', 'Umber', 'Warren', 'Weld', 'Wright',
  'Ainsley', 'Bramwell', 'Carter', 'Dorset', 'Everard', 'Fletcher', 'Grafton', 'Holling',
]);

export const SURNAME_REGION_SIZE = 4096;
export const SURNAME_POOL_SIZE = 8;

function hashRegion(seed, ri, rj) {
  let hash = (seed ^ 0x4e414d45) >>> 0;
  hash = Math.imul(hash ^ ri, 16777619);
  hash = Math.imul(hash ^ rj, 16777619);
  return hash >>> 0;
}

/** A stable local vocabulary: neighbouring settlements share families. */
export function surnamePoolForRegion(worldSeed, x, z) {
  const ri = Math.floor(x / SURNAME_REGION_SIZE);
  const rj = Math.floor(z / SURNAME_REGION_SIZE);
  const rng = mulberry32(hashRegion(worldSeed >>> 0, ri, rj));
  const available = SURNAMES.slice();
  const pool = [];
  while (pool.length < SURNAME_POOL_SIZE) {
    pool.push(available.splice(Math.floor(rng() * available.length), 1)[0]);
  }
  return Object.freeze(pool);
}

export function householdSurname(site, homeSeed, householdIndex) {
  const pool = surnamePoolForRegion(site.worldSeed ?? site.seed, site.x, site.z);
  const rng = mulberry32((homeSeed ^ Math.imul(householdIndex + 1, 0x46414d)) >>> 0);
  return pool[Math.floor(rng() * pool.length)];
}

const GENERIC_PROGRAM_NAMES = Object.freeze({
  dwelling: 'Dwelling', barn: 'Barn', workshop: 'Workshop', inn: 'Inn', hall: 'Hall',
  church: 'Church', school: 'School', 'market-hall': 'Market Hall', smithy: 'Smithy',
  granary: 'Granary', 'station-house': 'Station House',
});

export function buildingDisplayName(building) {
  return building?.ownerSurname ? `${building.ownerSurname}\u2019s`
    : (GENERIC_PROGRAM_NAMES[building?.program] || 'Building');
}
