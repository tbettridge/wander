// Tree LOD impostors. At startup each tall-tree archetype is rendered once,
// from the side, into a texture (render-to-texture). Distant trees are then
// drawn as cheap cross-quad billboards (two perpendicular textured planes) at
// the exact positions the full trees would occupy — so forests extend toward
// the fog line and the full→impostor swap is invisible at range.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IMPOSTOR_TYPES } from './vegdata.js';
import { injectHueJitter, injectCaveSink } from './vegetation.js?v=4';
import { injectAtmosphere } from './atmosphere.js';

const TEX_H = 256;          // texture height in px (width follows tree aspect)
const NIGHT_BRIGHTNESS = 0.12;

// Render one archetype's representative geometry into an sRGB texture with
// transparent background, framed tightly to its bounding box.
function renderImpostorTexture(renderer, entry) {
  const geo = entry.geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const halfW = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x),
                         Math.abs(bb.min.z), Math.abs(bb.max.z)) * 1.04;
  const y0 = bb.min.y, y1 = bb.max.y, h = y1 - y0, yc = (y0 + y1) / 2;
  const texW = Math.max(16, Math.round(TEX_H * (2 * halfW) / h));

  const rt = new THREE.WebGLRenderTarget(texW, TEX_H, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    colorSpace: THREE.SRGBColorSpace,
  });

  const scene = new THREE.Scene();
  // InstancedMesh(1) so the foliage sway shaders (which read instanceMatrix)
  // compile; identity transform, uTime is 0 at startup so there is no sway.
  const mesh = new THREE.InstancedMesh(geo, entry.mats.length === 1 ? entry.mats[0] : entry.mats, 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-0.5, 1.1, 0.7);
  scene.add(key);

  const cam = new THREE.OrthographicCamera(-halfW, halfW, h / 2, -h / 2, 0.1, 1000);
  cam.position.set(0, yc, 200);
  cam.lookAt(0, yc, 0);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);

  return { texture: rt.texture, halfW, y0, y1 };
}

// Cross of `blades` vertical quads, sized to the tree's real footprint/height,
// UVs spanning the impostor texture (v=0 at the base).
function crossQuadGeometry(halfW, y0, y1, blades) {
  const geos = [];
  const SKIRT = 6.0; // metres the billboard trunk extends below the foot
  for (let i = 0; i < blades; i++) {
    // main quad: the tree, textured normally (v=0 at the foot y0, v=1 at y1)
    const g = new THREE.PlaneGeometry(2 * halfW, y1 - y0);
    g.translate(0, (y0 + y1) / 2, 0);
    // root skirt: a short quad BELOW the foot whose UVs are pinned to v=0, so it
    // keeps sampling the texture's bottom row (trunk pixels + transparency)
    // rather than stretching the whole tree. A distant tree whose feet land a
    // metre or two above the coarse far-terrain then buries its trunk INTO the
    // hill instead of hovering; a tree sitting flush just has the extra trunk
    // underground (invisible). Scales with the instance.
    const sk = new THREE.PlaneGeometry(2 * halfW, SKIRT);
    sk.translate(0, y0 - SKIRT / 2, 0);
    const suv = sk.attributes.uv;
    for (let k = 0; k < suv.count; k++) suv.setY(k, 0);
    const blade = mergeGeometries([g, sk]);
    blade.rotateY((i / blades) * Math.PI);
    geos.push(blade);
  }
  return mergeGeometries(geos);
}

