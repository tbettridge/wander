import { applyLivingWorldEventOnce } from './livingworldstate.mjs';

export function recordSettlementPressure(state, settlementId, changes = {}) {
  state.settlementEvolution ||= {};
  const record = state.settlementEvolution[settlementId] ||= { settlementId, prosperity: 0, populationPressure: 0, damage: 0, lastEpoch: -1 };
  for (const key of ['prosperity', 'populationPressure', 'damage']) record[key] += Number(changes[key]) || 0;
  return record;
}

export function advanceSettlementEvolution(state, nowHour, { epochHours = 24 * 30 } = {}) {
  const epoch = Math.floor(nowHour / epochHours), changes = [];
  state.settlementDeltas ||= {};
  for (const record of Object.values(state.settlementEvolution || {})) {
    if (record.lastEpoch >= epoch) continue;
    const eventId = `settlement-evolution:${record.settlementId}:${epoch}`;
    const result = applyLivingWorldEventOnce(state, { id: eventId, type: 'settlement-evolution', placeKey: record.settlementId, atHour: nowHour }, (draft) => {
      const current = draft.settlementEvolution[record.settlementId]; current.lastEpoch = epoch;
      const delta = draft.settlementDeltas[record.settlementId] ||= { settlementId: record.settlementId, addedBuildings: [], removedBuildingIds: [], repairs: {}, revision: 0 };
      if (current.damage > 1) { delta.repairs.pending = (delta.repairs.pending || 0) + 1; current.damage -= 1; }
      else if (current.prosperity + current.populationPressure > 2) {
        delta.addedBuildings.push({ id: `${record.settlementId}:evolved:${epoch}`, program: current.prosperity > current.populationPressure ? 'workshop' : 'dwelling', epoch });
        current.prosperity = Math.max(0, current.prosperity - 1); current.populationPressure = Math.max(0, current.populationPressure - 1);
      }
      delta.revision++; draft.metrics.settlementEvolutionEvents = (draft.metrics.settlementEvolutionEvents || 0) + 1;
      return { settlementId: record.settlementId, revision: delta.revision };
    });
    changes.push(result);
  }
  return changes;
}

export function compactSettlementDeltas(state) {
  for (const [id, delta] of Object.entries(state.settlementDeltas || {})) {
    if (!delta.addedBuildings?.length && !delta.removedBuildingIds?.length && !Object.keys(delta.repairs || {}).length) delete state.settlementDeltas[id];
  }
}
