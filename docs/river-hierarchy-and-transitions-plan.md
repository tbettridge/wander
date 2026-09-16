# River hierarchy, width variation and lake transitions

Status: partial implementation in explicit previews; see the checkpoints below for delivered work and remaining rollout gates.

This extends the mountain-to-valley watershed plan. It makes river hierarchy and waterbody transitions explicit requirements of that work, rather than adding a separate random-width pass. Existing river and crossing locations may change. All existing bridge styles must remain functional at suitable sites.

## Experience to deliver

Most waterways should be small streams and modest rivers. Less frequently, a player should discover a substantially larger valley river, with smaller tributaries feeding it, that can be followed to an ocean outlet. A distant view should make that hierarchy readable. Walking along a river should reveal purposeful changes: narrow confined stretches, wider bends and pools, asymmetric banks, and gradual changes after tributaries join.

At a lake, a river should become part of the lake's landform: an inlet channel opening through the shore, a bed that continues below the lake surface, or an outlet leaving through a plausible spill point. The water should not resemble two intersecting strips or a tube attached to a pond.

Tributaries normally feed the main river. Branches that split downstream are distributaries, reserved for a later delta feature rather than scattered arbitrarily through the network.

## What the current code explains

- `src/riverterrain.mjs:70–175`: `prepareRiverReach` defaults to a 4 m half-width. Width variation is `1 + 0.12 * sin(arc / 110)`, with additional bend/constriction factors. It is small, repeats the same pattern, and restarts with each reach's arc. The input half-width is capped at 22.5 m. Bounds also assume a single nominal half-width.
- `src/rivercomponent.mjs:7–54` and `src/rivernetwork.mjs:8–76`: the network merges routes and solves connected water levels, but does not assign widths from accumulated catchment contributions. Adding tributaries therefore does not establish a convincing hierarchy of channel sizes.
- `src/basininlets.mjs:7–60`: lake inlets use a fixed 2.4 m half-width and locally sampled source candidates. The current default is two inlets, with a maximum of three. That count is a planning budget, not a drainage model.
- `src/riverterrain.mjs:280–309`: river/lake contacts already constrain overlapping sections to the lake level. Those safeguards are valuable, but level agreement alone does not design an inlet's shoreline, bed, banks or current transition.
- `src/riverjunctions.mjs:4–59`: junction ownership relies on overlapping bank envelopes sharing the solved head. Fixed-length flat junction collars can become visually dominant as rivers grow; their size should follow the actual intersection geometry.
- `src/hydrologyregions.mjs`: local candidate ownership and whole-object rejection do not yet create a stable multi-region drainage hierarchy. Simply increasing the default width would make fitting and memory failures more frequent without solving this.

## 1. Establish river classes and measurable rarity

Use the following as initial art-direction ranges for total visible channel width, not guaranteed dimensions at every section or strict buckets in the generator:

| Character | Initial width range | Intended occurrence |
|---|---:|---|
| Headwater / small stream | 1–3 m | Very common in suitable catchments |
| Stream / small tributary | 3–8 m | Common |
| Medium tributary / river | 8–20 m | Less common |
| Main valley river | 20–50 m | Uncommon |
| Large trunk river | 50–100 m | Rare, broad-valley and ocean-connected sites |

These ranges overlap through continuous interpolation. Widths beyond current fitting limits are gated on terrain feasibility, tile partitioning and bridge support; they are not enabled by lifting the existing cap alone.

Start tuning toward roughly 5–10% of suitable coastal drainage systems containing a main river above 20 m, with the largest class in roughly 1–3%. Measure this by independent drainage systems, not detail regions or mesh counts. These are provisional tuning targets: first measure terrain suitability and rejection rates, then lock a seed-corpus distribution that delivers the intended rarity. Include river length and actual walking encounters so one long main river does not overwhelm the landscape despite being a small count of systems.

Do not force a large river into an unsuitable region to meet a quota. Conversely, record why large proposals fail so byte caps or narrow-channel assumptions do not silently eliminate the rare class.

## 2. Plan a drainage hierarchy before assigning widths

