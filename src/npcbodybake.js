// One skinned draw per NPC body.
//
// An avatar is authored as ~40 primitives hung off its bones (head, hands,
// boots, hair, hat, wardrobe, accessories) plus two skinned garments. Drawn as
// authored that is ~22 visible draw calls a resident, repeated in every pass
// that sees them (main, ambient-occlusion prepass, sun shadow, lake
// reflection) and the garments were never frustum culled at all.
//
// The authoring stays exactly as it is. Once a body is assembled in its bind
// pose, every primitive is rigidly bound to the bone it hangs from and merged,
// with the two garments and their blended weights, into one SkinnedMesh that
// draws the whole body. Colour, roughness and metalness move from the
// per-colour material onto the vertices, so every resident in the world
// shares a single program and a single material.

import * as THREE from 'three';
import { enableVillageActorLighting } from './villagelighting.mjs';

/**
 * The one material every baked NPC body draws with. Identical to the
 * per-colour MeshStandardMaterials it replaces (flat shading, no maps) except
 * that diffuse colour comes from vertex colours and roughness/metalness from
 * a per-vertex `npcSurface` attribute.
 */
export function createNpcBodyMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true, roughness: 1, metalness: 0,
  });
  material.name = 'npc-body';
  enableVillageActorLighting(material);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 npcSurface;\nvarying vec2 vNpcSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvNpcSurface = npcSurface;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNpcSurface;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vNpcSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vNpcSurface.y;');
  };
  material.customProgramCacheKey = () => 'npc-body-v1';
  return material;
}

const _normalMatrix = new THREE.Matrix3();

/**
 * Bake `parts` into one SkinnedMesh bound to `skeleton`.
 *
 * Each part is either a rigid Mesh hung (at any depth) under one of the
 * skeleton's bones, or a SkinnedMesh already authored in the root's bind
 * space whose own skeleton uses a subset of these bones. Everything must be
 * in its bind pose with the avatar root at identity.
 *
 * Written straight into preallocated arrays (no per-part clones or merge):
 * residents are built while the player walks, so this runs in a frame.
 */
export function bakeSkinnedParts(parts, skeleton, material, name) {
  const boneIndex = new Map(skeleton.bones.map((bone, i) => [bone, i]));
  let total = 0;
  for (const part of parts) {
    const g = part.geometry;
    total += g.index ? g.index.count : g.attributes.position.count;
  }
  if (!total) return null;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const surface = new Float32Array(total * 2);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  let o = 0;
  for (const part of parts) {
    const g = part.geometry;
    const index = g.index?.array;
    const count = index ? index.length : g.attributes.position.count;
    const pos = g.attributes.position.array, nor = g.attributes.normal.array;
    const c = part.material.color, roughness = part.material.roughness, metalness = part.material.metalness;
    let m = null, n = null, bone = 0, remap = null, si = null, sw = null;
    if (part.isSkinnedMesh) {
      // Garments are already authored in the root's bind space.
      remap = part.skeleton.bones.map((b) => boneIndex.get(b) ?? 0);
      si = g.attributes.skinIndex; sw = g.attributes.skinWeight;
    } else {
      let owner = part.parent;
      while (owner && !boneIndex.has(owner)) owner = owner.parent;
      if (!owner) throw new Error(`NPC part "${part.name}" is not under a skeleton bone`);
      bone = boneIndex.get(owner);
      // Root-local bind transform: the avatar root is at identity while baking.
      m = part.matrixWorld.elements;
      n = _normalMatrix.getNormalMatrix(part.matrixWorld).elements;
    }
    for (let k = 0; k < count; k++, o++) {
      const v = index ? index[k] : k;
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const nx = nor[v * 3], ny = nor[v * 3 + 1], nz = nor[v * 3 + 2];
      if (m) {
        position[o * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        position[o * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        position[o * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        const tx = n[0] * nx + n[3] * ny + n[6] * nz;
        const ty = n[1] * nx + n[4] * ny + n[7] * nz;
        const tz = n[2] * nx + n[5] * ny + n[8] * nz;
        const len = Math.hypot(tx, ty, tz) || 1;
        normal[o * 3] = tx / len; normal[o * 3 + 1] = ty / len; normal[o * 3 + 2] = tz / len;
        skinIndex[o * 4] = bone;
        skinWeight[o * 4] = 1;
      } else {
        position[o * 3] = x; position[o * 3 + 1] = y; position[o * 3 + 2] = z;
        normal[o * 3] = nx; normal[o * 3 + 1] = ny; normal[o * 3 + 2] = nz;
        for (let j = 0; j < 4; j++) {
          skinIndex[o * 4 + j] = remap[si.getComponent(v, j)] ?? 0;
          skinWeight[o * 4 + j] = sw.getComponent(v, j);
        }
      }
      color[o * 3] = c.r; color[o * 3 + 1] = c.g; color[o * 3 + 2] = c.b;
      surface[o * 2] = roughness; surface[o * 2 + 1] = metalness;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('npcSurface', new THREE.BufferAttribute(surface, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  // Bind with an identity bind matrix: the geometry is authored in the root's
  // space and the mesh sits at the root's origin. Passing it explicitly keeps
  // the skeleton's inverses exactly as computed in the bind pose.
  mesh.bind(skeleton, new THREE.Matrix4());
  return mesh;
}

/**
 * A never-drawn body that carries the shared NPC program into the loading
 * screen's shader prewarm (main.js). Residents usually first appear after
 * play begins, when compiling the program cost a ~300 ms frame.
 */
export function createNpcBodyPrewarmMesh(material = createNpcBodyMaterial()) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  geometry.setAttribute('npcSurface', new THREE.Float32BufferAttribute([0.9, 0, 0.9, 0, 0.9, 0], 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const bone = new THREE.Bone();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'npc-body-prewarm';
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]), new THREE.Matrix4());
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}
