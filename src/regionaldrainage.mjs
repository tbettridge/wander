// Terrain drainage for a regional river system.
//
// Rivers should sit where the land actually sends its water. This survey
// fills closed hollows (priority flood), routes every cell down its steepest
// filled descent and accumulates contributing area. A basin's main stem then
// follows its largest donor upstream from the sea, and its feeders are the
// remaining large donors along the way, so the network branches like the
// valleys that produced it instead of being drawn onto the terrain.
//
// The survey is pure, deterministic and bounded: one natural-height sample per
// lattice cell, typed arrays throughout, no world mutation.

const LAND = 0, OCEAN = 1, EXIT = 2;
const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const DISTANCES = DIRECTIONS.map(([dx, dz]) => Math.hypot(dx, dz));

export const DRAINAGE_KIND = Object.freeze({ LAND, OCEAN, EXIT });

// Binary heap of cell indices keyed by a shared Float64Array. Ties break on
// the index, so every survey of the same window visits cells identically.
function cellHeap(capacity, key) {
  const items = new Int32Array(capacity);
  let size = 0;
  const less = (a, b) => key[a] < key[b] || (key[a] === key[b] && a < b);
  return {
    get size() { return size; },
    push(value) {
      let i = size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(value, items[parent])) break;
        items[i] = items[parent]; i = parent;
      }
      items[i] = value;
    },
    pop() {
      const top = items[0], last = items[--size];
      let i = 0;
      while (i * 2 + 1 < size) {
        let child = i * 2 + 1;
        if (child + 1 < size && less(items[child + 1], items[child])) child++;
        if (!less(items[child], last)) break;
        items[i] = items[child]; i = child;
      }
      items[i] = last;
      return top;
    },
  };
}

/**
 * Survey the natural drainage of a rectangle on a global lattice.
 * Ocean cells (natural height below -0.25 m) and the rectangle's edge are the
 * only outlets; cells that drain off the edge belong to a neighbouring survey.
 */
export function surveyDrainage(world, { minX, minZ, maxX, maxZ, cell = 16, minSea = 250000 }) {
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite) || !(cell > 0) || maxX <= minX || maxZ <= minZ) {
    throw new Error('Invalid drainage survey bounds');
  }
  const cols = Math.floor((maxX - minX) / cell) + 1, rows = Math.floor((maxZ - minZ) / cell) + 1;
  const count = cols * rows;
  if (count > 400000) throw new Error('Drainage survey budget exceeded');
  const height = new Float64Array(count), filled = new Float64Array(count);
  const kind = new Uint8Array(count), receiver = new Int32Array(count).fill(-1);
  const order = new Int32Array(count), visited = new Uint8Array(count);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    height[j * cols + i] = world._naturalHeight(minX + i * cell, minZ + j * cell);
  }
  // Only open sea receives rivers. A small hollow below the tide inland is a
  // depression to fill, not an ocean outlet.
  const submerged = new Uint8Array(count), label = new Int32Array(count).fill(-1), stack = [];
  for (let k = 0; k < count; k++) if (height[k] < -0.25) submerged[k] = 1;
  for (let k = 0; k < count; k++) {
    if (!submerged[k] || label[k] >= 0) continue;
    const members = [k];
    label[k] = k; stack.push(k);
    while (stack.length) {
      const c = stack.pop(), ci = c % cols, cj = (c - ci) / cols;
      for (let d = 0; d < 8; d++) {
        const ni = ci + DIRECTIONS[d][0], nj = cj + DIRECTIONS[d][1];
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const q = nj * cols + ni;
        if (submerged[q] && label[q] < 0) { label[q] = k; stack.push(q); members.push(q); }
      }
    }
    if (members.length * cell * cell >= minSea) for (const q of members) kind[q] = OCEAN;
  }
  const heap = cellHeap(count, filled);
  for (let k = 0; k < count; k++) {
    const i = k % cols, j = (k - i) / cols;
    if (kind[k] !== OCEAN) {
      if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) kind[k] = EXIT;
      else continue;
    }
    filled[k] = height[k]; visited[k] = 1; heap.push(k);
  }
  // A tiny gradient across filled hollows keeps every cell draining to an
  // outlet. The filled surface is a routing device only; real terrain and
  // water levels are fitted later against the original heights.
  let visits = 0;
  while (heap.size) {
    const c = heap.pop();
    order[visits++] = c;
    const ci = c % cols, cj = (c - ci) / cols;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DIRECTIONS[d][0], nj = cj + DIRECTIONS[d][1];
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const k = nj * cols + ni;
      if (visited[k]) continue;
      visited[k] = 1;
      filled[k] = Math.max(height[k], filled[c] + 1e-4 * DISTANCES[d]);
      heap.push(k);
    }
  }
  for (let k = 0; k < count; k++) {
    if (kind[k] !== LAND) continue;
    const ci = k % cols, cj = (k - ci) / cols;
    let best = -1, steepest = 0;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DIRECTIONS[d][0], nj = cj + DIRECTIONS[d][1];
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const q = nj * cols + ni, slope = (filled[k] - filled[q]) / DISTANCES[d];
      if (slope > steepest || (slope === steepest && best >= 0 && q < best && slope > 0)) { steepest = slope; best = q; }
    }
    receiver[k] = best;
  }
  const area = new Float64Array(count), cellArea = cell * cell;
  for (let o = visits - 1; o >= 0; o--) {
    const k = order[o];
    if (kind[k] === OCEAN) continue;
    area[k] += cellArea;
    const r = receiver[k];
    if (r >= 0 && kind[r] !== OCEAN) area[r] += area[k];
  }
  // Compact donor lists for upstream walks.
  const donorStart = new Int32Array(count + 1), donors = new Int32Array(count);
  for (let k = 0; k < count; k++) if (receiver[k] >= 0) donorStart[receiver[k] + 1]++;
  for (let k = 0; k < count; k++) donorStart[k + 1] += donorStart[k];
  const cursor = donorStart.slice(0, count);
  for (let k = 0; k < count; k++) if (receiver[k] >= 0) donors[cursor[receiver[k]]++] = k;
  return { minX, minZ, cell, cols, rows, height, filled, kind, receiver, area, order, donorStart, donors };
}

