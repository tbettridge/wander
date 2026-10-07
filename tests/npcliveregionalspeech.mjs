import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcLiveRegionalSpeech } from '../src/npcliveregionalspeech.mjs';

const pause = () => new Promise(resolve => setImmediate(resolve));
const npc = { id: 'npc:iris', presentation: 'feminine', age: 'elder', voiceBackground: { accentId: 'irish' } };
const headers = { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' };
function harness(fetchImpl) {
  const calls = [], chunks = [], errors = [], drained = [];
  const audio = { time: 0, enqueuePcm(bytes) { const chunk = { start: this.time, end: this.time + bytes.length / 48000 }; this.time = chunk.end; chunks.push([...bytes]); return chunk; } };
  const speech = new NpcLiveRegionalSpeech({ endpoint: '/ai', audio,
    fetchImpl: async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return fetchImpl?.(options) || new Response(new Uint8Array([0, 0, 1, 0]), { headers }); },
    onError: () => errors.push(true), onDrained: () => drained.push(true) });
  speech.setNpc(npc); return { speech, calls, chunks, errors, drained };
}

test('regional playback keeps its immutable cast key across emotional replies and starts with a complete sentence', async () => {
  const h = harness();
  h.speech.update('Hello'); assert.equal(h.calls.length, 0);
  h.speech.update('Hello there, traveller. The old bridge is'); assert.equal(h.calls.length, 0, 'a tiny greeting waits for enough spoken context');
  h.speech.update('Hello there, traveller. The old bridge is over there.', true);
  await pause(); await pause();
  assert.equal(h.calls.length, 1); assert.equal(h.speech.pending, false);
  assert.match(h.calls[0].body.voiceKey, /^irish:female:elder:/);
  assert.equal(h.calls[0].body.stream, true); assert.equal(h.calls[0].body.regionalOnly, true);
  const firstKey = h.calls[0].body.voiceKey;
  h.speech.cancel(); h.speech.deliveryFor = () => 'whispered confidentially';
  h.speech.update('A quiet word, if you have a moment.', true); await pause(); await pause();
  assert.equal(h.calls[1].body.voiceKey, firstKey);
  assert.equal(h.calls[1].body.style, 'whispered confidentially');
  assert.equal(h.errors.length, 0);
});

test('PCM split at arbitrary HTTP byte boundaries is reassembled before playback', async () => {
  const h = harness(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1])); controller.enqueue(new Uint8Array([2, 3]));
    controller.enqueue(new Uint8Array([4])); controller.close();
  } }), { headers }));
  h.speech.update('The mill is just beyond the bridge.', true); await pause(); await pause();
  assert.deepEqual(h.chunks.flat(), [1, 2, 3, 4]); assert.equal(h.errors.length, 0);
});

test('a resumed Live generation buffers unfinished words after an earlier complete speech segment', async () => {
  const h = harness();
  h.speech.update('The mill is just beyond the bridge.', true); await pause(); await pause();
  assert.equal(h.calls.length, 1);
  h.speech.update('The mill is just beyond the bridge. Please', false); await pause();
  assert.equal(h.calls.length, 1, 'a late continuation is not synthesized one word at a time');
  assert.equal(h.speech.pending, true);
  h.speech.update('The mill is just beyond the bridge. Please take care on the road.', true); await pause(); await pause();
  assert.equal(h.calls.length, 2); assert.equal(h.speech.pending, false);
});

test('a late response from cancelled speech never restarts its mouth or gesture clock', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.speech.update('I was about to tell you a story.', true);
  const signal = h.calls[0].signal; h.speech.cancel();
  assert.equal(signal.aborted, true);
  resolve(new Response(new Uint8Array([1, 0]), { headers })); await pause(); await pause();
  assert.equal(h.chunks.length, 0); assert.equal(h.drained.length, 0); assert.equal(h.errors.length, 0);
});

test('stock voices, truncated PCM and an unavailable regional cast never become an American fallback', async () => {
  for (const response of [new Response(new Uint8Array([0, 0]), { headers: { ...headers, 'x-wander-voice-source': 'preset' } }),
    new Response(new Uint8Array([1]), { headers }), new Response(null, { status: 503 })]) {
    const h = harness(() => response); h.speech.update('The road goes past the old mill.', true); await pause(); await pause();
    assert.equal(h.errors.length, 1); assert.equal(h.speech.pending, false);
    assert.equal(h.chunks.length, 0);
  }
});
