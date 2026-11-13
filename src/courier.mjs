import { applyLivingWorldEventOnce } from './livingworldstate.mjs?v=courier1';
import { createItem, transferItem } from './npcitems.mjs';
import { applyRelationshipDelta, rememberSocialMemory } from './npcsocialmemory.mjs';
import { COURIER_VERSION, COURIER_SCENARIO, COURIER_JOBS, COURIER_ROLES,
  COURIER_EVIDENCE, COURIER_THREADS, courierSources, validateCreativeWork,
  fallbackCreativeWork, upgradeCourierOnboarding, COURIER_ENDING, courierRank, courierText } from './couriercontent.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity;
const fail = reason => ({ ok: false, applied: false, reason });
const itemId = job => 'courier:item:' + job.id;
export function initializeCourier(state, bindings) {
  if (state.courier) return upgradeCourierOnboarding(state.courier);
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
  return upgradeCourierOnboarding(state.courier);
}
export class CourierController {
  constructor({ getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace = null, save = () => true, director = null }) {
    Object.assign(this, { getState, getPlayer, getNpcPosition, getSourcePosition, getNpcPlace, getKnownPlace, save, director });
    this.previousPosition = null;
    this.workRequests = new Map();
    this.listeners = new Set();
  }
  get state() { return this.getState(); }
  get story() { return this.state.courier; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(result) { for (const listener of this.listeners) listener(result); return result; }
  roleFor(npcId) { return Object.keys(COURIER_ROLES).find(role => this.story?.bindings.cast[role]?.id === npcId); }
  npc(role) { return this.story?.bindings.cast[role]; }
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
    if (role) return COURIER_ROLES[role];
    const provided = this.getNpcPlace?.(npcId);
    if (this.story?.bindings.places[provided]) return provided;
    const entity = this.state.entities[npcId], household = this.state.households?.[entity?.householdId];
    const settlementId = household?.settlementId || entity?.homeSettlementId;
    return Object.keys(this.story?.bindings.places || {}).find(key => this.story.bindings.places[key].id === settlementId) || null;
  }
  boardJobs(place) {
    if (!this.story?.bindings.places[place]) return [];
    return COURIER_JOBS.filter(j => COURIER_ROLES[j.sender] === place).map(j => ({
      ...j, state: this.story.jobs[j.id].state, sender: clone(this.npc(j.sender)),
      recipient: clone(this.npc(j.recipient)), destinationName: this.story.bindings.places[COURIER_ROLES[j.recipient]].name,
      senderPlaceName: this.story.bindings.places[COURIER_ROLES[j.sender]].name,
    }));
  }
  localOpportunities(npcId) {
    return this.boardJobs(this.placeForNpc(npcId)).filter(j => !['active', 'delivered'].includes(j.state));
  }
  storeLead(story, job, source, atHour) {
    story.knownOffers[job.id] = true;
    story.leads['job:' + job.id] ||= { jobId: job.id, source: clone(source), learnedAtHour: atHour,
      summary: job.title + ': ask ' + this.npc(job.sender).name + ' in ' + this.story.bindings.places[COURIER_ROLES[job.sender]].name + '.' };
  }
  readBoard(place) {
    if (!this.story?.bindings.places[place] || distance(this.getPlayer(), this.getSourcePosition('board:' + place)) > 4.5)
      return fail('Stand beside the Post & Errands board to read its notices.');
    const jobs = this.boardJobs(place);
    const unseen = jobs.some(j => !this.story.leads['job:' + j.id]);
    if (!unseen) return { ok: true, applied: false, jobs, message: 'These public notices are in your Leads page. Collect a parcel from its sender.' };
    return this.commit('board-read', { place }, (draft, event) => {
      for (const card of jobs) this.storeLead(draft.courier, COURIER_JOBS.find(j => j.id === card.id),
        { kind: 'board', id: 'board:' + place, name: 'Post & Errands, ' + this.story.bindings.places[place].name }, event.atHour);
      return { jobs, message: 'Notices copied to Leads. Visit the sender to ask about a parcel; reading a notice accepts no work.' };
    });
  }
  learnReferrals(npcId, place = this.placeForNpc(npcId)) {
    if (!place || place !== this.placeForNpc(npcId) || !this.nearby(npcId)) return fail('Ask someone nearby about their local errands.');
    const jobs = this.localOpportunities(npcId);
    if (!jobs.some(j => !this.story.leads['job:' + j.id])) return { ok: true, applied: false, jobs };
    return this.commit('referral', { npcId, place }, (draft, event) => {
      for (const card of jobs) this.storeLead(draft.courier, COURIER_JOBS.find(j => j.id === card.id),
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
    const person = this.npc(role), places = this.story.bindings.places, there = places[COURIER_ROLES[role]];
    if (!person || !there) return '';
    const player = this.getPlayer?.(), home = person.home?.address || 'known to people in ' + there.name;
    // Where the courier knows they are (the last name sign, board or station
    // they passed), when the game tracks it; otherwise the nearest village.
    const known = this.getKnownPlace ? places[this.getKnownPlace()] || null : undefined;
    const here = known !== undefined ? known : player && Object.values(places).filter(place => Number.isFinite(place.x))
      .reduce((best, place) => !best || distance(player, place) < distance(player, best) ? place : best, null);
    if (here === there && (known !== undefined || distance(player, there) < 450))
      return 'Their home is ' + home + '. Find the well and use your compass, or ask anyone nearby to point the way.';
    const train = here?.stationId && there.stationId && here !== there;
    return there.name + ' is another village. ' + (train ? 'The regional train stops there; on foot or horseback, ' : 'To get there, ')
      + 'follow the road posts marked “' + there.name + '” (anyone can point out the first one). Once there, their home is ' + home + '.';
  }
  deliveredCount() { return Object.values(this.story.jobs).filter(j => j.state === 'delivered').length; }
  standing() {
    const delivered = this.deliveredCount();
    return { delivered, total: COURIER_JOBS.length, rank: courierRank(delivered) };
  }
  readyThread() {
    return COURIER_THREADS.find(t => !this.story.compared[t.id] && t.evidence.every(id => this.story.evidence[id])) || null;
  }
  contactDirections(jobId) {
    const def = COURIER_JOBS.find(j => j.id === jobId), sender = def && this.npc(def.sender);
    if (!sender) return 'Ask a local about work or look for the Post & Errands board by a village well.';
    const atDesk = def.sender === 'dispatcher' && this.story.jobs['village-note'].state !== 'delivered';
    return sender.name + ' has ' + def.title + '. '
      + (atDesk ? 'They work at the post desk beside the well in ' + this.story.bindings.places.A.name + '.' : this.wayTo(def.sender))
      + ' Walk up, press T to talk, then choose Accept.';
  }
  guidance() {
    const story = this.story;
    const thread = this.readyThread();
    if (thread) return { title: 'Two accounts do not agree', view: 'stories',
      text: 'You now hold both accounts of “' + thread.title + '”. Open your book (N), choose Story and compare them.' };
    if (!story.hypothesis && Object.keys(story.compared).filter(id => story.compared[id]).length >= 2)
      return { title: 'A pattern is forming', view: 'stories', text: 'You have compared two sets of accounts. Open your book (N), choose Story and consider the larger pattern.' };
    const active = Object.values(story.jobs).filter(j => j.state === 'active');
    const focused = story.jobs[story.focusJobId];
    const job = focused?.state === 'active' ? focused : active[0];
    if (job) {
      const def = COURIER_JOBS.find(j => j.id === job.id), recipient = this.npc(def.recipient);
      return { title: 'Deliver ' + def.title, jobId: job.id,
        text: 'Take it to ' + recipient.name + ' in ' + story.bindings.places[COURIER_ROLES[def.recipient]].name + '. '
          + this.wayTo(def.recipient) + ' Walk up, press T to talk, then choose Deliver.' };
    }
    if (story.hypothesis && !story.concluded) {
      const poet = this.npc('poet');
      return { title: 'Someone should hear this', text: 'Take what you have found to ' + poet.name + ', the poet in '
        + story.bindings.places[COURIER_ROLES.poet].name + '. ' + this.wayTo('poet') + ' Press T to talk, then choose “Show what I found”.' };
    }
    // A job the player passed on is not suggested again; they can still ask for it.
    const open = j => ['offered', 'returned'].includes(story.jobs[j.id].state);
    if (focused && open(focused)) return { title: 'Collect ' + COURIER_JOBS.find(j => j.id === focused.id).title, jobId: focused.id, text: this.contactDirections(focused.id) };
    const player = this.getPlayer?.();
    const reach = j => { const at = this.whereIs(j.sender); return at && player ? distance(player, at) : Infinity; };
    const next = COURIER_JOBS.filter(open).sort((a, b) => Number(!story.knownOffers[a.id]) - Number(!story.knownOffers[b.id]) || reach(a) - reach(b))[0];
    if (next && (story.knownOffers[next.id] || this.deliveredCount() > 0 || story.onboarding.choice === 'easy'))
      return { title: 'Next errand: ' + next.title, jobId: next.id, text: this.contactDirections(next.id) };
    if (next) return { title: 'Find work when you want it', text: 'Press E at the Post & Errands board beside the village well, or press T beside anyone and ask “Is there any delivery work?” N opens your book. You can also just explore.' };
    return { title: story.concluded ? 'The round is yours' : 'Every parcel is delivered',
      text: story.concluded ? 'Every errand is done and the poet has heard what you found. Wander as you like; your book keeps it all.'
        : 'Read the public accounts on the stands by each village well, and compare them in your book’s Story page.' };
  }
  learnOffer(jobId, speakerId) {
    const def = COURIER_JOBS.find(j => j.id === jobId);
    if (!def || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)) return fail('Talk to the sender to learn about this job.');
    if (this.story.leads['job:' + jobId]) return { ok: true, applied: false };
    return this.commit('offer-seen', { jobId, speakerId }, (draft, event) => {
      this.storeLead(draft.courier, def, { kind: 'npc', id: speakerId, name: this.npc(def.sender).name }, event.atHour);
      return { jobId };
    });
  }
  accept(jobId, speakerId) {
    const def = COURIER_JOBS.find(j => j.id === jobId), job = this.story?.jobs[jobId];
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
    const recipient = this.npc(def.recipient), places = this.story.bindings.places;
    const fromKey = COURIER_ROLES.dispatcher, toKey = COURIER_ROLES[def.recipient], there = places[toKey];
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
    const def = COURIER_JOBS.find(j => j.id === jobId), job = this.story?.jobs[jobId];
    if (!def || !job || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)
      || ['active', 'delivered'].includes(job.state)) return fail('This offer cannot be declined here.');
    if (job.state === 'declined') return { ok: true, applied: false, message: 'You can ask about this errand again whenever you like.' };
    return this.commit('declined', { jobId, speakerId }, draft => {
      draft.courier.jobs[jobId].state = 'declined'; draft.courier.knownOffers[jobId] = true;
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: 'declined', condition: job.condition };
      return { jobId, message: 'Of course. You can ask again whenever you like.' };
    });
  }
  handoff(jobId, speakerId, returning = false) {
    const def = COURIER_JOBS.find(j => j.id === jobId), job = this.story?.jobs[jobId];
    if (!def || !job) return fail('Unknown commission.');
    if (!returning && job.state === 'delivered') return { ok: true, duplicate: true, applied: false };
    const target = this.npc(returning ? def.sender : def.recipient)?.id;
    if (target !== speakerId || !this.nearby(target)) return fail('Find the ' + (returning ? 'sender' : 'recipient') + ' before handing it over.');
    if (job.state !== 'active' || this.state.projections.items[job.itemId]?.ownerId !== this.state.playerId) return fail('That parcel is not in your satchel.');
    return this.commit(returning ? 'returned' : 'delivered', { jobId, speakerId, condition: job.condition }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      transferItem(draft, current.itemId, target, { eventId: event.id, condition: current.condition });
      current.state = returning ? 'returned' : 'delivered';
      if (!returning) current.deliveredAtHour = event.atHour;
      const knowledge = draft.courier.knowledge[target] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: current.state, condition: current.condition };
      this.remember(draft, target, event, returning ? 'The traveller returned ' + def.title + '.'
        : 'The traveller delivered ' + def.title + (current.condition === 'chipped' ? ', with a chipped cup.' : '.'));
      if (!returning) applyRelationshipDelta(draft, target, draft.playerId,
        { familiarity: 0.08, trust: current.condition === 'chipped' ? 0.01 : 0.04 }, event);
      const next = !returning && COURIER_JOBS.find(j => this.npc(j.sender)?.id === target
        && !['active', 'delivered'].includes(draft.courier.jobs[j.id].state));
      if (next) this.storeLead(draft.courier, next, { kind: 'npc', id: target, name: this.state.entities[target].name }, event.atHour);
      const nextLead = returning ? null : next ? { jobId: next.id, title: next.title }
        : { place: COURIER_ROLES[def.recipient], kind: 'reading-stand' };
      const revealed = returning ? null : this.grantEvidence(draft.courier, def.reveals);
      const thanks = jobId === 'village-note' ? 'The guide opens your note and sets it beside the trail papers. Your first delivery is complete.'
        : (def.thanks || 'Thank you. This will be put to good use.')
          + (current.condition === 'chipped' ? ' “A small chip, but it still holds tea.”' : '');
      const delivered = Object.values(draft.courier.jobs).filter(j => j.state === 'delivered').length;
      const rank = courierRank(delivered), promoted = !returning && rank !== courierRank(delivered - 1);
      return { jobId, nextLead, revealed: revealed?.id || null, standing: { delivered, total: COURIER_JOBS.length, rank },
        message: returning ? 'The parcel is safely back with its sender.' : thanks
          + (revealed ? '\nNew in your book: “' + revealed.title + '”.' : '')
          + '\n' + delivered + ' of ' + COURIER_JOBS.length + ' delivered' + (promoted ? ' — you are now “' + rank + '”.' : '.')
          + (next ? ' ' + this.state.entities[target].name + ' has another errand if you want it: ' + next.title + '.' : '') };
    }, returning ? null : 'courier:delivered:' + jobId);
  }
  sources() { return courierSources(this.story?.bindings); }
  /** Record an account the courier was handed or shown; returns it when new. */
  grantEvidence(story, evidenceId) {
    const evidence = evidenceId && COURIER_EVIDENCE.find(e => e.id === evidenceId);
    if (!evidence) return null;
    const record = story.evidence[evidence.id] ||= { id: evidence.id, sourceIds: [] };
    const isNew = !record.sourceIds.length;
    const sourceId = evidence.id + ':' + evidence.places[0];
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
      const evidence = draft.courier.evidence[source.id] ||= { id: source.id, sourceIds: [] };
      if (!evidence.sourceIds.includes(sourceId)) evidence.sourceIds.push(sourceId);
      return { evidenceId: source.id, document: source };
    }, 'courier:source:' + sourceId);
  }
  compare(threadId) {
    const thread = COURIER_THREADS.find(t => t.id === threadId);
    if (!thread || !thread.evidence.every(id => this.story.evidence[id])) return fail('Collect both accounts before comparing them.');
    return this.commit('compared', { threadId }, draft => {
      draft.courier.compared[threadId] = true;
      return { message: thread.comparison };
    }, 'courier:compared:' + threadId);
  }
  formHypothesis() {
    if (Object.keys(this.story.compared).filter(id => this.story.compared[id]).length < 2) return fail('Compare discoveries from two different threads first.');
    return this.commit('hypothesis', {}, draft => {
      draft.courier.hypothesis = true;
      return { message: 'Perhaps the records and recollections are repeating parts of other lives. '
        + this.npc('poet').name + ', the poet in ' + this.story.bindings.places[COURIER_ROLES.poet].name + ', might make sense of this.' };
    }, 'courier:hypothesis');
  }
  shareEvidence(speakerId, evidenceIds) {
    if (!this.roleFor(speakerId) || !this.nearby(speakerId) || !evidenceIds?.length
      || evidenceIds.some(id => !this.story.evidence[id])) return fail('Share only accounts you have actually read, with someone nearby.');
    return this.commit('evidence-shared', { speakerId, evidenceIds: [...new Set(evidenceIds)] }, (draft, event) => {
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.evidence = [...new Set([...knowledge.evidence, ...evidenceIds])];
      this.remember(draft, speakerId, event, 'The traveller showed me the accounts they had collected.', 'told');
      const role = this.roleFor(speakerId);
      if (role === 'poet' && draft.courier.hypothesis && !draft.courier.concluded) {
        draft.courier.concluded = true; draft.courier.concludedAtHour = event.atHour;
        const text = COURIER_ENDING.lines.map(line => courierText(line, draft.courier.bindings)).join('\n\n');
        return { ending: { title: COURIER_ENDING.title, text }, message: 'The poet has something to say about what you found.' };
      }
      return { message: role === 'poet'
        ? 'Different lives leaving the same footprints… Compare what you have, and bring me the pattern when you see one.'
        : draft.courier.hypothesis ? 'I only keep the records. Take this to ' + this.npc('poet').name + ', the poet in '
          + draft.courier.bindings.places[COURIER_ROLES.poet].name + '; they will know what to make of it.'
          : 'There may be a copying error. Still, these are worth keeping together.' };
    });
  }
  contextForNpc(speakerId, { place: requestedPlace } = {}) {
    const role = this.roleFor(speakerId);
    const place = this.placeForNpc(speakerId);
    if (!place || (requestedPlace && requestedPlace !== place)) return null;
    const knowledge = this.story.knowledge[speakerId] || { jobs: {}, evidence: [] };
    const evidenceIds = new Set([...COURIER_EVIDENCE.filter(e => e.places.includes(place)).map(e => e.id), ...knowledge.evidence]);
    const evidence = this.sources().filter(s => evidenceIds.has(s.id))
      .filter((s, i, all) => all.findIndex(e => e.id === s.id) === i)
      .map(({ id, title, text }) => ({ id, title, text }));
    const boardPosition = this.getSourcePosition('board:' + place);
    return { responsibility: role || 'neighbor', place,
      npc: { id: speakerId, name: this.state.entities[speakerId]?.name || 'A local resident' },
      localOpportunities: this.localOpportunities(speakerId),
      boardTarget: { ...boardPosition, id: 'board:' + place, kind: 'place', name: 'Post & Errands board by the well',
        worldX: boardPosition?.x, worldZ: boardPosition?.z },
      deliveries: COURIER_JOBS.filter(j => j.recipient === role && this.story.jobs[j.id].state === 'active')
        .map(j => ({ id: j.id, title: j.title })),
      standing: this.standing(),
      offers: COURIER_JOBS.filter(j => j.sender === role).map(j => ({
      id: j.id, jobId: j.id, local: !!j.local,
      title: j.title, description: j.description, recipient: this.npc(j.recipient).name,
      destination: this.story.bindings.places[COURIER_ROLES[j.recipient]].name,
      recipientAddress: this.npc(j.recipient).home?.address,
      lastWitnessedState: knowledge.jobs[j.id]?.state || 'offered',
    })), witnessedJobs: clone(knowledge.jobs), evidence,
    people: Object.entries(this.story.bindings.cast).filter(([personRole]) => COURIER_ROLES[personRole] === place
      || (role && COURIER_JOBS.some(j => j.sender === role && j.recipient === personRole)))
      .map(([personRole, person]) => ({ id: person.id, name: person.name, responsibility: personRole,
        address: person.home?.address, place: person.place })),
    belief: COURIER_THREADS.filter(t => t.evidence.every(id => evidenceIds.has(id))).length >= 2
      ? 'curious about the inconsistencies; you have no proof of their cause' : 'ordinary explanations seem plausible',
    travelLessons: [
      { id: 'foot', title: 'Finding the way on foot', text: 'Use the compass, landmarks and the destination names on physical road posts. Ask for directions at a village, and keep the ones you want in your notebook. The book has space for your own sketches; you can print those pages before a journey.' },
      ...(role === 'guide' ? [{ id: 'horse', title: 'Learning to ride', text: 'Stand beside a calm horse. R mounts or dismounts; in VR use left Y. W and S move forward and back, and A and D steer; in VR use the left stick. Hold Shift or press the movement stick to gallop. Take a fragile parcel at a walk: running, galloping and jumping can chip it. Open your book to stop steering and make a note.' }] : []),
      ...(['dispatcher', 'archivist'].includes(role) ? [{ id: 'train', title: 'Taking the regional train', text: 'Wait on the platform until the train stops and its doors slide open, then walk through a doorway. Inside, E or right B lets you sit by a seat; use it again to stand. Read the named stops and arrival hints, and walk out through an open door at your destination. You can read and write in your book while the train carries you. It is a gentle way to carry a fragile parcel.' }] : []),
    ],
    routes: clone(this.story.bindings.routes?.[place] || []),
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
    for (const def of COURIER_JOBS.filter(j => j.fragile)) {
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
    const events = this.story.travel.observations.map(o => ({ id: o.id, summary: o.summary }));
    for (const [id, job] of Object.entries(this.story.jobs)) if (job.state === 'delivered') {
      const def = COURIER_JOBS.find(j => j.id === id);
      events.push({ id: 'delivery:' + id, summary: 'Delivered ' + def.title + ' to ' + this.npc(def.recipient).name + (job.condition === 'chipped' ? ', with a chipped cup.' : '.') });
    }
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
