import { byteLength } from './multiplayerprotocol.mjs';

/**
 * Host-authoritative rooms for human chat and conversations with one NPC.
 *
 * This module deliberately has no DOM, WebRTC, or Three.js dependency.  The
 * host uses it as the authority and the browser UI uses the same command/event
 * contract through MultiplayerSession.  That makes ordering, membership, and
 * attribution testable without a running renderer.
 */

export const CONVERSATION_PROTOCOL_VERSION = 1;
export const MAX_CONVERSATION_HUMANS = 4;
export const MAX_CONVERSATION_MESSAGE_BYTES = 1_024;
export const MAX_CONVERSATION_EVENTS = 200;
export const MAX_CONVERSATION_CONTEXT_BYTES = 12 * 1024;
export const CONVERSATION_JOIN_RANGE = 9;
export const CONVERSATION_LEAVE_RANGE = 13;
export const CONVERSATION_LEAVE_GRACE_MS = 5_000;

const ROOM_ID_PREFIX = 'room';
const DEFAULT_WORLD_ID = 'world:unknown';

export class ConversationRoomService {
  constructor({
    hostPlayerId = null,
    worldId = DEFAULT_WORLD_ID,
    sessionEpoch = null,
    maxHumans = MAX_CONVERSATION_HUMANS,
    state = null,
    getPlayerPosition = null,
    getNpcPosition = null,
    canShareSpace = null,
    getPlayerProfile = null,
    getNpcContext = null,
    generateNpcReply = null,
    onMemoryCommit = null,
    save = null,
    now = () => Date.now(),
    onEvent = null,
  } = {}) {
    this.hostPlayerId = hostPlayerId ? String(hostPlayerId) : null;
    this.worldId = String(worldId || DEFAULT_WORLD_ID).slice(0, 160);
    this.sessionEpoch = String(sessionEpoch || '').slice(0, 96) || null;
    this.maxHumans = Math.max(2, Math.min(MAX_CONVERSATION_HUMANS, Math.floor(maxHumans) || MAX_CONVERSATION_HUMANS));
    this.state = state && typeof state === 'object' ? state : {};
    this.state.conversationJournal ||= {};
    this.state.conversationReceipts ||= {};
    this.getPlayerPosition = typeof getPlayerPosition === 'function' ? getPlayerPosition : () => null;
    this.getNpcPosition = typeof getNpcPosition === 'function' ? getNpcPosition : null;
    this.canShareSpace = typeof canShareSpace === 'function' ? canShareSpace : () => true;
    this.getPlayerProfile = typeof getPlayerProfile === 'function' ? getPlayerProfile : () => null;
    this.getNpcContext = typeof getNpcContext === 'function' ? getNpcContext : () => null;
    this.generateNpcReply = typeof generateNpcReply === 'function' ? generateNpcReply : null;
    this.onMemoryCommit = typeof onMemoryCommit === 'function' ? onMemoryCommit : null;
    this.save = typeof save === 'function' ? save : () => true;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.rooms = new Map();
    this.playerRooms = new Map();
    this.invites = new Map();
    this.commandReceipts = new Map();
    this.sequence = 0;
  }

  /** Create or join the room belonging to an NPC. */
  openNpc(playerId, { npcId, anchor = null, homeOrigin = null } = {}) {
    const id = this._playerId(playerId);
    const target = this._npcId(npcId);
    if (!id || !target) throw new Error('A resident is required.');
    if (this.getNpcPosition) {
      const at = normalizePosition(this.getNpcPosition(target));
      if (!at) throw new Error('That resident is not available here.');
      this._assertNearby(id, { anchor: at });
    }
    const existing = this.roomForNpc(target);
    if (existing) return this.join(id, { roomId: existing.id, anchor });
    const room = this.createRoom(id, { npcId: target, anchor, homeOrigin });
    return this.snapshotFor(id, { roomId: room.id });
  }

  /** Start a human room and issue an invitation to the requested player. */
  invite(playerId, targetPlayerId, { anchor = null } = {}) {
    const from = this._playerId(playerId);
    const target = this._playerId(targetPlayerId);
    if (!from || !target || from === target) throw new Error('That traveller cannot be invited.');
    if (this.playerRooms.has(from)) throw new Error('Leave the current conversation first.');
    if (!this._hasPlayer(target)) throw new Error('That traveller is not connected.');
    this._assertPlayersNearby(from, target);
    // Pressing T on someone already in a room is the newcomer choosing Join.
    // Reuse that room instead of creating an invitation which could strand the
    // target in their existing conversation.
    const targetRoom = this.roomForPlayer(target);
    if (targetRoom) return this.join(from, { roomId: targetRoom.id, anchor });
    const room = this.createRoom(from, { anchor });
    const inviteId = this._newId('invite');
    const invite = {
      version: CONVERSATION_PROTOCOL_VERSION,
      inviteId,
      roomId: room.id,
      from,
      fromDisplayName: String(this._profile(from).displayName || 'A traveller').slice(0, 28),
      target,
      createdAt: this.now(),
      expiresAt: this.now() + 15_000,
    };
    this.invites.set(inviteId, invite);
    this._emit('invite', room, { invite }, [target]);
    return { ...invite, room: this.snapshotFor(from, { roomId: room.id }) };
  }

  acceptInvite(playerId, inviteId) {
    const id = this._playerId(playerId);
    const invite = this.invites.get(String(inviteId || ''));
    if (!invite || invite.target !== id || invite.expiresAt <= this.now()) {
      throw new Error('That invitation has expired.');
    }
    this.invites.delete(invite.inviteId);
    return this.join(id, { roomId: invite.roomId });
  }

  declineInvite(playerId, inviteId) {
    const id = this._playerId(playerId);
    const invite = this.invites.get(String(inviteId || ''));
    if (!invite || invite.target !== id) return false;
    this.invites.delete(invite.inviteId);
    const room = this.rooms.get(invite.roomId);
    if (room) this._emit('invite-declined', room, { inviteId: invite.inviteId, playerId: id }, [invite.from]);
    if (room && this._activeIds(room).length === 1) this._closeRoom(room, 'invitation-declined');
    return true;
  }

