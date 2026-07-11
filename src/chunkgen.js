// Pure chunk generation — no THREE, runs in the Web Worker. Produces plain
// typed arrays (transferable back to the main thread) for terrain geometry,
// vegetation instance placements and grass. The RNG call order mirrors the
// original main-thread code exactly, so the generated world is unchanged.

import { groundColor, WATER_LEVEL } from './world.js';
import { mulberry32, smoothstep, lerp } from './noise.js';
import { VARIANT_COUNTS, RECIPES, GRASS_COLORS, GRASS_DENSITY, CLUTTER_RECIPES, UNDERSTORY_RECIPES, UNDERSTORY_SCALE, FLOWER_CLUSTER_CELLS, FLOWER_CLUSTER_BIOMES, rockTint, IMPOSTOR_TYPES } from './vegdata.js';
import { landmarksAround, inLandmarkHalo } from './landmarks.js';
import { trailsAround, trailWearAt } from './trails.js';

// Convert compacted-ground wear into vegetation survival. A smooth threshold
// guarantees a clear primary-route centre while leaving shoulder encroachment;
// the old linear (1 - wear) still allowed full trees and dense grass to land in
// the middle of a visibly established path.
const trailVegetationFactor = (wear) => 1 - smoothstep(0.055, 0.50, wear);

// Euler(XYZ) + position + scale -> 16-float column-major matrix, matching
// THREE.Matrix4.compose(pos, Quaternion.setFromEuler(Euler), scale).
function composeMat4(out, px, py, pz, ex, ey, ez, sx, sy, sz) {
  const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2);
  const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
}

// --- terrain geometry --------------------------------------------------------

export function buildTerrainArrays(world, cx, cz, res, chunkSize) {
  const size = chunkSize;
  const x0 = cx * size, z0 = cz * size;
  const step = size / res;
  const n = res + 1;

  // Sample heights with a one-cell margin so normals come from the grid and
  // neighbouring chunks at different LODs shade consistently. Interior points
  // are the terrain chunk's exact vertex grid — collect the river water levels
  // here too (they fall out of the same world.height calls for free), so the
  // river mesh can be assembled on the SAME grid without re-sampling.
  const hn = n + 2;
  const heights = new Float32Array(hn * hn);
  const rWaterY = new Float32Array(n * n);   // effective surface (sinks at margins)
  const rHead = new Float32Array(n * n);     // pure smooth surface (flow/falls)
  const rSub = new Float32Array(n * n);      // submerge depth (>0 wet)
  const rInfo = { base: 0, ch: 0, floor: 0, head: 0, waterY: 0 };
  let anyWet = false;
  for (let zi = 0; zi < hn; zi++) {
    for (let xi = 0; xi < hn; xi++) {
      const interior = xi >= 1 && xi <= n && zi >= 1 && zi <= n;
      const h = world.height(x0 + (xi - 1) * step, z0 + (zi - 1) * step, interior ? rInfo : undefined);
      heights[zi * hn + xi] = h;
      if (interior) {
        const ri = (zi - 1) * n + (xi - 1);
        rWaterY[ri] = rInfo.waterY;
        rHead[ri] = rInfo.head;
        const s = rInfo.waterY - rInfo.floor;
        // the sinking waterY guarantees s <= 0 outside the channel, so this cut
        // always lands below the rendered terrain (never a floating edge)
        // extend the river sheet BELOW sea level so it slides under the ocean
        // plane at the mouth (no lip); the river shader crossfades it out there.
        const wet = (s > 0.03 && rInfo.waterY > WATER_LEVEL - 0.5 && rInfo.ch > 0.001) ? s : 0;
        rSub[ri] = wet;
        if (wet > 0) anyWet = true;
      }
    }
  }
  const H = (xi, zi) => heights[(zi + 1) * hn + (xi + 1)];

  const skirtCount = 4 * n;
  const vertCount = n * n + skirtCount;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const rgb = [0, 0, 0];

  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const i = zi * n + xi;
      const x = x0 + xi * step, z = z0 + zi * step;
      const h = H(xi, zi);
      positions[i * 3] = x; positions[i * 3 + 1] = h; positions[i * 3 + 2] = z;
      const dx = H(xi - 1, zi) - H(xi + 1, zi);
      const dz = H(xi, zi - 1) - H(xi, zi + 1);
      const len = Math.hypot(dx, 2 * step, dz);
      const ny = (2 * step) / len;
      normals[i * 3] = dx / len; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = dz / len;
      const { t, m } = world.climate(x, z, h);
      groundColor(world, x, z, h, 1 - ny, t, m, rgb, dx / len, dz / len);
      // Forest-floor darkening belongs only beneath forest canopies. Applying
      // groveFactor globally made tundra, snow, grassland and other open
      // biomes acquire broad dark patches even when no trail was present.
      const biomeId = world.classify(h, 1 - ny, t, m);
      const underCanopy = biomeId === 'forest' || biomeId === 'taiga' || biomeId === 'jungle';
      const gd = underCanopy ? 1 - 0.34 * world.groveFactor(x, z) : 1;
      let cr = rgb[0] * gd, cg = rgb[1] * gd, cb = rgb[2] * gd;
      colors[i * 3] = cr; colors[i * 3 + 1] = cg; colors[i * 3 + 2] = cb;
    }
  }

  // Skirts: border vertices copied downward, stitching LOD seams.
  const skirtDrop = 4 + (64 / res) * 6;
  const edges = [];
  for (let xi = 0; xi < n; xi++) edges.push(xi);
  for (let xi = 0; xi < n; xi++) edges.push((n - 1) * n + xi);
  for (let zi = 0; zi < n; zi++) edges.push(zi * n);
  for (let zi = 0; zi < n; zi++) edges.push(zi * n + (n - 1));
  for (let s = 0; s < skirtCount; s++) {
    const src = edges[s];
    const dst = n * n + s;
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirtDrop;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    normals[dst * 3] = normals[src * 3];
    normals[dst * 3 + 1] = normals[src * 3 + 1];
    normals[dst * 3 + 2] = normals[src * 3 + 2];
    colors[dst * 3] = colors[src * 3];
    colors[dst * 3 + 1] = colors[src * 3 + 1];
    colors[dst * 3 + 2] = colors[src * 3 + 2];
  }

  const idx = [];
  for (let zi = 0; zi < res; zi++) {
    for (let xi = 0; xi < res; xi++) {
      const a = zi * n + xi, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const quad = (e0, e1, s0, s1) => idx.push(e0, s0, e1, e1, s0, s1);
  for (let i = 0; i < n - 1; i++) {
    quad(edges[i + 1], edges[i], n * n + i + 1, n * n + i);
    quad(edges[n + i], edges[n + i + 1], n * n + n + i, n * n + n + i + 1);
    quad(edges[2 * n + i], edges[2 * n + i + 1], n * n + 2 * n + i, n * n + 2 * n + i + 1);
    quad(edges[3 * n + i + 1], edges[3 * n + i], n * n + 3 * n + i + 1, n * n + 3 * n + i);
  }
  const indices = new Uint32Array(idx);

  return {
    positions, normals, colors, indices,
    // pre-sampled river water levels on this exact vertex grid (null = dry
    // chunk); buildRiver assembles its mesh from these without re-sampling
    river: anyWet ? { waterY: rWaterY, headY: rHead, sub: rSub } : null,
  };
}

// --- trail surface ----------------------------------------------------------
// Phase 4 decouples visible paths from the terrain vertex grid. Each streamed
// chunk receives a finely sampled ribbon that conforms to the rendered height
// grid, uses RGBA vertex colour for a softly blended shoulder, and keeps
// the underlying biome pigment in the mix. Vegetation still consumes
// trailWearAt(), so the visible surface and cleared corridor share one route.

const TRAIL_SAMPLE_SPACING = 3.2;
const TRAIL_ACROSS = [-1.16, -0.82, 0, 0.82, 1.16];
const TRAIL_EDGE_ALPHA = [0, 0.54, 1, 0.54, 0];
const TRAIL_CLASS = {
  primary: { pigment: 0.68, alpha: 0.88 },
  secondary: { pigment: 0.54, alpha: 0.72 },
  faint: { pigment: 0.40, alpha: 0.50 },
};

function trailHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// Liang–Barsky clipping. Returning parametric bounds lets the ribbon preserve
// its world-space arc rhythm while emitting only the centreline inside a chunk.
function clipTrailSegment(x0, z0, x1, z1, minX, minZ, maxX, maxZ) {
  const dx = x1 - x0, dz = z1 - z0;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, x0 - minX) || !clip(dx, maxX - x0)
    || !clip(-dz, z0 - minZ) || !clip(dz, maxZ - z0)) return null;
  return t1 > t0 + 1e-6 ? [t0, t1] : null;
}

