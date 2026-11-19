import { applyLivingWorldEventOnce } from './livingworldstate.mjs?v=courier1';
import { createItem, transferItem } from './npcitems.mjs';
import { applyRelationshipDelta, rememberSocialMemory } from './npcsocialmemory.mjs';
import { DROPPED_THANKS, POST_LIVE_CAP, SATCHEL_SLOTS, STORY_LETTER, STORY_MEMORY, droppedLetterClues, dailyPostCount, fill, letterTopic, topicById, wantsReply } from './courierpost.mjs';
import { COURIER_VERSION, COURIER_SCENARIO, COURIER_JOBS, COURIER_ROLES,
  COURIER_EVIDENCE, COURIER_THREADS, courierSources, validateCreativeWork,
  fallbackCreativeWork, upgradeCourierOnboarding, COURIER_ENDING, courierRank, courierText } from './couriercontent.mjs';
import { HORIZON_ARCHIVIST, HORIZON_REACTIONS, LIGHTHOUSE_ORDER_GAP_DAYS, SPOUSE_FETCH_HOURS, SPOUSE_HOME_HOUR, feverPowdersDef, horizonLetterDef, horizonPage, keeperLog, twoHandsWork, jobSlots, keeperLogReaction, lampOutLetters, lighthouseOrderDef, lighthouseReplyDef } from './courierlighthouse.mjs';
import { STORY_WORD, recordEnding, recordHorizonFiled, storyEnding, storyNeeds, validateStoryWork, STORY_FIRST, STORY_GLITCHES, STORY_REACTIONS, accountDef, beatDone, beatOpen, recordVoice, stanceOf, storyStage, fallbackStoryWork, recordAccount, recordCompared, recordPattern, storyFacts, storyHash,
  storyRefrain, storyThreads, tellById, upgradeCourierPlot } from './courierstory.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity;
// How close the courier must be to act. These match the reach that offers the action in the first place:
// a conversation opens within the station keeper's TALK_RANGE (6.5 m), and a board's E prompt shows within 5 m
// (courierruntime nearbyBoards). With a shorter reach here, a Deliver or Accept button offered in an open
// conversation answered "Find the recipient before handing it over" to a courier standing 5 m from them.
const PERSON_REACH = 6.5, BOARD_REACH = 5;
const fail = reason => ({ ok: false, applied: false, reason });
const firstName = name => String(name || '').split(' ')[0];
// What the archivist says, once the courier has seen the pattern, as they file the keeper's page about the horizon.
const HORIZON_NAMED = 'Then, quietly, as they file it: “A horizon that will not move, and a sea like a painted board. That is not a coast. That is a stage, and someone set it.”';
/** Write a commission into the story: its definition, and its state, offered. */
function addCommission(story, def, state = 'offered') {
  story.plot.jobs[def.id] = def;
  story.jobs[def.id] = { id: def.id, state, attempts: 0, condition: 'intact', roughSeconds: 0, itemId: 'courier:item:' + def.id };
  return def;
}
const itemId = job => 'courier:item:' + job.id;
/**
 * A new courier draws a story seed once and keeps it; `storySeed` pins it (a
 * debug URL parameter). An older save derives its seed from its run, so it
 * upgrades to the same story every time.
 */
