// Where village life happens: venues, and the exact spots in them.
//
// A day plan (npcdayplan.mjs) says WHAT someone is doing — at home, at work,
// at the market, at the inn. This module says WHERE, down to a position, a
// facing and a pose: the doorway they lean in, the window they look out of,
// the bed they tend, the stall they serve from, the place at the well where
// the evening gathers. Every spot is derived from things the settlement plan
// already placed — rooms and openings, family-frontage gardens, the
// district's veg rows and washing lines, the market stalls — so people stand
// where the life of the place visibly is.
//
// Pure and THREE-free: derived once per plan and cached with it.

import { buildingWorldPoint } from './buildingplan.mjs';
import { planOpenings } from './buildingopenings.mjs';

const TAU = Math.PI * 2;

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function rngFor(key) {
  let a = hashText(key);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMESTIC = new Set(['dwelling', 'row-house', 'infill-house']);
const GARDEN_ASSETS = /^(yard\.|garden)/;
const GARDEN_PROPS = new Set(['veg-rows', 'flower-bed', 'planter-tub', 'skep', 'pots']);
const WORK_PROPS = new Set(['firewood', 'chopping-block', 'crates', 'sacks', 'barrel', 'barrel-pair', 'washtub', 'handcart', 'drying-rack']);

function footprintOf(b) {
  return b.footprint || { minX: -b.width / 2, maxX: b.width / 2, minZ: -b.depth / 2, maxZ: b.depth / 2 };
}

function insideAnyBuilding(buildings, x, z, pad) {
  for (const b of buildings) {
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz > 900) continue;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const fp = footprintOf(b);
    if (lx > fp.minX - pad && lx < fp.maxX + pad && lz > fp.minZ - pad && lz < fp.maxZ + pad) return true;
  }
  return false;
}

/** A spot `out` metres in front of a thing at (x, z) facing `yaw`, facing it. */
function standBefore(x, z, yaw, out) {
  return { x: x + Math.sin(yaw) * out, z: z + Math.cos(yaw) * out, yaw: yaw + Math.PI };
}

function spot(id, fields) {
  return { id, pose: null, indoor: false, ...fields };
}

/**
 * The spots belonging to one building: rooms, windows, doorway and step, and
 * whatever its yard holds.
 */
function buildingSpots(plan, building, nodeKey, extras) {
  const rng = rngFor(`${building.id}:spots`);
  const local = (lx, lz) => buildingWorldPoint(building, lx, lz);
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  const lift = (building.masses || []).find((m) => m.role === 'core')?.baseY || 0;
  const floorY = building.y + 0.16 + lift;
  const spots = { inside: [], window: [], doorway: [], front: [], yard: [] };
  const base = { buildingId: building.id, nodeKey };
  for (const room of building.rooms || []) {
    const b = room.bounds;
    const pad = 0.55;
    if (b.maxX - b.minX < pad * 2 || b.maxZ - b.minZ < pad * 2) continue;
    for (let k = 0; k < 2; k++) {
      const lx = b.minX + pad + rng() * (b.maxX - b.minX - pad * 2);
      const lz = b.minZ + pad + rng() * (b.maxZ - b.minZ - pad * 2);
      const p = local(lx, lz);
      spots.inside.push(spot(`${room.id}:spot:${k}`, {
        ...base, kind: 'inside', indoor: true, x: p.x, z: p.z, y: floorY, yaw: building.yaw + rng() * TAU, lx, lz,
      }));
    }
  }
  if (door) {
    const sill = planOpenings(building, building.width)
      .filter((o) => o.glazed !== false && o.bottom < building.floorHeight && o.bottom > 0.4)
      .filter((o) => Math.abs(o.x - door.x) > (o.width + door.width) / 2 + 0.12);
    for (const [k, opening] of sill.entries()) {
      for (const side of [1, -1]) {
        const lz = side * (building.depth / 2 - 0.62);
        const p = local(opening.x, lz);
        spots.window.push(spot(`${building.id}:window:${side > 0 ? 'f' : 'b'}:${k}`, {
          ...base, kind: 'window', indoor: true, x: p.x, z: p.z, y: floorY,
          yaw: building.yaw + (side > 0 ? 0 : Math.PI), pose: 'window-watch', lx: opening.x, lz,
        }));
      }
    }
    const threshold = local(door.x, building.depth / 2 - 0.32);
    spots.doorway.push(spot(`${building.id}:doorway`, {
      ...base, kind: 'doorway', indoor: true, x: threshold.x, z: threshold.z, y: floorY,
      yaw: building.yaw, pose: 'lean-door', lx: door.x, lz: building.depth / 2 - 0.32,
    }));
    for (const side of [-1, 1]) {
      const lx = door.x + side * (door.width / 2 + 0.75), lz = footprintOf(building).maxZ + 1.25;
      const p = local(lx, lz);
      if (insideAnyBuilding(plan.buildings, p.x, p.z, 0.35)) continue;
      spots.front.push(spot(`${building.id}:front:${side}`, {
        ...base, kind: 'front', x: p.x, z: p.z, yaw: building.yaw + (rng() - 0.5) * 0.8, lx, lz,
      }));
    }
  }
  for (const item of extras) {
    const p = standBefore(item.x, item.z, item.yaw, item.out);
    if (insideAnyBuilding(plan.buildings, p.x, p.z, 0.3)) continue;
    const dx = p.x - building.x, dz = p.z - building.z;
    const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
    spots.yard.push(spot(item.id, {
      ...base, kind: 'yard', x: p.x, z: p.z, yaw: p.yaw, pose: item.pose,
      lx: dx * c - dz * s, lz: dx * s + dz * c,
    }));
  }
  return spots;
}