export function buildTrailSurface(world, cx, cz, chunkSize, terrainRes = 64, terrainPositions = null) {
  const minX = cx * chunkSize, minZ = cz * chunkSize;
  const maxX = minX + chunkSize, maxZ = minZ + chunkSize;
  const gridN = terrainRes + 1;
  const gridStep = chunkSize / terrainRes;
  // Match the piecewise-linear streamed mesh rather than the exact height
  // function. Local micro-relief can diverge from a 2–9 m terrain grid by more
  // than the ribbon lift, which otherwise buries a valid path between vertices.
  const renderedGroundY = (x, z) => {
    const gx = Math.max(0, Math.min(terrainRes - 1, Math.floor((x - minX) / gridStep)));
    const gz = Math.max(0, Math.min(terrainRes - 1, Math.floor((z - minZ) / gridStep)));
    const fx = Math.max(0, Math.min(1, (x - (minX + gx * gridStep)) / gridStep));
    const fz = Math.max(0, Math.min(1, (z - (minZ + gz * gridStep)) / gridStep));
    const sample = (xi, zi) => terrainPositions
      ? terrainPositions[(zi * gridN + xi) * 3 + 1]
      : world.height(minX + xi * gridStep, minZ + zi * gridStep);
    const h00 = sample(gx, gz), h10 = sample(gx + 1, gz);
    const h01 = sample(gx, gz + 1), h11 = sample(gx + 1, gz + 1);
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  };
  const trails = [];
  trailsAround(world, minX + chunkSize / 2, minZ + chunkSize / 2,
    world.seed, chunkSize * 0.78, trails);
  if (!trails.length) return null;

  const positions = [], normals = [], colors = [], indices = [];
  const ground = [0, 0, 0];
  let vertexBase = 0;

  for (const edge of trails) {
    const style = TRAIL_CLASS[edge.routeClass] || TRAIL_CLASS.faint;
    const phase = trailHash(edge.id) * Math.PI * 2;
    const s = edge.segments;
    for (let i = 0; i < s.count; i++) {
      const x0 = s.ax[i], z0 = s.az[i], x1 = x0 + s.dx[i], z1 = z0 + s.dz[i];
      const clipped = clipTrailSegment(x0, z0, x1, z1, minX, minZ, maxX, maxZ);
      if (!clipped) continue;
      const segLength = s.len[i] || Math.hypot(x1 - x0, z1 - z0) || 1;
      const tx = (x1 - x0) / segLength, tz = (z1 - z0) / segLength;
      const px = -tz, pz = tx;
      // A small overlap closes the wedge where independently clipped polyline
      // segments turn. Similar biome-aware pigments make the overlap quiet.
      const capT = Math.min(0.045, 0.65 / segLength);
      const ta = Math.max(0, clipped[0] - capT), tb = Math.min(1, clipped[1] + capT);
      const visibleLength = (tb - ta) * segLength;
      const rows = Math.max(1, Math.ceil(visibleLength / TRAIL_SAMPLE_SPACING));

      for (let row = 0; row <= rows; row++) {
        const t = ta + (tb - ta) * (row / rows);
        const arc = s.arc[i] + t * segLength;
        const widthNoise = Math.sin(arc * 0.047 + phase) * 0.075
          + Math.sin(arc * 0.121 - phase * 0.71) * 0.035;
        const centreWander = edge.width * 0.045 * Math.sin(arc * 0.061 + phase * 1.73);
        const cxp = x0 + (x1 - x0) * t + px * centreWander;
        const czp = z0 + (z1 - z0) * t + pz * centreWander;
        const width = edge.width * (1 + widthNoise);

        const h = world.height(cxp, czp);
        const ne = 1.35;
        const hx = renderedGroundY(cxp - ne, czp) - renderedGroundY(cxp + ne, czp);
        const hz = renderedGroundY(cxp, czp - ne) - renderedGroundY(cxp, czp + ne);
        const nl = Math.hypot(hx, ne * 2, hz) || 1;
        const nx = hx / nl, ny = ne * 2 / nl, nz = hz / nl;
        const climate = world.climate(cxp, czp, h);
        groundColor(world, cxp, czp, h, 1 - ny, climate.t, climate.m, ground, nx, nz);
        const biome = world.classify(h, 1 - ny, climate.t, climate.m);
        const gravel = smoothstep(55, 145, h);
        // Lowland paths are warm, compacted umber; altitude gradually exposes
        // pale mineral gravel. The umber is intentionally separated from the
        // olive savanna/forest palette so the path survives the pastel grade.
        let tr = lerp(0.36, 0.46, gravel);
        let tg = lerp(0.235, 0.41, gravel);
        let tbCol = lerp(0.115, 0.37, gravel);
        let pigment = style.pigment;
        if (biome === 'desert' || biome === 'beach') pigment *= 0.48;
        else if (biome === 'savanna') pigment *= 0.80;
        else if (biome === 'snow') { tr = 0.56; tg = 0.55; tbCol = 0.53; pigment *= 0.78; }
        else if (biome === 'tundra' || biome === 'taiga') pigment *= 0.88;
        const rowDry = h > WATER_LEVEL + 0.18 && !world.riverAt(cxp, czp).wet;
        const fleck = 1 + 0.035 * Math.sin(arc * 0.39 + phase * 4.1);

        for (let col = 0; col < TRAIL_ACROSS.length; col++) {
          const lateral = TRAIL_ACROSS[col] * width;
          const x = cxp + px * lateral, z = czp + pz * lateral;
          positions.push(x, renderedGroundY(x, z) + 0.032, z);
          normals.push(nx, ny, nz);
          const shoulder = 1 - Math.min(1, Math.abs(TRAIL_ACROSS[col]));
          const mixAmount = pigment * (0.78 + shoulder * 0.22);
          colors.push(
            lerp(ground[0], tr, mixAmount) * fleck,
            lerp(ground[1], tg, mixAmount) * fleck,
            lerp(ground[2], tbCol, mixAmount) * fleck,
            rowDry ? TRAIL_EDGE_ALPHA[col] * style.alpha : 0
          );
        }
      }

      const cols = TRAIL_ACROSS.length;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols - 1; col++) {
          const a = vertexBase + row * cols + col, b = a + 1;
          const c = a + cols, d = c + 1;
          // Rows advance along the tangent and columns along its left normal;
          // that basis is clockwise in XZ, so wind the triangles in the
          // opposite order to present their +Y face to the walker.
          indices.push(a, b, c, b, d, c);
        }
      }
      vertexBase += (rows + 1) * TRAIL_ACROSS.length;
    }
  }

  if (!indices.length) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

