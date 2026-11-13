import * as THREE from 'three';
import { CourierController, initializeCourier } from './courier.mjs';
import { COURIER_JOBS, COURIER_PENNANTS, COURIER_PREFIX, COURIER_ROLES, courierCompass, courierWalkTime } from './couriercontent.mjs';
import { handleCourierUtterance } from './courierdialogue.mjs';
import { NotebookStore } from './notebook.mjs';
import { CourierUI } from './courierui.js';
import { paintPostedVillageMap, revealCourierPlace } from './couriermap.mjs';
import { CourierXRPanel } from './courierxr.js';
import { settlementsAround } from './settlementplacement.mjs';
import { cachedSettlementPlan } from './settlementspatial.mjs';
import { activateSettlementResidents } from './npcresidenceregistry.mjs';
import { createSettlementResidentIdentity } from './npcresidentidentity.mjs';
import { settlementOrigin } from './settlementorigin.mjs';
import { applyArrival, planArrival } from './courierdirector.mjs';
import { STORY_FIRST } from './courierstory.mjs';
import { findRoute } from './npcnavgraph.mjs';
import { trailFrameAtArc } from './trails.js';
import { worldGenerationScope } from './worldgeneration.mjs';
import { STATION_LAYOUT } from './railstation.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export class CourierRuntime {
  constructor(options) {
    Object.assign(this, options); this.prepared = false; this.preparing = null;
    this.roots = []; this.sourcePositions = new Map(); this.jumpAirborne = false;
    this.noticeBoards = new Map(); this.deliveryProps = new Map(); this.flowerPots = [];
    this.welcomeOpened = false; this.firstWelcomePending = false;
    this.fingerposts = []; this.nameSignSpots = []; this.stationSpots = []; this.promptText = null;
    this.controller = new CourierController({
      getState: () => this.population.worldState, getPlayer: () => this.controls.rig.position,
      getNpcPosition: id => this.population.actorById(id)?.avatar?.root?.position || null,
      // A paper pinned to a board is wherever that board stands.
      getSourcePosition: id => this.sourcePositions.get(id) || this.sourcePositions.get('board:' + String(id).split(':').slice(1).join(':')) || null,
      getPlace: id => this.placeFor(id),
      // Roads signed from a place beyond the tutorial villages, as residents describe them.
      getRoutes: key => this.signedPlaces?.get(key) || null,
      getNpcPlace: id => this.npcPlace(id),
      getKnownPlace: () => this.notebook?.book?.map?.place || null,
      save: () => this.population.saveLivingWorldState(true), director: this.director,
    });
    this.unsubscribePhysical = this.controller.subscribe(() => this.syncPhysicalState());
    this.onKey = event => {
      if (event.code !== 'KeyE' || event.repeat || !this.isPlaying() || this.ui?.isOpen
        || this.rail.riding || ['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) return;
      const board = this.nearbyBoards()[0];
      if (board) {
        // Pressing E at the board is reading it: no second "read" step.
        this.ui.open('leads'); this.ui.readBoard(board.place, { quiet: true });
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (this.nearbySources().length) { this.ui.open('stories'); event.preventDefault(); event.stopImmediatePropagation(); return; }
      const post = this.nearbyFingerpost();
      if (post) { this.ui.readFingerpost(post); event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this.onKey, true);
  }
  /** The round's people, and anyone the story is waiting on to hand something over: they stay at home. */
  isCast(id) { return !!this.controller.roleFor(id) || this.castIds().includes(id); }
  castIds() {
    const story = this.controller.story;
    if (!story) return [];
    const waiting = Object.values(story.plot?.sites || {}).flatMap(site => site.offers)
      .filter(offer => offer.ch === 'handed' && !story.evidence[offer.a]).map(offer => story.plot.accounts[offer.a]?.by);
    return [...new Set([...Object.values(story.bindings.cast || {}).map(c => c.id), ...waiting, story.plot?.closer?.id].filter(Boolean))];
  }
  async prepare(plan) {
    if (this.prepared || this.preparing || !plan?.stations?.length) return this.preparing;
    this.preparing = (async () => {
      this.setStatus('Preparing the courier communities and their roads…');
      this.railPlan = plan;
      const bindings = this.selectBindings(plan);
      const state = this.population.worldState;
      // `?storySeed=` pins a new courier's story, to reproduce a run; saves keep their own.
      const pinned = Number.parseInt(new URLSearchParams(globalThis.location?.search || '').get('storySeed'), 10);
      initializeCourier(state, bindings, { storySeed: Number.isFinite(pinned) ? pinned : null });
      // Revalidate persisted bindings against the current generation and plans.
      for (const place of Object.values(this.controller.story.bindings.places)) {
        if (!bindings.places[place.key] || bindings.places[place.key].id !== place.id) throw new Error('The courier landscape has changed. Restart this proof to bind its new communities.');
      }
      for (const [role, person] of Object.entries(bindings.cast)) {
        const saved = this.controller.story.bindings.cast[role];
        // An older save keeps its own cast; refresh the address only for the same person.
        if (saved?.id === person.id) saved.home.address = person.home.address;
        else if (saved?.home) {
          const plan = this.plans[saved.place], well = plan?.props.find(p => p.kind === 'well') || plan?.site;
          if (well) saved.home.address = saved.name + '’s household, ' + courierCompass(saved.home.x - well.x, saved.home.z - well.z)
            + ' of the central well in ' + this.controller.story.bindings.places[saved.place].name;
        }
      }
      // Directions are derived from the land, so an older save hears the current wording.
      if (this.controller.story.bindings) this.controller.story.bindings.routes = structuredClone(bindings.routes);
      this.createReadingStands(); this.createTrailSigns(); this.createNameSigns();
      this.createFlowerPots(); this.syncPhysicalState();
      const key = COURIER_PREFIX + 'book.' + state.worldSeed + worldGenerationScope(state.worldGeneration) + '.' + state.playerId;
      this.notebook = new NotebookStore({ key }); await this.notebook.load();
      this.ui = new CourierUI({ controller: this.controller, notebook: this.notebook,
        population: this.population, controls: this.controls, renderer: this.renderer,
        onOpen: this.onPanelOpen, onClose: this.onPanelClose,
        onRestart: () => this.restart(), onReturn: this.returnToNormal, canOpen: this.isPlaying,
        getNearbySources: () => this.nearbySources(),
        getNearbyBoards: () => this.nearbyBoards(),
        getMapData: () => this.mapData(),
        getLandmarkNear: () => this.landmarkNear(),
        onVisitContact: contact => this.visitContact(contact),
      });
      this.xrPanel = new CourierXRPanel({ ui: this.ui, renderer: this.renderer, scene: this.scene,
        camera: this.camera, controls: this.controls, canOpen: this.isPlaying });
      this.rail.mapEl.classList.add('courier-route-hidden');
      // One prompt in the middle of the screen: people, boards, road posts and
      // the train all speak through it instead of stacking their own.
      this.population.promptEl?.classList.add('courier-route-hidden');
      this.rail.promptEl?.classList.add('courier-route-hidden');
      this.promptEl = document.createElement('div'); this.promptEl.id = 'courier-prompt';
      this.promptEl.setAttribute('role', 'status'); this.promptEl.style.display = 'none'; document.body.append(this.promptEl);
      const map = this.ui.courierMap();
      if (!map.place && !map.seen.length) {
        // A new courier knows their home village and nothing beyond it.
        const home = this.mapData()?.places.find(place => place.key === 'A');
        map.place = 'A'; map.arrived = ['A']; revealCourierPlace(map, home); this.notebook.save();
      }
      const horsePoint = this.safePoint(state.courier.mount) ? state.courier.mount : this.horsePoint;
      if (!this.safePoint(horsePoint)) throw new Error('The courier horse needs a safe place to stand.');
      this.loanHorse = this.animals.stagePreview('horse', horsePoint.x, horsePoint.z, horsePoint.x, horsePoint.z + 1, Infinity);
      this.loanHorse.state = 'idle'; this.loanHorse.stateTimer = Infinity;
      this.loanHorse.previewTimer = Infinity; this.loanHorse.sharedId = 'courier:loan-horse';
      this.loanHorse.heading = Number(horsePoint.heading) || 0;
      state.courier.mount = { x: horsePoint.x, z: horsePoint.z, heading: this.loanHorse.heading };
      const resume = state.courier.resume;
      const start = resume && this.safePoint(resume) ? resume : this.startPoint;
      this.firstWelcomePending = state.courier.onboarding?.seen === false;
      this.prepared = true; this.population.saveLivingWorldState(true);
      // Papers placed before this load and not yet read start being written again.
      for (const site of Object.values(state.courier.plot.sites)) for (const offer of site.offers) {
        if (!state.courier.evidence[offer.a]) this.controller.prepareWork(offer.a);
      }
      this.onPrepared(start);
      if (!this.firstWelcomePending) this.ui.notify('T talks to a nearby person · E reads the board · N opens your book');
      console.info('[courier-ready]', JSON.stringify({ places: state.courier.bindings.places, cast: state.courier.bindings.cast }));
    })().catch(error => { this.error = error; this.setStatus('Courier start unavailable: ' + error.message); console.error('[courier preparation]', error); });
    return this.preparing;
  }
  safePoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
    const terrain = this.world.biomeAt(point.x, point.z), river = this.world.riverAt(point.x, point.z);
    return terrain.h > 0.55 && terrain.slope < 0.44 && (!river.wet || river.depth < 0.04)
      && !this.structureCollision?.animalBlocked(point.x, point.z, 0.7);
  }
  openPoint(plan, offset = 0) {
    const well = plan.props.find(p => p.kind === 'well') || plan.site;
    for (const radius of [5 + offset, 9 + offset, 15 + offset, 22 + offset]) {
      for (let i = 0; i < 16; i++) {
        const point = { x: well.x + Math.sin(i * Math.PI / 8) * radius, z: well.z + Math.cos(i * Math.PI / 8) * radius };
        if (this.safePoint(point)) return point;
      }
    }
    throw new Error('No safe open ground at ' + plan.site.id);
  }
  selectBindings(railPlan) {
    const graph = this.getNavGraph(), catalog = this.getSettlementCatalog();
    const routeKey = record => graph.nodes.has(record.key) ? record.key : record.stationNodeKey;
    const stations = [...catalog.values()].filter(r => r.stationId && r.kind === 'station-village' && r.residentIds.length >= 2)
      .sort((a, b) => a.plan.site.stationIndex - b.plan.site.stationIndex);
    const center = railPlan.center || railPlan.requestedCenter || railPlan.stations[0];
    const rural = settlementsAround(this.world, center.x, center.z, this.world.seed, 6500, [])
      .filter(s => !s.isStationSettlement).sort((a, b) => a.id.localeCompare(b.id));
    const choices = [];
    for (const a of stations) {
      const index = a.plan.site.stationIndex;
      const b = stations.find(r => r.plan.site.stationIndex === (index + 1) % railPlan.stations.length);
      if (!b) continue;
      for (const h of rural) {
        const ah = findRoute(graph, routeKey(a), h.regionalEntrance.key), bh = findRoute(graph, routeKey(b), h.regionalEntrance.key);
        const ab = findRoute(graph, routeKey(a), routeKey(b));
        if (ah?.legs.length && bh?.legs.length && ab?.legs.length)
          choices.push({ a, b, h, cost: ah.distance + bh.distance + ab.distance });
      }
    }
    choices.sort((a, b) => a.cost - b.cost || a.a.id.localeCompare(b.a.id) || a.h.id.localeCompare(b.h.id));
    const eligible = (record, state) => record.residentIds.map(id => state.entities[id]).filter(e => e && !e.tombstone && !e.inTransit)
      .map(entity => createSettlementResidentIdentity({ entity, state, worldSeed: this.world.seed }))
      .filter(identity => identity.interactive !== false && ['adult', 'elder'].includes(identity.age))
      .sort((a, b) => a.id.localeCompare(b.id));
    const previews = new Map();
    const selected = choices.find(choice => {
      if (!previews.has(choice.h.id)) {
        const scratch = structuredClone(this.population.worldState), plan = cachedSettlementPlan(this.world, choice.h);
        const population = activateSettlementResidents(plan, scratch);
        previews.set(choice.h.id, eligible({ residentIds: population.residentIds }, scratch).length >= 2);
      }
      return previews.get(choice.h.id) && eligible(choice.a, this.population.worldState).length >= 2
        && eligible(choice.b, this.population.worldState).length >= 2;
    });
    if (!selected) throw new Error('Three connected courier communities could not be found.');
    const hPlan = cachedSettlementPlan(this.world, selected.h);
    const hPopulation = activateSettlementResidents(hPlan, this.population.worldState);
    this.recordSettlement(hPlan, hPopulation);
    const records = { A: selected.a, B: selected.b, H: catalog.get(selected.h.id) };
    this.plans = Object.fromEntries(Object.entries(records).map(([key, r]) => [key, r.plan]));
    const places = Object.fromEntries(Object.entries(records).map(([key, r]) => [key, {
      key, id: r.id, name: r.stationId ? railPlan.stations.find(s => s.id === r.stationId).name
        : settlementOrigin(this.world, r.plan.site).name,
      x: r.x, z: r.z, nodeKey: routeKey(r), stationId: r.stationId,
    }]));
    const state = this.population.worldState, cast = {};
    for (const [key, record] of Object.entries(records)) {
      const everyone = eligible(record, state);
      const roles = Object.keys(COURIER_ROLES).filter(role => COURIER_ROLES[role] === key);
      if (everyone.length < roles.length) throw new Error('Not enough adult residents in ' + places[key].name);
      // A sender and a recipient should not share a front door: take one
      // adult per home first, and fall back to housemates only if we must.
      const homeOf = identity => state.entities[identity.id]?.residence?.homeBuildingId;
      const seenHomes = new Set(), spread = [], housemates = [];
      for (const identity of everyone) {
        if (seenHomes.has(homeOf(identity))) housemates.push(identity);
        else { seenHomes.add(homeOf(identity)); spread.push(identity); }
      }
      const identities = [...spread, ...housemates];
      roles.forEach((role, i) => {
        const identity = identities[i], entity = state.entities[identity.id];
        const home = record.plan.buildings.find(b => b.id === entity.residence.homeBuildingId);
        const well = record.plan.props.find(p => p.kind === 'well') || record.plan.site;
        const dx = home.x - well.x, dz = home.z - well.z;
        const compass = courierCompass(dx, dz);
        cast[role] = { id: identity.id, name: identity.name, place: key,
          home: { id: home.id, name: identity.name + '’s home', x: home.x, z: home.z,
            address: identity.name + '’s household, ' + compass + ' of the central well in ' + places[key].name } };
      });
    }
    this.stationA = railPlan.stations.find(station => station.id === places.A.stationId) || null;
    this.stationSpots = Object.entries(places).flatMap(([key, place]) => {
      const station = place.stationId && railPlan.stations.find(item => item.id === place.stationId);
      return station && Number.isFinite(station.x) ? [{ place: key, x: station.x, z: station.z, name: place.name + ' station' }] : [];
    });
    this.nameSignSpots = [];
    this.routePaths = []; const routes = {};
    for (const [key, from] of Object.entries(places)) {
      routes[key] = [];
      for (const [destination, to] of Object.entries(places)) {
        if (destination === key) continue;
        const road = this.planRoute(graph, key, from, destination, to, records[key].plan);
        if (!road) continue;
        this.routePaths.push(road.path); routes[key].push(road.entry);
        if (!this.nameSignSpots.some(spot => spot.place === key && distance(spot, road.sign) < 25)) this.nameSignSpots.push(road.sign);
      }
    }
    this.startPoint = this.openPoint(records.A.plan, 3); this.horsePoint = this.openPoint(records.A.plan, 11);
    return { places, cast, routes };
  }
  /**
   * Any settlement the world has streamed in, as a place the story can use.
   * The tutorial villages answer from their bindings; everywhere else is
   * named the way its own residents and name boards name it.
   */
  placeFor(id) {
    if (!id || typeof id !== 'string') return null;
    if (this.extraPlaces?.has(id)) return this.extraPlaces.get(id);
    const record = this.getSettlementCatalog?.()?.get(id);
    if (!record?.plan?.site) return null;
    const station = record.stationId && this.railPlan?.stations?.find(item => item.id === record.stationId);
    let name = station?.name;
    try { name ||= settlementOrigin(this.world, record.plan.site).name; } catch { name ||= null; }
    const place = Object.freeze({ key: id, id, name: name || 'the settlement', x: record.x, z: record.z,
      kind: record.kind || record.plan.site.kind, stationId: record.stationId || null, radius: record.plan.site.radius || 120 });
    (this.extraPlaces ||= new Map()).set(id, place);
    (this.plans ||= {})[id] ||= record.plan;
    return place;
  }
  /** The settlement the courier is standing in, by key, from the streamed catalogue. */
  settlementAt(player) {
    const tutorial = this.controller.story?.bindings.places || {};
    let best = null;
    for (const record of this.getSettlementCatalog?.()?.values() || []) {
      const radius = (record.plan?.site?.radius || 120) + 25, d = distance(player, record);
      if (d <= radius && (!best || d < best.d)) best = { record, d };
    }
    if (!best) return null;
    return Object.keys(tutorial).find(key => tutorial[key].id === best.record.id) || best.record.id;
  }
  /** The adults who live in a settlement, as the director casts them. */
  adultsOf(key) {
    const state = this.population.worldState, place = this.controller.place(key);
    const record = place && this.getSettlementCatalog?.()?.get(place.id);
    if (!record) return [];
    return record.residentIds.map(id => state.entities[id]).filter(entity => entity && !entity.tombstone)
      .flatMap(entity => {
        try {
          const identity = createSettlementResidentIdentity({ entity, state, worldSeed: this.world.seed });
          if (identity.interactive === false || !['adult', 'elder'].includes(identity.age)) return [];
          return [{ id: identity.id, name: identity.name, role: entity.role || 'resident',
            familiarity: state.relationships?.[identity.id + '|' + state.playerId]?.familiarity || 0,
            home: this.homeOf(entity, key, identity.name) }];
        } catch { return []; }
      });
  }
  /** A resident's address, as the courier is given it: their house, by the compass from the well. */
  homeOf(entity, key, name) {
    const plan = this.plans?.[key] || this.plans?.[this.controller.place(key)?.id], place = this.controller.place(key);
    const home = plan?.buildings.find(building => building.id === entity?.residence?.homeBuildingId);
    if (!home || !place) return null;
    const well = plan.props?.find(prop => prop.kind === 'well');
    const from = well || plan.site;
    return { id: home.id, name: name + '’s home', x: home.x, z: home.z,
      address: name + '’s household, ' + courierCompass(home.x - from.x, home.z - from.z) + ' of the ' + (well ? 'central well' : 'middle of ' + place.name) + (well ? ' in ' + place.name : '') };
  }
  /** Places the courier has been, with the people who live there: where a new commission may be addressed. */
  visitedPlaces(except) {
    const story = this.controller.story, keys = new Set([...Object.keys(story.bindings.places), ...story.plot.pacing.seen.map(entry => this.controller.placeKey(entry[0])).filter(Boolean)]);
    keys.delete(except);
    return [...keys].map(key => ({ key, name: this.controller.placeName(key), people: this.adultsOf(key) })).filter(place => place.people.length);
  }
  /**
   * The courier is in a settlement: let the director decide what it offers,
   * and make sure it has a board to pin that to. Pacing is plain story state,
   * so this writes no event and leaves no receipt behind.
   */
  visitSettlement(key) {
    const story = this.controller.story, place = this.controller.place(key);
    if (!story || !place) return;
    const nowHour = this.population.worldState.clock?.worldHours || 0;
    const plan = planArrival(story, { id: place.id, name: place.name, kind: place.kind || (place.stationId ? 'station-village' : 'hamlet') },
      this.adultsOf(key), { nowHour, channels: this.storyChannels || ['stand', 'handed'] });
    if (!this.noticeBoards.has(key) && (plan?.offer || story.plot.sites[place.id] || this.boardWanted(key))) this.ensureBoard(key);
    if (!plan) return;
    applyArrival(story, plan);
    if (plan.arrival && !story.bindings.places[key]) this.controller.noteArrival(key, this.rail.riding ? 'train' : this.horseRiding.riding ? 'horse' : 'foot');
    // A place the courier has come to may have post of its own, for somewhere they have been.
    const commission = this.controller.offerCommission(key, this.adultsOf(key), this.visitedPlaces(key));
    if (commission) { this.ensureBoard(key); this.syncBoardNotices(); }
    this.population.saveLivingWorldState(true);
    // Start writing while the courier walks over to read it.
    if (plan.offer?.author) this.controller.prepareWork(plan.offer.account);
    if (plan.offer || plan.closer) this.controller.changed({ ok: true, story: plan });
    if (plan.offer?.channel === 'stand' && this.ui && !this.renderer.xr.isPresenting) {
      this.ui.notify('Something new is pinned to the Post & Errands board here.');
    }
  }
  /** A place gets a board as soon as the courier walks into a village or town, whatever the story needs. */
  boardWanted(key) {
    const kind = this.controller.place(key)?.kind;
    return ['village', 'town', 'station-village', 'station-halt'].includes(kind);
  }
  /** Build a settlement's board, keeping only the few nearest beyond the tutorial villages. */
  ensureBoard(key) {
    if (this.noticeBoards.has(key)) return this.noticeBoards.get(key);
    const place = this.controller.place(key), plan = this.plans?.[key];
    if (!place || !plan) return null;
    let board;
    try {
      this.signRoadsFor(key);
      board = this.createBoard(key, place, plan, { compact: ['farmstead', 'hamlet'].includes(place.kind) });
      this.createBoardFingerposts(this.boardMaterials().wood, [board]);
    } catch (error) { console.warn('[courier board]', key, error.message); return null; }
    this.paintBoardPlan(board); board.signature = null; this.syncBoardNotices();
    const tutorial = new Set(Object.keys(this.controller.story.bindings.places));
    const extra = [...this.noticeBoards.values()].filter(item => !tutorial.has(item.place));
    if (extra.length > 6) {
      const player = this.controls.rig.position;
      this.disposeBoard(extra.sort((a, b) => distance(player, b.root.position) - distance(player, a.root.position))[0]);
    }
    return board;
  }
  disposeBoard(board) {
    this.unsignRoads(board.place);
    for (const root of board.extraRoots || []) { this.scene.remove(root); this.roots = this.roots.filter(item => item !== root); }
    this.scene.remove(board.root); this.roots = this.roots.filter(root => root !== board.root);
    board.root.traverse(object => { object.geometry?.dispose?.(); if (object.material?.map) object.material.map.dispose(); });
    this.noticeBoards.delete(board.place); this.sourcePositions.delete('board:' + board.place); this.sourcePositions.delete('stand:' + board.place);
  }
  /**
   * One signed road from a village to a neighbour: posts at each junction and
   * along the way, the lane's first stretch for the posted plan, which way it
   * really leaves, the name board on the way in, and the words a resident
   * uses to send someone down it. Derived from the land, never saved.
   */
  planRoute(graph, key, from, destination, to, plan) {
    const route = findRoute(graph, from.nodeKey, to.nodeKey);
    if (!route?.legs?.length) return null;
    const points = [];
    for (const [i, leg] of route.legs.entries()) {
      const length = leg.edge.arcLength;
      const sample = trailFrameAtArc(leg.edge, leg.forward ? Math.min(length, 55) : Math.max(0, length - 55), {});
      const point = { id: 'courier:post:' + key + ':' + destination + ':' + i,
        name: 'the ' + to.name + ' road post ' + (i + 1), x: sample.x, z: sample.z, junction: true };
      if (this.safePoint(point)) points.push(point);
      for (let arc = 240; arc < length - 40; arc += 240) {
        const frame = trailFrameAtArc(leg.edge, leg.forward ? arc : length - arc, {});
        if (this.safePoint(frame)) points.push({ id: point.id + ':' + arc, name: 'the ' + to.name + ' road post', x: frame.x, z: frame.z });
      }
    }
    const walk = courierWalkTime(route.distance || 0);
    // The lane itself for the first stretch out of the village, for the posted plan.
    const trace = [];
    for (const leg of route.legs) {
      const length = leg.edge.arcLength;
      for (let arc = 0; arc <= length && trace.length < 40; arc += 12) {
        const frame = trailFrameAtArc(leg.edge, leg.forward ? arc : length - arc, {});
        if (Number.isFinite(frame?.x) && Number.isFinite(frame?.z)) trace.push({ x: frame.x, z: frame.z });
      }
      if (trace.length >= 40) break;
    }
    // Which way the road really leaves: where the lane is out past the houses,
    // not the first post, which can sit on a bend going the other way.
    const well = plan.props.find(p => p.kind === 'well') || plan.site;
    const leave = trace.find(point => distance(point, well) > 150) || trace[trace.length - 1] || points[0] || to;
    const first = points[0] || { id: 'courier:entrance:' + key, name: 'the trail entrance', x: plan.site.regionalEntrance.x, z: plan.site.regionalEntrance.z };
    // Each road out of a village carries that village's name board, so a
    // courier arriving along it learns where they are by reading it.
    const toward = points[1] || to;
    const heading = courierCompass(leave.x - well.x, leave.z - well.z);
    const length = route.distance || 0, pennant = COURIER_PENNANTS[destination]?.name;
    const pace = 'It is ' + walk + ' on foot' + (length > 3000 ? '; the loan horse makes it easier.' : length > 1200 ? ', so keep an eye on your compass.' : '.');
    return {
      path: { from: key, to: destination, destination: to.name, toPlace: to, points, trace, leave, distance: length, walk },
      sign: { place: key, x: first.x, z: first.z, toward: { x: toward.x, z: toward.z } },
      entry: { place: destination, name: to.name, targetId: first.id, distance: length, walk,
        target: { id: first.id, name: first.name, worldX: first.x, worldZ: first.z,
          direction: 'along the signed trail', distancePhrase: 'just along the road', kind: 'trail-marker' },
        instructions: 'For ' + to.name + ', take the road that leaves ' + from.name + ' to the ' + heading + ', past ' + first.name + '. Follow the road posts marked “' + to.name + '”; they stay with the trail at its bends and junctions. '
          + pace + ' When you pass the name board for ' + to.name + ', you are there' + (pennant ? '; its post board flies a ' + pennant + ' pennant. ' : '. ')
          + (from.stationId && to.stationId ? 'You can also board the regional train here and step off at ' + to.name + '; ask which stop is next before boarding.' : 'Once there, ask a neighbour for the house you want.') },
    };
  }
  augmentContext(context, actor) {
    const npcId = actor?.identity?.id || actor?.id || actor?.actorId;
    const place = this.npcPlace(npcId, context, actor);
    const courier = this.controller.story && place
      && this.controller.contextForNpc(npcId, { place });
    if (!courier) return context;
    const boardPosition = this.sourcePositions.get('board:' + place);
    const boardTarget = boardPosition ? { ...(courier.boardTarget || { id: 'board:' + place, kind: 'place', name: 'Post & Errands board by the well' }),
      worldX: boardPosition.x, worldZ: boardPosition.z } : courier.boardTarget;
    const standPosition = this.sourcePositions.get('stand:' + place);
    const readingStand = standPosition ? { id: 'reading-stand:' + place, kind: 'place',
      name: 'the public reading stand by the well in ' + (this.controller.placeName(place) || place),
      worldX: standPosition.x, worldZ: standPosition.z } : null;
    const localPeople = new Set((courier.people || []).map(person => person.id));
    const visibleCast = Object.values(this.controller.story.bindings.cast || {})
      .filter(person => person.home && localPeople.has(person.id));
    const homeTargets = visibleCast
      .map(person => ({ id: 'home:' + person.id, kind: 'place', name: person.home.name,
        address: person.home.address, place: person.place, worldX: person.home.x, worldZ: person.home.z }));
    const routeTargets = courier.routes.map(route => route.target);
    const contactTargets = visibleCast
      .map(person => {
        const current = this.population.actorById(person.id)?.avatar?.root?.position;
        return { id: person.id, kind: 'person', name: person.name,
          worldX: Number.isFinite(current?.x) ? current.x : person.home.x,
          worldZ: Number.isFinite(current?.z) ? current.z : person.home.z,
          address: person.home.address, place: person.place };
      });
    const targetMap = new Map((context.targets || []).filter(target => target?.id).map(target => [target.id, target]));
    for (const target of [...routeTargets, ...(boardTarget ? [boardTarget] : []),
      ...(readingStand ? [readingStand] : []), ...contactTargets]) targetMap.set(target.id, target);
    return { ...context, courier: { ...courier, boardTarget },
      targets: [...targetMap.values()], pointPlaces: [...routeTargets, ...(boardTarget ? [boardTarget] : []), ...(readingStand ? [readingStand] : []),
        ...homeTargets, ...(context.pointPlaces || [])] };
  }
  label(text, width = 512, height = 100, size = 36) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ded0ab'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#29392f'; ctx.font = 'bold ' + size + 'px Georgia'; ctx.textAlign = 'center'; ctx.fillText(text.slice(0, 26), width / 2, height / 2 + size / 3, width - 24);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: true, side: THREE.DoubleSide });
  }
  boardMaterials() {
    // One lantern glass for every board: they all light together at dusk.
    this.lanternGlass ||= new THREE.MeshStandardMaterial({ color: 0x3b3224, roughness: 0.4, emissive: 0xffb04a, emissiveIntensity: 0 });
    return this.boardKit ||= {
      wood: new THREE.MeshStandardMaterial({ color: 0x66583e, roughness: 1 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x4a3f2e, roughness: 1 }),
      roofing: new THREE.MeshStandardMaterial({ color: 0x5b4a3b, roughness: 0.95 }),
      iron: new THREE.MeshStandardMaterial({ color: 0x2d2a26, roughness: 0.7, metalness: 0.4 }),
    };
  }
  createReadingStands() {
    for (const [key, place] of Object.entries(this.controller.story.bindings.places)) this.createBoard(key, place, this.plans[key]);
    this.createBoardFingerposts(this.boardMaterials().wood);
    for (const board of this.noticeBoards.values()) this.paintBoardPlan(board);
  }
  /** The posted village plan beside a board: the one place that says where you are. */
  paintBoardPlan(board) {
    const place = this.mapData({ include: [board.place] })?.places.find(item => item.key === board.place);
    if (!place) return;
    paintPostedVillageMap(board.planCanvas.getContext('2d'), place, this.postedRoads(board.place), place.boardFacing, 1024, 1024);
    board.planTexture.needsUpdate = true;
  }
  /**
   * A Post & Errands board by a village well. A farmstead or hamlet gets the
   * same notices and plan on a plainer post, without the roofed shelter.
   */
  createBoard(key, place, plan, { compact = false } = {}) {
    const { wood, dark, roofing, iron } = this.boardMaterials();
    const box = (w, h, d, material, x, y, z) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); return mesh; };
    {
      const point = this.openPoint(plan);
      const root = new THREE.Group(); root.position.set(point.x, this.groundAt(point.x, point.z), point.z);
      root.userData.viewDistance = 700; root.name = 'Post & Errands board, ' + place.name;
      const legs = box(0.25, 1.2, 0.3, wood, 0, 0.6, 0);
      const desk = box(1.6, 0.1, 0.65, wood, 0, 1.2, 0);
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.32), this.label('Public accounts'));
      paper.rotation.x = -Math.PI / 2; paper.position.set(0, 1.26, 0);
      const frame = box(2.05, 1.48, 0.12, wood, 0, 1.95, -0.12);
      const noticeCanvas = document.createElement('canvas'); noticeCanvas.width = 1024; noticeCanvas.height = 900;
      const noticeTexture = new THREE.CanvasTexture(noticeCanvas); noticeTexture.colorSpace = THREE.SRGBColorSpace;
      noticeTexture.generateMipmaps = false; noticeTexture.minFilter = THREE.LinearFilter;
      const noticeMaterial = new THREE.MeshBasicMaterial({ map: noticeTexture, toneMapped: true,
        side: THREE.DoubleSide });
      const notice = new THREE.Mesh(new THREE.PlaneGeometry(1.83, 1.28), noticeMaterial);
      notice.position.set(0, 1.95, -0.05);
      if (key === 'A') {
        const envelope = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.025, 0.23),
          new THREE.MeshStandardMaterial({ color: 0xe5d2a5, roughness: 0.95 }));
        envelope.position.set(-0.44, 1.267, 0.02);
        const envelopeMark = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.16), this.label('A NOTE'));
        envelopeMark.rotation.x = -Math.PI / 2; envelopeMark.position.set(-0.44, 1.281, 0.02);
        const parcel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.27, 0.3),
          new THREE.MeshStandardMaterial({ color: 0xa7794c, roughness: 0.96 }));
        parcel.position.set(0.47, 1.385, -0.04);
        const twine = new THREE.MeshStandardMaterial({ color: 0xd8c79d, roughness: 1 });
        const tieX = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.275, 0.31), twine);
        tieX.position.set(0.47, 1.385, -0.04);
        const tieZ = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.275, 0.055), twine);
        tieZ.position.set(0.47, 1.385, -0.04);
        root.add(envelope, envelopeMark, parcel, tieX, tieZ);
      }
      root.add(legs, desk, paper, frame, notice);
      // The posted village plan, pinned beside the notices.
      const planCanvas = document.createElement('canvas'); planCanvas.width = 1024; planCanvas.height = 1024;
      const planTexture = new THREE.CanvasTexture(planCanvas); planTexture.colorSpace = THREE.SRGBColorSpace;
      planTexture.minFilter = THREE.LinearMipmapLinearFilter; planTexture.anisotropy = 4;
      const planSheet = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.MeshBasicMaterial({ map: planTexture, toneMapped: true }));
      planSheet.position.set(1.72, 1.95, -0.05);
      root.add(box(1.27, 1.27, 0.12, wood, 1.72, 1.95, -0.12), planSheet);
      // A roofed shelter with the village's name across it.
      for (const x of [-1.25, 2.45]) root.add(box(0.14, compact ? 3.2 : 3.6, 0.14, dark, x, compact ? 1.6 : 1.8, -0.25));
      root.add(box(3.84, 0.12, 0.12, dark, 0.6, 2.72, -0.25));
      if (!compact) {
        // Eaves high enough that the name plate shows beneath them from the lane.
        const slope = Math.atan2(0.37, 0.9), slab = Math.hypot(0.37, 0.9) + 0.1;
        const front = box(4.3, 0.07, slab, roofing, 0.6, 3.435, 0.2); front.rotation.x = slope;
        const back = box(4.3, 0.07, slab, roofing, 0.6, 3.435, -0.7); back.rotation.x = -slope;
        root.add(front, back, box(4.36, 0.1, 0.1, dark, 0.6, 3.64, -0.25));
      }
      const nameMaterial = this.label(place.name.toUpperCase(), 768, 84, 58); nameMaterial.side = THREE.FrontSide;
      const plate = box(2.9, 0.36, 0.06, wood, 0.6, 2.98, -0.16);
      const nameFace = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.3), nameMaterial); nameFace.position.set(0.6, 2.98, -0.115);
      const nameBack = new THREE.Mesh(nameFace.geometry, nameMaterial); nameBack.position.set(0.6, 2.98, -0.205); nameBack.rotation.y = Math.PI;
      root.add(plate, nameFace, nameBack);
      // A hanging POST sign on a bracket, seen from along the lane.
      if (!compact) root.add(box(0.95, 0.07, 0.07, iron, -1.72, 2.72, -0.25));
      for (const x of [-1.95, -1.5]) root.add(box(0.02, 0.2, 0.02, iron, x, 2.59, -0.25));
      const postMaterial = this.label('POST', 320, 192, 92); postMaterial.side = THREE.FrontSide;
      const hanging = box(0.06, 0.42, 0.66, wood, -1.72, 2.28, -0.25); hanging.rotation.y = Math.PI / 2;
      const postA = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.36), postMaterial); postA.position.set(-1.72, 2.28, -0.215);
      const postB = new THREE.Mesh(postA.geometry, postMaterial); postB.position.set(-1.72, 2.28, -0.285); postB.rotation.y = Math.PI;
      if (!compact) root.add(hanging, postA, postB);
      // A lantern on the right-hand post, lit at dusk.
      const lantern = new THREE.Group(); lantern.position.set(2.45, 2.3, 0.02);
      lantern.add(box(0.05, 0.05, 0.2, iron, 0, 0.16, -0.1), box(0.2, 0.04, 0.2, iron, 0, 0.13, 0),
        box(0.15, 0.21, 0.15, this.lanternGlass, 0, 0, 0), box(0.18, 0.03, 0.18, iron, 0, -0.11, 0));
      root.add(lantern);
      // A tall flagpole with the village's own pennant, to be seen across the roofs.
      const pennantColour = COURIER_PENNANTS[key]?.colour ?? 0xb08a3a;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 7.2, 8), dark); pole.position.set(3.25, 3.6, -0.6);
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), iron); finial.position.set(3.25, 7.24, -0.6);
      const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(1.5, -0.32); shape.lineTo(0, -0.64); shape.closePath();
      const pennant = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: pennantColour, roughness: 0.85, side: THREE.DoubleSide }));
      const flag = new THREE.Group(); flag.position.set(3.25, 7.05, -0.6); flag.add(pennant);
      if (!compact) root.add(pole, finial, flag);
      this.scene.add(root); this.roots.push(root);
      const board = { place: key, name: place.name, root, canvas: noticeCanvas,
        texture: noticeTexture, signature: null, planCanvas, planTexture, flag,
        phase: key.charCodeAt(0) * 1.7, arms: [] };
      this.noticeBoards.set(key, board);
      this.sourcePositions.set('board:' + key, root.position);
      this.sourcePositions.set('stand:' + key, root.position);
      if (key === 'B') { this.workPosition = root.position; this.cupRoot = root; }
      if (key === 'A') {
        this.postDeskPosition = root.position;
        this.startPoint = this.nearDeskStart(root.position) || this.openPoint(this.plans.A, 3);
      }
      return board;
    }
  }
  /** The signed roads out of a village, from the village outward, for its posted plan. */
  postedRoads(key) {
    return (this.routePaths || []).filter(path => path.from === key)
      .map(path => ({ name: path.destination, walk: path.walk, points: (path.trace?.length > 1 ? path.trace : path.points).map(point => ({ x: point.x, z: point.z })) }));
  }
  /** A fingerpost beside each board, one arm for each road out, with walking times. */
  createBoardFingerposts(wood, boards = [...this.noticeBoards.values()]) {
    const paint = this.armPaint ||= new THREE.MeshStandardMaterial({ color: 0xded0ab, roughness: 1 });
    for (const board of boards) {
      const base = board.root.position, at = { x: base.x - 2.5, z: base.z + 1.15 };
      const root = new THREE.Group(); root.position.set(at.x, this.groundAt(at.x, at.z), at.z);
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.1, 0.1), wood); pole.position.y = 1.05; root.add(pole);
      const roads = (this.routePaths || []).filter(path => path.from === board.place && (path.leave || path.points[0]));
      roads.forEach((path, i) => {
        // The arm points the way the road leaves for that village, not across country.
        const toward = path.leave || path.points[0];
        const arm = new THREE.Group(); arm.position.y = 1.8 - i * 0.34;
        arm.rotation.y = Math.atan2(-(toward.z - at.z), toward.x - at.x);
        const outline = new THREE.Shape();
        outline.moveTo(0.02, -0.13); outline.lineTo(1.18, -0.13); outline.lineTo(1.42, 0); outline.lineTo(1.18, 0.13); outline.lineTo(0.02, 0.13); outline.closePath();
        const plank = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: 0.06, bevelEnabled: false }), paint); plank.position.z = -0.03;
        const material = this.armLabel(path.destination, path.walk); material.side = THREE.FrontSide;
        const face = new THREE.Mesh(new THREE.PlaneGeometry(1.14, 0.24), material); face.position.set(0.62, 0, 0.035);
        const reverse = new THREE.Mesh(face.geometry, material); reverse.position.set(0.62, 0, -0.035); reverse.rotation.y = Math.PI;
        arm.add(plank, face, reverse); root.add(arm);
        board.arms.push({ name: path.destination, walk: path.walk, compass: courierCompass(toward.x - at.x, toward.z - at.z) });
      });
      root.add(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.12, 4), wood).translateY(2.16));
      root.userData.viewDistance = 260; this.scene.add(root); this.roots.push(root); (board.extraRoots ||= []).push(root);
    }
  }
  armLabel(name, walk) {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 134;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ded0ab'; ctx.fillRect(0, 0, 640, 134);
    ctx.fillStyle = '#29392f'; ctx.textAlign = 'center';
    ctx.font = 'bold 50px Georgia'; ctx.fillText(name.toUpperCase().slice(0, 18), 320, 62, 600);
    ctx.font = 'italic 38px Georgia'; ctx.fillText(walk, 320, 114, 600);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: true });
  }
  /** Pennants stir in the wind and lanterns light as the day goes. */
  animateBoards(night) {
    const t = performance.now() / 1000;
    const lit = Math.max(0, Math.min(1, (night - 0.12) / 0.35));
    if (this.lanternGlass) this.lanternGlass.emissiveIntensity = lit * 2.6;
    for (const board of this.noticeBoards.values()) {
      if (!board.root.visible) continue;
      board.flag.rotation.y = 0.5 + Math.sin(t * 1.3 + board.phase) * 0.35 + Math.sin(t * 3.7 + board.phase) * 0.08;
      board.flag.scale.y = 1 + Math.sin(t * 5.3 + board.phase) * 0.05;
    }
  }
  nearDeskStart(position) {
    const candidates = [
      { x: position.x, z: position.z + 1.55 },
      { x: position.x + 1.35, z: position.z + 0.9 },
      { x: position.x - 1.35, z: position.z + 0.9 },
      { x: position.x + 1.55, z: position.z },
      { x: position.x - 1.55, z: position.z },
      { x: position.x, z: position.z + 2.1 },
    ];
    return candidates.find(point => this.safePoint(point)) || null;
  }
  drawNoticeBoard(board) {
    const ctx = board.canvas.getContext('2d');
    const width = board.canvas.width, height = board.canvas.height;
    ctx.fillStyle = '#eee2bf'; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#725d3f'; ctx.lineWidth = 16; ctx.strokeRect(8, 8, width - 16, height - 16);
    ctx.fillStyle = '#284234'; ctx.fillRect(20, 20, width - 40, 118);
    ctx.fillStyle = '#f4ecd8'; ctx.textAlign = 'center'; ctx.font = 'bold 54px Georgia';
    ctx.fillText('POST & ERRANDS', width / 2, 80);
    ctx.font = '28px Georgia'; ctx.fillText(this.controller.story.bindings.places[board.place]?.name || board.name, width / 2, 122);
    const jobs = this.controller.boardJobs(board.place);
    if (!jobs.length) {
      ctx.fillStyle = '#29392f'; ctx.font = '34px Georgia';
      ctx.fillText('No notices at present', width / 2, 220);
    }
    const rowHeight = Math.floor((height - 160) / Math.max(1, jobs.length));
    jobs.forEach((job, index) => {
      const y = 154 + index * rowHeight;
      const cardHeight = Math.max(116, rowHeight - 8);
      ctx.fillStyle = index % 2 ? '#e2d5b3' : '#f7f0db';
      ctx.fillRect(34, y, width - 68, cardHeight);
      ctx.strokeStyle = '#a09170'; ctx.lineWidth = 2; ctx.strokeRect(34, y, width - 68, cardHeight);
      const sender = job.sender?.name || 'Local sender';
      const recipient = job.recipient?.name || 'Local recipient';
      const cargo = ({ letter: 'Letter', basket: 'Seed basket', cup: 'Tea cup', parcel: 'Parcel' })[job.kind]
        || String(job.kind || 'Parcel').replace(/[-_]/g, ' ');
      const status = ({ offered: 'POSTED', declined: 'ASK AGAIN', active: 'IN TRANSIT',
        delivered: 'DELIVERED', returned: 'RETURNED' })[job.state] || String(job.state || 'POSTED').toUpperCase();
      ctx.textAlign = 'left'; ctx.fillStyle = '#29392f'; ctx.font = 'bold 34px Georgia';
      ctx.fillText(job.title, 60, y + Math.round(rowHeight * 0.3), width - 120);
      ctx.font = '27px Georgia';
      ctx.fillText(`From ${sender}  ·  To ${recipient} at ${job.destinationName}`, 60, y + Math.round(rowHeight * 0.58), width - 120);
      ctx.font = 'bold 25px Georgia'; ctx.fillText(`${cargo}  ·  ${status}`, 60, y + Math.round(rowHeight * 0.83), width - 120);
    });
    board.texture.needsUpdate = true;
  }
  syncBoardNotices() {
    for (const board of this.noticeBoards.values()) {
      const jobs = this.controller.boardJobs(board.place);
      const signature = jobs.map(job => `${job.id}:${job.state}`).join('|');
      if (signature === board.signature) continue;
      board.signature = signature; this.drawNoticeBoard(board);
    }
  }
  residentAppointment(id, settlementId = null) {
    if (this.controller.story && this.controller.roleFor(id) !== 'dispatcher') return this.doorstepAppointment(id, settlementId);
    if (!this.controller.story || this.controller.roleFor(id) !== 'dispatcher' || !this.postDeskPosition) return null;
    const place = this.controller.story.bindings.places.A;
    const job = this.controller.story.jobs['village-note'];
    if (!place || !job || job.state === 'delivered' || (settlementId && settlementId !== place.id)) return null;
    const position = { x: this.postDeskPosition.x - 1.72,
      y: this.groundAt(this.postDeskPosition.x - 1.72, this.postDeskPosition.z - 0.96),
      z: this.postDeskPosition.z - 0.96 };
    return { id: 'courier-post-desk:' + place.id, position,
      activity: 'sorting letters', role: 'post', pose: 'work', placeId: place.id,
      heading: Math.atan2(this.postDeskPosition.x - position.x, this.postDeskPosition.z - position.z) };
  }
  /**
   * Someone with a paper to hand over waits by their own front door in the
   * day, so the address the courier was given is where they are found.
   */
  doorstepAppointment(id, settlementId = null) {
    const story = this.controller.story, hour = ((this.population.worldState.clock?.worldHours || 0) % 24 + 24) % 24;
    if (hour < 7 || hour > 20 || this.controller.roleFor(id)) return null;
    const waiting = this.controller.handedHere(id)[0] || (story.plot.closer?.id === id && !story.plot.beats.ending ? { siteId: story.plot.closer.site } : null);
    if (!waiting || (settlementId && settlementId !== waiting.siteId)) return null;
    const entity = this.population.worldState.entities[id], plan = this.plans?.[this.controller.placeKey(waiting.siteId)];
    const building = plan?.buildings.find(item => item.id === entity?.residence?.homeBuildingId);
    const door = building?.portals?.find(portal => portal.kind === 'exterior-door');
    if (!building || !door) return null;
    const c = Math.cos(building.yaw), s = Math.sin(building.yaw), localX = door.x + 0.9, localZ = building.depth / 2 + 1.4;
    const x = building.x + localX * c + localZ * s, z = building.z - localX * s + localZ * c;
    return { id: 'courier-doorstep:' + id, position: { x, y: this.groundAt(x, z), z }, activity: 'waiting by the door', role: 'resident',
      pose: 'work', placeId: waiting.siteId, heading: Math.atan2(x - building.x, z - building.z) };
  }
  createFlowerPots() {
    if (!this.stationA) return;
    const station = this.stationA;
    const tangentLength = Math.hypot(station.tangentX || 0, station.tangentZ || 1) || 1;
    const tx = (station.tangentX || 0) / tangentLength, tz = (station.tangentZ || 1) / tangentLength;
    const rx = tz, rz = -tx;
    const platformY = (station.formationY ?? station.y ?? 0) + STATION_LAYOUT.platformTop;
    const pots = [
      { across: 2.25, along: -6.35 }, { across: 2.25, along: 6.35 },
    ];
    const terracotta = new THREE.MeshStandardMaterial({ color: 0x9b583d, roughness: 0.93 });
    const soil = new THREE.MeshStandardMaterial({ color: 0x493628, roughness: 1 });
    this.flowerPots = pots.map((spot, index) => {
      const root = new THREE.Group();
      root.position.set(station.x + rx * spot.across + tx * spot.along,
        platformY, station.z + rz * spot.across + tz * spot.along);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.38, 12), terracotta);
      body.position.y = 0.19; body.castShadow = true; body.receiveShadow = true;
      const earth = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.035, 12), soil);
      earth.position.y = 0.36;
      root.add(body, earth); this.scene.add(root); this.roots.push(root);
      return { root, index, bloom: null };
    });
  }
  addFlowers(pot) {
    if (!pot || pot.bloom) return;
    const bloom = new THREE.Group();
    const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x4b7448, roughness: 0.95 });
    const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x63864d, roughness: 0.94 });
    const flowerMaterials = [0xe1b54f, 0xd57968, 0x8b82ac].map(color =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.82 }));
    for (let i = 0; i < 5; i++) {
      const angle = i * 2.399;
      const x = Math.cos(angle) * (0.04 + (i % 2) * 0.08);
      const z = Math.sin(angle) * (0.04 + (i % 2) * 0.08);
      const top = 0.72 + (i % 3) * 0.12;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, top - 0.34, 5), stemMaterial);
      stem.position.set(x, 0.34 + (top - 0.34) / 2, z); bloom.add(stem);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), leafMaterial);
      leaf.position.set(x + Math.cos(angle + 0.8) * 0.12, top * 0.63, z + Math.sin(angle + 0.8) * 0.12);
      leaf.scale.set(1.35, 0.35, 0.55); bloom.add(leaf);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), flowerMaterials[i % flowerMaterials.length]);
      head.position.set(x, top, z); bloom.add(head);
    }
    pot.root.add(bloom); pot.bloom = bloom;
  }
  syncDeliveryProps() {
    const jobs = this.controller.story?.jobs;
    if (!jobs) return;
    if (jobs['village-note']?.state === 'delivered' && !this.deliveryProps.has('village-note')) {
      const guide = this.controller.story.bindings.cast.guide;
      const building = this.plans.A?.buildings.find(item => item.id === guide?.home?.id);
      const doorway = building?.portals?.find(portal => portal.kind === 'exterior-door');
      if (building && doorway) {
        const localX = doorway.x + 0.43, localZ = building.depth / 2 + 1.1;
        const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
        const x = building.x + localX * c + localZ * s;
        const z = building.z - localX * s + localZ * c;
        const root = new THREE.Group(); root.position.set(x, this.groundAt(x, z) + 0.04, z);
        const paper = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.028, 0.24),
          new THREE.MeshStandardMaterial({ color: 0xe7d6a9, roughness: 0.92 }));
        paper.rotation.y = building.yaw; root.add(paper);
        const seal = new THREE.Mesh(new THREE.CircleGeometry(0.035, 10),
          new THREE.MeshStandardMaterial({ color: 0x9a5546, roughness: 0.8 }));
        seal.rotation.x = -Math.PI / 2; seal.position.y = 0.019; root.add(seal);
        root.name = 'Delivered village note'; this.scene.add(root); this.roots.push(root);
        this.deliveryProps.set('village-note', root);
      }
    }
    if (jobs['platform-seeds']?.state === 'delivered') {
      for (const pot of this.flowerPots) this.addFlowers(pot);
    }
  }
  syncPhysicalState() {
    if (!this.controller?.story) return;
    this.syncBoardNotices(); this.syncDeliveryProps();
  }
  nearbyBoards() {
    if (!this.controller.story || !this.noticeBoards.size) return [];
    const player = this.controls.rig.position;
    return [...this.noticeBoards.values()].flatMap(board => {
      const position = this.sourcePositions.get('board:' + board.place);
      if (!position || distance(player, position) > 5) return [];
      const jobs = this.controller.boardJobs(board.place);
      const contact = jobs.find(job => !['delivered', 'active'].includes(job.state))?.sender || jobs[0]?.sender;
      const atDesk = contact && this.controller.roleFor(contact.id) === 'dispatcher' && this.residentAppointment(contact.id);
      return [{ place: board.place, name: board.name, position: { x: position.x, y: position.y, z: position.z }, arms: board.arms || [],
        roads: this.postedRoads(board.place),
        contactName: contact?.name || '', address: contact?.home?.address || '',
        contactHint: atDesk ? 'Ask ' + contact.name + ' at the post desk beside this board.'
          : contact ? 'Contact: ' + contact.name + '. Home address: ' + (contact.home?.address || 'ask locally')
            + '. Ask a local person if they are away.' : '' }];
    });
  }
  visitContact({ jobId, contactId, place, address, name } = {}) {
    if (jobId) this.controller.focusJob(jobId);
    const person = this.controller.story?.bindings.cast && Object.values(this.controller.story.bindings.cast)
      .find(candidate => candidate.id === contactId);
    this.ui?.close();
    const directions = jobId && this.controller.contactDirections(jobId);
    if (this.controller.story?.onboarding?.hintsEnabled !== false) { if (this.ui) this.ui.reminderDismissed = false; this.ui?.renderReminder(); return true; }
    this.ui?.notify(typeof directions === 'string' ? directions
      : `Find ${name || person?.name || 'the sender'} at ${address || person?.home?.address || 'their permanent home address'}, then press T within 4.5 metres to talk about the errand.`);
    return true;
  }
  placeKey(value) {
    const places = this.controller.story?.bindings?.places || {};
    if (typeof value === 'string') {
      if (places[value]) return value;
      return Object.keys(places).find(key => places[key].id === value || places[key].name === value)
        || (this.placeFor(value) ? value : null);
    }
    if (!value || typeof value !== 'object') return null;
    return this.placeKey(value.key || value.placeKey || value.settlementId || value.id || value.name);
  }
  npcPlace(id, context = null, actor = null) {
    const state = this.population?.worldState, entity = state?.entities?.[id];
    const household = state?.households?.[entity?.householdId];
    const candidates = [
      entity?.currentSettlementId, entity?.location?.settlementId, entity?.residence?.settlementId,
      entity?.residence?.residenceSettlementId, entity?.homeSettlementId, entity?.settlementId,
      household?.settlementId, household?.homeSettlementId,
      context?.place, context?.settlement, context?.settlementId,
      actor?.settlementId, actor?.residence?.settlementId,
    ];
    for (const candidate of candidates) {
      const key = this.placeKey(candidate);
      if (key) return key;
    }
    return null;
  }
  handleDialogueMessage(actor, text, options = {}) {
    const npcId = actor?.identity?.id || actor?.id || actor?.actorId;
    if (!npcId || !this.controller.story) return null;
    const place = this.npcPlace(npcId, options?.context, actor) || this.placeKey(options?.place);
    const response = handleCourierUtterance(this.controller, npcId, text, {
      ...options, place: place || undefined,
      lastAssistantText: options?.lastAssistantText,
    });
    if (response?.result?.briefing) this.ui?.briefed(response.result, npcId);
    return response;
  }
  /** Road posts along `paths`; `limit` caps how many one batch puts up, `owner` lets a far place's posts be taken down later. */
  createTrailSigns(paths = this.routePaths, { limit = 72, owner = null } = {}) {
    const wood = this.signWood ||= new THREE.MeshStandardMaterial({ color: 0x5f523d, roughness: 1 });
    const made = this.signsMade ||= new Set(); let count = 0;
    const signs = paths.flatMap(path => path.points.map((point, i) => ({ path, point, next: path.points[i + 1] || path.toPlace })));
    signs.sort((a, b) => Number(!!b.point.junction) - Number(!!a.point.junction));
    for (const { path, point, next } of signs) {
      const key = Math.round(point.x / 8) + ':' + Math.round(point.z / 8) + ':' + path.destination;
      if (made.has(key) || count >= limit) continue; made.add(key); count++;
      const root = new THREE.Group(); root.position.set(point.x, this.groundAt(point.x, point.z), point.z);
      root.rotation.y = Math.atan2(-(next.z - point.z), next.x - point.x);
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), wood); pole.position.y = 0.7;
      const outline = new THREE.Shape();
      outline.moveTo(-0.525, -0.11); outline.lineTo(0.525, -0.11);
      outline.lineTo(0.78, 0); outline.lineTo(0.525, 0.11);
      outline.lineTo(-0.525, 0.11); outline.closePath();
      const board = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: 0.12, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({ color: 0xded0ab, roughness: 1 }));
      board.position.set(0, 1.25, -0.06);
      const material = this.label(path.destination);
      material.side = THREE.FrontSide;
      // Keep the two readable faces outside both the board and its supporting post.
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.22), material); sign.position.set(0, 1.25, 0.065);
      const reverse = new THREE.Mesh(sign.geometry, material); reverse.position.set(0, 1.25, -0.065); reverse.rotation.y = Math.PI;
      root.add(pole, board, sign, reverse); this.scene.add(root); this.roots.push(root);
      this.fingerposts.push({ x: point.x, z: point.z, destination: path.destination, toward: { x: next.x, z: next.z }, owner, root, made: key });
    }
  }
  /** A name board beside each road into a village, set a little off the road. */
  createNameSigns(spots = this.nameSignSpots) {
    const wood = this.signWood ||= new THREE.MeshStandardMaterial({ color: 0x5f523d, roughness: 1 });
    for (const spot of spots) {
      if (spot.root) continue;
      const dx = spot.toward.x - spot.x, dz = spot.toward.z - spot.z, length = Math.hypot(dx, dz) || 1;
      const ux = dx / length, uz = dz / length;
      const at = [2.6, -2.6, 3.4, -3.4].map(side => ({ x: spot.x - uz * side + ux * 4, z: spot.z + ux * side + uz * 4 }))
        .find(point => this.safePoint(point));
      if (!at) continue;
      spot.sign = at;
      const root = new THREE.Group(); root.position.set(at.x, this.groundAt(at.x, at.z), at.z);
      // Face along the road so a courier walking in reads it head on.
      root.rotation.y = Math.atan2(ux, uz);
      for (const x of [-0.82, 0.82]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.7, 0.09), wood); leg.position.set(x, 0.85, 0); root.add(leg); }
      const plank = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.42, 0.07), wood); plank.position.y = 1.45;
      const material = this.label(this.controller.placeName(spot.place).toUpperCase(), 512, 112); material.side = THREE.FrontSide;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.36), material); face.position.set(0, 1.45, 0.04);
      const back = new THREE.Mesh(face.geometry, material); back.position.set(0, 1.45, -0.04); back.rotation.y = Math.PI;
      root.add(plank, face, back); this.scene.add(root); this.roots.push(root); spot.root = root;
    }
  }
  /**
   * Sign the roads at a place beyond the tutorial villages: to its three
   * nearest neighbours and back, with name boards on the way in. Within the
   * trail graph around the start; beyond it residents give a bearing instead.
   */
  signRoadsFor(key) {
    if ((this.signedPlaces ||= new Map()).has(key)) return this.signedPlaces.get(key);
    const graph = this.getNavGraph?.(), catalog = this.getSettlementCatalog?.(), here = this.controller.place(key);
    const nodeOf = place => { const record = catalog?.get(place.id); return record && (graph.nodes.has(record.key) ? record.key : record.stationNodeKey); };
    const routes = [];
    this.signedPlaces.set(key, routes);
    if (!graph || !here) return routes;
    const from = { ...here, nodeKey: nodeOf(here) };
    if (!from.nodeKey || !graph.nodes.has(from.nodeKey)) return routes;
    const tutorial = this.controller.story.bindings.places;
    const neighbours = [...catalog.values()].filter(record => record.id !== here.id && distance(record, here) < 9000)
      .sort((a, b) => distance(a, here) - distance(b, here)).slice(0, 3);
    const paths = [], spots = [];
    for (const record of neighbours) {
      const toKey = Object.keys(tutorial).find(item => tutorial[item].id === record.id) || record.id;
      const there = this.controller.place(toKey) || this.placeFor(record.id);
      const to = { ...there, nodeKey: tutorial[toKey]?.nodeKey || nodeOf(there) };
      if (!to.nodeKey) continue;
      let out = null, back = null;
      try { out = this.planRoute(graph, key, from, toKey, to, this.plans[key]); back = this.planRoute(graph, toKey, to, key, from, this.plans[toKey] || record.plan); }
      catch (error) { console.warn('[courier roads]', key, toKey, error.message); }
      if (out) {
        paths.push(out.path); routes.push(out.entry);
        if (!this.nameSignSpots.some(spot => spot.place === key && distance(spot, out.sign) < 25)) { this.nameSignSpots.push(out.sign); spots.push(out.sign); }
      }
      if (back) paths.push(back.path);
    }
    this.routePaths.push(...paths);
    this.createTrailSigns(paths, { limit: 36, owner: key });
    this.createNameSigns(spots);
    for (const spot of spots) if (spot.root) spot.owner = key;
    return routes;
  }
  /** Take down a far place's posts and name boards, keeping only the roads near where the courier is. */
  unsignRoads(key) {
    const drop = root => { this.scene.remove(root); this.roots = this.roots.filter(item => item !== root); };
    for (const post of this.fingerposts.filter(item => item.owner === key)) { drop(post.root); this.signsMade.delete(post.made); }
    this.fingerposts = this.fingerposts.filter(item => item.owner !== key);
    for (const spot of this.nameSignSpots.filter(item => item.owner === key)) drop(spot.root);
    this.nameSignSpots = this.nameSignSpots.filter(item => item.owner !== key);
    this.routePaths = this.routePaths.filter(path => path.from !== key && path.to !== key || Object.keys(this.controller.story.bindings.places).includes(path.from) && Object.keys(this.controller.story.bindings.places).includes(path.to));
    this.signedPlaces?.delete(key);
  }
  nearbyFingerpost(player = this.controls.rig.position) {
    let best = null;
    for (const post of this.fingerposts) {
      const d = distance(player, post);
      if (d <= 3.2 && (!best || d < best.d)) best = { post, d };
    }
    return best?.post || null;
  }
  /** Something the courier can stand beside and find on a map: they know where that is. */
  landmarkNear(player = this.controls.rig.position) {
    const story = this.controller.story;
    if (!story) return null;
    const candidates = [];
    for (const key of new Set([...Object.keys(story.bindings.places), ...this.noticeBoards.keys()])) {
      const place = this.controller.place(key);
      if (!place) continue;
      const board = this.sourcePositions.get('board:' + key);
      if (board) candidates.push({ x: board.x, z: board.z, reach: 6, kind: 'post', name: 'the Post & Errands board in ' + place.name });
      const well = this.plans?.[key]?.props?.find(prop => prop.kind === 'well');
      if (well) candidates.push({ x: well.x, z: well.z, reach: 6, kind: 'well', name: 'the well in ' + place.name });
    }
    for (const spot of this.stationSpots) candidates.push({ ...spot, reach: 26, kind: 'station' });
    for (const spot of this.nameSignSpots) if (spot.sign) candidates.push({ x: spot.sign.x, z: spot.sign.z, reach: 6, kind: 'post', name: 'the ' + story.bindings.places[spot.place].name + ' name board' });
    for (const post of this.fingerposts) candidates.push({ x: post.x, z: post.z, reach: 4, kind: 'post', name: 'the ' + post.destination + ' road post' });
    let best = null;
    for (const item of candidates) {
      const d = distance(player, item);
      if (d <= item.reach && (!best || d < best.d)) best = { item, d };
    }
    return best ? { x: best.item.x, z: best.item.z, kind: best.item.kind, name: best.item.name } : null;
  }
  /** Passing a name board, reading a village board or stepping onto its platform tells the courier where they are. */
  checkArrival(player) {
    const map = this.ui?.courierMap();
    if (!map) return;
    const spots = [
      ...this.nameSignSpots.filter(spot => spot.sign).map(spot => ({ place: spot.place, x: spot.sign.x, z: spot.sign.z, reach: 9 })),
      ...this.stationSpots.map(spot => ({ ...spot, reach: 28 })),
      ...[...this.noticeBoards.keys()].flatMap(key => {
        const board = this.sourcePositions.get('board:' + key);
        return board ? [{ place: key, x: board.x, z: board.z, reach: 7 }] : [];
      }),
    ];
    const reached = spots.find(spot => spot.place !== map.place && distance(player, spot) <= spot.reach);
    if (reached) this.ui.arrive(reached.place);
  }
  contextPrompt(playable) {
    if (!playable || this.ui?.isOpen || this.renderer.xr.isPresenting) return '';
    const shown = el => el && el.style.display !== 'none' && el.innerHTML ? el.innerHTML : '';
    if (this.rail.riding) return shown(this.rail.promptEl);
    const talk = shown(this.population.promptEl);
    if (talk) return talk;
    const board = this.nearbyBoards()[0];
    if (board) return '<b>E</b> · Read notices';
    if (this.nearbySources().length) return '<b>E</b> read the public accounts';
    const post = this.nearbyFingerpost();
    if (post) return '<b>E</b> read the road post';
    return shown(this.rail.promptEl);
  }
  updatePrompt(playable) {
    if (!this.promptEl) return;
    const text = this.contextPrompt(playable);
    if (text === this.promptText) return;
    this.promptText = text; this.promptEl.innerHTML = text; this.promptEl.style.display = text ? 'block' : 'none';
  }
  /** Geography for the courier's own map. The map page decides what has been uncovered. */
  mapData({ include = [] } = {}) {
    const story = this.controller.story;
    if (!story) return null;
    const map = this.notebook?.book?.map;
    const keys = [...new Set([...Object.keys(story.bindings.places), ...(map?.arrived || []), ...this.noticeBoards.keys(), ...include])]
      .filter(key => this.controller.place(key));
    if (!this.railLine) {
      this.railLine = [];
      const route = this.rail?.route;
      try {
        for (let d = 0; route && d <= route.length; d += 60) {
          const sample = route.sampleAtDistance(d, {});
          if (Number.isFinite(sample?.x) && Number.isFinite(sample?.z)) this.railLine.push({ x: sample.x, z: sample.z });
        }
      } catch { this.railLine = []; }
    }
    const rig = this.controls.rig.position;
    return {
      player: { x: rig.x, z: rig.z },
      rail: this.railLine,
      roads: (this.routePaths || []).map(path => path.points.map(point => ({ x: point.x, z: point.z }))),
      places: keys.map(key => [key, this.controller.place(key)]).map(([key, place]) => {
        const plan = this.plans?.[key], board = this.sourcePositions.get('board:' + key), well = plan?.props?.find(prop => prop.kind === 'well');
        return { key, name: place.name, x: place.x, z: place.z, station: !!place.stationId,
          board: board ? { x: board.x, z: board.z } : null, well: well ? { x: well.x, z: well.z } : null,
          // Boards face north, so a reader standing at one faces south.
          boardFacing: Math.PI,
          buildings: (plan?.buildings || []).map(b => ({ id: b.id, x: b.x, z: b.z, width: b.width, depth: b.depth, yaw: b.yaw })) };
      }),
    };
  }
  nearbySources() {
    if (!this.controller.story) return [];
    const player = this.controls.rig.position;
    return this.controller.sources().filter(s => distance(player, this.controller.getSourcePosition(s.sourceId) || { x: Infinity, z: Infinity }) <= 5);
  }
  update(dt, ready) {
    if (!this.prepared) return;
    const player = this.controls.rig.position;
    const playable = !!ready && !!this.isPlaying();
    this.ui?.renderReminder();
    if (playable) { this.ui?.explore(player.x, player.z); this.checkArrival(player); this.watchSettlements(player, dt); }
    this.ui?.renderHud(); this.updatePrompt(playable);
    const vrButton = document.getElementById('VRButton');
    if (vrButton && /NOT SUPPORTED/i.test(vrButton.textContent)) vrButton.style.visibility = playable || this.ui?.isOpen ? 'hidden' : '';
    if (playable && !this.welcomeOpened && this.firstWelcomePending
      && this.controller.story?.onboarding?.seen === false && !this.ui?.isOpen) {
      this.welcomeOpened = true; this.firstWelcomePending = false;
      this.ui?.open('welcome');
    }
    for (const root of this.roots) root.visible = ready && distance(root.position, player) < (root.userData.viewDistance || 260);
    this.animateBoards(this.getNight?.() || 0);
    if (this.loanHorse && this.horseRiding.mount !== this.loanHorse) {
      this.loanHorse.state = 'idle'; this.loanHorse.stateTimer = Infinity;
    }
    if (this.loanHorse) this.controller.story.mount = { x: this.loanHorse.mesh.position.x, z: this.loanHorse.mesh.position.z, heading: this.loanHorse.heading };
    const mode = this.rail.riding ? 'train' : this.horseRiding.riding ? 'horse' : 'foot';
    const airborne = !this.controls.grounded;
    this.controller.recordTravel(dt, { position: player, mode,
      sprint: this.controls.keys.has('ShiftLeft') || this.controls.keys.has('ShiftRight') || this.controls.xrActions.sprintHeld || this.controls.xrActions.run,
      jumped: mode === 'foot' && airborne && !this.jumpAirborne && this.controls.verticalVelocity > 0,
      active: ready && (this.isPlaying() || this.ui.isOpen) && (mode === 'train' || !this.ui.isOpen) });
    this.jumpAirborne = airborne;
    if (mode !== 'foot' && this.controller.story.resume) this.controller.story.resume = this.startPoint;
    if (this.controller.story.jobs['platform-cup'].state === 'delivered' && !this.cup) {
      this.cup = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.2, 16), new THREE.MeshStandardMaterial({ color: this.controller.story.jobs['platform-cup'].condition === 'chipped' ? 0xaca183 : 0xe4dac2, roughness: 0.7 }));
      this.cup.position.set(0.55, 1.36, 0); this.cupRoot.add(this.cup);
    }
    if (this.controller.story.works.personal && !this.workProp) {
      this.workProp = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.035, 0.24), new THREE.MeshStandardMaterial({ color: 0x6a7d64, roughness: 1 }));
      this.workProp.position.set(-0.45, 1.3, 0); this.cupRoot.add(this.workProp);
    }
    if (ready && this.renderer.xr.isPresenting && !this.ui.isOpen
      && this.population.activeNpc && this.population.activeNpc.distance <= 4.5
      && this.controls.xrActions.interactPressed && !this.rail.riding) {
      this.population.talk(); this.population.setPointerReleased();
    }
    if (this.ui.isOpen) this.population.dialogueEl.style.display = 'none';
  }
  /** Once a second: which settlement is the courier in, and has the story moved since it last looked? */
  watchSettlements(player, dt) {
    this.settlementTimer = (this.settlementTimer || 0) - dt;
    if (this.settlementTimer > 0) return;
    this.settlementTimer = 1;
    try {
      const key = this.settlementAt(player);
      if (key) this.visitSettlement(key);
    } catch (error) { console.warn('[courier director]', error); }
  }
  async restart() {
    const store = this.population.livingWorldStore;
    store.suspendWrites = true;
    if (this.controller.story) this.controller.story.runId = 'restarting';
    this.director.runtime.cancelWhere(job => job.kind === 'creative-work');
    this.controller.pendingWorks.clear();
    try {
      const state = this.population.worldState;
      const notebook = this.notebook || new NotebookStore({ key: COURIER_PREFIX + 'book.' + state.worldSeed
        + worldGenerationScope(state.worldGeneration) + '.' + state.playerId });
      await notebook.clear();
      localStorage.removeItem(store.key());
      const prefixes = [COURIER_PREFIX + 'memory.', COURIER_PREFIX + 'encounters.'];
      for (const key of Object.keys(localStorage)) if (prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
      location.reload();
    } catch (error) { store.suspendWrites = false; throw error; }
  }
}
