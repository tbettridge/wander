// The scaffold of First Post's story: a lattice of beats, the authored tells
// that can show each beat, and each resident's temperament. Everything here is
// data or a pure reducer over the saved story, so a script can walk the whole
// graph without the game (scripts/walk-courier-story.mjs).
import { COURIER_EVIDENCE, COURIER_THREADS } from './couriercontent.mjs';

/** The first, mild tell. Authored, and the same for every courier. */
export const STORY_FIRST = 'dispatch-now';
export const STORY_STANCES = Object.freeze(['afraid', 'relieved', 'denying', 'curious']);
export const STORY_GLITCHES = Object.freeze(['record', 'memory', 'maker']);
/** Consecutive arrivals away from the tutorial villages before their fixed papers stop counting as close by. */
export const STORY_AWAY = 2;

// `needs` is a prerequisite: a beat id, or `count` of a set of beats.
export const STORY_BEATS = Object.freeze([
  { id: 'record', kind: 'glitch', needs: [], title: 'A record that repeats' },
  { id: 'memory', kind: 'glitch', needs: [], title: 'A memory two people share' },
  { id: 'maker', kind: 'glitch', needs: [], title: 'A thing older than its maker' },
  { id: 'pattern', kind: 'player', needs: [{ anyOf: STORY_GLITCHES, count: 2 }], title: 'A pattern noticed' },
  { id: 'voices', kind: 'player', needs: [{ anyOf: STORY_GLITCHES, count: 1 }], title: 'What people make of it' },
  { id: 'named', kind: 'placed', needs: ['pattern'], title: 'Someone names it' },
  { id: 'turn', kind: 'placed', needs: ['named', 'voices'], title: 'The turn toward the courier' },
  { id: 'ending', kind: 'closer', needs: ['turn'], title: 'The last letter' },
].map(beat => Object.freeze(beat)));
const BEAT = new Map(STORY_BEATS.map(beat => [beat.id, beat]));

// The three threads the tutorial villages hold are the first tell of each glitch.
const TUTORIAL_BEATS = { post: 'record', memories: 'memory', craft: 'maker' };
const TUTORIAL_ANCHORS = {
  'dispatch-now': ['FP-17'], 'dispatch-old': ['FP-17', 'twenty winters'],
  'guide-memory': ['brass button', 'willow', 'I told nobody'], 'gardener-memory': ['brass button', 'willow', 'I told nobody'],
  'maker-now': ['three small stars'], 'maker-old': ['three small stars', 'twenty winters'],
};

/**
 * A tell shows one beat. Glitch tells are a pair of accounts and the line the
 * courier reaches by comparing them; later tells are a single account.
 */
export const STORY_TELLS = Object.freeze([
  ...COURIER_THREADS.map(thread => ({ id: thread.id, beat: TUTORIAL_BEATS[thread.id], tutorial: true,
    title: thread.title, accounts: thread.evidence, comparison: thread.comparison })),
  { id: 'post-book', beat: 'record', title: 'The post and its book', accounts: [STORY_FIRST, 'book-entry'],
    comparison: 'A letter you were handed as new is already signed for, in a delivery book older than the person who keeps it.' },
  { id: 'lullaby', beat: 'memory', title: 'One lullaby, two cradles', accounts: ['lullaby-a', 'lullaby-b'],
    comparison: 'Two parents in different places each say they made up the same line for their own child, and never sang it outside the house.' },
  { id: 'tool', beat: 'maker', title: 'The new pattern', accounts: ['tool-new', 'tool-old'],
    comparison: 'A tool its maker says they worked out this spring was dug up worn thin, with the same notch cut in the handle.' },
  { id: 'tally', beat: 'named', title: 'The tally', accounts: ['tally'] },
  { id: 'rope', beat: 'named', title: 'The well rope', accounts: ['rope'] },
  { id: 'route-book', beat: 'turn', title: 'The route book', accounts: ['route-book'] },
  { id: 'own-letter', beat: 'turn', title: 'A letter for the courier', accounts: ['own-letter'] },
].map(tell => Object.freeze({ ...tell, accounts: Object.freeze([...tell.accounts]) })));

