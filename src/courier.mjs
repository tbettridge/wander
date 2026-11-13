import { applyLivingWorldEventOnce } from './livingworldstate.mjs?v=courier1';
import { createItem, transferItem } from './npcitems.mjs';
import { applyRelationshipDelta, rememberSocialMemory } from './npcsocialmemory.mjs';
import { COURIER_VERSION, COURIER_SCENARIO, COURIER_JOBS, COURIER_ROLES,
  COURIER_EVIDENCE, COURIER_THREADS, courierSources, validateCreativeWork,
  fallbackCreativeWork, upgradeCourierOnboarding, COURIER_ENDING, courierRank, courierText } from './couriercontent.mjs';
import { STORY_WORD, recordEnding, storyEnding, storyNeeds, validateStoryWork, STORY_FIRST, STORY_GLITCHES, STORY_REACTIONS, accountDef, beatDone, beatOpen, recordVoice, stanceOf, storyStage, fallbackStoryWork, recordAccount, recordCompared, recordPattern, storyFacts, storyHash,
  storyRefrain, storyThreads, tellById, upgradeCourierPlot } from './courierstory.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity;
const fail = reason => ({ ok: false, applied: false, reason });
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
  constructor({ getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace = null, getPlace = null, getRoutes = null, save = () => true, director = null }) {
    Object.assign(this, { getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace, getPlace, getRoutes, save, director });
    this.previousPosition = null;
    this.workRequests = new Map();
    // Generated editions waiting to be read; the one read first is saved for good.
    this.pendingWorks = new Map();
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
    return !!entity && !entity.tombstone && !entity.inTransit
      && distance(this.getPlayer(), this.getNpcPosition(npcId)) <= 4.5;
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
    if (!place || distance(this.getPlayer(), this.getSourcePosition('board:' + place)) > 4.5)
      return fail('Stand beside the Post & Errands board to read its notices.');
    const jobs = this.boardJobs(place);
    const unseen = jobs.some(j => !this.story.leads['job:' + j.id]);
    if (!unseen) return { ok: true, applied: false, jobs, message: 'These public notices are in your Leads page. Collect a parcel from its sender.' };
    return this.commit('board-read', { place }, (draft, event) => {
      for (const card of jobs) this.storeLead(draft.courier, this.jobDef(card.id),
        { kind: 'board', id: 'board:' + place, name: 'Post & Errands, ' + this.placeName(place) }, event.atHour);
      return { jobs, message: 'Notices copied to Leads. Visit the sender to ask about a parcel; reading a notice accepts no work.' };
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
    if (same && (known !== undefined || distance(player, there) < 450))
      return 'Their home is ' + home + '. Find the well and use your compass, or ask anyone nearby to point the way.';
    const train = here?.stationId && there.stationId && !same;
    return there.name + ' is another village. ' + (train ? 'The regional train stops there; on foot or horseback, ' : 'To get there, ')
      + 'follow the road posts marked “' + there.name + '” (anyone can point out the first one). Once there, their home is ' + home + '.';
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
  /** The closer hears it all, and the last letter is read. */
  finish(speakerId) {
    const closer = this.story.plot.closer;
    if (!closer || closer.id !== speakerId || !beatOpen(this.story, 'ending')) return fail('There is nobody here waiting for what you found.');
    if (!this.nearby(speakerId)) return fail('Stand beside ' + closer.name + ' to show them.');
    return this.commit('ending', { speakerId }, (draft, event) => {
      recordEnding(draft.courier); draft.courier.plot.endedAtHour = event.atHour;
      this.remember(draft, speakerId, event, 'I read everything the courier carried, and gave them the last letter.', 'observed');
      return { ending: this.endingDoc(draft.courier), message: closer.name + ' reads everything you carry.' };
    }, 'courier:ending');
  }
  endingDoc(story = this.story) {
    if (!story.plot.closer) return null;
    const ending = storyEnding(story, story.plot.closer.name);
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
    if (Object.values(this.story.jobs).filter(j => j.state === 'active').length >= 3) return fail('Your satchel is full. Deliver or return a parcel to make room.');
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
    return this.commit('declined', { jobId, speakerId }, draft => {
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
    if (target !== speakerId || !this.nearby(target)) return fail('Find the ' + (returning ? 'sender' : 'recipient') + ' before handing it over.');
    if (job.state !== 'active' || this.state.projections.items[job.itemId]?.ownerId !== this.state.playerId) return fail('That parcel is not in your satchel.');
    return this.commit(returning ? 'returned' : 'delivered', { jobId, speakerId, condition: job.condition }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      transferItem(draft, current.itemId, target, { eventId: event.id, condition: current.condition });
      current.state = returning ? 'returned' : 'delivered';
      if (def.dynamic) current.receipts = [...(current.receipts || []), event.id];
      if (!returning) current.deliveredAtHour = event.atHour;
      const knowledge = draft.courier.knowledge[target] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: current.state, condition: current.condition };
      this.remember(draft, target, event, returning ? 'The traveller returned ' + def.title + '.'
        : 'The traveller delivered ' + def.title + (current.condition === 'chipped' ? ', with a chipped cup.' : '.'));
      if (!returning) applyRelationshipDelta(draft, target, draft.playerId,
        { familiarity: 0.08, trust: current.condition === 'chipped' ? 0.01 : 0.04 }, event);
      const next = !returning && this.jobs().find(j => this.npc(j.sender)?.id === target
        && !['active', 'delivered'].includes(draft.courier.jobs[j.id].state));
      if (next) this.storeLead(draft.courier, next, { kind: 'npc', id: target, name: this.state.entities[target].name }, event.atHour);
      const nextLead = returning ? null : next ? { jobId: next.id, title: next.title }
        : { place: this.placeOf(def.recipient), kind: 'reading-stand' };
      const revealed = returning ? null : this.grantEvidence(draft.courier, def.reveals);
      const thanks = jobId === 'village-note' ? 'The guide opens your note and sets it beside the trail papers. Your first delivery is complete.'
        : (def.thanks || 'Thank you. This will be put to good use.')
          + (current.condition === 'chipped' ? ' “A small chip, but it still holds tea.”' : '');
      const delivered = Object.values(draft.courier.jobs).filter(j => j.state === 'delivered').length;
      const rank = courierRank(delivered), promoted = !returning && rank !== courierRank(delivered - 1);
      return { jobId, nextLead, revealed: revealed?.id || null, standing: { delivered, total: this.jobs().length, rank },
        message: returning ? 'The parcel is safely back with its sender.' : thanks
          + (revealed ? '\nNew in your book: “' + revealed.title + '”.' : '')
          + '\n' + delivered + ' of ' + this.jobs().length + ' delivered' + (promoted ? ' — you are now “' + rank + '”.' : '.')
          + (next ? ' ' + this.state.entities[target].name + ' has another errand if you want it: ' + next.title + '.' : '') };
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
    const work = story.plot.works[accountId] || this.pendingWorks?.get(accountId) || fallbackStoryWork(this.accountFacts(accountId));
    return { id: accountId, title: work.title, text: work.lines.join('\n'), author: cast?.name || null,
      place: cast?.siteName || null, siteId: cast?.site || null, source: work.source || 'authored' };
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
  offerCommission(key, senders = [], destinations = []) {
    const story = this.story, plot = story?.plot, here = this.place(key);
    if (!plot || !here || !senders.length || Object.keys(story.bindings.places).includes(key)) return null;
    const live = Object.values(plot.jobs).filter(def => story.jobs[def.id]?.state !== 'delivered');
    if (live.some(def => def.senderPlace === here.id) || live.length >= 3) return null;
    const pick = (list, ...parts) => list.length ? list[storyHash(plot.seed, ...parts) % list.length] : null;
    const serial = (plot.commissions || 0) + 1;
    const sender = pick(senders.filter(person => person.home), 'sender', here.id, serial);
    if (!sender) return null;
    const places = destinations.filter(place => place.key !== key && place.people?.some(person => person.home));
    const there = pick(places, 'to', here.id, serial);
    const recipients = (there ? there.people : senders).filter(person => person.home && person.id !== sender.id && person.home.id !== sender.home.id);
    const recipient = pick(recipients, 'recipient', here.id, serial);
    if (!recipient) return null;
    const thereKey = there?.key || key, thereName = there?.name || here.name;
    // A fresh half of a glitch the story still needs, carried rather than pinned up.
    const need = storyNeeds(story, { tutorial: false }).find(item => !item.first && STORY_GLITCHES.includes(item.beat)
      && !plot.accounts[item.account] && !accountDef(item.account).tutorial);
    const kind = pick(['letter', 'letter', 'parcel'], 'kind', here.id, serial);
    const first = name => String(name).split(' ')[0];
    const id = 'post:' + plot.seed.toString(36) + ':' + serial;
    const def = { id, dynamic: true, kind, title: (kind === 'letter' ? 'A Letter for ' : 'A Parcel for ') + first(recipient.name),
      sender: sender.id, recipient: recipient.id, senderPlace: here.id, recipientPlace: this.place(thereKey)?.id || thereKey,
      local: !there,
      description: (kind === 'letter' ? 'A sealed letter from ' : 'A small wrapped parcel from ') + sender.name + ' of ' + here.name + ' for ' + recipient.name + ' in ' + thereName + '.',
      ...(need ? { reveals: need.account } : {}),
      thanks: first(recipient.name) + ' turns it over. “From ' + first(sender.name) + '? I had wondered when I would hear.”'
        + (need ? ' Something else was folded inside, and they hand it to you. “You had better read this. I wrote it myself, and I do not like it.”' : '') };
    plot.commissions = serial;
    plot.people[sender.id] = { id: sender.id, name: sender.name, role: sender.role, place: key, home: sender.home };
    plot.people[recipient.id] = { id: recipient.id, name: recipient.name, role: recipient.role, place: thereKey, home: recipient.home };
    plot.jobs[id] = def;
    story.jobs[id] = { id, state: 'offered', attempts: 0, condition: 'intact', roughSeconds: 0, itemId: 'courier:item:' + id };
    if (need) plot.accounts[need.account] = { by: recipient.id, name: recipient.name, site: def.recipientPlace, siteName: thereName,
      stance: stanceOf(story, recipient.id) };
    this.pruneCommissions();
    this.save(); this.changed({ ok: true, commission: id });
    return def;
  }
  /** Keep a short memory of finished commissions: the latest few stay readable, the rest become a count. */
  pruneCommissions() {
    const story = this.story, plot = story.plot;
    const done = Object.values(plot.jobs).filter(def => story.jobs[def.id]?.state === 'delivered');
    for (const def of done.slice(0, Math.max(0, done.length - 3))) {
      for (const receipt of story.jobs[def.id].receipts || []) delete this.state.effectReceipts[receipt];
      delete this.state.effectReceipts['courier:delivered:' + def.id];
      delete this.state.projections.items[story.jobs[def.id].itemId];
      delete plot.jobs[def.id]; delete story.jobs[def.id]; delete story.knownOffers[def.id]; delete story.leads['job:' + def.id];
      for (const knowledge of Object.values(story.knowledge)) delete knowledge.jobs?.[def.id];
      plot.delivered = (plot.delivered || 0) + 1;
    }
    // People are remembered while a commission or an account still names them.
    const named = new Set([...Object.values(plot.jobs).flatMap(def => [def.sender, def.recipient]), ...Object.values(plot.accounts).map(cast => cast.by)]);
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
    const story = this.story, knowledge = story.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
    const before = knowledge.evidence.length;
    knowledge.evidence = [...new Set([...knowledge.evidence, ...evidenceIds])];
    // Residents outside the round remember only the latest few they were shown.
    const kept = Object.keys(story.knowledge).filter(id => !this.roleFor(id));
    for (const id of kept.slice(0, Math.max(0, kept.length - 24))) delete story.knowledge[id];
    const glitch = STORY_GLITCHES.some(beat => beatDone(story, beat));
    const voices = Object.keys(story.plot.voices).length;
    const { stance, counted } = recordVoice(story, speakerId);
    if (knowledge.evidence.length !== before) {
      rememberSocialMemory(this.state, speakerId, {
        id: 'memory:courier:shown:' + speakerId + ':' + knowledge.evidence.length, lineageId: 'courier:shown:' + speakerId,
        subject: { kind: 'player', id: this.state.playerId }, predicate: 'courier.evidence-shared', object: { evidenceIds: knowledge.evidence.slice(-6) },
        summary: 'The traveller showed me papers that do not agree with each other.', source: { kind: 'courier', id: 'shown' },
        provenance: 'told', privacy: 'personal', confidence: 1, salience: 0.6, createdAtHour: this.state.clock.worldHours });
    }
    this.save();
    const message = glitch ? STORY_REACTIONS[stance][storyStage(story)] : 'There may be a copying error. Still, these are worth keeping together.';
    return this.changed({ ok: true, applied: true, persisted: true, stance, counted,
      message: message + (counted && voices < 2 && Object.keys(story.plot.voices).length >= 2 ? '\nTwo people have now told you what they make of it, and they do not agree.' : '') });
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
        .map(j => ({ id: j.id, title: j.title })),
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
    // The closer opens the conversation: they asked for the courier.
    ...(this.story.plot.closer?.id === speakerId && beatOpen(this.story, 'ending') ? { calling: this.story.plot.closer.name + ' has been watching the lane. “You are the courier. They say you carry papers that do not agree. I asked for you. Show me.”' } : {}),
    travelLessons: [
      { id: 'foot', title: 'Finding the way on foot', text: 'Use the compass, landmarks and the destination names on physical road posts. Ask for directions at a village, and keep the ones you want in your notebook. The book has space for your own sketches; you can print those pages before a journey.' },
      ...(role === 'guide' ? [{ id: 'horse', title: 'Learning to ride', text: 'Stand beside a calm horse. R mounts or dismounts; in VR use left Y. W and S move forward and back, and A and D steer; in VR use the left stick. Hold Shift or press the movement stick to gallop. Take a fragile parcel at a walk: running, galloping and jumping can chip it. Open your book to stop steering and make a note.' }] : []),
      ...(['dispatcher', 'archivist'].includes(role) ? [{ id: 'train', title: 'Taking the regional train', text: 'Wait on the platform until the train stops and its doors slide open, then walk through a doorway. Inside, E or right B lets you sit by a seat; use it again to stand. Read the named stops and arrival hints, and walk out through an open door at your destination. You can read and write in your book while the train carries you. It is a gentle way to carry a fragile parcel.' }] : []),
    ],
    routes: clone(this.story.bindings.routes?.[place] || this.getRoutes?.(place) || []),
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
        return { message: 'The fragile cup has chipped. Walk gently or use the train; it can still be delivered.' };
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
