import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { waterUniforms } from './watercommon.js';
import { lakeReflectionTargets, nearestLakeReflection } from './waterreflectiontargets.mjs';

// One nearby lake gets a small planar capture. The source surface remains the
// shared clipped mesh; the helper plane is never added to the scene.
export class LakeReflection {
  constructor() {
    this.targets = []; this.planHash = null; this.elapsed = 1;
    this.position = new THREE.Vector3(); this.rotation = new THREE.Quaternion();
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastRotation = new THREE.Quaternion(); this.inverse = new THREE.Matrix4();
    this.captureCamera = new THREE.PerspectiveCamera();
    this.cost = 0; this.activeId = null;
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
    if (this.activeId === target.id && this.elapsed < (moved ? 1 / 30 : 1 / 12)) return;
    this.reflector ||= new Reflector(new THREE.PlaneGeometry(1, 1), {
      textureWidth: 384, textureHeight: 384, clipBias: 0.001, multisample: 0,
    });
    const reflector = this.reflector;
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set((target.minX + target.maxX) / 2, target.level, (target.minZ + target.maxZ) / 2);
    reflector.updateMatrixWorld(true);
    const capture = this.captureCamera;
    capture.copy(camera, false); capture.position.copy(this.position); capture.quaternion.copy(this.rotation);
    capture.far = Math.min(camera.far, 450); capture.updateProjectionMatrix(); capture.updateMatrixWorld(true);
    const hidden = [], cameraVisible = camera.visible;
    scene.traverseVisible(object => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(m => m?.userData?.waterSurface)) hidden.push(object);
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
