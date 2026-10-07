import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcSpeechPlayer, savedNpcSpeechEnabled } from '../src/npcspeechplayer.mjs';

function audioContext({ autoEnd = true } = {}) {
  const sources = [];
  return { state: 'running', sources, destination: {}, resume: async () => {},
    createBuffer: (channels, count, rate) => {
      assert.equal(channels, 1); assert.equal(rate, 24000);
      const samples = new Float32Array(count);
      return { getChannelData: () => samples, samples };
    },
    createBufferSource: () => {
      const source = { connect() {}, disconnect() {},
        start() { this.started = true; if (autoEnd) queueMicrotask(() => this.onended()); },
        stop() { this.stopped = true; queueMicrotask(() => this.onended?.()); } };
      sources.push(source); return source;
    } };
}
const pcmResponse = () => new Response(new Uint8Array([0, 0, 0, 128, 255, 127]), { headers: { 'content-type': 'audio/pcm' } });

test('speech stays silent before a gesture and when disabled; saved settings tolerate blocked storage', async () => {
  let calls = 0;
  const player = new NpcSpeechPlayer({ enabled: true, fetchImpl: async () => { calls++; return pcmResponse(); }, contextFactory: audioContext });
  assert.equal(await player.speak('Hello.'), false);
  player.unlock(); player.setEnabled(false);
  assert.equal(await player.speak('Hello.'), false);
  assert.equal(calls, 0);
  assert.equal(savedNpcSpeechEnabled({ getItem: () => 'false' }), false);
  assert.equal(savedNpcSpeechEnabled({ getItem() { throw new Error('blocked'); } }), true);
});

test('speech sends delivery metadata without provider credentials and decodes PCM for playback', async () => {
  const sent = [], context = audioContext();
  const player = new NpcSpeechPlayer({ endpoint: 'https://ai.example/', enabled: true, contextFactory: () => context,
    fetchImpl: async (url, options) => { sent.push({ url, ...options, body: JSON.parse(options.body) }); return pcmResponse(); } });
  player.unlock();
  assert.equal(await player.speak({ text: 'Stay close. <chuckle>', speechSegments: [
    { text: 'Stay close. <chuckle>', style: 'scared, clenched teeth' },
  ] }, { id: 'npc:maren' }), true);
  assert.equal(sent[0].url, 'https://ai.example/speech');
  assert.equal(sent[0].body.style, 'scared, clenched teeth');
  assert.equal(sent[0].body.input, 'Stay close. <chuckle>');
  assert.equal(sent[0].headers.authorization, undefined);
  assert.equal(context.sources[0].buffer.samples[1], -1);
  assert.ok(context.sources[0].buffer.samples[2] > 0.999);
});

test('closing or a newer reply cancels pending audio even if fetch ignores abort', async () => {
  let resolveFirst, firstSignal, calls = 0;
  const context = audioContext();
  const player = new NpcSpeechPlayer({ enabled: true, contextFactory: () => context,
    fetchImpl: async (url, options) => {
      calls++;
      if (calls === 1) { firstSignal = options.signal; return new Promise((resolve) => { resolveFirst = resolve; }); }
      return pcmResponse();
    } });
  player.unlock();
  const first = player.speak('Old reply.');
  const second = player.speak('New reply.');
  resolveFirst(pcmResponse());
  assert.equal(await first, false);
  assert.equal(firstSignal.aborted, true);
  assert.equal(await second, true);
  assert.equal(context.sources.length, 1);
});

test('stopping active playback ends it and provider errors leave text-only dialogue usable', async () => {
  const context = audioContext({ autoEnd: false });
  const player = new NpcSpeechPlayer({ enabled: true, contextFactory: () => context, fetchImpl: async () => pcmResponse() });
  player.unlock();
  const active = player.speak('Hello.');
  await new Promise((resolve) => setImmediate(resolve));
  player.stop();
  assert.equal(await active, false);
  assert.equal(context.sources[0].stopped, true);
  player.fetchImpl = async () => new Response('unavailable', { status: 503 });
  assert.equal(await player.speak('Still visible.'), false);
});
