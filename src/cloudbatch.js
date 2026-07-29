import * as THREE from 'three';
import { cloudLayerDrawBudget, packedCloudCardOrder } from './cloudbatch.mjs';

const CLOUD_VERTEX = /* glsl */`
attribute float aCloudOpacity;
attribute vec3 aCloudTint;
attribute float aCloudAtlasIndex;
uniform float uAtlasColumns;
varying vec2 vCloudUv;
varying float vCloudOpacity;
varying vec3 vCloudTint;

void main() {
  vCloudUv = vec2(
    (uv.x + aCloudAtlasIndex) / uAtlasColumns,
    uv.y
  );
  vCloudOpacity = aCloudOpacity;
  vCloudTint = aCloudTint;
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`;

const CLOUD_FRAGMENT = /* glsl */`
uniform sampler2D uCloudAtlas;
varying vec2 vCloudUv;
varying float vCloudOpacity;
varying vec3 vCloudTint;

void main() {
  vec4 cloud = texture2D(uCloudAtlas, vCloudUv);
  float alpha = cloud.a * vCloudOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(cloud.rgb * vCloudTint, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function atlasImage(texture) {
  return texture?.image || texture?.source?.data || null;
}

export function makeCloudTextureAtlas(textures, documentRef = globalThis.document) {
  if (!textures?.length) throw new Error('Cloud atlas requires at least one texture');
  if (textures.length === 1) return textures[0];
  if (!documentRef?.createElement) throw new Error('Cloud atlas requires a canvas document');
  const images = textures.map(atlasImage);
  if (images.some((image) => !image)) throw new Error('Cloud atlas texture is missing image data');
  const width = Math.max(...images.map((image) => image.width));
  const height = Math.max(...images.map((image) => image.height));
  const canvas = documentRef.createElement('canvas');
  canvas.width = width * images.length;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  images.forEach((image, index) => {
    context.drawImage(image, index * width, 0, width, height);
  });
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.name = `cloud-atlas-${textures.length}`;
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.generateMipmaps = true;
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.needsUpdate = true;
  return atlas;
}

export function createCloudCard({
  x = 0,
  y = 0,
  z = 0,
  width = 1,
  height = 1,
  atlasIndex = 0,
  opacity = 1,
  color = 0xffffff,
  rotation = 0,
  userData = {},
} = {}) {
  return {
    position: new THREE.Vector3(x, y, z),
    scale: new THREE.Vector3(width, height, 1),
    rotation: new THREE.Euler(0, 0, rotation),
    atlasIndex,
    material: { opacity, color: new THREE.Color(color) },
    visible: opacity > 0,
    userData,
  };
}

export class CloudCardBatch {
  constructor({ texture, atlasColumns = 1, capacity, horizontal = false, name = 'cloud cards' }) {
    this.capacity = capacity;
    this.horizontal = horizontal;
    const geometry = new THREE.PlaneGeometry(1, 1);
    // PlaneGeometry faces +Z. Turn horizontal cards so their front normal aims
    // downward at the player, allowing FrontSide instead of DoubleSide.
    if (horizontal) geometry.rotateX(Math.PI / 2);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.atlasIndex = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute('aCloudOpacity', this.opacity);
    geometry.setAttribute('aCloudTint', this.tint);
    geometry.setAttribute('aCloudAtlasIndex', this.atlasIndex);

    const material = new THREE.ShaderMaterial({
      name: `${name} single-pass material`,
      uniforms: {
        uCloudAtlas: { value: texture },
        uAtlasColumns: { value: atlasColumns },
      },
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
    });
    // Explicitly retain one render pass if Three's transparent-side policy
    // changes; FrontSide already avoids the normal two-pass DoubleSide path.
    material.forceSinglePass = true;

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this._object = new THREE.Object3D();
  }

  sync(cards, sortOrigin = null) {
    const visible = packedCloudCardOrder(cards, sortOrigin);

    const object = this._object;
    const count = Math.min(visible.length, this.capacity);
    for (let index = 0; index < count; index++) {
      const card = visible[index];
      object.position.copy(card.position);
      object.scale.copy(card.scale);
      if (this.horizontal) object.rotation.set(0, card.rotation.z, 0);
      else object.rotation.set(0, card.rotation.y, 0);
      object.updateMatrix();
      this.mesh.setMatrixAt(index, object.matrix);
      this.opacity.setX(index, card.material.opacity);
      this.tint.setXYZ(index, card.material.color.r, card.material.color.g, card.material.color.b);
      this.atlasIndex.setX(index, card.atlasIndex || 0);
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = count > 0;
    this.opacity.needsUpdate = count > 0;
    this.tint.needsUpdate = count > 0;
    this.atlasIndex.needsUpdate = count > 0;
    return count;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.uniforms.uCloudAtlas.value?.dispose?.();
    this.mesh.material.dispose();
  }
}

export function activeCloudBatchDrawCalls(batches) {
  return cloudLayerDrawBudget(batches.map((batch) => batch.mesh.visible ? batch.mesh.count : 0));
}
