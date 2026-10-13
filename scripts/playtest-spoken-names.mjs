// Exercises actual voice/controller/lookup/TTS code with synthetic provider
// transcripts. It makes no paid requests and does not measure STT accuracy.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'wander-spoken-names-'));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('content-type', path === '/' ? 'text/html' : 'text/javascript');
    response.end(path === '/' ? '<!doctype html><body style="background:#203e32;color:#f5efdd;font:18px/1.5 system-ui;padding:24px"><h1>Spoken NPC names</h1><div id="results"></div></body>' : await readFile(join(root, path)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async () => {
    const { NpcLiveVoiceController } = await import('/src/npclivevoice.mjs');
    const { NpcLiveEncounterBridge } = await import('/src/npcliveencounter.mjs');
    const { liveTokenPayload } = await import('/services/ai-worker/src/live.js');
    const faye = { id: 'npc:faye', name: 'Faye Barton', role: 'baker' }, other = { id: 'npc:other', name: 'Faye Cole', role: 'innkeeper' };
    const actor = { identity: { id: 'npc:maren', name: 'Maren Reed', role: 'keeper' }, avatar: { root: { position: { x: 0, y: 0, z: 1 }, visible: true } } };
    const context = { npc: actor.identity, station: { name: 'Millbrook' }, player: { id: 'player:proof' },
      homeCommunity: { residents: [faye, other] }, targets: [{ id: 'mill', name: 'Harrow Mill', worldX: 30, worldZ: 0 }],
      personWhereabouts: [{ subjectId: faye.id, name: faye.name, known: true,
        line: 'Faye Barton should be at Harrow Mill today. You should check there.',
        place: { id: 'person-location:npc:faye', name: 'Harrow Mill', worldX: 30, worldZ: 0 } },
      { subjectId: other.id, name: other.name, known: false, line: 'I am not sure where Faye Cole is today.' }] };
    const queries = [], speech = [], captions = []; let seconds = 0, input, setup;
    const bridge = new NpcLiveEncounterBridge({ contextForActor: () => context,
      conversationBridge: { lookup: async ({ query }) => { queries.push(query); return { speakable: [], personWhereabouts: context.personWhereabouts }; } } });
    const voice = new NpcLiveVoiceController({ now: () => seconds, getActors: () => [actor], getPlayer: () => ({ x: 0, y: 0, z: 0 }),
      microphoneFactory: callback => { input = callback; return { start: async () => true, stop() {} }; },
      openEncounter: async () => ({ context, remoteConversationId: 'proof' }),
      lookupContext: (encounter, query) => bridge.lookup(encounter, query),
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith('/live-token')) { setup = liveTokenPayload(body).bidiGenerateContentSetup; return Response.json({ token: 'auth_tokens/proof', setup }); }
        speech.push(body.input);
        return new Response(new Uint8Array(new Int16Array(1200).buffer), { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' } });
      },
      socketFactory: () => {
        const socket = { readyState: 1, send: raw => {
          if (JSON.parse(raw).setup) queueMicrotask(() => socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) }));
        }, close() { this.readyState = 3; } };
        queueMicrotask(() => socket.onopen()); return socket;
      },
      onTranscript: turn => captions.push({ role: turn.role, text: turn.text }),
    });
    const frame = rms => { seconds += .02; input({ rms, pcm: new Int16Array(320) }); };
    const wait = async condition => {
      for (let i = 0; i < 300; i++) { if (condition()) return; voice.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('Voice proof timed out');
    };
    await voice.setEnabled(true);
    for (let i = 0; i < 6; i++) frame(.2);
    await wait(() => voice.encounter?.connected);
    for (let i = 0; i < 65; i++) frame(0);
    const checks = [];
    for (const [index, [utterance, pattern, expectedId]] of [
      ['Where is Fay Barton?', 'should be at Harrow Mill', faye.id],
      ['Where is Fay?', 'Do you mean', null],
      ['The baker', 'should be at Harrow Mill', faye.id],
      ['Where is she today?', 'should be at Harrow Mill', faye.id],
      ['Where is Fay Bartun?', 'Do you mean', null],
      ['Yes', 'should be at Harrow Mill', faye.id],
      ['Where is Faye Cole?', 'not sure where Faye Cole', other.id],
      ['Where is Faye Andersen?', 'could not place that name', null],
    ].entries()) {
      if (index) { for (let i = 0; i < 6; i++) frame(.2); for (let i = 0; i < 65; i++) frame(0); }
      const count = voice.encounter.transcript.length, start = speech.length;
      voice.receive({ serverContent: { inputTranscription: { text: utterance, finished: true } } });
      await voice._handleTool({ id: `lookup:${index}`, name: 'lookup_world_context', args: { query: 'Where is Faye Cole?' } }, voice.encounter);
      const resolution = voice.encounter.referenceResolution;
      if (expectedId && resolution.personId !== expectedId) throw new Error('Wrong resolved person: ' + utterance);
      await voice._handleTool({ id: `reply:${index}`, name: 'queue_gesture', args: {
        name: 'point', placeId: 'mill', phrase: 'At the mill.', reply: 'Faye Cole is definitely at the mill.' } }, voice.encounter);
      voice.receive({ serverContent: { turnComplete: true } });
      await wait(() => voice.encounter.transcript.length >= count + 2);
      const spoken = speech.slice(start).join(' ');
      if (!spoken.includes(pattern)) throw new Error('Wrong spoken answer for ' + utterance + ': ' + spoken);
      if (voice.encounter.transcript[count].content !== utterance) throw new Error('Raw transcript was rewritten');
      checks.push({ utterance, spoken, status: resolution.status, personId: resolution.personId || null });
      const row = document.createElement('p'); row.textContent = `You: ${utterance}\nNPC: ${spoken}`; row.style.whiteSpace = 'pre-line'; document.querySelector('#results').append(row);
    }
    const vocabulary = setup.inputAudioTranscription.customVocabulary;
    if (!vocabulary.includes(faye.name) || !vocabulary.includes(other.name)) throw new Error('Missing proper-name hints');
    await voice.setEnabled(false);
    return { checks, queries, vocabulary, captionEvents: captions.length };
  });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'spoken-names.png'), fullPage: true });
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ ...report, browserErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, browserErrors: errors, artifacts }));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
