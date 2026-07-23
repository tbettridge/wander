// Pure chunk generation — no THREE, runs in the Web Worker. Produces plain
// typed arrays (transferable back to the main thread) for terrain geometry,
// vegetation instance placements and grass. The RNG call order mirrors the
// original main-thread code exactly, so the generated world is unchanged.

import { groundColor, WATER_LEVEL } from './world.js';
import { mulberry32, smoothstep, lerp } from './noise.js';
import { VARIANT_COUNTS, RECIPES, GRASS_DENSITY, CLUTTER_RECIPES, UNDERSTORY_RECIPES, UNDERSTORY_SCALE, FLOWER_CLUSTER_CELLS, FLOWER_CLUSTER_BIOMES, rockTint, IMPOSTOR_TYPES, coastalVariantForChunk } from './vegdata.js';
import { landmarksAround, majorLandmarksAround, inLandmarkHalo } from './landmarks.js';
import { trailsAround, trailEcologyAt } from './trails.js';
import { rockPlacementsForChunk } from './rockscatter.mjs';

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
// trailEcologyAt(), so the visible surface and cleared/verge zones share one route.

const TRAIL_SAMPLE_SPACING = 2.6;
const TRAIL_ACROSS = [-1.12, -0.96, -0.68, 0, 0.68, 0.96, 1.12];
const TRAIL_EDGE_ALPHA = [0, 0.18, 0.72, 1, 0.72, 0.18, 0];
const TRAIL_CLASS = {
  primary: { pigment: 0.72, alpha: 0.92 },
  secondary: { pigment: 0.63, alpha: 0.82 },
  faint: { pigment: 0.58, alpha: 0.74 },
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

// Sample the exact piecewise-planar terrain triangle used by buildTerrainArrays
// (a,c,b below the grid diagonal; b,c,d above it). Bilinear interpolation bows
// between those triangles and was the reason a nominally lifted trail could
// disappear into hillsides. `out` also receives the triangle's exact normal.
export function sampleRenderedTerrainTriangle(
  terrainPositions, terrainRes, chunkSize, minX, minZ, x, z, out = {}, fallbackHeight = null,
) {
  const gridN = terrainRes + 1;
  const step = chunkSize / terrainRes;
  const gx = Math.max(0, Math.min(terrainRes - 1, Math.floor((x - minX) / step)));
  const gz = Math.max(0, Math.min(terrainRes - 1, Math.floor((z - minZ) / step)));
  const fx = Math.max(0, Math.min(1, (x - (minX + gx * step)) / step));
  const fz = Math.max(0, Math.min(1, (z - (minZ + gz * step)) / step));
  const sample = (xi, zi) => terrainPositions
    ? terrainPositions[(zi * gridN + xi) * 3 + 1]
    : fallbackHeight(minX + xi * step, minZ + zi * step);
  const h00 = sample(gx, gz), h10 = sample(gx + 1, gz);
  const h01 = sample(gx, gz + 1), h11 = sample(gx + 1, gz + 1);
  let dhdx, dhdz;
  if (fx + fz <= 1) {
    out.y = h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    dhdx = (h10 - h00) / step;
    dhdz = (h01 - h00) / step;
  } else {
    out.y = h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
    dhdx = (h11 - h01) / step;
    dhdz = (h11 - h10) / step;
  }
  const length = Math.hypot(dhdx, 1, dhdz) || 1;
  out.nx = -dhdx / length;
  out.ny = 1 / length;
  out.nz = -dhdz / length;
  return out;
}

export function buildTrailSurface(world, cx, cz, chunkSize, terrainRes = 64, terrainPositions = null) {
  const minX = cx * chunkSize, minZ = cz * chunkSize;
  const maxX = minX + chunkSize, maxZ = minZ + chunkSize;
  const gridStep = chunkSize / terrainRes;
  const renderedSurface = (x, z, out) => sampleRenderedTerrainTriangle(
    terrainPositions, terrainRes, chunkSize, minX, minZ, x, z, out,
    (wx, wz) => world.height(wx, wz),
  );
  const trails = [];
  trailsAround(world, minX + chunkSize / 2, minZ + chunkSize / 2,
    world.seed, chunkSize * 0.78, trails);
  if (!trails.length) return null;

  const positions = [], normals = [], colors = [], indices = [];
  const ground = [0, 0, 0];
  const centreSurface = {}, vertexSurface = {}, startSurface = {}, endSurface = {}, middleSurface = {};
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
      const sx = x0 + (x1 - x0) * ta, sz = z0 + (z1 - z0) * ta;
      const ex = x0 + (x1 - x0) * tb, ez = z0 + (z1 - z0) * tb;
      const mx = (sx + ex) * 0.5, mz = (sz + ez) * 0.5;
      renderedSurface(sx, sz, startSurface);
      renderedSurface(ex, ez, endSurface);
      renderedSurface(mx, mz, middleSurface);
      const grade = visibleLength > 0.01
        ? Math.abs(endSurface.y - startSurface.y) / visibleLength : 0;
      const bend = Math.abs(middleSurface.y - (startSurface.y + endSurface.y) * 0.5);
      let spacing = Math.max(1.15, Math.min(TRAIL_SAMPLE_SPACING, gridStep * 0.9));
      if (grade > 0.10 || bend > 0.18) spacing *= 0.68;
      else if (grade > 0.055 || bend > 0.08) spacing *= 0.82;
      const rows = Math.max(1, Math.ceil(visibleLength / Math.max(0.78, spacing)));

      for (let row = 0; row <= rows; row++) {
        const t = ta + (tb - ta) * (row / rows);
        const arc = s.arc[i] + t * segLength;
        const widthNoise = Math.sin(arc * 0.047 + phase) * 0.075
          + Math.sin(arc * 0.121 - phase * 0.71) * 0.035;
        const centreWander = edge.width * 0.045 * Math.sin(arc * 0.061 + phase * 1.73);
        const cxp = x0 + (x1 - x0) * t + px * centreWander;
        const czp = z0 + (z1 - z0) * t + pz * centreWander;
        let approachWear = 0;
        for (const crossing of edge.fords || []) {
          const fx = crossing.centerX ?? crossing.x, fz = crossing.centerZ ?? crossing.z;
          const fd = Math.hypot(cxp - fx, czp - fz);
          approachWear = Math.max(approachWear, 1 - smoothstep(7, 30, fd));
        }
        const width = edge.width * (1 + widthNoise) * (1 + approachWear * 0.28);

        renderedSurface(cxp, czp, centreSurface);
        const h = centreSurface.y;
        const nx = centreSurface.nx, ny = centreSurface.ny, nz = centreSurface.nz;
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
        if (edge.cliffPath) {
          // Salt-grey mineral tread makes the narrow contour route legible on
          // turf and rock without turning it into a built promenade.
          const chalk = edge.coastType === 'chalk';
          tr = chalk ? 0.64 : 0.39;
          tg = chalk ? 0.63 : 0.40;
          tbCol = chalk ? 0.57 : 0.38;
          pigment = Math.max(pigment, style.pigment * 0.72);
        }
        // Keep the tread separated from its immediate terrain in luminance,
        // rather than relying on one universal brown that disappears in dark
        // forest or pale grassland. Hue remains soil/mineral; only value moves.
        const groundLuma = ground[0] * 0.299 + ground[1] * 0.587 + ground[2] * 0.114;
        const trailLuma = tr * 0.299 + tg * 0.587 + tbCol * 0.114;
        const targetLuma = groundLuma < 0.29
          ? Math.min(0.48, groundLuma + 0.075)
          : Math.max(0.16, groundLuma - 0.105);
        const contrastScale = Math.max(0.72, Math.min(1.38, targetLuma / Math.max(0.05, trailLuma)));
        tr *= contrastScale; tg *= contrastScale; tbCol *= contrastScale;
        pigment *= 1 + approachWear * 0.10;
        tr *= 1 - approachWear * 0.10;
        tg *= 1 - approachWear * 0.13;
        tbCol *= 1 - approachWear * 0.12;
        const rowDry = h > WATER_LEVEL + 0.18 && !world.riverAt(cxp, czp).wet;
        const fleck = 1 + 0.035 * Math.sin(arc * 0.39 + phase * 4.1);

        for (let col = 0; col < TRAIL_ACROSS.length; col++) {
          const lateral = TRAIL_ACROSS[col] * width;
          const x = cxp + px * lateral, z = czp + pz * lateral;
          renderedSurface(x, z, vertexSurface);
          // Vertical lift scaled by normal.y produces a constant ~2cm normal
          // separation without shifting the trail sideways on steep terrain.
          const lift = 0.020 / Math.max(0.35, vertexSurface.ny);
          positions.push(x, vertexSurface.y + lift, z);
          normals.push(vertexSurface.nx, vertexSurface.ny, vertexSurface.nz);
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

// --- trail dressing helpers -------------------------------------------------

function trailHash01(id, salt = 0) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function trailFrameAtArc(edge, arc, out = {}) {
  const s = edge.segments;
  const d = Math.max(0, Math.min(edge.arcLength, arc));
  let i = 0;
  while (i < s.count - 1 && s.arc[i + 1] < d) i++;
  const sl = s.len[i] || 1;
  const t = Math.max(0, Math.min(1, (d - s.arc[i]) / sl));
  out.x = s.ax[i] + s.dx[i] * t; out.z = s.az[i] + s.dz[i] * t;
  out.tangentX = s.dx[i] / sl; out.tangentZ = s.dz[i] / sl;
  out.perpX = -out.tangentZ; out.perpZ = out.tangentX;
  out.arc = d; out.segment = i;
  return out;
}

function trailFrameNear(edge, x, z, out = {}) {
  const s = edge.segments;
  let best = Infinity, bestI = 0, bestT = 0;
  for (let i = 0; i < s.count; i++) {
    let t = ((x - s.ax[i]) * s.dx[i] + (z - s.az[i]) * s.dz[i]) * s.invLen2[i];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s.ax[i] + s.dx[i] * t, qz = s.az[i] + s.dz[i] * t;
    const d2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (d2 < best) { best = d2; bestI = i; bestT = t; }
  }
  const sl = s.len[bestI] || 1;
  out.x = s.ax[bestI] + s.dx[bestI] * bestT;
  out.z = s.az[bestI] + s.dz[bestI] * bestT;
  out.tangentX = s.dx[bestI] / sl; out.tangentZ = s.dz[bestI] / sl;
  out.perpX = -out.tangentZ; out.perpZ = out.tangentX;
  out.arc = s.arc[bestI] + bestT * sl; out.segment = bestI;
  return out;
}

function yawForLocalX(tx, tz) { return Math.atan2(-tz, tx); }

export function chunkTouchesCoast(world, cx, cz, chunkSize) {
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  for (let iz = 0; iz < 3; iz++) {
    for (let ix = 0; ix < 3; ix++) {
      const x = x0 + (ix / 2) * chunkSize;
      const z = z0 + (iz / 2) * chunkSize;
      const b = world.biomeAt(x, z);
      if (b.id === 'beach' || b.id === 'ocean' || b.h < 0.18) return true;
    }
  }
  return false;
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
  const coastalChunk = opts.coastal ?? chunkTouchesCoast(world, cx, cz, chunkSize);
  const consolidatedCoastTypes = new Set(['rock', 'boulder', 'pebble', 'tidepool']);
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
  const coastPebbleVariant = coastalVariantForChunk('pebble', cx, cz);
  const coastTidepoolVariant = coastalVariantForChunk('tidepool', cx, cz);
  const trailEco = {};
  const trailRecords = [];
  const push = (type, v, color) => {
    if (!impostor && coastalChunk && consolidatedCoastTypes.has(type)) {
      v = coastalVariantForChunk(type, cx, cz);
    }
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
  majorLandmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 40, lmList, true);

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
    const eco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
    const trailTree = !eco || eco.zone === 'none' || eco.zone === 'outer' ? 1 : eco.plantDensity;
    if (rng() > recipe.density * (1 - open * 0.92) * (0.15 + 1.1 * clump) * treeF * trailTree) continue;
    if (b.slope > 0.5 || b.h < 0.6) continue;
    // Salt-tolerant shrubs start above the storm strand, never in the swash.
    // Dunes support more scrub; shingle and exposed headlands stay open.
    if (b.id === 'beach') {
      if (b.h < 1.35) continue;
      const coastalScrub = b.coastType === 'dune' ? 1 : b.coastType === 'shingle' ? 0.35 : 0.55;
      if (rng() > coastalScrub) continue;
    }
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
    if (opts.audit) out.trailRecords = [];
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
    const eco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
    const trailShrub = !eco || eco.zone === 'none' ? 1 : eco.plantDensity;
    const dens = smoothstep(0.18, 0.72, clump) * (1 - open * 0.7) * treeF * trailShrub;
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

  // --- Trail dressing (Phase 5) --------------------------------------------
  // Crossing and marker anchors have canonical IDs and are emitted only by the
  // half-open chunk containing that anchor. The complete prop may cross a chunk
  // edge, but ownership never does, preventing duplicate bridges/cairns.
  const inChunk = (x, z) => x >= x0 && x < x0 + chunkSize && z >= z0 && z < z0 + chunkSize;
  const frame = {}, frame2 = {};
  const markerCandidates = new Map();
  const edgeCues = new Map();
  const cue = (edge, arc) => {
    let list = edgeCues.get(edge.id); if (!list) edgeCues.set(edge.id, list = []);
    list.push(Math.max(0, Math.min(edge.arcLength, arc)));
  };
  const addMarker = (edge, arc, reason, id) => {
    trailFrameAtArc(edge, arc, frame);
    markerCandidates.set(id, {
      id, reason, edge, arc: frame.arc, x: frame.x, z: frame.z,
      tangentX: frame.tangentX, tangentZ: frame.tangentZ,
      perpX: frame.perpX, perpZ: frame.perpZ,
    });
    cue(edge, frame.arc);
  };
  const record = (id, kind, x, z, extra = {}) => {
    const entry = { id, kind, x, z, ...extra };
    trailRecords.push(entry);
    return entry;
  };
  const drySafe = (x, z, maxSlope = 0.44) => {
    const b = world.biomeAt(x, z);
    return b.h > 0.55 && b.slope <= maxSlope && !world.riverAt(x, z).wet ? b : null;
  };

  // Junction inventory from canonical endpoint keys. Because an endpoint inside
  // this chunk's query window causes every incident edge to touch the query,
  // local degree is complete even though the world graph is infinite.
  const junctions = new Map();
  const addEndpoint = (key, edge, x, z, arc) => {
    let j = junctions.get(key);
    if (!j) junctions.set(key, j = { key, x: 0, z: 0, count: 0, edges: new Map() });
    j.x += x; j.z += z; j.count++; j.edges.set(edge.id, { edge, arc });
  };
  for (const edge of trails) {
    addEndpoint(edge.fromKey, edge, edge.curve.startX, edge.curve.startZ, 0);
    addEndpoint(edge.toKey, edge, edge.curve.endX, edge.curve.endZ, edge.arcLength);
  }
  for (const j of junctions.values()) {
    if (j.edges.size < 3) continue;
    const first = [...j.edges.values()].sort((a, b) => a.edge.id.localeCompare(b.edge.id))[0];
    addMarker(first.edge, first.arc < first.edge.arcLength * 0.5 ? 18 : first.edge.arcLength - 18,
      'junction', `junction:${j.key}`);
  }

  for (const edge of trails) {
    if (edge.cliffPath) {
      // Sparse pale cairns punctuate the exposed contour and make the route to
      // a sea cave readable from either direction without fencing the cliff.
      let cliffCue = 0;
      for (let arc = 48; arc < edge.arcLength - 24; arc += 82 + trailHash01(edge.id, 820 + cliffCue++) * 44) {
        addMarker(edge, arc, 'cliff-path', `${edge.id}:cliff:${Math.round(arc)}`);
      }
    }
    const crossings = edge.fords || [];
    for (let ci = 0; ci < crossings.length; ci++) {
      const crossing = crossings[ci];
      const crossingId = `${edge.id}:crossing:${ci}`;
      let cx = crossing.centerX ?? crossing.x, cz = crossing.centerZ ?? crossing.z;
      trailFrameNear(edge, cx, cz, frame);
      let tx = crossing.tangentX || frame.tangentX, tz = crossing.tangentZ || frame.tangentZ;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const px = -tz, pz = tx;

      // Refine the coarse Phase-3 span against the water query along the trail
      // axis. This is also the orientation invariant audited for stepping stones.
      let span = Math.max(1.2, Math.min(24, crossing.span || 2));
      if (world.riverAt(cx, cz).wet) {
        let back = 0, forward = 0;
        for (let d = 0.75; d <= 18; d += 0.75) {
          if (!world.riverAt(cx - tx * d, cz - tz * d).wet) break; back = d;
        }
        for (let d = 0.75; d <= 18; d += 0.75) {
          if (!world.riverAt(cx + tx * d, cz + tz * d).wet) break; forward = d;
        }
        if (back + forward > 1) {
          // Phase-3 metadata stores sampled entry/exit points; re-centre on the
          // refined wet run so symmetric bank/prop placement truly spans it.
          const shift = (forward - back) * 0.5;
          cx += tx * shift; cz += tz * shift;
          span = back + forward;
        }
      }
      const bankA = drySafe(cx - tx * (span * 0.5 + 1.4), cz - tz * (span * 0.5 + 1.4), 0.48);
      const bankB = drySafe(cx + tx * (span * 0.5 + 1.4), cz + tz * (span * 0.5 + 1.4), 0.48);
      const biome = bankA?.id || bankB?.id || world.biomeAt(cx, cz).id;
      const forestChannel = biome === 'forest' || biome === 'taiga' || biome === 'jungle';
      const centerRiver = world.riverAt(cx, cz);
      const waterY = centerRiver.wet ? centerRiver.y : world.height(cx, cz);
      const bankRise = bankA && bankB ? Math.max(bankA.h, bankB.h) - waterY : Infinity;
      const bankStep = bankA && bankB ? Math.abs(bankA.h - bankB.h) : Infinity;
      let kind = 'rejected';
      if (bankA && bankB && crossing.kind !== 'bridge-required' && span <= 14.5
        && bankRise <= 1.25 && bankStep <= 1.0) {
        if (forestChannel && span <= 12.0 && crossing.maxDepth > 0.35 && bankRise <= 0.62) kind = 'log';
        else if (crossing.maxDepth <= 0.85 && span <= 10.0) kind = 'stepping-stones';
        else if (crossing.maxDepth <= 1.65) kind = 'plank-bridge';
      }
      const crossingRecord = inChunk(cx, cz) ? record(crossingId, kind, cx, cz, {
        edgeId: edge.id, span, depth: crossing.maxDepth,
        tangentX: tx, tangentZ: tz,
        ownerChunk: `${Math.floor(cx / chunkSize)},${Math.floor(cz / chunkSize)}`,
      }) : null;
      cue(edge, crossing.arcPosition ?? frame.arc);
      if (kind === 'rejected') {
        addMarker(edge, Math.max(20, (crossing.arcStart ?? frame.arc) - 16),
          'route-blocked', `${crossingId}:blocked`);
        continue;
      }
      if (!inChunk(cx, cz)) continue;

      if (kind === 'stepping-stones') {
        if (crossingRecord) { crossingRecord.waterY = waterY; crossingRecord.surfaceY = waterY + 0.08; }
        const count = Math.max(3, Math.ceil(span / 1.2) + 1);
        for (let k = 0; k < count; k++) {
          const along = -span * 0.5 + span * (k / (count - 1));
          const wobble = (trailHash01(crossingId, k + 17) - 0.5) * 0.32;
          const sx = cx + tx * along + px * wobble, sz = cz + tz * along + pz * wobble;
          const rv = world.riverAt(sx, sz);
          const y = rv.wet ? rv.y + 0.08 : world.height(sx, sz) + 0.03;
          const sc = 0.45 + trailHash01(crossingId, k + 61) * 0.20;
          composeMat4(m, sx, y, sz, 0, trailHash01(crossingId, k + 91) * Math.PI * 2, 0,
            sc, 0.16 + sc * 0.08, sc * (0.78 + trailHash01(crossingId, k + 4) * 0.22));
          push('boulder', (trailHash01(crossingId, k + 3) * VARIANT_COUNTS.boulder) | 0,
            rockTint(biome, rng, col));
          record(`${crossingId}:stone:${k}`, 'stepping-stone', sx, sz, {
            edgeId: edge.id, surfaceY: y, waterY: rv.wet ? rv.y : world.height(sx, sz),
            tangentX: tx, tangentZ: tz, sequence: k,
          });
        }
      } else if (kind === 'log') {
        if (crossingRecord) { crossingRecord.waterY = waterY; crossingRecord.surfaceY = waterY + 0.20; }
        const scaleX = Math.max(1.0, (span + 1.8) / 2.7);
        composeMat4(m, cx, waterY + 0.20, cz, 0, yawForLocalX(tx, tz), 0,
          scaleX, 0.82, 0.82);
        push('fallenLog', (trailHash01(crossingId, 7) * VARIANT_COUNTS.fallenLog) | 0, null);
      } else {
        const deckY = Math.max(waterY + 0.32, bankA.h + 0.08, bankB.h + 0.08);
        if (crossingRecord) { crossingRecord.waterY = waterY; crossingRecord.surfaceY = deckY; }
        const bridgeYaw = yawForLocalX(tx, tz);
        // Two longitudinal bearers.
        for (const side of [-0.62, 0.62]) {
          composeMat4(m, cx + px * side, deckY - 0.11, cz + pz * side,
            0, bridgeYaw, 0, (span + 1.8) / 1.8, 0.72, 0.52);
          push('plank', (trailHash01(crossingId, side > 0 ? 41 : 42) * VARIANT_COUNTS.plank) | 0, null);
        }
        // Short crosswise deck boards, explicitly perpendicular to the route.
        const boards = Math.max(4, Math.ceil((span + 1.0) / 0.52));
        for (let k = 0; k < boards; k++) {
          const along = -(span + 0.7) * 0.5 + (span + 0.7) * (k / (boards - 1));
          composeMat4(m, cx + tx * along, deckY, cz + tz * along,
            0, yawForLocalX(px, pz), 0, 0.92, 0.90, 0.95);
          push('plank', (trailHash01(crossingId, k + 80) * VARIANT_COUNTS.plank) | 0, null);
        }
      }

      // Muddy widened approaches and a short asymmetric bypass braid. All
      // patches are dry/slope-gated and remain owned by the crossing anchor.
      for (const dir of [-1, 1]) {
        const side = trailHash01(crossingId, dir > 0 ? 201 : 202) < 0.5 ? -1 : 1;
        for (let k = 0; k < 3; k++) {
          const arc = (crossing.arcPosition ?? frame.arc) + dir * (span * 0.5 + 3 + k * 2.4);
          trailFrameAtArc(edge, arc, frame2);
          const offset = side * edge.width * (0.45 + k * 0.18);
          const mx = frame2.x + frame2.perpX * offset, mz = frame2.z + frame2.perpZ * offset;
          const mb = drySafe(mx, mz, 0.34); if (!mb) continue;
          composeMat4(m, mx, groundY(mx, mz) + 0.018, mz, 0,
            yawForLocalX(frame2.tangentX, frame2.tangentZ), 0,
            1.25 + k * 0.18, 0.72, 0.82);
          push('trailMud', (trailHash01(crossingId, 230 + k + (dir > 0 ? 10 : 0)) * VARIANT_COUNTS.trailMud) | 0, null);
          record(`${crossingId}:mud:${dir}:${k}`, 'mud-braid', mx, mz, { edgeId: edge.id });
        }
      }
      addMarker(edge, Math.min(edge.arcLength - 20, (crossing.arcEnd ?? frame.arc) + 16),
        'trail-resumption', `${crossingId}:resume`);
    }

    // Consolidated switchback cues: sharp direction changes separated by 70 m.
    let lastSwitch = -1e9;
    const s = edge.segments;
    for (let i = 1; i < s.count; i++) {
      const al = s.len[i - 1] || 1, bl = s.len[i] || 1;
      const dot = (s.dx[i - 1] / al) * (s.dx[i] / bl) + (s.dz[i - 1] / al) * (s.dz[i] / bl);
      const arc = s.arc[i];
      if (dot < 0.55 && arc - lastSwitch > 70 && arc > 45 && edge.arcLength - arc > 45) {
        addMarker(edge, arc - 22, 'switchback', `${edge.id}:switchback:${Math.round(arc)}`);
        lastSwitch = arc;
      }
    }

    // Alpine/scenic cues are conditional samples, not a fixed metronome.
    const sampleOffset = 95 + trailHash01(edge.id, 301) * 95;
    for (let arc = sampleOffset; arc < edge.arcLength - 80; arc += 210 + trailHash01(edge.id, Math.round(arc)) * 95) {
      trailFrameAtArc(edge, arc, frame);
      const b = world.biomeAt(frame.x, frame.z);
      if ((b.id === 'tundra' || b.id === 'snow' || b.h > 125) && b.slope < 0.30
        && trailHash01(edge.id, Math.round(arc) + 310) < 0.48) {
        addMarker(edge, arc, 'alpine', `${edge.id}:alpine:${Math.round(arc)}`);
        continue;
      }
      if (b.h > 65 && b.slope < 0.18 && world.openFactor(frame.x, frame.z) > 0.62) {
        let ring = 0;
        for (let q = 0; q < 4; q++) {
          const a = q * Math.PI * 0.5;
          ring += world.height(frame.x + Math.cos(a) * 55, frame.z + Math.sin(a) * 55);
        }
        if (b.h - ring * 0.25 > 10 && trailHash01(edge.id, Math.round(arc) + 330) < 0.55) {
          addMarker(edge, arc, 'overlook', `${edge.id}:overlook:${Math.round(arc)}`);
        }
      }
    }

    // Forest-edge evidence: roots, leaf buildup and rare saplings in the verge.
    let vi = 0;
    for (let arc = 35 + trailHash01(edge.id, 401) * 45; arc < edge.arcLength - 30; arc += 72 + trailHash01(edge.id, 420 + vi++) * 46) {
      trailFrameAtArc(edge, arc, frame);
      const side = trailHash01(edge.id, 450 + vi) < 0.5 ? -1 : 1;
      const offset = side * (edge.width + 1.1 + trailHash01(edge.id, 470 + vi) * 2.0);
      const vx = frame.x + frame.perpX * offset, vz = frame.z + frame.perpZ * offset;
      if (!inChunk(vx, vz)) continue;
      const b = drySafe(vx, vz, 0.42);
      if (!b || !(b.id === 'forest' || b.id === 'taiga' || b.id === 'jungle')) continue;
      const roll = trailHash01(edge.id, 500 + vi);
      if (roll < 0.38) {
        composeMat4(m, vx, groundY(vx, vz) + 0.015, vz, 0,
          yawForLocalX(frame.perpX * -side, frame.perpZ * -side), 0, 1.0, 0.72, 0.9);
        push('trailRoot', (trailHash01(edge.id, 520 + vi) * VARIANT_COUNTS.trailRoot) | 0, null);
        record(`${edge.id}:verge:${vi}`, 'exposed-root', vx, vz, { edgeId: edge.id });
      } else if (roll < 0.82) {
        composeMat4(m, vx, groundY(vx, vz) + 0.01, vz, 0,
          trailHash01(edge.id, 540 + vi) * Math.PI * 2, 0, 1.0, 0.75, 1.0);
        push('litter', (trailHash01(edge.id, 550 + vi) * VARIANT_COUNTS.litter) | 0, null);
        record(`${edge.id}:verge:${vi}`, 'leaf-buildup', vx, vz, { edgeId: edge.id });
      } else if (edge.routeClass !== 'faint') {
        const sc = 0.30 + trailHash01(edge.id, 560 + vi) * 0.18;
        composeMat4(m, vx, groundY(vx, vz) - 0.08, vz, 0,
          trailHash01(edge.id, 570 + vi) * Math.PI * 2, 0, sc, sc * 1.15, sc);
        push(b.id === 'taiga' ? 'conifer' : 'broadleaf', 0, null);
        record(`${edge.id}:verge:${vi}`, 'sapling', vx, vz, { edgeId: edge.id });
      }
    }
  }

  // Fill only genuinely long cue-less gaps; spacing varies by edge and gap.
  for (const edge of trails) {
    const cues = [0, ...(edgeCues.get(edge.id) || []), edge.arcLength].sort((a, b) => a - b);
    for (let i = 0; i < cues.length - 1; i++) {
      const gap = cues[i + 1] - cues[i];
      if (gap < 390) continue;
      const arc = cues[i] + gap * (0.43 + trailHash01(edge.id, 600 + i) * 0.14);
      addMarker(edge, arc, 'long-uncued', `${edge.id}:long-gap:${i}`);
    }
  }

  // Emit contextual markers with biome variants and wilderness restraint.
  for (const marker of markerCandidates.values()) {
    const edge = marker.edge;
    const classChance = edge.routeClass === 'primary' ? 1 : edge.routeClass === 'secondary' ? 0.58 : 0.16;
    const baseChance = marker.reason === 'junction' ? 1
      : marker.reason === 'route-blocked' ? 0.92
        : marker.reason === 'switchback' || marker.reason === 'trail-resumption' ? 0.78
          : marker.reason === 'alpine' ? 0.86 : marker.reason === 'overlook' ? 0.62 : 0.48;
    if (trailHash01(marker.id, 701) > classChance * baseChance) continue;
    const side = trailHash01(marker.id, 702) < 0.5 ? -1 : 1;
    const mx = marker.x + marker.perpX * side * (edge.width + 1.05);
    const mz = marker.z + marker.perpZ * side * (edge.width + 1.05);
    if (!inChunk(mx, mz)) continue;
    const b = drySafe(mx, mz, 0.40); if (!b) continue;
    // Especially wild jungle/desert reaches may deliberately remain unmarked.
    if ((b.id === 'jungle' || b.id === 'desert') && marker.reason !== 'junction'
      && trailHash01(marker.id, 703) > 0.42) continue;

    let type = marker.reason === 'cliff-path' ? 'pale-stone' : 'cairn';
    if (marker.reason !== 'cliff-path' && (b.id === 'forest' || b.id === 'taiga' || b.id === 'jungle')) {
      type = trailHash01(marker.id, 704) < 0.62 ? 'branch-stack' : 'post';
    } else if (marker.reason !== 'cliff-path' && !(b.id === 'tundra' || b.id === 'snow' || b.h > 100)) {
      type = trailHash01(marker.id, 705) < 0.48 ? 'post' : 'pale-stone';
    }
    if (type === 'branch-stack') {
      composeMat4(m, mx, groundY(mx, mz) + 0.02, mz, 0,
        trailHash01(marker.id, 706) * Math.PI * 2, 0, 1, 1, 1);
      push('branchStack', (trailHash01(marker.id, 707) * VARIANT_COUNTS.branchStack) | 0, null);
    } else if (type === 'post') {
      composeMat4(m, mx, groundY(mx, mz) - 0.08, mz, 0,
        trailHash01(marker.id, 708) * Math.PI * 2, 0, 1, 1, 1);
      push('trailPost', (trailHash01(marker.id, 709) * VARIANT_COUNTS.trailPost) | 0, null);
    } else {
      let yy = groundY(mx, mz) - 0.08;
      const nStack = 3 + (trailHash01(marker.id, 710) * 2.99 | 0);
      for (let sn = 0; sn < nStack; sn++) {
        const sc = 0.40 - sn * 0.062;
        composeMat4(m, mx, yy + sc * 0.34, mz, 0,
          trailHash01(marker.id, 720 + sn) * Math.PI * 2, 0, sc, sc * 0.82, sc);
        if (type === 'pale-stone') { col[0] = 1.10; col[1] = 1.08; col[2] = 0.94; }
        else rockTint(b.id, rng, col);
        push('pebble', (trailHash01(marker.id, 730 + sn) * VARIANT_COUNTS.pebble) | 0, col);
        yy += sc * 0.48;
      }
    }
    record(marker.id, `marker-${type}`, mx, mz, { edgeId: edge.id, reason: marker.reason, arc: marker.arc });
  }

  // Geological clusters replace the old uniform sprinkle. Every group has a
  // dominant mass, a couple of secondary stones and small fragments; canonical
  // world cells make groups cross chunk boundaries without duplication.
  for (const placement of rockPlacementsForChunk(world, cx, cz, chunkSize)) {
    const { x, z } = placement;
    const b = world.biomeAt(x, z);
    if (!b || b.h < 0.5) continue;
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue;
    const river = world.riverAt(x, z);
    if (river.wet) continue; // the authored river pass below owns channel stone
    const ecology = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
    if (ecology && (ecology.zone === 'core'
      || (ecology.zone === 'inner' && placement.scale > 0.65))) continue;

    // Seat larger footprints from several rendered-height samples, then align
    // most (not all) of the local up-axis to the terrain normal. The remaining
    // imperfection keeps clusters geological rather than mechanically pasted.
    const footprint = Math.max(0.65, Math.min(3.2, placement.scale * 0.48));
    const centre = groundY(x, z);
    const left = groundY(x - footprint, z), right = groundY(x + footprint, z);
    const back = groundY(x, z - footprint), front = groundY(x, z + footprint);
    const seatY = (centre * 2 + left + right + back + front) / 6;
    const nxRaw = left - right, nzRaw = back - front;
    const normalLength = Math.hypot(nxRaw, footprint * 2, nzRaw) || 1;
    const nx = nxRaw / normalLength, nz = nzRaw / normalLength;
    const ex = Math.max(-0.46, Math.min(0.46, Math.asin(nz) * 0.72 + (rng() - 0.5) * 0.10));
    const ez = Math.max(-0.46, Math.min(0.46, -Math.asin(nx) * 0.72 + (rng() - 0.5) * 0.10));
    composeMat4(
      m,
      x,
      seatY - placement.scale * placement.burial,
      z,
      ex,
      placement.yaw,
      ez,
      placement.scaleX,
      placement.scaleY,
      placement.scaleZ,
    );
    push(placement.type, placement.variant, rockTint(b.id, rng, col));
  }

  // Beach pebbles: sparse on dunes, dense on shingle, pale below chalk. These
  // compact clusters complement the broader clutter pass without turning the
  // whole strand into an evenly distributed gravel field.
  for (let i = 0; i < 26; i++) {
    const x = x0 + rng() * chunkSize;
    const z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    if (b.id !== 'beach' || b.slope > 0.3) continue;
    const coastType = b.coastType;
    const count = coastType === 'shingle' ? 12 + (rng() * 15 | 0)
      : coastType === 'rocky' ? 7 + (rng() * 10 | 0)
      : 4 + (rng() * 7 | 0);
    const retainedCount = Math.ceil(count * 0.68);
    for (let k = 0; k < count; k++) {
      const px = x + (rng() - 0.5) * 4;
      const pz = z + (rng() - 0.5) * 4;
      const ph = world.height(px, pz);
      if (ph < 0.3) continue;
      rng(); // preserve the deterministic stream consumed by the old variant pick
      const v = coastPebbleVariant;
      const s = 0.05 + rng() * 0.16;
      const ex = (rng() - 0.5) * 0.6, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.6;
      const sx = s * (0.8 + rng() * 0.5), sz = s * (0.8 + rng() * 0.5);
      composeMat4(m, px, ph - s * 0.3, pz, ex, ey, ez, sx, s, sz);
      const tint = rockTint(coastType === 'chalk' ? 'chalk' : 'beach', rng, col);
      // Consume the legacy deterministic stream for every candidate so talus,
      // sea stacks and tide pools retain their established positions. Only the
      // emitted coastal payload is thinned.
      if (i < 16 && k < retainedCount) push('pebble', v, tint);
    }
  }

  // Talus at exposed headlands and chalk-foot coves. Require nearby sea so
  // inland low hills do not inherit coastal rubble merely from sharing the
  // same geological province.
  for (let i = 0; i < 46; i++) {
    const x = x0 + rng() * chunkSize, z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    const coastType = b.coastType;
    if ((coastType !== 'chalk' && coastType !== 'rocky') || b.h < 0.25 || b.h > 18) continue;
    const nearSea = world.height(x + 14, z) < 0 || world.height(x - 14, z) < 0
      || world.height(x, z + 14) < 0 || world.height(x, z - 14) < 0;
    if (!nearSea || rng() > (coastType === 'chalk' ? 0.42 : 0.30)) continue;
    const type = rng() < 0.42 ? 'boulder' : 'rock';
    const v = (rng() * VARIANT_COUNTS[type]) | 0;
    const s = type === 'boulder' ? 0.75 + rng() * 2.3 : 0.35 + rng() * 1.05;
    composeMat4(m, x, b.h - s * (0.22 + rng() * 0.18), z,
      (rng() - 0.5) * 0.45, rng() * Math.PI * 2, (rng() - 0.5) * 0.45,
      s * (0.72 + rng() * 0.58), s, s * (0.72 + rng() * 0.58));
    push(type, v, rockTint(coastType === 'chalk' ? 'chalk' : 'rock', rng, col));
  }

  // Sea stacks rise from shallow wave-cut shelves. They are deliberately rare
  // and limited to rocky/chalk provinces, where an offshore silhouette reads
  // as erosion rather than a random boulder dropped into open water.
  for (let i = 0; i < 34; i++) {
    const x = x0 + rng() * chunkSize, z = z0 + rng() * chunkSize;
    const floor = world.height(x, z);
    const coastType = world.coastTypeAt(x, z);
    if ((coastType !== 'chalk' && coastType !== 'rocky') || floor > -0.35 || floor < -7.5) continue;
    const nearLand = world.height(x + 24, z) > 1.2 || world.height(x - 24, z) > 1.2
      || world.height(x, z + 24) > 1.2 || world.height(x, z - 24) > 1.2;
    if (!nearLand || rng() > 0.095) continue;
    const v = (rng() * VARIANT_COUNTS.boulder) | 0;
    const width = 2.1 + rng() * 3.6;
    const height = Math.max(4.8, -floor + 3.0 + rng() * 8.5);
    composeMat4(m, x, floor - 0.45, z,
      (rng() - 0.5) * 0.18, rng() * Math.PI * 2, (rng() - 0.5) * 0.18,
      width * (0.72 + rng() * 0.45), height, width * (0.72 + rng() * 0.45));
    push('boulder', v, rockTint(coastType === 'chalk' ? 'chalk' : 'rock', rng, col));
  }

  // Tide pools occupy shallow depressions on exposed rock shelves just above
  // mean water. Several height probes require real nearby sea and a locally
  // level seat, preventing glossy discs from appearing on inland slopes.
  for (let i = 0; i < 38; i++) {
    const x = x0 + rng() * chunkSize, z = z0 + rng() * chunkSize;
    const b = world.biomeAt(x, z);
    if ((b.coastType !== 'rocky' && b.coastType !== 'chalk')
      || b.h < 0.28 || b.h > 1.65 || b.slope > 0.20) continue;
    const seaNear = world.height(x + 10, z) < 0.18 || world.height(x - 10, z) < 0.18
      || world.height(x, z + 10) < 0.18 || world.height(x, z - 10) < 0.18;
    if (!seaNear || rng() > (b.coastType === 'rocky' ? 0.36 : 0.25)) continue;
    rng(); // preserve downstream placement while consolidating the local bucket
    const v = coastTidepoolVariant;
    const sx = 1.1 + rng() * 2.4, sz = sx * (0.58 + rng() * 0.46);
    composeMat4(m, x, b.h + 0.018, z, 0, rng() * Math.PI * 2, 0, sx, 1, sz);
    push('tidepool', v, null);
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
  if (opts.audit) out.trailRecords = trailRecords;
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
  const coastalChunk = opts.coastal ?? chunkTouchesCoast(world, cx, cz, chunkSize);
  const trails = [];
  trailsAround(world, x0 + chunkSize / 2, z0 + chunkSize / 2, world.seed, chunkSize, trails);
  const trailEco = {};
  const coastalVariants = new Map();
  const coastalLimit = Math.max(24, Math.round(132 * (opts.clutterDensityScale || 1)));
  let coastalAccepted = 0;
  const push = (type, v) => {
    const key = type + '/' + v;
    let b = map.get(key);
    if (!b) map.set(key, b = { type, variant: v, mats: [] });
    for (let i = 0; i < 16; i++) b.mats.push(m[i]);
  };

  const lmList = [];
  landmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 32, lmList);
  majorLandmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 40, lmList, true);

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
    const meadow = b.id === 'beach' ? 0
      : (1 - smoothstep(38, 72, b.h)) * (1 - smoothstep(0.18, 0.33, b.slope));
    const eco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
    const trailFactor = !eco || eco.zone === 'none' ? 1 : eco.plantDensity;
    if (rng() > recipe.density * lush * (1 - 0.7 * meadow) * trailFactor) continue;

    // Beaches use elevation and geological type to organize clutter into a
    // real strand line: kelp low, driftwood around the storm line, gravel on
    // shingle shores. Other biomes keep their ordinary weighted recipe.
    let pick = rng(), type = recipe.mix[0][0];
    if (b.id === 'beach') {
      const coastType = b.coastType;
      const strandY = 1.02 + world.coastDetail.noise(x * 0.018 + 41, z * 0.018) * 0.24;
      const lowStrand = b.h < strandY + 0.28;
      if (coastType === 'shingle' && pick < 0.72) type = 'pebble';
      else if (lowStrand && pick < 0.55) type = 'seaweed';
      else if (pick < (lowStrand ? 0.76 : 0.52)) type = 'driftwood';
      else if (pick < 0.94) type = 'pebble';
      else type = 'snag';
    } else {
      for (const [t, w] of recipe.mix) { pick -= w; if (pick <= 0) { type = t; break; } }
    }
    const sampledVariant = (rng() * VARIANT_COUNTS[type]) | 0;
    let v = sampledVariant;
    if (b.id === 'beach') {
      if (coastalAccepted >= coastalLimit) continue;
      coastalAccepted++;
    }
    if (coastalChunk && ['pebble', 'driftwood', 'seaweed', 'snag'].includes(type)) {
      if (!coastalVariants.has(type)) coastalVariants.set(type, coastalVariantForChunk(type, cx, cz));
      v = coastalVariants.get(type);
    }

    let s = 0.85 + rng() * 0.4;
    if (b.id === 'beach') {
      if (type === 'pebble') s = 0.12 + rng() * 0.28;
      else if (type === 'seaweed') s = 0.58 + rng() * 0.82;
      else if (type === 'driftwood') s = 0.92 + rng() * 0.58;
    }
    const ey = rng() * Math.PI * 2;
    // logs and litter sit flat; others stand upright with a tiny lean
    const flat = (type === 'fallenLog' || type === 'driftwood' || type === 'seaweed'
      || type === 'litter' || type === 'pebble');
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
  const trailEco = {};
  const lmList = [];
  landmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 32, lmList);
  majorLandmarksAround(world, x0 + chunkSize * 0.5, z0 + chunkSize * 0.5, world.seed, chunkSize * 0.5 + 40, lmList, true);

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
    if (b.id === 'beach' && b.h < 1.18) continue; // no flowers rooted in the active swash
    const rv = world.riverAt(x, z);
    if (rv.wet && rv.depth > 0.05) continue;
    if (lmList.length && inLandmarkHalo(lmList, x, z)) continue;
    // forest species thicken under the groves, thin in the open
    const clump = world.groveFactor(x, z);
    let lush = (b.id === 'forest' || b.id === 'jungle' || b.id === 'taiga') ? (0.45 + clump) : 1;
    if (b.id === 'beach') {
      const coastType = b.coastType;
      lush *= coastType === 'dune' ? 1.35 : coastType === 'shingle' ? 0.55 : 0.72;
    }
    const eco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
    const trailFactor = !eco || eco.zone === 'none' ? 1 : eco.plantDensity;
    if (rng() > recipe.density * lush * trailFactor) continue;

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
    const eco = trails.length ? trailEcologyAt(trails, cxp, czp, trailEco) : null;
    const trailFactor = !eco || eco.zone === 'none' ? 1 : eco.plantDensity;
    if (rng() > zone * meadow * trailFactor) continue;
    if (lmList.length && inLandmarkHalo(lmList, cxp, czp)) continue;

    const cellA = FLOWER_CLUSTER_CELLS[(rng() * FLOWER_CLUSTER_CELLS.length) | 0];
    const cellB = rng() < 0.45 ? FLOWER_CLUSTER_CELLS[(rng() * FLOWER_CLUSTER_CELLS.length) | 0] : cellA;
    const n = 10 + ((rng() * 17) | 0);
    const rad = 2.4 + rng() * 3.8;
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * rad;
      const px = cxp + Math.cos(a) * d, pz = czp + Math.sin(a) * d;
      if (trails.length) {
        const pe = trailEcologyAt(trails, px, pz, trailEco);
        if (pe.zone === 'core' && pe.routeClass !== 'faint') continue;
      }
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
  const trailEco = {};
  const mats = [];
  const cols = [];
  const m = new Float32Array(16);
  const grassGround = [0, 0, 0];

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
    const centreEco = trails.length ? trailEcologyAt(trails, ccx, ccz, trailEco) : null;
    const trailDensity = !centreEco || centreEco.zone === 'none' ? 1 : centreEco.grassDensity;
    const d = base * (0.85 + world.openFactor(ccx, ccz) * 0.5) * foothill * trailDensity;
    if (rng() > d) continue;
    const rv = world.riverAt(ccx, ccz);
    if (rv.wet && rv.depth > 0.2) continue; // no grass submerged in the channel
    // constant areal density → big patches are genuinely full, small ones tidy
    const n = Math.max(8, Math.round(area * GRASS_AREA_DENSITY * (0.6 + 0.6 * d)));
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const rr = rad * Math.sqrt(rng());        // uniform fill toward the centre
      const x = ccx + Math.cos(a) * rr, z = ccz + Math.sin(a) * rr;
      const bladeEco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
      if (bladeEco && bladeEco.zone !== 'none') {
        if (bladeEco.grassDensity <= 0 || rng() > bladeEco.grassDensity) continue;
      }
      const h = world.height(x, z);             // one cheap sample to seat the blade
      if (h < WATER_LEVEL + 0.4) continue;
      const s = 0.55 + rng() * 0.75;
      const ex = (rng() - 0.5) * 0.25, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.25;
      const trailHeight = bladeEco && bladeEco.zone !== 'none' ? bladeEco.grassHeight : 1;
      composeMat4(m, x, h - 0.04, z, ex, ey, ez, s, s * (0.7 + rng() * 0.6) * trailHeight, s);
      for (let j = 0; j < 16; j++) mats.push(m[j]);
      // Ground detail varies within a patch, so sample at the individual blade
      // rather than tinting the entire stand from its centre.
      groundColor(world, x, z, h, b.slope, b.t, b.m, grassGround);
      cols.push(grassGround[0], grassGround[1], grassGround[2]);
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
      const bankEco = trails.length ? trailEcologyAt(trails, x, z, trailEco) : null;
      if (bankEco && bankEco.zone === 'core' && bankEco.routeClass !== 'faint') continue;
      const r0 = world.riverAt(x, z);
      if (r0.wet || r0.floor < WATER_LEVEL + 0.3) continue;
      if (!(world.riverAt(x + 3, z).wet || world.riverAt(x - 3, z).wet ||
            world.riverAt(x, z + 3).wet || world.riverAt(x, z - 3).wet)) continue;
      const b = world.biomeAt(x, z);
      if (b.slope > 0.5) continue;
      const s = 0.7 + rng() * 0.8;
      const ex = (rng() - 0.5) * 0.2, ey = rng() * Math.PI * 2, ez = (rng() - 0.5) * 0.2;
      const trailHeight = bankEco && bankEco.zone !== 'none' ? bankEco.grassHeight : 1;
      composeMat4(m, x, r0.floor - 0.04, z, ex, ey, ez, s, s * (0.85 + rng() * 0.6) * trailHeight, s);
      for (let j = 0; j < 16; j++) mats.push(m[j]);
      groundColor(world, x, z, r0.floor, b.slope, b.t, b.m, grassGround);
      cols.push(grassGround[0], grassGround[1], grassGround[2]);
    }
  }

  if (mats.length === 0) return null;
  return { matrices: new Float32Array(mats), colors: new Float32Array(cols) };
}
