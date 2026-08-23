// The streamer for tower sites — the one owner of everything on them.
//
// Before this, LandmarkManager built a watchtower here and a separate outpost
// stream built a keep around it, each from its own vocabulary. Two builders at
// one set of coordinates is how a site ends up looking like two buildings, so
// there is now one: it lays the stones, publishes the colliders (including the
// drum's, which nothing ever did), claims the walkable surfaces, and offers the
// undercroft to whoever owns the underground.

import { fortifiedOutpostsAround } from './landmarks.js';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from './fortifiedoutpost.mjs';
import { registerFortifiedOutpostRuntime } from './fortifiedoutpostruntime.mjs';
import {
  buildFortifiedOutpostVisual,
  disposeFortifiedOutpostVisual,
  OUTPOST_DETAIL_RANGE,
} from './fortifiedoutpostmesh.js';
import { undercroftSitingFor, keepUndercroftAnchor } from './keepdungeonanchor.mjs';

// Hysteresis on the detail swap, so standing on the boundary does not rebuild a
// keep every time the player shifts their weight.
const DETAIL_HYSTERESIS = 70;

export class FortifiedOutpostStream {
  constructor(scene, world, {
    walkableSurface = null, collisionIndex = null, circulation = null,
    dungeons = null, radius = 2200, visualOptions = {},
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.walkableSurface = walkableSurface;
    this.collisionIndex = collisionIndex;
    this.circulation = circulation;
    // Whoever owns the underground. Given each keep's undercroft as it streams
    // in, and told when it leaves. Optional: the surface stands without it.
    this.dungeons = dungeons;
    this.radius = radius;
    this.visualOptions = visualOptions;
    this.active = new Map();
    this.scratch = [];
    this.lastX = Infinity;
    this.lastZ = Infinity;
  }

  // Terrain height under a point in the site's local frame, after the group's
  // yaw is applied — masonry has to seat where it actually renders, not where
  // its pre-rotation coordinates would put it.
  _groundFor(entry) {
    const c = Math.cos(entry.yaw), s = Math.sin(entry.yaw);
    return (localX, localZ) =>
      this.world.height(entry.x + localX * c + localZ * s, entry.z - localX * s + localZ * c)
        - entry.y;
  }

  _planFor(entry) {
    // A keep's way down has to be in a bank, so the plan asks the terrain where
    // one is before it decides where to cut the door.
    const siting = entry.tier === 'keep' ? undercroftSitingFor(this.world, entry) : null;
    return createFortifiedOutpostPlan(entry.outpostSeed, {
      undercroftBearing: siting?.bearing, undercroftReach: siting?.reach,
      undercroftSill: siting?.sill,
    });
  }

  _build(entry, localPlan, detail, sealed = false) {
    const visual = buildFortifiedOutpostVisual(localPlan, {
      ...this.visualOptions, ground: this._groundFor(entry), detail,
      undercroftSealed: sealed,
    });
    visual.position.set(entry.x, entry.y, entry.z);
    visual.rotation.y = entry.yaw;
    this.scene?.add(visual);
    return visual;
  }

  update(px, pz) {
    if ((px - this.lastX) ** 2 + (pz - this.lastZ) ** 2 < 60 * 60) return;
    this.lastX = px; this.lastZ = pz;
    fortifiedOutpostsAround(this.world, px, pz, this.world.seed, this.radius, this.scratch);
    const want = new Set(this.scratch.map((entry) => entry.key));

    for (const entry of this.scratch) {
      const distance = Math.hypot(entry.x - px, entry.z - pz);
      const existing = this.active.get(entry.key);
      if (existing) {
        // Swap detail only once the player is clearly on one side of the line.
        const wantFull = existing.detail === 'full'
          ? distance < OUTPOST_DETAIL_RANGE + DETAIL_HYSTERESIS
          : distance < OUTPOST_DETAIL_RANGE - DETAIL_HYSTERESIS;
        const detail = wantFull ? 'full' : 'far';
        if (detail === existing.detail) continue;
        disposeFortifiedOutpostVisual(existing.visual);
        existing.visual = this._build(entry, existing.localPlan, detail, existing.sealed);
        existing.detail = detail;
        continue;
      }

      const detail = distance < OUTPOST_DETAIL_RANGE ? 'full' : 'far';
      const localPlan = this._planFor(entry);
      const plan = transformFortifiedOutpostPlan(localPlan, {
        x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw,
      });
      // Decided before the stones are cut, so the door you can see and the
      // passage behind it are the same decision. Where the hill will not take a
      // passage the door is still built — and choked with fallen stone.
      const anchor = plan.dungeonSeam
        ? keepUndercroftAnchor(this.world, entry, localPlan) : null;
      const sealed = !!plan.dungeonSeam && !anchor;
      const visual = this._build(entry, localPlan, detail, sealed);
      try {
        // The visual is already installed so it swaps atomically with the
        // semantic registrations; its cleanup is part of the same handle.
        const release = registerFortifiedOutpostRuntime({
          plan, walkableSurface: this.walkableSurface,
          collisionIndex: this.collisionIndex, circulation: this.circulation,
          visuals: null,
        });
        const releaseDungeon = anchor
          ? this.dungeons?.registerUndercroft?.(entry, anchor) : null;
        this.active.set(entry.key, {
          visual, release, releaseDungeon, plan, localPlan, detail, entry, sealed, anchor,
        });
      } catch (error) {
        disposeFortifiedOutpostVisual(visual);
        throw error;
      }
    }

    for (const [key, active] of this.active) {
      if (want.has(key)) continue;
      this._release(active);
      this.active.delete(key);
    }
  }

  _release(active) {
    active.releaseDungeon?.();
    active.release?.();
    disposeFortifiedOutpostVisual(active.visual);
  }

  /** Sites currently streamed in, for debug and for the undercroft search. */
  snapshot() {
    return [...this.active.values()].map(({ entry, plan, detail, sealed, anchor }) => ({
      key: entry.key, tier: entry.tier, x: entry.x, y: entry.y, z: entry.z,
      seed: entry.outpostSeed, detail,
      undercroft: plan.dungeonSeam ? { sealed, anchorId: anchor?.id || null } : null,
    }));
  }

  reset(world = this.world) {
    for (const active of this.active.values()) this._release(active);
    this.active.clear();
    this.world = world;
    this.lastX = Infinity; this.lastZ = Infinity;
  }
}
