import { prepareRiverReach, finishRiverReach } from './riverterrain.mjs';
import { solveRiverGraph } from './rivergraph.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from './riversparsemesh.mjs';
import { meanderFootprintsSeparated } from './rivermeanderfit.mjs';
import { waterPlanningTerrain } from './waterplanningterrain.mjs';

const MAX_PROPOSALS = 6, MAX_CELLS = 21000, MAX_BYTES = 2000000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Branches share the trunk's physical receiving head. They are proposals only:
// no source, shore, or junction is published before a complete joint bake.
export function extendRegionalTrunk(world, trunk, localNetwork) {
  if (trunk?.status !== 'baked' || !trunk.route || trunk.component?.reaches?.length !== 1
    || !trunk.component.reaches[0].channelProfile?.regionalTrunk) return trunk;
  world = waterPlanningTerrain(world);
  const base = trunk.component.reaches[0], route = trunk.route;
  const receiving = new SparseRiverComponentField(trunk.mesh, { clone: false });
  const stations = receivingStations(route, base);
  const localSources = (localNetwork?.components || []).flatMap(component =>
    (component.routes || []).map(candidate => ({ ...candidate.points[0], id: candidate.source, origin: 'local-network' })));
  const accepted = [], attempts = [], usedSources = new Set();
  let result = trunk, proposals = 0;
  for (const station of stations) {
    const sources = tributarySources(world, station, base, localSources, usedSources);
    for (const source of sources.slice(0, 2)) {
      if (proposals >= MAX_PROPOSALS) break;
      proposals++;
      const branch = routeTributary(source, station, route.id);
      if (branch.status !== 'candidate') {
        attempts.push({ source: source.id, join: station.id, stage: 'route', reason: branch.reason }); continue;
      }
      const branches = [...accepted, { station, source, branch }];
      let fitted = fitJointSections(world, route, base, branches, receiving);
      if (fitted.status === 'fitted') {
        const ownership = prepareRiverJunctions(fitted);
        if (ownership.status !== 'prepared') fitted = ownership;
      }
      if (fitted.status !== 'fitted' || !meanderFootprintsSeparated(fitted.reaches)) {
        attempts.push({ source: source.id, join: station.id, stage: 'fit',
          reason: fitted.reason || 'bank-self-overlap',
          ...(Number.isInteger(fitted.section) ? { section: fitted.section } : {}),
          ...(Number.isFinite(fitted.x) ? { x: fitted.x } : {}),
          ...(Number.isFinite(fitted.z) ? { z: fitted.z } : {}),
          ...(fitted.id !== undefined ? { conflict: fitted.id } : {}),
          ...(Number.isFinite(fitted.minY) ? { minY: fitted.minY } : {}),
          ...(Number.isFinite(fitted.maxY) ? { maxY: fitted.maxY } : {}) }); continue;
      }
      const mesh = bakeSparseRiverComponent(world, fitted, { gridStep: 8, maxCells: MAX_CELLS });
      if (mesh.status !== 'baked') {
        attempts.push({ source: source.id, join: station.id, stage: 'mesh', reason: mesh.reason }); continue;
      }
      if (JSON.stringify(mesh).length > MAX_BYTES) {
        attempts.push({ source: source.id, join: station.id, stage: 'mesh', reason: 'tributary-memory-budget' }); continue;
      }
      accepted.push({ station, source, branch }); usedSources.add(source.id);
      result = { ...trunk, component: fitted, mesh };
      const reach = fitted.reaches.find(candidate => candidate.id === branch.id);
      const length = reach.points.at(-1).arc;
      attempts.push({ source: source.id, join: station.id, stage: 'accepted', origin: source.origin,
        length, sinuosity: length / Math.hypot(station.x - source.x, station.z - source.z),
        sourceWidth: reach.points[0].leftWidth + reach.points[0].rightWidth,
        downstreamWidth: reach.points.at(-1).leftWidth + reach.points.at(-1).rightWidth });
      break;
    }
  }
  return { ...result, diagnostics: { ...trunk.diagnostics, tributaries: {
    accepted: accepted.length, proposed: Math.min(proposals, MAX_PROPOSALS), attempts,
    joins: result.component.junctions.map(join => ({ id: join.nodeId, x: join.x, z: join.z, waterY: join.waterY })),
  } } };
}