// --- river water -------------------------------------------------------------
// A ribbon mesh that fills each carved channel at its water-surface height.
// Cells touching water emit triangles whose vertices carry submerged depth
// (aWet, for shore/shallows) and downstream flow (aFlow, for ripple scroll +
// rapids). Returns null when the chunk has no wet channel (most chunks).
//
// CRITICAL: the river grid uses EXACTLY the terrain chunk's grid — same
// resolution, same sample points, same triangulation. Water and terrain are
// then piecewise-linear surfaces over the same mesh, so their comparison is
// exact everywhere (not only at sample points): the water sheet provably dips
// below the rendered ground before the mesh is cut, and shorelines are always
// the true water/terrain intersection. (A coarser river grid — the old capped
// 48² — disagreed with the rendered terrain between samples by up to metres,
// leaving stepped water edges hanging mid-air where the two samplings differed.)

export function buildRiver(cx, cz, res, chunkSize, pre) {
  if (!pre) return null;                      // dry chunk (no wet vertex)
  const rres = res;
  const n = rres + 1;
  const step = chunkSize / rres;
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const { waterY, headY, sub } = pre;         // sampled by buildTerrainArrays

  const positions = [], wets = [], flows = [], idx = [];
  const vmap = new Int32Array(n * n).fill(-1);
  const vert = (xi, zi) => {
    const gi = zi * n + xi;
    if (vmap[gi] !== -1) return vmap[gi];
    // downstream = downhill on the PURE water surface (headY); using the
    // effective (sinking) surface here would read shoreline dives as rapids.
    const xm = xi > 0 ? xi - 1 : xi, xp = xi < n - 1 ? xi + 1 : xi;
    const zm = zi > 0 ? zi - 1 : zi, zp = zi < n - 1 ? zi + 1 : zi;
    let fx = headY[zi * n + xm] - headY[zi * n + xp];
    let fz = headY[zm * n + xi] - headY[zp * n + xi];
    const fl = Math.hypot(fx, fz) || 1;
    // slope per metre → flow speed; the head is a gentle continental gradient,
    // so scale up — but conservatively: descending rivers (≳1.5°) read as
    // current, while the mild residual gradient across lake basins (≲1°)
    // stays below the shader's "still water" threshold (mirror surface).
    const speed = Math.min(1, (fl / (2 * step)) * 16);
    const vi = positions.length / 3;
    positions.push(x0 + xi * step, waterY[gi] + 0.02, z0 + zi * step);
    wets.push(sub[gi]);
    flows.push((fx / fl) * speed, (fz / fl) * speed);
    vmap[gi] = vi;
    return vi;
  };

  for (let zi = 0; zi < rres; zi++) {
    for (let xi = 0; xi < rres; xi++) {
      const c00 = zi * n + xi, c10 = c00 + 1, c01 = c00 + n, c11 = c01 + 1;
      if (sub[c00] <= 0 && sub[c10] <= 0 && sub[c01] <= 0 && sub[c11] <= 0) continue;
      const a = vert(xi, zi), b = vert(xi + 1, zi), c = vert(xi, zi + 1), d = vert(xi + 1, zi + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (idx.length === 0) return null;

  return {
    positions: new Float32Array(positions),
    wet: new Float32Array(wets),
    flow: new Float32Array(flows),
    indices: new Uint32Array(idx),
    // falls detect drops on the PURE surface — the sinking margins would
    // otherwise read as a waterfall along every shoreline
    fall: buildFalls(headY, sub, n, rres, step, x0, z0),
  };
}

// Waterfalls/cascades: where the water surface drops sharply between adjacent
// wet cells, emit a near-vertical "curtain" quad from the lip down to the
// plunge level, plus a mist seed point at its base. Returns null when there's
// no steep drop in the chunk (the common case).
const FALL_THRESHOLD = 2.0; // metres of surface drop per cell to count as a fall

function buildFalls(waterY, sub, n, rres, step, x0, z0) {
  const pos = [], uvs = [], idx = [], mist = [];
  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const gi = zi * n + xi;
      if (sub[gi] <= 0.3) continue;            // meaningfully wet only (not margins)
      const wy = waterY[gi];
      // steepest descent toward a wet neighbour
      let lowWy = wy, bdx = 0, bdz = 0, found = false;
      const tryN = (nx, nz) => {
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) return;
        const ni = nz * n + nx;
        if (sub[ni] <= 0.3) return;
        if (waterY[ni] < lowWy) { lowWy = waterY[ni]; bdx = nx - xi; bdz = nz - zi; found = true; }
      };
      tryN(xi + 1, zi); tryN(xi - 1, zi); tryN(xi, zi + 1); tryN(xi, zi - 1);
      const drop = wy - lowWy;
      if (!found || drop < FALL_THRESHOLD) continue;

      const px = x0 + xi * step, pz = z0 + zi * step;
      const dl = Math.hypot(bdx, bdz) || 1;
      const dx = bdx / dl, dz = bdz / dl;     // downstream (horizontal)
      const ox = -dz, oy = dx;                 // perpendicular (channel width)
      const w = step * 0.9, over = step * 0.55;
      const b = pos.length / 3;
      pos.push(px + ox * w * 0.5, wy, pz + oy * w * 0.5);                          uvs.push(0, 0);
      pos.push(px - ox * w * 0.5, wy, pz - oy * w * 0.5);                          uvs.push(1, 0);
      pos.push(px + ox * w * 0.5 + dx * over, wy - drop, pz + oy * w * 0.5 + dz * over); uvs.push(0, 1);
      pos.push(px - ox * w * 0.5 + dx * over, wy - drop, pz - oy * w * 0.5 + dz * over); uvs.push(1, 1);
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      mist.push(px + dx * over, wy - drop + 0.4, pz + dz * over, Math.min(drop, 9));
    }
  }
  if (idx.length === 0) return null;
  return {
    positions: new Float32Array(pos),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(idx),
    mist: new Float32Array(mist),
  };
}

