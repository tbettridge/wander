import { fallbackDialogue } from './livingworld.mjs';
import { findMentionedTarget } from './livingworldcontext.mjs';
import {
  combineNpcMemory,
  fallbackMemorySynthesis,
  NpcMemoryStore,
} from './npcmemory.mjs';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { advanceBipedGait, createBipedState } from './npcgait.mjs';
import { createStationPopulation, sampleNpcMotion } from './npcpopulation.mjs';
import { advanceGaze, createGazeState } from './npcgaze.mjs';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  gestureAmount, nodPitch, pointAmount, pulseDelivery, pulsePoint, SOCIAL,
} from './npcsocial.mjs';
import {
  beginGroundingFrame, createGrounding, groundHeightFor, groundingStats,
  releaseGrounding,
} from './npcgrounding.mjs';
import {
  advanceJourney, createJourneyState, isTravelling, JOURNEY_PHASE,
} from './npcjourney.mjs';
import { advanceWander, createWanderState, requestVisit, WANDER } from './npcwander.mjs';
import { STATION_LAYOUT } from './railstation.mjs';

const TALK_RANGE = 6.5;
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

/**
 * Where a resident on this side of the track is allowed to roam.
 *
 * The walkable strip only: inset from the platform edge so nobody strolls off
 * it, short of the end ramps, and on the main side cut back before the station
 * building rather than through it.
 */
function platformBounds(across) {
  const P = STATION_LAYOUT;
  const margin = 0.35;
  if (across >= 0) {
    return {
      alongMin: -(P.halfLength - P.endRamp),
      alongMax: P.halfLength - P.endRamp,
      acrossMin: P.mainAcross - P.mainHalf + margin,
      acrossMax: Math.min(P.mainAcross + P.mainHalf, P.building.across - P.building.half) - margin,
    };
  }
  return {
    alongMin: -(P.oppHalfLength - P.endRamp),
    alongMax: P.oppHalfLength - P.endRamp,
    acrossMin: P.oppAcross - P.oppHalf + margin,
    acrossMax: P.oppAcross + P.oppHalf - margin,
  };
}

function dampAngle(current, target, lambda, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * Math.min(dt, 0.1)));
}

