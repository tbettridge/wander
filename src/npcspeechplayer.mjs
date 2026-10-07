import { npcSpeechProfile, parseNpcDelivery } from './npcspeech.mjs?v=3';
import { NPC_GESTURES, buildSpeechEnvelope, mouthAmountAt } from './npcexpression.mjs?v=1';

export function savedNpcSpeechEnabled(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem('wander.npc.speech') !== 'false'; }
  catch { return true; }
}

export class NpcSpeechPlayer {
  constructor({ endpoint = globalThis.WANDER_AI_URL || '/api/ai', fetchImpl = (...args) => globalThis.fetch(...args),
    contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    enabled = savedNpcSpeechEnabled(), onStatus = () => {}, onSegmentStart = () => {}, onStop = () => {}, } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.contextFactory = contextFactory;
    this.enabled = enabled;
    this.onStatus = onStatus;
    this.onSegmentStart = onSegmentStart;
    this.onStop = onStop;
    this.performerId = null;
    this.context = null;
    this.controller = null;
    this.source = null;
    this.performance = null;
    this.gesture = null;
  }

  // Call synchronously from Talk / Send to satisfy mobile autoplay policies.
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ||= this.contextFactory();
      this.context.resume()?.catch?.(() => {});
    } catch { /* Text remains usable on devices without Web Audio. */ }
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled) this.stop();
    try { globalThis.localStorage?.setItem('wander.npc.speech', String(this.enabled)); } catch { /* optional */ }
  }

  stop() {
    const npcId = this.performerId;
    this.performerId = null;
    this.controller?.abort();
    this.controller = null;
    try { this.source?.stop(); } catch { /* already ended */ }
    this.source = null;
    this.performance = null;
    this.gesture = null;
    if (npcId) { try { this.onStop(npcId); } catch { /* presentation only */ } }
  }

  // Read on the audio clock rather than render time: pauses and interrupted
  // requests cannot leave a face talking, or make a queued cue run early.
  performanceFor(npcId) {
    if (this.context?.state !== 'running') return null;
    const now = this.context.currentTime || 0;
    const speech = this.performance?.npcId === npcId ? this.performance : null;
    const gesture = this.gesture?.npcId === npcId ? this.gesture : null;
    const elapsed = gesture ? now - gesture.startedAt : 0;
    const activeGesture = gesture && elapsed < NPC_GESTURES[gesture.name].duration;
    if (!speech && !activeGesture) return null;
    return { mouthOpen: speech ? mouthAmountAt(speech.envelope, now - speech.startedAt) : 0,
      gestureName: activeGesture ? gesture.name : null, gestureElapsed: elapsed };
  }

  async speak(raw, npc = {}) {
    this.stop();
    if (!this.enabled || !this.context || this.context.state !== 'running') return false;
    const profile = npcSpeechProfile(npc);
    const { segments } = parseNpcDelivery(raw);
    // Bound a single reply, including malformed/model-created cue storms.
    // The chat still displays the entire reply if it exceeds speech limits.
    if (!segments.length || segments.length > 8 || segments.some((segment) => segment.input.length > 1200)) return false;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 120000);
    const fetchSegment = async (segment) => {
      const response = await this.fetchImpl(`${this.endpoint}/speech`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ npcId: npc.id || 'resident', voice: profile.voice, voiceKey: profile.voiceKey,
          input: segment.input, style: segment.style || profile.baselineStyle }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('NPC speech unavailable');
      const type = response.headers.get('content-type') || '';
      if (!/audio\/(?:pcm|l16)/i.test(type)) throw new Error('Unsupported NPC audio');
      const data = await response.arrayBuffer();
      if (!data.byteLength || data.byteLength > 6000000 || data.byteLength % 2) throw new Error('Invalid NPC audio');
      if (controller.signal.aborted) throw new Error('NPC speech cancelled');
      const samples = new DataView(data);
      const buffer = this.context.createBuffer(1, data.byteLength / 2, 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
      return { buffer, envelope: buildSpeechEnvelope(channel) };
    };
    try {
      let pending = fetchSegment(segments[0]);
      // Warm the following phrase alongside the first request so a gesture
      // boundary does not add a full synthesis round trip to the spoken line.
      let next = segments.length > 1 ? fetchSegment(segments[1]) : Promise.resolve(null);
      next.catch(() => {});
      for (let i = 0; i < segments.length; i++) {
        const { buffer, envelope } = await pending;
        if (controller.signal.aborted) return false;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.source = source;
        const ended = new Promise((resolve) => {
          const finish = () => {
            controller.signal.removeEventListener('abort', cancel);
            source.disconnect();
            if (this.source === source) { this.source = null; this.performance = null; }
            resolve();
          };
          const cancel = () => { try { source.stop(); } catch { finish(); } };
          source.onended = finish;
          controller.signal.addEventListener('abort', cancel, { once: true });
        });
        const startedAt = this.context.currentTime || 0;
        this.performance = { npcId: npc.id || 'resident', source, envelope, startedAt };
        this.performerId = npc.id || 'resident';
        const gesture = segments[i].gesture || (i === 0 ? 'open-hand' : null);
        if (gesture) this.gesture = { npcId: npc.id || 'resident', name: gesture, startedAt };
        source.start();
        try { this.onSegmentStart({ npcId: npc.id || 'resident', segment: segments[i], duration: envelope.duration }); }
        catch { /* A presentation callback must never interrupt audible speech. */ }
        await ended;
        if (controller.signal.aborted) return false;
        pending = next;
        // Keep only one phrase ahead of the currently audible performance.
        next = i + 2 < segments.length ? fetchSegment(segments[i + 2]) : Promise.resolve(null);
        next.catch(() => {});
      }
      this.onStatus('ready');
      return true;
    } catch {
      if (!controller.signal.aborted) this.onStatus('unavailable');
      if (this.controller === controller) this.stop();
      return false;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
}
