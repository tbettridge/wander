// Phase-3 seamless cave entrance and collision integration. Rare deterministic
// anchors feed worker-streamed fixed-resolution blocks; an open SDF throat,
// terrain-aligned portal and swept player collision join surface to interior.

import * as THREE from 'three';
import { landmarksAround } from './landmarks.js';
import { groundColor } from './world.js';
import { mulberry32 } from './noise.js';
import { buildGrassMesh, buildScatterGroup, buildUnderstoryMesh } from './vegetation.js';
import { GRASS_COLORS, GRASS_DENSITY, UNDERSTORY_RECIPES, UNDERSTORY_SCALE, rockTint } from './vegdata.js';
import {
  CAVE_CELL_SIZE,
  caveAnchorForCell,
  caveAnchorsAround,
  caveHash,
  caveReliefAt,
  caveGraphSignature,
  generateCaveGraph,
  scoreCaveEntrance,
} from './cavegen.mjs';
import { fitCaveToTerrain } from './cavefit.mjs';
import {
  CAVE_DEFAULT_RESOLUTION,
  CAVE_PLAYER_CROUCH_HEIGHT,
  CAVE_PLAYER_HEIGHT,
  CAVE_PLAYER_RADIUS,
  CAVE_PLAYER_SKIN,
  cavePortalInside,
  createCaveField,
} from './cavefield.mjs';
import {
  caveChunkCoordinatesAt,
  caveChunkKey,
  createCaveVisualFieldSampler,
  createCaveChunkPlan,
  meshImplicitBox,
} from './cavemesh.mjs';
import {
  entrancePortalNear,
  entranceShouldRecoverOutdoor,
  entranceThroatEngaged,
  entranceTransitionState,
  implicitBodyFits,
  implicitFloorHeightNear,
  resolveImplicitHorizontal,
} from './caveentrance.mjs';
import { setCaveEntranceVisual } from './cavevisual.js';
import { createTerrainPatchMaterial } from './terrain.js';

