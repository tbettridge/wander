# Wander river, pond and lake overhaul

Planning only · 11 September 2026 · reviewed against `842d14a`

The proposed outcome is a landscape of recognisable rivers, occasional quiet ponds and distinctive lakes, with convincing banks and water that suits each setting. Preserve the current crossing structures and their traversal behaviour. This document supersedes the unfinished design direction in `river-bank-fix-plan.md`; it does not implement or deploy the overhaul.

## 1. Recommendation and visual intent

Replace the river noise band with connected channel paths whose widths are measured in metres. Generate ponds and lakes as separate terrain basins with explicit water levels, shorelines and drainage relationships. Plan the landform and its water together, then derive materials and vegetation from the resulting slopes, sediment, exposure and depth.

A successful scene should read at three distances. From a ridge, a lake should occupy a believable hollow and a river should follow the valley. Walking along the shore, bays, points, shallows and changes of substrate should have a reason. At the water's edge, ground contact, reflections, current, small ripples and vegetation should agree with the same surface.

Keep Wander's painterly lighting and colour language. The aim is restrained, readable water and convincing landforms, not a photorealistic fluid simulation. Occasional lakes should feel like discoveries rather than repeated bulges along every river.

## 2. What the current code actually does

In `src/world.js`, wet width is controlled by `abs(riverNoise) / 0.040`. A small spatial noise gradient therefore makes a very wide channel. `_riverPlanSample` estimates `halfWidth = clamp(0.040 / gradient, 6, 80)`, but that clamp only positions the bank probes. It does **not** bound the actual wet footprint. Removing a previous gradient cutoff prevented fragmented pools but left these broad areas without a basin model.

The 24m planning grid projects samples onto approximate noise contours and interpolates feasible water levels. It has no lake identity, containing rim, inlet, spillway or downstream graph. A region that looks like a pond can still slope across its surface. The bed is largely a uniform 1.4m below water; bank crests use the same 0.55m rise and similar section on both sides. This accounts for much of the repetitive, sculpted appearance.

The shader in `src/river.js` infers still water from a small flow vector. That vector comes from the water-height gradient in `buildRiver`, rather than an explicit downstream direction. Consequently “lake”, “slow river” and “nearly flat erroneous channel” are not distinct material states. The ripple normal strength rises from 0.10 toward 0.80 with flow speed; foam is also driven by depth and speed. These are tuning mechanisms, not a model of where turbulence or foam belongs.

Useful work to retain: exact terrain/water triangle contact within a chunk, signed shore depth, railway corridor protection, authoritative gameplay floor queries, and the cached-module visibility regression test. Passing those tests establishes contact and compatibility, not attractive lake shapes or correct drainage.

Read-only spot measurements on the reviewed code:

| Seed | Probe X, Z | Approximate wet transect length | Water-height range along transect |
| --- | --- | ---: | ---: |
| 20260612 | 1150, -2100 | 484m | 1.82m |
| 20260612 | -2050, -700 | 300m | 1.69m |
| 4242 | -950, 1050 | 282m | 4.34m |

Method: inspect wet interior points on a 50m grid over ±2.5km, select small noise gradients, then march both ways along each point's local noise normal in 2m steps until dry. These are approximate line intersections, not traced lake boundaries, certified cross-sections or observations of the user's exact location. Curving channels can enter the same transect. They nevertheless demonstrate that the current broad wet areas have no single-level lake invariant. Preserve these coordinates as diagnostic fixtures.

## 3. Protect crossings before changing geography

Treat “maintains crossings as they are now” conservatively: keep their types, locations, trail approach alignment, visible dimensions, deck or foothold elevations, collision behaviour and player/NPC access. Do not silently exchange stepping stones for bridges or move a crossing because a new lake wants its site. Surrounding banks and materials may improve while the crossing remains recognisable.

Simply leaving `trailcrossings.mjs` untouched would not accomplish this. `trails.js` chooses paths and records wet intervals from the current world. `solveCrossing` then selects a structure from span, depth and bank height, and searches for its abutments. Changing the world underneath changes the result.

Introduce a versioned crossing-preservation manifest before activating new hydrology:

