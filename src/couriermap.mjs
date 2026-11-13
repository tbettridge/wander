// The courier's own map. Nothing is drawn for country the courier has not
// walked: the ground uncovers as they travel, and they stamp and label what
// they find. Pure data and 2D drawing so the desktop book, the VR panel and
// the tests share it. World convention: +Z north, +X WEST (compasshud.mjs), so
// a north-up page draws +X to the left, as the land looks to someone facing north.

export const COURIER_MAP_CELL = 25;
const MAX_SEEN = 40000, MAX_MARKS = 300;
export const COURIER_STAMPS = Object.freeze([
  ['house', 'House'], ['post', 'Post board'], ['well', 'Well'], ['station', 'Station'], ['bridge', 'Bridge'],
  ['tree', 'Tree'], ['star', 'Important'], ['question', 'Not sure'], ['cross', 'Dead end'], ['label', 'Words only'],
]);
const KINDS = new Set(COURIER_STAMPS.map(([kind]) => kind));
const INK = '#25352e', PAPER = '#e9dfc4', OPEN = '#f6efda', FAINT = '#8d8a70', ACCENT = '#a6492f', GREEN = '#3d5a49';
const uid = () => globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2);

// `place` is the village the courier last knew they were in: set by passing
// its name sign, reading its board or stepping off at its station. The map
// never learns where the courier is from anything else.
export function createCourierMap() { return { seen: [], marks: [], place: null, arrived: [] }; }
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
  // A place is a tutorial key ('A') or any settlement's id ('station-settlement:3', 'settlement:-12:40').
  const placeKey = key => typeof key === 'string' && key.length <= 48 && /^[A-Za-z0-9:_-]+$/.test(key);
  if (placeKey(value?.place)) map.place = value.place;
  for (const key of Array.isArray(value?.arrived) ? value.arrived.slice(0, 64) : []) if (placeKey(key) && !map.arrived.includes(key)) map.arrived.push(key);
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

