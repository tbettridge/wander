/*
 * WANDER departures + signaling directory.
 *
 * This Worker never receives a world snapshot or gameplay packet. Its only
 * responsibilities are a short-lived public board and an opaque WebSocket
 * relay for WebRTC offers/candidates. The Durable Object is intentionally
 * small enough for the Workers free plan and fails closed when a payload is
 * too large or a listing has expired.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECORDS = 500;
const LISTING_TTL_MS = 60_000;
const PROTOCOL_VERSION = 1;
const SIGNAL_KINDS = new Set(['admission-request', 'admission-response', 'peer-signal', 'ping', 'pong']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!url.pathname.startsWith('/v1/')) return json({ error: 'not found' }, 404, headers);
    const id = env.DIRECTORY.idFromName('public');
    const stub = env.DIRECTORY.get(id);
    const response = await stub.fetch(new Request(url, request));
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    return new Response(response.body, { status: response.status, headers: merged });
  },
};

export class DepartureDirectory {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
    this.records = new Map();
    this.loaded = this.load();
  }

  async load() {
    const saved = await this.storage.get('departures');
    if (!Array.isArray(saved)) return;
    const now = Date.now();
    for (const record of saved) {
      if (record?._expiresAt > now) this.records.set(record.regionId, record);
    }
  }

  async fetch(request) {
    await this.loaded;
    const url = new URL(request.url);
    this.prune();
    if (url.pathname === '/v1/departures' && request.method === 'GET') return this.list();
    if (url.pathname === '/v1/departures' && request.method === 'POST') return this.register(request);
    if (url.pathname.startsWith('/v1/departures/') && request.method === 'PATCH') {
      return this.heartbeat(request, decodeURIComponent(url.pathname.split('/').pop()));
    }
    if (url.pathname.startsWith('/v1/departures/') && request.method === 'DELETE') {
      return this.unregister(request, decodeURIComponent(url.pathname.split('/').pop()));
    }
    if (url.pathname === '/v1/signal' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.signal(request, url);
    }
    return json({ error: 'not found' }, 404);
  }

  list() {
    return json({ departures: [...this.records.values()].map(publicRecord) });
  }

  async register(request) {
    let body;
    try { body = await readJson(request); } catch (error) { return json({ error: error.message }, 413); }
    if (!body || body.protocolVersion !== PROTOCOL_VERSION || !body.regionId || !body.regionCode || !body.regionName) {
      return json({ error: 'invalid departure' }, 400);
    }
    const existing = this.records.get(String(body.regionId));
    if (existing && !this.authorized(request, existing)) {
      return json({ error: 'departure is already hosted' }, 409);
    }
    if (this.records.size >= MAX_RECORDS && !this.records.has(body.regionId)) {
      return json({ error: 'departures board is full' }, 429);
    }
    const hostToken = crypto.randomUUID();
    const record = {
      protocolVersion: PROTOCOL_VERSION,
      regionId: String(body.regionId).slice(0, 96),
      regionCode: String(body.regionCode).slice(0, 16),
      regionName: String(body.regionName).slice(0, 48),
      ownerName: String(body.ownerName || 'Traveller').slice(0, 28),
      population: clampInt(body.population, 1, 4, 1),
      capacity: clampInt(body.capacity, 1, 3, 3),
      status: ['open', 'boarding'].includes(body.status) ? body.status : 'open',
      updatedAt: Date.now(),
      _expiresAt: Date.now() + LISTING_TTL_MS,
      _hostToken: hostToken,
    };
    this.records.set(record.regionId, record);
    await this.persist();
    return json({ departure: publicRecord(record), hostToken });
  }

  async heartbeat(request, regionId) {
    const record = this.records.get(regionId);
    if (!record || !this.authorized(request, record)) return json({ error: 'not found' }, 404);
    let body;
    try { body = await readJson(request); } catch (error) { return json({ error: error.message }, 413); }
    if (body?.population !== undefined) record.population = clampInt(body.population, 1, 4, record.population);
    if (['open', 'boarding', 'departed'].includes(body?.status)) record.status = body.status;
    record.updatedAt = Date.now();
    record._expiresAt = Date.now() + LISTING_TTL_MS;
    await this.persist();
    return json({ departure: publicRecord(record) });
  }

  async unregister(request, regionId) {
    const record = this.records.get(regionId);
    if (!record || !this.authorized(request, record)) return json({ error: 'not found' }, 404);
    this.records.delete(regionId);
    await this.persist();
    return json({ ok: true });
  }

  async signal(request, url) {
    const regionId = url.searchParams.get('regionId');
    const playerId = url.searchParams.get('playerId');
    const token = url.searchParams.get('token');
    const record = this.records.get(regionId);
    if (!record || !playerId || !isValidPlayerId(playerId) || playerId.length > 96) return json({ error: 'region unavailable' }, 404);
    const isHost = token && token === record._hostToken;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    try { this.state.acceptWebSocket(server, [`region:${regionId}`]); }
    catch { server.accept?.(); }
    server.serializeAttachment?.({ regionId, playerId, isHost: !!isHost, token: isHost ? token : null });
    server.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: 'signal-ready', regionId, isHost: !!isHost }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const sender = socket.deserializeAttachment?.();
    if (!sender) return;
    const record = this.records.get(sender.regionId);
    if (!record || (sender.isHost && sender.token !== record._hostToken)) return;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return;
    let packet;
    try { packet = JSON.parse(text); } catch { return; }
    if (!packet || packet.protocolVersion !== PROTOCOL_VERSION || !SIGNAL_KINDS.has(packet.kind)) return;
    if (packet.from && packet.from !== sender.playerId) return;
    if (packet.kind === 'admission-request' && sender.isHost) return;
    if (packet.kind === 'admission-response' && !sender.isHost) return;
    if (packet.kind === 'admission-response' && !packet.to) return;
    if (packet.kind === 'peer-signal' && !packet.to) return;
    if (packet.kind === 'ping' || packet.kind === 'pong') {
      if (packet.to && packet.to === sender.playerId) return;
    }
    for (const peer of this.state.getWebSockets()) {
      const target = peer.deserializeAttachment?.();
      if (!target || target.regionId !== sender.regionId || target.playerId === sender.playerId) continue;
      if (packet.kind === 'admission-request' && !target.isHost) continue;
      if (packet.kind === 'admission-response' && target.isHost) continue;
      if (packet.kind === 'peer-signal' && target.isHost === sender.isHost) continue;
      if (packet.to && packet.to !== target.playerId) continue;
      if (!packet.to && packet.kind !== 'admission-request') continue;
      try { peer.send(JSON.stringify({ ...packet, from: sender.playerId })); } catch { /* peer closed */ }
    }
  }

  webSocketClose(socket) {
    try { socket.close(); } catch { /* already closed */ }
  }

  webSocketError(socket) {
    try { socket.close(); } catch { /* already closed */ }
  }

  authorized(request, record) {
    return request.headers.get('x-wander-host-token') === record._hostToken;
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.records) {
      if (record._expiresAt <= now) { this.records.delete(id); changed = true; }
    }
    if (changed) this.persist();
  }

  persist() {
    return this.storage.put('departures', [...this.records.values()]);
  }
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('payload too large');
  try { return JSON.parse(text); } catch { return null; }
}

function publicRecord(record) {
  const { _hostToken, _expiresAt, ...publicValue } = record;
  return publicValue;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function isValidPlayerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,96}$/.test(value);
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-wander-host-token',
    'cache-control': 'no-store',
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
