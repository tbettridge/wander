// A single procedural kerosene lantern shared by desktop and WebXR. Desktop
// carries it at the lower-right edge of the view; XR suspends the same object
// from the tracked off hand and counter-rotates the grip so gravity remains
// legible while the spring model supplies physical lag.

import * as THREE from 'three';
import {
  createLanternSwingState,
  lanternFlicker,
  lanternIgnitionTarget,
  lanternGlowOpacity,
  lanternLightIntensity,
  lanternPresenceTarget,
  lanternSwingTarget,
  stepLanternSwing,
} from './lanternmotion.mjs?v=5';

const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _worldQuaternion = new THREE.Quaternion();
const _inverseQuaternion = new THREE.Quaternion();
const _rawVelocity = new THREE.Vector3();
const _rawAcceleration = new THREE.Vector3();

function solid(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addCylinder(parent, top, bottom, height, y, material, name, segments = 12) {
  const mesh = solid(
    new THREE.CylinderGeometry(top, bottom, height, segments), material, name,
  );
  mesh.position.y = y;
  parent.add(mesh);
  return mesh;
}

function addRod(parent, start, end, radius, material, name) {
  _a.set(...start);
  _b.set(...end);
  _centre.addVectors(_a, _b).multiplyScalar(0.5);
  _direction.subVectors(_b, _a);
  const mesh = solid(
    new THREE.CylinderGeometry(radius, radius, _direction.length(), 7),
    material,
    name,
  );
  mesh.position.copy(_centre);
  mesh.quaternion.setFromUnitVectors(_up, _direction.normalize());
  parent.add(mesh);
  return mesh;
}

function makeLanternModel() {
  const brass = new THREE.MeshStandardMaterial({
    name: 'Worn lantern brass',
    color: 0x8e5e25,
    roughness: 0.34,
    metalness: 0.76,
  });
  const brassEdge = new THREE.MeshStandardMaterial({
    name: 'Polished lantern edges',
    color: 0xc08a3d,
    roughness: 0.27,
    metalness: 0.8,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    name: 'Lantern ironwork',
    color: 0x2b241d,
    roughness: 0.52,
    metalness: 0.68,
  });
  const glass = new THREE.MeshStandardMaterial({
    name: 'Warm hurricane glass',
    color: 0xffc985,
    emissive: 0xff6c18,
    emissiveIntensity: 0.02,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const wickMaterial = new THREE.MeshStandardMaterial({
    name: 'Charred wick', color: 0x17100b, roughness: 1,
  });
  const flameMaterial = new THREE.MeshBasicMaterial({
    name: 'Kerosene flame',
    color: 0xffd27a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  const glowMaterial = new THREE.MeshBasicMaterial({
    name: 'Kerosene flame glow',
    color: 0xff9a3d,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const root = new THREE.Group();
  root.name = 'Carried kerosene lantern';
  const swing = new THREE.Group();
  swing.name = 'Lantern handle pendulum';
  root.add(swing);

  // The handle's top is the suspension point. Its semicircular brass bow and
  // hinged legs make the hand attachment readable from both eyes in XR.
  const handle = solid(
    new THREE.TorusGeometry(0.14, 0.012, 7, 22, Math.PI),
    darkMetal,
    'Hinged carrying handle',
  );
  handle.position.y = -0.14;
  handle.scale.y = 1.08;
  swing.add(handle);
  addRod(swing, [-0.14, -0.14, 0], [-0.13, -0.27, 0], 0.011, darkMetal, 'Left handle hinge');
  addRod(swing, [0.14, -0.14, 0], [0.13, -0.27, 0], 0.011, darkMetal, 'Right handle hinge');

  // Ventilated cap and broad fuel reservoir give the silhouette the familiar
  // handcrafted hurricane-lantern weight instead of a generic glowing orb.
  addCylinder(swing, 0.048, 0.07, 0.075, -0.205, brass, 'Vent chimney');
  addCylinder(swing, 0.082, 0.06, 0.026, -0.157, brassEdge, 'Vent crown');
  addCylinder(swing, 0.112, 0.09, 0.035, -0.255, brassEdge, 'Upper globe collar');
  addCylinder(swing, 0.057, 0.07, 0.04, -0.493, brass, 'Wick burner');
  addCylinder(swing, 0.112, 0.126, 0.044, -0.526, brassEdge, 'Lower globe collar');

  const reservoir = solid(
    new THREE.SphereGeometry(0.13, 14, 8), brass, 'Rounded kerosene reservoir',
  );
  reservoir.position.y = -0.574;
  reservoir.scale.y = 0.48;
  swing.add(reservoir);
  addCylinder(swing, 0.135, 0.125, 0.025, -0.635, darkMetal, 'Lantern foot');
  addCylinder(swing, 0.105, 0.12, 0.018, -0.615, brassEdge, 'Reservoir rim');

  // Four tapered stays cage the globe and visually carry the upper cap's load
  // into the reservoir. They also cast small moving shadows on capable desktop
  // tiers when the lantern swings.
  addRod(swing, [-0.105, -0.27, 0], [-0.13, -0.535, 0], 0.009, brass, 'Left globe stay');
  addRod(swing, [0.105, -0.27, 0], [0.13, -0.535, 0], 0.009, brass, 'Right globe stay');
  addRod(swing, [0, -0.27, -0.095], [0, -0.535, -0.12], 0.007, brass, 'Rear globe stay');
  addRod(swing, [0, -0.27, 0.095], [0, -0.535, 0.12], 0.007, brass, 'Front globe stay');

  const globeProfile = [
    [0.054, -0.13], [0.082, -0.108], [0.105, -0.062],
    [0.098, 0], [0.108, 0.064], [0.078, 0.112], [0.052, 0.13],
  ].map(([radius, y]) => new THREE.Vector2(radius, y));
  const globe = new THREE.Mesh(new THREE.LatheGeometry(globeProfile, 18), glass);
  globe.name = 'Hurricane glass globe';
  globe.position.y = -0.392;
  globe.castShadow = false;
  globe.renderOrder = 2;
  swing.add(globe);

  const wick = solid(
    new THREE.CylinderGeometry(0.012, 0.014, 0.055, 7), wickMaterial, 'Lantern wick',
  );
  wick.position.y = -0.462;
  swing.add(wick);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.09, 9), flameMaterial);
  flame.name = 'Golden kerosene flame';
  flame.position.y = -0.402;
  flame.renderOrder = 3;
  swing.add(flame);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 7), glowMaterial);
  glow.name = 'Soft amber flame halo';
  glow.position.y = -0.41;
  glow.scale.y = 1.25;
  glow.renderOrder = 1;
  swing.add(glow);

  const fillerCap = addCylinder(
    swing, 0.026, 0.032, 0.032, -0.565, brassEdge, 'Kerosene filler cap', 9,
  );
  fillerCap.rotation.z = Math.PI * 0.5;
  fillerCap.position.x = 0.137;

  // Do not give the light a finite cutoff: Three's range term reaches exactly
  // zero at `distance`, which becomes a visible circle once a dark scene is
  // graded. A steeper physical-style decay makes the tail imperceptible on its
  // own instead, while retaining a broad, graduated pool around the player.
  const light = new THREE.PointLight(0xffc36a, 0, 0, 1.7);
  // r184+ performs the full render-target path in the renderer's linear
  // working space. Use a slightly creamier kerosene tint there so the physical
  // pool remains amber after the desktop grade instead of collapsing to red.
  if (Number(THREE.REVISION) >= 184) light.color.set(0xffd6a0);
  light.name = 'Carried warm lantern light';
  light.position.set(0, -0.41, 0.012);
  light.castShadow = false;
  light.shadow.mapSize.set(256, 256);
  light.shadow.camera.near = 0.12;
  light.shadow.camera.far = 18;
  light.shadow.bias = -0.0015;
  light.shadow.normalBias = 0.035;
  swing.add(light);

  return { root, swing, light, glass, flame, flameMaterial, glowMaterial };
}

export class CarriedLantern {
  constructor(renderer, camera, controls) {
    this.renderer = renderer;
    this.camera = camera;
    this.controls = controls;
    this.enabled = false;
    this.level = 0;
    this.presence = 0;
    this.mode = 'desktop';
    this.swingState = createLanternSwingState();
    this.walkPhase = 0;
    this.motionReady = false;
    this.modernWorkingColorSpace = Number(THREE.REVISION) >= 184;
    this.previousAnchor = new THREE.Vector3();
    this.filteredVelocity = new THREE.Vector3();
    this.previousVelocity = new THREE.Vector3();
    this.filteredAcceleration = new THREE.Vector3();

    const model = makeLanternModel();
    Object.assign(this, model);
    this.desktopAnchor = new THREE.Group();
    this.desktopAnchor.name = 'Desktop peripheral lantern anchor';
    this.desktopShownPosition = new THREE.Vector3(0.48, 0.055, -0.78);
    this.desktopHiddenPosition = new THREE.Vector3(1.18, -0.1, -0.78);
    this.desktopAnchor.position.copy(this.desktopHiddenPosition);
    camera.add(this.desktopAnchor);
    this.desktopAnchor.add(this.root);
    this.root.scale.setScalar(0.74);
    this.root.visible = false;

    // Both target-ray and grip spaces move with the same tracking origin. The
    // target-ray event reliably identifies handedness; gripSpace supplies the
    // physical palm pose when the device exposes one.
    this.controllerSlots = [0, 1].map((index) => {
      const target = renderer.xr.getController(index);
      const grip = renderer.xr.getControllerGrip(index);
      const slot = { index, target, grip, inputSource: null };
      target.name = `XR controller ray ${index}`;
      grip.name = `XR controller grip ${index}`;
      target.addEventListener('connected', (event) => { slot.inputSource = event.data; });
      target.addEventListener('disconnected', () => { slot.inputSource = null; });
      controls.rig.add(target);
      controls.rig.add(grip);
      return slot;
    });
    this.activeSpace = null;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  _syncTrackingOrigin() {
    const parent = this.camera.parent || this.controls.rig;
    for (const slot of this.controllerSlots) {
      if (slot.target.parent !== parent) parent.add(slot.target);
      if (slot.grip.parent !== parent) parent.add(slot.grip);
    }
  }

  _offHandSpace() {
    const connected = this.controllerSlots.filter((slot) => slot.inputSource);
    const slot = connected.find((entry) => entry.inputSource.handedness === 'left')
      || connected.find((entry) => entry.inputSource.handedness === 'right')
      || null;
    if (!slot) return null;
    return slot.inputSource.gripSpace ? slot.grip : slot.target;
  }

  _enterDesktop() {
    if (this.root.parent !== this.desktopAnchor) this.desktopAnchor.add(this.root);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.setScalar(0.74);
    this.activeSpace = null;
    this.mode = 'desktop';
    this.motionReady = false;
  }

  _enterXR(space) {
    if (!space) {
      this.root.visible = false;
      this.activeSpace = null;
      this.mode = 'xr';
      this.motionReady = false;
      return;
    }
    if (this.root.parent !== space) space.add(this.root);
    this.root.position.set(0, -0.01, 0.018);
    if (this.activeSpace !== space || this.mode !== 'xr') this.motionReady = false;
    this.activeSpace = space;
    this.mode = 'xr';

    // Cancel wrist pitch/roll so the handle's suspension point follows the
    // palm while the lantern itself continues to hang in world gravity.
    space.updateWorldMatrix(true, false);
    space.getWorldQuaternion(_worldQuaternion);
    this.root.quaternion.copy(_worldQuaternion).invert();
  }

  _sampleAcceleration(object, dt, localTo = null) {
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(_anchor);
    const step = Math.max(dt, 1 / 240);
    if (!this.motionReady || _anchor.distanceTo(this.previousAnchor) > 1.5) {
      this.previousAnchor.copy(_anchor);
      this.filteredVelocity.set(0, 0, 0);
      this.previousVelocity.set(0, 0, 0);
      this.filteredAcceleration.set(0, 0, 0);
      this.motionReady = true;
      return this.filteredAcceleration;
    }

    _rawVelocity.subVectors(_anchor, this.previousAnchor).multiplyScalar(1 / step);
    this.previousAnchor.copy(_anchor);
    const velocityBlend = 1 - Math.exp(-10 * step);
    this.filteredVelocity.lerp(_rawVelocity, velocityBlend);
    _rawAcceleration.subVectors(this.filteredVelocity, this.previousVelocity).multiplyScalar(1 / step);
    this.previousVelocity.copy(this.filteredVelocity);
    const accelerationBlend = 1 - Math.exp(-7 * step);
    this.filteredAcceleration.lerp(_rawAcceleration, accelerationBlend);
    this.filteredAcceleration.clampLength(0, 20);

    if (localTo) {
      localTo.getWorldQuaternion(_inverseQuaternion).invert();
      return _rawAcceleration.copy(this.filteredAcceleration).applyQuaternion(_inverseQuaternion);
    }
    return this.filteredAcceleration;
  }

  _resetHiddenMotion() {
    this.motionReady = false;
    this.swingState.pitch = 0;
    this.swingState.roll = 0;
    this.swingState.pitchVelocity = 0;
    this.swingState.rollVelocity = 0;
    this.swing.rotation.set(0, 0, 0);
  }

  update(dt, timeSeconds, { togglePressed = false, allowDynamicShadows = false } = {}) {
    if (togglePressed) this.toggle();
    const xr = this.renderer.xr.isPresenting;
    let anchorObject = this.camera;
    let localTo = this.camera;
    let hasPresentationSpace = true;

    if (xr) {
      this._syncTrackingOrigin();
      const space = this._offHandSpace();
      this._enterXR(space);
      hasPresentationSpace = !!space;
      if (space) {
        anchorObject = space;
        localTo = null; // root axes have been counter-rotated into world space
      }
    } else if (this.mode !== 'desktop' || this.root.parent !== this.desktopAnchor) {
      this._enterDesktop();
    }

    const presenceTarget = lanternPresenceTarget(this.enabled, this.level);
    this.presence = THREE.MathUtils.damp(
      this.presence, presenceTarget, this.enabled ? 4.5 : 6, dt,
    );
    const targetLevel = lanternIgnitionTarget(this.enabled, this.presence);
    this.level = THREE.MathUtils.damp(this.level, targetLevel, this.enabled ? 7 : 9, dt);

    // Desktop physically travels in from beyond the lower-right frame edge.
    // XR grows into the grip instead, keeping the hand anchor fixed and avoiding
    // a sideways camera-space motion that would feel artificial in stereo.
    if (xr) {
      const appear = THREE.MathUtils.smoothstep(this.presence, 0.02, 0.7);
      this.root.scale.setScalar(0.9 * appear);
    } else {
      const slide = THREE.MathUtils.smootherstep(this.presence, 0, 1);
      this.desktopAnchor.position.lerpVectors(
        this.desktopHiddenPosition, this.desktopShownPosition, slide,
      );
      this.root.scale.setScalar(0.74);
    }
    this.root.visible = hasPresentationSpace
      && (this.enabled || this.presence > 0.004 || this.level > 0.002);

    if (this.root.visible) {
      this.walkPhase += Math.max(0, this.controls.speed) * Math.max(0, dt) * 1.45;
      const acceleration = this._sampleAcceleration(anchorObject, dt, localTo);
      const target = lanternSwingTarget({
        accelerationX: acceleration.x,
        accelerationZ: acceleration.z,
        speed: this.controls.speed,
        walkPhase: this.walkPhase,
      });
      stepLanternSwing(this.swingState, dt, target);
      this.swing.rotation.x = this.swingState.pitch;
      this.swing.rotation.z = this.swingState.roll;
    } else {
      this._resetHiddenMotion();
    }

    const flicker = lanternFlicker(timeSeconds);
    this.light.intensity = lanternLightIntensity(this.level, timeSeconds);
    this.light.visible = this.level > 0.002 && this.root.visible;
    const castsShadow = this.light.visible && !xr && allowDynamicShadows;
    if (this.light.castShadow !== castsShadow) this.light.castShadow = castsShadow;

    this.glass.emissiveIntensity = 0.02 + this.level * flicker * 1.12;
    this.glass.opacity = 0.2 + this.level * 0.14;
    this.flameMaterial.opacity = this.level * (0.78 + (flicker - 0.93) * 2.1);
    this.glowMaterial.opacity = lanternGlowOpacity(
      this.level,
      flicker,
      this.modernWorkingColorSpace,
    );
    this.flame.scale.set(0.92 + flicker * 0.08, 0.82 + flicker * 0.2, 0.92 + flicker * 0.08);
  }
}
