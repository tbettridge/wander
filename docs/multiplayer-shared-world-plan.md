# Wander: one shared living world

Status: implementation in progress. The first shared-world slice is now wired
through the runtime: versioned host snapshots, interest management, shared
clock/weather/rail state, host-owned NPC and settlement presentation, stable
wildlife replication, and guest portal requests are implemented. The remaining
work is the broader interaction inventory, shared mounts and ambient group
events, plus the four-player failure matrix and rollout gates described below.

## Outcome and scope

A host and up to three guests should inhabit one logical world. At the same
location and shared time they encounter the same terrain, vegetation layout,
buildings, residents, animals, trains, weather, and observable consequences of
interactions. A late arrival sees the world as it is now, including changes made
before joining.

Rendering quality, draw distance, audio mixing, interpolation, and purely
decorative particles can remain device-specific. These may change how a scene
looks, but must not change what exists, where it is, or what players can do.
Named or interactive animals and insects belong to shared state. Ambient flocks
and insect groups need shared existence, timing, and trajectories; individual
decorative wing or sparkle particles do not require network packets.

Retain the existing browser-hosted model and direct WebRTC with TURN fallback.
The directory continues to handle discovery and signaling. The host must remain
online for the visit. Automatic host migration and a continuously running world
without its owner are separate future projects.

## Existing foundation and gaps

- `src/regionlayout.mjs` and approved tickets already carry the world seed and
  railway generation inputs. Keep this deterministic foundation for static
  geometry; do not transmit meshes.
- `src/multiplayer.mjs` already owns admission, player motion, reliable world
  updates, and resynchronization. Its five-second world update interval is not
  sufficient for moving NPCs, animals, or vehicles.
- `src/multiplayerauthority.mjs` currently shares a restricted projection of
  identities, locations, markers, and public facts. It does not describe the
  complete observable simulation.
- `src/main.js` still advances NPCs, settlements, fauna, trains, and sky on each
  browser. `applyGuestWorldState()` replaces the guest's local ledger with a
  normalized partial projection. That is not an adequate read model for a
  shared world and can discard fields needed by presentation.
- `src/stationkeeper.js` mixes decision-making, presentation, conversations,
  and saving. Some activity and save paths run even when `active` is false.
  Disabling one top-level update flag will not establish host authority.
- `src/animals.js` deliberately assigns a random session salt. Birds,
  butterflies, and fireflies also make independent random decisions.
- `scripts/playtest-multiplayer.mjs` now exercises two full browser sessions,
  matching stations, both player avatars, movement, and returning home. Extend
  this test rather than relying only on transport mocks.

## Authority contract

| System | Host responsibility | Guest responsibility |
| --- | --- | --- |
| Terrain and static flora/structures | Publish seed, generation version, settings, and persistent modifications | Generate matching geometry locally |
| Clock, weather, trains | Own time, weather transitions, service state, and occupancy | Follow shared time and interpolate presentation |
| NPCs and settlement evolution | Own identities, schedules, decisions, relationships, and public consequences | Render public NPC state; submit interaction requests |
| Wildlife and ambient life | Own spawn identities, behavior, routes, mounting, and removals | Render the same creatures and group events |
| Doors, objects, resources, and other interactions | Validate requests and commit each accepted change once | Show pending feedback, then reconcile with the host result |
| Persistence | Save canonical state for the hosted region | Maintain a temporary replica; preserve the guest's home save |

The host is the authority for world changes. Player movement remains responsive
locally, with host validation of movement relevant to shared interactions and
authoritative correction for vehicle seats, mounts, teleports, and invalid
positions. Private memories and relationship internals stay on the host;
guests receive the observable behavior and player-appropriate responses those
internals produce.

## Phase 1 — Establish the simulation boundary and replica protocol

Audit every state-changing path in `main.js`, the population and settlement
systems, fauna, vehicles, and interaction handlers. Record the owner of each
mutation and save. Split each subsystem into simulation and presentation
operations, with explicit offline, host, and guest roles. Offline and host
sessions use the same decision code; guests consume replicated state.

Introduce a dedicated guest read model instead of rebuilding a writable
canonical ledger from a partial public snapshot. Define stable entity IDs,
entity types, observable appearance and state, spawn/despawn messages, discrete
events, and timestamped movement samples. Include session epoch, simulation
tick, state revision, and generation/schema versions. A stale packet from a
previous visit must never enter a new one.

Use reliable ordered messages for creation, removal, committed interactions,
and checkpoints. Use timestamped motion updates for rapidly changing poses.
Discard old samples, ignore motion for unknown entities, and explicitly request
a baseline when revisions do not match. Make initial join atomic: load the
snapshot at a known tick, replay subsequent updates, then release guest control.

Add interest management on both sides. Each guest receives nearby detail, while
the host simulates the union of areas around all connected players. Keep coarse
NPC schedules and other required offscreen world state active outside those
areas. Simulation existence must not depend on whether the host renders a mesh.

Acceptance: a guest cannot independently make world decisions or write the host
region's canonical save. A late join and a forced resync reconstruct the same
public state. Moving away from the host does not freeze or erase the guest's
surroundings. Old-session and duplicate packets are harmless.

## Phase 2 — Share time, weather, and transport

Create one host-owned simulation clock. Guests estimate its offset and advance
presentation between updates, correcting small differences smoothly. Publish
day, time, time scale, and pause state; preserve the existing unequal day/night
rates. Feed the same clock into sky, weather, NPC schedules, and rail services.

