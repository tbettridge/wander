// Brooks in the folds of the forest hills.
//
// The planned hydrology carries the rivers and lakes; it does not carry the
// small water that makes a wood feel alive: a brook rising on a hillside,
// finding its way down the creases of the ground over stones and moss, now
// and then dropping a step in a little cascade, and losing itself in a hollow
// or running into the river below. These are those brooks.
//
// Each rises at a spring on a forested slope and follows the ground down by
// steepest descent, which is what water does, so brooks gather in the
// natural folds of the terrain without the terrain being cut. A brook ends
// where the ground stops falling (it sinks into the hollow), where it meets
// real water, or before it would cross a trail, a village or the railway.
//
// In a planned landscape these are the narrow headwater creeks: only traces
// that reach an owned river or lake are published, and the final surface joins
// that body's level and current. Legacy landscapes retain their hollow ponds.
// Deterministic per BROOK_CELL cell, cached per world. Pure and THREE-free.

import { mulberry32 } from './noise.js';
import { settlementsAround } from './settlementplacement.mjs';
import { nearestTrailPoint, trailsAround } from './trails.js';

export const BROOK_CELL = 420;
const STEP = 7;
const MAX_STEPS = 110;              // about 770 m of brook at most
export const BROOK_REACH = STEP * MAX_STEPS + 20;
const CASCADE_SLOPE = 0.5;          // fall per metre of bed that drops as a little waterfall
const SPILL_RISE = 0.6;             // how far a brook may rise to spill out of a hollow
const MAX_SPILLS = 6;
const CACHE_LIMIT = 900;
const BED_CUT = 0.8;                // deepest a brook's bed is worn below the drawn ground
const BED_BANK = 2;                 // metres over which a brook's bank eases back to the ground
const drainageTargets = new WeakMap();

// Sparse accepted water already provides real receiving points. Index a
// coarse subset once, rather than searching for a river during every trace.
function targetsFor(world) {
  const field = world.waterField;
  if (!field) return null;
  if (drainageTargets.has(field)) return drainageTargets.get(field);
  const bins = new Map(), add = (x, z, y, regionalTrunk = false) => {
    const key = `${Math.floor(x / BROOK_CELL)},${Math.floor(z / BROOK_CELL)}`;
    let list = bins.get(key);
    if (!list) { list = []; bins.set(key, list); }
    list.push({ x, z, y, regionalTrunk });
  };
  for (const component of field.components.values()) {
    const g = component.mesh.grid;
    if (!g.coords) continue;
    for (let i = 0; i < g.coords.length; i += 8) {
      if (g.signed[i] > 0.12 && g.head[i] > 0.25) {
        add(g.coords[i][0] * g.step, g.coords[i][1] * g.step, g.head[i], component.mesh.regionalTrunk === true);
      }
    }
  }
  for (const body of field.bodies.values()) {
    const g = body.grid;
    for (let i = 0; i < g.signed.length; i += 8) if (g.signed[i] > 0.12) {
      add(g.x0 + i % g.cols * g.step, g.z0 + Math.floor(i / g.cols) * g.step, body.level);
    }
  }
  drainageTargets.set(field, bins);
  return bins;
}

function receivingTarget(bins, x, z, y) {
  const cx = Math.floor(x / BROOK_CELL), cz = Math.floor(z / BROOK_CELL);
  let best = null, distance = BROOK_REACH * BROOK_REACH;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    for (const p of bins.get(`${cx + dx},${cz + dz}`) || []) {
      if (p.y >= y - 0.15) continue;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < distance) { best = p; distance = d; }
    }
  }
  return best;
}

