// Distant terrain: a regular radial surface carries the walkable world to 3 km,
// then three concentric ridge ribbons carry its real height silhouette to
// 7.5 km. The ribbons deliberately trade radial topology and WANDER's full
// terrain shader for painted vertical contours with simple lighting and fog.
// Rebuilds remain incremental and only begin after ~450 m of travel.

import * as THREE from 'three';
import { groundColor, groundMacroPatch } from './world.js';
import { terrainMaterial } from './terrain.js?v=5';
import {
  FAR_REBUILD_DIST,
  FAR_RIBBON_ANGULAR,
  FAR_RIBBON_RADII,
  FAR_SURFACE_ANGULAR,
  FAR_SURFACE_RINGS,
  fillSurfaceRadii,
} from './farterrainplan.mjs';

const RINGS_PER_FRAME = 6;

// Unlike terrainMaterial this has no physical ground-detail work, tide band,
// cached/analytical cloud shadow, biome branching, or custom aerial loop.
// MeshLambertMaterial supplies one inexpensive diffuse response; built-in fog
// supplies the live atmospheric colour shared with the sky.
const ridgeMaterial = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  vertexColors: true,
  fog: true,
  dithering: true,
  // The player remains inside every 3 km+ cylinder between recenter events;
  // rendering only inward-facing sides avoids drawing each horizon twice.
  side: THREE.BackSide,
});
ridgeMaterial.name = 'painted-horizon-ribbons';

const RIDGE_LOW = [0.27, 0.34, 0.29];
const RIDGE_ROCK = [0.38, 0.39, 0.41];
const RIDGE_SNOW = [0.74, 0.77, 0.81];
const RIDGE_HAZE = [0.43, 0.51, 0.62];

export class FarTerrain {
  constructor(scene, world) {
    this.world = world;
    this.nearField = 800;     // extent of streamed chunks (set by quality tier)
    this.cx = 0;
    this.cz = 0;
    this.buildRing = -1;      // -1 = idle
    this.buildRibbon = -1;
    this.needsRebuild = true;

    // The full terrain material ends at the first painted ribbon.
    this.radii = new Float32Array(FAR_SURFACE_RINGS);
    this._computeRadii();

    const count = FAR_SURFACE_RINGS * FAR_SURFACE_ANGULAR;
    this.scratchPos = new Float32Array(count * 3);
    this.scratchNor = new Float32Array(count * 3);
    this.scratchCol = new Float32Array(count * 3);
    this.scratchMacro = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aGroundMacro', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('aXRShade', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    geo.setIndex(makeStripIndices(FAR_SURFACE_RINGS, FAR_SURFACE_ANGULAR));

    this.mesh = new THREE.Mesh(geo, terrainMaterial);
    this.mesh.name = 'far-terrain-surface';
    prepareFarMesh(this.mesh);
    scene.add(this.mesh);

    this.ribbonScratch = [];
    this.ribbonMeshes = [];
    for (let band = 0; band < FAR_RIBBON_RADII.length; band++) {
      const ribbonCount = FAR_RIBBON_ANGULAR * 2;
      const ribbonGeo = new THREE.BufferGeometry();
      const positions = new Float32Array(ribbonCount * 3);
      const colors = new Float32Array(ribbonCount * 3);
      ribbonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ribbonCount * 3), 3));
      ribbonGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(ribbonCount * 3), 3));
      ribbonGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ribbonCount * 3), 3));
      ribbonGeo.setIndex(makeStripIndices(2, FAR_RIBBON_ANGULAR));

      const mesh = new THREE.Mesh(ribbonGeo, ridgeMaterial);
      mesh.name = `far-terrain-ribbon-${band + 1}`;
      mesh.renderOrder = band + 1;
      prepareFarMesh(mesh);
      scene.add(mesh);

      this.ribbonScratch.push({ positions, colors });
      this.ribbonMeshes.push(mesh);
    }

    this._rgb = [0, 0, 0];
  }

  // Exponential rings start inside the streamed-chunk edge and finish exactly
  // at 3 km, sharing their last boundary with the first lightweight ribbon.
  _computeRadii() {
    fillSurfaceRadii(this.nearField, this.radii);
  }

  setNearField(d) {
    if (d !== this.nearField) {
      this.nearField = d;
      this._computeRadii();
      this.needsRebuild = true;
    }
  }

  setSurfaceMaterial(material = terrainMaterial) {
    this.mesh.material = material || terrainMaterial;
  }

  update(px, pz) {
    if (this.buildRing >= 0) {
      this.buildStep();
      return;
    }
    const dx = px - this.cx, dz = pz - this.cz;
    if (this.needsRebuild || dx * dx + dz * dz > FAR_REBUILD_DIST * FAR_REBUILD_DIST) {
      this.cx = Math.round(px / 50) * 50;
      this.cz = Math.round(pz / 50) * 50;
      this.buildRing = 0;
      this.buildRibbon = 0;
      this.needsRebuild = false;
    }
  }

  buildStep() {
    if (this.buildRing < FAR_SURFACE_RINGS) {
      this._buildSurfaceRings();
      return;
    }

    if (this.buildRibbon < this.ribbonMeshes.length) {
      this._buildRibbon(this.buildRibbon);
      this.buildRibbon++;
      if (this.buildRibbon < this.ribbonMeshes.length) return;
    }

    this._commitBuild();
  }

  _buildSurfaceRings() {
    const world = this.world;
    const end = Math.min(this.buildRing + RINGS_PER_FRAME, FAR_SURFACE_RINGS);
    for (let i = this.buildRing; i < end; i++) {
      const r = this.radii[i];
      const depress = this._depression(r);
      const eps = Math.max(6, r * 0.045); // normal sampling radius matches cell size
      for (let a = 0; a < FAR_SURFACE_ANGULAR; a++) {
        const idx = i * FAR_SURFACE_ANGULAR + a;
        const theta = (a / FAR_SURFACE_ANGULAR) * Math.PI * 2;
        const x = this.cx + Math.cos(theta) * r;
        const z = this.cz + Math.sin(theta) * r;
        const h = world.height(x, z) - depress;
        const hx = world.height(x - eps, z) - world.height(x + eps, z);
        const hz = world.height(x, z - eps) - world.height(x, z + eps);
        const len = Math.hypot(hx, 2 * eps, hz);
        const nx = hx / len, ny = (2 * eps) / len, nz = hz / len;
        const { t, m } = world.climate(x, z, h);
        groundColor(world, x, z, h + depress, 1 - ny, t, m, this._rgb);

        writeVec3(this.scratchPos, idx, x, h, z);
        writeVec3(this.scratchNor, idx, nx, ny, nz);
        writeVec3(this.scratchCol, idx, this._rgb[0], this._rgb[1], this._rgb[2]);
        this.scratchMacro[idx] = groundMacroPatch(world, x, z, t, m);
      }
    }
    this.buildRing = end;
  }

  _buildRibbon(band) {
    const scratch = this.ribbonScratch[band];
    const r = FAR_RIBBON_RADII[band];
    const depress = this._depression(r);
    for (let a = 0; a < FAR_RIBBON_ANGULAR; a++) {
      const theta = (a / FAR_RIBBON_ANGULAR) * Math.PI * 2;
      const x = this.cx + Math.cos(theta) * r;
      const z = this.cz + Math.sin(theta) * r;
      // One honest skyline height per spoke: no climate query, biome classify,
      // material noise, finite-difference normal, or cloud-shadow work.
      const h = this.world.height(x, z) - depress;
      const bottom = Math.min(-90 - band * 35, h - 260 - band * 70);
      writeVec3(scratch.positions, a, x, h, z);
      writeVec3(scratch.positions, FAR_RIBBON_ANGULAR + a, x, bottom, z);
      writeRidgeColor(scratch.colors, a, h + depress, band, 1);
      writeRidgeColor(scratch.colors, FAR_RIBBON_ANGULAR + a, h + depress, band, 0.78);
    }
  }

  _depression(r) {
    // Sink under streamed chunks, then converge to the old 35 cm far-surface
    // offset. The 3 km handoff and all ribbons therefore share exact heights.
    const inner = smooth01((r - this.nearField * 0.55) / (this.nearField * 0.45));
    const outer = smooth01((r - this.nearField) / (this.nearField * 0.7));
    return (1.5 + 8.5 * (1 - inner)) * (1 - outer) + 0.35 * outer;
  }

  _commitBuild() {
    // Atomic swap: the old complete horizon stays visible until every surface
    // ring and silhouette ribbon for the new 450 m cell is ready.
    updateGeometry(this.mesh.geometry, this.scratchPos, this.scratchNor, this.scratchCol, this.scratchMacro);
    this.mesh.visible = true;

    for (let band = 0; band < this.ribbonMeshes.length; band++) {
      const mesh = this.ribbonMeshes[band];
      const scratch = this.ribbonScratch[band];
      const geo = mesh.geometry;
      geo.attributes.position.array.set(scratch.positions);
      geo.attributes.color.array.set(scratch.colors);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      // Broad ridge faces provide stable, low-frequency lighting without four
      // extra height-model samples per vertex.
      geo.computeVertexNormals();
      mesh.visible = true;
    }

    this.buildRing = -1;
    this.buildRibbon = -1;
  }
}

