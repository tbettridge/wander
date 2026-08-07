// The worn ground of a village: its square and the streets running out of it.
//
// This is deliberately built the way a TRAIL is built rather than the way the
// old ground treatment was. The old treatment laid opaque rectangles over the
// terrain — one slab for the square, one for every building's plot — which read
// as asphalt because that is what an opaque grey rectangle with a hard edge
// looks like, whatever colour you tint it. A trail instead carries its own
// per-vertex colour AND alpha, fading to nothing at the shoulders, so the tread
// dissolves into whatever the biome grows there.
//
// So: one dirt tone per settlement, used by the square and every street alike
// (they are one connected surface, and a road that changes colour where it
// leaves the square reads as two materials meeting). Alpha carries the edges.
//
// Renderer-independent — Three.js consumes these arrays in the browser and Node
// tests audit them directly.

import { groundColor } from './world.js';

export const SURFACE_LIFT = 0.022;
// Streets are surfaced wider than their carriageway: a village street is the
// road plus the trodden verge either side, and stopping the dirt at the
// carriageway leaves a suspiciously neat green strip up to the houses.
export const STREET_WIDTH_SCALE = 1.6;
// Lateral stations across a street and the alpha at each. Zero on the outside,
// so the dirt ends in a gradient rather than on a cut line.
export const STREET_ACROSS = Object.freeze([-1, -0.78, -0.5, 0, 0.5, 0.78, 1]);
export const STREET_ALPHA = Object.freeze([0, 0.30, 0.82, 1, 0.82, 0.30, 0]);
// The same idea radially for the square: solid across the middle, gone by the
// rim.
export const SQUARE_RING = Object.freeze([0, 0.45, 0.70, 0.87, 1]);
export const SQUARE_ALPHA = Object.freeze([1, 1, 0.92, 0.48, 0]);
export const SQUARE_SEGMENTS = 44;
// How much of the dirt tone survives against the local ground colour. Not 1:
// letting a little of the biome through is what keeps a village's ground
// looking like that village's soil rather than like an imported texture.
export const DIRT_MIX = 0.88;
const SAMPLE_SPACING = 1.7;

function lerp(a, b, t) { return a + (b - a) * t; }

