import { floodBasin } from './drainage.mjs';

export function refineBasinConnection(world, basin) {
  const b = basin.bounds, step = 2, cols = (b.maxX - b.minX) / step + 1, rows = (b.maxZ - b.minZ) / step + 1;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 3 || rows < 3 || cols * rows > 65536) {
    throw new Error('Basin connection grid budget exceeded');
  }
  const floor = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) floor.push(world._naturalHeight(b.minX + x * step, b.minZ + z * step));
  const start = Math.round((basin.centerZ - b.minZ) / step) * cols + Math.round((basin.centerX - b.minX) / step);
  const flood = floodBasin(floor, cols, start, basin.level, rows);
  if (!flood.cells.length || flood.boundary) throw new Error('Uncontained refined basin');
  return { ...basin, grid: { x0: b.minX, z0: b.minZ, step, cols, rows, floor,
    signed: floor.map((h, i) => flood.mask[i] ? basin.level - h : Math.min(-0.001, basin.level - h)) } };
}

// Use the same triangle diagonal and connected-wet mask as the basin renderer.
// A low neighbouring hollow is not lake support merely because its height fits.
export function wetBasinAt(basins, x, z) {
  let found = null;
  for (const basin of basins) {
    const g = basin.grid, gx = (x - g.x0) / g.step, gz = (z - g.z0) / g.step;
    if (gx < 0 || gz < 0 || gx >= g.cols - 1 || gz >= g.rows - 1) continue;
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
    const a = iz * g.cols + ix, b = a + 1, c = a + g.cols, d = c + 1, v = g.signed;
    const signed = fx + fz <= 1 ? v[a] + (v[b] - v[a]) * fx + (v[c] - v[a]) * fz
      : v[d] + (v[c] - v[d]) * (1 - fx) + (v[b] - v[d]) * (1 - fz);
    if (signed <= 0) continue;
    if (found && found.id !== basin.id) throw new Error('Overlapping lake ownership');
    found = basin;
  }
  return found;
}
