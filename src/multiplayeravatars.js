import * as THREE from 'three';
import { createNpcAvatar, NpcAssetLibrary } from './npcavatar.js';
import { advanceNpcLocomotion, createNpcLocomotionState } from './npclocomotion.mjs';
import { npcWorldDimensions } from './npcanatomy.mjs';
import { createNpcIdentity } from './npcpopulation.mjs';
import {
  advancePlayout,
  createPlayoutClock,
  recordPose,
  sampleAt,
} from './poseinterpolation.mjs';

/**
 * Visitors, wearing the same bodies the world's own people wear.
 *
 * A remote player used to be a capsule with a sphere on top, leaning slightly
 * when it moved. Everyone else in this world walks: the gait solver plants feet
 * against the ground, swings the arms against the hips and leans into turns, and
 * a visitor standing among villagers who all move properly was the one thing in
 * the scene that read as a placeholder.
 *
 * The gait is not animated from the `moving` flag. advanceNpcLocomotion measures
 * speed from how far the body actually travelled since the last frame, so
 * driving the same interpolation that already smoothed the capsule now produces
 * a walk cycle whose cadence matches the real speed — including slowing to a
 * stop, which a boolean could not express.
 */

/** Poses are eased on top of the interpolation so a late packet cannot step. */
const FOLLOW_SHARPNESS = 12;
const SCRATCH = new THREE.Vector3();
/** A visitor whose poses stopped arriving is hidden rather than left standing. */
const STALE_AFTER_MS = 10_000;

export class MultiplayerAvatarManager {
  constructor(scene, { maxAvatars = 3, worldSeed = 1, assets = null, surfaceQuery = null } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'wander-multiplayer-avatars';
    scene?.add(this.root);
    this.maxAvatars = Math.max(1, Math.min(3, maxAvatars));
    this.worldSeed = Number(worldSeed) || 1;
    // Shared with the settlements when one is handed in: the geometry and
    // material caches are the expensive part of a body, not the skeleton.
    this.assets = assets || new NpcAssetLibrary();
    this.surfaceQuery = typeof surfaceQuery === 'function' ? surfaceQuery : null;
    this.avatars = new Map();
  }

  /** Let the manager ground visitors once the walkable surface exists. */
  setSurfaceQuery(surfaceQuery) {
    this.surfaceQuery = typeof surfaceQuery === 'function' ? surfaceQuery : null;
  }

  upsert({ playerId, displayName = 'Visitor', pose, sentAt = null } = {}) {
    if (!playerId || !pose) return null;
    let avatar = this.avatars.get(playerId);
    if (!avatar) {
      if (this.avatars.size >= this.maxAvatars) return null;
      avatar = this._createAvatar(playerId, displayName);
      this.avatars.set(playerId, avatar);
      this.root.add(avatar.group);
      avatar.group.position.set(Number(pose.x) || 0, Number(pose.y) || 0, Number(pose.z) || 0);
    } else if (displayName && displayName !== avatar.displayName) {
      this.rename(playerId, displayName);
    }
    const at = performanceNow();
    const sample = {
      // The sender's clock when available: evenly spaced by construction, where
      // arrival times carry every hiccup the network added.
      at: Number.isFinite(Number(sentAt)) ? Number(sentAt) : at,
      x: Number(pose.x) || 0,
      y: Number(pose.y) || 0,
      z: Number(pose.z) || 0,
      yaw: Number(pose.yaw) || 0,
      moving: !!pose.moving,
    };
    if (recordPose(avatar.history, sample)) {
      avatar.group.position.set(sample.x, sample.y, sample.z);
      avatar.group.rotation.y = sample.yaw;
    }
    avatar.moving = sample.moving;
    avatar.lastSeenAt = at;
    return avatar;
  }

  remove(playerId) {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return false;
    this.root.remove(avatar.group);
    avatar.avatar.dispose?.();
    avatar.label?.material?.map?.dispose?.();
    avatar.label?.material?.dispose?.();
    this.avatars.delete(playerId);
    return true;
  }

  rename(playerId, displayName) {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return false;
    const next = String(displayName || 'Visitor').trim().slice(0, 28) || 'Visitor';
    if (avatar.displayName === next) return true;
    if (avatar.label) {
      avatar.group.remove(avatar.label);
      avatar.label.material?.map?.dispose?.();
      avatar.label.material?.dispose?.();
    }
    avatar.displayName = next;
    avatar.group.name = `visitor-${next}`;
    avatar.label = createLabel(next);
    if (avatar.label) {
      avatar.label.position.y = (avatar.avatar.dims?.eye || 1.6) + 0.42;
      avatar.group.add(avatar.label);
    }
    return true;
  }