/** A north-up, uniform-scale fit of world points into a canvas rectangle. East (-X) is on the right. */
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
    project: point => ({ x: width / 2 - (point.x - centerX) * scale, y: height / 2 - (point.z - centerZ) * scale }),
    unproject: point => ({ x: centerX - (point.x - width / 2) / scale, z: centerZ - (point.y - height / 2) / scale }),
  };
}
/** A round distance for the scale bar that is about a fifth of the map wide. */
export function courierScaleBar(scale, width) {
  const target = width / 5 / scale;
  const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const metres = steps.reduce((best, step) => Math.abs(step - target) < Math.abs(best - target) ? step : best, steps[0]);
  return { metres, pixels: metres * scale, label: metres >= 1000 ? metres / 1000 + ' km' : metres + ' m' };
}
/** Uncover a whole village at once: the courier knows their home village. */
export function revealCourierPlace(map, place) {
  if (!map || !place) return 0;
  let added = revealCourierMap(map, place.x, place.z, 90);
  for (const building of place.buildings || []) added += revealCourierMap(map, building.x, building.z, 40);
  for (const spot of [place.board, place.well]) if (spot) added += revealCourierMap(map, spot.x, spot.z, 40);
  return added;
}
/** The village whose buildings are nearest a position, if any (used by tests and debugging, not the map page). */
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
  // "Near" is the last village the courier knew they were in, never a frame
  // that follows them: in open country they have to place themselves.
  const place = mode === 'near' && map?.place ? (data?.places || []).find(item => item.key === map.place) : null;
  if (place) {
    const frame = [...(place.buildings || []), place.board, place.well, place].filter(Boolean);
    return { title: place.name, projection: courierMapProjection(frame, width, height, { margin: 80, minSpan: 120 }) };
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

/** Turn a canvas already at a building's spot on a north-up page to lie along the building. */
function alongBuilding(ctx, building) {
  // The page mirrors X (east is -X), so the building's own axes mirror too.
  ctx.scale(-1, 1); ctx.rotate(building.yaw || 0);
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
      ctx.save(); ctx.translate(at.x, at.y); alongBuilding(ctx, building);
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
    if (!map?.arrived?.includes(place.key) && !courierMapSeen(map, place.x, place.z) && !(place.board && courierMapSeen(map, place.board.x, place.board.z))) continue;
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

/**
 * The village plan pinned beside each Post & Errands board: the one map in the
 * game that says "you are here". It is drawn heads-up, the way a reader sees it
 * standing at the board, so up is the way they face (`heading`, a compass
 * angle: 0 north, PI south) and a north arrow shows where north really is.
 * `roads` are the signed roads out of this village, from the village outward,
 * as { name, walk, points }.
 */
export function postedMapLayout(place, roads, heading, width, height, { margin = 92 } = {}) {
  const origin = place?.board || place || { x: 0, z: 0 };
  const h = Number.isFinite(heading) ? heading : 0;
  // Forward for a compass heading (+X is west), and the reader's right hand as
  // the renderer places it: forward x up.
  const fx = -Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
  const rotate = point => {
    const dx = point.x - origin.x, dz = point.z - origin.z;
    return { u: dx * rx + dz * rz, v: dx * fx + dz * fz };
  };
  const frame = [...(place?.buildings || []), place?.board, place?.well, place].filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.z)).map(rotate);
  if (!frame.length) frame.push({ u: 0, v: 0 });
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const { u, v } of frame) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const spanU = Math.max(120, maxU - minU + 24), spanV = Math.max(120, maxV - minV + 24);
  const scale = Math.min((width - margin * 2) / spanU, (height - margin * 2) / spanV);
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const project = point => { const { u, v } = rotate(point); return { x: width / 2 + (u - cu) * scale, y: height / 2 - (v - cv) * scale }; };
  // Where each road leaves the plan, so its destination can be written there.
  const inset = margin * 0.62;
  const inside = at => at.x >= inset && at.x <= width - inset && at.y >= inset && at.y <= height - inset;
  const exits = [];
  for (const road of roads || []) {
    const path = (road.points || []).filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.z)).map(project);
    if (path.length < 2) continue;
    let exit = null;
    for (let i = 1; i < path.length && !exit; i++) {
      const a = path[i - 1], b = path[i];
      if (!inside(a) || inside(b)) continue;
      let lo = 0, hi = 1;
      for (let step = 0; step < 24; step++) { const mid = (lo + hi) / 2; if (inside({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid })) lo = mid; else hi = mid; }
      exit = { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    if (!exit) { const a = path[path.length - 2], b = path[path.length - 1]; exit = { x: b.x, y: b.y, angle: Math.atan2(b.y - a.y, b.x - a.x) }; }
    // Roads that leave by the same lane share one arrow, with every name on it.
    const shared = exits.find(other => Math.hypot(other.x - exit.x, other.y - exit.y) < Math.min(width, height) * 0.08);
    if (shared) shared.names.push({ name: road.name, walk: road.walk || '' });
    else exits.push({ names: [{ name: road.name, walk: road.walk || '' }], ...exit });
  }
  // The same turn as a canvas transform from the north-up page (a plain
  // rotation, since both are drawn as the land looks), for building outlines.
  const matrix = [Math.cos(h), -Math.sin(h), Math.sin(h), Math.cos(h)];
  return { scale, project, here: project(origin), north: { x: -Math.sin(h), y: -Math.cos(h) }, matrix, exits };
}