export const surveyX = (survey, k) => survey.minX + (k % survey.cols) * survey.cell;
export const surveyZ = (survey, k) => survey.minZ + Math.floor(k / survey.cols) * survey.cell;

/** Land cells that discharge directly into the sea, largest catchment first. */
export function drainageMouths(survey, minArea = 0) {
  const mouths = [];
  for (let k = 0; k < survey.kind.length; k++) {
    if (survey.kind[k] !== LAND) continue;
    const r = survey.receiver[k];
    if (r >= 0 && survey.kind[r] === OCEAN && survey.area[k] >= minArea) mouths.push(k);
  }
  return mouths.sort((a, b) => survey.area[b] - survey.area[a] || a - b);
}

function largestDonor(survey, k, exclude = -1) {
  let best = -1;
  for (let i = survey.donorStart[k]; i < survey.donorStart[k + 1]; i++) {
    const d = survey.donors[i];
    if (d === exclude) continue;
    if (best < 0 || survey.area[d] > survey.area[best] || (survey.area[d] === survey.area[best] && d < best)) best = d;
  }
  return best;
}

/** Cells of a stem from its head (first) down to `k` (last). */
export function upstreamStem(survey, k, headArea) {
  const cells = [k];
  for (;;) {
    const donor = largestDonor(survey, cells.at(-1));
    if (donor < 0 || survey.area[donor] < headArea) break;
    cells.push(donor);
  }
  return cells.reverse();
}

/**
 * The dendritic channel tree above a mouth. Every branch is a stem of cells
 * from its head to the cell where it meets its parent (the parent's cell is
 * the branch's last entry). Branches are ordered parents-first.
 */
export function drainageTree(survey, mouth, {
  headArea = 12000, branchArea = [90000, 55000], maxBranches = 24,
} = {}) {
  const branches = [];
  const trunk = { id: 0, parent: -1, joinIndex: -1, order: 0, cells: upstreamStem(survey, mouth, headArea) };
  branches.push(trunk);
  for (let cursor = 0; cursor < branches.length; cursor++) {
    const parent = branches[cursor];
    if (parent.order >= branchArea.length) continue;
    const threshold = branchArea[parent.order];
    const roots = [];
    // The head cell has no stem donor of its own; every later cell excludes
    // the stem's upstream cell so only side valleys become branches.
    for (let index = 1; index < parent.cells.length; index++) {
      const cell = parent.cells[index], stemDonor = parent.cells[index - 1];
      for (let i = survey.donorStart[cell]; i < survey.donorStart[cell + 1]; i++) {
        const donor = survey.donors[i];
        if (donor !== stemDonor && survey.area[donor] >= threshold) roots.push({ donor, index });
      }
    }
    roots.sort((a, b) => survey.area[b.donor] - survey.area[a.donor] || a.donor - b.donor);
    for (const { donor, index } of roots) {
      if (branches.length >= maxBranches) break;
      const cells = upstreamStem(survey, donor, headArea);
      cells.push(parent.cells[index]);
      branches.push({ id: branches.length, parent: parent.id, joinIndex: index, order: parent.order + 1, cells });
    }
  }
  return branches;
}
