// Main-thread lifecycle for distant terrain/water tiles.
//
// Geometry is prepared by distantwaterworker.js. This module only stages
// transferable arrays, optionally turns one tile at a time into renderer
// objects, and atomically swaps a complete stage into view.

import {
  DEFAULT_DISTANT_MAX_BYTES,
  DEFAULT_DISTANT_MAX_TILES,
  DEFAULT_DISTANT_RADIUS,
  DEFAULT_DISTANT_SAMPLE_STEP,
  DEFAULT_DISTANT_HINT_SAMPLE_STEP,
  DEFAULT_DISTANT_TILE_SIZE,
  DISTANT_WATER_VERSION,
  validateDistantWaterOptions,
} from './distantwaterplan.mjs';

function workerForDefault() {
  if (typeof Worker !== 'function') throw new Error('Distant water requires a browser Worker');
  return new Worker(new URL('./distantwaterworker.js?v=distant-water1', import.meta.url), { type: 'module' });
}

function planPayload(request) {
  let value = request.waterPlansJSON ?? request.plansJSON;
  if (value === undefined && request.waterField) value = request.waterField.workerPlansJSON ?? request.waterField.plans;
  if (value === undefined) value = request.waterPlans;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value;
  return JSON.stringify(value);
}

function tileBytes(tile) {
  const seen = new Set(), visit = value => {
    if (!value || typeof value !== 'object') return 0;
    if (ArrayBuffer.isView(value)) {
      if (seen.has(value.buffer)) return 0;
      seen.add(value.buffer); return value.byteLength;
    }
    return Object.values(value).reduce((sum, child) => sum + visit(child), 0);
  };
  return visit(tile);
}

function finite(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }

export class DistantWaterLandscape {
  constructor(scene = null, {
    workerFactory = workerForDefault,
    renderer = null,
    three = null,
    terrainMaterial = null,
    waterMaterial = null,
  } = {}) {
    this.scene = scene;
    this.renderer = renderer || (three && scene
      ? createDistantWaterThreeRenderer(three, { scene, terrainMaterial, waterMaterial }) : null);
    this.workerFactory = workerFactory;
    this.worker = null;
    this.sequence = 0;
    this.pending = null;
    this.active = null;
    this.ready = null;
    this.debug = {
      state: 'idle', requestId: 0, completed: 0, total: 0, bytes: 0, maxBytes: 0,
      tileCount: 0, waterTiles: 0, waterTriangles: 0, waterArea: 0,
      unsupportedWaterSamples: 0, waterPlanHash: null, lastError: null,
    };
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = this.workerFactory();
    if (!this.worker || typeof this.worker.postMessage !== 'function') {
      throw new Error('Distant water worker factory returned an invalid worker');
    }
    this.worker.onmessage = event => this._receive(event.data || {});
    this.worker.onerror = event => this._fail(event?.message || 'Distant water worker failed');
    return this.worker;
  }

  // Use an accepted WaterField's workerPlansJSON whenever possible. That wire
  // payload was validated before publication and avoids a second main-thread
  // clone of a large regional graph.
  attachWorld(world, options = {}) {
    if (!world || !Number.isSafeInteger(world.seed)) throw new TypeError('Invalid distant water world');
    return this.prepare({ ...options, seed: world.seed, waterField: world.waterField,
      generationVersion: world.generationVersion });
  }

  prepare({
    seed,
    waterPlansJSON,
    waterPlans,
    waterField,
    center = { x: 0, z: 0 },
    radius = DEFAULT_DISTANT_RADIUS,
    tileSize = DEFAULT_DISTANT_TILE_SIZE,
    sampleStep = DEFAULT_DISTANT_SAMPLE_STEP,
    hintSampleStep = DEFAULT_DISTANT_HINT_SAMPLE_STEP,
    maxTiles = DEFAULT_DISTANT_MAX_TILES,
    maxBytes = DEFAULT_DISTANT_MAX_BYTES,
    generationVersion = 3,
  } = {}) {
    if (!Number.isSafeInteger(seed)) throw new TypeError('Distant water requires a safe integer seed');
    const options = validateDistantWaterOptions({ center, radius, tileSize, sampleStep, maxTiles, maxBytes });
    this.cancel('superseded');
    const id = ++this.sequence;
    const worker = this._ensureWorker();
    const encoded = planPayload({ waterPlansJSON, waterPlans, waterField });
    const pending = {
      id, options, seed, generationVersion, tiles: new Map(), bytes: 0,
      rendererStage: this.renderer?.beginStage?.({ id, bounds: options.bounds }) || null,
      resolve: null, reject: null, settled: false,
    };
    this.pending = pending;
    this.debug = { ...this.debug, state: 'preparing', requestId: id, completed: 0,
      total: 0, bytes: 0, maxBytes, tileCount: 0, waterTiles: 0, waterTriangles: 0,
      waterArea: 0, unsupportedWaterSamples: 0, lastError: null };
    const promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    try {
      worker.postMessage({ type: 'distant-water-prepare', id, seed, waterPlansJSON: encoded,
        center, radius, tileSize, sampleStep, hintSampleStep, maxTiles, maxBytes, generationVersion });
    } catch (error) {
      this._fail(error?.message || String(error));
    }
    return promise;
  }

