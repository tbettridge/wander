# NPC semantic knowledge retrieval

Open the debug menu and expand **NPC knowledge retrieval**. **Embeddings enabled** starts off, retaining current graph and word retrieval. Turn it on to add semantic matches, and select **Qwen3 Embedding · 0.6B** or **Gemini Embedding · 2** in **embedding model**. The selected model is remembered even when embeddings are off. Explicit opt-in and model preferences persist locally and are independent of the dialogue model. Older provider-only preferences start off after migration.

With embeddings on, enable **compare both providers** to evaluate the same question with both embedders while the selected provider supplies the NPC context. Turning embeddings off also disables automatic comparison and prevents further background indexing batches; an already-started request may finish. Comparison can add latency because both searches run. **Inspect / replay lookups** opens the last ten captured questions with their speaker, world revision, actual provider, selected facts in rank order, access classification, similarity, latency, and estimated usage. The panel also identifies indexing and fallback results rather than presenting them as successful semantic searches.

**Replay both providers** indexes as needed and sends fresh query embedding requests against the captured graph, even if the live world has changed. Explicit replay retries providers in cooldown and allows twelve seconds per request; ordinary dialogue retains its four-second query limit. Replay does not send another dialogue request or modify memories. Enter expected relevant fact IDs, separated by commas, and select **Score expected facts** for recall, precision and reciprocal rank. **Download report** exports the observations and labels as JSON. Compare the same question/speaker/revision and distinguish initial indexing time from warm query latency. Similarity values are model-specific and should not be compared as calibrated confidence scores.

## Retrieval architecture

`npcembeddings.mjs` defines a common gateway adapter, fixed provider identities, input formatting, and finite, normalized 768-dimensional vectors. `npcsemanticretrieval.mjs` owns disposable indexes, content and query caches, background indexing, comparison, and snapshot replay. `npcnarrativecontinuity.mjs` invokes it for local typed and Live conversations, and host-owned visitor lookups. Typed visitors request their context from the host. The host's retrieval settings govern remote conversations; a visitor's local selector does not override the host.

Each graph/speaker/provider combination owns a separate index. Only identical document content vectors are reusable between snapshots. Gemini and Qwen vector spaces are never mixed. Document and query vectors also persist in browser-local IndexedDB across reloads. Persistent keys include exact text, provider model, dimensions, format version, purpose, and prompt format; changed content or formats require new embeddings. Current graph permissions and status are always rechecked, never restored from this cache. Clearing browser site data removes it; private browsing, quota errors, or unavailable storage fall back to memory-only caching. Each model/purpose namespace is bounded to the same entry limits as its in-memory cache. Explicit comparison replay still requests fresh query vectors. Query caches hold 128 entries per provider, shared content caches hold 4,096, and diagnostics retain ten snapshots. A graph indexes up to 1,024 eligible facts in salience order; the panel exposes indexed versus eligible counts so larger worlds are not mistaken for exhaustive searches.

The current entity resolver, graph traversal, word ranking, fact limits, ambiguity reporting, and access classification remain in place. Semantic matches above cosine similarity 0.35 can introduce candidates and add up to 140 ranking points. Explicit entity references restrict semantic boosts to facts involving those entities. These initial thresholds are tuning choices, not measured quality claims.

Inaccessible and retracted facts are excluded before embedding. Every selected candidate is checked again by `narrativeFactAccess`; speakable and consistency-only facts remain separate in the packet. Diagnostic scores and ranking metadata never enter the NPC prompt. If the world revision changes during inference, the conversation recomputes current graph retrieval before returning context.

Indexes warm in the background when a conversation begins or retrieval settings change. A lookup while indexing returns the current graph packet. Once ready, new questions embed on demand. Missing credentials, timeouts, invalid vectors, and provider errors fall back to current retrieval. Provider failures have a 30-second cooldown. Queries have a four-second client timeout; background document batches have twelve seconds so cold starts do not immediately abort indexing. The gateway bounds its provider response wait to ten seconds. Workers AI binding inference already started may continue after the response wait ends.

