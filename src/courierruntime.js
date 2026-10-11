import * as THREE from 'three';
import { CourierController, initializeCourier } from './courier.mjs';
import { COURIER_PREFIX, COURIER_ROLES } from './couriercontent.mjs';
import { NotebookStore } from './notebook.mjs';
import { CourierUI } from './courierui.js';
import { CourierXRPanel } from './courierxr.js';
import { settlementsAround } from './settlementplacement.mjs';
import { cachedSettlementPlan } from './settlementspatial.mjs';
import { activateSettlementResidents } from './npcresidenceregistry.mjs';
import { createSettlementResidentIdentity } from './npcresidentidentity.mjs';
import { settlementOrigin } from './settlementorigin.mjs';
import { findRoute } from './npcnavgraph.mjs';
import { trailFrameAtArc } from './trails.js';
import { worldGenerationScope } from './worldgeneration.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export class CourierRuntime {
  constructor(options) {
    Object.assign(this, options); this.prepared = false; this.preparing = null;
    this.roots = []; this.sourcePositions = new Map(); this.jumpAirborne = false;
    this.controller = new CourierController({
      getState: () => this.population.worldState, getPlayer: () => this.controls.rig.position,
      getNpcPosition: id => this.population.actorById(id)?.avatar?.root?.position || null,
      getSourcePosition: id => this.sourcePositions.get(id) || null,
      save: () => this.population.saveLivingWorldState(true), director: this.director,
    });
    this.onKey = event => {
      if (event.code !== 'KeyE' || event.repeat || !this.isPlaying() || this.ui?.isOpen
        || this.rail.riding || ['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) return;
      if (this.nearbySources().length) { this.ui.open('stories'); event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this.onKey, true);
  }
  isCast(id) { return !!this.controller.roleFor(id); }
  castIds() { return Object.values(this.controller.story?.bindings.cast || {}).map(c => c.id); }
  async prepare(plan) {
    if (this.prepared || this.preparing || !plan?.stations?.length) return this.preparing;
    this.preparing = (async () => {
      this.setStatus('Preparing the courier communities and their roads…');
      const bindings = this.selectBindings(plan);
      const state = this.population.worldState;
      initializeCourier(state, bindings);
      // Revalidate persisted bindings against the current generation and plans.
      for (const place of Object.values(this.controller.story.bindings.places)) {
        if (!bindings.places[place.key] || bindings.places[place.key].id !== place.id) throw new Error('The courier landscape has changed. Restart this proof to bind its new communities.');
      }
      for (const [role, person] of Object.entries(bindings.cast)) {
        this.controller.story.bindings.cast[role].home.address = person.home.address;
      }
      this.createReadingStands(); this.createTrailSigns();
      const key = COURIER_PREFIX + 'book.' + state.worldSeed + worldGenerationScope(state.worldGeneration) + '.' + state.playerId;
      this.notebook = new NotebookStore({ key }); await this.notebook.load();
      this.ui = new CourierUI({ controller: this.controller, notebook: this.notebook,
        population: this.population, controls: this.controls, renderer: this.renderer,
        onOpen: this.onPanelOpen, onClose: this.onPanelClose,
        onRestart: () => this.restart(), onReturn: this.returnToNormal, canOpen: this.isPlaying,
        getNearbySources: () => this.nearbySources(),
      });
      this.xrPanel = new CourierXRPanel({ ui: this.ui, renderer: this.renderer, scene: this.scene,
        camera: this.camera, controls: this.controls, canOpen: this.isPlaying });
      this.rail.mapEl.classList.add('courier-route-hidden');
      const horsePoint = this.safePoint(state.courier.mount) ? state.courier.mount : this.horsePoint;
      if (!this.safePoint(horsePoint)) throw new Error('The courier horse needs a safe place to stand.');
      this.loanHorse = this.animals.stagePreview('horse', horsePoint.x, horsePoint.z, horsePoint.x, horsePoint.z + 1, Infinity);
      this.loanHorse.state = 'idle'; this.loanHorse.stateTimer = Infinity;
      this.loanHorse.previewTimer = Infinity; this.loanHorse.sharedId = 'courier:loan-horse';
      this.loanHorse.heading = Number(horsePoint.heading) || 0;
      state.courier.mount = { x: horsePoint.x, z: horsePoint.z, heading: this.loanHorse.heading };
      const resume = state.courier.resume;
      const start = resume && this.safePoint(resume) ? resume : this.startPoint;
      this.prepared = true; this.population.saveLivingWorldState(true);
      this.onPrepared(start);
      this.ui.notify('First Post: work is optional. T talks to a nearby person; E reads public accounts; N opens your notebook. In VR, right grip opens the book.');
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
      const identities = eligible(record, state);
      const roles = Object.keys(COURIER_ROLES).filter(role => COURIER_ROLES[role] === key);
      if (identities.length < roles.length) throw new Error('Not enough adult residents in ' + places[key].name);
      roles.forEach((role, i) => {
        const identity = identities[i], entity = state.entities[identity.id];
        const home = record.plan.buildings.find(b => b.id === entity.residence.homeBuildingId);
        const well = record.plan.props.find(p => p.kind === 'well') || record.plan.site;
        const dx = home.x - well.x, dz = home.z - well.z;
        const directions = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
        const compass = directions[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8];
        cast[role] = { id: identity.id, name: identity.name, place: key,
          home: { id: home.id, name: identity.name + '’s home', x: home.x, z: home.z,
            address: identity.name + '’s household, ' + compass + ' of the central well in ' + places[key].name } };
      });
    }
    this.routePaths = []; const routes = {};
    for (const [key, from] of Object.entries(places)) {
      routes[key] = [];
      for (const [destination, to] of Object.entries(places)) {
        if (destination === key) continue;
        const route = findRoute(graph, from.nodeKey, to.nodeKey);
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
        this.routePaths.push({ destination: to.name, to, points });
        const first = points[0] || { id: 'courier:entrance:' + key, name: 'the trail entrance', x: records[key].plan.site.regionalEntrance.x, z: records[key].plan.site.regionalEntrance.z };
        routes[key].push({ place: destination, name: to.name, targetId: first.id,
          target: { id: first.id, name: first.name, worldX: first.x, worldZ: first.z,
            direction: 'along the signed trail', distancePhrase: 'just along the road', kind: 'trail-marker' },
          instructions: 'For ' + to.name + ', leave ' + from.name + ' by ' + first.name + '. Follow the physical road posts marked “' + to.name + '”; they stay with the trail at its bends and junctions. '
            + (from.stationId && to.stationId ? 'You can also board the regional train at ' + from.name + ' and step off at ' + to.name + '. Ask which stop is next before boarding.' : 'At the settlement, ask a neighbor about the recipient’s home or workplace.') });
      }
    }
    this.startPoint = this.openPoint(records.A.plan, 3); this.horsePoint = this.openPoint(records.A.plan, 11);
    return { places, cast, routes };
  }
  augmentContext(context, actor) {
    const courier = this.controller.story && this.controller.contextForNpc(actor.identity.id);
    if (!courier) return context;
    const targets = courier.routes.map(r => r.target);
    return { ...context, courier, targets: [...targets, ...(context.targets || [])],
      pointPlaces: [...targets, ...(context.pointPlaces || [])] };
  }
  label(text, width = 512, height = 100) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ded0ab'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#29392f'; ctx.font = 'bold 36px Georgia'; ctx.textAlign = 'center'; ctx.fillText(text.slice(0, 26), width / 2, height / 2 + 12);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: true, side: THREE.DoubleSide });
  }
  createReadingStands() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x66583e, roughness: 1 });
    for (const [key, place] of Object.entries(this.controller.story.bindings.places)) {
      const point = this.openPoint(this.plans[key]);
      const root = new THREE.Group(); root.position.set(point.x, this.groundAt(point.x, point.z), point.z);
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.2, 0.3), wood); legs.position.y = 0.6;
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.65), wood); desk.position.y = 1.2;
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.32), this.label('Public accounts · E / N'));
      paper.rotation.x = -Math.PI / 2; paper.position.set(0, 1.26, 0);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.27), this.label(place.name)); sign.position.set(0, 1.65, 0);
      root.add(legs, desk, paper, sign); this.scene.add(root); this.roots.push(root);
      for (const source of this.controller.sources().filter(s => s.place === key)) this.sourcePositions.set(source.sourceId, root.position);
      if (key === 'B') { this.workPosition = root.position; this.cupRoot = root; }
    }
  }
  createTrailSigns() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x5f523d, roughness: 1 });
    const made = new Set(); let count = 0;
    const signs = this.routePaths.flatMap(path => path.points.map((point, i) => ({ path, point, next: path.points[i + 1] || path.to })));
    signs.sort((a, b) => Number(!!b.point.junction) - Number(!!a.point.junction));
    for (const { path, point, next } of signs) {
      const key = Math.round(point.x / 8) + ':' + Math.round(point.z / 8) + ':' + path.destination;
      if (made.has(key) || count >= 72) continue; made.add(key); count++;
      const root = new THREE.Group(); root.position.set(point.x, this.groundAt(point.x, point.z), point.z);
      root.rotation.y = Math.atan2(-(next.z - point.z), next.x - point.x);
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), wood); pole.position.y = 0.7;
      const material = this.label(path.destination);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.22), material); sign.position.set(0, 1.25, 0.01);
      const reverse = new THREE.Mesh(sign.geometry, material); reverse.position.set(0, 1.25, -0.01); reverse.rotation.y = Math.PI;
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute([0.525, 1.14, 0, 0.78, 1.25, 0, 0.525, 1.36, 0], 3));
      const arrow = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xded0ab, roughness: 1, side: THREE.DoubleSide }));
      root.add(pole, sign, reverse, arrow); this.scene.add(root); this.roots.push(root);
    }
  }
  nearbySources() {
    if (!this.controller.story) return [];
    const player = this.controls.rig.position;
    return this.controller.sources().filter(s => distance(player, this.sourcePositions.get(s.sourceId) || { x: Infinity, z: Infinity }) <= 5);
  }
  update(dt, ready) {
    if (!this.prepared) return;
    const player = this.controls.rig.position;
    for (const root of this.roots) root.visible = ready && distance(root.position, player) < 260;
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
  async restart() {
    const store = this.population.livingWorldStore;
    store.suspendWrites = true;
    if (this.controller.story) this.controller.story.runId = 'restarting';
    this.director.runtime.cancelWhere(job => job.kind === 'creative-work');
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
