/**
 * Restore desktop control immediately after a user-initiated fast travel.
 *
 * Pointer lock must be requested synchronously inside the originating click;
 * deferring this work until streaming settles loses the browser activation and
 * leaves both movement and mouse-look suspended.
 */
export function resumeDesktopAfterFastTravel({
  active,
  locked,
  enterPlaying,
  enterResuming,
  requestLock,
  onFailure,
}) {
  if (!active) return 'inactive';
  if (locked) {
    enterPlaying();
    return 'playing';
  }

  enterResuming();
  try {
    const request = requestLock();
    request?.catch?.(onFailure);
  } catch (error) {
    onFailure(error);
  }
  return 'requesting';
}