const CRADLE = 'A note signed by {author} of {authorPlace}: “When my first would not sleep I made up one line and sang it until morning: ‘Sleep now, the road will keep.’ I never sang it outside this house.”';
/**
 * Authored facts, not prose. `roles` is who could plausibly have written it,
 * best first, and always ends in anyone (`*`) so casting cannot fail.
 * `anchors` are the words that carry the clue: generated prose must keep them.
 */
export const STORY_ACCOUNTS = Object.freeze([
  ...COURIER_EVIDENCE.map(evidence => ({ id: evidence.id, tutorial: true, form: 'account', title: evidence.title,
    roles: ['*'], channels: ['stand'], facts: [{ id: evidence.id, text: evidence.text, anchors: TUTORIAL_ANCHORS[evidence.id] }] })),
  { id: 'book-entry', form: 'account', title: 'A page of an old delivery book', roles: ['clerk', 'innkeeper', 'shopkeeper', '*'], channels: ['stand', 'handed'],
    facts: [
      { id: 'entry', text: 'An old delivery book kept in {authorPlace} has this line, in ink gone brown: FP-17, a personal letter from {dispatcher} for {gardener}, delivered and signed for.', anchors: ['FP-17', 'delivered and signed for'] },
      { id: 'age', text: '{author} keeps the book now, and says that page was sewn into it before {author} was born.', anchors: ['sewn into it'] },
    ],
    handover: '{author} turns a heavy book toward you and keeps one finger on a line. “You carry the post? Then read this, and tell me how it can be.”' },
  { id: 'lullaby-a', form: 'letter', title: 'A cradle song', roles: ['*'], channels: ['stand', 'handed'],
    facts: [{ id: 'line', text: CRADLE, anchors: ['Sleep now, the road will keep', 'outside this house'] }],
    handover: '{author} writes one line on a scrap and folds it over. “It is only a cradle song. But it is mine, and I would like it kept somewhere.”' },
  { id: 'lullaby-b', form: 'letter', title: 'Another cradle song', roles: ['*'], channels: ['stand', 'handed'],
    facts: [{ id: 'line', text: CRADLE, anchors: ['Sleep now, the road will keep', 'outside this house'] }],
    handover: '{author} hums a little before speaking. “I made that up myself, years ago. Here, I will write it down for you.”' },
  { id: 'tool-new', form: 'account', title: 'A maker’s note', roles: ['smith', 'craftsperson', 'miller', 'farmer', '*'], channels: ['stand', 'handed'],
    facts: [{ id: 'made', text: 'A maker’s note from {author} of {authorPlace}: “This spring I worked out a better hay knife: long in the blade, with a notch cut in the handle for the thumb. Nobody showed it to me.”', anchors: ['hay knife', 'notch cut in the handle'] }],
    handover: '{author} holds up a long knife, pleased with it. “My own pattern. I wrote down how it goes, in case anyone asks.”' },
  { id: 'tool-old', form: 'account', title: 'Something the plough turned up', roles: ['farmer', 'miller', '*'], channels: ['stand', 'handed'],
    facts: [{ id: 'found', text: 'Turned up by the plough in {authorPlace} and kept by {author}: a hay knife worn thin with use, long in the blade, with a notch cut in the handle for the thumb. The rust on it is older than anyone living here.', anchors: ['hay knife', 'notch cut in the handle', 'worn thin'] }],
    handover: '{author} unwraps something long and rusted from a cloth. “The plough found it. Look at the handle before you say anything.”' },
  { id: 'tally', form: 'letter', title: 'A tally', roles: ['clerk', 'shopkeeper', 'innkeeper', '*'], channels: ['handed', 'stand'],
    facts: [
      { id: 'count', text: 'I have kept count since I could write. Every year {authorPlace} has as many cradles as graves. Not one year out.', anchors: ['as many cradles as graves'] },
      { id: 'kept', text: 'A ledger does not balance like that by luck. Someone is keeping it, and it is not me.', anchors: ['Someone is keeping it'] },
    ],
    handover: '{author} has been waiting for you. “You are the one collecting papers that do not agree. I have one more, and I wrote it myself.”' },
  { id: 'rope', form: 'letter', title: 'About the well rope', roles: ['innkeeper', 'farmer', 'miller', '*'], channels: ['handed', 'stand'],
    facts: [
      { id: 'rope', text: 'The well rope in {authorPlace} has never been changed. Nobody remembers a new one, and it does not fray.', anchors: ['well rope', 'does not fray'] },
      { id: 'wound', text: 'Things here are not used up. They are kept, the way a clock is kept: wound, and set, and looked in on.', anchors: ['wound, and set, and looked in on'] },
    ],
    handover: '{author} has been waiting for you. “You are the one collecting papers that do not agree. I have one more, and I wrote it myself.”' },
  // The turn is built from the courier's own recorded journey (`journey: true`).
  { id: 'route-book', form: 'account', title: 'An old route book', journey: true, roles: ['clerk', 'innkeeper', 'shopkeeper', '*'], channels: ['handed'],
    facts: [
      { id: 'found', text: '{author} found this at the bottom of a chest in {authorPlace}: a route book with its cover gone soft, in a hand nobody here knows.', anchors: ['route book'] },
      { id: 'last', text: 'The last line is not a place. It says: “and then the courier reads this.”', anchors: ['and then the courier reads this'] },
    ],
    handover: '{author} will not quite look at you. “This was here before you were. I think you had better read it yourself.”' },
  { id: 'own-letter', form: 'letter', title: 'A letter kept for the courier', journey: true, roles: ['clerk', 'innkeeper', 'shopkeeper', '*'], channels: ['handed'],
    facts: [
      { id: 'kept', text: 'A letter kept by {author} of {authorPlace}, left “for the courier, when one comes”. The seal was old before you arrived.', anchors: ['for the courier, when one comes'] },
      { id: 'last', text: 'It ends: “You will think you chose that road. So did I.”', anchors: ['You will think you chose that road'] },
    ],
    handover: '{author} will not quite look at you. “This was here before you were. I think you had better read it yourself.”' },
].map(account => Object.freeze({ ...account, roles: Object.freeze([...account.roles]), channels: Object.freeze([...account.channels]),
  facts: Object.freeze(account.facts.map(fact => Object.freeze({ ...fact, anchors: Object.freeze([...(fact.anchors || [])]) }))) })));
