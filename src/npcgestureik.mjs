// Two-bone arm reach in shoulder-local coordinates. The elbow pole keeps
// folded arms in front of the torso and hands-behind-back elbows outside it.
export function solveNpcArmReach(target, upperLength, foreLength, pole = [1, -0.5, 0.4]) {
  if (!target?.every(Number.isFinite) || target.length !== 3
    || !pole?.every(Number.isFinite) || pole.length !== 3
    || !Number.isFinite(upperLength) || !Number.isFinite(foreLength)
    || !(upperLength > 0) || !(foreLength > 0)) return null;
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const length = v => Math.hypot(...v);
  const distance = length(target);
  const direction = distance > 1e-8 ? target.map(value => value / distance) : [0, -1, 0];
  const reach = Math.max(Math.abs(upperLength - foreLength) + 1e-5,
    Math.min(upperLength + foreLength - 1e-5, distance));
  const along = (upperLength ** 2 - foreLength ** 2 + reach ** 2) / (2 * reach);
  const bend = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  let projection = dot(pole, direction);
  let perpendicular = pole.map((value, i) => value - projection * direction[i]);
  if (length(perpendicular) < 1e-6) {
    const fallback = Math.abs(direction[0]) < 0.8 ? [1, 0, 0] : [0, 0, 1];
    projection = dot(fallback, direction);
    perpendicular = fallback.map((value, i) => value - projection * direction[i]);
  }
  const perpendicularLength = length(perpendicular);
  const elbow = direction.map((value, i) => value * along + perpendicular[i] / perpendicularLength * bend);
  const wrist = direction.map(value => value * reach);
  return {
    upper: elbow.map(value => value / upperLength),
    lower: wrist.map((value, i) => (value - elbow[i]) / foreLength),
    wrist,
  };
}
