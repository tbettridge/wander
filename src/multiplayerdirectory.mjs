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

export const HOST_TOKEN_STORAGE_KEY = 'wander.multiplayer.hostTokens.v1';

function asStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  if (storage === null) return null;
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* blocked */ }
  return null;
}

/** Client for the tiny public departures/signaling directory. */
export class DepartureDirectoryClient {
  constructor({
    endpoint = globalThis.WANDER_DEPARTURES_URL || DEFAULT_DIRECTORY_PATH,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    storage,
    logger = console,
  } = {}) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.storage = asStorage(storage);
    this.logger = logger || console;
    this.listing = null;
    this.hostToken = null;
    this.heartbeatTimer = null;
  }

  /**
   * The tokens that prove this browser owns the regions it has listed.
   *
   * A region id is derived from the browser's own identity and seed, so the same
   * browser always asks for the same one — but the board holds a listing for a
   * minute after the page goes away, and the token that proved ownership died
   * with the page. Reloading therefore collided with the host's own ghost and
   * came back "departure is already hosted" until the listing aged out. Keeping
   * the token means a reload reclaims its listing instead of queueing behind it.
   */
  _rememberedTokens() {
    try { return JSON.parse(this.storage?.getItem(HOST_TOKEN_STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  _rememberToken(regionId, token) {
    if (!this.storage || !regionId) return;
    const tokens = this._rememberedTokens();
    if (token) tokens[regionId] = token; else delete tokens[regionId];
    try { this.storage.setItem(HOST_TOKEN_STORAGE_KEY, JSON.stringify(tokens)); } catch { /* optional */ }
  }

  hostTokenFor(regionId) {
    return this.hostToken || this._rememberedTokens()[regionId] || null;
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
    // Present the remembered token so a reload reclaims its own listing rather
    // than being refused as a second host of it.
    const remembered = this.hostTokenFor(normalized.regionId);
    const body = await fetchJson(this.fetchImpl, withPath(this.endpoint, `${DIRECTORY_API_VERSION}/departures`), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(remembered ? { 'x-wander-host-token': remembered } : {}),
      },
      body: JSON.stringify(normalized),
    });
    this.listing = normalizeDeparture(body?.departure || normalized);
    this.hostToken = typeof body?.hostToken === 'string' ? body.hostToken : null;
    this._rememberToken(this.listing?.regionId, this.hostToken);
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
      this._rememberToken(this.listing?.regionId, null);
      this.listing = null;
      this.hostToken = null;
    }
  }

  startHeartbeat(intervalMs = 20_000) {
    this.stopHeartbeat();
    if (typeof setInterval !== 'function') return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((error) => this._heartbeatFailed(error, intervalMs));
    }, intervalMs);
  }

  /**
   * A heartbeat that cannot find its listing has to do something about it.
   *
   * This used to log "heartbeat stopped" and stop nothing, so a listing that had
   * aged off the board left the interval beating against a 404 every twenty
   * seconds for the rest of the session — filling the console while the region
   * stayed invisible to everyone. The host is still hosting when this happens,
   * so the useful answer is to put the region back rather than to give up: one
   * re-registration, which restarts the heartbeat on success. Anything else is a
   * transport problem the next beat may well survive, so it is only reported.
   */
  _heartbeatFailed(error, intervalMs) {
    if (!/not found/i.test(error?.message || '')) {
      this.logger.warn?.('[departures] heartbeat failed', error);
      return;
    }
    this.stopHeartbeat();
    const departure = this.listing;
    if (!departure) return;
    // The token died with the listing, so do not present a stale one.
    this.hostToken = null;
    this._rememberToken(departure.regionId, null);
    this.register(departure, { heartbeat: true })
      .then(() => this.logger.info?.('[departures] listing had expired · re-registered'))
      .catch((cause) => this.logger.warn?.('[departures] listing expired and could not be restored', cause));
    void intervalMs;
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
      if (onOpen) socket.addEventListener('open', onOpen);
      if (onClose) socket.addEventListener('close', onClose);
      if (onError) socket.addEventListener('error', onError);
      if (onMessage) socket.addEventListener('message', handleMessage);
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
