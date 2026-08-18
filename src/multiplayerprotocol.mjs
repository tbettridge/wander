/**
 * Wire-level contracts for the peer-hosted Wander session.
 *
 * The host is authoritative. Guests send intents and compact motion; the
 * host sends a filtered snapshot/delta. Keeping this file dependency-free
 * makes it usable by browser code, the directory worker, and node tests.
 */

import { MULTIPLAYER_PROTOCOL_VERSION, isCompatibleProtocol } from './multiplayeridentity.mjs';

export const PROTOCOL_VERSION = MULTIPLAYER_PROTOCOL_VERSION;
export const STATE_SCHEMA_VERSION = 1;
/**
 * The largest single data-channel message, held to the cross-browser floor.
 *
 * 64 KiB is what a Chromium pair will carry, but a reliable ordered channel from
 * Firefox to Chromium caps at 16 KiB, and a message over the limit is dropped by
 * the transport rather than reported — so the sender believes it sent a snapshot
 * that never arrives. Anything larger is split by chunkString() instead.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_DELTA_OPERATIONS = 256;
export const MAX_VISITORS = 3;

export const CHANNELS = Object.freeze({
  control: 'wander-control',
  state: 'wander-state',
  motion: 'wander-motion',
});

export const MESSAGE_TYPES = Object.freeze([
  'hello', 'hello-ack', 'admission-request', 'admission-response',
  'host-ready', 'host-denied', 'ping', 'pong', 'intent', 'motion',
  'state-snapshot', 'state-delta', 'state-ack', 'state-chunk', 'ticket-request',
  'state-request',
  'ticket-issued', 'ticket-update', 'transit-request', 'transit-update',
  'transit-arrive', 'return-home', 'close-session', 'error',
]);
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);
const FORBIDDEN_STATE_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

export function byteLength(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return new TextEncoder().encode(text).byteLength;
}

export function createEnvelope(type, payload = {}, {
  from = null,
  requestId = null,
  sequence = null,
  sentAt = Date.now(),
} = {}) {
  if (!MESSAGE_TYPE_SET.has(type)) throw new Error(`Unknown multiplayer message type: ${type}`);
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    type,
    payload,
    sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
  };
  if (from) envelope.from = String(from);
  if (requestId) envelope.requestId = String(requestId);
  if (sequence !== null && sequence !== undefined) envelope.sequence = Number(sequence) >>> 0;
  return envelope;
}

export function encodeEnvelope(envelope) {
  const value = JSON.stringify(envelope);
  if (byteLength(value) > MAX_MESSAGE_BYTES) throw new Error('Multiplayer message exceeds the 64 KiB budget');
  return value;
}

export function decodeEnvelope(value, { maxBytes = MAX_MESSAGE_BYTES } = {}) {
  if (typeof value !== 'string' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    throw new Error('Multiplayer message must be text or bytes');
  }
  const text = typeof value === 'string'
    ? value
    : new TextDecoder().decode(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  if (byteLength(text) > maxBytes) throw new Error('Multiplayer message is too large');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Malformed multiplayer JSON'); }
  const result = validateEnvelope(parsed, { maxBytes });
  if (!result.ok) throw new Error(result.error);
  return parsed;
}

export function validateEnvelope(value, { maxBytes = MAX_MESSAGE_BYTES } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Envelope must be an object' };
  if (!isCompatibleProtocol(value)) return { ok: false, error: 'Incompatible multiplayer protocol' };
  if (!MESSAGE_TYPE_SET.has(value.type)) return { ok: false, error: 'Unknown multiplayer message type' };
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    return { ok: false, error: 'Envelope payload must be an object' };
  }
  if (!Number.isFinite(value.sentAt)) return { ok: false, error: 'Envelope sentAt must be finite' };
  if (value.sequence !== undefined && (!Number.isInteger(value.sequence) || value.sequence < 0)) {
    return { ok: false, error: 'Envelope sequence must be a non-negative integer' };
  }
  if (byteLength(value) > maxBytes) return { ok: false, error: 'Envelope exceeds the message budget' };
  return { ok: true };
}

export function quantizePose({ x = 0, y = 0, z = 0, yaw = 0, pitch = 0, moving = false } = {}) {
  return {
    x: Math.round(Number(x) * 100) / 100,
    y: Math.round(Number(y) * 100) / 100,
    z: Math.round(Number(z) * 100) / 100,
    yaw: Math.round(Number(yaw) * 1000) / 1000,
    pitch: Math.round(Number(pitch) * 1000) / 1000,
    moving: !!moving,
  };
}

export function isValidPose(pose) {
  return !!pose && ['x', 'y', 'z', 'yaw', 'pitch'].every((key) => Number.isFinite(pose[key]))
    && Math.abs(pose.x) <= 1e7 && Math.abs(pose.y) <= 1e5 && Math.abs(pose.z) <= 1e7
    && Math.abs(pose.yaw) <= Math.PI * 4 && Math.abs(pose.pitch) <= Math.PI * 2;
}

export function createStateSnapshot(state, {
  revision = 0,
  worldSeed = 0,
  regionId = null,
  playerId = null,
  observedAt = Date.now(),
} = {}) {
  const snapshot = {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: Number(revision) >>> 0,
    worldSeed: Number(worldSeed) || 0,
    regionId: regionId ? String(regionId) : null,
    playerId: playerId ? String(playerId) : null,
    observedAt,
    state,
  };
  if (byteLength(snapshot) > MAX_SNAPSHOT_BYTES) throw new Error('State snapshot exceeds the 512 KiB budget');
  return snapshot;
}

export function createStateDelta(operations = [], {
  baseRevision = 0,
  revision = baseRevision + 1,
  regionId = null,
} = {}) {
  if (!Array.isArray(operations) || operations.length > MAX_DELTA_OPERATIONS) {
    throw new Error(`State deltas may contain at most ${MAX_DELTA_OPERATIONS} operations`);
  }
  const delta = {
    schemaVersion: STATE_SCHEMA_VERSION,
    baseRevision: Number(baseRevision) >>> 0,
    revision: Number(revision) >>> 0,
    regionId: regionId ? String(regionId) : null,
    operations: operations.map((operation) => normalizeOperation(operation)),
  };
  if (byteLength(delta) > MAX_MESSAGE_BYTES) throw new Error('State delta exceeds the 64 KiB budget');
  return delta;
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== 'object' || typeof operation.path !== 'string') {
    throw new Error('State operation needs a string path');
  }
  const kind = operation.op || 'set';
  if (!['set', 'delete'].includes(kind)) throw new Error(`Unsupported state operation: ${kind}`);
  const path = operation.path.split('.').filter(Boolean);
  if (!path.length || path.length > 12 || path.some((part) => (
    part.length > 80 || FORBIDDEN_STATE_PATH_PARTS.has(part)
  ))) {
    throw new Error('Invalid state operation path');
  }
  const normalized = { op: kind, path: path.join('.') };
  if (kind === 'set') normalized.value = operation.value;
  return normalized;
}

export function applyStateDelta(state, delta, { expectedRevision } = {}) {
  if (!delta || delta.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error('Unsupported state delta schema');
  if (!Array.isArray(delta.operations) || delta.operations.length > MAX_DELTA_OPERATIONS) {
    throw new Error('Invalid state delta operations');
  }
  if (!Number.isInteger(delta.baseRevision) || delta.baseRevision < 0
      || !Number.isInteger(delta.revision) || delta.revision < 0) {
    throw new Error('Invalid state delta revision');
  }
  if (expectedRevision !== undefined && delta.baseRevision !== expectedRevision) {
    throw new Error(`State delta base revision ${delta.baseRevision} does not match ${expectedRevision}`);
  }
  const next = structuredCloneSafe(state);
  for (const rawOperation of delta.operations) {
    const operation = normalizeOperation(rawOperation);
    const parts = operation.path.split('.');
    let cursor = next;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!isSafeStateContainer(cursor)) throw new Error('State delta traverses a non-object value');
      if (!Object.prototype.hasOwnProperty.call(cursor, part)
          || !isSafeStateContainer(cursor[part])) cursor[part] = {};
      cursor = cursor[part];
    }
    if (!isSafeStateContainer(cursor)) throw new Error('State delta targets a non-object value');
    const key = parts[parts.length - 1];
    if (operation.op === 'delete') delete cursor[key];
    else cursor[key] = structuredCloneSafe(operation.value);
  }
  return { state: next, revision: delta.revision };
}

function isSafeStateContainer(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split an oversized payload into envelope-sized pieces.
 *
 * The chunk size is the message ceiling less room for the envelope around it and
 * for base64, which costs a third on top of the bytes it carries. Picking the
 * ceiling itself would produce chunks that are individually too large to send,
 * which is the failure this exists to prevent.
 */
