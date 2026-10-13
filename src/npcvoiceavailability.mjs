// XR focus belongs to the session; desktop focus belongs to the page.
export function npcLiveVoiceAvailable({ started, ready, uiState, dialogueOpen,
  remoteConversation, documentVisible, xrPresenting, xrVisibility = 'visible', bookOpen } = {}) {
  return !npcLiveVoicePauseReason({ started, ready, uiState, dialogueOpen,
    remoteConversation, documentVisible, xrPresenting, xrVisibility, bookOpen });
}

export function npcLiveVoicePauseReason({ started, ready, uiState, dialogueOpen,
  remoteConversation, documentVisible, xrPresenting, xrVisibility = 'visible', bookOpen } = {}) {
  if (!ready) return 'Voice paused · waiting for the world to load';
  if (!started) return 'Voice paused · begin walking to talk';
  if (bookOpen) return 'Voice paused · close your book to talk';
  if (dialogueOpen) return 'Voice paused · close text chat to talk';
  if (remoteConversation) return 'Voice paused · finish the current conversation';
  if (xrPresenting) return uiState === 'xr' && xrVisibility === 'visible'
    ? '' : 'Voice paused · return to the game in your headset';
  if (!documentVisible) return 'Voice paused · return to the game tab';
  return uiState === 'playing' ? '' : 'Voice paused · resume walking to talk';
}
