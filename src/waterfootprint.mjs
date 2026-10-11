// Coarse spatial footprints for water descriptors.
//
// A branching river system spans most of its basin's bounding box while its
// sparse mesh only owns narrow corridors along each channel. Comparing boxes
// would forbid every lake and stream between its feeders. Sparse meshes are
// therefore compared by the 64 m cells their lattice actually touches; any
// other descriptor keeps its whole bounding box. The test stays conservative:
// a shared cell is treated as overlap even when the lattices miss each other.

const CELL = 64;
const footprints = new WeakMap();

export const waterBoundsOverlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

function footprint(object) {
  if (!object || typeof object !== 'object') return null;
  if (footprints.has(object)) return footprints.get(object);
  const grid = object.grid;
  let cells = null;
  if (object.version === 3 && Array.isArray(grid?.coords) && Number.isFinite(grid.step)) {
    cells = new Set();
    // A lattice vertex owns the triangles around it, one step either way.
    for (const [x, z] of grid.coords) {
      const px = x * grid.step, pz = z * grid.step;
      for (const ox of [-grid.step, grid.step]) for (const oz of [-grid.step, grid.step]) {
        cells.add(`${Math.floor((px + ox) / CELL)},${Math.floor((pz + oz) / CELL)}`);
      }
    }
  }
  footprints.set(object, cells);
  return cells;
}

/** Whether two water descriptors could own the same ground. */
export function waterObjectsOverlap(a, b) {
  if (!waterBoundsOverlap(a.bounds, b.bounds)) return false;
  const ca = footprint(a), cb = footprint(b);
  if (!ca && !cb) return true;
  if (ca && cb) {
    const [small, large] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
    for (const key of small) if (large.has(key)) return true;
    return false;
  }
  // One sparse lattice against a rectangular owner: any lattice cell inside
  // the rectangle's cells overlaps it.
  const cells = ca || cb, box = (ca ? b : a).bounds;
  const x0 = Math.floor(box.minX / CELL), x1 = Math.floor(box.maxX / CELL);
  const z0 = Math.floor(box.minZ / CELL), z1 = Math.floor(box.maxZ / CELL);
  for (const key of cells) {
    const comma = key.indexOf(','), x = Number(key.slice(0, comma)), z = Number(key.slice(comma + 1));
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return true;
  }
  return false;
}
