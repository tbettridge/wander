/**
 * The one thing a visitor may write into a host's world.
 *
 * Kept out of main.js so the ceiling below can be tested against its real
 * behaviour rather than by reading the source. Guests reach this through
 * HostWorldAuthority.applyIntent, which has already checked that the sender is
 * an admitted visitor and that the intent is within the rate limit.
 */

/**
 * How many visitor markers a region keeps before the oldest are forgotten.
 *
 * Markers are guest-written and nothing else expires them, while every one of
 * them rides in every state snapshot — and a snapshot throws above its 512 KiB
 * budget. That throw surfaces inside the render loop's own update() call, ahead
 * of terrain streaming and drawing, so an unbounded collection here does not
 * merely grow: it stops the game. The ceiling is roughly a fourteenth of the
 * marker count that reaches the budget, which leaves the snapshot room for the
 * rest of the projection.
 */
export const MAX_SHARED_MARKERS = 256;

const CHANGES_PATH = 'publicProjections.worldChanges';
/** The protocol's own ceiling on one path segment, which a key has to fit. */
const MAX_KEY_LENGTH = 80;

/**
 * A short, stable key for one marker.
 *
 * The obvious key — owner plus intent id — does not fit. `sendIntent` already
 * builds an intent id out of the player id, so concatenating both spells the
 * same 45-character player id twice and lands near 112 characters, over the 80
 * a single delta path segment may hold. The whole operation would then be
 * refused and the marker silently lost. Hashing keeps the key inside the limit
 * and, because it is a pure function of the pair, a replayed intent still
 * resolves to the same marker rather than a duplicate. The owner is not lost:
 * it stays on the value as `ownerId`.
 */
function markerKey(playerId, intentId) {
  let hash = 0x811c9dc5;
  const source = `${playerId}:${intentId}`;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `marker:${hash.toString(36)}`;
}

/**
 * Apply a visitor's marker, evicting the oldest once the ceiling is reached.
 *
 * Evictions are returned as delete operations rather than dropped silently: a
 * guest holding a marker the host has forgotten is a view of the world that no
 * longer matches the host's, which is the divergence the revision contract
 * exists to prevent.
 *
 * Returns null when the intent is not a marker, which leaves the caller's
 * reducer free to handle other kinds.
 */
export function placeSharedMarker(state, intent, playerId) {
  if (!state || intent?.kind !== 'place-marker') return null;
  if (!Number.isFinite(Number(intent.x)) || !Number.isFinite(Number(intent.z))) return null;
  state.publicProjections ||= {};
  const changes = (state.publicProjections.worldChanges ||= {});

  // A dot would split into extra path segments on the way to the guest and land
  // the value somewhere the host never wrote, so a key that cannot round-trip is
  // refused rather than replicated into a mismatch. The hash cannot produce one,
  // which is the point; the check stays as the guarantee rather than a hope.
  const id = markerKey(playerId, String(intent.intentId ?? ''));
  if (id.includes('.') || id.length > MAX_KEY_LENGTH) return null;

  changes[id] = {
    id,
    kind: 'marker',
    ownerId: playerId,
    x: Number(intent.x),
    z: Number(intent.z),
    label: String(intent.label || 'a shared marker').slice(0, 80),
  };
  const operations = [{ op: 'set', path: `${CHANGES_PATH}.${id}`, value: changes[id] }];

  const keys = Object.keys(changes);
  for (let i = 0; i < keys.length - MAX_SHARED_MARKERS; i += 1) {
    delete changes[keys[i]];
    operations.push({ op: 'delete', path: `${CHANGES_PATH}.${keys[i]}` });
  }
  return { operations };
}