## Gateway configuration

The new `POST /embeddings` (also `/api/ai/embeddings`) endpoint accepts only:

```json
{"provider":"qwen","purpose":"query","texts":["Who could fix my cart?"]}
```

Purpose may be `query` or `document`. Queries contain one input; document batches contain at most sixteen. Each input is limited to 2,000 characters and the existing 64 KiB request-body bound applies. Model selection and dimensions are server-owned. Responses include normalized vectors, fixed model identity, format version, and explicitly estimated token/cost usage. Query and indexing costs are reported separately; aggregate usage counts successful requests for this browser session. Character-based token estimates are not provider billing records and exclude storage, Worker requests and dialogue inference.

The Worker configuration adds the `AI` Workers AI binding for `@cf/qwen/qwen3-embedding-0.6b`. Gemini uses the existing server-side `GEMINI_API_KEY` secret and `gemini-embedding-2:batchEmbedContents`, with one content request per fact and `outputDimensionality: 768`. The two providers use their documented asymmetric query/document formats. No embedding API key belongs in the browser. `/health` reports embedding availability independently from OpenRouter configuration.

Embedding requests use an independent persistent Durable Object budget with `EMBEDDING_` prefixed limits. Defaults in `wrangler.toml` allow 60 requests/client/minute, 1,200 total/minute, 10,000/day, and 16 MB input/day. Documents are batched to reduce request overhead. A paid Workers plan or appropriate quota may be needed for the requested traffic.

Deploy the updated AI Worker configuration before live semantic requests can work. The frontend uses the existing `WANDER_AI_URL` endpoint. Publishing only the frontend against an older gateway produces explicit fallback results. Worker secrets must already be configured; deployment does not create or expose them.

## Validation

Run:

```sh
node --test tests/npcsemanticretrieval.mjs tests/npcembeddinggateway.mjs tests/npcnarrativegraph.mjs tests/npcnarrativecontinuity.mjs tests/npcdialogueui.mjs tests/npclivegateway.mjs tests/npclivevoice.mjs tests/npcliveencounter.mjs tests/multiplayervisitorconversation.mjs tests/aigateway.mjs tests/npcspeechgateway.mjs tests/desktopchatclose.mjs
```

Deterministic fake vectors test paraphrase candidate recovery, access control, wrong-entity rejection, provider separation, content updates, snapshot replay, stale-revision revalidation, malformed responses, timeouts, secret handling, and isolated budgets. Those tests establish system behaviour, not relative Gemini/Qwen model quality. Measure real model quality with labelled NPC questions in the comparison panel.

Provider references: [Gemini embedding formats](https://ai.google.dev/gemini-api/docs/embeddings), [Cloudflare Qwen binding](https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/).

For a small live smoke test, run `node scripts/evaluate-npc-embeddings.mjs`. It sends twelve labelled fictional questions and sixteen fact/profile documents through the production gateway, writes a JSON report in `/private/tmp`, and reports retrieval recall, reciprocal rank, indexing/query latency and estimated cost. Optional arguments select a gateway URL and report path. This is a deliberately small synthetic fixture, not a representative benchmark of saved player worlds.

## Live gateway verification — October 9, 2026

The gateway at `https://wander-ai.departures-worker.workers.dev` was deployed with the Workers AI binding. Health reports both embedding providers configured, and live requests produced valid normalized 768-dimensional vectors from both models.

On the twelve-question synthetic smoke test, current retrieval found the labelled fact in eight questions. Gemini hybrid found it in all twelve, with a median query latency of 426 ms. Qwen hybrid found it in all eleven queries that completed, with a median latency of 1,452 ms; one query hit the gateway's ten-second timeout. Ten Qwen queries and all twelve Gemini queries completed within the game's four-second query deadline. These figures describe one small run, with no claim about representative player-world quality or provider latency guarantees. The initial shorter client deadline also exposed Qwen cold-start variability, which motivated separate indexing and replay deadlines.

The frontend controls remain in the local checkout until the game frontend is published. The deployed gateway is available to local playtests through the existing public endpoint.
