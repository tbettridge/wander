// Optional landmark streamer for the fortified-outpost vertical slice. The
// legacy LandmarkManager remains untouched by default; callers opt into this
// stream when they have collision/walkable ownership available.

import { fortifiedOutpostsAround } from './landmarks.js';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from './fortifiedoutpost.mjs';
import { registerFortifiedOutpostRuntime } from './fortifiedoutpostruntime.mjs';
import {
  buildFortifiedOutpostVisual,
  disposeFortifiedOutpostVisual,
} from './fortifiedoutpostmesh.js';

export class FortifiedOutpostStream {
  constructor(scene, world, {
    walkableSurface = null, collisionIndex = null, circulation = null,
    radius = 2200, visualOptions = {},
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.walkableSurface = walkableSurface;
    this.collisionIndex = collisionIndex;
    this.circulation = circulation;
    this.radius = radius;
    this.visualOptions = visualOptions;
    this.active = new Map();
    this.scratch = [];
    this.lastX = Infinity;
    this.lastZ = Infinity;
  }

  update(px, pz) {
    if ((px - this.lastX) ** 2 + (pz - this.lastZ) ** 2 < 60 * 60) return;
    this.lastX = px; this.lastZ = pz;
    fortifiedOutpostsAround(this.world, px, pz, this.world.seed, this.radius, this.scratch);
    const want = new Set(this.scratch.map((entry) => entry.key));
    for (const entry of this.scratch) {
      if (this.active.has(entry.key)) continue;
      const localPlan = createFortifiedOutpostPlan(entry.outpostSeed);
      const plan = transformFortifiedOutpostPlan(localPlan, {
        x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw,
      });
      const visual = buildFortifiedOutpostVisual(localPlan, this.visualOptions);
      visual.position.set(entry.x, entry.y, entry.z);
      visual.rotation.y = entry.yaw;
      this.scene?.add(visual);
      try {
        const release = registerFortifiedOutpostRuntime({
          plan, walkableSurface: this.walkableSurface,
          collisionIndex: this.collisionIndex, circulation: this.circulation,
          // Visual was already installed so it can be swapped atomically with
          // the semantic registrations; its cleanup is part of the same handle.
          visuals: null,
        });
        this.active.set(entry.key, { visual, release, plan });
      } catch (error) {
        disposeFortifiedOutpostVisual(visual);
        throw error;
      }
    }
    for (const [key, active] of this.active) {
      if (want.has(key)) continue;
      active.release?.();
      disposeFortifiedOutpostVisual(active.visual);
      this.active.delete(key);
    }
  }

  reset(world = this.world) {
    for (const active of this.active.values()) {
      active.release?.();
      disposeFortifiedOutpostVisual(active.visual);
    }
    this.active.clear();
    this.world = world;
    this.lastX = Infinity; this.lastZ = Infinity;
  }
}