// Where the planned regional creeks run, indexed once per water field, so a
// forest brook never crosses one or runs down the same fold beside it.
const plannedIndexes = new WeakMap();
const PLANNED_CELL = 24;
function plannedCreekNear(world, x, z, margin) {
  const field = world.waterField;
  if (!field?.creekBins?.size) return false;
  let grid = plannedIndexes.get(field);
  if (!grid) {
    grid = new Map();
    for (const pieces of field.creekBins.values()) for (const piece of pieces) {
      const pts = piece.points;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az, aw] = pts[i - 1], [bx, bz] = pts[i], pad = 32;
        const entry = [ax, az, bx, bz, aw / 2];
        for (let gz = Math.floor((Math.min(az, bz) - pad) / PLANNED_CELL); gz <= Math.floor((Math.max(az, bz) + pad) / PLANNED_CELL); gz++) {
          for (let gx = Math.floor((Math.min(ax, bx) - pad) / PLANNED_CELL); gx <= Math.floor((Math.max(ax, bx) + pad) / PLANNED_CELL); gx++) {
            const key = `${gx},${gz}`;
            const list = grid.get(key);
            if (list) list.push(entry); else grid.set(key, [entry]);
          }
        }
      }
    }
    plannedIndexes.set(field, grid);
  }
  for (const [ax, az, bx, bz, hw] of grid.get(`${Math.floor(x / PLANNED_CELL)},${Math.floor(z / PLANNED_CELL)}`) || []) {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    if (Math.hypot(x - ax - dx * t, z - az - dz * t) < hw + margin) return true;
  }
  return false;
}

function cellSeed(world, ci, cj) {
  return (Math.imul(ci, 83492791) ^ Math.imul(cj, 2971215073) ^ Math.imul(world.seed | 0, 19349663) ^ 0x42524f4b) >>> 0;
}

function cacheFor(world) {
  const planHash = world.waterField ? world.waterPlanHash || world.waterField.hash : null;
  if (world._brookPlanHash !== planHash) {
    world._brookPlanHash = planHash;
    world._brookCache = new Map(); world._brookGrid = new Map();
  }
  return world._brookCache || (world._brookCache = new Map());
}

/** Whether the brooks of a cell are already traced (cheap to ask for). */
export function brookCellReady(world, ci, cj) {
  return cacheFor(world).has(`${ci},${cj}`);
}

/** The brooks rising in cell (ci, cj). Cached per world. */
export function brooksForCell(world, ci, cj) {
  const cache = cacheFor(world);
  const key = `${ci},${cj}`;
  if (cache.has(key)) return cache.get(key);
  const brooks = planCell(world, ci, cj);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, brooks);
  indexBrooks(world, brooks);
  return brooks;
}

// A coarse grid of brook segments (and ponds), filled as cells are traced,
// so a per-texel question — is there a brook bed here? — costs a map lookup
// and a few segment distances, and never traces anything.
const GRID = 12;
function indexBrooks(world, brooks) {
  const grid = world._brookGrid || (world._brookGrid = new Map());
  if (grid.size > 60000) grid.clear();
  const add = (gx, gz, entry) => {
    const key = `${gx},${gz}`;
    const list = grid.get(key);
    if (list) list.push(entry); else grid.set(key, [entry]);
  };
  for (const brook of brooks) {
    const p = brook.pts;
    for (let i = 0; i < brook.count - 1; i++) {
      const entry = [p[i * 4], p[i * 4 + 2], p[i * 4 + 4], p[i * 4 + 6], Math.max(p[i * 4 + 3], p[i * 4 + 7]) / 2];
      const pad = entry[4] * 1.7 + 2.2;
      const gx0 = Math.floor((Math.min(entry[0], entry[2]) - pad) / GRID), gx1 = Math.floor((Math.max(entry[0], entry[2]) + pad) / GRID);
      const gz0 = Math.floor((Math.min(entry[1], entry[3]) - pad) / GRID), gz1 = Math.floor((Math.max(entry[1], entry[3]) + pad) / GRID);
      for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) add(gx, gz, entry);
    }
    if (brook.pond) {
      const { x, z, r } = brook.pond;
      const entry = [x, z, x, z, r];
      for (let gz = Math.floor((z - r - 2) / GRID); gz <= Math.floor((z + r + 2) / GRID); gz++) {
        for (let gx = Math.floor((x - r - 2) / GRID); gx <= Math.floor((x + r + 2) / GRID); gx++) add(gx, gz, entry);
      }
    }
  }
}

/**
 * Whether (x, z) lies in the bed of an already-traced brook: within its
 * half-width scaled by `widthScale`, plus `margin` metres. Never traces.
 */
export function inBrookBed(world, x, z, widthScale = 1.7, margin = 1.6) {
  const list = world._brookGrid?.get(`${Math.floor(x / GRID)},${Math.floor(z / GRID)}`);
  if (!list) return false;
  for (const [ax, az, bx, bz, hw] of list) {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < hw * widthScale + margin) return true;
  }
  return false;
}

