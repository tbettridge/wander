// Runtime lifecycle adapter for the semantic dungeon proof. The cave field
// remains owned by CaveExperiment; this adapter owns the structural layer and
// its collision/walkable/nav contracts so a dungeon can stream atomically even
// when a browser/XR harness cannot drive a pointer-locked player.

import { fortifiedOutpostsAround } from './landmarks.js';
import { createFortifiedOutpostPlan, transformFortifiedOutpostPlan } from './fortifiedoutpost.mjs';
import { createFortifiedDungeonPlan } from './fortifieddungeon.mjs';

function invoke(target, names, value) {
  if (!target) return null;
  for (const name of names) {
    if (typeof target[name] !== 'function') continue;
    const release = target[name](value);
    return typeof release === 'function' ? release : () => {};
  }
  return null;
}

/**
 * Install every semantic dungeon representation as one transaction. Targets
 * are intentionally duck-typed so the same adapter works with browser
 * managers, tests, and future local-NPC navigation owners.
 */
export function registerFortifiedDungeonRuntime({
  plan, walkableSurface = null, collisionIndex = null,
  visuals = null, navigation = null, terrainOpening = null,
} = {}) {
  if (!plan?.id || !plan?.collisionProxies || !plan?.walkableClaims) {
    throw new TypeError('A complete fortified dungeon plan is required.');
  }
  const releases = [];
  try {
    if (walkableSurface) {
      if (typeof walkableSurface.registerClaims === 'function') {
        releases.push(walkableSurface.registerClaims(plan.walkableClaims));
      } else if (typeof walkableSurface.registerClaim === 'function') {
        const claimReleases = plan.walkableClaims.map((claim) => walkableSurface.registerClaim(claim));
        releases.push(() => { for (const release of claimReleases.reverse()) release?.(); });
      }
    }
    const collisionRelease = invoke(
      collisionIndex,
      ['registerFortifiedDungeon', 'registerSemanticPlan', 'registerSegments'],
      collisionIndex?.registerFortifiedDungeon || collisionIndex?.registerSemanticPlan
        ? plan : plan.collisionProxies,
    );
    if (collisionRelease) releases.push(collisionRelease);
    const visualRelease = invoke(visuals, ['registerFortifiedDungeon', 'registerPlan', 'register'], plan);
    if (visualRelease) releases.push(visualRelease);
    const navRelease = invoke(navigation, ['registerFortifiedDungeon', 'registerPlan', 'register'], plan);
    if (navRelease) releases.push(navRelease);
    const openingRelease = invoke(
      terrainOpening,
      ['registerDungeonOpening', 'registerTerrainOpening', 'register'],
      plan.terrainOpening,
    );
    if (openingRelease) releases.push(openingRelease);
  } catch (error) {
    for (const release of releases.reverse()) release?.();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release?.();
  };
}

/** Semantic terrain-opening registry; CaveExperiment may consume these records
 * later, while the stream already has an atomic owner for cleanup and debug. */
export class DungeonTerrainOpeningRegistry {
  constructor() { this.openings = new Map(); }

  registerDungeonOpening(opening) {
    if (!opening?.id) throw new TypeError('Dungeon openings require stable ids.');
    this.openings.set(opening.id, opening);
    return () => this.openings.delete(opening.id);
  }

  snapshot() { return [...this.openings.values()]; }

  clear() { this.openings.clear(); }
}

/** Local-NPC/player navigation ownership mirrors the terrain-opening registry.
 * It stores immutable semantic plans rather than renderer paths, so unload can
 * release one site without touching the regional trail graph. */
export class DungeonNavigationRegistry {
  constructor() { this.plans = new Map(); }

  registerFortifiedDungeon(plan) {
    if (!plan?.id || !(plan.localNavigation || plan.navigation)) {
      throw new TypeError('Dungeon navigation requires a local navigation plan.');
    }
    this.plans.set(plan.id, plan.localNavigation || plan.navigation);
    return () => this.plans.delete(plan.id);
  }

  snapshot() { return [...this.plans.values()]; }

  clear() { this.plans.clear(); }
}

/** A small stream that binds generated outpost seams to structural dungeons. */
export class FortifiedDungeonStream {
  constructor(scene, world, {
    walkableSurface = null, collisionIndex = null, navigation = null,
    terrainOpening = null, radius = 1400, visualOptions = {}, enabled = true,
    visualBuilder = null, visualDisposer = null,
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.walkableSurface = walkableSurface;
    this.collisionIndex = collisionIndex;
    this.navigation = navigation;
    this.terrainOpening = terrainOpening;
    this.radius = radius;
    this.visualOptions = visualOptions;
    // Keep this module THREE-free for deterministic workers and Node audits.
    // The browser supplies the masonry builder from fortifieddungeonmesh.js;
    // tests and headless tools may provide a lightweight semantic stub.
    this.visualBuilder = visualBuilder;
    this.visualDisposer = visualDisposer || (() => {});
    this.enabled = enabled;
    this.active = new Map();
    this.scratch = [];
    this.lastX = Infinity;
    this.lastZ = Infinity;
  }

  update(px, pz) {
    if (!this.enabled) return;
    if ((px - this.lastX) ** 2 + (pz - this.lastZ) ** 2 < 60 * 60) return;
    this.lastX = px; this.lastZ = pz;
    fortifiedOutpostsAround(this.world, px, pz, this.world.seed, this.radius, this.scratch);
    const wanted = new Set(this.scratch.map((entry) => `D${entry.key}`));
    for (const entry of this.scratch) {
      const key = `D${entry.key}`;
      if (this.active.has(key)) continue;
      const localOutpost = createFortifiedOutpostPlan(entry.outpostSeed);
      const worldOutpost = transformFortifiedOutpostPlan(localOutpost, {
        x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw,
      });
      const plan = createFortifiedDungeonPlan({
        seed: entry.outpostSeed,
        surfacePlan: worldOutpost,
        surfaceY: worldOutpost.dungeonSeam?.y ?? entry.y,
      });
      const visual = this.visualBuilder ? this.visualBuilder(plan, this.visualOptions) : null;
      if (visual) this.scene?.add(visual);
      try {
        const release = registerFortifiedDungeonRuntime({
          plan, walkableSurface: this.walkableSurface,
          collisionIndex: this.collisionIndex, navigation: this.navigation,
          terrainOpening: this.terrainOpening,
        });
        this.active.set(key, { plan, visual, release });
      } catch (error) {
        this.visualDisposer(visual);
        throw error;
      }
    }
    for (const [key, active] of this.active) {
      if (wanted.has(key)) continue;
      active.release?.();
      this.visualDisposer(active.visual);
      this.active.delete(key);
    }
  }

  reset(world = this.world) {
    for (const active of this.active.values()) {
      active.release?.();
      this.visualDisposer(active.visual);
    }
    this.active.clear();
    this.world = world;
    this.lastX = Infinity; this.lastZ = Infinity;
  }

  snapshot() {
    return [...this.active.values()].map(({ plan }) => ({
      id: plan.id, seed: plan.seed, surfaceLink: plan.surfaceLink,
      entrance: plan.entrance.surface, graph: plan.graphValidation,
      navigation: plan.localNavigation || plan.navigation,
    }));
  }
}
