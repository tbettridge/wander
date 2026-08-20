import { createStateDelta, createStateSnapshot, isSafePlayerIntent } from './multiplayerprotocol.mjs';
import { diffProjections } from './statediff.mjs';

/**
 * How far around a visitor the world is described to them.
 *
 * The projection used to carry every entity in the world however far away, which
 * on a world of twelve hundred residents was three quarters of the snapshot
 * describing people the visitor could not see. This is comfortably wider than
 * the 720m at which settlements stream in, so everything a visitor can actually
 * look at is still described; what is dropped is the far side of the region.
 */
export const INTEREST_RADIUS = 1_100;

/**
 * Host-side state authority. Guests never receive the canonical living-world
 * object: only a deliberately small visitor projection is emitted.
 */
export class HostWorldAuthority {
  constructor({ regionId, worldSeed, state = {}, maxVisitors = 3, resolvePlace = null } = {}) {
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
    // Turns a symbolic living-world place into metres, so that interest can be
    // measured at all. Without one, nothing is culled -- which is correct, if
    // expensive, rather than the silent nothing-is-culled of a NaN comparison.
    this.resolvePlace = typeof resolvePlace === 'function' ? resolvePlace : null;
    // Where a visitor is assumed to be before they have said. See update().
    this.defaultViewpoint = null;
    // The last projection each visitor was sent, so the next one can describe
    // only what moved rather than repeating the world.
    this.baselines = new Map();
  }

  setDefaultViewpoint(pose) {
    this.defaultViewpoint = Number.isFinite(Number(pose?.x)) && Number.isFinite(Number(pose?.z))
      ? { x: Number(pose.x), y: Number(pose.y) || 0, z: Number(pose.z) }
      : null;
  }

  admit(playerId, { displayName = 'Visitor', pose = null } = {}) {
    if (!playerId) return { ok: false, reason: 'missing-player' };
    if (!this.visitors.has(playerId) && this.visitors.size >= this.maxVisitors) return { ok: false, reason: 'capacity' };
    this.visitors.set(playerId, { playerId, displayName: String(displayName).slice(0, 28), pose: pose ? clone(pose) : null, joinedAt: Date.now() });
    return { ok: true, visitor: clone(this.visitors.get(playerId)) };
  }

  remove(playerId) {
    this.baselines.delete(playerId);
    this.intentWindows.delete(playerId);
    return this.visitors.delete(playerId);
  }

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

  /** The world as this visitor should currently see it. */
  projectionFor(playerId) {
    const visitor = this.visitors.get(playerId);
    return createVisitorProjection(this.state, this.visitors, playerId, {
      center: visitor?.pose || this.defaultViewpoint || null,
      radius: INTEREST_RADIUS,
      resolvePlace: this.resolvePlace,
    });
  }

  /**
   * A complete projection for a visitor. Produces; never records.
   *
   * Producing a snapshot and recording it as the visitor's baseline used to be
   * the same act, which quietly assumed that everything produced was also
   * delivered. It is not: a channel that is not open yet refuses the send, an
   * oversized projection throws before it is encoded, and a caller can decide
   * not to send at all. Any of those left the host describing later changes
   * relative to a world the guest had never received, and because a diff
   * against an up-to-date baseline is empty, the repair never came either --
   * the visitor simply stood in an empty region forever. Recording is now the
   * caller's separate act, performed only once the channel has taken it.
   */
  snapshotFor(playerId) {
    if (playerId && !this.visitors.has(playerId)) return null;
    return createStateSnapshot(this.projectionFor(playerId), {
      revision: this.revision,
      worldSeed: this.worldSeed,
      regionId: this.regionId,
      playerId,
    });
  }

