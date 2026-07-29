function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function xrGrassPlan(profile, runtimeScale = 1) {
  const scale = clamp(runtimeScale, 0.5, 1);
  const nearFull = finite(profile?.grassGrowNear, 30);
  const nearLimit = finite(profile?.grassGrowFar, nearFull + 22);
  const midNear = finite(profile?.grassMidStart, Math.max(16, nearFull - 10));
  const midLimit = finite(profile?.grassMidEnd, midNear + 80);
  const bladeBudget = finite(profile?.grassMidBladeBudget, 60000);
  const farLimit = finite(profile?.grassFarEnd, midLimit + 70);
  const nearFade = lerp(nearFull + 8, nearLimit, scale);
  const minimumMidFar = midNear + 36;
  const midFar = lerp(minimumMidFar, midLimit, scale);
  const farNear = Math.max(midNear + 18, midFar - 22);
  return Object.freeze({
    scale,
    near: Object.freeze({ full: nearFull, fade: nearFade }),
    mid: Object.freeze({
      near: midNear,
      far: midFar,
      instances: Math.max(1, Math.round(bladeBudget * scale)),
    }),
    far: Object.freeze({
      near: farNear,
      full: farNear + 28,
      fade: farLimit,
    }),
  });
}

export function xrGrassPlanLabel(plan) {
  return `near 0–${Math.round(plan.near.fade)}m · mid ${Math.round(plan.mid.near)}–${Math.round(plan.mid.far)}m / ${plan.mid.instances.toLocaleString()} blades · far shader ${Math.round(plan.far.near)}–${Math.round(plan.far.fade)}m`;
}
