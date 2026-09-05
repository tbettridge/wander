# WANDER peer-hosted multiplayer

WANDER's multiplayer shell is desktop-first and direct-only. A browser keeps a
local pseudonymous identity, hosts its deterministic region, and exchanges
gameplay with visitors over WebRTC data channels. The optional directory under
`services/departures-worker/` is only a short-lived public board and signaling
relay; it never receives terrain, dialogue, knowledge-graph, or player-state
packets.

## What is implemented

- Stable browser-local identity and deterministic region name/code/id in
  `src/multiplayeridentity.mjs`.
- A crypto-random home-world seed assigned once per browser and persisted in
  local storage; explicit `?wanderSeed=…` values are temporary overrides. The
  seed is part of each region's private ticket handoff, so approved visits can
  resolve the host's deterministic landscape without publishing it on the
  departures board.
- Versioned envelopes, compact poses, snapshots/deltas, chunking, and payload
  limits in `src/multiplayerprotocol.mjs`.
- Direct WebRTC with Cloudflare STUN and no TURN fallback in
  `src/multiplayerpeer.mjs`.
- Public Departures board client and an in-memory fallback in
  `src/multiplayerdirectory.mjs`.
- Host approval, visitor limits, ticket phases, return-home contract, and
  compact motion fan-out in `src/multiplayer.mjs`.
- WebSocket-open signal queuing, approval-gated signaling, contiguous guest
  state projection/resync, and public knowledge-graph projection in
  `src/multiplayer.mjs` / `src/multiplayerauthority.mjs`.
- A station-keeper ticket action (`I` when standing near a station keeper) and
  a red two-carriage interregional commuter in
  `src/interregionaltrain.js` / `src/interregionaltransit.mjs`.
- Seed-scoped runtime handoffs and a replaceable runtime boundary in
  `src/worldruntime.mjs`.
- Live arrival replacement: terrain workers, landmarks, weather, wildlife,
  rail service, settlements, and the local narrative ledger are reseeded in
  place when the red commuter arrives; the home seed/state is restored on the
  return journey (`H`).
- Browser-local living-world save scope with migration from `player:local` in
  `src/livingworldstate.mjs` and `src/stationkeeper.js`.

## Directory deployment

The directory is optional. Deploy it only when a public board is desired:

```sh
cd services/departures-worker
npx wrangler deploy
```

Then define the Worker origin before `src/main.js` loads:

```html
<script>
  globalThis.WANDER_DEPARTURES_URL = 'https://your-worker.example.workers.dev';
</script>
```

When the endpoint is absent, WANDER remains fully playable as a private
single-player region and the landing screen explains that the board is offline.

## Optional relay for peers that cannot connect directly

Direct is the default and stays the default. But between a tenth and a fifth of
peers cannot establish a direct connection at all — about one in ten sits behind
a NAT that maps each destination separately, and restrictive mobile and corporate
networks raise that share. Those visits previously failed with no explanation.

A relay may be supplied, and is used **only after the direct path has already
failed**, so a player who can connect directly never routes traffic through
anyone.

Credentials are **never placed in this repository**. A TURN key is a long-term
secret that can mint unlimited credentials, and this page is served publicly from
`main` — anything embedded in the HTML is published with it, and anyone could
then spend the relay quota it pays for. Instead the key lives as a Worker secret
and the Worker mints a short-lived credential per session:

```sh
cd services/departures-worker
npx wrangler secret put TURN_KEY_ID       # paste the key id, then Enter
npx wrangler secret put TURN_API_TOKEN    # paste the API token, then Enter
npx wrangler deploy
```

Create the key at **Cloudflare dashboard → Realtime → TURN Keys**. The browser
receives only `GET /v1/turn`, which returns credentials that expire after an
hour. With no secret set the endpoint answers with an empty list, the client
stays direct-only, and a failed visit says that no relay is configured.

The escalation is: direct → one ICE restart → relay (if configured) → stop and
explain. A connection that merely dropped keeps its seat, its approval and its
avatar while it is rebuilt.

## Connection and privacy rules

1. A destination is selected from Departures, then the player asks the station
   keeper for a ticket.
2. The destination host receives an admission request and explicitly approves
   or declines it.
3. Only after approval are offers/candidates released and the direct WebRTC
   connection attempted.
4. Control/state channels are reliable and ordered; motion is ordered=false
   with `maxRetransmits: 0`.
5. A host can have at most three visitors. No voice channel or free-form player
   chat is opened by this layer.
6. A destination seed and arrival-station coordinates are sent only inside the
   approved signaling/ticket flow, never on the public board.
7. The directory relay validates host/guest message direction and requires
   addressed approval and peer-signal packets; it never accepts world state.
8. Guests receive only the host's public projection (including public narrative
   facts), never private memories, holdings, or raw canonical state.

## Verification

Run `node --test tests/multiplayer*.mjs tests/interregional.mjs` for the
multiplayer regression suite. `tests/multiplayertransport.mjs` exercises
disconnect recovery, relay ICE restarts, cancelled retries, snapshot backpressure,
listing-token renewal, signaling after Durable Object hibernation, and the shared
broadcast clock. Reliable state messages are queued in full and drained as the
data channel becomes writable; relay fallback updates the existing connection's
ICE configuration so its negotiated identity and channels survive.

Changes to `services/departures-worker/src/index.js` require a Worker deployment
in addition to publishing the browser files. Local browser verification of the
transport repair covered three direct data channels, a 420 KB snapshot, and
TURN fallback with direct candidates deliberately withheld.

Pure protocol, ticket, transit, runtime-boundary, and directory tests live in
`tests/multiplayer.mjs` and `tests/interregional.mjs`. The existing suite
continues to run with the legacy `player:local` default. A browser smoke test
should show the Departures panel, offline fallback, and no console errors when
the Worker is not deployed.
