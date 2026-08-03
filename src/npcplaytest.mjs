export const PLAYTEST_VIGNETTES = Object.freeze([
  { id: 'letter', label: 'Scene 1', expected: 'delivering a letter' },
  { id: 'parcel', label: 'Scene 2', expected: 'carrying a parcel somewhere' },
  { id: 'repair', label: 'Scene 3', expected: 'doing repair work' },
  { id: 'trade', label: 'Scene 4', expected: 'offering goods or a trade' },
  { id: 'pair', label: 'Scene 5', expected: 'travelling together' },
  { id: 'map', label: 'Scene 6', expected: 'checking a route or map' },
  { id: 'train', label: 'Scene 7', expected: 'waiting for a train' },
]);

export function scoreParticipant(response = {}) {
  const correct = PLAYTEST_VIGNETTES.reduce((count, vignette) => (
    response.answers?.[vignette.id]?.correct === true ? count + 1 : count
  ), 0);
  return {
    participantId: String(response.participantId || 'unknown'),
    correct, legibilityPass: correct >= 5,
    frequency: response.frequency || 'unanswered',
    pressurePass: response.frequency === 'rare-noticeable',
    automaticDialogue: !!response.automaticDialogue,
    forcedStops: Number(response.forcedStops) || 0,
  };
}

export function summarizePlaytest(responses = []) {
  const participants = responses.map(scoreParticipant);
  const legibilityPasses = participants.filter((entry) => entry.legibilityPass).length;
  const pressurePasses = participants.filter((entry) => entry.pressurePass).length;
  return {
    participantCount: participants.length,
    participants,
    legibilityPasses,
    pressurePasses,
    automaticDialogueReports: participants.filter((entry) => entry.automaticDialogue).length,
    forcedStops: participants.reduce((sum, entry) => sum + entry.forcedStops, 0),
    gates: {
      enoughParticipants: participants.length >= 5,
      legibility: participants.length >= 5 && legibilityPasses >= 4,
      interactionPressure: participants.length >= 5 && pressurePasses >= 4,
      noAutomaticDialogue: participants.every((entry) => !entry.automaticDialogue),
      noForcedStops: participants.every((entry) => entry.forcedStops === 0),
    },
  };
}
