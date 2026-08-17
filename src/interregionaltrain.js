import * as THREE from 'three';
import { advanceTransit, TrackBlockArbiter, transitionTransit } from './interregionaltransit.mjs';

/**
 * The interregional service is visually distinct from the green/brown
 * regional railway: a compact red commuter with an ivory waist band, charcoal
 * roof, and brass route plates. It is a render-only shell around the pure
 * transit plan and never owns world state.
 */
export class InterregionalTrain {
  constructor(scene, { onPhase, onTransition } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'interregional-red-commuter';
    this.root.visible = false;
    scene?.add(this.root);
    this.onPhase = typeof onPhase === 'function' ? onPhase : () => {};
    this.onTransition = typeof onTransition === 'function' ? onTransition : () => {};
    this.arbiter = new TrackBlockArbiter();
    this.conflictProvider = () => false;
    this.plan = null;
    this.origin = new THREE.Vector3();
    this.destination = new THREE.Vector3();
    this._build();
  }

  summon(plan) {
    if (this.conflictProvider?.(plan)) return false;
    if (!this.arbiter.claim(plan.trackBlockId, plan.transitId)) return false;
    this.plan = transitionTransit(plan, 'summoned');
    this.origin.set(plan.originStation.x, plan.originStation.y, plan.originStation.z);
    this.destination.set(plan.destinationStation.x, plan.destinationStation.y, plan.destinationStation.z);
    this.root.position.copy(this.origin);
    this.root.visible = true;
    this.onPhase(this.plan);
    return true;
  }

  setConflictProvider(provider) {
    this.conflictProvider = typeof provider === 'function' ? provider : () => false;
    return this.conflictProvider;
  }

  board() {
    if (!this.plan || this.plan.phase !== 'boarding') return false;
    this.plan = transitionTransit(this.plan, 'boarded');
    this.onPhase(this.plan);
    return true;
  }

  cancel(reason = 'cancelled') {
    if (!this.plan || ['complete', 'cancelled'].includes(this.plan.phase)) return false;
    this.plan = transitionTransit(this.plan, 'cancelled');
    this.plan.cancelReason = reason;
    this.arbiter.release(this.plan.trackBlockId, this.plan.transitId);
    this.root.visible = false;
    this.onPhase(this.plan);
    return true;
  }

  update(dt) {
    if (!this.plan || ['complete', 'cancelled'].includes(this.plan.phase)) return;
    const previous = this.plan.phase;
    this.plan = advanceTransit(this.plan, dt);
    const progress = Math.min(1, this.plan.elapsed / this.plan.duration);
    // Hold the carriage at the origin until departure, then make the crossing
    // read as a deliberate journey into the horizon rather than a teleport.
    if (['departing', 'transition'].includes(this.plan.phase)) {
      const t = Math.min(1, Math.max(0, (progress - 0.22) / 0.64));
      this.root.position.lerpVectors(this.origin, this.destination, smoothstep(t));
      this.root.rotation.y = Math.atan2(this.destination.x - this.origin.x, this.destination.z - this.origin.z);
    } else if (this.plan.phase === 'arriving') {
      this.root.position.lerpVectors(this.origin, this.destination, 1);
    }
    if (this.plan.phase !== previous) {
      this.onPhase(this.plan);
      if (this.plan.phase === 'transition') this.onTransition(this.plan);
    }
    if (this.plan.phase === 'complete') {
      this.arbiter.release(this.plan.trackBlockId, this.plan.transitId);
      this.root.visible = false;
      this.onPhase(this.plan);
    }
  }

  get diagnostics() {
    return { visible: this.root.visible, plan: this.plan, blocks: this.arbiter.snapshot() };
  }

  _build() {
    const red = new THREE.MeshStandardMaterial({ color: 0x9d2724, roughness: 0.7, metalness: 0.12 });
    const redDark = new THREE.MeshStandardMaterial({ color: 0x551616, roughness: 0.82 });
    const ivory = new THREE.MeshStandardMaterial({ color: 0xe6d6b7, roughness: 0.76 });
    const charcoal = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.6, metalness: 0.22 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb88d45, roughness: 0.38, metalness: 0.72 });
    for (let car = 0; car < 2; car += 1) {
      const carriage = new THREE.Group();
      carriage.position.z = (car - 0.5) * 5.3;
      const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.0, 4.8), red);
      body.position.y = 1.75;
      const band = new THREE.Mesh(new THREE.BoxGeometry(3.23, 0.34, 4.84), ivory);
      band.position.y = 1.68;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.32, 0.22, 4.92), charcoal);
      roof.position.y = 2.83;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(3.25, 0.22, 4.85), redDark);
      lower.position.y = 0.72;
      carriage.add(body, band, roof, lower);
      for (const side of [-1, 1]) {
        for (let window = -1; window <= 1; window += 1) {
          const pane = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, 0.54, 0.86),
            new THREE.MeshStandardMaterial({ color: 0x9eb3b4, roughness: 0.15, metalness: 0.42, transparent: true, opacity: 0.78 }),
          );
          pane.position.set(side * 1.63, 2.17, window * 1.25);
          carriage.add(pane);
        }
      }
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.8), brass);
      plate.position.set(1.67, 1.16, 0);
      carriage.add(plate);
      this.root.add(carriage);
    }
    const coupler = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 1.0), brass);
    coupler.position.y = 0.62;
    this.root.add(coupler);
  }
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
