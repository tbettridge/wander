// Worker-safe parametric recipes. Small, coloured primitives are assembled into
// one buffer per detail tier; no object per book, chair leg or cupboard hinge.
import { planInterior } from './interiorplan.mjs';
import { interiorAsset } from './interiorcatalog.mjs';
import { planOpenings } from './buildingopenings.mjs';
const PALETTES = [0x7c3f35, 0x48685c, 0x52677b, 0x997345, 0x76617d];
const WOOD = [0x72513a, 0x86664a, 0x65452f, 0x967456, 0x745844];
function partsFor(p, profile) {
  const a = interiorAsset(p.assetId), w = p.width, d = p.depth, h = p.height, parts = [];
  const wood = WOOD[profile.palette], cloth = PALETTES[(profile.palette + profile.textile) % PALETTES.length], dark = 0x373335, cream = 0xd9cbb0;
  const box = (sx, sy, sz, x = 0, y = sy / 2, z = 0, color = wood) => parts.push({ shape: 'box', sx, sy, sz, x, y, z, color });
  const cylinder = (radius, height, x = 0, y = height / 2, z = 0, color = wood, top = radius) => parts.push({ shape: 'cylinder', radius, top, height, x, y, z, color });
  const legs = (top, inset = 0.08) => { for (const x of [-w / 2 + inset, w / 2 - inset]) for (const z of [-d / 2 + inset, d / 2 - inset]) box(0.07, top, 0.07, x, top / 2, z); };
  switch (a.shape) {
    case 'table': case 'workbench':
      box(w, 0.09, d, 0, h - 0.045); legs(h - 0.09);
      box(w - 0.1, 0.11, 0.065, 0, h - 0.18, -d / 2 + 0.045);
      if (a.shape === 'workbench') { box(w - 0.1, 0.08, d * 0.7, 0, 0.22); box(0.18, 0.12, 0.12, w * 0.3, h, 0.1, dark); }
      break;
    case 'chair':
      box(w, 0.065, d, 0, 0.47); legs(0.44, 0.05);
      box(0.055, h - 0.45, 0.06, -w / 2 + 0.04, (h + 0.45) / 2, -d / 2 + 0.04);
      box(0.055, h - 0.45, 0.06, w / 2 - 0.04, (h + 0.45) / 2, -d / 2 + 0.04);
      box(w - 0.04, 0.15, 0.055, 0, h - 0.1, -d / 2 + 0.04); break;
    case 'bench': box(w, 0.075, d, 0, h - 0.04); legs(h - 0.08); box(w - 0.1, 0.06, 0.06, 0, 0.18); break;
    case 'bed':
      box(w, 0.17, d, 0, 0.34); box(w - 0.09, 0.18, d - 0.07, 0, 0.48, 0, cream);
      for (const x of [-w / 2 + 0.04, w / 2 - 0.04]) for (const z of [-d / 2 + 0.04, d / 2 - 0.04]) box(0.075, 0.72, 0.075, x, 0.36, z);
      box(w, 0.35, 0.06, 0, 0.57, -d / 2); box(w * 0.64, 0.105, 0.35, 0, 0.615, -d * 0.31, 0xe8dfcc); break;
    case 'cupboard': case 'shelf':
      box(0.07, h, d, -w / 2 + 0.035); box(0.07, h, d, w / 2 - 0.035);
      box(w, h, 0.045, 0, h / 2, -d / 2 + 0.025);
      for (let i = 0; i <= 3; i++) box(w, 0.055, d, 0, 0.08 + i * (h - 0.1) / 3);
      if (a.shape === 'cupboard') { box(w - 0.15, h - 0.17, 0.055, 0, h / 2, d / 2); for (const x of [-0.08, 0.08]) box(0.025, 0.07, 0.045, x, h * 0.52, d / 2 + 0.04, dark); }
      else for (let i = 0; i < 3; i++) { box(w * 0.23, 0.2, d * 0.68, w * (i - 1) * 0.27, h * 0.4, 0, i % 2 ? cream : cloth); }
      break;
    case 'chest': case 'crate': case 'counter':
      box(w, h, d); box(w + 0.03, 0.045, d + 0.03, 0, h);
      for (const x of [-w * 0.34, w * 0.34]) box(0.055, h + 0.04, d + 0.045, x, h / 2, 0, a.shape === 'crate' ? wood : dark);
      if (a.shape === 'counter') box(w * 0.87, 0.06, 0.02, 0, h * 0.4, d / 2 + 0.02, cream); break;
    case 'hearth':
      box(w, h, 0.13, 0, h / 2, -d / 2, 0x797265);
      box(w * 0.2, h * 0.7, d, -w * 0.4, h * 0.35, 0, 0x8a8070); box(w * 0.2, h * 0.7, d, w * 0.4, h * 0.35, 0, 0x8a8070);
      box(w, 0.16, d + 0.1, 0, h * 0.77, 0, 0x918472); box(w + 0.1, 0.06, d + 0.2, 0, 0.03, 0, 0x5d564b);
      box(w * 0.48, 0.11, d * 0.5, 0, 0.11, 0.1, 0x773f27); box(w * 0.26, 0.13, d * 0.25, 0, 0.22, 0.1, 0xef9b48); break;
    case 'barrel':
      cylinder(w / 2, h, 0, h / 2, 0, wood, w * 0.44);
      for (const y of [h * 0.17, h * 0.78]) cylinder(w * 0.51, 0.045, 0, y, 0, dark); break;
    case 'basket': case 'sack': cylinder(w * 0.48, h, 0, h / 2, 0, a.shape === 'basket' ? 0xb09866 : 0xae9d78, w * 0.32); break;
    case 'rug': case 'blanket':
      box(w, h, d, 0, h / 2, 0, cloth); for (const z of [-d * 0.4, d * 0.4]) box(w * 0.96, 0.004, 0.075, 0, h + 0.002, z, cream); break;
    case 'book': box(w, h, d, 0, h / 2, 0, cloth); box(w * 0.92, h * 0.6, d * 0.94, 0, h * 0.5, 0.008, cream); break;
    case 'bowl': cylinder(w / 2, h, 0, h / 2, 0, 0xbba082, w * 0.35); cylinder(w * 0.31, 0.01, 0, h + 0.004, 0, 0x4b3a2e); break;
    case 'jug': cylinder(w * 0.42, h * 0.7, 0, h * 0.35, 0, 0x9f754f, w * 0.24); cylinder(w * 0.18, h * 0.3, 0, h * 0.85, 0, 0x9f754f); break;
    case 'plant': cylinder(w * 0.38, h * 0.35, 0, h * 0.175, 0, 0x9d694c, w * 0.5); for (let i = -1; i <= 1; i++) box(0.075, h * 0.55, 0.06, i * 0.07, h * 0.57, i * 0.035, 0x526b43); break;
    case 'lamp': cylinder(w * 0.38, 0.04, 0, 0.02, 0, dark); cylinder(0.025, h * 0.67, 0, h * 0.36, 0, dark); cylinder(w * 0.52, h * 0.35, 0, h * 0.78, 0, 0xf2c887, w * 0.28); break;
    case 'tools': box(w, 0.04, 0.04, 0, 0.025, -0.045); box(0.14, 0.07, 0.12, w * 0.3, 0.04, -0.045, dark); box(0.05, 0.025, d, -w * 0.3, 0.025, 0.04, dark); break;
    case 'lectern': box(w * 0.6, 0.06, d * 0.7); box(0.12, h - 0.12, 0.12, 0, h / 2); box(w, 0.07, d, 0, h - 0.04); break;
    case 'anvil': box(w * 0.65, h * 0.65, d * 0.9, 0, h * 0.325, 0, wood); box(w, h * 0.22, d, 0, h * 0.77, 0, dark); box(w * 0.4, h * 0.15, d * 0.55, w * 0.4, h * 0.9, 0, dark); break;
    case 'firewood': for (let i = 0; i < 5; i++) box(w, 0.09, 0.09, 0, 0.07 + Math.floor(i / 3) * 0.1, (i % 3 - 1) * 0.11, i % 2 ? wood : 0xa5845c); break;
    default: box(w, h, d, 0, h / 2, 0, cloth);
  }
  return parts;
}
const FACES = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [0, 0, 1]],
  [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [0, 0, -1]],
  [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, 0, 0]],
  [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, 0, 0]],
  [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]],
  [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]]];
