// The courier's own map. Nothing is drawn for country the courier has not
// walked: the ground uncovers as they travel, and they stamp and label what
// they find. Pure data and 2D drawing so the desktop book, the VR panel and
// the tests share it. World convention: +Z north, +X east.

export const COURIER_MAP_CELL = 25;
const MAX_SEEN = 40000, MAX_MARKS = 300;
export const COURIER_STAMPS = Object.freeze([
  ['house', 'House'], ['post', 'Post board'], ['well', 'Well'], ['station', 'Station'], ['bridge', 'Bridge'],
  ['tree', 'Tree'], ['star', 'Important'], ['question', 'Not sure'], ['cross', 'Dead end'], ['label', 'Words only'],
]);
const KINDS = new Set(COURIER_STAMPS.map(([kind]) => kind));
const INK = '#25352e', PAPER = '#e9dfc4', OPEN = '#f6efda', FAINT = '#8d8a70', ACCENT = '#a6492f', GREEN = '#3d5a49';
const uid = () => globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2);

export function createCourierMap() { return { seen: [], marks: [] }; }
export function normalizeCourierMap(value) {
  const map = createCourierMap();
  for (const cell of Array.isArray(value?.seen) ? value.seen.slice(0, MAX_SEEN) : []) {
    if (typeof cell === 'string' && /^-?\d+,-?\d+$/.test(cell)) map.seen.push(cell);
  }
  for (const mark of Array.isArray(value?.marks) ? value.marks.slice(0, MAX_MARKS) : []) {
    if (!mark || !Number.isFinite(mark.x) || !Number.isFinite(mark.z)) continue;
    map.marks.push({ id: String(mark.id || uid()), kind: KINDS.has(mark.kind) ? mark.kind : 'star',
      text: String(mark.text || '').slice(0, 40), x: mark.x, z: mark.z });
  }
  return map;
}

const seenSets = new WeakMap();
function seenSet(map) {
  let set = seenSets.get(map);
  if (!set || set.size !== map.seen.length) { set = new Set(map.seen); seenSets.set(map, set); }
  return set;
}
const cellOf = value => Math.floor(value / COURIER_MAP_CELL);
/** Has the courier been close enough to this spot to have put it on the map? */
export function courierMapSeen(map, x, z) {
  return !!map && Number.isFinite(x) && Number.isFinite(z) && seenSet(map).has(cellOf(x) + ',' + cellOf(z));
}
/** Uncover the ground around a position; returns how many new cells appeared. */
export function revealCourierMap(map, x, z, radius = 55) {
  if (!map || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const set = seenSet(map), reach = Math.ceil(radius / COURIER_MAP_CELL);
  let added = 0;
  for (let ix = cellOf(x) - reach; ix <= cellOf(x) + reach; ix++) for (let iz = cellOf(z) - reach; iz <= cellOf(z) + reach; iz++) {
    const cx = (ix + 0.5) * COURIER_MAP_CELL, cz = (iz + 0.5) * COURIER_MAP_CELL, key = ix + ',' + iz;
    if (Math.hypot(cx - x, cz - z) > radius || set.has(key) || map.seen.length >= MAX_SEEN) continue;
    set.add(key); map.seen.push(key); added++;
  }
  return added;
}
export function addCourierMark(map, { kind = 'star', text = '', x, z }) {
  if (!map || !Number.isFinite(x) || !Number.isFinite(z) || map.marks.length >= MAX_MARKS) return null;
  const mark = { id: uid(), kind: KINDS.has(kind) ? kind : 'star', text: String(text).trim().slice(0, 40), x, z };
  map.marks.push(mark); return mark;
}
export function removeCourierMarkNear(map, x, z, reach = 20) {
  let best = null;
  for (const mark of map?.marks || []) {
    const d = Math.hypot(mark.x - x, mark.z - z);
    if (d <= reach && (!best || d < best.d)) best = { mark, d };
  }
  if (!best) return null;
  map.marks.splice(map.marks.indexOf(best.mark), 1); return best.mark;
}

/** A north-up, uniform-scale fit of world points into a canvas rectangle. */
export function courierMapProjection(points, width, height, { margin = 60, minSpan = 80 } = {}) {
  const usable = points.filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.z));
  if (!usable.length) usable.push({ x: 0, z: 0 });
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of usable) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  const spanX = Math.max(minSpan, maxX - minX), spanZ = Math.max(minSpan, maxZ - minZ);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanZ);
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  return {
    scale,
    project: point => ({ x: width / 2 + (point.x - centerX) * scale, y: height / 2 - (point.z - centerZ) * scale }),
    unproject: point => ({ x: centerX + (point.x - width / 2) / scale, z: centerZ - (point.y - height / 2) / scale }),
  };
}
/** A round distance for the scale bar that is about a fifth of the map wide. */
export function courierScaleBar(scale, width) {
  const target = width / 5 / scale;
  const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const metres = steps.reduce((best, step) => Math.abs(step - target) < Math.abs(best - target) ? step : best, steps[0]);
  return { metres, pixels: metres * scale, label: metres >= 1000 ? metres / 1000 + ' km' : metres + ' m' };
}
/** The village the courier is standing in, if any. */
export function courierMapPlaceAt(data, reach = 400) {
  const player = data?.player;
  if (!player) return null;
  let best = null;
  for (const place of data.places || []) {
    const d = Math.hypot(place.x - player.x, place.z - player.z);
    if (d <= reach && (!best || d < best.d)) best = { place, d };
  }
  return best?.place || null;
}
/** What a map page frames: the country nearby, or everything uncovered so far. */
export function courierMapView(data, map, mode, width, height) {
  if (mode === 'near') {
    const place = courierMapPlaceAt(data);
    if (place) {
      const frame = [...(place.buildings || []), place.board, place.well, place].filter(Boolean);
      return { title: place.name, projection: courierMapProjection(frame, width, height, { margin: 80, minSpan: 120 }) };
    }
    // Open country: a fixed window that does not follow each step.
    const cx = Math.round((data?.player?.x || 0) / 150) * 150, cz = Math.round((data?.player?.z || 0) / 150) * 150;
    return { title: 'Open country', projection: courierMapProjection([{ x: cx - 220, z: cz - 220 }, { x: cx + 220, z: cz + 220 }], width, height, { margin: 30 }) };
  }
  const corners = [];
  for (const cell of map?.seen || []) {
    const [ix, iz] = cell.split(',').map(Number);
    corners.push({ x: ix * COURIER_MAP_CELL, z: iz * COURIER_MAP_CELL }, { x: (ix + 1) * COURIER_MAP_CELL, z: (iz + 1) * COURIER_MAP_CELL });
  }
  return { title: 'Everywhere you have been', projection: courierMapProjection([...corners, ...(map?.marks || [])], width, height, { margin: 70, minSpan: 500 }) };
}

