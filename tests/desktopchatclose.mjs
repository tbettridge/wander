import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const handler = main.slice(main.indexOf('function requestNpcChatClose()'), main.indexOf('\nfunction abandonNpcChat()'));

test('opening chat enables its Close button without waiting for the unlock event', () => {
  const begin = main.slice(main.indexOf('function beginNpcChat()'), main.indexOf('\nfunction handlePointerLockFailure('));
  const canvas = {}, state = {
    renderer: { domElement: canvas, xr: {} },
    document: { pointerLockElement: canvas, exitPointerLock() {} },
    controls: { suspendInput() {} }, overlay: { classList: { add() {} } },
    livingWorldPopulation: { setPointerReleased() { state.closeUsable = true; } },
  };
  vm.runInNewContext(`${begin}\nbeginNpcChat();`, state);
  assert.equal(state.closeUsable, true);
  assert.equal(state.npcPointerReleasePending, true);
});

function closeHarness(requestLock, { alreadyLocked = false, closeError = null, inputLocked = false } = {}) {
  const canvas = { requestPointerLock: requestLock, focus() { state.focused = true; } };
  const state = {
    desktopUiState: 'npc-dialogue',
    renderer: { domElement: canvas }, document: { pointerLockElement: alreadyLocked ? canvas : null },
    controls: { enabled: false, allowLook: false, inputLocked, suspendInput() { this.enabled = false; } },
    livingWorldPopulation: {
      dialogueOpen: true, closeCount: 0,
      completeDialogueClose() { this.dialogueOpen = false; this.closeCount++; if (closeError) throw closeError; },
    },
    overlay: { classList: { add() {} } },
    notePointerLockRequest() {}, recordPointerLockFailure() {},
    console: { warn() {} },
  };
  vm.runInNewContext(`${handler}\nrequestNpcChatClose();`, state);
  return state;
}

test('closing an already locked chat restores movement without waiting for a new browser event', () => {
  const state = closeHarness(() => Promise.resolve(), { alreadyLocked: true });
  assert.equal(state.livingWorldPopulation.dialogueOpen, false);
  assert.equal(state.controls.enabled, true);
  assert.equal(state.desktopUiState, 'playing');
  assert.equal(state.focused, true);
});

test('chat closes even when legacy pointer lock returns nothing and emits no event', () => {
  const state = closeHarness(() => undefined);
  assert.equal(state.livingWorldPopulation.closeCount, 1);
  assert.equal(state.controls.enabled, true);
});

test('rejected or missing pointer lock leaves keyboard movement available', async () => {
  for (const request of [undefined, () => { throw new Error('denied'); }, () => Promise.reject(new Error('denied'))]) {
    const state = closeHarness(request);
    await Promise.resolve();
    assert.equal(state.livingWorldPopulation.dialogueOpen, false);
    assert.equal(state.controls.enabled, true);
    assert.equal(state.desktopUiState, 'playing');
  }
});

test('a synchronous memory-close error cannot strand controls after the panel is hidden', () => {
  const state = closeHarness(() => undefined, { closeError: new Error('memory save failed') });
  assert.equal(state.livingWorldPopulation.dialogueOpen, false);
  assert.equal(state.controls.enabled, true);
  assert.equal(state.desktopUiState, 'playing');
});

test('closing chat preserves an independent terrain or travel safety lock', () => {
  const state = closeHarness(() => undefined, { inputLocked: true });
  assert.equal(state.controls.enabled, true);
  assert.equal(state.controls.inputLocked, true);
});

const pointerChange = main.slice(main.indexOf("document.addEventListener('pointerlockchange'"),
  main.indexOf("document.addEventListener('pointerlockerror'"));

function pointerChangeHarness({ locked = false, pendingRelease = false, uiState = 'playing' } = {}) {
  const canvas = {};
  const state = {
    desktopUiState: uiState, npcPointerReleasePending: pendingRelease, started: true,
    renderer: { domElement: canvas, xr: {} },
    document: { pointerLockElement: locked ? canvas : null,
      addEventListener(type, callback) { state.listener = callback; },
      exitPointerLock() { state.exits = (state.exits || 0) + 1; } },
    pointerLockDebug: {}, pointerLockNow: () => 0, console: { log() {} },
    controls: { enabled: uiState === 'playing', suspendInput() { this.enabled = false; } },
    overlay: { classList: { add() {}, remove() {} } }, startButton: { focus() {} },
    livingWorldSetting: { enabled: false }, livingWorldPopulation: { setPointerReleased() {} },
  };
  vm.runInNewContext(`${pointerChange}\nlistener();`, state);
  return state;
}

test('a delayed chat-opening unlock cannot pause an already closed chat', () => {
  const state = pointerChangeHarness({ pendingRelease: true });
  assert.equal(state.controls.enabled, true);
  assert.equal(state.desktopUiState, 'playing');
  assert.equal(state.npcPointerReleasePending, false);
});

test('a late pointer-lock grant cannot enable walking behind a new conversation', () => {
  const state = pointerChangeHarness({ locked: true, uiState: 'npc-dialogue' });
  assert.equal(state.controls.enabled, false);
  assert.equal(state.desktopUiState, 'npc-dialogue');
  assert.equal(state.exits, 1);
  assert.equal(state.npcPointerReleasePending, true);
});

test('a normal Escape unlock still pauses the world', () => {
  const state = pointerChangeHarness();
  assert.equal(state.controls.enabled, false);
  assert.equal(state.desktopUiState, 'paused');
});

test('abandoning chat releases the desktop UI even when memory bookkeeping throws', async () => {
  const source = await readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  abandonDialogue('), source.indexOf('\n  closeDialogue()'));
  const state = { console: { log() {} }, called: 0 };
  vm.runInNewContext(`const population = {dialogueOpen: true, ${method}};
    population.completeDialogueClose = () => { throw new Error('memory failed'); };
    population.onChatAbandon = () => { called++; };
    try { population.abandonDialogue(); } catch {}`, state);
  assert.equal(state.called, 1);
});
