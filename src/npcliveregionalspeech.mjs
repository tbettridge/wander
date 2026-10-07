import { npcSpeechProfile, npcDialogueText } from './npcspeech.mjs?v=4';

// Live understands speech and writes the reply. The stored TTS voice provides
// its permanent accent and identity, independently of Live's stock audio.
export class NpcLiveRegionalSpeech {
  constructor({ endpoint, fetchImpl, audio, onChunk = () => {}, onDrained = () => {}, onError = () => {}, deliveryFor = () => '' }) {
    Object.assign(this, { endpoint, fetchImpl, audio, onChunk, onDrained, onError, deliveryFor });
  }
  setNpc(npc) { this.cancel(); this.npcId = npc.id; this.profile = npcSpeechProfile(npc); }
  get pending() { return !!this.job && (!this.job.complete || this.job.running || this.job.queue.length > 0); }
  cancel() { this.job?.controller.abort(); this.job = null; }

  update(text, complete = false) {
    if (!text?.trim()) return;
    const job = this.job ||= { controller: new AbortController(), offset: 0, text: '', queue: [],
      complete: false, running: false, segments: [], bytes: 0 };
    if (text.length > 2400 || !text.startsWith(job.text)) { this._fail(job); return; }
    job.text = text; job.complete = complete;
    while (job.offset < text.length) {
      const tail = text.slice(job.offset);
      const boundary = [...tail.matchAll(/[.!?]["'”’)]*(?=\s|$)/g)].find(match => match.index + match[0].length >= 24);
      let count = boundary ? boundary.index + boundary[0].length : job.complete ? tail.length : 0;
      if (!count && tail.length < 600) break;
      if (count > 600 || !count) count = tail.lastIndexOf(' ', 600) > 0 ? tail.lastIndexOf(' ', 600) : 600;
      const segment = { text: npcDialogueText(tail.slice(0, count)), offset: job.offset, index: job.segments.length,
        start: null, end: null, complete: false };
      job.offset += count;
      if (!segment.text) continue;
      if (job.segments.length >= 6) { this._fail(job); return; }
      job.segments.push(segment); job.queue.push(segment);
    }
    this._drain(job);
  }

  _fail(job) {
    if (this.job !== job) return;
    this.cancel(); this.onError();
  }

  async _drain(job) {
    if (job.running || this.job !== job) return;
    job.running = true;
    try {
      while (job.queue.length && this.job === job) {
        const segment = job.queue.shift();
        const timer = setTimeout(() => job.controller.abort(), 35000);
        try {
          const response = await this.fetchImpl(`${this.endpoint}/speech`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: job.controller.signal,
            body: JSON.stringify({ npcId: this.npcId, voice: this.profile.voice, voiceKey: this.profile.voiceKey,
              input: segment.text, style: this.deliveryFor(segment.text) || this.profile.baselineStyle,
              stream: true, regionalOnly: true }),
          });
          if (!response.ok || !/audio\/(pcm|l16)/i.test(response.headers.get('content-type') || '')
            || !['designed', 'regional-library'].includes(response.headers.get('x-wander-voice-source'))) throw new Error('Regional voice unavailable');
          const reader = response.body.getReader(); let carry = new Uint8Array(0), size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (this.job !== job || job.controller.signal.aborted) { await reader.cancel(); return; }
              if (done) break;
              size += value.length; job.bytes += value.length;
              if (size > 6000000 || job.bytes > 12000000) throw new Error('Regional speech too long');
              const bytes = new Uint8Array(carry.length + value.length); bytes.set(carry); bytes.set(value, carry.length);
              const length = bytes.length - bytes.length % 2; carry = bytes.slice(length);
              if (!length) continue;
              const chunk = this.audio.enqueuePcm(bytes.subarray(0, length));
              if (!chunk) throw new Error('Playback unavailable');
              segment.start ??= chunk.start; segment.end = chunk.end;
              this.onChunk(segment, chunk);
            }
            if (!size || carry.length) throw new Error('Malformed regional audio');
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          segment.complete = true; this.onChunk(segment, null);
        } finally { clearTimeout(timer); }
      }
    } catch { if (this.job === job) this._fail(job); }
    finally {
      job.running = false;
      if (this.job === job && job.complete && !job.queue.length) this.onDrained();
    }
  }
}
