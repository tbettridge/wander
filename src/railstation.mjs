// Classic station layout + collision, kept pure so the geometry (railstation.js)
// and the walking environment share one source of truth and the maths can be
// tested in Node. Local frame: `along` runs with the track tangent, `across` is
// the right vector — +across is the main platform / building side.

export const STATION_LAYOUT = Object.freeze({
  platformTop: 0.34,      // walking surface, above the rail formation
  platformBase: -0.62,    // slab underside, set into the trackbed shelf
  halfLength: 24,         // main platform half-length along the track
  endRamp: 3.5,           // access ramp up onto each platform end
  mainAcross: 3.4, mainHalf: 1.95,
  oppAcross: -3.3, oppHalf: 1.5, oppHalfLength: 17,
  building: { across: 4.95, half: 1.35, halfLength: 5.5, wallHeight: 3.4, ridgeRise: 1.2 },
  canopy: { front: 1.55, back: 3.6, height: 2.55, halfLength: 8 },
  playerRadius: 0.34,
});

const P = STATION_LAYOUT;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/** Build the collision model for one station in its own oriented frame. */
export function stationCollisionModel(station) {
  const tx = station.tangentX ?? 0, tz = station.tangentZ ?? 1;
  const norm = Math.hypot(tx, tz) || 1;
  const utx = tx / norm, utz = tz / norm;
  const formationY = station.formationY ?? station.y ?? 0;
  const platformY = formationY + P.platformTop;
  const platforms = [
    { a0: -P.halfLength, a1: P.halfLength, c0: P.mainAcross - P.mainHalf, c1: P.mainAcross + P.mainHalf },
    { a0: -P.oppHalfLength, a1: P.oppHalfLength, c0: P.oppAcross - P.oppHalf, c1: P.oppAcross + P.oppHalf },
  ];
  const buildings = [
    {
      a0: -P.building.halfLength, a1: P.building.halfLength,
      c0: P.building.across - P.building.half, c1: P.building.across + P.building.half,
    },
  ];
  return {
    id: station.id, index: station.index,
    ox: station.x, oz: station.z,
    tx: utx, tz: utz, rx: utz, rz: -utx,   // right / across basis
    formationY, platformY, platforms, buildings,
    boundHalfLen: P.halfLength + 12,
    boundC0: P.oppAcross - P.oppHalf - 5,
    boundC1: P.building.across + P.building.half + 5,
  };
}

function localAlong(m, x, z) { return (x - m.ox) * m.tx + (z - m.oz) * m.tz; }
function localAcross(m, x, z) { return (x - m.ox) * m.rx + (z - m.oz) * m.rz; }

/** Is the point within the station's activation footprint (a generous box
 * around platforms + building), so the environment should be installed? */
export function stationContains(m, x, z) {
  const a = localAlong(m, x, z), c = localAcross(m, x, z);
  return a > -m.boundHalfLen && a < m.boundHalfLen && c > m.boundC0 && c < m.boundC1;
}

/** Floor height at (x, z): the platform surface when standing on a platform
 * (ramping down to terrain at the along-ends), otherwise the terrain. Always
 * finite so the walking resolver never freezes the player's height. */
export function stationFloorAt(m, x, z, terrainY) {
  const a = localAlong(m, x, z), c = localAcross(m, x, z);
  let floor = terrainY;
  for (const p of m.platforms) {
    if (c < p.c0 || c > p.c1 || a < p.a0 || a > p.a1) continue;
    let h = m.platformY;
    const dEnd = Math.min(a - p.a0, p.a1 - a);
    if (dEnd < P.endRamp) h = terrainY + (m.platformY - terrainY) * clamp(dEnd / P.endRamp, 0, 1);
    if (h > floor) floor = h;
  }
  return floor;
}

/** Push the point out of any solid building footprint (expanded by the player
 * radius), resolving along the axis of least penetration. Returns {x,z} when it
 * moved, else null. */
export function stationConstrain(m, x, z, out = {}) {
  let a = localAlong(m, x, z), c = localAcross(m, x, z);
  const r = P.playerRadius;
  let hit = false;
  for (const b of m.buildings) {
    const a0 = b.a0 - r, a1 = b.a1 + r, c0 = b.c0 - r, c1 = b.c1 + r;
    if (a <= a0 || a >= a1 || c <= c0 || c >= c1) continue;
    const penA0 = a - a0, penA1 = a1 - a, penC0 = c - c0, penC1 = c1 - c;
    const min = Math.min(penA0, penA1, penC0, penC1);
    if (min === penA0) a = a0;
    else if (min === penA1) a = a1;
    else if (min === penC0) c = c0;
    else c = c1;
    hit = true;
  }
  if (!hit) return null;
  out.x = m.ox + m.tx * a + m.rx * c;
  out.z = m.oz + m.tz * a + m.rz * c;
  return out;
}
