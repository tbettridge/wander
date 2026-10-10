// A bounded, exact lattice cache shared by lake and river planning attempts.
// Fractional probes are never rounded; the cache is discarded with the plan.
const cachedTerrains = new WeakSet();

export function waterPlanningTerrain(world) {
  if (cachedTerrains.has(world)) return world;
  const rows = new Map(), baseHeight = world._naturalHeight.bind(world);
  const planning = Object.create(world);
  let entries = 0;
  planning._naturalHeight = (x, z, out) => {
    // Rich natural-terrain queries also fill biome/coast metadata. Cache only
    // the numeric planner path so inherited World APIs retain that contract.
    if (out) return baseHeight(x, z, out);
    // Fractional fitting probes must stay exact. Keep them out of this cache
    // so low-reuse bank coordinates cannot crowd out repeated mesh vertices.
    if (!Number.isInteger(x / 2) || !Number.isInteger(z / 2)) return baseHeight(x, z);
    let row = rows.get(z);
    if (row?.has(x)) return row.get(x);
    const height = baseHeight(x, z);
    if (entries < 131072) {
      if (!row) { row = new Map(); rows.set(z, row); }
      row.set(x, height); entries++;
    }
    return height;
  };
  cachedTerrains.add(planning);
  return planning;
}
