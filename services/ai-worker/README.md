# WANDER AI gateway

This separate Cloudflare Worker sends NPC dialogue, quest prompts and memory
summaries to OpenRouter's `qwen/qwen3.7-flash`. The departures/signaling Worker
remains separate. The browser never receives the OpenRouter key.
NPC speech uses Gemini 3.8 Flash TTS through the same gateway. Presets use
OpenRouter; designed regional voices use the Google project that owns them.

## Local setup

From this directory, copy `.dev.vars.example` to `.dev.vars` and replace the
placeholder locally. `.dev.vars` is ignored by Git. Run:

```sh
npx wrangler dev --port 8788
```

Before WANDER's main module loads, set the public gateway address:

```html
<script>globalThis.WANDER_AI_URL = 'http://localhost:8788';</script>
```

Alternatively, route `/api/ai/*` on the game's origin to this Worker; that is
the client's default path. Static Python/GitHub Pages hosting does not provide
this route. The debug panel's **Living World AI → provider** defaults to
**Qwen · OpenRouter**, with **Local · Chrome Nano** as the other option. Both the
provider choice and AI enabled preference persist in browser storage.

## Production setup

The deployed gateway is `https://wander-ai.departures-worker.workers.dev`.
The game configures this public address in `index.html`; its allowed production
origin is `https://tbettridge.github.io`, alongside the local development origins.
`OPENROUTER_API_KEY` is stored as a Cloudflare Worker secret.

Set `ALLOWED_ORIGINS` in `wrangler.toml` to the exact game origins (comma-separated,
no trailing slash), then configure the secret interactively and deploy:

```sh
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler deploy
```

Set `WANDER_AI_URL` to the resulting HTTPS Worker URL or configure the same-origin
route. Use a dedicated OpenRouter API key with its own credit limit. Do not put
the provider key in HTML, client JavaScript, browser storage, or debug controls.

This is an anonymous game endpoint, not a player authentication system. Origin
checks limit browser access; they do not authenticate non-browser callers.
Persistent server-side controls bound paid usage: 30 requests per client IP per
minute, 1,200 total per minute, 10,000 per UTC day, and 32 MB of incoming prompt
JSON per UTC day by default. Change the variables above as traffic grows. They
are gateway controls, not OpenRouter's model quota or an exact dollar budget.
Failed provider attempts count toward the budget. The byte cap is not TPM.

The models are fixed server-side. Thinking is disabled; structured dialogue
output is capped at 650 tokens (legacy prose at 350) and quest/memory output at 1,600. JSON requests use JSON-object
mode with a schema instruction because this endpoint advertises JSON mode,
not strict schema support. The game retains its authoritative target, memory
and narrative-claim validation. Invalid JSON, incomplete output, missing setup,
rate limits and provider failures use the existing authored fallbacks. It never
silently downloads the local model; select that explicitly in the debug panel.

`GET /health` checks configuration without calling OpenRouter or consuming
inference credits. `POST /chat` accepts bounded message history and an optional
JSON schema. Request bodies and upstream error messages are not logged/returned.

`POST /speech` accepts an NPC ID, preset voice, optional allowlisted cast slot,
transcript (up to 1,200 characters)
and a short delivery style. The server fixes Gemini Flash and 24 kHz mono PCM;
clients cannot choose a different model. Speech has its own persistent budget:
20 requests per client IP/minute, 600 total/minute, 5,000 per day and 2 MB of
incoming JSON/day. `SPEECH_*` variables configure these limits. Output is bounded
to 6 MB and each upstream attempt to 35 seconds. One generated reply may contain
several delivery segments and use several speech requests. Closing, sending a
new message or disabling voices cancels pending speech and playback. Provider
failure leaves the text visible. **NPC voices · Gemini Flash** in the debug panel
is enabled by default and its preference persists independently of the LLM choice.

See [character voice profiles and Google prompting guidance](../../docs/npc-speech.md).
`NPC_VOICES_JSON` optionally maps canonical NPC IDs to pre-created `voice_...` IDs.
With `GEMINI_API_KEY` set, those overrides use Google directly. Without it they
retain the legacy OpenRouter route and require matching provider/project access.
The public gateway does not create or clone voices.

## Regional voice cast

Google's [Voice Design API](https://ai.google.dev/gemini-api/docs/voice-design)
defines permanent age, gender, timbre and accent once. Designed IDs are scoped
to their Google project; OpenRouter's shared credentials cannot automatically
access your project's voices. Configure the Google key as a Worker secret:

```sh
npx wrangler secret put GEMINI_API_KEY
```

From this directory, the administrative script prints its 144 fixed cast prompts
without making requests by default. Creation requires `--create` and a
`GEMINI_API_KEY` environment variable from the same Google project:

```sh
node scripts/design-voices.mjs
node scripts/design-voices.mjs --create --keys=yorkshire:female:elder:0,london:male:adult:0
node scripts/design-voices.mjs --create
npx wrangler secret put NPC_VOICE_BANK_JSON < .voice-bank.json
```

Creation saves `.voice-bank.json` after every voice and WAV samples under
`voice-previews/`; both are ignored by Git. Re-running resumes completed slots.
Audition samples before filling the entire bank. Google's project storage cap
is 200 stateful voices, shared with other designed/replicated voices, so existing
voices also count. Stored voices have a one-year TTL; plan to refresh or replace
expired entries. This script is an administrator operation, never a browser
request or part of public game startup.

The gateway chooses only preconfigured IDs for allowlisted slots, reuses each
voice, and keeps the same budgets, timeout and PCM bounds on direct Google
synthesis. Missing key, missing slot or malformed mappings use the gender-matched
preset fallback. Provider errors leave chat text visible. Exact accents and
child/senior sound are pending until the project cast is created and auditioned;
preset voices provide varied male/female identities immediately.

The gateway receives the compact NPC context and conversation text; OpenRouter
and its Alibaba provider process that data. Local Chrome mode keeps model
inference on the player's device.
Enabled NPC speech sends the spoken transcript and delivery style to OpenRouter
and Google (or directly to your Google project for designed voices) even when
the local LLM is selected. Disable NPC voices for text-only
local conversations.
