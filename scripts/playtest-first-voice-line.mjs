#!/usr/bin/env node
// Browser proof for the first spoken line of a session. A fresh page's echo
// canceller has not yet learnt the room, so the speakers carry the NPC's own
// first line into the microphone. This page plays the resident's greeting
// through real Web Audio in headless Chromium, feeds the microphone a copy of
// what the speakers play (an untrained canceller), and reports how much of the
// greeting was heard. A second line, once the canceller has "learnt" the room,
// checks that the traveller can still talk over the resident.
//
//   npm run playbot:setup                      # once
//   node scripts/playtest-first-voice-line.mjs # or WANDER_ROOT=<checkout> to test another copy
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.WANDER_ROOT || here;
const vendor = join(here, '.playbot', 'node_modules');
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH
  || pathToFileURL(join(vendor, 'playwright-core', 'index.mjs')).href);
const launch = existsSync(join(vendor, '@sparticuz', 'chromium'))
  ? { executablePath: await (await import(pathToFileURL(createRequire(join(vendor, 'x.js')).resolve('@sparticuz/chromium')).href)).default.executablePath() }
  : { channel: 'chrome' };

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body><button id="walk">Begin walking</button></body>');
      return;
    }
    if (path.includes('..')) throw new Error('Invalid path');
    res.setHeader('content-type', /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(join(root, path)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

let browser;
try {
  browser = await chromium.launch({ headless: true, ...launch, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { NpcLiveVoiceController } = await import('/src/npclivevoice.mjs');
    const { NpcLiveAudioPlayer } = await import('/src/npcliveaudio.mjs');
    const proof = window.proof = { coupling: 0.6, sent: [], segmentSeconds: 2, synthesized: 0, statuses: [] };
    // Everything the speakers play also reaches an analyser: the "room".
    const connect = AudioNode.prototype.connect;
    AudioBufferSourceNode.prototype.connect = function (target, ...rest) {
      if (proof.room?.context === this.context && target === this.context.destination) connect.call(this, proof.room);
      return connect.call(this, target, ...rest);
    };
    const audio = new NpcLiveAudioPlayer({ contextFactory: () => {
      const context = new AudioContext({ sampleRate: 24000 });
      proof.room = context.createAnalyser(); proof.room.fftSize = 512;
      return context;
    } });
    const samples = new Float32Array(512);
    const microphoneFactory = onFrame => ({
      async start() {
        proof.timer = setInterval(() => {
          proof.room.getFloatTimeDomainData(samples);
          let sum = 0; for (const value of samples) sum += value * value;
          const voice = proof.travellerSpeaking ? 0.2 : 0;
          onFrame({ rms: Math.max(voice, Math.sqrt(sum / samples.length) * proof.coupling), pcm: new Int16Array(320) });
        }, 20);
        return true;
      },
      stop() { clearInterval(proof.timer); },
    });
    // A speech-like line: a voiced tone with four syllables a second.
    const line = seconds => {
      const pcm = new Int16Array(Math.round(24000 * seconds));
      for (let i = 0; i < pcm.length; i++) {
        const t = i / 24000, syllable = Math.max(0, Math.sin(Math.PI * 4 * t)) ** 0.5;
        pcm[i] = Math.round(9000 * syllable * Math.sin(2 * Math.PI * 180 * t));
      }
      return new Uint8Array(pcm.buffer);
    };
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/live-token')) return Response.json({ token: 'auth_tokens/proof', setup: {} });
      proof.synthesized += proof.segmentSeconds;
      const bytes = line(proof.segmentSeconds), parts = 4, size = Math.ceil(bytes.length / parts / 2) * 2;
      let sent = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        if (options.signal.aborted || sent >= bytes.length) { controller.close(); return; }
        await new Promise(resolve => setTimeout(resolve, 150));
        controller.enqueue(bytes.slice(sent, sent + size)); sent += size;
      } }), { headers: { 'content-type': 'audio/pcm', 'x-wander-voice-source': 'designed' } });
    };
    const socketFactory = () => {
      const socket = { readyState: 1, close() { this.readyState = 3; this.onclose?.(); },
        send(raw) { const message = JSON.parse(raw); proof.sent.push(message);
          if (message.setup) setTimeout(() => this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 30); } };
      setTimeout(() => socket.onopen(), 10); return socket;
    };
    const actor = { identity: { id: 'npc:ada', name: 'Ada', role: 'dispatcher', age: 'adult' },
      avatar: { root: { visible: true, position: { x: 1, y: 0, z: 0 } } } };
    proof.actor = actor;
    proof.voice = new NpcLiveVoiceController({ endpoint: '/api/ai', fetchImpl, socketFactory, audio, microphoneFactory,
      speechMode: 'regional', getActors: () => [actor], getPlayer: () => ({ x: 0, y: 0, z: 0 }),
      openEncounter: async npc => ({ context: { npc: npc.identity, station: { name: 'Millbrook' }, targets: [], player: { id: 'player' } } }),
      onStatus: status => proof.statuses.push(status) });
    proof.audio = audio;
    // Live voice starts with the click that begins walking, as in the game.
    document.querySelector('#walk').onclick = () => { proof.enabled = proof.voice.setEnabled(true); };
  });
  await page.click('#walk');
  await page.evaluate(() => proof.enabled);

  const speak = async (seconds, text, interrupt = false) => page.evaluate(async ({ seconds, text, interrupt }) => {
    proof.segmentSeconds = seconds;
    const before = proof.audio.heardSeconds, synthesized = proof.synthesized, interruptions = () => proof.sent
      .filter(message => message.clientContent?.turns[0]?.parts[0]?.text?.includes('GAME INTERRUPTED')).length;
    const already = interruptions();
    if (!proof.voice.encounter) await proof.voice.greet(proof.actor, text, { silenceSeconds: 25 });
    else proof.voice.say(text);
    if (interrupt) setTimeout(() => { proof.travellerSpeaking = true; }, 1500);
    const started = performance.now();
    while (performance.now() - started < (seconds + 3) * 1000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!proof.audio.busy && !proof.voice.regionalSpeech.pending && performance.now() - started > 800) break;
    }
    proof.travellerSpeaking = false;
    await new Promise(resolve => setTimeout(resolve, 500));
    return { line: Math.round((proof.synthesized - synthesized) * 100) / 100, heard: Math.round((proof.audio.heardSeconds - before) * 100) / 100,
      interrupted: interruptions() > already, context: proof.audio.context.state,
      inTranscript: !!proof.voice.encounter?.transcript.some(entry => entry.content === text) };
  }, { seconds, text, interrupt });

  // Ada's greeting, in two phrases of 2.5 seconds each.
  const first = await speak(2.5, 'There you are! Welcome to the post, courier. I am Ada.');
  // Afterwards the canceller has learnt the room: little of the speaker leaks through.
  await page.evaluate(() => { proof.coupling = 0.02; });
  const later = await speak(5, 'The board by the door has the day\'s letters on it, and the mill is past the bridge.', true);
  const report = { root, first, later, errors };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(first.context, 'running');
  assert.equal(first.interrupted, false, 'the greeting was cut off by its own echo');
  assert.ok(first.heard >= first.line - 0.05, `only ${first.heard} s of a ${first.line} s greeting was heard`);
  assert.equal(first.inTranscript, true);
  assert.equal(later.interrupted, true, 'the traveller could not talk over a later line');
  assert.ok(later.heard < 3, 'speaking over a later line stops it');
  assert.deepEqual(errors, []);
  console.log('First line plays in full; later lines can still be interrupted.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