export const CHUNK_PAYLOAD_BYTES = 8 * 1024;

export function chunkString(value, { chunkBytes = CHUNK_PAYLOAD_BYTES, transferId = `transfer-${Date.now()}` } = {}) {
  const bytes = new TextEncoder().encode(String(value));
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const part = bytes.slice(offset, Math.min(bytes.length, offset + chunkBytes));
    chunks.push({ transferId, index: chunks.length, total: Math.ceil(bytes.length / chunkBytes), data: toBase64(part) });
  }
  return chunks;
}

export function reassembleChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return '';
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const transferId = ordered[0].transferId;
  const total = ordered[0].total;
  if (!transferId || !Number.isInteger(total) || total < 1 || ordered.length !== total
      || ordered.some((part, index) => part.transferId !== transferId || part.index !== index || part.total !== total)) {
    throw new Error('Incomplete or mixed state chunks');
  }
  const bytes = new Uint8Array(ordered.reduce((sum, part) => sum + fromBase64(part.data).length, 0));
  let offset = 0;
  for (const part of ordered) {
    const data = fromBase64(part.data);
    bytes.set(data, offset);
    offset += data.length;
  }
  return new TextDecoder().decode(bytes);
}

function toBase64(bytes) {
  if (typeof btoa === 'function') {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value) {
  if (typeof atob === 'function') {
    const text = atob(value);
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

export function isSafePlayerIntent(payload) {
  return !!payload && typeof payload.intentId === 'string' && payload.intentId.length <= 80
    && typeof payload.kind === 'string' && payload.kind.length <= 48
    && byteLength(payload) <= 8 * 1024;
}

export function normalizeDeparture(value) {
  if (!value || typeof value !== 'object') return null;
  if (!value.regionId || !value.regionCode || !value.regionName) return null;
  if (!isCompatibleProtocol(value)) return null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    regionId: String(value.regionId).slice(0, 96),
    regionCode: String(value.regionCode).slice(0, 16),
    regionName: String(value.regionName).slice(0, 48),
    ownerName: String(value.ownerName || 'Traveller').slice(0, 28),
    population: Math.max(0, Math.min(MAX_VISITORS + 1, Number(value.population) || 1)),
    capacity: Math.max(1, Math.min(MAX_VISITORS, Number(value.capacity) || MAX_VISITORS)),
    status: ['boarding', 'open', 'departed'].includes(value.status) ? value.status : 'open',
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}
