// Distant terrain: one radial "horizon mesh" centred on the player, with
// exponentially spaced rings — fine cells where it meets the streamed chunks,
// coarse cells out to the horizon. It samples the same world model and shares
// the terrain material, so far mountain ranges match what you eventually walk
// to. Rebuilds are incremental (a few rings per frame) and only happen when
// the player strays ~450 m from the mesh centre.

import * as THREE from 'three';
import { groundColor } from './world.js';
import { terrainMaterial } from './terrain.js';

const ANGULAR = 160;  // spokes: finer curved ridge silhouettes
const RINGS = 60;     // last ring is a downward skirt
const OUTER = 7500;
const RINGS_PER_FRAME = 6;
const REBUILD_DIST = 450;

export class FarTerrain {
  constructor(scene, world) {
    this.world = world;
    this.nearField = 800;     // extent of streamed chunks (set by quality tier)
    this.cx = 0;
    this.cz = 0;
    this.buildRing = -1;      // -1 = idle
    this.needsRebuild = true;

    // radial ring radii (recomputed per quality tier — see _computeRadii)
    this.radii = new Float32Array(RINGS);
    this._computeRadii();

    const count = RINGS * ANGULAR;
    this.scratchPos = new Float32Array(count * 3);
    this.scratchNor = new Float32Array(count * 3);
    this.scratchCol = new Float32Array(count * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const indices = [];
    for (let i = 0; i < RINGS - 1; i++) {
      for (let a = 0; a < ANGULAR; a++) {
        const a1 = (a + 1) % ANGULAR;
        const p00 = i * ANGULAR + a, p01 = i * ANGULAR + a1;
        const p10 = (i + 1) * ANGULAR + a, p11 = (i + 1) * ANGULAR + a1;
        indices.push(p00, p01, p10, p01, p11, p10);
      }
    }
    geo.setIndex(indices);

    this.mesh = new THREE.Mesh(geo, terrainMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.visible = false; // until the first build completes
    scene.add(this.mesh);

    this._rgb = [0, 0, 0];
  }

  // Exponential ring radii starting just INSIDE the streamed-chunk edge, so the
  // dense (closely-spaced) end of the exponential lands in the visible mid-
  // distance band instead of being wasted under the chunks. Tracks nearField so
  // each quality tier packs its rings where that tier's chunks actually stop —
  // 0.6·nearField keeps a safe overlap under the chunks with no seam/gap.
  _computeRadii() {
    const inner = Math.max(120, this.nearField * 0.6);
    for (let i = 0; i < RINGS - 1; i++) {
      this.radii[i] = inner * Math.pow(OUTER / inner, i / (RINGS - 2));
    }
    this.radii[RINGS - 1] = OUTER * 1.04;
  }

  setNearField(d) {
    if (d !== this.nearField) {
      this.nearField = d;
      this._computeRadii();
      this.needsRebuild = true;
    }
  }

  update(px, pz) {
    if (this.buildRing >= 0) {
      this.buildStep();
      return;
    }
    const dx = px - this.cx, dz = pz - this.cz;
    if (this.needsRebuild || dx * dx + dz * dz > REBUILD_DIST * REBUILD_DIST) {
      this.cx = Math.round(px / 50) * 50;
      this.cz = Math.round(pz / 50) * 50;
      this.buildRing = 0;
      this.needsRebuild = false;
    }
  }

  buildStep() {
    const world = this.world;
    const end = Math.min(this.buildRing + RINGS_PER_FRAME, RINGS);
    for (let i = this.buildRing; i < end; i++) {
      const r = this.radii[i];
      const skirt = i === RINGS - 1;
      // Sink the mesh under the streamed chunks so coarse far-samples never poke
      // through the fine chunk geometry (deep in the overlap zone) — then EASE
      // THE SINK BACK toward the true surface past the chunk edge. Out there
      // nothing overlaps the far mesh, so the old constant 1.5 m depression only
      // made distant impostor trees (placed at true height) hover with daylight
      // under them. Trees now meet the far surface within centimetres; the
      // impostor root-skirt buries any residue.
      const inner = smooth01((r - this.nearField * 0.55) / (this.nearField * 0.45));
      const outer = smooth01((r - this.nearField) / (this.nearField * 0.7));
      const depress = (1.5 + 8.5 * (1 - inner)) * (1 - outer) + 0.35 * outer;
      const eps = Math.max(6, r * 0.045); // normal sampling radius matches cell size
      for (let a = 0; a < ANGULAR; a++) {
        const idx = i * ANGULAR + a;
        const theta = (a / ANGULAR) * Math.PI * 2;
        const x = this.cx + Math.cos(theta) * r;
        const z = this.cz + Math.sin(theta) * r;
        let h, nx, ny, nz;
        if (skirt) {
          h = -80; nx = 0; ny = 1; nz = 0;
          this.scratchCol[idx * 3] = 0.1; this.scratchCol[idx * 3 + 1] = 0.13; this.scratchCol[idx * 3 + 2] = 0.15;
        } else {
          h = world.height(x, z) - depress;
          const hx = world.height(x - eps, z) - world.height(x + eps, z);
          const hz = world.height(x, z - eps) - world.height(x, z + eps);
          const len = Math.hypot(hx, 2 * eps, hz);
          nx = hx / len; ny = (2 * eps) / len; nz = hz / len;
          const { t, m } = world.climate(x, z, h);
          groundColor(world, x, z, h + depress, 1 - ny, t, m, this._rgb);
          this.scratchCol[idx * 3] = this._rgb[0];
          this.scratchCol[idx * 3 + 1] = this._rgb[1];
          this.scratchCol[idx * 3 + 2] = this._rgb[2];
        }
        this.scratchPos[idx * 3] = x;
        this.scratchPos[idx * 3 + 1] = h;
        this.scratchPos[idx * 3 + 2] = z;
        this.scratchNor[idx * 3] = nx;
        this.scratchNor[idx * 3 + 1] = ny;
        this.scratchNor[idx * 3 + 2] = nz;
      }
    }
    this.buildRing = end;
    if (this.buildRing >= RINGS) {
      // atomic swap so the horizon never shows a half-built frame
      const geo = this.mesh.geometry;
      geo.attributes.position.array.set(this.scratchPos);
      geo.attributes.normal.array.set(this.scratchNor);
      geo.attributes.color.array.set(this.scratchCol);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      this.mesh.visible = true;
      this.buildRing = -1;
    }
  }
}

function smooth01(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
