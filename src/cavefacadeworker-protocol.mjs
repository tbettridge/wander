// Worker boundary for the terrain-derived cave entrance facade. The main
// thread samples the exact rendered terrain heightfield incrementally, then
// this worker performs handoff planning and the expensive marching-cubes pass.

import { planCaveEntranceHandoff, planCaveEntranceLateralBounds } from './cavefit.mjs';
import { createCaveField } from './cavefield.mjs';
import { caveGraphSignature } from './cavegen.mjs';
import { meshImplicitBox } from './cavemesh.mjs';
import { groundColor, World } from './world.js';

const HANDOFF_MIN = 24.5;
const HANDOFF_MAX = 44.0;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function smoothstep(min, max, value) {
  const t = clamp((value - min) / Math.max(1e-9, max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
function smoothMinimum(a, b, radius) {
  const h = clamp(0.5 + 0.5 * (b - a) / radius, 0, 1);
  return b + (a - b) * h - radius * h * (1 - h);
}

function validateSurface(surface) {
  if (!surface || !ArrayBuffer.isView(surface.heights)) {
    throw new Error('Cave facade job is missing its sampled terrain heights');
  }
  if (!Number.isInteger(surface.nx) || surface.nx < 2
    || !Number.isInteger(surface.nz) || surface.nz < 2
    || surface.heights.length !== surface.nx * surface.nz) {
    throw new Error('Cave facade sampled terrain dimensions are invalid');
  }
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) {
    if (!Number.isFinite(surface[key])) throw new Error(`Cave facade surface has invalid ${key}`);
  }
  if (surface.maxX <= surface.minX || surface.maxZ <= surface.minZ) {
    throw new Error('Cave facade sampled terrain bounds are empty');
  }
}

export function sampledTerrainHeight(surface, x, z) {
  const fx = clamp((x - surface.minX) / (surface.maxX - surface.minX), 0, 1)
    * (surface.nx - 1);
  const fz = clamp((z - surface.minZ) / (surface.maxZ - surface.minZ), 0, 1)
    * (surface.nz - 1);
  const ix = Math.min(surface.nx - 2, Math.floor(fx));
  const iz = Math.min(surface.nz - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const row = iz * surface.nx;
  const a = surface.heights[row + ix];
  const b = surface.heights[row + ix + 1];
  const c = surface.heights[row + surface.nx + ix];
  const d = surface.heights[row + surface.nx + ix + 1];
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

function srgbToLinear(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const INNER = [srgbToLinear(0x20), srgbToLinear(0x29), srgbToLinear(0x23)];
const SOIL = [srgbToLinear(0x51), srgbToLinear(0x46), srgbToLinear(0x38)];

function decorateFacade(raw, { graph, field, surface, render, cutMinAlong }) {
  if (!render || !Number.isFinite(render.worldSeed)
    || !Array.isArray(render.origin) || render.origin.length !== 3
    || !Number.isFinite(render.yaw) || !render.supportLocalBounds) {
    throw new Error('Cave facade job is missing its render-space transform');
  }
  const world = new World(render.worldSeed);
  const [originX, originY, originZ] = render.origin;
  const cos = Math.cos(render.yaw), sin = Math.sin(render.yaw);
  const mouthZ = graph.entrance.mouth[2];
  const entranceSdf = field.entranceSdf || field.sdf;
  const support = render.supportLocalBounds;
  const colors = new Float32Array(raw.positions.length);
  const retained = new Uint8Array(raw.positions.length / 3);
  const rgb = [0, 0, 0];
  const localToWorld = (x, z) => ({
    x: originX + cos * x + sin * z,
    z: originZ - sin * x + cos * z,
  });
  for (let i = 0; i < raw.positions.length; i += 3) {
    const x = raw.positions[i], y = raw.positions[i + 1], z = raw.positions[i + 2];
    const worldXZ = localToWorld(x, z);
    const terrainY = sampledTerrainHeight(surface, x, z);
    const localCover = Math.max(0, terrainY - y);
    let collarWeight = 0;
    if (x > support.minX && x < support.maxX && z > support.minZ && z < support.maxZ) {
      const continuousY = world.height(worldXZ.x, worldXZ.z) - originY;
      const caveDistance = Math.max(
        entranceSdf(x, continuousY, z),
        cutMinAlong - (z - mouthZ),
      );
      const fieldWeight = 1 - smoothstep(0.40, 3.20, caveDistance);
      const edge = Math.min(
        x - support.minX, support.maxX - x,
        z - support.minZ, support.maxZ - z,
      );
      collarWeight = fieldWeight * smoothstep(0, 0.85, edge);
    }
    retained[i / 3] = localCover > 0.045 || collarWeight > 1e-5;

    const e = 0.7;
    const localDx = sampledTerrainHeight(surface, x - e, z)
      - sampledTerrainHeight(surface, x + e, z);
    const localDz = sampledTerrainHeight(surface, x, z - e)
      - sampledTerrainHeight(surface, x, z + e);
    const worldDx = cos * localDx + sin * localDz;
    const worldDz = -sin * localDx + cos * localDz;
    const length = Math.hypot(worldDx, e * 2, worldDz) || 1;
    const normalY = (e * 2) / length;
    const worldY = originY + terrainY;
    const climate = world.climate(worldXZ.x, worldXZ.z, worldY);
    groundColor(world, worldXZ.x, worldXZ.z, worldY, 1 - normalY,
      climate.t, climate.m, rgb, worldDx / length, worldDz / length);
    const biomeId = world.classify(worldY, 1 - normalY, climate.t, climate.m);
    if (biomeId === 'forest' || biomeId === 'taiga' || biomeId === 'jungle') {
      const darken = 1 - 0.34 * world.groveFactor(worldXZ.x, worldXZ.z);
      rgb[0] *= darken; rgb[1] *= darken; rgb[2] *= darken;
    }
    const blend = clamp((localCover - 0.65) / 1.85, 0, 1);
    const soilBlend = blend * 0.46;
    const innerBlend = blend * blend * 0.58;
    for (let channel = 0; channel < 3; channel++) {
      const soilMixed = rgb[channel] + (SOIL[channel] - rgb[channel]) * soilBlend;
      colors[i + channel] = soilMixed + (INNER[channel] - soilMixed) * innerBlend;
    }
  }
  const filtered = new raw.indices.constructor(raw.indices.length);
  let count = 0;
  for (let i = 0; i < raw.indices.length; i += 3) {
    const a = raw.indices[i], b = raw.indices[i + 1], c = raw.indices[i + 2];
    if (!retained[a] && !retained[b] && !retained[c]) continue;
    filtered[count++] = a; filtered[count++] = b; filtered[count++] = c;
  }
  return { colors, indices: filtered.slice(0, count) };
}

export function meshCaveEntranceFacade({ graph, surface, entranceFloorLocal, render, cutMinAlong = -4.2 }) {
  validateSurface(surface);
  if (!graph?.entrance?.mouth || !Number.isFinite(entranceFloorLocal)) {
    throw new Error('Cave facade job is missing its finalized entrance');
  }
  const startedAt = performance.now();
  const field = createCaveField(graph);
  const mouth = graph.entrance.mouth;
  const terrainLocalY = (x, z) => sampledTerrainHeight(surface, x, z);
  const handoff = planCaveEntranceHandoff(field, terrainLocalY, graph.entrance, {
    minAlong: HANDOFF_MIN,
    maxAlong: HANDOFF_MAX,
  });
  const collarExtent = {
    minX: -6.35,
    maxX: 6.35,
    minZ: mouth[2] - 4.9,
    maxZ: mouth[2] + handoff.collarEndAlong,
  };
  const measureVerticalExtent = (extent) => {
    let maxTerrain = -Infinity;
    let minWalkableFloor = entranceFloorLocal;
    for (let iz = 0; iz <= 30; iz++) {
      const z = extent.minZ + iz / 30 * (extent.maxZ - extent.minZ);
      for (let ix = 0; ix <= 12; ix++) {
        const x = extent.minX + ix / 12 * (extent.maxX - extent.minX);
        maxTerrain = Math.max(maxTerrain, terrainLocalY(x, z));
        const caveFloor = field.floorHeightNear(x, z, entranceFloorLocal, 4.0, 14.0);
        if (Number.isFinite(caveFloor)) minWalkableFloor = Math.min(minWalkableFloor, caveFloor);
      }
    }
    return { maxTerrain, minWalkableFloor };
  };

  let verticalExtent = measureVerticalExtent(collarExtent);
  for (let pass = 0; pass < 3; pass++) {
    const lateralBounds = planCaveEntranceLateralBounds(
      field,
      terrainLocalY,
      graph.entrance,
      handoff,
      {
        minY: verticalExtent.minWalkableFloor - 1.5,
        maxY: verticalExtent.maxTerrain + 1.0,
      },
    );
    const stable = lateralBounds.minX === collarExtent.minX
      && lateralBounds.maxX === collarExtent.maxX;
    collarExtent.minX = lateralBounds.minX;
    collarExtent.maxX = lateralBounds.maxX;
    if (stable) break;
    verticalExtent = measureVerticalExtent(collarExtent);
  }
  verticalExtent = measureVerticalExtent(collarExtent);
  const bounds = {
    ...collarExtent,
    minY: verticalExtent.minWalkableFloor - 1.5,
    maxY: verticalExtent.maxTerrain + 1.0,
  };
  const entranceSdf = field.entranceSdf || field.sdf;
  const implicit = (x, y, z) => smoothMinimum(
    Math.max(entranceSdf(x, y, z), cutMinAlong - (z - mouth[2])),
    terrainLocalY(x, z) - y,
    0.72,
  );
  const lateralCells = Math.max(38, Math.ceil((bounds.maxX - bounds.minX) / (12.7 / 38)));
  const verticalCells = Math.max(33, Math.ceil((bounds.maxY - bounds.minY) / 0.35));
  const axialCells = Math.max(54, Math.ceil((bounds.maxZ - bounds.minZ) / 0.55));
  const meshStartedAt = performance.now();
  const raw = meshImplicitBox(implicit, bounds, {
    nx: lateralCells,
    ny: verticalCells,
    nz: axialCells,
  });
  const meshMs = performance.now() - meshStartedAt;
  const decorated = decorateFacade(raw, {
    graph, field, surface, render, cutMinAlong,
  });
  return {
    ...raw,
    ...decorated,
    bounds,
    handoff,
    meshMs,
    workerMs: performance.now() - startedAt,
    cells: { nx: lateralCells, ny: verticalCells, nz: axialCells },
  };
}

function transferablesFor(result) {
  return ['positions', 'normals', 'colors', 'indices']
    .map((key) => result?.[key]?.buffer)
    .filter((buffer, index, all) => buffer instanceof ArrayBuffer && all.indexOf(buffer) === index);
}

export function createCaveFacadeWorkerProtocol({ postMessage, meshFacade = meshCaveEntranceFacade } = {}) {
  if (typeof postMessage !== 'function') throw new Error('Cave facade worker requires postMessage');
  if (typeof meshFacade !== 'function') throw new Error('Cave facade worker requires a mesher');
  const handleJob = (job) => {
    if (!job || job.type !== 'entrance-facade') return null;
    try {
      if (!Number.isSafeInteger(job.requestId) || !Number.isSafeInteger(job.epoch)) {
        throw new Error('Cave facade job has an invalid request identity');
      }
      const actualGraphHash = caveGraphSignature(job.graph);
      if (actualGraphHash !== job.graphHash) {
        throw new Error(`Cave facade graph hash mismatch: requested ${job.graphHash}, actual ${actualGraphHash}`);
      }
      const graph = structuredClone(job.graph);
      graph.entrance.cutMinAlong = Number(job.cutMinAlong);
      const result = meshFacade({
        graph,
        surface: job.surface,
        entranceFloorLocal: Number(job.entranceFloorLocal),
        render: job.render,
        cutMinAlong: Number(job.cutMinAlong),
      });
      const response = {
        ...result,
        type: 'entrance-facade-result',
        requestId: job.requestId,
        epoch: job.epoch,
        graphHash: actualGraphHash,
        terrainSignature: job.terrainSignature,
      };
      postMessage(response, transferablesFor(result));
      return response;
    } catch (error) {
      const response = {
        type: 'entrance-facade-error',
        requestId: job?.requestId ?? null,
        epoch: job?.epoch ?? null,
        graphHash: job?.graphHash ?? null,
        terrainSignature: job?.terrainSignature ?? null,
        message: error?.stack || error?.message || String(error),
      };
      postMessage(response, []);
      return response;
    }
  };
  return { handleJob };
}
