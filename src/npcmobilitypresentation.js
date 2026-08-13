// Read-only presentation ownership for canonical NPCs walking between streamed
// world systems. This module deliberately has no THREE dependency: callers
// resolve canonical locations to world points and create/mount their own avatar.

import { normalizeNpcLocation, normalizeNpcResidence } from './npclocation.mjs';

const DEFAULT_CULL_RANGE = 260;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validObserver(value) {
  return value && finite(value.x) && finite(value.y ?? 0) && finite(value.z);
}

function normalizedResolvedPoint(value) {
  if (!value || typeof value !== 'object'
    || !finite(value.x) || !finite(value.y) || !finite(value.z)
    || !finite(value.heading) || !finite(value.progress)
    || value.progress < 0 || value.progress > 1) return null;
  return Object.freeze({
    x: value.x,
    y: value.y,
    z: value.z,
    heading: value.heading,
    progress: value.progress,
    mode: typeof value.mode === 'string' ? value.mode : 'walk',
    seated: value.seated === true,
    railPhase: typeof value.railPhase === 'string' ? value.railPhase : null,
  });
}

function canonicalWalkingLocation(entity) {
  if (!entity || entity.kind !== 'npc' || entity.tombstone || !entity.id) return null;
  if (!normalizeNpcResidence(entity.residence)) return null;
  const location = normalizeNpcLocation(entity.location);
  if (!location) return null;
  const transfer = entity.activity?.executor?.railTransfer;
  const localTransfer = entity.activity?.executor?.fromLocation
    && entity.activity?.executor?.toLocation;
  return ['regional-edge', 'settlement-node', 'station-platform', 'train-carriage', 'train-seat']
    .includes(location.kind) || transfer || localTransfer ? location : null;
}

function presentationRoot(created) {
  return created?.root ?? created?.object ?? created ?? null;
}

/**
 * Reconcile canonical trail walkers with optional renderer-owned avatars.
 *
 * Providers:
 * - stateProvider() => current living-world state
 * - excludedActorIdsProvider() => IDs already owned by settlement/station/train
 * - identityProvider(actorId, entity, state) => existing canonical identity
 * - locationResolver(location, entity, state) => {x,y,z,heading,progress}|null
 * - avatarFactory({actorId, entity, identity, resolved}) => presentation
 *
 * A presentation may expose `update({ actorId, entity, identity, resolved,
 * dt, distance })`, `dispose()`, and `root.removeFromParent()`. The factory is
 * responsible for initially mounting its root. No provider is allowed to turn
 * this reconciler into simulation authority; canonical state is never changed.
 */
export class NpcMobilityPresentationReconciler {
  constructor({
    stateProvider,
    identityProvider,
    avatarFactory,
    locationResolver,
    excludedActorIdsProvider = () => [],
    cullRange = DEFAULT_CULL_RANGE,
  } = {}) {
    this.stateProvider = typeof stateProvider === 'function' ? stateProvider : null;
    this.identityProvider = typeof identityProvider === 'function' ? identityProvider : null;
    this.avatarFactory = typeof avatarFactory === 'function' ? avatarFactory : null;
    this.locationResolver = typeof locationResolver === 'function' ? locationResolver : null;
    this.excludedActorIdsProvider = typeof excludedActorIdsProvider === 'function'
      ? excludedActorIdsProvider : null;
    this.cullRange = Number.isFinite(cullRange) && cullRange >= 0
      ? cullRange : DEFAULT_CULL_RANGE;
    this.enabled = true;
    this.disposed = false;
    this.presentations = new Map();
  }

  materializedActorIds() {
    return [...this.presentations.keys()];
  }

  remove(actorId) {
    const presentation = this.presentations.get(actorId);
    if (!presentation) return false;
    this.presentations.delete(actorId);
    try { presentation.root?.removeFromParent?.(); } catch { /* optional visual */ }
    try { presentation.dispose?.(); } catch { /* disposal is best effort */ }
    return true;
  }

  clear() {
    for (const actorId of [...this.presentations.keys()]) this.remove(actorId);
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) this.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.clear();
  }

  update(dt, observer) {
    if (this.disposed || !this.enabled) {
      this.clear();
      return Object.freeze({ active: 0, created: 0, updated: 0, removed: 0 });
    }
    if (!finite(dt) || dt < 0 || !validObserver(observer)
      || !this.stateProvider || !this.identityProvider
      || !this.avatarFactory || !this.locationResolver
      || !this.excludedActorIdsProvider) {
      const removed = this.presentations.size;
      this.clear();
      return Object.freeze({ active: 0, created: 0, updated: 0, removed });
    }

    let state;
    let excluded;
    try {
      state = this.stateProvider();
      const excludedIds = this.excludedActorIdsProvider();
      if (!excludedIds || typeof excludedIds === 'string'
        || typeof excludedIds[Symbol.iterator] !== 'function') {
        throw new TypeError('Excluded actor IDs must be an iterable collection.');
      }
      excluded = new Set(excludedIds);
    } catch {
      const removed = this.presentations.size;
      this.clear();
      return Object.freeze({ active: 0, created: 0, updated: 0, removed });
    }
    if (!state?.features?.unifiedNpcMobilityEnabled || !state.entities
      || typeof state.entities !== 'object') {
      const removed = this.presentations.size;
      this.clear();
      return Object.freeze({ active: 0, created: 0, updated: 0, removed });
    }

    const desired = new Set();
    let createdCount = 0;
    let updatedCount = 0;
    let removedCount = 0;
    const ids = Object.keys(state.entities).sort();
    for (const actorId of ids) {
      const entity = state.entities[actorId];
      if (entity?.id !== actorId) continue;
      const location = canonicalWalkingLocation(entity);
      if (!location || excluded.has(actorId)) continue;

      let identity;
      let resolved;
      try {
        identity = this.identityProvider(actorId, entity, state);
        resolved = normalizedResolvedPoint(this.locationResolver(location, entity, state));
      } catch {
        identity = null;
        resolved = null;
      }
      if (!identity || identity.id !== actorId || !resolved) continue;
      const distance = Math.hypot(resolved.x - observer.x, resolved.z - observer.z);
      if (distance > this.cullRange) continue;
      desired.add(actorId);

      let presentation = this.presentations.get(actorId);
      if (!presentation) {
        let made = null;
        try {
          made = this.avatarFactory({ actorId, entity, identity, resolved });
        } catch {
          made = null;
        }
        const root = presentationRoot(made);
        if (!made || !root) {
          desired.delete(actorId);
          continue;
        }
        presentation = {
          root,
          update: typeof made.update === 'function' ? made.update.bind(made) : null,
          dispose: typeof made.dispose === 'function' ? made.dispose.bind(made) : null,
        };
        this.presentations.set(actorId, presentation);
        createdCount++;
      }

      try {
        presentation.update?.({ actorId, entity, identity, resolved, dt, distance });
        updatedCount++;
      } catch {
        desired.delete(actorId);
        if (this.remove(actorId)) removedCount++;
      }
    }

    for (const actorId of [...this.presentations.keys()]) {
      if (!desired.has(actorId) && this.remove(actorId)) removedCount++;
    }
    return Object.freeze({
      active: this.presentations.size,
      created: createdCount,
      updated: updatedCount,
      removed: removedCount,
    });
  }
}

export const NPC_MOBILITY_PRESENTATION_CULL_RANGE = DEFAULT_CULL_RANGE;
