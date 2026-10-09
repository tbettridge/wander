// Service-led rail demand. All passengers are persistent residents with a real
// round trip; viewing distance and the player's presence never choose traffic.
import { createItinerary, currentItineraryLeg } from './npcitinerary.mjs';
import { activeNpcItinerary, loadNpcItinerary, registerNpcItinerary, railVehiclePassengerManifest, releaseMissedRailReservations } from './npcmobility.mjs';
import { tickNpcMobilityItinerary } from './npcmobilityexecutor.mjs';
import { trainPassengerTarget } from './npcmobilitydemand.mjs';
import { createTravelGroup, groupForActor, GROUP_STATE } from './npcgroup.mjs';
import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';
import { railVehicleId } from './railpassengers.mjs';
import { householdAgeBand } from './npcpopulation.mjs';

const TERMINAL = new Set(['completed', 'failed']);
const WORK_PLACES = new Set(['workshop', 'inn', 'market', 'shop', 'store']);

export function scheduleRailPassengerTraffic(state, {
  stations = [], service = null, hour = state?.clock?.worldHours ?? 12,
  bootstrap = false, excludedActorIds = [], platformLocationFor = defaultPlatform,
  walkDurationFor = () => 20,
} = {}) {
  const result = { planned: [], rejected: [], bootstrapped: [], target: null };
  if (!state?.features?.unifiedNpcMobilityEnabled || !state.features.npcRailTravelEnabled) return result;
  if (!service?.runId || stations.length < 2) return result;
  const byId = new Map(stations.map((station) => [station.id, station]));
  if (byId.size !== stations.length || stations.some((station) => !station.settlementId || !station.plan)) {
    result.rejected.push({ reason: 'incomplete-station-catalog' }); return result;
  }
  const vehicleId = railVehicleId(service.runId);
  state.railTraffic ||= {};
  const traffic = state.railTraffic[vehicleId] ||= {
    sequence: 0, lastPlannedSeconds: -Infinity, bootstrapped: false,
    lastDepartureSequence: service.departureSequence || 0,
    departures: 0, occupiedDepartures: 0, totalPassengers: 0,
    periodSamples: {}, cooldowns: {}, errors: {},
  };
  // JSON checkpoints must contain finite numbers, including before first plan.
  if (!Number.isFinite(traffic.lastPlannedSeconds)) traffic.lastPlannedSeconds = -10;
  const demand = trainPassengerTarget({ worldSeed: state.worldSeed, runId: service.runId,
    departureSequence: service.departureSequence || 0, hour });
  result.target = demand;
  releaseMissedRailReservations(state, service);
  const occupants = railVehiclePassengerManifest(state, service.runId).reservations({ includeAlighted: false });
  if ((service.departureSequence || 0) !== traffic.lastDepartureSequence) {
    const count = occupants.filter((r) => r.status === 'boarded' && r.kind === 'npc').length;
    traffic.lastDepartureSequence = service.departureSequence;
    traffic.departures++;
    if (count >= 1 && count <= 6) traffic.occupiedDepartures++;
    traffic.totalPassengers += count;
    const sample = traffic.periodSamples[demand.period] ||= { departures: 0, passengers: 0 };
    sample.departures++; sample.passengers += count;
  }
  finishRailGroups(state);
  const key = `${service.runId}|${service.nextStationId}|${service.phase === 'dwelling'}|${demand.period}`;
  const seconds = Number(service.serviceTick) || 0;
  if (!bootstrap && key === traffic.lastPlanKey && seconds >= traffic.lastPlannedSeconds
    && seconds - traffic.lastPlannedSeconds < 5) return result;
  traffic.lastPlanKey = key; traffic.lastPlannedSeconds = seconds;
  const excluded = new Set(excludedActorIds);
  const context = { state, stations, service, byId, traffic, platformLocationFor, walkDurationFor, excluded, hour };

  // Populate a fresh, not-yet-visible service by advancing genuine earlier
  // journeys. Reloads reuse their saved trips and never reseed watched cars.
  if (bootstrap && !traffic.bootstrapped) {
    const current = Math.max(0, stations.findIndex((station) => station.id === (service.stationId || service.nextStationId)));
    const origin = stations[(current + stations.length - 1) % stations.length];
    const destination = stations[(current + 1) % stations.length];
    let missing = Math.max(0, demand.target - occupants.filter((r) => r.status === 'boarded').length);
    while (missing > 0) {
      const trips = planParty(context, origin, missing, destination);
      if (!trips.length) break;
      result.planned.push(...trips); missing -= trips.length;
    }
    const virtualStop = { ...service, stationId: origin.id, nextStationId: destination.id,
      phase: 'dwelling', doorFactor: 1, dwellRemaining: 1000,
      npcPassengerLimit: 6,
      boardingApproachFor: null, alightingEgressFor: null, etaSeconds: null };
    const ids = result.planned.map((trip) => trip.actorId);
    const walkSeconds = Math.max(0, ...result.planned.map((trip) => trip.legs[0].data.durationSeconds));
    for (let elapsed = 0; elapsed <= walkSeconds + 30; elapsed++) {
      for (const id of ids) {
        tickNpcMobilityItinerary(state, id, { deltaSeconds: 1, worldHours: state.clock.worldHours, railServices: [virtualStop] });
      }
      if (ids.every((id) => state.entities[id].activity?.legKind === 'train-ride')) break;
    }
    result.bootstrapped.push(...ids.filter((id) => ['train-seat', 'train-carriage'].includes(state.entities[id]?.location?.kind)));
    traffic.bootstrapped = true;
  }

  // Walkers for the next stops leave early. Forecast the people who continue
  // past each stop, so a train doesn't empty whenever its current riders alight.
  let next = stations.findIndex((station) => station.id === service.nextStationId);
  if (next < 0) return result;
  const occupied = railVehiclePassengerManifest(state, service.runId).reservations({ includeAlighted: false });
  const riders = new Map(occupied.filter((r) => r.status === 'boarded').map((r) => [r.personId, r.destinationStationId]));
  let eta = service.phase === 'dwelling' ? 0 : Math.max(0, service.etaSeconds || 0);
  const pending = pendingBoardings(state, vehicleId);
  const arrivalEstimates = new Map();
  for (let offset = 0; offset < stations.length; offset++) {
    const origin = stations[(next + offset) % stations.length];
    arrivalEstimates.set(origin.id, eta);
    for (const [id, destinationId] of riders) if (destinationId === origin.id) riders.delete(id);
    const arriving = pending.filter((p) => p.originStationId === origin.id && p.remainingWalkSeconds <= eta + 10);
    for (const trip of arriving) riders.set(trip.actorId, trip.destinationStationId);
    const expectedHour = hour; // The same authoritative sky period as the live service.
    const target = trainPassengerTarget({ worldSeed: state.worldSeed, runId: service.runId,
      departureSequence: (service.departureSequence || 0) + offset, hour: expectedHour }).target;
    let missing = Math.max(0, target - riders.size);
    // Don't stack a new quota behind a missed train's already waiting people.
    missing = Math.min(missing, Math.max(0, 6 - pending.filter((p) => p.originStationId === origin.id).length));
    while (missing > 0) {
      const h = ((hour % 24) + 24) % 24;
      const pendingCount = pending.filter((p) => p.originStationId === origin.id).length;
      // A daytime family may use spare capacity above the soft demand target.
      // Counting only the one-person shortfall otherwise almost never leaves
      // a three-person household an opportunity to travel together.
      const partyBudget = h >= 6 && h < 22
        ? Math.min(6 - pendingCount, Math.max(missing, Math.min(3, 6 - riders.size))) : missing;
      const trips = planParty(context, origin, partyBudget);
      if (!trips.length) break;
      result.planned.push(...trips);
      for (const trip of trips) {
        const board = trip.legs.find((leg) => leg.kind === 'board-train');
        const walk = trip.legs[0].data.durationSeconds;
        const p = { actorId: trip.actorId, originStationId: origin.id,
          destinationStationId: board.data.destinationStationId, remainingWalkSeconds: walk };
        pending.push(p);
        if (walk <= eta + 10) riders.set(trip.actorId, p.destinationStationId);
      }
      missing -= trips.length;
    }
    eta += (origin.segmentSeconds || 90) + (service.dwell || 16);
  }
  if (bootstrap && result.bootstrapped.length) {
    // Villages can be several minutes' walk from their platform. The service
    // was already operating before world entry, so its upcoming passengers
    // also started their access walks earlier. Never do this in a watched or
    // restored world: normal planning maintains the established pipeline.
    const seeded = new Set(result.bootstrapped);
    for (const trip of result.planned) {
      if (seeded.has(trip.actorId)) continue;
      const access = trip.legs[0];
      const arrival = arrivalEstimates.get(trip.purpose.originStationId) ?? 0;
      const earlierSeconds = Math.max(0, access.data.durationSeconds - Math.max(0, arrival - 18));
      if (earlierSeconds) tickNpcMobilityItinerary(state, trip.actorId, {
        deltaSeconds: earlierSeconds, worldHours: state.clock.worldHours, railServices: [],
      });
    }
  }
  pruneRailHistory(state, service.runId);
  state.revision++;
  return result;
}