function buffer() { return { position: [], normal: [], color: [] }; }
function emit(out, p, point, normal, color) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  out.position.push(p.x + point[0] * c + point[2] * s, p.y + point[1], p.z - point[0] * s + point[2] * c);
  out.normal.push(normal[0] * c + normal[2] * s, normal[1], -normal[0] * s + normal[2] * c);
  // Vertex AO is precomputed, independent of changing sunlight. Lower faces
  // and joints retain readable contact depth even on the no-shadow XR tier.
  const shade = normal[1] < -0.1 ? 0.62 : normal[1] > 0.1 ? 1 : 0.82;
  for (const shift of [16, 8, 0]) {
    const v = ((color >> shift) & 255) / 255;
    out.color.push((v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * shade);
  }
}
function primitive(out, p, part) {
  if (part.shape === 'box') {
    for (const face of FACES) for (const i of [0, 1, 2, 0, 2, 3]) emit(out, p,
      [part.x + face[i][0] * part.sx / 2, part.y + face[i][1] * part.sy / 2, part.z + face[i][2] * part.sz / 2], face[4], part.color);
  } else {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = i * Math.PI * 2 / n, b = (i + 1) * Math.PI * 2 / n;
      const v = (angle, top) => [part.x + Math.cos(angle) * (top ? part.top : part.radius), part.y + (top ? 1 : -1) * part.height / 2, part.z + Math.sin(angle) * (top ? part.top : part.radius)];
      const normal = [Math.cos((a + b) / 2), 0, Math.sin((a + b) / 2)];
      for (const point of [v(a, false), v(a, true), v(b, true), v(a, false), v(b, true), v(b, false)]) emit(out, p, point, normal, part.color);
      for (const top of [false, true]) for (const point of top
        ? [[part.x, part.y + part.height / 2, part.z], v(b, true), v(a, true)]
        : [[part.x, part.y - part.height / 2, part.z], v(a, false), v(b, false)]) emit(out, p, point, [0, top ? 1 : -1, 0], part.color);
    }
  }
}
export function prepareInteriorRoom(building, roomId) {
  const plan = planInterior(building), major = buffer(), decoration = buffer(), fixtures = [];
  const room = plan.rooms.find(r => r.id === roomId);
  if (!room) throw new RangeError(`Unknown interior room: ${roomId}`);
  // Dedicated inner surfaces receive room lighting without dimming the world
  // outside. Front/back openings remain genuinely open and unobstructed.
  const r = room.bounds, base = { x: 0, y: room.y, z: 0, yaw: 0 };
  primitive(major, base, { shape: 'box', sx: r.maxX-r.minX, sy: 0.008, sz: r.maxZ-r.minZ,
    x: (r.minX+r.maxX)/2, y: -0.002, z: (r.minZ+r.maxZ)/2, color: WOOD[plan.profile.palette] });
  // A few board seams and a worn walking strip are baked into the same room
  // buffer. They add no objects, textures, lights, or collision work.
  const width = r.maxX-r.minX, depth = r.maxZ-r.minZ;
  for (let i=1; i<Math.min(14, Math.ceil(width/.48)); i++) primitive(major, base,
    { shape:'box', sx:.009, sy:.003, sz:depth, x:r.minX+i*width/Math.min(14,Math.ceil(width/.48)), y:.003, z:(r.minZ+r.maxZ)/2, color:0x493626 });
  primitive(major, base, { shape:'box', sx:.28+plan.profile.wear*.3, sy:.001, sz:depth*.65,
    x:room.floor ? building.interior.stairs[0].bounds.maxX+.7 : 0, y:.005, z:(r.minZ+r.maxZ)/2, color:0x8d7050 });
  const next = building.interior.levels[room.floor+1];
  const height = next && next.kind !== 'loft' ? next.y-room.y-.12 : building.floorCount*building.floorHeight-room.y-.16;
  const ceilingRects = next ? next.rectangles : [r];
  for (const rect of ceilingRects) {
    const x0=Math.max(r.minX,rect.minX),x1=Math.min(r.maxX,rect.maxX),z0=Math.max(r.minZ,rect.minZ),z1=Math.min(r.maxZ,rect.maxZ);
    if(x1>x0&&z1>z0) primitive(major,base,{shape:'box',sx:x1-x0,sy:.008,sz:z1-z0,x:(x0+x1)/2,
      y:next?next.y-room.y-.125:height,z:(z0+z1)/2,color:0xb8a78a});
  }
  const wallColor = building.materials.wall === 'stone' ? 0xa5987e : 0xc8b897;
  // Churches have pierced side walls as well as front/back windows. Their
  // existing wall mesh supplies that surface; a solid liner would seal it.
  for (const side of building.program === 'church' ? [] : [-1, 1]) primitive(major, base, { shape: 'box', sx: 0.016, sy: height,
    sz: r.maxZ-r.minZ+0.22, x: side*(building.width/2-(room.floor?0.17:0.15)), y: height/2-0.02,
    z: (r.minZ+r.maxZ)/2, color: wallColor });
  // Interior faces of end/partition walls share room lighting. A rectangular
  // grid subtracts the actual window and doorway openings rather than glazing
  // over them; the outdoor scene remains the ordinary clear world render.
  for(const side of [-1,1]) {
    const edge = side<0?r.minZ:r.maxZ;
    const part = building.interior.partitions.find(p=>p.floor===room.floor && Math.abs(p.z-edge)<.3);
    const exterior = !part;
    const wallHeight=part?Math.min(height,part.y+part.height-room.y):height;
    const wallZ=part?part.z-side*.13:side*(building.depth/2-(room.floor?.17:.15));
    const cuts=exterior?planOpenings(building,building.width).map(o=>({...o,bottom:o.bottom-room.y}))
      :part.openings.map(o=>({...o,bottom:-room.y+part.y}));
    if(exterior){const door=building.portals.find(p=>p.kind===(side>0?'exterior-door':'back-door'));if(door)cuts.push({...door,bottom:-room.y});}
    const holes=cuts.filter(o=>o.bottom<wallHeight&&o.bottom+o.height>0);
    const xs=[...new Set([r.minX,r.maxX,...holes.flatMap(o=>[Math.max(r.minX,Math.min(r.maxX,o.x-o.width/2)),Math.max(r.minX,Math.min(r.maxX,o.x+o.width/2))])])].sort((a,b)=>a-b);
    const ys=[...new Set([0,wallHeight,...holes.flatMap(o=>[Math.max(0,o.bottom),Math.min(wallHeight,o.bottom+o.height)])])].sort((a,b)=>a-b);
    for(let i=1;i<xs.length;i++)for(let j=1;j<ys.length;j++){
      const x=(xs[i-1]+xs[i])/2,y=(ys[j-1]+ys[j])/2;
      if(holes.some(o=>Math.abs(x-o.x)<o.width/2&&y>o.bottom&&y<o.bottom+o.height))continue;
      if(xs[i]-xs[i-1]>.001&&ys[j]-ys[j-1]>.001)primitive(major,base,{shape:'box',sx:xs[i]-xs[i-1],sy:ys[j]-ys[j-1],sz:.016,x,y,z:wallZ,color:wallColor});
    }
  }
  // Each room has a cheap warm fixture even if no table supports a lamp.
  fixtures.push({ x: r.maxX - 0.35, y: room.y + Math.min(1.65, height - 0.2),
    z: (r.minZ+r.maxZ)/2, kind: 'lamp' });
  primitive(decoration, base, { shape: 'box', sx: 0.14, sy: 0.22, sz: 0.13,
    x: r.maxX - 0.05, y: Math.min(1.65, height - 0.2), z: (r.minZ+r.maxZ)/2, color: 0xdfb474 });
  for (const p of plan.placements) if (p.roomId === roomId) {
    const out = p.detail === 'decoration' ? decoration : major;
    for (const part of partsFor(p, plan.profile)) primitive(out, p, part);
    const a = interiorAsset(p.assetId);
    if (a.light) fixtures.push({ x: p.x, y: p.y + p.height * 0.7, z: p.z, kind: a.light });
  }
  const typed = data => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, new Float32Array(value)]));
  return { roomId, major: typed(major), decoration: typed(decoration), fixtures: fixtures.slice(0, 2) };
}
