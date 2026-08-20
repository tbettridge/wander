/**
 * What changed between two projections, as delta operations.
 *
 * The host used to send a complete projection to every visitor every five
 * seconds whether anything had changed or not. Measured on a live connection
 * that was 79% of all traffic — 307 KB of state against 83 KB of movement over
 * twenty seconds — and on a world of four hundred residents a single snapshot is
 * 72 KiB while the delta describing the same tick is 166 bytes.
 *
 * Producing that diff is the whole job of this file. It is deliberately separate
 * from the authority so the awkward cases below can be tested directly.
 */

import { MAX_DELTA_OPERATIONS } from './multiplayerprotocol.mjs';

/** The protocol's own limits on a path: twelve segments, eighty characters each. */
const MAX_PATH_DEPTH = 12;
const MAX_SEGMENT_LENGTH = 80;

/**
 * A key that cannot survive the trip is a reason to send the whole thing.
 *
 * Delta paths are dot-joined and split again by the receiver, so a key that
 * itself contains a dot arrives as two segments and lands somewhere the host
 * never wrote — the same divergence that once split marker ids apart. Rather
 * than encode around it, a diff that meets one gives up and lets the caller send
 * a snapshot, which is always correct and merely larger.
 */
function isSafeSegment(key) {
  return !key.includes('.') && key.length <= MAX_SEGMENT_LENGTH;
}

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Arrays are compared whole: an index-wise diff is rarely smaller and never simpler. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff `next` against `previous`.
 *
 * Returns `{ operations }` when the change can be described, or `null` when it
 * cannot — too deep, too many operations, or a key that will not round-trip.
 * A null result is not an error: it means "send a snapshot instead".
 */
export function diffProjections(previous, next, { maxOperations = MAX_DELTA_OPERATIONS } = {}) {
  if (!isPlainRecord(previous) || !isPlainRecord(next)) return null;
  const operations = [];
  const walk = (before, after, prefix, depth) => {
    if (depth > MAX_PATH_DEPTH) return false;
    for (const key of Object.keys(after)) {
      if (!isSafeSegment(key)) return false;
      const path = prefix ? `${prefix}.${key}` : key;
      const a = before?.[key], b = after[key];
      if (sameValue(a, b)) continue;
      // Both sides plain records: descend, so one changed field does not resend
      // the whole branch. Anything else is replaced outright.
      if (isPlainRecord(a) && isPlainRecord(b)) {
        if (!walk(a, b, path, depth + 1)) return false;
      } else {
        if (operations.length >= maxOperations) return false;
        operations.push({ op: 'set', path, value: b });
      }
    }
    for (const key of Object.keys(before || {})) {
      if (Object.prototype.hasOwnProperty.call(after, key)) continue;
      if (!isSafeSegment(key)) return false;
      if (operations.length >= maxOperations) return false;
      operations.push({ op: 'delete', path: prefix ? `${prefix}.${key}` : key });
    }
    return true;
  };
  if (!walk(previous, next, '', 1)) return null;
  return { operations };
}