// A planned regional creek: the river planner traced its course down the
// real ground and the water that receives it, with a water level that never
// rises. Lay it in the ground as a brook, with cascades where it steps down.
function plannedBrook(world, piece, rng) {
  const raw = [];
  // Older plans carry no water level; their brooks follow the ground.
  const level = (p, x, z) => (p.length > 3 ? p[3] : world.height(x, z));
  for (let i = 0; i < piece.points.length - 1; i++) {
    const a = piece.points[i], b = piece.points[i + 1];
    const [ax, az, aw] = a, [bx, bz, bw] = b, ay = level(a, ax, az), by = level(b, bx, bz);
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 4));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      raw.push([x, ay + (by - ay) * t, z, aw + (bw - aw) * t]);
    }
  }
  {
    const last = piece.points.at(-1), [ex, ez, ew] = last;
    raw.push([ex, level(last, ex, ez), ez, ew]);
  }
  // Within the receiving river's own ground the creek runs down its banks.
  const ground = {};
  for (const p of raw) {
    const h = world.height(p[0], p[2], ground);
    if (ground.bodyId) p[1] = Math.min(p[1], h);
  }
  // Water never climbs. Where the ground stands higher above the water than
  // a brook's worn bed can account for, the creek rises again below it.
  let climb = -1;
  for (let i = 0; i < raw.length; i++) if (world.height(raw[i][0], raw[i][2]) - raw[i][1] > BED_CUT - 0.1) climb = i;
  if (climb >= 0) raw.splice(0, climb + 1);
  // A creek with its own worn bed runs on under a path as a ford; older
  // planned creeks give way to paths like forest brooks.
  const worn = piece.points[0].length > 3;
  // Like forest brooks, a creek gives way to paths and villages: a receiving
  // creek rises again below the last one it would cross, any other stops short.
  let cx = 0, cz = 0;
  for (const p of raw) { cx += p[0]; cz += p[2]; }
  cx /= raw.length; cz /= raw.length;
  const extent = Math.max(...raw.map(p => Math.hypot(p[0] - cx, p[2] - cz)));
  const trails = trailsAround(world, cx, cz, world.seed, extent + 30, []);
  const sites = settlementsAround(world, cx, cz, world.seed, extent + 40, []);
  const near = {}, blocked = [];
  for (let i = 0; i < raw.length; i++) {
    const [px, , pz, w] = raw[i];
    if (trails.length && !worn) {
      nearestTrailPoint(trails, px, pz, near);
      if (near.distance < (near.width || 1.5) + w + 3) { blocked.push(i); continue; }
    }
    if (sites.some(site => Math.hypot(site.x - px, site.z - pz) < (site.exclusionHalo || site.radius || 60) + 8)) blocked.push(i);
  }
  if (blocked.length) {
    if (piece.receiver === 'river') raw.splice(0, blocked.at(-1) + 2);
    else raw.length = Math.max(0, blocked[0] - 1);
  }
  if (raw.length < 12) return null;
  const [ex, , ez] = raw.at(-1);
  let receiving = null;
  if (piece.receiver === 'river') {
    const water = world.riverAt(ex, ez);
    if (!water.wet || !water.bodyId) return null;
    receiving = { bodyId: water.bodyId, kind: water.kind, x: ex, z: ez, y: water.y,
      flowX: water.flowX || 0, flowZ: water.flowZ || 0 };
    // Running water never climbs: settle the line down to the receiving head.
    for (let i = raw.length - 2; i >= 0; i--) raw[i][1] = Math.max(raw[i][1], receiving.y);
  }
  const brook = finish(world, raw, rng, piece.id, receiving);
  if (receiving) {
    const end = (brook.count - 1) * 4;
    const water = world.riverAt(brook.pts[end], brook.pts[end + 2]);
    if (!water.wet || water.bodyId !== receiving.bodyId) return null;
    const head = Math.fround(water.y);
    for (let i = brook.count - 1; i >= 0 && brook.pts[i * 4 + 1] < head; i--) brook.pts[i * 4 + 1] = head;
    brook.pts[end + 1] = head;
    Object.assign(receiving, { x: brook.pts[end], z: brook.pts[end + 2], y: water.y });
  }
  // A middle piece continues into the next one rather than ending in a tip.
  if (!piece.receiver && !blocked.length && brook.count > 1) brook.pts[(brook.count - 1) * 4 + 3] = brook.pts[(brook.count - 2) * 4 + 3];
  // A creek that runs into a hollow too deep to cut through ends in a pool
  // on its floor.
  if (piece.receiver === 'pool' && piece.pool && !world.riverAt(piece.pool[0], piece.pool[1]).wet) {
    const [x, z, y, r] = piece.pool;
    brook.pond = { id: `${piece.id}:pond`, x, z, y, r, yaw: rng() * Math.PI * 2, seed: rng() };
    brook.minX = Math.min(brook.minX, x - r); brook.maxX = Math.max(brook.maxX, x + r);
    brook.minZ = Math.min(brook.minZ, z - r); brook.maxZ = Math.max(brook.maxZ, z + r);
  }
  brook.planned = true;
  return brook;
}

