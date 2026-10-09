// Shared bake/pool mathematics. No renderer or world-state dependencies.
export const VILLAGE_LIGHTING = Object.freeze({
  desktopLights: 6, xrLights: 2, range: 12.03125, intensity: 9,
  receiverReach: 11, viewReach: 110, fadeRate: 5, warmColor: 0xffd29a,
});
export const villageLightingNight = { value: 0 };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
export function villageNightLevel(night = 0) {
  return clamp01(((Number.isFinite(night) ? night : 0) - 0.25) / 0.45);
}

export function enableVillageActorLighting(material) {
  if (!material || material.defines?.WANDER_VILLAGE_ACTOR) return material;
  material.defines = { ...material.defines, WANDER_VILLAGE_ACTOR: 1 };
  material.needsUpdate = true;
  return material;
}

export function villageLightShaderChunk(chunk) {
  if (chunk.includes('WANDER_VILLAGE_ACTOR')) return chunk;
  const anchor = /void getPointLightInfo\s*\([^{}]*out IncidentLight (\w+)\s*\)\s*\{/;
  const match = chunk.match(anchor);
  if (!match) throw new Error('Unsupported Three point-light shader');
  const light = match[1];
  // WebGLRenderer has no per-mesh light mask. Reserve an exactly representable
  // cutoff as the native pool's tag; every ordinary light retains its behavior.
  // Reject static receivers before attenuation or BRDF work, in both supported
  // Three revisions and both fragment-lit and vertex-lit materials.
  return chunk.replace(anchor, `${match[0]}
#ifndef WANDER_VILLAGE_ACTOR
  bool villageSkipLight = pointLight.distance == ${VILLAGE_LIGHTING.range};
#else
  // Zero-intensity slots keep the shader layout stable without doing lighting
  // work. XR therefore evaluates only its two occupied slots.
  bool villageSkipLight = pointLight.distance == ${VILLAGE_LIGHTING.range} && pointLight.color == vec3( 0.0 );
#endif
  if ( villageSkipLight ) {
    ${light}.color = vec3( 0.0 );
    ${light}.direction = vec3( 0.0, 0.0, 1.0 );
    ${light}.visible = false;
    return;
  }`);
}

export function villageDirectLightShaderChunk(chunk) {
  if (chunk.includes('WANDER_VILLAGE_POINT_SKIP')) return chunk;
  const point = chunk.search(/getPointLightInfo\s*\(/);
  const call = point < 0 ? null : chunk.slice(point).match(/RE_Direct\s*\([^;]+\);/);
  if (!call) throw new Error('Unsupported Three point-light accumulation shader');
  const at = point + call.index;
  // getPointLightInfo's early exit alone would still run RE_Direct (including
  // GGX) with a zero colour. Skip that work for static surfaces and empty slots.
  return chunk.slice(0, at) + `// WANDER_VILLAGE_POINT_SKIP
    if ( directLight.visible ) { ${call[0]} }` + chunk.slice(at + call[0].length);
}

function boxFor(building) {
  const lift = (building.masses || []).find(m => m.role === 'core')?.baseY || 0;
  return {
    x: building.x, z: building.z, cos: Math.cos(building.yaw || 0), sin: Math.sin(building.yaw || 0),
    halfX: building.width / 2, halfZ: building.depth / 2,
    bottom: building.y + lift, top: building.y + lift + building.floorCount * building.floorHeight,
  };
}

export function segmentHitsVillageBuilding(from, to, box) {
  const local = (p) => {
    const x = p.x - box.x, z = p.z - box.z;
    return [x * box.cos - z * box.sin, p.y, x * box.sin + z * box.cos];
  };
  const a = local(from), b = local(to);
  const lo = [-box.halfX, box.bottom, -box.halfZ], hi = [box.halfX, box.top, box.halfZ];
  let enter = 0.001, leave = 0.999;
  for (let axis = 0; axis < 3; axis++) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-8) {
      if (a[axis] < lo[axis] || a[axis] > hi[axis]) return false;
    } else {
      let t0 = (lo[axis] - a[axis]) / delta, t1 = (hi[axis] - a[axis]) / delta;
      if (t0 > t1) [t0, t1] = [t1, t0];
      enter = Math.max(enter, t0); leave = Math.min(leave, t1);
      if (enter > leave) return false;
    }
  }
  return enter <= leave;
}