function planParty(context, origin, budget, forcedDestination = null) {
  const { state, traffic, excluded } = context;
  const committed = new Set(Object.values(state.commitments || {}).filter((c) => !['resolved', 'failed'].includes(c.state)).map((c) => c.actorId));
  const available = (entity) => entity?.kind === 'npc' && !entity.tombstone && !entity.itineraryId
    && !entity.inTransit && !excluded.has(entity.id) && !committed.has(entity.id)
    && normalizeNpcResidence(entity.residence)?.residenceSettlementId === origin.settlementId
    && normalizeNpcLocation(entity.location)?.kind === 'building'
    && entity.location.settlementId === origin.settlementId
    && (!entity.activity || ['home', 'idle', 'routine'].includes(entity.activity.kind))
    && !groupForActor(state, entity.id)
    && (traffic.cooldowns[entity.id] == null || state.clock.worldHours - traffic.cooldowns[entity.id] >= 1);
  const away = (origin.residentIds || []).filter((id) => state.entities[id]?.itineraryId).length;
  budget = Math.min(budget, Math.max(0, Math.floor((origin.residentIds || []).length * 0.5) - away));
  if (budget < 1) return [];
  const candidates = (origin.residentIds || []).map((id) => state.entities[id]).filter(available)
    .sort((a, b) => hash(`${state.worldSeed}|${traffic.sequence}|${a.id}`) - hash(`${state.worldSeed}|${traffic.sequence}|${b.id}`) || a.id.localeCompare(b.id));
  const adults = candidates.filter((entity) => {
    const family = state.households[entity.householdId];
    const age = householdAgeBand(family?.form, Math.max(0, family?.memberIds.indexOf(entity.id) ?? 0), family?.memberIds.length ?? 1, entity.id);
    return age !== 'child' && entity.lifeStage !== 'child' && entity.ageBand !== 'child' && entity.role !== 'child';
  });
  let leader = adults[0];
  if (!leader) return [];
  let members = [leader];
  const day = Math.floor(state.clock.worldHours / 24);
  const daylight = ((context.hour % 24) + 24) % 24 >= 6 && ((context.hour % 24) + 24) % 24 < 20;
  if (budget >= 2 && state.features.travelGroupsEnabled !== false
    && ((daylight && traffic.lastFamilyDay !== day) || hash(`${state.worldSeed}|${traffic.sequence}|family`) % 4 === 0)) {
    const parent = adults.find((entity) => {
      const family = state.households[entity.householdId];
      return family && ['partners', 'siblings'].includes(family.form)
        && family.memberIds.length >= 2 && family.memberIds.length <= Math.min(6, budget)
        && family.memberIds.every((id) => available(state.entities[id]));
    });
    if (parent) { leader = parent; members = state.households[parent.householdId].memberIds.map((id) => state.entities[id]); }
  }
  const sequence = traffic.sequence + 1;
  const purposes = ['friend-visit', 'family-visit', 'pleasure-trip', 'work-errand'];
  const morning = context.hour % 24 >= 6 && context.hour % 24 < 9;
  let reason = morning && sequence % 2 === 0 ? 'work-errand' : purposes[sequence % purposes.length];
  if (reason === 'work-errand' && !leader.workplaceId) reason = 'friend-visit';
  if (members.length > 1 && reason === 'work-errand') reason = 'family-visit';
  if (reason === 'pleasure-trip' && !state.features.npcLeisureTravelEnabled) reason = 'friend-visit';
  const choice = chooseDestination(context, leader, origin, reason, forcedDestination);
  if (!choice) return [];
  const { destination, host, location } = choice;
  const groupId = members.length > 1 ? `group:${leader.id}:${(state.groupSequences[leader.id] || 0) + 1}` : null;
  const kind = reason === 'work-errand' ? 'work' : reason === 'pleasure-trip' ? 'leisure' : 'visit';
  const description = reason === 'work-errand' ? `running an errand for ${leader.workplaceName || 'work'} in ${destination.name || destination.id}`
    : reason === 'pleasure-trip' ? `taking a pleasure trip to ${destination.name || destination.id}`
      : `visiting ${reason === 'family-visit' ? 'family' : 'a friend'}${host ? `, ${host.name}` : ''} in ${destination.name || destination.id}`;
  const durationHours = reason === 'work-errand' ? 0.35 : reason === 'pleasure-trip' ? 2 : 1.25;
  const purpose = { kind, reason, description, transport: 'rail', groupId,
    vehicleId: railVehicleId(context.service.runId),
    originStationId: origin.id, destinationStationId: destination.id,
    originName: origin.name || origin.id, destinationName: destination.name || destination.id,
    targetEntityId: host?.id || null, targetHouseholdId: host?.householdId || null,
    workplaceId: leader.workplaceId || null, durationHours,
    companionNames: members.filter((m) => m.id !== leader.id).map((m) => m.name) };
  const platform = (station, actor) => context.platformLocationFor(station, actor, leader.id);
  try {
    const access = Math.max(...members.map((m) => context.walkDurationFor(m.location, platform(origin, m), m)));
    const egress = Math.max(...members.map((m) => context.walkDurationFor(platform(destination, m), location, m)));
    const returnWalk = Math.max(...members.map((m) => context.walkDurationFor(platform(origin, m), {
      kind: 'building', settlementId: m.residence.residenceSettlementId, buildingId: m.residence.homeBuildingId, nodeId: null,
    }, m)));
    const trips = members.map((entity) => {
      const home = { kind: 'building', settlementId: entity.residence.residenceSettlementId,
        buildingId: entity.residence.homeBuildingId, nodeId: null };
      const accommodation = hash(`${entity.id}|${sequence}|place`) % 7 === 0 ? 'standing' : 'seat';
      return createItinerary({ id: `rail-trip:${railVehicleId(context.service.runId)}:${sequence}:${entity.id}`,
        actorId: entity.id, residence: entity.residence,
        origin: { key: entity.location.buildingId, settlementId: origin.settlementId },
        destination: { key: destination.settlementId, settlementId: destination.settlementId },
        purpose: { ...purpose, accommodation, companionNames: members.filter((m) => m.id !== entity.id).map((m) => m.name) },
        outboundLegs: railLegs('outbound', entity.location, location, origin.id, destination.id,
          platform(origin, entity), platform(destination, entity), context.service.serviceId, access, egress),
        activity: { kind, data: { reason, durationSeconds: 0, durationHours, location } },
        returnLegs: railLegs('return', location, home, destination.id, origin.id,
          platform(destination, entity), platform(origin, entity), context.service.serviceId, egress, returnWalk),
      });
    });
    // Registration of a party is atomic too: one invalid member must not send
    // half a household away or consume group sequence numbers.
    const draft = { ...state, entities: { ...state.entities }, itineraries: { ...state.itineraries },
      groups: { ...state.groups }, groupSequences: { ...state.groupSequences }, metrics: { ...state.metrics } };
    for (const member of members) draft.entities[member.id] = JSON.parse(JSON.stringify(member));
    if (groupId) {
      const group = createTravelGroup(draft, { memberIds: members.map((m) => m.id), leaderId: leader.id,
        transport: 'rail', purpose, episode: 'rail-journey' });
      if (!group || group.id !== groupId) return [];
      group.itineraryIds = trips.map((trip) => trip.id); group.state = GROUP_STATE.together;
    }
    for (const trip of trips) registerNpcItinerary(draft, trip);
    for (const member of members) Object.assign(member, draft.entities[member.id]);
    state.itineraries = draft.itineraries; state.groups = draft.groups;
    state.groupSequences = draft.groupSequences; state.metrics = draft.metrics; state.revision = draft.revision;
    traffic.sequence = sequence;
    if (groupId) traffic.lastFamilyDay = day;
    for (const member of members) traffic.cooldowns[member.id] = state.clock.worldHours;
    if (host && ['friend-visit', 'family-visit'].includes(reason)) connectHosts(state, leader, host, reason);
    return trips;
  } catch (error) {
    traffic.errors[leader.id] = { message: String(error.message || error), atHour: state.clock.worldHours };
    return [];
  }
}

