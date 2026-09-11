// Canonical, serializable identities shared by the planner and all consumers.
export function plain(value) {
  if (value instanceof Map) return { type: 'Map', entries: [...value.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, entry]) => [plain(key), plain(entry)]) };
  if (ArrayBuffer.isView(value)) return Array.from(value, plain);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, plain(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite crossing data');
  if (typeof value === 'function') throw new Error('Crossing manifests must be serializable');
  if (value === 0) return 0; // JSON has one zero; canonicalise IEEE negative zero
  return value;
}

export function descriptorHash(value) {
  const text = JSON.stringify(plain(value));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}


export const BASIN_PLAN_VERSION = 1;
export const BASIN_REGION_SIZE = 4096;
