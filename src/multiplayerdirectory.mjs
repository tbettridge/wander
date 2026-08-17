import { normalizeDeparture } from './multiplayerprotocol.mjs';

export const DIRECTORY_API_VERSION = 'v1';
export const DEFAULT_DIRECTORY_PATH = '/api';
export const DEFAULT_LIST_TTL_SECONDS = 45;

function asUrl(value, fallback = DEFAULT_DIRECTORY_PATH) {
  try { return new URL(value || fallback, globalThis.location?.href || 'http://localhost/'); }
  catch { return new URL(fallback, 'http://localhost/'); }
}

function withPath(base, path) {
  const url = asUrl(base);
  const suffix = String(path).replace(/^\//, '');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix}`;
  return url;
}

async function fetchJson(fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');
  const response = await fetchImpl(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  let body = null;
  try { body = await response.json(); } catch { /* non-json error */ }
  if (!response.ok) throw new Error(body?.error || `Directory request failed (${response.status})`);
  return body;
}

/** Client for the tiny public departures/signaling directory. */
export class DepartureDirectoryClient {
  constructor({
    endpoint = globalThis.WANDER_DEPARTURES_URL || DEFAULT_DIRECTORY_PATH,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    logger = console,
  } = {}) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger || console;
    this.listing = null;
    this.hostToken = null;
    this.heartbeatTimer = null;
  }

  async list({ signal } = {}) {
    const body = await fetchJson(this.fetchImpl, withPath(this.endpoint, `${DIRECTORY_API_VERSION}/departures`), { signal });
    const departures = Array.isArray(body?.departures)
      ? body.departures.map(normalizeDeparture).filter(Boolean)
      : [];
    return departures.sort((a, b) => a.regionName.localeCompare(b.regionName));
  }

  async register(departure, { signal, heartbeat = true } = {}) {
    const normalized = normalizeDeparture({ ...departure, status: departure.status || 'open' });
    if (!normalized) throw new Error('Cannot publish an invalid departure');
    const body = await fetchJson(this.fetchImpl, withPath(this.endpoint, `${DIRECTORY_API_VERSION}/departures`), {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    this.listing = normalizeDeparture(body?.departure || normalized);
    this.hostToken = typeof body?.hostToken === 'string' ? body.hostToken : null;
    if (heartbeat) this.startHeartbeat();
    return { departure: this.listing, hostToken: this.hostToken };
  }

  async heartbeat({ population, status, signal } = {}) {
    if (!this.listing) return null;
    const body = await fetchJson(this.fetchImpl, withPath(this.endpoint, `${DIRECTORY_API_VERSION}/departures/${encodeURIComponent(this.listing.regionId)}`), {
      method: 'PATCH',
      signal,
      headers: { 'content-type': 'application/json', ...(this.hostToken ? { 'x-wander-host-token': this.hostToken } : {}) },
      body: JSON.stringify({ population, status }),
    });
    this.listing = normalizeDeparture(body?.departure || { ...this.listing, population, status, updatedAt: Date.now() });
    return this.listing;
  }

  async unregister({ signal } = {}) {
    if (!this.listing) return;
    try {
      await fetchJson(this.fetchImpl, withPath(this.endpoint, `${DIRECTORY_API_VERSION}/departures/${encodeURIComponent(this.listing.regionId)}`), {
        method: 'DELETE', signal,
        headers: this.hostToken ? { 'x-wander-host-token': this.hostToken } : {},
      });
    } finally {
      this.stopHeartbeat();
      this.listing = null;
      this.hostToken = null;
    }
  }

  startHeartbeat(intervalMs = 20_000) {
    this.stopHeartbeat();
    if (typeof setInterval !== 'function') return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((error) => this.logger.warn?.('[departures] heartbeat stopped', error));
    }, intervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  openSignalSocket({ regionId, playerId, token, onMessage, onOpen, onClose, onError } = {}) {
    if (typeof this.WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable');
    if (!regionId || !playerId) throw new Error('A signaling socket needs a region and player id');
    const base = withPath(this.endpoint, `${DIRECTORY_API_VERSION}/signal`);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.search = new URLSearchParams({ regionId, playerId, ...(token ? { token } : {}) }).toString();
    const socket = new this.WebSocketImpl(base.toString());
    const handleMessage = (event) => {
      let message;
      try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; }
      catch (error) { onError?.(error); return; }
      onMessage?.(message);
    };
    // Minimal WebSocket shims used by embedded WebViews sometimes only expose
    // on* properties. Assigning both keeps the client portable.
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
      socket.addEventListener('message', handleMessage);
    } else {
      if (onOpen) socket.onopen = onOpen;
      if (onClose) socket.onclose = onClose;
      if (onError) socket.onerror = onError;
      if (onMessage) socket.onmessage = handleMessage;
    }
    return socket;
  }

  static exportSignalBundle(signals) {
    return JSON.stringify({ version: 1, signals: Array.isArray(signals) ? signals : [signals] });
  }

  static importSignalBundle(value) {
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error('Signal bundle is not valid JSON'); }
    if (parsed?.version !== 1 || !Array.isArray(parsed.signals) || parsed.signals.length > 32) {
      throw new Error('Unsupported signal bundle');
    }
    return parsed.signals;
  }
}

/** Deterministic in-memory directory for local development and unit tests. */
export class InMemoryDepartureDirectory {
  constructor({ clock = () => Date.now(), ttlMs = 60_000 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.records = new Map();
  }

  register(departure) {
    const normalized = normalizeDeparture({ ...departure, updatedAt: this.clock() });
    if (!normalized) throw new Error('Cannot publish an invalid departure');
    const record = { ...normalized, _expiresAt: this.clock() + this.ttlMs };
    this.records.set(record.regionId, record);
    return { departure: stripPrivate(record), hostToken: `memory:${record.regionId}` };
  }

  list() {
    this.prune();
    return [...this.records.values()].map(stripPrivate).sort((a, b) => a.regionName.localeCompare(b.regionName));
  }

  heartbeat(regionId, patch = {}) {
    this.prune();
    const current = this.records.get(regionId);
    if (!current) return null;
    const next = normalizeDeparture({ ...current, ...patch, updatedAt: this.clock() });
    this.records.set(regionId, { ...next, _expiresAt: this.clock() + this.ttlMs });
    return stripPrivate(next);
  }

  unregister(regionId) { this.records.delete(regionId); }

  prune() {
    const now = this.clock();
    for (const [id, value] of this.records) if (value._expiresAt <= now) this.records.delete(id);
  }
}

function stripPrivate(record) {
  const { _expiresAt, ...publicRecord } = record;
  return publicRecord;
}