function chooseDestination(context, leader, origin, reason, forced) {
  const { state, stations } = context;
  const candidates = stations.filter((s) => s.id !== origin.id && (!forced || s.id === forced.id));
  const matches = Object.values(state.relationships || {}).filter((edge) => edge.ownerId === leader.id
    && edge.tags?.includes(reason === 'family-visit' ? 'family' : 'friend'));
  const linked = matches.map((edge) => state.entities[edge.subjectId]).find((person) =>
    person && !person.tombstone && !person.itineraryId
    && candidates.some((s) => s.settlementId === person.residence?.residenceSettlementId));
  const destination = linked ? candidates.find((s) => s.settlementId === linked.residence.residenceSettlementId)
    : candidates[hash(`${leader.id}|${context.traffic.sequence}|destination`) % candidates.length];
  if (!destination) return null;
  const hosts = (destination.residentIds || []).map((id) => state.entities[id])
    .filter((e) => e?.kind === 'npc' && !e.tombstone && !e.itineraryId && e.residence?.homeBuildingId);
  const host = linked || hosts[hash(`${leader.id}|host`) % Math.max(1, hosts.length)];
  let location;
  if (['friend-visit', 'family-visit'].includes(reason) && host) {
    location = { kind: 'building', settlementId: destination.settlementId,
      buildingId: host.residence.homeBuildingId, nodeId: null };
  } else {
    const building = destination.plan.buildings?.find((b) => reason === 'work-errand'
      ? WORK_PLACES.has(b.program) : ['market', 'inn'].includes(b.program));
    const centre = destination.plan.localGraph?.nodes?.find((node) => node.kind === 'centre');
    location = building ? { kind: 'building', settlementId: destination.settlementId, buildingId: building.id, nodeId: null }
      : centre ? { kind: 'settlement-node', settlementId: destination.settlementId, nodeId: centre.key } : null;
  }
  return location ? { destination, host, location } : null;
}