Extend the planned deterministic parent drainage graph above the 4,096 m detail-region scale. Store canonical reach IDs, source contributions, downstream receivers, tributary junctions, lake nodes and ocean outlets. Accept a trunk corridor and its feasible downstream destination before generating its detailed banks and tributary attachments.

Use contributing drainage area and a deterministic moisture/runoff weight as a discharge proxy. This is a stable generation model, not a full fluid simulation. Accumulate upstream contributions once through a directed acyclic graph. Shared route suffixes must not count the same drainage twice. At a confluence, the downstream contribution combines both branches; at a through-flow lake, its outlet carries the incoming contributions plus the lake's local catchment, without treating lake surface area as an extra independent river source.

Derive widths from a calibrated sublinear mapping of that proxy, modified by valley confinement and bank material. Store the accepted width/depth profile and drainage identity before baking sparse meshes; do not try to recover missing discharge or centerlines from the compatibility adapter's mesh bounds.

The downstream plan must be stable before upstream detail is visited. Use bounded parent dependencies and shared boundary contracts for level, position, width, bank footprint and flow. A newly loaded tributary must not widen an already visible river. Define explicit natural terminals for closed basins; an unloaded region or exhausted search budget is not a valid sink.

A large river must have a verified continuous path to the ocean, possibly through lakes. If existing terrain cannot support it within earthwork limits, use the separately versioned broad valley-shaping stage already contemplated in the watershed plan. Do not create tall filled berms or relax bank containment to force acceptance.

## 3. Give each reach an organic width and cross-section profile

Replace the repeated sine multiplier with deterministic variation tied to the continuous river identity and physical distance along it. Combine:

- A gradual baseline responding to accumulated drainage.
- Valley confinement: narrower passages through constrictions, broader sections in suitable open ground.
- Bend geometry: asymmetric inner deposition shelves and deeper outer channels, with bank widths and slopes changing coherently.
- Smooth pool and shallow-run sequences where grade and bed material support them.
- Low-frequency seeded variation that adds local character without regular pulsing or a sawtooth shoreline.

Initially aim for about 10–25% ordinary local variation, with larger expansions only when supported by a pool, valley opening, confluence or lake transition. Smooth the profile over several local channel widths and bound its rate of change. Constant-width bedrock reaches remain valid; every segment does not need decorative widening.

Increasing discharge does not mean instantaneous widening at a junction, nor strictly increasing width at every downstream sample. A confined section can become deeper. Compare characteristic widths across unconstrained upstream/downstream stretches, while conserving drainage contribution through local constrictions.

Fit left and right banks, depth, shelves and terrain influence together. Recompute spatial bounds from actual section envelopes. Scale bend-radius checks and sampling to the resulting footprint, rejecting self-intersections and unsupported banks. Water elevations continue to follow the solved downstream profile; width changes must never be achieved by curling water toward low ground.

## 4. Design confluences and ocean mouths

Make a confluence an explicitly owned transition area. Blend incoming bed channels and bank lines into the receiving river; remove internal banks from the wet intersection. Prefer plausible joining angles when routing tributaries and avoid parallel channels touching through a thin accidental gap.

Use shared levels where surfaces meet, with the smallest terrain-feasible transition collar. Blend current direction and turbulence through the junction so material animation follows the joined channel. Width and depth changes should develop over a coherent downstream reach, not as a circular bulge at the meeting point.

For ocean outlets, fit a coast-connected estuary or simple mouth according to shoreline slope and available valley width. Continue the bed into submerged terrain, taper banks into the coast, and blend river flow/turbidity into ocean water. Validate a real ocean connection, rather than treating any sea-level point as an outlet. Start with single-channel mouths; broad sediment deltas and braided distributaries are a separate, later feature.

## 5. Treat lake inlets and outlets as distinct landforms

Add explicit contact descriptors carrying the lake ID, reach ID, role, contact position/tangent, lake level, channel profile, transition extent and shared ownership. A lake shoreline and its attached channels must be fitted together in these areas.

For an inlet:

- Continue the channel below the lake surface and gently merge its bed into the basin.
- Open the banks into the shoreline with asymmetric, terrain-dependent shoulders; taper vegetation and bank ridges out of the wet opening.
- Use a modest submerged sediment fan or shallow shelf where a low-gradient inlet supports one. A steep rocky inlet should retain a different, tighter shape. Do not give every inlet a triangular delta.
- Gradually reduce directional current and turbulence as the channel enters open water. Optional sediment colour should follow the inlet and dissipate into the lake, rather than forming a hard material seam.

