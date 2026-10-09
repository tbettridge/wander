import { createNpcNarrativeConversation, retrieveNpcConversationNarrative, commitNpcConversationNarrative } from './npcnarrativecontinuity.mjs?v=embeddings1';
import { fallbackMemorySynthesis, combineNpcMemory } from './npcmemory.mjs?v=live1';
import { beginPlayerConversation, recordPlayerConversationOutcome } from './npcrumor.mjs';

// This bridge shares the existing fact validation and memory stores. Voice
// sessions do not open the modal chat or acquire the player's walking controls.
export class NpcLiveEncounterBridge {
  constructor(population, { synthesize, isGuest = () => false } = {}) {
    this.population = population; this.synthesize = synthesize; this.isGuest = isGuest;
  }
  async open(actor, conversationId) {
    const population = this.population, npcId = actor.identity.id;
    if (population.isTalkingTo(npcId) || !population.reserveRemoteDialogue(npcId, conversationId)) return null;
    try {
      const remote = this.isGuest() && population.conversationBridge;
      const opened = remote ? await remote.open({ npcId, live: true }) : null;
      const context = opened?.context || population.contextForActor(actor, { encounterCount: population.readEncounterCount(actor) });
      if (!context) throw new Error('NPC context unavailable');
      return { context, npcId, conversationId, remoteConversationId: opened?.conversationId,
        state: population.worldState, memoryStore: population.memoryStore,
        livingWorldStore: population.livingWorldStore,
        narrative: createNpcNarrativeConversation({ state: population.worldState, context }),
        worldConversation: remote ? null : beginPlayerConversation(population.worldState, npcId, {
          playerId: population.playerId, nowHour: population.worldState.clock.worldHours,
        }),
      };
    } catch (error) { population.releaseRemoteDialogue(npcId, conversationId); throw error; }
  }
  lookup(encounter, text) {
    const reservation = encounter.reservation;
    if (reservation.remoteConversationId) return this.population.conversationBridge?.lookup?.({ conversationId: reservation.remoteConversationId, query: text });
    return retrieveNpcConversationNarrative(reservation.narrative, {
      state: reservation.state, context: reservation.context, text, conversationId: reservation.conversationId,
    });
  }
  checkpoint(encounter) {
    const reservation = encounter.reservation;
    if (!reservation || reservation.closed) return;
    const transcript = encounter.transcript.slice(-18);
    if (reservation.remoteConversationId) return this.population.conversationBridge?.checkpoint?.({ conversationId: reservation.remoteConversationId, transcript });
    if (transcript.length) {
      const previous = reservation.memoryStore.load(reservation.npcId);
      const memory = fallbackMemorySynthesis(previous, reservation.context, transcript);
      memory.meetingCount = previous.meetingCount;
      reservation.memoryStore.save(reservation.npcId, memory);
      reservation.context.memory = memory;
    }
  }
  async close(encounter) {
    const reservation = encounter.reservation;
    if (!reservation || reservation.closed) return;
    reservation.closed = true;
    const population = this.population, { npcId, conversationId, context, state, memoryStore } = reservation;
    population.releaseRemoteDialogue(npcId, conversationId);
    const transcript = (reservation.remoteConversationId ? encounter.transcript.slice(-18) : encounter.transcript).map(message => ({ ...message }));
    if (reservation.remoteConversationId) {
      const remote = population.conversationBridge;
      try { await remote?.close?.({ conversationId: reservation.remoteConversationId, transcript }); } catch { /* disconnect also releases the actor */ }
      if (transcript.length && this.synthesize) {
        const synthesis = await this.synthesize(context, transcript, conversationId);
        return remote?.commit?.({ conversationId: reservation.remoteConversationId, synthesis, transcript });
      }
      return;
    }
    if (!transcript.length) return;
    const provisional = fallbackMemorySynthesis(context.memory, context, transcript);
    provisional.meetingCount = Math.max(context.memory?.meetingCount || 0, memoryStore.load(npcId)?.meetingCount || 0) + 1;
    memoryStore.save(npcId, provisional);
    try { globalThis.localStorage?.setItem(population.storageKey(encounter.actor), String(population.readEncounterCount(encounter.actor) + 1)); } catch { /* optional */ }
    if (population.features.socialMemoryEnabled) recordPlayerConversationOutcome(state, reservation.worldConversation, {
      npcId, playerId: context.player?.id || population.playerId,
      playerTurns: transcript.filter(message => message.role === 'user').length, nowHour: state.clock.worldHours,
    });
    reservation.livingWorldStore?.save?.(state);
    try {
      if (!this.synthesize) return;
      const synthesis = await this.synthesize(context, transcript, conversationId);
      memoryStore.save(npcId, combineNpcMemory(memoryStore.load(npcId), synthesis, npcId));
      if (population.features.npcNarrativeFactPropagationEnabled && context.homeCommunity) {
        commitNpcConversationNarrative({ state, context, transcript, synthesis, memoryStore });
        reservation.livingWorldStore?.save?.(state);
      }
    } catch { /* The immediate provisional memory remains usable. */ }
  }
}