function connectHosts(state, actor, host, reason) {
  for (const [owner, subject] of [[actor, host], [host, actor]]) {
    const key = `${owner.id}->${subject.id}`;
    const relationship = state.relationships[key] ||= { ownerId: owner.id, subjectId: subject.id,
      familiarity: 0.7, affinity: 0.6, trust: 0.65, obligation: reason === 'family-visit' ? 0.55 : 0.2,
      tags: reason === 'family-visit' ? ['family', 'relative'] : ['friend'] };
    relationship.tags = [...new Set([...(relationship.tags || []), ...(reason === 'family-visit' ? ['family', 'relative'] : ['friend'])])];
  }
}

function railLegs(direction, from, to, origin, destination, originPlatform, destinationPlatform, serviceId, access, egress) {
  const id = (name) => `${direction}:${name}`;
  const data = { originStationId: origin, destinationStationId: destination, serviceId, doorQueue: true };
  return [
    { id: id('walk-station'), kind: 'local-walk', data: { durationSeconds: Math.max(1, access), fromLocation: from, toLocation: originPlatform } },
    { id: id('wait'), kind: 'station-wait', data: { ...data, platformLocation: originPlatform } },
    { id: id('board'), kind: 'board-train', data: { ...data, platformLocation: originPlatform } },
    { id: id('ride'), kind: 'train-ride', data },
    { id: id('alight'), kind: 'alight-train', data: { ...data, platformLocation: destinationPlatform } },
    { id: id('walk-destination'), kind: 'local-walk', data: { durationSeconds: Math.max(1, egress), fromLocation: destinationPlatform, toLocation: to } },
  ];
}

