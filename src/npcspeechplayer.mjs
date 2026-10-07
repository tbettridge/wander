import { npcSpeechProfile, parseNpcDelivery } from './npcspeech.mjs';

export function savedNpcSpeechEnabled(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem('wander.npc.speech') !== 'false'; }
  catch { return true; }
}

export class NpcSpeechPlayer {
  constructor({ endpoint = globalThis.WANDER_AI_URL || '/api/ai', fetchImpl = globalThis.fetch,
    contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    enabled = savedNpcSpeechEnabled(), onStatus = () => {}, } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.contextFactory = contextFactory;
    this.enabled = enabled;
    this.onStatus = onStatus;
    this.context = null;
    this.controller = null;
    this.source = null;
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
    this.controller?.abort();
    this.controller = null;
    try { this.source?.stop(); } catch { /* already ended */ }
    this.source = null;
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
        body: JSON.stringify({ npcId: npc.id || 'resident', voice: profile.voice,
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
      return buffer;
    };
    try {
      let pending = fetchSegment(segments[0]);
      for (let i = 0; i < segments.length; i++) {
        const buffer = await pending;
        if (controller.signal.aborted) return false;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.source = source;
        const ended = new Promise((resolve) => {
          const finish = () => {
            controller.signal.removeEventListener('abort', cancel);
            source.disconnect();
            if (this.source === source) this.source = null;
            resolve();
          };
          const cancel = () => { try { source.stop(); } catch { finish(); } };
          source.onended = finish;
          controller.signal.addEventListener('abort', cancel, { once: true });
        });
        source.start();
        // Prepare only the next segment during playback; do not bill the whole
        // conversation ahead of the listener. Handle early rejection promptly.
        pending = i + 1 < segments.length ? fetchSegment(segments[i + 1]) : Promise.resolve(null);
        pending.catch(() => {});
        await ended;
        if (controller.signal.aborted) return false;
      }
      this.onStatus('ready');
      return true;
    } catch {
      if (!controller.signal.aborted) this.onStatus('unavailable');
      return false;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
}
