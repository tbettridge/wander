// Renderer-independent contract for the desktop NPC conversation surface.
// Keeping the positioning here makes the world-view requirement testable
// without constructing the full Three.js population system.

export const NPC_DIALOGUE_PANEL_STYLE = Object.freeze({
  right: '18px',
  bottom: '18px',
  left: 'auto',
  width: 'min(420px, calc(100vw - 24px))',
  maxHeight: 'min(480px, calc(100vh - 32px))',
  transform: 'none',
});