function receivingStations(route, fitted) {
  const length = route.points.at(-1).arc, stations = [];
  for (const fraction of [0.42, 0.53, 0.80]) {
    const targetIndex = clamp(Math.round((route.points.length - 1) * fraction), 1, route.points.length - 2);
    let index = targetIndex;
    if (route.valleyWaves) {
      // Place a confluence on a quieter part of the fitted valley curve.
      // Fixed arc fractions can land on the apex of a newly authored bend,
      // requiring a level collar longer than its physical ownership budget.
      const choices = [];
      for (let j = Math.max(1, targetIndex - 7); j <= Math.min(route.points.length - 2, targetIndex + 7); j++) {
        const p = route.points[j];
        const near = fitted.points.find(q => Math.hypot(q.x - p.x, q.z - p.z) < 1e-8);
        if (near && p.arc >= 192 && length - p.arc >= 192) choices.push({ index: j,
          score: Math.abs(near.smoothedCurvature || 0) * 10000 + Math.abs(j - targetIndex) * 0.1 });
      }
      choices.sort((a, b) => a.score - b.score || a.index - b.index);
      index = choices.find(c => stations.every(s => Math.abs(c.index - s.routeIndex) > 8))?.index;
      if (index === undefined) continue;
    }
    const point = route.points[index];
    if (point.arc < 192 || length - point.arc < 192) continue;
    let target = null, distance = Infinity;
    let fittedIndex = 0;
    for (let i = 0; i < fitted.points.length; i++) {
      const sample = fitted.points[i];
      const d = (sample.x - point.x) ** 2 + (sample.z - point.z) ** 2;
      if (d < distance) { distance = d; target = sample; fittedIndex = i; }
    }
    if (!target || distance > 1e-8) continue;
    stations.push({ ...target, routeIndex: index, fittedIndex, canonicalArc: point.arc,
      id: `${route.id}:join:${index}` });
  }
  return stations;
}

function tributarySources(world, station, trunk, localSources, used) {
  const sources = [...localSources];
  for (const side of [-1, 1]) for (const offset of [192, 288, 384, 480]) for (const upstream of [0, 96, 192]) {
    sources.push({ id: `${station.id}:spring:${side}:${offset}:${upstream}`, origin: 'valley-spring',
      x: station.x - station.tx * upstream - station.tz * side * offset,
      z: station.z - station.tz * upstream + station.tx * side * offset });
  }
  return sources.filter(source => {
    if (used.has(source.id)) return false;
    const distance = Math.hypot(source.x - station.x, source.z - station.z);
    const height = world._naturalHeight(source.x, source.z);
    source.height = height; source.distance = distance;
    if (distance < 160 || distance > 850 || height < station.waterY + 0.4
      || height > station.waterY + Math.min(12, distance * 0.023)) return false;
    return trunk.points.every(point => Math.hypot(source.x - point.x, source.z - point.z)
      > Math.max(point.leftWidth, point.rightWidth) + 24);
  }).sort((a, b) => Number(a.origin !== 'local-network') - Number(b.origin !== 'local-network')
    || a.distance + Math.abs(a.height - station.waterY - a.distance * 0.01) * 20
      - b.distance - Math.abs(b.height - station.waterY - b.distance * 0.01) * 20
    || a.id.localeCompare(b.id));
}

