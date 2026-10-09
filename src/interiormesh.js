import * as THREE from 'three';
export function buildInteriorStructure(root, building, wood, floor) {
  if (!building.interior) return;
  const box = (w, h, d, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
  };
  for (const level of building.interior.levels.slice(1)) {
    for (const r of level.rectangles) {
      const mesh = box(r.maxX - r.minX, 0.12, r.maxZ - r.minZ,
        (r.minX + r.maxX) / 2, level.y - 0.06, (r.minZ + r.maxZ) / 2);
      mesh.material = floor;
    }
    if (level.kind === 'loft') {
      const x0 = building.interior.stairs[0].bounds.maxX, x1 = level.bounds.maxX, z = level.bounds.maxZ;
      box(x1 - x0, 0.06, 0.06, (x0 + x1) / 2, level.y + 0.9, z);
      box(x1 - x0, 0.055, 0.055, (x0 + x1) / 2, level.y + 0.43, z);
      const n = Math.ceil((x1 - x0) / 0.75);
      for (let i = 0; i <= n; i++) box(0.055, 0.95, 0.055, x0 + (x1 - x0) * i / n, level.y + 0.45, z);
      // Exposed joists make the loft read as a partial timber deck.
      for (let z0 = level.bounds.minZ + 0.4; z0 < level.bounds.maxZ; z0 += 0.9)
        box(building.width - 0.3, 0.14, 0.1, 0, level.y - 0.18, z0);
    }
  }
  for (const s of building.interior.stairs) {
    const run = (s.startZ - s.endZ) / s.steps, rise = (s.upperY - s.lowerY) / s.steps;
    for (let i = 0; i < s.steps; i++) {
      // Open treads retain headroom between stacked parallel flights.
      box(s.width, 0.1, run + 0.015, s.x, s.lowerY + (i + 1) * rise - 0.05, s.startZ - (i + 0.5) * run);
    }
    for (const side of [-1, 1]) {
      const x = s.x + side * (s.width / 2 + 0.035);
      const beam = box(0.065, 0.085, Math.hypot(s.startZ - s.endZ, s.upperY - s.lowerY), x,
        (s.lowerY + s.upperY) / 2 + 0.9, (s.startZ + s.endZ) / 2);
      beam.rotation.x = Math.atan2(s.upperY - s.lowerY, s.startZ - s.endZ);
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        box(0.05, 0.94, 0.05, x, s.lowerY + (s.upperY - s.lowerY) * t + 0.44, s.startZ + (s.endZ - s.startZ) * t);
      }
    }
  }
}
