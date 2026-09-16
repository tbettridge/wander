// Lossless, bounded JSON packaging for the immutable watershed descriptors.
//
// The descriptor intentionally remains the public, readable representation.
// This module only changes the wire representation: repeated arrays and plain
// objects are placed in a dictionary and occurrences become references.  No
// terrain is re-sampled and no numeric field is quantised.
import {
  WATERSHED_DESCRIPTOR_VERSION,
  validateWatershedDescriptor,
} from './watersheddescriptor.mjs';

export const WATERSHED_DESCRIPTOR_PACK_FORMAT = 'watershed-descriptor-pack';
export const WATERSHED_DESCRIPTOR_PACK_VERSION = 1;

// These ceilings apply to both sides of the wire.  A caller can lower them for
// an untrusted transport, but cannot provide an invalid or unbounded budget.
export const WATERSHED_PACK_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxExpandedBytes: 16 * 1024 * 1024,
  maxNodes: 200_000,
  maxReferences: 1_000_000,
  maxDepth: 256,
  maxArrayLength: 1_000_000,
  maxObjectKeys: 100_000,
  maxStringLength: 4 * 1024 * 1024,
});

const REF_KEY = '\u0000r';
const NEGATIVE_ZERO_KEY = '\u0000n';
const TEXT_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function byteLength(value) {
  const text = String(value);
  return TEXT_ENCODER ? TEXT_ENCODER.encode(text).length : text.length;
}

function jsonLength(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Watershed pack contains an unsupported value');
  return byteLength(text);
}

function fail(message) {
  throw new TypeError(`Invalid watershed descriptor pack: ${message}`);
}

function budget(name) {
  throw new RangeError(`Watershed descriptor pack budget exceeded: ${name}`);
}