export function initializeCourier(state, bindings, { storySeed = null } = {}) {
  if (state.courier) { upgradeCourierPlot(state.courier); return upgradeCourierOnboarding(state.courier); }
  for (const role of Object.keys(COURIER_ROLES)) {
    if (!state.entities[bindings.cast[role]?.id]) throw new Error('Missing canonical courier resident: ' + role);
  }
  state.courier = {
    version: COURIER_VERSION, scenarioId: COURIER_SCENARIO,
    runId: globalThis.crypto?.randomUUID?.() || String(Date.now()) + ':' + Math.random(),
    bindings: clone(bindings), sequence: 0,
    jobs: Object.fromEntries(COURIER_JOBS.map(j => [j.id, { id: j.id, state: 'offered',
      attempts: 0, condition: 'intact', roughSeconds: 0, itemId: itemId(j) }])),
    knownOffers: {}, evidence: {}, compared: {}, knowledge: {}, works: {}, hypothesis: false, concluded: false,
    travel: { distances: {}, visited: {}, observations: [] }, resume: null, mount: null,
  };
  const seed = Number.isFinite(storySeed) ? storySeed >>> 0
    : globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] : storyHash(state.courier.runId);
  upgradeCourierPlot(state.courier, { seed });
  return upgradeCourierOnboarding(state.courier);
}
export class CourierController {
  constructor({ getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace = null, getPlace = null, getRoutes = null, save = () => true, director = null,
    onWatch = null, atGallery = null, lampTurning = null, nightWords = null }) {
    // `onWatch(npcId)`: a lighthouse keeper is up at the lamp; `atGallery()`: the courier is on its gallery;
    // `lampTurning()`: the lamp is lit tonight; `nightWords(npcId)`: after dark, within sight of a lighthouse, how to walk home by its flash.
    Object.assign(this, { getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace, getPlace, getRoutes, save, director,
      onWatch: onWatch || (() => false), atGallery: atGallery || (() => false), lampTurning: lampTurning || (() => false), nightWords: nightWords || (() => null) });
    this.previousPosition = null;
    this.workRequests = new Map();
    // Generated editions waiting to be read; the one read first is saved for good.
    this.pendingWorks = new Map();
    // A job a resident has just held out in conversation, waiting for the courier's yes or no.
    this.pendingOffers = new Map();
    this.listeners = new Set();
  }
  get state() { return this.getState(); }
  get story() { return this.state.courier; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(result) { for (const listener of this.listeners) listener(result); return result; }
  roleFor(npcId) { return Object.keys(this.story?.bindings.cast || {}).find(role => this.story.bindings.cast[role]?.id === npcId); }
  /** Someone on the round, by the name the story knows them under. */
  npc(who) { return this.story?.bindings.cast[who] || this.story?.plot?.people?.[who]; }
  /** How the story knows a resident: their tutorial role, or their own id for anyone a commission names. */
  whoFor(npcId) { return this.roleFor(npcId) || (this.story?.plot?.people?.[npcId] ? npcId : undefined); }
  /** The key of a place the story knows: a tutorial village by key or settlement id, or anywhere the game can resolve. */
  placeKey(value) {
    const places = this.story?.bindings.places || {};
    if (!value) return null;
    if (places[value]) return value;
    return Object.keys(places).find(key => places[key].id === value) || (this.getPlace?.(value) ? value : null);
  }
  place(value) { const key = this.placeKey(value); return key ? this.story.bindings.places[key] || this.getPlace(key) : null; }
  placeName(value) { return this.place(value)?.name || ''; }
  /** Where someone on the round belongs, as a place key. */
  placeOf(who) { return this.npc(who)?.place || null; }
  /** The tutorial's six commissions and the seventh, then whatever settlements have posted since. */
  jobs() { return [...COURIER_JOBS, ...Object.values(this.story?.plot?.jobs || {})]; }
  jobDef(id) { return COURIER_JOBS.find(job => job.id === id) || this.story?.plot?.jobs?.[id] || null; }
  nearby(npcId) {
    const entity = this.state.entities[npcId];
    const player = this.getPlayer(), at = this.getNpcPosition(npcId);
    // Up a tower or down a stair is not within reach, however close on the map.
    if (Number.isFinite(player?.y) && Number.isFinite(at?.y) && Math.abs(player.y - at.y) > 4.5) return false;
    return !!entity && !entity.tombstone && !entity.inTransit && distance(player, at) <= PERSON_REACH;
  }
  commit(type, payload, reduce, stableId = null) {
    const id = stableId || 'courier:' + type + ':' + (this.story.sequence + 1);
    const event = { id, type: 'courier.' + type, atHour: this.state.clock.worldHours, payload };
    const result = applyLivingWorldEventOnce(this.state, event, (draft, incoming) => {
      draft.courier.sequence++;
      return reduce(draft, incoming);
    });
    const persisted = !result.applied || this.save() !== false;
    return this.changed({ ...result, ok: true, persisted, ...result.result });
  }
  remember(state, npcId, event, summary, provenance = 'observed') {
    rememberSocialMemory(state, npcId, {
      id: 'memory:' + event.id + ':' + npcId, lineageId: event.id + ':' + npcId,
      subject: { kind: 'player', id: state.playerId }, predicate: event.type,
      object: event.payload, summary, source: { kind: 'world-event', id: event.id },
      provenance, originEventId: event.id, privacy: 'personal', confidence: 1,
      salience: 0.7, createdAtHour: event.atHour,
    });
  }
  chooseWelcome(choice) {
    if (!['easy', 'explain', 'explore'].includes(choice)) return fail('Choose how you would like to begin.');
    return this.commit('welcome', { choice }, draft => {
      Object.assign(draft.courier.onboarding, { seen: true, choice });
      if (choice === 'easy') draft.courier.focusJobId = 'village-note';
      return { message: choice === 'easy' ? this.contactDirections('village-note') : choice === 'explain'
        ? 'Ask a local about work, read a Post & Errands board, and collect any parcel you choose from its sender. Your book keeps the next step.'
        : 'Explore freely. Post & Errands boards and local people can help you find work when you want it.' };
    });
  }
  /**
   * The dispatcher walks over and talks the new courier through the work.
   * Kept in memory only: a reload part way starts the welcome again, and
   * the save records only how it ended.
   */
  startWelcome(npcId, lines) {
    if (!npcId || !lines?.length || this.story?.onboarding?.seen !== false) return null;
    return this.welcome = { npcId, step: 0, lines };
  }
  endWelcome(choice = 'explore') {
    if (!this.welcome) return null;
    this.welcome = null;
    return this.story?.onboarding?.seen === false ? this.chooseWelcome(choice) : null;
  }
  setHints(enabled) {
    return this.commit('hints', { enabled: !!enabled }, draft => {
      draft.courier.onboarding.hintsEnabled = !!enabled; return {};
    });
  }
  placeForNpc(npcId) {
    const role = this.roleFor(npcId);
    if (role) return this.placeOf(role);
    const provided = this.placeKey(this.getNpcPlace?.(npcId));
    if (provided) return provided;
    const entity = this.state.entities[npcId], household = this.state.households?.[entity?.householdId];
    return this.placeKey(household?.settlementId || entity?.homeSettlementId);
  }
  boardJobs(place) {
    const key = this.placeKey(place);
    if (!key) return [];
    return this.jobs().filter(j => this.placeOf(j.sender) === key).map(j => ({
      ...j, state: this.story.jobs[j.id].state, sender: clone(this.npc(j.sender)),
      recipient: clone(this.npc(j.recipient)), destinationName: this.placeName(this.placeOf(j.recipient)),
      senderPlaceName: this.placeName(this.placeOf(j.sender)),
    }));
  }
  localOpportunities(npcId) {
    return this.boardJobs(this.placeForNpc(npcId)).filter(j => !['active', 'delivered'].includes(j.state));
  }
  storeLead(story, job, source, atHour) {
    story.knownOffers[job.id] = true;
    story.leads['job:' + job.id] ||= { jobId: job.id, source: clone(source), learnedAtHour: atHour,
      summary: job.title + ': ask ' + this.npc(job.sender).name + ' in ' + this.placeName(this.placeOf(job.sender)) + '.' };
  }
  readBoard(place) {
    place = this.placeKey(place);
    if (!place || distance(this.getPlayer(), this.getSourcePosition('board:' + place)) > BOARD_REACH)
      return fail('Stand beside the Post & Errands board to read its notices.');
    const jobs = this.boardJobs(place);
    // The keeper's note hangs on the board where their word reached the courier.
    const note = this.story.plot.closer?.lamp && this.placeKey(this.story.plot.closer.lamp) === place ? this.keeperCall() : null;
    const unseen = jobs.some(j => !this.story.leads['job:' + j.id]);
    if (!unseen) return { ok: true, applied: false, jobs, ...(note ? { note } : {}), message: 'These public notices are in your Leads page. Collect a parcel from its sender.' };
    return this.commit('board-read', { place }, (draft, event) => {
      for (const card of jobs) this.storeLead(draft.courier, this.jobDef(card.id),
        { kind: 'board', id: 'board:' + place, name: 'Post & Errands, ' + this.placeName(place) }, event.atHour);
      return { jobs, ...(note ? { note } : {}), message: 'Notices copied to Leads. Visit the sender to ask about a parcel; reading a notice accepts no work.' };
    });
  }
  learnReferrals(npcId, place = this.placeForNpc(npcId)) {
    if (!place || place !== this.placeForNpc(npcId) || !this.nearby(npcId)) return fail('Ask someone nearby about their local errands.');
    const jobs = this.localOpportunities(npcId);
    if (!jobs.some(j => !this.story.leads['job:' + j.id])) return { ok: true, applied: false, jobs };
    return this.commit('referral', { npcId, place }, (draft, event) => {
      for (const card of jobs) this.storeLead(draft.courier, this.jobDef(card.id),
        { kind: 'npc', id: npcId, name: this.state.entities[npcId].name || 'A local resident' }, event.atHour);
      return { jobs };
    });
  }
  focusJob(jobId) {
    if (!this.story?.jobs[jobId] || !(this.story.knownOffers[jobId] || this.story.jobs[jobId].state === 'active'
      || this.deliveredCount() > 0 || (jobId === 'village-note' && this.story.onboarding.choice === 'easy'))) return fail('Learn about this errand from a notice or a local person first.');
    return this.commit('focus', { jobId }, draft => { draft.courier.focusJobId = jobId; return {}; });
  }
  /** Where a cast member is now if they are loaded nearby, otherwise their home. */
  whereIs(role) {
    const person = this.npc(role);
    if (!person) return null;
    const live = this.getNpcPosition?.(person.id);
    // Only a resident streamed in around the player has a meaningful position.
    if (live && Number.isFinite(live.x) && Number.isFinite(live.z) && distance(this.getPlayer?.(), live) < 400)
      return { x: live.x, z: live.z, live: true };
    return person.home && Number.isFinite(person.home.x) ? { x: person.home.x, z: person.home.z, live: false } : null;
  }
  /**
   * How to set about finding someone. Deliberately no live distance or
   * bearing: the courier is told an address and how the country is signed,
   * and finding the way is their craft.
   */
  wayTo(role) {
    const person = this.npc(role), places = this.story.bindings.places, there = this.place(this.placeOf(role));
    if (!person || !there) return '';
    const player = this.getPlayer?.(), home = person.home?.address || 'known to people in ' + there.name;
    // Where the courier knows they are (the last name sign, board or station
    // they passed), when the game tracks it; otherwise the nearest village.
    const known = this.getKnownPlace ? this.place(this.getKnownPlace()) : undefined;
    const here = known !== undefined ? known : player && Object.values(places).filter(place => Number.isFinite(place.x))
      .reduce((best, place) => !best || distance(player, place) < distance(player, best) ? place : best, null);
    const same = !!here && (here === there || (!!here.id && here.id === there.id));
    if (same && (known !== undefined || distance(player, there) < 450)) return there.kind === 'lighthouse'
      ? 'Their home is ' + home + '. The house is at the top of the ramp, below the tower.'
      : 'Their home is ' + home + '. Find the well and use your compass, or ask anyone nearby to point the way.';
    const train = here?.stationId && there.stationId && !same;
    const what = there.kind === 'lighthouse' ? ' stands on its own out on the coast. ' : there.kind === 'town' ? ' is a town. ' : ' is another village. ';
    return there.name + what + (train ? 'The regional train stops there; on foot or horseback, ' : 'To get there, ')
      + 'follow the road posts marked “' + there.name + '” (anyone can point out the first one). Once there, their home is ' + home + '.';
  }
  /** Places taken in the satchel: most things take one, heavy cargo takes two. */
  satchelLoad(story = this.story) {
    return Object.values(story?.jobs || {}).filter(job => job.state === 'active')
      .reduce((sum, job) => sum + jobSlots(this.jobDef(job.id)), 0);
  }
  /** Heavy cargo the courier is carrying, if any: on foot it keeps them to a walk. */
  carryingHeavy() {
    return this.jobs().find(def => def.heavy && this.story?.jobs[def.id]?.state === 'active') || null;
  }
  deliveredCount() { return Object.values(this.story.jobs).filter(j => j.state === 'delivered').length + (this.story.plot?.delivered || 0); }
  standing() {
    const delivered = this.deliveredCount();
    return { delivered, total: this.jobs().length + (this.story.plot?.delivered || 0), rank: courierRank(delivered) };
  }
  /** A pair of accounts the courier holds but has not yet compared. */
  readyThread() {
    const thread = storyThreads(this.story).find(item => item.ready && !item.compared);
    return thread ? { id: thread.tell.id, title: thread.tell.title } : null;
  }
  contactDirections(jobId) {
    const def = this.jobDef(jobId), sender = def && this.npc(def.sender);
    if (!sender) return 'Ask a local about work or look for the Post & Errands board by a village well.';
    const atDesk = def.sender === 'dispatcher' && this.story.jobs['village-note'].state !== 'delivered';
    return sender.name + ' has ' + def.title + '. '
      + (atDesk ? 'They work at the post desk beside the well in ' + this.placeName(this.placeOf(def.sender)) + '.' : this.wayTo(def.sender))
      + ' Walk up, press T to talk, then choose Accept.';
  }
  guidance() {
    const story = this.story;
    const thread = this.readyThread();
    if (thread) return { title: 'Two accounts do not agree', view: 'stories',
      text: 'You now hold both accounts of “' + thread.title + '”. Open your book (N), choose Story and compare them.' };
    if (beatOpen(story, 'pattern'))
      return { title: 'A pattern is forming', view: 'stories', text: 'You have compared two sets of accounts. Open your book (N), choose Story and consider the larger pattern.' };
    const active = Object.values(story.jobs).filter(j => j.state === 'active');
    const focused = story.jobs[story.focusJobId];
    const job = focused?.state === 'active' ? focused : active[0];
    if (job) {
      const def = this.jobDef(job.id), recipient = this.npc(def.recipient);
      if (def.unaddressed) return { title: 'Whose letter is this?', jobId: job.id,
        text: def.clues.slice(1).join(' ') + ' Ask around in that place, and tell whoever it belongs to that you have their letter.' };
      return { title: 'Deliver ' + def.title, jobId: job.id,
        text: 'Take it to ' + recipient.name + ' in ' + this.placeName(this.placeOf(def.recipient)) + '. '
          + this.wayTo(def.recipient) + ' Walk up, press T to talk, then choose Deliver.' };
    }
    const later = this.storyGuidance();
    if (later) return later;
    // A job the player passed on is not suggested again; they can still ask for it.
    const open = j => ['offered', 'returned'].includes(story.jobs[j.id].state);
    if (focused && open(focused)) return { title: 'Collect ' + this.jobDef(focused.id).title, jobId: focused.id, text: this.contactDirections(focused.id) };
    const player = this.getPlayer?.();
    const reach = j => { const at = this.whereIs(j.sender); return at && player ? distance(player, at) : Infinity; };
    const next = this.jobs().filter(open).sort((a, b) => Number(!story.knownOffers[a.id]) - Number(!story.knownOffers[b.id]) || reach(a) - reach(b))[0];
    if (next && (story.knownOffers[next.id] || this.deliveredCount() > 0 || story.onboarding.choice === 'easy'))
      return { title: 'Next errand: ' + next.title, jobId: next.id, text: this.contactDirections(next.id) };
    if (next) return { title: 'Find work when you want it', text: 'Press E at the Post & Errands board beside the village well, or press T beside anyone and ask “Is there any delivery work?” N opens your book. You can also just explore.' };
    const ended = beatDone(story, 'ending');
    return { title: ended ? 'The round is yours' : 'Every parcel is delivered',
      text: ended ? 'You have read the last letter. Wander as you like; your book keeps it all.'
        : 'Read the public accounts by village wells wherever you go, and compare them in your book’s Story page.' };
  }
  /**
   * The next step of the story itself, once there is a pattern. It names
   * people and places, never a direction or a distance: the courier finds
   * them the way they find anyone.
   */
  storyGuidance() {
    const story = this.story, plot = story.plot;
    if (beatDone(story, 'ending')) return null;
    if (beatOpen(story, 'ending') && plot.closer?.lamp) return { title: 'The keeper has asked for you',
      text: this.keeperCall() + ' Go to ' + plot.closer.siteName + ' for lamp-time, climb the stair to the gallery after dark, press T beside ' + firstName(plot.closer.name) + ', then choose “Show what I found”.' };
    if (beatOpen(story, 'ending') && plot.closer) return { title: 'Someone has asked for you',
      text: plot.closer.name + ' in ' + plot.closer.siteName + ' has asked for the courier. Find them (anyone there can point), press T, then choose “Show what I found”.' };
    if (beatOpen(story, 'ending')) return { title: 'Something is finishing', text: 'Someone near where you are will want to see what you carry. Keep going about.' };
    const handed = Object.entries(plot.sites).flatMap(([siteId, site]) => site.offers.filter(offer => offer.ch === 'handed' && !story.evidence[offer.a])
      .map(offer => ({ ...plot.accounts[offer.a], beat: accountDef(offer.a).journey ? 'turn' : 'other' }))).filter(item => item.by)
      // Whoever is where the courier is now comes first; then the most recent.
      .sort((a, b) => Number(b.site === plot.pacing.last) - Number(a.site === plot.pacing.last))[0];
    if (handed) return { title: handed.beat === 'turn' ? 'Something was left for you' : 'Someone has written something down',
      text: handed.name + ' in ' + handed.siteName + ' has something to give you in person. Ask anyone there for ' + handed.name + ', then press T beside them.' };
    if (beatDone(story, 'pattern') && !beatDone(story, 'named')) return { title: 'Somebody will have tried to say it',
      text: 'You see the pattern. Somewhere, somebody has been trying to put it into words. Keep reading the boards wherever you go.' };
    if (beatDone(story, 'named') && !beatDone(story, 'voices')) return { title: 'What do people make of it?',
      text: 'Show people what you carry and hear what they make of it: press T beside anyone, then “Show what I carry”.' };
    return null;
  }
  /**
   * The keeper's note, as it hangs on the board where the word reached the
   * courier: they are wanted at the lighthouse at lamp-time. Null unless the
   * keeper is the one who asked.
   */
  keeperCall() {
    const closer = this.story?.plot?.closer;
    if (!closer?.lamp || !beatOpen(this.story, 'ending')) return null;
    return 'A note from ' + closer.name + ' of ' + closer.siteName + ': “I hear the courier carries papers that do not agree. Come to me at lamp-time, up the stair to the gallery, and bring everything you carry. I will be at the lamp.”';
  }
  /**
   * Is the keeper's reading ready to happen: the keeper up at the lamp, the
   * lamp lit, and the courier with them on the gallery? Null when it is, or
   * for any other closer; otherwise why not yet.
   */
  galleryWait(speakerId) {
    const closer = this.story.plot.closer;
    if (!closer?.lamp || closer.id !== speakerId) return null;
    const first = firstName(closer.name);
    if (!this.onWatch(speakerId)) return first + ' asked for you at lamp-time, up at the lamp. Come back as the light goes, and climb the stair to the gallery.';
    if (!this.atGallery()) return first + ' is up at the lamp. Climb the stair and find them on the gallery.';
    if (!this.lampTurning()) return first + ' is lighting the lamp. Wait for it to catch.';
    return null;
  }
  /** How the closer opens the conversation. The keeper, before lamp-time or off the gallery, asks the courier to come back then. */
  closerCalling(speakerId) {
    const closer = this.story.plot.closer;
    if (!closer.lamp) return { calling: closer.name + ' has been watching the lane. “You are the courier. They say you carry papers that do not agree. I asked for you. Show me.”' };
    if (this.galleryWait(speakerId)) return { calling: firstName(closer.name) + ' knows you at once. “You had my note. Not here, and not by daylight. Come up to the lamp after dark, and bring everything you carry.”', callingLater: true };
    return { calling: firstName(closer.name) + ' turns from the lamp as you come out onto the gallery. “You came up. They say you carry papers that do not agree. I asked for you here, where the light goes round and nobody hurries us. Show me.”' };
  }
  /** The closer hears it all, and the last letter is read. */
  finish(speakerId) {
    const closer = this.story.plot.closer;
    if (!closer || closer.id !== speakerId || !beatOpen(this.story, 'ending')) return fail('There is nobody here waiting for what you found.');
    const wait = this.galleryWait(speakerId);
    if (wait) return fail(wait);
    if (!this.nearby(speakerId)) return fail('Stand beside ' + closer.name + ' to show them.');
    return this.commit('ending', { speakerId }, (draft, event) => {
      recordEnding(draft.courier); draft.courier.plot.endedAtHour = event.atHour;
      this.remember(draft, speakerId, event, closer.lamp ? 'I read everything the courier carried, up at the lamp, and gave them the last letter.'
        : 'I read everything the courier carried, and gave them the last letter.', 'observed');
      return { ending: this.endingDoc(draft.courier), message: closer.name + (closer.lamp ? ' reads everything you carry, by the light of the lamp.' : ' reads everything you carry.') };
    }, 'courier:ending');
  }
  endingDoc(story = this.story) {
    if (!story.plot.closer) return null;
    const closer = story.plot.closer, ending = storyEnding(story, closer.name, { light: closer.lamp ? closer.siteName : null });
    return { title: ending.title, text: ending.lines.join('\n\n') };
  }
  learnOffer(jobId, speakerId) {
    const def = this.jobDef(jobId);
    if (!def || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)) return fail('Talk to the sender to learn about this job.');
    if (this.story.leads['job:' + jobId]) return { ok: true, applied: false };
    return this.commit('offer-seen', { jobId, speakerId }, (draft, event) => {
      this.storeLead(draft.courier, def, { kind: 'npc', id: speakerId, name: this.npc(def.sender).name }, event.atHour);
      return { jobId };
    });
  }
  accept(jobId, speakerId) {
    const def = this.jobDef(jobId), job = this.story?.jobs[jobId];
    if (!def || !job || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)) return fail('Accept the parcel beside its sender.');
    if (job.state === 'active' || job.state === 'delivered') return fail('This commission is already accepted or complete.');
    if (this.satchelLoad() + jobSlots(def) > SATCHEL_SLOTS) return fail(jobSlots(def) > 1 && this.satchelLoad() < SATCHEL_SLOTS
      ? def.title + ' takes ' + jobSlots(def) + ' places in your satchel. Deliver something first to make room.'
      : 'Your satchel is full. Deliver or return a parcel to make room.');
    const currentItem = this.state.projections.items[job.itemId];
    if (currentItem && currentItem.ownerId !== speakerId) return fail('The sender does not have this parcel.');
    const briefing = def.sender === 'dispatcher' ? this.dispatcherBriefing(def) : null;
    return this.commit('accepted', { jobId, speakerId }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      createItem(draft, { id: current.itemId, kind: def.kind, ownerId: speakerId,
        purpose: 'courier', condition: current.condition });
      transferItem(draft, current.itemId, draft.playerId, { eventId: event.id });
      current.state = 'active'; current.attempts++; current.acceptedAtHour = event.atHour;
      if (def.dynamic) current.receipts = [...(current.receipts || []), event.id];
      draft.courier.knownOffers[jobId] = true;
      draft.courier.focusJobId = jobId;
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: 'accepted', condition: current.condition };
      this.remember(draft, speakerId, event, 'The traveller accepted ' + def.title + '.');
      const carried = this.grantEvidence(draft.courier, def.carries);
      return { jobId, message: def.title + ' is in your satchel.'
        + (carried ? ' It comes with “' + carried.title + '”, now in your book under Story.' : '')
        + (briefing ? ' ' + briefing.text : ''), ...(briefing ? { briefing } : {}) };
    });
  }
  /**
   * The dispatcher teaches the trade as they hand a note over: which way to
   * go, pointing as they say it, and to ask people along the road. Returns
   * the words and the place they point at.
   */
  dispatcherBriefing(def) {
    const recipient = this.npc(def.recipient);
    const fromKey = this.placeOf(def.sender), toKey = this.placeOf(def.recipient), there = this.place(toKey);
    if (!recipient || !there) return null;
    if (toKey === fromKey) {
      const where = String(recipient.home?.address || '').replace(/^[^,]*,\s*/, '');
      return { text: recipient.name + '’s home is that way' + (where ? ', ' + where : '') + '. I won’t walk you there: if you lose the way, ask anyone you meet and they will point. Come back to the board when it is done.',
        point: recipient.home && { id: 'home:' + recipient.id, name: recipient.home.name, x: recipient.home.x, z: recipient.home.z },
        directions: { id: 'route:dispatcher:' + def.recipient, title: 'Directions to ' + recipient.name + '’s home' } };
    }
    const route = (this.story.bindings.routes?.[fromKey] || []).find(item => item.place === toKey);
    const target = route?.target;
    return { text: 'For ' + there.name + ', take the road out that way, past ' + (target?.name || 'the first road post') + ', and follow the posts marked “' + there.name + '”.'
      + (route?.walk ? ' It is ' + route.walk + ' on foot.' : '') + ' Ask along the way; anyone you meet can point you on. When you pass the ' + there.name + ' name board, you are there.',
      point: target && Number.isFinite(target.worldX) ? { id: target.id, name: target.name, x: target.worldX, z: target.worldZ } : null,
      directions: { id: 'route:dispatcher:' + toKey, title: 'Directions to ' + there.name } };
  }
  decline(jobId, speakerId) {
    const def = this.jobDef(jobId), job = this.story?.jobs[jobId];
    if (!def || !job || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)
      || ['active', 'delivered'].includes(job.state)) return fail('This offer cannot be declined here.');
    if (job.state === 'declined') return { ok: true, applied: false, message: 'You can ask about this errand again whenever you like.' };
    return this.commit('declined', { jobId, speakerId }, (draft, event) => {
      draft.courier.jobs[jobId].state = 'declined'; draft.courier.knownOffers[jobId] = true;
      if (def.dynamic) draft.courier.jobs[jobId].receipts = [...(draft.courier.jobs[jobId].receipts || []), event.id];
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: 'declined', condition: job.condition };
      return { jobId, message: 'Of course. You can ask again whenever you like.' };
    });
  }
  handoff(jobId, speakerId, returning = false) {
    const def = this.jobDef(jobId), job = this.story?.jobs[jobId];
    if (!def || !job) return fail('Unknown commission.');
    if (!returning && job.state === 'delivered') return { ok: true, duplicate: true, applied: false };
    const target = this.npc(returning ? def.sender : def.recipient)?.id;
    // After dark the keeper is up at the lamp, and post is handed over there.
    const watching = !returning && def.lighthouse && target === speakerId && this.onWatch(target), up = watching && this.atGallery();
    if (watching && !up) return fail(firstName(this.npc(target)?.name || 'The keeper') + ' is up at the lamp. Take it up the stair and hand it over on the gallery.');
    if (target !== speakerId || !this.nearby(target)) return fail('Find the ' + (returning ? 'sender' : 'recipient') + ' before handing it over.');
    if (job.state !== 'active' || this.state.projections.items[job.itemId]?.ownerId !== this.state.playerId) return fail('That parcel is not in your satchel.');
    if (!returning && def.night && !up) return fail(def.early || 'This is wanted on the watch: bring it up to the gallery after dark.');
    return this.commit(returning ? 'returned' : 'delivered', { jobId, speakerId, condition: job.condition }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      transferItem(draft, current.itemId, target, { eventId: event.id, condition: current.condition });
      current.state = returning ? 'returned' : 'delivered';
      if (def.dynamic) current.receipts = [...(current.receipts || []), event.id];
      if (!returning) current.deliveredAtHour = event.atHour;
      const knowledge = draft.courier.knowledge[target] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: current.state, condition: current.condition };
      this.remember(draft, target, event, returning ? 'The traveller returned ' + def.title + '.'
        : 'The traveller delivered ' + def.title + (current.condition === 'chipped' ? (def.lighthouse ? ', cracked.' : ', with a chipped cup.') : '.'));
      if (!returning && def.lighthouse && def.standing) this.noteLighthouseDelivery(draft.courier);
      // The keeper's horizon page, filed in the archive, names what the pattern is.
      const named = !returning && def.horizon && recordHorizonFiled(draft.courier);
      if (!returning) applyRelationshipDelta(draft, target, draft.playerId,
        { familiarity: 0.08, trust: current.condition === 'chipped' ? 0.01 : 0.04 }, event);
      // Reading someone else's post is noticed, and not everyone forgives it.
      if (!returning && def.story && current.opened && ['afraid', 'denying'].includes(stanceOf(this.story, target)))
        applyRelationshipDelta(draft, target, draft.playerId, { trust: -0.05 }, event);
      // A letter that asks for an answer: the recipient writes it there and then, for you to carry back.
      const reply = returning ? null : this.replyFor(draft.courier, def);
      const next = reply || (!returning && this.jobs().find(j => this.npc(j.sender)?.id === target
        && !['active', 'delivered'].includes(draft.courier.jobs[j.id]?.state)));
      if (next) this.storeLead(draft.courier, next, { kind: 'npc', id: target, name: this.state.entities[target].name }, event.atHour);
      const nextLead = returning ? null : next ? { jobId: next.id, title: next.title }
        : { place: this.placeOf(def.recipient), kind: 'reading-stand' };
      const revealed = returning ? null : this.grantEvidence(draft.courier, def.reveals);
      const thanks = jobId === 'village-note' ? 'The guide opens your note and sets it beside the trail papers. Your first delivery is complete.'
        : (this.deliveryWords(def, current) || 'Thank you. This will be put to good use.')
          + (current.condition === 'chipped' && !def.lighthouse ? ' “A small chip, but it still holds tea.”' : '')
          + (named ? ' ' + HORIZON_NAMED : '');
      const delivered = Object.values(draft.courier.jobs).filter(j => j.state === 'delivered').length;
      const rank = courierRank(delivered), promoted = !returning && rank !== courierRank(delivered - 1);
      // Delivered after dark where the light can be seen: the way home is given by its flash.
      const night = returning ? null : this.nightWords(target);
      return { jobId, nextLead, revealed: revealed?.id || null, standing: { delivered, total: this.jobs().length, rank }, ...(night ? { nightWords: night } : {}),
        message: returning ? 'The parcel is safely back with its sender.' : thanks
          + (revealed ? '\nNew in your book: “' + revealed.title + '”.' : '')
          + (night ? ' “' + night + '”' : '')
          + '\n' + delivered + ' of ' + this.jobs().length + ' delivered' + (promoted ? ' — you are now “' + rank + '”.' : '.')
          + (reply ? ' ' + firstName(this.state.entities[target].name) + ' wants to send an answer back, if you will carry it: ' + reply.title + '.'
            : next ? ' ' + this.state.entities[target].name + ' has another errand if you want it: ' + next.title + '.' : '') };
    }, returning ? null : 'courier:delivered:' + jobId);
  }
  /**
   * Every paper the courier could read at a board: the tutorial villages'
   * fixed accounts, and whatever the director has pinned up elsewhere.
   */
  sources() {
    const story = this.story;
    if (!story) return [];
    // Until the courier holds the dispatch sheet, it is the only paper a stand shows.
    const opened = !!story.evidence?.[STORY_FIRST];
    const fixed = courierSources(story.bindings).filter(source => opened || source.id === STORY_FIRST);
    const placed = Object.entries(story.plot?.sites || {}).flatMap(([siteId, site]) => site.offers
      .filter(offer => offer.ch === 'stand' && (opened || offer.a === STORY_FIRST)).map(offer => {
        const doc = this.accountDoc(offer.a), place = this.placeKey(siteId) || siteId;
        return doc && { id: offer.a, sourceId: offer.a + ':' + place, place,
          title: doc.title, text: doc.text, copy: doc.place && doc.siteId !== siteId ? doc.place : null };
      }).filter(Boolean));
    return [...fixed, ...placed];
  }
  /** The courier's real road so far: arrivals and deliveries, as the poem and the turn are told them. */
  journeyEvents() {
    const events = (this.story.travel?.observations || []).map(o => ({ id: o.id, summary: o.summary }));
    for (const [id, job] of Object.entries(this.story.jobs || {})) if (job.state === 'delivered') {
      const def = this.jobDef(id);
      if (def) events.push({ id: 'delivery:' + id, summary: 'Delivered ' + def.title + ' to ' + this.npc(def.recipient)?.name + (job.condition === 'chipped' ? ', with a chipped cup.' : '.') });
    }
    return events;
  }
  /** The facts a resident's account may be written from, and nothing else. */
  accountFacts(accountId) {
    const story = this.story, cast = story.plot.accounts[accountId];
    const names = Object.values(story.bindings?.cast || {}).map(person => person.name)
      .concat(Object.values(story.bindings?.places || {}).map(place => place.name));
    return storyFacts(accountId, { author: cast?.name || 'A resident', authorPlace: cast?.siteName || 'this village',
      stance: cast?.stance || 'curious', refrain: storyRefrain(story), events: this.journeyEvents(), names,
      render: text => courierText(text, story.bindings) });
  }
  /**
   * An account as the courier reads it. A tutorial account is its fixed text;
   * anyone else's is the edition saved when it was first read, else the
   * generated one waiting, else the authored version.
   */
  accountDoc(accountId) {
    const def = accountDef(accountId), story = this.story;
    if (!def || !story) return null;
    if (def.tutorial) {
      const evidence = COURIER_EVIDENCE.find(e => e.id === accountId), key = evidence.places[0];
      return { id: accountId, title: def.title, text: courierText(evidence.text, story.bindings), place: this.placeName(key), siteId: this.place(key)?.id || key };
    }
    const cast = story.plot.accounts[accountId];
    const kept = story.plot.works[accountId];
    const work = (kept?.source === 'lighthouse' ? this.lighthouseWork(accountId) : kept) || this.pendingWorks?.get(accountId) || fallbackStoryWork(this.accountFacts(accountId));
    return { id: accountId, title: work.title, text: work.lines.join('\n'), author: cast?.name || null,
      place: cast?.siteName || null, siteId: cast?.site || null, source: work.source || 'authored' };
  }
  /** A lighthouse paper the save keeps no prose for, written again from the seed and the names it was read with. */
  lighthouseWork(accountId) {
    const plot = this.story.plot, keeper = plot.accounts['two-hands-keeper']?.name || plot.accounts.horizon?.name || plot.accounts['keeper-log']?.name || 'the keeper';
    if (accountId === 'horizon') return { title: 'The horizon doesn’t move', lines: horizonPage({ keeper, light: plot.accounts.horizon?.siteName || 'the lighthouse' }) };
    if (accountId === 'keeper-log' || accountId === 'keeper-log-old') {
      const cast = plot.accounts[accountId], log = keeperLog({ seed: plot.seed, day: plot.works[accountId].day || 0, keeper: cast?.name || 'the keeper', light: cast?.siteName || 'the lighthouse' });
      return accountId === 'keeper-log' ? { title: 'The keeper’s log', lines: log.recent } : { title: 'The oldest log on the shelf', lines: log.oldest };
    }
    return twoHandsWork(accountId, { seed: plot.seed, keeper, spouse: plot.accounts['two-hands-spouse']?.name || null });
  }
  /**
   * Ask for a resident's account to be written while the courier is on the
   * way to it. Nothing is saved until it is read, and a story that has moved
   * on (restart) never receives a late answer.
   */
  prepareWork(accountId) {
    const story = this.story, def = accountDef(accountId), cast = story?.plot.accounts[accountId];
    if (!def || def.tutorial || !cast || story.plot.works[accountId] || this.pendingWorks.has(accountId) || this.workRequests.has(accountId)) return null;
    if (!this.director?.requestStoryWork) return null;
    const facts = this.accountFacts(accountId), token = story.runId;
    const lexicon = Object.keys(story.plot.lexicon[cast.by] || {});
    const promise = this.director.requestStoryWork(facts, { lexicon }).then(({ work, source }) => {
      if (this.story?.runId !== token || this.story.plot.works[accountId]) return null;
      let checked = null;
      try { checked = { ...validateStoryWork(work, facts, { lexicon }), source }; } catch { checked = { ...fallbackStoryWork(facts), source: 'authored' }; }
      this.pendingWorks.set(accountId, checked);
      return checked;
    }).catch(() => null).finally(() => this.workRequests.delete(accountId));
    this.workRequests.set(accountId, promise);
    return promise;
  }
  /** The courier now holds an account. A resident's own writing is fixed as it is first read. */
  takeAccount(story, accountId, siteId = null) {
    if (!accountDef(accountId)) return null;
    const isNew = recordAccount(story, accountId, siteId);
    const def = accountDef(accountId);
    if (isNew && !def.tutorial && !story.plot.works[accountId]) {
      const doc = this.accountDoc(accountId);
      story.plot.works[accountId] = { title: doc.title, lines: doc.text.split('\n'), source: doc.source };
      this.pendingWorks.delete(accountId);
    }
    return isNew ? def : null;
  }
  /** Record an account the courier was handed or shown; returns it when new. */
  grantEvidence(story, evidenceId) {
    const evidence = evidenceId && COURIER_EVIDENCE.find(e => e.id === evidenceId);
    // A resident's own account, shown on delivery by the person who wrote it.
    if (!evidence) {
      if (!evidenceId || !accountDef(evidenceId)) return null;
      const taken = this.takeAccount(story, evidenceId, story.plot.accounts[evidenceId]?.site || null);
      return taken && { id: evidenceId, title: this.accountDoc(evidenceId).title };
    }
    const isNew = !!this.takeAccount(story, evidence.id);
    const record = story.evidence[evidence.id], sourceId = evidence.id + ':' + evidence.places[0];
    if (!record.sourceIds.includes(sourceId)) record.sourceIds.push(sourceId);
    return isNew ? evidence : null;
  }
  discover(sourceId, speakerId = null) {
    const source = this.sources().find(s => s.sourceId === sourceId);
    if (!source) return fail('Unknown source.');
    const present = speakerId ? this.nearby(speakerId) && this.placeForNpc(speakerId) === source.place
      : distance(this.getPlayer(), this.getSourcePosition(sourceId)) <= 5;
    if (!present) return fail('Read this document where it is kept, or ask a local resident.');
    return this.commit('evidence-read', { sourceId, evidenceId: source.id, speakerId }, draft => {
      this.takeAccount(draft.courier, source.id, this.place(source.place)?.id || source.place);
      const evidence = draft.courier.evidence[source.id];
      if (!evidence.sourceIds.includes(sourceId)) evidence.sourceIds.push(sourceId);
      return { evidenceId: source.id, document: source };
    }, 'courier:source:' + sourceId);
  }
  compare(threadId) {
    const thread = tellById(threadId);
    if (!thread || thread.accounts.length < 2 || !thread.accounts.every(id => this.story.evidence[id])) return fail('Collect both accounts before comparing them.');
    return this.commit('compared', { threadId }, draft => {
      recordCompared(draft.courier, threadId);
      return { message: thread.comparison };
    }, 'courier:compared:' + threadId);
  }
  formHypothesis() {
    if (!beatOpen(this.story, 'pattern')) return fail('Compare discoveries from two different threads first.');
    return this.commit('hypothesis', {}, draft => {
      recordPattern(draft.courier);
      // The keeper's horizon page is already in the archive: someone has said what it is.
      if (beatDone(draft.courier, 'named')) return { message: 'Perhaps the records and recollections are repeating parts of other lives. And the keeper’s page about the horizon, filed in the archive, has already said what it is like: a sea painted on a board.' };
      return { message: 'Perhaps the records and recollections are repeating parts of other lives. Somebody, somewhere, will have tried to say what it is.' };
    }, 'courier:hypothesis');
  }
  /** People the story has cast near here: anyone who wrote what the courier carries, and the closer. */
  storyPeople(place) {
    const plot = this.story.plot, siteId = this.place(place)?.id, people = new Map();
    for (const [id, cast] of Object.entries(plot.accounts)) {
      if (cast.site !== siteId && !this.story.evidence[id]) continue;
      people.set(cast.by, { id: cast.by, name: cast.name, responsibility: 'wrote “' + this.accountDoc(id).title + '”', place: cast.siteName });
    }
    if (plot.closer) people.set(plot.closer.id, { id: plot.closer.id, name: plot.closer.name, responsibility: 'asking for the courier', place: plot.closer.siteName });
    return [...people.values()].slice(0, 12);
  }
  /** What this resident makes of it all, in the words the model is given. */
  beliefFor(npcId, knowledge = this.story.knowledge[npcId]) {
    if (!knowledge?.evidence?.length && !Object.values(this.story.plot.accounts).some(cast => cast.by === npcId)) return 'ordinary explanations seem plausible';
    return { afraid: 'frightened by the inconsistencies and would rather not look closer', relieved: 'relieved there may be a reason for how things feel',
      denying: 'sure there is an ordinary explanation, and a little irritated to be asked', curious: 'curious about the inconsistencies and eager to compare more' }[stanceOf(this.story, npcId)]
      + (knowledge?.avoids ? '; you have asked the courier to show you no more, and you avoid them' : '')
      + (knowledge?.evidence?.length ? '; the courier has shown you ' + knowledge.evidence.length + ' such papers and you remember each of them' : '')
      + '; you have no proof of their cause and no word for it beyond your own';
  }
  /** Papers this resident is waiting to put into the courier's hands. */
  handedHere(npcId) {
    const plot = this.story?.plot;
    if (!plot) return [];
    return Object.entries(plot.sites).flatMap(([siteId, site]) => site.offers
      .filter(offer => offer.ch === 'handed' && plot.accounts[offer.a]?.by === npcId && !this.story.evidence[offer.a]
        && (offer.a === STORY_FIRST || this.story.evidence[STORY_FIRST]))
      .map(offer => ({ accountId: offer.a, siteId, title: this.accountDoc(offer.a).title,
        text: courierText(String(accountDef(offer.a).handover || '{author} has something for you.').replaceAll('{author}', plot.accounts[offer.a].name), this.story.bindings) })));
  }
  /**
   * Nobody here has the word "simulation". Said to someone who does not
   * know it, they ask what it means; the courier's next words are kept as
   * its meaning, and from then on that person may use it.
   */
  teachWord(npcId, text, { lastAssistantText = '' } = {}) {
    const story = this.story, lexicon = story?.plot.lexicon;
    if (!lexicon || !this.state.entities[npcId]) return null;
    const known = !!lexicon[npcId]?.[STORY_WORD.id];
    if (!known && String(lastAssistantText).trim() === STORY_WORD.ask) {
      const meaning = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!meaning) return null;
      lexicon[npcId] = { ...lexicon[npcId], [STORY_WORD.id]: meaning };
      // A few people remember what they were taught: the most recent sixteen.
      const taught = Object.keys(lexicon);
      for (const id of taught.slice(0, Math.max(0, taught.length - 16))) delete lexicon[id];
      this.save(); this.changed({ ok: true, learned: npcId });
      return { text: STORY_WORD.learned[stanceOf(story, npcId)], learned: true };
    }
    if (!known && STORY_WORD.pattern.test(String(text || ''))) return { text: STORY_WORD.ask, asked: true };
    return null;
  }
  /**
   * A settlement posts a commission of its own: a letter or parcel from
   * someone here to someone in a place the courier has already been, which
   * is how a new place comes to know the old ones. When the story has a fresh
   * half of a glitch to place, the recipient becomes its writer and shows it
   * on delivery, so carrying is the quick road to the story and never the
   * only one. `senders` are adults here; `destinations` are
   * `{ key, name, people }` for places already visited, people with homes.
   */
  offerCommission(key, senders = [], destinations = [], { day = 0, open = true } = {}) {
    const story = this.story, plot = story?.plot, here = this.place(key);
    if (!plot || !here || !senders.length || !open) return null;
    // A tutorial village posts only once its own round of errands is done with.
    if (story.bindings.places[key] && COURIER_JOBS.some(job => this.placeOf(job.sender) === key
      && !['delivered', 'declined'].includes(story.jobs[job.id]?.state))) return null;
    const posted = plot.posted ||= {};
    if (posted[here.id] === day) return null;
    // Yesterday's notices that nobody took come down when today's go up.
    for (const def of Object.values(plot.jobs)) {
      if (def.senderPlace === here.id && !def.dropped && !def.standing && def.day !== day && (!def.replyTo || day - (def.day || 0) >= 2)
        && ['offered', 'declined'].includes(story.jobs[def.id]?.state)) this.withdrawCommission(def.id);
    }
    const live = Object.values(plot.jobs).filter(def => story.jobs[def.id]?.state !== 'delivered').length;
    // A lighthouse is one household: it writes one letter a day at most.
    const want = Math.min(POST_LIVE_CAP - live, here.kind === 'lighthouse' ? 1 : dailyPostCount(plot.seed, here.id, day));
    if (want <= 0) return null;
    const made = [], used = { places: new Set(), senders: new Set() };
    for (let i = 0; i < want; i++) { const def = this.postCommission(key, here, senders, destinations, day, used); if (def) made.push(def); }
    delete posted[here.id]; posted[here.id] = day;
    const sites = Object.keys(posted);
    for (const id of sites.slice(0, Math.max(0, sites.length - 32))) delete posted[id];
    this.pruneCommissions();
    this.save();
    if (made.length) this.changed({ ok: true, commission: made.map(def => def.id), posted: here.id, day });
    return made.length ? made : null;
  }
  /** One notice for today's post at `here`, to a place not already written to today where there is a choice. */
  postCommission(key, here, senders, destinations, day, used) {
    const story = this.story, plot = story.plot;
    const pick = (list, ...parts) => list.length ? list[storyHash(plot.seed, ...parts) % list.length] : null;
    const serial = (plot.commissions || 0) + 1;
    const withHome = senders.filter(person => person.home);
    const sender = pick(withHome.filter(person => !used.senders.has(person.id)), 'sender', here.id, serial) || pick(withHome, 'sender', here.id, serial);
    if (!sender) return null;
    const places = destinations.filter(place => place.key !== key && place.people?.some(person => person.home));
    const there = pick(places.filter(place => !used.places.has(place.key)), 'to', here.id, serial) || pick(places, 'to', here.id, serial);
    const recipients = (there ? there.people : senders).filter(person => person.home && person.id !== sender.id && person.home.id !== sender.home.id);
    const recipient = pick(recipients, 'recipient', here.id, serial);
    if (!recipient) return null;
    used.senders.add(sender.id); if (there) used.places.add(there.key);
    const thereKey = there?.key || key, thereName = there?.name || here.name;
    // A fresh half of a glitch the story still needs: the sender has written it down, and it goes as a letter.
    const need = storyNeeds(story, { tutorial: false }).find(item => !item.first && STORY_GLITCHES.includes(item.beat)
      && !plot.accounts[item.account] && !accountDef(item.account).tutorial);
    const kind = need ? 'letter' : pick(['letter', 'letter', 'parcel'], 'kind', here.id, serial);
    const id = 'post:' + plot.seed.toString(36) + ':' + serial;
    const topic = need ? null : letterTopic(plot.seed, kind, id);
    const names = { from: sender.name, to: recipient.name };
    const def = { id, dynamic: true, kind, day, topic: topic?.id || 'story', title: (kind === 'letter' ? 'A Letter for ' : 'A Parcel for ') + firstName(recipient.name),
      sender: sender.id, recipient: recipient.id, senderPlace: here.id, recipientPlace: this.place(thereKey)?.id || thereKey,
      local: !there,
      description: (kind === 'letter' ? 'A sealed letter from ' : 'A small wrapped parcel from ') + sender.name + ' of ' + here.name + ' for ' + recipient.name + ' in ' + thereName + '. '
        + fill(need ? STORY_LETTER.gist : topic.gist, names),
      ...(need ? { reveals: need.account, story: true } : {}) };
    plot.commissions = serial;
    plot.people[sender.id] = { id: sender.id, name: sender.name, role: sender.role, place: key, home: sender.home };
    plot.people[recipient.id] = { id: recipient.id, name: recipient.name, role: recipient.role, place: thereKey, home: recipient.home };
    addCommission(story, def);
    if (need) plot.accounts[need.account] = { by: sender.id, name: sender.name, site: here.id, siteName: here.name, stance: stanceOf(story, sender.id) };
    return def;
  }
  /**
   * The lighthouse's standing order, pinned up in the post town. One is up at
   * a time, from after the courier's first delivery; once it is carried the
   * next goes up a few post days later. It is never taken down unaccepted, so
   * a courier who misses a day never loses the lighthouse from their round.
   * `lighthouse` is `{ id, key, name, keeper }` with the keeper's home.
   */
  offerLighthouseOrder(townKey, senders = [], lighthouse = null, { day = 0, open = true } = {}) {
    const story = this.story, plot = story?.plot, town = this.place(townKey);
    if (!plot || !town || !open || !lighthouse?.keeper?.home || this.deliveredCount() < 1) return null;
    const round = plot.lighthouse ||= { count: 0, lastDay: null };
    if (Object.values(plot.jobs).some(def => def.standing && def.lighthouse === lighthouse.id && story.jobs[def.id]?.state !== 'delivered')) return null;
    if (Number.isFinite(round.lastDay) && day - round.lastDay < LIGHTHOUSE_ORDER_GAP_DAYS) return null;
    const withHome = senders.filter(person => person.home && person.id !== lighthouse.keeper.id);
    if (!withHome.length) return null;
    const serial = (plot.commissions || 0) + 1;
    const sender = withHome[storyHash(plot.seed, 'lighthouse-sender', round.count) % withHome.length];
    const def = lighthouseOrderDef({ id: 'post:' + plot.seed.toString(36) + ':' + serial, day, count: round.count, sender,
      keeper: lighthouse.keeper, town: town.name, light: lighthouse.name, lighthouseId: lighthouse.id, townId: town.id });
    plot.commissions = serial;
    plot.people[sender.id] = { id: sender.id, name: sender.name, role: sender.role, place: townKey, home: sender.home };
    plot.people[lighthouse.keeper.id] = { id: lighthouse.keeper.id, name: lighthouse.keeper.name, role: lighthouse.keeper.role,
      place: lighthouse.key, home: lighthouse.keeper.home };
    addCommission(story, def);
    this.save();
    this.changed({ ok: true, commission: [def.id], posted: town.id, day });
    return def;
  }
  /** The courier has watched the lamp come on: from now on, a dark evening is something they would notice. */
  noteLampSeen(night) {
    const plot = this.story?.plot;
    if (!plot || !Number.isFinite(night)) return false;
    const round = plot.lighthouse ||= { count: 0, lastDay: null };
    if (Number.isFinite(round.seenLit)) return false;
    round.seenLit = night; this.save();
    return true;
  }
  /**
   * Tonight the lamp stays dark: the keeper is down with a fever and the
   * spouse is in the post town. Fever powders go up on the post town's board,
   * standing until carried. Plain story state, written once.
   */
  beginLampOut({ night, light, keeper, spouse = null, townKey = 'A', senders = [] }) {
    const story = this.story, plot = story?.plot, town = this.place(townKey);
    if (!plot || plot.lampOut || !light?.id || !keeper?.id) return null;
    const lampOut = plot.lampOut = { night, day: plot.postDay || 0, light: light.id, keeper: keeper.id, spouse: spouse?.id || null,
      litHour: null, litBy: null, powders: null, fetched: null, homeHour: SPOUSE_HOME_HOUR, letters: false };
    const withHome = senders.filter(person => person.home && person.id !== keeper.id);
    if (town && withHome.length) {
      const sender = withHome[storyHash(plot.seed, 'fever-powders', night) % withHome.length];
      const serial = (plot.commissions || 0) + 1;
      plot.commissions = serial;
      const def = feverPowdersDef({ id: 'post:' + plot.seed.toString(36) + ':' + serial, day: plot.postDay || 0, sender, keeper, spouse,
        town: town.name, light: light.name, lighthouseId: light.id, townId: town.id });
      plot.people[sender.id] = { id: sender.id, name: sender.name, role: sender.role, place: townKey, home: sender.home };
      plot.people[keeper.id] = { id: keeper.id, name: keeper.name, role: keeper.role || 'lighthouse keeper', place: light.key || light.id, home: keeper.home || null };
      addCommission(story, def);
      lampOut.powders = def.id;
    }
    this.save(); this.changed({ ok: true, lampOut: night, ...(lampOut.powders ? { commission: [lampOut.powders] } : {}) });
    return lampOut;
  }
  /** Who keeps the fever powders, by name, for the keeper to send the courier to. */
  feverPowders() {
    const id = this.story?.plot?.lampOut?.powders, def = id && this.jobDef(id);
    return def ? { def, sender: this.npc(def.sender), state: this.story.jobs[id]?.state } : null;
  }
  /** The courier strikes the match and holds it to the wick: the dark night's lamp is lit. */
  lightLamp({ hour }) {
    const lampOut = this.story?.plot?.lampOut;
    if (!lampOut || lampOut.litBy) return fail('The lamp is already lit.');
    return this.commit('lamp-lit', { lightId: lampOut.light, hour }, draft => {
      const current = draft.courier.plot.lampOut;
      current.litBy = 'courier'; current.litHour = Number(hour) || 0;
      return { message: 'The match flares, and you cup it to the wick until the flame stands up on its own. The lens takes the light, and the beam begins to turn across the sea.' };
    }, 'courier:lamp-lit:' + lampOut.night);
  }
  /**
   * The courier finds the spouse in the post town on the dark night and tells
   * them: they set off home at once, and light the lamp when they get there
   * if nobody has. Plain story state, once.
   */
  fetchSpouse({ hour }) {
    const lampOut = this.story?.plot?.lampOut;
    if (!lampOut?.spouse || lampOut.fetched !== null) return null;
    lampOut.fetched = Number(hour) || 0;
    lampOut.homeHour = Math.min(SPOUSE_HOME_HOUR, lampOut.fetched + SPOUSE_FETCH_HOURS);
    this.save(); this.changed({ ok: true, spouseFetched: lampOut.fetched });
    return lampOut;
  }
  /**
   * The next post day, letters come for the courier: from people along the
   * coast who saw the light go dark, and from the keeper. Once.
   * `watchers` are `{ name, place }` where the beam can be seen.
   */
  takeLampOutLetters({ watchers = [], light, keeper, spouse = null }) {
    const plot = this.story?.plot, lampOut = plot?.lampOut;
    if (!lampOut || lampOut.letters || (plot.postDay || 0) <= lampOut.day) return null;
    const powders = !!lampOut.powders && this.story.jobs[lampOut.powders]?.state === 'delivered';
    const letters = lampOutLetters({ seed: plot.seed, night: lampOut.night, light, keeper, spouse, watchers, powders,
      lit: lampOut.litBy === 'courier' ? 'courier' : lampOut.fetched !== null ? 'fetched' : 'late', fetched: lampOut.fetched !== null });
    lampOut.letters = true; this.save(); this.changed({ ok: true, lampOutLetters: letters.length });
    return letters;
  }
  /** A supply order reached the lighthouse: the next one goes up a few post days from now. */
  noteLighthouseDelivery(story) {
    const round = story.plot.lighthouse ||= { count: 0, lastDay: null };
    round.count++; round.lastDay = story.plot.postDay || 0;
  }
  /**
   * Leave post for the lighthouse in the box at the foot of the ramp, for
   * when the keeper is asleep or out. It counts as delivered, but nobody is
   * there to write an answer.
   */
  leaveInBox(jobId, place) {
    const def = this.jobDef(jobId), job = this.story?.jobs[jobId], key = this.placeKey(place), there = key && this.place(key);
    if (!def || !job || !there) return fail('Unknown commission.');
    if (def.recipientPlace !== there.id) return fail('That is not addressed to anyone here.');
    if (job.state !== 'active' || this.state.projections.items[job.itemId]?.ownerId !== this.state.playerId) return fail('That parcel is not in your satchel.');
    if (distance(this.getPlayer(), this.getSourcePosition('board:' + key)) > BOARD_REACH) return fail('Stand by the box at the foot of the ramp.');
    const target = this.npc(def.recipient)?.id;
    if (def.night) return fail(def.boxed || 'This is wanted on the watch: take it up to the gallery after dark.');
    if (target && this.onWatch(target)) return fail('The light is lit: ' + firstName(this.npc(target).name) + ' is up at the lamp and will sign for it there. Take it up the stair to the gallery.');
    return this.commit('boxed', { jobId, place: key, condition: job.condition }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      if (target && draft.entities[target]) transferItem(draft, current.itemId, target, { eventId: event.id, condition: current.condition });
      current.state = 'delivered'; current.boxed = true; current.deliveredAtHour = event.atHour;
      current.receipts = [...(current.receipts || []), event.id];
      if (target) (draft.courier.knowledge[target] ||= { jobs: {}, evidence: [] }).jobs[jobId] = { state: 'delivered', condition: current.condition };
      if (def.standing && def.lighthouse) this.noteLighthouseDelivery(draft.courier);
      const delivered = Object.values(draft.courier.jobs).filter(j => j.state === 'delivered').length;
      return { jobId, boxed: true, standing: { delivered, total: this.jobs().length, rank: courierRank(delivered) },
        message: 'You leave ' + def.title + ' in the box at the foot of the ramp, with a note to say who brought it. '
          + (this.npc(def.recipient)?.name ? firstName(this.npc(def.recipient).name) + ' will find it when they wake.' : 'It will be found.')
          + '\n' + delivered + ' of ' + this.jobs().length + ' delivered.' };
    }, 'courier:delivered:' + jobId);
  }
  /**
   * Read the keeper's log where it is kept: the open page and the oldest log
   * on the shelf, both at once. `log` is what courierlighthouse keeperLog()
   * wrote for this story and night; `keeper` is `{ id, name }` and `light`
   * `{ id, name }`. Before the dispatch sheet is in hand it is only a log.
   */
  readKeeperLog({ keeper, spouse = null, light, log }) {
    const story = this.story;
    if (!story || !keeper?.id || !light?.id || !log) return fail('There is no log here.');
    const twoHands = spouse?.id && log.twoHands ? log.twoHands : null;
    const pages = [...log.recent, ...(twoHands ? ['', ...twoHands.lines] : [])];
    if (!story.evidence?.[STORY_FIRST]) return { ok: true, applied: false, message: pages.join('\n') + '\n\nA keeper’s log: ships and weather. It means nothing much to you yet.' };
    const everything = pages.join('\n') + '\n\n' + log.oldest.join('\n') + (log.horizon ? '\n\n' + log.horizon.join('\n') : '');
    const fresh = ['keeper-log', 'keeper-log-old', ...(twoHands ? ['two-hands-keeper'] : []), ...(log.horizon ? ['horizon'] : [])]
      .filter(id => !story.evidence[id]);
    if (!fresh.length) return { ok: true, applied: false, message: everything };
    return this.commit('evidence-read', { sourceId: 'keeper-log:' + light.id, evidenceId: fresh[0], speakerId: null }, draft => {
      const plot = draft.courier.plot, stance = stanceOf(draft.courier, keeper.id);
      const works = { 'keeper-log': { title: 'The keeper’s log', lines: log.recent }, 'keeper-log-old': { title: 'The oldest log on the shelf', lines: log.oldest },
        'two-hands-keeper': twoHands && twoHandsWork('two-hands-keeper', { seed: plot.seed, keeper: keeper.name, spouse: spouse.name }),
        horizon: log.horizon && { title: 'The horizon doesn’t move', lines: log.horizon } };
      // The doubled night and the horizon page are rebuilt from the seed and the names when read: the save keeps no prose for them.
      const rebuilt = new Set(['keeper-log', 'keeper-log-old', 'two-hands-keeper', 'horizon']);
      for (const id of fresh) {
        plot.accounts[id] = { by: keeper.id, name: keeper.name, site: light.id, siteName: light.name, stance };
        plot.works[id] = rebuilt.has(id) ? { source: 'lighthouse', ...(id.startsWith('keeper-log') ? { day: log.day ?? 0 } : {}) } : { ...works[id], source: 'authored' };
        this.takeAccount(draft.courier, id, light.id);
        draft.courier.evidence[id].sourceIds = [...new Set([...(draft.courier.evidence[id].sourceIds || []), id + ':' + light.id])];
      }
      // The spouse has their own word to say about the doubled night, and says it in person.
      if (fresh.includes('two-hands-keeper') && !draft.courier.evidence['two-hands-spouse']) {
        plot.accounts['two-hands-spouse'] = { by: spouse.id, name: spouse.name, site: light.id, siteName: light.name, stance: stanceOf(draft.courier, spouse.id) };
        plot.works['two-hands-spouse'] = { source: 'lighthouse' };
        const site = plot.sites[light.id] ||= { name: light.name, offers: [] };
        if (!site.offers.some(offer => offer.a === 'two-hands-spouse')) site.offers.push({ a: 'two-hands-spouse', ch: 'handed', at: plot.pacing.arrivals || 0 });
      }
      // The keeper asks for their page to go to someone who keeps records.
      const archivist = draft.courier.bindings?.cast?.archivist;
      const letter = fresh.includes('horizon') && archivist ? this.postHorizonLetter(draft.courier, { keeper, light }) : null;
      const titles = fresh.map(id => '“' + works[id].title + '”');
      const added = titles.length > 1 ? titles.slice(0, -1).join(', ') + ' and ' + titles.at(-1) : titles[0];
      return { evidenceId: fresh[0], document: { title: 'The keeper’s log', text: pages.join('\n') },
        message: everything + '\n\nNew in your book: ' + added + '.'
          + (fresh.includes('keeper-log') ? ' Compare the two logs on the Story page.' : '')
          + (twoHands && fresh.includes('two-hands-keeper') ? ' ' + firstName(spouse.name) + ' may have something to say about the night written twice.' : '')
          + (letter ? '\n' + firstName(keeper.name) + ' has written a fair copy of the loose page for ' + archivist.name + ', the station archivist, and would like it carried: ' + letter.title + '.' : '') };
    }, 'courier:source:keeper-log:' + light.id + ':' + fresh.join('+'));
  }
  /** The keeper's page about the horizon, as a letter to the station archivist. Offered by the keeper in person. */
  postHorizonLetter(story, { keeper, light }) {
    const plot = story.plot, cast = story.bindings?.cast?.archivist;
    if (!cast || Object.values(plot.jobs).some(def => def.horizon) || plot.horizonSent) return null;
    // Addressed by role, as the round's own errands are, so it reaches whoever keeps the station archive.
    const archivist = { id: 'archivist', name: cast.name }, there = cast.place;
    const serial = (plot.commissions || 0) + 1;
    plot.commissions = serial; plot.horizonSent = true;
    const def = horizonLetterDef({ id: 'post:' + plot.seed.toString(36) + ':' + serial, day: plot.postDay || 0, keeper, archivist,
      light: light.name, lighthouseId: light.id, archivistPlace: this.place(there)?.id || there, archivistPlaceName: this.placeName(there) });
    plot.people[keeper.id] ||= { id: keeper.id, name: keeper.name, role: 'lighthouse keeper', place: light.key || light.id, home: keeper.home || null };
    addCommission(story, def);
    story.knownOffers[def.id] = true;
    story.leads['job:' + def.id] ||= { jobId: def.id, source: { kind: 'npc', id: keeper.id, name: keeper.name }, learnedAtHour: this.state.clock?.worldHours || 0,
      summary: def.title + ': ask ' + keeper.name + ' at ' + light.name + '.' };
    return def;
  }
  /**
   * A letter lies on the road with no address on it. Plain story state, one
   * at a time and no more than one every couple of days: it writes no event
   * until the courier picks it up.
   */
  dropLetter({ x, z, sender, recipient, senderKey, recipientKey, homeCompass, day = 0 }) {
    const story = this.story, plot = story?.plot;
    if (!plot || plot.dropped || !sender?.home || !recipient?.home || sender.id === recipient.id) return null;
    if (Number.isFinite(plot.droppedDay) && day - plot.droppedDay < 2) return null;
    if (Object.values(plot.jobs).some(def => def.dropped && story.jobs[def.id]?.state === 'active')) return null;
    const serial = (plot.commissions || 0) + 1;
    plot.commissions = serial;
    plot.people[sender.id] = { id: sender.id, name: sender.name, role: sender.role, place: senderKey, home: sender.home };
    plot.people[recipient.id] = { id: recipient.id, name: recipient.name, role: recipient.role, place: recipientKey, home: recipient.home };
    plot.dropped = { id: 'post:' + plot.seed.toString(36) + ':' + serial, x, z, day, sender: sender.id, recipient: recipient.id,
      senderPlace: this.place(senderKey)?.id || senderKey, recipientPlace: this.place(recipientKey)?.id || recipientKey,
      clues: droppedLetterClues({ sender: sender.name, recipient: recipient.name, placeName: this.placeName(recipientKey), homeCompass }) };
    plot.droppedDay = day;
    this.save();
    return plot.dropped;
  }
  /** Pick the letter off the road. Whose it is, the courier has to work out from what it says. */
  pickUpDropped() {
    const story = this.story, spot = story?.plot?.dropped;
    if (!spot) return fail('There is nothing here to pick up.');
    if (distance(this.getPlayer(), spot) > 4) return fail('Stand by the letter to pick it up.');
    if (this.satchelLoad() >= SATCHEL_SLOTS) return fail('Your satchel is full. Deliver something first, then come back for the letter.');
    return this.commit('found', { id: spot.id }, (draft, event) => {
      const def = addCommission(draft.courier, { id: spot.id, dynamic: true, dropped: true, unaddressed: true, kind: 'letter', day: spot.day,
        title: 'A Letter with No Address', sender: spot.sender, recipient: spot.recipient, senderPlace: spot.senderPlace, recipientPlace: spot.recipientPlace,
        description: 'Found lying on the road. ' + spot.clues.join(' '), clues: spot.clues }, 'active');
      const current = draft.courier.jobs[def.id];
      Object.assign(current, { attempts: 1, acceptedAtHour: event.atHour, receipts: [event.id] });
      createItem(draft, { id: current.itemId, kind: 'letter', ownerId: draft.playerId, purpose: 'courier', condition: 'intact' });
      draft.courier.knownOffers[def.id] = true; draft.courier.focusJobId = def.id;
      delete draft.courier.plot.dropped;
      return { jobId: def.id, message: 'You pick up a letter with no address. ' + spot.clues.join(' ')
        + '\nIt is in your satchel. Someone will be glad of it, if you can work out who.' };
    }, 'courier:found:' + spot.id);
  }
  /** Take a notice down that nobody accepted, with anything only it remembered. */
  withdrawCommission(id) {
    const story = this.story, plot = story.plot, def = plot.jobs[id];
    if (!def || ['active', 'delivered'].includes(story.jobs[id]?.state)) return false;
    for (const receipt of story.jobs[id]?.receipts || []) delete this.state.effectReceipts[receipt];
    delete plot.jobs[id]; delete story.jobs[id]; delete story.knownOffers[id]; delete story.leads['job:' + id];
    for (const knowledge of Object.values(story.knowledge)) delete knowledge.jobs?.[id];
    // An account it was carrying, and nobody has read, can be placed again.
    if (def.reveals && !story.evidence[def.reveals]) delete plot.accounts[def.reveals];
    this.pendingOffers?.forEach((offer, npcId) => { if (offer.jobId === id) this.pendingOffers.delete(npcId); });
    return true;
  }
  /**
   * Lift the seal on a story letter in the satchel and read it first. The
   * recipient will see the seal has been lifted and say what they think.
   */
  openLetter(jobId) {
    const def = this.jobDef(jobId), job = this.story?.jobs[jobId];
    if (!def?.story || !def.reveals || job?.state !== 'active') return fail('There is nothing in your satchel you could open.');
    if (job.opened) return { ok: true, duplicate: true, applied: false };
    return this.commit('opened', { jobId }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      current.opened = true; current.receipts = [...(current.receipts || []), event.id];
      const revealed = this.grantEvidence(draft.courier, def.reveals);
      return { jobId, revealed: revealed?.id || null, message: fill(STORY_LETTER.read, { from: this.npc(def.sender)?.name })
        + (revealed ? '\nNew in your book: “' + revealed.title + '”.' : '') };
    }, 'courier:opened:' + jobId);
  }
  /** What the recipient says as they open it: its reason, or the story, and whether you read it first. */
  deliveryWords(def, job) {
    const names = { from: this.npc(def.sender)?.name, to: this.npc(def.recipient)?.name };
    if (def.dropped) return fill(DROPPED_THANKS, names);
    if (def.lighthouse) return job.condition === 'chipped' && def.crackedThanks ? def.crackedThanks : def.thanks;
    if (def.lampOut) return def.thanks;
    if (def.horizon) return HORIZON_ARCHIVIST[stanceOf(this.story, this.npc(def.recipient)?.id)] || HORIZON_ARCHIVIST.curious;
    if (def.story) return fill(job.opened ? STORY_LETTER.opened[stanceOf(this.story, this.npc(def.recipient)?.id)] : STORY_LETTER.unopened, names);
    if (def.replyTo) return fill(topicById(def.topic)?.reply?.reaction || def.thanks || '', names);
    const topic = topicById(def.topic);
    return topic ? fill(topic.reaction, names) : def.thanks;
  }
  /** The answer the recipient asks the courier to carry back, if they want to send one. */
  replyFor(story, def) {
    if (def.lighthouse && def.standing) {
      const plot = story.plot, keeper = this.npc(def.recipient), sender = this.npc(def.sender);
      if (!keeper || !sender) return null;
      const serial = (plot.commissions || 0) + 1;
      plot.commissions = serial;
      const reply = lighthouseReplyDef({ id: 'post:' + plot.seed.toString(36) + ':' + serial, order: { ...def, day: plot.postDay || 0 }, keeper, sender,
        town: this.placeName(this.placeOf(sender.id)), light: this.placeName(this.placeOf(keeper.id)) });
      addCommission(story, reply);
      return reply;
    }
    if (!def.dynamic || def.replyTo || def.story || def.dropped || def.lampOut || def.horizon || !wantsReply(story.plot.seed, def.id, def.topic)) return null;
    const plot = story.plot, serial = (plot.commissions || 0) + 1, topic = topicById(def.topic);
    const from = this.npc(def.recipient), to = this.npc(def.sender);
    if (!from || !to) return null;
    plot.commissions = serial;
    const reply = { id: 'post:' + plot.seed.toString(36) + ':' + serial, dynamic: true, kind: 'letter', topic: def.topic, replyTo: def.id,
      title: 'A Reply for ' + firstName(to.name), sender: from.id, recipient: to.id, senderPlace: def.recipientPlace, recipientPlace: def.senderPlace,
      local: def.local, day: def.day,
      description: 'A reply from ' + from.name + ' for ' + to.name + ' in ' + this.placeName(this.placeOf(to.id)) + '. ' + fill(topic.reply.gist, { from: from.name, to: to.name }) };
    addCommission(story, reply);
    return reply;
  }
  /** Keep a short memory of finished commissions: the latest few stay readable, the rest become a count. */
  pruneCommissions() {
    const story = this.story, plot = story.plot;
    const done = Object.values(plot.jobs).filter(def => story.jobs[def.id]?.state === 'delivered');
    for (const def of done.slice(0, Math.max(0, done.length - 3))) {
      for (const receipt of story.jobs[def.id].receipts || []) delete this.state.effectReceipts[receipt];
      delete this.state.effectReceipts['courier:delivered:' + def.id]; delete this.state.effectReceipts['courier:opened:' + def.id];
      delete this.state.effectReceipts['courier:found:' + def.id];
      delete this.state.projections.items[story.jobs[def.id].itemId];
      delete plot.jobs[def.id]; delete story.jobs[def.id]; delete story.knownOffers[def.id]; delete story.leads['job:' + def.id];
      for (const knowledge of Object.values(story.knowledge)) delete knowledge.jobs?.[def.id];
      plot.delivered = (plot.delivered || 0) + 1;
    }
    // People are remembered while a commission or an account still names them.
    const named = new Set([...Object.values(plot.jobs).flatMap(def => [def.sender, def.recipient]), ...Object.values(plot.accounts).map(cast => cast.by),
      plot.dropped?.sender, plot.dropped?.recipient]);
    for (const id of Object.keys(plot.people)) if (!named.has(id)) delete plot.people[id];
  }
  /** The courier reached a settlement beyond the tutorial villages: it goes in their journey, once. */
  noteArrival(key, mode = 'foot') {
    const travel = this.story?.travel, place = this.place(key);
    if (!travel || !place || travel.visited[key]) return false;
    travel.visited[key] = true;
    // Only the latest few places are kept by name; the rest are just visited.
    const visited = Object.keys(travel.visited).filter(item => !this.story.bindings.places[item]);
    for (const old of visited.slice(0, Math.max(0, visited.length - 24))) delete travel.visited[old];
    travel.observations.push({ id: 'arrival:' + key, summary: 'Arrived at ' + place.name + ' ' + (mode === 'train' ? 'by train' : mode === 'horse' ? 'on horseback' : 'on foot') + '.', place: key, mode });
    travel.observations = travel.observations.slice(-24);
    return true;
  }
  /** Take a paper a resident hands over in person. */
  receive(accountId, speakerId) {
    const handed = this.handedHere(speakerId).find(item => item.accountId === accountId);
    if (!handed || !this.nearby(speakerId)) return fail('Only the person who wrote it can hand it to you.');
    return this.commit('handed', { accountId, speakerId }, (draft, event) => {
      this.takeAccount(draft.courier, accountId, handed.siteId);
      this.remember(draft, speakerId, event, 'I gave the traveller something I had written down.', 'observed');
      const doc = this.accountDoc(accountId);
      return { evidenceId: accountId, document: { title: doc.title, text: doc.text }, message: 'New in your book: “' + doc.title + '”.' };
    }, 'courier:handed:' + accountId);
  }
  /**
   * Show a resident what you carry. Anyone can be shown, and each answers in
   * their own temperament. A reaction is ordinary conversation, not an event:
   * it writes no receipt, so talking to a whole town cannot grow the save.
   */
  shareEvidence(speakerId, evidenceIds) {
    if (!this.state.entities[speakerId] || !this.nearby(speakerId) || !evidenceIds?.length
      || evidenceIds.some(id => !this.story.evidence[id])) return fail('Share only accounts you have actually read, with someone nearby.');
    if (this.story.plot.closer?.id === speakerId && beatOpen(this.story, 'ending')) return this.finish(speakerId);
    return this.react(speakerId, evidenceIds);
  }
  react(speakerId, evidenceIds) {
    const story = this.story, plot = story.plot, knowledge = story.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
    const before = knowledge.evidence.slice();
    const title = id => this.accountDoc(id)?.title || 'that paper';
    // Someone frightened enough has asked you to keep them away, and means it.
    if (knowledge.avoids) return this.changed({ ok: true, applied: false, stance: stanceOf(story, speakerId), avoided: true,
      message: STORY_MEMORY.avoids });
    knowledge.evidence = [...new Set([...knowledge.evidence, ...evidenceIds])];
    // Residents outside the round remember only the latest few they were shown.
    const kept = Object.keys(story.knowledge).filter(id => !this.roleFor(id));
    for (const id of kept.slice(0, Math.max(0, kept.length - 24))) delete story.knowledge[id];
    const glitch = STORY_GLITCHES.some(beat => beatDone(story, beat));
    const fresh = evidenceIds.filter(id => !before.includes(id));
    // What they were shown before colours what they make of this.
    const memory = !before.length ? '' : fresh.length ? STORY_MEMORY.again.replace('{title}', title(before.at(-1))) + ' '
      : STORY_MEMORY.seen.replace('{title}', title(evidenceIds[0])) + ' ';
    // A temperament is not fixed: enough papers wear a denial through, and enough frighten the frightened away.
    let shift = '';
    const count = knowledge.evidence.length, was = stanceOf(story, speakerId);
    if (glitch && fresh.length && was === 'denying' && count >= 3) {
      const to = storyHash(plot.seed, 'turns', speakerId) % 2 ? 'curious' : 'afraid';
      plot.stances[speakerId] = to; shift = STORY_MEMORY.turned[to];
      const pinned = Object.keys(plot.stances);
      for (const id of pinned.slice(0, Math.max(0, pinned.length - 48))) if (!Object.values(plot.voices).includes(id)) delete plot.stances[id];
    } else if (glitch && fresh.length && was === 'afraid' && count >= 4) { knowledge.avoids = true; shift = STORY_MEMORY.avoids; }
    const voices = Object.keys(plot.voices).length;
    const { stance, counted } = recordVoice(story, speakerId);
    if (knowledge.evidence.length !== before.length) {
      rememberSocialMemory(this.state, speakerId, {
        id: 'memory:courier:shown:' + speakerId + ':' + knowledge.evidence.length, lineageId: 'courier:shown:' + speakerId,
        subject: { kind: 'player', id: this.state.playerId }, predicate: 'courier.evidence-shared', object: { evidenceIds: knowledge.evidence.slice(-6) },
        summary: 'The traveller has shown me ' + knowledge.evidence.length + (knowledge.evidence.length === 1 ? ' paper' : ' papers') + ' that do not agree with each other, the latest “' + title(knowledge.evidence.at(-1)) + '”.',
        source: { kind: 'courier', id: 'shown' },
        provenance: 'told', privacy: 'personal', confidence: 1, salience: 0.6, createdAtHour: this.state.clock.worldHours });
    }
    this.save();
    // Read the keeper's log aloud and the ship that comes back is what people hear.
    const horizon = !shift && evidenceIds.includes('horizon') && evidenceIds.every(id => id === 'horizon');
    const log = !shift && !horizon && evidenceIds.some(id => ['keeper-log', 'keeper-log-old'].includes(id));
    const isKeeper = log && evidenceIds.some(id => plot.accounts[id]?.by === speakerId);
    const message = shift || (horizon ? (plot.accounts.horizon?.by === speakerId
      ? 'I wrote that on a night I could not stop looking. Hearing it read back in another voice is worse.' : HORIZON_REACTIONS[stance] || HORIZON_REACTIONS.curious)
      : log ? keeperLogReaction(stance, { isKeeper })
      : glitch ? STORY_REACTIONS[stance][storyStage(story)] : 'There may be a copying error. Still, these are worth keeping together.');
    return this.changed({ ok: true, applied: true, persisted: true, stance, counted, shifted: !!shift, remembered: before.length,
      message: memory + message + (counted && voices < 2 && Object.keys(plot.voices).length >= 2 ? '\nTwo people have now told you what they make of it, and they do not agree.' : '') });
  }
  /** The roads residents of a place can send the courier down: the round's own, then any signed since. */
  routesFor(place) {
    const own = this.story?.bindings.routes?.[place], extra = this.getRoutes?.(place) || [];
    if (!own) return extra;
    return [...own, ...extra.filter(route => !own.some(item => item.place === route.place))];
  }
  contextForNpc(speakerId, { place: requestedPlace } = {}) {
    const role = this.roleFor(speakerId);
    const place = this.placeForNpc(speakerId);
    if (!place || (requestedPlace && requestedPlace !== place)) return null;
    const knowledge = this.story.knowledge[speakerId] || { jobs: {}, evidence: [] };
    const siteId = this.place(place)?.id;
    const own = Object.entries(this.story.plot.accounts).filter(([, cast]) => cast.by === speakerId).map(([id]) => id);
    // What is pinned up here is local knowledge; so is anything this person wrote.
    const pinned = (this.story.plot.sites[siteId]?.offers || []).filter(offer => offer.ch === 'stand').map(offer => offer.a);
    const evidenceIds = new Set([...COURIER_EVIDENCE.filter(e => e.places.includes(place)).map(e => e.id), ...knowledge.evidence, ...pinned, ...own]);
    const evidence = [...evidenceIds].map(id => this.accountDoc(id)).filter(Boolean)
      .map(({ id, title, text }) => ({ id, title, text }));
    const handed = this.handedHere(speakerId)[0];
    const boardPosition = this.getSourcePosition('board:' + place);
    return { responsibility: role || (this.story.plot.people[speakerId] ? 'courier contact' : 'neighbor'), place, placeName: this.placeName(place),
      npc: { id: speakerId, name: this.state.entities[speakerId]?.name || 'A local resident' },
      localOpportunities: this.localOpportunities(speakerId),
      boardTarget: boardPosition ? { ...boardPosition, id: 'board:' + place, kind: 'place', name: 'Post & Errands board by the well',
        worldX: boardPosition.x, worldZ: boardPosition.z } : null,
      deliveries: this.jobs().filter(j => this.npc(j.recipient)?.id === speakerId && this.story.jobs[j.id].state === 'active')
        .map(j => ({ id: j.id, title: j.title, ...(j.unaddressed ? { unaddressed: true } : {}) })),
      standing: this.standing(),
      offers: this.jobs().filter(j => this.npc(j.sender)?.id === speakerId).map(j => ({
      id: j.id, jobId: j.id, local: !!j.local,
      title: j.title, description: j.description, recipient: this.npc(j.recipient).name,
      destination: this.placeName(this.placeOf(j.recipient)),
      recipientAddress: this.npc(j.recipient).home?.address,
      lastWitnessedState: knowledge.jobs[j.id]?.state || 'offered',
    })), witnessedJobs: clone(knowledge.jobs), evidence,
    people: [...Object.entries(this.story.bindings.cast).filter(([personRole, person]) => person.place === place
      || (role && this.jobs().some(j => j.sender === role && j.recipient === personRole)))
      .map(([personRole, person]) => ({ id: person.id, name: person.name, responsibility: personRole,
        address: person.home?.address, place: person.place })), ...this.storyPeople(place)],
    stance: stanceOf(this.story, speakerId),
    belief: this.beliefFor(speakerId, knowledge),
    lexicon: Object.keys(this.story.plot.lexicon[speakerId] || {}),
    ...(handed ? { handover: handed } : {}),
    // The welcome opens with the dispatcher's own greeting.
    ...(this.welcome?.npcId === speakerId && !this.welcome.greeted ? { welcome: this.welcome.lines[0] } : {}),
    // The closer opens the conversation: they asked for the courier.
    ...(this.story.plot.closer?.id === speakerId && beatOpen(this.story, 'ending') ? this.closerCalling(speakerId) : {}),
    travelLessons: [
      { id: 'foot', title: 'Finding the way on foot', text: 'Use the compass, landmarks and the destination names on physical road posts. Ask for directions at a village, and keep the ones you want in your notebook. The book has space for your own sketches; you can print those pages before a journey.' },
      ...(role === 'guide' ? [{ id: 'horse', title: 'Learning to ride', text: 'Stand beside a calm horse. R mounts or dismounts; in VR use left Y. W and S move forward and back, and A and D steer; in VR use the left stick. Hold Shift or press the movement stick to gallop. Take a fragile parcel at a walk: running, galloping and jumping can chip it. Open your book to stop steering and make a note.' }] : []),
      ...(['dispatcher', 'archivist'].includes(role) ? [{ id: 'train', title: 'Taking the regional train', text: 'Wait on the platform until the train stops and its doors slide open, then walk through a doorway. Inside, E or right B lets you sit by a seat; use it again to stand. Read the named stops and arrival hints, and walk out through an open door at your destination. You can read and write in your book while the train carries you. It is a gentle way to carry a fragile parcel.' }] : []),
    ],
    routes: clone(this.routesFor(place)),
    personalWork: role === 'poet' ? this.story.works.personal || null : null };
  }
  recordTravel(dt, { position, mode = 'foot', sprint = false, jumped = false, active = true }) {
    if (!this.story || !position) return;
    const moved = distance(this.previousPosition, position); this.previousPosition = { x: position.x, z: position.z };
    if (!active || !Number.isFinite(moved) || moved > 60) return;
    const travel = this.story.travel;
    travel.distances[mode] = (travel.distances[mode] || 0) + moved;
    for (const [key, place] of Object.entries(this.story.bindings.places)) {
      if (!travel.visited[key] && distance(position, place) < 130) {
        travel.visited[key] = true;
        travel.observations.push({ id: 'arrival:' + key, summary: 'Arrived at ' + place.name + ' ' + (mode === 'train' ? 'by train' : mode === 'horse' ? 'on horseback' : 'on foot') + '.', place: key, mode });
      }
    }
    travel.observations = travel.observations.slice(-24);
    for (const def of this.jobs().filter(j => j.fragile)) {
      const job = this.story.jobs[def.id];
      if (job.state !== 'active' || job.condition !== 'intact' || mode === 'train') continue;
      if (sprint && moved > 0.01) job.roughSeconds += Math.min(0.2, Math.max(0, dt));
      if (job.roughSeconds >= 5 || jumped) this.commit('cargo-chipped', { jobId: job.id }, draft => {
        const current = draft.courier.jobs[def.id]; current.condition = 'chipped';
        draft.projections.items[current.itemId].condition = 'chipped';
        return { message: def.chipMessage || 'The fragile cup has chipped. Walk gently or use the train; it can still be delivered.' };
      }, 'courier:chipped:' + def.id);
    }
    this.story.resume = { x: position.x, y: position.y, z: position.z };
  }
  async shareJourney(speakerId, note = '') {
    if (this.roleFor(speakerId) !== 'poet' || !this.nearby(speakerId)) return fail('Share your journey with the poet nearby.');
    if (this.story.works.personal) return { ok: true, work: clone(this.story.works.personal), cached: true };
    if (this.workRequests.has('personal')) return this.workRequests.get('personal');
    const events = this.journeyEvents();
    if (!events.length) return fail('Make a journey first, then tell the poet about it.');
    const facts = { author: this.npc('poet').name, events, sharedNote: String(note).slice(0, 1600) };
    const token = this.story.runId;
    const promise = (async () => {
      const response = this.director ? await this.director.requestCreativeWork(facts)
        : { work: fallbackCreativeWork(facts), source: 'authored' };
      if (this.story?.runId !== token) return fail('The story changed before the poem was finished.');
      let content, source = response.source;
      try { content = validateCreativeWork(response.work, facts); }
      catch { content = fallbackCreativeWork(facts); source = 'authored'; }
      if (this.story.works.personal) return { ok: true, work: this.story.works.personal, cached: true };
      return this.commit('work-published', { speakerId }, (draft, event) => {
        const work = { ...content, id: 'personal', authorId: speakerId, author: facts.author,
          introduction: 'Written after the traveller shared: ' + events.map(e => e.summary).join(' ')
            + (facts.sharedNote ? '\nThe traveller also shared a note: “' + facts.sharedNote + '”' : ''),
          source, publishedAtHour: event.atHour };
        draft.courier.works.personal = work;
        this.remember(draft, speakerId, event, 'The traveller told me about their journey; I wrote a poem from it.', 'told');
        return { work, message: 'The poet has left a finished copy for you to read and keep.' };
      }, 'courier:work:personal');
    })().finally(() => this.workRequests.delete('personal'));
    this.workRequests.set('personal', promise); return promise;
  }
}