  /**
   * The next thing to send this visitor: a delta, a snapshot, or nothing at all.
   *
   * Nothing at all is the common case in a quiet moment and is the point of the
   * exercise — the previous design sent a complete projection every five seconds
   * regardless, which measured as four fifths of all traffic.
   *
   * Nothing here records anything. The returned `commit` advances the baseline
   * (and, for a delta, the revision), and the caller runs it only once the
   * channel has actually accepted the payload -- an unsent update must leave
   * the visitor's baseline exactly where it was, or the next diff is taken
   * against a world they were never given.
   *
   * Commit on acceptance rather than on acknowledgement is enough: the state
   * channel is reliable and ordered, so a delta the channel has taken will
   * arrive unless the connection dies, and a connection that dies ends the
   * visit. A guest that somehow falls behind rejects the non-contiguous
   * revision and asks for a snapshot, which is the path that repairs it.
   *
   * `force` skips the baseline entirely and answers with a full snapshot; it is
   * how a join and an explicit state-request are served.
   *
   * Each visitor has their own revision chain, because each now receives their
   * own deltas: what one visitor is shown depends on where they are standing,
   * so a single shared counter would have handed the second visitor a
   * baseRevision belonging to the first and desynchronised them both. The
   * authority's own `revision` remains the version of the world itself, which
   * is what a snapshot stamps and what a visitor's chain then continues from.
   */
  updateFor(playerId, { force = false } = {}) {
    if (playerId && !this.visitors.has(playerId)) return null;
    const snapshot = () => {
      const projection = this.projectionFor(playerId);
      const revision = this.revision;
      return {
        kind: 'snapshot',
        payload: createStateSnapshot(projection, {
          revision,
          worldSeed: this.worldSeed,
          regionId: this.regionId,
          playerId,
        }),
        commit: () => { this.baselines.set(playerId, { projection, revision }); },
      };
    };
    const baseline = force ? null : this.baselines.get(playerId);
    if (!baseline) return snapshot();
    const projection = this.projectionFor(playerId);
    const diff = diffProjections(baseline.projection, projection);
    // Undescribable, or so changed that a snapshot is the smaller answer.
    if (!diff) return snapshot();
    if (!diff.operations.length) return { kind: 'none', payload: null, commit: () => {} };
    const baseRevision = baseline.revision;
    const revision = baseRevision + 1;
    return {
      kind: 'delta',
      payload: createStateDelta(diff.operations, {
        baseRevision,
        revision,
        regionId: this.regionId,
      }),
      commit: () => { this.baselines.set(playerId, { projection, revision }); },
    };
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

/**
 * Where an entity actually is, in metres, or nothing.
 *
 * A living-world `location` is usually symbolic -- a room in a building in a
 * settlement -- and carries no coordinates at all. Reading `.x` off one yields
 * undefined, which the projection used to coerce to zero: every resident in the
 * world was described to visitors as standing on the origin, and the distance
 * test that was meant to cull them compared NaN against the radius, which is
 * false for every entity, so nothing was ever culled. Symbolic places are
 * resolved through the host's own settlement index instead, and anything that
 * still cannot be placed is reported as unplaced rather than as being at 0,0,0.
 */
export function placePosition(location, resolvePlace) {
  if (!location || typeof location !== 'object') return null;
  const literal = { x: Number(location.x), y: Number(location.y), z: Number(location.z) };
  const resolved = Number.isFinite(literal.x) && Number.isFinite(literal.z)
    ? literal
    : resolvePlace?.(location) || null;
  if (!resolved) return null;
  const x = Number(resolved.x), y = Number(resolved.y), z = Number(resolved.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  // JSON has no negative zero: it encodes -0 as 0, so a host that kept -0 would
  // never agree with the guest it had just described the world to, and every
  // later diff would re-send a coordinate that had not moved.
  const plain = (value) => (value === 0 ? 0 : value);
  return { x: plain(x), y: Number.isFinite(y) ? plain(y) : 0, z: plain(z) };
}

export function createVisitorProjection(state, visitors, viewerId, { center = null, radius = 0, resolvePlace = null } = {}) {
  const source = state && typeof state === 'object' ? state : {};
  const entities = {};
  const culling = radius > 0 && Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.z));
  for (const [id, entity] of Object.entries(source.entities || {})) {
    if (!entity || entity.tombstone) continue;
    const at = placePosition(entity.location, resolvePlace);
    // Someone on the far side of the region is not part of this visitor's world
    // yet. An entity that cannot be placed at all is always described: it is not
    // somewhere the visitor can walk away from.
    if (culling && at && Math.hypot(at.x - center.x, at.z - center.z) > radius) continue;
    entities[id] = {
      id,
      kind: entity.kind,
      name: entity.name,
      role: entity.role,
      stationId: entity.stationId || null,
      location: at,
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
