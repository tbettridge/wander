import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcLiveMicrophone } from '../src/npcliveaudio.mjs';

test('capture retains one permission grant across pauses, reports browser mute and cleans up on disable', async () => {
  const originalNode = globalThis.AudioWorkletNode;
  const frames = [], muted = [];
  let grants = 0;
  const track = { enabled: true, muted: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  const context = { state: 'running', destination: {}, sampleRate: 48000,
    resume: async () => { context.state = 'running'; context.onstatechange?.(); },
    close: async () => { context.closed = true; },
    audioWorklet: { addModule: async () => {} }, createMediaStreamSource: node,
    createGain: () => ({ ...node(), gain: {} }) };
  globalThis.AudioWorkletNode = class { constructor() { Object.assign(this, node(), { port: {} }); } };
  const mic = new NpcLiveMicrophone({ onFrame: frame => frames.push(frame),
    getUserMedia: async options => { grants++; assert.equal(options.video, false); return stream; },
    contextFactory: () => context });
  mic.onMuted = value => muted.push(value);
  try {
    assert.equal(await mic.start(), true);
    const emit = () => mic.node.port.onmessage({ data: { samples: new Float32Array(960).fill(.2), sampleRate: 48000 } });
    emit(); assert.equal(frames.length, 1); assert.equal(frames[0].pcm.length, 320);
    mic.setPaused(true); assert.equal(track.enabled, false);
    emit(); assert.equal(frames.length, 1);
    mic.setPaused(false); assert.equal(track.enabled, true);
    emit(); assert.equal(frames.length, 2); assert.equal(grants, 1);
    track.muted = true; track.onmute(); emit(); assert.equal(frames.length, 2);
    track.muted = false; track.onunmute(); emit(); assert.equal(frames.length, 3);
    context.state = 'suspended'; context.onstatechange(); emit(); assert.equal(frames.length, 3);
    mic.setPaused(true); mic.setPaused(false); emit(); assert.equal(frames.length, 4);
    assert.ok(muted.includes(true)); assert.equal(muted.at(-1), false);
    mic.stop(); assert.equal(track.stopped, true); assert.equal(context.closed, true);
    assert.equal(track.onmute, null); assert.equal(track.onended, null); assert.equal(context.onstatechange, null);
  } finally {
    mic.stop();
    if (originalNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = originalNode;
  }
});