function normalizeLimits(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid watershed descriptor pack options');
  }
  const limits = { ...WATERSHED_PACK_LIMITS };
  if (Object.hasOwn(options, 'maxBytes')) {
    const value = options.maxBytes;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError('Invalid watershed descriptor pack budget: maxBytes');
    }
    limits.maxInputBytes = value;
    limits.maxOutputBytes = value;
    limits.maxExpandedBytes = value;
  }
  const aliases = {
    maxExpanded: 'maxExpandedBytes',
    maxRefs: 'maxReferences',
    maxArrayEntries: 'maxArrayLength',
    maxObjectEntries: 'maxObjectKeys',
  };
  for (const key of Object.keys(options)) {
    const target = aliases[key] || key;
    if (!(target in limits)) continue;
    const value = options[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Invalid watershed descriptor pack budget: ${key}`);
    }
    limits[target] = value;
  }
  return limits;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkKey(key, path, limits) {
  if (key.startsWith('\u0000')) fail(`reserved key at ${path}.${key}`);
  if (byteLength(key) > limits.maxStringLength) budget('maxStringLength');
}

function ownKeys(value, path, limits) {
  if (Object.getOwnPropertySymbols(value).length) fail(`symbol key at ${path}`);
  const keys = Object.keys(value);
  if (keys.length > limits.maxObjectKeys) budget('maxObjectKeys');
  for (const key of keys) checkKey(key, path, limits);
  return keys;
}

function checkArray(value, path, limits) {
  if (value.length > limits.maxArrayLength) budget('maxArrayLength');
  if (Object.getOwnPropertySymbols(value).length) fail(`symbol property at ${path}`);
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    fail(`sparse or extra array property at ${path}`);
  }
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`non-enumerable or extra array property at ${path}`);
  }
}

function primitiveKey(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value ? 1 : 0}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite number');
    return `number:${Object.is(value, -0) ? '-0' : JSON.stringify(value)}`;
  }
  fail(`unsupported ${typeof value}`);
}

// Stable structural keys let separately allocated but equal shoreline values
// share one dictionary entry.  A WeakMap avoids walking an aliased subtree
// repeatedly while the active set still rejects cycles.
function structuralKey(value, limits, cache = new WeakMap(), active = new Set(), depth = 0, path = '$') {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && byteLength(value) > limits.maxStringLength) budget('maxStringLength');
    return primitiveKey(value);
  }
  if (depth > limits.maxDepth) budget('maxDepth');
  if (cache.has(value)) return cache.get(value);
  if (active.has(value)) fail(`cyclic value at ${path}`);
  active.add(value);
  let result;
  if (Array.isArray(value)) {
    checkArray(value, path, limits);
    result = `array:[${value.map((child, index) => structuralKey(child, limits, cache, active, depth + 1, `${path}[${index}]`)).join(',')}]`;
  } else {
    if (!isPlainObject(value)) fail(`non-plain object at ${path}`);
    const keys = ownKeys(value, path, limits).sort();
    result = `object:{${keys.map(key => `${JSON.stringify(key)}:${structuralKey(value[key], limits, cache, active, depth + 1, `${path}.${key}`)}`).join(',')}}`;
  }
  active.delete(value);
  cache.set(value, result);
  return result;
}

function collectValues(root, limits) {
  const cache = new WeakMap();
  const counts = new Map();
  const active = new Set();
  let occurrences = 0;

  const walk = (value, depth, path) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && byteLength(value) > limits.maxStringLength) budget('maxStringLength');
      primitiveKey(value);
      return;
    }
    if (depth > limits.maxDepth) budget('maxDepth');
    const key = structuralKey(value, limits, cache);
    const record = counts.get(key);
    if (record) record.count++;
    else counts.set(key, { key, value, count: 1 });
    occurrences++;
    if (occurrences > limits.maxNodes * 16) budget('maxNodes');
    // Count every occurrence, including aliases.  This is needed to decide
    // whether a reference saves bytes in the serialized tree.
    if (active.has(value)) fail(`cyclic value at ${path}`);
    active.add(value);
    if (Array.isArray(value)) {
      checkArray(value, path, limits);
      for (let i = 0; i < value.length; i++) walk(value[i], depth + 1, `${path}[${i}]`);
    } else {
      for (const keyName of ownKeys(value, path, limits)) walk(value[keyName], depth + 1, `${path}.${keyName}`);
    }
    active.delete(value);
  };

  walk(root, 0, '$');
  return { counts, cache };
}

function shouldIntern(record) {
  if (record.count < 2) return false;
  // A reference marker plus a dictionary slot has a fixed cost.  Avoid making
  // a tiny two-use object larger while still interning the repeated arrays and
  // shoreline records that dominate real watershed descriptors.
  const referenceCost = 12;
  const dictionaryCost = 18;
  return (record.count - 1) * record.key.length > record.count * referenceCost + dictionaryCost;
}

function makeDictionary(counts) {
  const entries = [...counts.values()].filter(shouldIntern)
    .sort((a, b) => a.key.localeCompare(b.key));
  const ids = new Map(entries.map((entry, index) => [entry.key, index]));
  return { entries, ids };
}

function encodeTree(root, dictionary, limits) {
  let references = 0;
  const encode = (value, forcedKey = null, depth = 0) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('non-finite number');
        if (Object.is(value, -0)) return { [NEGATIVE_ZERO_KEY]: true };
      } else if (typeof value === 'string' && byteLength(value) > limits.maxStringLength) {
        budget('maxStringLength');
      } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
        fail(`unsupported ${typeof value}`);
      }
      return value;
    }
    if (depth > limits.maxDepth) budget('maxDepth');
    const key = structuralKey(value, limits);
    const id = dictionary.ids.get(key);
    if (id !== undefined && key !== forcedKey) {
      if (++references > limits.maxReferences) budget('maxReferences');
      return { [REF_KEY]: id };
    }
    if (Array.isArray(value)) {
      checkArray(value, '$', limits);
      return value.map(child => encode(child, null, depth + 1));
    }
    const result = {};
    for (const keyName of ownKeys(value, '$', limits)) result[keyName] = encode(value[keyName], null, depth + 1);
    return result;
  };

  const nodes = dictionary.entries.map(entry => encode(entry.value, entry.key, 0));
  const rootEncoded = encode(root, null, 0);
  if (nodes.length > limits.maxNodes) budget('maxNodes');
  return { root: rootEncoded, dictionary: nodes, references };
}

function markerId(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== REF_KEY) return null;
  const id = value[REF_KEY];
  return Number.isSafeInteger(id) ? id : NaN;
}

function isNegativeZeroMarker(value) {
  return isPlainObject(value) && Object.keys(value).length === 1
    && Object.hasOwn(value, NEGATIVE_ZERO_KEY) && value[NEGATIVE_ZERO_KEY] === true;
}

function parseEnvelope(serialized, limits) {
  if (typeof serialized !== 'string') fail('serialized value must be a string');
  const serializedBytes = byteLength(serialized);
  if (serializedBytes > limits.maxInputBytes) budget('maxInputBytes');
  if (serializedBytes > limits.maxOutputBytes) budget('maxOutputBytes');
  let envelope;
  try { envelope = JSON.parse(serialized); } catch (error) {
    throw new TypeError(`Invalid watershed descriptor pack JSON: ${error.message}`);
  }
  if (!isPlainObject(envelope)
    || envelope.format !== WATERSHED_DESCRIPTOR_PACK_FORMAT
    || envelope.version !== WATERSHED_DESCRIPTOR_PACK_VERSION
    || envelope.descriptorVersion !== WATERSHED_DESCRIPTOR_VERSION
    || !Array.isArray(envelope.dictionary)
    || !Object.hasOwn(envelope, 'root')) {
    fail('unsupported format or version');
  }
  if (envelope.dictionary.length > limits.maxNodes) budget('maxNodes');
  return envelope;
}

function measureEnvelope(envelope, limits) {
  const dictionary = envelope.dictionary;
  const nodeMemo = new Map();
  const active = new Set();
  let references = 0;
  let nodes = 0;

  const measure = (value, depth, path) => {
    if (depth > limits.maxDepth) budget('maxDepth');
    if (value === null) return 4;
    if (typeof value === 'string') {
      if (byteLength(value) > limits.maxStringLength) budget('maxStringLength');
      return jsonLength(value);
    }
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(`non-finite number at ${path}`);
      return jsonLength(value);
    }
    if (!value || typeof value !== 'object') fail(`unsupported value at ${path}`);
    if (isNegativeZeroMarker(value)) return 2;
    const id = markerId(value);
    if (id !== null) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= dictionary.length) {
        fail(`invalid dictionary reference at ${path}`);
      }
      references++;
      if (references > limits.maxReferences) budget('maxReferences');
      return measureNode(id, depth + 1, path);
    }
    if (Array.isArray(value)) {
      checkArray(value, path, limits);
      nodes++;
      if (nodes > limits.maxNodes) budget('maxNodes');
      let size = 2;
      for (let i = 0; i < value.length; i++) size += measure(value[i], depth + 1, `${path}[${i}]`) + (i ? 1 : 0);
      return size;
    }
    if (!isPlainObject(value)) fail(`non-plain encoded object at ${path}`);
    const keys = ownKeys(value, path, limits);
    nodes++;
    if (nodes > limits.maxNodes) budget('maxNodes');
    let size = 2;
    for (const key of keys) size += jsonLength(key) + 1 + measure(value[key], depth + 1, `${path}.${key}`);
    return size + Math.max(0, keys.length - 1);
  };

  const measureNode = (id, depth, path) => {
    if (nodeMemo.has(id)) return nodeMemo.get(id);
    if (active.has(id)) fail(`cyclic dictionary reference at ${path}`);
    active.add(id);
    const size = measure(dictionary[id], depth, `dictionary[${id}]`);
    active.delete(id);
    nodeMemo.set(id, size);
    return size;
  };

  // Validate every dictionary definition, including an unreachable one.  This
  // prevents an attacker from hiding a cyclic or out-of-range reference in an
  // otherwise ignored slot.
  for (let i = 0; i < dictionary.length; i++) measureNode(i, 0, `dictionary[${i}]`);
  const expandedBytes = measure(envelope.root, 0, 'root');
  if (expandedBytes > limits.maxExpandedBytes) budget('maxExpandedBytes');
  return { expandedBytes, references, nodes };
}

function decodeEnvelope(envelope, limits) {
  measureEnvelope(envelope, limits);
  const dictionary = envelope.dictionary;
  const decodedNodes = new Array(dictionary.length);
  const active = new Set();

  const decodeNode = (id, depth, path) => {
    if (decodedNodes[id] !== undefined) return decodedNodes[id];
    if (active.has(id)) fail(`cyclic dictionary reference at ${path}`);
    active.add(id);
    const decoded = decode(dictionary[id], depth, `dictionary[${id}]`);
    active.delete(id);
    decodedNodes[id] = decoded;
    return decoded;
  };

  const decode = (value, depth, path) => {
    if (depth > limits.maxDepth) budget('maxDepth');
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail(`non-finite number at ${path}`);
      if (typeof value === 'string' && byteLength(value) > limits.maxStringLength) budget('maxStringLength');
      return value;
    }
    if (isNegativeZeroMarker(value)) return -0;
    const id = markerId(value);
    if (id !== null) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= dictionary.length) fail(`invalid dictionary reference at ${path}`);
      return decodeNode(id, depth + 1, path);
    }
    if (Array.isArray(value)) {
      checkArray(value, path, limits);
      return value.map((child, index) => decode(child, depth + 1, `${path}[${index}]`));
    }
    if (!isPlainObject(value)) fail(`non-plain encoded object at ${path}`);
    const result = {};
    for (const key of ownKeys(value, path, limits)) result[key] = decode(value[key], depth + 1, `${path}.${key}`);
    return result;
  };

  const descriptor = decode(envelope.root, 0, 'root');
  if (!isPlainObject(descriptor)) fail('root is not a descriptor object');
  const validation = validateWatershedDescriptor(descriptor, { verifyHash: true });
  if (!validation.valid) fail(`descriptor validation failed: ${validation.errors.join(', ')}`);
  return freezeDeep(descriptor);
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) for (const child of value) freezeDeep(child, seen);
  else for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function buildEnvelope(descriptor, limits) {
  const sourceJson = JSON.stringify(descriptor);
  if (sourceJson === undefined) fail('descriptor is not JSON-serializable');
  if (byteLength(sourceJson) > limits.maxInputBytes) budget('maxInputBytes');
  const validation = validateWatershedDescriptor(descriptor, { verifyHash: true });
  if (!validation.valid) fail(`descriptor validation failed: ${validation.errors.join(', ')}`);
  const { counts } = collectValues(descriptor, limits);
  const dictionary = makeDictionary(counts);
  const encoded = encodeTree(descriptor, dictionary, limits);
  const envelope = {
    format: WATERSHED_DESCRIPTOR_PACK_FORMAT,
    version: WATERSHED_DESCRIPTOR_PACK_VERSION,
    descriptorVersion: WATERSHED_DESCRIPTOR_VERSION,
    root: encoded.root,
    dictionary: encoded.dictionary,
  };
  // Apply the decoder's structural ceilings during packing too.  This keeps a
  // caller from producing a packet that immediately fails when read back with
  // the same budget, and bounds the expanded alias fan-out before JSON output.
  measureEnvelope(envelope, limits);
  const serialized = JSON.stringify(envelope);
  if (byteLength(serialized) > limits.maxOutputBytes) budget('maxOutputBytes');
  return { envelope, serialized, dictionaryEntries: encoded.dictionary.length, references: encoded.references };
}

/** Return the versioned JSON envelope as a string. */
export function serializeWatershedDescriptor(descriptor, options = {}) {
  const limits = normalizeLimits(options);
  return buildEnvelope(descriptor, limits).serialized;
}

/** Parse, budget-check, checksum-check and freeze a packed descriptor. */
export function deserializeWatershedDescriptor(serialized, options = {}) {
  const limits = normalizeLimits(options);
  return decodeEnvelope(parseEnvelope(serialized, limits), limits);
}

/** Build an envelope and useful wire-size counters without serializing twice. */
export function watershedDescriptorPackStats(descriptor, options = {}) {
  const limits = normalizeLimits(options);
  const packed = buildEnvelope(descriptor, limits);
  const expandedBytes = byteLength(JSON.stringify(descriptor));
  return Object.freeze({
    sourceBytes: expandedBytes,
    packedBytes: byteLength(packed.serialized),
    dictionaryEntries: packed.dictionaryEntries,
    references: packed.references,
    savingsBytes: expandedBytes - byteLength(packed.serialized),
    savingsRatio: expandedBytes ? 1 - byteLength(packed.serialized) / expandedBytes : 0,
  });
}