function plannedBrooks(world, ci, cj) {
  const field = world.waterField;
  if (!field?.plannedCreeks) return [];
  const x0 = ci * BROOK_CELL, z0 = cj * BROOK_CELL, brooks = [];
  const rng = mulberry32(cellSeed(world, ci, cj) ^ 0x6372656b);
  for (const piece of field.plannedCreeks(x0, z0, x0 + BROOK_CELL, z0 + BROOK_CELL)) {
    const brook = plannedBrook(world, piece, rng);
    if (brook) brooks.push(brook);
  }
  return brooks;
}

function planCell(world, ci, cj) {
  const planned = plannedBrooks(world, ci, cj);
  return planned.length ? [...planned, ...planForestCell(world, ci, cj)] : planForestCell(world, ci, cj);
}

function planForestCell(world, ci, cj) {
  // Creeks cannot feed a drainage network beyond their bounded downhill
  // reach. Skip those cells before any forest/terrain/route sampling.
  if (world.waterField && !world.waterField.gridStep(ci * BROOK_CELL - BROOK_REACH,
    cj * BROOK_CELL - BROOK_REACH, (ci + 1) * BROOK_CELL + BROOK_REACH,
    (cj + 1) * BROOK_CELL + BROOK_REACH)) return [];
  const rng = mulberry32(cellSeed(world, ci, cj));
  const roll = rng();
  const wanted = roll < 0.2 ? 0 : roll < 0.7 ? 1 : roll < 0.92 ? 2 : 3;
  const targets = targetsFor(world);
  const nearbyShores = targets ? [-1, 0, 1].flatMap(dz => [-1, 0, 1].flatMap(dx =>
    targets.get(`${ci + dx},${cj + dz}`) || [])) : [];
  const localShores = nearbyShores.some(shore => shore.regionalTrunk) ? nearbyShores.filter(point => {
      // Biased sources start at most 84 + 112m from their selected shore.
      // A farther target cannot generate a source in this owning cell and
      // must not consume attempts when a new regional river appears nearby.
      const dx = Math.max(ci * BROOK_CELL - point.x, 0, point.x - (ci + 1) * BROOK_CELL);
      const dz = Math.max(cj * BROOK_CELL - point.z, 0, point.z - (cj + 1) * BROOK_CELL);
      return dx * dx + dz * dz <= 196 * 196;
    }) : nearbyShores;
  const tributaryShores = localShores.filter(shore => !shore.regionalTrunk);
  // Prefer nearby tributaries and basin shores for the small forest sources.
  // Broad channels remain receivers where no ordinary local shore is present.
  const shores = tributaryShores.length ? tributaryShores : localShores;
  const brooks = [];
  for (let n = 0; n < wanted; n++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      let x = (ci + rng()) * BROOK_CELL, z = (cj + rng()) * BROOK_CELL;
      if (shores.length && attempt < 8) {
        const shore = shores[Math.floor(rng() * shores.length)], angle = rng() * Math.PI * 2;
        const distance = 84 + rng() * 112;
        x = shore.x + Math.cos(angle) * distance; z = shore.z + Math.sin(angle) * distance;
        if (Math.floor(x / BROOK_CELL) !== ci || Math.floor(z / BROOK_CELL) !== cj) continue;
      }
      const b = world.biomeAt(x, z);
      if (b.id !== 'forest' || b.h < (world.waterField ? 2 : 6) || b.h > 170
        || b.slope < (world.waterField ? 0.012 : 0.04) || b.slope > 0.2) continue;
      if (world.riverAt(x, z).wet || plannedCreekNear(world, x, z, 30)) continue;
      const receiver = targets ? receivingTarget(targets, x, z, b.h) : null;
      if (targets && !receiver) continue;
      if (settlementsAround(world, x, z, world.seed, 60, []).length) continue;
      const brook = trace(world, x, z, b.h, rng, `brook:${ci}:${cj}:${n}`, receiver);
      if (brook) { brooks.push(brook); break; }
    }
  }
  return brooks;
}

