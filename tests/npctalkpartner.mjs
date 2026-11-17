import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// The living-world population's per-frame update decides who T talks to. Its
// module needs the browser (three, avatars), so the two methods are lifted from
// the source and run against a small stand-in, as the speech-pointing tests do.
const source = await readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8');
const update = source.slice(source.indexOf('  update(dt, player, {'), source.indexOf('\n  /**\n   * Who T talks to'));
const partner = source.slice(source.indexOf('  updateTalkPartner('), source.indexOf('\n}\n\n// Keep the earlier exported name'));

function population({ stationActors = [], residents = [] } = {}) {
  const globals = {
    TALK_RANGE: 6.5,
    performance: { now: () => 0 },
    advanceLivingWorldClock() {}, beginGroundingFrame() {},
    pendingInteraction: () => null, resolveInteraction() {}, interactionLine: () => '',
    titleCase: (text) => text,
  };
  const p = vm.runInNewContext(`new (class {${update}\n${partner}})()`, globals);
  Object.assign(p, {
    actors: stationActors, pending: [], grounding: {}, stateSaveElapsed: 0, worldState: { clock: {}, metrics: {} },
    features: {}, debug: { enabled: true }, dialogueOpen: false, activeNpc: null, talkQueued: false, declineQueued: false,
    remoteDialoguePartners: new Set(), promptEl: { style: { display: 'none' }, innerHTML: '' },
    drainSpawnQueue() {}, readEncounterCount: () => 0, abandonDialogue() { this.dialogueOpen = false; },
    getExternalActors: () => residents,
    talk() { this.dialogueOpen = true; this.conversationNpcId = this.activeNpc.identity.id; },
  });
  return p;
}

const resident = (id, name, x, z) => ({
  identity: { id, name, role: 'innkeeper', interactive: true },
  avatar: { root: { visible: true, position: { x, y: 20, z } } },
});

test('village residents can be talked to while no station staff are built', () => {
  const ada = resident('station-settlement:0:household:0:resident:0', 'Ada Dale', 2, 0);
  const finn = resident('station-settlement:0:household:5:resident:1', 'Finn Fallow', 30, 0);
  const p = population({ residents: [ada, finn] });
  // Whoever was nearest a while ago is still remembered as the partner.
  p.activeNpc = finn;
  p.talkQueued = true;
  p.update(0.016, { x: 0, y: 20, z: 0 });
  assert.equal(p.activeNpc, ada, 'the nearest resident is offered, not the one remembered from before');
  assert.equal(p.promptEl.style.display, 'block');
  assert.match(p.promptEl.innerHTML, /talk to Ada Dale/);
  assert.equal(p.dialogueOpen, true, 'T opens a conversation');
  assert.equal(p.conversationNpcId, ada.identity.id);
});

test('with nobody in reach and no station staff, no prompt is shown and T does nothing', () => {
  const p = population({ residents: [resident('far', 'Far Away', 40, 0)] });
  p.talkQueued = true;
  p.update(0.016, { x: 0, y: 20, z: 0 });
  assert.equal(p.promptEl.style.display, 'none');
  assert.equal(p.dialogueOpen, false);
  assert.equal(p.talkQueued, false, 'a T pressed out of reach is not saved up for later');
});
