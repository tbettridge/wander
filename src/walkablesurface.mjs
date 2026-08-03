// Everything standing above the terrain that a walker can be on top of.
//
// Two kinds of structure share this: trail crossings (plank bridges and the
// long trestles) and the railway's own spans (bridges and viaducts, which
// deliberately leave the ground beneath them natural). Both are invisible to
// world.height(), so without this a walker crosses a river or a gorge by
// strolling through the deck and falling.
//
// One provider serves the player's feet and an NPC's gait, because two grounding
// systems that disagree would put an NPC shin-deep in a river the player walks
// over dry.
//
// Crossings are resolved lazily and cached: solving one walks the water for up
// to 400m, far too costly to repeat per frame, and the answer never changes for
// a given world.
//
// That cache is keyed by REGION, not by "wherever the last caller stood". One
// surface serves the player and every NPC, and a single shared active-set — kept
// around one moving centre — meant an NPC asking about its own footing a couple
// of hundred metres away silently evicted the bridge the player was standing on.
// The player then fell through a deck that the console cheerfully reported as
// present, because the very next query re-gathered around the player again.

import {
  deckHalfWidth, deckHeightAt, DECK_EDGE_MARGIN, nearestArcOnEdge, solveCrossing,
} from './trailcrossings.mjs';

export class WalkableSurface {
  constructor(world, { seed = world?.seed ?? 1, trailsAround = null } = {}) {
    this.world = world;
    this.seed = seed;
    this.trailsAround = trailsAround;
    // A crossing is expressed along its own trail, so the edge has to be on
    // hand to answer where a walker is standing.
    this.edges = new Map();
    // Crossings solved so far, keyed by edge id + ford index.
    this.solved = new Map();
    // Crossings per region of the world, so two walkers in different places
    // cannot evict each other's footing.
    this.regions = new Map();
    // A region gathers trails from well beyond its own bounds — the furthest
    // corner is ~90m from the centre, so 220m covers anything a walker inside
    // it can stand on, and the bucket needs no neighbour lookups.
    this.regionSize = 128;
    this.regionReach = 220;
    this.regionLimit = 64;
    this._edges = [];
    // Reports why a deck was missed, when standing close enough to one that it
    // should not have been. Left on: a walker falling through a bridge needs
    // explaining more than the console needs to be quiet.
    this.debug = true;
    this._lastReport = 0;
    this._reporting = false;
    // Deterministic structure floors register here while their settlement is
    // streamed. Claims are intentionally plain providers, keeping this class
    // independent from THREE and useful to NPC navigation tests.
    this.structureClaims = new Map();
  }

  registerClaim(claim) {
    if (!claim?.id || typeof claim.contains !== 'function' || !Number.isFinite(claim.y)) {
      throw new TypeError('Walkable claims require id, y, and contains(x,z).');
    }
    this.structureClaims.set(claim.id, claim);
    return () => this.structureClaims.delete(claim.id);
  }

  unregisterClaim(id) { return this.structureClaims.delete(id); }

  structureAt(x, z, atY = Infinity) {
    let best = null;
    for (const claim of this.structureClaims.values()) {
      if (claim.y <= atY + 1.25 && claim.contains(x, z)
        && (!best || claim.y > best.y)) best = claim;
    }
    return best;
  }

  /**
   * The walkable crossings covering a point. Gathered once per region and kept:
   * trail edges are already cached by the trail system, and a crossing never
   * changes for a given world, so this costs one solve per region ever.
   */
  crossingsAt(x, z) {
    const rx = Math.floor(x / this.regionSize);
    const rz = Math.floor(z / this.regionSize);
    const key = `${rx}:${rz}`;
    const held = this.regions.get(key);
    if (held !== undefined) {
      // Freshen its place in insertion order so the eviction below drops the
      // region nobody has walked in, not the one underfoot.
      this.regions.delete(key);
      this.regions.set(key, held);
      return held;
    }
    const found = this._gather(rx, rz);
    this.regions.set(key, found);
    if (this.regions.size > this.regionLimit) {
      this.regions.delete(this.regions.keys().next().value);
    }
    return found;
  }

