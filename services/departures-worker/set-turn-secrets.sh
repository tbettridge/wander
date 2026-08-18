#!/usr/bin/env bash
# Store the Cloudflare TURN key as Worker secrets.
#
# The values are typed in by you and handed straight to Cloudflare — they are
# never written to this repository, which is public, and never printed here.
# A TURN key can mint unlimited relay credentials, so it must not live in the
# page: the Worker holds it and issues short-lived credentials per session.
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER="$(command -v wrangler || true)"
if [ -z "$WRANGLER" ]; then
  for candidate in "$HOME"/.npm/_npx/*/node_modules/.bin/wrangler; do
    [ -x "$candidate" ] && WRANGLER="$candidate" && break
  done
fi
[ -z "$WRANGLER" ] && { echo "wrangler not found — run: npm i -g wrangler"; exit 1; }

echo
echo "1/2 — paste the API Token, then press Enter:"
"$WRANGLER" secret put TURN_API_TOKEN

echo
echo "2/2 — paste the Turn Token ID, then press Enter:"
"$WRANGLER" secret put TURN_KEY_ID

echo
echo "Deploying…"
"$WRANGLER" deploy

echo
echo "Done. Checking the relay endpoint:"
curl -s https://wander-departures.departures-worker.workers.dev/v1/turn | head -c 400
echo
