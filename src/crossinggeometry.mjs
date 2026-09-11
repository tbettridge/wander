// Versioned construction recipe for existing trail crossings. Keep the exact
// board rhythm, variant selection, support heights and individual footholds.
// Both live scatter and migration manifests consume these same transforms.
import { trailFrameAtArc } from './trails.js';
import { VARIANT_COUNTS } from './vegdata.js';

export const CROSSING_RECIPE_VERSION = 1;

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

function trailHash01(id, salt = 0) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function yawForLocalX(tx, tz) { return Math.atan2(-tz, tx); }

export function buildCrossingRecipe(world, edge, crossing, crossingId, solved) {
  const preserved = world.preservedCrossings?.get(crossingId);
  if (preserved) return preserved.recipe;
  if (!solved) return null;
  world = world.layoutWorld || world;
  const { kind, waterY, span, biome, x: cx, z: cz, tangentX: tx, tangentZ: tz } = solved;
  const px = -tz, pz = tx, frame2 = {}, m = new Float32Array(16);
  const instances = [], records = [], crossingRecord = {};
  const push = (type, variant, tint) => instances.push({ type, variant, tint, matrix: Array.from(m) });
  const record = (id, kind, x, z, extra) => records.push({ id, kind, x, z, ...extra });
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
            'rock');
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
      } else if (kind === 'bridge') {
        // A trestle: a plank deck carried on piers, spanning bank to bank at
        // whatever length the river asks for. The deck runs between the two
        // abutments actually found, not between the water's edges, so it lands
        // on solid ground at both ends.
        const deckLength = solved.deckLength;
        const deckY = solved.surfaceY;
        // As wide as the trail it carries: a narrower deck is a walker
        // following the worn path straight off the side of the bridge.
        const half = solved.halfWidth;
        const boardScale = (half * 2) / 1.8;
        // Laid along the trail's own arc. A straight chord between the banks
        // leaves the path it was built for — measured at 8m of drift on a long
        // span — so the bridge cuts across the route and a walker steps off the
        // side of their own deck.
        const at = (t, out) => trailFrameAtArc(edge, solved.arcStart + deckLength * t, out);
        if (crossingRecord) {
          crossingRecord.waterY = waterY;
          crossingRecord.surfaceY = deckY;
          crossingRecord.deckLength = deckLength;
          crossingRecord.arcStart = solved.arcStart;
          crossingRecord.arcEnd = solved.arcEnd;
          crossingRecord.edgeId = edge.id;
        }
        // Piers roughly every 9m, so a long crossing reads as a repeating
        // structure rather than one impossible beam.
        const bays = Math.max(1, Math.round(deckLength / 9));
        for (let k = 0; k <= bays; k++) {
          at(k / bays, frame2);
          const rv = world.riverAt(frame2.x, frame2.z);
          const bedY = rv.wet ? Math.min(rv.y, world.height(frame2.x, frame2.z))
            : world.height(frame2.x, frame2.z);
          const pierHeight = Math.max(0.4, deckY - bedY);
          // Skip the bents standing on dry land at the very ends; the abutment
          // already carries the deck there.
          if (pierHeight < 0.55 && k > 0 && k < bays) continue;
          const yaw = yawForLocalX(frame2.tangentX, frame2.tangentZ);
          for (const side of [-(half - 0.35), half - 0.35]) {
            composeMat4(m, frame2.x + frame2.perpX * side, bedY + pierHeight * 0.5,
              frame2.z + frame2.perpZ * side, 0, yaw, 0, 0.34, pierHeight, 0.34);
            push('trailPost', (trailHash01(crossingId, k * 7 + (side > 0 ? 3 : 5)) * VARIANT_COUNTS.trailPost) | 0, null);
          }
        }
        // Longitudinal bearers, one per bay so no single plank is stretched the
        // whole way across.
        for (let k = 0; k < bays; k++) {
          const bayLength = deckLength / bays;
          at((k + 0.5) / bays, frame2);
          const yaw = yawForLocalX(frame2.tangentX, frame2.tangentZ);
          for (const side of [-(half - 0.3), half - 0.3]) {
            composeMat4(m, frame2.x + frame2.perpX * side, deckY - 0.11,
              frame2.z + frame2.perpZ * side, 0, yaw, 0, (bayLength + 0.4) / 1.8, 0.72, 0.52);
            push('plank', (trailHash01(crossingId, k * 11 + (side > 0 ? 41 : 42)) * VARIANT_COUNTS.plank) | 0, null);
          }
        }
        // Crosswise deck boards along the whole length.
        const boards = Math.max(4, Math.ceil(deckLength / 0.52));
        for (let k = 0; k < boards; k++) {
          at(k / (boards - 1), frame2);
          composeMat4(m, frame2.x, deckY, frame2.z,
            0, yawForLocalX(frame2.perpX, frame2.perpZ), 0, boardScale, 0.90, 0.95);
          push('plank', (trailHash01(crossingId, k + 80) * VARIANT_COUNTS.plank) | 0, null);
        }
        // Handrail posts, sparse — enough to read as a rail at a distance.
        const rails = Math.max(2, Math.round(deckLength / 3.2));
        for (let k = 0; k <= rails; k++) {
          at(k / rails, frame2);
          const yaw = yawForLocalX(frame2.tangentX, frame2.tangentZ);
          for (const side of [-(half - 0.08), half - 0.08]) {
            composeMat4(m, frame2.x + frame2.perpX * side, deckY + 0.42,
              frame2.z + frame2.perpZ * side, 0, yaw, 0, 0.16, 0.85, 0.16);
            push('trailPost', (trailHash01(crossingId, k * 13 + (side > 0 ? 21 : 23)) * VARIANT_COUNTS.trailPost) | 0, null);
          }
        }
      } else {
        // The plank bridge is a small trestle without the piers, and it is laid
        // exactly the same way: along the trail's arc, between the abutments,
        // at the height the crossing solved. It used to keep its own deck
        // height and its own straight chord centred on the water — so the deck
        // the eye saw and the deck the foot resolved against were two different
        // structures, in two places, at two heights.
        const deckY = solved.surfaceY;
        const deckLength = solved.deckLength;
        const half = solved.halfWidth;
        const boardScale = (half * 2) / 1.8;
        const at = (t, out) => trailFrameAtArc(edge, solved.arcStart + deckLength * t, out);
        if (crossingRecord) {
          crossingRecord.waterY = waterY;
          crossingRecord.surfaceY = deckY;
          crossingRecord.deckLength = deckLength;
          crossingRecord.arcStart = solved.arcStart;
          crossingRecord.arcEnd = solved.arcEnd;
          crossingRecord.edgeId = edge.id;
        }
        // Two longitudinal bearers, split into runs so they follow the curve.
        const runs = Math.max(1, Math.round(deckLength / 4));
        for (let k = 0; k < runs; k++) {
          const runLength = deckLength / runs;
          at((k + 0.5) / runs, frame2);
          const yaw = yawForLocalX(frame2.tangentX, frame2.tangentZ);
          for (const side of [-(half - 0.3), half - 0.3]) {
            composeMat4(m, frame2.x + frame2.perpX * side, deckY - 0.11,
              frame2.z + frame2.perpZ * side, 0, yaw, 0, (runLength + 0.4) / 1.8, 0.72, 0.52);
            push('plank', (trailHash01(crossingId, k * 11 + (side > 0 ? 41 : 42)) * VARIANT_COUNTS.plank) | 0, null);
          }
        }
        // Crosswise deck boards, perpendicular to the route at each point.
        const boards = Math.max(4, Math.ceil(deckLength / 0.52));
        for (let k = 0; k < boards; k++) {
          at(k / (boards - 1), frame2);
          composeMat4(m, frame2.x, deckY, frame2.z,
            0, yawForLocalX(frame2.perpX, frame2.perpZ), 0, boardScale, 0.90, 0.95);
          push('plank', (trailHash01(crossingId, k + 80) * VARIANT_COUNTS.plank) | 0, null);
        }
      }

  return { version: CROSSING_RECIPE_VERSION, instances, records, crossingRecord };
}