  createRoom(playerId, {
    npcId = null,
    anchor = null,
    homeOrigin = null,
  } = {}) {
    const id = this._playerId(playerId);
    if (!id) throw new Error('A traveller identity is required.');
    if (this.playerRooms.has(id)) throw new Error('Leave the current conversation first.');
    if (npcId && this.roomForNpc(npcId)) throw new Error('That resident is already in a conversation.');
    const room = {
      version: CONVERSATION_PROTOCOL_VERSION,
      id: this._newId(ROOM_ID_PREFIX),
      worldId: this.worldId,
      sessionEpoch: this.sessionEpoch,
      npcId: npcId ? this._npcId(npcId) : null,
      npc: null,
      // The inviter's current position is authoritative. The client-supplied
      // anchor is only a fallback for hosts that do not expose a position
      // provider (for example, a headless test harness).
      anchor: (npcId && this.getNpcPosition ? normalizePosition(this.getNpcPosition(npcId)) : null)
        || normalizePosition(this.getPlayerPosition(id)) || normalizePosition(anchor),
      createdBy: id,
      createdAt: this.now(),
      updatedAt: this.now(),
      seq: 0,
      membershipRevision: 0,
      members: new Map(),
      events: [],
      generation: null,
      _generationTimer: null,
      _lastNpcSeq: 0,
      pendingHumanSeq: 0,
      closed: false,
      homeOrigins: homeOrigin ? { [id]: clone(homeOrigin) } : {},
    };
    this.rooms.set(room.id, room);
    this._addMember(room, id);
    if (room.npcId) {
      const context = this._contextFor(room, id);
      room.npc = sanitizeNpcDescriptor(context?.npc);
      room.npcContext = publicRoomContext(context);
    }
    this._emit('room-created', room, {
      snapshot: this.snapshotFor(id, { roomId: room.id }),
      autoOpen: !!room.npcId,
    }, [id]);
    return room;
  }

  join(playerId, { roomId, anchor = null } = {}) {
    const id = this._playerId(playerId);
    const room = this._room(roomId);
    if (!id || !room || room.closed) throw new Error('That conversation is no longer available.');
    if (room.members.has(id) && room.members.get(id).active) {
      return this.snapshotFor(id, { roomId: room.id });
    }
    if (this.playerRooms.has(id)) throw new Error('Leave the current conversation first.');
    if (this._activeIds(room).length >= this.maxHumans) throw new Error('That conversation is full.');
    this._assertNearby(id, room);
    const previousMembershipRevision = room.membershipRevision;
    const previousUpdatedAt = room.updatedAt;
    const previousAnchor = clone(room.anchor);
    const previousMember = room.members.get(id);
    this._addMember(room, id);
    if (!room.anchor) room.anchor = normalizePosition(this.getPlayerPosition(id)) || normalizePosition(anchor);
    const profile = this._profile(id);
    let event;
    try {
      event = this._appendEvent(room, {
        kind: 'member-joined',
        speakerId: id,
        speakerKind: 'human',
        content: `${profile.displayName || 'A traveller'} joined the conversation.`,
        system: true,
      });
    } catch (error) {
      room.members.delete(id);
      if (previousMember) room.members.set(id, previousMember);
      if (this.playerRooms.get(id) === room.id) this.playerRooms.delete(id);
      room.membershipRevision = previousMembershipRevision;
      room.updatedAt = previousUpdatedAt;
      room.anchor = previousAnchor;
      throw error;
    }
    if (this._invalidateGeneration(room)) this._scheduleNpcTurn(room);
    this._emit('event', room, { event }, this._activeIds(room));
    const snapshot = this.snapshotFor(id, { roomId: room.id });
    this._emit('snapshot', room, { snapshot }, [id]);
    return snapshot;
  }

  leave(playerId, { roomId = null, reason = 'left', synthesis = null } = {}) {
    const id = this._playerId(playerId);
    const room = roomId ? this._room(roomId) : this.roomForPlayer(id);
    if (!id || !room || !room.members.get(id)?.active) return { left: false };
    const member = room.members.get(id);
    const profile = this._profile(id);
    const event = this._appendEvent(room, {
      kind: 'member-left',
      speakerId: id,
      speakerKind: 'human',
      content: `${profile.displayName || 'A traveller'} left the conversation.`,
      system: true,
      reason: String(reason || 'left').slice(0, 48),
    });
    // Commit while the member is still active so snapshotFor can apply the
    // member's join boundary and event audience. The commit is idempotent and
    // therefore also safe when a disconnect and an explicit leave race.
    this._commitParticipantMemory(room, id, { synthesis });
    member.active = false;
    member.leftSeq = event.seq;
    member.leftAt = this.now();
    const interval = member.intervals?.at?.(-1);
    if (interval) {
      interval.leftSeq = member.leftSeq;
      interval.leftAt = member.leftAt;
    }
    this.playerRooms.delete(id);
    room.membershipRevision += 1;
    room.updatedAt = this.now();
    if (this._invalidateGeneration(room)) this._scheduleNpcTurn(room);
    const recipients = this._activeIds(room);
    this._emit('event', room, { event }, [id]);
    this._emit('event', room, { event }, recipients);
    if (!recipients.length) this._closeRoom(room, 'empty');
    return { left: true, roomId: room.id, event };
  }

  say(playerId, { roomId, content, addressedTo = null, commandId = null } = {}) {
    const id = this._playerId(playerId);
    const room = this._room(roomId);
    if (!id || !room || !room.members.get(id)?.active) throw new Error('You are not in that conversation.');
    const text = normalizeMessage(content);
    if (!text) throw new Error('A message is required.');
    const normalizedCommandId = normalizeCommandId(commandId);
    const receiptKey = normalizedCommandId ? `${room.id}:${id}:${normalizedCommandId}` : null;
    if (receiptKey) {
      const prior = this.commandReceipts.get(receiptKey)
        || [...room.events].reverse().find((event) => event.commandId === normalizedCommandId
          && event.speakerId === id && event.speakerKind === 'human');
      if (prior) {
        const priorEvent = prior.event || prior;
        if (priorEvent.content !== text) throw new Error('That message retry used a different text.');
        return clone(prior.event ? prior : {
          accepted: true, roomId: room.id, event: priorEvent, durable: this._isDurable(room.id),
        });
      }
    }
    const recipients = this._activeIds(room);
    const event = this._appendEvent(room, {
      kind: 'message', speakerId: id, speakerKind: 'human', content: text,
      addressedTo: normalizeAudience(addressedTo, room), commandId: normalizedCommandId,
    });
    room.pendingHumanSeq = Math.max(room.pendingHumanSeq, event.seq);
    const result = { accepted: true, roomId: room.id, event, durable: room.npcId ? this._isDurable(room.id) : true };
    if (receiptKey) this.commandReceipts.set(receiptKey, clone(result));
    this._emit('event', room, { event }, recipients);
    if (room.npcId) this._scheduleNpcTurn(room);
    return result;
  }

