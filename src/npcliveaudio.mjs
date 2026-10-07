import { buildSpeechEnvelope, mouthAmountAt } from './npcexpression.mjs?v=2';
import { livePcmFrame } from './npcliveprotocol.mjs';

export function createLiveAudioContext(sampleRate) {
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  try { return new AudioContext({ sampleRate }); } catch { return new AudioContext(); }
}

export const livePcmBase64 = pcm => {
  const bytes = new Uint8Array(pcm.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
};

export class NpcLiveMicrophone {
  constructor({ onFrame = () => {}, getUserMedia = options => navigator.mediaDevices.getUserMedia(options),
    contextFactory = () => createLiveAudioContext(16000), } = {}) {
    this.onFrame = onFrame; this.getUserMedia = getUserMedia; this.contextFactory = contextFactory; this.sequence = 0;
  }
  async start() {
    const sequence = ++this.sequence;
    const context = this.contextFactory(); this.context = context;
    await context.resume();
    const stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (sequence !== this.sequence) { stream.getTracks().forEach(track => track.stop()); await context.close(); return false; }
    this.stream = stream;
    await context.audioWorklet.addModule(new URL('./npclivemicworklet.js', import.meta.url));
    if (sequence !== this.sequence) return false;
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, 'npc-live-mic');
    this.silent = context.createGain(); this.silent.gain.value = 0;
    this.node.port.onmessage = event => this.onFrame(livePcmFrame(event.data.samples, event.data.sampleRate));
    this.source.connect(this.node); this.node.connect(this.silent); this.silent.connect(context.destination);
    stream.getAudioTracks().forEach(track => { track.onended = () => { this.stop(); this.onEnded?.(); }; });
    return true;
  }
  stop() {
    this.sequence++; this.node?.disconnect(); this.source?.disconnect(); this.silent?.disconnect();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = null; this.node = null; this.source = null; this.silent = null;
    this.context?.close()?.catch?.(() => {}); this.context = null;
  }
}

export class NpcLiveAudioPlayer {
  constructor({ contextFactory = () => createLiveAudioContext(24000), onIdle = () => {} } = {}) {
    this.contextFactory = contextFactory; this.onIdle = onIdle; this.chunks = []; this.nextTime = 0;
  }
  unlock() { this.context ||= this.contextFactory(); this.context.resume()?.catch?.(() => {}); }
  enqueue(base64) {
    return this.enqueuePcm(Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)));
  }
  enqueuePcm(raw) {
    if (this.context?.state !== 'running') return null;
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length % 2 || raw.length > 2000000) throw new Error('Invalid Live audio');
    const buffer = this.context.createBuffer(1, raw.length / 2, 24000), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      let value = raw[i * 2] | raw[i * 2 + 1] << 8;
      if (value >= 32768) value -= 65536; samples[i] = value / 32768;
    }
    const now = this.context.currentTime;
    if (this.nextTime - now > 30) throw new Error('Live playback queue exceeded');
    const start = Math.max(now + 0.12, this.nextTime), end = start + samples.length / 24000;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const chunk = { source, start, end, envelope: buildSpeechEnvelope(samples, 24000) };
    this.chunks.push(chunk); this.nextTime = end; this.lastChunk = chunk;
    source.onended = () => {
      source.disconnect(); this.chunks = this.chunks.filter(item => item !== chunk);
      if (!this.chunks.length) this.onIdle();
    };
    source.start(start); return chunk;
  }
  get now() { return this.context?.currentTime || 0; }
  get busy() { return this.chunks.length > 0; }
  get mouthOpen() {
    if (this.context?.state !== 'running') return 0;
    const chunk = this.chunks.find(item => this.now >= item.start && this.now < item.end);
    return chunk ? mouthAmountAt(chunk.envelope, this.now - chunk.start) : 0;
  }
  stop() {
    const chunks = this.chunks; this.chunks = []; this.nextTime = this.now; this.lastChunk = null;
    for (const chunk of chunks) { chunk.source.onended = null; try { chunk.source.stop(); } catch { /* ended */ } chunk.source.disconnect(); }
  }
  dispose() { this.stop(); this.context?.close()?.catch?.(() => {}); this.context = null; }
}
