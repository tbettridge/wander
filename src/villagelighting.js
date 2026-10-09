// Procedural static bake + a fixed native PointLight pool. Static illumination
// never changes when a slot is borrowed by a nearby moving character.
import * as THREE from 'three';
import {
  VILLAGE_LIGHTING, createVillageLightField, createVillageLightPool,
  stepVillageLightPool, villageGroundBounds, villageLightShaderChunk,
  villageLightingNight, villageNightLevel, segmentHitsVillageBuilding, villageDirectLightShaderChunk,
} from './villagelighting.mjs';

const warm = new THREE.Color(VILLAGE_LIGHTING.warmColor);
const groundCaches = new WeakMap();

function* groundBake(field, world) {
  const bounds = villageGroundBounds(field.lights);
  if (!bounds) return null;
  const { minX, minZ, width, depth, size } = bounds;
  const nx = Math.ceil(width / 2), nz = Math.ceil(depth / 2), row = nx + 1;
  const positions = new Float32Array(row * (nz + 1) * 3), uvs = new Float32Array(row * (nz + 1) * 2);
  const heights = new Float32Array(row * (nz + 1));
  for (let z = 0; z <= nz; z++) {
    for (let x = 0; x <= nx; x++) {
      const i = z * row + x, wx = minX + x / nx * width, wz = minZ + z / nz * depth;
      const y = world.height(wx, wz);
      heights[i] = y;
      positions.set([wx, y + 0.065, wz], i * 3); uvs.set([x / nx, z / nz], i * 2);
    }
    yield;
  }
  const data = new Uint8Array(size * size * 4), point = {}, normal = {};
  let litPixels = 0;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (z + 0.5) / size;
      const gx = u * nx, gz = v * nz, ix = Math.min(nx - 1, Math.floor(gx)), iz = Math.min(nz - 1, Math.floor(gz));
      const tx = gx - ix, tz = gz - iz, a = iz * row + ix;
      const h00 = heights[a], h10 = heights[a + 1], h01 = heights[a + row], h11 = heights[a + row + 1];
      point.x = minX + u * width; point.z = minZ + v * depth;
      point.y = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
      const sx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) * nx / width;
      const sz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) * nz / depth;
      const length = Math.hypot(sx, 1, sz);
      normal.x = -sx / length; normal.y = 1 / length; normal.z = -sz / length;
      const alpha = point.y < 0 ? 0 : Math.round(Math.min(1, field.sample(point, normal)) * 255);
      const offset = (z * size + x) * 4;
      data.set([255, 255, 255, alpha], offset);
      if (alpha) litPixels++;
    }
    yield;
  }
  const alphaAt = (u, v) => data[(Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size))) * 4 + 3];
  const indices = [];
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      // Empty portions of the atlas have no triangles and incur no overdraw.
      if (![alphaAt(x / nx, z / nz), alphaAt((x + 1) / nx, z / nz),
        alphaAt(x / nx, (z + 1) / nz), alphaAt((x + 1) / nx, (z + 1) / nz),
        alphaAt((x + 0.5) / nx, (z + 0.5) / nz)].some(Boolean)) continue;
      const a = z * row + x;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
    yield;
  }
  return { bounds, positions, uvs, indices: new Uint32Array(indices), data, litPixels };
}

function createGroundGlow(bake) {
  if (!bake?.indices.length) return null;
  const { size } = bake.bounds;
  const texture = new THREE.DataTexture(bake.data, size, size);
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(bake.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(bake.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(bake.indices, 1));
  // Post-processing normal/depth passes also see this mesh.
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({
    name: 'village-baked-ground-glow', color: warm.clone().multiplyScalar(0.38), map: texture,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.uVillageNight = villageLightingNight;
    shader.fragmentShader = 'uniform float uVillageNight;\n' + shader.fragmentShader.replace(
      '#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= uVillageNight;',
    );
  };
  material.customProgramCacheKey = () => 'village-ground-bake-v1';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'village-baked-ground-glow'; mesh.renderOrder = 3;
  return mesh;
}

function bakeMaterial(original) {
  const material = original.clone(), compile = original.onBeforeCompile;
  const originalKey = original.customProgramCacheKey();
  material.name = `${original.name || 'village-surface'}:baked-lantern-light`;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(original, shader, renderer);
    shader.uniforms.uVillageNight = villageLightingNight;
    shader.uniforms.uVillageWarm = { value: warm };
    shader.vertexShader = 'attribute float aVillageIrradiance;\nvarying float vVillageIrradiance;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\nvVillageIrradiance = aVillageIrradiance;',
    );
    shader.fragmentShader = 'varying float vVillageIrradiance;\nuniform float uVillageNight;\nuniform vec3 uVillageWarm;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += diffuseColor.rgb * uVillageWarm * vVillageIrradiance * uVillageNight;`,
    );
  };
  material.customProgramCacheKey = () => `${originalKey}:village-vertex-bake-v1`;
  return material;
}

