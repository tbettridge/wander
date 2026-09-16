// Inspection positions on real terrain, not an arbitrary camera floating above
// a feature. The animated route between them is an inspection flight, not a
// claim that a traversable walking path has been solved.
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

export function watershedSightlineClear(heightAt, eye, target, step = 40) {
  if (typeof heightAt !== 'function' || !finitePoint(eye) || !finitePoint(target)
    || !Number.isFinite(eye.y) || !Number.isFinite(target.y) || !(step > 0)) {
    throw new Error('Invalid watershed sightline');
  }
  const distance = Math.hypot(target.x - eye.x, target.z - eye.z);
  const samples = Math.max(2, Math.ceil(distance / step));
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const x = eye.x + (target.x - eye.x) * t, z = eye.z + (target.z - eye.z) * t;
    const h = heightAt(x, z);
    if (!Number.isFinite(h) || h > eye.y + (target.y - eye.y) * t - 0.15) return false;
  }
  return true;
}

export async function findWatershedViewpoints(world, focus, {
  radii = [900, 1500, 2200, 3000], angles = 32, eyeHeight = 1.7,
  yieldTask = pause, signal = null,
} = {}) {
  if (!world || typeof world.height !== 'function' || typeof world.riverAt !== 'function'
    || !finitePoint(focus) || !Array.isArray(radii) || !radii.length
    || radii.some(r => !Number.isFinite(r) || r <= 0)
    || !Number.isInteger(angles) || angles < 4 || angles > 128
    || !Number.isFinite(eyeHeight) || eyeHeight <= 0 || typeof yieldTask !== 'function') {
    throw new Error('Invalid watershed viewpoint search');
  }
  const check = () => { if (signal?.aborted) throw new Error('Watershed viewpoint search cancelled'); };
  check();
  const water = world.riverAt(focus.x, focus.z);
  const target = { x: focus.x, y: water.wet ? water.y + 0.1 : world.height(focus.x, focus.z), z: focus.z };
  if (!Number.isFinite(target.y)) throw new Error('Invalid watershed target elevation');
  const candidates = [];
  let tested = 0;
  for (const radius of [...radii].sort((a, b) => a - b)) {
    for (let index = 0; index < angles; index++) {
      if (tested++ % 8 === 0) { await yieldTask(); check(); }
      const angle = index * 2 * Math.PI / angles;
      const x = target.x + Math.cos(angle) * radius, z = target.z + Math.sin(angle) * radius;
      const groundY = world.height(x, z);
      if (!Number.isFinite(groundY) || groundY <= target.y + 2 || world.riverAt(x, z).wet) continue;
      const eye = { x, y: groundY + eyeHeight, z };
      if (!watershedSightlineClear((sx, sz) => world.height(sx, sz), eye, target)) continue;
      candidates.push({ ...eye, groundY, distance: radius, angle,
        score: Math.atan2(eye.y - target.y, radius) });
    }
  }
  check();
  candidates.sort((a, b) => b.score - a.score || b.distance - a.distance || a.angle - b.angle);
  const overlook = candidates[0] || null;
  let bank = null;
  // A bank position is independently checked; it is not the focus point with
  // an artificial vertical offset that could leave the camera underwater.
  for (let distance = 4; distance <= 320 && !bank; distance += 4) {
    if (distance % 32 === 0) { await yieldTask(); check(); }
    for (let index = 0; index < 32; index++) {
      const angle = index * Math.PI / 16;
      const x = target.x + Math.cos(angle) * distance, z = target.z + Math.sin(angle) * distance;
      const groundY = world.height(x, z);
      if (!Number.isFinite(groundY) || groundY <= target.y + 0.2 || world.riverAt(x, z).wet) continue;
      const eye = { x, y: groundY + eyeHeight, z };
      if (watershedSightlineClear((sx, sz) => world.height(sx, sz), eye, target, 4)) {
        bank = { ...eye, groundY, distance }; break;
      }
    }
  }
  const midSlope = candidates.filter(p => p.distance < (overlook?.distance || Infinity))
    .sort((a, b) => Math.abs(a.distance - (overlook?.distance || 2000) / 2)
      - Math.abs(b.distance - (overlook?.distance || 2000) / 2) || b.score - a.score)[0] || null;
  return { target, overlook, midSlope, bank, tested, clearCandidates: candidates.length,
    routeKind: 'inspection-flight' };
}