  /** Accept a reply from the currently assigned edge model. */
  submitNpcReply(playerId, {
    roomId, generationId, content, addressedTo = null, commandId = null,
  } = {}) {
    const id = this._playerId(playerId);
    const room = this._room(roomId);
    const text = normalizeMessage(content);
    if (!text) throw new Error('The NPC returned an empty message.');
    const normalizedCommandId = normalizeCommandId(commandId);
    const receiptKey = normalizedCommandId ? `${room?.id}:${id}:${normalizedCommandId}` : null;
    if (receiptKey) {
      const prior = this.commandReceipts.get(receiptKey)
        || [...(room?.events || [])].reverse().find((event) => event.commandId === normalizedCommandId
          && event.speakerKind === 'npc');
      if (prior) {
        const priorEvent = prior.event || prior;
        if (priorEvent.content !== text) throw new Error('That NPC retry used a different text.');
        return clone(prior.event ? prior : {
          accepted: true, roomId: room?.id, event: priorEvent, durable: this._isDurable(room?.id),
        });
      }
    }
    if (!room?.npcId || !room.generation || room.generation.id !== String(generationId || '')
      || room.generation.assignedTo !== id) throw new Error('That NPC turn is no longer assigned to you.');
    const event = this._appendEvent(room, {
      kind: 'message', speakerId: room.npcId, speakerKind: 'npc', content: text,
      addressedTo: normalizeAudience(addressedTo, room), generationId: room.generation.id,
      commandId: normalizedCommandId,
    });
    room.generation = null;
    if (room._generationTimer) clearTimeout(room._generationTimer);
    room._generationTimer = null;
    room.pendingHumanSeq = room.seq;
    const result = { accepted: true, roomId: room.id, event, durable: this._isDurable(room.id) };
    if (receiptKey) this.commandReceipts.set(receiptKey, clone(result));
    this._emit('event', room, { event }, this._activeIds(room));
    this._commitMemory(room, event);
    this._scheduleNpcTurn(room);
    return result;
  }

  roomForPlayer(playerId) {
    const id = this._playerId(playerId);
    const roomId = this.playerRooms.get(id);
    return roomId ? this.rooms.get(roomId) || null : null;
  }

  roomForNpc(npcId) {
    const id = this._npcId(npcId);
    if (!id) return null;
    return [...this.rooms.values()].find((room) => !room.closed && room.npcId === id) || null;
  }

  /** Apply a human profile change to active room labels without changing IDs. */
  updateProfile(playerId, profile = null) {
    const id = this._playerId(playerId);
    if (!id) return 0;
    const source = profile && typeof profile === 'object' ? profile : this._profile(id);
    const displayName = String(source.displayName || 'Traveller').slice(0, 28);
    const homeOrigin = source.homeOrigin ? clone(source.homeOrigin) : null;
    let updated = 0;
    for (const room of this.rooms.values()) {
      const member = room.members.get(id);
      if (!member || member.displayName === displayName
        && JSON.stringify(member.homeOrigin || null) === JSON.stringify(homeOrigin)) continue;
      member.displayName = displayName;
      member.homeOrigin = homeOrigin;
      updated += 1;
      if (!room.closed) {
        if (this._invalidateGeneration(room)) this._scheduleNpcTurn(room);
        this._emit('profile-updated', room, {
          playerId: id, displayName, homeOrigin,
        }, this._activeIds(room));
      }
    }
    return updated;
  }

  snapshotFor(playerId, { roomId = null, sinceSeq = null } = {}) {
    const id = this._playerId(playerId);
    const room = roomId ? this._room(roomId) : this.roomForPlayer(id);
    if (!room || !room.members.get(id)?.active) throw new Error('You are not in that conversation.');
    const member = room.members.get(id);
    const start = Number.isInteger(sinceSeq) ? Math.max(0, sinceSeq) : member.joinedSeq;
    const events = room.events.filter((event) => event.seq >= start && event.audience.includes(id));
    return {
      version: CONVERSATION_PROTOCOL_VERSION,
      roomId: room.id,
      worldId: room.worldId,
      sessionEpoch: room.sessionEpoch,
      npc: room.npc || null,
      // Rebuild the context for the requesting participant. The room's cached
      // context belongs to its creator and must never expose that person's
      // private NPC memory to a later guest.
      npcContext: safeContext(this._contextFor(room, id) || room.npcContext),
      anchor: clone(room.anchor),
      membershipRevision: room.membershipRevision,
      currentSeq: room.seq,
      members: [...room.members.values()].filter((entry) => entry.active).map(publicMember),
      events: clone(events.slice(-MAX_CONVERSATION_EVENTS)),
      generation: room.generation ? publicGeneration(room.generation, id) : null,
    };
  }

  handleCommand(playerId, command = {}) {
    const op = String(command.op || command.kind || '');
    switch (op) {
      case 'open-npc': return this.openNpc(playerId, command);
      case 'invite': return this.invite(playerId, command.targetPlayerId, command);
      case 'accept-invite': return this.acceptInvite(playerId, command.inviteId);
      case 'decline-invite': return { declined: this.declineInvite(playerId, command.inviteId) };
      case 'join': return this.join(playerId, command);
      case 'resume': return this.join(playerId, command);
      case 'say': return this.say(playerId, command);
      case 'npc-reply': return this.submitNpcReply(playerId, command);
      case 'leave': return this.leave(playerId, command);
      case 'snapshot': return this.snapshotFor(playerId, command);
      default: throw new Error('Unknown conversation command.');
    }
  }

