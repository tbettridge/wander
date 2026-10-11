import { applyLivingWorldEventOnce } from './livingworldstate.mjs?v=courier1';
import { createItem, transferItem } from './npcitems.mjs';
import { applyRelationshipDelta, rememberSocialMemory } from './npcsocialmemory.mjs';
import { COURIER_VERSION, COURIER_SCENARIO, COURIER_JOBS, COURIER_ROLES,
  COURIER_EVIDENCE, COURIER_THREADS, courierSources, validateCreativeWork,
  fallbackCreativeWork } from './couriercontent.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity;
const fail = reason => ({ ok: false, applied: false, reason });
const itemId = job => 'courier:item:' + job.id;
export function initializeCourier(state, bindings) {
  if (state.courier) return state.courier;
  for (const role of Object.keys(COURIER_ROLES)) {
    if (!state.entities[bindings.cast[role]?.id]) throw new Error('Missing canonical courier resident: ' + role);
  }
  state.courier = {
    version: COURIER_VERSION, scenarioId: COURIER_SCENARIO,
    runId: globalThis.crypto?.randomUUID?.() || String(Date.now()) + ':' + Math.random(),
    bindings: clone(bindings), sequence: 0,
    jobs: Object.fromEntries(COURIER_JOBS.map(j => [j.id, { id: j.id, state: 'offered',
      attempts: 0, condition: 'intact', roughSeconds: 0, itemId: itemId(j) }])),
    knownOffers: {}, evidence: {}, compared: {}, knowledge: {}, works: {}, hypothesis: false,
    travel: { distances: {}, visited: {}, observations: [] }, resume: null, mount: null,
  };
  return state.courier;
}
export class CourierController {
  constructor({ getState, getPlayer, getNpcPosition, getSourcePosition, save = () => true, director = null }) {
    Object.assign(this, { getState, getPlayer, getNpcPosition, getSourcePosition, save, director });
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
  learnOffer(jobId, speakerId) {
    const def = COURIER_JOBS.find(j => j.id === jobId);
    if (!def || this.npc(def.sender)?.id !== speakerId || !this.nearby(speakerId)) return fail('Talk to the sender to learn about this job.');
    if (this.story.knownOffers[jobId]) return { ok: true, applied: false };
    return this.commit('offer-seen', { jobId, speakerId }, draft => {
      draft.courier.knownOffers[jobId] = true;
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
    return this.commit('accepted', { jobId, speakerId }, (draft, event) => {
      const current = draft.courier.jobs[jobId];
      createItem(draft, { id: current.itemId, kind: def.kind, ownerId: speakerId,
        purpose: 'courier', condition: current.condition });
      transferItem(draft, current.itemId, draft.playerId, { eventId: event.id });
      current.state = 'active'; current.attempts++; current.acceptedAtHour = event.atHour;
      draft.courier.knownOffers[jobId] = true;
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.jobs[jobId] = { state: 'accepted', condition: current.condition };
      this.remember(draft, speakerId, event, 'The traveller accepted ' + def.title + '.');
      return { jobId, message: def.title + ' is in your satchel.' };
    });
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
      return { jobId, message: returning ? 'The parcel is safely back with its sender.'
        : current.condition === 'chipped' ? 'A small chip, but it still holds tea. Thank you for bringing it.' : 'Thank you. This will be put to good use.' };
    }, returning ? null : 'courier:delivered:' + jobId);
  }
  sources() { return courierSources(this.story?.bindings); }
  discover(sourceId, speakerId = null) {
    const source = this.sources().find(s => s.sourceId === sourceId);
    if (!source) return fail('Unknown source.');
    const role = this.roleFor(speakerId);
    const present = speakerId ? this.nearby(speakerId) && COURIER_ROLES[role] === source.place
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
      return { message: 'Perhaps the records and recollections are repeating parts of other lives. Who would make sense of this?' };
    }, 'courier:hypothesis');
  }
  shareEvidence(speakerId, evidenceIds) {
    if (!this.roleFor(speakerId) || !this.nearby(speakerId) || !evidenceIds?.length
      || evidenceIds.some(id => !this.story.evidence[id])) return fail('Share only accounts you have actually read, with someone nearby.');
    return this.commit('evidence-shared', { speakerId, evidenceIds: [...new Set(evidenceIds)] }, (draft, event) => {
      const knowledge = draft.courier.knowledge[speakerId] ||= { jobs: {}, evidence: [] };
      knowledge.evidence = [...new Set([...knowledge.evidence, ...evidenceIds])];
      this.remember(draft, speakerId, event, 'The traveller showed me the accounts they had collected.', 'told');
      return { message: this.roleFor(speakerId) === 'poet'
        ? 'Different lives leaving the same footprints… I would like to hear more.'
        : 'There may be a copying error. Still, these are worth keeping together.' };
    });
  }
  contextForNpc(speakerId) {
    const role = this.roleFor(speakerId);
    if (!role) return null;
    const place = COURIER_ROLES[role], knowledge = this.story.knowledge[speakerId] || { jobs: {}, evidence: [] };
    const evidenceIds = new Set([...COURIER_EVIDENCE.filter(e => e.places.includes(place)).map(e => e.id), ...knowledge.evidence]);
    const evidence = this.sources().filter(s => evidenceIds.has(s.id))
      .filter((s, i, all) => all.findIndex(e => e.id === s.id) === i)
      .map(({ id, title, text }) => ({ id, title, text }));
    return { responsibility: role, offers: COURIER_JOBS.filter(j => j.sender === role).map(j => ({
      title: j.title, description: j.description, recipient: this.npc(j.recipient).name,
      destination: this.story.bindings.places[COURIER_ROLES[j.recipient]].name,
      recipientAddress: this.npc(j.recipient).home?.address,
      lastWitnessedState: knowledge.jobs[j.id]?.state || 'offered',
    })), witnessedJobs: clone(knowledge.jobs), evidence,
    people: Object.entries(this.story.bindings.cast).filter(([personRole]) => COURIER_ROLES[personRole] === place
      || COURIER_JOBS.some(j => j.sender === role && j.recipient === personRole))
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
