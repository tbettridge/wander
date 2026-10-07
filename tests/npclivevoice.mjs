import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcLiveVoiceController, liveConversationPrompt, appendLiveTranscript } from '../src/npclivevoice.mjs';
import { NpcLiveAudioPlayer, livePcmBase64 } from '../src/npcliveaudio.mjs';
import { nearestLiveNpc, LiveSpeechGate, livePcmFrame } from '../src/npcliveprotocol.mjs';

const pause = () => new Promise(resolve => setImmediate(resolve));
const actor = (id = 'npc:maren', x = 1) => ({ identity: { id, name: 'Maren', role: 'keeper', age: 'adult' }, avatar: { root: { visible: true, position: { x, y: 0, z: 0 } } } });
const context = npc => ({ npc: npc.identity, station: { name: 'Millbrook' }, targets: [{ id: 'mill', name: 'Harrow Mill', worldX: 20, worldZ: 5 }], player: { id: 'player:one' }, memory: { playerFacts: ['The traveller said their name is Ewan.'] } });
function harness({ fetchImpl, openEncounter, speechMode = 'native' } = {}) {
  let seconds = 0, micCallback;
  const sockets = [], opened = [], closed = [], gestures = [], interrupted = [], statuses = [], player = { x: 0, y: 0, z: 0 }, actors = [actor()];
  const audioContext = { currentTime: 0, state: 'running', destination: {}, sources: [], resume: async () => {}, close: async () => {},
    createBuffer: (channels, count) => ({ getChannelData: () => new Float32Array(count) }),
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start(at) { this.startedAt = at; }, stop() { this.stopped = true; } };
      this.sources.push(source); return source;
    },
  };
  const audio = new NpcLiveAudioPlayer({ contextFactory: () => audioContext });
  const voice = new NpcLiveVoiceController({ audio, speechMode, now: () => seconds, getActors: () => actors, getPlayer: () => player,
    microphoneFactory: callback => { micCallback = callback; return { start: async () => true, stop() {} }; },
    fetchImpl: fetchImpl || (async () => Response.json({ token: 'auth_tokens/test', setup: { model: 'models/gemini-3.8-live' } })),
    socketFactory: url => {
      assert.match(url, /BidiGenerateContentConstrained\?access_token=auth_tokens%2Ftest$/);
      const socket = { readyState: 1, sent: [], close() { this.closed = true; this.readyState = 3; this.onclose?.(); },
        send(raw) { const message = JSON.parse(raw); this.sent.push(message);
          if (message.setup) queueMicrotask(() => this.onmessage({ data: JSON.stringify({ setupComplete: {} }) })); },
      };
      sockets.push(socket); queueMicrotask(() => socket.onopen()); return socket;
    },
    openEncounter: openEncounter || (async (npc, id) => { opened.push(npc.identity.id); return { context: context(npc), id }; }),
    closeEncounter: (encounter, reason) => closed.push({ reason, transcript: structuredClone(encounter.transcript) }),
    onGesture: (encounter, cue) => gestures.push(cue.name), onInterrupt: id => interrupted.push(id), onStatus: status => statuses.push(status),
  });
  const frame = (rms, advance = 0.02) => { seconds += advance; micCallback({ rms, pcm: new Int16Array(320).fill(rms ? 4000 : 0) }); };
  const start = async () => { await voice.setEnabled(true); for (let i = 0; i < 6; i++) frame(.2); await pause(); await pause(); };
  const silence = () => { for (let i = 0; i < 65; i++) frame(0); };
  const pcm = livePcmBase64(new Int16Array(24000).fill(12000));
  const respond = text => voice.receive({ serverContent: { outputTranscription: { text }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] }, turnComplete: true } });
  const finish = () => { audioContext.currentTime = audio.nextTime; for (const source of [...audioContext.sources]) source.onended?.(); };
  return { voice, start, frame, silence, respond, finish, audioContext, sockets, opened, closed, gestures, interrupted, player, actors,
    time: value => { seconds = value; }, statuses };
}

