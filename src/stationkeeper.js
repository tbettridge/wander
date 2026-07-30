import { fallbackDialogue } from './livingworld.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { createStationPopulation, sampleNpcMotion } from './npcpopulation.mjs';
import { STATION_LAYOUT } from './railstation.mjs';

const TALK_RANGE = 6.5;
const PREFETCH_RANGE = 55;
const VISIBLE_RANGE = 245;
const XR_VISIBLE_RANGE = 115;
const FULL_ANIMATION_RANGE = 92;
const STATION_CULL_MARGIN = 38;
const XR_RESIDENT_LIMIT = 3;

function makePanel(styles) {
  const element = document.createElement('div');
  Object.assign(element.style, {
    position: 'fixed',
    zIndex: '7',
    color: 'rgba(239,245,241,.95)',
    font: '13px/1.6 "Helvetica Neue", Arial, sans-serif',
    textShadow: '0 1px 3px rgba(0,0,0,.9)',
    pointerEvents: 'none',
    userSelect: 'none',
    display: 'none',
  }, styles);
  document.body.appendChild(element);
  return element;
}

function dampAngle(current, target, lambda, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * Math.min(dt, 0.1)));
}

function titleCase(value = '') {
  return value.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function isInteractiveTarget(target) {
  const tagName = target?.tagName?.toLocaleLowerCase();
  return target?.isContentEditable
    || tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || tagName === 'button';
}

function dialogueSourceLabel(source = '') {
  return source.startsWith('edge')
    ? 'On-device model'
    : 'Authored fallback';
}

export class LivingWorldPopulation {
  constructor(scene, controls, director, {
    getContext,
    worldSeed = 1,
    residentsPerStation = 6,
    onChatOpen = () => {},
    onChatCloseRequest = null,
    onChatAbandon = () => {},
  } = {}) {
    this.scene = scene;
    this.controls = controls;
    this.director = director;
    this.getContext = getContext;
    this.worldSeed = worldSeed;
    this.residentsPerStation = residentsPerStation;
    this.onChatOpen = onChatOpen;
    this.onChatCloseRequest = onChatCloseRequest;
    this.onChatAbandon = onChatAbandon;
    this.assets = new NpcAssetLibrary();
    this.plan = null;
    this.actors = [];
    this.activeNpc = null;
    this.station = null;
    this.encounterCount = 0;
    this.talkQueued = false;
    this.prefetchedKey = '';
    this.prefetchRequest = null;
    this.dialogueOpen = false;
    this.requestToken = 0;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.chatHistories = new Map();
    this.chatHistory = null;
    this.conversationNpcId = '';

    this.debug = {
      enabled: true,
      residentsPerStation,
      status: 'waiting for railway plan',
      talkToNearest: () => {
        if (!this.activeNpc) {
          this.debug.status = 'no resident is loaded nearby';
          return;
        }
        const residentPosition = this.activeNpc.avatar.root.position;
        this.controls.placeAt(residentPosition.x, residentPosition.y, residentPosition.z + 2.5);
        this.talk();
      },
    };

    this.promptEl = makePanel({
      left: '50%',
      bottom: '23%',
      transform: 'translateX(-50%)',
      padding: '7px 15px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.18)',
      background: 'rgba(8,15,16,.62)',
      letterSpacing: '.5px',
    });
    this.dialogueEl = makePanel({
      left: '50%',
      bottom: '5%',
      width: 'min(680px, calc(100% - 28px))',
      maxHeight: 'min(660px, 82vh)',
      transform: 'translateX(-50%)',
      padding: '0',
      borderRadius: '13px',
      border: '1px solid rgba(190,216,204,.28)',
      background: 'rgba(7,14,15,.94)',
      boxShadow: '0 12px 36px rgba(0,0,0,.32)',
      font: '15px/1.5 "Helvetica Neue", Arial, sans-serif',
      textShadow: 'none',
      pointerEvents: 'auto',
      userSelect: 'text',
      overflow: 'hidden',
      flexDirection: 'column',
      zIndex: '30',
    });
    this.dialogueEl.setAttribute('role', 'dialog');
    this.dialogueEl.setAttribute('aria-modal', 'true');
    this.dialogueEl.setAttribute('aria-labelledby', 'living-world-chat-title');
    this.dialogueEl.addEventListener('click', (event) => event.stopPropagation());

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '14px 16px',
      borderBottom: '1px solid rgba(190,216,204,.16)',
      background: 'rgba(151,184,169,.06)',
    });
    this.dialogueTitleEl = document.createElement('div');
    this.dialogueTitleEl.id = 'living-world-chat-title';
    Object.assign(this.dialogueTitleEl.style, {
      color: '#b8ccc3',
      font: '600 12px/1.4 "Helvetica Neue", Arial, sans-serif',
      letterSpacing: '.11em',
      textTransform: 'uppercase',
    });
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.textContent = 'Close';
    this.closeButton.setAttribute('aria-label', 'Close conversation and return to walking');
    Object.assign(this.closeButton.style, {
      minWidth: '76px',
      padding: '7px 12px',
      border: '1px solid rgba(206,225,216,.3)',
      borderRadius: '8px',
      color: '#e5eee9',
      background: 'rgba(206,225,216,.08)',
      font: '600 12px/1.3 "Helvetica Neue", Arial, sans-serif',
      cursor: 'pointer',
    });
    header.append(this.dialogueTitleEl, this.closeButton);

    this.transcriptEl = document.createElement('div');
    this.transcriptEl.setAttribute('role', 'log');
    this.transcriptEl.setAttribute('aria-live', 'polite');
    this.transcriptEl.setAttribute('aria-relevant', 'additions text');
    Object.assign(this.transcriptEl.style, {
      minHeight: '130px',
      overflowY: 'auto',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      overscrollBehavior: 'contain',
    });

    this.chatForm = document.createElement('form');
    Object.assign(this.chatForm.style, {
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: '9px',
      padding: '13px 16px 8px',
      borderTop: '1px solid rgba(190,216,204,.16)',
    });
    this.chatInput = document.createElement('input');
    this.chatInput.type = 'text';
    this.chatInput.maxLength = 320;
    this.chatInput.autocomplete = 'off';
    this.chatInput.placeholder = 'Write a message…';
    this.chatInput.setAttribute('aria-label', 'Message station resident');
    Object.assign(this.chatInput.style, {
      minWidth: '0',
      padding: '11px 12px',
      border: '1px solid rgba(190,216,204,.3)',
      borderRadius: '9px',
      outline: 'none',
      color: '#f0f5f2',
      background: 'rgba(255,255,255,.06)',
      font: '15px/1.35 "Helvetica Neue", Arial, sans-serif',
    });
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'submit';
    this.sendButton.textContent = 'Send';
    Object.assign(this.sendButton.style, {
      padding: '10px 17px',
      border: '1px solid rgba(168,207,188,.4)',
      borderRadius: '9px',
      color: '#eff7f3',
      background: 'rgba(104,158,132,.32)',
      font: '600 13px/1.3 "Helvetica Neue", Arial, sans-serif',
      cursor: 'pointer',
    });
    this.chatForm.append(this.chatInput, this.sendButton);

    this.chatStatusEl = document.createElement('div');
    Object.assign(this.chatStatusEl.style, {
      padding: '0 16px 12px',
      color: 'rgba(190,207,199,.66)',
      font: '10px/1.4 "Helvetica Neue", Arial, sans-serif',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
    });
    this.dialogueEl.append(header, this.transcriptEl, this.chatForm, this.chatStatusEl);

    this.closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.requestDialogueClose();
    });
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendMessage();
    });
    this.onKeyDown = (event) => {
      if (this.dialogueOpen && event.code === 'Escape') {
        event.preventDefault();
        this.abandonDialogue();
        return;
      }
      if (event.code !== 'KeyT' || event.repeat) return;
      if (this.dialogueOpen || !this.controls.enabled || isInteractiveTarget(event.target)) return;
      this.talkQueued = true;
      event.preventDefault();
    };
    window.addEventListener('keydown', this.onKeyDown);
  }

  clear() {
    if (this.dialogueOpen) this.abandonDialogue();
    for (const actor of this.actors) actor.avatar.dispose();
    this.actors = [];
    this.plan = null;
    this.activeNpc = null;
    this.station = null;
    this.talkQueued = false;
    this.promptEl.style.display = 'none';
    this.debug.status = 'waiting for railway plan';
  }

  dispose() {
    this.clear();
    this.assets.dispose();
    this.promptEl.remove();
    this.dialogueEl.remove();
    this.chatHistories.clear();
    window.removeEventListener('keydown', this.onKeyDown);
  }

  setPlan(plan) {
    this.clear();
    this.plan = plan || null;
    if (!plan?.stations?.length) return;

    for (const station of plan.stations) {
      const tangentLength = Math.hypot(station.tangentX, station.tangentZ) || 1;
      const frame = {
        tx: station.tangentX / tangentLength,
        tz: station.tangentZ / tangentLength,
      };
      frame.rx = frame.tz;
      frame.rz = -frame.tx;
      const descriptors = createStationPopulation(station, this.worldSeed, {
        count: this.residentsPerStation,
      });
      for (let rosterIndex = 0; rosterIndex < descriptors.length; rosterIndex++) {
        const descriptor = descriptors[rosterIndex];
        const avatar = createNpcAvatar(descriptor.identity, this.assets);
        avatar.root.visible = false;
        this.scene.add(avatar.root);
        this.actors.push({
          station,
          frame,
          descriptor,
          identity: descriptor.identity,
          avatar,
          rosterIndex,
          heading: 0,
          poseTimer: 0,
          motionTime: 0,
          gestureTime: 0,
          pose: {},
          distance: Infinity,
        });
      }
    }
    this.debug.status = `${this.actors.length} residents · ${plan.stations.length} stations`;
  }

  setEnabled(enabled) {
    this.debug.enabled = !!enabled;
    if (!this.debug.enabled) {
      for (const actor of this.actors) actor.avatar.root.visible = false;
      this.promptEl.style.display = 'none';
      this.closeDialogue();
    }
  }

  setResidentsPerStation(value) {
    this.residentsPerStation = Math.max(3, Math.min(7, Math.round(value)));
    this.debug.residentsPerStation = this.residentsPerStation;
    const plan = this.plan;
    if (plan) this.setPlan(plan);
  }

  storageKey(actor = this.activeNpc) {
    return actor ? `wander.livingWorld.encounters.${actor.identity.id}` : '';
  }

  readEncounterCount(actor = this.activeNpc) {
    try {
      const value = Number.parseInt(localStorage.getItem(this.storageKey(actor)) || '0', 10);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    } catch (error) {
      return 0;
    }
  }

  recordEncounter() {
    this.encounterCount++;
    try {
      localStorage.setItem(this.storageKey(), String(this.encounterCount));
    } catch (error) { /* persistence is optional */ }
  }

  context() {
    if (!this.activeNpc) return null;
    return this.getContext?.(
      this.activeNpc.station,
      this.encounterCount,
      this.activeNpc.identity,
    );
  }

  prefetch() {
    if (!this.director.aiReady || this.prefetchRequest) return;
    const context = this.context();
    if (!context) return;
    const signature = [
      context.npc.id,
      context.station.id,
      context.weather,
      context.timeOfDay,
      context.encounterBand,
    ].join('|');
    if (signature === this.prefetchedKey) return;
    this.prefetchedKey = signature;
    const request = this.director.requestChatOpening(context);
    this.prefetchRequest = request;
    request.finally(() => {
      if (this.prefetchRequest === request) this.prefetchRequest = null;
    });
  }

  limitChatHistory(history = this.chatHistory) {
    if (history?.length > 18) history.splice(0, history.length - 18);
  }

  renderTranscript() {
    if (!this.chatHistory) return;
    this.transcriptEl.replaceChildren();
    for (const message of this.chatHistory) {
      const row = document.createElement('div');
      const isPlayer = message.role === 'user';
      Object.assign(row.style, {
        alignSelf: isPlayer ? 'flex-end' : 'flex-start',
        maxWidth: '86%',
        padding: '9px 12px',
        borderRadius: isPlayer ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
        color: isPlayer ? '#edf6f1' : '#f2f2ea',
        background: isPlayer ? 'rgba(84,139,113,.34)' : 'rgba(255,255,255,.07)',
        font: isPlayer
          ? '14px/1.5 "Helvetica Neue", Arial, sans-serif'
          : '16px/1.5 Georgia, serif',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      });
      const text = document.createElement('div');
      text.textContent = message.content;
      row.appendChild(text);
      if (!isPlayer && message.source) {
        const source = document.createElement('div');
        source.textContent = dialogueSourceLabel(message.source);
        Object.assign(source.style, {
          marginTop: '5px',
          color: 'rgba(190,207,199,.55)',
          font: '9px/1.35 "Helvetica Neue", Arial, sans-serif',
          letterSpacing: '.07em',
          textTransform: 'uppercase',
        });
        row.appendChild(source);
      }
      this.transcriptEl.appendChild(row);
    }
    if (this.chatBusy) {
      const thinking = document.createElement('div');
      thinking.textContent = `${this.activeNpc?.identity.name || 'The resident'} is thinking…`;
      Object.assign(thinking.style, {
        alignSelf: 'flex-start',
        padding: '8px 11px',
        borderRadius: '12px 12px 12px 3px',
        color: 'rgba(220,232,226,.66)',
        background: 'rgba(255,255,255,.045)',
        font: 'italic 13px/1.4 Georgia, serif',
      });
      this.transcriptEl.appendChild(thinking);
    }
    requestAnimationFrame(() => {
      this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    });
  }

  updateChatControls() {
    const canClose = this.dialogueOpen && this.pointerReleased && !this.resumePending;
    const canWrite = canClose && !this.chatBusy;
    this.closeButton.disabled = !canClose;
    this.closeButton.textContent = this.resumePending ? 'Returning…' : 'Close';
    this.closeButton.style.cursor = canClose ? 'pointer' : 'wait';
    this.chatInput.disabled = !canWrite;
    this.sendButton.disabled = !canWrite;
    this.sendButton.style.cursor = canWrite ? 'pointer' : 'wait';
    if (this.resumePending) {
      this.chatStatusEl.textContent = 'Returning to walking…';
    } else if (!this.pointerReleased) {
      this.chatStatusEl.textContent = 'Opening conversation…';
    } else if (this.chatBusy) {
      this.chatStatusEl.textContent = 'On-device reply in progress…';
    } else {
      this.chatStatusEl.textContent = 'Enter to send · Close returns to walking';
    }
  }

  renderDialogue(dialogue, source, entry = null) {
    const target = entry || [...(this.chatHistory || [])]
      .reverse().find((message) => message.role === 'assistant');
    if (!target) return;
    target.content = dialogue.text;
    target.source = source;
    this.renderTranscript();
  }

  focusDialogue() {
    if (!this.dialogueOpen || !this.pointerReleased) return;
    const target = this.chatInput.disabled ? this.closeButton : this.chatInput;
    target.focus({ preventScroll: true });
  }

  setPointerReleased() {
    if (!this.dialogueOpen) return;
    this.pointerReleased = true;
    this.updateChatControls();
    this.focusDialogue();
  }

  talk() {
    if (this.dialogueOpen) return;
    const context = this.context();
    if (!context) return;
    this.dialogueOpen = true;
    this.pointerReleased = false;
    this.resumePending = false;
    this.conversationNpcId = this.activeNpc.identity.id;
    this.chatHistory = this.chatHistories.get(this.conversationNpcId) || [];
    this.chatHistories.set(this.conversationNpcId, this.chatHistory);
    this.dialogueTitleEl.textContent = `${this.activeNpc.identity.name} · ${this.activeNpc.identity.role}`;
    this.chatInput.setAttribute('aria-label', `Message ${this.activeNpc.identity.name}`);
    this.dialogueEl.style.display = 'flex';
    this.recordEncounter();

    const needsGreeting = this.chatHistory.length === 0;
    let greetingEntry = null;
    if (needsGreeting) {
      const greeting = fallbackDialogue(context);
      greetingEntry = { role: 'assistant', content: greeting.text, source: 'authored' };
      this.chatHistory.push(greetingEntry);
      this.chatBusy = true;
    } else {
      this.chatBusy = false;
    }
    this.renderTranscript();
    this.updateChatControls();
    this.onChatOpen();

    if (!needsGreeting) return;
    const token = ++this.requestToken;
    this.director.requestChatOpening(context).then(({ reply, source }) => {
      if (this.conversationNpcId !== context.npc.id) return;
      this.renderDialogue(reply, source, greetingEntry);
      if (!this.dialogueOpen || token !== this.requestToken) return;
      this.chatBusy = false;
      this.renderTranscript();
      this.updateChatControls();
      this.focusDialogue();
    });
  }

  sendMessage() {
    if (!this.dialogueOpen || this.chatBusy || this.resumePending || !this.pointerReleased) return;
    const content = this.chatInput.value.trim().slice(0, 320);
    if (!content) return;
    const context = this.context();
    if (!context || context.npc.id !== this.conversationNpcId) return;

    const history = this.chatHistory;
    history.push({ role: 'user', content });
    this.chatInput.value = '';
    this.chatBusy = true;
    this.limitChatHistory(history);
    this.renderTranscript();
    this.updateChatControls();
    const token = ++this.requestToken;
    const npcId = this.conversationNpcId;
    this.director.requestChatReply(context, history).then(({ reply, source }) => {
      if (this.chatHistories.get(npcId) !== history) return;
      history.push({ role: 'assistant', content: reply.text, source });
      this.limitChatHistory(history);
      if (!this.dialogueOpen || this.conversationNpcId !== npcId || token !== this.requestToken) return;
      this.chatBusy = false;
      this.renderTranscript();
      this.updateChatControls();
      this.focusDialogue();
    });
  }

  requestDialogueClose() {
    if (!this.dialogueOpen || !this.pointerReleased || this.resumePending) return;
    this.resumePending = true;
    this.updateChatControls();
    if (this.onChatCloseRequest) this.onChatCloseRequest();
    else this.completeDialogueClose();
  }

  resumeDialogueClose() {
    if (!this.dialogueOpen) return;
    this.resumePending = false;
    this.updateChatControls();
    this.focusDialogue();
  }

  completeDialogueClose() {
    this.dialogueOpen = false;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.requestToken++;
    this.dialogueEl.style.display = 'none';
    this.chatInput.value = '';
    this.chatHistory = null;
    this.conversationNpcId = '';
  }

  abandonDialogue({ notify = true } = {}) {
    if (!this.dialogueOpen) return;
    this.completeDialogueClose();
    if (notify) this.onChatAbandon();
  }

  closeDialogue() {
    this.abandonDialogue();
  }

  updateActor(actor, player, dt, { xr = false } = {}) {
    const talking = this.dialogueOpen && this.activeNpc?.identity.id === actor.identity.id;
    if (!talking) actor.motionTime += dt;
    actor.gestureTime += dt;
    const motion = sampleNpcMotion(
      actor.identity,
      actor.motionTime,
      { talking, gestureElapsed: actor.gestureTime },
      actor.pose,
    );
    const along = actor.descriptor.along + motion.pathOffset;
    const across = actor.descriptor.across;
    const y = (actor.station.formationY ?? actor.station.y ?? 0)
      + STATION_LAYOUT.platformTop;
    const root = actor.avatar.root;
    root.position.set(
      actor.station.x + actor.frame.tx * along + actor.frame.rx * across,
      y,
      actor.station.z + actor.frame.tz * along + actor.frame.rz * across,
    );
    actor.distance = Math.hypot(root.position.x - player.x, root.position.z - player.z);
    const visibleRange = xr ? XR_VISIBLE_RANGE : VISIBLE_RANGE;
    root.visible = this.debug.enabled && actor.distance <= visibleRange
      && (!xr || actor.rosterIndex < XR_RESIDENT_LIMIT);
    if (!root.visible) return actor.distance;

    actor.poseTimer -= dt;
    if (actor.distance <= FULL_ANIMATION_RANGE || actor.poseTimer <= 0) {
      actor.avatar.applyMotion(motion);
      actor.poseTimer = actor.distance <= FULL_ANIMATION_RANGE ? 0 : 0.14;
    }
    actor.avatar.setDetail(actor.distance, { xr });

    let desiredHeading;
    if (talking || actor.distance < 13) {
      desiredHeading = Math.atan2(
        player.x - root.position.x,
        player.z - root.position.z,
      );
    } else if (motion.locomotion > 0.12) {
      desiredHeading = Math.atan2(
        actor.frame.tx * motion.facingSign,
        actor.frame.tz * motion.facingSign,
      );
    } else {
      const towardTrack = across >= 0 ? -1 : 1;
      desiredHeading = Math.atan2(
        actor.frame.rx * towardTrack,
        actor.frame.rz * towardTrack,
      );
    }
    actor.heading = dampAngle(actor.heading, desiredHeading, talking ? 8 : 4.5, dt);
    root.rotation.y = actor.heading;
    return actor.distance;
  }

  update(dt, player, { active = true, allowAI = true, xr = false } = {}) {
    if (!this.actors.length) return;
    if ((!active || !this.debug.enabled) && this.dialogueOpen) this.abandonDialogue();

    let nearest = null;
    const visibleRange = xr ? XR_VISIBLE_RANGE : VISIBLE_RANGE;
    const stationDistances = new Map();
    for (const actor of this.actors) {
      let stationDistance = stationDistances.get(actor.station.id);
      if (stationDistance === undefined) {
        stationDistance = Math.hypot(
          actor.station.x - player.x,
          actor.station.z - player.z,
        );
        stationDistances.set(actor.station.id, stationDistance);
      }
      if (stationDistance > visibleRange + STATION_CULL_MARGIN) {
        actor.avatar.root.visible = false;
        actor.distance = Infinity;
        continue;
      }
      const distance = this.updateActor(actor, player, dt, { xr });
      if (actor.identity.interactive && (!nearest || distance < nearest.distance)) {
        nearest = { actor, distance };
      }
    }
    if (!nearest || !this.debug.enabled) {
      if (this.dialogueOpen) this.abandonDialogue();
      this.promptEl.style.display = 'none';
      this.talkQueued = false;
      return;
    }

    let selected = nearest.actor;
    let distance = nearest.distance;
    if (this.dialogueOpen && this.activeNpc) {
      selected = this.activeNpc;
      distance = selected.distance;
    }
    if (this.activeNpc?.identity.id !== selected.identity.id) {
      if (this.dialogueOpen) this.abandonDialogue();
      this.activeNpc = selected;
      this.station = selected.station;
      this.encounterCount = this.readEncounterCount(selected);
      this.prefetchedKey = '';
    }

    if (allowAI && distance <= PREFETCH_RANGE) this.prefetch();
    const canTalk = active && distance <= TALK_RANGE;
    this.promptEl.style.display = canTalk && !this.dialogueOpen ? 'block' : 'none';
    if (canTalk && !this.dialogueOpen) {
      this.promptEl.innerHTML = `<b>T</b> talk to ${this.activeNpc.identity.name}`
        + ` · ${titleCase(this.activeNpc.identity.role)}`;
    }

    const talkPressed = this.talkQueued;
    this.talkQueued = false;
    if (canTalk && talkPressed) this.talk();

    if (this.dialogueOpen && distance > TALK_RANGE * 2) this.abandonDialogue();
  }
}

// Keep the earlier exported name available for code or bookmarks created by
// the first station-keeper prototype.
export { LivingWorldPopulation as LivingWorldStationKeeper };