function trace(world, x, z, y, rng, id, target = null) {
  const pts = [[x, y, z]];
  let heading = null, outside = 0, spills = 0, pond = null, receiving = null;
  const skew = rng() * Math.PI * 2;
  for (let s = 0; s < MAX_STEPS; s++) {
    const remaining = target ? Math.hypot(target.x - x, target.z - z) : 0;
    let best = null;
    for (let k = 0; k < 8; k++) {
      const a = skew + (k / 8) * Math.PI * 2;
      const turn = heading === null ? 1 : Math.cos(a - heading);
      if (turn < -0.1) continue;                  // water does not double back
      const nx = x + Math.cos(a) * STEP, nz = z + Math.sin(a) * STEP;
      const ny = world.height(nx, nz);
      const towardReceiver = target ? (Math.hypot(target.x - nx, target.z - nz) - remaining) * 0.04 : 0;
      const score = ny - y + (1 - turn) * 0.12 + towardReceiver;
      if (!best || score < best.score) best = { a, x: nx, y: ny, z: nz, score };
    }
    if (!best) break;
    // A planned creek already carries the water of this fold.
    if (plannedCreekNear(world, best.x, best.z, 3)) return null;
    const receiver = world.riverAt(best.x, best.z);
    if (world.waterField && receiver.wet && receiver.bodyId) {
      if (receiver.y > y + 0.03) break;
      pts.push([best.x, receiver.y, best.z]);
      receiving = { bodyId: receiver.bodyId, kind: receiver.kind,
        x: best.x, z: best.z, y: receiver.y,
        flowX: receiver.flowX || 0, flowZ: receiver.flowZ || 0 };
      break;
    }
    if (best.y > y - 0.015) {
      // A hollow. A shallow one fills and spills over its lowest lip and the
      // brook runs on; a deep one, or too many, and it sinks here.
      if (best.y > y + (target ? 1.2 : SPILL_RISE) || ++spills > (target ? 12 : MAX_SPILLS)) {
        // too deep to spill out of: the brook fills it as a little pond
        const rise = best.y - y;
        if (rise > 0.12) pond = { x, z, y: y + Math.min(0.3, rise * 0.55), r: 2.2 + Math.min(2.8, rise * 2.2) };
        break;
      }
      if (target) {
        // A shallow hollow fills to its spill before the creek continues.
        // Raise only upstream water to that level, never above its spring.
        // This keeps a descending physical surface through local ponding
        // instead of pretending a rising lip is another downhill step.
        const spill = best.y + 0.02;
        if (spill > pts[0][1]) break;
        for (let i = pts.length - 1; i >= 0 && pts[i][1] < spill; i--) pts[i][1] = spill;
        y = spill;
      } else best.y = y - 0.01;
    }
    if (receiver.wet) break;
    const b = world.biomeAt(best.x, best.z);
    outside = b.id === 'forest' ? 0 : outside + 1;
    if (outside > (target ? 80 : 10)) break;
    if (world.railwayClearanceAt) {
      const rail = world.railwayClearanceAt(best.x, best.z);
      if (rail && (rail.plantClearance > 0 || rail.grassClearance > 0)) break;
    }
    heading = best.a; x = best.x; z = best.z; y = best.y;
    pts.push([x, y, z]);
  }
  if (pts.length < (world.waterField ? 7 : 12) || (world.waterField && !receiving)) return null;
  // Cut it short before a trail or a village: a brook across a path would
  // want a ford or a footbridge, and the plan for those is the trails'.
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cz += p[2]; }
  cx /= pts.length; cz /= pts.length;
  const extent = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[2] - cz)));
  const trails = trailsAround(world, cx, cz, world.seed, extent + 30, []);
  const sites = settlementsAround(world, cx, cz, world.seed, extent + 40, []);
  const near = {};
  let keep = pts.length;
  for (let i = 0; i < pts.length; i++) {
    const [px, , pz] = pts[i];
    if (trails.length) {
      nearestTrailPoint(trails, px, pz, near);
      if (near.distance < (near.width || 1.5) + 3) { keep = i; break; }
    }
    if (sites.some((site) => Math.hypot(site.x - px, site.z - pz) < (site.exclusionHalo || site.radius || 60) + 8)) { keep = i; break; }
  }
  if (keep < (world.waterField ? 7 : 12)) return null;
  if (receiving && keep < pts.length) return null;
  if (keep < pts.length) pond = null;   // cut short before it reached its hollow
  pts.length = keep;
  const brook = finish(world, pts, rng, id, receiving);
  if (receiving) {
    // Geometry is packed into Float32 buffers. Re-sample the receiving head
    // at those exact coordinates so a sloped river contact keeps one level.
    const end = (brook.count - 1) * 4;
    const water = world.riverAt(brook.pts[end], brook.pts[end + 2]);
    if (!water.wet || water.bodyId !== receiving.bodyId) return null;
    const head = Math.fround(water.y);
    for (let i = brook.count - 1; i >= 0 && brook.pts[i * 4 + 1] < head; i--) brook.pts[i * 4 + 1] = head;
    brook.pts[end + 1] = head;
    Object.assign(receiving, { x: brook.pts[end], z: brook.pts[end + 2], y: water.y });
  }
  if (pond && !world.riverAt(pond.x, pond.z).wet) {
    brook.pond = { id: `${id}:pond`, ...pond, yaw: rng() * Math.PI * 2, seed: rng() };
    brook.minX = Math.min(brook.minX, pond.x - pond.r); brook.maxX = Math.max(brook.maxX, pond.x + pond.r);
    brook.minZ = Math.min(brook.minZ, pond.z - pond.r); brook.maxZ = Math.max(brook.maxZ, pond.z + pond.r);
  }
  return brook;
}