export function createVillageLightField(sources, buildings = []) {
  const boxes = buildings.map(boxFor), buckets = new Map(), cell = VILLAGE_LIGHTING.range;
  const lights = sources.map((source, index) => ({
    ...source, id: source.id ?? `lantern:${index}`,
    blockers: boxes.filter(box => Math.hypot(box.x - source.x, box.z - source.z)
      < cell + Math.hypot(box.halfX, box.halfZ)),
  }));
  for (const light of lights) {
    const key = `${Math.floor(light.x / cell)}:${Math.floor(light.z / cell)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(light);
  }
  function near(point) {
    const x = Math.floor(point.x / cell), z = Math.floor(point.z / cell), result = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const entries = buckets.get(`${x + dx}:${z + dz}`);
      if (entries) result.push(...entries);
    }
    return result;
  }
  function blocked(light, point, normal = null) {
    const end = normal ? {
      x: point.x + normal.x * 0.04, y: point.y + normal.y * 0.04, z: point.z + normal.z * 0.04,
    } : point;
    return light.blockers.some(box => segmentHitsVillageBuilding(light, end, box));
  }
  function sample(point, normal = { x: 0, y: 1, z: 0 }) {
    let irradiance = 0;
    for (const light of near(point)) {
      const dx = light.x - point.x, dy = light.y - point.y, dz = light.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= cell * cell) continue;
      const facing = Math.max(0, (dx * normal.x + dy * normal.y + dz * normal.z) / Math.sqrt(Math.max(d2, 0.01)));
      if (!facing || blocked(light, point, normal)) continue;
      // Match Three's finite-range inverse-square attenuation and Lambert BRDF.
      const cutoff = clamp01(1 - (d2 / (cell * cell)) ** 2);
      irradiance += VILLAGE_LIGHTING.intensity * facing * cutoff * cutoff / (Math.max(d2, 0.25) * Math.PI);
    }
    return Math.min(2, irradiance);
  }
  return { lights, near, blocked, sample };
}

export function villageGroundBounds(lights) {
  if (!lights.length) return null;
  const r = VILLAGE_LIGHTING.range;
  const minX = Math.min(...lights.map(l => l.x)) - r, maxX = Math.max(...lights.map(l => l.x)) + r;
  const minZ = Math.min(...lights.map(l => l.z)) - r, maxZ = Math.max(...lights.map(l => l.z)) + r;
  const width = maxX - minX, depth = maxZ - minZ;
  const size = Math.max(32, Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(width, depth) / 1.1))));
  return { minX, minZ, width, depth, size };
}

export function createVillageLightPool() {
  return Array.from({ length: VILLAGE_LIGHTING.desktopLights }, () => ({ source: null, level: 0 }));
}

export function stepVillageLightPool(pool, lights, receivers, viewer, night, dt, { xr = false, enabled = true, blocked = () => false } = {}) {
  const budget = xr ? VILLAGE_LIGHTING.xrLights : VILLAGE_LIGHTING.desktopLights;
  const byId = new Map(lights.map(l => [l.id, l])), held = new Set(pool.slice(0, budget).map(s => s.source?.id));
  const candidates = [];
  if (enabled && night > 0.001) for (const source of lights) {
    if (Math.hypot(source.x - viewer.x, source.z - viewer.z) > VILLAGE_LIGHTING.viewReach) continue;
    let score = 0, strength = 0;
    for (const receiver of receivers) {
      const d = Math.hypot(source.x - receiver.x, source.y - receiver.y, source.z - receiver.z);
      if (d >= VILLAGE_LIGHTING.receiverReach || blocked(source, receiver)) continue;
      const fade = clamp01((VILLAGE_LIGHTING.receiverReach - d) / 3);
      strength = Math.max(strength, fade);
      score = Math.max(score, fade * (receiver.player ? 2 : 1) / (1 + d * d));
    }
    if (score) candidates.push({ source, strength, score: score * (held.has(source.id) ? 1.35 : 1) });
  }
  candidates.sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id));
  const selected = new Map(candidates.slice(0, budget).map(c => [c.source.id, c]));
  const occupied = new Set(pool.map(slot => slot.source?.id));
  const response = 1 - Math.exp(-VILLAGE_LIGHTING.fadeRate * Math.min(0.1, Math.max(0, dt)));
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    if (i >= budget) { slot.level = 0; slot.source = null; continue; }
    // Unloaded sources vanish immediately. A retained source never travels:
    // fade completely out before assigning this slot to a different lantern.
    if (slot.source && !byId.has(slot.source.id)) { occupied.delete(slot.source.id); slot.source = null; slot.level = 0; }
    if (slot.source) {
      const current = byId.get(slot.source.id);
      if (current.x !== slot.source.x || current.y !== slot.source.y || current.z !== slot.source.z) {
        occupied.delete(slot.source.id); slot.source = null; slot.level = 0;
      } else slot.source = current;
    }
    const wanted = slot.source && selected.get(slot.source.id);
    slot.level += ((wanted ? wanted.strength * night : 0) - slot.level) * response;
    if (!wanted && slot.level < 0.003) {
      occupied.delete(slot.source?.id); slot.source = null; slot.level = 0;
      const next = [...selected.values()].find(c => !occupied.has(c.source.id));
      if (next) { slot.source = next.source; occupied.add(next.source.id); }
    }
  }
  return { budget, selected: selected.size, active: pool.filter(s => s.level > 0.003).length };
}
