import {
  hasTurnFallback,
  iceConfigurationFor,
  nextConnectionAttempt,
} from './multiplayerice.mjs';
import {
  CHANNELS,
  chunkString,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  reassembleChunks,
} from './multiplayerprotocol.mjs';

export {
  DIRECT_ICE_SERVERS,
  configuredTurnServers,
  hasTurnFallback,
  iceConfigurationFor,
} from './multiplayerice.mjs';

/** Kept for callers that only ever wanted the direct configuration. */
export const DIRECT_PEER_CONNECTION_OPTIONS = Object.freeze(iceConfigurationFor('direct', null));

const CHANNEL_BY_NAME = Object.freeze({
  control: CHANNELS.control,
  state: CHANNELS.state,
  motion: CHANNELS.motion,
});

/**
 * A small RTCPeerConnection adapter. Signaling is deliberately injected: the
 * directory worker only relays opaque offers/candidates and never sees world
 * state. The adapter withholds all ICE material until host approval.
 */
export class WanderPeerConnection {
  constructor({
    role = 'guest',
    playerId,
    remotePlayerId = null,
    onSignal,
    onMessage,
    onStateChange,
    logger = console,
    rtcFactory,
  } = {}) {
    this.role = role === 'host' ? 'host' : 'guest';
    this.playerId = playerId || null;
    this.remotePlayerId = remotePlayerId;
    this.onSignal = typeof onSignal === 'function' ? onSignal : () => {};
    this.onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
    this.logger = logger || console;
    this.rtcFactory = rtcFactory || (() => globalThis.RTCPeerConnection);
    this.pc = null;
    this.channels = new Map();
    this.pendingSignals = [];
    this.pendingCandidates = [];
    this._chunks = new Map();
    // Which route this attempt uses, and how many attempts have been spent, so a
    // failure can escalate rather than simply end the visit.
    this.iceMode = 'direct';
    this.attempts = 0;
    this.usedRelay = false;
    this._recovering = false;
    this.admissionApproved = false;
    this.state = 'idle';
    this.sequence = 0;
    this.startedAt = 0;
  }

  get supported() {
    return typeof this.rtcFactory() === 'function';
  }

  async startHost({ admissionApproved = false } = {}) {
    this._ensurePeer();
    this.admissionApproved = !!admissionApproved;
    this._createDataChannels();
    this._setState('connecting');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    // Wait for the browser to gather candidates; this gives the approval gate
    // one atomic payload to release instead of leaking a host candidate early.
    await this._waitForIceGathering();
    this._queueOrSignal({ kind: 'offer', description: this.pc.localDescription });
    this.startedAt = Date.now();
    return this.pc.localDescription;
  }

  async acceptOffer(description, { admissionApproved = false } = {}) {
    this._ensurePeer();
    this.admissionApproved = !!admissionApproved;
    await this.pc.setRemoteDescription(description);
    this._flushCandidates();
    this._setState('connecting');
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitForIceGathering();
    this._queueOrSignal({ kind: 'answer', description: this.pc.localDescription });
    return this.pc.localDescription;
  }

  async acceptAnswer(description) {
    this._ensurePeer();
    await this.pc.setRemoteDescription(description);
    this._flushCandidates();
    return this.pc.remoteDescription;
  }

