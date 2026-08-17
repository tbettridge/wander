import { findMentionedTarget } from './livingworldcontext.mjs?v=pointplaces1';
import { NPC_DIALOGUE_PANEL_STYLE } from './npcdialogueui.mjs';
import {
  combineNpcMemory,
  fallbackMemorySynthesis,
  NpcMemoryStore,
} from './npcmemory.mjs?v=worldscope1';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { advanceNpcLocomotion, createNpcLocomotionState } from './npclocomotion.mjs';
import { createStationPopulation, NPC_STATION_SLOTS, sampleNpcMotion } from './npcpopulation.mjs';
import { createSettlementResidentIdentity } from './npcresidentidentity.mjs';
import { advanceGaze, createGazeState } from './npcgaze.mjs';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  beginDeliberation, deliberationLookAway, endDeliberation,
  gestureAmount, nodPitch, pointAmount, pulseDelivery, pulseNod, pulsePoint, SOCIAL,
} from './npcsocial.mjs';
import {
  beginGroundingFrame, createGrounding, groundHeightFor, groundingStats,
  releaseGrounding,
} from './npcgrounding.mjs';
import {
  advanceEncounter, createEncounterState, sociabilityFor,
} from './npcencounter.mjs';
import {
  advanceJourney, createJourneyState, drainJourneyTransitions, isTravelling, JOURNEY_PHASE, journeyProgress,
} from './npcjourney.mjs';
import { advanceLivingWorldClock } from './livingworldclock.mjs';
import {
  createLivingWorldState,
  LivingWorldStateStore,
  normalizeLivingWorldFeatures,
  registerLivingWorldEntity,
} from './livingworldstate.mjs?v=mobility1';
import {
  activateCommitment,
  COMMITMENT_STATE,
  openCommitmentForActor,
  planCommitment,
  restoreCommitmentJourney,
  retryBlockedCommitment,
  syncCommitmentProgress,
} from './npccommitment.mjs';
import {
  advanceRepairJobs,
  outcomeContextForActor,
  resolveCommitmentArrival,
} from './npcoutcomes.mjs';
import {
  memoriesFor,
  migrateLegacyNpcMemory,
  socialContextFor,
} from './npcsocialmemory.mjs';
import {
  beginNpcConversation,
  beginPlayerConversation,
  exchangeRumors,
  recordPlayerConversationOutcome,
  rumorInspector,
} from './npcrumor.mjs';
import { safeFallbackDialogue } from './livingworld.mjs?v=travellersubject2';
import { advanceWander, createWanderState, requestVisit, WANDER } from './npcwander.mjs';
import { STATION_LAYOUT } from './railstation.mjs';
import { claimActivity, createActivityArbiter, releaseActivity } from './npcactivity.mjs';
import { createItem, deriveNpcLoadout, freeGestureHand, itemsForOwner } from './npcitems.mjs';
import { advanceInteractions, createInteractionEpisode, interactionCandidateFor, interactionLine, pendingInteraction, resolveInteraction } from './npcinteraction.mjs';
import { advanceFormationFollower, applyGroupEpisodeEvent, createTravelGroup, formationOffset, groupForActor, GROUP_STATE, routeRiskScore } from './npcgroup.mjs';
import { registerActionAnchor } from './npcactionanchors.mjs';
import { activeActionForActor, advanceSituatedAction, planSituatedAction, situatedActionCandidatesFor } from './npcsituatedaction.mjs';
import {
  commitNpcConversationNarrative,
  createNpcNarrativeConversation,
  retrieveNpcConversationNarrative,
} from './npcnarrativecontinuity.mjs';

const TALK_RANGE = 6.5;
const VISIBLE_RANGE = 245;
const XR_VISIBLE_RANGE = 115;
const FULL_ANIMATION_RANGE = 92;
const STATION_CULL_MARGIN = 38;
const XR_RESIDENT_LIMIT = 3;
const NPC_PLAYTEST_VIGNETTES = Object.freeze([
  'letter delivery', 'parcel journey', 'repair work', 'trade offer',
  'travelling pair', 'map consultation', 'waiting for train',
]);

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

function stationFrame(station) {
  const tangentLength = Math.hypot(station.tangentX, station.tangentZ) || 1;
  const tx = station.tangentX / tangentLength;
  const tz = station.tangentZ / tangentLength;
  return { tx, tz, rx: tz, rz: -tx };
}

function canonicalStationDutyDescriptors(station, roster, state, worldSeed) {
  if (!roster || roster.stationId !== station.id || !Array.isArray(roster.assignments)) return [];
  const slots = new Map(NPC_STATION_SLOTS.map((slot) => [slot.key, slot]));
  return roster.assignments.flatMap((assignment) => {
    const entity = state.entities?.[assignment.personId];
    const slot = slots.get(assignment.slotKey);
    if (!entity || !slot || entity.location?.kind !== 'station-platform'
      || entity.location.stationId !== station.id) return [];
    const household = state.households?.[entity.householdId];
    const householdIndex = Math.max(0, household?.memberIds?.indexOf(entity.id) ?? 0);
    const resident = createSettlementResidentIdentity({
      entity,
      state,
      worldSeed,
      homeBuildingId: entity.residence?.homeBuildingId,
      householdIndex,
    });
    const paceDistance = slot.activity === 'pace'
      ? 1.4 + ((resident.seed >>> 9) % 130) / 100 : 0;
    const identity = Object.freeze({
      ...resident,
      role: assignment.role,
      stationId: station.id,
      stationName: station.name || `Station ${(station.index ?? 0) + 1}`,
      activity: slot.activity,
      accessory: slot.accessory,
      animation: Object.freeze({ ...resident.animation, paceDistance }),
    });
    return [Object.freeze({
      id: entity.id,
      identity,
      slot: slot.key,
      along: slot.along,
      across: slot.across,
      canonicalDuty: true,
    })];
  });
}

