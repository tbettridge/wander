// Player movement: pointer-lock + WASD on desktop, smooth locomotion with snap
// turn in VR. Outdoor grounding uses the heightfield; debug/indoor experiments
// can provide a unified floor and swept-movement resolver.

import * as THREE from 'three';
import { resolveFloor } from './floor.mjs';
import { clamp, lerp } from './noise.js';
import { SPRINT_SPEED, WALK_SPEED } from './pace.mjs';
import { WATER_LEVEL } from './world.js';
import { XR_BUTTON_BINDINGS, xrLanternTriggerHeld } from './xractions.mjs';

const EYE_HEIGHT = 1.7;
const JUMP_VELOCITY = 6.25;
const GRAVITY = 19.5;

export { XR_BUTTON_BINDINGS };

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
    this.inputLocked = false;
    // Seated passengers keep mouselook while movement is disabled: the train
    // service sets this and reads yaw/pitch to orient the seat-local camera.
    this.allowLook = false;
    this.speed = 0;            // current horizontal speed (read by audio)
    this.strideDistance = 0;   // accumulated metres, for footsteps
    this.bobPhase = 0;
    this.eyeHeight = EYE_HEIGHT;
    this.snapCooldown = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.jumpQueued = false;
    this.xrActions = {
      run: false,
      jumpPressed: false,
      interactPressed: false,
      switchSeatPressed: false,
      lanternTogglePressed: false,
      // Sampled even while movement input is locked — a mounted rider steers
      // with the stick while their own legs are switched off.
      stickX: 0,
      stickY: 0,
      mountPressed: false,
      sprintHeld: false,
    };
    this._xrHeld = { jump: false, interact: false, switchSeat: false, lantern: false, mount: false };
    this.lanternTogglePressed = false;
    this._desktopLanternQueued = false;
    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._previous = new THREE.Vector3();
    this.environment = null; // active base or priority override
    this.baseEnvironment = null; // caves/stations/tunnels own the ordinary slot
    this.environmentOverrides = new Map(); // moving interiors can temporarily win
    this.obstacleResolver = null; // compatibility handle for the legacy resolver
    this.obstacleResolvers = new Map(); // dynamic outdoor obstacles compose here
    this.walkableSurface = null;
    // Reports the player's own floor each second while they are on a deck or in
    // water. Left on while crossings are being made to work.
    this.deckDebug = true;
    this._floorReport = 0;
    // Whether a deck is carrying the player, and whether they are really in
    // water — both read by the audio and movement layers.
    this.onDeck = false;
    this.wading = false;
    this._lastGround = 0;
    this._lastDeck = null; // decks standing above the terrain (see below)

    window.addEventListener('keydown', (e) => {
      // Only text-entry targets may swallow keys. Buttons deliberately do NOT:
      // clicking "click to walk" or any debug-panel button leaves DOM focus on
      // that button, and pointer lock does not move keyboard focus, so treating
      // a focused button as text entry silenced WASD for the whole session.
      // Movement is already gated by `enabled`, which conversations clear.
      const target = e.target;
      const tagName = target?.tagName?.toLocaleLowerCase();
      if (target?.isContentEditable
        || tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select') return;
      this.keys.add(e.code);
      // Queue once per physical press. Holding Space must not auto-hop when
      // the player lands, and pointer-lock keeps the key from scrolling.
      if (e.code === 'Space' && !e.repeat) {
        this.jumpQueued = true;
        if (this.enabled) e.preventDefault();
      }
      if (e.code === 'KeyF' && !e.repeat) {
        this._desktopLanternQueued = true;
        if (this.enabled || this.allowLook) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._desktopLanternQueued = false;
    });

    domElement.addEventListener('mousemove', (e) => {
      if ((!this.enabled && !this.allowLook) || document.pointerLockElement !== domElement) return;
      this.yaw -= e.movementX * 0.0021;
      this.pitch = clamp(this.pitch - e.movementY * 0.0021, -1.45, 1.45);
    });
  }

  setObstacleResolver(resolver) {
    this.obstacleResolver = resolver || null;
    if (resolver) this.obstacleResolvers.set('legacy', { resolver, priority: 0 });
    else this.obstacleResolvers.delete('legacy');
  }

  registerObstacleResolver(id, resolver, priority = 0) {
    if (!id || !resolver?.resolveMovement) {
      throw new TypeError('Obstacle resolvers require an id and resolveMovement().');
    }
    this.obstacleResolvers.set(id, { resolver, priority: Number(priority) || 0 });
    return () => this.obstacleResolvers.delete(id);
  }

  place(x, z) {
    // Land on whatever is walkable here, not on the bare terrain underneath it.
    // Teleporting onto a bridge used to drop the player inside the deck and let
    // the next frame sort it out.
    this.rig.position.set(x, this.surfaceHeight(x, z), z);
  }

  placeAt(x, y, z) {
    this.rig.position.set(x, y, z);
  }

  setEnvironment(environment) {
    this.baseEnvironment = environment || null;
    this._refreshEnvironment();
  }

  setEnvironmentOverride(id, environment = null, priority = 0) {
    if (!id) throw new TypeError('Environment overrides require an id.');
    if (environment) this.environmentOverrides.set(id, { environment, priority: Number(priority) || 0 });
    else this.environmentOverrides.delete(id);
    this._refreshEnvironment();
    return () => {
      this.environmentOverrides.delete(id);
      this._refreshEnvironment();
    };
  }

  _refreshEnvironment() {
    let chosen = null;
    for (const entry of this.environmentOverrides.values()) {
      if (!chosen || entry.priority > chosen.priority) chosen = entry;
    }
    this.environment = chosen?.environment || this.baseEnvironment;
  }

  /**
   * A structure standing above the terrain that can be walked on — a bridge
   * deck, a viaduct, a plank crossing.
   *
   * Deliberately NOT an `environment`. That contract hands total ownership of
   * the vertical domain to one claimant (a null floor freezes the player rather
   * than falling back to the ground), which is right for a cave interior and
   * wrong for something outdoors that the player walks on and off continuously.
   * There is also only one environment slot, and caves and the railway already
   * contend for it. This layers over the ordinary outdoor floor instead, so a
   * deck works everywhere without displacing anything.
   *
   * The provider returns a height, or null when there is no deck underfoot.
   */
  setWalkableSurface(provider) {
    this.walkableSurface = provider || null;
  }

  /**
   * What the player's feet actually resolved to this frame.
   *
   * The surface layer reporting a deck is not evidence the player stood on it:
   * one WalkableSurface serves the player AND every NPC, so a console line
   * saying a deck was found may be about somebody else entirely. This reports
   * the player's own floor decision — which is the number that decides whether
   * they walk the bridge or the riverbed.
   */
  _reportFloor(ground, deck, floor, river) {
    const now = Date.now();
    if (now - this._floorReport < 900) return;
    // Only where it matters: standing on something above the ground, or wet.
    if (!(deck > ground + 0.05 || river.wet)) return;
    this._floorReport = now;
    console.warn('[floor]'
      + ` env=${this.environment ? (this.environment.isIndoor?.() ? 'indoor' : 'active') : 'none'}`
      + ` ground=${ground.toFixed(2)} deck=${deck.toFixed(2)} floor=${floor.toFixed(2)}`
      + ` y=${this.rig.position.y.toFixed(2)}`
      + ` grounded=${this.grounded} wet=${river.wet} depth=${(river.depth ?? 0).toFixed(2)}`);
  }

  /** Ground height including any deck standing on it. Shared with NPCs. */
  surfaceHeight(x, z, atY = Infinity) {
    const ground = this.world.height(x, z);
    this._lastGround = ground;
    const deck = this.walkableSurface ? this.walkableSurface(x, z, atY) : null;
    // Kept separately from the answer: an active environment needs to know a
    // deck exists in order to stop overruling it, and "the height returned"
    // cannot distinguish a deck from the ground it stands on.
    this._lastDeck = deck !== null && deck !== undefined && deck > ground ? deck : null;
    return this._lastDeck !== null ? this._lastDeck : ground;
  }

  // Both callers below need the same "stop the player mid-stride" reset, so it
  // lives in one place rather than being copied into each.
  _clearMotionState() {
    this.keys.clear();
    this.speed = 0;
    this.jumpQueued = false;
    this._desktopLanternQueued = false;
  }

  // Benchmark / scripted lock: two-way, and also gates XR actions and look in
  // update(). Cleared only by setInputLocked(false).
  setInputLocked(locked) {
    this.inputLocked = !!locked;
    if (!this.inputLocked) return;
    this._clearMotionState();
  }

  // The Living World conversation UI takes over the screen, so it drops the
  // enabled flag and pointer-look as well.
  //
  // Deliberately NOT routed through setInputLocked: inputLocked is cleared only
  // by setInputLocked(false), while this path resumes by restoring `enabled`
  // directly (see main.js). Delegating would leave inputLocked set forever and
  // zero all movement in update() after the first conversation.
  suspendInput() {
    this.enabled = false;
    this.allowLook = false;
    this._clearMotionState();
  }

  requestJump() {
    this.jumpQueued = true;
  }

  update(dt) {
    const xr = this.renderer.xr.isPresenting;
    let mx = 0, mz = 0, sprint = false;
    this.lanternTogglePressed = false;

    if (xr) {
      const session = this.renderer.xr.getSession();
      let jumpHeld = false, interactHeld = false, switchSeatHeld = false, lanternHeld = false;
      this.xrActions.run = false;
      this.xrActions.jumpPressed = false;
      this.xrActions.interactPressed = false;
      this.xrActions.switchSeatPressed = false;
      this.xrActions.lanternTogglePressed = false;
      // Stick and mount button are read whatever the lock state, because
      // locking movement is exactly what riding does — gating these behind the
      // lock would leave a mounted player unable to steer.
      let mountHeld = false;
      this.xrActions.stickX = 0;
      this.xrActions.stickY = 0;
      this.xrActions.sprintHeld = false;
      for (const src of session?.inputSources || []) {
        const gp = src.gamepad;
        if (!gp || src.handedness !== 'left') continue;
        const sx = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
        const sy = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
        if (Math.abs(sx) > 0.12) this.xrActions.stickX = sx;
        if (Math.abs(sy) > 0.12) this.xrActions.stickY = sy;
        mountHeld ||= !!gp.buttons?.[5]?.pressed;   // Quest Y
        // Same stick-press that sprints on foot. `run` below is cleared by the
        // input lock, which riding holds down, so a rider needs its own copy.
        this.xrActions.sprintHeld ||= !!gp.buttons?.[3]?.pressed;
      }
      this.xrActions.mountPressed = mountHeld && !this._xrHeld.mount;
      this._xrHeld.mount = mountHeld;

      if (session && !this.inputLocked) {
        lanternHeld = xrLanternTriggerHeld(session.inputSources);
        for (const src of session.inputSources) {
          const gp = src.gamepad;
          if (!gp) continue;
          const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
          const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
          if (src.handedness === 'left') {
            if (Math.abs(ax) > 0.12) mx += ax;
            if (Math.abs(ay) > 0.12) mz += ay;
            // Pressing the movement stick is a natural hold-to-run action and
            // leaves both triggers free for future hand interactions.
            this.xrActions.run ||= !!gp.buttons?.[3]?.pressed;
            switchSeatHeld ||= !!gp.buttons?.[4]?.pressed; // Quest X
          } else if (src.handedness === 'right') {
            jumpHeld ||= !!gp.buttons?.[4]?.pressed;       // Quest A
            interactHeld ||= !!gp.buttons?.[5]?.pressed;   // Quest B
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
      this.xrActions.jumpPressed = jumpHeld && !this._xrHeld.jump;
      this.xrActions.interactPressed = interactHeld && !this._xrHeld.interact;
      this.xrActions.switchSeatPressed = switchSeatHeld && !this._xrHeld.switchSeat;
      this.xrActions.lanternTogglePressed = lanternHeld && !this._xrHeld.lantern;
      this.lanternTogglePressed = this.xrActions.lanternTogglePressed;
      if (this.xrActions.jumpPressed) this.requestJump();
      this._xrHeld.jump = jumpHeld;
      this._xrHeld.interact = interactHeld;
      this._xrHeld.switchSeat = switchSeatHeld;
      this._xrHeld.lantern = lanternHeld;
      sprint = this.xrActions.run;
    } else {
      this.xrActions.run = false;
      this.xrActions.jumpPressed = false;
      this.xrActions.interactPressed = false;
      this.xrActions.switchSeatPressed = false;
      this.xrActions.lanternTogglePressed = false;
      this.xrActions.mountPressed = false;
      this.xrActions.sprintHeld = false;
      this._xrHeld.mount = false;
      this._xrHeld.jump = false;
      this._xrHeld.interact = false;
      this._xrHeld.switchSeat = false;
      this._xrHeld.lantern = false;
      this.lanternTogglePressed = this._desktopLanternQueued
        && (this.enabled || this.allowLook);
      this._desktopLanternQueued = false;
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

    if (this.inputLocked) {
      mx = 0;
      mz = 0;
      sprint = false;
      this.jumpQueued = false;
      this.lanternTogglePressed = false;
      this.xrActions.run = false;
      this.xrActions.jumpPressed = false;
      this.xrActions.interactPressed = false;
      this.xrActions.switchSeatPressed = false;
      this.xrActions.lanternTogglePressed = false;
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
    const indoors = this.environment?.isIndoor?.() ?? false;
    // A bridge is not a river. This tested the terrain and the river at the
    // player's x/z and never asked whether something was carrying them over it,
    // so crossing a bridge slowed you to a wade — and main.js ran the identical
    // test to pick footstep sounds, so it also splashed. Walking a deck above a
    // river felt exactly like walking through it, whatever the feet resolved to.
    this.wading = !indoors && !this.onDeck
      && (groundH < WATER_LEVEL + 0.4 || (river.wet && river.depth > 0.05));
    if (this.wading) target *= 0.55;

    // Cave traversal already uses a compact crouch/ceiling solver. Keep the
    // new free-jump action on the outdoor movement domain until that solver
    // owns vertical sweeps too; this prevents a jump from crossing a low roof.
    const canJump = !indoors;
    if (this.jumpQueued) {
      if (this.enabled && this.grounded && canJump) {
        this.verticalVelocity = JUMP_VELOCITY;
        this.grounded = false;
      }
      this.jumpQueued = false;
    }

    this.speed = lerp(this.speed, target, 1 - Math.exp(-10 * dt));
    this._previous.copy(this.rig.position);
    if (this.speed > 0.05) {
      this._dir.set(0, 0, 0)
        .addScaledVector(this._fwd, -mz)
        .addScaledVector(this._right, -mx);
      if (this._dir.lengthSq() > 1e-6) {
        this._dir.normalize();
        this.rig.position.addScaledVector(this._dir, this.speed * dt);
      }
    }

    let acceptedDistance = Math.hypot(
      this.rig.position.x - this._previous.x,
      this.rig.position.z - this._previous.z,
    );
    const resolvers = [...this.obstacleResolvers.values()]
      .sort((a, b) => a.priority - b.priority);
    for (const { resolver } of resolvers) {
      const obstacleResult = resolver.resolveMovement?.(this.rig.position, this._previous);
      if (obstacleResult) acceptedDistance = Math.min(
        acceptedDistance,
        obstacleResult.acceptedDistance ?? Math.hypot(
          this.rig.position.x - this._previous.x,
          this.rig.position.z - this._previous.z,
        ),
      );
    }
    let movementResult = null;
    if (this.environment?.resolveMovement) {
      movementResult = this.environment.resolveMovement(this.rig.position, this._previous);
      acceptedDistance = movementResult?.acceptedDistance ?? Math.hypot(
        this.rig.position.x - this._previous.x,
        this.rig.position.z - this._previous.z,
      );
    } else if (this.environment?.constrain) {
      this.environment.constrain(this.rig.position, this._previous.x, this._previous.z);
      acceptedDistance = Math.hypot(
        this.rig.position.x - this._previous.x,
        this.rig.position.z - this._previous.z,
      );
    }
    this.strideDistance += acceptedDistance;

    // glue feet to terrain, softly so steps over detail noise don't jar
    const environmentFloor = Number.isFinite(movementResult?.floorHeight)
      ? movementResult.floorHeight
      : this.environment?.floorHeight?.(this.rig.position.x, this.rig.position.z);
    const outdoorFloor = this.surfaceHeight(
      this.rig.position.x, this.rig.position.z, this.rig.position.y,
    );
    // An indoor resolver owns its vertical domain. A missing cave floor freezes
    // the last safe height instead of pulling the player up to outdoor terrain.
    // Outdoors it does NOT get to veto a bridge deck: this branch used to hand
    // the environment the vertical domain outright, so a trail crossing within
    // a station's reach was resolved, reported, and discarded, and the player
    // walked through the deck into the river 2.85m below.
    void outdoorFloor;
    const floor = resolveFloor({
      hasEnvironment: !!this.environment,
      indoors,
      environmentFloor,
      deck: this._lastDeck,
      ground: this._lastGround,
      lastY: this.rig.position.y,
      waterLevel: WATER_LEVEL,
    });
    this.onDeck = this._lastDeck !== null && floor >= this._lastDeck - 0.01;
    if (this.deckDebug) this._reportFloor(this._lastGround, outdoorFloor, floor, river);
    if (this.grounded || indoors) {
      // A cave may become active while an outdoor jump is in progress. Cancel
      // its remaining airborne state before the indoor resolver takes over.
      this.verticalVelocity = 0;
      this.grounded = true;
      this.rig.position.y = lerp(this.rig.position.y, floor, 1 - Math.exp(-14 * dt));
    } else {
      this.verticalVelocity -= GRAVITY * dt;
      this.rig.position.y += this.verticalVelocity * dt;
      if (this.rig.position.y <= floor) {
        this.rig.position.y = floor;
        this.verticalVelocity = 0;
        this.grounded = true;
      }
    }

    // subtle head bob on desktop only
    if (!xr) {
      const targetEyeHeight = movementResult?.eyeHeight ?? EYE_HEIGHT;
      // Duck on the same frame collision admits the low opening, preventing a
      // brief ceiling clip. Standing back up is deliberately softer so an
      // irregular roof reads as one natural crouch rather than camera chatter.
      if (targetEyeHeight < this.eyeHeight) this.eyeHeight = targetEyeHeight;
      else this.eyeHeight = lerp(
        this.eyeHeight, targetEyeHeight, 1 - Math.exp(-5.5 * dt),
      );
      this.bobPhase += this.speed * dt * 1.85;
      const bob = Math.sin(this.bobPhase) * 0.035 * clamp(this.speed / WALK_SPEED, 0, 1);
      const crouchBlend = clamp((this.eyeHeight - 1.05) / (EYE_HEIGHT - 1.05), 0, 1);
      this.camera.position.y = this.eyeHeight + bob * crouchBlend;
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
