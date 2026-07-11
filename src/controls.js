// Player movement: pointer-lock + WASD on desktop, smooth locomotion with
// snap turn in VR. The player rig is glued to the terrain height field.

import * as THREE from 'three';
import { clamp, lerp } from './noise.js';
import { WATER_LEVEL } from './world.js';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 4.8;
const SPRINT_SPEED = 10.5;

export class PlayerControls {
  constructor(renderer, camera, world, domElement) {
    this.renderer = renderer;
    this.camera = camera;
    this.world = world;

    this.rig = new THREE.Group(); // rig sits at the player's feet
    this.rig.add(camera);
    camera.position.set(0, EYE_HEIGHT, 0);

    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.enabled = false;
    this.speed = 0;            // current horizontal speed (read by audio)
    this.strideDistance = 0;   // accumulated metres, for footsteps
    this.bobPhase = 0;
    this.snapCooldown = 0;
    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== domElement) return;
      this.yaw -= e.movementX * 0.0021;
      this.pitch = clamp(this.pitch - e.movementY * 0.0021, -1.45, 1.45);
    });
  }

  place(x, z) {
    this.rig.position.set(x, this.world.height(x, z), z);
  }

  update(dt) {
    const xr = this.renderer.xr.isPresenting;
    let mx = 0, mz = 0, sprint = false;

    if (xr) {
      const session = this.renderer.xr.getSession();
      if (session) {
        for (const src of session.inputSources) {
          const gp = src.gamepad;
          if (!gp) continue;
          const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
          const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
          if (src.handedness === 'left') {
            if (Math.abs(ax) > 0.12) mx += ax;
            if (Math.abs(ay) > 0.12) mz += ay;
          } else if (src.handedness === 'right') {
            this.snapCooldown -= dt;
            if (Math.abs(ax) > 0.6 && this.snapCooldown <= 0) {
              this.rig.rotation.y -= Math.sign(ax) * Math.PI / 6;
              this.snapCooldown = 0.3;
            } else if (Math.abs(ax) < 0.3) {
              this.snapCooldown = 0;
            }
          }
        }
      }
    } else {
      this.rig.rotation.y = this.yaw;
      this.camera.rotation.set(this.pitch, 0, 0);
      if (this.enabled) {
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz -= 1;
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz += 1;
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
        sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      }
    }

    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }

    // movement is relative to where the head is pointing (flattened)
    this.camera.getWorldDirection(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.crossVectors(this._fwd, new THREE.Vector3(0, 1, 0)).negate();

    let target = (sprint ? SPRINT_SPEED : WALK_SPEED) * Math.min(mag, 1);

    // wading slows you down — in the sea/lakes, and in river channels
    const groundH = this.world.height(this.rig.position.x, this.rig.position.z);
    const river = this.world.riverAt(this.rig.position.x, this.rig.position.z);
    if (groundH < WATER_LEVEL + 0.4 || (river.wet && river.depth > 0.05)) target *= 0.55;

    this.speed = lerp(this.speed, target, 1 - Math.exp(-10 * dt));
    if (this.speed > 0.05) {
      this._dir.set(0, 0, 0)
        .addScaledVector(this._fwd, -mz)
        .addScaledVector(this._right, -mx);
      if (this._dir.lengthSq() > 1e-6) {
        this._dir.normalize();
        this.rig.position.addScaledVector(this._dir, this.speed * dt);
        this.strideDistance += this.speed * dt;
      }
    }

    // glue feet to terrain, softly so steps over detail noise don't jar
    const h = this.world.height(this.rig.position.x, this.rig.position.z);
    const floor = Math.max(h, WATER_LEVEL - 1.2); // can wade, not sink forever
    this.rig.position.y = lerp(this.rig.position.y, floor, 1 - Math.exp(-14 * dt));

    // subtle head bob on desktop only
    if (!xr) {
      this.bobPhase += this.speed * dt * 1.85;
      const bob = Math.sin(this.bobPhase) * 0.035 * clamp(this.speed / WALK_SPEED, 0, 1);
      this.camera.position.y = EYE_HEIGHT + bob;
    }
  }

  // one footstep every ~1.9m walked; returns true once per stride
  consumeFootstep() {
    if (this.strideDistance > 1.9) {
      this.strideDistance = 0;
      return this.speed > 0.4;
    }
    return false;
  }

  eyeWorldPosition(out) {
    return this.camera.getWorldPosition(out);
  }
}
