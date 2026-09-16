import { planWaterRegionCandidates } from './hydrologyregions.mjs';

self.onmessage = ({ data }) => {
  if (data?.type !== 'candidate') return;
  try {
    if (![data.seed, data.x, data.z].every(Number.isSafeInteger)) throw new Error('Invalid candidate identity');
    const plan = planWaterRegionCandidates(data.seed, data.x, data.z);
    self.postMessage({ type: 'candidate-ready', id: data.id, planJSON: JSON.stringify(plan) });
  } catch (error) {
    self.postMessage({ type: 'candidate-error', id: data.id, error: error.message });
  }
};
