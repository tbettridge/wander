import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcSpeechPlayer, savedNpcSpeechEnabled } from '../src/npcspeechplayer.mjs';

function audioContext({ autoEnd = true } = {}) {
  const sources = [];
  return { state: 'running', currentTime: 0, sources, destination: {}, resume: async () => {},
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

test('default browser fetch preserves its Window receiver for speech', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (url) {
    assert.equal(this, globalThis, 'native Window.fetch rejects a class instance as its receiver');
    assert.equal(url, 'https://ai.example/speech');
    calls++;
    return pcmResponse();
  };
  const player = new NpcSpeechPlayer({ endpoint: 'https://ai.example', enabled: true, contextFactory: audioContext });
  try {
    player.unlock();
    assert.equal(await player.speak('Welcome.', { id: 'npc:maren' }), true);
    assert.equal(calls, 1);
  } finally {
    player.stop();
    globalThis.fetch = previous;
  }
});

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
  assert.match(sent[0].body.voiceKey, /^[a-z]+:(female|male):adult:[01]$/);
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

test('gesture timing follows actual phrase playback, mouth samples its audio clock and cancellation clears both', async () => {
  const context = audioContext({ autoEnd: false }), started = [], sent = [], stopped = [];
  const pcm = new Uint8Array(4800 * 2), view = new DataView(pcm.buffer);
  for (let i = 480; i < 2400; i++) view.setInt16(i * 2, Math.sin(i * 0.3) * 11000, true);
  const player = new NpcSpeechPlayer({ enabled: true, contextFactory: () => context,
    fetchImpl: async (url, request) => {
      sent.push(JSON.parse(request.body).input);
      return new Response(pcm, { headers: { 'content-type': 'audio/pcm' } });
    },
    onSegmentStart: event => { assert.ok(context.sources.at(-1).started); started.push(event); },
    onStop: id => stopped.push(id),
  });
  player.unlock();
  const playing = player.speak('Let me think. <gesture:point> Harrow Mill is along that lane.', { id: 'npc:maren' });
  assert.equal(player.performanceFor('npc:maren'), null, 'a downloading clip has no mouth or gesture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.equal(started[0].segment.input, 'Let me think.');
  assert.equal(player.performanceFor('npc:maren').mouthOpen, 0);
  context.currentTime = 0.04;
  assert.ok(player.performanceFor('npc:maren').mouthOpen > 0.5);
  assert.equal(player.performanceFor('npc:someone-else'), null);
  assert.equal(started.some(event => event.segment.gesture === 'point'), false,
    'prefetching the later phrase must not point early');
  context.currentTime = 0.2;
  context.sources[0].onended();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started[1].segment.gesture, 'point');
  assert.equal(player.performanceFor('npc:maren').gestureName, 'point');
  assert.ok(sent.every(input => !input.includes('gesture:')));
  context.state = 'suspended';
  assert.equal(player.performanceFor('npc:maren'), null);
  context.state = 'running';
  player.stop();
  assert.equal(await playing, false);
  assert.equal(player.performanceFor('npc:maren'), null);
  assert.deepEqual(stopped, ['npc:maren']);
  assert.equal(context.sources[1].stopped, true);
});