/** Things in a building's yard worth standing at, with the pose that goes with them. */
function yardExtrasFor(plan, building) {
  const extras = [];
  const frontage = (plan.familyFrontages || []).find((f) => f.buildingId === building.id);
  for (const entry of frontage?.yardElements || []) {
    const p = entry.placement;
    if (!p) continue;
    const garden = GARDEN_ASSETS.test(entry.assetId);
    const working = /^(materials\.|tools\.|service\.)/.test(entry.assetId);
    if (!garden && !working) continue;
    extras.push({
      id: `${entry.id}:spot`, x: p.x, z: p.z, yaw: building.yaw + (p.yaw || 0), out: 1.1,
      pose: garden ? 'tend-garden' : 'repair-site',
    });
  }
  for (const placement of plan.managedVegetation?.placements || []) {
    if (placement.buildingId !== building.id) continue;
    extras.push({ id: `${placement.id}:spot`, x: placement.x, z: placement.z, yaw: placement.yaw || 0, out: 1.2, pose: 'tend-garden' });
  }
  for (const prop of plan.district?.props || []) {
    if (prop.buildingId !== building.id) continue;
    const pose = GARDEN_PROPS.has(prop.kind) ? 'tend-garden' : WORK_PROPS.has(prop.kind) ? 'repair-site' : null;
    if (!pose) continue;
    extras.push({ id: `${prop.id}:spot`, x: prop.x, z: prop.z, yaw: prop.yaw, out: prop.d / 2 + 0.55, pose });
  }
  for (const line of plan.district?.lines || []) {
    if (line.kind !== 'washing' || !line.id.startsWith(`${building.id}:`)) continue;
    const t = 0.35;
    const x = line.ax + (line.bx - line.ax) * t, z = line.az + (line.bz - line.az) * t;
    const along = Math.atan2(line.bx - line.ax, line.bz - line.az);
    extras.push({ id: `${line.id}:spot`, x, z, yaw: along + Math.PI / 2, out: 0.45, pose: 'hang-washing' });
  }
  return extras;
}

/**
 * Venues and spots for a settlement plan.
 *
 * Returns { buildings: { [id]: spots }, market, inn, church, gathering, stroll,
 * nodeFor(buildingId) }. A spot carries its position, facing, pose, whether it
 * is indoors, the building it belongs to and the graph node its route ends at.
 */
