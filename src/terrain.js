// Infinite chunked terrain. Chunks stream in around the player, resolution
// drops with distance (with skirt geometry hiding LOD seams), and each chunk
// carries its own instanced vegetation and grass.

import * as THREE from 'three';
import { buildScatterGroup, buildGrassMesh, buildUnderstoryMesh } from './vegetation.js';
import { riverMaterial } from './river.js';
import { buildWaterfallGroup } from './waterfall.js';
import { injectAtmosphere } from './atmosphere.js';
import { waterUniforms } from './watercommon.js';
import { groundDetailUniforms } from './grounddetail.js';
import { trailSurfaceMaterial } from './trailsurface.js';
import { groundColor } from './world.js';
import { buildTerrainCutPatch, caveCutContainsWorld, splitQuadValue } from './terraincut.mjs';
import { setWorldRailwayTerrain } from './railwayterrain.mjs';
import {
  DEFAULT_ASSEMBLY_BUDGET_MS,
  DEFAULT_ASSEMBLY_MAX_CHUNKS,
  canContinueAssembly,
} from './assemblybudget.mjs';

export const CHUNK_SIZE = 140;

// CPU-side counterpart of the render mask in cavevisual.js. Heightfields
// cannot represent an overhang, so affected triangles are genuinely removed
// and a separate folded-earth mesh bridges the retained terrain to the cave.
// Keeping this predicate in world space makes cross-chunk ownership exact.
export function terrainCaveCutContains(worldX, worldZ, spec, inset = 0) {
  return caveCutContainsWorld(worldX, worldZ, spec, inset);
}

export const terrainMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 1.0, metalness: 0,
});

// Delicate painterly terrain detail. All fields are continuous, world-space
// and low contrast: no crack ridges, hard bands or binary material thresholds.
// The same material is shared by streamed and far terrain, so washes stay
// stable across chunk/LOD boundaries.
const GLSL_GROUND_DETAIL = `
uniform float uGroundDetail;
uniform float uGroundRelief;

float gdHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float gdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = gdHash(i), b = gdHash(i + vec2(1.0, 0.0));
  float c = gdHash(i + vec2(0.0, 1.0)), d = gdHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float gdFbm(vec2 p) {
  return gdNoise(p) * 0.68 + gdNoise(p * 2.31 + 13.7) * 0.32;
}
float gdBrush(vec2 p) {
  mat2 turn = mat2(0.82, -0.57, 0.57, 0.82);
  vec2 q = turn * p;
  float longStroke = gdNoise(vec2(q.x * 0.48, q.y * 1.55));
  float crossStroke = gdNoise(vec2(q.x * 1.35 + 17.0, q.y * 0.62 - 9.0));
  return longStroke * 0.64 + crossStroke * 0.36;
}
vec2 gdFaceUV(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return p.xz;
  return a.x >= a.z ? p.yz : p.xy;
}
void gdSurfaceWeights(vec3 vc, float up, out float grass, out float snow, out float sand, out float rock) {
  float luma = dot(vc, vec3(0.299, 0.587, 0.114));
  float mx = max(max(vc.r, vc.g), vc.b);
  float mn = min(min(vc.r, vc.g), vc.b);
  float sat = mx - mn;
  float greenLead = vc.g - max(vc.r, vc.b);
  grass = smoothstep(0.015, 0.12, greenLead);
  snow = smoothstep(0.72, 0.90, luma) * (1.0 - smoothstep(0.10, 0.24, sat));
  float warm = smoothstep(0.05, 0.22, vc.r - vc.b);
  sand = warm * smoothstep(0.44, 0.70, luma) * smoothstep(0.76, 0.96, up);
  sand *= (1.0 - grass) * (1.0 - snow);
  float neutral = 1.0 - smoothstep(0.10, 0.28, sat);
  rock = (smoothstep(0.16, 0.58, 1.0 - up) * 0.72 + neutral * 0.28);
  rock *= (1.0 - snow) * (1.0 - grass * 0.75) * (1.0 - sand);
}
`;

terrainMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTide = waterUniforms.uTide;   // shore darkens/shines with the tide
  shader.uniforms.uGroundDetail = groundDetailUniforms.strength;
  shader.uniforms.uGroundRelief = groundDetailUniforms.relief;
  shader.vertexShader = 'varying vec3 vWP;\nvarying float vUp;\nvarying vec3 vGroundN;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
    vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vUp = normal.y;
    vGroundN = normalize(normal);`   // terrain has no rotation, so object normal == world normal
  );
  shader.fragmentShader = ('varying vec3 vWP;\nvarying float vUp;\nvarying vec3 vGroundN;\nuniform float uTide;\n' + GLSL_GROUND_DETAIL + shader.fragmentShader)
    // --- wet-sand band: flat ground just above the (tide-shifted) waterline
    // darkens and takes a cool damp sheen. Migrates with the tide, and its soft
    // top edge blends the shore into the receding sea (also hides the old
    // sand/water contact line). --------------------------------------------
    .replace('#include <color_fragment>', `#include <color_fragment>
    {
      float wet = (1.0 - smoothstep(-0.08, 0.72, vWP.y - uTide)) * smoothstep(0.80, 0.95, vUp);
      // near-field effect only: on flat deltas the band is tens of metres wide,
      // and from a lookout it reads as a dark "division" between river and sea
      wet *= 1.0 - smoothstep(250.0, 700.0, length(vViewPosition));
      diffuseColor.rgb *= 1.0 - 0.38 * wet;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.85, 0.92, 1.02), wet * 0.35);

      // A fine wrack/strand line above the active swash. CPU vertex pigment
      // establishes the broad band; this world-space detail keeps it coherent
      // on high-res nearby chunks and breaks it into tide-thrown fragments.
      float sandWarmth = smoothstep(0.05, 0.20, vColor.r - vColor.b)
                       * smoothstep(0.82, 0.97, vUp);
      float strandY = 1.02 + (gdNoise(vWP.xz * 0.018 + vec2(41.0, 0.0)) - 0.5) * 0.48;
      float strand = (1.0 - smoothstep(0.08, 0.30, abs(vWP.y - strandY))) * sandWarmth;
      float broken = smoothstep(0.37, 0.68, gdFbm(vWP.xz * 0.22 + 19.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.22, 0.14), strand * broken * 0.34);
    }
    {
      float dist = length(vViewPosition);
      float grass, snow, sand, rock;
      gdSurfaceWeights(vColor, vUp, grass, snow, sand, rock);

      vec3 triN = normalize(vGroundN);
      float broad = gdFbm(gdFaceUV(vWP * 0.024, triN)) - 0.5;
      float brush = gdBrush(gdFaceUV(vWP * 0.17, triN)) - 0.5;
      float grain = gdNoise(gdFaceUV(vWP * 1.35 + 31.0, triN)) - 0.5;
      float broadFade = 1.0 - smoothstep(300.0, 950.0, dist);
      float nearFade = 1.0 - smoothstep(70.0, 230.0, dist);

      // A shared underpainting unifies surfaces. Material weights only nudge
      // its character; they never select a separate crack/stripe pattern.
      float broadAmount = 0.095 + grass * 0.035 + rock * 0.025 - snow * 0.048;
      float nearAmount = 0.090 + grass * 0.040 + sand * 0.032 + rock * 0.025 - snow * 0.045;
      float valueWash = broad * broadAmount * broadFade
                      + brush * nearAmount * nearFade
                      + grain * 0.040 * nearFade;

      vec3 c = diffuseColor.rgb * (1.0 + valueWash * uGroundDetail);

      // Soft pigment drift: grassy ground catches a little straw warmth, sand
      // a warm directional wash, rock a cool mineral grey, snow a quiet blue.
      float warmStroke = (brush * 0.5 + broad * 0.5) * uGroundDetail * nearFade;
      c = mix(c, c * vec3(1.045, 1.022, 0.950), grass * (warmStroke + 0.5) * 0.070);
      c = mix(c, c * vec3(1.035, 1.012, 0.958), sand * (warmStroke + 0.5) * 0.060);
      c = mix(c, c * vec3(0.975, 0.992, 1.025), rock * (broad + 0.5) * 0.050 * uGroundDetail);
      c = mix(c, c * vec3(0.965, 0.990, 1.035), snow * (brush + 0.5) * 0.040 * uGroundDetail);
      diffuseColor.rgb = c;
    }`)
    // Very shallow physical tooth near the player. It has no ridged component,
    // so it grounds light without drawing contour lines on slopes.
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    {
      float grass, snow, sand, rock;
      gdSurfaceWeights(vColor, vUp, grass, snow, sand, rock);
      float nFade = 1.0 - smoothstep(24.0, 95.0, length(vViewPosition));
      vec2 np = vWP.xz * 0.46;
      float ne = 0.32;
      float n0 = gdNoise(np);
      float gx = (gdNoise(np + vec2(ne, 0.0)) - n0) / ne;
      float gz = (gdNoise(np + vec2(0.0, ne)) - n0) / ne;
      float tooth = 0.022 + grass * 0.012 + sand * 0.008 + rock * 0.016 - snow * 0.014;
      tooth *= smoothstep(0.18, 0.62, abs(vUp));
      vec3 wgrad = vec3(-gx, 0.0, -gz) * tooth * nFade * uGroundDetail * uGroundRelief;
      normal = normalize(normal + (viewMatrix * vec4(wgrad, 0.0)).xyz);
    }`)
    // wet sand near the tideline is glossier (damp sheen)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    {
      float wet = (1.0 - smoothstep(-0.08, 0.72, vWP.y - uTide)) * smoothstep(0.80, 0.95, vUp);
      wet *= 1.0 - smoothstep(250.0, 700.0, length(vViewPosition)); // near-field only (matches colour band)
      roughnessFactor = mix(roughnessFactor, 0.35, wet * 0.7);
    }`)
    // Shadow-edge fade: the single 95 m shadow box otherwise ENDS in a hard
    // line — sunlit ground beyond it, shadowed ground inside, trees popping
    // their shadows as you walk. Ease the shadow term back to fully lit over
    // the outer rim of the shadow map instead. (Terrain is the only shadow
    // RECEIVER, so patching this one material covers the whole world; the
    // first 'return shadow;' in the chunk is directional getShadow.)
    .replace('#include <shadowmap_pars_fragment>',
      THREE.ShaderChunk.shadowmap_pars_fragment.replace('return shadow;',
        `{
          vec2 _rim = abs(shadowCoord.xy - 0.5) * 2.0;
          shadow = mix(shadow, 1.0, smoothstep(0.78, 0.98, max(_rim.x, _rim.y)));
        }
        return shadow;`));
};

// cloud shadows + aerial haze on all terrain (streamed chunks share this with
// the far horizon mesh in farterrain.js)
injectAtmosphere(terrainMaterial, { clouds: true, aerial: true });

export function createTerrainPatchMaterial() {
  const material = terrainMaterial.clone();
  material.userData.cavePatch = true;
  const compileTerrain = terrainMaterial.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    compileTerrain.call(terrainMaterial, shader, renderer);
  };
  material.customProgramCacheKey = () => 'terrain-cave-patch-v1';
  material.needsUpdate = true;
  return material;
}

export class ChunkManager {
  constructor(scene, world, library) {
    this.scene = scene;
    this.world = world;
    this.library = library;
    this.chunks = new Map();   // key -> { mesh, veg, imp, grass, sig, res, ring, cx, cz }
    this.pending = new Map();  // key -> { id, sig } (in flight OR awaiting assembly)
    this.jobs = new Map();     // id -> { key, cx, cz, plan }
    this.results = [];         // worker results awaiting main-thread assembly
    this.nextId = 1;
    this.neededNear = 0;       // near (ring<=1) chunks not yet completed
    this.assembleMaxChunks = DEFAULT_ASSEMBLY_MAX_CHUNKS;
    this.assembleBudgetMs = DEFAULT_ASSEMBLY_BUDGET_MS;
    this.assemblyDebug = {
      queue: '0 ready',
      timing: '—',
      peakMs: 0,
      peak: '—',
      lastMs: 0,
      lastProps: '—',
    };
    this.caveCut = null;
    this.railwayTerrainSpec = null;
    this.railwayTerrainRevision = 0;
    this.pcx = 0;              // player chunk coords, updated each frame
    this.pcz = 0;
    this.impostors = null;     // impostor system (set by main once the renderer exists)

    // Quality-driven knobs (set by QualityManager)
    this.viewRadius = 5;       // chunks with streamed terrain
    this.treeRadius = 4;       // chunks with full-geometry trees
    this.impostorRadius = 8;   // chunks with trees as billboards (terrainless past viewRadius)
    this.grassRadius = 2;      // chunks that get grass
    this.clutterRadius = 2;    // chunks that get ground clutter (ferns/flowers/etc.)
    this.grassPerChunk = 1800; // scatter attempts
    this.treeDensityScale = 1;
    this.clutterDensityScale = 1;
    this.nearRes = 64;         // vertex resolution of the nearest ring (tier-scaled)
    this.shadows = true;

    // Worker pool: generation runs off the main thread. Messages are FIFO per
    // worker, so an 'init' posted before any 'build' is always processed first.
    const n = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 4));
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, busy: false };
      worker.onmessage = (e) => this.onWorkerMessage(slot, e.data);
      worker.postMessage({ type: 'init', seed: world.seed });
      this.workers.push(slot);
    }
  }

  resForRing(ring) {
    // A gentler LOD ladder than the old nearRes / nearRes·½ / 16 cliff: two more
    // steps so the mid-distance rings (4–7, ~560–980 m) aren't a flat 16-vert
    // grid whose 9 m facets read as low-poly mountainsides. Monotonic on every
    // tier (values derived from nearRes so lower tiers stay cheaper).
    if (ring <= 1) return this.nearRes;
    const r23 = Math.max(24, this.nearRes >> 1);
    if (ring <= 3) return r23;
    const r45 = Math.max(20, (r23 * 3) >> 2);   // ≈ 0.75·r23
    if (ring <= 5) return r45;
    return Math.max(16, r45 >> 1);              // ≈ 0.5·r45
  }

  // What a chunk at offset (dx, dz) from the player should contain, or null if
  // out of range. The `sig` string fully describes the chunk's content, so any
  // change to it (LOD, full<->impostor trees, terrain<->terrainless) rebuilds.
  chunkPlan(dx, dz) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    const d2 = dx * dx + dz * dz;
    if (ring <= this.viewRadius && d2 <= this.viewRadius * this.viewRadius + 1) {
      const res = this.resForRing(ring);
      const treeMode = ring <= this.treeRadius ? 'full' : 'impostor';
      const doGrass = ring <= this.grassRadius;
      const doClutter = ring <= this.clutterRadius;
      // density LOD: full blades near, thinning outward while terrain vertex
      // colours carry the broad biome tone beneath the sparse geometry
      const grassScale = ring <= 1 ? 1 : ring === 2 ? 0.6 : 0.35;
      return {
        ring, res, doTerrain: true, treeMode, doGrass, doClutter, grassScale,
        sig: res + ':' + treeMode + (doGrass ? ':g' + grassScale : '') + (doClutter ? ':c' : '')
          + ':rail' + this.railwayTerrainRevision,
      };
    }
    if (ring <= this.impostorRadius && d2 <= this.impostorRadius * this.impostorRadius + 1) {
      return {
        ring, res: 0, doTerrain: false, treeMode: 'impostor', doGrass: false, doClutter: false,
        sig: 'imp:rail' + this.railwayTerrainRevision,
      };
    }
    return null;
  }

  update(px, pz) {
    const pcx = this.pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = this.pcz = Math.floor(pz / CHUNK_SIZE);
    const R = this.impostorRadius;

    // Collect chunks that need (re)building: missing, or whose content changed.
    const candidates = [];
    let neededNear = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const plan = this.chunkPlan(dx, dz);
        if (!plan) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = cx + ',' + cz;
        const existing = this.chunks.get(key);
        if (existing && existing.sig === plan.sig) { existing.ring = plan.ring; continue; }
        const pend = this.pending.get(key);
        if (pend) { if (plan.ring <= 1 && pend.sig === plan.sig) neededNear++; continue; }
        candidates.push({ cx, cz, key, plan, d2: dx * dx + dz * dz });
        if (plan.ring <= 1) neededNear++;
      }
    }
    this.neededNear = neededNear;
    candidates.sort((a, b) => a.d2 - b.d2);

    // Dispatch nearest candidates to any free workers this frame.
    let ci = 0;
    for (const slot of this.workers) {
      if (ci >= candidates.length) break;
      if (slot.busy) continue;
      this.dispatch(slot, candidates[ci++]);
    }

    // Assemble a bounded number of finished chunks (nearest first).
    this.drainResults();

    // Drop chunks far outside the impostor radius (hysteresis of +1.5 rings).
    const drop = (R + 1.5) * (R + 1.5);
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - pcx, dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > drop) this.removeChunk(key);
    }
  }

  pendingNearby() {
    return this.neededNear;
  }

  dispatch(slot, cand) {
    const id = this.nextId++;
    const p = cand.plan;
    slot.busy = true;
    this.pending.set(cand.key, { id, sig: p.sig });
    this.jobs.set(id, { key: cand.key, cx: cand.cx, cz: cand.cz, plan: p });
    slot.worker.postMessage({
      type: 'build', id, cx: cand.cx, cz: cand.cz, res: p.res, chunkSize: CHUNK_SIZE,
      doTerrain: p.doTerrain, treeMode: p.treeMode, doGrass: p.doGrass, doClutter: p.doClutter,
      grassPerChunk: Math.round(this.grassPerChunk * (p.grassScale || 1)),
      treeDensityScale: this.treeDensityScale,
      clutterDensityScale: this.clutterDensityScale,
      railwayRevision: this.railwayTerrainRevision,
    });
  }

  onWorkerMessage(slot, data) {
    if (data.type === 'ready') return;
    slot.busy = false; // free the worker immediately so it can take the next job
    if (data.type !== 'built') return;
    const job = this.jobs.get(data.id);
    this.jobs.delete(data.id);
    if (!job) return;
    // Keep the pending entry (so update() won't re-dispatch this key) until the
    // result is assembled or discarded in drainResults().
    this.results.push({ job, data });
  }

  // Assemble up to assembleBudget finished chunks per frame, nearest first, so
  // a burst of worker completions can't blow the frame budget (matters in VR).
  drainResults() {
    if (this.results.length === 0) {
      this.assemblyDebug.queue = '0 ready';
      return;
    }
    if (this.results.length > 1) {
      this.results.sort((a, b) => {
        const da = (a.job.cx - this.pcx) ** 2 + (a.job.cz - this.pcz) ** 2;
        const db = (b.job.cx - this.pcx) ** 2 + (b.job.cz - this.pcz) ** 2;
        return da - db;
      });
    }
    const frameStart = performance.now();
    let assembled = 0, examined = 0;
    while (this.results.length && canContinueAssembly({
      assembled,
      examined,
      elapsedMs: performance.now() - frameStart,
      maxChunks: this.assembleMaxChunks,
      budgetMs: this.assembleBudgetMs,
    })) {
      const { job, data } = this.results.shift();
      examined++;
      this.pending.delete(job.key);
      // Validate against the current desired content: the player may have moved
      // or the chunk's plan may have changed while it was generating.
      const plan = this.chunkPlan(job.cx - this.pcx, job.cz - this.pcz);
      if (!plan || plan.sig !== job.plan.sig) continue; // out of range or stale
      if (this.chunks.has(job.key)) this.removeChunk(job.key); // replace old content
      const chunkStart = performance.now();
      this.assembleChunk(job, data, plan);
      const chunkMs = performance.now() - chunkStart;
      assembled++;
      this.assemblyDebug.lastMs = +chunkMs.toFixed(2);
      const clutterObjects = data.clutter?.reduce((sum, bucket) => sum + bucket.matrices.length / 16, 0) || 0;
      const scatterObjects = data.scatter?.reduce((sum, bucket) => sum + bucket.matrices.length / 16, 0) || 0;
      this.assemblyDebug.lastProps = `${clutterObjects} clutter/${data.clutter?.length || 0} · ${scatterObjects} scatter/${data.scatter?.length || 0}`;
      if (chunkMs > this.assemblyDebug.peakMs) {
        this.assemblyDebug.peakMs = this.assemblyDebug.lastMs;
        this.assemblyDebug.peak = `${chunkMs.toFixed(2)}ms · ring ${plan.ring} · ${clutterObjects} clutter/${data.clutter?.length || 0} · ${scatterObjects} scatter/${data.scatter?.length || 0}`;
      }
    }
    const frameMs = performance.now() - frameStart;
    this.assemblyDebug.queue = `${this.results.length} ready`;
    this.assemblyDebug.timing = `${assembled} chunk · ${frameMs.toFixed(2)}ms frame · ${this.assembleBudgetMs}ms budget`;
  }

  assembleChunk(job, data, plan) {
    let mesh = null;
    if (data.terrain) {
      const t = data.terrain;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(t.colors, 3));
      geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
      geo.computeBoundingSphere();
      mesh = new THREE.Mesh(geo, terrainMaterial);
      mesh.receiveShadow = this.shadows;
      mesh.castShadow = false;
      this.scene.add(mesh);
    }

    const chunk = {
      mesh, caveCollar: null, trail: null, veg: null, imp: null, grass: null, clutter: null, under: null, river: null, waterfall: null,
      sig: plan.sig, res: plan.res, ring: plan.ring, cx: job.cx, cz: job.cz,
      terrainFullIndex: mesh?.geometry.index || null,
      terrainCutSignature: null,
    };

    if (data.trail) {
      const t = data.trail;
      const tgeo = new THREE.BufferGeometry();
      tgeo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
      tgeo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
      // Four components deliberately enable THREE's vertex-alpha path. The
      // material blends that coverage into the terrain for a soft shoulder.
      tgeo.setAttribute('color', new THREE.BufferAttribute(t.colors, 4));
      tgeo.setIndex(new THREE.BufferAttribute(t.indices, 1));
      tgeo.computeBoundingSphere();
      chunk.trail = new THREE.Mesh(tgeo, trailSurfaceMaterial);
      chunk.trail.receiveShadow = this.shadows;
      chunk.trail.castShadow = false;
      chunk.trail.renderOrder = 1;
      this.scene.add(chunk.trail);
    }

    if (data.river) {
      const r = data.river;
      const rgeo = new THREE.BufferGeometry();
      rgeo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
      rgeo.setAttribute('aWet', new THREE.BufferAttribute(r.wet, 1));
      rgeo.setAttribute('aFlow', new THREE.BufferAttribute(r.flow, 2));
      rgeo.setIndex(new THREE.BufferAttribute(r.indices, 1));
      rgeo.computeBoundingSphere();
      chunk.river = new THREE.Mesh(rgeo, riverMaterial);
      chunk.river.renderOrder = 2;   // after the ocean (renderOrder 1) for the delta crossfade
      this.scene.add(chunk.river);

      if (r.fall) {
        chunk.waterfall = buildWaterfallGroup(r.fall);
        this.scene.add(chunk.waterfall);
      }
    }

    if (data.scatter && data.scatter.length) {
      chunk.veg = buildScatterGroup(this.library, data.scatter, {
        shadows: this.shadows && plan.ring <= 2,
        coastal: data.coastal,
      });
      this.scene.add(chunk.veg);
    }
    if (data.impostors && data.impostors.length && this.impostors) {
      chunk.imp = this.impostors.buildGroup(data.impostors);
      this.scene.add(chunk.imp);
    }
    if (data.grass) {
      chunk.grass = buildGrassMesh(data.grass);
      this.scene.add(chunk.grass);
    }
    if (data.clutter && data.clutter.length) {
      // clutter reuses the same instanced-scatter group machinery as veg, just
      // shadow-off (the props are small and the cost is mostly draw-call setup)
      chunk.clutter = buildScatterGroup(this.library, data.clutter, {
        shadows: false,
        coastal: data.coastal,
      });
      this.scene.add(chunk.clutter);
    }
    if (data.understory) {
      // the atlas-billboard plant layer: one InstancedMesh for the whole chunk
      chunk.under = buildUnderstoryMesh(data.understory);
      this.scene.add(chunk.under);
    }

    this.chunks.set(job.key, chunk);
    this.applyCaveCutToChunk(chunk);
  }

  setCaveCut(spec = null) {
    const nextSignature = spec?.signature || null;
    if ((this.caveCut?.signature || null) === nextSignature) return;
    this.caveCut = spec ? { ...spec } : null;
    for (const chunk of this.chunks.values()) this.applyCaveCutToChunk(chunk);
  }

  setRailwayTerrain(spec = null) {
    const signature = spec?.signature || null;
    if ((this.railwayTerrainSpec?.signature || null) === signature) return false;
    this.railwayTerrainSpec = spec;
    this.railwayTerrainRevision++;
    setWorldRailwayTerrain(this.world, spec);
    for (const slot of this.workers) {
      slot.worker.postMessage({
        type: 'railwayTerrain',
        spec,
        revision: this.railwayTerrainRevision,
      });
    }
    return true;
  }

  terrainChunkAt(worldX, worldZ) {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    // On an exact chunk boundary either owner has the same edge samples. Try
    // both so a newly streamed neighbour is not required just to query it.
    for (const [ox, oz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const chunk = this.chunks.get(`${cx + ox},${cz + oz}`);
      if (!chunk?.mesh || !chunk.res) continue;
      const x0 = chunk.cx * CHUNK_SIZE, z0 = chunk.cz * CHUNK_SIZE;
      if (worldX >= x0 - 1e-6 && worldX <= x0 + CHUNK_SIZE + 1e-6
        && worldZ >= z0 - 1e-6 && worldZ <= z0 + CHUNK_SIZE + 1e-6) return chunk;
    }
    return null;
  }

  hasTerrainAt(worldX, worldZ) {
    return !!this.terrainChunkAt(worldX, worldZ);
  }

  caveTerrainSignature(bounds) {
    if (!bounds) return '';
    const affected = [];
    for (const chunk of this.chunks.values()) {
      if (!chunk.mesh || !chunk.res) continue;
      const minX = chunk.cx * CHUNK_SIZE, minZ = chunk.cz * CHUNK_SIZE;
      if (minX > bounds.maxX || minX + CHUNK_SIZE < bounds.minX
        || minZ > bounds.maxZ || minZ + CHUNK_SIZE < bounds.minZ) continue;
      affected.push(`${chunk.cx},${chunk.cz}:${chunk.res}`);
    }
    affected.sort();
    return affected.join('|');
  }

  // Exact CPU counterpart of the rendered heightfield's fixed diagonal. This
  // deliberately reads the immutable source vertices, not world.height(), so
  // the entrance/collision contract follows what the player can actually see.
  renderedHeightAt(worldX, worldZ) {
    const chunk = this.terrainChunkAt(worldX, worldZ);
    if (!chunk) return this.world.height(worldX, worldZ);
    const res = chunk.res, n = res + 1, step = CHUNK_SIZE / res;
    const x0 = chunk.cx * CHUNK_SIZE, z0 = chunk.cz * CHUNK_SIZE;
    const gridX = Math.max(0, Math.min(res, (worldX - x0) / step));
    const gridZ = Math.max(0, Math.min(res, (worldZ - z0) / step));
    const cellX = Math.min(res - 1, Math.floor(gridX));
    const cellZ = Math.min(res - 1, Math.floor(gridZ));
    const fx = gridX - cellX, fz = gridZ - cellZ;
    const positions = chunk.mesh.geometry.attributes.position.array;
    const a = cellZ * n + cellX, b = a + 1, c = a + n, d = c + 1;
    return splitQuadValue(
      positions[a * 3 + 1], positions[b * 3 + 1],
      positions[c * 3 + 1], positions[d * 3 + 1], fx, fz,
    );
  }

  // The replacement collar owns the transition from the exact coarse mesh to
  // continuous procedural terrain. Entrance meshing and collision call this
  // same function, so the three representations cannot drift apart.
  caveSurfaceHeightAt(worldX, worldZ, spec = this.caveCut) {
    const procedural = this.world.height(worldX, worldZ);
    if (!spec || typeof spec.collarWeightAt !== 'function') return procedural;
    const coarse = this.renderedHeightAt(worldX, worldZ);
    const weight = Math.max(0, Math.min(1, spec.collarWeightAt(worldX, worldZ)));
    return coarse + (procedural - coarse) * weight;
  }

  sampleCavePatchSurface(worldX, worldZ) {
    const e = 0.55;
    const height = this.world.height(worldX, worldZ);
    const dx = this.world.height(worldX - e, worldZ) - this.world.height(worldX + e, worldZ);
    const dz = this.world.height(worldX, worldZ - e) - this.world.height(worldX, worldZ + e);
    const length = Math.hypot(dx, e * 2, dz) || 1;
    const ny = (e * 2) / length;
    const climate = this.world.climate(worldX, worldZ, height);
    const color = [0, 0, 0];
    groundColor(this.world, worldX, worldZ, height, 1 - ny,
      climate.t, climate.m, color, dx / length, dz / length);
    const biomeId = this.world.classify(height, 1 - ny, climate.t, climate.m);
    if (biomeId === 'forest' || biomeId === 'taiga' || biomeId === 'jungle') {
      const darken = 1 - 0.34 * this.world.groveFactor(worldX, worldZ);
      color[0] *= darken; color[1] *= darken; color[2] *= darken;
    }
    return { height, normal: [dx / length, ny, dz / length], color };
  }

  disposeCaveCollar(chunk) {
    if (!chunk?.caveCollar) return;
    this.scene.remove(chunk.caveCollar);
    chunk.caveCollar.geometry.dispose();
    chunk.caveCollar = null;
  }

  applyCaveCutToChunk(chunk) {
    if (!chunk.mesh || !chunk.terrainFullIndex) return;
    const geometry = chunk.mesh.geometry;
    if (!this.caveCut) {
      if (chunk.terrainCutSignature !== null) {
        geometry.setIndex(chunk.terrainFullIndex);
        this.disposeCaveCollar(chunk);
        chunk.terrainCutSignature = null;
      }
      return;
    }
    if (chunk.terrainCutSignature === this.caveCut.signature) return;

    this.disposeCaveCollar(chunk);
    const bounds = this.caveCut.worldBounds;
    const chunkMinX = chunk.cx * CHUNK_SIZE, chunkMinZ = chunk.cz * CHUNK_SIZE;
    if (bounds && (chunkMinX > bounds.maxX || chunkMinX + CHUNK_SIZE < bounds.minX
      || chunkMinZ > bounds.maxZ || chunkMinZ + CHUNK_SIZE < bounds.minZ)) {
      geometry.setIndex(chunk.terrainFullIndex);
      chunk.terrainCutSignature = this.caveCut.signature;
      return;
    }
    const source = chunk.terrainFullIndex.array;
    const patch = buildTerrainCutPatch({
      positions: geometry.attributes.position.array,
      normals: geometry.attributes.normal.array,
      colors: geometry.attributes.color.array,
      sourceIndices: source,
      res: chunk.res,
      chunkSize: CHUNK_SIZE,
      cx: chunk.cx,
      cz: chunk.cz,
      // Shrink only the rendered heightfield cut by a fraction of a voxel.
      // The implicit fold retains the canonical zero surface and overlaps this
      // lip; polygon offset keeps the overlap stable without z-fighting.
      cutValueAt: (x, z) => this.caveCut.cutValueAt(x, z)
        + Math.max(0, this.caveCut.terrainCutOverlap || 0),
      collarWeightAt: this.caveCut.collarWeightAt,
      sampleProcedural: (x, z) => this.sampleCavePatchSurface(x, z),
      supportBounds: this.caveCut.worldBounds,
      solidValueAt: this.caveCut.solidValueAt,
      targetSpacing: 0.32,
    });
    geometry.setIndex(new THREE.BufferAttribute(patch.keptIndices, 1));
    if (patch.collar.indices.length) {
      const collarGeometry = new THREE.BufferGeometry();
      collarGeometry.setAttribute('position', new THREE.BufferAttribute(patch.collar.positions, 3));
      collarGeometry.setAttribute('normal', new THREE.BufferAttribute(patch.collar.normals, 3));
      collarGeometry.setAttribute('color', new THREE.BufferAttribute(patch.collar.colors, 3));
      collarGeometry.setIndex(new THREE.BufferAttribute(patch.collar.indices, 1));
      collarGeometry.computeBoundingSphere();
      const collar = new THREE.Mesh(collarGeometry, terrainMaterial);
      collar.name = 'cave-terrain-cut-collar';
      collar.receiveShadow = this.shadows;
      collar.castShadow = false;
      this.scene.add(collar);
      chunk.caveCollar = collar;
    }
    chunk.terrainCutSignature = this.caveCut.signature;
  }

  removeChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    this.disposeCaveCollar(chunk);
    if (chunk.trail) {
      this.scene.remove(chunk.trail);
      chunk.trail.geometry.dispose();
    }
    // instanced geometry is shared (library / impostor atlas) — dispose only the
    // per-instance buffers by disposing each InstancedMesh.
    if (chunk.veg) {
      this.scene.remove(chunk.veg);
      chunk.veg.children.forEach((m) => m.dispose());
    }
    if (chunk.imp) {
      this.scene.remove(chunk.imp);
      chunk.imp.children.forEach((m) => m.dispose());
    }
    if (chunk.grass) {
      this.scene.remove(chunk.grass);
      chunk.grass.dispose();
    }
    if (chunk.clutter) {
      this.scene.remove(chunk.clutter);
      chunk.clutter.children.forEach((m) => m.dispose());
    }
    if (chunk.under) {
      this.scene.remove(chunk.under);
      chunk.under.geometry.dispose(); // cloned quad (owns the per-chunk aCell buffer)
      chunk.under.dispose();
    }
    if (chunk.river) {
      this.scene.remove(chunk.river);
      chunk.river.geometry.dispose();
    }
    if (chunk.waterfall) {
      this.scene.remove(chunk.waterfall);
      // curtain mesh owns its geometry; mist sprites share material/texture
      chunk.waterfall.children.forEach((c) => { if (c.geometry) c.geometry.dispose(); });
    }
    this.chunks.delete(key);
  }
}