// Smooth the step-to-step zigzag into a meandering line — the water level
// with it, which stays falling because every step of the trace fell — then
// settle it onto the ground where the ground lies lower.
function finish(world, raw, rng, id, receiving = null) {
  let line = raw;
  // Planned creeks carry their own water width as a fourth component.
  const planned = raw[0].length > 3;
  for (let pass = 0; pass < 2; pass++) {
    const next = [line[0]];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      next.push(a.map((v, k) => v * 0.75 + b[k] * 0.25));
      next.push(a.map((v, k) => v * 0.25 + b[k] * 0.75));
    }
    next.push(line[line.length - 1]);
    line = next;
  }
  const phase = rng() * 100;
  const n = line.length;
  const pts = new Float32Array(n * 4);
  const cascades = [];
  let along = 0, prevY = Infinity;
  for (let i = 0; i < n; i++) {
    let [x, , z] = line[i];
    if (i > 0) along += Math.hypot(x - line[i - 1][0], z - line[i - 1][2]);
    // a gentle meander across the line of the fold (a planned creek already
    // follows the fold itself, so it keeps to its traced line)
    if (!planned && i > 0 && i < n - 1) {
      const dx = line[i + 1][0] - line[i - 1][0], dz = line[i + 1][2] - line[i - 1][2];
      const l = Math.hypot(dx, dz) || 1;
      const m = Math.sin(along * 0.11 + phase) * 0.45 + Math.sin(along * 0.29 + phase * 1.7) * 0.2;
      x += (-dz / l) * m; z += (dx / l) * m;
    }
    const y = receiving ? Math.max(receiving.y, Math.min(line[i][1], prevY))
      : Math.min(line[i][1], prevY - (planned ? 0 : 0.003));
    const run = i > 0 ? Math.hypot(x - pts[i * 4 - 4], z - pts[i * 4 - 2]) : 1;
    // a little waterfall where the bed drops steeply, no more than one every
    // ten metres; the steep runs between show as white water instead
    if (i > 0 && prevY - y > 0.45 && (prevY - y) / run > CASCADE_SLOPE
      && along - (cascades.at(-1)?.along ?? -Infinity) > 10) {
      cascades.push({ i, top: prevY, bottom: y, along });
    }
    prevY = y;
    const width = (planned ? line[i][3] : Math.min(1.75, 0.5 + along * 0.0035))
      * (receiving ? 1 + 0.12 * Math.sin(along / 31 + phase) : (i === n - 1 ? 0.4 : 1));
    pts.set([x, y, z, width], i * 4);
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[i * 4]); maxX = Math.max(maxX, pts[i * 4]);
    minZ = Math.min(minZ, pts[i * 4 + 2]); maxZ = Math.max(maxZ, pts[i * 4 + 2]);
  }
  return { id, pts, count: n, cascades, minX: minX - 2, minZ: minZ - 2, maxX: maxX + 2, maxZ: maxZ + 2,
    length: along, ...(receiving ? { drainage: { tier: 'creek', receiver: receiving } } : {}) };
}

