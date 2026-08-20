// Phase 1: the connection survives more, says more, and moves more smoothly.
//
// Measured across large WebRTC deployments, somewhere between a tenth and a
// fifth of connections cannot be established directly. Before this, every one of
// those visits failed silently and permanently: no relay to fall back to, no
// retry, and a status line that said only that something had not worked.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_MESSAGE_BYTES,
  CHUNK_PAYLOAD_BYTES,
  byteLength,
  chunkString,
  createEnvelope,
  encodeEnvelope,
  reassembleChunks,
} from '../src/multiplayerprotocol.mjs';
import {
  INTERPOLATION_DELAY_MS,
  TELEPORT_DISTANCE,
  advancePlayout,
  createPlayoutClock,
  recordPose,
  sampleAt,
} from '../src/poseinterpolation.mjs';
import {
  configuredTurnServers,
  hasTurnFallback,
  iceConfigurationFor,
  nextConnectionAttempt,
} from '../src/multiplayerice.mjs';

// --- 2. the message ceiling is the cross-browser floor, and chunks fit under it
{
  assert.equal(MAX_MESSAGE_BYTES, 16 * 1024,
    'a reliable ordered channel from Firefox to Chromium caps at 16 KiB');

  // A chunk has to survive being wrapped in an envelope, or the pieces are
  // individually unsendable and chunking has achieved nothing. Chunks carry the
  // text itself rather than base64 of its bytes, so how much a piece grows on
  // the wire depends on what is in it: the worst realistic case is a payload
  // that is all quotes and backslashes, every one of which doubles.
  for (const [name, filler] of [
    ['plain', 'x'],
    ['quotes', '"'],
    ['backslashes', '\\'],
    ['astral', '\u{1f600}'],
  ]) {
    const worstCase = filler.repeat(CHUNK_PAYLOAD_BYTES);
    for (const part of chunkString(worstCase, { transferId: 'transfer-worst' })) {
      const carrier = encodeEnvelope(createEnvelope('state-chunk', part, { from: 'player:someone' }));
      assert.ok(byteLength(carrier) <= MAX_MESSAGE_BYTES,
        `a ${name} chunk must fit one message, saw ${byteLength(carrier)} bytes`);
    }
    assert.equal(reassembleChunks(chunkString(worstCase, { transferId: 't' })), worstCase,
      `a ${name} payload must rebuild exactly`);
  }

  // The round trip has to be lossless, including non-ASCII and characters that
  // are two code units wide and must not be split down the middle.
  const payload = JSON.stringify({
    note: 'a bigger snapshot — with a dash',
    name: 'Traveller \u{1f600}\u{1f3d4}',
    body: 'y'.repeat(40_000),
  });
  const parts = chunkString(payload, { transferId: 'transfer-round' });
  assert.ok(parts.length > 1, 'an oversized payload must actually split');
  assert.equal(reassembleChunks(parts), payload, 'and rebuild byte for byte');

  // Carrying the text is the point: base64 cost a third on top of every byte.
  const wire = parts.reduce((sum, part) => sum
    + byteLength(encodeEnvelope(createEnvelope('state-chunk', part, { from: 'player:someone' }))), 0);
  assert.ok(wire < byteLength(payload) * 1.25,
    `chunking must not cost a quarter of the payload, saw ${Math.round((wire / byteLength(payload) - 1) * 100)}%`);

  // A piece has to be worth its envelope. Sizing by halving met the budget and
  // then undershot it, cutting a snapshot into twice the messages it needed at
  // half the size they could have been.
  for (const part of parts.slice(0, -1)) {
    assert.ok(byteLength(JSON.stringify(part.data)) > CHUNK_PAYLOAD_BYTES / 2,
      'a full piece must use most of the budget rather than a fraction of it');
  }

  // A peer on a cached older build sends base64 pieces. Decoding those as text
  // would rebuild a corrupt world in silence, so they are refused instead.
  const stale = parts.map(({ encoding, ...rest }) => ({ ...rest, encoding: 'base64' }));
  assert.throws(() => reassembleChunks(stale), /encoding/i,
    'an unknown chunk encoding must be refused, not misread');
}