export function createImpostorSystem(renderer, library) {
  const geoByType = {};
  const matByType = {};
  const materials = [];

  for (const type of IMPOSTOR_TYPES) {
    const variants = library[type];
    if (!variants || !variants.length) continue;
    const { texture, halfW, y0, y1 } = renderImpostorTexture(renderer, variants[0]);
    // broad deciduous crowns read fuller with 3 blades; conifers/palms/columnar are fine with 2
    const blades = ['broadleaf', 'oak', 'willow', 'blossom'].includes(type) ? 3 : 2;
    geoByType[type] = crossQuadGeometry(halfW, y0, y1, blades);
    const mat = new THREE.MeshBasicMaterial({
      map: texture, alphaTest: 0.5, side: THREE.DoubleSide,
      transparent: false, toneMapped: false, fog: true,
    });
    // same per-instance hue/autumn variety as the full trees — the hash keys
    // off instance position, so each billboard matches ITS full-geometry tree.
    // (blossom stays out of the autumn turn: pink crowns aren't deciduous-green)
    injectHueJitter(mat, { autumn: ['broadleaf', 'oak', 'birch'].includes(type) });
    injectCaveSink(mat);   // distant trees also drop out over a carved cave mouth
    // The baked texture supplies the tree's local shading; the shared cached
    // cloud field and aerial perspective keep the billboard in the same moving
    // light and haze as the full-geometry tree it replaces.
    injectAtmosphere(mat, { clouds: true, aerial: true });
    matByType[type] = mat;
    materials.push(mat);
  }

  // ── one InstancedMesh per TYPE, shared by every chunk ──────────────────────
  //
  // Impostors are the most draw-call-dense thing in the frame and the least
  // triangle-dense: measured at 373 draw calls (19% of the frame's calls) for
  // 0.03M triangles (0.5%). That ratio came from giving each chunk its own
  // InstancedMesh per type — ~4.4 meshes across ~360 streamed chunks — because
  // every archetype bakes its own texture and therefore needs its own material.
  //
  // The materials genuinely cannot merge without a texture atlas, but the
  // CHUNKS can: the worker emits world-space matrices and the groups were added
  // straight to the scene with no parent transform, so instances from every
  // chunk can live in one pool per type. Types stay separate (~9 draws); chunks
  // stop multiplying them.
  //
  // The trade is per-chunk frustum culling: one world-spanning pool is always
  // submitted whole. At ~10 triangles per billboard that is ~130k triangles
  // instead of the ~30k that survived culling — 1.6% more triangles to remove
  // 19% of the frame's draw calls, which is the right way round for a frame
  // this call-bound.
  const root = new THREE.Group();
  root.name = 'impostor-pools';

  const pools = new Map();      // type -> { mesh, matrices, total, blocks }
  const chunkTypes = new Map(); // chunkId -> Set(type)

  function poolFor(type) {
    let p = pools.get(type);
    if (p) return p;
    const capacity = 2048;
    const matrices = new Float32Array(capacity * 16);
    const mesh = new THREE.InstancedMesh(geoByType[type], matByType[type], capacity);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The pool spans the streamed world, so a bounding-sphere test against it
    // is always true and only costs time. Three would also recompute it from
    // stale instance data on every write.
    mesh.frustumCulled = false;
    mesh.name = `impostor-pool/${type}`;
    root.add(mesh);
    p = { mesh, matrices, total: 0, blocks: [] };
    pools.set(type, p);
    return p;
  }

  // Grow by doubling. Chunks stream continuously, so a pool that reallocated
  // per chunk would churn; doubling makes reallocation vanishingly rare.
  function ensure(p, extra) {
    const needed = p.total + extra;
    let capacity = p.matrices.length / 16;
    if (needed <= capacity) return;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity * 16);
    grown.set(p.matrices.subarray(0, p.total * 16));
    p.matrices = grown;
    p.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(grown, 16);
    p.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  function markRange(attribute, offset, count) {
    // Upload only what moved. A full re-upload of a grown pool is ~0.8MB and
    // would happen on every chunk arrival, which costs more than the draw calls
    // this whole change is saving.
    if (typeof attribute.addUpdateRange === 'function') {
      attribute.addUpdateRange(offset * 16, count * 16);
    }
    attribute.needsUpdate = true;
  }

  return {
    root,

    // buckets: [{ type, matrices: Float32Array(count*16) }] — world space
    addChunk(chunkId, buckets) {
      if (chunkTypes.has(chunkId)) this.removeChunk(chunkId);
      const types = new Set();
      for (const b of buckets) {
        if (!geoByType[b.type]) continue;
        const count = b.matrices.length / 16;
        if (!count) continue;
        const p = poolFor(b.type);
        ensure(p, count);
        p.matrices.set(b.matrices, p.total * 16);
        p.blocks.push({ chunkId, offset: p.total, count });
        markRange(p.mesh.instanceMatrix, p.total, count);
        p.total += count;
        p.mesh.count = p.total;
        types.add(b.type);
      }
      if (types.size) chunkTypes.set(chunkId, types);
    },

    removeChunk(chunkId) {
      const types = chunkTypes.get(chunkId);
      if (!types) return;
      for (const type of types) {
        const p = pools.get(type);
        if (!p) continue;
        const i = p.blocks.findIndex((b) => b.chunkId === chunkId);
        if (i < 0) continue;
        const block = p.blocks[i];
        const tailStart = block.offset + block.count;
        const tailCount = p.total - tailStart;
        if (tailCount > 0) {
          // Close the hole by sliding the tail down, then fix the offsets of
          // the blocks that moved. Keeping the pool contiguous is what lets
          // mesh.count alone bound the draw.
          p.matrices.copyWithin(block.offset * 16, tailStart * 16, p.total * 16);
          for (let j = i + 1; j < p.blocks.length; j++) p.blocks[j].offset -= block.count;
          markRange(p.mesh.instanceMatrix, block.offset, tailCount);
        }
        p.blocks.splice(i, 1);
        p.total -= block.count;
        p.mesh.count = p.total;
      }
      chunkTypes.delete(chunkId);
    },

    // Match the day/night cycle: billboards darken at night like lit geometry.
    update(day) {
      const b = NIGHT_BRIGHTNESS + (1 - NIGHT_BRIGHTNESS) * day;
      for (const m of materials) m.color.setScalar(b);
    },

    get debug() {
      const perType = [...pools.entries()].map(([t, p]) => ({
        type: t, instances: p.total, chunks: p.blocks.length,
        capacity: p.matrices.length / 16,
      }));
      return { draws: pools.size, chunks: chunkTypes.size, perType };
    },
  };
}