function* bakeMesh(mesh, field, budget) {
  const old = mesh.geometry, names = ['position', 'normal', ...Object.keys(old.attributes).filter(n => n !== 'position' && n !== 'normal')];
  if (!old.attributes.normal || names.some(n => old.attributes[n].isInterleavedBufferAttribute)) return 0;
  const sizes = names.map(n => old.attributes[n].itemSize), outputs = names.map(() => []), glow = [];
  const offsets = [], stride = sizes.reduce((n, size) => { offsets.push(n); return n + size; }, 0);
  const vertex = index => names.flatMap(name => Array.from(old.attributes[name].array.slice(index * old.attributes[name].itemSize, (index + 1) * old.attributes[name].itemSize)));
  const worldPosition = v => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(mesh.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), p = new THREE.Vector3(), n = new THREE.Vector3();
  const count = old.index?.count ?? old.attributes.position.count;
  let sinceYield = 0;
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map(k => vertex(old.index ? old.index.getX(i + k) : i + k));
    const world = triangle.map(worldPosition);
    const min = new THREE.Vector3().copy(world[0]).min(world[1]).min(world[2]);
    const max = new THREE.Vector3().copy(world[0]).max(world[1]).max(world[2]);
    const nearby = field.lights.some(light => {
      const dx = Math.max(min.x - light.x, 0, light.x - max.x), dy = Math.max(min.y - light.y, 0, light.y - max.y), dz = Math.max(min.z - light.z, 0, light.z - max.z);
      return dx * dx + dy * dy + dz * dz < VILLAGE_LIGHTING.range ** 2;
    });
    const stack = [{ triangle, depth: 0 }];
    while (stack.length) {
      const { triangle: t, depth } = stack.pop();
      const edge = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      const lengths = [edge(t[0], t[1]), edge(t[1], t[2]), edge(t[2], t[0])];
      const longest = lengths.indexOf(Math.max(...lengths));
      if (nearby && lengths[longest] > 2.2 ** 2 && depth < 9 && budget.remaining > 0) {
        const a = longest, b = (longest + 1) % 3, c = (longest + 2) % 3;
        const mid = t[a].map((value, k) => (value + t[b][k]) * 0.5);
        stack.push({ triangle: [t[a], mid, t[c]], depth: depth + 1 }, { triangle: [mid, t[b], t[c]], depth: depth + 1 });
        budget.remaining -= 3;
        continue;
      }
      for (const v of t) {
        for (let k = 0; k < names.length; k++) for (let j = 0; j < sizes[k]; j++) outputs[k].push(v[offsets[k] + j]);
        p.set(v[0], v[1], v[2]).applyMatrix4(mesh.matrixWorld);
        n.set(v[3], v[4], v[5]).applyNormalMatrix(normalMatrix);
        glow.push(nearby ? field.sample(p, n) : 0);
      }
      if (++sinceYield >= 128) { sinceYield = 0; yield; }
    }
  }
  const geometry = new THREE.BufferGeometry();
  names.forEach((name, k) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(outputs[k], sizes[k])));
  geometry.setAttribute('aVillageIrradiance', new THREE.Float32BufferAttribute(glow, 1));
  geometry.computeBoundingSphere();
  mesh.geometry = geometry; old.dispose();
  return glow.filter(v => v > 0.001).length;
}

export function* bakeVillageLighting(group, plan, world, sources) {
  const field = createVillageLightField(sources.map((s, i) => ({ ...s, id: `${plan.site.id}:lantern:${i}` })), plan.buildings);
  const materials = new Map(), debug = { sources: sources.length, bakedVertices: 0, textureBytes: 0, groundTriangles: 0, cacheHit: false };
  if (!sources.length) return { field, ground: null, debug, dispose() {} };
  let cache = groundCaches.get(world);
  if (!cache) { cache = new Map(); groundCaches.set(world, cache); }
  let bake = cache.get(plan.district);
  if (bake) { debug.cacheHit = true; cache.delete(plan.district); }
  else bake = yield* groundBake(field, world);
  cache.set(plan.district, bake);
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  const ground = createGroundGlow(bake);
  if (ground) {
    group.add(ground); debug.textureBytes = bake.data.byteLength; debug.groundTriangles = bake.indices.length / 3;
  }
  group.updateMatrixWorld(true);
  const meshes = [];
  group.traverse(mesh => {
    if (!mesh.isMesh || mesh.isInstancedMesh || !mesh.castShadow || Array.isArray(mesh.material)) return;
    if (!mesh.material.isMeshStandardMaterial && !mesh.material.isMeshLambertMaterial) return;
    // Swinging door leaves stay dynamic; district-detail contains static props.
    for (let p = mesh.parent; p && p !== group; p = p.parent) {
      if (p.userData.dynamicStructure && !p.name.endsWith(':district-detail')) return;
    }
    meshes.push(mesh);
  });
  const budget = { remaining: 120000 };
  for (const mesh of meshes) {
    const baked = yield* bakeMesh(mesh, field, budget);
    if (!mesh.geometry.attributes.aVillageIrradiance) continue;
    debug.bakedVertices += baked;
    if (!materials.has(mesh.material)) materials.set(mesh.material, bakeMaterial(mesh.material));
    mesh.material = materials.get(mesh.material);
    yield;
  }
  return { field, ground, debug, dispose() {
    ground?.material.map.dispose(); ground?.material.dispose();
    for (const material of materials.values()) material.dispose();
  } };
}

