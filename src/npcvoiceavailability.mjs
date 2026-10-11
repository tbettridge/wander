// XR focus belongs to the session; desktop focus belongs to the page.
export function npcLiveVoiceAvailable({ started, ready, uiState, dialogueOpen,
  remoteConversation, documentVisible, xrPresenting, xrVisibility = 'visible' } = {}) {
  if (!started || !ready || dialogueOpen || remoteConversation) return false;
  return xrPresenting
    ? uiState === 'xr' && xrVisibility === 'visible'
    : uiState === 'playing' && documentVisible;
}