// How far a brook's water may reach from its centreline; its worn bed ends
// there and its bank eases back up to the ground over BED_BANK beyond.
const brookReach = halfWidth => halfWidth * 1.7 + 0.12;

/**
 * The beds the brooks have worn into the ground near a rectangle, as a
 * function (x, z, h) -> h lowered into a shallow channel beneath each brook's
 * water and eased back up over its banks, so the water lies between low banks
 * instead of on top of the ground. It only ever lowers ground, never by more
 * than BED_CUT, and returns null when no brook runs near.
 */
export function brookBeds(brooks, x0, z0, x1, z1) {
  const CELL = 8, grid = new Map(), cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);
  for (const brook of brooks) {
    const p = brook.pts;
    for (let i = 0; i < brook.count - 1; i++) {
      const ax = p[i * 4], az = p[i * 4 + 2], bx = p[i * 4 + 4], bz = p[i * 4 + 6];
      const pad = brookReach(Math.max(p[i * 4 + 3], p[i * 4 + 7]) / 2) + BED_BANK;
      if (Math.max(ax, bx) + pad < x0 || Math.min(ax, bx) - pad > x1
        || Math.max(az, bz) + pad < z0 || Math.min(az, bz) - pad > z1) continue;
      const entry = [ax, az, bx, bz, p[i * 4 + 1], p[i * 4 + 5], p[i * 4 + 3] / 2, p[i * 4 + 7] / 2];
      for (let gz = Math.floor((Math.min(az, bz) - pad) / CELL); gz <= Math.floor((Math.max(az, bz) + pad) / CELL); gz++) {
        for (let gx = Math.floor((Math.min(ax, bx) - pad) / CELL); gx <= Math.floor((Math.max(ax, bx) + pad) / CELL); gx++) {
          const key = cellKey(gx, gz), list = grid.get(key);
          if (list) list.push(entry); else grid.set(key, [entry]);
        }
      }
    }
  }
  if (!grid.size) return null;
  return (x, z, h) => {
    const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return h;
    let out = h;
    for (const [ax, az, bx, bz, ay, by, ah, bh] of list) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      const hw = ah + (bh - ah) * t, shore = brookReach(hw);
      if (d >= shore + BED_BANK) continue;
      const y = ay + (by - ay) * t, edge = y - 0.02, floor = y - 0.2 - 0.1 * hw;
      let target;
      if (d <= shore) target = floor + (edge - floor) * (d / shore) ** 2;
      else {
        const u = (d - shore) / BED_BANK;
        target = edge + (h - edge) * u * u * (3 - 2 * u);
      }
      out = Math.min(out, Math.max(target, h - BED_CUT));
    }
    return out;
  };
}

/** Every brook whose bounds touch the rectangle. */
export function brooksInRect(world, x0, z0, x1, z1, out = []) {
  out.length = 0;
  const i0 = Math.floor((x0 - BROOK_REACH) / BROOK_CELL), i1 = Math.floor((x1 + BROOK_REACH) / BROOK_CELL);
  const j0 = Math.floor((z0 - BROOK_REACH) / BROOK_CELL), j1 = Math.floor((z1 + BROOK_REACH) / BROOK_CELL);
  for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
    for (const brook of brooksForCell(world, ci, cj)) {
      if (brook.maxX < x0 || brook.minX > x1 || brook.maxZ < z0 || brook.minZ > z1) continue;
      out.push(brook);
    }
  }
  return out;
}

