import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { waterUniforms } from './watercommon.js';
import { lakeReflectionTargets, nearestLakeReflection } from './waterreflectiontargets.mjs';

// Default capture size; quality tiers may raise it (tier.reflectionSize).
const CAPTURE_SIZE = 384;
// The capture spans the camera's field of view in `size` texels and is seen
// through ripples, so a mesh only a couple of texels wide contributes nothing
// to it. It still cost a draw call: train fittings, station trim and every
// distant prop pushed one capture to ~900 draws, up to 30 times a second while
// walking. Anything under this many texels across is left out, measured from
// the real camera, which is nearer than the mirrored one and so errs on the
// side of keeping things.
const MIN_REFLECTED_TEXELS = 2.5;
const _sphere = new THREE.Sphere();

// One nearby lake gets a small planar capture. The source surface remains the
// shared clipped mesh; the helper plane is never added to the scene.
export class LakeReflection {
  constructor() {
    this.targets = []; this.planHash = null; this.elapsed = 1;
    this.position = new THREE.Vector3(); this.rotation = new THREE.Quaternion();
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastRotation = new THREE.Quaternion(); this.inverse = new THREE.Matrix4();
    this.captureCamera = new THREE.PerspectiveCamera();
    this.cost = 0; this.activeId = null; this.size = CAPTURE_SIZE;
    this.minAngle = 0;
  }

  setQuality(tier) {
    this.size = tier?.reflectionSize || CAPTURE_SIZE;
  }

  // Whether an object is worth drawing into the capture. Scatter can opt out
  // (or limit its range) with userData.reflectionRange: instanced and batched
  // scatter spans a whole chunk, so its bounds alone never look small.
  reflects(object) {
    const range = object.userData.reflectionRange;
    if (range === 0) return false;
    const bounds = object.boundingSphere || object.geometry?.boundingSphere;
    if (!bounds) return true;
    _sphere.copy(bounds).applyMatrix4(object.matrixWorld);
    const distance = _sphere.center.distanceTo(this.position);
    if (range !== undefined && distance - _sphere.radius > range) return false;
    return _sphere.radius >= distance * this.minAngle;
  }

  update(renderer, scene, camera, world, dt, enabled = true) {
    const u = waterUniforms;
    if (!enabled || renderer.xr.isPresenting || !world.waterField) { u.uLakeReflectionReady.value = 0; return; }
    if (world.waterPlanHash !== this.planHash) {
      this.targets = lakeReflectionTargets(world); this.planHash = world.waterPlanHash;
      this.activeId = null;
    }
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.position); camera.getWorldQuaternion(this.rotation);
    const target = nearestLakeReflection(this.targets, this.position);
    if (!target) { u.uLakeReflectionReady.value = 0; this.activeId = null; return; }
    this.elapsed += dt;
    const moved = this.position.distanceToSquared(this.lastPosition) > 0.01 || this.rotation.angleTo(this.lastRotation) > 0.002;
    // Moving re-captures up to `movingRate` times a second (30 on foot). From
    // a train the camera never stops, so it ran every frame at 7–11 ms each;
    // the rider's rate is lower, which rippled water does not show.
    if (this.activeId === target.id && this.elapsed < (moved ? 1 / (this.movingRate || 30) : 1 / 12)) return;
    this.reflector ||= new Reflector(new THREE.PlaneGeometry(1, 1), {
      textureWidth: this.size, textureHeight: this.size, clipBias: 0.001, multisample: 0,
    });
    const reflector = this.reflector;
    const captureTarget = reflector.getRenderTarget();
    if (captureTarget.width !== this.size) captureTarget.setSize(this.size, this.size);
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set((target.minX + target.maxX) / 2, target.level, (target.minZ + target.maxZ) / 2);
    reflector.updateMatrixWorld(true);
    const capture = this.captureCamera;
    capture.copy(camera, false); capture.position.copy(this.position); capture.quaternion.copy(this.rotation);
    capture.far = Math.min(camera.far, 450); capture.updateProjectionMatrix(); capture.updateMatrixWorld(true);
    // radius / distance for a mesh MIN_REFLECTED_TEXELS across
    this.minAngle = 0.5 * MIN_REFLECTED_TEXELS * THREE.MathUtils.degToRad(capture.fov) / this.size;
    const hidden = [], cameraVisible = camera.visible;
    scene.traverseVisible(object => {
      if (!object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(m => m?.userData?.waterSurface) || !this.reflects(object)) hidden.push(object);
    });
    for (const object of hidden) object.visible = false;
    camera.visible = false;
    const ready = u.uLakeReflectionReady.value;
    u.uLakeReflectionReady.value = 0;
    const start = performance.now();
    try {
      reflector.onBeforeRender(renderer, scene, capture);
      this.inverse.copy(reflector.matrixWorld).invert();
      u.uLakeReflectionMatrix.value.copy(reflector.material.uniforms.textureMatrix.value).multiply(this.inverse);
      u.uLakeReflectionMap.value = reflector.getRenderTarget().texture;
      u.uLakeReflectionLevel.value = target.level;
      u.uLakeReflectionBounds.value.set(target.minX - 4, target.minZ - 4, target.maxX + 4, target.maxZ + 4);
      u.uLakeReflectionReady.value = 1;
      this.activeId = target.id; this.elapsed = 0;
      this.lastPosition.copy(this.position); this.lastRotation.copy(this.rotation);
      this.cost = performance.now() - start;
    } catch (error) {
      u.uLakeReflectionReady.value = ready; throw error;
    } finally {
      for (const object of hidden) object.visible = true;
      camera.visible = cameraVisible; reflector.visible = false;
    }
  }

  dispose() {
    this.reflector?.geometry.dispose(); this.reflector?.dispose(); this.reflector = null;
    waterUniforms.uLakeReflectionReady.value = 0; waterUniforms.uLakeReflectionMap.value = null;
  }
}