test('nearest selection excludes other floors, hidden actors and busy NPCs and stays within close range', () => {
  const a = actor('npc:a', 2), b = actor('npc:b', 1), high = actor('npc:high', .1); high.avatar.root.position.y = 5;
  assert.equal(nearestLiveNpc([a, b, high], { x: 0, y: 0, z: 0 }), b);
  assert.equal(nearestLiveNpc([a, b], { x: 0, y: 0, z: 0 }, 3.5, npc => npc !== b), a);
  b.avatar.root.visible = false; assert.equal(nearestLiveNpc([b], { x: 0, y: 0, z: 0 }), null);
  assert.equal(nearestLiveNpc([a], { x: 10, y: 0, z: 0 }), null);
});

test('VAD waits for speech evidence, preserves pauses within a sentence, and PCM conversion bounds samples', () => {
  const gate = new LiveSpeechGate();
  assert.equal(gate.update(.003, 0), null); assert.equal(gate.update(.2, .02), null);
  gate.update(.2, .04); assert.equal(gate.update(.2, .06), 'start');
  assert.equal(gate.update(0, .5), null); assert.equal(gate.update(0, .7), null);
  assert.equal(gate.update(0, 1.08), 'end');
  assert.deepEqual([...livePcmFrame(new Float32Array([-2, 0, 2])).pcm], [-32768, 0, 32767]);
});

test('live prompt keeps memories and permanent regional voice while removing JSON and memory-synthesis protocols', () => {
  const prompt = liveConversationPrompt(context(actor()));
  assert.match(prompt, /Ewan/); assert.match(prompt, /regional accent/); assert.match(prompt, /queue_gesture/);
  assert.doesNotMatch(prompt, /Memory synthesis protocol:/);
  assert.doesNotMatch(prompt, /Every dialogue reply MUST contain/);
});

test('transcript fragments preserve names split inside a word and tolerate cumulative updates', () => {
  assert.equal(appendLiveTranscript('My name is Ew', 'an.'), 'My name is Ewan.');
  assert.equal(appendLiveTranscript('Hello', ', Ewan.'), 'Hello, Ewan.');
  assert.equal(appendLiveTranscript('My name', 'My name is Ewan.'), 'My name is Ewan.');
});

test('speech engages only the closest NPC and releases it immediately when walking away', async () => {
  const h = harness(); h.actors.push(actor('npc:near', .5)); await h.start();
  assert.deepEqual(h.opened, ['npc:near']);
  assert.ok(h.sockets[0].sent.some(message => message.realtimeInput?.audio), 'opening speech is buffered through connection startup');
  h.actors[0].avatar.root.position.x = .1; h.voice.tick();
  assert.equal(h.voice.encounter.actor.identity.id, 'npc:near', 'the conversation does not switch mid-sentence');
  h.player.x = 7; h.voice.tick();
  assert.equal(h.voice.encounter, null); assert.equal(h.closed[0].reason, 'walk-away');
  await h.voice.setEnabled(false);
});

