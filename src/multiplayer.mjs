import { createLocalIdentity, regionDescriptor } from './multiplayeridentity.mjs';
import {
  applyStateDelta,
  createEnvelope,
  isValidPose,
  normalizeDeparture,
  quantizePose,
} from './multiplayerprotocol.mjs';
import { GuestWorldProjection } from './multiplayerauthority.mjs';
import {
  createAdmissionDecision,
  createAdmissionRequest,
  createTicket,
  transitionTicket,
} from './interregionalticket.mjs';
import { DepartureDirectoryClient } from './multiplayerdirectory.mjs?v=hosttoken1';
import { WanderPeerConnection } from './multiplayerpeer.mjs';

const MOTION_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 20_000;
const STATE_SNAPSHOT_INTERVAL_MS = 5_000;
const MAX_PENDING_SIGNALS = 128;

/**
 * Session coordinator shared by the landing screen and the world loop.
 * It owns identity, presence, signaling, admission, ticket phases and the
 * compact motion stream; world systems remain consumers of its callbacks.
 */
export class MultiplayerSession {
  constructor({
    seed,
    identity = createLocalIdentity(),
    directory = new DepartureDirectoryClient(),
    avatarManager = null,
    onStatus,
    onDepartures,
    onAdmissionRequest,
    onRemotePose,
    onStateSnapshot,
    onTravel,
    logger = console,
  } = {}) {
    this.seed = Number(seed) || 0;
    this.identity = identity;
    this.directory = directory;
    this.avatarManager = avatarManager;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.onDepartures = typeof onDepartures === 'function' ? onDepartures : () => {};
    this.onAdmissionRequest = typeof onAdmissionRequest === 'function' ? onAdmissionRequest : () => {};
    this.onRemotePose = typeof onRemotePose === 'function' ? onRemotePose : () => {};
    this.onStateSnapshot = typeof onStateSnapshot === 'function' ? onStateSnapshot : () => {};
    this.onTravel = typeof onTravel === 'function' ? onTravel : () => {};
    this.logger = logger || console;
    this.region = regionDescriptor({ identity, seed: this.seed });
    this.departures = [];
    this.selectedDeparture = null;
    this.ticket = null;
    this.role = 'offline';
    this.peers = new Map();
    this.connectedPeers = new Set();
    this.ticketStarted = false;
    this.signalSocket = null;
    this.pendingSignals = [];
    this.hostRequests = new Map();
    this.approvedVisitors = new Set();
    this.approvedVisitorNames = new Map();
    this.hostId = null;
    this.lastMotionSentAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastStateSnapshotAt = 0;
    this.lastPose = null;
    this.startedAt = Date.now();
    this.authority = null;
    this.intentReducer = null;
    this.guestProjection = new GuestWorldProjection();
    this.homeHosting = false;
    this.travel = {
      originStationProvider: null,
      destinationStationsProvider: null,
      hostPositionProvider: null,
    };
  }

  async refreshDepartures() {
    try {
      this.departures = (await this.directory.list()).filter((departure) => departure.regionId !== this.region.regionId);
      this.onDepartures(this.departures);
      this.onStatus({ state: 'departures-ready', count: this.departures.length });
      return this.departures;
    } catch (error) {
      this.onStatus({ state: 'departures-offline', message: error.message });
      return [];
    }
  }

  selectDeparture(departure) {
    const normalized = normalizeDeparture(departure);
    if (!normalized) throw new Error('Invalid departure');
    this.selectedDeparture = normalized;
    return normalized;
  }

  async openRegion({ visibility = 'public', allowVisitors = true, regionName } = {}) {
    this.region = regionDescriptor({
      identity: this.identity,
      seed: this.seed,
      name: regionName,
      visibility,
      allowVisitors,
    });
    if (visibility !== 'public' || allowVisitors === false) {
      this.role = 'host-private';
      this.onStatus({ state: 'region-private', region: this.region });
      return this.region;
    }
    const result = await this.directory.register({
      ...this.region,
      population: 1,
      capacity: 3,
      status: 'open',
    });
    this.role = 'host';
    this.lastHeartbeatAt = Date.now();
    this._openHostSignalSocket(result.hostToken);
    this.onStatus({ state: 'region-open', region: this.region, departure: result.departure });
    return this.region;
  }