  update(dt = 0.016) {
    const safeDt = Math.max(0, dt);
    const alpha = 1 - Math.exp(-safeDt * FOLLOW_SHARPNESS);
    const now = performanceNow();
    for (const avatar of this.avatars.values()) {
      avatar.group.visible = now - avatar.lastSeenAt < STALE_AFTER_MS;
      if (!avatar.group.visible) continue;
      // Draw the moment that is INTERPOLATION_DELAY_MS in the past, between the
      // two poses that bracket it. The distance covered by this step is exactly
      // what the gait reads as speed, so the walk cycle still needs no animation
      // state of its own — it now just follows a smooth path instead of a jittery
      // one. A small ease remains on top so a late packet cannot produce a step.
      const renderTime = advancePlayout(avatar.playout, avatar.history, safeDt * 1000);
      const sampled = renderTime === null ? null : sampleAt(avatar.history, renderTime);
      if (sampled) {
        avatar.group.position.lerp(SCRATCH.set(sampled.x, sampled.y, sampled.z), alpha);
        avatar.group.rotation.y = dampAngle(avatar.group.rotation.y, sampled.yaw, alpha);
      }
      const position = avatar.group.position;
      const solved = advanceNpcLocomotion(avatar.locomotion, {
        dims: avatar.worldDims,
        dt: safeDt,
        position: [position.x, position.y, position.z],
        heading: avatar.group.rotation.y,
        surfaceQuery: this.surfaceQuery,
        fixedY: position.y,
      });
      if (!solved) continue;
      avatar.avatar.setDetail?.(0);
      avatar.avatar.applyPose(solved, position.y);
    }
  }

  clear() {
    for (const id of [...this.avatars.keys()]) this.remove(id);
  }

  get diagnostics() {
    return {
      count: this.avatars.size,
      maxAvatars: this.maxAvatars,
      players: [...this.avatars.values()].map((avatar) => ({
        playerId: avatar.playerId,
        displayName: avatar.displayName,
        visible: avatar.group.visible,
        lastSeenAt: avatar.lastSeenAt,
      })),
    };
  }

  _createAvatar(playerId, displayName) {
    // A visitor keeps the same face every time they call. The identity is seeded
    // from the player id, which is stable for the life of their browser, so the
    // person you met yesterday is recognisably the same person today.
    const identity = createNpcIdentity({
      worldSeed: this.worldSeed,
      stationId: 'visitors',
      stationName: 'Visitors',
      slot: { key: `visitor:${playerId}`, role: 'traveller', family: 'storybook', activity: 'wait' },
      givenName: cleanName(displayName),
    });
    const avatar = createNpcAvatar(identity, this.assets);
    const group = new THREE.Group();
    group.name = `visitor-${displayName}`;
    group.add(avatar.root);

    const label = createLabel(displayName);
    if (label) {
      label.position.y = (avatar.dims?.eye || 1.6) + 0.42;
      group.add(label);
    }
    return {
      playerId,
      displayName,
      group,
      avatar,
      label,
      locomotion: createNpcLocomotionState(identity.animation.phase / (Math.PI * 2)),
      worldDims: npcWorldDimensions(avatar.dims, identity.proportions),
      history: [],
      playout: createPlayoutClock(),
      moving: false,
      lastSeenAt: performanceNow(),
    };
  }
}

function cleanName(displayName) {
  const trimmed = String(displayName || '').trim().split(/\s+/)[0];
  return /^[A-Za-z][A-Za-z'-]{0,23}$/.test(trimmed) ? trimmed : null;
}

function createLabel(text) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 48;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(5, 10, 12, .72)';
  context.roundRect?.(5, 5, 246, 38, 10);
  context.fill();
  context.font = '22px Helvetica Neue, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#e9f1ee';
  context.fillText(String(text).slice(0, 24), 128, 24);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(2.1, 0.4, 1);
  return sprite;
}

function dampAngle(current, target, alpha) {
  const delta = (target - current + Math.PI) % (Math.PI * 2) - Math.PI;
  return current + delta * alpha;
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
