// Cacheable selection data only: no rendering resources or world mutation.
export function lakeReflectionTargets(world) {
  const targets = [];
  for (const body of world.waterField?.bodies.values() || []) {
    targets.push({ id: body.id, level: body.level, ...body.bounds });
  }
  for (const field of world.waterField?.components.values() || []) {
    const g = field.mesh?.grid;
    if (!g?.lakeKind) continue;
    const levels = new Map();
    for (let i = 0; i < g.coords.length; i++) {
      if (g.lakeKind[i] <= 0 || g.signed[i] <= 0) continue;
      const level = g.head[i], key = level.toFixed(6), x = g.coords[i][0] * g.step, z = g.coords[i][1] * g.step;
      let b = levels.get(key);
      if (!b) { b = { id: `${field.mesh.hash}:${key}`, level, minX: x, maxX: x, minZ: z, maxZ: z }; levels.set(key, b); }
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    }
    targets.push(...levels.values());
  }
  return targets;
}

export function nearestLakeReflection(targets, position) {
  let chosen = null, best = 160 * 160;
  for (const b of targets) {
    if (position.y <= b.level + 0.08 || position.y - b.level > 240) continue;
    const dx = Math.max(b.minX - position.x, 0, position.x - b.maxX);
    const dz = Math.max(b.minZ - position.z, 0, position.z - b.maxZ);
    const d = dx * dx + dz * dz;
    if (d < best) { chosen = b; best = d; }
  }
  return chosen;
}