// --- vegetation scatter ------------------------------------------------------
// mode 'full'    -> buckets { type, variant, matrices (count*16), colors|null }
//                   for full geometry: trees, rocks, boulders, pebbles.
// mode 'impostor'-> buckets { type, matrices } for tall trees only (billboards).
// Both modes draw RNG identically in the tree loop, so the same trees land in
// the same spots — the full<->impostor swap never shifts anything.

export function buildScatter(world, cx, cz, chunkSize, opts) {
  const mode = opts.mode || 'full';
  const impostor = mode === 'impostor';
  const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x5f3759df);
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  // Plant each tree on the RENDERED terrain surface, not the true one: sample
  // world.height bilinearly on the SAME grid the tree's terrain is drawn at
  // (chunk res for streamed chunks — vertices land at x0 + i·step — or a coarse
  // cell for far-terrain-only rings). A coarse mesh cuts sharp ridges below
  // their true height, so trees placed at true height perch in the air along
  // every distant ridgeline; this seats them on the visible surface instead.
  // LOD-consistent: when a chunk changes resolution it re-plants on the new
  // grid, so trees move WITH the terrain rather than popping off it.
  // far-terrain-only rings (res 0) have no chunk grid; sample on ~46 m cells to
  // match the radial far mesh's angular spacing at typical impostor range (160
  // spokes span ~43 m at ~1.1 km). The far mesh is a RADIAL mesh not aligned to
  // this world grid, so on steep ground the two coarse surfaces still diverge —
  // farSink biases the tree DOWN (into the depressed far mesh) so residual error
  // errs toward "trunk buried a little" (invisible) rather than "hovering".
  const gcell = opts.res > 0 ? chunkSize / opts.res : 46;
  const gAligned = opts.res > 0;
  const farSink = opts.res > 0 ? 0 : 1.3;
  const groundY = (x, z) => {
    const ox = gAligned ? x0 : 0, oz = gAligned ? z0 : 0;
    const lx = ox + Math.floor((x - ox) / gcell) * gcell;
    const lz = oz + Math.floor((z - oz) / gcell) * gcell;
    const fx = (x - lx) / gcell, fz = (z - lz) / gcell;
    const h00 = world.height(lx, lz), h10 = world.height(lx + gcell, lz);
    const h01 = world.height(lx, lz + gcell), h11 = world.height(lx + gcell, lz + gcell);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz - farSink;
  };
  const map = new Map();
  const m = new Float32Array(16);
  const trails = [];
  trailsAround(world, x0 + chunkSize / 2, z0 + chunkSize / 2, world.seed, chunkSize, trails);
  const col = [0, 0, 0];
  const push = (type, v, color) => {
    const key = impostor ? type : type + '/' + v;
    let b = map.get(key);
    if (!b) map.set(key, b = { type, variant: v, mats: [], cols: color ? [] : null });
    for (let i = 0; i < 16; i++) b.mats.push(m[i]);
    // colour mode is fixed at bucket creation; once coloured, EVERY instance
    // must contribute a colour (default white) to keep instanceColor aligned —
    // pushing a coloured instance into a null-colour bucket (or vice-versa)
    // used to throw and silently hang the worker.
    if (b.cols) b.cols.push(color ? color[0] : 1, color ? color[1] : 1, color ? color[2] : 1);
  };

  // landmarks near this chunk carve a tree-free clearing around themselves
  const lmList = [];
  landmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 32, lmList);

  const attempts = Math.round(240 * opts.treeDensityScale);
  for (let i = 0; i < attempts; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    const recipe = RECIPES[b.id];
    if (!recipe || recipe.density === 0) continue;
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue; // landmark glade
    // open/closed rhythm: broad glades thin trees out, while a mid-frequency
    // grove field gathers the rest into copses (full in stands, sparse loners
    // in the gaps) so the forest reads as rooms rather than a flat carpet.
    const open = world.openFactor(x, z);
    const clump = world.groveFactor(x, z);
    // treeline: forests thin into krummholz and stop on cold, high ground
    const treeF = smoothstep(-3.5, 2.5, b.t);
    const twear = trails.length ? trailWearAt(trails, x, z) : 0;
    if (rng() > recipe.density * (1 - open * 0.92) * (0.15 + 1.1 * clump) * treeF * trailVegetationFactor(twear)) continue;
    if (b.slope > 0.5 || b.h < 0.6) continue;
    if (b.id !== 'beach' && b.h < 1.5) continue;
    const rv = world.riverAt(x, z);
    if (rv.wet && rv.depth > 0.3) continue; // no trees standing in the channel
    let pick = rng(), type = recipe.mix[0][0];
    for (const [t, w] of recipe.mix) { pick -= w; if (pick <= 0) { type = t; break; } }
    const v = (rng() * VARIANT_COUNTS[type]) | 0;
    // stunted near the treeline, fuller where it's wetter
    const s = (0.7 + rng() * 0.7) * (0.55 + 0.45 * treeF) * (0.92 + 0.16 * b.m);
    const ey = rng() * Math.PI * 2;
    const sy = s * (0.85 + rng() * 0.3);
    composeMat4(m, x, groundY(x, z) - 0.18, z, 0, ey, 0, s, sy, s);
    if (impostor) { if (IMPOSTOR_TYPES.has(type)) push(type, v, null); }
    else push(type, v, null);
  }

  if (impostor) {
    // Tall trees are all placed in the loop above; skip rocks/grass entirely.
    const out = [];
    for (const b of map.values()) out.push({ type: b.type, matrices: new Float32Array(b.mats) });
    return out;
  }

  // Understory + edge skirts: small shade shrubs and saplings under and around
  // groves, so forests read as a layered space you walk INTO rather than tall
  // trees standing over bare grass. Shrubs tolerate a bit more openness than the
  // trees, so they naturally ring each grove with a thinning skirt.
  for (let i = 0; i < 80; i++) {
    const x = x0 + rng() * chunkSize, z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    if (!(b.id === 'forest' || b.id === 'taiga' || b.id === 'jungle')) continue;
    if (b.slope > 0.5 || b.h < 1.5) continue;
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue;
    const rv = world.riverAt(x, z);
    if (rv.wet && rv.depth > 0.2) continue;
    const clump = world.groveFactor(x, z);
    const open = world.openFactor(x, z);
    const treeF = smoothstep(-3.5, 2.5, b.t);
    // dense in the grove interior, thinning through the edge into the open
    const dens = smoothstep(0.18, 0.72, clump) * (1 - open * 0.7) * treeF
               * (trails.length ? trailVegetationFactor(trailWearAt(trails, x, z)) : 1);
    if (rng() > dens) continue;
    let type, v, sc;
    if (rng() < 0.72) {                 // shade shrub
      type = 'shrub'; v = (rng() * VARIANT_COUNTS.shrub) | 0; sc = 0.5 + rng() * 0.55;
    } else {                            // sapling (a small tree)
      type = b.id === 'taiga' ? 'conifer' : 'broadleaf';
      v = (rng() * VARIANT_COUNTS[type]) | 0; sc = 0.26 + rng() * 0.22;
    }
    const ey = rng() * Math.PI * 2, sy = sc * (0.85 + rng() * 0.3);
    composeMat4(m, x, groundY(x, z) - 0.14, z, 0, ey, 0, sc, sy, sc);
    push(type, v, null);
  }

  // --- Trail dressing (Phase 2): waymark cairns + river stepping stones ------
  // Deterministic markers that make a path read as travelled — a small cairn
  // every ~170 m set just off the path, and flat stepping stones where a trail
  // fords a river. Each marker is emitted only by the chunk it falls in (dedup).
  const th = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const inChunk = (x, z) => x >= x0 && x < x0 + chunkSize && z >= z0 && z < z0 + chunkSize;
  for (const e of trails) {
    const p = e.pts;
    let acc = 0, nextC = 85, lastFordArc = -1e9;
    for (let i = 0; i < p.length - 2; i += 2) {
      const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
      const sl = Math.hypot(bx - ax, bz - az) || 1;
      const ox = -(bz - az) / sl, oz = (bx - ax) / sl;   // perpendicular
      // stepping stones where the segment midpoint fords a river
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      if (inChunk(mx, mz)) {
        const rv = world.riverAt(mx, mz);
        const midArc = acc + sl * 0.5;
        // Distance-adaptive trail sampling can put several consecutive
        // midpoints in one broad channel; emit one crossing cluster, not a row
        // of duplicate stepping-stone sets.
        if (rv.wet && midArc - lastFordArc > 30) {
          lastFordArc = midArc;
          for (let k = -1; k <= 1; k++) {
            const sx = mx + ox * k * 0.85, sz = mz + oz * k * 0.85;
            composeMat4(m, sx, rv.y - 0.02, sz, 0, th(sx, sz) * 6.28, 0, 0.8, 0.22, 0.8);
            push('boulder', (th(sx + 3, sz) * VARIANT_COUNTS.boulder) | 0, rockTint('rock', rng, col));
          }
        }
      }
      // waymark cairns at ~170 m arc-length intervals, just off the path
      while (acc + sl >= nextC) {
        const t = (nextC - acc) / sl;
        const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
        nextC += 170;
        const side = th(cx, cz) < 0.5 ? 1.7 : -1.7;
        const px = cx + ox * side, pz = cz + oz * side;
        if (!inChunk(px, pz)) continue;
        const b2 = world.biomeAt(px, pz);
        if (b2.slope > 0.42 || b2.h < 1.5 || world.riverAt(px, pz).wet) continue;
        let yy = groundY(px, pz) - 0.12;
        const nStack = 3 + ((th(px, pz) * 2.99) | 0);
        for (let sN = 0; sN < nStack; sN++) {
          const scv = 0.42 - sN * 0.065;
          composeMat4(m, px, yy + scv * 0.35, pz, 0, th(px + sN, pz) * 6.28, 0, scv, scv * 0.85, scv);
          push('pebble', (th(px + sN * 3, pz) * VARIANT_COUNTS.pebble) | 0, rockTint('rock', rng, col));
          yy += scv * 0.5;
        }
      }
      acc += sl;
    }
  }

  // rocks & boulders: field rocks everywhere, scree on steep / high ground,
  // occasional large weathered boulders — all partially buried
  for (let i = 0; i < 40; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    if (b.h < 0.5) continue;
    // strewn rubble on steep high ground = alpine scree fields
    const p = 0.07 + b.slope * 0.85 + (b.h > 100 ? 0.2 : 0)
            + smoothstep(0.5, 0.8, b.slope) * smoothstep(115, 185, b.h) * 0.5;
    if (rng() > p) continue;
    const isBoulder = rng() < 0.22;
    const type = isBoulder ? 'boulder' : 'rock';
    const v = (rng() * VARIANT_COUNTS[type]) | 0;
    const s = isBoulder ? 1.3 + rng() * 2.4 : 0.22 + rng() * 0.85;
    // bury boulders deeper — a big sphere on a steep slope otherwise exposes its
    // downhill underside and reads as floating even with its centre grounded
    const bury = isBoulder ? 0.44 + rng() * 0.2 : 0.3 + rng() * 0.25;
    const ex = (rng() - 0.5) * 0.5, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.5;
    const sx = s * (0.75 + rng() * 0.5), sz = s * (0.75 + rng() * 0.5);
    composeMat4(m, x, groundY(x, z) - s * bury, z, ex, ey, ez, sx, s, sz);
    push(type, v, rockTint(b.id, rng, col));
  }

  // beach pebbles: clusters of small water-worn stones near the tide line
  for (let i = 0; i < 26; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    if (b.id !== 'beach' || b.slope > 0.3) continue;
    const count = 5 + (rng() * 9 | 0);
    for (let k = 0; k < count; k++) {
      const px = x + (rng() - 0.5) * 4;
      const pz = z + (rng() - 0.5) * 4;
      const ph = world.height(px, pz);
      if (ph < 0.3) continue;
      const v = (rng() * VARIANT_COUNTS.pebble) | 0;
      const s = 0.05 + rng() * 0.16;
      const ex = (rng() - 0.5) * 0.6, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.6;
      const sx = s * (0.8 + rng() * 0.5), sz = s * (0.8 + rng() * 0.5);
      composeMat4(m, px, ph - s * 0.3, pz, ex, ey, ez, sx, s, sz);
      push('pebble', v, rockTint('beach', rng, col));
    }
  }

  // riverside features: large boulders strewn on the banks, bigger ones set in
  // the channel itself, and clusters of trees hugging the banks. Full-geometry
  // only (runs after the impostor return), so it never affects tree alignment.
  // A coarse wetness scan skips the many chunks with no river.
  let hasRiver = false;
  for (let zi = 0; zi <= 4 && !hasRiver; zi++) {
    for (let xi = 0; xi <= 4; xi++) {
      if (world.riverAt(x0 + (xi / 4) * chunkSize, z0 + (zi / 4) * chunkSize).wet) { hasRiver = true; break; }
    }
  }
  if (hasRiver) {
    for (let i = 0; i < 80; i++) {
      const x = x0 + rng() * chunkSize;
      const z = z0 + rng() * chunkSize;
      const r = world.riverAt(x, z);

      if (r.wet) {
        if (r.depth < 0.65) {
          // reeds & cattails standing in the shallow margins
          if (rng() < 0.6) {
            const clumps = 1 + (rng() * 3 | 0);
            for (let c = 0; c < clumps; c++) {
              const rx = x + (rng() - 0.5) * 3, rz = z + (rng() - 0.5) * 3;
              const rr = world.riverAt(rx, rz);
              if (rr.wet && rr.depth < 0.8) {
                const v = (rng() * VARIANT_COUNTS.reed) | 0;
                const s = 0.7 + rng() * 0.7;
                const ry = rng() * Math.PI * 2;
                composeMat4(m, rx, rr.floor - 0.05, rz, 0, ry, 0, s, s * (0.8 + rng() * 0.5), s);
                push('reed', v, null);
              }
            }
          }
        } else if (rng() < 0.13 && r.depth < 3.2) {
          // big boulders standing in the deeper channel, partly submerged
          const v = (rng() * VARIANT_COUNTS.boulder) | 0;
          const s = 1.7 + rng() * 2.6;
          const ex = (rng() - 0.5) * 0.4, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.4;
          const sx = s * (0.8 + rng() * 0.4), sz = s * (0.8 + rng() * 0.4);
          composeMat4(m, x, r.floor - s * 0.12, z, ex, ey, ez, sx, s, sz);
          push('boulder', v, rockTint('rock', rng, col));
        }
        continue;
      }

      // dry point: a bank only if water is within a few metres
      const bank = world.riverAt(x + 5, z).wet || world.riverAt(x - 5, z).wet ||
                   world.riverAt(x, z + 5).wet || world.riverAt(x, z - 5).wet ||
                   world.riverAt(x + 4, z + 4).wet || world.riverAt(x - 4, z - 4).wet;
      if (!bank) continue;
      const b = world.biomeAt(x, z);
      if (b.h < 0.6) continue;

      // gallery forest: dry biomes get a lush broadleaf corridor along the water
      const dry = b.id === 'savanna' || b.id === 'desert' || b.id === 'grassland';
      const roll = rng();
      const clusterCut = dry ? 0.9 : 0.62;
      if (roll < 0.28 && b.slope < 0.7) {
        // large boulder on the bank, partially buried
        const v = (rng() * VARIANT_COUNTS.boulder) | 0;
        const s = 1.4 + rng() * 2.5;
        const ex = (rng() - 0.5) * 0.5, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.5;
        const sx = s * (0.75 + rng() * 0.5), sz = s * (0.75 + rng() * 0.5);
        composeMat4(m, x, b.h - s * (0.24 + rng() * 0.16), z, ex, ey, ez, sx, s, sz);
        push('boulder', v, rockTint(b.id, rng, col));
      } else if (roll < clusterCut && b.slope < 0.55) {
        // a cluster of riparian trees — broadleaf-dominated, denser in dry biomes
        const recipe = RECIPES[b.id];
        const k = (dry ? 4 : 3) + (rng() * 4 | 0);
        for (let j = 0; j < k; j++) {
          const a = rng() * Math.PI * 2;
          const rad = 1.5 + rng() * 6.5;
          const tx = x + Math.cos(a) * rad, tz = z + Math.sin(a) * rad;
          const rr = world.riverAt(tx, tz);
          // broadleaf gallery; lush biomes occasionally mix in the local species
          let type = 'broadleaf';
          if (!dry && rng() < 0.35 && recipe && recipe.mix.length) {
            let p = rng(); type = recipe.mix[0][0];
            for (const [t, wt] of recipe.mix) { p -= wt; if (p <= 0) { type = t; break; } }
          }
          const v = (rng() * VARIANT_COUNTS[type]) | 0;
          const s = 0.85 + rng() * 0.7;
          const ry = rng() * Math.PI * 2;
          const sy = s * (0.85 + rng() * 0.3);
          if (rr.floor > 0.6 && !(rr.wet && rr.depth > 0.3)) {
            composeMat4(m, tx, rr.floor - 0.18, tz, 0, ry, 0, s, sy, s);
            push(type, v, null);
          }
        }
      }
    }
  }

  const out = [];
  for (const b of map.values()) {
    out.push({
      type: b.type, variant: b.variant,
      matrices: new Float32Array(b.mats),
      colors: b.cols ? new Float32Array(b.cols) : null,
    });
  }
  return out;
}

