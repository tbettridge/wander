// Conservative connected support of generation-2 river carving. Cells include
// every possible point of the old signal band, not just wet sample vertices.
// A closed search proves containment, not that a replacement is feasible.
import { descriptorHash } from './hydrologyformat.mjs';

export function surveyLegacyFootprint(world, anchors, {
  cellSize = 64, refinement = 5, maxCells = 8192, maxChecks = 250000,
} = {}) {
  if (world.generationVersion !== 2 || typeof world._legacyRiverMayInfluence !== 'function'
    || !anchors?.length || anchors.length > 4096
    || !anchors.every(p => typeof p.id === 'string' && p.id && Number.isFinite(p.x) && Number.isFinite(p.z))
    || new Set(anchors.map(p => p.id)).size !== anchors.length
    || !Number.isFinite(cellSize) || cellSize < 4 || cellSize > 256
    || !Number.isInteger(refinement) || refinement < 0 || refinement > 8
    || !Number.isInteger(maxCells) || maxCells < 1 || maxCells > 100000
    || !Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > 2000000) {
    throw new Error('Invalid legacy footprint survey');
  }
  const sorted = [...anchors].sort((a, b) => a.id.localeCompare(b.id));
  const cells = new Map(), queue = [], outside = new Set(), terminals = new Map();
  const routeBudget = { remaining: 25000 };
  let sourceExcludedCells = 0;
  let checks = 0, exhausted = false;
  const mayContain = (bounds, depth) => {
    if (checks >= maxChecks) { exhausted = true; return true; }
    checks++;
    if (!world._legacyRiverMayInfluence(bounds)) return false;
    if (!depth) return true;
    const { minX, minZ, maxX, maxZ } = bounds;
    const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
    return mayContain({ minX, minZ, maxX: midX, maxZ: midZ }, depth - 1)
      || mayContain({ minX: midX, minZ, maxX, maxZ: midZ }, depth - 1)
      || mayContain({ minX, minZ: midZ, maxX: midX, maxZ }, depth - 1)
      || mayContain({ minX: midX, minZ: midZ, maxX, maxZ }, depth - 1);
  };
  const visit = (x, z) => {
    const key = `${x},${z}`;
    if (cells.has(key) || outside.has(key) || terminals.has(key) || exhausted) return;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) { exhausted = true; return; }
    const bounds = { minX: x * cellSize, minZ: z * cellSize,
      maxX: (x + 1) * cellSize, maxZ: (z + 1) * cellSize };
    if (world._legacyRiverOceanOwns?.(bounds)) { terminals.set(key, 'ocean'); return; }
    if (!mayContain(bounds, refinement)) { outside.add(key); return; }
    if (world._legacyRiverRouteMayInfluence && routeBudget.remaining > 0
      && !world._legacyRiverRouteMayInfluence(bounds, routeBudget)) {
      sourceExcludedCells++; outside.add(key); return;
    }
    if (exhausted || cells.size >= maxCells) { exhausted = true; return; }
    const cell = { x, z };
    cells.set(key, cell); queue.push(cell);
  };
  for (const anchor of sorted) visit(Math.floor(anchor.x / cellSize), Math.floor(anchor.z / cellSize));
  for (let cursor = 0; cursor < queue.length && !exhausted; cursor++) {
    const { x, z } = queue[cursor];
    // Include corner connections: four-neighbour traversal can drop a narrow
    // branch that crosses exactly through a grid corner.
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx || dz) visit(x + dx, z + dz);
    }
  }
  const ordered = [...cells.values()].sort((a, b) => a.z - b.z || a.x - b.x);
  const indices = new Map(ordered.map((cell, i) => [`${cell.x},${cell.z}`, i]));
  const remaining = new Set(indices.keys()), components = [];
  while (remaining.size) {
    const pending = [remaining.values().next().value], cellIndices = [];
    remaining.delete(pending[0]);
    for (let i = 0; i < pending.length; i++) {
      const index = indices.get(pending[i]), { x, z } = ordered[index];
      cellIndices.push(index);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const key = `${x + dx},${z + dz}`;
        if (remaining.delete(key)) pending.push(key);
      }
    }
    cellIndices.sort((a, b) => a - b);
    const membership = new Set(cellIndices);
    const anchorIds = sorted.filter(p => membership.has(indices.get(
      `${Math.floor(p.x / cellSize)},${Math.floor(p.z / cellSize)}`))).map(p => p.id);
    const identity = { seed: world.seed, cellSize, cells: cellIndices.map(i => ordered[i]) };
    // A small component can finish before an unrelated large one uses up the
    // global search budget. Certify it only if every neighbour is classified;
    // an unvisited frontier remains unresolved even if its centre looks dry.
    const closed = cellIndices.every(i => {
      const { x, z } = ordered[i];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const key = `${x + dx},${z + dz}`;
        if (!indices.has(key) && !outside.has(key) && !terminals.has(key)) return false;
      }
      return true;
    });
    components.push({ id: `legacy-footprint:${descriptorHash(identity)}`, anchorIds, cellIndices,
      containment: closed ? 'closed' : 'unresolved' });
  }
  const payload = { version: 1, seed: world.seed, generationVersion: 2, cellSize,
    anchors: sorted.map(({ id, x, z }) => ({ id, x, z })), cells: ordered,
    terminals: [...terminals].sort(([a], [b]) => a.localeCompare(b)).map(([key, kind]) => {
      const [x, z] = key.split(',').map(Number); return { x, z, kind };
    }), components,
    containment: exhausted ? 'unresolved' : 'closed', activationReady: false };
  return { ...payload, hash: descriptorHash(payload),
    reason: exhausted ? 'legacy-footprint-budget' : null,
    diagnostics: { cells: cells.size, checks, excludedCells: outside.size,
      closedComponents: components.filter(c => c.containment === 'closed').length,
      routeChecks: 25000 - routeBudget.remaining, sourceExcludedCells,
      oceanTerminalCells: terminals.size } };
}