  removePlayer(playerId, reason = 'disconnected') {
    return this.leave(playerId, { reason });
  }

  closeAll(reason = 'session-closed') {
    for (const room of [...this.rooms.values()]) {
      for (const member of room.members.values()) {
        if (member.active) this._commitParticipantMemory(room, member.playerId);
      }
      this._closeRoom(room, reason);
    }
    this.invites.clear();
  }

  /**
   * Replay durable room evidence after a host reload. Active room membership is
   * intentionally not recreated; only accepted participant evidence that lacks
   * its exact-once receipt is projected into the current world.
   */
  async recover() {
    const jobs = [];
    for (const record of Object.values(this.state.conversationJournal || {})) {
      if (!record?.roomId || !record.npcId || !Array.isArray(record.events)) continue;
      const participantIds = Array.isArray(record.participantIds)
        ? [...new Set(record.participantIds.map(String))].slice(0, this.maxHumans) : [];
      const memberRecords = Array.isArray(record.members) ? record.members : [];
      for (const playerId of participantIds) {
        const prior = memberRecords.find((entry) => entry?.playerId === playerId);
        const intervals = Array.isArray(prior?.intervals) && prior.intervals.length
          ? prior.intervals : [{ joinedSeq: Number(prior?.joinedSeq) || 1, leftSeq: null }];
        for (const interval of intervals) {
          const joinedSeq = Math.max(0, Math.floor(Number(interval?.joinedSeq) || 0));
          const receiptKey = `conversation-participant:${record.roomId}:${playerId}:${joinedSeq}`;
          if (this.state.conversationReceipts?.[receiptKey]?.durable) continue;
          const visibleEvents = record.events.filter((event) => {
            if (Array.isArray(event?.audience) && !event.audience.includes(playerId)) return false;
            if (Number.isFinite(Number(event?.seq)) && Number(event.seq) < joinedSeq) return false;
            if (interval?.leftSeq !== null && interval?.leftSeq !== undefined
              && Number.isFinite(Number(interval.leftSeq)) && Number(event.seq) > Number(interval.leftSeq)) return false;
            return true;
          });
          if (!visibleEvents.some((event) => event?.kind === 'message'
            && (event.speakerKind === 'npc' || event.speakerId === playerId))) continue;
          const members = new Map(participantIds.map((id) => {
            const memberRecord = memberRecords.find((entry) => entry?.playerId === id);
            const profile = this._profile(id);
            const latestInterval = memberRecord?.intervals?.at?.(-1);
            return [id, {
              playerId: id,
              displayName: String(memberRecord?.displayName || profile.displayName || 'Traveller').slice(0, 28),
              homeOrigin: clone(memberRecord?.homeOrigin || profile.homeOrigin || null), active: true,
              joinedSeq: Number(latestInterval?.joinedSeq || memberRecord?.joinedSeq) || 1,
              joinedAt: memberRecord?.joinedAt || this.now(),
              intervals: clone(memberRecord?.intervals || []),
            }];
          }));
          members.get(playerId).joinedSeq = joinedSeq;
          const room = {
            ...record,
            id: record.roomId,
            npc: sanitizeNpcDescriptor(record.npc) || { id: record.npcId, name: 'The resident', role: 'resident' },
            members,
            events: visibleEvents,
            anchor: normalizePosition(record.anchor),
            npcContext: null,
          };
          let context = this._contextFor(room, playerId) || {
            npc: room.npc, player: { id: playerId },
          };
          const memberOrigin = members.get(playerId)?.homeOrigin;
          if (memberOrigin?.stationName) {
            context = {
              ...context,
              player: {
                ...(context.player || {}),
                id: playerId,
                originLabel: `traveller from ${String(memberOrigin.stationName).slice(0, 64)}`,
              },
            };
          }
          const details = {
            version: CONVERSATION_PROTOCOL_VERSION,
            roomId: record.roomId,
            worldId: record.worldId || this.worldId,
            sessionEpoch: record.sessionEpoch || this.sessionEpoch,
            npcId: record.npcId,
            playerId,
            joinedSeq,
            participantIds,
            room: {
              roomId: record.roomId,
              worldId: room.worldId,
              sessionEpoch: room.sessionEpoch,
              npc: room.npc,
              anchor: clone(room.anchor),
              members: participantIds.map((id) => publicMember(members.get(id))),
              events: clone(visibleEvents),
            },
            events: clone(visibleEvents),
            context: safeContext(context),
            synthesis: null,
          };
          jobs.push(Promise.resolve().then(() => this.onMemoryCommit(details)).then((result) => {
            const durable = result !== false && this._markParticipantReceipt(details);
            if (!durable) this._emit('error', room, {
              roomId: room.id, message: 'The host could not recover this conversation.',
            }, []);
            return durable ? result : false;
          }).catch(() => {
            this._emit('error', room, {
              roomId: room.id, message: 'The host could not recover this conversation.',
            }, []);
            return false;
          }));
        }
      }
    }
    const results = await Promise.all(jobs);
    for (const record of Object.values(this.state.conversationJournal || {})) this._compactJournal(record);
    return { attempted: jobs.length, committed: results.filter((result) => result !== false).length };
  }

  /** Enforce the bounded spatial lifetime of an active room. */
  tick(now = this.now()) {
    const at = Number.isFinite(Number(now)) ? Number(now) : this.now();
    for (const invite of this.invites.values()) {
      if (invite.expiresAt > at) continue;
      this.invites.delete(invite.inviteId);
      const room = this.rooms.get(invite.roomId);
      if (room && this._activeIds(room).length === 1) this._closeRoom(room, 'invitation-expired');
    }
    for (const room of this.rooms.values()) {
      if (room.closed && at - room.updatedAt > 60_000) {
        this.rooms.delete(room.id);
        for (const [key, receipt] of this.commandReceipts) {
          if (receipt.roomId === room.id) this.commandReceipts.delete(key);
        }
        continue;
      }
      if (room.closed || !room.anchor) continue;
      for (const member of [...room.members.values()]) {
        if (!member.active) continue;
        const position = normalizePosition(this.getPlayerPosition(member.playerId));
        if (!position) continue;
        const distance = Math.hypot(position.x - room.anchor.x, position.z - room.anchor.z);
        if (distance > CONVERSATION_LEAVE_RANGE || Math.abs(position.y - room.anchor.y) > 3
          || !this.canShareSpace(position, room.anchor)) {
          member.outOfRangeAt ??= at;
          if (at - member.outOfRangeAt >= CONVERSATION_LEAVE_GRACE_MS) {
            try {
              this.leave(member.playerId, { roomId: room.id, reason: 'out-of-range' });
            } catch (error) {
              // A transient storage failure must not escape the render loop.
              // Retry after another grace interval while keeping the member in
              // the room so their accepted transcript remains addressable.
              member.outOfRangeAt = at;
              this._emit('error', room, {
                roomId: room.id, message: 'The conversation could not be saved yet.',
              }, this._activeIds(room));
            }
          }
        } else {
          member.outOfRangeAt = null;
        }
      }
    }
    return this.diagnostics;
  }

