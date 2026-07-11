// Shared live-tuning controls for the painterly surface treatment. Terrain and
// landmark stone consume the same strength so the world reads as one painted
// material system rather than disconnected shader effects.

export const groundDetailUniforms = {
  strength: { value: 0.70 },
  relief: { value: 0.30 },
};