function canonicalStationDescriptors(station, roster, state, worldSeed) {
  const duty = canonicalStationDutyDescriptors(station, roster, state, worldSeed);
  // Itinerary travellers have one continuous presentation owner from their
  // walk to the station through their ride. Station duty remains owned here.
  return duty;
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
    playerId = 'player:local',
    playerName = 'Traveller',
    residentsPerStation = 6,
    memoryStore = null,
    migrateLegacyMemory = false,
    onChatOpen = () => {},
    onChatCloseRequest = null,
    onChatAbandon = () => {},
    groundAt = null,
    surfaceQuery = null,
    heightSamplesPerFrame = 12,
    spawnsPerFrame = 2,
    travellersPerStation = 3,
    livingWorldStore = null,
    livingWorldState = null,
    commitmentsEnabled = null,
    consequencesEnabled = null,
    socialMemoryEnabled = null,
    rumorExchangeEnabled = null,
    intentPropsEnabled = null,
    npcInitiationEnabled = null,
    travelGroupsEnabled = null,
    situatedActionsEnabled = null,
    getAgencyContext = null,
    stationRosterProvider = null,
    onBeforeFeaturesChanged = null,
    onFeaturesChanged = null,
  } = {}) {
    this.scene = scene;
    this.controls = controls;
    this.director = director;
    this.getContext = getContext;
    this.getAgencyContext = getAgencyContext;
    this.worldSeed = worldSeed;
    this.playerId = String(playerId || 'player:local');
    this.playerName = String(playerName || 'Traveller');
    this.residentsPerStation = residentsPerStation;
    this.memoryStore = memoryStore || new NpcMemoryStore({
      worldSeed,
      migrateLegacy: migrateLegacyMemory,
    });
    this.livingWorldStore = livingWorldStore || new LivingWorldStateStore({
      worldSeed, playerId: this.playerId, playerName: this.playerName,
    });
    this.worldState = livingWorldState || this.livingWorldStore.load();
    this.features = normalizeLivingWorldFeatures({
      ...this.worldState.features,
      ...(commitmentsEnabled == null ? {} : { commitmentsEnabled }),
      ...(consequencesEnabled == null ? {} : { consequencesEnabled }),
      ...(socialMemoryEnabled == null ? {} : { socialMemoryEnabled }),
      ...(rumorExchangeEnabled == null ? {} : { rumorExchangeEnabled }),
      ...(intentPropsEnabled == null ? {} : { intentPropsEnabled }),
      ...(npcInitiationEnabled == null ? {} : { npcInitiationEnabled }),
      ...(travelGroupsEnabled == null ? {} : { travelGroupsEnabled }),
      ...(situatedActionsEnabled == null ? {} : { situatedActionsEnabled }),
    });
    this.worldState.features = { ...this.features };
    this.commitmentsEnabled = this.features.commitmentsEnabled;
    registerLivingWorldEntity(this.worldState, {
      id: this.playerId, kind: 'player', name: this.playerName, role: 'traveller',
    });
    this.stateSaveElapsed = 0;
    this.onChatOpen = onChatOpen;
    this.onChatCloseRequest = onChatCloseRequest;
    this.onChatAbandon = onChatAbandon;
    this.assets = new NpcAssetLibrary();
    // The same walkable surface the player's feet resolve against — terrain,
    // bridge decks, railway spans. Two grounding systems that disagree put an
    // NPC shin-deep in a river the player walks over dry.
    this.grounding = createGrounding({ groundAt, samplesPerFrame: heightSamplesPerFrame });
    this.surfaceQuery = surfaceQuery;
    // Avatars are built a few per frame rather than all at once. Building a
    // region's worth of skinned meshes in one call is a visible hitch, and it
    // lands exactly when a station comes into range — the worst moment for it.
    this.spawnsPerFrame = spawnsPerFrame;
    this.pending = [];
    // How many of each station's residents are travellers rather than staff.
    // Not all of them: a station with nobody left on the platform reads as
    // abandoned, and the residents are what make it feel staffed.
    this.travellersPerStation = travellersPerStation;
    this.stationRosterProvider = typeof stationRosterProvider === 'function'
      ? stationRosterProvider : null;
    this.onBeforeFeaturesChanged = typeof onBeforeFeaturesChanged === 'function'
      ? onBeforeFeaturesChanged : null;
    this.onFeaturesChanged = typeof onFeaturesChanged === 'function'
      ? onFeaturesChanged : null;
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
    this.declineQueued = false;
    this.dialogueOpen = false;
    this.requestToken = 0;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.chatOpeningPending = false;
    this.chatHistories = new Map();
    this.chatHistory = null;
    this.conversationNpcId = '';
    this.conversationContext = null;
    this.chatSessionId = null;
    this.worldConversation = null;
    this.narrativeConversation = null;
    // A canonical roster change that arrived while the player was talking, and
    // is owed to the world the moment the conversation ends.
    this.rosterReconcileDeferred = false;
    this.memoryJobs = new Map();
    this.regionStateGeneration = 0;
    this.conversations = [];
    this.socialTimer = SOCIAL.checkInterval;
    this.getExternalActors = () => [];
    this.activityArbiter = createActivityArbiter();
    this.agencyTimer = 0;

    this.debug = {
      enabled: true,
      commitmentsEnabled: this.features.commitmentsEnabled,
      consequencesEnabled: this.features.consequencesEnabled,
      socialMemoryEnabled: this.features.socialMemoryEnabled,
      rumorExchangeEnabled: this.features.rumorExchangeEnabled,
      intentPropsEnabled: this.features.intentPropsEnabled,
      npcInitiationEnabled: this.features.npcInitiationEnabled,
      travelGroupsEnabled: this.features.travelGroupsEnabled,
      situatedActionsEnabled: this.features.situatedActionsEnabled,
      npcCommunityKnowledgeEnabled: this.features.npcCommunityKnowledgeEnabled,
      npcNarrativeGraphRetrievalEnabled: this.features.npcNarrativeGraphRetrievalEnabled,
      npcNarrativeFactPropagationEnabled: this.features.npcNarrativeFactPropagationEnabled,
      unifiedNpcMobilityEnabled: this.features.unifiedNpcMobilityEnabled,
      npcRailTravelEnabled: this.features.npcRailTravelEnabled,
      npcLeisureTravelEnabled: this.features.npcLeisureTravelEnabled,
      npcMigrationEnabled: this.features.npcMigrationEnabled,
      residentsPerStation,
      status: 'waiting for railway plan',
      commitment: 'none selected',
      ledger: '0 events · 0 relationships · 0 memories',
      rumor: 'no exchanges',
      playtestVignette: NPC_PLAYTEST_VIGNETTES[0],
      playtestStatus: 'not started',
      loadPlaytestVignette: () => this.loadPlaytestVignette(this.debug.playtestVignette),
      selectedCommitment: () => this.activeNpc
        ? openCommitmentForActor(this.worldState, this.activeNpc.identity.id)
        : null,
      livingWorld: () => ({
        revision: this.worldState.revision,
        worldHours: this.worldState.clock.worldHours,
        commitments: Object.values(this.worldState.commitments).reduce((counts, commitment) => {
          counts[commitment.state] = (counts[commitment.state] || 0) + 1;
          return counts;
        }, {}),
        events: this.worldState.events.length,
        relationships: Object.keys(this.worldState.relationships).length,
        memories: Object.values(this.worldState.memories)
          .reduce((sum, entries) => sum + (entries?.length || 0), 0),
        rumorExchanges: this.worldState.metrics?.rumorExchanges || 0,
        rumorTransfers: this.worldState.metrics?.rumorTransfers || 0,
        narrativeFacts: Object.keys(this.worldState.narrativeFacts || {}).length,
        narrativeFactReceipts: Object.keys(this.worldState.narrativeFactReceipts || {}).length,
        narrativeGraphRetrievals: this.worldState.metrics?.narrativeGraphRetrievals || 0,
        narrativeFactsAccepted: this.worldState.metrics?.narrativeFactsAccepted || 0,
        narrativeFactsRejected: this.worldState.metrics?.narrativeFactsRejected || 0,
        items: Object.keys(this.worldState.projections.items || {}).length,
        interactions: Object.keys(this.worldState.interactions || {}).length,
        groups: Object.keys(this.worldState.groups || {}).length,
        actions: Object.keys(this.worldState.actions || {}).length,
        snapshotBytes: this.worldState.metrics?.snapshotBytes || 0,
        features: { ...this.features },
        saveError: this.livingWorldStore.lastError?.message || '',
      }),
      rumorInspector: () => rumorInspector(this.worldState),
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
      ...NPC_DIALOGUE_PANEL_STYLE,
      padding: '0',
      borderRadius: '12px',
      border: '1px solid rgba(190,216,204,.28)',
      background: 'rgba(7,14,15,.91)',
      boxShadow: '0 10px 30px rgba(0,0,0,.34)',
      backdropFilter: 'blur(5px)',
      font: '14px/1.45 "Helvetica Neue", Arial, sans-serif',
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
      gap: '10px',
      padding: '10px 12px',
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
      minWidth: '62px',
      padding: '6px 10px',
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
      minHeight: '92px',
      maxHeight: '260px',
      flex: '1 1 auto',
      overflowY: 'auto',
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      overscrollBehavior: 'contain',
    });

    this.chatForm = document.createElement('form');
    Object.assign(this.chatForm.style, {
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: '7px',
      padding: '10px 12px 7px',
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
      padding: '9px 10px',
      border: '1px solid rgba(190,216,204,.3)',
      borderRadius: '9px',
      outline: 'none',
      color: '#f0f5f2',
      background: 'rgba(255,255,255,.06)',
      font: '14px/1.35 "Helvetica Neue", Arial, sans-serif',
    });
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'submit';
    this.sendButton.textContent = 'Send';
    Object.assign(this.sendButton.style, {
      padding: '9px 13px',
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
      padding: '0 12px 9px',
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
    this.onKeyDown = ((base) => (event) => {
      if (event.code === 'KeyN' && !event.repeat && !this.dialogueOpen
        && this.controls.enabled && !isInteractiveTarget(event.target)) {
        this.declineQueued = true;
        event.preventDefault();
        return;
      }
      base(event);
    })(this.onKeyDown);
    window.addEventListener('keydown', this.onKeyDown);
  }

  clear() {
    if (this.dialogueOpen) this.abandonDialogue({ reason: 'population-cleared' });
    this.saveLivingWorldState(true);
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
    this.declineQueued = false;
    this._shownTravellers.clear();
    this.promptEl.style.display = 'none';
    this.debug.status = 'waiting for railway plan';
  }

  /** Switch the local narrative ledger to a different deterministic region. */
  setRegionState({ worldSeed = this.worldSeed, state = null, livingWorldStore = null } = {}) {
    this.clear();
    this.regionStateGeneration++;
    this.requestToken++;
    this.chatHistories.clear();
    this.memoryJobs.clear();
    this.worldSeed = Number(worldSeed) || 1;
    this.livingWorldStore = livingWorldStore || new LivingWorldStateStore({
      worldSeed: this.worldSeed,
      playerId: this.playerId,
      playerName: this.playerName,
    });
    this.memoryStore?.setWorldSeed?.(this.worldSeed, { migrateLegacy: false });
    this.worldState = state || this.livingWorldStore.load() || createLivingWorldState({
      worldSeed: this.worldSeed,
      playerId: this.playerId,
      playerName: this.playerName,
    });
    this.features = normalizeLivingWorldFeatures(this.worldState.features);
    this.worldState.features = { ...this.features };
    this.commitmentsEnabled = this.features.commitmentsEnabled;
    if (this.debug) {
      this.debug.commitmentsEnabled = this.features.commitmentsEnabled;
      this.debug.consequencesEnabled = this.features.consequencesEnabled;
      this.debug.socialMemoryEnabled = this.features.socialMemoryEnabled;
      this.debug.rumorExchangeEnabled = this.features.rumorExchangeEnabled;
      this.debug.intentPropsEnabled = this.features.intentPropsEnabled;
      this.debug.npcInitiationEnabled = this.features.npcInitiationEnabled;
    }
    registerLivingWorldEntity(this.worldState, {
      id: this.playerId, kind: 'player', name: this.playerName, role: 'traveller',
    });
    this.navGraph = null;
    this.plan = null;
    this.stationRosterProvider = null;
    this.stateSaveElapsed = 0;
    this.debug.status = 'waiting for railway plan';
    return this.worldState;
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
    for (const actor of this.actors) {
      this.resolveJourneyHome(actor);
      this.registerActorState(actor);
      this.restoreActorCommitment(actor);
    }
  }

  setRouteActionAnchors(edges = []) {
    let markers = 0;
    let streams = 0;
    for (const edge of edges) {
      if (markers < 24 && Number.isFinite(edge?.curve?.startX)) {
        registerActionAnchor(this.worldState, {
          id: `anchor:marker:${edge.id}`, kind: 'trail-marker',
          x: edge.curve.startX, z: edge.curve.startZ, locationKey: edge.fromKey, capacity: 2,
        });
        markers++;
      }
      for (let i = 0; i < (edge?.fords || []).length && streams < 24; i++) {
        const ford = edge.fords[i];
        if (ford.kind !== 'ford') continue;
        registerActionAnchor(this.worldState, {
          id: `anchor:stream:${edge.id}:${i}`, kind: 'stream',
          x: ford.x - (ford.tangentX || 0) * 1.5,
          z: ford.z - (ford.tangentZ || 0) * 1.5,
          locationKey: edge.fromKey, capacity: 1,
        });
        streams++;
      }
      if (markers >= 24 && streams >= 24) break;
    }
    return { markers, streams };
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
    const entity = this.worldState.entities[actor.identity.id];
    if (entity) {
      entity.homeKey ||= bestKey;
      entity.locationKey ||= bestKey;
    }
  }

  registerActorState(actor) {
    const existing = this.worldState.entities[actor.identity.id];
    // Canonical duty actors already belong to a household. Their authored
    // station role is presentation/activity data, never a replacement for the
    // durable occupation, residence, or current-location records.
    const entity = actor.canonicalDuty || actor.canonicalMobility
      ? existing
      : registerLivingWorldEntity(this.worldState, {
        id: actor.identity.id,
        kind: 'npc',
        name: actor.identity.name,
        role: actor.identity.role,
        stationId: actor.station.id,
        homeKey: existing?.homeKey || actor.journey?.homeKey || null,
        locationKey: existing?.locationKey || actor.journey?.homeKey || null,
        inTransit: existing?.inTransit || false,
        legacyMemoryMigrated: existing?.legacyMemoryMigrated || false,
      });
    if (!entity) throw new RangeError(`Missing canonical station resident ${actor.identity.id}.`);
    if (this.features.socialMemoryEnabled && !entity.legacyMemoryMigrated) {
      migrateLegacyNpcMemory(
        this.worldState,
        actor.identity.id,
        this.memoryStore.load(actor.identity.id),
        { nowHour: this.worldState.clock.worldHours },
      );
      entity.legacyMemoryMigrated = true;
      this.worldState.revision++;
    }
    if (this.features.intentPropsEnabled && !itemsForOwner(this.worldState, actor.identity.id).length) {
      const kind = ({ case: 'parcel', basket: 'basket', lantern: 'lantern', staff: 'walking-stick', book: 'map', satchel: 'boot-kit' })[actor.identity.accessory];
      if (kind) createItem(this.worldState, {
        id: `item:${actor.identity.id}:signature`, kind, ownerId: actor.identity.id,
        purpose: actor.journey ? 'commitment' : 'ambient', condition: 'usable',
      });
    }
    return entity;
  }

  restoreActorCommitment(actor) {
    if (!this.commitmentsEnabled || !actor.journey || !this.navGraph) return null;
    const commitment = openCommitmentForActor(this.worldState, actor.identity.id);
    if (!commitment) {
      const entity = this.worldState.entities[actor.identity.id];
      if (entity) entity.inTransit = false;
      return null;
    }
    if (commitment.state === COMMITMENT_STATE.active && commitment.progress) {
      if (restoreCommitmentJourney(commitment, actor.journey, this.navGraph)) {
        actor.roaming = true;
        this.worldState.entities[actor.identity.id].inTransit = true;
      }
    } else if (commitment.state === COMMITMENT_STATE.planned) {
      if (activateCommitment(commitment, actor.journey, this.navGraph)) {
        actor.roaming = true;
        this.worldState.entities[actor.identity.id].inTransit = true;
      }
    }
    return commitment;
  }

  ensureActorCommitment(actor) {
    if (!this.commitmentsEnabled || !actor.journey || !this.navGraph) return null;
    let commitment = openCommitmentForActor(this.worldState, actor.identity.id);
    if (commitment?.state === COMMITMENT_STATE.blocked) {
      const targetEntity = this.worldState.entities[commitment.target.id];
      const targetLocationKey = targetEntity && !targetEntity.inTransit
        ? targetEntity.locationKey || null
        : null;
      retryBlockedCommitment(commitment, {
        nowHour: this.worldState.clock.worldHours,
        targetLocationKey,
      });
    }
    commitment = openCommitmentForActor(this.worldState, actor.identity.id);
    if (!commitment) {
      commitment = planCommitment(this.worldState, actor, this.navGraph, {
        nowHour: this.worldState.clock.worldHours,
      });
    }
    if (commitment?.state === COMMITMENT_STATE.planned
      && activateCommitment(commitment, actor.journey, this.navGraph)) {
      actor.roaming = true;
      this.worldState.entities[actor.identity.id].inTransit = true;
    }
    return commitment;
  }

  handleJourneyTransitions(actor) {
    for (const transition of drainJourneyTransitions(actor.journey)) {
      const entity = this.worldState.entities[actor.identity.id];
      if (entity && transition.destinationKey) {
        entity.locationKey = transition.destinationKey;
        entity.inTransit = false;
      }
      if (this.features.consequencesEnabled) {
        resolveCommitmentArrival(this.worldState, transition, {
          nowHour: this.worldState.clock.worldHours,
        });
      }
      const group = groupForActor(this.worldState, actor.identity.id);
      if (group && group.leaderId === actor.identity.id) {
        group.state = GROUP_STATE.splitting;
        group.episode = 'split';
        group.updatedAtHour = this.worldState.clock.worldHours;
        for (const memberId of group.memberIds) {
          const member = this.actors.find((entry) => entry.identity.id === memberId);
          if (member && member !== actor) {
            member.roaming = true;
            member.journey.x = actor.journey.x;
            member.journey.z = actor.journey.z;
            const memberEntity = this.worldState.entities[memberId];
            if (memberEntity) { memberEntity.locationKey = transition.destinationKey; memberEntity.inTransit = false; }
          }
        }
      }
    }
  }

  saveLivingWorldState(force = false) {
    if (!force && this.stateSaveElapsed < 1) return false;
    for (const actor of this.actors) {
      const commitment = openCommitmentForActor(this.worldState, actor.identity.id);
      if (commitment?.state === COMMITMENT_STATE.active && isTravelling(actor.journey)) {
        syncCommitmentProgress(commitment, actor.journey);
      }
    }
    this.stateSaveElapsed = 0;
    return this.livingWorldStore.save(this.worldState);
  }

  refreshLivingWorldDebug() {
    const commitment = this.activeNpc
      ? openCommitmentForActor(this.worldState, this.activeNpc.identity.id)
      : null;
    this.debug.commitment = commitment
      ? `${commitment.kind} · ${commitment.state} · ${commitment.destination.key}`
      : 'none selected';
    const memoryCount = Object.values(this.worldState.memories)
      .reduce((sum, entries) => sum + (entries?.length || 0), 0);
    this.debug.ledger = `${this.worldState.events.length} events · `
      + `${Object.keys(this.worldState.relationships).length} relationships · `
      + `${memoryCount} memories · ${this.worldState.metrics?.rumorTransfers || 0} rumors`;
    const latestRumor = this.worldState.rumorLog?.at(-1);
    this.debug.rumor = latestRumor
      ? `${latestRumor.transfers.length} shared · ${latestRumor.rejections.length} rejected · ${latestRumor.conversationId}`
      : 'no exchanges';
  }

  setLivingWorldFeatures(changes = {}) {
    const previous = { ...this.features };
    const next = normalizeLivingWorldFeatures({ ...this.features, ...changes });
    try { this.onBeforeFeaturesChanged?.({ previous, next, changes: { ...changes } }); } catch {
      // Feature controls must remain recoverable even if an optional consumer
      // cannot complete its visual handoff.
    }
    this.features = next;
    this.worldState.features = { ...this.features };
    this.commitmentsEnabled = this.features.commitmentsEnabled;
    Object.assign(this.debug, this.features);
    this.worldState.revision++;
    this.saveLivingWorldState(true);
    try { this.onFeaturesChanged?.({ previous, next: { ...this.features }, changes: { ...changes } }); } catch {
      // State remains authoritative; optional renderers can reconcile next frame.
    }
    return { ...this.features };
  }

  loadPlaytestVignette(name) {
    const actors = this.actors.filter((actor) => actor.avatar?.root);
    if (!actors.length) {
      this.debug.playtestStatus = 'wait for residents to spawn';
      return null;
    }
    const index = Math.max(0, NPC_PLAYTEST_VIGNETTES.indexOf(name));
    let actor = actors[index % actors.length];
    if (name === 'travelling pair') actor = actors.find((entry) => entry.journey) || actor;
    const partner = actors.find((entry) => entry !== actor && entry.station.id === actor.station.id
      && entry.journey && !groupForActor(this.worldState, entry.identity.id));
    for (const [id, item] of Object.entries(this.worldState.projections.items || {})) {
      if (id.startsWith('item:playtest:')) delete this.worldState.projections.items[id];
    }
    for (const episode of Object.values(this.worldState.interactions || {})) {
      if (episode.state === 'pending') episode.state = 'expired';
    }
    for (const action of Object.values(this.worldState.actions || {})) {
      if (action.playtest && !['completed', 'interrupted', 'expired'].includes(action.state)) {
        advanceSituatedAction(this.worldState, action.id, { interruptedBy: 'next-playtest-vignette' });
      }
    }
    for (const group of Object.values(this.worldState.groups || {})) {
      if (group.playtest && group.state !== GROUP_STATE.dissolved) group.state = GROUP_STATE.dissolved;
    }
    const currentAction = activeActionForActor(this.worldState, actor.identity.id);
    if (currentAction) advanceSituatedAction(this.worldState, currentAction.id, { interruptedBy: 'playtest-vignette' });
    const currentGroup = groupForActor(this.worldState, actor.identity.id);
    if (currentGroup) currentGroup.state = GROUP_STATE.dissolved;

    const addProp = (kind, condition = 'usable') => createItem(this.worldState, {
      id: `item:playtest:${kind}`, kind, ownerId: actor.identity.id,
      purpose: 'handoff', condition,
    });
    let fixture = null;
    if (name === 'letter delivery') fixture = addProp('letter', 'sealed');
    if (name === 'parcel journey') fixture = addProp('parcel', 'wrapped');
    if (name === 'repair work') {
      addProp('tools');
      fixture = planSituatedAction(this.worldState, {
        actorId: actor.identity.id, kind: 'repair-site', itemKinds: ['tools'],
        position: this.actorPosition(actor), maxDistance: 80,
      });
    }
    if (name === 'trade offer') {
      addProp('basket', 'full');
      fixture = createInteractionEpisode(this.worldState, {
        actorId: actor.identity.id, kind: 'offer-trade', reason: 'a basket of goods to exchange',
        evidence: { provenance: 'observed', itemId: 'item:playtest:basket' },
      }, { nowHour: this.worldState.clock.worldHours });
    }
    if (name === 'travelling pair' && actor.journey && partner) {
      this.ensureActorCommitment(actor);
      fixture = createTravelGroup(this.worldState, {
        memberIds: [actor.identity.id, partner.identity.id], leaderId: actor.identity.id, episode: 'walk',
      });
    }
    if (name === 'map consultation') {
      addProp('map');
      fixture = planSituatedAction(this.worldState, {
        actorId: actor.identity.id, kind: 'consult-map', itemKinds: ['map'],
        position: this.actorPosition(actor), maxDistance: 80,
      });
    }
    if (name === 'waiting for train') {
      addProp('lantern');
      fixture = planSituatedAction(this.worldState, {
        actorId: actor.identity.id, kind: 'wait-train', itemKinds: ['lantern'], facts: { trainDue: true },
        position: this.actorPosition(actor), maxDistance: 80,
      });
    }
    if (fixture && typeof fixture === 'object') fixture.playtest = true;
    if (fixture?.anchorId && !actor.roaming) {
      const anchor = this.worldState.actionAnchors[fixture.anchorId];
      if (anchor) {
        const dx = anchor.x - actor.station.x;
        const dz = anchor.z - actor.station.z;
        requestVisit(actor.wander, dx * actor.frame.tx + dz * actor.frame.tz, dx * actor.frame.rx + dz * actor.frame.rz);
      }
    }
    this.activeNpc = actor;
    this.station = actor.station;
    const position = this.actorPosition(actor);
    this.controls.placeAt(position.x, actor.groundY, position.z + 3.5);
    this.debug.playtestStatus = fixture ? `${name} ready · ${actor.identity.name}` : `${name} unavailable`;
    this.worldState.revision++;
    return fixture;
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
  advanceJourneys(dt, hours, player) {
    for (const actor of this.actors) {
      if (!actor.journey) continue;
      if (this.features.situatedActionsEnabled && activeActionForActor(this.worldState, actor.identity.id)) continue;
      const group = this.features.travelGroupsEnabled ? groupForActor(this.worldState, actor.identity.id) : null;
      if (group && group.leaderId !== actor.identity.id && group.state !== GROUP_STATE.dissolved) {
        const leader = this.actors.find((entry) => entry.identity.id === group.leaderId);
        if (leader?.journey) {
          const offset = formationOffset(group, actor.identity.id);
          actor.roaming = leader.roaming;
          // Formation offsets rotate with the leader, but followers do not.
          // Move toward the rotated slot along a bounded breadcrumb step. The
          // old hard assignment shifted the first follower ~1.4m in one frame
          // at a right-angle turn—small enough to evade the former teleport
          // threshold and large enough to destroy both planted contacts.
          advanceFormationFollower(actor.journey, leader.journey, offset, dt);
          continue;
        }
      }
      if (group && group.leaderId === actor.identity.id && group.state === GROUP_STATE.paused) continue;
      // Walking away mid-sentence is worse than arriving late.
      if (actor.conversation || (this.dialogueOpen && this.activeNpc === actor)) continue;
      // Someone who has stopped to look at the player is not covering ground.
      // Resolved here rather than in updateActor because a traveller must react
      // whether or not it is close enough to be drawn — otherwise it walks
      // straight past anyone standing outside render range.
      if (actor.encounter?.pausing) continue;
      if (isTravelling(actor.journey)) {
        advanceJourney(actor.journey, {
          dt,
          hours: 0,
          graph: this.navGraph,
          worldHour: this.worldState.clock.worldHours,
          allowAutonomousDeparture: !this.commitmentsEnabled,
        });
        this.handleJourneyTransitions(actor);
      } else {
        advanceJourney(actor.journey, {
          dt: 0,
          hours,
          graph: this.navGraph,
          worldHour: this.worldState.clock.worldHours,
          allowAutonomousDeparture: !this.commitmentsEnabled,
        });
        if (this.commitmentsEnabled && actor.journey.loiterLeft <= 0) {
          this.ensureActorCommitment(actor);
        }
      }
      const commitment = openCommitmentForActor(this.worldState, actor.identity.id);
      if (commitment?.state === COMMITMENT_STATE.active && isTravelling(actor.journey)) {
        syncCommitmentProgress(commitment, actor.journey);
      }
      if (actor.journey.phase !== JOURNEY_PHASE.loiter) actor.roaming = true;
    }
    advanceRepairJobs(this.worldState, this.worldState.clock.worldHours);
    void player;
  }

  /**
   * How each traveller is reacting to the player this frame.
   *
   * Runs for everyone, before culling, for the same reason journeys do: the
   * decision to stop or walk on belongs to the traveller, not to whether the
   * renderer happens to be drawing them.
   */
  advanceEncounters(dt, player) {
    for (const actor of this.actors) {
      if (!actor.encounter) continue;
      const position = this.actorPosition(actor);
      const distance = Math.hypot(position.x - player.x, position.z - player.z);
      const talking = this.dialogueOpen && this.activeNpc === actor;
      const reaction = advanceEncounter(actor.encounter, dt, {
        distance,
        travelling: isTravelling(actor.journey),
        talking,
      });
      actor.encounter.pausing = reaction.pausing;
      actor.encounter.facing = reaction.facing;
      actor.encounter.noticeAmount = reaction.notice;
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

  updateAgency(dt, player) {
    this.agencyTimer -= dt;
    advanceInteractions(this.worldState, this.worldState.clock.worldHours);
    for (const group of Object.values(this.worldState.groups || {})) {
      if (group.state === GROUP_STATE.forming) {
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:rendezvous`, type: 'group.rendezvous',
        }, { nowHour: this.worldState.clock.worldHours });
        continue;
      }
      const leader = this.actors.find((entry) => entry.identity.id === group.leaderId);
      const edge = leader?.journey?.route?.legs?.[leader.journey.legIndex]?.edge;
      const risk = routeRiskScore({
        ford: (edge?.fordCount || 0) > (edge?.bridgeCount || 0), grade: Math.abs(edge?.meanGrade || 0),
        storm: /storm/i.test(leader
          ? (this.getAgencyContext?.(this.actorPosition(leader), leader.station)?.weather || '')
          : ''),
        night: this.worldState.clock.worldHours % 24 < 5 || this.worldState.clock.worldHours % 24 > 21,
      });
      if (leader?.journey) group.progress = journeyProgress(leader.journey);
      if (group.state === GROUP_STATE.together && group.episode === 'walk' && risk >= 0.45) {
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:risk:${leader?.journey?.legIndex || 0}`, type: 'group.risk-entered', riskScore: risk,
        }, { nowHour: this.worldState.clock.worldHours });
        continue;
      } else if (group.episode === 'accompany-risk' && risk < 0.25) {
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:risk-cleared:${leader?.journey?.legIndex || 0}`, type: 'group.risk-cleared',
        }, { nowHour: this.worldState.clock.worldHours });
        continue;
      }
      if (group.state === GROUP_STATE.together && group.episode === 'walk'
        && group.progress >= 0.35 && !group.argumentSeen) {
        group.argumentSeen = true;
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:argument`, type: 'group.argument-started',
        }, { nowHour: this.worldState.clock.worldHours });
        continue;
      }
      if (group.state === GROUP_STATE.paused && group.episode === 'argue'
        && this.worldState.clock.worldHours >= group.argumentEndsAtHour) {
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:argument-resolved`, type: 'group.argument-resolved',
          split: group.memberIds.length > 2,
        }, { nowHour: this.worldState.clock.worldHours });
        continue;
      }
      if (group.state === GROUP_STATE.splitting
        && this.worldState.clock.worldHours - (group.updatedAtHour || 0) >= 0.02) {
        applyGroupEpisodeEvent(this.worldState, group.id, {
          id: `event:${group.id}:split-completed`, type: 'group.split-completed',
        }, { nowHour: this.worldState.clock.worldHours });
        for (const memberId of group.memberIds) releaseActivity(this.activityArbiter, memberId, 'group');
      }
    }
    if (this.features.situatedActionsEnabled) for (const action of Object.values(this.worldState.actions || {})) {
      if (['completed', 'interrupted', 'expired'].includes(action.state)) continue;
      const actor = this.actors.find((entry) => entry.identity.id === action.actorId);
      const anchor = this.worldState.actionAnchors[action.anchorId];
      if (!actor || !anchor) continue;
      const position = this.actorPosition(actor);
      const agency = this.getAgencyContext?.(position, actor.station, actor) || {};
      const ownedKinds = itemsForOwner(this.worldState, actor.identity.id).map((item) => item.kind);
      advanceSituatedAction(this.worldState, action.id, {
        hours: dt / 3600, distance: Math.hypot(position.x - anchor.x, position.z - anchor.z),
        interruptedBy: this.busyWithPlayer(actor) ? 'dialogue' : null,
        nowHour: this.worldState.clock.worldHours,
        facts: { ...agency, anchorEnabled: anchor.enabled !== false }, itemKinds: ownedKinds,
      });
      if (['completed', 'interrupted', 'expired'].includes(action.state)) releaseActivity(this.activityArbiter, actor.identity.id, 'situated');
    }
    if (this.agencyTimer > 0) return;
    this.agencyTimer = 4;
    if (this.features.travelGroupsEnabled) {
      const candidates = this.actors.filter((actor) => actor.journey && !groupForActor(this.worldState, actor.identity.id)
        && actor.journey.phase === JOURNEY_PHASE.loiter && !this.busyWithPlayer(actor));
      for (const actor of candidates) {
        const companionLimit = 1 + (((actor.identity.seed || 0) + Math.floor(this.worldState.clock.worldHours)) & 1);
        const companions = candidates.filter((other) => other !== actor && other.station.id === actor.station.id).slice(0, companionLimit);
        if (companions.length) {
          this.ensureActorCommitment(actor);
          const group = createTravelGroup(this.worldState, { memberIds: [actor.identity.id, ...companions.map((entry) => entry.identity.id)], leaderId: actor.identity.id, episode: 'meet' });
          if (group) {
            claimActivity(this.activityArbiter, actor.identity.id, 'group');
            for (const companion of companions) claimActivity(this.activityArbiter, companion.identity.id, 'group');
          }
          break;
        }
      }
    }
    if (this.features.situatedActionsEnabled) {
      for (const actor of this.actors.filter((entry) => !entry.conversation
        && (!entry.roaming || isTravelling(entry.journey)))) {
        if (activeActionForActor(this.worldState, actor.identity.id)) continue;
        const items = itemsForOwner(this.worldState, actor.identity.id).map((item) => item.kind);
        const agency = this.getAgencyContext?.(this.actorPosition(actor), actor.station, actor) || {};
        const candidatesForActor = situatedActionCandidatesFor(this.worldState, actor, agency, items);
        let action = null;
        for (const candidate of candidatesForActor) {
          action = planSituatedAction(this.worldState, {
            ...candidate, itemKinds: items, facts: agency,
            position: this.actorPosition(actor), maxDistance: actor.roaming ? 1.5 : 60,
          });
          if (action) break;
        }
        if (!action) continue;
        if (action && claimActivity(this.activityArbiter, actor.identity.id, 'situated').accepted) {
          const anchor = this.worldState.actionAnchors[action.anchorId];
          const dx = anchor.x - actor.station.x;
          const dz = anchor.z - actor.station.z;
          requestVisit(actor.wander, dx * actor.frame.tx + dz * actor.frame.tz, dx * actor.frame.rx + dz * actor.frame.rz);
        } else if (action) {
          advanceSituatedAction(this.worldState, action.id, { interruptedBy: 'higher-priority-activity' });
        }
        break;
      }
    }
    if (this.features.npcInitiationEnabled && !pendingInteraction(this.worldState) && this.activeNpc?.distance < 11) {
      const context = this.context();
      const actorId = this.activeNpc.identity.id;
      const items = itemsForOwner(this.worldState, actorId);
      const commitment = openCommitmentForActor(this.worldState, actorId);
      const relationship = this.worldState.relationships[`${actorId}|${this.playerId}`];
      const negativeObserved = (this.worldState.memories[actorId] || []).find((memory) =>
        memory?.provenance === 'observed' && memory?.subject?.id === this.playerId
        && /(?:confront|broken|harm|theft|betray|accus)/i.test(`${memory.predicate} ${memory.summary}`));
      const candidate = interactionCandidateFor(this.worldState, this.activeNpc, {
        weather: context?.weather || '',
        raining: /rain|shower/i.test(context?.weather || ''),
        storm: /storm/i.test(context?.weather || ''),
        shelterAnchorId: `anchor:${this.activeNpc.station.id}:shelter`,
        damagedEquipment: items.find((item) => item.kind === 'damaged-equipment'),
        needsHelp: commitment?.state === COMMITMENT_STATE.blocked,
        tradeItem: items.find((item) => ['basket', 'parcel'].includes(item.kind)),
        metPlayerBefore: (relationship?.familiarity || 0) > 0 || this.readEncounterCount(this.activeNpc) > 0,
        relationshipEventId: relationship?.lastEventId || null,
        destinationKey: commitment?.destination?.key || this.activeNpc.journey?.destKey || null,
        routeUncertain: !!this.activeNpc.journey,
        commitmentId: commitment?.id || null,
        confrontationEvidence: negativeObserved ? {
          provenance: 'observed', memoryId: negativeObserved.id,
          originEventId: negativeObserved.originEventId,
        } : null,
      });
      if (candidate) createInteractionEpisode(this.worldState, candidate, { nowHour: this.worldState.clock.worldHours });
    }
    void player;
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
      if (this.commitmentsEnabled) {
        this.ensureActorCommitment(actor);
      } else {
        advanceJourney(actor.journey, { dt: 0, hours: 0.01, graph: this.navGraph });
      }
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
      const frame = stationFrame(station);
      for (const [kind, along, across] of [['platform', 0, 0], ['shelter', 0, STATION_LAYOUT.mainAcross], ['repair-site', -4, STATION_LAYOUT.mainAcross], ['map-point', 4, STATION_LAYOUT.mainAcross], ['trail-marker', STATION_LAYOUT.halfLength - 3, STATION_LAYOUT.mainAcross]]) {
        registerActionAnchor(this.worldState, {
          id: `anchor:${station.id}:${kind}`, kind,
          x: station.x + frame.tx * along + frame.rx * across,
          z: station.z + frame.tz * along + frame.rz * across,
          locationKey: station.id, capacity: kind === 'shelter' ? 4 : 2,
        });
      }
      let descriptors;
      if (this.worldState.features?.unifiedNpcMobilityEnabled) {
        let roster = null;
        try { roster = this.stationRosterProvider?.(station, this.worldState) ?? null; } catch { roster = null; }
        // Fail closed: unified mode must never fall back to a second synthetic
        // roster when canonical adoption data is missing or malformed.
        descriptors = canonicalStationDescriptors(
          station, roster, this.worldState, this.worldSeed,
        );
      } else {
        descriptors = createStationPopulation(station, this.worldSeed, {
          count: this.residentsPerStation,
        });
      }
      // Queued rather than built. Draining a few per frame is what keeps a
      // station arriving from costing a visible hitch.
      for (let rosterIndex = 0; rosterIndex < descriptors.length; rosterIndex++) {
        this.pending.push({ station, frame, descriptor: descriptors[rosterIndex], rosterIndex });
      }
    }
    this.debug.status = `${this.pending.length} residents queued`;
  }

  removeActor(actor) {
    if (!actor) return false;
    // Never delete the person the player is mid-conversation with. Canonical
    // duty and mobility churn on a half-hour world bucket — about twenty-nine
    // real seconds — so without this a conversation is routinely deleted out
    // from under the player, taking the dialogue and the pointer lock with it.
    // The removal is owed, not cancelled: it is replayed on the next reconcile
    // after the dialogue closes.
    if (this.isTalkingTo(actor.identity?.id)) {
      this.rosterReconcileDeferred = true;
      return false;
    }
    for (let index = this.conversations.length - 1; index >= 0; index--) {
      const conversation = this.conversations[index];
      if (!conversation.actors.includes(actor)) continue;
      for (const participant of conversation.actors) participant.conversation = null;
      this.conversations.splice(index, 1);
    }
    releaseGrounding(this.grounding, actor.groundKey);
    actor.avatar.dispose();
    const index = this.actors.indexOf(actor);
    if (index >= 0) this.actors.splice(index, 1);
    if (this.activeNpc === actor) this.activeNpc = null;
    return true;
  }

  /** Reconcile a changed canonical duty roster without rebuilding the train plan. */
  reconcileCanonicalStationRosters() {
    if (!this.plan?.stations?.length
      || this.worldState.features?.unifiedNpcMobilityEnabled !== true) return false;
    const desired = new Map();
    for (const station of this.plan.stations) {
      let roster = null;
      try { roster = this.stationRosterProvider?.(station, this.worldState) ?? null; } catch { roster = null; }
      const descriptors = canonicalStationDescriptors(
        station, roster, this.worldState, this.worldSeed,
      );
      const frame = stationFrame(station);
      descriptors.forEach((descriptor, rosterIndex) => {
        if (!desired.has(descriptor.id)) {
          desired.set(descriptor.id, { station, frame, descriptor, rosterIndex });
        }
      });
    }

    let changed = false;
    for (const actor of [...this.actors]) {
      const next = desired.get(actor.identity.id);
      const unchanged = (actor.canonicalDuty || actor.canonicalMobility) && next
        && actor.station.id === next.station.id
        && actor.descriptor.slot === next.descriptor.slot;
      if (unchanged) {
        desired.delete(actor.identity.id);
        continue;
      }
      // The player's conversation partner keeps the body they are talking to.
      // Dropping their pending descriptor as well is what stops the same person
      // being rebuilt in a new slot beside the one still holding the dialogue.
      if (this.isTalkingTo(actor.identity.id)) {
        desired.delete(actor.identity.id);
        this.rosterReconcileDeferred = true;
        continue;
      }
      changed = this.removeActor(actor) || changed;
    }

    const queued = new Set();
    this.pending = this.pending.flatMap((item) => {
      const next = desired.get(item.descriptor.id);
      if (!next || queued.has(item.descriptor.id)) {
        changed = true;
        return [];
      }
      queued.add(item.descriptor.id);
      desired.delete(item.descriptor.id);
      return [next];
    });
    for (const item of desired.values()) {
      this.pending.push(item);
      changed = true;
    }
    this.debug.status = `${this.actors.length} residents · ${this.pending.length} queued`;
    return changed;
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
      canonicalDuty: descriptor.canonicalDuty === true,
      canonicalMobility: descriptor.canonicalMobility === true,
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
      locomotion: createNpcLocomotionState(descriptor.identity.animation.phase / (Math.PI * 2)),
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
    };
    // The first few of each roster travel; the rest keep the station staffed.
    if (!actor.canonicalDuty && !actor.canonicalMobility
      && rosterIndex < this.travellersPerStation) {
      actor.journey = createJourneyState(
        (descriptor.identity.seed ^ 0x7a17e1) >>> 0, null,
        { x: station.x, z: station.z },
      );
      this.resolveJourneyHome(actor);
      actor.encounter = createEncounterState(
        (descriptor.identity.seed ^ 0x2c1b3d) >>> 0,
        sociabilityFor(descriptor.identity),
      );
    } else {
      actor.journey = null;
      actor.encounter = null;
    }
    // True once a traveller has left its platform for the first time. From then
    // on its position comes from the journey even while loitering, because it is
    // loitering at some other landmark now — snapping back to the platform would
    // undo the walk it just made.
    actor.roaming = false;
    // Resolved through the shared budget rather than captured as a constant.
    // A resident on its platform short-circuits before the budget is touched;
    // anything off it is sampled from the same surface the player uses.
    actor.groundHeight = (x = actor.avatar.root.position.x, z = actor.avatar.root.position.z) => groundHeightFor(
      this.grounding, actor.groundKey, x, z,
      { fixedY: actor.platformY, fallback: actor.groundY },
    );
    actor.surfaceQuery = (x, z, atY) => actor.platformY !== null
      ? { y: actor.platformY, normal: [0, 1, 0], supportId: `${actor.station.id}:platform`, surfaceKind: 'platform', walkable: true, edgeDistance: Infinity, stepHeight: 0 }
      : (this.surfaceQuery?.(x, z, atY)
        || { y: actor.groundHeight(x, z), normal: [0, 1, 0], supportId: 'ground', surfaceKind: 'terrain', walkable: true });
    this.actors.push(actor);
    this.registerActorState(actor);
    this.restoreActorCommitment(actor);
  }

  setStationRosterProvider(provider = null) {
    this.stationRosterProvider = typeof provider === 'function' ? provider : null;
  }

  canonicalResidentIdentity(personId) {
    const entity = this.worldState.entities?.[personId];
    if (!entity || entity.kind !== 'npc' || entity.tombstone || !entity.residence) return null;
    const household = this.worldState.households?.[entity.householdId];
    const householdIndex = Math.max(0, household?.memberIds?.indexOf(entity.id) ?? 0);
    return createSettlementResidentIdentity({
      entity,
      state: this.worldState,
      worldSeed: this.worldSeed,
      homeBuildingId: entity.residence.homeBuildingId,
      householdIndex,
    });
  }

  /** Build the same canonical person in a restrained static seated pose. */
  createRailPassengerPresentation({ identity } = {}) {
    if (!identity?.id) return null;
    const avatar = createNpcAvatar(identity, this.assets);
    avatar.root.userData.actorId = identity.id;
    const bones = avatar.rig.bones;
    // The root stays on the carriage floor. Folding each local leg chain puts
    // the hips on the cushion and both feet on the floor without a second NPC
    // geometry system or a per-passenger animation loop.
    bones.hips.position.y *= 0.72;
    for (const side of ['left', 'right']) {
      bones[`${side}Thigh`].rotation.x = -1.28;
      bones[`${side}Shin`].rotation.x = 1.28;
      bones[`${side}Foot`].rotation.x = 0;
      bones[`${side}UpperArm`].rotation.x = -0.18;
      bones[`${side}Forearm`].rotation.x = -0.58;
    }
    avatar.setDetail(0);
    return {
      root: avatar.root,
      seatLocalPosition: { x: 0, y: -1.75, z: 0 },
      dispose: () => avatar.dispose(),
    };
  }

  /** Mount the canonical resident avatar and shared gait for regional walking. */
  createRegionalWalkerPresentation({ identity, resolved } = {}) {
    if (!identity?.id || !resolved) return null;
    const avatar = createNpcAvatar(identity, this.assets);
    avatar.root.userData.actorId = identity.id;
    this.scene.add(avatar.root);
    const locomotion = createNpcLocomotionState(
      identity.animation.phase / (Math.PI * 2),
    );
    const dims = npcWorldDimensions(avatar.dims, identity.proportions);
    const baseHipsY = avatar.rig.bones.hips.position.y;
    const surfaceQuery = this.surfaceQuery || ((x, z, y) => ({
      y, normal: [0, 1, 0], supportId: 'terrain', surfaceKind: 'terrain', walkable: true,
    }));
    const update = ({ resolved: point, dt, distance }) => {
      const root = avatar.root;
      root.position.set(point.x, point.y, point.z);
      root.rotation.y = point.heading;
      root.visible = this.debug.enabled;
      avatar.setDetail(distance);
      avatar.setIntentLoadout?.(
        this.features.intentPropsEnabled
          ? deriveNpcLoadout(this.worldState, identity.id) : {},
      );
      avatar.rig.bones.hips.position.y = baseHipsY;
      if (point.seated || point.mode === 'seated' || point.mode === 'sit') {
        const bones = avatar.rig.bones;
        bones.hips.position.y = baseHipsY * 0.72;
        for (const side of ['left', 'right']) {
          bones[`${side}Thigh`].rotation.x = -1.28;
          bones[`${side}Shin`].rotation.x = 1.28;
          bones[`${side}Foot`].rotation.x = 0;
          bones[`${side}UpperArm`].rotation.x = -0.18;
          bones[`${side}Forearm`].rotation.x = -0.58;
        }
        return;
      }
      const pose = advanceNpcLocomotion(locomotion, {
        dims,
        dt,
        position: [point.x, point.y, point.z],
        heading: point.heading,
        surfaceQuery,
        distance,
      });
      if (pose) avatar.applyPose(pose, point.y);
    };
    update({ resolved, dt: 0, distance: Infinity });
    return { root: avatar.root, update, dispose: () => avatar.dispose() };
  }

  materializedActorIds() {
    return this.actors.map((actor) => actor.identity.id);
  }

  setEnabled(enabled) {
    this.debug.enabled = !!enabled;
    if (!this.debug.enabled) {
      for (const actor of this.actors) actor.avatar.root.visible = false;
      this.promptEl.style.display = 'none';
      this.closeDialogue();
    }
  }

  /** Include actors whose movement/rendering is owned by another world system. */
  setExternalActorsProvider(provider) {
    this.getExternalActors = typeof provider === 'function' ? provider : () => [];
  }

  /**
   * Give the wait for an on-device reply a body.
   *
   * The emote is captured by the caller rather than looked up again on
   * arrival: a reply can land after the conversation has moved on, and ending
   * deliberation on whoever happens to be active then would leave the original
   * speaker thinking forever.
   */
  deliberatingEmote() {
    return this.activeNpc?.emote || null;
  }

  isTalkingTo(actorId) {
    if (!actorId || !this.dialogueOpen) return false;
    // conversationNpcId is the authority: it is the person the transcript and
    // the model session belong to, and it survives an actor object being
    // re-selected underneath an open dialogue.
    return this.conversationNpcId === actorId || this.activeNpc?.identity?.id === actorId;
  }

  /**
   * The person the player is talking to right now, or null.
   *
   * The world's reassignment systems ask this before moving anyone: a
   * conversation is the one commitment the simulation may not overrule.
   */
  dialoguePartnerId() {
    if (!this.dialogueOpen) return null;
    return this.conversationNpcId || this.activeNpc?.identity?.id || null;
  }

  setResidentsPerStation(value) {
    this.residentsPerStation = Math.max(3, Math.min(7, Math.round(value)));
    this.debug.residentsPerStation = this.residentsPerStation;
    const plan = this.plan;
    if (plan) this.setPlan(plan);
  }

  storageKey(actor = this.activeNpc) {
    if (!actor) return '';
    const seed = Number.isFinite(Number(this.worldSeed))
      ? (Math.trunc(Number(this.worldSeed)) >>> 0) : 1;
    return `wander.livingWorld.encounters.${seed}.${actor.identity.id}`;
  }

  legacyStorageKey(actor = this.activeNpc) {
    return actor ? `wander.livingWorld.encounters.${actor.identity.id}` : '';
  }

  readEncounterCount(actor = this.activeNpc) {
    try {
      const key = this.storageKey(actor);
      let raw = localStorage.getItem(key);
      if (raw == null && this.memoryStore?.migrateLegacy) {
        raw = localStorage.getItem(this.legacyStorageKey(actor));
        if (raw != null) localStorage.setItem(key, raw);
      }
      const value = Number.parseInt(raw || '0', 10);
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
    const position = this.activeNpc.avatar?.root?.position || { x: 0, y: 0, z: 0 };
    const identity = this.activeNpc.identity || {
      id: this.activeNpc.actorId || 'npc:unknown', name: 'The resident', role: 'resident',
    };
    // Settlement residents are external actors and do not have a railway
    // station field. Give them a local anchor at their feet so the shared
    // dialogue context builder can still provide one grounded target.
    const station = this.activeNpc.station || {
      id: `resident-anchor:${identity.id}`,
      name: `${identity.name || 'The resident'}'s place`,
      kind: 'settlement',
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
      index: 0,
    };
    let context;
    try {
      context = this.getContext?.(
        station,
        this.encounterCount,
        identity,
        // Distances and bearings belong to whoever is answering, not to the
        // station they happen to be standing on.
        position,
        // A traveller has a journey to speak from; a platform resident does not,
        // and passing null says so plainly.
        this.activeNpc.journey,
        this.navGraph,
      );
    } catch {
      // A streamed guest/settlement projection can be one frame ahead of its
      // context catalog. Keep the conversation usable with a minimal,
      // authoritative local anchor rather than dropping the Talk gesture.
      context = null;
    }
    if (!context) {
      context = {
        npc: {
          id: identity.id,
          name: identity.name || 'The resident',
          role: identity.role || 'resident',
        },
        station: { id: station.id, name: station.name },
        targets: [{
          id: station.id, name: station.name, kind: station.kind || 'settlement',
          distanceM: 0, distancePhrase: 'right here', direction: 'here',
          worldX: station.x, worldZ: station.z,
        }],
        biome: 'unknown country',
        weather: 'changeable weather',
        timeOfDay: 'this hour',
        playerHistory: this.encounterCount > 0
          ? `The traveller has spoken with you ${this.encounterCount} time${this.encounterCount === 1 ? '' : 's'} before.`
          : 'This is the traveller\'s first conversation with you.',
        encounterBand: this.encounterCount === 0 ? 'new' : 'familiar',
        journey: null,
      };
    }
    const npcId = identity.id;
    const social = this.features.socialMemoryEnabled
      ? socialContextFor(this.worldState, npcId, {
        nowHour: this.worldState.clock.worldHours, playerId: this.playerId,
      })
      : { relationshipToPlayer: 'stranger', relevantPeople: [], memories: [] };
    const outcomes = outcomeContextForActor(this.worldState, npcId);
    const remembered = this.memoryStore.load(npcId);
    return {
      ...context,
      memory: {
        ...remembered,
        socialMemories: this.features.socialMemoryEnabled
          ? memoriesFor(this.worldState, npcId, { nowHour: this.worldState.clock.worldHours })
          : [],
      },
      social: { ...social, ...outcomes },
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
    if (this.chatBusy && !this.chatOpeningPending) {
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
    } else if (this.chatOpeningPending) {
      this.chatStatusEl.textContent = 'Waiting for the resident…';
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
      const place = findMentionedTarget([
        ...(this.conversationContext?.targets || []),
        ...(this.conversationContext?.pointPlaces || []),
      ], dialogue.text);
      if (place && Number.isFinite(place.worldX)) {
        this.pointOut(this.activeNpc, place);
      } else {
        pulseDelivery(this.activeNpc.emote);
      }
    }
    this.renderTranscript();
  }

  deliverOpeningFallback(context, token, deliberating) {
    endDeliberation(deliberating);
    if (this.conversationNpcId !== context?.npc?.id
      || !this.dialogueOpen || token !== this.requestToken) return;
    const reply = safeFallbackDialogue(context);
    this.chatSessionId = null;
    this.chatOpeningPending = false;
    this.chatBusy = false;
    const greetingEntry = {
      role: 'assistant', content: reply.text, source: 'authored', speakerId: context.npc.id,
    };
    this.chatHistory.push(greetingEntry);
    this.renderDialogue(reply, 'authored', greetingEntry);
    this.updateChatControls();
    this.focusDialogue();
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
    // If Chrome purged or remounted its on-device model, begin recreation
    // synchronously inside this Talk gesture before any promise yields.
    this.director.resumeFromUserGesture?.();
    claimActivity(this.activityArbiter, this.activeNpc.identity.id, 'dialogue');
    this.dialogueOpen = true;
    const offered = this.features.npcInitiationEnabled ? pendingInteraction(this.worldState) : null;
    if (offered?.actorId === this.activeNpc.identity.id) {
      resolveInteraction(this.worldState, offered.id, 'listen', {
        nowHour: this.worldState.clock.worldHours, playerId: this.playerId,
      });
    }
    this.pointerReleased = false;
    this.resumePending = false;
    this.conversationNpcId = this.activeNpc.identity.id;
    this.conversationContext = context;
    this.chatSessionId = null;
    this.worldConversation = this.features.socialMemoryEnabled
      ? beginPlayerConversation(this.worldState, this.conversationNpcId, {
        nowHour: this.worldState.clock.worldHours, playerId: this.playerId,
      })
      : null;
    this.narrativeConversation = this.features.npcNarrativeGraphRetrievalEnabled
      && context.homeCommunity
      ? createNpcNarrativeConversation({ state: this.worldState, context })
      : null;
    this.chatHistory = [];
    this.chatHistories.set(this.conversationNpcId, this.chatHistory);
    this.dialogueTitleEl.textContent = `${this.activeNpc.identity.name} · ${this.activeNpc.identity.role}`;
    this.chatInput.setAttribute('aria-label', `Message ${this.activeNpc.identity.name}`);
    this.dialogueEl.style.display = 'flex';
    this.recordEncounter();

    this.chatOpeningPending = true;
    this.chatBusy = true;
    this.renderTranscript();
    this.updateChatControls();
    this.onChatOpen();

    const token = ++this.requestToken;
    const deliberating = this.deliberatingEmote();
    beginDeliberation(deliberating);
    this.director.requestChatOpening(context).then(({ reply, source, conversationId }) => {
      endDeliberation(deliberating);
      if (this.conversationNpcId !== context.npc.id) {
        this.director.discardConversation?.(conversationId);
        return;
      }
      if (!this.dialogueOpen || token !== this.requestToken) {
        this.director.discardConversation?.(conversationId);
        return;
      }
      this.chatSessionId = conversationId;
      this.chatOpeningPending = false;
      this.chatBusy = false;
      const greetingEntry = {
        role: 'assistant', content: reply.text, source, speakerId: context.npc.id,
      };
      this.chatHistory.push(greetingEntry);
      this.renderDialogue(reply, source, greetingEntry);
      this.updateChatControls();
      this.focusDialogue();
    }, () => this.deliverOpeningFallback(context, token, deliberating));
  }

  sendMessage() {
    if (!this.dialogueOpen || this.chatBusy || this.resumePending || !this.pointerReleased) return;
    const content = this.chatInput.value.trim().slice(0, 320);
    if (!content) return;
    const context = this.conversationContext;
    if (!context || context.npc.id !== this.conversationNpcId) return;
    this.director.resumeFromUserGesture?.();

    // Heard, before anything is composed. The on-device model can take several
    // seconds, and a nod at the moment of asking is the difference between a
    // pause that reads as thinking and one that reads as a hang.
    if (this.activeNpc) pulseNod(this.activeNpc.emote);
    const history = this.chatHistory;
    history.push({ role: 'user', content, speakerId: this.playerId });
    this.chatInput.value = '';
    this.chatBusy = true;
    this.limitChatHistory(history);
    this.renderTranscript();
    this.updateChatControls();
    const token = ++this.requestToken;
    const npcId = this.conversationNpcId;
    let retrieval = null;
    if (this.features.npcNarrativeGraphRetrievalEnabled && this.narrativeConversation) {
      try {
        retrieval = retrieveNpcConversationNarrative(this.narrativeConversation, {
          state: this.worldState,
          context,
          speakerId: npcId,
          text: content,
          conversationId: this.worldConversation?.id || this.chatSessionId || npcId,
        });
        this.worldState.metrics.narrativeGraphRetrievals =
          (this.worldState.metrics.narrativeGraphRetrievals || 0) + 1;
      } catch { /* malformed or unavailable graph context fails closed */ }
    }
    const deliberating = this.deliberatingEmote();
    beginDeliberation(deliberating);
    this.director.requestChatReply(context, content, this.chatSessionId, retrieval, {
      // The current user turn is prompted separately. Earlier visible turns
      // are the authoritative recipe for rebuilding a purged model session.
      transcript: history.slice(0, -1),
    }).then(({ reply, source }) => {
      endDeliberation(deliberating);
      if (this.chatHistories.get(npcId) !== history) return;
      const replyEntry = { role: 'assistant', content: reply.text, source, speakerId: npcId };
      history.push(replyEntry);
      this.limitChatHistory(history);
      if (!this.dialogueOpen || this.conversationNpcId !== npcId || token !== this.requestToken) return;
      this.chatBusy = false;
      // Through renderDialogue rather than straight to the transcript: that is
      // the one place a line becomes a gesture. Only the greeting used to take
      // this path, so a resident pointed once and then stood perfectly still
      // for the rest of the conversation — no pointing and no delivery nod.
      this.renderDialogue(reply, source, replyEntry);
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
    endDeliberation(this.deliberatingEmote());
    const context = this.conversationContext;
    const npcId = this.conversationNpcId;
    const conversationId = this.chatSessionId;
    const worldConversation = this.worldConversation;
    const regionGeneration = this.regionStateGeneration;
    const transcript = (this.chatHistory || [])
      .map(({ role, content, speakerId, source }) => ({ role, content, speakerId, source }));
    this.dialogueOpen = false;
    this.pointerReleased = false;
    this.resumePending = false;
    this.chatBusy = false;
    this.chatOpeningPending = false;
    this.requestToken++;
    this.dialogueEl.style.display = 'none';
    this.chatInput.value = '';
    this.chatHistories.delete(npcId);
    this.chatHistory = null;
    this.conversationNpcId = '';
    this.conversationContext = null;
    this.chatSessionId = null;
    this.worldConversation = null;
    this.narrativeConversation = null;
    if (npcId) releaseActivity(this.activityArbiter, npcId, 'dialogue');

    if (!context || !npcId || !transcript.length) return;
    if (this.features.socialMemoryEnabled) {
      recordPlayerConversationOutcome(this.worldState, worldConversation, {
        npcId,
        playerId: this.playerId,
        playerTurns: transcript.filter((message) => message.role === 'user').length,
        nowHour: this.worldState.clock.worldHours,
      });
    }
    // Save a deterministic provisional memory immediately so even a very fast
    // return visit can recall the meeting. The edge model refines it in the
    // background using the just-finished conversation session.
    const provisional = fallbackMemorySynthesis(context.memory, context, transcript);
    this.memoryStore.save(npcId, provisional);
    const job = this.director.synthesizeConversation(context, transcript, conversationId)
      .then((memory) => {
        if (regionGeneration !== this.regionStateGeneration) return false;
        const current = this.memoryStore.load(npcId);
        const saved = this.memoryStore.save(npcId, combineNpcMemory(current, memory, npcId));
        if (this.features.npcNarrativeFactPropagationEnabled && context.homeCommunity) {
          try {
            commitNpcConversationNarrative({
              state: this.worldState,
              context,
              transcript,
              synthesis: memory,
              memoryStore: this.memoryStore,
            });
            this.livingWorldStore.save(this.worldState);
          } catch (error) {
            if ('window' in globalThis) console.warn('NPC narrative fact propagation failed closed:', error);
          }
        }
        return saved;
      })
      .finally(() => {
        if (this.memoryJobs.get(npcId) === job) this.memoryJobs.delete(npcId);
      });
    this.memoryJobs.set(npcId, job);
  }

  /**
   * End a conversation the player did not choose to end.
   *
   * `reason` is named at every call site because the visible symptom of a world
   * cause — the dialogue vanishing and the pointer lock going with it — is the
   * same whichever system caused it, and the console is the only place the
   * difference shows. 'escape' is the player's own doing and stays quiet.
   */
  abandonDialogue({ notify = true, reason = 'escape' } = {}) {
    if (!this.dialogueOpen) return;
    if (reason !== 'escape' && 'window' in globalThis) {
      console.warn('[npc dialogue] abandoned by the world', {
        reason, npcId: this.conversationNpcId, turns: this.chatHistory?.length ?? 0,
      });
    }
    this.completeDialogueClose();
    if (notify) this.onChatAbandon();
  }

  closeDialogue() {
    this.abandonDialogue({ reason: 'population-disabled' });
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
  solveGait(actor, motion, dt, talking, actionKind = null, { xr = false } = {}) {
    const root = actor.avatar.root;
    const pose = advanceNpcLocomotion(actor.locomotion, {
      dims: actor.worldDims,
      dt,
      position: [root.position.x, actor.groundY, root.position.z],
      heading: actor.heading,
      surfaceQuery: actor.surfaceQuery,
      distance: actor.distance,
      xr,
      held: talking || !!actor.conversation,
      talking,
      gesturePhase: actor.gestureTime * 1.7,
      actionKind,
    });
    if (!pose) return null;
    const loadout = this.features.intentPropsEnabled ? deriveNpcLoadout(this.worldState, actor.identity.id) : null;
    actor.avatar.setIntentLoadout?.(loadout || {});
    const freeHand = freeGestureHand(loadout);
    actor.avatar.applyPose(pose, actor.groundY, {
      gesture: gestureAmount(actor.emote),
      gestureHand: freeHand || actor.identity.animation.gestureHand,
      point: pointAmount(actor.emote),
      // Landmarks sit out on the country, so the arm reads best a touch above
      // level rather than aimed at the horizon exactly.
      pointPitch: 0.10,
      // Point with the free hand. Somebody carrying a basket raises the other
      // arm; only the case is carried on the left.
      pointHand: freeHand || (HANDHELD_ACCESSORIES.has(actor.identity.accessory)
        ? (actor.identity.accessory === 'case' ? 'right' : 'left')
        : actor.identity.animation.gestureHand),
      actionKind,
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
    // Something in the hand is worth looking down at — but a walking stick is
    // scenery, and a bag over the shoulder is not in view at all.
    const heldLook = HANDHELD_ACCESSORIES.has(actor.identity.accessory)
      ? { yaw: (actor.identity.accessory === 'case' ? -1 : 1) * 0.22, pitch: 0.52 }
      : null;
    const deliberating = talking && deliberationLookAway(actor.emote);
    const gaze = advanceGaze(actor.gaze, dt, {
      player: playerLook,
      neighbour: neighbourLook,
      held: heldLook,
      // Off across whatever the platform faces: the fields, the valley, the
      // weather coming in. The neck clamp turns this into as far round as they
      // can manage, which is what staring out at something looks like.
      vista: actor.vista,
      // Mid-thought the eyes leave the player: down to whatever is in their
      // hands if anything is, otherwise off at nothing. Coming back to the
      // player is what says the answer has arrived.
      lockOn: deliberating ? (heldLook ? 'held' : 'glance')
        : talking ? 'player'
          // A traveller that has stopped for the player is looking AT them, not
          // glancing in their direction between other things.
          : (actor.encounter?.pausing ? 'player' : (partner ? 'neighbour' : null)),
      // A traveller's interest is what the encounter decided. Falling back to
      // pure proximity made everyone equally curious, which is the flat
      // attentiveness that reads as scripted.
      playerInterest: actor.encounter
        ? clamp01(actor.encounter.noticeAmount ?? 0)
        : clamp01(1 - (actor.distance - 3) / 11),
      // Travellers do not use the platform wander, so this read as standing
      // still for the entire length of a journey — and a head that never settles
      // to the horizon while walking is what made them look like they were
      // gliding rather than going somewhere.
      moving: actor.roaming
        ? isTravelling(actor.journey) && !actor.encounter?.pausing
        : actor.wander.speed > WANDER.idleSpeed,
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
      if (convo.exchangeReady && !convo.exchangeDone) {
        if (this.features.socialMemoryEnabled && this.features.rumorExchangeEnabled) {
          exchangeRumors(this.worldState, convo, { nowHour: this.worldState.clock.worldHours });
        }
        convo.exchangeDone = true;
        convo.exchangeReady = false;
      }
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
        const worldConversation = beginNpcConversation(this.worldState, [
          actor.identity.id, close.identity.id,
        ], { nowHour: this.worldState.clock.worldHours });
        const convo = createConversation(actor.identity.seed ^ close.identity.seed, worldConversation);
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
    const situatedAction = activeActionForActor(this.worldState, actor.identity.id);
    const acting = situatedAction?.state === 'acting';
    const working = acting || Object.values(this.worldState.projections.repairJobs).some(
      (job) => job?.workerId === actor.identity.id && job.status === 'in-progress',
    );
    if (!talking && !working) actor.motionTime += dt;
    actor.gestureTime += dt;
    const motion = sampleNpcMotion(
      actor.identity,
      actor.motionTime,
      { talking: talking || working, gestureElapsed: actor.gestureTime },
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
    const held = talking || working || !!actor.conversation;
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
      // A culled actor has no visible reason to retain old world-space feet.
      // Reinitialize on re-entry; updating only x/z left contacts kilometres
      // behind while making the displacement check think nothing happened.
      actor.locomotion.x = root.position.x;
      actor.locomotion.y = root.position.y;
      actor.locomotion.z = root.position.z;
      actor.locomotion.initialized = false;
      actor.locomotion.pose = null;
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
    } else if (actor.roaming && actor.encounter?.facing) {
      // Stopped for the player: turn and face them. Only ever while stopped —
      // turning the body mid-stride drags the planted foot, which is the same
      // rule the platform wander follows.
      desiredHeading = Math.atan2(
        player.x - root.position.x,
        player.z - root.position.z,
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
    // depends on where the body has ended up facing. A traveller's is the road
    // ahead: the platform's outward direction is meaningless once they are ten
    // kilometres from the station that defined it.
    const vistaHeading = actor.roaming && isTravelling(actor.journey)
      ? actor.journey.heading
      : actor.vistaHeading;
    const outward = vistaHeading - actor.heading;
    actor.vista.yaw = Math.atan2(Math.sin(outward), Math.cos(outward));

    actor.poseTimer -= dt;
    actor.poseElapsed += dt;
    const near = actor.distance <= FULL_ANIMATION_RANGE;
    // Contact state advances every rendered frame. Throttling the whole pose
    // while the root travelled made distant station residents exhibit the same
    // dragging legs settlement residents did; only gaze is safe to throttle.
    this.solveGait(actor, motion, dt, talking || working, acting ? situatedAction.kind : null, { xr });
    if (near || actor.poseTimer <= 0) {
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
    // Pay back any roster change that was held off while the player was
    // talking. Here rather than inside the dialogue close so the plan and the
    // actor list are in their settled frame state when it lands.
    if (this.rosterReconcileDeferred && !this.dialogueOpen) {
      this.rosterReconcileDeferred = false;
      this.reconcileCanonicalStationRosters();
    }
    const simulationStarted = globalThis.performance?.now?.() ?? Date.now();
    advanceLivingWorldClock(this.worldState.clock, { dt, hours, active });
    this.stateSaveElapsed += Math.max(0, dt);
    // Every ground sample after this counts against one shared ceiling.
    beginGroundingFrame(this.grounding);
    if (!this.actors.length) return;
    if ((!active || !this.debug.enabled) && this.dialogueOpen) this.abandonDialogue({ reason: 'population-inactive' });
    this.updateConversations(dt);

    // Journeys advance whether or not anyone is watching. This is the whole
    // point of a traveller being a position and an intent: it costs an arc
    // position and no rig work, so there is no reason to freeze it, and freezing
    // it means the world only moves where the player is already looking.
    // Reactions first: whether a traveller has stopped decides whether its
    // journey advances at all this frame.
    this.advanceEncounters(dt, player);
    this.advanceJourneys(dt, hours, player);
    this.updateAgency(dt, player);
    const simulationElapsed = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - simulationStarted);
    this.worldState.metrics.simulationMs += simulationElapsed;
    this.worldState.metrics.simulationSamples++;
    this.saveLivingWorldState();
    this.refreshLivingWorldDebug();

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
          actor.locomotion.x = actor.journey.x;
          actor.locomotion.y = actor.avatar.root.position.y;
          actor.locomotion.z = actor.journey.z;
          actor.locomotion.initialized = false;
          actor.locomotion.pose = null;
        }
        continue;
      }
      const distance = this.updateActor(actor, player, dt, { xr });
      if (actor.identity.interactive && (!nearest || distance < nearest.distance)) {
        nearest = { actor, distance };
      }
    }
    // Settlement residents own their own routes and animation, but participate
    // in the same nearest-NPC prompt and dialogue/memory flow as station actors.
    for (const actor of this.getExternalActors() || []) {
      const root = actor?.avatar?.root;
      if (!root?.visible || !actor.identity?.interactive) continue;
      actor.distance = Math.hypot(root.position.x - player.x, root.position.z - player.z);
      if (!nearest || actor.distance < nearest.distance) nearest = { actor, distance: actor.distance };
    }
    if (!nearest || !this.debug.enabled) {
      if (this.dialogueOpen) this.abandonDialogue({ reason: 'no-npc-in-range' });
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
      if (this.dialogueOpen) this.abandonDialogue({ reason: 'partner-replaced' });
      this.activeNpc = selected;
      this.station = selected.station;
      this.encounterCount = this.readEncounterCount(selected);
    }

    const canTalk = active && distance <= TALK_RANGE;
    this.promptEl.style.display = canTalk && !this.dialogueOpen ? 'block' : 'none';
    if (canTalk && !this.dialogueOpen) {
      const offer = this.features.npcInitiationEnabled ? pendingInteraction(this.worldState) : null;
      this.promptEl.innerHTML = offer?.actorId === this.activeNpc.identity.id
        ? `${interactionLine(offer, this.activeNpc.identity.name)} · <b>T</b> respond · <b>N</b> decline`
        : `<b>T</b> talk to ${this.activeNpc.identity.name} · ${titleCase(this.activeNpc.identity.role)}`;
    }

    const talkPressed = this.talkQueued;
    this.talkQueued = false;
    const declinePressed = this.declineQueued;
    this.declineQueued = false;
    if (canTalk && declinePressed) {
      const offer = this.features.npcInitiationEnabled ? pendingInteraction(this.worldState) : null;
      if (offer?.actorId === this.activeNpc.identity.id) resolveInteraction(this.worldState, offer.id, 'decline', {
        nowHour: this.worldState.clock.worldHours, playerId: this.playerId,
      });
    }
    if (canTalk && talkPressed) this.talk();

    if (this.dialogueOpen && distance > TALK_RANGE * 2) this.abandonDialogue({ reason: 'partner-out-of-range' });
  }
}

// Keep the earlier exported name available for code or bookmarks created by
// the first station-keeper prototype.
export { LivingWorldPopulation as LivingWorldStationKeeper };
