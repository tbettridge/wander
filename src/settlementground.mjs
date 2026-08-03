// Renderer-independent settlement ground-overlay geometry. These arrays are
// consumed by Three.js in the browser and directly audited by Node tests.

export const SETTLEMENT_GROUND_SURFACE_OFFSET = 0.018;
export const SETTLEMENT_GROUND_SAMPLE_SPACING = 1.25;

export function settlementGroundGrid(world, zone) {
  const cols = Math.max(2, Math.ceil(zone.width / SETTLEMENT_GROUND_SAMPLE_SPACING));
  const rows = Math.max(2, Math.ceil(zone.depth / SETTLEMENT_GROUND_SAMPLE_SPACING));
  const positions = [], indices = [], c = Math.cos(zone.yaw), s = Math.sin(zone.yaw);
  for (let z = 0; z <= rows; z++) for (let x = 0; x <= cols; x++) {
    const lx = (x / cols - 0.5) * zone.width, lz = (z / rows - 0.5) * zone.depth;
    const wx = zone.x + lx * c + lz * s, wz = zone.z - lx * s + lz * c;
    positions.push(wx, world.height(wx, wz) + SETTLEMENT_GROUND_SURFACE_OFFSET, wz);
  }
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const a = z * (cols + 1) + x, b = a + 1, d = (z + 1) * (cols + 1) + x, e = d + 1;
    indices.push(a, d, b, b, d, e);
  }
  return { positions, indices, cols, rows };
}

function terrainRibbonSamples(path) {
  const samples = [];
  for (let segment = 1; segment < path.points.length; segment++) {
    const from = path.points[segment - 1], to = path.points[segment];
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / SETTLEMENT_GROUND_SAMPLE_SPACING));
    for (let step = segment === 1 ? 0 : 1; step <= steps; step++) {
      const t = step / steps;
      samples.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
    }
  }
  if (!samples.length && path.points[0]) samples.push({ x: path.points[0].x, z: path.points[0].z });
  return samples;
}

export function settlementPathRibbon(world, path) {
  const positions = [], indices = [], samples = terrainRibbonSamples(path);
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
    const dx = after.x - before.x, dz = after.z - before.z, length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length * path.width / 2, nz = dx / length * path.width / 2;
    for (const side of [-1, 1]) {
      const x = p.x + nx * side, z = p.z + nz * side;
      positions.push(x, world.height(x, z) + SETTLEMENT_GROUND_SURFACE_OFFSET, z);
    }
    if (i) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices, samples };
}
