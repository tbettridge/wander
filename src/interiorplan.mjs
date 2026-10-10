import { interiorHash, interiorLocal, interiorWorld, localSegment } from './interiorarchitecture.mjs';
import { INTERIOR_ASSETS, INTERIOR_CATALOG_VERSION, ROOM_RECIPES, interiorAsset } from './interiorcatalog.mjs';
import { massCollides } from './buildingmassing.mjs';
const cache = new WeakMap();
const overlap = (a, b, pad = 0) => a.minX < b.maxX + pad && a.maxX > b.minX - pad
  && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;
export function placementBounds(p, clearance = 0) {
  const turned = Math.abs(Math.sin(p.yaw || 0)) > 0.5;
  const w = turned ? p.depth : p.width, d = turned ? p.width : p.depth;
  return { minX: p.x - w / 2 - clearance, maxX: p.x + w / 2 + clearance,
    minZ: p.z - d / 2 - clearance, maxZ: p.z + d / 2 + clearance };
}
function corridor(b, room) {
  // The corridor is deliberately generous: later decoration never consumes it.
  const stair = b.interior.stairs[0];
  const axis = room.floor ? stair.bounds.maxX + 0.7 : 0;
  const lane = { minX: axis - 0.6, maxX: axis + 0.6, minZ: room.bounds.minZ - 0.5, maxZ: room.bounds.maxZ + 0.5 };
  const out = [lane];
  for (const p of b.portals) if (p.kind !== 'stair' && Math.abs(p.y - room.y) < 0.01
    && p.z >= room.bounds.minZ - 0.6 && p.z <= room.bounds.maxZ + 0.6) {
    out.push({ minX: Math.min(axis, p.x) - 0.65, maxX: Math.max(axis, p.x) + 0.65,
      minZ: p.z - 0.72, maxZ: p.z + 0.72 });
  }
  if (stair) out.push({ stair: true, minX: stair.bounds.minX - 0.05, maxX: stair.bounds.maxX + 0.42,
    minZ: -b.depth / 2, maxZ: b.depth / 2 });
  for(const s of b.interior.stairs){
    const z=s.fromFloor===room.floor?s.startZ+.36:s.toFloor===room.floor?s.endZ-.36:null;
    if(z===null)continue;
    out.push({landing:true,minX:Math.min(axis,s.x)-.42,maxX:Math.max(axis,s.x)+.42,minZ:z-.42,maxZ:z+.42});
  }
  return out;
}
function candidates(b, room, a) {
  const r = room.bounds, out = [];
  for (const yaw of [0, Math.PI / 2]) {
    const w = yaw ? a.depth : a.width, d = yaw ? a.width : a.depth;
    const insets = r.maxX-r.minX > 4.5 ? [0,(r.maxX-r.minX)*.18,(r.maxX-r.minX)*.36] : [0];
    for (const inset of insets) for (const side of [-1, 1]) for (const t of [0.22, 0.5, 0.78]) {
      const x = side < 0 ? r.minX + w / 2 + 0.05 + inset : r.maxX - w / 2 - 0.05 - inset;
      const z = r.minZ + d / 2 + 0.05 + t * Math.max(0, r.maxZ - r.minZ - d - 0.1);
      out.push({ x, z, yaw, width: a.width, depth: a.depth, height: a.height, y: room.y });
    }
  }
  return out;
}
function roomRecipe(room) {
  const recipe = [...(ROOM_RECIPES[room.purpose] || ROOM_RECIPES.storage)];
  const area = (room.bounds.maxX-room.bounds.minX)*(room.bounds.maxZ-room.bounds.minZ);
  const repeats = Math.min(3,Math.max(0,Math.floor((area-20)/18)));
  const extra = room.purpose === 'sleeping' ? ['narrow-bed','chest']
    : ['common','public'].includes(room.purpose) ? ['table','chair','bench']
    : ['nave','classroom'].includes(room.purpose) ? ['bench','bench']
    : ['storage','work','shop','store'].includes(room.purpose) ? ['crate','barrel','sack'] : [];
  for(let i=0;i<repeats;i++)recipe.push(...extra);
  return recipe;
}
function pairedSeats(room, asset, placements) {
  if(!['chair','bench'].includes(asset.id))return [];
  const out=[];
  for(const table of placements.filter(p=>['table','small-table','desk'].includes(p.assetId))){
    const rect=placementBounds(table);
    for(const side of [-1,1])out.push({x:table.x,z:side<0?rect.minZ-asset.depth/2-.24:rect.maxZ+asset.depth/2+.24,
      yaw:side<0?0:Math.PI,width:asset.width,depth:asset.depth,height:asset.height,y:room.y,seatingFor:table.id});
  }
  return out;
}
export function planInterior(b) {
  if (cache.has(b)) return cache.get(b);
  if (!b.interior) return { version: INTERIOR_CATALOG_VERSION, rooms: [], placements: [], anchors: [], diagnostics: {} };
  const placements = [], anchors = [], roomPlans = [], omissions = [];
  const seed = interiorHash(`${b.ownerHouseholdId || b.id}:${b.seed}:interior-furnishings`);
  const profile = { palette: interiorHash(`${b.ownerHouseholdId || b.id}:interior-palette`) % 5, textile: (seed >>> 5) % 4, wear: 0.18 + (seed % 55) / 100,
    orderliness: (seed >>> 8) % 3, householdId: b.ownerHouseholdId || null };
  for (const room of b.interior.rooms) {
    const reserved = corridor(b, room), occupied = [];
    const axis = room.floor ? b.interior.stairs[0].bounds.maxX + 0.7 : 0;
    const lift=(b.masses||[]).find(m=>m.role==='core')?.baseY||0;
    const forbidden=(b.masses||[]).filter(m=>m.role!=='core'&&massCollides(m)&&room.y<=m.baseY+m.height-lift+.2)
      .map(m=>({minX:m.dx-m.width/2,maxX:m.dx+m.width/2,minZ:m.dz-m.depth/2,maxZ:m.dz+m.depth/2}));
    const accessFor=(p,a)=>{
      const bounds=placementBounds(p),x=p.x>axis?bounds.minX-.45:bounds.maxX+.45;
      const span=a.action==='sleep'&&a.capacity>1?.69:.34;
      return {x,minX:Math.min(axis,x)-.34,maxX:Math.max(axis,x)+.34,minZ:p.z-span,maxZ:p.z+span};
    };
    const recipe = roomRecipe(room);
    const domains = recipe.map((id, index) => {
      const a = interiorAsset(id);
      return { a, index, required: index === 0, options: candidates(b, room, a) };
    });
    const fit = (p,a,required=false) => {
      const bounds = placementBounds(p), r = room.bounds;
      const access=a&&(a.action||required)?accessFor(p,a):null;
      return bounds.minX >= r.minX && bounds.maxX <= r.maxX && bounds.minZ >= r.minZ && bounds.maxZ <= r.maxZ
        && !reserved.some(lane => overlap(bounds, lane)) && !occupied.some(rect => overlap(bounds, rect, 0.16))
        && !forbidden.some(rect=>overlap(bounds,rect))
        && (!access || access.x>r.minX&&access.x<r.maxX
          && !occupied.filter(rect=>!rect.access).some(rect=>overlap(access,rect))
          && !forbidden.some(rect=>overlap(access,rect)));
    };
    const roomPlacements = [];
    while (domains.length) {
      // Bounded constraint propagation: remove impossible slots after every
      // choice, then collapse the smallest remaining domain. Required anchors
      // go first. No timing-dependent retries or unbounded WFC search.
      for (const domain of domains) {
        const linked=pairedSeats(room,domain.a,roomPlacements).filter(p=>fit(p,domain.a,domain.required));
        domain.options=linked.length?linked:domain.options.filter(p=>fit(p,domain.a,domain.required));
      }
      domains.sort((a, c) => Number(c.required) - Number(a.required) || a.options.length - c.options.length || a.index - c.index);
      const domain = domains.shift();
      let options = domain.options, a = domain.a;
      if (!options.length && a.id === 'bed') { a = interiorAsset('narrow-bed'); options = candidates(b, room, a).filter(p=>fit(p,a,true)); }
      if (!options.length) { omissions.push({ roomId: room.id, assetId: a.id, reason: 'clearance', required: domain.required }); continue; }
      const pick = interiorHash(`${seed}:${room.id}:${domain.index}`) % options.length;
      const p = { ...options[pick], id: `${room.id}:furnishing:${domain.index}`, roomId: room.id,
        floor: room.floor, assetId: a.id, detail: a.detail, collision: a.collision, action: a.action || null, capacity: a.capacity || 1 };
      placements.push(p); roomPlacements.push(p); occupied.push(placementBounds(p));
      if (a.action || domain.required) {
        const axis = room.floor ? b.interior.stairs[0].bounds.maxX + 0.7 : 0;
        const bounds = placementBounds(p), side = p.x > axis ? -1 : 1;
        const anchor = { id: `${p.id}:use`, roomId: room.id, furnishingId: p.id, floor: room.floor,
          x: side < 0 ? bounds.minX - 0.45 : bounds.maxX + 0.45, z: p.z, y: room.y,
          yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2, kind: a.action || room.purpose, purpose: room.purpose };
        const capacity = a.action === 'sleep' ? a.capacity || 1 : 1;
        if (a.action === 'sit' || a.action === 'sleep') {
          anchor.yaw = p.yaw;
          const dx = p.x - anchor.x, dz = p.z - anchor.z;
          anchor.furniturePose = { kind: a.action, height: a.action === 'sleep' ? 0.66 : 0.55,
            offsetX: dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw),
            offsetZ: dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw) };
        }
        const approach = { minX: anchor.x - 0.34, maxX: anchor.x + 0.34,
          minZ: anchor.z - (capacity > 1 ? 0.69 : 0.34), maxZ: anchor.z + (capacity > 1 ? 0.69 : 0.34) };
        if (anchor.x > room.bounds.minX && anchor.x < room.bounds.maxX
          && !reserved.filter(r=>r.stair).some(r => overlap(approach, r))
          && !occupied.slice(0, -1).some(r => overlap(approach, r))) {
          for (let slot=0; slot<capacity; slot++) {
            const side = capacity > 1 ? slot*2-1 : 0;
            const use = { ...anchor, id:capacity > 1 ? `${anchor.id}:${slot}` : anchor.id, z:anchor.z+side*.35 };
            if (anchor.furniturePose) {
              const dx=p.x+side*p.width*.24*Math.cos(p.yaw)-use.x;
              const dz=p.z-side*p.width*.24*Math.sin(p.yaw)-use.z;
              use.furniturePose={...anchor.furniturePose,offsetX:dx*Math.cos(p.yaw)-dz*Math.sin(p.yaw),offsetZ:dx*Math.sin(p.yaw)+dz*Math.cos(p.yaw)};
            }
            anchors.push(use);
          }
          occupied.push({ ...accessFor(p,a), access:true });
        }
      }
      if (['table', 'small-table', 'desk', 'workbench', 'counter', 'bed', 'narrow-bed', 'shelf'].includes(a.id)) {
        const choices = INTERIOR_ASSETS.filter(d => d.detail === 'decoration' && d.support
          && d.purposes.includes(room.purpose) && (d.support !== 'bed' || a.shape === 'bed')
          && (d.support === 'bed' || a.shape !== 'bed'));
        for (let k = 0; k < Math.min(3, choices.length); k++) {
          const decoration = choices[(k + interiorHash(`${p.id}:objects`)) % choices.length];
          const d = { id: `${p.id}:object:${k}`, assetId: decoration.id, roomId: room.id, floor: room.floor,
            x: p.x + (k - 1) * Math.min(0.25, p.width * 0.18), z: p.z + (k % 2 ? 1 : -1) * (0.04 + profile.orderliness * 0.04),
            y: p.y + (a.shape === 'bed' ? 0.575 : a.height), width: decoration.id === 'blanket' ? Math.min(p.width * 0.86, decoration.width) : decoration.width,
            depth: decoration.depth, height: decoration.height, yaw: p.yaw + (k - 1) * profile.orderliness * 0.09,
            detail: 'decoration', collision: false, supportId: p.id };
          if (decoration.id === 'blanket') { d.x = p.x; d.z = p.z; d.yaw = p.yaw; }
          placements.push(d); roomPlacements.push(d);
        }
      }
    }
    // A rug occupies the walking lane visually, without changing collision.
    if (['common', 'sleeping', 'office', 'public'].includes(room.purpose)) {
      const p = { id: `${room.id}:rug`, assetId: 'rug', roomId: room.id, floor: room.floor, x: room.floor ? b.interior.stairs[0].bounds.maxX + 0.7 : 0,
        z: (room.bounds.minZ + room.bounds.maxZ) / 2, y: room.y + 0.006, width: 0.95,
        depth: Math.min(1.8, room.bounds.maxZ - room.bounds.minZ - 0.2), height: 0.012, yaw: 0, collision: false, detail: 'decoration' };
      placements.push(p); roomPlacements.push(p);
      const hanging = { id:`${room.id}:hanging`, assetId:'wall-hanging', roomId:room.id, floor:room.floor,
        x:b.width/2-.18, y:room.y+.65, z:room.bounds.minZ+(room.bounds.maxZ-room.bounds.minZ)*.7,
        width:.65, depth:.035, height:.8, yaw:Math.PI/2, collision:false, detail:'decoration' };
      placements.push(hanging); roomPlacements.push(hanging);
    }
    // Always retain a reachable stand/arrival anchor on the protected lane.
    anchors.push({ id: `${room.id}:arrival`, roomId: room.id, floor: room.floor, kind: 'inside', purpose: room.purpose,
      x: room.floor ? b.interior.stairs[0].bounds.maxX + 0.7 : 0,
      z: (room.bounds.minZ + room.bounds.maxZ) / 2, y: room.y, yaw: 0 });
    roomPlans.push({ ...room, reserved, placementIds: roomPlacements.map(p => p.id) });
  }
  const plan = { version: INTERIOR_CATALOG_VERSION, buildingId: b.id, profile, rooms: roomPlans, placements, anchors,
    diagnostics: { placements: placements.length, omissions, requiredOmissions: omissions.filter(o => o.required).length,
      floors: b.interior.levels.length, lofts: b.interior.levels.filter(l => l.kind === 'loft').length } };
  cache.set(b, plan);
  return plan;
}
export function interiorFurnitureSegments(b) {
  const out = [];
  for (const p of planInterior(b).placements) if (p.collision) {
    const r = placementBounds(p);
    for (const [i, edge] of [[r.minX, r.minZ, r.maxX, r.minZ], [r.maxX, r.minZ, r.maxX, r.maxZ],
      [r.maxX, r.maxZ, r.minX, r.maxZ], [r.minX, r.maxZ, r.minX, r.minZ]].entries()) {
      out.push({ ...localSegment(b, `${p.id}:collision:${i}`, ...edge, p.y, p.y + p.height), furnishing: true });
    }
  }
  return out;
}
export function routeInterior(b, from, to) {
  if (!b.interior) return null;
  const a = interiorLocal(b, from), c = interiorLocal(b, to), points = [];
  const floorAt = p => b.interior.levels.reduce((best, level) => Math.abs(level.y - p.y) < Math.abs(best.y - p.y) ? level : best, b.interior.levels[0]);
  let floor = floorAt(a).index; const targetFloor = floorAt(c).index;
  let current = a;
  const push = p => { points.push({ ...interiorWorld(b, p), interior: true, stairId: p.stairId || null }); current = p; };
  const alongFloor = (end, level) => {
    const axis = level ? b.interior.stairs[0].bounds.maxX + 0.7 : 0;
    push({ x: axis, z: current.z, y: b.interior.levels[level].y });
    const parts = b.interior.partitions.filter(p => p.floor === level
      && p.z > Math.min(current.z, end.z) && p.z < Math.max(current.z, end.z))
      .sort((x, y) => end.z > current.z ? x.z - y.z : y.z - x.z);
    for (const part of parts) {
      const door = part.openings[0];
      push({ x: axis, z: part.z + (end.z > current.z ? -0.65 : 0.65), y: b.interior.levels[level].y });
      push({ x: door.x, z: current.z, y: current.y });
      push({ x: door.x, z: part.z + (end.z > current.z ? 0.65 : -0.65), y: current.y });
      push({ x: axis, z: current.z, y: current.y });
    }
    push({ x: axis, z: end.z, y: b.interior.levels[level].y });
    push(end);
  };
  while (floor !== targetFloor) {
    const ascending = targetFloor > floor;
    const s = b.interior.stairs.find(stair => stair.fromFloor === (ascending ? floor : floor - 1));
    const start = { x: s.x, z: ascending ? s.startZ + 0.36 : s.endZ - 0.36, y: ascending ? s.lowerY : s.upperY };
    alongFloor(start, floor);
    // Dense waypoints preserve stair support and avoid steering skipping a ramp.
    for (let i = 0; i <= 12; i++) {
      const t = ascending ? i / 12 : 1 - i / 12;
      push({ x: s.x, z: s.startZ + (s.endZ - s.startZ) * t, y: s.lowerY + (s.upperY - s.lowerY) * t, stairId: s.id });
    }
    floor += ascending ? 1 : -1;
    push({ x: s.x, z: ascending ? s.endZ - 0.36 : s.startZ + 0.36, y: b.interior.levels[floor].y });
  }
  alongFloor(c, floor);
  return points;
}