function prepareFarMesh(mesh) {
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.visible = false;
}

function makeStripIndices(rows, angular) {
  const indices = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let a = 0; a < angular; a++) {
      const a1 = (a + 1) % angular;
      const p00 = row * angular + a, p01 = row * angular + a1;
      const p10 = (row + 1) * angular + a, p11 = (row + 1) * angular + a1;
      indices.push(p00, p01, p10, p01, p11, p10);
    }
  }
  return indices;
}

function updateGeometry(geo, positions, normals, colors, macros) {
  geo.attributes.position.array.set(positions);
  geo.attributes.normal.array.set(normals);
  geo.attributes.color.array.set(colors);
  geo.attributes.aGroundMacro.array.set(macros);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  geo.attributes.aGroundMacro.needsUpdate = true;
}

function writeVec3(target, index, x, y, z) {
  const i = index * 3;
  target[i] = x;
  target[i + 1] = y;
  target[i + 2] = z;
}

function writeRidgeColor(target, index, height, band, value) {
  const rock = smooth01((height - 70) / 150);
  const snow = smooth01((height - 215) / 115);
  let r = mix(RIDGE_LOW[0], RIDGE_ROCK[0], rock);
  let g = mix(RIDGE_LOW[1], RIDGE_ROCK[1], rock);
  let b = mix(RIDGE_LOW[2], RIDGE_ROCK[2], rock);
  r = mix(r, RIDGE_SNOW[0], snow);
  g = mix(g, RIDGE_SNOW[1], snow);
  b = mix(b, RIDGE_SNOW[2], snow);

  // Cohesive blue-grey layers read as painted depth even before live scene fog
  // completes the blend. Farther ribbons carry less local material colour.
  const haze = 0.12 + band * 0.10;
  writeVec3(
    target,
    index,
    mix(r, RIDGE_HAZE[0], haze) * value,
    mix(g, RIDGE_HAZE[1], haze) * value,
    mix(b, RIDGE_HAZE[2], haze) * value,
  );
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smooth01(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