test('an utterance ending during provisioning replays its audio and flushes the native VAD stream exactly once', async () => {
  let resolve;
  const h = harness({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  await h.start(); h.silence();
  resolve(Response.json({ token: 'auth_tokens/test', setup: {} })); await pause(); await pause();
  const messages = h.sockets[0].sent;
  assert.equal(messages.filter(message => message.realtimeInput?.activityStart).length, 0);
  assert.equal(messages.filter(message => message.realtimeInput?.audioStreamEnd).length, 1);
  await h.voice.setEnabled(false);
});

test('manual VAD sends a complete buffered utterance between exactly one start and end marker', async () => {
  let resolve;
  const h = harness({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  await h.start(); h.silence();
  resolve(Response.json({ token: 'auth_tokens/test', setup: { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } }));
  await pause(); await pause();
  const input = h.sockets[0].sent.filter(message => message.realtimeInput).map(message => message.realtimeInput);
  assert.deepEqual(input[0], { activityStart: {} });
  assert.deepEqual(input.at(-1), { activityEnd: {} });
  assert.equal(input.filter(message => message.activityStart).length, 1);
  assert.equal(input.filter(message => message.activityEnd).length, 1);
  assert.ok(input.slice(1, -1).every(message => message.audio?.mimeType === 'audio/pcm;rate=16000'));
  for (let i = 0; i < 100; i++) h.frame(0);
  assert.equal(h.sockets[0].sent.filter(message => message.realtimeInput?.activityEnd).length, 1);
  await h.voice.setEnabled(false);
});

test('ten quiet seconds prompts a brief hidden farewell and holds the NPC until it is heard', async () => {
  const h = harness(); await h.start(); h.silence();
  h.voice.receive({ serverContent: { inputTranscription: { text: 'Hello.' }, turnComplete: true } });
  h.respond('Hello, traveller.'); h.finish();
  const idleAt = h.voice.encounter.quietSince;
  h.time(idleAt + 9.99); h.voice.tick(); assert.equal(h.voice.encounter.closing, undefined);
  h.time(idleAt + 10); h.voice.tick(); assert.equal(h.voice.encounter.closing, true);
  assert.match(h.sockets[0].sent.at(-1).clientContent.turns[0].parts[0].text, /GAME FAREWELL/);
  assert.equal(h.closed.length, 0);
  h.respond("All right then, I'd best be on my way."); h.finish();
  assert.equal(h.closed[0].reason, 'silence');
  assert.ok(h.closed[0].transcript.every(message => !message.content.includes('GAME FAREWELL')));
  await h.voice.setEnabled(false);
});

test('a function-only turn cannot commit an unfinished spoken response when playback briefly runs dry', async () => {
  const h = harness(); await h.start(); h.silence();
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'intro', name: 'queue_gesture', args: { name: 'wave', phrase: 'Hello, Ewan.' } }] } });
  h.voice.receive({ serverContent: { generationComplete: true, turnComplete: true } });
  const pcm = livePcmBase64(new Int16Array(24000).fill(12000));
  h.voice.receive({ serverContent: { outputTranscription: { text: 'Hello, Ewan.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] } } });
  h.finish();
  assert.equal(h.voice.encounter.transcript.length, 0, 'speech still generating is not a completed memory turn');
  h.voice.receive({ serverContent: { generationComplete: true } });
  assert.equal(h.voice.encounter.transcript.length, 1);
  h.voice.receive({ serverContent: { turnComplete: true } });
  assert.equal(h.voice.encounter.transcript.length, 1, 'the completion acknowledgement is idempotent');
  await h.voice.setEnabled(false);
});

test('unavailable browser audio resets the mode without an unhandled startup failure', async () => {
  const h = harness(); h.voice.audio.contextFactory = () => { throw new Error('No audio'); };
  assert.equal(await h.voice.setEnabled(true), false);
  assert.equal(h.voice.enabled, false); assert.equal(h.voice.ready, false);
  assert.match(h.statuses.at(-1), /unavailable/);
});

test('interruptions cancel queued audio and gestures and exclude unheard NPC speech from memory', async () => {
  const h = harness(); await h.start(); h.silence();
  h.voice.receive({ serverContent: { inputTranscription: { text: 'My name is Ewan.' } } });
  h.respond('I have a secret that you have not heard yet.');
  h.audioContext.currentTime = .15; h.voice.tick(); assert.ok(h.voice.performanceFor('npc:maren').mouthOpen > .5);
  h.frame(.2); h.frame(.2); h.frame(.2);
  assert.equal(h.voice.performanceFor('npc:maren').mouthOpen, 0);
  assert.equal(h.voice.performanceFor('npc:maren').gestureName, null);
  assert.ok(h.audioContext.sources[0].stopped);
  h.voice.end('walk-away');
  assert.deepEqual(h.closed[0].transcript.map(message => message.content), ['My name is Ewan.']);
  await h.voice.setEnabled(false);
});

test('gestures follow the playback clock, enforce two cues, and points use known coordinates only', async () => {
  const h = harness(); await h.start(); h.silence();
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'cue1', name: 'queue_gesture', args: { name: 'point', phrase: 'Harrow Mill', placeId: 'mill' } }] } });
  h.voice.receive({ serverContent: { turnComplete: true } });
  assert.equal(h.voice.encounter.cueCount, 1, 'a tool-only server turn must retain its gesture until audible speech');
  h.respond('Harrow Mill is that way.'); assert.equal(h.gestures.length, 0);
  h.audioContext.currentTime = .15; h.voice.tick(); assert.deepEqual(h.gestures, ['point']);
  h.voice.receive({ toolCall: { functionCalls: [
    { id: 'bad', name: 'queue_gesture', args: { name: 'point', phrase: 'Unknown', placeId: 'invented' } },
    { id: 'cue2', name: 'queue_gesture', args: { name: 'nod', phrase: 'Harrow Mill' } },
    { id: 'cue3', name: 'queue_gesture', args: { name: 'wave', phrase: 'Harrow Mill' } },
  ] } });
  h.voice.tick(); assert.deepEqual(h.gestures, ['point', 'nod']);
  await h.voice.setEnabled(false);
});

