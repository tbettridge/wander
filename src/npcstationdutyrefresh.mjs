// Live, deterministic station-duty refresh orchestration.
//
// This module owns no clock and renders nothing. Callers explicitly present the
// canonical station contexts and current living-world state. The returned
// snapshot is JSON-safe and can be handed back on the next refresh.

import {
  applyStationDutyRoster,
  planStationDutyRoster,
} from './npcstationduty.mjs';

export const STATION_DUTY_REFRESH_SNAPSHOT_VERSION = 1;

/**
 * Reconcile all canonical station-duty rosters at most once per half-hour
 * demand bucket. A context change (including station removal) also forces a
 * reconciliation. Feature-disabled calls are strict no-ops and publish no
 * active roster projection.
 */
export function refreshStationDutyRosters({ state, contexts = [], snapshot = null } = {}) {
  requireState(state);
  const prior = restoreStationDutyRefreshSnapshot(snapshot);
  if (state.features?.unifiedNpcMobilityEnabled !== true) {
    return frozenResult({
      enabled: false,
      refreshed: false,
      applied: false,
      dayIndex: prior.dayIndex,
      hourBucket: prior.hourBucket,
      rosters: {},
      snapshot: prior,
    });
  }

  const normalizedContexts = normalizeContexts(contexts);
  const contextSignature = stableJson(normalizedContexts);
  const { dayIndex, hourBucket, hour } = demandClock(state.clock?.worldHours);
  if (prior.dayIndex === dayIndex
    && prior.hourBucket === hourBucket
    && prior.contextSignature === contextSignature) {
    return frozenResult({
      enabled: true,
      refreshed: false,
      applied: false,
      dayIndex,
      hourBucket,
      rosters: rosterRecord(prior.rosters),
      snapshot: prior,
    });
  }

  const priorRosters = new Map(prior.rosters.map((roster) => [roster.stationId, roster]));
  const nextRosters = [];
  const changedIds = [];
  const unchangedIds = [];
  const releasedIds = [];
  const conflictedIds = [];
  const changedStationIds = [];
  const removedStationIds = [];
  const nextStationIds = new Set(normalizedContexts.map((context) => context.stationId));

  // Release removed stations first. The existing apply contract guards a newer
  // itinerary/location from being teleported home by stale duty activity.
  for (const oldRoster of prior.rosters) {
    if (nextStationIds.has(oldRoster.stationId)) continue;
    collectApplication(applyStationDutyRoster(state, emptyRoster(oldRoster)), {
      changedIds, unchangedIds, releasedIds, conflictedIds,
    });
    removedStationIds.push(oldRoster.stationId);
  }

  for (const context of normalizedContexts) {
    const oldRoster = priorRosters.get(context.stationId);
    if (oldRoster && oldRoster.settlementId !== context.settlementId) {
      collectApplication(applyStationDutyRoster(state, emptyRoster(oldRoster)), {
        changedIds, unchangedIds, releasedIds, conflictedIds,
      });
    }
    const roster = planStationDutyRoster({
      state,
      stationId: context.stationId,
      settlementId: context.settlementId,
      residents: context.residentIds,
      worldSeed: state.worldSeed,
      dayIndex,
      hour,
    });
    collectApplication(applyStationDutyRoster(state, roster), {
      changedIds, unchangedIds, releasedIds, conflictedIds,
    });
    nextRosters.push(cloneRoster(roster));
    changedStationIds.push(context.stationId);
  }

  const nextSnapshot = freezeSnapshot({
    version: STATION_DUTY_REFRESH_SNAPSHOT_VERSION,
    dayIndex,
    hourBucket,
    contextSignature,
    contexts: normalizedContexts,
    rosters: nextRosters,
  });
  return frozenResult({
    enabled: true,
    refreshed: true,
    applied: changedIds.length > 0 || releasedIds.length > 0,
    dayIndex,
    hourBucket,
    changedStationIds,
    removedStationIds,
    changedIds,
    unchangedIds,
    releasedIds,
    conflictedIds,
    rosters: rosterRecord(nextRosters),
    snapshot: nextSnapshot,
  });
}