  _gather(rx, rz) {
    const found = [];
    if (!this.trailsAround) return found;
    const cx = (rx + 0.5) * this.regionSize;
    const cz = (rz + 0.5) * this.regionSize;
    this._edges.length = 0;
    this.trailsAround(this.world, cx, cz, this.seed, this.regionReach, this._edges);
    for (const edge of this._edges) {
      this.edges.set(edge.id, edge);
      const fords = edge.fords || [];
      for (let i = 0; i < fords.length; i++) {
        const key = `${edge.id}:${i}`;
        let record = this.solved.get(key);
        if (record === undefined) {
          record = solveCrossing(this.world, edge, fords[i]) || null;
          this.solved.set(key, record);
        }
        if (record && record.walkable) found.push(record);
      }
    }
    return found;
  }

  /**
   * The deck height at a point, or null when nothing is standing there.
   *
   * `atY` keeps a walker beneath a structure from being lifted onto it: you can
   * wade under a footbridge or walk a gorge beneath a viaduct.
   */
  /**
   * Why a deck was or was not underfoot here.
   *
   * Every measurement of this outside the running game says it works, and in
   * the running game it does not, so the game has to be the one to say what it
   * sees. Throttled, and only near a crossing, so it reports the moment that
   * matters rather than filling the console.
   */
  explain(x, z, atY) {
    const active = this.crossingsAt(x, z);
    let nearest = null;
    for (const c of active) {
      const edge = this.edges.get(c.edgeId);
      if (!edge) continue;
      const near = nearestArcOnEdge(edge, x, z);
      const centre = Math.hypot(x - c.x, z - c.z);
      // The real width this crossing uses, not a constant — reporting the
      // constant hid the very mismatch this exists to find.
      const reach = deckHalfWidth(edge) + DECK_EDGE_MARGIN;
      const alongDeck = near.arc >= c.arcStart - 0.4 && near.arc <= c.arcEnd + 0.4;
      if (!nearest || centre < nearest.centre) {
        nearest = {
          kind: c.kind, centre,
          offCentreline: near.distance, halfWidth: reach,
          arc: near.arc, arcStart: c.arcStart, arcEnd: c.arcEnd,
          alongDeck,
          insideFootprint: near.distance <= reach && alongDeck,
          deckY: c.surfaceY, walkable: c.walkable,
        };
      }
    }
    return {
      activeCrossings: active.length,
      edgesKnown: this.edges.size,
      groundHere: this.world.height(x, z),
      deckReturned: this.heightAt(x, z, atY),
      walkerY: atY,
      nearest,
    };
  }

  heightAt(x, z, atY = Infinity) {
    const trail = deckHeightAt(this.crossingsAt(x, z), this.edges, x, z, atY);
    if (this.debug && trail === null) this._maybeReport(x, z, atY);
    // Read live rather than cached: replanning the railway swaps this index out.
    const railway = this.world.railwayTerrain;
    const rail = railway ? railway.deckAt(this.world.height(x, z), x, z, atY) : null;
    const structure = this.structureAt(x, z, atY)?.y ?? null;
    if (trail === null && rail === null && structure === null) return null;
    return Math.max(trail ?? -Infinity, rail ?? -Infinity, structure ?? -Infinity);
  }

  /**
   * Ground height including anything standing on it — the function an NPC gait
   * wants for `terrainHeight`, and the same one the player's feet resolve
   * against. `atY` defaults to the ground itself so a walker on open terrain
   * steps up onto a deck as they reach it, rather than needing to guess.
   */
  groundAt(x, z, atY) {
    const ground = this.world.height(x, z);
    // A validated interior pad is authoritative throughout its footprint.
    // Taking max(floor, raw terrain) made support toggle between the two inside
    // one room wherever unsmoothed terrain crossed the slab.
    const structure = this.structureAt(x, z, atY ?? ground + 1.2);
    if (structure) return structure.y;
    const deck = this.heightAt(x, z, atY ?? ground + 1.2);
    return deck !== null && deck > ground ? deck : ground;
  }

