import { createStateDelta, createStateSnapshot, isSafePlayerIntent } from './multiplayerprotocol.mjs?v=sharedworld1';
import { diffProjections } from './statediff.mjs';
import {
  normalizeSharedWorldState,
  SHARED_WORLD_PROJECTED_ENTITY_LIMIT,
  sharedWorldEqual,
} from './multiplayersharedworld.mjs?v=sharedworld1';

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
 * The only branch of the world a visitor's intent may write.
 *
 * It is also the branch a visitor can see: the projection carries public
 * projections and region facts, and deliberately carries no memories, no
 * commitments and no private holdings. Giving an intent reducer exactly the
 * subtree the visitor is allowed to affect keeps those two lists the same one.
 */
export const INTENT_SCOPE = 'publicProjections';

/**
 * Host-side state authority. Guests never receive the canonical living-world
 * object: only a deliberately small visitor projection is emitted.
 */
export class HostWorldAuthority {
  constructor({ regionId, worldSeed, state = {}, maxVisitors = 3, resolvePlace = null, sessionEpoch = null } = {}) {
    this.regionId = regionId || null;
    this.worldSeed = Number(worldSeed) || 0;
    // Every host lifetime gets its own state stream. A delayed packet from a
    // previous visit can therefore be rejected even when the region ID and
    // world seed happen to be the same.
    this.sessionEpoch = String(sessionEpoch || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).slice(0, 96);
    // Keep the authority attached to the host's canonical state object. The
    // previous clone meant NPC/world mutations never reached a visitor, and
    // an accepted intent could silently detach the network copy again.
    this.state = isRecord(state) ? state : {};
    this.state.publicProjections ||= {};
    this.state.sharedWorld = normalizeSharedWorldState(this.state.sharedWorld, {
      worldSeed: this.worldSeed,
    });
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

  /**
   * Publish the host's public simulation read model.
   *
   * This is intentionally separate from `applyIntent`: the host simulation
   * can advance many times without a visitor writing anything. A revision is
   * still advanced only when the public model changes, so a quiet world does
   * not manufacture deltas for every connected peer.
   */
  publishSharedWorld(value, { revision = null } = {}) {
    const next = normalizeSharedWorldState(value, { worldSeed: this.worldSeed });
    const changed = !sharedWorldEqual(this.state.sharedWorld, next);
    this.state.sharedWorld = next;
    this.worldSeed = Number(next.worldSeed) || this.worldSeed;
    if (Number.isInteger(revision) && revision >= 0) {
      this.revision = Math.max(this.revision, revision);
    } else if (changed) {
      this.revision += 1;
    }
    return { changed, revision: this.revision, state: next };
  }

  admit(playerId, { displayName = 'Visitor', pose = null, homeOrigin = null } = {}) {
    if (!playerId) return { ok: false, reason: 'missing-player' };
    if (!this.visitors.has(playerId) && this.visitors.size >= this.maxVisitors) return { ok: false, reason: 'capacity' };
    this.visitors.set(playerId, {
      playerId,
      displayName: String(displayName).slice(0, 28),
      homeOrigin: homeOrigin && typeof homeOrigin === 'object' ? clone(homeOrigin) : null,
      pose: pose ? clone(pose) : null,
      joinedAt: Date.now(),
    });
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

    // The reducer is handed the public branch and nothing else.
    //
    // It used to be handed a deep clone of the entire world -- 382 KB and about
    // a millisecond of the host's frame budget per intent, which a visitor may
    // send twelve times a second -- and the result was then swapped back in
    // wholesale, replacing every top-level branch with a fresh copy, so every
    // object identity in the world changed each time a marker was dropped.
    //
    // Scoping it to the branch a visitor is allowed to affect costs a clone of
    // the markers map instead, keeps the rest of the world's identities intact,
    // and makes the boundary a property of the code rather than of the one
    // reducer that happens to respect it: an intent cannot reach memories,
    // relationships or holdings, because they are not in what it is given.
    const scope = clone(this.state[INTENT_SCOPE] || {});
    let result;
    try {
      result = reducer({ [INTENT_SCOPE]: scope }, clone(intent), playerId);
    } catch (error) {
      // The draft is discarded, so a reducer that threw leaves nothing behind.
      return { applied: false, reason: 'reducer-failed', error: error?.message || 'reducer threw' };
    }
    // An explicit null is how a reducer refuses -- a marker whose key cannot
    // round-trip, a coordinate that is not a number. Refusing must not advance
    // the revision or leave the draft behind. A reducer that simply mutates and
    // returns nothing has still applied.
    if (result === null) return { applied: false, reason: 'rejected' };
    this.state[INTENT_SCOPE] = scope;
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
      sessionEpoch: this.sessionEpoch,
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
          sessionEpoch: this.sessionEpoch,
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
    let payload;
    try {
      payload = createStateDelta(diff.operations, {
        baseRevision,
        revision,
        regionId: this.regionId,
        sessionEpoch: this.sessionEpoch,
      });
    } catch {
      // A large entity churn (for example, the first interest update after a
      // visitor walks away) is still valid state. A full snapshot is cheaper
      // and safer than dropping the visitor's replica until its next request.
      return snapshot();
    }
    return {
      kind: 'delta',
      payload,
      commit: () => { this.baselines.set(playerId, { projection, revision }); },
    };
  }

  deltaFor(playerId, operations, baseRevision = this.revision - 1) {
    if (playerId && !this.visitors.has(playerId)) return null;
    return createStateDelta(operations, {
      baseRevision, revision: this.revision, regionId: this.regionId,
      sessionEpoch: this.sessionEpoch,
    });
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
  constructor() {
    this.state = {};
    this.revision = 0;
    this.regionId = null;
    this.sessionEpoch = null;
  }

  reset() {
    this.state = {};
    this.revision = 0;
    this.regionId = null;
    this.sessionEpoch = null;
    return this.state;
  }

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.state
        || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)
        || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('Invalid guest snapshot');
    }
    const epoch = snapshot.sessionEpoch ? String(snapshot.sessionEpoch) : null;
    if (this.sessionEpoch && epoch && epoch !== this.sessionEpoch) {
      throw new Error('Guest snapshot belongs to another host session');
    }
    if (this.sessionEpoch && epoch === this.sessionEpoch
        && snapshot.regionId === this.regionId && snapshot.revision < this.revision) {
      throw new Error('Guest snapshot is stale');
    }
    this.state = clone(snapshot.state);
    this.revision = snapshot.revision;
    this.regionId = snapshot.regionId || null;
    this.sessionEpoch = epoch;
    return this.state;
  }

  applyDelta(delta, applyDeltaFn) {
    if (!delta || delta.schemaVersion !== 1 || delta.baseRevision !== this.revision
        || (delta.regionId && this.regionId && delta.regionId !== this.regionId)
        || (this.sessionEpoch && delta.sessionEpoch && delta.sessionEpoch !== this.sessionEpoch)) {
      throw new Error('Guest projection needs a contiguous delta');
    }
    const applied = applyDeltaFn(this.state, delta, { expectedRevision: this.revision });
    this.state = applied.state;
    this.revision = applied.revision;
    if (delta.sessionEpoch) this.sessionEpoch = String(delta.sessionEpoch);
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
    sharedWorld: projectSharedWorld(source.sharedWorld, center, radius),
    visitor: viewerId ? { playerId: viewerId } : null,
    // Deliberately absent: memories, narrative facts, private holdings,
    // commitments, and raw knowledge graph nodes.
  };
}

