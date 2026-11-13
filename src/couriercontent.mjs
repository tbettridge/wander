// First Post's authored content is independent of quest completion and AI output.
export const COURIER_SCENARIO = 'first-post';
export const COURIER_SEED = 20260612;
export const COURIER_VERSION = 1;
export const COURIER_PREFIX = 'wander.courier.first-post.v1.';
export const COURIER_ROLES = Object.freeze({
  dispatcher: 'A', guide: 'A', gardener: 'H', potter: 'H', poet: 'B', archivist: 'B',
});
export const COURIER_JOBS = Object.freeze([
  // `reveals` is the account the recipient shows the courier on delivery, so
  // the story is earned on the road as well as read at the public stands.
  { id: 'first-letter', title: 'First Letter', sender: 'dispatcher', recipient: 'gardener', kind: 'letter', description: 'A sealed personal letter. Find the gardener at home or work.', serial: 'FP-17', carries: 'dispatch-now', reveals: 'dispatch-old',
    thanks: 'The gardener turns the envelope over twice. “FP-17. I have a receipt for this very letter — filed twenty winters ago.” They fetch it and let you copy it.' },
  { id: 'trail-notes', title: 'Trail Notes', sender: 'guide', recipient: 'archivist', kind: 'letter', description: 'A rider’s written account of the trails, for the station archive.', reveals: 'guide-memory',
    thanks: 'The archivist reads the last page aloud: a childhood recollection the rider added at the end. “That one we will file where people can read it.”' },
  { id: 'platform-seeds', title: 'Seeds for the Platform', sender: 'gardener', recipient: 'dispatcher', kind: 'basket', description: 'A basket of flower seeds for the station’s pots.', reveals: 'gardener-memory',
    thanks: 'Thank you. These seeds will fill the station’s flower pots. A postcard was tucked under the packets; the dispatcher reads it and hands it to you.' },
  { id: 'platform-cup', title: 'A Cup for the Platform', sender: 'potter', recipient: 'archivist', kind: 'parcel', description: 'A glazed cup. Walking and the train are gentle; running, galloping and jumping can chip it.', fragile: true, reveals: 'maker-now',
    thanks: 'The archivist turns the cup to its signed label and frowns at the mark. “Read this. I have seen that mark somewhere older.”' },
  { id: 'return-manuscript', title: 'Return Manuscript', sender: 'poet', recipient: 'dispatcher', kind: 'parcel', description: 'A manuscript of local stories. The writer would like it to reach another village.',
    thanks: 'The dispatcher weighs the manuscript in both hands. “Stories from down the line. I will see they are read here.”' },
  { id: 'catalog-copy', title: 'Catalog Copy', sender: 'archivist', recipient: 'potter', kind: 'letter', description: 'A copy of an old pottery catalog, for the maker to examine.', reveals: 'maker-old',
    thanks: 'The potter opens the catalog to an illustration and goes quiet. “That is my mark. This was printed before I ever drew it.” They show you the page.' },
  { id: 'village-note', title: 'A Note Across the Village', sender: 'dispatcher', recipient: 'guide', kind: 'letter', local: true, description: 'A short walk: carry a note from the post desk to the local trail guide. Ask for the guide’s address before you leave.' },
]);
export const COURIER_EVIDENCE = Object.freeze([
  { id: 'dispatch-now', thread: 'post', title: 'The current dispatch sheet', places: ['A', 'B'], text: 'Opening dispatch sheet: FP-17, a personal letter from {dispatcher} for {gardener}. This serial was issued for the present courier round.' },
  { id: 'dispatch-old', thread: 'post', title: 'An older receipt', places: ['B', 'H'], text: 'Archive receipt, filed twenty winters ago: FP-17, a personal letter from {dispatcher} for {gardener}. The envelope and consignment description match the current sheet.' },
  { id: 'guide-memory', thread: 'memories', title: 'The rider’s recollection', places: ['A', 'B'], text: 'A public recollection signed by {guide}: “I was seven. I hid a brass button in the willow’s hollow while the well bell rang three times. I told nobody.” The rider names their childhood village as {A}.' },
  { id: 'gardener-memory', thread: 'memories', title: 'The gardener’s postcard', places: ['H', 'A'], text: 'A public postcard signed by {gardener}: “I was seven. I hid a brass button in the willow’s hollow while the well bell rang three times. I told nobody.” The gardener names their childhood village as {H}.' },
  { id: 'maker-now', thread: 'craft', title: 'The maker’s signed label', places: ['H', 'B'], text: 'A signed label from {potter}: “Last spring I first drew my own mark: a cup beneath three small stars. That is when I began using it.”' },
  { id: 'maker-old', thread: 'craft', title: 'The old catalog illustration', places: ['A', 'B'], text: 'This catalog is dated twenty winters ago. Its illustration bears the mark of {potter}: a cup beneath three small stars, with the same initials as the new signed label.' },
]);
export const COURIER_THREADS = Object.freeze([
  { id: 'post', title: 'The post and its records', evidence: ['dispatch-now', 'dispatch-old'], comparison: 'A serial issued for this courier round appears on a receipt filed twenty winters ago.' },
  { id: 'memories', title: 'Borrowed memories', evidence: ['guide-memory', 'gardener-memory'], comparison: 'Two people from different villages describe the same private incident, each claiming to have been the child.' },
  { id: 'craft', title: 'The maker’s mark', evidence: ['maker-now', 'maker-old'], comparison: 'A mark its maker says they invented last spring appears in a much older catalog.' },
]);
export const COURIER_ENDING = Object.freeze({
  title: 'What the poet said',
  lines: ['{poet} lays your accounts side by side and reads them without speaking for a while.',
    '“A letter that arrives twice. A childhood two people remember. A mark older than its maker. I cannot tell you why, and I would not trust anyone who said they could.”',
    '“But I can tell you what I think it is like. A road is walked by many people, and each of them thinks the footprints are their own. Perhaps we are all carrying something that was carried before.”',
    '“You are the one who took these from door to door. Whatever this place is repeating, it needed a courier to notice. Keep the pages. The round is yours for as long as you want it.”'],
});
export const COURIER_RANKS = Object.freeze([
  [0, 'New on the round'], [1, 'Known at the post desk'], [3, 'Trusted courier'], [5, 'Courier of the three villages'], [7, 'The round complete'],
]);
export function courierRank(delivered) {
  return COURIER_RANKS.filter(([count]) => delivered >= count).at(-1)[1];
}
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
/** World convention, shared with the HUD compass: +Z north, +X west (compasshud.mjs). */
export function courierCompass(dx, dz) {
  return COMPASS[(Math.round(Math.atan2(-dx, dz) / (Math.PI / 4)) + 8) % 8];
}
// The walking pace residents already speak in (npcjourneycontext.mjs), so a
// fingerpost and a traveller on the road agree about how far a village is.
export const COURIER_METRES_PER_HOUR = 4200;
/**
 * How long a road is on foot, in the in-world day's own terms: what a
 * fingerpost or a neighbour would say, never a number of metres.
 */