export function planVenues(plan) {
  const nodes = plan.localGraph?.nodes || [];
  const plaza = nodes.find((node) => node.kind === 'centre') || null;
  const nodeByBuilding = new Map(nodes.filter((n) => n.buildingId).map((n) => [n.buildingId, n.key]));
  const nearestNode = (x, z) => {
    let best = null, bestD = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(node.x - x, node.z - z);
      if (d < bestD) { bestD = d; best = node; }
    }
    return best?.key || null;
  };
  const nodeFor = (building) => {
    if (nodeByBuilding.has(building.id)) return nodeByBuilding.get(building.id);
    const door = building.portals.find((portal) => portal.kind === 'exterior-door');
    const p = buildingWorldPoint(building, door?.x || 0, building.depth / 2 + 2);
    return nearestNode(p.x, p.z);
  };
  const buildings = {};
  for (const building of plan.buildings) {
    buildings[building.id] = buildingSpots(plan, building, nodeFor(building), yardExtrasFor(plan, building));
  }
  const plazaKey = plaza?.key || null;
  const square = plan.square;
  const props = plan.props || [];

  // The market: a trader behind each stall and room for a few buyers before it.
  const stalls = props.filter((p) => p.kind === 'market-stall').map((stall, index) => {
    const c = Math.cos(stall.yaw), s = Math.sin(stall.yaw);
    const at = (across, out) => ({ x: stall.x + across * c + out * s, z: stall.z - across * s + out * c });
    const back = at(0, -1.05), front = [-0.55, 0.55].map((across) => at(across, 1.55));
    return {
      id: stall.id,
      merchant: spot(`${stall.id}:merchant`, { kind: 'stall', x: back.x, z: back.z, yaw: stall.yaw, nodeKey: plazaKey }),
      customers: front.map((p, k) => spot(`${stall.id}:customer:${k}`, {
        kind: 'customer', x: p.x, z: p.z, yaw: stall.yaw + Math.PI, nodeKey: plazaKey,
      })),
      index,
    };
  });
  const well = props.find((p) => p.kind === 'well') || (square ? { x: square.x, z: square.z, radius: 1.5 } : null);
  const ring = (radius, count, prefix, phase = 0) => (well ? Array.from({ length: count }, (_, k) => {
    const a = phase + (k / count) * TAU;
    return spot(`${prefix}:${k}`, {
      kind: prefix.split(':').pop(), x: well.x + Math.cos(a) * radius, z: well.z + Math.sin(a) * radius,
      yaw: Math.atan2(-Math.cos(a), -Math.sin(a)), nodeKey: plazaKey,
    });
  }) : []);
  const market = stalls.length ? {
    stalls, well: ring((well?.radius || 1.5) + 1.3, 6, `${plan.site.id}:well`),
  } : null;
  // An evening's gathering: two loose rings round the well, facing in.
  const gathering = square ? [
    ...ring(3.6, 8, `${plan.site.id}:gathering`, 0.2), ...ring(5.4, 10, `${plan.site.id}:gathering-outer`, 0.5),
  ].filter((s) => !props.some((p) => p.kind !== 'well' && Math.hypot(p.x - s.x, p.z - s.z) < (p.radius || 1.2) + 0.6)) : [];
  // Open ground in the square to cross and stop in.
  const stroll = [];
  if (square) {
    const rng = rngFor(`${plan.site.id}:stroll`);
    for (let k = 0; k < 14 && stroll.length < 8; k++) {
      const a = rng() * TAU, r = square.radius * (0.35 + rng() * 0.45);
      const x = square.x + Math.cos(a) * r, z = square.z + Math.sin(a) * r;
      if (props.some((p) => Math.hypot(p.x - x, p.z - z) < (p.radius || 1.4) + 1.2)) continue;
      stroll.push(spot(`${plan.site.id}:stroll:${k}`, { kind: 'stroll', x, z, yaw: rng() * TAU, nodeKey: plazaKey }));
    }
  }
  // The inn: its rooms, and a knot of drinkers out front on a fine evening.
  const innBuilding = plan.buildings.find((b) => b.program === 'inn') || null;
  let inn = null;
  if (innBuilding) {
    const door = innBuilding.portals.find((portal) => portal.kind === 'exterior-door');
    const cluster = [];
    const fp = footprintOf(innBuilding);
    for (let k = 0; k < 7; k++) {
      const side = k % 2 ? 1 : -1;
      const lx = door.x + side * (1.6 + Math.floor(k / 2) * 0.9), lz = fp.maxZ + 2.2 + (k % 3) * 0.7;
      const p = buildingWorldPoint(innBuilding, lx, lz);
      if (insideAnyBuilding(plan.buildings, p.x, p.z, 0.4)) continue;
      const centre = buildingWorldPoint(innBuilding, door.x + side * 2.4, fp.maxZ + 2.9);
      cluster.push(spot(`${innBuilding.id}:cluster:${k}`, {
        kind: 'cluster', buildingId: innBuilding.id, nodeKey: nodeFor(innBuilding), x: p.x, z: p.z,
        yaw: Math.atan2(centre.x - p.x, centre.z - p.z) + (k % 2 ? 0.3 : -0.3),
      }));
    }
    inn = { buildingId: innBuilding.id, cluster };
  }
  const church = plan.buildings.find((b) => b.program === 'church') || null;
  return {
    buildings, market, inn, church: church ? { buildingId: church.id } : null,
    gathering, stroll, plazaKey,
    homes: plan.buildings.filter((b) => DOMESTIC.has(b.program)).map((b) => b.id),
  };
}