- Record seed, region/railway layout identity, trail edge ID and exact segment/arc data; crossing kind, wet interval, bank/abutment positions, deck profile, width, stone/log transforms and collision footprints. Store the realised structure recipe, not only inputs that a later solver might reinterpret.
- Freeze relevant trail geometry and the generation inputs for railway and station approaches. Capture dependent route identity so changed hydrology does not indirectly regenerate a different village and crossing network.
- Define a protected envelope around each crossing: physical footprint, all supports, complete approaches and a terrain transition buffer. Start with a 20–40m buffer beyond the complete structure/approaches, extended for long spans; do not use a radius from the bridge centre that misses its ends.
- Solve a permissible water-level/depth interval for each crossing from its real type. Ordinary bridges retain their required clearance; low planks, logs and stepping stones use their own existing elevations and tolerances. Preserve the dry landing and the traversable bed where wading is part of the current experience.
- New channels must pass through these envelopes with compatible width and direction. Blend into changed channels over a meaningful upstream/downstream distance; reject abrupt necks or artificial impoundments invented just to accommodate an anchor.
- Lake candidates cannot consume protected approaches, submerge footholds or spread around the end of a bridge.

Migration must work beyond currently loaded chunks. For existing saved regions, persist manifests before replacement. For old seeded regions without manifests, lazily regenerate the current-version crossing/trail plan in an isolated compatibility world, then freeze it. That compatibility world must never call the new water planner. Cache and serialize the result so it is not regenerated on every height query. Include landmark, station and settlement spurs, plus rail crossings; snapshotting a handful of screenshots is insufficient.

New regions created in the overhaul version can plan hydrology before trails, retaining the same crossing construction and traversal contracts. Existing regions use their preservation manifests as hard constraints.

There is a real feasibility conflict: an arbitrary set of old water heights need not admit one downhill river. Keep structure elevations fixed, permit water levels only within their safe intervals, and try a different route or watershed connection. If a component still cannot satisfy both requirements, retain its entire compatible legacy reach and identify it in the review report. Do not publish a half-solved connection or silently relax a crossing constraint. A full-release gate must expose how many retained reaches remain and where.

## 4. Give water bodies distinct geological forms

The following ranges are initial art-direction targets, not measured natural laws or final quotas. Existing protected crossings may require wider local reaches.

| Feature | Initial scale | Shape and terrain context | Water and shoreline character |
| --- | --- | --- | --- |
| Small stream | 2–6m wide | Constrained by local valley floor, rocks and roots; gentle width changes | Clear shallows, gravel, local riffles, quieter pockets |
| Ordinary river | 6–20m wide | Coherent bends along a floodplain, with occasional wider reaches | Darker deep thread, exposed inner bars, varied outer banks |
| Broad lowland reach | 20–45m wide, uncommon | A supported valley widening or confluence | Slower margins and a recognisable main current; remains a river |
| Floodplain/oxbow pond | 20–100m long | An abandoned bend beside a plausible active channel | Crescent or elongated hollow, silt, clustered sedges and reeds |
| Enclosed lowland pond | 15–70m across | A complete shallow depression in suitable ground | Quiet surface, soft bays, sheltered plants and some open shore |
| Valley lake | 120–600m long, rare | Elongated along a containing hollow with branching side valleys | A few meaningful bays and points, shallow inlet delta, visible outlet |
| Upland rock-basin lake | 50–250m long, rare | A supported bowl with rock shoulders and an outlet sill | Clear water, broken rocky margins, few reeds, restrained wavelets |