function projectSharedWorld(value, center, radius) {
  const shared = normalizeSharedWorldState(value);
  const culling = radius > 0 && Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.z));
  const near = (position) => {
    if (!culling || !position) return true;
    return Math.hypot(Number(position.x) - Number(center.x), Number(position.z) - Number(center.z)) <= radius;
  };
  const entityEntries = Object.entries(shared.entities)
    .filter(([, entity]) => near(entity.pose))
    .sort(([aId, a], [bId, b]) => {
      if (!culling) return aId.localeCompare(bId);
      const distance = (entity) => Math.hypot(
        Number(entity.pose?.x || 0) - Number(center.x),
        Number(entity.pose?.z || 0) - Number(center.z),
      );
      return distance(a) - distance(b) || aId.localeCompare(bId);
    })
    .slice(0, SHARED_WORLD_PROJECTED_ENTITY_LIMIT);
  const entities = Object.fromEntries(entityEntries);
  const animals = {};
  for (const [id, animal] of Object.entries(shared.animals)) {
    if (near(animal.pose)) animals[id] = animal;
  }
  const settlements = {};
  for (const [id, settlement] of Object.entries(shared.settlements)) {
    if (!culling || near(settlement)) settlements[id] = {
      ...settlement,
      residents: Object.fromEntries(Object.entries(settlement.residents || {})
        .filter(([, resident]) => near(resident.pose))),
    };
  }
  return {
    ...shared,
    entities,
    animals,
    settlements,
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

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
