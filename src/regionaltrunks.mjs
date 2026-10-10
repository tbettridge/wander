import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { meanderFootprintsSeparated } from './rivermeanderfit.mjs';
import { BASIN_REGION_SIZE } from './hydrologyformat.mjs';
import { riverChannelInspection } from './riverchannelreport.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Local springs are intentionally small. The regional survey separately
// reserves a long valley route before lake detail can consume its mesh budget.
export function planRegionalTrunk(world, regionX, regionZ) {
  const planner = new RiverRoutePlanner(world, { maxVisited: 4096 });
  const candidates = [];
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
    const px = (regionX + (x + 0.5) / 8) * BASIN_REGION_SIZE;
    const pz = (regionZ + (z + 0.5) / 8) * BASIN_REGION_SIZE;
    const h = world._naturalHeight(px, pz);
    if (h < 8 || h > 60) continue;
    const route = planner.route({ x: px, z: pz }, { deferProfile: true });
    if (route.status === 'candidate' && route.points.at(-1).arc >= 640) candidates.push(route);
  }
  candidates.sort((a, b) => b.points.at(-1).arc - a.points.at(-1).arc
    || a.source.localeCompare(b.source));
  const attempts = [];
  for (const route of candidates.slice(0, 3)) {
    for (const [waves, strength, flip, valleyWaves, valleyAmplitude] of [
      [3, 1.55, 1, 8, 60], [3, 1.55, 1, 4, 120], [3, 1.55, 1],
      [3, 1.2, 1], [3, 0.85, 1], [4, 0.85, 1], [2, 0.56, 1],
    ]) {
      const shaped = regionalCurve(route, world.seed, strength, waves, flip, valleyWaves, valleyAmplitude);
      const profile = { id: `trunk:${world.seed}:${regionX},${regionZ}`, halfWidth: 36,
        startHalfWidth: 28, endHalfWidth: 40, depth: 2.2, arcOffset: 0,
        variationSeed: world.seed + regionX * 137 + regionZ * 719,
        morphology: true, regionalTrunk: true };
      const segmented = { status: 'candidate', reaches: [shaped], junctions: [] };
      const fitted = fitRiverComponent(world, segmented, { channelProfiles: { [shaped.id]: profile },
        maxCut: 16, maxFill: 4, mouthLength: 96 });
      if (fitted.status !== 'fitted') { attempts.push({ source: route.source, strength, reason: fitted.reason }); continue; }
      if (!meanderFootprintsSeparated(fitted.reaches)) { attempts.push({ source: route.source, strength, reason: 'bank-self-overlap' }); continue; }
      let mesh = bakeSparseRiverComponent(world, fitted, { gridStep: 8, maxCells: 21000 });
      if (['uncontained-component-boundary', 'invalid-component-collar'].includes(mesh.reason)) {
        mesh = bakeSparseRiverComponent(world, fitted, { gridStep: 4, maxCells: 21000 });
      }
      if (mesh.status !== 'baked') { attempts.push({ source: route.source, strength, reason: mesh.reason }); continue; }
      return { status: 'baked', component: fitted, mesh, route: shaped,
        diagnostics: { attempts, length: fitted.reaches[0].points.at(-1).arc,
          widths: fitted.reaches[0].points.map(p => p.leftWidth + p.rightWidth), strength,
          ...(valleyWaves ? { valleyWaves, valleyAmplitude } : {}),
          inspection: riverChannelInspection(fitted),
          sinuosity: fitted.reaches[0].points.at(-1).arc / Math.hypot(
            shaped.points.at(-1).x - shaped.points[0].x, shaped.points.at(-1).z - shaped.points[0].z) } };
    }
  }
  return { status: 'rejected', reason: 'regional-trunk-terrain', diagnostics: { attempts } };
}

// A broad river needs broad curvature. Smooth the complete drainage skeleton
// before segmenting it, avoiding a sharp restart at every tributary junction.
export function regionalCurve(route, seed, strength = 1, waves = 2, flip = 1, valleyWaves = 0, valleyAmplitude = 0) {
  const length = route.points.at(-1).arc;
  const spacing = 24, count = Math.ceil(length / spacing), samples = [];
  const at = s => {
    const distance = clamp(s, 0, length);
    let i = 1;
    while (i < route.points.length - 1 && route.points[i].arc < distance) i++;
    const a = route.points[i - 1], b = route.points[i];
    const t = (distance - a.arc) / Math.max(1e-9, b.arc - a.arc);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
      waterY: a.waterY + (b.waterY - a.waterY) * t };
  };
  const filtered = s => {
    let x = 0, z = 0, weight = 0;
    for (let i = -36; i <= 36; i++) {
      const w = Math.exp(-i * i / 288), p = at(s + i * spacing);
      x += p.x * w; z += p.z * w; weight += w;
    }
    return { x: x / weight, z: z / weight };
  };
  const first = filtered(0), last = filtered(length), start = route.points[0], end = route.points.at(-1);
  const phase = ((seed >>> 0) % 13) / 13 * Math.PI * 2;
  const dx = end.x - start.x, dz = end.z - start.z, chord = Math.hypot(dx, dz);
  for (let i = 0; i <= count; i++) {
    const s = length * i / count, t = i / count, p = filtered(s), original = at(s);
    const amplitude = waves >= 3 ? Math.min(190, length * 0.1) : Math.min(340, length * 0.2);
    const offset = amplitude * strength
      * Math.sin(t * Math.PI * waves) * (Math.cos(phase) < 0 ? -1 : 1) * flip * Math.sin(t * Math.PI);
    samples.push({ x: p.x + (start.x - first.x) * (1 - t) + (end.x - last.x) * t - dz / chord * offset,
      z: p.z + (start.z - first.z) * (1 - t) + (end.z - last.z) * t + dx / chord * offset,
      waterY: original.waterY, preferredY: original.waterY, arc: s });
  }
  // Alternate across the local valley axis, rather than only translating the
  // whole drainage skeleton along one global normal. Leave the tidal approach
  // intact; each proposal still passes the full hydraulic and bank fit.
  if (valleyWaves) {
    const axis = samples.map(p => ({ ...p }));
    for (let i = 1; i < samples.length - 1; i++) {
      const t = i / (samples.length - 1), u = clamp((t - 0.60) / 0.20, 0, 1);
      const offset = valleyAmplitude * Math.sin(t * Math.PI * valleyWaves)
        * Math.sin(t * Math.PI) * (1 - u * u * (3 - 2 * u));
      const a = axis[i - 1], b = axis[i + 1], distance = Math.hypot(b.x - a.x, b.z - a.z);
      samples[i].x -= (b.z - a.z) / distance * offset;
      samples[i].z += (b.x - a.x) / distance * offset;
    }
  }
  samples[0] = { ...samples[0], id: start.id, x: start.x, z: start.z };
  samples.at(-1).id = end.id; samples.at(-1).x = end.x; samples.at(-1).z = end.z;
  return { ...route, id: `regional:${route.source}`, points: samples, sourceClosure: true, oceanMouth: true,
    profileArcLength: length, ...(valleyWaves ? { valleyWaves } : {}) };
}