export class VillageLightingSystem {
  constructor(scene) {
    THREE.ShaderChunk.lights_pars_begin = villageLightShaderChunk(THREE.ShaderChunk.lights_pars_begin);
    THREE.ShaderChunk.lights_fragment_begin = villageDirectLightShaderChunk(THREE.ShaderChunk.lights_fragment_begin);
    this.enabled = true;
    this.villages = new Map(); this.pool = createVillageLightPool();
    this.lights = this.pool.map((slot, index) => {
      const light = new THREE.PointLight(VILLAGE_LIGHTING.warmColor, 0, VILLAGE_LIGHTING.range, 2);
      light.name = `Village character light ${index + 1}`; light.castShadow = false;
      scene.add(light); return light;
    });
    this.frustum = new THREE.Frustum(); this.viewProjection = new THREE.Matrix4(); this.sphere = new THREE.Sphere();
    this.debug = { slots: this.lights.length, budget: 6, active: 0, selected: 0, sources: 0, bakedVertices: 0, textureBytes: 0 };
  }
  register(id, group, detail, bake) {
    this.villages.set(id, { group, detail, bake });
    return () => { this.villages.delete(id); bake.dispose(); };
  }
  update(dt, viewer, { night = 0, xr = false, enabled = true, actors = [], camera = null } = {}) {
    enabled = enabled && this.enabled;
    const level = villageNightLevel(night);
    villageLightingNight.value = enabled ? level : 0;
    const sources = [], receivers = [{ x: viewer.x, y: viewer.y + 1.2, z: viewer.z, player: true }];
    let vertices = 0, bytes = 0, registeredSources = 0;
    for (const { group, detail, bake } of this.villages.values()) {
      if (bake.ground) bake.ground.visible = enabled && level > 0.001;
      vertices += bake.debug.bakedVertices; bytes += bake.debug.textureBytes; registeredSources += bake.field.lights.length;
      if (group.visible && detail.visible) sources.push(...bake.field.lights);
    }
    if (camera) {
      camera.updateWorldMatrix(true, false);
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProjection);
    }
    const seen = new Set();
    for (const actor of enabled && level > 0.001 ? actors : []) {
      const root = actor.avatar?.root || actor.root || actor.mesh;
      if (!root?.parent || typeof root.getWorldPosition !== 'function' || seen.has(root)) continue;
      seen.add(root);
      let visible = true;
      for (let p = root; p; p = p.parent) if (!p.visible) { visible = false; break; }
      if (!visible) continue;
      root.getWorldPosition(this.sphere.center); this.sphere.center.y += 1; this.sphere.radius = 2;
      if (this.sphere.center.distanceToSquared(viewer) > VILLAGE_LIGHTING.viewReach ** 2) continue;
      if (camera && !this.frustum.intersectsSphere(this.sphere)) continue;
      receivers.push({ x: this.sphere.center.x, y: this.sphere.center.y, z: this.sphere.center.z });
    }
    const state = stepVillageLightPool(this.pool, sources, receivers, viewer, level, dt, {
      xr, enabled, blocked: (source, point) => source.blockers.some(box => segmentHitsVillageBuilding(source, point, box)),
    });
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i], light = this.lights[i];
      light.intensity = slot.level * VILLAGE_LIGHTING.intensity;
      if (slot.source) light.position.set(slot.source.x, slot.source.y, slot.source.z);
    }
    Object.assign(this.debug, state, { sources: registeredSources, bakedVertices: vertices, textureBytes: bytes, receivers: receivers.length, night: level });
    return this.debug;
  }
  dispose() {
    for (const { bake } of this.villages.values()) bake.dispose();
    this.villages.clear(); this.lights.forEach(light => light.removeFromParent());
  }
}