Share weather seed/version plus the current transition and any host overrides.
Drive wind, rain, lighting, and ambient schedules from that state. Replicate train
service IDs, route progress, stop/dwell state, and passenger/seat reservations.
Boarding and alighting require host acceptance so players cannot occupy a seat
twice or see different train locations.

Define host suspension explicitly. If the host cannot tick because its browser
is suspended or loses connectivity, show a paused/reconnecting world on guests.
Resume from a fresh authoritative baseline. Do not let every browser invent its
own elapsed simulation. Host-side menu use should not inadvertently stop a world
that guests are still exploring.

Acceptance: two clients joining at different times agree on day/night and weather
transitions, see the same train at the same station, and can ride together. A
backgrounded or suspended host produces the same pause/resume outcome for all.

## Phase 3 — Share NPCs, dialogue outcomes, and settlement evolution

Move NPC schedules, roaming, journeys, encounters, agency, and settlement
evolution behind the authority boundary. Replicate stable resident identity and
appearance, position/heading, current action, destinations, relevant animation
cues, and public state changes. Guests must not generate a second resident
population or run a second decision loop.

Route guest interaction requests to the host, including the NPC ID, player ID,
request ID, and interaction context. The host checks proximity and availability,
runs dialogue/decision logic, and applies consequences once. Return the response
to the initiating player and broadcast observable consequences. Keep private
memory and relationship data on the host. Use a conversation reservation with
expiry so two requests for the same NPC have an explicit outcome; a disconnected
guest must not leave an NPC permanently occupied.

Publish settlement evolution changes that affect building layouts, ownership,
occupancy, public resources, or other visible properties. Ensure dynamic public
fields needed to reproduce structures are included, not just the original seed.

Acceptance: both players watch the same NPC walk, stop, interact, and board a
train. A guest request changes the host's canonical state exactly once and both
players see the result. Public changes survive a late join and a host reload;
private internals are absent from guest packets and saves.

## Phase 4 — Share fauna and ambient life

Have the host own animal IDs, population salt, species/appearance, spawn cells,
behavior, positions, and despawning. Send a reliable spawn baseline followed by
movement/action updates. Guests interpolate motion and animate limbs locally.
Changing only the random seed is insufficient: behavior depends on all nearby
players, elapsed simulation, and interaction history.

Animal perception must include every relevant player's authoritative position.
If a guest approaches a deer, the host decides whether it flees and sends that
result to everyone. Shared horse mounting needs exclusive ownership, validated
control input, rider identity, and consistent dismount handling. Treat birds and
insect groups as shared timed spawn/route events where that is sufficient.

Acceptance: players encounter the same animal identities and trajectories; a
reaction caused by either player is visible to both. Two players cannot mount
the same horse. Animals remain valid around a distant guest, survive streaming
out and back in, and disappear consistently when removed.

## Phase 5 — Complete shared interactions and persistence

Use the phase-one mutation inventory to finish every existing observable
interaction: doors, pickups/resources, object changes, markers, mounts, vehicle
occupancy, and supported settlement/environment changes. Do not add new gameplay
solely for networking. Define a typed request and an observable result for each
existing action.

Validate distance, target existence, permissions, ownership, and current state.
Deduplicate request IDs; resolve conflicting requests once on the host. A guest
can display immediate tentative feedback, but only the host commits the change.
Use revisioned events and persistent tombstones so consumed or removed objects
do not return when a client streams them again.

Store hosted-region changes only in the host's canonical save. Preserve guest
home seed, layout, state, and position through the entire visit. Keep any intended
guest personal progress separate from the host's world. On host loss, freeze
shared interactions, offer return home, and restore the guest's own state.

Acceptance: simultaneous requests cannot duplicate resources or ownership; a
door/object change reaches both users; a late join sees earlier changes; leaving
and returning never corrupts either player's home world.

## Phase 6 — Scale, failure testing, and rollout

Extend the full-browser regression to one host and three guests. Compare canonical
public state at a common simulation tick, plus rendered poses after interpolation
settles. Check actual views and behavior as well as data equality.

Cover separated players, late joins, packet loss/jitter, bandwidth backpressure,
disconnect/reconnect, host backgrounding, mixed build versions, and return home.
Inject failures into the browser harness; include real direct and TURN sessions
in release verification. Keep existing single-player tests as regression gates.

Start measurements with near moving entities around 10 updates/second, reduced
rates for distant entities, event-driven discrete changes, and occasional
checkpoints. These are starting parameters, not promises: record bytes/second,
queue lengths, active entities, snapshot size, resync time, host simulation CPU,
and guest frame time. Establish numerical budgets against the current build
before rollout, then enforce them in stress scenarios. Preserve the existing
per-message and bounded reliable-queue limits; partition large initial state if
it exceeds the snapshot budget.

Roll out behind session-negotiated feature versions. Release complete behavior
for a subsystem only after its acceptance tests pass; fail incompatible joins
with a reload instruction. Document any remaining decorative-only differences.

## Recommended implementation sequence

Complete phase 1 first, then use clock/weather/trains as the first end-to-end
slice of the new contract. Complete NPCs and settlements next, then fauna,
followed by the remaining interaction inventory. Build acceptance tests with
each phase; phase 6 adds the combined four-player and failure matrix.

The project is complete when guests observe the same meaningful world state and
consequences as the host across that matrix. Identical seeds and visible player
avatars alone are not the completion criterion.
