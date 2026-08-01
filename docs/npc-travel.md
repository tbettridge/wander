# NPC world travel

NPCs walk the world between landmarks, loiter when they arrive, and prefer the
trail network to open ground — choosing a longer route with gentle grades over a
direct one that climbs hard.

This document exists because the plan previously lived only in a conversation.
Decisions made once were re-derived, re-litigated, and in one case reversed by
accident. What follows is the agreed shape of the work and the constraints it
must respect.

## Decisions

These were settled up front. They are constraints, not open questions.

| | |
|---|---|
| **Trail profiles** | Not edited to make travel easier. The one exception already taken: a crossing longer than the old ceiling builds a long bridge rather than rerouting. |
| **Height sampling** | Explicitly budgeted in Phase 1. Not sampled ad-hoc per NPC per frame. |
| **Spawning** | Staggered through workers. No frame drops when a region populates. |
| **Seeding** | NPCs are already seeded at landmarks. Travel starts from where they are. |
| **Loitering** | An NPC may stay at a landmark for up to 24 in-world hours. |
| **Character collision** | Out of scope. NPCs pass through each other. |
| **Rivers** | Ford them when off-trail. Use the crossing when on a trail. |
| **Caves** | An NPC may follow the player into a cave. |
| **Off-trail** | Trails are preferred, not required. An NPC must be able to navigate open terrain. |

## Phase 0 — river crossings (done)

A crossing had to be something a walker could actually stand on before anyone
could be sent across one.

- `src/trailcrossings.mjs` — one source of truth for a crossing. The chunk
  builder asks what to build; feet and gaits ask what to stand on. THREE-free,
  so a crossing can be asserted without a renderer.
- `src/walkablesurface.mjs` — decks over terrain, cached by region.
- `src/floor.mjs` — which claimant wins the vertical domain.

A crossing is measured **along the trail's arc**, never a straight chord between
banks: laid as a chord it drifted 8m from the path it carries on a long span.
Abutments walk outward until the ground rises to meet the deck, so a deck cannot
hang above a bank out of reach.

The failure worth remembering: every diagnostic reported the deck as present and
correct, and it was — an active environment was handed the vertical domain and
discarded it one line later. Five fixes were made to code that already worked
before the consumer was instrumented. **Instrument the consumer, not the
supplier.**

## Phase 1 — grounding and the nav graph (done)

**Grounding wire-up.** `WalkableSurface.groundProvider()` exists, is tested, and
is called by nothing. Only the player is wired up
(`controls.setWalkableSurface`, `main.js`). Until an NPC resolves against the
same surface, it wades through a bridge the player walks over — two grounding
systems disagreeing about the same river.

**Nav graph.** Landmark-to-landmark routing over the existing trail network,
reusing the edges the crossing solver already walks. Landmarks are nodes, trail
edges are arcs, and a route is a sequence of edges plus arc positions along
them.

**Height-sampling budget.** A hard per-frame ceiling on terrain samples across
all travelling NPCs, with work deferred rather than dropped when the ceiling is
hit. Sampling is the cost that scales with population, so it is capped
explicitly rather than left to emerge.

**Staggered spawning.** `setPlan` queues residents instead of building them, and
`drainSpawnQueue` builds a few per frame. Verified in the browser against the
real class: 12 residents queued, **0 built during `setPlan`**, then 2 per frame.

Skinned-mesh construction cannot move to a worker — it needs THREE objects and
the GPU-facing side of the renderer — so this spreads the work rather than
offloading it. The pure data half (identities, descriptors) could move, and has
not, because it is not what costs.

### What Phase 1 measured

**The nav graph must be gathered at travel scale.** `trailsAround` returns edges
touching the query area, so a small radius omits every link to a landmark just
outside it and the network *looks* fragmented:

| radius | nodes | components | largest |
|---|---|---|---|
| 5000 | 11 | 3 | 55% |
| 10000 | 87 | 4 | 54% |
| 20000 | 272 | 3 | **96%** |

The network is well connected. A cheap gather cannot see it. An NPC routed on a
streaming-scale graph would be stranded by an artifact of the query radius.

**Legs do not join, and must not pretend to.** Trail edges stop at a landmark's
clearing halo, not its centre, so consecutive legs end and begin at different
points on that halo. Measured over 416 routes and 5180 junctions: min 16m,
median 43.5m, max 100m. A route publishes each hop as `gapToNext`, because an
NPC silently teleporting across a clearing is the kind of thing nobody notices
until it happens in front of the player.

**Cost is hiking time, not distance.** A linear grade penalty got the answer
backwards: at weight 2.4, a 600m route at 30% grade cost 1032 against 1048 for a
1000m route at 2%, so every traveller would have gone straight up the hill.
Tobler's hiking function is used instead — `6 · exp(-3.5 · |slope + 0.05|)` —
which makes steepness hurt disproportionately and carries "declines matter less"
through its own offset rather than through a rule bolted on top.

## Phase 2 — the journey

A state machine per NPC: **loiter → depart → travel → arrive → loiter**.

- Loitering has a duration, up to 24 in-world hours, and ends by choosing a
  destination.
- Travel follows the nav graph, using crossings where the trail provides one and
  fording where it does not.
- Arrival hands the NPC back to whatever it does at a landmark.

Journeys must survive an NPC leaving simulation range and coming back. A
traveller is a position and an intent, not a live actor.

## Phase 3 — grade intelligence and LOD

**Grades.** Route cost weights climbing more than descending: a longer, gentler
route should win over a short steep one. The `ROUTE_PROFILE` per-class grade
weights already exist for the trail solver and are the natural starting point.

**LOD.** Distant travellers advance along their route without a rig, a gait, or
per-frame height sampling. Only nearby NPCs are fully simulated.

## Testing

Every module here is THREE-free and asserted in `tests/`. That is what let
crossings be measured across thousands of real cases without a renderer.

The gap that cost this project the most: **the tests exercised the supplier
directly and the bug was always in the consumer.** A test with one walker passed
while no bridge in the running game could be crossed. Prefer tests that
integrate two parts over tests that confirm one part in isolation.