export function courierWalkTime(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return 'a short stroll';
  const hours = metres / COURIER_METRES_PER_HOUR;
  if (hours < 0.3) return 'a short stroll';
  if (hours < 0.6) return 'half an hour';
  if (hours < 0.9) return 'three quarters of an hour';
  if (hours < 1.2) return 'an hour';
  if (hours < 1.6) return 'an hour and a half';
  if (hours < 2.5) return 'two hours';
  if (hours < 3.5) return 'half a morning';
  if (hours < 5) return 'a morning';
  if (hours < 8) return 'most of a day';
  return 'a long day';
}
export const COURIER_PENNANTS = Object.freeze({
  A: { colour: 0xb4462f, name: 'red' }, B: { colour: 0x2f5b98, name: 'blue' }, H: { colour: 0x4e8a3c, name: 'green' },
});
export function courierBearing(from, to) {
  if (!from || !to || !Number.isFinite(to.x) || !Number.isFinite(to.z)) return '';
  const dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz);
  if (!Number.isFinite(d)) return '';
  if (d < 6) return 'right beside you';
  return 'about ' + (d < 950 ? Math.max(10, Math.round(d / 10) * 10) + ' m ' : (d / 1000).toFixed(1) + ' km ') + courierCompass(dx, dz);
}
export function courierText(text, bindings) {
  return String(text || '').replace(/\{([A-Za-z]+)\}/g, (_, key) =>
    bindings?.cast?.[key]?.name || bindings?.places?.[key]?.name || key);
}
export function courierSources(bindings) {
  return COURIER_EVIDENCE.flatMap(evidence => evidence.places.map(place => ({
    ...evidence, sourceId: evidence.id + ':' + place, place,
    text: courierText(evidence.text, bindings),
  })));
}
export function validateCourierCoverage(excludedPlace = null) {
  const reachable = COURIER_THREADS.filter(thread => thread.evidence.every(id =>
    COURIER_EVIDENCE.find(e => e.id === id).places.some(place => place !== excludedPlace)));
  return { ok: reachable.length >= 2, threads: reachable.map(t => t.id) };
}
export function normalizeCourierState(value) {
  if (!value || value.version !== COURIER_VERSION || value.scenarioId !== COURIER_SCENARIO
    || !value.bindings?.places || !value.bindings?.cast) return null;
  // JSON-shaped state only: editor strokes live separately in IndexedDB.
  const copy = JSON.parse(JSON.stringify(value));
  for (const key of ['jobs', 'knownOffers', 'evidence', 'compared', 'knowledge', 'works', 'leads']) {
    if (!copy[key] || typeof copy[key] !== 'object' || Array.isArray(copy[key])) copy[key] = {};
  }
  copy.sequence = Math.max(0, Math.trunc(Number(copy.sequence) || 0));
  copy.hypothesis = copy.hypothesis === true;
  copy.concluded = copy.concluded === true;
  copy.travel = copy.travel || { distances: {}, visited: {}, observations: [] };
  copy.travel.observations = (copy.travel.observations || []).slice(-24);
  upgradeCourierOnboarding(copy);
  return copy;
}
// Additive migration keeps the original save namespace, inventory and authored cast.
export function upgradeCourierOnboarding(story) {
  story.leads ||= {};
  story.onboarding = { seen: false, choice: null, hintsEnabled: true, ...story.onboarding };
  for (const job of COURIER_JOBS) story.jobs[job.id] ||= { id: job.id, state: 'offered',
    attempts: 0, condition: 'intact', roughSeconds: 0, itemId: 'courier:item:' + job.id };
  return story;
}
export const CREATIVE_WORK_SCHEMA = Object.freeze({
  type: 'object', properties: {
    title: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } },
    referencedEventIds: { type: 'array', items: { type: 'string' } },
  }, required: ['title', 'lines', 'referencedEventIds'], additionalProperties: false,
});
export function validateCreativeWork(work, facts) {
  const allowed = new Set((facts.events || []).map(e => e.id));
  if (!work || typeof work.title !== 'string' || !work.title.trim() || work.title.length > 120
    || !Array.isArray(work.lines) || work.lines.length < 3 || work.lines.length > 12
    || work.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 240)
    || !Array.isArray(work.referencedEventIds) || !work.referencedEventIds.length
    || work.referencedEventIds.some(id => !allowed.has(id))) throw new Error('The work must refer only to shared journey evidence.');
  return { title: work.title.trim(), lines: work.lines.map(line => line.trim()),
    referencedEventIds: [...new Set(work.referencedEventIds)] };
}
export function fallbackCreativeWork(facts) {
  const event = facts.events?.[0];
  return {
    title: 'A Road Remembered',
    lines: ['A traveller brought a road into our room,',
      'With stories folded close beside the rain.',
      (event?.summary || 'They came from another village.') + ' —',
      'And in the telling, walked that road again.'],
    referencedEventIds: event ? [event.id] : [],
  };
}
