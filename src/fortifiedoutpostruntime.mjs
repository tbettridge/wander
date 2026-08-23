// Runtime lifecycle adapter for a semantic fortified outpost. The planner is
// intentionally renderer-free; this module binds its immutable recipes to the
// existing walkable/collision/visual systems without letting one subsystem
// remain registered when another fails.

import {
  createFortifiedOutpostWalkableClaims,
  fortifiedOutpostCollisionRecipes,
} from './fortifiedoutpost.mjs';

function invokeRegistration(target, names, value) {
  if (!target) return null;
  for (const name of names) {
    if (typeof target[name] !== 'function') continue;
    const release = target[name](value);
    return typeof release === 'function' ? release : () => {};
  }
  return null;
}

/**
 * Install all local representations as one operation. `visuals` and
 * `circulation` are deliberately duck-typed so the adapter can be used by a
 * browser manager, a worker audit, or a headless test.
 */
export function registerFortifiedOutpostRuntime({
  plan, walkableSurface = null, collisionIndex = null, visuals = null,
  circulation = null,
} = {}) {
  if (!plan?.id) throw new TypeError('A fortified outpost plan is required.');
  const releases = [];
  try {
    if (walkableSurface) {
      if (typeof walkableSurface.registerClaims === 'function') {
        releases.push(walkableSurface.registerClaims(
          createFortifiedOutpostWalkableClaims(plan),
        ));
      } else {
        const claims = createFortifiedOutpostWalkableClaims(plan);
        const claimReleases = claims.map((claim) => walkableSurface.registerClaim(claim));
        releases.push(() => { for (const release of claimReleases.reverse()) release(); });
      }
    }
    if (collisionIndex) {
      const release = invokeRegistration(
        collisionIndex,
        ['registerFortifiedOutpost', 'registerSemanticPlan', 'registerSegments'],
        collisionIndex.registerFortifiedOutpost || collisionIndex.registerSemanticPlan
          ? plan : fortifiedOutpostCollisionRecipes(plan),
      );
      if (release) releases.push(release);
    }
    const visualRelease = invokeRegistration(visuals, ['registerFortifiedOutpost', 'registerPlan', 'register'], plan);
    if (visualRelease) releases.push(visualRelease);
    const circulationRelease = invokeRegistration(
      circulation, ['registerFortifiedOutpost', 'registerPlan', 'register'], plan,
    );
    if (circulationRelease) releases.push(circulationRelease);
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release();
  };
}

export class FortifiedOutpostRuntime {
  constructor(options = {}) {
    this.options = options;
    this.release = null;
    this.plan = null;
  }

  mount(plan = this.options.plan) {
    if (this.release) this.unmount();
    this.plan = plan;
    this.release = registerFortifiedOutpostRuntime({ ...this.options, plan });
    return this.release;
  }

  unmount() {
    if (this.release) this.release();
    this.release = null;
    this.plan = null;
  }
}

export function createFortifiedOutpostRuntime(options) {
  const runtime = new FortifiedOutpostRuntime(options);
  runtime.mount(options?.plan);
  return runtime;
}
