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

## Verification

Pure protocol, ticket, transit, runtime-boundary, and directory tests live in
`tests/multiplayer.mjs` and `tests/interregional.mjs`. The existing suite
continues to run with the legacy `player:local` default. A browser smoke test
should show the Departures panel, offline fallback, and no console errors when
the Worker is not deployed.
