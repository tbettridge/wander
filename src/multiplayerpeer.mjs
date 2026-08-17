import {
  CHANNELS,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
} from './multiplayerprotocol.mjs';

/** Cloudflare's public STUN service is free; no TURN relay is configured. */
export const DIRECT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
]);

export const DIRECT_PEER_CONNECTION_OPTIONS = Object.freeze({
  iceServers: DIRECT_ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
});

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
    try { encoded = encodeEnvelope(envelope); } catch (error) {
      this.logger.warn?.('[wander peer] refusing oversized message', error);
      return false;
    }
    if (typeof dataChannel.bufferedAmount === 'number' && dataChannel.bufferedAmount > 256 * 1024) return false;
    try { dataChannel.send(encoded); return true; } catch (error) {
      this.logger.warn?.('[wander peer] send failed', error);
      return false;
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
    this.pc = new Factory(DIRECT_PEER_CONNECTION_OPTIONS);
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this._queueOrSignal({ kind: 'candidate', candidate: event.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState || 'closed';
      this._setState(state);
      if (state === 'failed') this.onStateChange({ state, reconnectable: true });
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
      try { this.onMessage(name, decodeEnvelope(event.data)); } catch (error) {
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

  _setState(state, reason = null) {
    if (this.state === state && !reason) return;
    this.state = state;
    this.onStateChange({ state, reason });
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
