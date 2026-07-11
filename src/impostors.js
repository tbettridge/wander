// Tree LOD impostors. At startup each tall-tree archetype is rendered once,
// from the side, into a texture (render-to-texture). Distant trees are then
// drawn as cheap cross-quad billboards (two perpendicular textured planes) at
// the exact positions the full trees would occupy — so forests extend toward
// the fog line and the full→impostor swap is invisible at range.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IMPOSTOR_TYPES } from './vegdata.js';
import { injectHueJitter } from './vegetation.js';

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
    matByType[type] = mat;
    materials.push(mat);
  }

  return {
    // buckets: [{ type, matrices: Float32Array(count*16) }]
    buildGroup(buckets) {
      const group = new THREE.Group();
      for (const b of buckets) {
        const geo = geoByType[b.type];
        if (!geo) continue;
        const count = b.matrices.length / 16;
        const mesh = new THREE.InstancedMesh(geo, matByType[b.type], count);
        mesh.instanceMatrix = new THREE.InstancedBufferAttribute(b.matrices, 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      return group;
    },

    // Match the day/night cycle: billboards darken at night like lit geometry.
    update(day) {
      const b = NIGHT_BRIGHTNESS + (1 - NIGHT_BRIGHTNESS) * day;
      for (const m of materials) m.color.setScalar(b);
    },
  };
}