// --- ground clutter ----------------------------------------------------------
// Small props (ferns, flowers, mushrooms, leaf litter, fallen logs, snags,
// pebbles, driftwood) strewn across each chunk by a biome-keyed recipe table.
// Density is boosted under canopy (groveFactor — ferns/mushrooms/litter thrive
// in shade), shore proximity adds a beach skirt (driftwood, pebble drifts), and
// nothing is placed inside a river or in landmark halos.

export function buildClutter(world, cx, cz, chunkSize, opts) {
  const rng = mulberry32((cx * 51874849) ^ (cz * 11400714) ^ 0x29a7c1bf);
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const map = new Map();
  const m = new Float32Array(16);
  const trails = [];
  trailsAround(world, x0 + chunkSize / 2, z0 + chunkSize / 2, world.seed, chunkSize, trails);
  const push = (type, v) => {
    const key = type + '/' + v;
    let b = map.get(key);
    if (!b) map.set(key, b = { type, variant: v, mats: [] });
    for (let i = 0; i < 16; i++) b.mats.push(m[i]);
  };

  const lmList = [];
  landmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 32, lmList);

  const attempts = Math.round(440 * (opts.clutterDensityScale || 1));
  for (let i = 0; i < attempts; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    const recipe = CLUTTER_RECIPES[b.id];
    if (!recipe || recipe.density === 0) continue;
    if (b.slope > 0.6 || b.h < 0.4) continue;
    const rv = world.riverAt(x, z);
    if (rv.wet && rv.depth > 0.05) continue;     // not in the channel
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue;

    // canopy boost: groves enrich the forest-floor mix (more ferns/mushrooms);
    // moisture nudges density up too
    const clump = world.groveFactor(x, z);
    const lush = (b.id === 'forest' || b.id === 'jungle' || b.id === 'taiga') ? (0.5 + clump * 0.9) : 1;
    // fewer logs/mushrooms/pebbles where the dense grass field already fills
    // the ground (meadows/rolling hills) — reclaim that geometry for grass
    const meadow = (1 - smoothstep(38, 72, b.h)) * (1 - smoothstep(0.18, 0.33, b.slope));
    const cwear = trails.length ? trailWearAt(trails, x, z) : 0;
    if (rng() > recipe.density * lush * (1 - 0.7 * meadow) * trailVegetationFactor(cwear)) continue;

    // weighted pick from the recipe mix
    let pick = rng(), type = recipe.mix[0][0];
    for (const [t, w] of recipe.mix) { pick -= w; if (pick <= 0) { type = t; break; } }
    const v = (rng() * VARIANT_COUNTS[type]) | 0;

    const s = 0.85 + rng() * 0.4;
    const ey = rng() * Math.PI * 2;
    // logs and litter sit flat; others stand upright with a tiny lean
    const flat = (type === 'fallenLog' || type === 'driftwood' || type === 'litter' || type === 'pebble');
    const ex = flat ? 0 : (rng() - 0.5) * 0.1;
    const ez = flat ? 0 : (rng() - 0.5) * 0.1;
    composeMat4(m, x, b.h - (flat ? 0.03 : 0.01), z, ex, ey, ez, s, s, s);
    push(type, v);
  }

  const out = [];
  for (const b of map.values()) out.push({
    type: b.type, variant: b.variant, matrices: new Float32Array(b.mats), colors: null,
  });
  return out;
}