function pendingBoardings(state, vehicleId) {
  const records = [];
  for (const entity of Object.values(state.entities || {})) {
    if (!entity.itineraryId || entity.tombstone || ['train-seat', 'train-carriage'].includes(entity.location?.kind)) continue;
    let trip;
    try { trip = activeNpcItinerary(state, entity.id); } catch { continue; }
    const current = trip && currentItineraryLeg(trip);
    if (trip?.purpose?.vehicleId && trip.purpose.vehicleId !== vehicleId) continue;
    if (!current || current.direction === 'activity') continue;
    const remaining = trip.legs.slice(trip.legIndex).filter((leg) => leg.direction === current.direction);
    const board = remaining.find((leg) => leg.kind === 'board-train');
    if (!board) continue;
    let remainingWalkSeconds = 0;
    for (const leg of remaining) {
      if (leg.id === board.id) break;
      if (['local-walk', 'regional-walk'].includes(leg.kind)) {
        remainingWalkSeconds += Math.max(0, (leg.data.durationSeconds || 0)
          - (entity.activity?.executor?.legId === leg.id ? entity.activity.executor.elapsedSeconds || 0 : 0));
      }
    }
    records.push({ actorId: entity.id, originStationId: board.data.originStationId,
      destinationStationId: board.data.destinationStationId, remainingWalkSeconds });
  }
  return records;
}

