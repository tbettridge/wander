export const SETTLEMENT_BUDGETS = Object.freeze({
  legacySnapshotBytes: 256 * 1024,
  farmsteadSnapshotBytes: 300 * 1024,
  activeTownSnapshotBytes: 512 * 1024,
  simulationP95Ms: 0.55,
  foregroundBuildBudgetMs: 2,
  maxFullSettlements: 3,
  maxExteriorSettlements: 8,
});

export function validateSettlementExitGates({ summaries = [], plans = [], state, simulationSamples = [] } = {}) {
  const failures = [];
  const ids = new Set();
  for (const summary of summaries) {
    if (ids.has(summary.id)) failures.push(`duplicate settlement id ${summary.id}`); ids.add(summary.id);
    if (!summary.regionalEntrance?.key) failures.push(`missing entrance ${summary.id}`);
  }
  for (const plan of plans) {
    if (!plan.buildings.length) failures.push(`empty plan ${plan.id}`);
    for (const building of plan.buildings) if (!building.portals.some((p) => p.kind === 'exterior-door')) failures.push(`sealed building ${building.id}`);
  }
  const orphanOccupants = Object.values(state?.occupancy || {}).filter((o) => !state.entities?.[o.actorId]);
  if (orphanOccupants.length) failures.push(`${orphanOccupants.length} orphan occupants`);
  const sorted = simulationSamples.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  if (p95 > SETTLEMENT_BUDGETS.simulationP95Ms) failures.push(`simulation p95 ${p95.toFixed(3)}ms`);
  return { passed: failures.length === 0, failures, metrics: { summaries: summaries.length, plans: plans.length, p95Ms: p95, orphanOccupants: orphanOccupants.length } };
}