For an outlet:

- Select a plausible spill point and form a stable channel throat that gathers water from the lake.
- Maintain exactly the lake's head at the contact, then solve a downstream fall through the outlet reach.
- Avoid a residual lake-rim barrier, underwater bank wall or abrupt full-depth trench across the shore.

Multiple inlets should come from distinct catchments. Closed lakes remain valid; through-flow lakes normally have one ordinary outlet. Inlets must not be mirrored duplicates or clustered solely because a local search found several easy fits. A large river entering and leaving a lake should preserve its drainage identity while the lake itself remains a level surface.

## 6. Integrate size, rendering, crossings and streaming

Partition long and wide systems into bounded terrain/water tiles sharing the accepted profiles. A large river must not be dropped because a single connected mesh exceeds the existing region byte budget. Keep scheduling and geometry budgets separate from geographic existence.

Use the same profiles for distant silhouettes, intermediate banks, nearby meshes and collision. The current 8 m hinted overview sampling can still lose small channels; large trunk-river silhouettes and lake transition outlines require constrained geometry, not simply a denser grid everywhere. Preserve terrain occlusion and consistent near/far shorelines.

Bridge placement must use the actual wet span, bank clearance and approach terrain. Keep every existing bridge style represented across suitable widths. Reposition crossings where necessary; do not stretch a small bridge over a 100 m channel. Survey viable narrow sections or implement the appropriate large-span support before claiming large-river crossing coverage. Water depth, walking slowdown and swimming must agree with the visible channel at every width.

Retain startup-only parallel candidate generation, bounded queues, stale-result rejection and atomic terrain/water publication. New cross-region dependencies must not recreate hitching while walking. Package geographic data independently of detailed meshes and increment generation/cache/save/multiplayer identities for changed geography.

## Implementation order and delegation

The orchestrator first defines the drainage, section-profile and contact interfaces, plus diagnostic fixtures. Then use three Luna agents at Max effort with exclusive file ownership:

1. **Drainage agent:** stable parent hierarchy, accumulation, rarity, coastal receivers and boundary contracts.
2. **Channel agent:** variable-width/depth fitting, bank shapes, confluence geometry and footprint bounds, initially against fixed interface fixtures.
3. **Lake/coast agent:** inlet/outlet contacts, bed/shore blending, simple estuaries and their visual fixtures, also against fixed interfaces.

The orchestrator integrates the interfaces, reviews numeric and geometric invariants, checks actual renders at overlook/bank/waterline positions, and runs performance comparisons. Agents should not all edit the planner or renderer simultaneously. After the geometry milestone, assign subsequent bounded tasks for tiled LOD, crossings and water/shore visual polish; retain Luna Max and orchestrator review.

Milestone A: measurable width hierarchy and organic profiles in deterministic fixtures, including small streams and a broad river, with no new floating-water defects.

Milestone B: one real multi-region, ocean-connected trunk with several visibly smaller tributaries, preserving its shape under reversed generation order and cache eviction.

Milestone C: small and large lake inlets, a through-flow lake, a multiple-inlet lake, a closed lake and an ocean mouth pass close-up visual review and terrain checks.

Milestone D: production near/far transitions, all bridge styles, encounter-frequency tuning and the performance corpus pass before broader rollout. Keep the new generation behind an explicit preview until then.

## Acceptance gates

