// Finite-domain depression analysis. The caller owns boundary conditions;
// touching the boundary means unresolved, never an automatically valid lake.
// Original elevations remain untouched. Flood parents form an acyclic drainage
// tree even across flats (strictly earlier visitation, not arbitrary slope ties).
export class MinHeap {
  constructor() { this.items = []; }
  less(a, b) { return a.height < b.height || (a.height === b.height && a.index < b.index); }
  push(value) {
    const a = this.items;
    let i = a.length;
    a.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(value, a[p])) break;
      a[i] = a[p]; i = p;
    }
    a[i] = value;
  }
  pop() {
    const a = this.items, result = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && this.less(a[c + 1], a[c])) c++;
        if (!this.less(a[c], last)) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return result;
  }
}

export function priorityFlood(heights, width, height = width) {
  if (width < 3 || height < 3 || heights.length !== width * height
    || !heights.every(Number.isFinite)) throw new Error('Invalid drainage height grid');
  const filled = Float64Array.from(heights), parent = new Int32Array(heights.length).fill(-1);
  const visited = new Uint8Array(heights.length), order = new Uint32Array(heights.length);
  const heap = new MinHeap();
  const boundary = index => {
    if (visited[index]) return;
    visited[index] = 1;
    heap.push({ index, height: heights[index] });
  };
  for (let x = 0; x < width; x++) { boundary(x); boundary((height - 1) * width + x); }
  for (let z = 1; z < height - 1; z++) { boundary(z * width); boundary(z * width + width - 1); }
  let count = 0;
  while (heap.items.length) {
    const current = heap.pop(), i = current.index;
    order[count++] = i;
    const x = i % width, z = Math.floor(i / width);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const ni = nz * width + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      filled[ni] = Math.max(heights[ni], current.height);
      parent[ni] = i;
      heap.push({ index: ni, height: filled[ni] });
    }
  }
  const accumulation = new Uint32Array(heights.length).fill(1);
  for (let n = order.length - 1; n >= 0; n--) {
    const i = order[n];
    if (parent[i] >= 0) accumulation[parent[i]] += accumulation[i];
  }
  return { filled, parent, order, accumulation };
}

// Connected cells strictly below one physical level. A boundary hit is an
// explicit rejection so a cropped valley cannot masquerade as a contained bowl.
export function floodBasin(heights, width, start, level, height = width) {
  if (!Number.isFinite(level) || !Number.isInteger(start) || start < 0 || start >= heights.length
    || heights.length !== width * height) throw new Error('Invalid basin flood');
  const mask = new Uint8Array(heights.length), cells = [];
  if (heights[start] >= level) return { mask, cells, boundary: false, rim: Infinity };
  const queue = [start]; mask[start] = 1;
  let boundary = false, rim = Infinity;
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at], x = i % width, z = Math.floor(i / width);
    cells.push(i);
    if (x === 0 || z === 0 || x === width - 1 || z === height - 1) boundary = true;
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const ni = nz * width + nx;
      if (heights[ni] >= level) { rim = Math.min(rim, heights[ni]); continue; }
      if (!mask[ni]) { mask[ni] = 1; queue.push(ni); }
    }
  }
  return { mask, cells, boundary, rim };
}
