// Inspection views use fitted sections, not the coarse drainage route. Keep
// measurements away from source closure and the ocean handoff.
export function riverChannelInspection(component) {
  const reaches = component.reaches.map(reach => {
    const length = reach.points.at(-1).arc;
    const points = reach.points.filter(p => p.arc >= (reach.sourceClosure ? 32 : 16)
      && p.arc <= length - (reach.oceanMouth ? 64 : 16));
    if (!points.length) return null;
    let widthIntegral = 0, span = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], distance = b.arc - a.arc;
      widthIntegral += distance * (a.leftWidth + a.rightWidth + b.leftWidth + b.rightWidth) / 2;
      span += distance;
    }
    const meanWidth = span ? widthIntegral / span : points[0].leftWidth + points[0].rightWidth;
    return { reach, points, meanWidth, target: points[Math.floor(points.length / 2)] };
  }).filter(Boolean);
  if (!reaches.length) return null;
  const headwater = reaches.filter(item => item.reach.sourceClosure)
    .sort((a, b) => a.meanWidth - b.meanWidth || a.reach.id.localeCompare(b.reach.id))[0];
  const downstream = [...reaches].sort((a, b) => b.meanWidth - a.meanWidth
    || a.reach.id.localeCompare(b.reach.id))[0];
  const bend = reaches.flatMap(item => item.points).filter(p => (p.bendWidening ?? 1) > 1)
    .sort((a, b) => (b.bendWidening - 1) * (b.leftWidth + b.rightWidth)
      - (a.bendWidening - 1) * (a.leftWidth + a.rightWidth))[0];
  const views = [];
  const add = (kind, label, p) => { if (p) views.push({ kind, label, x: p.x, z: p.z,
    ...(Number.isFinite(p.tx) ? { tangentX: p.tx, tangentZ: p.tz } : {}) }); };
  add('headwater', 'Headwater', headwater?.target);
  add('bend', 'Bend', bend);
  add('downstream', 'Downstream river', downstream?.target);
  const junction = component.junctions.at(-1);
  add('junction', 'Tributary join', junction);
  return { views, headwaterMeanWidth: headwater?.meanWidth ?? null,
    downstreamMeanWidth: downstream.meanWidth,
    growthRatio: headwater ? downstream.meanWidth / headwater.meanWidth : null,
    maxBendWidening: bend?.bendWidening ?? 1 };
}
