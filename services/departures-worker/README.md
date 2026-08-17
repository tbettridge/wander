# WANDER departures directory

This optional Cloudflare Worker provides only the public departures board and
WebRTC signaling relay. It never carries terrain, knowledge-graph, dialogue,
or player-state traffic. The game still runs as a single-player experience if
the endpoint is absent.

From this directory, after authenticating Wrangler once:

```sh
npx wrangler deploy
```

Set the deployed URL in the app before loading WANDER:

```html
<script>globalThis.WANDER_DEPARTURES_URL = 'https://your-worker.example.workers.dev';</script>
```

The client calls `/v1/departures` and `/v1/signal`. The free, direct-only
configuration intentionally contains STUN but no TURN relay; if a peer cannot
establish a direct connection the visit fails closed and the player remains in
their own region.