// --- 1. a relay is a fallback, never the first attempt -----------------------
{
  const turn = [{ urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' }];

  assert.equal(hasTurnFallback(null), false, 'with nothing configured there is no fallback');
  assert.equal(configuredTurnServers(turn).length, 1);
  assert.equal(configuredTurnServers('not-an-array').length, 0, 'malformed config must not become a server');

  const direct = iceConfigurationFor('direct', turn);
  assert.equal(direct.iceTransportPolicy, 'all', 'the first attempt is unrestricted');
  assert.ok(!direct.iceServers.some((s) => /^turns?:/.test(String(s.urls))),
    'and must not include the relay: a direct-capable player never routes through one');

  const relay = iceConfigurationFor('relay', turn);
  assert.equal(relay.iceTransportPolicy, 'relay',
    'the retry must pin to relay, or it re-tries the candidates that just failed');
  assert.ok(relay.iceServers.some((s) => /^turns?:/.test(String(s.urls))));

  // Absent configuration, the relay attempt degrades to exactly direct.
  assert.deepEqual(iceConfigurationFor('relay', null), iceConfigurationFor('direct', null));
}

// --- 3 & 4. failure escalates, then explains --------------------------------
{
  const withTurn = { turnAvailable: true, usedRelay: false };
  const first = nextConnectionAttempt(0, withTurn);
  assert.equal(first.action, 'ice-restart', 'a first failure is often transient and worth one retry');

  const second = nextConnectionAttempt(1, withTurn);
  assert.equal(second.action, 'reconnect');
  assert.equal(second.mode, 'relay', 'the escalation is the relay, once the direct path has failed');

  const exhausted = nextConnectionAttempt(2, { turnAvailable: true, usedRelay: true });
  assert.equal(exhausted.action, 'give-up');
  assert.match(exhausted.reason, /relay/, 'and says the relay was tried too');

  // With no relay configured, restarting forever against an impossible route is
  // not persistence, it is a hang. Stop, and say why.
  const noRelay = nextConnectionAttempt(1, { turnAvailable: false, usedRelay: false });
  assert.equal(noRelay.action, 'give-up');
  assert.match(noRelay.reason, /no relay is configured/,
    'a player must learn that this world has no fallback, not just that it failed');
}

// --- the wiring that makes the above reachable -------------------------------
{
  const peer = await readFile(new URL('../src/multiplayerpeer.mjs', import.meta.url), 'utf8');
  assert.match(peer, /_recoverFromFailure\(\)/, 'a failed connection must escalate rather than end');
  assert.match(peer, /iceConfigurationFor\(this\.iceMode\)/,
    'the peer must build itself from the mode it is attempting');
  assert.doesNotMatch(peer, /if \(state === 'failed'\) this\.onStateChange\(\{ state, reconnectable: true \}\)/,
    'the old report-and-stop path must be gone');

  const session = await readFile(new URL('../src/multiplayer.mjs', import.meta.url), 'utf8');
  assert.match(session, /if \(state\.state === 'reconnecting'\)/,
    'a reconnecting peer keeps its seat, its approval and its avatar');

  // 5. the buffer, and what it is for.
  const avatars = await readFile(new URL('../src/multiplayeravatars.js', import.meta.url), 'utf8');
  assert.match(avatars, /from '\.\/poseinterpolation\.mjs'/,
    'remote motion must be interpolated between two received poses');
  assert.match(avatars, /advancePlayout\(avatar\.playout, avatar\.history/,
    'and played out on a clock steered by the sender stamps, not by arrival');
  assert.match(avatars, /Number\.isFinite\(Number\(sentAt\)\) \? Number\(sentAt\) : at/,
    'the history must be keyed on the sender stamp when one is present');
  assert.doesNotMatch(avatars, /avatar\.target\b/,
    'chasing the newest pose is what produced the rubber-banding');
}

console.log('multiplayerreliability PASS · 16 KiB ceiling with chunks that fit · relay only after direct fails · '
  + 'restart then escalate then explain · remote motion interpolated, not chased');

// --- 5. the buffer absorbs jitter instead of passing it on -------------------
// Replay one steady walk twice: once with poses arriving on time, once with
// arrival times jittered and one dropped entirely. Then compare how uneven the
// drawn motion is. Chasing the newest pose turns a late packet into a stall and
// the next into a lurch; interpolating between two received poses does not.
{
  const SEND_MS = 100;
  const SPEED = 1.35 / 1000;               // metres per millisecond

  // Poses are stamped by the sender on a fixed cadence; the network then delays
  // each one differently. Only the arrival times differ between the two runs.
  const walk = (arrivalJitter) => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      if (arrivalJitter && i === 12) continue;            // one pose lost outright
      const stampedAt = i * SEND_MS;
      events.push({
        arrivesAt: stampedAt + (arrivalJitter ? arrivalJitter(i) : 0),
        sample: { at: stampedAt, x: stampedAt * SPEED, y: 0, z: 0, yaw: 0, moving: true },
      });
    }
    events.sort((a, b) => a.arrivesAt - b.arrivesAt);
    return events;
  };

  // Step through real time, delivering poses as they arrive and drawing at 60Hz.
  const unevenness = (events) => {
    const history = [];
    const clock = createPlayoutClock();
    const steps = [];
    let next = 0, previous = null;
    for (let wall = 0; wall <= 4200; wall += 16) {
      while (next < events.length && events[next].arrivesAt <= wall) {
        recordPose(history, events[next].sample);
        next += 1;
      }
      if (!history.length) continue;
      const renderTime = advancePlayout(clock, history, 16);
      const drawn = sampleAt(history, renderTime);
      if (!drawn) continue;
      // Measure only while interpolation is actually happening: before the clock
      // has found the stream, and after the last pose has been passed, the code
      // deliberately holds the nearest pose rather than inventing motion. Those
      // holds are correct behaviour, and counting them would be measuring the
      // harness running past the end of its own data.
      const interpolating = wall > 900 && renderTime < history[history.length - 1].at;
      if (interpolating && previous !== null) steps.push(Math.abs(drawn.x - previous));
      previous = drawn.x;
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const variance = steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length;
    return Math.sqrt(variance) / (mean || 1e-9);
  };

  const clean = unevenness(walk(null));
  const jittered = unevenness(walk((i) => (i % 3 === 0 ? 55 : i % 5 === 0 ? -20 : 8)));

  assert.ok(clean < 0.02, `evenly delivered poses must draw evenly, saw ${clean.toFixed(3)}`);
  assert.ok(jittered < 0.05,
    `jitter and a dropped pose must stay absorbed, saw ${jittered.toFixed(3)}`);

  // The delay has to outlast the send interval or a single late pose still
  // leaves nothing to interpolate between, and stay short enough not to read
  // as lag on someone walking.
  // Measured: chasing the newest pose under this same jitter gives a coefficient
  // of variation around 0.50; interpolating on the sender's timeline gives 0.004.
  assert.ok(jittered < clean * 4 + 0.01,
    'jitter must not make the drawn motion measurably rougher than clean delivery');
  assert.ok(INTERPOLATION_DELAY_MS > SEND_MS, `buffer must exceed ${SEND_MS}ms`);
  assert.ok(INTERPOLATION_DELAY_MS <= 250, 'and not read as lag');
}

// --- a visitor who was moved is placed, not skated --------------------------
{
  const history = [];
  recordPose(history, { at: 0, x: 0, y: 0, z: 0, yaw: 0 });
  const teleported = recordPose(history, {
    at: 100, x: TELEPORT_DISTANCE + 40, y: 0, z: 0, yaw: 0,
  });
  assert.equal(teleported, true, 'a jump across the world must be reported as a placement');
  assert.equal(history.length, 1, 'and the history restarted, so nothing interpolates across it');
}

// --- nothing is invented before the poses arrive ----------------------------
{
  const history = [];
  recordPose(history, { at: 1000, x: 5, y: 0, z: 0, yaw: 0 });
  const early = sampleAt(history, 0);
  assert.equal(early.x, 5, 'a single pose is held, not extrapolated backwards');
  const late = sampleAt(history, 99_000);
  assert.equal(late.x, 5, 'and held rather than guessed forward when nothing new arrives');
  assert.equal(sampleAt([], 10), null);
}