  get diagnostics() {
    return {
      version: CONVERSATION_PROTOCOL_VERSION,
      worldId: this.worldId,
      rooms: [...this.rooms.values()].filter((room) => !room.closed).map((room) => ({
        roomId: room.id, npcId: room.npcId, members: this._activeIds(room),
        events: room.events.length, generation: room.generation?.id || null,
      })),
      invites: this.invites.size,
      journalEntries: Object.keys(this.state.conversationJournal || {}).length,
    };
  }

  _scheduleNpcTurn(room) {
    if (room.generation || room.closed) return;
    room._batchStartedAt ??= this.now();
    if (room._npcTimer) clearTimeout(room._npcTimer);
    const delay = Math.max(0, Math.min(800, 2000 - (this.now() - room._batchStartedAt)));
    const wait = () => {
      room._npcTimer = null;
      room._batchStartedAt = null;
      this._runNpcTurn(room).catch((error) => {
        this._emit('error', room, { roomId: room.id, message: String(error?.message || 'NPC reply failed') }, this._activeIds(room));
      });
    };
    if (typeof setTimeout === 'function') room._npcTimer = setTimeout(wait, delay);
    else wait();
  }

  _invalidateGeneration(room) {
    if (!room?.generation) return false;
    const failed = room.generation;
    room.generation = null;
    if (room._generationTimer) clearTimeout(room._generationTimer);
    room._generationTimer = null;
    room._lastNpcSeq = Math.min(room._lastNpcSeq || 0, failed.beforeSeq || 0);
    return true;
  }

  async _runNpcTurn(room) {
    if (room.closed || room.generation || !room.npcId) return;
    const beforeSeq = room._lastNpcSeq || 0;
    let batch = room.events.filter((event) => event.seq > beforeSeq
      && event.kind === 'message' && event.speakerKind === 'human');
    if (!batch.length) return;
    const eligible = this._activeIds(room);
    const ready = eligible.filter((id) => !room.generationFailures?.has(id));
    const authored = ready.length === 0 && eligible.length > 0;
    const assignedTo = ready.includes(room.createdBy) ? room.createdBy : ready[0] || eligible[0];
    if (!assignedTo) return;
    // A new delegate must never receive earlier messages they did not hear.
    batch = batch.filter((event) => eligible.every((id) => event.audience.includes(id)));
    if (!batch.length) return;
    room._lastNpcSeq = batch.at(-1).seq;
    const generation = {
      id: this._newId('generation'), roomId: room.id, assignedTo,
      throughSeq: batch.at(-1).seq, createdAt: this.now(),
      membershipRevision: room.membershipRevision,
      beforeSeq,
    };
    room.generation = generation;
    if (authored) {
      const result = this.submitNpcReply(assignedTo, {
        roomId: room.id, generationId: generation.id, content: fallbackNpcReply(room, batch).text,
      });
      room.generationFailures?.clear();
      return result;
    }
    const participantContext = {
      ...(this._contextFor(room, assignedTo) || room.npcContext || {}),
      participants: [...room.members.values()]
        .filter((member) => member.active)
        .map((member, index) => ({ playerId: member.playerId, speakerLabel: `Traveller ${index + 1}` })),
    };
    if (eligible.length > 1) {
      // Personal recollections are not automatically publishable to a group.
      participantContext.memory = {};
      participantContext.social = {};
      participantContext.player = { id: assignedTo };
    }
    const payload = {
      generation: publicGeneration(generation, assignedTo),
      messages: clone(batch),
      context: safeContext(participantContext),
    };
    this._emit('generation', room, payload, [assignedTo]);
    if (typeof setTimeout === 'function') {
      room._generationTimer = setTimeout(() => {
        if (room.generation?.id !== generation.id) return;
        room.generation = null;
        room._generationTimer = null;
        room._lastNpcSeq = generation.beforeSeq;
        room.generationFailures ||= new Set();
        room.generationFailures.add(generation.assignedTo);
        this._scheduleNpcTurn(room);
        this._emit('error', room, { roomId: room.id, message: 'The resident is ready to listen again.' }, this._activeIds(room));
      }, 25_000);
    }
    // If the host is not a room member, the assignment is intentionally sent to
    // an eligible guest. The host must not generate with context that belongs to
    // that guest; their browser will submit the result through npc-reply.
    if (assignedTo !== this.hostPlayerId) return;
    const result = this.generateNpcReply
      ? await this.generateNpcReply({
        room: {
          ...this.snapshotFor(assignedTo, { roomId: room.id }),
          events: clone(room.events.filter((event) => eligible.every((id) => event.audience.includes(id)))),
        },
        messages: clone(batch), context: payload.context, generation: clone(generation),
      })
      : fallbackNpcReply(room, batch);
    if (room.generation?.id !== generation.id) return;
    const text = typeof result === 'string' ? result : result?.text;
    if (!text) throw new Error('The NPC could not answer right now.');
    this.submitNpcReply(assignedTo, {
      roomId: room.id, generationId: generation.id, content: text,
      addressedTo: result?.addressedTo || null,
    });
  }

