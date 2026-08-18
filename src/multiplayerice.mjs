/**
 * How a visit reaches the other person, and what to try when it cannot.
 *
 * Direct is the default and stays the default: peers exchange gameplay straight
 * to each other and the relay never sees it. But direct is not always possible.
 * Measured across large deployments, somewhere between a tenth and a fifth of
 * connections cannot be made without a relay — roughly one peer in ten sits
 * behind a NAT that maps each destination differently, and restrictive corporate
 * and mobile networks push that share higher still. Before this, those visits
 * simply never connected, and said nothing about why.
 *
 * So a relay is offered as a fallback and never as the first attempt: the direct
 * path is tried on its own, and only once it has actually failed is the
 * connection rebuilt with the relay included. A player who can connect directly
 * therefore never routes traffic through anyone, which is the property the
 * direct-only design was protecting.
 */

/** Cloudflare's public STUN service is free and reveals only a public address. */
export const DIRECT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
]);

export const BASE_PEER_CONNECTION_OPTIONS = Object.freeze({
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
});

/**
 * Relay credentials, supplied by the deployment rather than baked in.
 *
 * Shaped exactly like RTCIceServer, so a Cloudflare Calls or Twilio credential
 * can be pasted in as-is:
 *
 *   globalThis.WANDER_TURN_SERVERS = [{
 *     urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
 *     username: '…', credential: '…',
 *   }];
 *
 * Absent, everything below degrades to exactly the previous direct-only
 * behaviour, which is what keeps this safe to ship before any relay exists.
 */
export function configuredTurnServers(source = globalThis.WANDER_TURN_SERVERS) {
  if (!Array.isArray(source)) return [];
  return source
    .filter((entry) => entry && (typeof entry.urls === 'string' || Array.isArray(entry.urls)))
    .map((entry) => Object.freeze({ ...entry }));
}

export function hasTurnFallback(source) {
  return configuredTurnServers(source).length > 0;
}

/**
 * The ICE configuration for one attempt.
 *
 * `relay` is not merely "add the TURN servers": it also pins the transport
 * policy to 'relay'. Leaving it on 'all' would let the same host candidates that
 * just failed be tried again first, which wastes the retry on the path already
 * known not to work.
 */
export function iceConfigurationFor(attempt = 'direct', source = globalThis.WANDER_TURN_SERVERS) {
  const turn = configuredTurnServers(source);
  if (attempt === 'relay' && turn.length) {
    return {
      ...BASE_PEER_CONNECTION_OPTIONS,
      iceServers: [...DIRECT_ICE_SERVERS, ...turn],
      iceTransportPolicy: 'relay',
    };
  }
  return { ...BASE_PEER_CONNECTION_OPTIONS, iceServers: [...DIRECT_ICE_SERVERS] };
}

/**
 * What to do after a connection fails, given how many attempts have been made.
 *
 * An ICE restart is worth one try on the path that just failed: transient
 * candidate loss is common and recovers. After that, the useful escalation is
 * the relay, if one exists. When it does not, the honest answer is to stop and
 * say so rather than restart forever against a route that cannot work.
 */
export function nextConnectionAttempt(attempts = 0, { turnAvailable = false, usedRelay = false } = {}) {
  if (attempts < 1) return { action: 'ice-restart', mode: 'direct', delayMs: 400 };
  if (turnAvailable && !usedRelay) return { action: 'reconnect', mode: 'relay', delayMs: 700 };
  return {
    action: 'give-up',
    mode: usedRelay ? 'relay' : 'direct',
    reason: turnAvailable
      ? 'could not reach them directly or through the relay'
      : 'could not reach them directly · no relay is configured for this world',
  };
}