test('switching modes during token provisioning releases the NPC and ignores a late credential', async () => {
  let resolve;
  const h = harness({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  await h.start(); await h.voice.setEnabled(false);
  resolve(Response.json({ token: 'auth_tokens/test', setup: {} })); await pause();
  assert.equal(h.sockets.length, 0); assert.equal(h.closed.length, 1); assert.equal(h.voice.encounter, null);
});

test('provider cancellation stops an active point without cutting off speech that was not interrupted', async () => {
  const h = harness(); await h.start(); h.silence();
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'point', name: 'queue_gesture', args: { name: 'point', phrase: 'East.', placeId: 'mill' } }] } });
  h.respond('East.'); h.audioContext.currentTime = .15; h.voice.tick();
  assert.equal(h.voice.performanceFor('npc:maren').gestureName, 'point');
  h.voice.receive({ toolCallCancellation: { ids: ['point'] } });
  assert.equal(h.voice.performanceFor('npc:maren').gestureName, null);
  assert.equal(h.interrupted.at(-1), 'npc:maren', 'the world-space pointing pose is released');
  assert.ok(h.voice.performanceFor('npc:maren').mouthOpen > .5, 'the continuing speech stays audible');
  await h.voice.setEnabled(false);
});

test('regional Live waits for actual cast playback, times its point there, and pins voice identity across replies', async () => {
  const calls = []; let completeSpeech;
  const h = harness({ speechMode: 'regional', fetchImpl: async (url, options) => {
    if (url.endsWith('/live-token')) return Response.json({ token: 'auth_tokens/test', setup: {} });
    calls.push(JSON.parse(options.body));
    return new Promise(resolve => { completeSpeech = resolve; });
  } });
  h.actors[0].identity.voiceBackground = { accentId: 'irish' };
  await h.start(); h.silence();
  h.voice.receive({ serverContent: { inputTranscription: { text: 'My name is Ewan.' } } });
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'mill', name: 'queue_gesture', args: { name: 'point', phrase: 'The mill is east', placeId: 'mill', delivery: 'reassuring' } }] } });
  h.respond('The mill is east, just past the old bridge.');
  assert.equal(h.audioContext.sources.length, 0, 'American stock Live audio is never played');
  assert.equal(h.voice.regionalSpeech.pending, true); assert.equal(h.voice.encounter.transcript.length, 0);
  h.time(20); h.voice.tick(); assert.equal(h.voice.encounter.closing, undefined, 'voice synthesis is not mistaken for player silence');
  const castKey = calls[0].voiceKey;
  assert.match(castKey, /^irish:/); assert.equal(calls[0].style, 'calm and reassuring');
  completeSpeech(new Response(new Uint8Array(new Int16Array(24000).fill(12000).buffer), {
    headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' },
  })); await pause(); await pause();
  h.audioContext.currentTime = .15; h.voice.tick(); assert.deepEqual(h.gestures, ['point']);
  assert.ok(h.voice.performanceFor('npc:maren').mouthOpen > .5);
  h.finish(); assert.equal(h.voice.encounter.transcript.at(-1).content, 'The mill is east, just past the old bridge.');
  h.actors[0].identity.voiceBackground = { accentId: 'yorkshire' };
  h.frame(.2); h.frame(.2); h.frame(.2); h.silence();
  h.respond('It is a pleasant morning for walking there.');
  assert.equal(calls[1].voiceKey, castKey, 'a reply cannot switch the character accent');
  await h.voice.setEnabled(false);
  completeSpeech(new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' } }));
  await pause(); assert.equal(h.voice.encounter, null);
});