const CAVE_RENDER_LAYER = 2;
// Region-aware retention keeps the current region + graph neighbours resident
// (~30–70 blocks mid-network on a V4 graph), so the LRU needs headroom beyond
// the active set before it starts evicting blocks we still want.
const CACHE_LIMIT = 144;

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function smoothstep(a, b, value) {
  const t = clamp01((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
}
function smoothMinimum(a, b, radius) {
  const h = clamp01(0.5 + 0.5 * (b - a) / radius);
  return b + (a - b) * h - radius * h * (1 - h);
}

function caveMaterial({ clipEntrance = false } = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    wireframe: false,
    uniforms: {
      uTime: { value: 0 },
      uSurfaceDebug: { value: 0 },
      // Only meshes belonging to entrance-tagged streaming blocks enable this
      // clip. Keeping it off on ordinary blocks lets large caves bend behind
      // the mouth without a cave-wide local-Z discard deleting distant walls.
      uSurfacePreview: { value: clipEntrance ? 1 : 0 },
      uPreviewMinZ: { value: -35 },
    },
    vertexShader: /* glsl */`
      attribute vec4 aSurface;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPosition;
      varying vec4 vSurface;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vLocalPosition = position;
        vSurface = aSurface;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uSurfaceDebug;
      uniform float uSurfacePreview;
      uniform float uPreviewMinZ;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPosition;
      varying vec4 vSurface;
      float hash31(vec3 p) {
        p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float noise3(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
              mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
              mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        if (uSurfacePreview > 0.5 && vLocalPosition.z < uPreviewMinZ) discard;
        vec3 n = normalize(vWorldNormal), toEye = normalize(cameraPosition - vWorldPosition);
        float distanceToEye = length(cameraPosition - vWorldPosition);
        float broad = noise3(vLocalPosition * 0.085 + vec3(2.1, 7.3, -4.8));
        float tooth = noise3(vLocalPosition * 0.34 + vec3(-8.0, 1.5, 11.0));
        float mineral = noise3(vLocalPosition * vec3(0.045, 0.16, 0.045));
        vec3 charcoal = vec3(0.025, 0.036, 0.045), slate = vec3(0.225, 0.255, 0.235);
        vec3 moss = vec3(0.105, 0.215, 0.135), warmStone = vec3(0.315, 0.205, 0.105);
        vec3 base = mix(charcoal, slate, 0.35 + broad * 0.52);
        base = mix(base, moss, smoothstep(0.56, 0.88, mineral) * (0.35 + max(-n.y, 0.0) * 0.35));
        base = mix(base, warmStone, smoothstep(0.76, 0.96, tooth) * 0.28);
        float facing = max(dot(n, toEye), 0.0);
        float headlight = (0.08 + facing * 1.15) / (1.0 + distanceToEye * 0.040);
        float floorBounce = max(n.y, 0.0) * 0.055;
        float wetSheen = pow(max(dot(reflect(-toEye, n), vec3(0.0, 1.0, 0.0)), 0.0), 12.0);
        if (uSurfaceDebug > 0.5) {
          // false-colour semantics view: orientation from the normal (green
          // floors / grey walls / violet ceilings), then wet=blue,
          // sediment=ochre, mineral=teal, fracture=red
          vec3 orient = n.y > 0.35 ? vec3(0.30, 0.34, 0.22)
            : (n.y < -0.35 ? vec3(0.20, 0.16, 0.30) : vec3(0.24, 0.24, 0.24));
          vec3 debugColor = orient;
          debugColor = mix(debugColor, vec3(0.10, 0.38, 0.90), vSurface.x * 0.85);
          debugColor = mix(debugColor, vec3(0.62, 0.46, 0.24), vSurface.y * 0.55);
          debugColor = mix(debugColor, vec3(0.15, 0.95, 0.75), vSurface.z * 0.95);
          debugColor = mix(debugColor, vec3(0.90, 0.22, 0.18), vSurface.w * 0.75);
          gl_FragColor = vec4(debugColor * (0.35 + headlight * 1.1), 1.0);
          return;
        }
        vec3 color = base * (0.05 + headlight * 1.50 + floorBounce);
        // the semantic wet channel scales the existing sheen — the first real
        // consumer of the Phase-A data; full painting arrives with Phase D
        color += vec3(0.12, 0.17, 0.16) * wetSheen * smoothstep(0.48, 0.9, mineral) * 0.24 * (0.5 + vSurface.x * 1.6);
        color *= 0.94 + floor(tooth * 5.0) / 5.0 * 0.10;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose?.();
  });
}

export class CaveExperiment {
  constructor(scene, world, controls, { x = -4129, z = -809, terrain = null, library = null } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.terrain = terrain;
    this.library = library;
    this.surfaceCameraNear = controls.camera.near;
    this.searchOrigin = { x, z };
    this.group = new THREE.Group();
    this.group.name = 'phase-3-seamless-cave';
    this.group.visible = false;
    scene.add(this.group);
    this.material = caveMaterial();
    this.entranceStreamMaterial = caveMaterial({ clipEntrance: true });

    this.graphDebug = null;
    this.entranceFacade = null;
    this.entranceMaterial = null;
    this.entranceImplicitField = null;
    this.entranceCollisionField = null;
    this.entranceImplicitBounds = null;
    this.entranceEcology = null;
    this.entranceTerrainSignature = null;
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.active = false;
    this.inside = false;
    this.openingActive = false;
    this.collisionFloorLocal = null;
    this.elapsed = 0;
    this.landmarkScratch = [];
    this.anchorCandidates = [];
    this.chunkCache = new Map();
    this.attachedKeys = new Set();
    this.desiredKeys = new Set();
    this.pendingKeys = new Map();
    this.requestById = new Map();
    this.queuedKeys = new Set();
    this.jobQueue = [];
    this.nextRequestId = 1;
    this.generationEpoch = 0;
    this.lastStreamCell = '';
    this.inspection = { active: false };
    this.auditPending = null;
    this.streamStartedAt = 0;
    this.workerErrors = 0;
    this.workers = [];
    this.createWorkers();
    this.collectAnchors();

    this.debug = {
      resolution: CAVE_DEFAULT_RESOLUTION,
      wireframe: false,
      surfaceDebug: false,
      inspect: false,
      showGraph: false,
      state: 'not streamed', collision: '—',
      anchor: '—', placement: '—', topology: '—', graph: '—',
      streaming: '—', metrics: '—', auditResult: '—',
      previousAnchor: () => this.stepAnchor(-1),
      nextAnchor: () => this.stepAnchor(1),
      previousChamber: () => this.stepChamber(-1),
      nextChamber: () => this.stepChamber(1),
      previewSurface: () => this.previewSurface(),
      enter: () => this.enter(),
      exit: () => this.exit(),
      rebuild: () => this.rebuild(),
      audit: () => this.audit(true),
    };

    this.anchorIndex = 0;
    this.chamberIndex = 0;
    this.configureAnchor(0);
    this.environment = {
      isIndoor: () => this.inside,
      floorHeight: (worldX, worldZ) => {
        return this.entranceFloorHeightWorld(worldX, worldZ);
      },
      resolveMovement: (position, previous) => this.resolveMovement(position, previous),
    };
  }

  createWorkers() {
    const count = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./caveworker.js', import.meta.url), { type: 'module' });
      const slot = { worker, busy: false, requestId: 0 };
      worker.onmessage = (event) => this.onWorkerMessage(slot, event.data);
      worker.onerror = (event) => {
        const job = this.requestById.get(slot.requestId);
        this.requestById.delete(slot.requestId);
        if (job) this.pendingKeys.delete(job.cacheKey);
        slot.busy = false;
        slot.requestId = 0;
        if (!job || job.epoch === this.generationEpoch) {
          this.workerErrors++;
          this.debug.state = `worker error · ${event.message || 'unknown'}`;
        }
        this.updateMetrics();
        this.pumpWorkers();
      };
      this.workers.push(slot);
    }
  }

  collectAnchors() {
    for (const radius of [7000, 14000, 22000]) {
      caveAnchorsAround(this.world, this.searchOrigin.x, this.searchOrigin.z, this.world.seed, radius, this.anchorCandidates);
      this.anchorCandidates = this.anchorCandidates.filter((anchor) => {
        landmarksAround(this.world, anchor.x, anchor.z, this.world.seed, 180, this.landmarkScratch);
        return !this.landmarkScratch.some((landmark) => {
          const dx = anchor.x - landmark.x, dz = anchor.z - landmark.z;
          const clearance = landmark.halo + 70;
          return dx * dx + dz * dz < clearance * clearance;
        });
      });
      if (this.anchorCandidates.length >= 3) break;
    }
    if (this.anchorCandidates.length === 0) {
      const fallback = scoreCaveEntrance(this.world, this.searchOrigin.x, this.searchOrigin.z, this.world.seed);
      this.anchorCandidates.push({
        ...fallback, id: 'cave:debug:fallback', key: 'debug_fallback', cellX: 0, cellZ: 0,
        seed: this.world.seed >>> 0, valid: false,
        reasons: [...fallback.reasons, 'no valid macro-cell anchor found in search radius'],
      });
    }
  }

  configureAnchor(index) {
    this.generationEpoch++;
    this.auditPending = null;
    if (this.debug) this.debug.auditResult = '—';
    this.jobQueue.length = 0;
    this.queuedKeys.clear();
    this.disposeEntranceFacade();
    this.disposeEntranceEcology();
    this.entranceImplicitField = null;
    this.entranceCollisionField = null;
    this.entranceImplicitBounds = null;
    this.entranceTerrainSignature = null;
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.collisionFloorLocal = null;
    const count = this.anchorCandidates.length;
    this.anchorIndex = ((index % count) + count) % count;
    this.anchor = this.anchorCandidates[this.anchorIndex];
    this.chamberIndex = 0;
    // biome gates the rare geologies (ice tubes in snow, lava tubes in desert);
    // hill class steers small-hill sites toward deep multi-level descents,
    // which fit under modest cover far better than long horizontal networks
    this.hillClass = caveReliefAt(this.world, this.anchor.x, this.anchor.z) < 26 ? 'low' : 'high';
    const generatedGraph = generateCaveGraph(this.anchor.seed, {
      biome: this.anchor.biome, hillClass: this.hillClass,
    });
    const generatedField = createCaveField(generatedGraph);
    const mouth = generatedGraph.entrance.mouth;
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    const mouthWorldX = cos * mouth[0] + sin * mouth[2];
    const mouthWorldZ = -sin * mouth[0] + cos * mouth[2];
    this.entranceFloorLocal = generatedField.floorHeight(mouth[0], mouth[2]);
    if (this.entranceFloorLocal === null) throw new Error(`Generated cave at ${this.anchor.id} has no entrance floor`);
    // A natural cave mouth cuts into the slope; aligning its floor to the top
    // of the heightfield made every facade sit on the ground like a pipe. Sink
    // the threshold under the hillside while preserving ample headroom/cover.
    this.entranceInset = Math.max(1.8, Math.min(3.2,
      this.anchor.coverRise * 0.18 + this.anchor.slope * 2.0));
    this.origin = new THREE.Vector3(
      this.anchor.x - mouthWorldX,
      this.anchor.surfaceY - this.entranceInset - this.entranceFloorLocal,
      this.anchor.z - mouthWorldZ,
    );
    const surfaceYAtLocal = (localX, localZ) => {
      const worldX = this.origin.x + cos * localX + sin * localZ;
      const worldZ = this.origin.z - sin * localX + cos * localZ;
      return this.world.height(worldX, worldZ) - this.origin.y;
    };
    const fitStartedAt = performance.now();
    this.graph = fitCaveToTerrain(generatedGraph, surfaceYAtLocal);
    this.terrainFitMs = performance.now() - fitStartedAt;
    this.graphSignature = caveGraphSignature(this.graph);
    this.field = createCaveField(this.graph);
    const fittedEntranceFloor = this.field.floorHeight(mouth[0], mouth[2]);
    if (fittedEntranceFloor === null || Math.abs(fittedEntranceFloor - this.entranceFloorLocal) > 0.02) {
      throw new Error(`Terrain fitting changed cave entrance floor ${this.graphSignature}`);
    }
    this.entranceFloorLocal = fittedEntranceFloor;
    this.fieldBaseline = this.field.hashField(24);
    const entranceSpec = {
      x: this.anchor.x,
      y: this.anchor.surfaceY - this.entranceInset,
      z: this.anchor.z,
      inwardX: this.anchor.inwardX,
      inwardZ: this.anchor.inwardZ,
      // Only the actual aperture/core clears ordinary chunk vegetation. The
      // outer verge remains available for both world scatter and authored
      // entrance dressing, avoiding a conspicuous sterile oval.
      width: 4.45,
      depth: 5.6,
      // Procedural chunk vegetation needs a slightly broader safety margin
      // than the cut itself; authored entrance dressing fills this verge back
      // in after it has been sampled against the final folded surface.
      vegetationWidth: 5.55,
      vegetationDepth: 7.2,
      // Terrain and the marching-cubes fold are independently tessellated.
      // Keep a small signed-field overlap at their shared lip so sub-voxel
      // interpolation differences cannot expose a sawtooth background crack.
      terrainCutOverlap: 0.30,
      cut: {
        minAlong: -4.2,
        maxAlong: 3.1,
        outerHalfWidth: 2.0,
        middleHalfWidth: 2.25,
        innerHalfWidth: 2.0,
      },
      signature: `${this.graphSignature}:${Math.round(this.anchor.surfaceY * 100)}:collar-v3`,
    };
    const supportLocal = {
      minX: -7.2, maxX: 7.2,
      // Carry the authored terrain-minus-cave throat past the entrance root.
      // The old +10.2m support ended while the generic round passage was still
      // visible from outside, leaving the renderer to choose between a pipe
      // shell and an open view through the hillside.
      minZ: mouth[2] - 5.6, maxZ: mouth[2] + 26.0,
    };
    entranceSpec.supportLocalBounds = supportLocal;
    entranceSpec.boundedCaveAirAtLocal = (localX, localY, localZ) => {
      const along = localZ - mouth[2];
      // The generated entrance passage is an open ray. Bound only its outward
      // end; inward it must remain the same cave field that streamed chunks use.
      return Math.max(
        (this.field.entranceSdf || this.field.sdf)(localX, localY, localZ),
        entranceSpec.cut.minAlong - along,
      );
    };
    entranceSpec.implicitValueAtLocal = (localX, localY, localZ, terrainLocalY) => smoothMinimum(
      entranceSpec.boundedCaveAirAtLocal(localX, localY, localZ),
      terrainLocalY - localY,
      0.72,
    );
    entranceSpec.collarWeightAt = (worldX, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const b = supportLocal;
      if (local.x <= b.minX || local.x >= b.maxX || local.z <= b.minZ || local.z >= b.maxZ) return 0;
      const continuousY = this.world.height(worldX, worldZ) - this.origin.y;
      const caveDistance = entranceSpec.boundedCaveAirAtLocal(local.x, continuousY, local.z);
      const fieldWeight = 1 - smoothstep(0.40, 3.20, caveDistance);
      const edge = Math.min(local.x - b.minX, b.maxX - local.x, local.z - b.minZ, b.maxZ - local.z);
      return fieldWeight * smoothstep(0, 0.85, edge);
    };
    entranceSpec.cutValueAt = (worldX, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const surfaceWorldY = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, entranceSpec)
        ?? this.world.height(worldX, worldZ);
      const surfaceLocalY = surfaceWorldY - this.origin.y;
      return entranceSpec.implicitValueAtLocal(local.x, surfaceLocalY, local.z, surfaceLocalY);
    };
    entranceSpec.solidValueAt = (worldX, worldY, worldZ) => {
      const local = this.worldToLocalXZ(worldX, worldZ);
      const surfaceWorldY = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, entranceSpec)
        ?? this.world.height(worldX, worldZ);
      return entranceSpec.implicitValueAtLocal(
        local.x,
        worldY - this.origin.y,
        local.z,
        surfaceWorldY - this.origin.y,
      );
    };
    const supportCorners = [
      [supportLocal.minX, supportLocal.minZ], [supportLocal.maxX, supportLocal.minZ],
      [supportLocal.minX, supportLocal.maxZ], [supportLocal.maxX, supportLocal.maxZ],
    ].map(([localX, localZ]) => this.localToWorldXZ(localX, localZ));
    entranceSpec.worldBounds = {
      minX: Math.min(...supportCorners.map((point) => point.x)),
      maxX: Math.max(...supportCorners.map((point) => point.x)),
      minZ: Math.min(...supportCorners.map((point) => point.z)),
      maxZ: Math.max(...supportCorners.map((point) => point.z)),
    };
    this.entranceSpec = entranceSpec;
    this.group.position.copy(this.origin);
    this.group.rotation.y = this.anchor.yaw;
    // A bespoke irregular throat renders the first metres; the generic SDF
    // begins only after its visibly cylindrical entrance segment is hidden.
    // Entrance-tagged blocks alone carry this clip, so it can extend beyond
    // the collar and suppress the first generic passage shell until the cave
    // is genuinely behind the hillside. Ordinary/distant blocks are untouched.
    const previewMinZ = mouth[2] + 24.5;
    this.material.uniforms.uPreviewMinZ.value = previewMinZ;
    this.material.uniforms.uSurfacePreview.value = 0;
    this.entranceStreamMaterial.uniforms.uPreviewMinZ.value = previewMinZ;
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.configurePlans();
    this.rebuildGraphDebug();
    this.refreshDebugReadout();
  }

  // Streamed blocks share ONE resolution across the whole network, by design.
  // Adaptive aperture detail is provided instead by the fine (~0.33 m) collar
  // mesh at the mouth (rebuildEntranceFacade), which needs no seam agreement
  // with the streamed blocks because they clip their surface behind it.
  // Per-block adaptive resolution is deliberately NOT used: every block is a
  // fixed 16-cell cube, so a different resolution means a different block size
  // and grid, which cannot share faces with its neighbours — it would crack
  // the seams the worker seam-audit guarantees. Silhouette-adaptive detail is
  // likewise declined: being view-dependent it would break the deterministic,
  // cache-keyed streaming and the identical-seed-identical-geometry contract.
  configurePlans() {
    const resolution = Number(this.debug.resolution);
    this.visualCameraField = createCaveVisualFieldSampler(this.field, resolution);
    this.plans = createCaveChunkPlan(this.graph, resolution).map((plan) => ({
      ...plan,
      cacheKey: `${this.graphSignature}:${resolution}:${plan.key}`,
    }));
    this.planByKey = new Map(this.plans.map((plan) => [plan.key, plan]));
    this.lastStreamCell = '';
  }

  refreshDebugReadout() {
    const v = this.graph.validation;
    const fit = this.graph.terrainFit;
    const fitLabel = fit
      ? ` · cover ${fit.minCover.toFixed(1)}m${fit.angleDegrees ? ` · bend ${fit.angleDegrees.toFixed(0)}°` : ''}${fit.drop ? ` · deepen ${fit.drop.toFixed(1)}m` : ''}`
      : '';
    this.debug.anchor = `${this.anchorIndex + 1}/${this.anchorCandidates.length} · ${this.anchor.id} · ${Math.round(this.anchor.x)}, ${Math.round(this.anchor.z)}`;
    this.debug.placement = `${this.anchor.valid ? 'valid' : 'fallback'} · ${this.anchor.biome} · score ${this.anchor.score.toFixed(2)} · slope ${this.anchor.slope.toFixed(2)} · inset ${this.entranceInset.toFixed(1)}m${fitLabel}`;
    this.debug.topology = `${this.graph.archetype} · ${v.nodes} nodes · ${v.chambers} chambers · ${v.branches} choices · ${v.loops} loops · ${v.mainLength.toFixed(0)}m route · ${v.verticalRelief.toFixed(1)}m relief · grade ${(v.maxGrade * 100).toFixed(1)}%`;
    this.debug.graph = `${this.graphSignature} · ${this.plans.length} sparse blocks · seed ${this.anchor.seed.toString(16).padStart(8, '0')} · fit ${this.terrainFitMs.toFixed(0)}ms`;
    this.updateMetrics();
  }

  worldToLocalXZ(worldX, worldZ) {
    const dx = worldX - this.origin.x, dz = worldZ - this.origin.z;
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    return { x: cos * dx - sin * dz, z: sin * dx + cos * dz };
  }

  localToWorldXZ(localX, localZ) {
    const cos = Math.cos(this.anchor.yaw), sin = Math.sin(this.anchor.yaw);
    return {
      x: this.origin.x + cos * localX + sin * localZ,
      z: this.origin.z - sin * localX + cos * localZ,
    };
  }

  worldToLocal(worldPosition) {
    const xz = this.worldToLocalXZ(worldPosition.x, worldPosition.z);
    return { x: xz.x, y: worldPosition.y - this.origin.y, z: xz.z };
  }

  localToWorld(localX, localY, localZ) {
    const xz = this.localToWorldXZ(localX, localZ);
    return { x: xz.x, y: this.origin.y + localY, z: xz.z };
  }

  disposeEntranceFacade() {
    if (this.entranceFacade) {
      this.group.remove(this.entranceFacade);
      disposeObject(this.entranceFacade);
    }
    this.entranceFacade = null;
    this.entranceMaterial = null;
  }

  disposeEntranceEcology() {
    if (!this.entranceEcology) return;
    this.scene.remove(this.entranceEcology);
    for (const child of this.entranceEcology.children) {
      if (child.name === 'cave-entrance-understory') child.geometry.dispose();
      if (child.name === 'cave-approach-boulders') child.children.forEach((mesh) => mesh.dispose?.());
      child.dispose?.();
    }
    this.entranceEcology = null;
  }

  // Despite the historical "facade" name, this builds the EXACT terrain collar:
  // a marching-cubes mesh of the shared terrain-minus-cave implicit field at
  // ~0.33 m, rendering the recessed throat that the streamed cave SDF clips
  // away (uPreviewMinZ). It is load-bearing, not a backing plane or a legacy
  // mask — removing it would re-expose the cylindrical SDF entrance as a pipe.
  rebuildEntranceFacade() {
    const startedAt = performance.now();
    this.disposeEntranceFacade();
    const facade = new THREE.Group();
    facade.name = 'implicit-terrain-cave-entrance';
    const mouth = this.graph.entrance.mouth;
    const floor = this.entranceFloorLocal;
    const surfaceHeightCache = new Map();
    const surfaceWorldY = (x, z) => {
      // SDF sampling revisits each x/z column for every y slice. Terrain
      // evaluation is the expensive part, so cache columns to avoid tens of
      // thousands of identical procedural-height calls during this one build.
      const key = `${Math.round(x * 1e8)},${Math.round(z * 1e8)}`;
      const cached = surfaceHeightCache.get(key);
      if (cached !== undefined) return cached;
      const worldXZ = this.localToWorldXZ(x, z);
      const height = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
        ?? this.world.height(worldXZ.x, worldXZ.z);
      surfaceHeightCache.set(key, height);
      return height;
    };
    const terrainLocalY = (x, z) => surfaceWorldY(x, z) - this.origin.y;
    const surfaceColorAt = (x, z) => {
      const worldXZ = this.localToWorldXZ(x, z);
      const h = surfaceWorldY(x, z);
      const e = 0.7;
      const sampleWorld = (sampleX, sampleZ) => this.terrain?.caveSurfaceHeightAt(
        sampleX, sampleZ, this.entranceSpec,
      ) ?? this.world.height(sampleX, sampleZ);
      const dx = sampleWorld(worldXZ.x - e, worldXZ.z) - sampleWorld(worldXZ.x + e, worldXZ.z);
      const dz = sampleWorld(worldXZ.x, worldXZ.z - e) - sampleWorld(worldXZ.x, worldXZ.z + e);
      const length = Math.hypot(dx, e * 2, dz) || 1;
      const climate = this.world.climate(worldXZ.x, worldXZ.z, h);
      const rgb = [0, 0, 0];
      groundColor(this.world, worldXZ.x, worldXZ.z, h, 1 - (e * 2) / length,
        climate.t, climate.m, rgb, dx / length, dz / length);
      const biomeId = this.world.classify(h, 1 - (e * 2) / length, climate.t, climate.m);
      if (biomeId === 'forest' || biomeId === 'taiga' || biomeId === 'jungle') {
        const darken = 1 - 0.34 * this.world.groveFactor(worldXZ.x, worldXZ.z);
        rgb[0] *= darken; rgb[1] *= darken; rgb[2] *= darken;
      }
      return new THREE.Color(rgb[0], rgb[1], rgb[2]);
    };
    const collarExtent = {
      minX: -6.35, maxX: 6.35,
      minZ: mouth[2] - 4.9, maxZ: mouth[2] + 25.0,
    };
    let maxTerrain = -Infinity;
    let minWalkableFloor = floor;
    // The first passage is allowed to descend and bend under the hillside.
    // The old collar extended 25m inward in X/Z but retained the mouth's Y
    // minimum, so the descending floor eventually left both the mesh box and
    // its collision scan. Sample the same fitted cave collision field across
    // the whole handoff and carry the collar beneath every reachable floor.
    for (let iz = 0; iz <= 30; iz++) {
      const z = collarExtent.minZ + iz / 30 * (collarExtent.maxZ - collarExtent.minZ);
      for (let ix = 0; ix <= 12; ix++) {
        const x = collarExtent.minX + ix / 12 * (collarExtent.maxX - collarExtent.minX);
        maxTerrain = Math.max(maxTerrain, terrainLocalY(x, z));
        const caveFloor = this.field.floorHeightNear(x, z, floor, 4.0, 14.0);
        if (Number.isFinite(caveFloor)) minWalkableFloor = Math.min(minWalkableFloor, caveFloor);
      }
    }
    // This is the canonical terrain-minus-cave field. The streamed collar is
    // clipped by this same field evaluated on its surface, so their aperture
    // boundary is shared instead of guessed twice with triangle centroids.
    const implicit = (x, y, z) => this.entranceSpec.implicitValueAtLocal(
      x, y, z, terrainLocalY(x, z),
    );
    // Navigation keeps the smoother standing-height profile, but preserves
    // visible wall recesses. This prevents the collision shell from protruding
    // invisibly into an apparently open entrance or chamber threshold.
    const collisionImplicit = (x, y, z) => smoothMinimum(
      Math.max(
        (this.field.entranceSdfNavigable
          || this.field.entranceSdfWalk
          || this.field.sdfNavigable
          || this.field.sdfWalk)(x, y, z),
        this.entranceSpec.cut.minAlong - (z - mouth[2]),
      ),
      terrainLocalY(x, z) - y,
      0.72,
    );
    const implicitBounds = {
      ...collarExtent,
      minY: minWalkableFloor - 1.50, maxY: maxTerrain + 1.0,
    };
    this.entranceImplicitField = implicit;
    this.entranceCollisionField = collisionImplicit;
    this.entranceImplicitBounds = implicitBounds;
    const meshStartedAt = performance.now();
    // Keep full cross-section detail at the lip; the axial cells relax toward
    // ~0.55m in the buried handoff where the silhouette is no longer seen.
    const verticalCells = Math.max(33, Math.ceil((implicitBounds.maxY - implicitBounds.minY) / 0.35));
    const raw = meshImplicitBox(implicit, implicitBounds, { nx: 38, ny: verticalCells, nz: 54 });
    this.entranceMeshMs = performance.now() - meshStartedAt;

    const colors = new Float32Array(raw.positions.length);
    const retainedVertex = new Uint8Array(raw.positions.length / 3);
    const inner = new THREE.Color(0x202923);
    const soil = new THREE.Color(0x514638);
    for (let i = 0; i < raw.positions.length; i += 3) {
      const x = raw.positions[i], y = raw.positions[i + 1], z = raw.positions[i + 2];
      const localCover = Math.max(0, terrainLocalY(x, z) - y);
      const worldXZ = this.localToWorldXZ(x, z);
      // Keep every recessed cave wall/roof plus only the narrow top-surface
      // overlap that participates in the shared collar. This avoids painting a
      // duplicate rectangular terrain patch around the mouth while preserving
      // a watertight overlap at the clipped aperture boundary.
      retainedVertex[i / 3] = localCover > 0.045
        || this.entranceSpec.collarWeightAt(worldXZ.x, worldXZ.z) > 1e-5;
      const blend = clamp01((localCover - 0.65) / 1.85);
      const color = surfaceColorAt(x, z);
      color.lerp(soil, blend * 0.46).lerp(inner, blend * blend * 0.58);
      colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b;
    }
    const retainedIndices = [];
    for (let i = 0; i < raw.indices.length; i += 3) {
      const a = raw.indices[i], b = raw.indices[i + 1], c = raw.indices[i + 2];
      if (retainedVertex[a] || retainedVertex[b] || retainedVertex[c]) retainedIndices.push(a, b, c);
    }
    const IndexArray = raw.indices.constructor;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(raw.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(retainedIndices), 1));
    geometry.computeBoundingSphere();
    const material = createTerrainPatchMaterial();
    material.side = THREE.DoubleSide;
    material.wireframe = this.debug.wireframe;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'cave-implicit-terrain-fold';
    mesh.receiveShadow = true;
    mesh.layers.enable(0);
    mesh.layers.enable(CAVE_RENDER_LAYER);
    facade.add(mesh);
    this.group.add(facade);
    this.entranceMaterial = material;
    this.entranceFacade = facade;
    this.entranceFacade.visible = this.openingActive;
    this.entranceBuildMs = performance.now() - startedAt;
    this.updateMetrics();
  }

  entranceSurfaceAtLocal(localX, localZ) {
    const worldXZ = this.localToWorldXZ(localX, localZ);
    const fallback = () => {
      const worldY = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
        ?? this.world.height(worldXZ.x, worldXZ.z);
      const e = 0.45;
      const sample = (x, z) => this.terrain?.caveSurfaceHeightAt(x, z, this.entranceSpec)
        ?? this.world.height(x, z);
      const dx = sample(worldXZ.x - e, worldXZ.z) - sample(worldXZ.x + e, worldXZ.z);
      const dz = sample(worldXZ.x, worldXZ.z - e) - sample(worldXZ.x, worldXZ.z + e);
      const normalY = (e * 2) / (Math.hypot(dx, e * 2, dz) || 1);
      const biome = this.world.biomeAt(worldXZ.x, worldXZ.z);
      return { worldY, normalY, biome, worldXZ, cover: 0, source: 'fallback' };
    };
    const field = this.entranceImplicitField;
    const bounds = this.entranceImplicitBounds;
    if (!field || !bounds || localX < bounds.minX || localX > bounds.maxX
      || localZ < bounds.minZ || localZ > bounds.maxZ) return fallback();

    const steps = 58;
    let previousY = bounds.maxY;
    let previousD = field(localX, previousY, localZ);
    for (let i = 1; i <= steps; i++) {
      const y = bounds.maxY + (bounds.minY - bounds.maxY) * i / steps;
      const d = field(localX, y, localZ);
      if (previousD < 0 && d >= 0) {
        const t = previousD / (previousD - d);
        const localY = previousY + (y - previousY) * t;
        const e = 0.18;
        const nx = -(field(localX + e, localY, localZ) - field(localX - e, localY, localZ));
        const ny = -(field(localX, localY + e, localZ) - field(localX, localY - e, localZ));
        const nz = -(field(localX, localY, localZ + e) - field(localX, localY, localZ - e));
        const length = Math.hypot(nx, ny, nz) || 1;
        const biome = this.world.biomeAt(worldXZ.x, worldXZ.z);
        const exteriorWorldY = this.terrain?.caveSurfaceHeightAt(
          worldXZ.x, worldXZ.z, this.entranceSpec,
        ) ?? this.world.height(worldXZ.x, worldXZ.z);
        const worldY = this.origin.y + localY;
        return {
          worldY,
          normalY: ny / length,
          biome,
          worldXZ,
          cover: Math.max(0, exteriorWorldY - worldY),
          source: 'implicit',
        };
      }
      previousY = y;
      previousD = d;
    }
    return fallback();
  }

  entranceFloorLocalNear(localX, localZ, referenceY = null, maxStep = Infinity, maxDrop = Infinity) {
    return implicitFloorHeightNear(
      this.entranceCollisionField || this.entranceImplicitField,
      this.entranceImplicitBounds,
      localX,
      localZ,
      referenceY,
      maxStep,
      maxDrop,
    );
  }

  entranceBodyFits(localX, localZ, floorY, radius = 0.30, height = 1.72, skin = 0.035) {
    return implicitBodyFits(
      this.entranceCollisionField || this.entranceImplicitField,
      localX,
      localZ,
      floorY,
      radius,
      height,
      skin,
    );
  }

  resolveEntranceHorizontal(fromX, fromZ, toX, toZ, referenceY, options = {}) {
    return resolveImplicitHorizontal(
      this.entranceCollisionField || this.entranceImplicitField,
      this.entranceImplicitBounds,
      fromX,
      fromZ,
      toX,
      toZ,
      referenceY,
      { ...options, cameraField: this.entranceImplicitField },
    );
  }

  rebuildEntranceEcology() {
    this.disposeEntranceEcology();

    const ecology = new THREE.Group();
    ecology.name = 'cave-entrance-ecology';
    const mouth = this.graph.entrance.mouth;
    const rng = mulberry32(caveHash(this.anchor.seed, 0x45434f4c));
    const grassMats = [], grassCols = [];
    const plantMats = [], plantCells = [], plantCols = [];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const pushMatrix = (out, x, y, z, ex, ey, ez, sx, sy, sz) => {
      position.set(x, y, z);
      euler.set(ex, ey, ez);
      quaternion.setFromEuler(euler);
      scale.set(sx, sy, sz);
      matrix.compose(position, quaternion, scale);
      out.push(...matrix.elements);
    };
    const choosePlant = (recipe) => {
      let pick = rng(), cell = recipe.mix[0][0];
      for (const [candidate, weight] of recipe.mix) {
        pick -= weight;
        if (pick <= 0) { cell = candidate; break; }
      }
      return cell;
    };
    const preferredSide = rng() < 0.5 ? -1 : 1;
    const withRadius = (x, z) => ({
      radius: Math.hypot(
        x / this.entranceSpec.width,
        (z - mouth[2] - 0.75) / this.entranceSpec.depth,
      ),
      x, z,
    });
    const candidate = (outer = 1) => {
      let x, z;
      if (rng() < 0.76) {
        const side = rng() < 0.64 ? preferredSide : -preferredSide;
        x = side * (3.15 + rng() * (2.6 + outer * 0.75));
        z = mouth[2] - 3.5 + rng() * (5.6 + outer * 0.9);
      } else {
        const angle = rng() * Math.PI * 2;
        const radius = 0.74 + Math.sqrt(rng()) * (0.42 + outer * 0.22);
        x = Math.cos(angle) * this.entranceSpec.width * radius;
        z = mouth[2] + 0.75 + Math.sin(angle) * this.entranceSpec.depth * radius;
      }
      return withRadius(x, z);
    };
    const foregroundCandidate = () => {
      // Concentrate dressing on the first few metres of approach, but split
      // it around a generous central walking line rather than filling it.
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (2.25 + Math.pow(rng(), 1.35) * 4.9);
      const z = mouth[2] - 8.0 + Math.sqrt(rng()) * 6.35;
      return withRadius(x, z);
    };
    const lipCandidate = () => {
      // This band is intentionally on the smooth entrance apron itself. The
      // earlier scatter began too far down the slope and left the most visible
      // few metres sterile.
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (0.18 + Math.pow(rng(), 0.82) * 4.55);
      const z = mouth[2] - 4.55 + Math.sqrt(rng()) * 4.08;
      return withRadius(x, z);
    };
    const validSite = (local, minNormal = 0.64, routeClearance = 1.9, minRadius = 0.70) => {
      // Taller dressing keeps a readable route; low, non-colliding grass gets
      // a much narrower clearance so the apron no longer reads as sterile.
      if (local.z < mouth[2] + 2.0 && Math.abs(local.x) < routeClearance) return null;
      if (local.radius < minRadius) return null;
      const surface = this.entranceSurfaceAtLocal(local.x, local.z);
      // A top-down implicit query can find the cave floor through the open
      // aperture. That is a valid walkable surface but not an exterior planting
      // site; placing a tuft there reads as floating/clipping vegetation when
      // viewed from outside. Keep dressing on the rim and shallow fold only.
      if (!surface || surface.normalY < minNormal || surface.worldY < 0.5
        || (surface.cover ?? 0) > 1.25) return null;
      const river = this.world.riverAt(surface.worldXZ.x, surface.worldXZ.z);
      if (river.wet && river.depth > 0.05) return null;
      return surface;
    };

    // Short inner-verge grass hides small surface seams; taller outer tufts
    // merge the authored entrance back into the world's existing grass field.
    for (let i = 0; i < 790; i++) {
      const onLip = i >= 500;
      const local = i < 290 ? candidate(i > 205 ? 1.35 : 0.55)
        : i < 500 ? foregroundCandidate() : lipCandidate();
      const site = validSite(local, onLip ? 0.42 : 0.61, onLip ? 0.16 : 1.9, onLip ? 0.12 : 0.70);
      if (!site) continue;
      const baseDensity = GRASS_DENSITY[site.biome.id] || 0;
      if (rng() > (onLip ? Math.max(0.76, baseDensity) : baseDensity)) continue;
      const color = GRASS_COLORS[site.biome.id];
      if (!color) continue;
      const inner = Math.max(0, Math.min(1, (local.radius - 0.72) / 0.52));
      const s = onLip ? 0.28 + rng() * 0.28 : 0.30 + rng() * 0.31 + inner * 0.20;
      const height = onLip ? s * (0.52 + rng() * 0.42) : s * (0.48 + rng() * 0.48 + inner * 0.30);
      pushMatrix(grassMats, site.worldXZ.x, site.worldY - 0.070, site.worldXZ.z,
        (rng() - 0.5) * 0.20, rng() * Math.PI * 2, (rng() - 0.5) * 0.20,
        s, height, s);
      const value = 0.64 + rng() * 0.30;
      grassCols.push(color[0] * value, color[1] * value, color[2] * value);
    }

    // Biome recipes own the species choice: ferns and horsetails in damp
    // forests, flowers in meadow biomes, sparse dry plants in exposed sites.
    let saplings = 0, flowers = 0, lipFlowers = 0;
    const flowerCells = new Set([1, 2, 8, 9, 10, 11]);
    for (let i = 0; i < 246; i++) {
      const onLip = i >= 158;
      const local = i < 92 ? candidate(i > 64 ? 1.45 : 0.65)
        : i < 158 ? foregroundCandidate() : lipCandidate();
      const site = validSite(local, onLip ? 0.48 : 0.68, onLip ? 0.72 : 1.9, onLip ? 0.16 : 0.70);
      if (!site) continue;
      const recipe = UNDERSTORY_RECIPES[site.biome.id];
      const density = onLip ? Math.max(0.54, recipe?.density || 0) : Math.min(0.82, (recipe?.density || 0) * 1.12);
      if (!recipe || rng() > density) continue;
      const cell = choosePlant(recipe);
      if (cell === 4) {
        if (saplings >= 2 || local.radius < 1.02 || local.z < mouth[2] + 0.4) continue;
        saplings++;
      }
      if (flowerCells.has(cell)) {
        if (flowers >= 18 || (onLip && lipFlowers >= 6) || local.z > mouth[2] + 1.0) continue;
        flowers++;
        if (onLip) lipFlowers++;
      }
      const range = UNDERSTORY_SCALE[cell];
      const s = (range[0] + rng() * (range[1] - range[0]))
        * (onLip ? 0.48 + rng() * 0.20 : 0.68 + rng() * 0.24);
      pushMatrix(plantMats, site.worldXZ.x, site.worldY - 0.060, site.worldXZ.z,
        (rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08,
        s, s * (0.88 + rng() * 0.24), s);
      plantCells.push(cell);
      const value = 0.84 + rng() * 0.27;
      plantCols.push(value * (0.96 + rng() * 0.07), value, value * (0.93 + rng() * 0.10));
    }

    // A few small, half-buried rocks sit down the approach rather than on the
    // aperture. They help the planted foreground feel established without
    // being asked to conceal the actual terrain seam or narrowing the route.
    const boulderBuckets = new Map();
    if (this.library?.boulder?.length) {
      const boulderSites = [
        [-3.35, -5.8], [4.15, -5.0], [-5.45, -2.85],
      ];
      const tint = [1, 1, 1];
      for (let i = 0; i < boulderSites.length; i++) {
        const [baseX, dz] = boulderSites[i];
        const local = withRadius(
          baseX + (rng() - 0.5) * 0.65,
          mouth[2] + dz + (rng() - 0.5) * 0.6,
        );
        const site = validSite(local, 0.48);
        if (!site) continue;
        const variant = caveHash(this.anchor.seed, i, 0x4150524f) % this.library.boulder.length;
        if (!boulderBuckets.has(variant)) boulderBuckets.set(variant, { mats: [], colors: [] });
        const bucket = boulderBuckets.get(variant);
        const s = 0.46 + rng() * 0.34;
        pushMatrix(bucket.mats, site.worldXZ.x, site.worldY - s * (0.28 + rng() * 0.12), site.worldXZ.z,
          (rng() - 0.5) * 0.20, rng() * Math.PI * 2, (rng() - 0.5) * 0.20,
          s * (0.88 + rng() * 0.22), s * (0.72 + rng() * 0.25), s * (0.88 + rng() * 0.22));
        rockTint(site.biome.id, rng, tint);
        bucket.colors.push(tint[0], tint[1], tint[2]);
      }
    }

    if (grassMats.length) {
      const grass = buildGrassMesh({
        matrices: new Float32Array(grassMats),
        colors: new Float32Array(grassCols),
      }, { caveDressing: true });
      grass.name = 'cave-entrance-grass';
      ecology.add(grass);
    }
    if (plantMats.length) {
      const plants = buildUnderstoryMesh({
        matrices: new Float32Array(plantMats),
        cells: new Float32Array(plantCells),
        colors: new Float32Array(plantCols),
      }, { caveDressing: true });
      plants.name = 'cave-entrance-understory';
      ecology.add(plants);
    }
    if (boulderBuckets.size) {
      const buckets = [...boulderBuckets.entries()].map(([variant, bucket]) => ({
        type: 'boulder', variant,
        matrices: new Float32Array(bucket.mats),
        colors: new Float32Array(bucket.colors),
      }));
      const boulders = buildScatterGroup(this.library, buckets, { shadows: true });
      boulders.name = 'cave-approach-boulders';
      ecology.add(boulders);
    }
    ecology.visible = this.openingActive;
    this.scene.add(ecology);
    this.entranceEcology = ecology;
  }

  rebuildGraphDebug() {
    if (this.graphDebug) {
      this.group.remove(this.graphDebug);
      disposeObject(this.graphDebug);
    }
    const debugGroup = new THREE.Group();
    const nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const linePositions = [];
    for (const edge of this.graph.edges) linePositions.push(...nodeById.get(edge.a).p, ...nodeById.get(edge.b).p);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
      color: 0x63e6ff, transparent: true, opacity: 0.9, depthTest: false,
    }));
    lines.layers.set(CAVE_RENDER_LAYER); lines.renderOrder = 20; debugGroup.add(lines);
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(this.graph.nodes.flatMap((node) => node.p), 3));
    const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({
      color: 0xffd36b, size: 0.48, sizeAttenuation: true, depthTest: false,
    }));
    points.layers.set(CAVE_RENDER_LAYER); points.renderOrder = 21; debugGroup.add(points);
    debugGroup.visible = this.debug?.showGraph ?? false;
    this.group.add(debugGroup);
    this.graphDebug = debugGroup;
  }

  // The V4 region the player currently occupies: nearest region AABB in cave-
  // local space (zero distance inside a box; ties break on the lower id).
  currentRegionAt(localX, localY, localZ) {
    const regions = this.graph?.regions;
    if (!Array.isArray(regions) || !regions.length) return null;
    let best = null, bestDistance = Infinity;
    for (const region of regions) {
      const b = region.bounds;
      if (!b) continue;
      const dx = Math.max(b.minX - localX, 0, localX - b.maxX);
      const dy = Math.max(b.minY - localY, 0, localY - b.maxY);
      const dz = Math.max(b.minZ - localZ, 0, localZ - b.maxZ);
      const distance = Math.hypot(dx, dy, dz);
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && best && region.id < best.id)) {
        bestDistance = distance;
        best = region;
      }
    }
    return best;
  }

  desiredPlansAtPlayer() {
    const p = this.controls.rig.position;
    const localXZ = this.worldToLocalXZ(p.x, p.z);
    const localY = p.y - this.origin.y;
    const { ix, iy, iz } = caveChunkCoordinatesAt(
      Number(this.debug.resolution), localXZ.x, localY, localXZ.z,
    );
    // Caves in the current grammar are compact sparse networks (typically
    // 30–55 blocks). Keeping the complete planned shell resident costs only a
    // few MB and prevents a much more damaging failure: analytic collision can
    // continue through an unloaded render block, exposing white sky, surface
    // grass, or an apparent wall hole at the end/side of a long sightline.
    const current = this.currentRegionAt(localXZ.x, localY, localXZ.z);
    this.regionDebug = `${current ? current.id : '—'} · whole cave`;
    const cellKey = `${ix}_${iy}_${iz}:${current ? current.id : 'none'}`;
    const plans = [...this.plans]
      .sort((a, b) => ((a.ix - ix) ** 2 + (a.iy - iy) ** 2 + (a.iz - iz) ** 2)
        - ((b.ix - ix) ** 2 + (b.iy - iy) ** 2 + (b.iz - iz) ** 2));
    return { cellKey, plans };
  }

  updateStreaming(force = false) {
    if (!this.active) return;
    const { cellKey, plans } = this.desiredPlansAtPlayer();
    if (!force && cellKey === this.lastStreamCell) return;
    this.lastStreamCell = cellKey;
    this.desiredKeys = new Set(plans.map((plan) => plan.cacheKey));
    // Movement changes are allowed to overtake background audits. Old graph
    // jobs can never become useful after an anchor/rebuild epoch changes.
    this.jobQueue = this.jobQueue.filter((job) => job.epoch === this.generationEpoch);
    this.queuedKeys = new Set(this.jobQueue.map((job) => job.cacheKey));
    for (const cacheKey of [...this.attachedKeys]) {
      if (!this.desiredKeys.has(cacheKey)) this.detachEntry(cacheKey);
    }
    this.enqueuePlans(plans, 0);
    for (const plan of plans) {
      const entry = this.chunkCache.get(plan.cacheKey);
      if (entry) this.attachEntry(entry);
    }
    this.pumpWorkers();
    this.updateMetrics();
  }

  enqueuePlans(plans, priorityBase = 0) {
    plans.forEach((plan, index) => {
      if (this.chunkCache.has(plan.cacheKey) || this.pendingKeys.has(plan.cacheKey) || this.queuedKeys.has(plan.cacheKey)) return;
      this.queuedKeys.add(plan.cacheKey);
      this.jobQueue.push({
        plan, cacheKey: plan.cacheKey, graphHash: this.graphSignature,
        graph: this.graph, epoch: this.generationEpoch,
        resolution: Number(this.debug.resolution),
        priority: priorityBase + index,
      });
    });
    this.jobQueue.sort((a, b) => a.priority - b.priority);
  }

  pumpWorkers() {
    for (const slot of this.workers) {
      if (slot.busy || this.jobQueue.length === 0) continue;
      const job = this.jobQueue.shift();
      this.queuedKeys.delete(job.cacheKey);
      if (this.chunkCache.has(job.cacheKey) || this.pendingKeys.has(job.cacheKey)) continue;
      const requestId = this.nextRequestId++;
      slot.busy = true; slot.requestId = requestId;
      this.pendingKeys.set(job.cacheKey, requestId);
      this.requestById.set(requestId, job);
      slot.worker.postMessage({
        type: 'mesh', requestId, cacheKey: job.cacheKey,
        graphHash: job.graphHash, graph: job.graph, epoch: job.epoch,
        resolution: job.resolution, plan: job.plan,
        // Positional coordinates remain for compatibility with an old worker
        // during hot reload; the signed explicit plan is authoritative.
        ix: job.plan.ix, iy: job.plan.iy, iz: job.plan.iz,
      });
    }
  }

  onWorkerMessage(slot, result) {
    slot.busy = false;
    const job = this.requestById.get(result.requestId);
    this.requestById.delete(result.requestId);
    if (job) this.pendingKeys.delete(job.cacheKey);
    if (!job) { this.pumpWorkers(); return; }
    const staleEpoch = job.epoch !== this.generationEpoch
      || job.graphHash !== this.graphSignature
      || result.epoch !== job.epoch;
    if (staleEpoch) { this.pumpWorkers(); return; }
    if (result.graphHash !== job.graphHash) {
      this.workerErrors++;
      this.debug.state = `worker graph verification failed · ${result.actualGraphHash || 'no hash'}`;
      this.updateMetrics();
      this.pumpWorkers();
      return;
    }
    if (result.type === 'mesh-error') {
      this.workerErrors++;
      this.debug.state = `worker mesh error · ${result.message}`;
      this.pumpWorkers();
      return;
    }

    let mesh = null;
    if (result.positions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
      if (result.surfaces?.length) {
        // Phase-A semantics: [wet, sediment, mineral, fracture], normalized
        geometry.setAttribute('aSurface', new THREE.BufferAttribute(result.surfaces, 4, true));
      }
      geometry.computeBoundingSphere();
      // The terrain-minus-cave collar replaces the generic rounded portal in
      // entrance blocks. Those blocks use the full handoff-depth clip that
      // produced the approved natural mouth; ordinary blocks never clip by Z,
      // so distant passages that curve back toward the entrance stay intact.
      mesh = new THREE.Mesh(
        geometry,
        job.plan.entrance ? this.entranceStreamMaterial : this.material,
      );
      mesh.name = `cave-block-${result.key}`;
      mesh.layers.set(CAVE_RENDER_LAYER);
      // Surface and cave coexist at the threshold. The preview clipping in the
      // cave material hides the exterior half of the open SDF tube, leaving
      // the real streamed interior visible through the terrain aperture.
      mesh.layers.enable(0);
    }
    const entry = {
      cacheKey: job.cacheKey, graphHash: job.graphHash,
      resolution: job.resolution, key: result.key,
      entrance: !!job.plan.entrance,
      ix: result.ix, iy: result.iy, iz: result.iz,
      bounds: result.bounds || job.plan.bounds,
      mesh, triangles: result.triangles, bytes: result.bytes,
      generationMs: result.generationMs, faceHashes: result.faceHashes,
      audit: result.audit, lastUsed: performance.now(),
    };
    this.chunkCache.set(job.cacheKey, entry);
    if (job.graphHash === this.graphSignature && job.resolution === Number(this.debug.resolution) && this.desiredKeys.has(job.cacheKey)) {
      this.attachEntry(entry);
    }
    this.evictCache();
    this.updateMetrics();
    if (this.auditPending && this.auditPending.graphHash === this.graphSignature && this.allCurrentPlansCached()) this.finishAudit();
    this.syncEntranceOpening();
    this.pumpWorkers();
  }

  attachEntry(entry) {
    entry.lastUsed = performance.now();
    if (this.attachedKeys.has(entry.cacheKey)) return;
    if (entry.mesh) this.group.add(entry.mesh);
    this.attachedKeys.add(entry.cacheKey);
  }

  detachEntry(cacheKey) {
    const entry = this.chunkCache.get(cacheKey);
    if (entry?.mesh) this.group.remove(entry.mesh);
    this.attachedKeys.delete(cacheKey);
  }

  detachAll() {
    for (const cacheKey of [...this.attachedKeys]) this.detachEntry(cacheKey);
    this.desiredKeys.clear();
    this.lastStreamCell = '';
  }

  evictCache() {
    const limit = this.auditPending?.graphHash === this.graphSignature
      ? Math.max(CACHE_LIMIT, this.plans.length)
      : CACHE_LIMIT;
    if (this.chunkCache.size <= limit) return;
    const candidates = [...this.chunkCache.values()]
      .filter((entry) => !this.attachedKeys.has(entry.cacheKey) && !this.desiredKeys.has(entry.cacheKey))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.chunkCache.size > limit && candidates.length) {
      const entry = candidates.shift();
      entry.mesh?.geometry.dispose();
      this.chunkCache.delete(entry.cacheKey);
    }
  }

  currentEntries() {
    const prefix = `${this.graphSignature}:${Number(this.debug.resolution)}:`;
    return [...this.chunkCache.values()].filter((entry) => entry.cacheKey.startsWith(prefix));
  }

  updateMetrics() {
    const entries = this.currentEntries();
    const triangles = entries.reduce((sum, entry) => sum + entry.triangles, 0);
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const workerMs = entries.reduce((sum, entry) => sum + entry.generationMs, 0);
    const currentPending = [...this.pendingKeys.keys()].filter((key) => key.startsWith(`${this.graphSignature}:${Number(this.debug.resolution)}:`)).length;
    const attachedSurface = [...this.attachedKeys].filter((key) => this.chunkCache.get(key)?.mesh).length;
    const cacheLimit = this.auditPending?.graphHash === this.graphSignature
      ? Math.max(CACHE_LIMIT, this.plans.length)
      : CACHE_LIMIT;
    const regionLabel = this.regionDebug ? ` · region ${this.regionDebug}` : '';
    this.debug.streaming = `${this.attachedKeys.size}/${this.desiredKeys.size} ready · ${attachedSurface} surfaces · ${currentPending} pending · ${this.chunkCache.size}/${cacheLimit} LRU${regionLabel}`;
    const entranceTiming = this.entranceBuildMs > 0
      ? ` · lip ${this.entranceBuildMs.toFixed(0)} ms (${this.entranceMeshMs.toFixed(0)} mesh)`
      : '';
    this.debug.metrics = `${entries.length}/${this.plans.length} blocks · ${triangles.toLocaleString()} tris · ${(bytes / 1048576).toFixed(2)} MB · ${workerMs.toFixed(0)} ms worker${entranceTiming}`;
    if (this.active && currentPending === 0 && !this.jobQueue.some((job) => job.graphHash === this.graphSignature)) {
      this.debug.state = this.inside ? 'inside — collision active' : 'approach — entrance ready';
    }
  }

  entranceReady() {
    // Do not open the terrain aperture onto a partially rendered network. The
    // complete sparse cave is small enough to prepare as one visual contract.
    return this.plans.length > 0 && this.plans.every((plan) => this.chunkCache.has(plan.cacheKey));
  }

  interiorReadyAt(local) {
    const coordinates = caveChunkCoordinatesAt(
      Number(this.debug.resolution), local.x, local.y, local.z,
    );
    const plan = this.planByKey.get(caveChunkKey(coordinates.ix, coordinates.iy, coordinates.iz));
    // A location outside every conservative primitive AABB is solid rock, so
    // the analytic collider may reject it without waiting for render geometry.
    return !plan || this.chunkCache.has(plan.cacheKey);
  }

  entranceThroatEngagedAt(local, engageDistance = 0.18) {
    return entranceThroatEngaged(
      this.entranceSpec?.boundedCaveAirAtLocal,
      local,
      { engageDistance },
    );
  }

  outdoorSurfaceLocalY(localX, localZ) {
    const worldXZ = this.localToWorldXZ(localX, localZ);
    const worldY = this.terrain?.caveSurfaceHeightAt(worldXZ.x, worldXZ.z, this.entranceSpec)
      ?? this.world.height(worldXZ.x, worldXZ.z);
    return worldY - this.origin.y;
  }

  recoverOutdoorStateIfNeeded(local, throatEngaged = this.entranceThroatEngagedAt(local)) {
    if (!entranceShouldRecoverOutdoor(
      this.inside,
      throatEngaged,
      local.y,
      this.outdoorSurfaceLocalY(local.x, local.z),
    )) return false;
    this.setInside(false);
    return true;
  }

  entranceFloorHeightWorld(worldX, worldZ) {
    const local = this.worldToLocalXZ(worldX, worldZ);
    const outdoor = this.terrain?.caveSurfaceHeightAt(worldX, worldZ, this.entranceSpec)
      ?? this.world.height(worldX, worldZ);
    const referenceLocalY = this.controls.rig.position.y - this.origin.y;
    // Roof and side approaches stay ordinary terrain. Previously every X/Z
    // point inside the collar footprint searched the implicit entrance for a
    // floor, so a walker above the aperture could snap toward a buried floor
    // or freeze when no crossing was close enough.
    if (!this.inside && !this.entranceThroatEngagedAt({
      x: local.x, y: referenceLocalY, z: local.z,
    })) return outdoor;
    const mouthZ = this.graph.entrance.mouth[2];
    const useTerrainSeam = entrancePortalNear(this.entranceImplicitBounds, local, {
      xMargin: 0,
      zMargin: 0,
    })
      && (!this.inside || local.z <= mouthZ + 4.0);
    if (useTerrainSeam) {
      const entranceFloor = this.entranceFloorLocalNear(
        local.x, local.z, referenceLocalY, 0.70, 1.45,
      );
      if (entranceFloor !== null) return this.origin.y + entranceFloor;
    }
    if (!this.inside) return outdoor;
    const caveFloor = this.field.floorHeightNear(local.x, local.z, referenceLocalY, 0.65, 1.4);
    if (caveFloor === null) return this.inside ? this.controls.rig.position.y : outdoor;
    return this.origin.y + caveFloor;
  }

  resolveMovement(position, previous) {
    const from = this.worldToLocal({ x: previous.x, y: previous.y, z: previous.z });
    const target = this.worldToLocal(position);
    const cachedFloor = this.collisionFloorLocal;
    const collisionReferenceY = cachedFloor
      && Math.hypot(from.x - cachedFloor.x, from.z - cachedFloor.z) < 0.75
      ? cachedFloor.y
      : from.y;
    const mouthZ = this.graph.entrance.mouth[2];
    const entranceBounds = this.entranceImplicitBounds;
    // X/Z proximity is insufficient: the same footprint includes the hillside
    // above the mouth and its side banks. Sample the cave-only throat at torso
    // height so outdoor air over the roof cannot opt into cave collision.
    const fromThroat = this.entranceThroatEngagedAt(from, 0.22);
    const targetThroat = this.entranceThroatEngagedAt(target, 0.22);
    if (this.recoverOutdoorStateIfNeeded(from, fromThroat)) {
      this.collisionFloorLocal = null;
      return {
        acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z),
        blocked: false,
        recoveredOutdoor: true,
      };
    }
    const transition = entranceTransitionState(entranceBounds, this.inside, from, target, {
      fromThroat, targetThroat,
    });
    // While still outdoors, terrain collision remains authoritative everywhere
    // outside the compact transition volume. Without this guard, the buried
    // cave SDF could incorrectly block someone simply walking over/around it.
    if (transition.outdoorAuthoritative) {
      this.collisionFloorLocal = null;
      return { acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z), blocked: false };
    }
    // Do not let the analytic collider lead the player into geometry that has
    // not arrived yet. The barrier disappears as soon as every throat block is
    // cached, normally before the player reaches the arch.
    if (transition.active && !this.entranceReady() && target.z > mouthZ - 0.5) {
      position.x = previous.x; position.z = previous.z;
      return { acceptedDistance: 0, blocked: true };
    }
    if (this.inside && !this.interiorReadyAt(target)) {
      position.x = previous.x; position.z = previous.z;
      this.updateStreaming(true);
      return { acceptedDistance: 0, blocked: true, streaming: true };
    }
    const collisionOptions = {
      maxSubstep: 0.20, radius: CAVE_PLAYER_RADIUS, height: CAVE_PLAYER_HEIGHT,
      crouchHeight: CAVE_PLAYER_CROUCH_HEIGHT,
      cameraField: this.visualCameraField,
      skin: CAVE_PLAYER_SKIN, maxStep: 0.50, maxDrop: 1.05,
    };
    // The terrain-minus-cave collider is only needed across the actual portal.
    // The collar remains visually authored for 25m, but once safely inside we
    // use the cave's calmer collision SDF instead of carrying render-detail
    // noise deep into the route. On exit, crossing back into this band restores
    // the exact terrain seam before the portal state changes.
    const movementNearPortal = entrancePortalNear(entranceBounds, from)
      || entrancePortalNear(entranceBounds, target);
    const useTerrainSeam = movementNearPortal && transition.active && (!this.inside
      || Math.min(from.z, target.z) <= mouthZ + 4.0);
    const resolved = useTerrainSeam
      ? this.resolveEntranceHorizontal(from.x, from.z, target.x, target.z, collisionReferenceY, collisionOptions)
      : this.field.resolveHorizontal(from.x, from.z, target.x, target.z, collisionReferenceY, collisionOptions);
    const colliderLabel = useTerrainSeam ? 'portal' : 'interior';
    const worldXZ = this.localToWorldXZ(resolved.x, resolved.z);
    position.x = worldXZ.x;
    position.z = worldXZ.z;
    if (Number.isFinite(resolved.floorY)) {
      this.collisionFloorLocal = { x: resolved.x, z: resolved.z, y: resolved.floorY };
      // Let controls ground against the exact floor branch collision accepted
      // this frame. Re-querying the SDF at a converging shelf could select the
      // other crossing and strand the next frame between two valid surfaces.
      resolved.floorHeight = this.origin.y + resolved.floorY;
    }
    // PlayerControls eases back to standing in open space, but ducks
    // immediately when the resolver reports low headroom so the rendered eye
    // never clips through the same keyhole ceiling we just accepted.
    resolved.eyeHeight = Math.max(1.05, Math.min(1.70,
      (resolved.stanceHeight ?? CAVE_PLAYER_HEIGHT) - 0.02));
    const requested = Math.hypot(target.x - from.x, target.z - from.z);
    if (resolved.crouched) {
      const assist = resolved.forgiving ? ' + route assist' : '';
      this.debug.collision = `${colliderLabel} · ducking ${resolved.stanceHeight.toFixed(2)}m${assist} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (resolved.recovered || resolved.forgiving) {
      this.debug.collision = `${colliderLabel} · ${resolved.recovered ? 'recovered' : 'route assist'} · ${resolved.blockReason || 'clear'} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (resolved.blocked && requested > 1e-4) {
      const stuck = resolved.acceptedDistance < Math.min(0.01, requested * 0.1);
      this.debug.collision = `${colliderLabel} · ${stuck ? 'STUCK' : 'contact'} · ${resolved.blockReason || 'body'} · ${resolved.x.toFixed(1)}, ${resolved.z.toFixed(1)}`;
    } else if (requested > 1e-4) {
      // Keep the last contact visible after the player releases a movement
      // key.  Clearing this every idle frame made the useful STUCK location
      // disappear before it could be read from the debug panel.
      this.debug.collision = `${colliderLabel} · clear`;
    }
    return resolved;
  }

  setInside(value) {
    const inside = !!value;
    if (inside === this.inside) return;
    this.inside = inside;
    // A real hole allows ordinary depth to resolve both worlds. Keeping the
    // surface layer enabled means the player can look back out naturally.
    this.controls.camera.layers.enable(0);
    this.controls.camera.layers.enable(CAVE_RENDER_LAYER);
    // Keep the analytic entrance tube hidden in both directions; the custom
    // throat is the visible surface all the way to the first chamber.
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.debug.state = inside ? 'inside — collision active' : 'approach — surface transition';
  }

  updatePortalTransition() {
    if (!this.active) return;
    const local = this.worldToLocal(this.controls.rig.position);
    const mouthZ = this.graph.entrance.mouth[2];
    const bounds = this.entranceImplicitBounds;
    // A terrain-fitted long cave may bend back across the mouth's local Z
    // plane while remaining tens of metres sideways and deep underground.
    // Portal state is meaningful only inside the compact entrance envelope.
    if (bounds && !entrancePortalNear(bounds, local)) return;
    const throatEngaged = this.entranceThroatEngagedAt(local, 0.04);
    // Correct any stale/misclassified state before asking the Z-plane
    // hysteresis to update it. This is the actual escape hatch for a player
    // already stranded on the roof or side by an earlier portal flip.
    if (this.recoverOutdoorStateIfNeeded(local, throatEngaged)) return;
    // Entering requires real overlap with the cave throat. Exiting remains
    // available to an existing interior occupant throughout the portal band.
    if (!this.inside && !throatEngaged) return;
    this.setInside(cavePortalInside(this.inside, local.z, mouthZ, this.entranceReady()));
  }

  allCurrentPlansCached() {
    return this.plans.every((plan) => this.chunkCache.has(plan.cacheKey));
  }

  audit(checkDeterminism = false) {
    this.auditPending = { graphHash: this.graphSignature, checkDeterminism };
    if (!this.allCurrentPlansCached()) {
      this.debug.auditResult = `loading ${this.plans.length - this.currentEntries().length} blocks for seam audit…`;
      this.enqueuePlans(this.plans, 10000);
      this.pumpWorkers();
      return { pending: true };
    }
    return this.finishAudit();
  }

  finishAudit() {
    const entries = new Map(this.currentEntries().map((entry) => [entry.key, entry]));
    let seamPairs = 0, seamMismatches = 0, finite = true, errorSum = 0, errorSamples = 0;
    for (const plan of this.plans) {
      const entry = entries.get(plan.key);
      if (!entry) continue;
      finite = finite && entry.audit.finite;
      errorSum += entry.audit.meanSurfaceError * entry.audit.samples;
      errorSamples += entry.audit.samples;
      for (const [dx, dy, dz, face, opposite] of [
        [1, 0, 0, 'xmax', 'xmin'], [0, 1, 0, 'ymax', 'ymin'], [0, 0, 1, 'zmax', 'zmin'],
      ]) {
        const neighbor = entries.get(caveChunkKey(plan.ix + dx, plan.iy + dy, plan.iz + dz));
        if (!neighbor) continue;
        seamPairs++;
        if (entry.faceHashes[face] !== neighbor.faceHashes[opposite]) seamMismatches++;
      }
    }
    const meanError = errorSamples ? errorSum / errorSamples : 0;
    const deterministic = !this.auditPending?.checkDeterminism || this.field.hashField(24) === this.fieldBaseline;
    const passed = this.graph.validation.valid && finite && seamMismatches === 0 && meanError < 0.05 && deterministic && this.workerErrors === 0;
    const report = { passed, seamPairs, seamMismatches, finite, meanError, deterministic, graphValid: this.graph.validation.valid };
    this.debug.auditResult = `${passed ? 'PASS' : 'FAIL'} · ${seamPairs} seams/${seamMismatches} mismatches · error ${meanError.toFixed(3)}m${deterministic ? ' · deterministic' : ''}`;
    this.auditPending = null;
    return report;
  }

  rebuild() {
    const wasActive = this.active;
    this.generationEpoch++;
    this.auditPending = null;
    this.debug.auditResult = '—';
    this.setEntranceOpening(false);
    this.entranceBuildMs = 0;
    this.entranceMeshMs = 0;
    this.detachAll();
    this.jobQueue.length = 0;
    this.queuedKeys.clear();
    this.configurePlans();
    this.refreshDebugReadout();
    if (wasActive) {
      this.streamStartedAt = performance.now();
      this.updateStreaming(true);
      this.debug.state = 'active — streaming rebuilt blocks';
    }
  }

  deactivate() {
    this.setEntranceOpening(false);
    this.active = false;
    this.inside = false;
    this.collisionFloorLocal = null;
    this.group.visible = false;
    this.controls.camera.layers.disable(CAVE_RENDER_LAYER);
    this.controls.camera.layers.enable(0);
    this.controls.camera.near = this.surfaceCameraNear;
    this.controls.camera.updateProjectionMatrix();
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.controls.setEnvironment(null);
    setCaveEntranceVisual(null);
    this.detachAll();
  }

  // Memoized per-cell anchor lookup for walk-up discovery. Cells are pure
  // functions of the world, so each is probed once and remembered (null too).
  // The landmark-clearance filter matches collectAnchors, keeping discovered
  // caves out of landmark halos.
  discoveryAnchorsNear(px, pz, radius) {
    this._anchorMemo = this._anchorMemo || new Map();
    const out = [];
    const c0x = Math.floor((px - radius) / CAVE_CELL_SIZE);
    const c1x = Math.floor((px + radius) / CAVE_CELL_SIZE);
    const c0z = Math.floor((pz - radius) / CAVE_CELL_SIZE);
    const c1z = Math.floor((pz + radius) / CAVE_CELL_SIZE);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = `${cx}_${cz}`;
        let anchor;
        if (this._anchorMemo.has(key)) {
          anchor = this._anchorMemo.get(key);
        } else {
          anchor = caveAnchorForCell(this.world, cx, cz, this.world.seed);
          if (anchor && anchor.valid) {
            landmarksAround(this.world, anchor.x, anchor.z, this.world.seed, 180, this.landmarkScratch);
            const blocked = this.landmarkScratch.some((landmark) => {
              const dx = anchor.x - landmark.x, dz = anchor.z - landmark.z;
              const clearance = landmark.halo + 70;
              return dx * dx + dz * dz < clearance * clearance;
            });
            if (blocked) anchor = null;
          } else {
            anchor = null;
          }
          if (this._anchorMemo.size >= 768) {
            this._anchorMemo.delete(this._anchorMemo.keys().next().value);
          }
          this._anchorMemo.set(key, anchor);
        }
        if (!anchor) continue;
        const dx = anchor.x - px, dz = anchor.z - pz;
        if (dx * dx + dz * dz <= radius * radius) out.push(anchor);
      }
    }
    out.sort((a, b) => ((a.x - px) ** 2 + (a.z - pz) ** 2) - ((b.x - px) ** 2 + (b.z - pz) ** 2));
    return out;
  }

  // Walk-up discovery: called from the game's slow probe. When the player
  // wanders within reach of a valid anchor, that cave configures and activates
  // IN PLACE — its entrance appears in the hillside ahead — and releases with
  // hysteresis once they wander far enough away. Never swaps a cave out from
  // under someone inside it or mid-inspection.
  discoverNear(px, pz) {
    if (this.inside || this.inspection?.active) return;
    const movedX = px - (this._discoverX ?? 1e9), movedZ = pz - (this._discoverZ ?? 1e9);
    if (movedX * movedX + movedZ * movedZ < 80 * 80) return;
    this._discoverX = px;
    this._discoverZ = pz;
    const DISCOVER_RADIUS = 620, RELEASE_RADIUS = 900;
    const currentDistance = this.active && this.anchor
      ? Math.hypot(this.anchor.x - px, this.anchor.z - pz)
      : Infinity;
    // hold the active cave while the player is anywhere near it
    if (this.active && currentDistance < RELEASE_RADIUS * 0.7) return;
    const nearest = this.discoveryAnchorsNear(px, pz, DISCOVER_RADIUS)[0] ?? null;
    if (!nearest || Math.hypot(nearest.x - px, nearest.z - pz) > DISCOVER_RADIUS) {
      if (this.active && this._discovered && currentDistance > RELEASE_RADIUS) {
        this.deactivate();
        this._discovered = false;
        this.debug.state = 'released — wandered away';
      }
      return;
    }
    if (this.active && this.anchor?.id === nearest.id) return;
    // adopt into the candidates list so every debug flow stays coherent
    let index = this.anchorCandidates.findIndex((candidate) => candidate.id === nearest.id);
    if (index < 0) {
      this.anchorCandidates.unshift(nearest);
      index = 0;
    }
    this.deactivate();
    this.configureAnchor(index);
    this.activate();
    this._discovered = true;
  }

  // Bring the configured cave to life IN PLACE: streaming, collar, collision
  // environment — everything enter() does except moving the player. This is
  // what walk-up discovery uses, so a cave appears in the hillside you are
  // already looking at instead of teleporting you to it.
  activate() {
    this.active = true;
    this.inside = false;
    this.collisionFloorLocal = null;
    this.group.visible = true;
    this.controls.camera.layers.enable(0);
    this.controls.camera.layers.enable(CAVE_RENDER_LAYER);
    // A smaller near plane is scoped to cave activity. It prevents the near
    // plane corners from slicing through a wall during close turns without
    // sacrificing outdoor far-distance depth precision for the whole game.
    this.controls.camera.near = Math.min(this.surfaceCameraNear, 0.04);
    this.controls.camera.updateProjectionMatrix();
    this.entranceStreamMaterial.uniforms.uSurfacePreview.value = 1;
    this.setEntranceOpening(false);
    this.controls.setEnvironment(this.environment);
    setCaveEntranceVisual(this.entranceSpec);
    this.streamStartedAt = performance.now();
    this.debug.state = 'approach — streaming entrance blocks';
    this.updateStreaming(true);
  }

  enter() {
    this.activate();
    const mouth = this.graph.entrance.mouth;
    // Place the debug view on the dense replacement surface. On steep anchors
    // the coarse streamed heightfield can sit metres above world.height()
    // between vertices, putting a true-height teleport under a triangle.
    const spawnLocal = { x: mouth[0], z: mouth[2] - 5.8 };
    const worldXZ = this.localToWorldXZ(spawnLocal.x, spawnLocal.z);
    const floor = this.terrain?.renderedHeightAt(worldXZ.x, worldXZ.z)
      ?? this.world.height(worldXZ.x, worldXZ.z);
    this.controls.placeAt(worldXZ.x, floor, worldXZ.z);
    this.controls.yaw = Math.PI + this.anchor.yaw;
    this.controls.pitch = 0.12;
    return { anchor: this.anchor, graph: this.graph, floor };
  }

  exit() {
    this.deactivate();
    const x = this.anchor.x - this.anchor.inwardX * 14;
    const z = this.anchor.z - this.anchor.inwardZ * 14;
    this.controls.place(x, z);
    this.controls.yaw = Math.PI + this.anchor.yaw;
    this.debug.state = 'cached — surface';
  }

  previewSurface() {
    const result = this.enter();
    this.controls.pitch = -0.08;
    this.debug.state = 'approach — surface placement preview';
    return result;
  }

  stepAnchor(direction) {
    const wasActive = this.active;
    this.deactivate();
    this.configureAnchor(this.anchorIndex + direction);
    if (wasActive) return this.enter();
    return this.previewSurface();
  }

  stepChamber(direction) {
    if (!this.graph.chambers.length) return null;
    const count = this.graph.chambers.length;
    this.chamberIndex = ((this.chamberIndex + direction) % count + count) % count;
    if (!this.active) this.enter();
    const chamber = this.graph.chambers[this.chamberIndex];
    const referenceY = Number.isFinite(chamber.floorY)
      ? chamber.floorY + 0.08
      : chamber.c[1] - chamber.r[1] + 0.7;
    const floorY = this.field.floorHeightNear(
      chamber.c[0], chamber.c[2], referenceY, chamber.r[1] + 2, chamber.r[1] + 2,
    ) ?? this.field.floorHeight(chamber.c[0], chamber.c[2]);
    if (floorY === null) {
      this.debug.state = `chamber ${this.chamberIndex + 1} has no navigable floor`;
      return null;
    }
    const world = this.localToWorld(chamber.c[0], floorY, chamber.c[2]);
    this.controls.placeAt(world.x, world.y, world.z);
    this.collisionFloorLocal = { x: chamber.c[0], z: chamber.c[2], y: floorY };
    const nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const mainIndex = this.graph.mainPath.indexOf(chamber.nodeId);
    let lookNode = null;
    if (mainIndex >= 0) {
      const lookIndex = mainIndex < this.graph.mainPath.length - 1 ? mainIndex + 1 : mainIndex - 1;
      lookNode = nodeById.get(this.graph.mainPath[lookIndex]);
    } else {
      const edge = this.graph.edges.find((candidate) => candidate.a === chamber.nodeId || candidate.b === chamber.nodeId);
      lookNode = edge ? nodeById.get(edge.a === chamber.nodeId ? edge.b : edge.a) : null;
    }
    if (lookNode) {
      const target = this.localToWorld(lookNode.p[0], lookNode.p[1], lookNode.p[2]);
      this.controls.yaw = Math.atan2(-(target.x - world.x), -(target.z - world.z));
    } else {
      this.controls.yaw = Math.PI + this.anchor.yaw;
    }
    this.controls.pitch = 0.04;
    this.setInside(true);
    this.lastStreamCell = '';
    this.updateStreaming(true);
    this.debug.state = `chamber ${this.chamberIndex + 1}/${count} · ${chamber.role || chamber.kind || chamber.type || 'room'}`;
    return { chamber, floorY, world };
  }

  setWireframe(value) {
    this.debug.wireframe = !!value;
    this.material.wireframe = this.debug.wireframe;
    this.entranceStreamMaterial.wireframe = this.debug.wireframe;
    if (this.entranceMaterial) this.entranceMaterial.wireframe = this.debug.wireframe;
  }

  setSurfaceDebug(value) {
    this.debug.surfaceDebug = !!value;
    this.material.uniforms.uSurfaceDebug.value = this.debug.surfaceDebug ? 1 : 0;
    this.entranceStreamMaterial.uniforms.uSurfaceDebug.value = this.debug.surfaceDebug ? 1 : 0;
  }

  setShowGraph(value) {
    this.debug.showGraph = !!value;
    if (this.graphDebug) this.graphDebug.visible = this.debug.showGraph;
  }

  setEntranceOpening(open) {
    const shouldOpen = !!open;
    if (shouldOpen === this.openingActive) return;
    this.openingActive = shouldOpen;
    this.terrain?.setCaveCut(shouldOpen ? this.entranceSpec : null);
    if (this.entranceFacade) this.entranceFacade.visible = shouldOpen;
    if (this.entranceEcology) this.entranceEcology.visible = shouldOpen;
  }

  entranceTerrainReady() {
    if (!this.terrain?.hasTerrainAt) return true;
    const mouth = this.graph.entrance.mouth;
    return [
      [0, mouth[2] - 4.6], [-5.8, mouth[2] - 3.2], [5.8, mouth[2] - 3.2],
      [-5.8, mouth[2] + 5.5], [5.8, mouth[2] + 5.5],
      [-5.8, mouth[2] + 14.0], [5.8, mouth[2] + 14.0],
      [-5.8, mouth[2] + 21.0], [5.8, mouth[2] + 21.0], [0, mouth[2] + 24.0],
    ].every(([x, z]) => {
      const worldXZ = this.localToWorldXZ(x, z);
      return this.terrain.hasTerrainAt(worldXZ.x, worldXZ.z);
    });
  }

  syncEntranceOpening() {
    const shouldOpen = this.active && this.entranceReady() && this.entranceTerrainReady();
    const terrainSignature = shouldOpen
      ? (this.terrain?.caveTerrainSignature?.(this.entranceSpec.worldBounds) || 'procedural')
      : null;
    if (shouldOpen && (!this.openingActive || terrainSignature !== this.entranceTerrainSignature)) {
      // Build only once destination terrain exists, then refresh if adaptive
      // quality replaces one of the affected chunks at a different resolution.
      this.rebuildEntranceFacade();
      this.rebuildEntranceEcology();
      this.entranceTerrainSignature = terrainSignature;
    }
    this.setEntranceOpening(shouldOpen);
  }

  update(dt) {
    this.elapsed += dt;
    this.material.uniforms.uTime.value = this.elapsed;
    this.entranceStreamMaterial.uniforms.uTime.value = this.elapsed;
    if (this.active) {
      this.updateStreaming(false);
      this.syncEntranceOpening();
      if (this.inspection?.active) this.updateInspectionOrbit(dt);
      else this.updatePortalTransition();
    }
  }

  // 360° entrance inspection: a slow debug orbit that circles the mouth from
  // outside so the collar, aperture and silhouette can be reviewed from every
  // angle without walking. Drives the same rig/yaw/pitch that controls.update
  // writes, but runs AFTER it each frame, so the override always wins for the
  // rendered frame without any reparenting or input fighting.
  setInspection(value) {
    const on = !!value;
    if (on && !this.active) this.enter();
    this.inspection = this.inspection || {};
    if (on && !this.inspection.active) {
      // remember the player's framing so leaving inspection never jumps
      this.inspection.saved = {
        yaw: this.controls.yaw, pitch: this.controls.pitch,
        pos: this.controls.rig.position.clone(),
        camY: this.controls.camera.position.y,
      };
      const mouth = this.graph.entrance.mouth;
      this.inspection.target = this.localToWorld(mouth[0], mouth[1], mouth[2]);
      const aperture = Math.max(this.graph.entrance.rx, this.graph.entrance.ry);
      this.inspection.radius = aperture * 2.4 + 11;
      this.inspection.height = aperture * 1.2 + 4.5;
      this.inspection.angle = 0;
      this.inspection.speed = 0.32;         // radians / second
    } else if (!on && this.inspection.active && this.inspection.saved) {
      const s = this.inspection.saved;
      this.controls.yaw = s.yaw; this.controls.pitch = s.pitch;
      this.controls.rig.position.copy(s.pos);
      this.controls.camera.position.y = s.camY;
      this.inspection.saved = null;
    }
    this.inspection.active = on;
    this.debug.inspect = on;
    if (on) this.debug.state = 'inspection — entrance orbit';
  }

  updateInspectionOrbit(dt) {
    const insp = this.inspection;
    insp.angle += dt * insp.speed;
    const target = insp.target;
    const camX = target.x + Math.cos(insp.angle) * insp.radius;
    const camZ = target.z + Math.sin(insp.angle) * insp.radius;
    const camY = target.y + insp.height;
    const dx = target.x - camX, dz = target.z - camZ, dy = target.y - camY;
    const horizontal = Math.hypot(dx, dz);
    // controls' forward is the rig's local -Z; solve rig yaw + camera pitch to
    // aim it at the mouth (matches the sign conventions in controls.update)
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horizontal);
    this.controls.yaw = yaw;
    this.controls.pitch = pitch;
    this.controls.rig.position.set(camX, camY, camZ);
    this.controls.rig.rotation.y = yaw;
    this.controls.camera.rotation.set(pitch, 0, 0);
    this.controls.camera.position.y = 0;   // orbit uses rig Y directly; cancel eye/bob
  }
}