  async closeRegion() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.connectedPeers.clear();
    this.signalSocket?.close?.();
    this.signalSocket = null;
    this.pendingSignals = [];
    this.approvedVisitors.clear();
    this.approvedVisitorNames.clear();
    this.hostId = null;
    await this.directory.unregister().catch(() => {});
    this.role = 'offline';
    this.onStatus({ state: 'region-closed' });
  }

  /** Station keeper call: pin a destination before asking the host. */
  pinDestination(departure = this.selectedDeparture) {
    const target = normalizeDeparture(departure);
    if (!target) throw new Error('Choose an available departure first');
    this.selectedDeparture = target;
    this.ticket = createTicket({
      passengerId: this.identity.playerId,
      passengerName: this.identity.displayName,
      originRegionId: this.region.regionId,
      destination: target,
    });
    this.ticket = transitionTicket(this.ticket, 'keeper-confirmed');
    this.onStatus({ state: 'destination-pinned', ticket: this.ticket });
    return this.ticket;
  }

  async requestVisit({ message = '' } = {}) {
    if (!this.ticket || ['complete', 'cancelled'].includes(this.ticket.phase)) this.pinDestination();
    if (!this.selectedDeparture) throw new Error('No departure selected');
    // A local host cannot keep advertising a region after becoming a guest.
    // Close the listing first so departures never point at an owner who is no
    // longer available to approve the connection.
    if (this.role === 'host') {
      this.homeHosting = true;
      await this.closeRegion();
    }
    this.ticket = transitionTicket(this.ticket, 'admission-requested');
    this.role = 'guest';
    this._openGuestSignalSocket();
    const request = createAdmissionRequest({ ticket: this.ticket, identity: this.identity, message });
    this._sendSignal({ kind: 'admission-request', request });
    this.onStatus({ state: 'admission-requested', ticket: this.ticket });
    return this.ticket;
  }

  /** Host response; the UI calls this after the keeper/host approves a request. */
  async decideAdmission(request, approved, reason = '') {
    if (this.role !== 'host') throw new Error('Only a host can approve visitors');
    if (!request?.playerId || !this.hostRequests.has(request.playerId)) {
      throw new Error('Admission request is no longer pending');
    }
    const decision = createAdmissionDecision({ request, approved, hostId: this.identity.playerId, reason });
    this.hostRequests.delete(request.playerId);
    if (!approved) {
      this._sendSignal({ kind: 'admission-response', to: request.playerId, decision });
      this.onStatus({ state: 'visitor-declined', request, decision });
      return decision;
    }
    let ticket = createTicket({
      ticketId: request.ticketId,
      passengerId: request.playerId,
      passengerName: request.playerName,
      originRegionId: request.originRegionId || request.regionId,
      destination: {
        ...this.region,
        // The seed is private until the host approves the visit. It is not
        // present on departures, but is needed to build the guest's region.
        seed: this.seed,
        ...(this._hostArrivalStation() || {}),
      },
    });
    for (const phase of ['keeper-confirmed', 'admission-requested', 'host-approved']) {
      ticket = transitionTicket(ticket, phase);
    }
    this.approvedVisitors.add(request.playerId);
    this.approvedVisitorNames.set(request.playerId, request.playerName || 'Visitor');
    const peer = this._ensurePeer(request.playerId, 'host');
    // Release the approval before emitting the offer. This preserves the
    // admission gate even when the signaling socket is already open.
    this._sendSignal({ kind: 'admission-response', to: request.playerId, decision, ticket });
    await peer.startHost({ admissionApproved: true });
    this.onStatus({ state: 'visitor-approved', request, decision });
    return decision;
  }

  requestReturnHome() {
    if (!this.ticket || this.ticket.phase !== 'visit-active') return false;
    this.ticket = transitionTicket(this.ticket, 'return-requested');
    this.onTravel({ phase: 'return-requested', ticket: this.ticket, homeRegion: this.region });
    return true;
  }

  markVisitActive() {
    if (!this.ticket) return null;
    const phases = ['boarded', 'departing', 'transition', 'arriving', 'visit-active'];
    try {
      for (const phase of phases) {
        if (this.ticket.phase === phase) continue;
        this.ticket = transitionTicket(this.ticket, phase);
      }
    } catch (error) {
      this.logger.warn?.('[wander multiplayer] arrival phase failed', error);
      return this.ticket;
    }
    this.onStatus({ state: 'visit-active', ticket: this.ticket });
    this.onTravel({ phase: 'visit-active', ticket: this.ticket });
    return this.ticket;
  }

  /** Complete the return journey after the red commuter reaches home. */
  markReturnComplete() {
    if (!this.ticket) return null;
    try {
      if (this.ticket.phase === 'return-requested') {
        this.ticket = transitionTicket(this.ticket, 'returning');
      }
      if (this.ticket.phase === 'returning') {
        this.ticket = transitionTicket(this.ticket, 'complete');
      }
    } catch (error) {
      this.logger.warn?.('[wander multiplayer] return phase failed', error);
      return this.ticket;
    }
    this.onStatus({ state: 'return-complete', ticket: this.ticket });
    this.onTravel({ phase: 'return-complete', ticket: this.ticket, homeRegion: this.region });
    this._finishVisitSession();
    return this.ticket;
  }

  configureTravel({ originStationProvider, destinationStationsProvider, hostPositionProvider } = {}) {
    this.travel = {
      originStationProvider: typeof originStationProvider === 'function' ? originStationProvider : null,
      destinationStationsProvider: typeof destinationStationsProvider === 'function' ? destinationStationsProvider : null,
      hostPositionProvider: typeof hostPositionProvider === 'function' ? hostPositionProvider : null,
    };
    return this.travel;
  }

  setAuthority(authority, { intentReducer } = {}) {
    this.authority = authority || null;
    this.intentReducer = typeof intentReducer === 'function' ? intentReducer : null;
    return this.authority;
  }

  /** Called once per render frame. Motion stays on the lossy channel. */
  update(now = Date.now(), pose, { moving = false } = {}) {
    this.avatarManager?.update?.(1 / 60);
    if (isValidPose(pose)) {
      const quantized = quantizePose({ ...pose, moving });
      this.lastPose = quantized;
      if (now - this.lastMotionSentAt >= MOTION_INTERVAL_MS) {
        this.lastMotionSentAt = now;
        for (const peer of this.peers.values()) {
          if (peer.state !== 'connected') continue;
          peer.sendMotion('motion', { playerId: this.identity.playerId, displayName: this.identity.displayName, pose: quantized });
        }
      }
    }
    if (this.role === 'host' && this.directory.listing && Date.now() - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeatAt = Date.now();
      this.directory.heartbeat({ population: 1 + this.peers.size, status: 'open' }).catch((error) => {
        this.logger.warn?.('[wander multiplayer] heartbeat failed', error);
      });
    }
    if (this.role === 'host' && this.authority && now - this.lastStateSnapshotAt >= STATE_SNAPSHOT_INTERVAL_MS) {
      this.lastStateSnapshotAt = now;
      this._broadcastStateSnapshots();
    }
  }

  sendIntent(kind, payload = {}) {
    const intent = { intentId: `${this.identity.playerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind, ...payload };
    for (const peer of this.peers.values()) peer.sendControl('intent', intent);
    return intent;
  }

  async reconnect(remotePlayerId = [...this.peers.keys()][0]) {
    const peer = this.peers.get(remotePlayerId);
    if (!peer) throw new Error('No peer is available to reconnect');
    this.onStatus({ state: 'peer-reconnecting', remotePlayerId });
    return peer.restartIce();
  }

  kickVisitor(playerId, reason = 'the host ended the visit') {
    if (this.role !== 'host') return false;
    const peer = this.peers.get(playerId);
    if (!peer) return false;
    peer.sendControl('close-session', { reason: String(reason).slice(0, 200) });
    peer.close();
    this.peers.delete(playerId);
    this.connectedPeers.delete(playerId);
    this.avatarManager?.remove?.(playerId);
    this.authority?.remove?.(playerId);
    this.onStatus({ state: 'visitor-kicked', playerId, reason });
    return true;
  }

  get diagnostics() {
    return {
      role: this.role,
      region: this.region,
      departureCount: this.departures.length,
      selectedDeparture: this.selectedDeparture,
      ticket: this.ticket,
      hostRequests: [...this.hostRequests.values()],
      peers: Object.fromEntries([...this.peers].map(([id, peer]) => [id, peer.diagnostics])),
      avatarManager: this.avatarManager?.diagnostics || null,
    };
  }

  _openHostSignalSocket(hostToken) {
    this.signalSocket?.close?.();
    try {
      this.signalSocket = this.directory.openSignalSocket({
        regionId: this.region.regionId,
        playerId: this.identity.playerId,
        token: hostToken,
        onMessage: (message) => this._handleSignal(message),
        onOpen: () => this._flushSignalQueue(),
        onClose: () => this.onStatus({ state: 'signaling-closed' }),
        onError: (error) => this.onStatus({ state: 'signaling-error', message: error?.message || 'signaling error' }),
      });
    } catch (error) {
      this.onStatus({ state: 'signaling-offline', message: error.message });
    }
  }

  _openGuestSignalSocket() {
    this.signalSocket?.close?.();
    try {
      this.signalSocket = this.directory.openSignalSocket({
        regionId: this.selectedDeparture.regionId,
        playerId: this.identity.playerId,
        onMessage: (message) => this._handleSignal(message),
        onOpen: () => this._flushSignalQueue(),
        onClose: () => this.onStatus({ state: 'signaling-closed' }),
        onError: (error) => this.onStatus({ state: 'signaling-error', message: error?.message || 'signaling error' }),
      });
    } catch (error) {
      this.onStatus({ state: 'signaling-offline', message: error.message });
    }
  }

  _ensurePeer(remotePlayerId, role = this.role === 'host' ? 'host' : 'guest') {
    let peer = this.peers.get(remotePlayerId);
    if (peer) return peer;
    peer = new WanderPeerConnection({
      role,
      playerId: this.identity.playerId,
      remotePlayerId,
      onSignal: (signal) => this._sendSignal({ kind: 'peer-signal', to: remotePlayerId, signal }),
      onMessage: (channel, envelope) => this._handlePeerMessage(remotePlayerId, channel, envelope),
      onStateChange: (state) => {
        this.onStatus({ state: `peer-${state.state}`, remotePlayerId, diagnostics: peer.diagnostics });
        if (['failed', 'disconnected', 'closed', 'denied'].includes(state.state)) {
          this.connectedPeers.delete(remotePlayerId);
          this.avatarManager?.remove?.(remotePlayerId);
          if (this.role === 'host') this.authority?.remove?.(remotePlayerId);
          if (this.role === 'host') {
            this.approvedVisitors.delete(remotePlayerId);
            this.approvedVisitorNames.delete(remotePlayerId);
          }
          // Let go of a connection that cannot come back.
          //
          // `peers` is what the visitor cap and the advertised population are
          // both counted from, so a dead entry left here costs a real seat: with
          // no TURN relay a failed connection is an ordinary outcome, and three
          // of them used to seal the region for the rest of the session — later
          // admission requests were dropped before the host ever saw them, while
          // the board went on advertising an empty region as full.
          //
          // 'disconnected' is deliberately not in this list even though it
          // clears the visitor above: it is a transient ICE state that regularly
          // recovers on its own, and the browser moves it to 'failed' when it
          // does not. Tearing the peer down there would end visits that were
          // about to resume.
          if (['failed', 'closed', 'denied'].includes(state.state) && this.peers.get(remotePlayerId) === peer) {
            this.peers.delete(remotePlayerId);
            peer.close();
          }
          if (this.role === 'guest' && state.state === 'failed'
              && this.ticket && ['host-approved', 'preflight', 'issued'].includes(this.ticket.phase)) {
            try {
              this.ticket = transitionTicket(this.ticket, 'cancelled', { cancelReason: 'direct connection failed' });
              this.onStatus({ state: 'visit-failed', message: 'the direct connection failed · your region is unchanged', ticket: this.ticket });
              this.onTravel({ phase: 'visit-failed', ticket: this.ticket });
            } catch (error) {
              this.logger.warn?.('[wander multiplayer] failed-visit cleanup failed', error);
            }
          }
        }
        if (state.state === 'connected') this._peerConnected(remotePlayerId);
      },
      logger: this.logger,
    });
    this.peers.set(remotePlayerId, peer);
    return peer;
  }

  _handleSignal(message) {
    if (!message?.kind) return;
    if (message.kind === 'admission-request' && this.role === 'host') {
      const request = message.request;
      if (!request?.playerId || (message.from && message.from !== request.playerId)
          || request.regionId !== this.region.regionId || this.peers.size >= 3) return;
      this.hostRequests.set(request.playerId, request);
      this.onAdmissionRequest(request);
      return;
    }
    if (message.kind === 'admission-response' && this.role === 'guest') {
      const decision = message.decision;
      if (decision?.playerId && decision.playerId !== this.identity.playerId) return;
      if (!decision?.approved) {
        if (this.ticket && !['complete', 'cancelled'].includes(this.ticket.phase)) {
          this.ticket = transitionTicket(this.ticket, 'cancelled', { cancelReason: decision?.reason || 'host declined' });
        }
        this.onStatus({ state: 'visitor-declined', ticket: this.ticket });
        return;
      }
      const approvedTicket = message.ticket;
      if (!approvedTicket || approvedTicket.ticketId !== this.ticket?.ticketId
          || approvedTicket.passengerId !== this.identity.playerId
          || approvedTicket.destination?.regionId !== this.selectedDeparture?.regionId
          || !Number.isFinite(Number(approvedTicket.destination?.seed))) {
        this.onStatus({ state: 'visit-rejected', message: 'the host returned an invalid ticket' });
        if (this.ticket && !['complete', 'cancelled'].includes(this.ticket.phase)) {
          this.ticket = transitionTicket(this.ticket, 'cancelled', { cancelReason: 'invalid host ticket' });
        }
        return;
      }
      this.ticket = { ...this.ticket, destination: approvedTicket.destination };
      this.hostId = decision.hostId || message.from || null;
      this.ticket = transitionTicket(this.ticket, 'host-approved');
      this.onStatus({ state: 'host-approved', ticket: this.ticket });
      if (this.hostId && this.peers.get(this.hostId)?.state === 'connected') {
        this._peerConnected(this.hostId);
      }
      return;
    }
    if (message.kind === 'peer-signal') {
      if (message.to && message.to !== this.identity.playerId) return;
      const remoteId = message.from;
      if (!remoteId || remoteId === this.identity.playerId) return;
      if (this.role === 'host' && !this.approvedVisitors.has(remoteId)) return;
      if (this.role === 'guest' && (!this.hostId || remoteId !== this.hostId)) return;
      const signal = message.signal || message;
      const peer = this._ensurePeer(remoteId, this.role === 'host' ? 'host' : 'guest');
      this._applyPeerSignal(peer, signal).catch((error) => this.logger.warn?.('[wander peer] signaling failed', error));
    }
  }

  async _applyPeerSignal(peer, signal) {
    if (!signal?.kind) return;
    if (signal.kind === 'offer') await peer.acceptOffer(signal.description, { admissionApproved: true });
    else if (signal.kind === 'answer') await peer.acceptAnswer(signal.description);
    else if (signal.kind === 'candidate') await peer.addCandidate(signal.candidate);
  }

  _handlePeerMessage(remotePlayerId, channel, envelope) {
    if (channel === 'control' && envelope.type === 'close-session') {
      this.peers.get(remotePlayerId)?.close();
      this.connectedPeers.delete(remotePlayerId);
      if (this.ticket && !['complete', 'cancelled'].includes(this.ticket.phase)) {
        try { this.ticket = transitionTicket(this.ticket, 'cancelled', { cancelReason: envelope.payload?.reason || 'host closed the visit' }); } catch { /* already terminal */ }
      }
      this.onStatus({ state: 'visit-closed', remotePlayerId, reason: envelope.payload?.reason });
      return;
    }
    if (channel === 'control' && envelope.type === 'intent' && this.role === 'host' && this.authority) {
      const result = this.authority.applyIntent(remotePlayerId, envelope.payload, this.intentReducer);
      if (result.applied && result.result?.operations) {
        const delta = this.authority.deltaFor(remotePlayerId, result.result.operations, result.revision - 1);
        if (delta) {
          for (const peer of this.peers.values()) {
            if (peer.state === 'connected') peer.sendState('state-delta', delta);
          }
        }
      }
      return;
    }
    if (channel === 'control' && envelope.type === 'state-request' && this.role === 'host' && this.authority) {
      const peer = this.peers.get(remotePlayerId);
      const snapshot = this._safeSnapshotFor(remotePlayerId);
      if (peer?.state === 'connected' && snapshot) peer.sendState('state-snapshot', snapshot);
      return;
    }
    if (channel === 'motion' && envelope.type === 'motion') {
      const pose = envelope.payload?.pose;
      if (!isValidPose(pose)) return;
      if (this.role === 'host' && !this.authority?.visitors?.has?.(remotePlayerId)) return;
      if (this.role === 'host') this.authority?.receiveMotion?.(remotePlayerId, pose);
      // A guest-to-guest pose is forwarded through the host. On the guest
      // side, preserve the original player id from the host-authoritative
      // payload instead of attributing every forwarded avatar to the host.
      const sourcePlayerId = this.role === 'host'
        ? remotePlayerId
        : (envelope.payload.playerId || remotePlayerId);
      const visitor = this.role === 'host' ? this.authority?.visitors?.get?.(remotePlayerId) : null;
      const forwarded = {
        playerId: sourcePlayerId,
        displayName: visitor?.displayName || envelope.payload.displayName || 'Visitor',
        pose,
      };
      this.avatarManager?.upsert?.(forwarded);
      this.onRemotePose(forwarded);
      if (this.role === 'host') {
        for (const [id, peer] of this.peers) {
          if (id !== remotePlayerId) peer.sendMotion('motion', forwarded);
        }
      }
      return;
    }
    if (this.role === 'guest' && channel === 'state' && envelope.type === 'state-snapshot') {
      try {
        const state = this.guestProjection.applySnapshot(envelope.payload);
        this.onStateSnapshot({
          playerId: remotePlayerId,
          channel,
          envelope,
          kind: 'snapshot',
          state,
          revision: this.guestProjection.revision,
          worldSeed: envelope.payload.worldSeed,
          regionId: envelope.payload.regionId,
        });
        this.peers.get(remotePlayerId)?.sendControl('state-ack', {
          revision: this.guestProjection.revision,
          regionId: this.guestProjection.regionId,
        });
      } catch (error) {
        this.logger.warn?.('[wander multiplayer] invalid state snapshot', error);
      }
      return;
    }
    if (this.role === 'guest' && channel === 'state' && envelope.type === 'state-delta') {
      try {
        const state = this.guestProjection.applyDelta(envelope.payload, applyStateDelta);
        this.onStateSnapshot({
          playerId: remotePlayerId,
          channel,
          envelope,
          kind: 'delta',
          state,
          revision: this.guestProjection.revision,
          worldSeed: envelope.payload.worldSeed,
          regionId: envelope.payload.regionId || this.guestProjection.regionId,
        });
        this.peers.get(remotePlayerId)?.sendControl('state-ack', {
          revision: this.guestProjection.revision,
          regionId: this.guestProjection.regionId,
        });
      } catch (error) {
        this.logger.warn?.('[wander multiplayer] state delta requires a snapshot', error);
        this.peers.get(remotePlayerId)?.sendControl('state-request', {
          reason: 'revision-mismatch',
          expectedRevision: this.guestProjection.revision,
          regionId: this.guestProjection.regionId,
        });
      }
    }
  }

  _peerConnected(remotePlayerId) {
    if (this.connectedPeers.has(remotePlayerId)
        && !(this.role === 'guest' && this.ticket?.phase === 'host-approved' && !this.ticketStarted)) return;
    this.connectedPeers.add(remotePlayerId);
    const peer = this.peers.get(remotePlayerId);
    if (this.role === 'host' && this.authority && peer) {
      const admission = this.authority.admit(remotePlayerId, {
        displayName: this.approvedVisitorNames.get(remotePlayerId) || 'Visitor',
      });
      if (!admission.ok) {
        peer.denyAdmission(admission.reason);
        return;
      }
      const snapshot = this._safeSnapshotFor(remotePlayerId);
      if (snapshot) peer.sendState('state-snapshot', snapshot);
    }
    try {
      if (this.role === 'guest' && this.ticket?.phase === 'host-approved') {
        this.ticket = transitionTicket(this.ticket, 'preflight');
        this.ticket = transitionTicket(this.ticket, 'issued');
        this.ticket = transitionTicket(this.ticket, 'summoned');
        this.ticketStarted = true;
      }
    } catch (error) {
      this.logger.warn?.('[wander multiplayer] ticket connection phase failed', error);
    }
    this.onStatus({ state: 'peer-connected', remotePlayerId, ticket: this.ticket });
    this.onTravel({ phase: 'ticket-issued', remotePlayerId, ticket: this.ticket });
  }

  /**
   * A snapshot that cannot take the frame down with it.
   *
   * `createStateSnapshot` throws above its 512 KiB budget, and this is reached
   * from `update()` — which the render loop calls before it streams terrain or
   * draws anything. An unbounded public projection could therefore stop the
   * whole game rather than just the sharing of it. The collections that feed a
   * snapshot are bounded at their source; this is the backstop for the next one
   * that is not, and it degrades to "visitors stop receiving updates" instead.
   */
  _safeSnapshotFor(playerId) {
    try {
      return this.authority?.snapshotFor(playerId) ?? null;
    } catch (error) {
      this.logger.warn?.('[wander multiplayer] snapshot refused', error);
      this.onStatus({ state: 'snapshot-too-large', remotePlayerId: playerId, message: error.message });
      return null;
    }
  }

  _broadcastStateSnapshots() {
    if (this.role !== 'host' || !this.authority) return;
    for (const [playerId, peer] of this.peers) {
      if (peer.state !== 'connected') continue;
      const snapshot = this._safeSnapshotFor(playerId);
      if (snapshot) peer.sendState('state-snapshot', snapshot);
    }
  }

  _finishVisitSession() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.connectedPeers.clear();
    this.signalSocket?.close?.();
    this.signalSocket = null;
    this.pendingSignals = [];
    this.approvedVisitors.clear();
    this.approvedVisitorNames.clear();
    this.hostRequests.clear();
    this.hostId = null;
    this.guestProjection = new GuestWorldProjection();
    this.ticketStarted = false;
    this.role = 'offline';
    this.onStatus({ state: 'visit-session-closed' });
    if (this.homeHosting) {
      this.homeHosting = false;
      this.openRegion({ visibility: 'public', allowVisitors: true, regionName: this.region.regionName })
        .catch((error) => this.onStatus({ state: 'region-reopen-failed', message: error.message }));
    }
  }

  _hostArrivalStation() {
    const stations = this.travel.destinationStationsProvider?.() || [];
    const position = this.travel.hostPositionProvider?.() || { x: 0, z: 0 };
    if (!stations.length) return null;
    const station = [...stations].sort((a, b) => (
      Math.hypot(Number(a.x) - Number(position.x), Number(a.z) - Number(position.z))
      - Math.hypot(Number(b.x) - Number(position.x), Number(b.z) - Number(position.z))
    ))[0];
    return station ? {
      arrivalStationId: station.id,
      arrivalStationName: station.name,
      arrivalStationX: Number(station.x) || 0,
      arrivalStationY: Number(station.y) || 0,
      arrivalStationZ: Number(station.z) || 0,
    } : null;
  }

  _sendSignal(message) {
    const envelope = { protocolVersion: 1, ...message, from: this.identity.playerId };
    const socket = this.signalSocket;
    if (!socket || (socket.readyState !== undefined && socket.readyState > 1)) {
      this._queueSignal(envelope);
      this.onStatus({ state: 'signaling-not-connected' });
      return false;
    }
    if (socket.readyState !== undefined && socket.readyState !== 1) {
      this._queueSignal(envelope);
      this.onStatus({ state: 'signaling-connecting' });
      return false;
    }
    return this._sendSignalNow(envelope);
  }

  _sendSignalNow(envelope) {
    if (!this.signalSocket || (this.signalSocket.readyState !== undefined && this.signalSocket.readyState !== 1)) {
      return false;
    }
    try { this.signalSocket.send(JSON.stringify(envelope)); return true; }
    catch (error) { this.logger.warn?.('[wander signaling] send failed', error); return false; }
  }

  _queueSignal(envelope) {
    if (this.pendingSignals.length >= MAX_PENDING_SIGNALS) this.pendingSignals.shift();
    this.pendingSignals.push(envelope);
  }

  _flushSignalQueue() {
    if (!this.signalSocket || (this.signalSocket.readyState !== undefined && this.signalSocket.readyState !== 1)) return;
    const queued = this.pendingSignals.splice(0);
    for (const envelope of queued) {
      if (!this._sendSignalNow(envelope)) {
        this.pendingSignals.unshift(envelope);
        break;
      }
    }
  }
}

export function createMultiplayerEnvelope(type, payload, from) {
  return createEnvelope(type, payload, { from });
}