// --- understory billboard layer ------------------------------------------------
// Cheap atlas-billboard plants (bracken, lupins, cow-parsley, …) strewn far
// denser than the full-geometry clutter can afford: each is a crossed quad, and
// the whole chunk's layer renders as ONE InstancedMesh (per-instance aCell picks
// the plant from the shared atlas). Placement mirrors the clutter pass.
export function buildUnderstory(world, cx, cz, chunkSize, opts) {
  const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x51f7a2b);
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const trails = [];
  trailsAround(world, x0 + chunkSize / 2, z0 + chunkSize / 2, world.seed, chunkSize, trails);
  const lmList = [];
  landmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 32, lmList);

  const mats = [], cells = [], cols = [];
  const m = new Float32Array(16);
  const attempts = Math.round(560 * (opts.clutterDensityScale || 1));
  for (let i = 0; i < attempts; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    const recipe = UNDERSTORY_RECIPES[b.id];
    if (!recipe || recipe.density === 0) continue;
    if (b.slope > 0.55 || b.h < 0.5) continue;
    const rv = world.riverAt(x, z);
    if (rv.wet && rv.depth > 0.05) continue;
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue;
    // forest species thicken under the groves, thin in the open
    const clump = world.groveFactor(x, z);
    const lush = (b.id === 'forest' || b.id === 'jungle' || b.id === 'taiga') ? (0.45 + clump) : 1;
    const uwear = trails.length ? trailWearAt(trails, x, z) : 0;
    if (rng() > recipe.density * lush * trailVegetationFactor(uwear)) continue;

    let pick = rng(), cell = recipe.mix[0][0];
    for (const [ci, w] of recipe.mix) { pick -= w; if (pick <= 0) { cell = ci; break; } }
    const [sMin, sMax] = UNDERSTORY_SCALE[cell];
    const s = sMin + rng() * (sMax - sMin);
    composeMat4(m, x, b.h - 0.02, z, (rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08, s, s * (0.9 + rng() * 0.25), s);
    for (let k = 0; k < 16; k++) mats.push(m[k]);
    cells.push(cell);
    // gentle per-plant value/warmth jitter over the painted atlas colours
    const v = 0.82 + rng() * 0.32;
    cols.push(v * (0.96 + rng() * 0.08), v, v * (0.92 + rng() * 0.12));
  }

  // --- meadow flower drifts: clusters of billboard blooms ---------------------
  // Same slow zone noise that used to carve the grass-field's diamond-flower
  // drifts, now spawning CLUSTERS: each accepted centre picks one or two flower
  // species and rings 8-20 of them within a few metres — blooms gather into
  // coherent painterly patches, densest in the heart of a drift.
  const flowerZone = (fx, fz) =>
    Math.max(0, Math.min(1, (world.glade.fbm(fx * 0.02 + 7, fz * 0.02, 2) - 0.15) * 2.2));
  for (let ci = 0; ci < 34; ci++) {
    const cxp = x0 + rng() * chunkSize;
    const czp = z0 + rng() * chunkSize;
    const zone = flowerZone(cxp, czp);
    if (zone < 0.2) continue;
    const b = world.biomeAt(cxp, czp);
    if (!FLOWER_CLUSTER_BIOMES.includes(b.id)) continue;
    if (b.slope > 0.42 || b.h < 0.6) continue;
    // flowers live where the meadow grass lives: low gentle ground, in the open
    const meadow = (1 - smoothstep(38, 72, b.h)) * (1 - 0.75 * world.groveFactor(cxp, czp));
    const cwear = trails.length ? trailWearAt(trails, cxp, czp) : 0;
    if (rng() > zone * meadow * trailVegetationFactor(cwear)) continue;
    if (lmList.length && inLandmarkHalo(lmList, cxp, czp)) continue;

    const cellA = FLOWER_CLUSTER_CELLS[(rng() * FLOWER_CLUSTER_CELLS.length) | 0];
    const cellB = rng() < 0.45 ? FLOWER_CLUSTER_CELLS[(rng() * FLOWER_CLUSTER_CELLS.length) | 0] : cellA;
    const n = 10 + ((rng() * 17) | 0);
    const rad = 2.4 + rng() * 3.8;
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * rad;
      const px = cxp + Math.cos(a) * d, pz = czp + Math.sin(a) * d;
      if (trails.length && trailWearAt(trails, px, pz) > 0.08) continue;
      const bb = world.biomeAt(px, pz);
      if (bb.slope > 0.5 || bb.h < 0.5) continue;
      const rv = world.riverAt(px, pz);
      if (rv.wet && rv.depth > 0.05) continue;
      const cell = rng() < 0.7 ? cellA : cellB;
      const [sMin, sMax] = UNDERSTORY_SCALE[cell];
      const s = sMin + rng() * (sMax - sMin);
      composeMat4(m, px, bb.h - 0.02, pz, (rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08, s, s * (0.9 + rng() * 0.25), s);
      for (let q = 0; q < 16; q++) mats.push(m[q]);
      cells.push(cell);
      const v = 0.85 + rng() * 0.3;
      cols.push(v * (0.97 + rng() * 0.06), v, v * (0.94 + rng() * 0.1));
    }
  }
  if (!mats.length) return null;
  return {
    matrices: new Float32Array(mats),
    cells: new Float32Array(cells),
    colors: new Float32Array(cols),
  };
}