/** Restore an immutable, JSON-safe controller snapshot; malformed input resets safely. */
export function restoreStationDutyRefreshSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== STATION_DUTY_REFRESH_SNAPSHOT_VERSION) {
    return emptySnapshot();
  }
  try {
    const contexts = normalizeContexts(value.contexts);
    const contextSignature = stableJson(contexts);
    if (value.contextSignature !== contextSignature) return emptySnapshot();
    const dayIndex = nullableNonNegativeInteger(value.dayIndex);
    const hourBucket = nullableHourBucket(value.hourBucket);
    if ((dayIndex == null) !== (hourBucket == null)) return emptySnapshot();
    const contextByStation = new Map(contexts.map((context) => [context.stationId, context]));
    const rosters = normalizeRosters(value.rosters, contextByStation, { dayIndex, hourBucket });
    return freezeSnapshot({
      version: STATION_DUTY_REFRESH_SNAPSHOT_VERSION,
      dayIndex,
      hourBucket,
      contextSignature,
      contexts,
      rosters,
    });
  } catch {
    return emptySnapshot();
  }
}

function normalizeContexts(values) {
  if (!Array.isArray(values)) throw new TypeError('Station duty contexts must be an array.');
  const contexts = new Map();
  for (const value of values) {
    const stationId = requiredId(value?.stationId, 'context.stationId');
    const settlementId = requiredId(value?.settlementId, 'context.settlementId');
    const residentIds = uniqueIds(value?.residentIds ?? value?.residents ?? []);
    const context = { stationId, settlementId, residentIds };
    const prior = contexts.get(stationId);
    if (prior && stableJson(prior) !== stableJson(context)) {
      throw new TypeError(`Conflicting station duty context ${stationId}.`);
    }
    contexts.set(stationId, context);
  }
  return [...contexts.values()]
    .sort((a, b) => a.stationId.localeCompare(b.stationId))
    .map((context) => Object.freeze({
      ...context,
      residentIds: Object.freeze([...context.residentIds]),
    }));
}

function normalizeRosters(values, contextByStation, clock) {
  if (!Array.isArray(values)) throw new TypeError('Snapshot rosters must be an array.');
  if (clock.dayIndex == null && values.length) {
    throw new TypeError('An uninitialized snapshot cannot contain rosters.');
  }
  const seen = new Set();
  return values.map((value) => {
    const roster = cloneRoster(value);
    const context = contextByStation.get(roster.stationId);
    const people = new Set();
    const slots = new Set();
    const validAssignments = roster.assignments.every((assignment) => {
      const expectedLocation = {
        kind: 'station-platform',
        stationId: roster.stationId,
        platformId: `${roster.stationId}:platform:main`,
        waitAnchorId: `${roster.stationId}:wait:${assignment.slotKey}`,
      };
      const valid = assignment.stationId === roster.stationId
        && assignment.settlementId === roster.settlementId
        && context?.residentIds.includes(assignment.personId)
        && !people.has(assignment.personId)
        && !slots.has(assignment.slotKey)
        && stableJson(assignment.location) === stableJson(expectedLocation);
      people.add(assignment.personId);
      slots.add(assignment.slotKey);
      return valid;
    });
    if (!context || context.settlementId !== roster.settlementId || seen.has(roster.stationId)
      || roster.dayIndex !== clock.dayIndex || roster.hourBucket !== clock.hourBucket
      || roster.target > 4 || roster.assignments.length > roster.target
      || roster.shortage !== roster.target - roster.assignments.length
      || !validAssignments) {
      throw new TypeError('Snapshot roster does not match its canonical context.');
    }
    seen.add(roster.stationId);
    return roster;
  }).sort((a, b) => a.stationId.localeCompare(b.stationId));
}

