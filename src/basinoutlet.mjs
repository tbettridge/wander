import { priorityFlood, floodBasin } from './drainage.mjs';
import { descriptorHash } from './hydrologyformat.mjs';
import { solveRiverProfile } from './riverprofile.mjs';
import { refineBasinConnection, wetBasinAt } from './basinmembership.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';

// Sample alternate wet shore anchors around the actual basin. A low spill
// point is not necessarily wide enough for a complete channel and two banks.
export function drainageAnchors(world, basin, shore) {
  const g = basin.grid, sectors = new Array(16).fill(null);
  for (let iz = 0; iz < g.rows; iz += 2) for (let ix = 0; ix < g.cols; ix += 2) {
    const i = iz * g.cols + ix;
    if (g.signed[i] < 0.12) continue;
    const x = g.x0 + ix * g.step, z = g.z0 + iz * g.step;
    const angle = Math.atan2(z - basin.centerZ, x - basin.centerX);
    const dx = Math.cos(angle), dz = Math.sin(angle);
    if (wetBasinAt([basin], x + dx * 12, z + dz * 12)) continue;
    const h12 = world._naturalHeight(x + dx * 12, z + dz * 12);
    const h32 = world._naturalHeight(x + dx * 32, z + dz * 32);
    const h64 = world._naturalHeight(x + dx * 64, z + dz * 64);
    const cut = Math.max(h12, h32, h64) - basin.level;
    if (cut > 4.5) continue;
    const score = Math.max(0, cut) * 3 + Math.abs(h32 - (basin.level - 0.4))
      + Math.max(0, basin.level - h64 - 2.6) * 4;
    const sector = Math.floor((angle + Math.PI) / (Math.PI * 2) * 16) % 16;
    if (!sectors[sector] || score < sectors[sector].score) sectors[sector] = { x, z, score };
  }
  const anchors = [{ x: shore.x, z: shore.z }];
  for (const p of sectors.filter(Boolean).sort((a, b) => a.score - b.score || a.x - b.x || a.z - b.z)) {
    if (anchors.some(a => Math.hypot(p.x - a.x, p.z - a.z) < 8)) continue;
    anchors.push({ x: p.x, z: p.z });
  }
  return anchors;
}

export function planBasinDrainage(world, basin, { maxVisited = 2048, maxCells = 65536, maxAttempts = 12, hydraulicRouting = true } = {}) {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16
    || !Number.isInteger(maxCells) || maxCells < 1 || maxCells > 65536) throw new Error('Invalid lake drainage budget');
  const reject = (stage, result) => ({ status: 'rejected', basinId: basin.id, stage,
    reason: result.reason, activationReady: false });
  const survey = surveyBasinOutlet(world, basin);
  if (survey.status !== 'candidate') return reject('survey', survey);
  let refined;
  try { refined = refineBasinConnection(world, basin); }
  catch (error) {
    if (error.message === 'Basin connection grid budget exceeded') return reject('refinement', { reason: 'basin-refinement-budget' });
    if (error.message === 'Uncontained refined basin') return reject('refinement', { reason: 'uncontained-refined-basin' });
    throw error;
  }
  const attempts = [], totalBudget = Math.min(8192, maxVisited * maxAttempts);
  let visited = 0;
  for (const anchor of drainageAnchors(world, refined, survey.shore).slice(0, maxAttempts)) {
    if (visited >= totalBudget) break;
    const route = new RiverRoutePlanner(world, { maxVisited: Math.min(maxVisited, totalBudget - visited) })
      .route({ ...anchor, ...(hydraulicRouting ? { minY: basin.level, maxY: basin.level } : {}) },
        { deferProfile: true, hydraulic: hydraulicRouting, basinSource: hydraulicRouting ? refined : null });
    visited += route.visited || 0;
    if (route.status !== 'candidate') { attempts.push(reject('routing', route)); continue; }
    const component = fitRiverComponent(world, { status: 'candidate', junctions: [],
      reaches: [{ ...route, id: `lake-outlet:${basin.id}`, sourceClosure: false, oceanMouth: true }] },
    { basins: [refined], mouthLength: 64,
      fixedLevels: [{ ...anchor, minY: basin.level, maxY: basin.level }] });
    if (component.status !== 'fitted') { attempts.push(reject('fitting', component)); continue; }
    if (!component.reaches[0].basinIds?.includes(basin.id)) {
      attempts.push(reject('fitting', { reason: 'outlet-misses-refined-lake' })); continue;
    }
    component.basins = [refined];
    const mesh = bakeSparseRiverComponent(world, component, { maxCells });
    if (mesh.status !== 'baked') { attempts.push(reject('mesh', mesh)); continue; }
    return { status: 'baked', basin: refined, component, mesh, visited, attempts: attempts.length + 1, activationReady: false };
  }
  const failure = attempts.findLast(a => a.stage === 'mesh') || attempts.findLast(a => a.stage === 'fitting') || attempts.at(-1);
  return { ...(failure || reject('routing', { reason: 'outlet-search-budget' })), visited, attempts };
}