const ACCOUNT = new Map(STORY_ACCOUNTS.map(account => [account.id, account]));
const TELL = new Map(STORY_TELLS.map(tell => [tell.id, tell]));

/** A phrase that comes back in later papers, one for each playthrough. */
export const STORY_REFRAINS = Object.freeze(['I told nobody', 'the road will keep', 'as it was before']);
/** How each temperament opens and closes anything it writes when no model is available. */
export const STORY_FRAMES = Object.freeze({
  afraid: { open: 'I am setting this down once, and then I do not want to speak of it.', close: 'Do not bring it back to me.' },
  relieved: { open: 'It is a comfort to have this written down at last.', close: 'There. It weighs less on paper.' },
  denying: { open: 'For the record, since people will talk.', close: 'I expect there is an ordinary reason.' },
  curious: { open: 'I have been turning this over and want it written exactly.', close: 'If you find another like it, I would give a good deal to see it.' },
});
/** What a resident says when the courier shows them what they carry, by how far the story has come. */
export const STORY_REACTIONS = Object.freeze({
  afraid: {
    glitch: 'I would rather you had not shown me that. Put it away. …No. Let me see it again.',
    pattern: 'Two is not a mistake. Do not read these out where the children can hear.',
    named: 'If we are kept, then we can be put down. Does it say anywhere who decides?' },
  relieved: {
    glitch: 'So it is not only me. I thought I was losing hold of my own years.',
    pattern: 'Then there is a reason things feel the way they do. I can live with a reason.',
    named: 'Kept. Good. A thing that is kept is looked after. I have been afraid of far worse than that.' },
  denying: {
    glitch: 'A copying error. Clerks are careless and paper is cheap.',
    pattern: 'You went looking for a pattern, and so you found one. That is all a pattern is.',
    named: 'People have always told stories about who winds the clock. I have bread to bake.' },
  curious: {
    glitch: 'Now that is odd. May I copy it? I want to see whether the hand is the same.',
    pattern: 'Then the next question is whether it repeats exactly, or only nearly. Bring me a third.',
    named: 'If someone looks in on us, there is a place they look in from. I wonder what the road there is like.' },
});
/** Nobody here has the word. A courier who uses it is asked what it means, and can teach it. */
export const STORY_WORD = Object.freeze({
  id: 'simulation', pattern: /\bsimulat(?:ion|ions|ed|or|ors|ing)\b/i,
  ask: 'Simulation. I do not know that word. What does it mean?',
  learned: {
    afraid: 'A made thing that only behaves like the real one. I would rather not have that word. But I have it now.',
    relieved: 'So there is even a word for it. Then somebody else has stood where we are standing.',
    denying: 'A word from somewhere else, for a worry from somewhere else. I will remember it, all the same.',
    curious: 'A simulation. Then tell me: from the inside, how would anyone tell the difference? How would you?' },
});
const RECAP = {
  record: 'A letter that was signed for before it was sent.', memory: 'A memory that two people own.',
  maker: 'A thing older than the hand that made it.', turn: 'And a page that knew your road before you walked it.',
};
/** The ending. `recap` lines depend on what this courier found; `final` is the same for everyone. */
export const STORY_ENDING = Object.freeze({
  title: 'The last letter',
  open: '{closer} reads everything you carry, one page after another, and does not hurry.',
  after: ['“I will not tell you what it is. I only know what it is like: a thing that is kept. Wound, and set, and looked in on.”',
    '“So there is one more letter, and it is not for anyone here.”'],
  final: ['{closer} hands you a letter with no seal and no address. Inside is a single line:',
    '“You checked whether our records agree. Who keeps yours?”',
    'The round is yours for as long as you want it.'],
});