function hash01(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The one dirt colour a settlement's square and streets are both painted in.
 *
 * Derived from the ground it is worn into, then pushed away from it in
 * luminance — the same trick the trails use — so the surface stays legible on
 * dark forest floor and on pale sand without ever leaving the soil hues.
 */
export function settlementDirtTone(world, site) {
  const h = world.height(site.x, site.z);
  const climate = world.climate(site.x, site.z, h);
  const ground = [0, 0, 0];
  groundColor(world, site.x, site.z, h, 0, climate.t, climate.m, ground, 0, 0);
  const biome = world.classify(h, 0, climate.t, climate.m);
  // Warm, compacted umber for ordinary country; sand and snow keep their own
  // mineral, because umber on a snowfield reads as spilled paint.
  let r = 0.360, g = 0.243, b = 0.130;
  if (biome === 'desert' || biome === 'beach') { r = 0.520; g = 0.436; b = 0.318; }
  else if (biome === 'snow') { r = 0.472; g = 0.451; b = 0.427; }
  else if (biome === 'tundra' || biome === 'taiga') { r = 0.372; g = 0.286; b = 0.194; }
  const groundLuma = ground[0] * 0.299 + ground[1] * 0.587 + ground[2] * 0.114;
  const dirtLuma = r * 0.299 + g * 0.587 + b * 0.114;
  const target = groundLuma < 0.29
    ? Math.min(0.50, groundLuma + 0.085)
    : Math.max(0.17, groundLuma - 0.115);
  const scale = Math.max(0.72, Math.min(1.40, target / Math.max(0.05, dirtLuma)));
  return [r * scale, g * scale, b * scale];
}

/** A painter that blends the settlement's dirt tone over the local ground. */
export function dirtPainter(world, site, tone = settlementDirtTone(world, site)) {
  const ground = [0, 0, 0];
  return (x, z, out) => {
    const h = world.height(x, z);
    const climate = world.climate(x, z, h);
    groundColor(world, x, z, h, 0, climate.t, climate.m, ground, 0, 0);
    out[0] = lerp(ground[0], tone[0], DIRT_MIX);
    out[1] = lerp(ground[1], tone[1], DIRT_MIX);
    out[2] = lerp(ground[2], tone[2], DIRT_MIX);
    return out;
  };
}

function emptyMesh() { return { positions: [], colors: [], indices: [] }; }

/**
 * The square, as a disc of rings rather than the rectangle it used to be.
 *
 * The layout has always treated the square as circular — `insideSquare` tests a
 * radius — so drawing it as a rectangle put paving in four corners that the
 * village itself considered outside the square.
 */
export function settlementSquareSurface(world, square, paint, mesh = emptyMesh()) {
  if (!square) return mesh;
  const base = mesh.positions.length / 3;
  const rgb = [0, 0, 0];
  const seed = Math.abs(Math.round(square.x * 0.37 + square.z * 0.71));
  for (let ring = 0; ring < SQUARE_RING.length; ring++) {
    for (let segment = 0; segment < SQUARE_SEGMENTS; segment++) {
      const angle = (segment / SQUARE_SEGMENTS) * Math.PI * 2;
      // The rim wanders a little, so the square ends in a worn edge rather than
      // as a drawn circle.
      const wobble = 1 + (hash01(seed + segment * 7.3) - 0.5) * 0.11 * SQUARE_RING[ring];
      const radius = square.radius * SQUARE_RING[ring] * wobble;
      const x = square.x + Math.cos(angle) * radius;
      const z = square.z + Math.sin(angle) * radius;
      mesh.positions.push(x, world.height(x, z) + SURFACE_LIFT, z);
      paint(x, z, rgb);
      mesh.colors.push(rgb[0], rgb[1], rgb[2], SQUARE_ALPHA[ring]);
      if (ring === 0) break;          // the centre is one vertex, not a ring
    }
  }
  // Fan from the centre to the first ring, then quads between rings.
  //
  // Wound to present the +Y face upward. Getting this backwards does not draw a
  // dark surface — it draws NOTHING, because the back faces are culled and the
  // only view of the ground you ever get is from above it.
  const ringStart = (ring) => base + (ring === 0 ? 0 : 1 + (ring - 1) * SQUARE_SEGMENTS);
  for (let segment = 0; segment < SQUARE_SEGMENTS; segment++) {
    const next = (segment + 1) % SQUARE_SEGMENTS;
    mesh.indices.push(base, ringStart(1) + next, ringStart(1) + segment);
  }
  for (let ring = 1; ring < SQUARE_RING.length - 1; ring++) {
    const inner = ringStart(ring), outer = ringStart(ring + 1);
    for (let segment = 0; segment < SQUARE_SEGMENTS; segment++) {
      const next = (segment + 1) % SQUARE_SEGMENTS;
      mesh.indices.push(
        inner + segment, outer + next, outer + segment,
        inner + segment, inner + next, outer + next,
      );
    }
  }
  return mesh;
}

/**
 * A street, surfaced from the middle of the square outward.
 *
 * It starts at the square's CENTRE rather than at its rim: the two surfaces
 * carry the same colour, so the overlap is invisible, and starting at the rim
 * instead leaves a ring where the square has faded out but the street has not
 * yet faded in — a gap exactly where the road should be at its most worn.
 */
export function settlementStreetSurface(world, street, square, paint, mesh = emptyMesh()) {
  const fromX = square ? square.x : street.fromX;
  const fromZ = square ? square.z : street.fromZ;
  const spanX = street.toX - fromX, spanZ = street.toZ - fromZ;
  const length = Math.hypot(spanX, spanZ);
  if (!(length > 0.5)) return mesh;
  const dirX = spanX / length, dirZ = spanZ / length;
  const normX = -dirZ, normZ = dirX;
  const rows = Math.max(2, Math.ceil(length / SAMPLE_SPACING));
  const halfWidth = (street.width * STREET_WIDTH_SCALE) / 2;
  const seed = Math.abs(Math.round(street.toX * 0.29 + street.toZ * 0.53));
  const base = mesh.positions.length / 3;
  const rgb = [0, 0, 0];
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const along = length * t;
    // A road narrows a little as it leaves the village and its edges wander.
    const taper = 1 - 0.18 * t * t;
    const wander = 1 + (hash01(seed + row * 3.1) - 0.5) * 0.13;
    const width = halfWidth * taper * wander;
    const cx = fromX + dirX * along, cz = fromZ + dirZ * along;
    for (let col = 0; col < STREET_ACROSS.length; col++) {
      const x = cx + normX * STREET_ACROSS[col] * width;
      const z = cz + normZ * STREET_ACROSS[col] * width;
      mesh.positions.push(x, world.height(x, z) + SURFACE_LIFT, z);
      paint(x, z, rgb);
      // The far end fades out too, so a street stops at the edge of the village
      // instead of being chopped off.
      const runOut = 1 - Math.max(0, (t - 0.86) / 0.14);
      mesh.colors.push(rgb[0], rgb[1], rgb[2], STREET_ALPHA[col] * runOut);
    }
  }
  const cols = STREET_ACROSS.length;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = base + row * cols + col, b = a + 1;
      const c = a + cols, d = c + 1;
      // Rows advance along the tangent and columns along its left normal, which
      // is a clockwise basis in XZ — so the triangles wind the opposite way
      // round to turn their +Y face toward the walker. Same reasoning, and the
      // same order, as the country trails.
      mesh.indices.push(a, b, c, b, d, c);
    }
  }
  return mesh;
}

/** Square and streets together, as one surface in one buffer. */
export function settlementSurfaceMesh(world, plan, paint) {
  const mesh = emptyMesh();
  settlementSquareSurface(world, plan.square, paint, mesh);
  for (const street of plan.streets || []) {
    settlementStreetSurface(world, street, plan.square, paint, mesh);
  }
  return mesh;
}
