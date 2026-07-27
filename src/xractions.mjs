export const XR_BUTTON_BINDINGS = Object.freeze({
  run: 'left-stick-click',
  jump: 'A',
  interact: 'B',
  switchSeat: 'X',
});

// The locomotion legend is onboarding, not a permanent HUD. Contextual train
// actions remain visible for as long as they can actually be used.
export const XR_INTRO_HINT_SECONDS = 5;

export function xrActionHudVisible(cue, introRemaining) {
  return !!cue || introRemaining > 0;
}

export function xrActionItems(cue = null) {
  if (cue?.mode === 'riding') {
    return [
      { button: cue.primaryButton || 'B', action: cue.primaryAction || 'ALIGHT' },
      { button: cue.secondaryButton || 'X', action: cue.secondaryAction || 'SWITCH SEAT' },
    ];
  }
  if (cue?.mode === 'board') {
    return [{ button: cue.primaryButton || 'B', action: cue.primaryAction || 'BOARD TRAIN' }];
  }
  return [
    { button: 'LS', action: 'PRESS TO RUN' },
    { button: 'A', action: 'JUMP' },
  ];
}