  _addMember(room, playerId) {
    const prior = room.members.get(playerId);
    const profile = this._profile(playerId);
    const joinedSeq = room.seq + 1;
    const intervals = Array.isArray(prior?.intervals) ? clone(prior.intervals) : [];
    intervals.push({ joinedSeq, joinedAt: this.now(), leftSeq: null, leftAt: null });
    const member = {
      playerId,
      displayName: String(profile.displayName || 'Traveller').slice(0, 28),
      joinedSeq,
      leftSeq: null,
      joinedAt: this.now(),
      leftAt: null,
      active: true,
      homeOrigin: clone(profile.homeOrigin || room.homeOrigins?.[playerId] || null),
      intervals,
    };
    room.members.set(playerId, member);
    room.membershipRevision += 1;
    this.playerRooms.set(playerId, room.id);
    room.committedMembers?.delete?.(playerId);
    room.updatedAt = this.now();
    return member;
  }

  _appendEvent(room, value) {
    if (value.kind === 'message' && room.events.length >= MAX_CONVERSATION_EVENTS) {
      throw new Error('This conversation is full. Close it and start a new conversation to continue.');
    }
    const previousEvents = room.events;
    const previousSeq = room.seq;
    const previousUpdatedAt = room.updatedAt;
    const event = {
      version: CONVERSATION_PROTOCOL_VERSION,
      eventId: this._newId('event'),
      roomId: room.id,
      seq: ++room.seq,
      at: this.now(),
      speakerId: String(value.speakerId || ''),
      speakerKind: value.speakerKind === 'npc' ? 'npc' : value.speakerKind === 'system' ? 'system' : 'human',
      kind: String(value.kind || 'message').slice(0, 32),
      content: String(value.content || '').slice(0, 320),
      audience: this._activeIds(room),
      addressedTo: value.addressedTo || null,
      ...(value.system ? { system: true } : {}),
      ...(value.reason ? { reason: String(value.reason).slice(0, 48) } : {}),
      ...(value.generationId ? { generationId: String(value.generationId).slice(0, 96) } : {}),
      ...(value.commandId ? { commandId: normalizeCommandId(value.commandId) } : {}),
    };
    room.events = [...room.events, event];
    room.updatedAt = this.now();
    if (room.npcId && !this._persistRoom(room)) {
      room.events = previousEvents;
      room.seq = previousSeq;
      room.updatedAt = previousUpdatedAt;
      throw new Error('The conversation could not be saved. Try again.');
    }
    return event;
  }

  _persistRoom(room) {
    const priorJournal = this.state.conversationJournal[room.id];
    const priorReceipt = this.state.conversationReceipts[room.id];
    const record = {
      version: CONVERSATION_PROTOCOL_VERSION,
      roomId: room.id, worldId: room.worldId, sessionEpoch: room.sessionEpoch,
      npcId: room.npcId, createdAt: room.createdAt, updatedAt: room.updatedAt,
      npc: clone(room.npc), anchor: clone(room.anchor),
      membershipRevision: room.membershipRevision,
      sequence: room.seq,
      events: clone(room.events),
      participantIds: [...room.members.keys()],
      members: [...room.members.values()].map((member) => ({
        ...publicMember(member), leftSeq: member.leftSeq, leftAt: member.leftAt, active: member.active,
      })),
    };
    this.state.conversationJournal[room.id] = record;
    // Persist the receipt in the same save as the journal. A receipt left in
    // memory after a failed save would make a later retry look durable.
    this.state.conversationReceipts[room.id] = {
      roomId: room.id, updatedAt: room.updatedAt, durable: true,
    };
    const saved = this.save();
    if (saved === false) {
      if (priorJournal === undefined) delete this.state.conversationJournal[room.id];
      else this.state.conversationJournal[room.id] = priorJournal;
      if (priorReceipt === undefined) delete this.state.conversationReceipts[room.id];
      else this.state.conversationReceipts[room.id] = priorReceipt;
      return false;
    }
    return true;
  }

  _isDurable(roomId) {
    return this.state.conversationReceipts?.[roomId]?.durable === true;
  }

  _commitMemory(room, event) {
    if (!room.npcId || event.speakerKind !== 'npc') return;
    // The journal is the durable evidence boundary. Existing NPC memory systems
    // can project these attributed events during the next package; keeping this
    // receipt separate prevents a duplicate save from doubling a relationship.
    const receiptKey = `${room.id}:${event.seq}`;
    if (this.state.conversationReceipts?.[receiptKey]) return;
    const priorReceipt = this.state.conversationReceipts[receiptKey];
    this.state.conversationReceipts[receiptKey] = {
      roomId: room.id, eventId: event.eventId, npcId: room.npcId,
      sequence: event.seq, committedAt: this.now(), durable: true,
    };
    if (this.save() === false) {
      if (priorReceipt === undefined) delete this.state.conversationReceipts[receiptKey];
      else this.state.conversationReceipts[receiptKey] = priorReceipt;
      return false;
    }
    return true;
  }

  _commitParticipantMemory(room, playerId, { synthesis = null } = {}) {
    if (!room?.npcId || !this.onMemoryCommit) return false;
    const id = this._playerId(playerId);
    const member = room.members.get(id);
    if (!id || !member) return false;
    const hasEvidence = room.events.some((event) => event?.kind === 'message'
      && (!Array.isArray(event.audience) || event.audience.includes(id))
      && (event.speakerKind === 'npc' || event.speakerId === id));
    // A participant may open and immediately close a room. There is no memory
    // projection to save in that case, so do not surface a storage error.
    if (!hasEvidence) return false;
    room.committedMembers ||= new Set();
    if (room.committedMembers.has(id)) return false;
    // Mark before invoking the projection so a callback which synchronously
    // causes cleanup cannot commit the same participant twice. A synchronous
    // exception rolls the marker back; the journal remains the authoritative
    // retryable evidence boundary in that case.
    room.committedMembers.add(id);
    let result;
    try {
      result = this.onMemoryCommit({
        version: CONVERSATION_PROTOCOL_VERSION,
        roomId: room.id,
        worldId: room.worldId,
        sessionEpoch: room.sessionEpoch,
        npcId: room.npcId,
        playerId: id,
        joinedSeq: member.joinedSeq,
        participantIds: [...room.members.keys()],
        room: {
          ...this.snapshotFor(id, { roomId: room.id }),
          events: clone(room.events.filter((event) => event.seq >= member.joinedSeq && event.audience.includes(id))),
        },
        events: clone(room.events),
        context: safeContext(this._contextFor(room, id) || room.npcContext),
        synthesis: clone(synthesis),
      });
    } catch (error) {
      room.committedMembers.delete(id);
      this._emit('error', room, {
        roomId: room.id,
        message: 'The host could not save this conversation.',
      }, this._activeIds(room));
      return false;
    }
    const fail = () => {
      room.committedMembers.delete(id);
      this._emit('error', room, {
        roomId: room.id,
        message: 'The host could not save this conversation.',
      }, this._activeIds(room));
      return false;
    };
    const finish = (value) => value !== false
      && this._markParticipantReceipt({
        roomId: room.id, npcId: room.npcId, playerId: id, joinedSeq: member.joinedSeq,
      })
      ? true : fail();
    if (result && typeof result.then === 'function') return result.then(finish, fail);
    return finish(result);
  }