  async addCandidate(candidate) {
    if (!candidate) return;
    if (!this.admissionApproved || !this.pc?.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try { await this.pc.addIceCandidate(candidate); } catch (error) {
      this.logger.warn?.('[wander peer] ICE candidate rejected', error);
    }
  }

  /**
   * Escalate a failed connection instead of ending the visit at the first refusal.
   *
   * Only the host rebuilds: it owns the offer, so a guest that tore its own
   * connection down would race the new one arriving. A guest reports the failure
   * and waits to be re-offered.
   *
   * Every outcome is named. The old code surfaced `failed` and nothing else, so
   * "it didn't work" was all a player ever learned, whether the cause was a
   * moment of packet loss or a network that can never be traversed directly.
   */
  _recoverFromFailure() {
    if (this._recovering) return;
    this._recovering = true;
    const plan = nextConnectionAttempt(this.attempts, {
      turnAvailable: hasTurnFallback(),
      usedRelay: this.usedRelay,
    });
    this.attempts += 1;
    if (plan.action === 'give-up' || this.role !== 'host') {
      this._recovering = false;
      if (plan.action === 'give-up') {
        this._setState('failed', plan.reason, { mode: plan.mode, exhausted: true });
        return;
      }
      this._setState('reconnecting', 'waiting for the host to try again', { mode: plan.mode });
      return;
    }
    this._setState('reconnecting', plan.mode === 'relay'
      ? 'direct connection failed · trying the relay'
      : 'connection dropped · trying again', { mode: plan.mode, attempt: this.attempts });
    const run = async () => {
      try {
        if (plan.mode === 'relay') {
          // A relay attempt needs a new peer connection: iceTransportPolicy is
          // fixed at construction and cannot be relaxed on a live one.
          this.iceMode = 'relay';
          this.usedRelay = true;
          try { this.pc?.close(); } catch { /* already closed */ }
          this.pc = null;
          this.channels.clear();
          await this.startHost({ admissionApproved: this.admissionApproved });
        } else {
          await this.restartIce();
        }
      } catch (error) {
        this.logger.warn?.('[wander peer] reconnection attempt failed', error);
        this._setState('failed', 'the connection could not be rebuilt', { exhausted: true });
      } finally {
        this._recovering = false;
      }
    };
    if (typeof setTimeout === 'function') setTimeout(run, plan.delayMs);
    else run();
  }

  async restartIce() {
    if (!this.pc) throw new Error('Peer connection is not initialized');
    if (typeof this.pc.restartIce === 'function') this.pc.restartIce();
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    await this._waitForIceGathering();
    this._queueOrSignal({ kind: 'offer', description: this.pc.localDescription, iceRestart: true });
    return this.pc.localDescription;
  }

  /** Release the offer/candidate queue only after the host accepts the guest. */
  approveAdmission() {
    this.admissionApproved = true;
    this._flushSignals();
    this._flushCandidates();
  }

  denyAdmission(reason = 'host declined the visit') {
    this._setState('denied', reason);
    this.close();
  }

  send(channel, type, payload = {}, options = {}) {
    const dataChannel = this.channels.get(channel);
    if (!dataChannel || dataChannel.readyState !== 'open') return false;
    const envelope = createEnvelope(type, payload, {
      from: this.playerId,
      sequence: this.sequence++,
      ...options,
    });
    let encoded;
    try { encoded = encodeEnvelope(envelope); } catch {
      // Too large for one message. A world snapshot legitimately outgrows the
      // ceiling, and refusing to send it left a visitor with no world at all, so
      // it travels in pieces instead. Only the reliable ordered channels are
      // eligible: motion is lossy by design and a partial pose is worthless.
      if (channel === 'motion') return false;
      return this._sendChunked(channel, dataChannel, envelope);
    }
    return this._sendRaw(dataChannel, encoded);
  }

  _sendRaw(dataChannel, encoded) {
    if (typeof dataChannel.bufferedAmount === 'number' && dataChannel.bufferedAmount > 256 * 1024) return false;
    try { dataChannel.send(encoded); return true; } catch (error) {
      this.logger.warn?.('[wander peer] send failed', error);
      return false;
    }
  }

  /** Carry one oversized envelope as a run of `state-chunk` messages. */
  _sendChunked(channel, dataChannel, envelope) {
    const transferId = `${this.playerId}:${this.sequence++}`;
    const parts = chunkString(JSON.stringify(envelope), { transferId });
    for (const part of parts) {
      const carrier = createEnvelope('state-chunk', part, {
        from: this.playerId,
        sequence: this.sequence++,
      });
      let encodedPart;
      try { encodedPart = encodeEnvelope(carrier); } catch (error) {
        this.logger.warn?.('[wander peer] chunk exceeded the message ceiling', error);
        return false;
      }
      if (!this._sendRaw(dataChannel, encodedPart)) return false;
    }
    return true;
  }

  /**
   * Rebuild a chunked envelope, or return null while pieces are still arriving.
   *
   * The channel carrying these is reliable and ordered, so the run cannot be
   * reordered or lost — only interrupted by a connection that dies, which takes
   * the half-built transfer with it.
   */
  _receiveChunk(payload) {
    const transferId = payload?.transferId;
    if (!transferId) return null;
    const pending = this._chunks.get(transferId) || [];
    pending.push(payload);
    this._chunks.set(transferId, pending);
    if (pending.length < payload.total) return null;
    this._chunks.delete(transferId);
    try { return JSON.parse(reassembleChunks(pending)); } catch (error) {
      this.logger.warn?.('[wander peer] dropped an incomplete chunked message', error);
      return null;
    }
  }

  sendControl(type, payload, options) { return this.send('control', type, payload, options); }
  sendState(type, payload, options) { return this.send('state', type, payload, options); }
  sendMotion(type, payload, options) { return this.send('motion', type, payload, options); }

  close() {
    for (const channel of this.channels.values()) {
      try { channel.close(); } catch { /* already closed */ }
    }
    this.channels.clear();
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null;
    this.pendingSignals = [];
    this.pendingCandidates = [];
    this._chunks.clear();
    this._setState('closed');
  }

  get diagnostics() {
    return {
      supported: this.supported,
      role: this.role,
      state: this.state,
      admissionApproved: this.admissionApproved,
      connectionState: this.pc?.connectionState || 'unavailable',
      iceConnectionState: this.pc?.iceConnectionState || 'unavailable',
      channels: Object.fromEntries([...this.channels].map(([key, channel]) => [key, channel.readyState])),
      pendingSignals: this.pendingSignals.length,
      pendingCandidates: this.pendingCandidates.length,
      startedAt: this.startedAt || null,
    };
  }

  _ensurePeer() {
    if (this.pc) return this.pc;
    const Factory = this.rtcFactory();
    if (typeof Factory !== 'function') throw new Error('WebRTC is unavailable in this browser');
    this.pc = new Factory(iceConfigurationFor(this.iceMode));
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this._queueOrSignal({ kind: 'candidate', candidate: event.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState || 'closed';
      if (state === 'failed') { this._recoverFromFailure(); return; }
      this._setState(state);
    };
    this.pc.ondatachannel = (event) => this._bindChannel(event.channel);
    return this.pc;
  }

  _createDataChannels() {
    if (this.role !== 'host' || !this.pc?.createDataChannel) return;
    this._bindChannel(this.pc.createDataChannel(CHANNELS.control, { ordered: true }));
    this._bindChannel(this.pc.createDataChannel(CHANNELS.state, { ordered: true }));
    this._bindChannel(this.pc.createDataChannel(CHANNELS.motion, { ordered: false, maxRetransmits: 0 }));
  }

  _bindChannel(channel) {
    if (!channel || !Object.values(CHANNELS).includes(channel.label)) return;
    const name = Object.entries(CHANNELS).find(([, label]) => label === channel.label)?.[0];
    if (!name) return;
    this.channels.set(name, channel);
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this._setState('connected');
      this.onStateChange({ state: 'connected', channel: name });
    };
    channel.onclose = () => {
      this.onStateChange({ state: 'channel-closed', channel: name });
    };
    channel.onerror = (error) => this.onStateChange({ state: 'channel-error', channel: name, error });
    channel.onmessage = (event) => {
      try {
        const envelope = decodeEnvelope(event.data);
        if (envelope.type === 'state-chunk') {
          const whole = this._receiveChunk(envelope.payload);
          if (whole) this.onMessage(name, whole);
          return;
        }
        this.onMessage(name, envelope);
      } catch (error) {
        this.logger.warn?.('[wander peer] dropped malformed data channel message', error);
      }
    };
  }

  _queueOrSignal(signal) {
    if (!this.admissionApproved && signal.kind !== 'offer') {
      this.pendingSignals.push(signal);
      return;
    }
    if (!this.admissionApproved && signal.kind === 'offer') {
      this.pendingSignals.push(signal);
      return;
    }
    this.onSignal({ ...signal, from: this.playerId, to: this.remotePlayerId });
  }

  _flushSignals() {
    const queued = this.pendingSignals.splice(0);
    for (const signal of queued) this.onSignal({ ...signal, from: this.playerId, to: this.remotePlayerId });
  }

  _flushCandidates() {
    if (!this.admissionApproved || !this.pc?.remoteDescription) return;
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) this.addCandidate(candidate);
  }

  _setState(state, reason = null, extra = null) {
    if (this.state === state && !reason) return;
    this.state = state;
    this.onStateChange({ state, reason, ...(extra || {}) });
  }

  _waitForIceGathering() {
    if (!this.pc || this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let timeout;
      const onChange = () => {
        if (this.pc?.iceGatheringState === 'complete') done();
      };
      const done = () => {
        if (timeout) clearTimeout(timeout);
        if (this.pc) this.pc.onicegatheringstatechange = null;
        resolve();
      };
      timeout = setTimeout(done, 2500);
      this.pc.onicegatheringstatechange = onChange;
    });
  }
}

export function isDirectIceConfiguration(configuration) {
  const servers = configuration?.iceServers || [];
  return servers.every((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.every((url) => typeof url === 'string' && url.startsWith('stun:'));
  }) && configuration?.iceTransportPolicy !== 'relay';
}
