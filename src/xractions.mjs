export const XR_BUTTON_BINDINGS = Object.freeze({
  run: 'left-stick-click',
  jump: 'A',
  interact: 'B',
  switchSeat: 'X',
  lantern: 'left-trigger',
});

// The off-hand trigger owns the lantern on standard two-controller headsets.
// A right-trigger fallback keeps the action available on one-controller and
// accessibility configurations without making both triggers toggle at once.
export function xrLanternTriggerHeld(inputSources = []) {
  let hasLeftGamepad = false;
  let leftHeld = false;
  let rightHeld = false;
  for (const source of inputSources) {
    const gamepad = source?.gamepad;
    if (!gamepad) continue;
    const trigger = gamepad.buttons?.[0];
    const held = !!trigger?.pressed || (trigger?.value ?? 0) > 0.72;
    if (source.handedness === 'left') {
      hasLeftGamepad = true;
      leftHeld ||= held;
    } else if (source.handedness === 'right') {
      rightHeld ||= held;
    }
  }
  return hasLeftGamepad ? leftHeld : rightHeld;
}

// The locomotion legend and passenger controls are onboarding, not permanent
// HUD. The service supplies a cue only during its short decision windows.
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
    { button: 'LT', action: 'LANTERN' },
  ];
}