  /**
   * Rich footing information for procedural locomotion.
   *
   * Older callers only need `groundAt`; the locomotion controller also needs
   * to know whether a sample belongs to terrain or an authored, level support
   * and which way that support tilts. Keeping that answer here prevents every
   * NPC system from inventing its own terrain probe.
   */
  queryAt(x, z, atY, { probe = 0.18 } = {}) {
    const terrainY = this.world.height(x, z);
    const crossings = this.crossingsAt(x, z);
    const trailY = deckHeightAt(crossings, this.edges, x, z, atY ?? terrainY + 1.2);
    const railway = this.world.railwayTerrain;
    const railY = railway ? railway.deckAt(terrainY, x, z, atY ?? terrainY + 1.2) : null;
    const claim = this.structureAt(x, z, atY ?? terrainY + 1.2);
    const structureY = claim?.y ?? null;
    const elevatedY = Math.max(trailY ?? -Infinity, railY ?? -Infinity);
    const y = structureY !== null
      ? structureY
      : (Number.isFinite(elevatedY) && elevatedY > terrainY ? elevatedY : terrainY);
    let surfaceKind = 'terrain';
    let supportId = 'terrain';
    if (y === structureY) { surfaceKind = claim.kind || 'floor'; supportId = claim.id; }
    else if (y === railY) { surfaceKind = 'rail-deck'; supportId = 'railway'; }
    else if (y === trailY) {
      surfaceKind = 'trail-deck';
      const nearest = crossings.find((crossing) => Math.abs(crossing.surfaceY - y) < 0.03);
      supportId = nearest ? `${nearest.edgeId}:${nearest.kind}` : 'trail-deck';
    }

    // Authored floors and decks are intentionally level. Terrain normals use
    // a central difference, which is stable across frame rates and cheap
    // enough for the near-field foot probes that consume this API.
    let normal = [0, 1, 0];
    if (surfaceKind === 'terrain') {
      const left = this.world.height(x - probe, z), right = this.world.height(x + probe, z);
      const back = this.world.height(x, z - probe), front = this.world.height(x, z + probe);
      const nx = left - right, ny = probe * 2, nz = back - front;
      const length = Math.hypot(nx, ny, nz) || 1;
      normal = [nx / length, ny / length, nz / length];
    }
    return {
      y, normal, supportId, surfaceKind, walkable: true,
      edgeDistance: Infinity, stepHeight: Math.max(0, y - terrainY),
    };
  }

  /** Throttled report when close to a crossing but not carried by it. */
  _maybeReport(x, z, atY) {
    // explain() asks heightAt() for the answer it is explaining, which comes
    // back through here. Guard the re-entry rather than relying on the throttle.
    if (this._reporting) return;
    this._reporting = true;
    try { this._report(x, z, atY); } finally { this._reporting = false; }
  }

  _report(x, z, atY) {
    const e = this.explain(x, z, atY);
    // Only when standing somewhere along the deck's own length. Short of the
    // abutment there is correctly nothing underfoot, and reporting that buried
    // the case that matters in noise.
    if (!e.nearest || !e.nearest.alongDeck) return;
    const now = Date.now();
    if (now - this._lastReport < 1000) return;
    this._lastReport = now;
    // One flat line rather than an object: a console collapses an object behind
    // an ellipsis, which is exactly the information needed here.
    const n = e.nearest;
    console.warn('[deck] no footing'
      + ` | active=${e.activeCrossings} edges=${e.edgesKnown}`
      + ` | ground=${e.groundHere.toFixed(2)} walkerY=${Number(e.walkerY).toFixed(2)}`
      + ` | deck=${e.deckReturned === null ? 'NULL' : e.deckReturned.toFixed(2)}`
      + (n
        ? ` | nearest=${n.kind} centre=${n.centre.toFixed(1)}m`
        + ` offCentreline=${n.offCentreline.toFixed(2)}/${n.halfWidth}`
        + ` arc=${n.arc.toFixed(1)} range=${n.arcStart.toFixed(1)}..${n.arcEnd.toFixed(1)}`
        + ` inside=${n.insideFootprint} deckY=${n.deckY.toFixed(2)} walkable=${n.walkable}`
        : ' | nearest=NONE'));
  }

  /** Bound to hand straight to controls.setWalkableSurface or an NPC gait. */
  provider() {
    return (x, z, atY) => this.heightAt(x, z, atY);
  }

  /** Bound ground function for NPCs: terrain, or the deck standing on it. */
  groundProvider() {
    return (x, z) => this.groundAt(x, z);
  }

  /** Bound rich surface query for NPC locomotion. */
  queryProvider() {
    return (x, z, atY) => this.queryAt(x, z, atY);
  }
}