export function fitBasinOutlet(world, basin, survey = surveyBasinOutlet(world, basin)) {
  if (survey.status !== 'candidate') return survey;
  const refined = refineBasinConnection(world, basin);
  const route = { status: 'candidate', source: basin.id,
    points: survey.points.map((p, i) => ({ ...p, id: `lake-outlet:${basin.id}:${i}` })) };
  const reach = fitRiverReach(world, route, { basins: [refined], sourceClosure: false, oceanMouth: false,
    depth: survey.bedDepth, maxCut: survey.maxCut,
    fixedLevels: [{ ...survey.shore, minY: basin.level, maxY: basin.level }] });
  if (reach.status !== 'fitted') return { status: 'rejected', basinId: basin.id, reason: reach.reason, activationReady: false };
  if (!reach.basinIds?.includes(basin.id)) return { status: 'rejected', basinId: basin.id, reason: 'outlet-misses-refined-lake', activationReady: false };
  return { status: 'fitted', basin: refined, reach, activationReady: false };
}

// Survey a real escape route through a closed basin's sill. This is a terrain
// candidate, not permission to publish a flowing lake: channel fitting and a
// shared lake/river shoreline mesh must still pass before activation.
export function surveyBasinOutlet(world, basin, { size = 1024, step = 8, maxCut = 6,
  bedDepth = 1.2, maxPath = 4096 } = {}) {
  if (![basin?.centerX, basin?.centerZ, basin?.level].every(Number.isFinite)
    || typeof basin.id !== 'string' || !basin.id.length
    || !Number.isInteger(size) || size < 64 || size > 1024
    || ![4, 8, 16].includes(step) || size % step !== 0
    || !Number.isFinite(maxCut) || maxCut < 0 || maxCut > 6
    || !Number.isFinite(bedDepth) || bedDepth <= 0 || bedDepth > 3
    || !Number.isInteger(maxPath) || maxPath < 1 || maxPath > 4096) throw new Error('Invalid basin outlet survey');
  const width = size / step + 1;
  // Anchor every sample globally so repeated surveys of the same basin agree.
  const x0 = Math.floor((basin.centerX - size / 2) / step) * step;
  const z0 = Math.floor((basin.centerZ - size / 2) / step) * step;
  const heights = new Float64Array(width * width);
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    heights[z * width + x] = world._naturalHeight(x0 + x * step, z0 + z * step);
  }
  const start = Math.round((basin.centerZ - z0) / step) * width + Math.round((basin.centerX - x0) / step);
  const reject = reason => ({ status: 'rejected', basinId: basin.id, reason, activationReady: false });
  const flooded = floodBasin(heights, width, start, basin.level);
  if (!flooded.cells.length) return reject('dry-basin-anchor');
  if (flooded.boundary) return reject('uncontained-basin');
  const drainage = priorityFlood(heights, width), walked = [], seen = new Set();
  let leftBasin = false, lastWet = -1, destination = -1;
  for (let i = start; i >= 0; i = drainage.parent[i]) {
    if (walked.length >= maxPath) return reject('outlet-path-budget');
    if (seen.has(i)) return reject('outlet-path-cycle');
    seen.add(i); walked.push(i);
    if (flooded.mask[i]) {
      // The minimax parent tree can cross a dry island between two arms of
      // the same lake. Only the final exit is an outlet; earlier exits are not.
      leftBasin = false;
      lastWet = walked.length - 1;
    } else leftBasin = true;
    const x = i % width, z = Math.floor(i / width);
    // Reaching the edge of a bounded survey never certifies an outlet.
    if (x === 0 || z === 0 || x === width - 1 || z === width - 1) return reject('unresolved-outlet-boundary');
    if (leftBasin && heights[i] < basin.level - 0.2) { destination = i; break; }
  }
  if (destination < 0 || lastWet < 0) return reject('no-downstream-valley');
  const path = walked.slice(lastWet);
  let arc = 0;
  const points = path.map((i, n) => {
    const x = x0 + (i % width) * step, z = z0 + Math.floor(i / width) * step;
    if (n) {
      const p = path[n - 1];
      arc += Math.hypot((i % width - p % width) * step, (Math.floor(i / width) - Math.floor(p / width)) * step);
    }
    return { x, z, naturalY: heights[i], arc };
  });
  const sill = points.reduce((best, p) => p.naturalY > best.naturalY ? p : best);
  // Even a perfectly level outlet bed needs this much cutting at the sill.
  // This is a lower bound, not an assertion that the full channel fits.
  const minimumCut = Math.max(0, sill.naturalY - basin.level + bedDepth);
  if (minimumCut > maxCut + 1e-9) return reject('outlet-cut-budget');
  const sections = points.map((p, i) => ({ arc: p.arc,
    minY: Math.max(0, p.naturalY - maxCut + bedDepth, i === 0 ? basin.level : 0),
    maxY: Math.min(basin.level, p.naturalY + bedDepth),
    preferredY: i === 0 ? basin.level : Math.min(basin.level, p.naturalY - 0.6) }));
  const profile = solveRiverProfile(sections, { maxGrade: 0.025 });
  if (profile.status !== 'accepted') return reject('outlet-profile-incompatible');
  points.forEach((p, i) => { p.waterY = profile.levels[i]; p.bedY = p.waterY - bedDepth; });
  const payload = { version: 1, basinId: basin.id, seed: world.seed, level: basin.level,
    lakeHead: { id: `lake-head:${basin.id}`, minY: basin.level, maxY: basin.level },
    shore: points[0], sill, downstream: points.at(-1), points, minimumCut, bedDepth, maxCut, maxGrade: 0.025,
    survey: { x0, z0, step, width, sampled: heights.length } };
  return { status: 'candidate', ...payload, hash: descriptorHash(payload), activationReady: false };
}