function cloneRoster(value) {
  const stationId = requiredId(value?.stationId, 'roster.stationId');
  const settlementId = requiredId(value?.settlementId, 'roster.settlementId');
  if (!Array.isArray(value.assignments)) throw new TypeError('Roster assignments are required.');
  return Object.freeze({
    stationId,
    settlementId,
    dayIndex: nonNegativeInteger(value.dayIndex, 'roster.dayIndex'),
    hourBucket: hourBucket(value.hourBucket, 'roster.hourBucket'),
    daytime: value.daytime === true,
    target: nonNegativeInteger(value.target, 'roster.target'),
    shortage: nonNegativeInteger(value.shortage, 'roster.shortage'),
    assignments: Object.freeze(value.assignments.map((assignment) => Object.freeze({
      personId: requiredId(assignment?.personId, 'assignment.personId'),
      stationId: requiredId(assignment?.stationId, 'assignment.stationId'),
      settlementId: requiredId(assignment?.settlementId, 'assignment.settlementId'),
      slotKey: requiredId(assignment?.slotKey, 'assignment.slotKey'),
      role: requiredId(assignment?.role, 'assignment.role'),
      location: Object.freeze({ ...assignment.location }),
    }))),
  });
}

function emptyRoster(roster) {
  return { stationId: roster.stationId, settlementId: roster.settlementId, assignments: [] };
}

function collectApplication(result, collections) {
  for (const key of Object.keys(collections)) collections[key].push(...(result[key] || []));
}

function rosterRecord(rosters) {
  return Object.freeze(Object.fromEntries(rosters.map((roster) => [roster.stationId, roster])));
}

function frozenResult(input) {
  return Object.freeze({
    enabled: input.enabled,
    refreshed: input.refreshed,
    applied: input.applied,
    dayIndex: input.dayIndex,
    hourBucket: input.hourBucket,
    changedStationIds: frozenSortedUnique(input.changedStationIds),
    removedStationIds: frozenSortedUnique(input.removedStationIds),
    changedIds: frozenSortedUnique(input.changedIds),
    unchangedIds: frozenSortedUnique(input.unchangedIds),
    releasedIds: frozenSortedUnique(input.releasedIds),
    conflictedIds: frozenSortedUnique(input.conflictedIds),
    rosters: input.rosters,
    snapshot: input.snapshot,
  });
}

function emptySnapshot() {
  return freezeSnapshot({
    version: STATION_DUTY_REFRESH_SNAPSHOT_VERSION,
    dayIndex: null,
    hourBucket: null,
    contextSignature: '[]',
    contexts: [],
    rosters: [],
  });
}

function freezeSnapshot(value) {
  return Object.freeze({
    version: value.version,
    dayIndex: value.dayIndex,
    hourBucket: value.hourBucket,
    contextSignature: value.contextSignature,
    contexts: Object.freeze([...value.contexts]),
    rosters: Object.freeze([...value.rosters]),
  });
}

function demandClock(worldHours) {
  const total = Number(worldHours);
  const normalized = Number.isFinite(total) && total >= 0 ? total : 0;
  const dayIndex = Math.floor(normalized / 24);
  const hour = normalized - dayIndex * 24;
  return { dayIndex, hour, hourBucket: Math.floor(hour * 2) };
}

function uniqueIds(values) {
  if (!Array.isArray(values)) throw new TypeError('context.residentIds must be an array.');
  return [...new Set(values.map((value) => (
    typeof value === 'string' ? value : value?.personId ?? value?.id
  )).map((value) => requiredId(value, 'residentId')))].sort();
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function frozenSortedUnique(values = []) {
  return Object.freeze([...new Set(values)].sort());
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} is invalid.`);
  return number;
}

function hourBucket(value, label) {
  const bucket = nonNegativeInteger(value, label);
  if (bucket > 47) throw new TypeError(`${label} is invalid.`);
  return bucket;
}

function nullableNonNegativeInteger(value) {
  return value == null ? null : nonNegativeInteger(value, 'snapshot.dayIndex');
}

function nullableHourBucket(value) {
  return value == null ? null : hourBucket(value, 'snapshot.hourBucket');
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Living-world state is required.');
  }
}
