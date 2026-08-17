import { createStateDelta, createStateSnapshot, isSafePlayerIntent } from './multiplayerprotocol.mjs';

/**
 * Host-side state authority. Guests never receive the canonical living-world
 * object: only a deliberately small visitor projection is emitted.
 */
export class HostWorldAuthority {
  constructor({ regionId, worldSeed, state = {}, maxVisitors = 3 } = {}) {
    this.regionId = regionId || null;
    this.worldSeed = Number(worldSeed) || 0;
    // Keep the authority attached to the host's canonical state object. The
    // previous clone meant NPC/world mutations never reached a visitor, and
    // an accepted intent could silently detach the network copy again.
    this.state = isRecord(state) ? state : {};
    this.state.publicProjections ||= {};
    this.maxVisitors = Math.max(1, Math.min(3, maxVisitors));
    this.revision = 0;
    this.visitors = new Map();
    this.appliedIntents = new Set();
    this.intentOrder = [];
    this.intentWindows = new Map();
  }

  admit(playerId, { displayName = 'Visitor', pose = null } = {}) {
    if (!playerId) return { ok: false, reason: 'missing-player' };
    if (!this.visitors.has(playerId) && this.visitors.size >= this.maxVisitors) return { ok: false, reason: 'capacity' };
    this.visitors.set(playerId, { playerId, displayName: String(displayName).slice(0, 28), pose: pose ? clone(pose) : null, joinedAt: Date.now() });
    return { ok: true, visitor: clone(this.visitors.get(playerId)) };
  }

  remove(playerId) { return this.visitors.delete(playerId); }

  receiveMotion(playerId, pose) {
    const visitor = this.visitors.get(playerId);
    if (!visitor || !pose) return false;
    visitor.pose = clone(pose);
    return true;
  }

  applyIntent(playerId, intent, reducer) {
    if (!this.visitors.has(playerId) || !isSafePlayerIntent(intent)) return { applied: false, reason: 'invalid-intent' };
    if (this.appliedIntents.has(intent.intentId)) return { applied: false, duplicate: true, revision: this.revision };
    const now = Date.now();
    const window = (this.intentWindows.get(playerId) || []).filter((at) => now - at < 10_000);
    if (window.length >= 120) return { applied: false, reason: 'rate-limit' };
    window.push(now);
    this.intentWindows.set(playerId, window);
    if (typeof reducer !== 'function') return { applied: false, reason: 'missing-reducer' };
    const draft = clone(this.state);
    const result = reducer(draft, clone(intent), playerId);
    replaceRecord(this.state, draft);
    this.revision += 1;
    this.appliedIntents.add(intent.intentId);
    this.intentOrder.push(intent.intentId);
    while (this.intentOrder.length > 1024) this.appliedIntents.delete(this.intentOrder.shift());
    return { applied: true, revision: this.revision, result: clone(result ?? null) };
  }

  snapshotFor(playerId) {
    if (playerId && !this.visitors.has(playerId)) return null;
    return createStateSnapshot(createVisitorProjection(this.state, this.visitors, playerId), {
      revision: this.revision,
      worldSeed: this.worldSeed,
      regionId: this.regionId,
      playerId,
    });
  }

  deltaFor(playerId, operations, baseRevision = this.revision - 1) {
    if (playerId && !this.visitors.has(playerId)) return null;
    return createStateDelta(operations, { baseRevision, revision: this.revision, regionId: this.regionId });
  }

  interestSet(playerId, center, radius = 140) {
    const visitor = this.visitors.get(playerId);
    if (!visitor || !center) return [];
    return [...this.visitors.values()]
      .filter((candidate) => candidate.playerId !== playerId && candidate.pose
        && Math.hypot(candidate.pose.x - center.x, candidate.pose.z - center.z) <= radius)
      .map((candidate) => clone(candidate));
  }

  get diagnostics() {
    return {
      regionId: this.regionId,
      worldSeed: this.worldSeed,
      revision: this.revision,
      visitors: [...this.visitors.keys()],
      dedupeWindow: this.intentOrder.length,
    };
  }
}

export class GuestWorldProjection {
  constructor() { this.state = {}; this.revision = 0; this.regionId = null; }

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.state
        || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)
        || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('Invalid guest snapshot');
    }
    this.state = clone(snapshot.state);
    this.revision = snapshot.revision;
    this.regionId = snapshot.regionId || null;
    return this.state;
  }

  applyDelta(delta, applyDeltaFn) {
    if (!delta || delta.schemaVersion !== 1 || delta.baseRevision !== this.revision
        || (delta.regionId && this.regionId && delta.regionId !== this.regionId)) {
      throw new Error('Guest projection needs a contiguous delta');
    }
    const applied = applyDeltaFn(this.state, delta, { expectedRevision: this.revision });
    this.state = applied.state;
    this.revision = applied.revision;
    return this.state;
  }
}

export function createVisitorProjection(state, visitors, viewerId) {
  const source = state && typeof state === 'object' ? state : {};
  const entities = {};
  for (const [id, entity] of Object.entries(source.entities || {})) {
    if (!entity || entity.tombstone) continue;
    entities[id] = {
      id,
      kind: entity.kind,
      name: entity.name,
      role: entity.role,
      stationId: entity.stationId || null,
      location: entity.location ? { x: Number(entity.location.x) || 0, y: Number(entity.location.y) || 0, z: Number(entity.location.z) || 0 } : null,
    };
  }
  for (const visitor of visitors?.values?.() || []) {
    entities[visitor.playerId] = {
      id: visitor.playerId,
      kind: 'visitor',
      name: visitor.displayName,
      role: 'traveller',
      location: visitor.pose ? { x: visitor.pose.x, y: visitor.pose.y, z: visitor.pose.z } : null,
      viewer: visitor.playerId === viewerId,
    };
  }
  return {
    schemaVersion: 1,
    regionFacts: clone(source.regionFacts || source.publicFacts || {}),
    entities,
    publicProjections: clone(source.publicProjections || {}),
    publicKnowledgeGraph: createPublicKnowledgeGraph(source),
    visitor: viewerId ? { playerId: viewerId } : null,
    // Deliberately absent: memories, narrative facts, private holdings,
    // commitments, and raw knowledge graph nodes.
  };
}

function createPublicKnowledgeGraph(source) {
  const facts = {};
  const entries = Object.entries(source.narrativeFacts || {})
    .filter(([, raw]) => {
      if (!raw || typeof raw !== 'object') return false;
      const visibility = String(raw.visibility || '');
      const privacy = String(raw.privacy || (visibility === 'shared' ? 'personal' : 'public'));
      return ['public', 'community'].includes(visibility)
        && privacy !== 'private' && raw.status !== 'retracted';
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 128);
  for (const [id, raw] of entries) {
    const visibility = String(raw.visibility || '');
    const privacy = String(raw.privacy || (visibility === 'shared' ? 'personal' : 'public'));
    facts[String(id)] = {
      id: String(raw.id || id),
      subjectId: raw.subjectId ? String(raw.subjectId) : null,
      subjectIds: Array.isArray(raw.subjectIds) ? raw.subjectIds.map(String).slice(0, 16) : [],
      predicate: raw.predicate ? String(raw.predicate).slice(0, 96) : null,
      value: raw.value == null ? null : String(raw.value).slice(0, 240),
      statement: raw.statement ? String(raw.statement).slice(0, 500) : null,
      visibility,
      privacy: 'public',
      status: raw.status ? String(raw.status).slice(0, 32) : 'asserted',
    };
  }
  return {
    version: 1,
    revision: Number(source.revision) || 0,
    facts,
  };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function replaceRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