Oxbows should inherit the form of an abandoned channel rather than receive a random crescent mask. The USGS describes their formation through meander cutoffs and subsequent infilling. Use that relationship as the design reference. [USGS: Oxbow Lakes](https://eros.usgs.gov/earthshots/oxbow-lakes)

A kettle is specifically associated with glacial deposits and melting buried ice. Wander currently lacks a matching regional glacial-history field, so do not scatter “kettle lakes” by latitude or label every round pond glacial. Start with generic closed depressions; introduce a kettle or tarn family only with surrounding landforms that support it. Naturally rounded basins are valid—the problem is repeated arbitrary outlines, not roundness itself. [NPS: Kettles](https://www.nps.gov/articles/kettles.htm)

Starting frequency target in suitable lowland terrain: a few accepted ponds per 4km × 4km area and a larger lake across several such areas. Some areas should contain none. Apply suitability, spacing and maximum inundated-area budgets before frequency goals. Do not guarantee one lake per tile or add water just to meet a quota. Measure encounters along actual walking routes as well as map area, then tune “occasional” in the visual review.

## 5. Plan drainage, channels and basins together

Use a staged deterministic planner, not per-frame fluid simulation or per-vertex basin searches.

**Regional foundation.** Sample natural terrain on a coarse, globally anchored grid, initially 32–64m spacing, with catchment refinement near potential water. Derive valley direction, slope, relative relief, contributing-area proxy, substrate and moisture suitability. Terrain generation remains the primary signal; old river noise may weakly influence route character but must no longer define width or decide where lakes appear.

Use depression/spill analysis to identify possible basins and drainage. Priority-Flood is a useful reference for identifying spill relationships and drainage over an elevation grid. Preserve the original terrain and depression hierarchy separately: filling every depression and using the filled surface as the rendered landscape would erase the very basins we want. Its guarantees for a finite grid do not by themselves solve Wander's infinite-region boundaries. [Barnes, Lehman and Mulla: Priority-Flood](https://arxiv.org/abs/1511.04463)

**Infinite-world ownership.** Start with fixed coarse super-regions and deterministic shared boundary portals, not independently draining each tile to its nearest edge. Every cross-boundary reach gets one ID, direction, position and admissible water-level interval derived from shared inputs. Use a coarser parent drainage graph to connect those portals and test for cycles. Refine child regions under that graph and the crossing constraints. Proposed starting sizes are 4km planning regions with 16km parent regions; these are experiments, not a claim that a finite halo guarantees global drainage.

Large catchments must connect through the parent graph. A basin that reaches an unresolved boundary is deferred to its authoritative parent owner; it must not become a square lake at the worker's bounding box. Preserve chosen closed basins explicitly. Prove generation-order independence at boundaries before expanding this system across the world. Treat this as a dedicated early engineering milestone because it is the largest architectural risk.

**Connected channel graph.** Trace candidate valley routes, attach sources/confluences/outlets, then fit continuous centreline curves inside the feasible valley corridor. Keep curvature, valley width and downstream direction coherent. Confluence nodes share one level and compatible bed geometry. Eliminate accidental disconnected slivers and classify any retained cycles as basins with a defined drainage status.

**Width and depth.** Store left/right widths in metres along arc length. Base their scale on stream class and a stable contributing-area proxy; modulate gently with valley confinement, bends and substrate. Limit widening rates over distance. Vary depth through pool/riffle sequences, keeping the deeper thread toward the outer side of a bend where appropriate. Do not create a lake by relaxing a width cap. A broad candidate must pass basin validation or remain a bounded channel.

**Water elevations.** Solve longitudinal profiles with non-increasing downstream levels and bounded ordinary grades, subject to crossing intervals and outlet levels. Each cross-section is level across the channel. Lake basins use one shared elevation. Drops that cannot be resolved as a continuous reach require an explicit cascade/fall with a lip, receiving pool and connected flow; do not infer waterfalls from a fixed height difference between arbitrary mesh cells.

**Basin construction.** For each selected depression, determine the containing rim, spill saddle and reachable outlet. Refine terrain, then flood the connected basin at the candidate level. The resulting terrain intersection defines the shoreline. Permit modest coherent terrain conditioning, but preserve natural shoulders and saddles. Resolve nested depressions and connected lobes before assigning the lake ID. A tributary entering a lake shares the lake level at the inlet; its sediment fan creates shallows, not an unexplained wall of water.

**Closed ponds.** A pond need not have a visible inlet or flowing outlet. Give it an explicit closed-basin state, a level below the spill rim, and a simple stable moisture/runoff suitability model. Do not claim every pond must drain at the surface, and do not imply a full groundwater simulation exists.

**Bound terrain edits.** Initially cap added fill around ordinary rivers near 2m and new incision near 4–6m relative to natural terrain, with stricter limits in protected areas. Measure the full affected area and earthwork volume, not just two bank probes. Lake depths must primarily use existing relief; excessive artificial excavation rejects a candidate. Constants are proposed feasibility budgets to calibrate on the fixture set.

## 6. Shape banks and shores with a hierarchy

Large-scale form comes first: valley confinement, basin axis, ridges, spurs and tributary mouths. Intermediate form comes from inner bars, sheltered coves, small deltas and rocky points. Fine irregularity follows substrate and erosion; it should not apply identical noise to the entire perimeter.

For river bends, use an asymmetric section: a shallower depositional inner bar and, where the ground supports it, a steeper outer bank with a deeper channel nearby. Straight reaches can have softer differences. The inner-bank deposition reference is supported by USGS work on point bars. [USGS: Channel planform and point-bar architecture](https://www.usgs.gov/publications/relationship-channel-planform-and-point-bar-architecture-a-reach-wabash-river-near)

Replace the continuous raised shoulder with a profile that transitions from bed to shallow margin, bank face, upper bank and surrounding terrain. A low floodplain should not become a uniform levee on both sides. Where containment would demand that wall, lower or reroute the reach within its constraints.

Lake shores vary with adjacent relief and exposure: gently shelving sheltered bays, steeper rock-bound edges, shallow inlet fans, and a lower outlet sill. Bathymetry should follow the basin's hollows instead of a flat floor or uniform distance-from-shore extrusion. Islands must be surviving higher terrain within a valid basin, not decorative holes cut into a water polygon.

Materials and plants consume the same semantic fields. Gravel and sand belong on suitable bars and exposed shelves; mud and organic silt belong in sheltered low-energy margins. Reeds, sedges and floating plants occur in clusters with gaps, based on shallow depth, soft ground and shelter. Avoid a continuous reed necklace, trees below water and identical vegetation on rocky and muddy banks. Preserve crossing clearance for feet and sightlines.

## 7. Redesign the water's appearance

Give every water body an explicit kind and material parameters: river, pond, lake or estuary; depth, clarity/turbidity, bed substrate, current vector, turbulence and wind exposure. Calmness must not be guessed from a near-zero elevation gradient.

- **Rivers:** interpolate a continuous downstream flow field with slower banks and appropriate acceleration through constrictions. Use subdued wavelets aligned with the current, local riffles and sparse foam around actual disturbances. Stabilise flow direction across triangle and chunk boundaries to avoid stretched streaks and orientation flips.
- **Ponds:** mostly quiet reflections, tiny wind ripples and readable shallow edges. Warm, tea-coloured or green water is a restrained material choice driven by setting, not obligatory bright cyan. Sparse floating plants can reinforce sheltered corners.
- **Lakes:** use wind direction and fetch—the unobstructed water distance upwind—to distinguish exposed surface from sheltered bays. Keep wave amplitude small near shore; use separate shallow and deep appearance without a hard colour ring. Clear mountain water and silty/turbid water need different absorption, not merely different opacity. NPS notes that glacial rock flour produces different lake colours, which supports using suspended material as a parameter rather than making all upland lakes turquoise. [NPS: Glacier lakes and ponds](https://www.nps.gov/glac/learn/nature/lakesandponds.htm)
- **Reflections:** retain inexpensive sky/environment reflection as the baseline. Evaluate one bounded, low-resolution planar reflection for the prominent visible lake on desktop, updated at reduced cadence. Reflect actual nearby terrain/trees with correct clipping. Make this optional by quality tier; baseline lakes must still look good in XR without it. Do not make screen-space reflection a dependency or invent mirrored silhouettes that contradict the scene.
- **Shore contact:** retain true terrain intersection and signed depth. Use a narrow wet-ground band and restrained shallow transparency. Foam should not outline every pond like white piping. Test transparent water and depth writes through post-processing and from below the surface.
- **Ocean ownership:** only confirmed estuary-connected surfaces blend into the sea. An inland lake must never fade out because its height happens to be close to sea level. Apply tidal adjustment only to an explicit mouth transition; inland pond/lake levels remain stable in this scope.

Keep water displacement small enough not to reopen a visible shore gap; attenuate it toward shore or initially keep waves in shading. Gameplay uses the stable mean surface and the same physical depth. Preserve wading, underwater tint and crossing behaviour, with an explicit volume/exclusion check for dry caves.

## 8. One water contract for rendering and gameplay

Introduce immutable descriptors for reaches, basins and crossing reservations, backed by a spatial index. A query should return body ID/kind, surface height, final ground/depth, signed shoreline distance, downstream flow, substrate and shore class. Preserve `riverAt` as a compatibility adapter while consumers move to a broader surface-water query. Do not mix this geometry service into `src/surfacewater.mjs`, which currently owns only underwater overlay policy.

Compose terrain in an explicit order: natural landform, approved river/basin conditioning, constrained earthworks, then final ground and water queries. Railway/tunnel/cave cuts must not remove containment unnoticed. Keep body membership separate from the sign of water-minus-ground so terrain elsewhere below a lake elevation is not automatically flooded.

Plan and serialize in workers before activating a region. The main thread and geometry workers consume the same plan/hash; never independently reflood a basin from whichever chunk loads first. Height queries do bounded local interpolation only. Cache by world seed, generation version, region, protected-layout signature and plan hash; enforce an LRU byte budget and cancellation of stale jobs.

Publish a region atomically: new terrain, water meshes, vegetation exclusions and gameplay queries become active together. While a plan is pending, retain the previous complete region or the loading state. Never show the new dry bed while water exists only in physics. A mismatched or malformed worker payload must produce a visible diagnostic and controlled retry, not a null river accepted as a dry chunk. Retain legacy field compatibility for migration, but do not let it replace version validation.

## 9. Mesh detail and performance

Retain common terrain/water topology around shores and refine both where narrow streams, sharp banks or small bays are unresolved. Use interior probes and descriptor intersection bounds, not only corner wetness. A narrow stream between four dry vertices still needs geometry.

Build one canonical boundary sample/intersection sequence per shared chunk edge and water body. Stitch adjacent detail levels to that sequence. Simplification can change interior triangle density but must preserve shoreline connectivity, inlet/outlet connections and shared elevations. Coarse lake interiors can be extremely cheap because their physical surface is planar. Terrain skirts do not substitute for water seam tests.

Performance must be measured from the start. The previous local benchmark already rose from 7.72ms to 10.05ms p95 terrain-plus-river construction, so another unbounded layer is unacceptable. Proposed gates, calibrated on the same hardware and fixed corpus:

- New cached point queries and worker builds should not regress against the current version; seek to recover the earlier approximately 20% overhead target relative to the pre-bank-fix reference.
- Record cold region planning separately from warm chunk construction. Begin with a 250ms p95 worker planning target per 4km region; profile and revise the design if it is missed rather than hiding cold work in height queries.
- Preserve the existing approximately 3ms main-thread chunk assembly budget; large payloads require incremental assembly and atomic activation.
- Establish a water-only GPU budget at fixed desktop resolution and on the target XR headset; a provisional 1ms allowance is a starting experiment, not a measured promise. Verify total-frame p95 too. Optional reflections are the first quality feature to shed.
- Track plan bytes, transferred bytes, peak transient memory, triangles, draw calls and shader cost. Share materials and avoid per-pond draw calls for individual reeds or ripples.

## 10. Implementation work packages and completion gates

| Order | Work | Primary code areas | Gate before proceeding |
| --- | --- | --- | --- |
| 1 | Capture current crossings and a representative visual corpus | `trails.js`, `trailcrossings.mjs`, crossing/traversal tests; proposed `crossingpreservation.mjs` | Protected IDs, transforms, approach support and traversal are reproducible across reload/order |
| 2 | Define descriptors, regional ownership and versioned transport | Proposed `hydrologyplan.mjs`, `hydrologyworker.js`, `waterfield.mjs`; `world.js`, `worker.js`, `terrain.js` | Shared boundary tests, serialization, stale-job rejection and atomic activation pass |
| 3 | Replace accidental widening with bounded connected channels | Proposed `riverplanner.mjs`, `riverterrain.mjs`; `railwayterrain.mjs` | No lake-sized bulges masquerading as channels; profiles and crossing intervals are feasible |
| 4 | Add real pond/lake basins | Proposed `basinplanner.mjs`, `basinterrain.mjs` | Closed containment, one lake level, outlet/closed-state validity and no protected-corridor flooding |
| 5 | Implement bank profiles, sediment and shore ecology | `world.js`, `chunkgen.js`, `vegetation.js`, palette/material code | Banks look different for a physical reason; placements respect water and structures |
| 6 | Implement body-specific water and ocean handoff | `river.js`, `water.js`, `watercommon.js`, `waterfall.js`, surface-water consumers | River, pond and lake are visually distinct; no invisible inland water or shore curl |
| 7 | Shared shoreline refinement and detail transitions | `chunkgen.js`, `terrain.js`, `worker.js` | Mixed-resolution edges and narrow-feature coverage pass; no popping away of water |
| 8 | Full-game review, performance and migration | `main.js`, `worldruntime.mjs`, multiplayer/saves, inspection pages and tests | Crossings pass, visual review passes, budgets measured, version mismatch safely handled |

Carry crossing tests throughout every package. Develop these behind a generation feature switch and keep the shipped version available for A/B comparison. Do not promote an intermediate “rivers only, lakes later” stage as the finished overhaul.

The first reviewable slice should include a constrained meandering reach, its unchanged crossing, and one properly contained pond or small lake using the actual game worker/render pipeline. This tests the central design before implementing every landform family. The final release includes ordinary channels, occasional ponds and at least valley and rock-basin lake forms wherever their setting is valid.

## 11. Acceptance and visual review

Use a fixed corpus across at least six seeds, then a wider deterministic soak. Include the three measured broad areas above, the original floating-edge fixture, each crossing type, a shallow closed pond, a valley lake with tributary/outlet, a rocky basin, a confluence, a coastal mouth, a cave exclusion and adjacent mixed-detail chunks. Add large positive/negative coordinates, region boundaries, cache eviction, delayed workers and joining a multiplayer region.

| Property | Required result |
| --- | --- |
| Crossing preservation | Same protected structures and trail geometry; original collision/foothold behaviour; dry supported approaches; water clearances remain valid for the crossing's actual type |
| Lake level | One physical mean level per connected lake; numerical variation within 1cm at ordinary local coordinates |
| River profile | Level lateral sections, non-increasing downstream levels outside explicit falls; matched junctions |
| Containment | Complete rim above the lake level except declared outlets; no exterior shoreline edge hanging above ground |
| Contact/detail | Near shoreline contact within 1cm; shared boundary positions generated once; narrow water and outlets survive all supported detail pairings |
| Gameplay agreement | Final ground/depth and membership match the rendered plan; dry caves stay dry; no invisible water on region activation |
| Ecology | Plausible material/depth placement; open shoreline gaps; no repeated reed border or submerged ordinary trees |
| Compatibility | Same descriptors from query order, worker order and cache rebuild; explicit handling of mismatched generation versions |
| Cost | Record cold/warm CPU, GPU and memory against the fixed baseline; no unmeasured performance claim |

Shape metrics should catch failures without pretending to judge beauty. Measure channel widening rate, basin elongation, repeated silhouettes, tiny shoreline teeth, disconnected slivers and terrain-edit volume. Apply archetype-specific expectations: a round lowland pond is not a failed valley lake. Do not optimise every basin toward the same perimeter/area score.

Review silhouettes first with neutral terrain and flat diagnostic water: a plausible basin, meaningful bays/points, no grid outline and no uniform earthen wall. Then inspect the full game at walking height and from a ridge, in daylight, overcast and low sun. Review motion for flow-direction seams, glitter, repetitive foam and flickering shorelines. Test the actual desktop pipeline and an XR headset; a lab screenshot or desktop emulation cannot certify XR appearance.

Cross each preserved structure with the player and representative NPC routes, at low and high update rates; check stone/log footholds individually and inspect the water beneath/alongside each structure. Existing tests that assert traversal and construction remain. Historical distribution checks, such as expecting most crossings to span wide rivers, must be separated from physical correctness: a protected legacy cohort should retain them, while newly generated narrow rivers legitimately have different proportions. Document any rebaseline and retain the old cohort rather than weakening traversal checks to get a green suite.

## 12. Deliberate limits

This is a generation and presentation overhaul. Dynamic flooding, seasonal water-level simulation, interactive erosion, groundwater flow, boat physics and a world-scale fluid solver are outside this release. Geological structure, coherent drainage constraints and carefully chosen visual rules provide the needed believability without those systems.

The hardest parts are compatible drainage around fixed crossings, deterministic ownership beyond one planning region, and exact shores across different mesh detail. Address those before investing heavily in shader polish. If they fail, attractive reflections will only make the wrong shape more visible.