  _receive(message) {
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    if (message.type === 'distant-water-progress') {
      if (!Number.isInteger(message.completed) || message.completed < 0
        || (message.total !== undefined && (!Number.isInteger(message.total) || message.total < message.completed))) return;
      pending.total = message.total ?? pending.total;
      this.debug.completed = message.completed; this.debug.total = pending.total;
      if (Number.isFinite(message.bytes)) this.debug.bytes = message.bytes;
      this.debug.waterPlanHash = message.waterPlanHash || this.debug.waterPlanHash;
      return;
    }
    if (message.type === 'distant-water-tile') {
      try {
        if (!message.tile || message.tile.version !== DISTANT_WATER_VERSION) throw new Error('Distant tile version mismatch');
        const bytes = Number.isFinite(message.bytes) ? message.bytes : tileBytes(message.tile);
        if (bytes > pending.options.maxBytes) throw new Error('Distant landscape memory budget exceeded');
        pending.bytes = Math.max(pending.bytes, bytes);
        pending.tiles.set(message.tile.key, message.tile);
        this.renderer?.addTile?.(pending.rendererStage, message.tile);
        this.debug.completed = Number.isInteger(message.index) ? message.index + 1 : this.debug.completed;
        this.debug.total = message.total ?? this.debug.total;
        this.debug.bytes = pending.bytes;
        this.debug.tileCount = pending.tiles.size;
        if (message.waterPlanHash) {
          if (this.debug.waterPlanHash && this.debug.waterPlanHash !== message.waterPlanHash) {
            throw new Error('Distant water plan changed during staging');
          }
          this.debug.waterPlanHash = message.waterPlanHash;
        }
      } catch (error) { this._fail(error?.message || String(error)); }
      return;
    }
    if (message.type === 'distant-water-cancelled') {
      this._fail('Distant landscape preparation cancelled', true);
      return;
    }
    if (message.type === 'distant-water-error') {
      this._fail(message.error || 'Distant landscape worker failed');
      return;
    }
    if (message.type !== 'distant-water-ready') return;
    const stats = message.stats || {};
    try {
      if (pending.tiles.size !== stats.tileCount) throw new Error('Incomplete distant landscape stage');
      const stage = {
        version: DISTANT_WATER_VERSION, id: pending.id, seed: pending.seed,
        bounds: message.bounds || pending.options.bounds,
        tileSize: pending.options.tileSize, sampleStep: pending.options.sampleStep,
        tiles: pending.tiles, renderStage: pending.rendererStage,
        waterPlanHash: message.waterPlanHash || this.debug.waterPlanHash || null,
        stats: { ...stats, bytes: pending.bytes },
      };
      this.renderer?.commit?.(pending.rendererStage, this.active?.renderStage || null);
      this.active = stage; this.ready = stage; this.pending = null;
      this.debug = { ...this.debug, state: 'ready', completed: stats.tileCount ?? pending.tiles.size,
        total: stats.tileCount ?? pending.tiles.size, bytes: pending.bytes,
        tileCount: pending.tiles.size, waterTiles: stats.waterTiles ?? 0,
        waterTriangles: stats.waterTriangles ?? 0, waterArea: stats.waterArea ?? 0,
        unsupportedWaterSamples: stats.unsupportedWaterSamples ?? 0,
        waterPlanHash: stage.waterPlanHash };
      this._resolve(pending, stage);
    } catch (error) { this._fail(error?.message || String(error)); }
  }

  _resolve(pending, value) {
    if (pending.settled) return;
    pending.settled = true; pending.resolve?.(value);
  }

  _fail(message, cancelled = false) {
    const pending = this.pending;
    if (!pending) {
      this.debug = { ...this.debug, state: cancelled ? 'cancelled' : 'error', lastError: message };
      return;
    }
    if (this.worker && typeof this.worker.postMessage === 'function') {
      try { this.worker.postMessage({ type: 'distant-water-cancel', id: pending.id }); } catch { /* worker is already gone */ }
    }
    this.renderer?.discard?.(pending.rendererStage);
    this.pending = null;
    this.debug = { ...this.debug, state: cancelled ? 'cancelled' : 'error', lastError: message };
    if (!pending.settled) {
      pending.settled = true;
      pending.reject?.(new Error(message));
    }
  }