function label(ctx, text, x, y, { color = INK, font = '15px Georgia', align = 'center' } = {}) {
  ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  const width = ctx.measureText(text).width, left = align === 'center' ? x - width / 2 : x;
  ctx.fillStyle = 'rgba(246,239,218,.85)'; ctx.fillRect(left - 3, y - 14, width + 6, 19);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function stamp(ctx, kind, x, y, size = 9) {
  ctx.save(); ctx.translate(x, y); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = ACCENT; ctx.fillStyle = ACCENT;
  const s = size;
  if (kind === 'house') { ctx.beginPath(); ctx.moveTo(-s, s); ctx.lineTo(-s, -s * 0.2); ctx.lineTo(0, -s); ctx.lineTo(s, -s * 0.2); ctx.lineTo(s, s); ctx.closePath(); ctx.fill(); }
  else if (kind === 'post') { ctx.beginPath(); ctx.moveTo(-s * 0.6, s); ctx.lineTo(-s * 0.6, -s); ctx.stroke(); ctx.fillRect(-s * 0.6, -s, s * 1.5, s * 0.9); }
  else if (kind === 'well') { ctx.beginPath(); ctx.arc(0, 0, s * 0.8, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, s * 0.25, 0, Math.PI * 2); ctx.fill(); }
  else if (kind === 'station') { ctx.strokeRect(-s, -s * 0.6, s * 2, s * 1.2); ctx.beginPath(); ctx.moveTo(-s * 1.4, s); ctx.lineTo(s * 1.4, s); ctx.stroke(); }
  else if (kind === 'bridge') { ctx.beginPath(); ctx.arc(0, s * 0.5, s, Math.PI, 0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-s * 1.3, s * 0.5); ctx.lineTo(s * 1.3, s * 0.5); ctx.stroke(); }
  else if (kind === 'tree') { ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.8, s * 0.5); ctx.lineTo(-s * 0.8, s * 0.5); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(0, s * 0.5); ctx.lineTo(0, s); ctx.stroke(); }
  else if (kind === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.45 : s, a = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'cross') { ctx.beginPath(); ctx.moveTo(-s * 0.8, -s * 0.8); ctx.lineTo(s * 0.8, s * 0.8); ctx.moveTo(s * 0.8, -s * 0.8); ctx.lineTo(-s * 0.8, s * 0.8); ctx.stroke(); }
  else if (kind === 'question') { ctx.font = 'bold ' + Math.round(s * 2.2) + 'px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', 0, 1); }
  else { ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
/** Draw one stamp for a toolbar swatch. */
export function paintCourierStamp(ctx, kind, width, height) {
  ctx.clearRect(0, 0, width, height); stamp(ctx, kind, width / 2, height / 2, Math.min(width, height) * 0.3);
}

function line(ctx, points, project) {
  ctx.beginPath();
  points.forEach((point, i) => { const at = project(point); if (i) ctx.lineTo(at.x, at.y); else ctx.moveTo(at.x, at.y); });
  ctx.stroke();
}
function baseline(ctx, data, { project, scale }) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // Signed roads: the posts are what the courier actually sees, so they are drawn too.
  ctx.strokeStyle = '#9a8a62'; ctx.lineWidth = Math.max(2, 4 * Math.min(1, scale * 2)); ctx.setLineDash([2, 7]);
  for (const road of data?.roads || []) if (road.length > 1) line(ctx, road, project);
  ctx.setLineDash([]);
  if (scale > 0.25) {
    ctx.fillStyle = '#6b5a3a';
    for (const road of data?.roads || []) for (const post of road) { const at = project(post); ctx.fillRect(at.x - 2, at.y - 2, 4, 4); }
  }
  if (data?.rail?.length > 1) {
    ctx.strokeStyle = INK; ctx.lineWidth = 5; line(ctx, data.rail, project);
    ctx.strokeStyle = OPEN; ctx.lineWidth = 2; ctx.setLineDash([8, 8]); line(ctx, data.rail, project); ctx.setLineDash([]);
  }
  for (const place of data?.places || []) {
    for (const building of place.buildings || []) {
      const at = project(building), w = Math.max(3, (building.width || 8) * scale), d = Math.max(3, (building.depth || 6) * scale);
      ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(building.yaw || 0);
      ctx.fillStyle = '#cdbf9b'; ctx.strokeStyle = '#6b5a3a'; ctx.lineWidth = scale > 0.8 ? 1.5 : 1;
      ctx.fillRect(-w / 2, -d / 2, w, d); if (w > 5) ctx.strokeRect(-w / 2, -d / 2, w, d);
      ctx.restore();
    }
    if (scale > 0.5 && place.well) {
      const at = project(place.well);
      ctx.fillStyle = '#7f9fa6'; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(at.x, at.y, Math.max(4, 1.6 * scale), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (scale > 0.5 && place.board) {
      const at = project(place.board);
      ctx.fillStyle = GREEN; ctx.fillRect(at.x - 5, at.y - 5, 10, 10);
    }
  }
}

/**
 * Paint a map page and return the projection used, so a click can be turned
 * back into a place in the world. Country the courier has not walked stays
 * blank paper; the courier's own stamps and labels always show.
 */
export function paintCourierMap(ctx, data, map, mode, width, height) {
  const view = courierMapView(data, map, mode, width, height), { project, scale } = view.projection;
  ctx.setLineDash([]); ctx.fillStyle = PAPER; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(120,105,70,.16)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let offset = -height; offset < width; offset += 16) { ctx.moveTo(offset, 0); ctx.lineTo(offset + height, height); }
  ctx.stroke();
  // Uncovered ground: every cell the courier has been near, as one clipped region.
  const radius = Math.max(1.5, COURIER_MAP_CELL * 0.78 * scale);
  ctx.save(); ctx.beginPath();
  for (const cell of map?.seen || []) {
    const [ix, iz] = cell.split(',').map(Number);
    const at = project({ x: (ix + 0.5) * COURIER_MAP_CELL, z: (iz + 0.5) * COURIER_MAP_CELL });
    if (at.x < -radius || at.y < -radius || at.x > width + radius || at.y > height + radius) continue;
    ctx.moveTo(at.x + radius, at.y); ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  }
  ctx.clip(); ctx.fillStyle = OPEN; ctx.fillRect(0, 0, width, height);
  baseline(ctx, data, view.projection);
  ctx.restore();
  for (const place of data?.places || []) {
    if (!courierMapSeen(map, place.x, place.z) && !(place.board && courierMapSeen(map, place.board.x, place.board.z))) continue;
    const at = project(place.board || place);
    if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) continue;
    if (mode !== 'near') label(ctx, place.name, at.x, at.y - 14, { font: 'bold 18px Georgia', color: GREEN });
    else if (place.board) label(ctx, 'Post board', at.x, at.y - 12, { font: 'italic 14px Georgia', color: GREEN });
  }
  for (const mark of map?.marks || []) {
    const at = project(mark);
    if (at.x < -20 || at.y < -20 || at.x > width + 20 || at.y > height + 20) continue;
    stamp(ctx, mark.kind, at.x, at.y, 9);
    if (mark.text) label(ctx, mark.text, at.x + 14, at.y + 5, { align: 'left', color: ACCENT, font: 'bold 15px Georgia' });
  }
  ctx.strokeStyle = '#b9ad8a'; ctx.lineWidth = 2; ctx.strokeRect(5, 5, width - 10, height - 10);
  label(ctx, view.title, 20, 34, { align: 'left', font: 'bold 20px Georgia', color: GREEN });
  const x = width - 40, y = 54;
  ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x, y - 14); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - 24); ctx.lineTo(x - 7, y - 9); ctx.lineTo(x + 7, y - 9); ctx.closePath(); ctx.fill();
  ctx.font = 'bold 16px Georgia'; ctx.textAlign = 'center'; ctx.fillText('N', x, y + 36);
  const bar = courierScaleBar(scale, width), left = 20, base = height - 22;
  ctx.beginPath(); ctx.moveTo(left, base - 6); ctx.lineTo(left, base); ctx.lineTo(left + bar.pixels, base); ctx.lineTo(left + bar.pixels, base - 6); ctx.stroke();
  ctx.font = '15px Georgia'; ctx.textAlign = 'left'; ctx.fillText(bar.label, left + bar.pixels + 8, base + 2);
  return view.projection;
}