function finishRailGroups(state) {
  for (const group of Object.values(state.groups || {})) {
    if (group.transport !== 'rail' || group.state === GROUP_STATE.dissolved) continue;
    if (group.itineraryIds.every((id) => { try { return TERMINAL.has(loadNpcItinerary(state, id)?.status); } catch { return false; } })) {
      group.state = GROUP_STATE.dissolved; group.episode = 'returned-home';
    }
  }
}

function pruneRailHistory(state, runId) {
  const finished = Object.entries(state.itineraries || {}).filter(([, trip]) =>
    TERMINAL.has(trip.status || trip.s) && (trip.purpose || trip.p)?.transport === 'rail');
  for (const [id] of finished.slice(0, Math.max(0, finished.length - 64))) delete state.itineraries[id];
  const old = Object.entries(state.railManifests || {}).filter(([id, manifest]) => id !== runId
    && (manifest.reservations || []).every((r) => ['alighted', 'cancelled'].includes(r.status)));
  for (const [id] of old.slice(0, Math.max(0, old.length - 8))) delete state.railManifests[id];
  for (const [id, group] of Object.entries(state.groups || {})) {
    if (group.transport === 'rail' && group.state === GROUP_STATE.dissolved && group.itineraryIds.every((trip) => !state.itineraries[trip])) delete state.groups[id];
  }
}

function defaultPlatform(station, actor, leaderId) {
  return { kind: 'station-platform', stationId: station.id,
    platformId: `${station.id}:platform:main`, waitAnchorId: `rail:${station.id}:${leaderId}:${actor.id}` };
}

export function npcRailJourneyContext(state, actorId) {
  let trip;
  try { trip = activeNpcItinerary(state, actorId); } catch { return null; }
  if (trip?.purpose?.transport !== 'rail') return null;
  const leg = currentItineraryLeg(trip);
  const p = trip.purpose;
  return { purpose: p.description, reason: p.reason, from: p.originName, to: p.destinationName,
    phase: leg.kind, returning: leg.direction === 'return', companions: p.companionNames,
    visitingPerson: state.entities[p.targetEntityId]?.name || null,
    returnPlan: 'Return to my own home after the visit.', residenceUnchanged: true };
}

function hash(text) {
  let value = 2166136261;
  for (const character of text) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
