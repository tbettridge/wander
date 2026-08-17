/**
 * Browser-local identity and deterministic region descriptors.
 *
 * A Wander identity is deliberately not an account. It is a device-local
 * pseudonym used to address a peer while a session is alive and to derive a
 * stable region id from the owner's seed. No address, seed, or contact detail
 * is ever placed on the public departures board.
 */

export const MULTIPLAYER_PROTOCOL_VERSION = 1;
export const IDENTITY_SCHEMA_VERSION = 1;
export const IDENTITY_STORAGE_KEY = `wander.multiplayer.identity.v${IDENTITY_SCHEMA_VERSION}`;
export const LEGACY_PLAYER_ID = 'player:local';

const REGION_ADJECTIVES = [
  'Amber', 'Ashen', 'Blue', 'Bright', 'Cinder', 'Copper', 'Dawn', 'Fern',
  'Foxglove', 'Glass', 'Golden', 'Green', 'Hollow', 'Ivory', 'Juniper',
  'Moss', 'North', 'Quiet', 'Red', 'Silver', 'Soft', 'Starling', 'Thistle',
  'Wandering', 'West', 'Willow', 'Winter', 'Wren',
];
const REGION_NOUNS = [
  'Barrow', 'Basin', 'Cairn', 'Coast', 'Common', 'Downs', 'Fells', 'Glen',
  'Heath', 'Hollow', 'March', 'Meadow', 'Moor', 'Pass', 'Reach', 'Ridge',
  'Shore', 'Vale', 'Way', 'Weald', 'Wood',
];

function asStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* private browsing or a non-browser runtime */ }
  return null;
}

function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes.some(Boolean)) {
      return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* use the final fallback below */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A small, stable, non-cryptographic hash for deterministic presentation. */
export function hashString(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sanitizeDisplayName(value, fallback = 'Traveller') {
  const clean = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N} ._'’-]/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 28);
  return clean || fallback;
}

export function createLocalIdentity({ storage, displayName } = {}) {
  const store = asStorage(storage);
  let saved = null;
  try {
    const raw = store?.getItem(IDENTITY_STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch { saved = null; }
  const identity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    playerId: typeof saved?.playerId === 'string' && saved.playerId.length >= 8
      ? saved.playerId
      : `player:${randomId()}`,
    displayName: sanitizeDisplayName(displayName ?? saved?.displayName ?? ''),
    createdAt: Number.isFinite(saved?.createdAt) ? saved.createdAt : Date.now(),
  };
  try { store?.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity)); } catch { /* optional */ }
  return identity;
}

export function updateIdentityDisplayName(identity, displayName, { storage } = {}) {
  const next = {
    ...identity,
    displayName: sanitizeDisplayName(displayName, identity?.displayName || 'Traveller'),
  };
  const store = asStorage(storage);
  try { store?.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(next)); } catch { /* optional */ }
  return next;
}

export function regionIdFor({ ownerId, seed }) {
  const value = hashString(`${ownerId || 'anonymous'}:${Number(seed) || 0}`);
  const second = hashString(`${Number(seed) || 0}:${ownerId || 'anonymous'}:wander`);
  return `region-${value.toString(36).padStart(7, '0')}-${second.toString(36).padStart(7, '0')}`;
}

export function regionCodeFor({ ownerId, seed }) {
  const value = hashString(`${ownerId || 'anonymous'}:${Number(seed) || 0}:code`);
  return value.toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

export function regionNameFor({ ownerId, seed }) {
  const value = hashString(`${ownerId || 'anonymous'}:${Number(seed) || 0}:name`);
  const adjective = REGION_ADJECTIVES[value % REGION_ADJECTIVES.length];
  const noun = REGION_NOUNS[Math.floor(value / REGION_ADJECTIVES.length) % REGION_NOUNS.length];
  return `${adjective} ${noun}`;
}

export function regionDescriptor({ identity, ownerId, seed, name, visibility = 'public', allowVisitors = true } = {}) {
  const resolvedOwnerId = ownerId || identity?.playerId || 'anonymous';
  const numericSeed = Number(seed) || 0;
  return Object.freeze({
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    regionId: regionIdFor({ ownerId: resolvedOwnerId, seed: numericSeed }),
    regionCode: regionCodeFor({ ownerId: resolvedOwnerId, seed: numericSeed }),
    regionName: sanitizeDisplayName(name, regionNameFor({ ownerId: resolvedOwnerId, seed: numericSeed })),
    ownerId: resolvedOwnerId,
    ownerName: sanitizeDisplayName(identity?.displayName || 'Traveller'),
    seed: numericSeed,
    visibility: visibility === 'private' ? 'private' : 'public',
    allowVisitors: allowVisitors !== false,
  });
}

export function isCompatibleProtocol(value) {
  return Number(value?.protocolVersion) === MULTIPLAYER_PROTOCOL_VERSION;
}

/**
 * Migrate the old single-player subject id without rewriting arbitrary text.
 * The returned value is a deep clone so state stores can compare before/after.
 */
export function migrateLegacyPlayerReferences(value, playerId) {
  if (!value || typeof value !== 'object') return value;
  const replacement = String(playerId || '');
  if (!replacement) return structuredCloneSafe(value);
  const walk = (entry) => {
    if (Array.isArray(entry)) return entry.map(walk);
    if (!entry || typeof entry !== 'object') return entry === LEGACY_PLAYER_ID ? replacement : entry;
    const output = {};
    for (const [key, child] of Object.entries(entry)) {
      const migratedKey = key.includes(LEGACY_PLAYER_ID)
        ? key.split(LEGACY_PLAYER_ID).join(replacement)
        : key;
      output[migratedKey] = child === LEGACY_PLAYER_ID ? replacement : walk(child);
    }
    return output;
  };
  return walk(value);
}

function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}
