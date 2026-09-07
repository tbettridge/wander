import {
  CONVERSATION_JOIN_RANGE,
  CONVERSATION_PROTOCOL_VERSION,
} from './multiplayerconversation.mjs';

/**
 * Small browser adapter for ConversationRoomService.
 *
 * It deliberately owns presentation only. The host still decides which events
 * exist; this adapter merely renders accepted events and submits commands with
 * the local stable identity.
 */
export class MultiplayerConversationClient {
  constructor({
    session,
    identity,
    director = null,
    getPlayerPosition = null,
    getNpcTarget = null,
    getHumanTarget = null,
    getProfile = null,
    onOpen = null,
    onClose = null,
    onStatus = null,
  } = {}) {
    this.session = session;
    this.identity = identity || {};
    this.director = director;
    this.getPlayerPosition = typeof getPlayerPosition === 'function' ? getPlayerPosition : () => null;
    this.getNpcTarget = typeof getNpcTarget === 'function' ? getNpcTarget : () => null;
    this.getHumanTarget = typeof getHumanTarget === 'function' ? getHumanTarget : () => null;
    this.getProfile = typeof getProfile === 'function' ? getProfile : () => null;
    this.onOpen = typeof onOpen === 'function' ? onOpen : () => {};
    this.onClose = typeof onClose === 'function' ? onClose : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.current = null;
    this.invites = new Map();
    this.inviteTimers = new Map();
    this.pendingRooms = new Map();
    this.events = new Set();
    this.generationJobs = new Map();
    this._buildUi();
  }

  /** Called by the station keeper's T handler before it opens one-to-one chat. */
  interceptKey(event) {
    if (!event || event.code !== 'KeyT' || event.repeat
      || !['host', 'guest'].includes(this.session?.role)) return false;
    // While the group panel owns focus, consume T so the stationkeeper's
    // legacy one-to-one handler cannot queue a second conversation underneath
    // it. The panel itself remains keyboard accessible.
    if (this.current) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    const human = this.getHumanTarget(this.getPlayerPosition());
    const npc = this.getNpcTarget(this.getPlayerPosition());
    const target = human && (!npc || human.distance <= npc.distance) ? human : npc;
    if (!target) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.openTarget(target).catch((error) => this._showStatus(error.message));
    return true;
  }

  async openTarget(target) {
    if (!target || this.current) return null;
    if (target.kind === 'human' || target.playerId) {
      const result = await this._command({
        op: 'invite', targetPlayerId: target.playerId,
        anchor: this._positionPayload(),
      });
      // An invitation protects the other player's controls. Keep the sender's
      // panel closed until the target accepts; joining an already-open room is
      // the one case where the command returns a snapshot directly.
      const snapshot = result?.room?.roomId ? null : result;
      if (snapshot?.roomId) {
        this.openSnapshot(snapshot);
      } else if (result?.room?.roomId) {
        this.pendingRooms.set(result.room.roomId, {
          targetPlayerId: target.playerId,
          expiresAt: Number(result.expiresAt) || Date.now() + 15_000,
        });
        this._showStatus('Invitation sent · waiting for them to join.');
      }
      return result;
    }
    const npcId = target.npcId || target.identity?.id || target.id;
    if (!npcId) return null;
    const result = await this._command({
      op: 'open-npc', npcId, anchor: this._positionPayload(),
    });
    const snapshot = result?.snapshot?.roomId ? result.snapshot : result;
    if (snapshot?.roomId) this.openSnapshot(snapshot);
    return result;
  }

  openSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== CONVERSATION_PROTOCOL_VERSION || !snapshot.roomId) return false;
    if (this.current && this.current.roomId !== snapshot.roomId) return false;
    const priorConversationId = this.current?.roomId === snapshot.roomId
      ? this.current.aiConversationId : null;
    this.current = {
      ...snapshot,
      members: Array.isArray(snapshot.members) ? snapshot.members : [],
      events: Array.isArray(snapshot.events) ? [...snapshot.events] : [],
      aiConversationId: priorConversationId,
    };
    this.pendingRooms.delete(this.current.roomId);
    this.events = new Set(this.current.events.map((event) => event.eventId).filter(Boolean));
    this._render();
    if (this.panel.style.display !== 'flex') {
      this.panel.style.display = 'flex';
      this.onOpen(this.current);
    }
    this.input.focus({ preventScroll: true });
    return true;
  }

  receive(message = {}) {
    if (!message || message.version && message.version !== CONVERSATION_PROTOCOL_VERSION) return false;
    const kind = message.kind || 'event';
    if (kind === 'invite') {
      this._receiveInvite(message.invite || message);
      return true;
    }
    const snapshot = message.snapshot || message.payload?.snapshot;
    if (kind === 'room-created' || kind === 'snapshot') {
      const humanPending = kind === 'room-created' && message.autoOpen === false;
      if (snapshot?.roomId && !humanPending && (!this.current || this.current.roomId === snapshot.roomId)) this.openSnapshot(snapshot);
      return true;
    }
    if (kind === 'invite-declined') {
      const roomId = message.roomId || message.payload?.roomId;
      if (roomId) this.pendingRooms.delete(roomId);
      this._showStatus('The invitation was declined.');
      return true;
    }
    if (kind === 'profile-updated') {
      const playerId = String(message.playerId || message.payload?.playerId || '');
      if (!playerId) return false;
      const displayName = String(message.displayName || message.payload?.displayName || 'Traveller').slice(0, 28);
      for (const invite of this.invites.values()) {
        if (invite.from === playerId) invite.fromDisplayName = displayName;
      }
      if (this.current) {
        const member = this.current.members.find((entry) => entry.playerId === playerId);
        if (member) {
          member.displayName = displayName;
          if (message.homeOrigin || message.payload?.homeOrigin) {
            member.homeOrigin = message.homeOrigin || message.payload.homeOrigin;
          }
          this._render();
        }
      }
      this._renderInvites();
      return true;
    }
    if (kind === 'generation') {
      const generationRoomId = message.roomId || message.payload?.generation?.roomId;
      const run = () => this._receiveGeneration(message.payload || message)
        .catch((error) => this._showStatus(error.message));
      if (generationRoomId === this.current?.roomId) run();
      else if (!this.current && generationRoomId) {
        this._openRoomFromEvent(generationRoomId).then((opened) => { if (opened) run(); });
      }
      return true;
    }
    if (kind === 'error') {
      this._showStatus(message.message || message.payload?.message || 'Conversation unavailable.');
      return true;
    }
    if (kind === 'closed') {
      this.pendingRooms.delete(message.roomId);
      if (message.roomId === this.current?.roomId) this.closeFromSession(message.reason || 'conversation closed');
      return true;
    }
    const event = message.event || message.payload?.event;
    if (!event?.eventId || (this.current && event.roomId !== this.current.roomId)) return false;
    if (!this.current) {
      if (event.kind === 'member-joined') {
        if (this.pendingRooms.has(event.roomId)) this._openPendingRoom(event.roomId);
        else this._openRoomFromEvent(event.roomId);
        return true;
      }
      return false;
    }
    if (this.events.has(event.eventId)) return true;
    this.events.add(event.eventId);
    this.current.events.push(event);
    this.current.members = this._membersAfterEvent(this.current.members, event);
    if (event.kind === 'member-left' && event.speakerId === this.identity.playerId) {
      this._finishLocal(true);
      return true;
    }
    this._render();
    return true;
  }

  async sendMessage() {
    if (!this.current || this.sending) return null;
    const roomId = this.current.roomId;
    const content = String(this.input.value || '').trim().slice(0, 320);
    if (!content) return null;
    this.input.value = '';
    this.sending = true;
    const pending = this.pendingMessage?.roomId === roomId && this.pendingMessage.content === content
      ? this.pendingMessage : { op: 'say', roomId, content,
        commandId: `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}` };
    this.pendingMessage = pending;
    this.input.disabled = true;
    this._showStatus('Sending…');
    try {
      const result = await this._command(pending);
      this.pendingMessage = null;
      if (result?.event) this.receive({ kind: 'event', roomId, event: result.event });
      this._showStatus('Enter to send · Close leaves the conversation');
      return result;
    } catch (error) {
      this.input.value = content;
      this._showStatus(error.message);
      throw error;
    } finally {
      this.sending = false;
      if (this.current) {
        this.input.disabled = false;
        this.input.focus({ preventScroll: true });
      }
    }
  }

  async leave() {
    if (!this.current) return false;
    const room = this.current;
    const roomId = room.roomId;
    let synthesis = null;
    if (room.npc) {
      this._showStatus('Saving this conversation…');
      synthesis = await this._memorySynthesisProposal(room);
    }
    try { await this._command({ op: 'leave', roomId, reason: 'closed', synthesis }); }
    catch (error) { this._showStatus(error.message); return false; }
    this._finishLocal(true);
    return true;
  }

  async acceptInvite(inviteId) {
    const invite = this.invites.get(inviteId);
    if (!invite) return false;
    try {
      const result = await this._command({ op: 'accept-invite', inviteId });
      this.invites.delete(inviteId);
      this._clearInviteTimer(inviteId);
      this.invitePanel.replaceChildren();
      const snapshot = result?.snapshot?.roomId ? result.snapshot : result;
      if (snapshot?.roomId) this.openSnapshot(snapshot);
      return true;
    } catch (error) {
      this._showStatus(error.message);
      return false;
    }
  }

  async declineInvite(inviteId) {
    if (!this.invites.has(inviteId)) return false;
    try { await this._command({ op: 'decline-invite', inviteId }); } catch { /* expiry is harmless */ }
    this.invites.delete(inviteId);
    this._clearInviteTimer(inviteId);
    this.invitePanel.replaceChildren();
    return true;
  }

  close() {
    return this.leave();
  }

  /** Tear down presentation when the underlying visit ends unexpectedly. */
  closeFromSession(reason = 'The multiplayer session ended.') {
    if (!this.current) return false;
    this._finishLocal(true);
    this._showStatus(reason);
    return true;
  }

  get active() { return !!this.current; }

  get diagnostics() {
    return {
      active: !!this.current,
      roomId: this.current?.roomId || null,
      npcId: this.current?.npc?.id || null,
      members: this.current?.members?.map((member) => member.playerId) || [],
      events: this.current?.events?.length || 0,
      invites: this.invites.size,
      generationJobs: this.generationJobs.size,
      pendingRooms: this.pendingRooms.size,
    };
  }

  async _command(command) {
    if (this.session?.role === 'host') {
      return this.session.executeConversationCommand(this.identity.playerId, command);
    }
    return this.session.requestConversation(command);
  }

  async _openPendingRoom(roomId) {
    const pending = this.pendingRooms.get(roomId);
    if (!pending || pending.opening || pending.expiresAt <= Date.now()) {
      if (pending?.expiresAt <= Date.now()) this.pendingRooms.delete(roomId);
      return false;
    }
    pending.opening = true;
    try {
      const snapshot = await this._command({ op: 'snapshot', roomId });
      this.pendingRooms.delete(roomId);
      return this.openSnapshot(snapshot);
    } catch (error) {
      pending.opening = false;
      this._showStatus(error.message);
      return false;
    }
  }

  async _openRoomFromEvent(roomId) {
    if (!roomId || this.current) return false;
    try {
      const snapshot = await this._command({ op: 'snapshot', roomId });
      return this.openSnapshot(snapshot);
    } catch (error) {
      this._showStatus(error.message);
      return false;
    }
  }

  _positionPayload() {
    const position = this.getPlayerPosition() || {};
    return { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 };
  }

  async _memorySynthesisProposal(room) {
    if (!this.director || !room?.npc) return null;
    const transcript = (room.events || [])
      .filter((event) => event.kind === 'message'
        && (event.speakerKind === 'npc' || event.speakerId === this.identity.playerId))
      .map((event) => ({
        role: event.speakerKind === 'npc' ? 'assistant' : 'user',
        speakerId: event.speakerId,
        content: String(event.content || '').slice(0, 320),
      }))
      .filter((message) => message.content);
    if (!transcript.length) return null;
    const context = {
      ...(room.npcContext || {}),
      npc: room.npc,
      player: { ...(room.npcContext?.player || {}), id: this.identity.playerId },
    };
    const job = Promise.resolve().then(() => this.director.synthesizeConversation(
      context, transcript, room.aiConversationId,
    ));
    try {
      return compactSynthesis(await Promise.race([
        job,
        new Promise((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]));
    } catch {
      return null;
    }
  }

  async _receiveGeneration(message) {
    const generation = message.generation;
    if (!generation || generation.assignedTo !== this.identity.playerId || !this.current
      || this.session?.role === 'host') return;
    if (this.generationJobs.has(generation.id)) return this.generationJobs.get(generation.id);
    const job = this._generateNpcReply(message).catch((error) => {
      this._showStatus('The resident could not answer right now.');
      throw error;
    }).finally(() => this.generationJobs.delete(generation.id));
    this.generationJobs.set(generation.id, job);
    return job;
  }

  async _generateNpcReply({ generation, messages = [], context = null } = {}) {
    if (!generation || !this.current) return null;
    const room = this.current;
    if (!this.director) {
      const last = messages.at(-1)?.content || '';
      const content = `${this.current.npc?.name || 'The resident'} listens. “${last.slice(0, 120)}”`;
      const accepted = await this._command({
        op: 'npc-reply', roomId: this.current.roomId,
        generationId: generation.id, content,
      });
      if (accepted?.event) this.receive({ kind: 'event', roomId: this.current.roomId, event: accepted.event });
      return accepted;
    }
    const modelContext = {
      ...(context || this.current?.npcContext || {}),
      player: { ...(context?.player || {}), id: this.identity.playerId },
    };
    const transcript = this.current?.events?.filter((event) => event.kind === 'message'
      && this.current.members.every((member) => event.audience?.includes(member.playerId))).map((event) => ({
      role: event.speakerKind === 'npc' ? 'assistant' : 'user',
      speakerId: event.speakerId,
      content: event.speakerKind === 'human' ? `Traveller [${event.speakerId}]: ${event.content}` : event.content,
    })) || [];
    const prompt = messages.map((message) => {
      return `Traveller [${message.speakerId}]: ${message.content}`;
    }).join('\n');
    this.director.discardConversation?.(room.aiConversationId);
    let conversationId = null;
    if (!conversationId) {
      const opening = await this.director.requestChatOpening(modelContext);
      conversationId = opening.conversationId;
      if (this.current !== room) {
        this.director.discardConversation?.(conversationId);
        return null;
      }
      room.aiConversationId = conversationId;
      // The opening is a model warm-up for a room whose human message already
      // exists. The next reply is the only accepted NPC event.
    }
    const result = await this.director.requestChatReply(modelContext, prompt, conversationId, null, {
      transcript: transcript.slice(0, -messages.length),
    });
    const content = result?.reply?.text || result?.text;
    if (this.current !== room) return null;
    if (!content) throw new Error('Empty NPC reply');
    const accepted = await this._command({
      op: 'npc-reply', roomId: this.current.roomId,
      generationId: generation.id, content,
    });
    if (accepted?.event) this.receive({ kind: 'event', roomId: this.current.roomId, event: accepted.event });
    return accepted;
  }

  _receiveInvite(invite) {
    if (!invite?.inviteId || invite.target && invite.target !== this.identity.playerId) return;
    this.invites.set(invite.inviteId, invite);
    this._clearInviteTimer(invite.inviteId);
    const expiresAt = Number(invite.expiresAt) || Date.now() + 15_000;
    if (typeof setTimeout === 'function') {
      this.inviteTimers.set(invite.inviteId, setTimeout(() => {
        if (this.invites.get(invite.inviteId) !== invite) return;
        this.invites.delete(invite.inviteId);
        this.inviteTimers.delete(invite.inviteId);
        this._renderInvites();
        this._showStatus('The conversation invitation expired.');
      }, Math.max(0, expiresAt - Date.now())));
    }
    this._renderInvites();
    this._showStatus(`${invite.fromDisplayName || invite.from || 'A traveller'} invited you to chat.`);
  }

  _clearInviteTimer(inviteId) {
    const timer = this.inviteTimers.get(inviteId);
    if (timer) clearTimeout(timer);
    this.inviteTimers.delete(inviteId);
  }

  _finishLocal(notify = true) {
    const prior = this.current;
    this.current = null;
    this.events.clear();
    this.input.value = '';
    this.panel.style.display = 'none';
    this._showStatus('');
    if (notify && prior) this.onClose(prior);
  }

  _showStatus(message) {
    this.status.textContent = String(message || '');
    this.onStatus(String(message || ''));
  }

  _membersAfterEvent(members, event) {
    const next = [...(members || [])];
    if (event.kind === 'member-joined' && !next.some((member) => member.playerId === event.speakerId)) {
      const profile = this.getProfile(event.speakerId) || {};
      next.push({ playerId: event.speakerId, displayName: profile.displayName || 'Traveller' });
    }
    if (event.kind === 'member-left') return next.filter((member) => member.playerId !== event.speakerId);
    return next;
  }

  _render() {
    if (!this.current) return;
    if (typeof document === 'undefined') return;
    const npcLabel = this.current.npc ? `${this.current.npc.name} · ${this.current.npc.role}` : 'Human conversation';
    const names = this.current.members.map((member) => member.playerId === this.identity.playerId
      ? 'You' : member.displayName || 'Traveller');
    this.title.textContent = npcLabel;
    this.participants.textContent = names.length ? names.join(' · ') : 'Conversation';
    this.transcript.replaceChildren();
    for (const event of this.current.events || []) {
      const row = document.createElement('div');
      const speaker = event.speakerKind === 'npc'
        ? this.current.npc?.name || 'Resident'
        : event.speakerKind === 'system'
          ? ''
          : this.current.members.find((member) => member.playerId === event.speakerId)?.displayName
            || (event.speakerId === this.identity.playerId ? 'You' : 'Traveller');
      row.style.cssText = 'padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.06);white-space:pre-wrap;overflow-wrap:anywhere;';
      if (speaker) {
        const label = document.createElement('div');
        label.textContent = speaker;
        label.style.cssText = 'margin-bottom:3px;color:rgba(190,216,204,.75);font:600 10px/1.3 "Helvetica Neue",Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;';
        row.appendChild(label);
      }
      const text = document.createElement('div');
      text.textContent = event.content;
      row.appendChild(text);
      this.transcript.appendChild(row);
    }
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.sendButton.disabled = false;
  }

  _buildUi() {
    if (typeof document === 'undefined') {
      this.panel = { style: {}, replaceChildren() {} };
      this.title = this.participants = this.status = this.transcript = this.input = this.sendButton = this.invitePanel = {
        textContent: '', replaceChildren() {}, focus() {}, style: {},
      };
      return;
    }
    this.invitePanel = document.createElement('div');
    this.invitePanel.style.cssText = 'position:fixed;right:18px;top:18px;z-index:40;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 36px));';
    document.body.appendChild(this.invitePanel);
    this.panel = document.createElement('div');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Multiplayer conversation');
    this.panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:35;display:none;flex-direction:column;width:min(440px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 32px));padding:0;border:1px solid rgba(190,216,204,.28);border-radius:12px;background:rgba(7,14,15,.93);box-shadow:0 10px 30px rgba(0,0,0,.34);backdrop-filter:blur(5px);color:#f0f5f2;font:14px/1.45 "Helvetica Neue",Arial,sans-serif;pointer-events:auto;user-select:text;overflow:hidden;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(190,216,204,.16);';
    const heading = document.createElement('div');
    this.title = document.createElement('div');
    this.title.style.cssText = 'color:#b8ccc3;font:600 12px/1.4 "Helvetica Neue",Arial,sans-serif;letter-spacing:.11em;text-transform:uppercase;';
    this.participants = document.createElement('div');
    this.participants.style.cssText = 'margin-top:3px;color:rgba(190,207,199,.58);font:10px/1.3 "Helvetica Neue",Arial,sans-serif;letter-spacing:.04em;';
    heading.append(this.title, this.participants);
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close';
    close.style.cssText = 'min-width:62px;padding:6px 10px;border:1px solid rgba(206,225,216,.3);border-radius:8px;color:#e5eee9;background:rgba(206,225,216,.08);font:600 12px/1.3 "Helvetica Neue",Arial,sans-serif;cursor:pointer;';
    close.addEventListener('click', () => this.leave());
    header.append(heading, close);
    this.transcript = document.createElement('div');
    this.transcript.style.cssText = 'min-height:92px;max-height:300px;flex:1 1 auto;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain;';
    const form = document.createElement('form');
    form.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:7px;padding:10px 12px 7px;border-top:1px solid rgba(190,216,204,.16);';
    this.input = document.createElement('input');
    this.input.type = 'text'; this.input.maxLength = 320; this.input.autocomplete = 'off'; this.input.placeholder = 'Write a message…'; this.input.setAttribute('aria-label', 'Message conversation');
    this.input.style.cssText = 'min-width:0;padding:9px 10px;border:1px solid rgba(190,216,204,.3);border-radius:9px;outline:none;color:#f0f5f2;background:rgba(255,255,255,.06);font:14px/1.35 "Helvetica Neue",Arial,sans-serif;';
    this.sendButton = document.createElement('button'); this.sendButton.type = 'submit'; this.sendButton.textContent = 'Send';
    this.sendButton.style.cssText = 'padding:9px 13px;border:1px solid rgba(168,207,188,.4);border-radius:9px;color:#eff7f3;background:rgba(104,158,132,.32);font:600 13px/1.3 "Helvetica Neue",Arial,sans-serif;cursor:pointer;';
    form.append(this.input, this.sendButton);
    form.addEventListener('submit', (event) => { event.preventDefault(); this.sendMessage().catch(() => {}); });
    this.status = document.createElement('div');
    this.status.style.cssText = 'min-height:15px;padding:0 12px 9px;color:rgba(190,207,199,.66);font:10px/1.4 "Helvetica Neue",Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;';
    this.panel.append(header, this.transcript, form, this.status);
    this.panel.addEventListener('click', (event) => event.stopPropagation());
    this.panel.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape' || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      this.leave();
    });
    document.body.appendChild(this.panel);
  }

  _renderInvites() {
    if (typeof document === 'undefined') return;
    this.invitePanel.replaceChildren();
    for (const invite of this.invites.values()) {
      const card = document.createElement('div');
      card.style.cssText = 'padding:10px 12px;border:1px solid rgba(190,216,204,.3);border-radius:10px;background:rgba(7,14,15,.94);color:#eef5f1;font:13px/1.4 "Helvetica Neue",Arial,sans-serif;';
      const text = document.createElement('div');
      text.textContent = `${invite.fromDisplayName || invite.from || 'A traveller'} wants to chat.`;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:7px;margin-top:8px;';
      const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = 'Join';
      const decline = document.createElement('button'); decline.type = 'button'; decline.textContent = 'Decline';
      for (const button of [accept, decline]) button.style.cssText = 'padding:5px 9px;border:1px solid rgba(206,225,216,.3);border-radius:7px;color:#e5eee9;background:rgba(206,225,216,.08);cursor:pointer;';
      accept.addEventListener('click', () => this.acceptInvite(invite.inviteId));
      decline.addEventListener('click', () => this.declineInvite(invite.inviteId));
      actions.append(accept, decline); card.append(text, actions); this.invitePanel.appendChild(card);
    }
  }
}

function compactSynthesis(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    npcId: String(value.npcId || '').slice(0, 160),
    meetingCount: Math.max(0, Math.floor(Number(value.meetingCount) || 0)),
    playerFacts: Array.isArray(value.playerFacts) ? value.playerFacts.slice(0, 14) : [],
    npcFacts: Array.isArray(value.npcFacts) ? value.npcFacts.slice(0, 14) : [],
    quests: Array.isArray(value.quests) ? value.quests.slice(0, 8) : [],
    landmarks: Array.isArray(value.landmarks) ? value.landmarks.slice(0, 12) : [],
    worldFacts: Array.isArray(value.worldFacts) ? value.worldFacts.slice(0, 12) : [],
    lastConversationSummary: String(value.lastConversationSummary || '').slice(0, 420),
    narrativeClaims: {
      version: value.narrativeClaims?.version,
      thirdPartyClaims: Array.isArray(value.narrativeClaims?.thirdPartyClaims)
        ? value.narrativeClaims.thirdPartyClaims.slice(0, 8) : [],
    },
    narrativeConfirmations: Array.isArray(value.narrativeConfirmations)
      ? value.narrativeConfirmations.slice(0, 8) : [],
  };
}