- **Hierarchy:** seeded showcase systems include at least three visibly distinct size classes; a large trunk is several times wider than its small tributaries. Corpus reports distinguish natural rarity from fitting/budget rejection.
- **Width character:** ordinary unconstrained reaches show smooth, nonperiodic variation over a walkable stretch, without reset seams at reach/tile boundaries or repetitive pond-sized bulges. Confined stretches may remain uniform for a visible terrain reason.
- **Drainage:** no cycles, duplicated contributions, unexplained inland ends or region-edge sources. The ocean-connected showcase has a continuous verified downstream path and at least two genuine tributary confluences.
- **Contacts:** each showcase inlet/outlet has a continuous wet path and bed, matching shared contact heads within existing solver tolerance, no internal dry ridge, no overlapping independently solved surfaces and no floating or bent-down water. Lake levels remain flat.
- **Geographic stability:** accepted IDs, centerlines, width/depth samples, lake outlines and boundary values remain unchanged across generation order, distant/near tiers, cache eviction and revisits.
- **Crossings:** every existing bridge style has at least one valid approach/deck/collision fixture; representative medium and large rivers have feasible crossings. No bridge is accepted beyond its supported span.
- **Visual review:** inspect top-down, mountain overlook, along-channel, bank-height and waterline views for forest, open valley, rocky confinement and coast. Include unequal tributaries, sharp-but-valid bends, multiple inlets and negative/cross-region coordinates. A passing unit test is not a visual approval.
- **Performance:** full-game first generation remains <=35 s and persisted reloads <15 s on the agreed benchmark setup. Keep browser-restart and device validation explicit. Compare the same walking route to the current hitch baseline; target <=4 ms scheduled main-thread water work per frame, with no new water-attributable >=50 ms stalls. Record p95/p99 frame intervals, long frames, memory, cache hits and worker queues; total frame time must not be confused with water-only work.

The recent local startup results (seed 2: 25.35/10.15 s; seed 4242: 22.42/8.62 s cold/cached) are baselines, not evidence that the larger hierarchy already fits those budgets. No reduction in river quality, erased distant channels or weaker containment checks is an acceptable way to meet the limits.

## Scope boundaries

This is terrain-aware procedural generation with a stable flow proxy, not a real-time erosion or fluid simulation. Dynamic flooding, seasonal channel migration, waterfalls, braided networks and elaborate multi-mouth deltas are outside the first implementation. First deliver convincing channel hierarchy, variable banks and coherent lake/ocean transitions, then extend the forms if the foundation and budgets hold.

## Implementation checkpoint — 16 September 2026

The first implementation is available in explicit inspection previews. It is not the regional rollout or completion of milestones B–D.

- `riverhierarchy.mjs` accumulates distinct upstream contributions on the existing merged graph, preserves contributions through explicit lake nodes, requires declared receivers, and reports widths beyond the supported fit cap rather than shrinking a modeled large trunk. The network preview uses a unit per sampled headwater, explicitly labeled as a local catchment proxy. It does not yet survey cross-region contributing areas or establish trunk rarity.
- `rivercharacter.mjs` and `riverterrain.mjs` supply seeded, nonperiodic width/depth profiles, authored global trend intervals, actual section-envelope bounds, and rejection of unsupported realized widths. Legacy fits retain their original path when the profile is absent. Existing bend, water-head, excavation and approach constraints remain active.
- `lakecontacts.mjs` locates distinct inlet/outlet contacts against connected lake membership. The optional sparse-mesh integration fades currents inside the lake; it does not change the water head, wet ownership, shoreline or bed. Bank-taper metadata is available but terrain reshaping, spill throats and submerged sediment fans are still pending.
- The shared river shader now anchors ripple phases in world space and uses bounded, cross-faded current advection. This removes the large phase discontinuities produced by rotating world-position coordinates with changing flow directions. Calm water avoids the second advection sample.

Inspection entries:

- `river-lab.html?fixture=12`: generated terrain, seed 20260612, three sources, two confluences and a verified ocean handoff; section widths approximately 2.9–7.6 m.
- `river-lab.html?fixture=13`: seed 42, basin `basin:42:4032:960`, one inlet and one outlet with two explicit current transitions.
- `index.html?wanderSeed=20260612&waterPreview=character`: the character network in the game preview.
- `index.html?wanderSeed=42&waterPreview=drainage&waterPreviewBasin=basin:42:4032:960&lakeTransitions=1`: the lake-current preview in the game.

Validation includes a synthetic broad-valley component with three distinct channel sizes and a roughly 35–40 m broad channel, actual sparse meshes, protected bank approaches and the ordinary cut/fill budgets. This is a geometric fixture, not evidence of naturally occurring broad trunks in regional generation. The generated-terrain integration checks reversed source order, visible installed water, exact low/high terrain-detail agreement, and rendered shoreline contact within 2 mm. Lake-current integration checks unchanged coordinates, heads, beds, wet masks and dry-cell flow. Browser overview and bank-height views were inspected for both fixtures.