  _markParticipantReceipt({ roomId, npcId, playerId, joinedSeq = 0 } = {}) {
    const id = this._playerId(playerId);
    const roomKey = String(roomId || '');
    if (!id || !roomKey || !npcId) return false;
    const segment = Math.max(0, Math.floor(Number(joinedSeq) || 0));
    const key = `conversation-participant:${roomKey}:${id}:${segment}`;
    if (this.state.conversationReceipts?.[key]?.durable) return true;
    const prior = this.state.conversationReceipts?.[key];
    this.state.conversationReceipts[key] = {
      roomId: roomKey, npcId: String(npcId), playerId: id, joinedSeq: segment,
      committedAt: this.now(), durable: true,
    };
    if (this.save() === false) {
      if (prior === undefined) delete this.state.conversationReceipts[key];
      else this.state.conversationReceipts[key] = prior;
      return false;
    }
    return true;
  }

  _closeRoom(room, reason) {
    if (!room || room.closed) return;
    const recipients = this._activeIds(room);
    if (room._npcTimer) clearTimeout(room._npcTimer);
    if (room._generationTimer) clearTimeout(room._generationTimer);
    room._generationTimer = null;
    room._npcTimer = null;
    room.generation = null;
    room.closed = true;
    for (const member of room.members.values()) {
      member.active = false;
      if (this.playerRooms.get(member.playerId) === room.id) this.playerRooms.delete(member.playerId);
    }
    this._emit('closed', room, { roomId: room.id, reason: String(reason || 'closed').slice(0, 48) }, recipients);
    this._compactJournal(this.state.conversationJournal[room.id]);
  }

  _compactJournal(record) {
    if (!record?.roomId || !Array.isArray(record.members)) return false;
    const complete = record.members.every((member) => (member.intervals || []).every((interval) => {
      const hasEvidence = record.events.some((event) => event.kind === 'message'
        && event.seq >= interval.joinedSeq && (interval.leftSeq == null || event.seq <= interval.leftSeq)
        && event.audience.includes(member.playerId)
        && (event.speakerKind === 'npc' || event.speakerId === member.playerId));
      return !hasEvidence || this.state.conversationReceipts[
        `conversation-participant:${record.roomId}:${member.playerId}:${interval.joinedSeq}`]?.durable;
    }));
    if (!complete) return false;
    delete this.state.conversationJournal[record.roomId];
    try {
      if (this.save() !== false) return true;
    } catch { /* keep the durable evidence for a later attempt */ }
    this.state.conversationJournal[record.roomId] = record;
    return false;
  }

  _assertNearby(playerId, room) {
    const position = normalizePosition(this.getPlayerPosition(playerId));
    const target = room.anchor;
    if (!position || !target) return;
    const distance = Math.hypot(position.x - target.x, position.z - target.z);
    if (Math.abs(position.y - target.y) > 3) throw new Error('Move to the same level as the conversation.');
    if (!this.canShareSpace(position, target)) throw new Error('Move past the barrier to join the conversation.');
    if (distance > CONVERSATION_JOIN_RANGE) throw new Error('Move closer to the conversation.');
  }

  _assertPlayersNearby(firstPlayerId, secondPlayerId) {
    const first = normalizePosition(this.getPlayerPosition(firstPlayerId));
    const second = normalizePosition(this.getPlayerPosition(secondPlayerId));
    // A headless authority may not have a pose for a not-yet-admitted target;
    // the target's invitation still goes through and the join check runs when
    // they accept. When both poses exist, the host enforces the approach range.
    if (!first || !second) return;
    if (Math.abs(first.y - second.y) > 3 || !this.canShareSpace(first, second)) {
      throw new Error('Move to the same space as that traveller.');
    }
    if (Math.hypot(first.x - second.x, first.z - second.z) > CONVERSATION_JOIN_RANGE) {
      throw new Error('Move closer to that traveller.');
    }
  }

  _contextFor(room, playerId) {
    if (!room.npcId) return null;
    try {
      const context = this.getNpcContext(room.npcId, {
        playerId, participantIds: this._activeIds(room), roomId: room.id,
      });
      return context && typeof context === 'object' ? context : room.npcContext;
    } catch {
      return room.npcContext;
    }
  }

  _hasPlayer(playerId) {
    if (playerId === this.hostPlayerId) return true;
    try { return !!this.getPlayerProfile(playerId); } catch { return false; }
  }

  _profile(playerId) {
    if (playerId === this.hostPlayerId) {
      return this.getPlayerProfile(playerId) || { playerId, displayName: 'Host' };
    }
    try { return this.getPlayerProfile(playerId) || { playerId, displayName: 'Traveller' }; }
    catch { return { playerId, displayName: 'Traveller' }; }
  }

  _activeIds(room) {
    return [...room.members.values()].filter((member) => member.active).map((member) => member.playerId);
  }

  _emit(kind, room, payload, recipients) {
    this.onEvent({
      version: CONVERSATION_PROTOCOL_VERSION,
      kind, roomId: room?.id || payload?.roomId || null,
      recipients: Array.isArray(recipients) ? [...new Set(recipients.map(String))] : [],
      payload: clone(payload || {}),
    });
  }

  _room(roomId) {
    const id = String(roomId || '');
    return this.rooms.get(id) || null;
  }