function routeTributary(source, station, trunkId) {
  // A compact, smooth final approach meets the downstream current without a
  // sharp 32m lattice turn. Full bank/earthwork fitting is still authoritative.
  const dx = station.x - source.x, dz = station.z - source.z;
  const length = Math.hypot(dx, dz), count = Math.max(12, Math.ceil(length / 16)), points = [];
  const sourceHead = Math.min(source.height, station.waterY + length * 0.01);
  const hx = station.tx * 0.25 + dx / length, hz = station.tz * 0.25 + dz / length, hl = Math.hypot(hx, hz) || 1;
  const direction = [...source.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 2 ? 1 : -1;
  const sweep = Math.min(64, length * 0.085) * Math.min(1, length / 300) * direction;
  for (let i = 0; i <= count; i++) {
    const t = i / count, t2 = t * t, t3 = t2 * t;
    const a = 2 * t3 - 3 * t2 + 1, b = t3 - 2 * t2 + t;
    const c = -2 * t3 + 3 * t2, d = t3 - t2;
    const bend = sweep * Math.sin(Math.PI * t) ** 2
      * (Math.sin(2 * Math.PI * t) + 0.25 * Math.sin(3 * Math.PI * t));
    points.push({ x: a * source.x + b * dx + c * station.x + d * hx / hl * length - dz / length * bend,
      z: a * source.z + b * dz + c * station.z + d * hz / hl * length + dx / length * bend,
      waterY: sourceHead + (station.waterY - sourceHead) * t });
  }
  points[0] = { ...points[0], id: source.id, x: source.x, z: source.z };
  points[points.length - 1] = { ...points.at(-1), id: station.id, x: station.x, z: station.z,
    waterY: station.waterY, preferredY: station.waterY };
  return { status: 'candidate', source: source.id, id: `tributary:${trunkId}:${source.id}`, points,
    routing: 'bounded-valley-proposal',
    sourceClosure: true, oceanMouth: false };
}

function fitJointSections(world, route, base, branches, receiving) {
  const profile = base.channelProfile;
  const joins = [...branches].sort((a, b) => a.station.fittedIndex - b.station.fittedIndex);
  const indexes = [0, ...joins.map(branch => branch.station.fittedIndex), base.points.length - 1];
  const byIndex = new Map(joins.map(branch => [branch.station.fittedIndex, branch.station]));
  const reaches = [];
  const totalArc = route.profileArcLength || route.points.at(-1).arc;
  // An incoming bank lying inside already accepted water is a confluence,
  // rather than a new dry bank. As with lake contacts, that receiving domain
  // supports its head. The final bake still samples the original terrain and
  // must establish complete shared ownership before accepting the branch.
  const branchWorld = Object.create(world), sample = {};
  branchWorld._naturalHeight = (x, z, out) => {
    const natural = world._naturalHeight(x, z, out);
    const height = receiving.sample(x, z, natural, sample) && sample.signedDepth > 0.03
      ? Math.max(natural, sample.waterY + 0.2) : natural;
    if (out) out.h = height;
    return height;
  };
  for (let i = 1; i < indexes.length; i++) {
    const first = indexes[i - 1], last = indexes[i];
    const points = base.points.slice(first, last + 1).map((point, offset) => {
      const station = byIndex.get(first + offset);
      return { ...point, arc: point.arc - base.points[first].arc,
        nodeId: station?.id || point.nodeId || `section:${route.id}:${first + offset}`,
        preferredY: point.waterY };
    });
    const id = `${route.id}:segment:${first}:${last}`;
    const arcOffset = (profile.arcOffset || 0) + (byIndex.get(first)?.canonicalArc || 0);
    reaches.push({ ...base, status: 'prepared', id, points,
      sourceClosure: first === 0, oceanMouth: last === base.points.length - 1,
      bounds: sectionBounds(points),
      channelProfile: { ...profile, arcOffset,
        trendStartArc: profile.arcOffset || 0, trendEndArc: (profile.arcOffset || 0) + totalArc } });
  }
  for (const { branch } of joins) {
    const prepared = prepareRiverReach(branchWorld, branch, { id: branch.id, maxCut: base.maxCut, maxFill: base.maxFill,
      sourceClosure: true, oceanMouth: false, channelProfile: { id: branch.id, halfWidth: 9,
        startHalfWidth: 1, endHalfWidth: 10, trendStartArc: 0,
        trendEndArc: Math.min(96, Math.hypot(branch.points.at(-1).x - branch.points[0].x,
          branch.points.at(-1).z - branch.points[0].z) * 0.6),
        depth: 1.35, variationSeed: profile.variationSeed,
        arcOffset: 0, morphology: true } });
    if (prepared.status !== 'prepared') return prepared;
    reaches.push(prepared);
  }
  const nodes = new Map(), edges = [], junctionIds = new Set(joins.map(join => join.station.id));
  const collars = junctionCollars(reaches, junctionIds);
  if (!collars) return { status: 'rejected', reason: 'tributary-collar-budget' };
  for (const reach of reaches) {
    const length = reach.points.at(-1).arc;
    const atStart = junctionIds.has(reach.points[0].nodeId), atEnd = junctionIds.has(reach.points.at(-1).nodeId);
    const startCollar = collars.get(reach.points[0].nodeId)?.reachLengths.get(reach.id) || 0;
    const endCollar = collars.get(reach.points.at(-1).nodeId)?.reachLengths.get(reach.id) || 0;
    for (let i = 0; i < reach.points.length; i++) {
      const point = reach.points[i], id = point.nodeId || `section:${reach.id}:${i}`;
      point.nodeId = id;
      const prior = nodes.get(id);
      if (prior) {
        if (prior.x !== point.x || prior.z !== point.z) return { status: 'rejected', reason: 'conflicting-tributary-join' };
        prior.minY = Math.max(prior.minY, point.minY); prior.maxY = Math.min(prior.maxY, point.maxY);
        prior.preferredY = Math.min(prior.preferredY, point.preferredY);
      } else nodes.set(id, { id, x: point.x, z: point.z,
        minY: point.minY, maxY: point.maxY, preferredY: point.preferredY });
      if (!i) continue;
      const previous = reach.points[i - 1];
      const level = (atStart && previous.arc < startCollar) || (atEnd && length - point.arc < endCollar)
        || (reach.oceanMouth && length - point.arc < 96);
      edges.push({ id: `${reach.id}:${i}`, from: previous.nodeId, to: id,
        length: point.arc - previous.arc, ...(level ? { maxDrop: 0 } : {}) });
    }
  }
  for (const { station } of joins) {
    const node = nodes.get(station.id);
    // A tidal confluence may reach mean sea level. Its existing bank and
    // earthwork interval remains binding; an arbitrary 25cm minimum should
    // not reject a physically supported lowland tributary.
    node.minY = Math.max(node.minY, 0);
    node.maxY = Math.min(node.maxY, station.waterY);
  }
  const solved = solveRiverGraph([...nodes.values()], edges, { maxGrade: 0.025 });
  if (solved.status !== 'accepted') return solved;
  return { status: 'fitted', reaches: reaches.map(reach => finishRiverReach(reach,
    reach.points.map(point => solved.levels[point.nodeId]))),
    junctions: joins.map(({ station }) => ({ id: `junction:${station.id}`, nodeId: station.id,
      x: station.x, z: station.z, waterY: solved.levels[station.id], levelLength: collars.get(station.id).length })) };
}

// Match the conservative rectangles used by prepareRiverJunctions. A broad
// trunk needs a longer shared head than a creek, but rounding every collar up
// to192/256m can consume all the upper reach's remaining hydraulic grade.
function junctionCollars(reaches, junctionIds) {
  const collars = new Map([...junctionIds].map(id => [id, { length: 0, reachLengths: new Map() }]));
  const sections = reaches.map(reach => ({ reach, segments: reach.points.slice(1).map((b, i) => {
    const a = reach.points[i];
    const margin = Math.max(...[a, b].flatMap(p => ['left', 'right'].map(side =>
      p[`${side}Width`] + p[`${side}BankWidth`] + p[`${side}BlendWidth`])));
    return { a, b, minX: Math.min(a.x, b.x) - margin, maxX: Math.max(a.x, b.x) + margin,
      minZ: Math.min(a.z, b.z) - margin, maxZ: Math.max(a.z, b.z) + margin };
  }) }));
  const ends = reach => [reach.points[0].nodeId, reach.points.at(-1).nodeId];
  const distance = (reach, point, owner) => reach.points[0].nodeId === owner
    ? point.arc : reach.points.at(-1).arc - point.arc;
  for (let i = 0; i < sections.length; i++) for (let k = i + 1; k < sections.length; k++) {
    const left = sections[i], right = sections[k];
    const owner = ends(left.reach).find(id => junctionIds.has(id) && ends(right.reach).includes(id));
    if (!owner) continue;
    for (const a of left.segments) for (const b of right.segments) {
      if (a.minX >= b.maxX || a.maxX <= b.minX || a.minZ >= b.maxZ || a.maxZ <= b.minZ) continue;
      const collar = collars.get(owner);
      for (const [reach, segment] of [[left.reach, a], [right.reach, b]]) {
        const length = Math.max(collar.reachLengths.get(reach.id) || 0,
          distance(reach, segment.a, owner), distance(reach, segment.b, owner));
        collar.reachLengths.set(reach.id, length);
        collar.length = Math.max(collar.length, length);
      }
    }
    if (collars.get(owner).length > 256) return null;
  }
  return collars;
}

function sectionBounds(points) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const point of points) {
    const width = Math.max(point.leftWidth + point.leftBankWidth + point.leftBlendWidth,
      point.rightWidth + point.rightBankWidth + point.rightBlendWidth);
    bounds.minX = Math.min(bounds.minX, point.x - width); bounds.maxX = Math.max(bounds.maxX, point.x + width);
    bounds.minZ = Math.min(bounds.minZ, point.z - width); bounds.maxZ = Math.max(bounds.maxZ, point.z + width);
  }
  return bounds;
}