function titleCase(value = '') {
  return value.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

// Things a resident actually holds in front of them. A staff is planted on the
// ground and a satchel hangs behind the hip: neither is something to look at.
const HANDHELD_ACCESSORIES = new Set(['book', 'case', 'basket', 'lantern']);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
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
    memoryStore = new NpcMemoryStore(),
    onChatOpen = () => {},
    onChatCloseRequest = null,
    onChatAbandon = () => {},
    groundAt = null,
    heightSamplesPerFrame = 12,
    spawnsPerFrame = 2,
    travellersPerStation = 2,
  } = {}) {
    this.scene = scene;
    this.controls = controls;
    this.director = director;
    this.getContext = getContext;
    this.worldSeed = worldSeed;
    this.residentsPerStation = residentsPerStation;
    this.memoryStore = memoryStore;
    this.onChatOpen = onChatOpen;
    this.onChatCloseRequest = onChatCloseRequest;
    this.onChatAbandon = onChatAbandon;
    this.assets = new NpcAssetLibrary();
    // The same walkable surface the player's feet resolve against — terrain,
    // bridge decks, railway spans. Two grounding systems that disagree put an
    // NPC shin-deep in a river the player walks over dry.
    this.grounding = createGrounding({ groundAt, samplesPerFrame: heightSamplesPerFrame });
    // Avatars are built a few per frame rather than all at once. Building a
    // region's worth of skinned meshes in one call is a visible hitch, and it
    // lands exactly when a station comes into range — the worst moment for it.
    this.spawnsPerFrame = spawnsPerFrame;
    this.pending = [];
    // How many of each station's residents are travellers rather than staff.
    // Not all of them: a station with nobody left on the platform reads as
    // abandoned, and the residents are what make it feel staffed.
    this.travellersPerStation = travellersPerStation;
    this.navGraph = null;
    // Travellers the debug jump has already shown, so each press finds someone
    // new until everyone has been seen.
    this._shownTravellers = new Set();
    this.plan = null;
    this.actors = [];
    this.activeNpc = null;
    this.station = null;
    this.encounterCount = 0;
    this.talkQueued = false;
    this.dialogueOpen = false;
    this.requestToken = 0;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.chatHistories = new Map();
    this.chatHistory = null;
    this.conversationNpcId = '';
    this.conversationContext = null;
    this.chatSessionId = null;
    this.memoryJobs = new Map();
    this.conversations = [];
    this.socialTimer = SOCIAL.checkInterval;

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
    for (const actor of this.actors) {
      releaseGrounding(this.grounding, actor.groundKey);
      actor.avatar.dispose();
    }
    this.actors = [];
    this.pending = [];
    this.conversations = [];
    this.plan = null;
    this.activeNpc = null;
    this.station = null;
    this.talkQueued = false;
    this.promptEl.style.display = 'none';
    this.debug.status = 'waiting for railway plan';
  }

  /**
   * Hand the population the landmark network travellers walk.
   *
   * Each traveller's home is the nearest landmark to its station, resolved once
   * here rather than stored on the station: stations and landmarks come from
   * different systems and only the graph knows where its own nodes are.
   */
  setNavGraph(graph) {
    this.navGraph = graph || null;
    if (!graph) return;
    for (const actor of this.actors) this.resolveJourneyHome(actor);
  }

  resolveJourneyHome(actor) {
    if (!actor.journey || actor.journey.homeKey || !this.navGraph) return;
    let bestKey = null;
    let bestDistance = Infinity;
    for (const node of this.navGraph.nodes.values()) {
      if (!Number.isFinite(node.x)) continue;
      const d = Math.hypot(node.x - actor.station.x, node.z - actor.station.z);
      if (d < bestDistance) { bestDistance = d; bestKey = node.key; }
    }
    actor.journey.homeKey = bestKey;
  }

  /**
   * Move every traveller, near or far.
   *
   * Deliberately separate from updateActor, which only runs for actors close
   * enough to draw. A journey needs an arc position and nothing else — no rig,
   * no gait, no height sample — so it is cheap enough to run for the whole
   * population and wrong to skip: a world that only advances where the player is
   * standing is a world where nobody ever went anywhere.
   */
  advanceJourneys(dt, hours) {
    for (const actor of this.actors) {
      if (!actor.journey) continue;
      // Walking away mid-sentence is worse than arriving late.
      if (actor.conversation || (this.dialogueOpen && this.activeNpc === actor)) continue;
      advanceJourney(actor.journey, { dt, hours, graph: this.navGraph });
      if (actor.journey.phase !== JOURNEY_PHASE.loiter) actor.roaming = true;
    }
  }

  /**
   * Where an actor actually is.
   *
   * NOT avatar.root.position: that is only written by updateActor, which is
   * skipped for anyone culled, so a resident of a distant station still reads
   * (0, 0, 0) — the world origin. A debug jump that trusted it teleported the
   * player to an empty trail in the middle of the map.
   */
  actorPosition(actor) {
    if (actor.roaming && actor.journey) {
      return { x: actor.journey.x, z: actor.journey.z };
    }
    const { along, across } = actor.descriptor;
    return {
      x: actor.station.x + actor.frame.tx * along + actor.frame.rx * across,
      z: actor.station.z + actor.frame.tz * along + actor.frame.rz * across,
    };
  }

  /**
   * An NPC that is walking somewhere right now, sending one on its way if
   * nobody happens to be.
   *
   * Waiting for a departure is not good enough for a debug jump whose whole
   * purpose is to watch someone travel: stays run up to 24 in-world hours, so
   * "come back later" is the usual answer and it looks identical to the feature
   * being broken.
   */
  travellerInTransit({ force = true } = {}) {
    const transit = this.actors.filter((a) => a.journey && isTravelling(a.journey));
    // Somebody not shown yet. Excluding only the PREVIOUS one is not enough:
    // with two people walking it ping-pongs between them forever and never sends
    // a third, which reads as "there are only two travellers in the world".
    const unseen = transit.filter((a) => !this._shownTravellers.has(a));
    if (unseen.length) return this.rememberTraveller(
      unseen[Math.floor(Math.random() * unseen.length) % unseen.length],
    );
    // Everyone currently walking has been visited, so send someone new out.
    if (force && this.navGraph) {
      const sent = this.sendSomeoneTravelling();
      if (sent) return this.rememberTraveller(sent);
    }
    // Nobody left to send: start the rotation again rather than returning
    // nothing, or the button stops working once every traveller has departed.
    this._shownTravellers.clear();
    if (!transit.length) return null;
    return this.rememberTraveller(
      transit[Math.floor(Math.random() * transit.length) % transit.length],
    );
  }

  rememberTraveller(actor) {
    this._shownTravellers.add(actor);
    return actor;
  }

  /**
   * Send a waiting traveller on its way now.
   *
   * Stays run up to 24 in-world hours, so a debug jump that only waits reports
   * "nobody is travelling" most of the time, which is indistinguishable from the
   * feature being broken.
   */
  sendSomeoneTravelling() {
    const waiting = this.actors.filter(
      (a) => a.journey && a.journey.homeKey && !isTravelling(a.journey),
    );
    for (let i = waiting.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [waiting[i], waiting[j]] = [waiting[j], waiting[i]];
    }
    for (const actor of waiting) {
      actor.journey.loiterLeft = 0;
      advanceJourney(actor.journey, { dt: 0, hours: 0.01, graph: this.navGraph });
      if (isTravelling(actor.journey)) {
        actor.roaming = true;
        return actor;
      }
    }
    return null;
  }

  /** What grounding cost last frame, for the quality panel. */
  groundingStats() {
    return { ...groundingStats(this.grounding), pendingSpawns: this.pending.length };
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
      // Queued rather than built. Draining a few per frame is what keeps a
      // station arriving from costing a visible hitch.
      for (let rosterIndex = 0; rosterIndex < descriptors.length; rosterIndex++) {
        this.pending.push({ station, frame, descriptor: descriptors[rosterIndex], rosterIndex });
      }
    }
    this.debug.status = `${this.pending.length} residents queued`;
  }

  /**
   * Build queued avatars, a few per frame.
   *
   * Skinned-mesh construction is the expensive part and it used to happen for
   * every resident of every station inside setPlan, in one call, at the moment a
   * region came into range. Residents are invisible until the player is near
   * them, so arriving over several frames costs nothing anyone can see.
   */
  drainSpawnQueue(limit = this.spawnsPerFrame) {
    let built = 0;
    while (this.pending.length && built < limit) {
      this.spawnResident(this.pending.shift());
      built++;
    }
    return built;
  }

  spawnResident({ station, frame, descriptor, rosterIndex }) {
    const avatar = createNpcAvatar(descriptor.identity, this.assets);
    avatar.root.visible = false;
    this.scene.add(avatar.root);
    // The platform is flat, so it is the whole ground function the gait
    // needs: residents stand on it, not on the terrain beneath it. A
    // traveller that steps off it takes fixedY away and is sampled from the
    // walkable surface instead — the seam Phase 2 attaches to.
    const groundY = (station.formationY ?? station.y ?? 0) + STATION_LAYOUT.platformTop;
    const groundKey = `${station.id}:${rosterIndex}`;
    // Outward from the track, in world terms: the direction the open
    // country lies in from this platform.
    const outward = descriptor.across >= 0 ? 1 : -1;
    const vistaHeading = Math.atan2(frame.rx * outward, frame.rz * outward);
    const actor = {
      station,
      frame,
      descriptor,
      identity: descriptor.identity,
      avatar,
      rosterIndex,
      heading: 0,
      poseTimer: 0,
      poseElapsed: 0,
      motionTime: 0,
      gestureTime: 0,
      pose: {},
      distance: Infinity,
      groundY,
      groundKey,
      // Null while the resident is on its platform. Phase 2 clears it for a
      // traveller, and the walkable surface answers instead.
      platformY: groundY,
      groundHeight: () => groundY,
      worldDims: npcWorldDimensions(avatar.dims, descriptor.identity.proportions),
      gait: createBipedState(descriptor.identity.animation.phase / (Math.PI * 2)),
      gaze: createGazeState(descriptor.identity.seed ^ 0x9e37, descriptor.identity.animation.phase),
      emote: createEmote(descriptor.identity.seed ^ 0x5eed),
      conversation: null,
      conversationSide: 0,
      vistaHeading,
      vista: { yaw: 0, pitch: -0.05 },
      wander: createWanderState(
        descriptor.identity.seed,
        { along: descriptor.along, across: descriptor.across },
        descriptor.identity.activity,
        platformBounds(descriptor.across),
      ),
      forward: [descriptor.identity.animation.phase < Math.PI ? 1 : -1, 0, 0],
      lastX: null,
      lastZ: null,
    };
    // The first few of each roster travel; the rest keep the station staffed.
    if (rosterIndex < this.travellersPerStation) {
      actor.journey = createJourneyState(
        (descriptor.identity.seed ^ 0x7a17e1) >>> 0, null,
        { x: station.x, z: station.z },
      );
      this.resolveJourneyHome(actor);
    } else {
      actor.journey = null;
    }
    // True once a traveller has left its platform for the first time. From then
    // on its position comes from the journey even while loitering, because it is
    // loitering at some other landmark now — snapping back to the platform would
    // undo the walk it just made.
    actor.roaming = false;
    // Resolved through the shared budget rather than captured as a constant.
    // A resident on its platform short-circuits before the budget is touched;
    // anything off it is sampled from the same surface the player uses.
    actor.groundHeight = () => groundHeightFor(
      this.grounding, actor.groundKey, actor.avatar.root.position.x,
      actor.avatar.root.position.z,
      { fixedY: actor.platformY, fallback: actor.groundY },
    );
    this.actors.push(actor);
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
    const context = this.getContext?.(
      this.activeNpc.station,
      this.encounterCount,
      this.activeNpc.identity,
      // Distances and bearings belong to whoever is answering, not to the
      // station they happen to be standing on.
      this.activeNpc.avatar.root.position,
    );
    if (!context) return null;
    return {
      ...context,
      memory: this.memoryStore.load(this.activeNpc.identity.id),
    };
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
    // The line has just landed, so mark it: a gesture, often a nod with it.
    // Deliberately here rather than while the dialogue box merely sits open —
    // gesturing continuously through a conversation reads as fidgeting.
    if (this.activeNpc) {
      const place = findMentionedTarget(this.conversationContext?.targets, dialogue.text);
      if (place && Number.isFinite(place.worldX)) {
        this.pointOut(this.activeNpc, place);
      } else {
        pulseDelivery(this.activeNpc.emote);
      }
    }
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
    this.conversationContext = context;
    this.chatSessionId = null;
    this.chatHistory = [];
    this.chatHistories.set(this.conversationNpcId, this.chatHistory);
    this.dialogueTitleEl.textContent = `${this.activeNpc.identity.name} · ${this.activeNpc.identity.role}`;
    this.chatInput.setAttribute('aria-label', `Message ${this.activeNpc.identity.name}`);
    this.dialogueEl.style.display = 'flex';
    this.recordEncounter();

    const greeting = fallbackDialogue(context);
    const greetingEntry = { role: 'assistant', content: greeting.text, source: 'authored' };
    this.chatHistory.push(greetingEntry);
    this.chatBusy = true;
    this.renderTranscript();
    this.updateChatControls();
    this.onChatOpen();

    const token = ++this.requestToken;
    this.director.requestChatOpening(context).then(({ reply, source, conversationId }) => {
      if (this.conversationNpcId !== context.npc.id) {
        this.director.discardConversation?.(conversationId);
        return;
      }
      this.chatSessionId = conversationId;
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
    const context = this.conversationContext;
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
    this.director.requestChatReply(context, content, this.chatSessionId).then(({ reply, source }) => {
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
    const context = this.conversationContext;
    const npcId = this.conversationNpcId;
    const conversationId = this.chatSessionId;
    const transcript = (this.chatHistory || []).map(({ role, content }) => ({ role, content }));
    this.dialogueOpen = false;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.requestToken++;
    this.dialogueEl.style.display = 'none';
    this.chatInput.value = '';
    this.chatHistories.delete(npcId);
    this.chatHistory = null;
    this.conversationNpcId = '';
    this.conversationContext = null;
    this.chatSessionId = null;

    if (!context || !npcId || !transcript.length) return;
    // Save a deterministic provisional memory immediately so even a very fast
    // return visit can recall the meeting. The edge model refines it in the
    // background using the just-finished conversation session.
    const provisional = fallbackMemorySynthesis(context.memory, context, transcript);
    this.memoryStore.save(npcId, provisional);
    const job = this.director.synthesizeConversation(context, transcript, conversationId)
      .then((memory) => {
        const current = this.memoryStore.load(npcId);
        return this.memoryStore.save(npcId, combineNpcMemory(current, memory, npcId));
      })
      .finally(() => {
        if (this.memoryJobs.get(npcId) === job) this.memoryJobs.delete(npcId);
      });
    this.memoryJobs.set(npcId, job);
  }

  abandonDialogue({ notify = true } = {}) {
    if (!this.dialogueOpen) return;
    this.completeDialogueClose();
    if (notify) this.onChatAbandon();
  }

  closeDialogue() {
    this.abandonDialogue();
  }

  /**
   * Drive one resident's skeleton from the bipedal gait solver.
   *
   * Speed and heading are measured from how far the root actually travelled
   * since the last solve rather than taken from the animation curve, so the
   * stride is a consequence of the movement instead of a sine running beside
   * it. A resident that is standing still reports zero speed, which is what
   * keeps its feet planted instead of marching on the spot.
   */
  solveGait(actor, motion, dt, talking) {
    const root = actor.avatar.root;
    if (actor.lastX === null) {
      actor.lastX = root.position.x;
      actor.lastZ = root.position.z;
    }
    const dx = root.position.x - actor.lastX;
    const dz = root.position.z - actor.lastZ;
    actor.lastX = root.position.x;
    actor.lastZ = root.position.z;
    // Forward is where the body FACES, not where it drifted: the legs can only
    // swing in that plane. Travel is projected onto it, so a resident sliding
    // sideways reports the speed its legs can actually account for rather than
    // a stride it cannot take.
    actor.forward[0] = Math.sin(actor.heading);
    actor.forward[2] = Math.cos(actor.heading);
    const advance = dx * actor.forward[0] + dz * actor.forward[2];

    const pose = advanceBipedGait(actor.gait, {
      dims: actor.worldDims,
      dt,
      speed: dt > 1e-4 ? Math.max(0, advance) / dt : 0,
      position: [root.position.x, actor.groundY, root.position.z],
      forward: actor.forward,
      terrainHeight: actor.groundHeight,
      talking,
      gesturePhase: actor.gestureTime * 1.7,
    });
    actor.avatar.applyPose(pose, actor.groundY, {
      gesture: gestureAmount(actor.emote),
      gestureHand: actor.identity.animation.gestureHand,
      point: pointAmount(actor.emote),
      // Landmarks sit out on the country, so the arm reads best a touch above
      // level rather than aimed at the horizon exactly.
      pointPitch: 0.10,
      // Point with the free hand. Somebody carrying a basket raises the other
      // arm; only the case is carried on the left.
      pointHand: HANDHELD_ACCESSORIES.has(actor.identity.accessory)
        ? (actor.identity.accessory === 'case' ? 'right' : 'left')
        : actor.identity.animation.gestureHand,
    });
    return pose;
  }

  /**
   * Aim the head. The gait owns the body; this owns what the body is paying
   * attention to. Throttled with the pose, so distant residents cost nothing.
   */
  solveGaze(actor, dt, talking, player, motion) {
    // Only look at a player who is close enough to be worth noticing, and the
    // nearer they are the more likely they are to be noticed at all.
    const playerLook = actor.distance <= 14
      ? this.lookAt(actor, player.x, player.y + 1.62, player.z) : null;
    // In conversation the neighbour IS the partner; otherwise it is whoever
    // happens to be standing nearest.
    const partner = this.conversationPartner(actor);
    const neighbour = partner || this.nearestNeighbour(actor);
    const neighbourLook = neighbour
      ? this.lookAt(
        actor,
        neighbour.avatar.root.position.x,
        this.eyeHeight(neighbour),
        neighbour.avatar.root.position.z,
      )
      : null;
    const gaze = advanceGaze(actor.gaze, dt, {
      player: playerLook,
      neighbour: neighbourLook,
      // Something in the hand is worth looking down at — but a walking stick is
      // scenery, and a bag over the shoulder is not in view at all.
      held: HANDHELD_ACCESSORIES.has(actor.identity.accessory)
        ? { yaw: (actor.identity.accessory === 'case' ? -1 : 1) * 0.22, pitch: 0.52 }
        : null,
      // Off across whatever the platform faces: the fields, the valley, the
      // weather coming in. The neck clamp turns this into as far round as they
      // can manage, which is what staring out at something looks like.
      vista: actor.vista,
      lockOn: talking ? 'player' : (partner ? 'neighbour' : null),
      playerInterest: clamp01(1 - (actor.distance - 3) / 11),
      moving: actor.wander.speed > WANDER.idleSpeed,
    });
    actor.avatar.rig.head.rotation.set(
      gaze.pitch + nodPitch(actor.emote), gaze.yaw, motion.headTilt * 0.35,
    );
    return gaze;
  }

  /** Eye height in world metres, for aiming a look at somebody. */
  eyeHeight(actor) {
    return actor.groundY + actor.worldDims.hipHeight * 1.72;
  }

  /**
   * A world point expressed as a look, relative to where this resident's body
   * already faces. Returns null for a target it is standing on top of.
   */
  lookAt(actor, x, y, z) {
    const root = actor.avatar.root;
    const dx = x - root.position.x;
    const dz = z - root.position.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 0.05) return null;
    const relative = Math.atan2(dx, dz) - actor.heading;
    return {
      yaw: Math.atan2(Math.sin(relative), Math.cos(relative)),
      // Negative pitches look up, matching a rotation about the head's local X.
      pitch: -Math.atan2(y - this.eyeHeight(actor), flat),
    };
  }

  /** The station-mate a resident is most likely to notice: the nearest one. */
  nearestNeighbour(actor, within = 9) {
    let best = null;
    let bestDistance = within;
    for (const other of this.actors) {
      if (other === actor || other.station.id !== actor.station.id) continue;
      const distance = Math.hypot(
        other.avatar.root.position.x - actor.avatar.root.position.x,
        other.avatar.root.position.z - actor.avatar.root.position.z,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    return best;
  }

  /**
   * Turn to a place and point it out.
   *
   * The bearing is recomputed from where the resident is standing right now
   * rather than reused from the context, because they may have taken a few
   * paces since it was built — and an arm aimed at where a landmark used to be
   * relative to them is worse than no arm at all.
   */
  pointOut(actor, place) {
    const root = actor.avatar.root;
    const bearing = Math.atan2(place.worldX - root.position.x, place.worldZ - root.position.z);
    pulsePoint(actor.emote, bearing);
    return bearing;
  }

  /** The resident on the other side of a conversation, if there is one. */
  conversationPartner(actor) {
    if (!actor.conversation) return null;
    return actor.conversation.actors[1 - actor.conversationSide] || null;
  }

  busyWithPlayer(actor) {
    return this.dialogueOpen && this.activeNpc === actor;
  }

  /**
   * Residents falling into conversation with each other, and out of it again.
   *
   * Pairing needs the whole roster, so it lives here; everything about how a
   * conversation actually runs — who holds the floor, when a gesture or a nod
   * lands — is in npcsocial.
   */
  updateConversations(dt) {
    for (let i = this.conversations.length - 1; i >= 0; i--) {
      const convo = this.conversations[i];
      const [a, b] = convo.actors;
      advanceConversation(convo, dt, [a.emote, b.emote]);
      const drifted = Math.hypot(
        a.avatar.root.position.x - b.avatar.root.position.x,
        a.avatar.root.position.z - b.avatar.root.position.z,
      ) > SOCIAL.breakRange;
      // The player asking one of them a question ends the side conversation.
      if (convo.done || drifted || this.busyWithPlayer(a) || this.busyWithPlayer(b)) {
        a.conversation = null;
        b.conversation = null;
        this.conversations.splice(i, 1);
      }
    }

    this.socialTimer -= dt;
    if (this.socialTimer > 0) return;
    this.socialTimer = SOCIAL.checkInterval;
    for (const actor of this.actors) {
      if (actor.conversation || actor.wander.mode !== 'dwell' || this.busyWithPlayer(actor)) continue;
      const close = this.nearestNeighbour(actor, SOCIAL.range);
      if (close && !close.conversation && close.wander.mode === 'dwell'
        && !this.busyWithPlayer(close) && actor.emote.rng() < SOCIAL.startChance) {
        const convo = createConversation(actor.identity.seed ^ close.identity.seed);
        convo.actors = [actor, close];
        actor.conversation = convo;
        actor.conversationSide = 0;
        close.conversation = convo;
        close.conversationSide = 1;
        this.conversations.push(convo);
        continue;
      }
      if (close) continue;
      // Nobody within talking distance. Residents are posted the length of a
      // platform apart, so left alone they would never once speak to each
      // other — somebody has to walk over. Pick someone in sight and go and
      // stand beside them; the conversation starts on arrival, by the branch
      // above.
      const candidate = this.nearestNeighbour(actor, SOCIAL.approachRange);
      if (!candidate || candidate.conversation || this.busyWithPlayer(candidate)) continue;
      if (actor.emote.rng() > SOCIAL.approachChance) continue;
      const toward = Math.hypot(
        candidate.wander.along - actor.wander.along,
        candidate.wander.across - actor.wander.across,
      ) || 1;
      const stand = SOCIAL.range * 0.55;
      requestVisit(
        actor.wander,
        candidate.wander.along + (actor.wander.along - candidate.wander.along) / toward * stand,
        candidate.wander.across + (actor.wander.across - candidate.wander.across) / toward * stand,
      );
    }
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
    // The resident decides where it wants to stand; the curve above is now only
    // consulted for the idle head turn and the talking gesture. Somebody in
    // conversation — with the player or with the resident beside them — stays
    // where they are until it is over.
    advanceEmote(actor.emote, dt);
    // The journey already advanced this frame, for every traveller including the
    // ones nobody can see. All that is left here is to put the body where the
    // journey says it is.
    const held = talking || !!actor.conversation;
    const root = actor.avatar.root;
    if (actor.roaming) {
      // Off the platform, so the ground is whatever the walkable surface says —
      // terrain, or the deck of a bridge the trail crosses. Clearing platformY
      // is what moves this actor onto the same footing the player uses.
      actor.platformY = null;
      root.position.x = actor.journey.x;
      root.position.z = actor.journey.z;
      root.position.y = actor.groundHeight();
      actor.groundY = root.position.y;
    } else {
      advanceWander(actor.wander, dt, { held });
      const along = actor.wander.along;
      const across = actor.wander.across;
      root.position.set(
        actor.station.x + actor.frame.tx * along + actor.frame.rx * across,
        actor.groundY,
        actor.station.z + actor.frame.tz * along + actor.frame.rz * across,
      );
    }
    actor.distance = Math.hypot(root.position.x - player.x, root.position.z - player.z);
    const visibleRange = xr ? XR_VISIBLE_RANGE : VISIBLE_RANGE;
    root.visible = this.debug.enabled && actor.distance <= visibleRange
      && (!xr || actor.rosterIndex < XR_RESIDENT_LIMIT);
    if (!root.visible) {
      // Keep the travel reference current while culled, or the first visible
      // frame reads the whole culled displacement as one enormous step.
      actor.lastX = root.position.x;
      actor.lastZ = root.position.z;
      return actor.distance;
    }

    // Facing has to settle BEFORE the legs are solved. The gait works in the
    // body's sagittal plane, so a heading that disagrees with the direction of
    // travel drags the stance foot sideways across the platform for as long as
    // they disagree — which is why a walking resident must face where it walks
    // and may only turn to the player once it has stopped.
    // The wander's facing lives in the station's own frame, so it converts back
    // through the same axes the position did.
    const wanderX = actor.frame.tx * Math.cos(actor.wander.facing)
      + actor.frame.rx * Math.sin(actor.wander.facing);
    const wanderZ = actor.frame.tz * Math.cos(actor.wander.facing)
      + actor.frame.rz * Math.sin(actor.wander.facing);
    const partner = this.conversationPartner(actor);
    const pointing = pointAmount(actor.emote);
    let desiredHeading;
    let turnRate = 4.5;
    if (pointing > 0.01) {
      // Square up to whatever is being pointed out: the arm aims straight
      // ahead, so the body has to be the thing that carries the direction.
      desiredHeading = actor.emote.pointBearing;
      turnRate = 7;
    } else if (partner && actor.wander.speed <= WANDER.idleSpeed) {
      // Two people talking square up to each other.
      desiredHeading = Math.atan2(
        partner.avatar.root.position.x - root.position.x,
        partner.avatar.root.position.z - root.position.z,
      );
      turnRate = 5.5;
    } else if (actor.roaming && isTravelling(actor.journey)) {
      // Same rule as the platform wander: face the direction of travel, or the
      // gait drags a planted foot sideways for as long as the two disagree.
      desiredHeading = actor.journey.heading;
      turnRate = 24;
    } else if (actor.wander.speed > WANDER.idleSpeed) {
      desiredHeading = Math.atan2(wanderX, wanderZ);
      // Snap to the behaviour's own heading while moving. The wander already
      // turned to face this on the spot, so damping it here would reintroduce
      // exactly the travel/facing disagreement that drags a planted foot.
      turnRate = 24;
    } else if (talking || actor.distance < 13) {
      desiredHeading = Math.atan2(
        player.x - root.position.x,
        player.z - root.position.z,
      );
      turnRate = talking ? 8 : 4.5;
    } else {
      desiredHeading = Math.atan2(wanderX, wanderZ);
    }
    actor.heading = dampAngle(actor.heading, desiredHeading, turnRate, dt);
    root.rotation.y = actor.heading;
    // The vista is a fixed world direction, so what it means for the head
    // depends on where the body has ended up facing.
    const outward = actor.vistaHeading - actor.heading;
    actor.vista.yaw = Math.atan2(Math.sin(outward), Math.cos(outward));

    actor.poseTimer -= dt;
    actor.poseElapsed += dt;
    const near = actor.distance <= FULL_ANIMATION_RANGE;
    if (near || actor.poseTimer <= 0) {
      this.solveGait(actor, motion, actor.poseElapsed, talking);
      this.solveGaze(actor, actor.poseElapsed, talking, player, motion);
      actor.poseElapsed = 0;
      actor.poseTimer = near ? 0 : 0.14;
    }
    actor.avatar.setDetail(actor.distance, { xr });
    return actor.distance;
  }

  update(dt, player, { active = true, allowAI = true, xr = false, hours = 0 } = {}) {
    // Before the early-out: a queue that only drains when actors already exist
    // never starts, and the first station would never populate.
    this.drainSpawnQueue();
    // Every ground sample after this counts against one shared ceiling.
    beginGroundingFrame(this.grounding);
    if (!this.actors.length) return;
    if ((!active || !this.debug.enabled) && this.dialogueOpen) this.abandonDialogue();
    this.updateConversations(dt);

    // Journeys advance whether or not anyone is watching. This is the whole
    // point of a traveller being a position and an intent: it costs an arc
    // position and no rig work, so there is no reason to freeze it, and freezing
    // it means the world only moves where the player is already looking.
    this.advanceJourneys(dt, hours);

    let nearest = null;
    const visibleRange = xr ? XR_VISIBLE_RANGE : VISIBLE_RANGE;
    const stationDistances = new Map();
    for (const actor of this.actors) {
      // Judge a traveller by where IT is, not by where its station is. Culling
      // on station distance hid every NPC that had walked away from home — they
      // were forced invisible while standing right in front of the player.
      let cullDistance;
      if (actor.roaming) {
        cullDistance = Math.hypot(actor.journey.x - player.x, actor.journey.z - player.z);
      } else {
        let stationDistance = stationDistances.get(actor.station.id);
        if (stationDistance === undefined) {
          stationDistance = Math.hypot(
            actor.station.x - player.x,
            actor.station.z - player.z,
          );
          stationDistances.set(actor.station.id, stationDistance);
        }
        cullDistance = stationDistance;
      }
      if (cullDistance > visibleRange + STATION_CULL_MARGIN) {
        actor.avatar.root.visible = false;
        actor.distance = Infinity;
        if (actor.roaming) {
          // Keep the body under the traveller while it is out of sight. Cheap —
          // no height sample, no gait — and it stops the first visible frame
          // reading the whole culled walk as one enormous stride.
          actor.avatar.root.position.x = actor.journey.x;
          actor.avatar.root.position.z = actor.journey.z;
          actor.lastX = actor.journey.x;
          actor.lastZ = actor.journey.z;
        }
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
    }

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