// --- grass -------------------------------------------------------------------

// Grass is placed in large PATCHES rather than a uniform per-blade scatter: pick
// a patch centre, test the biome ONCE there (a big generation-cost saving — the
// old path ran biomeAt+openFactor+riverAt for every one of thousands of blades),
// then fill a 10–30 m² meadow patch with blades at a constant areal density.
// Patches read as dense lush stands with natural ground between, and every blade
// in a patch shares one sway cell (GRASS_SWAY_CELL) so the whole patch moves
// together in the wind. The sway cell is sized to comfortably contain a patch.
export const GRASS_SWAY_CELL = 8.0; // metres; MUST match the grass vertex shader
const GRASS_AREA_DENSITY = 7.0;     // grass instances per m² inside a patch (lush)

export function buildGrass(world, cx, cz, chunkSize, perChunk) {
  if (perChunk <= 0) return null;
  const rng = mulberry32((cx * 83492791) ^ (cz * 297121507) ^ 0x9e3779b9);
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const trails = [];
  trailsAround(world, x0 + chunkSize / 2, z0 + chunkSize / 2, world.seed, chunkSize, trails);
  const mats = [];
  const cols = [];
  const m = new Float32Array(16);

  const CELL = GRASS_SWAY_CELL;
  // budget → patch count (each patch ~20 m² × areal density blades on average)
  const patches = Math.max(1, Math.round(perChunk / (20 * GRASS_AREA_DENSITY)));
  for (let ci = 0; ci < patches; ci++) {
    const rawX = x0 + rng() * chunkSize, rawZ = z0 + rng() * chunkSize;
    // patch size: a 10–30 m² meadow stand
    const area = 10 + rng() * 20;
    const rad = Math.sqrt(area / Math.PI);        // 1.8–3.1 m
    // Snap the centre into a sway cell and keep the whole patch inside it, so
    // every blade shares one phase/gust and the patch sways as a unit. `slack`
    // is how far the centre can wander and still fit — jitter within it so the
    // patches aren't visibly grid-locked.
    const slack = Math.max(0, CELL * 0.5 - rad - 0.3);
    const ccx = (Math.floor(rawX / CELL) + 0.5) * CELL + (rng() - 0.5) * 2 * slack;
    const ccz = (Math.floor(rawZ / CELL) + 0.5) * CELL + (rng() - 0.5) * 2 * slack;

    const b = world.biomeAt(ccx, ccz);
    const base = GRASS_DENSITY[b.id] || 0;
    if (base <= 0 || b.slope > 0.42 || b.h < WATER_LEVEL + 0.5) continue;
    // grass thickens in the open glades (meadows) the trees thinned out of
    // foothills only: ramp in above the meadow zone, gone by the mountains —
    // the blanket field owns the low ground, patches own the foothill band
    const foothill = smoothstep(46, 70, b.h) * (1 - smoothstep(108, 155, b.h));
    if (foothill < 0.05) continue;
    const d = base * (0.85 + world.openFactor(ccx, ccz) * 0.5) * foothill
            * (trails.length ? trailVegetationFactor(trailWearAt(trails, ccx, ccz)) : 1);
    if (rng() > d) continue;
    const rv = world.riverAt(ccx, ccz);
    if (rv.wet && rv.depth > 0.2) continue; // no grass submerged in the channel
    const c = GRASS_COLORS[b.id];

    // constant areal density → big patches are genuinely full, small ones tidy
    const n = Math.max(8, Math.round(area * GRASS_AREA_DENSITY * (0.6 + 0.6 * d)));
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const rr = rad * Math.sqrt(rng());        // uniform fill toward the centre
      const x = ccx + Math.cos(a) * rr, z = ccz + Math.sin(a) * rr;
      if (trails.length && trailWearAt(trails, x, z) > 0.08) continue;
      const h = world.height(x, z);             // one cheap sample to seat the blade
      if (h < WATER_LEVEL + 0.4) continue;
      const s = 0.55 + rng() * 0.75;
      const ex = (rng() - 0.5) * 0.25, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.25;
      composeMat4(m, x, h - 0.04, z, ex, ey, ez, s, s * (0.7 + rng() * 0.6), s);
      for (let j = 0; j < 16; j++) mats.push(m[j]);
      const jit = 0.6 + rng() * 0.3;
      cols.push(c[0] * jit, c[1] * jit, c[2] * jit);
    }
  }

  // riparian grass: a denser, taller, lusher band along the banks (only on the
  // few chunks that actually have a river — coarse-gated to stay cheap).
  let hasRiver = false;
  for (let zi = 0; zi <= 4 && !hasRiver; zi++) {
    for (let xi = 0; xi <= 4; xi++) {
      if (world.riverAt(x0 + (xi / 4) * chunkSize, z0 + (zi / 4) * chunkSize).wet) { hasRiver = true; break; }
    }
  }
  if (hasRiver) {
    for (let i = 0; i < 420; i++) {
      const x = x0 + rng() * chunkSize;
      const z = z0 + rng() * chunkSize;
      if (trails.length && trailWearAt(trails, x, z) > 0.08) continue;
      const r0 = world.riverAt(x, z);
      if (r0.wet || r0.floor < WATER_LEVEL + 0.3) continue;
      if (!(world.riverAt(x + 3, z).wet || world.riverAt(x - 3, z).wet ||
            world.riverAt(x, z + 3).wet || world.riverAt(x, z - 3).wet)) continue;
      const b = world.biomeAt(x, z);
      if (b.slope > 0.5) continue;
      const s = 0.7 + rng() * 0.8;
      const ex = (rng() - 0.5) * 0.2, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.2;
      composeMat4(m, x, r0.floor - 0.04, z, ex, ey, ez, s, s * (0.85 + rng() * 0.6), s);
      for (let j = 0; j < 16; j++) mats.push(m[j]);
      const jit = 0.85 + rng() * 0.25;
      cols.push((0.30 + rng() * 0.05) * jit, (0.5 + rng() * 0.07) * jit, (0.18 + rng() * 0.05) * jit);
    }
  }

  if (mats.length === 0) return null;
  return { matrices: new Float32Array(mats), colors: new Float32Array(cols) };
}