The final full test run passed 802 tests with six existing TODOs and no failures. Review added checks that the dominant tributary retains its noise identity and phase through a confluence, and that centreline smoothing preserves the canonical phase at the downstream endpoint while water grades still use physical distance. The prior full-game loading measurements remain the baseline. These isolated previews do not certify the new cross-region system against the <=35 s first-generation and <15 s persisted-load gates; those gates remain required before rollout, together with walking-frame and device validation.

Next: implement the parent cross-region drainage and boundary contracts, validate genuinely broad ocean-connected trunks, then apply the explicit lake contacts to shoreline/bed shaping and complete the close-up visual corpus. Production near/far geometry, wider bridge spans and encounter-frequency calibration follow the same acceptance gates above.

## Terrain-aware meanders

The coarse route graph is a drainage skeleton, not a finished river shape. Its 64 m routing grid and strong turn cost favor straight runs. A separate bounded shaping pass now proposes broader bends before the final section fit. Low-gradient, open reaches should wind more; short, confined or steep reaches may remain straighter. Bends must vary in spacing and size rather than tracing a repeated sine wave.

The shaping pass runs once per completed network component, after source routing. Endpoints and junction/mouth approach collars remain anchored. The original graph distances continue to locate width/depth character along the drainage system; the displaced physical arc controls hydraulic grades. Fitted sections and their accepted sparse grid are authoritative for terrain, water and collision. Raw graph/routes remain routing references and must not be treated as displaced geometry by future connection code.

Every proposal passes the ordinary terrain fit, junction ownership and sparse mesh checks. Up to three decreasing strengths are attempted; unsuccessful changes retain the original component and expose their rejection reasons. Validation does not weaken bend-radius, cut/fill, water-head or ocean-handoff requirements. The accepted mesh is reused for worker readiness and publication to avoid baking the same grid three times.

The final fitted curve is also checked for nonlocal bank-envelope overlap after Hermite resampling. Proposal clearance includes the widest authored trend, width variation, outer-bank widening and the complete bank/blend footprint. This closes the gap between a safe coarse proposal and a potentially overshooting fitted curve.

`river-lab.html?fixture=14` is the meander inspection entry; fixture 12 retains the character-only comparison. The game character preview enables meanders, with `riverMeanders=0` available for comparison. This is still an explicit preview: the regional cached generation, lake-contact shaping, large cross-region trunks, near/far rollout and bridge coverage retain their existing gates.

Validation checkpoint: seed 20260612 retains three sources, two joins and the verified ocean handoff. Two reaches are reshaped, with maximum fitted excursion 21.04 m; the shorter curved reach has sinuosity 1.056. Three short or constrained reaches keep their existing geometry. The final preview hash is `3dd0bc88`, with actual section widths 2.73–7.62 m. The inspection camera targets the reach with the clearest increase in winding rather than merely the greatest lateral shift.

Nine new tests cover deterministic seeded bends, steep/confined retention, endpoint heading at a curved collar, bounded sampling, exact canonical character phase in fitted junction sections, generated-terrain connectivity, cut budgets, ocean handoff, visible installed water, identical low/high-detail geometry, baseline fallback and final bank self-overlap rejection. The complete repository suite passes 811 tests, with six existing TODOs and no failures (`/tmp/wander-meanders-full-tests.log`). Browser overview and bank-height views were inspected. Full-game 35/15-second loading gates have not been re-certified for a regional rollout; this pass is outside the regional walking stream.

## Bend width and tributary growth

The next character-preview pass adds `riverMorphology` to the network entry and an explicit `morphology` flag on fitted channel profiles. This keeps the earlier inspection fixtures available as comparisons. Fixture 15 adds views of a headwater, a bend, a tributary join and the downstream river, including averages measured over physical channel distance. The game character preview enables this pass by default; `riverMorphology=0` selects the previous width behavior.

The key distinction is between local bank shape and accumulated river size. Smooth bend-aware multipliers form modest bulges and asymmetric shallows; the drainage graph determines the underlying average width. Tributary growth should settle over several channel widths after a join rather than being stretched across an entire downstream reach. A short reach ending at another tributary must hand its actual, partially completed width trend to the next reach. Canonical route distance continues to control noise phase independently of that shorter growth interval.