/** Paint the posted village plan (the board's own map, not the courier's). */
export function paintPostedVillageMap(ctx, place, roads, heading, width, height) {
  const layout = postedMapLayout(place, roads, heading, width, height), { project, scale } = layout;
  const unit = Math.min(width, height) / 600;
  ctx.setLineDash([]); ctx.fillStyle = OPEN; ctx.fillRect(0, 0, width, height);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#9a8a62'; ctx.lineWidth = Math.max(3, 7 * unit); ctx.setLineDash([3 * unit, 11 * unit]);
  for (const road of roads || []) {
    const path = (road.points || []).filter(point => point && Number.isFinite(point.x));
    if (path.length > 1) line(ctx, path, project);
  }
  ctx.setLineDash([]);
  for (const building of place?.buildings || []) {
    const at = project(building), w = Math.max(4, (building.width || 8) * scale), d = Math.max(4, (building.depth || 6) * scale);
    ctx.save(); ctx.translate(at.x, at.y); ctx.transform(...layout.matrix, 0, 0); alongBuilding(ctx, building);
    ctx.fillStyle = '#cdbf9b'; ctx.strokeStyle = '#6b5a3a'; ctx.lineWidth = 1.5 * unit;
    ctx.fillRect(-w / 2, -d / 2, w, d); ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.restore();
  }
  if (place?.well) {
    const at = project(place.well);
    ctx.fillStyle = '#7f9fa6'; ctx.strokeStyle = INK; ctx.lineWidth = 2 * unit;
    ctx.beginPath(); ctx.arc(at.x, at.y, 9 * unit, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    label(ctx, 'Well', at.x + 16 * unit, at.y + 6 * unit, { align: 'left', font: 'italic ' + Math.round(17 * unit) + 'px Georgia' });
  }
  for (const exit of layout.exits) {
    ctx.save(); ctx.translate(exit.x, exit.y); ctx.rotate(exit.angle);
    ctx.fillStyle = GREEN; ctx.beginPath(); ctx.moveTo(16 * unit, 0); ctx.lineTo(-6 * unit, -11 * unit); ctx.lineTo(-6 * unit, 11 * unit); ctx.closePath(); ctx.fill();
    ctx.restore();
    // Write the destination just inside the arrow, kept on the paper.
    const rows = exit.names.length * 2, tall = rows * 22 * unit;
    const tx = Math.max(90 * unit, Math.min(width - 90 * unit, exit.x - Math.cos(exit.angle) * 40 * unit));
    const ty = Math.max(60 * unit, Math.min(height - 30 * unit - tall, exit.y - Math.sin(exit.angle) * 40 * unit - (Math.sin(exit.angle) > 0 ? tall : 0)));
    exit.names.forEach((entry, i) => {
      const y = ty + i * 44 * unit;
      label(ctx, 'To ' + entry.name, tx, y, { font: 'bold ' + Math.round(21 * unit) + 'px Georgia', color: GREEN });
      if (entry.walk) label(ctx, entry.walk + ' on foot', tx, y + 21 * unit, { font: 'italic ' + Math.round(17 * unit) + 'px Georgia' });
    });
  }
  // You are here: the board itself.
  const here = layout.here;
  stamp(ctx, 'star', here.x, here.y, 15 * unit);
  label(ctx, 'You are here', here.x, here.y - 22 * unit, { font: 'bold ' + Math.round(20 * unit) + 'px Georgia', color: ACCENT });
  ctx.strokeStyle = '#7a6848'; ctx.lineWidth = 6 * unit; ctx.strokeRect(3 * unit, 3 * unit, width - 6 * unit, height - 6 * unit);
  label(ctx, place?.name || 'This village', 22 * unit, 40 * unit, { align: 'left', font: 'bold ' + Math.round(26 * unit) + 'px Georgia', color: GREEN });
  // North arrow, turned to where north really lies from the board.
  const nx = width - 52 * unit, ny = 62 * unit, n = layout.north, len = 30 * unit;
  ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 2.5 * unit;
  ctx.beginPath(); ctx.moveTo(nx - n.x * len, ny - n.y * len); ctx.lineTo(nx + n.x * len * 0.6, ny + n.y * len * 0.6); ctx.stroke();
  ctx.save(); ctx.translate(nx + n.x * len, ny + n.y * len); ctx.rotate(Math.atan2(n.y, n.x));
  ctx.beginPath(); ctx.moveTo(6 * unit, 0); ctx.lineTo(-12 * unit, -8 * unit); ctx.lineTo(-12 * unit, 8 * unit); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.font = 'bold ' + Math.round(18 * unit) + 'px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', nx + n.x * (len + 20 * unit), ny + n.y * (len + 20 * unit)); ctx.textBaseline = 'alphabetic';
  label(ctx, 'Up is the way you face as you read this board', width / 2, height - 16 * unit, { font: 'italic ' + Math.round(15 * unit) + 'px Georgia', color: FAINT });
  return layout;
}