  cancel(reason = 'Distant landscape preparation cancelled') {
    if (!this.pending) return false;
    this._fail(reason, reason.toLowerCase().includes('cancel'));
    return true;
  }

  update(view = {}) {
    let x = view?.x, z = view?.z, viewDistance = view?.viewDistance;
    if (typeof view === 'number') { x = view; z = arguments[1]; viewDistance = arguments[2]; }
    x = finite(x); z = finite(z);
    viewDistance = Number.isFinite(viewDistance) ? viewDistance : this.active?.bounds?.radius ?? DEFAULT_DISTANT_RADIUS;
    this.renderer?.update?.(this.active?.renderStage, { x, z, viewDistance });
    return this.active ? this.active.tiles.size : 0;
  }

  getObject3D() { return this.active?.renderStage?.group || this.active?.renderStage || null; }

  dispose() {
    this.cancel('Distant landscape disposed');
    if (this.worker?.terminate) this.worker.terminate();
    this.worker = null;
    this.renderer?.dispose?.(this.active?.renderStage);
    this.active = null; this.ready = null;
    this.debug = { ...this.debug, state: 'disposed' };
  }
}

export const DistantWater = DistantWaterLandscape;

// Optional Three.js renderer. It is dependency-injected so geometry/lifecycle
// tests do not need a browser or the application's import map.
export function createDistantWaterThreeRenderer(THREE, {
  scene,
  terrainMaterial = null,
  waterMaterial = null,
} = {}) {
  if (!THREE || !scene || typeof THREE.Group !== 'function') throw new TypeError('Three renderer requires THREE and scene');
  const terrainMat = terrainMaterial || new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xffffff });
  const waterMat = waterMaterial || new THREE.MeshLambertMaterial({ color: 0x2e6e8b, side: THREE.DoubleSide });
  if ('depthTest' in waterMat) waterMat.depthTest = true;
  if ('depthWrite' in waterMat) waterMat.depthWrite = true;
  const attr = (array, size) => new THREE.BufferAttribute(array, size);
  const disposeObject = object => {
    if (!object) return;
    object.traverse?.(child => { child.geometry?.dispose?.(); });
  };
  return {
    beginStage(meta) {
      const group = new THREE.Group();
      group.name = `distant-water-stage-${meta.id}`;
      return { group, tiles: new Map(), meta };
    },
    addTile(stage, tile) {
      if (!stage) return;
      const terrainGeometry = new THREE.BufferGeometry();
      terrainGeometry.setAttribute('position', attr(tile.terrain.positions, 3));
      terrainGeometry.setAttribute('normal', attr(tile.terrain.normals, 3));
      terrainGeometry.setAttribute('color', attr(tile.terrain.colors, 3));
      terrainGeometry.setIndex(attr(tile.terrain.indices, 1));
      const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMat);
      terrainMesh.name = `distant-terrain-${tile.key}`;
      terrainMesh.renderOrder = 0;
      terrainMesh.frustumCulled = false;

      const waterGeometry = new THREE.BufferGeometry();
      waterGeometry.setAttribute('position', attr(tile.water.positions, 3));
      waterGeometry.setAttribute('normal', attr(tile.water.normals, 3));
      waterGeometry.setIndex(attr(tile.water.indices, 1));
      const waterMesh = new THREE.Mesh(waterGeometry, waterMat);
      waterMesh.name = `distant-water-${tile.key}`;
      waterMesh.renderOrder = 1;
      waterMesh.frustumCulled = false;
      const object = new THREE.Group();
      object.name = `distant-tile-${tile.key}`;
      object.add(terrainMesh, waterMesh); stage.group.add(object);
      stage.tiles.set(tile.key, { key: tile.key, object,
        centerX: tile.x0 + tile.width * 0.5, centerZ: tile.z0 + tile.height * 0.5,
        tile });
    },
    commit(stage, previous) {
      if (!stage) return;
      scene.add(stage.group);
      if (previous?.group) { scene.remove(previous.group); disposeObject(previous.group); }
    },
    discard(stage) { if (stage?.group) disposeObject(stage.group); },
    update(stage, view) {
      if (!stage) return;
      const max = view.viewDistance + Math.hypot(stage.meta?.tileSize || DEFAULT_DISTANT_TILE_SIZE,
        stage.meta?.tileSize || DEFAULT_DISTANT_TILE_SIZE) * 0.75;
      for (const tile of stage.tiles.values()) {
        tile.object.visible = Math.hypot(tile.centerX - view.x, tile.centerZ - view.z) <= max;
      }
    },
    dispose(stage) {
      if (!stage?.group) return;
      scene.remove(stage.group); disposeObject(stage.group);
    },
  };
}