The clearance calculation shares its maximum width bound with the character fitter, including longitudinal variation and bend asymmetry. Tight bends must retain safe bank footprints rather than forcing the whole river to straighten to accommodate widening. The final physical fit, bank self-overlap check and sparse mesh remain the acceptance authority. This does not change regional cached generation or certify the pending cross-region catchment, large-river, lake-shaping and loading-time rollout gates.

Validation checkpoint: the generated seed 20260612 fixture retains all three sources, both confluences and its ocean outlet. Its distance-weighted mean channel width grows from 3.50 m at the narrowest headwater to 9.42 m downstream (2.69×), compared with 3.10 m to 5.67 m before this pass. Local bend widening is capped at 30%; side asymmetry adds at most 10%. Terrain confinement and raw-curvature fold risk suppress enlargement where needed. The accepted meanders retain strength 1 and 21.10 m maximum excursion, rather than falling back to straighter paths to accommodate wider banks.

Browser review covered the bend overview, bank-height view along the bend, tributary junction and downstream river, with production water material and no console warnings or errors. The generated preview hash is `85c22519`; its actual section widths span approximately 2.6–10.3 m. This fixture also exposes existing angular coastal ground-colour transitions in overhead views; this pass does not replace that terrain material. These local measurements do not establish a cross-region catchment distribution or certify the full-game loading gates.

Final validation: the full repository suite passes 825 tests with six existing TODOs and no failures (`/tmp/wander-width-full-tests.log`). Fourteen added tests cover bend shaping, confinement, tributary accumulation, short-reach continuation, authored-profile sampling, deterministic topology and canonical phase, retained meander amplitude, unsafe-width rejection, and exact low/high-detail wet geometry with shore contact. The nominal width helper now evaluates the authored response interval rather than interpolating sparse route samples; a short reach preserves its unfinished response and passes its actual sampled endpoint to the next join. `git diff --check` passes and the Graft graph was refreshed.

## Default-world rollout — 2026-09-16

The user approved the bend/width result and requested that the current river,
pond and lake implementation become normal world generation for testing on
GitHub `main`. Ordinary startup now prepares a regional water window without a
`waterPreview` query. Explicit inspection modes remain separate. Hydrology
revision 7 invalidates earlier candidate caches and host/guest agreement
identities so old river courses cannot silently survive the update.

This promotion covers the implemented regional water system and current channel
character. It does not claim completion of the separate cross-region watershed
hierarchy or the mountain-scale near/far rollout described above.

Normal startup now selects dry, gently sloping ground within 32 m of an
accepted lake shoreline and faces toward the water. It commits the surrounding
walking window before scene construction, preserves the same verified bank
through recentering, and searches bounded neighbouring windows if necessary.
Station preparation cannot relocate this lake start. The opening action reads
“Begin by the lake”.

Default-launch browser check on the development machine: no query parameters,
30.71 s cold (25 persistent misses), 9.91 s after reload (25 persistent hits),
including the lake-shore window handoff, terrain, water, collision and a rendered
frame. Both meet the 35 s / 15 s targets in this sample; these are not device-wide
or every-seed guarantees. Water was visible from the forest lakeshore. Automated
pointer lock was denied by the embedded browser, so walking/device validation
remains with the user as agreed. No application errors were logged.

The repository suite passed 838 tests with six pre-existing TODOs and no
failures (`/tmp/wander-default-full-tests-final.log`). Startup tests cover default
regional dispatch, safe bank selection through lake/pond edge blends,
pre-scene recentering, exact bank revalidation and bounded missing-lake search.
The seed 1 default region retains a joined lake/river system and remains below
the 3 MB regional descriptor budget; incompatible proposals still reject rather
than publishing uncontained water.

Final integration checks also cover a connected lake's real `World.riverAt`
identity and safe shore in seed 4242, region (1, 0), and a lake connection whose
receiving path has moved away from its original routing grid. Junctions use the
fitted path. Compatibility retries retain existing lake inlet reaches and
rebuild junction ownership from the final endpoints. The final focused regional
suite and staged whitespace checks pass.
