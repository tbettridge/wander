export const XR_BUTTON_BINDINGS = Object.freeze({
  run: 'left-stick-click',
  jump: 'A',
  interact: 'B',
  switchSeat: 'X',
});

export function xrActionItems(cue = null) {
  if (cue?.mode === 'riding') {
    return [
      { button: cue.primaryButton || 'B', action: cue.primaryAction || 'ALIGHT' },
      { button: cue.secondaryButton || 'X', action: cue.secondaryAction || 'SWITCH SEAT' },
    ];
  }
  const items = [
    { button: 'LS', action: 'PRESS TO RUN' },
    { button: 'A', action: 'JUMP' },
  ];
  if (cue?.mode === 'board') {
    items.push({ button: cue.primaryButton || 'B', action: cue.primaryAction || 'BOARD TRAIN' });
  }
  return items;
}