test('barge-in cancels an active regional stream and excludes the unplayed reply from recall', async () => {
  let writer, speechSignal;
  const h = harness({ speechMode: 'regional', fetchImpl: async (url, options) => {
    if (url.endsWith('/live-token')) return Response.json({ token: 'auth_tokens/test', setup: {} });
    speechSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) { writer = controller; controller.enqueue(new Uint8Array(new Int16Array(24000).fill(12000).buffer)); } }),
      { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'regional-library' } });
  } });
  await h.start(); h.silence();
  h.voice.receive({ serverContent: { inputTranscription: { text: 'My name is Ewan.' } } });
  h.respond('There is a story I have not finished telling you.'); await pause(); await pause();
  h.audioContext.currentTime = .15; h.voice.tick();
  assert.ok(h.voice.performanceFor('npc:maren').mouthOpen > .5);
  h.frame(.2); h.frame(.2); h.frame(.2);
  assert.equal(speechSignal.aborted, true); assert.equal(h.voice.regionalSpeech.pending, false);
  const reminder = h.sockets[0].sent.find(message => message.clientContent?.turns[0]?.parts[0]?.text?.includes('GAME INTERRUPTED'));
  assert.equal(reminder.clientContent.turnComplete, false, 'interrupted playback is reconciled with Live before the new audio activity');
  assert.equal(h.voice.performanceFor('npc:maren').mouthOpen, 0);
  assert.equal(h.voice.performanceFor('npc:maren').gestureName, null);
  await h.voice.setEnabled(false);
  assert.ok(h.closed[0].transcript.some(message => message.content.includes('Ewan')));
  assert.ok(h.closed[0].transcript.every(message => !message.content.includes('story')));
  assert.ok(h.closed[0].transcript.every(message => !message.content.includes('GAME INTERRUPTED')));
  writer.close(); await pause();
});

test('a function-only Live continuation resumes on model idle even while its earlier TTS is playing', async () => {
  let writer;
  const h = harness({ speechMode: 'regional', fetchImpl: async url => {
    if (url.endsWith('/live-token')) return Response.json({ token: 'auth_tokens/test', setup: {} });
    return new Response(new ReadableStream({ start(controller) { writer = controller; controller.enqueue(new Uint8Array(new Int16Array(24000).fill(12000).buffer)); } }),
      { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' } });
  } });
  await h.start(); h.silence();
  h.respond('The mill is just beyond the bridge.'); await pause(); await pause();
  assert.equal(h.voice.audio.busy, true);
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'continue', name: 'queue_gesture', args: { name: 'nod', phrase: 'Take care.' } }] } });
  assert.equal(h.sockets[0].sent.at(-1).toolResponse.functionResponses[0].scheduling, 'WHEN_IDLE', 'the model may resume without waiting for an unrelated playback clock');
  await h.voice.setEnabled(false); writer.close(); await pause();
});

test('complete dialogue from a gesture tool is spoken once even when native audio transcription is missing or different', async () => {
  const calls = [];
  const h = harness({ speechMode: 'regional', fetchImpl: async (url, options) => {
    if (url.endsWith('/live-token')) return Response.json({ token: 'auth_tokens/test', setup: {} });
    calls.push(JSON.parse(options.body));
    return new Response(new Uint8Array(new Int16Array(24000).fill(12000).buffer), { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' } });
  } });
  await h.start(); h.silence();
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'spoken', name: 'queue_gesture', args: { name: 'nod', phrase: 'The mill is east.', reply: 'The mill is east. Take care on the road.' } }] } });
  h.voice.receive({ serverContent: { generationComplete: true, turnComplete: true } });
  await pause(); await pause();
  h.voice.receive({ serverContent: { outputTranscription: { text: 'This different stock voice text must not be played.' } } });
  h.voice.receive({ toolCall: { functionCalls: [{ id: 'second', name: 'queue_gesture', args: { name: 'wave', phrase: 'Take care', reply: 'The mill is east. Take care on the road.' } }] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'The mill is east. Take care on the road.');
  assert.equal(h.sockets[0].sent.at(-1).toolResponse.functionResponses[0].scheduling, 'SILENT');
  h.finish(); assert.equal(h.voice.encounter.transcript.at(-1).content, 'The mill is east. Take care on the road.');
  h.voice.receive({ serverContent: { outputTranscription: { text: 'Late native audio acknowledgement.' }, turnComplete: true } });
  assert.equal(calls.length, 1, 'a late native acknowledgement after playback cannot become a second reply');
  await h.voice.setEnabled(false);
});