export function storyHash(...parts) {
  let hash = 2166136261;
  for (const character of parts.join('|')) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  // Avalanche, so neighbouring ids do not pick neighbouring answers.
  hash ^= hash >>> 15; hash = Math.imul(hash, 2246822507); hash ^= hash >>> 13; hash = Math.imul(hash, 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}
export const storyPick = (list, ...parts) => list[storyHash(...parts) % list.length];
export const accountDef = id => ACCOUNT.get(id) || null;
export const tellById = id => TELL.get(id) || null;
export const tellsOf = beat => STORY_TELLS.filter(tell => tell.beat === beat);
export const tellsWith = accountId => STORY_TELLS.filter(tell => tell.accounts.includes(accountId));
export const storyHeld = (story, accountId) => !!story.evidence?.[accountId];
export const storyRefrain = story => storyPick(STORY_REFRAINS, story.plot.seed, 'refrain');

export function createPlot(seed = 1) {
  return { v: 1, seed: seed >>> 0, beats: {}, voices: {}, stances: {}, accounts: {}, sites: {}, closer: null,
    pacing: { arrivals: 0, last: null, away: 0, quiet: 0, seen: [] }, lexicon: {}, jobs: {}, works: {}, people: {}, commissions: 0, delivered: 0 };
}
/**
 * Give an existing save its plot, or repair one that is missing parts. An
 * older save derives its story seed from the run it already has, so it
 * upgrades to the same story every time it is loaded.
 */
export function upgradeCourierPlot(story, { seed = null } = {}) {
  const fresh = createPlot(Number.isFinite(seed) ? seed : storyHash('plot', story.runId || ''));
  const plot = story.plot && typeof story.plot === 'object' ? story.plot : (story.plot = fresh);
  for (const [key, value] of Object.entries(fresh)) {
    if (key === 'seed') { if (!Number.isFinite(plot.seed)) plot.seed = value; continue; }
    if (key === 'closer') { if (plot.closer === undefined) plot.closer = null; continue; }
    if (typeof value === 'number') { if (!Number.isFinite(plot[key])) plot[key] = value; continue; }
    if (!plot[key] || typeof plot[key] !== 'object') plot[key] = value;
  }
  plot.pacing = { ...fresh.pacing, ...plot.pacing }; if (!Array.isArray(plot.pacing.seen)) plot.pacing.seen = [];
  story.evidence ||= {}; story.compared ||= {};
  // The tutorial poet answers the way they always have.
  const poet = story.bindings?.cast?.poet?.id;
  if (poet) { plot.stances[poet] ||= 'curious'; if (story.concluded) plot.voices.curious ||= poet; }
  return plot;
}

export function beatDone(story, id) {
  if (STORY_GLITCHES.includes(id)) return tellsOf(id).some(tell => story.compared?.[tell.id]);
  if (id === 'pattern') return story.hypothesis === true;
  if (id === 'voices') return Object.keys(story.plot.voices).length >= 2;
  return story.plot.beats[id] === true;
}
export function beatOpen(story, id) {
  const beat = BEAT.get(id);
  return !!beat && !beatDone(story, id) && beat.needs.every(need => typeof need === 'string' ? beatDone(story, need)
    : need.anyOf.filter(other => beatDone(story, other)).length >= need.count);
}
/** How far the story has come, for a resident deciding what to make of it. */
export function storyStage(story) {
  return beatDone(story, 'named') ? 'named' : beatDone(story, 'pattern') ? 'pattern' : 'glitch';
}
export const inTutorial = story => !!story.bindings?.places && story.plot.pacing.away < STORY_AWAY;

/** The one tell of a beat this courier is following: what they have begun, else the tutorial's, else the seed's. */
export function activeTell(story, beat, { tutorial = inTutorial(story) } = {}) {
  const tells = tellsOf(beat);
  // The dispatch sheet is half of every record tell, so it does not choose between them.
  const begun = tell => tell.accounts.filter(id => id !== STORY_FIRST && storyHeld(story, id)).length;
  const most = Math.max(...tells.map(begun));
  if (most > 0) return tells.find(tell => begun(tell) === most);
  return (tutorial && tells.find(tell => tell.tutorial)) || storyPick(tells, story.plot.seed, 'tell', beat);
}
/**
 * The accounts the story could use next, most wanted first: the first tell,
 * then the missing half of anything begun, then the later beats, and only then
 * a new glitch. Accounts the tutorial villages already post are left to them.
 */
export function storyNeeds(story, { tutorial = inTutorial(story) } = {}) {
  if (!storyHeld(story, STORY_FIRST)) return [{ beat: 'record', account: STORY_FIRST, first: true }];
  if (beatDone(story, 'turn')) return [];
  const needs = [], fresh = [];
  let dangling = 0;
  for (const beat of STORY_GLITCHES) {
    if (beatDone(story, beat)) continue;
    const tell = activeTell(story, beat, { tutorial });
    if (tutorial && tell.tutorial) continue;
    const missing = tell.accounts.filter(id => !storyHeld(story, id));
    if (!missing.length) continue; // both halves in hand: the comparing is the courier's to do
    if (missing.length < tell.accounts.length) { dangling++; for (const account of missing) needs.push({ beat, account }); }
    else fresh.push({ beat, account: tell.accounts[0] });
  }
  for (const beat of ['named', 'turn']) if (beatOpen(story, beat)) needs.push({ beat, account: activeTell(story, beat, { tutorial }).accounts[0] });
  if (dangling <= 1) needs.push(...fresh.sort((a, b) => storyHash(story.plot.seed, 'order', a.beat) - storyHash(story.plot.seed, 'order', b.beat)));
  return needs;
}
/** Every tell the courier has begun, with which accounts they hold: the Story page. */
export function storyThreads(story) {
  return STORY_TELLS.filter(tell => tell.accounts.length > 1 && tell.accounts.some(id => id !== STORY_FIRST && storyHeld(story, id))
    || (tell.beat === 'record' && storyHeld(story, STORY_FIRST) && tell === activeTell(story, 'record')))
    .map(tell => ({ tell, accounts: tell.accounts.map(id => ({ id, held: storyHeld(story, id) })),
      ready: tell.accounts.every(id => storyHeld(story, id)), compared: !!story.compared?.[tell.id] }));
}

export function stanceOf(story, npcId) {
  return story.plot.stances[npcId] || STORY_STANCES[storyHash(story.plot.seed, 'stance', npcId) % STORY_STANCES.length];
}
/** The courier now holds an account, read at `siteId`. Copies posted elsewhere are taken down. */
export function recordAccount(story, accountId, siteId = null) {
  const plot = story.plot, isNew = !storyHeld(story, accountId);
  story.evidence[accountId] ||= { id: accountId, sourceIds: [] };
  for (const [id, site] of Object.entries(plot.sites)) {
    if (id === siteId) continue;
    site.offers = site.offers.filter(offer => offer.a !== accountId);
    if (!site.offers.length) delete plot.sites[id];
  }
  for (const tell of tellsWith(accountId)) {
    if (tell.accounts.length !== 1) continue;
    plot.beats[tell.beat] = true;
    // Whoever named it has, by naming it, said what they make of it.
    const author = plot.accounts[accountId];
    if (tell.beat === 'named' && author) plot.voices[author.stance] ||= author.by;
  }
  return isNew;
}
export function recordCompared(story, tellId) {
  const tell = tellById(tellId);
  if (!tell || tell.accounts.length < 2 || !tell.accounts.every(id => storyHeld(story, id))) return false;
  story.compared[tellId] = true; return true;
}
export function recordPattern(story) {
  if (!beatOpen(story, 'pattern')) return false;
  story.hypothesis = true; return true;
}
/**
 * A resident reacts to what the courier shows them. Two different people
 * always give two different voices: if the second shares the first's
 * temperament, the story tilts them, and they keep that from then on.
 */
export function recordVoice(story, npcId) {
  const plot = story.plot;
  let stance = stanceOf(story, npcId);
  if (!STORY_GLITCHES.some(beat => beatDone(story, beat))) return { stance, counted: false };
  const heard = Object.keys(plot.voices);
  if (!plot.voices[stance]) plot.voices[stance] = npcId;
  else if (plot.voices[stance] !== npcId && heard.length < 2) {
    stance = storyPick(STORY_STANCES.filter(other => !plot.voices[other]), plot.seed, 'tilt', npcId);
    plot.stances[npcId] = stance; plot.voices[stance] = npcId;
  }
  return { stance, counted: true };
}
export function recordEnding(story) {
  if (!beatOpen(story, 'ending')) return false;
  story.plot.beats.ending = true; return true;
}
/** The closer's words: what this courier found, then the moment everyone shares. */
export function storyEnding(story, closerName) {
  const found = [...STORY_GLITCHES.filter(beat => beatDone(story, beat)), 'turn'].map(beat => RECAP[beat]);
  const lines = [STORY_ENDING.open, '“' + found.join(' ') + '”', ...STORY_ENDING.after, ...STORY_ENDING.final];
  return { title: STORY_ENDING.title, lines: lines.map(line => line.replaceAll('{closer}', closerName)) };
}

/** Fill `{author}`-style names; anything unknown is left for the caller's own bindings. */
export function storyText(text, vars = {}) {
  return String(text || '').replace(/\{([A-Za-z]+)\}/g, (whole, key) => vars[key] ?? whole);
}
/**
 * The facts a piece of writing may use, and nothing else: the account's own
 * sentences, the writer and their temperament, the courier's real journey for
 * a turn account, and every name that may appear.
 */
export function storyFacts(accountId, { author = 'A resident', authorPlace = 'this village', stance = 'curious',
  refrain = '', events = [], names = [], render = text => text } = {}) {
  const def = accountDef(accountId);
  if (!def) throw new Error('Unknown account: ' + accountId);
  const fill = text => render(storyText(text, { author, authorPlace }));
  const facts = def.facts.map(fact => ({ id: fact.id, text: fill(fact.text), anchors: fact.anchors.map(fill) }));
  // A turn account lists the courier's own road between its opening and its last line.
  if (def.journey) facts.splice(1, 0, ...events.slice(-8).map(event => ({ id: String(event.id), text: String(event.summary), anchors: [] })));
  return { accountId, form: def.form, journey: !!def.journey, title: fill(def.title), author, authorPlace, stance, refrain, facts,
    names: [...new Set([author, authorPlace, ...names].filter(Boolean))] };
}
const plain = value => String(value ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const WORDS = /[\p{L}][\p{L}'’-]*/gu;
const BLOCKED = /\b(simulat\w*|computers?|program(?:s|med|ming|mer)?|software|video ?games?|games?|players?|npcs?|servers?|render(?:s|ed|ing)?|pixels?|virtual|algorithms?|source code|artificial intelligence)\b/gi;
const ALL_ANCHORS = [...new Set(STORY_ACCOUNTS.flatMap(account => account.facts.flatMap(fact => fact.anchors)))];
/**
 * Accept generated prose only if it carries the authored facts and nothing
 * that could pass for a clue: every anchor present, no other tell's anchor,
 * no number or name the facts do not contain, none of the words this world
 * does not have (unless this writer has been taught one: `lexicon`).
 */
export function validateStoryWork(work, facts, { lexicon = [] } = {}) {
  const reject = reason => { throw new Error('The work must keep to the authored facts: ' + reason); };
  if (!work || typeof work.title !== 'string' || !work.title.trim() || work.title.length > 120
    || !Array.isArray(work.lines) || work.lines.length < 3 || work.lines.length > 20
    || work.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 400)
    || !Array.isArray(work.referencedEventIds)) reject('wrong shape');
  const ids = new Set(facts.facts.map(fact => fact.id)), cited = new Set(work.referencedEventIds);
  if ([...cited].some(id => !ids.has(id))) reject('an unknown fact is cited');
  if ([...ids].some(id => !cited.has(id))) reject('a fact is left out');
  const lines = work.lines.map(line => line.trim()), body = [work.title.trim(), ...lines].join('\n'), text = plain(body);
  const source = [facts.title, facts.refrain, ...facts.names, ...facts.facts.map(fact => fact.text)].join('\n'), known = plain(source);
  for (const fact of facts.facts) for (const anchor of fact.anchors) if (!text.includes(plain(anchor))) reject('“' + anchor + '” is missing');
  for (const anchor of ALL_ANCHORS) if (!known.includes(plain(anchor)) && text.includes(plain(anchor))) reject('“' + anchor + '” belongs to another account');
  for (const number of text.match(/\d+/g) || []) if (!known.includes(number)) reject('an invented number');
  const taught = lexicon.map(plain);
  for (const word of body.match(BLOCKED) || []) if (!taught.some(allowed => plain(word).startsWith(allowed.slice(0, 7)))) reject('“' + word + '” is not a word this world has');
  // A capitalised word in the middle of a sentence is a name: it must be one the facts gave.
  const given = new Set(source.match(WORDS) || []);
  for (const line of lines) for (const match of line.matchAll(WORDS)) {
    const word = match[0];
    if (word === 'I' || word.startsWith('I’') || word.startsWith("I'") || word[0] === word[0].toLowerCase() || given.has(word)) continue;
    if (!/^[\s“‘"'(—–-]*$/.test(line.slice(0, match.index).split(/[.!?…:;]/).pop())) reject('“' + word + '” is not a name the facts gave');
  }
  return { title: work.title.trim(), lines, referencedEventIds: [...cited] };
}
/** The authored version: the fact sentences, in the writer's own frame. */
export function fallbackStoryWork(facts) {
  // A page that knew the courier's road speaks for itself, and ends on its own last line.
  if (facts.journey) return { title: facts.title, lines: facts.facts.map(fact => fact.text), referencedEventIds: facts.facts.map(fact => fact.id) };
  const frame = STORY_FRAMES[facts.stance] || STORY_FRAMES.curious;
  const refrain = facts.refrain ? ' ' + facts.refrain[0].toUpperCase() + facts.refrain.slice(1) + '.' : '';
  return { title: facts.title, lines: [frame.open, ...facts.facts.map(fact => fact.text), frame.close + refrain],
    referencedEventIds: facts.facts.map(fact => fact.id) };
}