/**
 * The nearest point of any of `brooks` to (x, z): distance from the centre
 * line, the brook's half-width there, and the fall per metre of its bed.
 */
export function nearestBrook(brooks, x, z, out = {}) {
  out.distance = Infinity; out.halfWidth = 0; out.slope = 0; out.brook = null;
  for (const brook of brooks) {
    if (x < brook.minX - 30 || x > brook.maxX + 30 || z < brook.minZ - 30 || z > brook.maxZ + 30) continue;
    if (brook.pond) {
      // the pond it ends in counts as its water too (its centre, its radius)
      const d = Math.hypot(x - brook.pond.x, z - brook.pond.z);
      if (d < out.distance) { out.distance = d; out.halfWidth = brook.pond.r; out.slope = 0; out.brook = brook; }
    }
    const p = brook.pts;
    for (let i = 0; i < brook.count - 1; i++) {
      const ax = p[i * 4], az = p[i * 4 + 2], bx = p[i * 4 + 4], bz = p[i * 4 + 6];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < out.distance) {
        out.distance = d;
        out.halfWidth = (p[i * 4 + 3] + (p[i * 4 + 7] - p[i * 4 + 3]) * t) / 2;
        out.slope = (p[i * 4 + 1] - p[i * 4 + 5]) / Math.sqrt(l2);
        out.brook = brook;
      }
    }
  }
  return out;
}

/**
 * Brooks for the main thread, which must never trace a cell inside a frame:
 * `update` traces at most one missing cell per call, nearest first, and
 * `proximity` answers only from cells already traced.
 */
export class BrookIndex {
  constructor(world) {
    this.world = world;
    this._near = {};
    this._list = [];
  }

  setWorld(world) { this.world = world; }

  /** Trace one missing cell near the player; true when it found a brook close by. */
  update(px, pz) {
    const world = this.world;
    if (!world?.forestStand) return false;
    const reach = BROOK_REACH + 60;
    const i0 = Math.floor((px - reach) / BROOK_CELL), i1 = Math.floor((px + reach) / BROOK_CELL);
    const j0 = Math.floor((pz - reach) / BROOK_CELL), j1 = Math.floor((pz + reach) / BROOK_CELL);
    let best = null, bestD = Infinity;
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      if (brookCellReady(world, ci, cj)) continue;
      const d = Math.hypot((ci + 0.5) * BROOK_CELL - px, (cj + 0.5) * BROOK_CELL - pz);
      if (d < bestD) { bestD = d; best = [ci, cj]; }
    }
    if (!best) return false;
    const brooks = brooksForCell(world, best[0], best[1]);
    // whether this cell brought a brook near enough to the player to matter
    return brooks.some((b) => b.maxX > px - 160 && b.minX < px + 160 && b.maxZ > pz - 160 && b.minZ < pz + 160);
  }

  /** How near a brook is, and how lively: { near, flow, fall } in 0..1. */
  proximity(px, pz) {
    const world = this.world;
    const list = this._list;
    list.length = 0;
    if (!world?._brookCache) return { near: 0, flow: 0, fall: 0 };
    const i0 = Math.floor((px - BROOK_REACH) / BROOK_CELL), i1 = Math.floor((px + BROOK_REACH) / BROOK_CELL);
    const j0 = Math.floor((pz - BROOK_REACH) / BROOK_CELL), j1 = Math.floor((pz + BROOK_REACH) / BROOK_CELL);
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const brooks = world._brookCache.get(`${ci},${cj}`);
      if (brooks) for (const brook of brooks) list.push(brook);
    }
    const near = nearestBrook(list, px, pz, this._near);
    if (!near.brook) return { near: 0, flow: 0, fall: 0 };
    const closeness = Math.max(0, 1 - near.distance / 28);
    return {
      near: closeness * 0.75,
      flow: Math.min(1, 0.35 + near.slope * 3),
      fall: closeness * Math.max(0, Math.min(1, (near.slope - 0.12) * 3)),
    };
  }
}
