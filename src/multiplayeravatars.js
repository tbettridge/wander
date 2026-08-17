import * as THREE from 'three';

/** Lightweight, intentionally anonymous visitor avatars. */
export class MultiplayerAvatarManager {
  constructor(scene, { maxAvatars = 3 } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'wander-multiplayer-avatars';
    scene?.add(this.root);
    this.maxAvatars = Math.max(1, Math.min(3, maxAvatars));
    this.avatars = new Map();
  }

  upsert({ playerId, displayName = 'Visitor', pose, color } = {}) {
    if (!playerId || !pose) return null;
    let avatar = this.avatars.get(playerId);
    if (!avatar) {
      if (this.avatars.size >= this.maxAvatars) return null;
      avatar = this._createAvatar(displayName, colorFor(playerId, color));
      avatar.playerId = playerId;
      avatar.displayName = displayName;
      this.avatars.set(playerId, avatar);
      this.root.add(avatar.group);
      avatar.group.position.set(pose.x || 0, pose.y || 0, pose.z || 0);
      avatar.target.set(pose.x || 0, pose.y || 0, pose.z || 0);
    }
    avatar.target.set(Number(pose.x) || 0, Number(pose.y) || 0, Number(pose.z) || 0);
    avatar.targetYaw = Number(pose.yaw) || 0;
    avatar.targetPitch = Number(pose.pitch) || 0;
    avatar.moving = !!pose.moving;
    avatar.lastSeenAt = performanceNow();
    return avatar;
  }

  remove(playerId) {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return false;
    this.root.remove(avatar.group);
    avatar.group.traverse((node) => {
      node.geometry?.dispose?.();
      node.material?.dispose?.();
    });
    this.avatars.delete(playerId);
    return true;
  }

  update(dt = 0.016) {
    const alpha = 1 - Math.exp(-Math.max(0, dt) * 12);
    for (const avatar of this.avatars.values()) {
      avatar.group.position.lerp(avatar.target, alpha);
      avatar.group.rotation.y = dampAngle(avatar.group.rotation.y, avatar.targetYaw, alpha);
      const sway = avatar.moving ? Math.sin(performanceNow() * 0.008 + avatar.phase) * 0.035 : 0;
      avatar.body.rotation.z = sway;
      avatar.group.visible = performanceNow() - avatar.lastSeenAt < 10_000;
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

  _createAvatar(displayName, color) {
    const group = new THREE.Group();
    group.name = `visitor-${displayName}`;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.85, 4, 8), material);
    body.position.y = 0.78;
    body.castShadow = true;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xd9b59a, roughness: 0.9 }),
    );
    head.position.y = 1.55;
    head.castShadow = true;
    group.add(body, head);
    const label = createLabel(displayName);
    if (label) {
      label.position.y = 2.05;
      group.add(label);
    }
    return {
      group,
      body,
      target: new THREE.Vector3(),
      targetYaw: 0,
      targetPitch: 0,
      phase: Math.random() * Math.PI * 2,
      moving: false,
      lastSeenAt: performanceNow(),
    };
  }
}

function colorFor(playerId, explicit) {
  if (explicit !== undefined) return explicit;
  let hash = 0;
  for (const character of String(playerId)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = (hash >>> 0) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.36, 0.48);
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
  let delta = (target - current + Math.PI) % (Math.PI * 2) - Math.PI;
  return current + delta * alpha;
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