  _newId(prefix) {
    this.sequence += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}:${this.hostPlayerId || 'host'}:${Date.now().toString(36)}:${this.sequence.toString(36)}:${random}`;
  }

  _playerId(value) {
    const id = String(value || '').trim();
    return id.length <= 160 ? id : id.slice(0, 160);
  }

  _npcId(value) {
    const id = String(value || '').trim();
    return id.length <= 160 ? id : id.slice(0, 160);
  }
}

function normalizeMessage(value) {
  const text = String(value ?? '').trim();
  if (!text || byteLength(text) > MAX_CONVERSATION_MESSAGE_BYTES) {
    if (text && byteLength(text) > MAX_CONVERSATION_MESSAGE_BYTES) throw new Error('That message is too long.');
    return '';
  }
  return text.slice(0, 320);
}

function normalizeCommandId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 96 ? id : id.slice(0, 96) || null;
}

function normalizePosition(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.z))) return null;
  return { x: Number(value.x), y: Number(value.y) || 0, z: Number(value.z) };
}

function normalizeAudience(value, room) {
  if (!value) return null;
  const ids = Array.isArray(value) ? value : [value];
  const active = new Set([...room.members.values()].filter((member) => member.active).map((member) => member.playerId));
  const valid = ids.map(String).filter((id) => active.has(id)).slice(0, 4);
  return valid.length ? valid : null;
}

function publicMember(member) {
  return {
    playerId: member.playerId,
    displayName: member.displayName,
    joinedSeq: member.joinedSeq,
    joinedAt: member.joinedAt,
    homeOrigin: member.homeOrigin ? clone(member.homeOrigin) : null,
    intervals: Array.isArray(member.intervals) ? clone(member.intervals) : [],
  };
}

function publicGeneration(generation, viewerId) {
  return {
    id: generation.id,
    roomId: generation.roomId,
    assignedTo: generation.assignedTo,
    viewerIsAssignee: generation.assignedTo === viewerId,
    throughSeq: generation.throughSeq,
    createdAt: generation.createdAt,
    membershipRevision: generation.membershipRevision,
  };
}

function sanitizeNpcDescriptor(npc) {
  if (!npc || typeof npc !== 'object') return null;
  return {
    id: String(npc.id || '').slice(0, 160),
    name: String(npc.name || 'The resident').slice(0, 80),
    role: String(npc.role || 'resident').slice(0, 80),
  };
}

function safeContext(context) {
  if (!context || typeof context !== 'object') return null;
  const result = clone(context);
  // A guest may run an edge model, but a room snapshot is still a disclosure
  // boundary. Keep the public persona and bounded local facts; drop raw private
  // social/graph records that are not needed to answer the group.
  if (result.social && typeof result.social === 'object') {
    result.social = {
      relationshipToPlayer: result.social.relationshipToPlayer || 'stranger',
      recentOutcomes: Array.isArray(result.social.recentOutcomes) ? result.social.recentOutcomes.slice(-3) : [],
    };
  }
  if (result.memory && typeof result.memory === 'object') {
    result.memory = {
      meetingCount: Number(result.memory.meetingCount) || 0,
      playerFacts: Array.isArray(result.memory.playerFacts) ? result.memory.playerFacts.slice(-5) : [],
      npcFacts: Array.isArray(result.memory.npcFacts) ? result.memory.npcFacts.slice(-5) : [],
      lastConversationSummary: String(result.memory.lastConversationSummary || '').slice(0, 420),
    };
  }
  if (Array.isArray(result.participants)) {
    result.participants = result.participants.slice(0, MAX_CONVERSATION_HUMANS).map((member) => ({
      playerId: String(member?.playerId || '').slice(0, 160),
      speakerLabel: String(member?.speakerLabel || 'Traveller').slice(0, 64),
    }));
  }
  delete result.narrativeRetrieval;
  delete result.private;
  // Context is sent through a reliable control message and also becomes model
  // input on a delegate device. Keep the rich settlement directory useful for
  // nearby questions, then discard progressively less relevant fields if an
  // unusual world snapshot is still too large.
  if (Array.isArray(result.targets)) result.targets = result.targets.slice(0, 10);
  if (Array.isArray(result.pointPlaces)) result.pointPlaces = result.pointPlaces.slice(0, 8);
  if (Array.isArray(result.homeCommunity?.residents)) {
    result.homeCommunity.residents = result.homeCommunity.residents.slice(0, 12);
  }
  if (Array.isArray(result.currentCommunity?.residents)) {
    result.currentCommunity.residents = result.currentCommunity.residents.slice(0, 12);
  }
  for (const key of ['pointPlaces', 'currentCommunity', 'homeCommunity', 'targets', 'social']) {
    if (byteLength(result) <= MAX_CONVERSATION_CONTEXT_BYTES) break;
    delete result[key];
  }
  if (byteLength(result) > MAX_CONVERSATION_CONTEXT_BYTES && result.memory) {
    result.memory = {
      meetingCount: Number(result.memory.meetingCount) || 0,
      playerFacts: Array.isArray(result.memory.playerFacts) ? result.memory.playerFacts.slice(-2) : [],
      npcFacts: Array.isArray(result.memory.npcFacts) ? result.memory.npcFacts.slice(-2) : [],
    };
  }
  if (byteLength(result) > MAX_CONVERSATION_CONTEXT_BYTES) {
    return { npc: sanitizeNpcDescriptor(result.npc), participants: result.participants || [] };
  }
  return result;
}

function publicRoomContext(context) {
  const result = safeContext(context);
  if (result?.memory && typeof result.memory === 'object') {
    // A cached room context is used only as a fallback when a live participant
    // context cannot be rebuilt. Retain NPC facts, but never cache the creator's
    // personal recollections for disclosure to a later guest.
    result.memory = {
      meetingCount: Number(result.memory.meetingCount) || 0,
      npcFacts: Array.isArray(result.memory.npcFacts) ? result.memory.npcFacts.slice(-5) : [],
    };
  }
  return result;
}

function fallbackNpcReply(room, batch) {
  const name = room.npc?.name || 'The resident';
  const last = batch.at(-1)?.content || '';
  return { text: `${name} listens to the group. “${last.length > 120 ? `${last.slice(0, 117)}…` : last}”` };
}

function clone(value) {
  if (value === undefined) return undefined;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
