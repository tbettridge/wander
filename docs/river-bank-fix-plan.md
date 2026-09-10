**Wander river diagnosis and implementation plan**

Prepared 9 September 2026 against commit `85e5114`, then updated during implementation. The diagnosis and measurements below describe that original commit. Game behavior has now changed; see the implementation status immediately below. The supporting [audit](river-analysis/audit.mjs), preserved [baseline measurements](river-analysis/baseline.json), and [current measurements](river-analysis/current.json) are available for comparison.

**Implementation status — 9 September 2026**

The bank/shoreline milestone is implemented. The complete drainage-network plan below is **not complete**.

Visibility follow-up: a cached pre-revision `World` paired with the new mesh builder reproduced invisible rivers: `riverAt` was wet, but the missing `signedDepth` field left every sample at the builder's default zero, so it returned no river mesh. The sampler now detects a missing signed field and derives legacy depth from final ground. Game, world, terrain-worker and mesher asset URLs are revised together to fetch matching code. `tests/riverworker.mjs` covers that mixed-version reproduction and the actual transferable worker payload. Fresh full-game rendering was also inspected with visible water; the user's exact browser cache state was not available to confirm that it was their trigger.

- `World` now samples natural terrain separately, projects candidate channels onto a globally anchored 24m planning grid, probes both banks, and lowers the section's water level when the lower bank cannot contain the old level. The bed and two raised bank shoulders use that common surface. The old distance-to-edge water sag is removed. Cached planning is deterministic across query order and eviction.
- Terrain and water retain the same mesh grid and triangle diagonal. Water triangles are clipped using signed depth, ending at their rendered terrain intersection. Shared edge intersections reuse vertices; the old geometric water lift is removed.
- Railway earthworks respect the river bed/bank corridor. Final water depth is recomputed against final ground. Dry tunnel-cover earthworks remain permitted. Station approaches now share a tangent, fixing sharp joins exposed by the changed terrain.
- Changed dry landmarks exposed disconnected trails and cave-mouth chords; trail connectivity and mouth avoidance now cover those cases. Partial-edge journey progress and crossing clearance were also corrected.
- New station geography exposed repeated village identities, nearby frontage twins, blocked door approaches and undersampled foundation edges. Station layout seeds now hash the full railway identity; frontage allocation checks nearby profile similarity; door approaches reserve clearance against neighbouring foundations; foundation probes are at most 1m apart.
- The world and settlement cache revisions were bumped. This changes regenerated rivers, routes and villages for existing seeds. It does not implement saved-position migration or multiplayer version admission.

Validation:

- `npm test`: **609 passed, 0 failed, 6 TODOs** (615 total). After subsequent mesh allocation and planning-cell cache optimizations, the focused river suite passed again and the geometry audit remained byte-identical.
- Four cross-sections in two seeds have water and containing banks on both sides. The original reproduction remains continuously wet across the tested 50m span, with less than 8cm of water-height variation.
- Shoreline vertices contact rendered terrain within 1mm across eleven terrain resolutions. A separate 1,800-chunk coarse-grid sweep over two seeds checks more than 10,000 shoreline contacts.
- The 4km audit windows have zero legacy head/surface sag cases (previously 69 and 105). In the original nine-chunk area, centroid probes find zero omitted or buried wet samples at resolutions 96, 48, 24 and 16. These are sampled coverage checks, not a proof that arbitrarily narrow channels are resolved.
- The railway audit finds zero stale floor mismatches in 8,633 wet probes (previously 211 mismatches). Probe grids overlap.
- Browser inspection of the original section at walking height and overhead shows continuous bank contact with both solid diagnostic water and the production water material. Resolution 16 was inspected overhead. This is a standalone mesh inspection, not an XR or full-game playthrough.
- Cave collision regression fixtures retain the original terrain through a test-only legacy sampler, preserving their original assertions. Current-generation cave tests remain in the full suite.
- Village identity comparisons now include actual wall/roof fabric and trim hue, which the previous first-building style signature omitted. The design distance budget is unchanged. The known trade-coupling snapshot was explicitly remeasured at approximately 0.026 excess for thirty distinct villages; it remains below the 0.15 target and is not presented as a solved feature.

Run `npm run serve` and open [the inspection scene](http://localhost:8474/river-lab.html). Run `node docs/river-analysis/audit.mjs` for geometry measurements and `node docs/river-analysis/performance.mjs [baseline-checkout]` for the CPU benchmark. Timing results are recorded in [performance.json](river-analysis/performance.json): warm median terrain-plus-river construction is 7.83ms versus 6.71ms, with p95 10.05ms versus 7.72ms. The roughly 30% p95 increase exceeds the original proposed 20% target and needs further optimization before claiming that performance gate. These are local CPU measurements, not a device or GPU performance guarantee.

Still unfinished from the larger plan: connected reach IDs and downstream solving; guaranteed monotonic water levels through confluences; basin/outlet and explicit waterfall planning; enforced whole-reach incision/fill budgets; adaptive recovery of channels between mesh samples; mixed-resolution shoreline stitching; coast/tide/cave-cut ownership fixtures; save migration and multiplayer compatibility admission. The current centreline projection is approximate, and broad critical points in the noise field do not yet have basin semantics. The 2m fill value constrains the planning probes, not every point of the final terrain. Do not interpret the passing fixtures as a universal containment or drainage proof.

The recommended fix is to generate each river's route, water level, bed, and two banks together. The water surface should remain level across a channel section and descend along the river. The terrain must rise to contain it, and the rendered water must end at that terrain intersection. Where the landscape cannot support the proposed level, the generator should adjust the river's level or route over a continuous reach, or create a valid basin and outlet.

**What is causing the problem**

1. **The reported bending is explicitly authored into the world model.** In `src/world.js:190–195`, `edge = smoothstep(0, 0.18, ch)` drives `waterY = lerp(floor - 1.2, headY, edge)`. Consequently water follows the intended head in the channel interior and bends toward a point 1.2m below the ground at its margins. This hides a formerly exposed edge by deforming the surface. The same result feeds both river meshes and gameplay queries; it is not a ripple shader effect.

2. **There is no containment constraint for either bank.** In `src/world.js:164–181`, the route is a band around a warped noise zero contour, water level is continental elevation minus 0.8m, and local terrain includes independently generated hills and hollows. Carving only removes material: `max(h - targetFloor, 0) * ch^1.6`. If the landscape beside the channel is already lower than the water, this operation cannot make a bank. The valley mask suppresses channels on high ground but does not establish a containing edge on low ground.

3. **The current “head” is not a solved river profile.** A smooth elevation field is not sufficient to guarantee downhill travel along an independently generated path. It can slope across that path, contain local extrema, and disagree at apparent connections. `buildRiver` uses the downhill gradient of that field for animation, rather than a downstream direction derived from channel connectivity. Comments claiming the river never climbs hills are stronger than the implementation guarantees. This is an architectural finding; the audit does not claim to have traced every current river's drainage.

4. **Water and terrain already share a grid within each chunk, which should be preserved.** `src/chunkgen.js:59–87` samples both together; `:459–465` uses the terrain's triangle diagonal. This prevents the old independent-grid disagreement within a chunk. However, it makes the bent water agree with the sampled terrain; it does not create physically valid banks. The mesh emits whole cells touching a wet vertex, rather than clipping triangles to a shoreline.

5. **Depth and shoreline information are lost during sampling.** `src/chunkgen.js:80–86` replaces negative depths with zero and applies wetness cutoffs before interpolation. `buildRiver` then raises water vertices by 0.02m. The shader interpolates these clamped values to estimate water depth and fade the edge (`src/river.js`). This cannot recover the exact signed water/terrain separation inside a partially wet triangle. Separate depth thresholds and the 0.30m alpha fade can further affect shallow margins. These are secondary contributors, not an explanation for metres of bending.

6. **Later earthworks invalidate the claimed shared-surface guarantee.** `src/railwayterrain.mjs:420–423` returns modified terrain but leaves `riverInfo.floor` at its pre-earthwork value. Both `riverAt` and the worker's depth calculation trust that stale floor. Raised earth can bury water that is still reported wet, and lowered earth can undermine an otherwise valid bank. Cave and tunnel terrain cuts also need explicit boundary checks because they can remove containing geometry after ordinary terrain generation.

7. **Sampling changes with quality and distance.** Chunks are 140m wide; desktop near resolutions are 48, 56, 72, 96, and 112, and XR uses 80. The distance ladder also includes coarser resolutions down to 16. Terrain skirts hide ground seams, but river boundaries have no corresponding cross-LOD stitching contract. A bank narrow enough to fall between samples can move or disappear as detail changes. Different-grid seam failures remain a validation target; this audit measured within-chunk discrepancies, not a browser-visible seam.

**Measured reproduction**

The audit samples a 4km by 4km square around the origin every 10m, independently for seeds `20260612` and `4242`. It found 69 of 4,398 wet samples in the first seed and 105 of 7,065 in the second where the effective water is more than 1m below its intended head. These are counts in this sampling window, not estimates of the percentage of all rivers or their affected length.

At seed `20260612`, position `(-550, -960)`, the ground is 4.559m, the effective water is 5.705m, and the intended head is 11.721m. Moving inward along the local channel-mask gradient gives:

| Distance inward from that point | Ground | Effective water | Intended head |
| --- | ---: | ---: | ---: |
| 0m | 4.559m | 5.705m | 11.721m |
| 2m | 4.634m | 8.651m | 11.668m |
| 4m | 4.972m | 11.308m | 11.615m |
| 6m | 5.570m | 11.562m | 11.562m |

The effective surface rises 5.857m over 6m inward, while the intended head changes by just 0.159m. Twelve metres outward, the channel mask is zero but the ground is still roughly 3.94m below the extrapolated head: there is no containing bank there at that level.

This survives real mesh generation. At that coordinate, the 96-resolution mesh places water at 5.813m, including the 0.02m render lift; the intended head is 11.721m. Resolution 16 instead places water at 7.738m. Increasing detail cannot repair the underlying surface definition.

In nine chunks around this example, sampling the two triangle centroids per cell found 4 procedurally wet points hidden below rendered terrain at resolution 96, 21 at 48, 33 at 24, and 24 at 16. The sample positions differ by resolution, so the raw counts are not directly comparable rates. No wet sample in this particular sweep was omitted because all four cell corners were dry; that remains a possible sampling failure to cover with a synthetic fixture.

A separate audit of the default regional railway found 211 sampled wet locations where final ground and the reported river floor differ by more than 0.25m. Around `(1583.110, -6728.737)`, the query reports 1.392m of water, but water is actually 7.898m below the modified ground. These probe grids can overlap and are not counts of distinct broken crossings.

To reproduce, run `node docs/river-analysis/audit.mjs`. For a later visual inspection, open the game with `?wanderSeed=20260612` and use `__wander.teleport(-550, -960)` in its debug console. The audit inspects the procedural model and actual generated arrays; no in-game screenshots or GPU appearance checks were performed for this plan.

**Implementation sequence**

1. **Establish invariant tests and a river inspection scene.**

   Preserve the measured seeds and coordinates as regression fixtures. Add synthetic straight channels with a low hollow on either side, high obstacles, a narrow channel between coarse vertices, a confluence, a pond outlet, a coast transition, and a railway crossing. Give the inspection scene overlays for the unmodified ground, final ground, water surface, shoreline, bank crest, flow, and chunk boundaries. Include fixed walking-height and overhead cameras and quality switches.

   Tests should express the desired geometry rather than snapshot the old sinking surface: every ordinary open-water section has containing terrain on both sides; water does not slope down toward a lateral boundary; every lateral water edge meets solid terrain; and final depth agrees with final ground. Sources, mouths, junctions, and explicit falls need their own endpoint rules.

   Deliverable: a small set of known failing physical invariants and fixed camera locations. This becomes the gate for the following changes.

2. **Separate natural terrain evaluation from river planning and final-surface queries.**

   Extract the pre-river terrain calculation from `World.height` into an internal sampler that supplies natural ground and continental elevation. It must not call river planning or decorated world-height queries. Retain current numerical terrain values outside river modifications during this extraction.

   Introduce one immutable river descriptor containing a stable ID, connected reach IDs, centreline samples, distance along the reach, surface elevations, bed depths, left/right shoreline distances, bank profiles, and downstream direction. Use separate records for basins and explicit drops. A spatial index makes queries return only nearby descriptors.

   Compose the world in this order: natural terrain → channel and bank terrain → permitted earthworks → final ground and water-depth query. Rivers provide reservation corridors to railway planning so ordinary earthworks cannot dam or puncture them inadvertently. Resolve crossings as spans or explicit supported water passages. Recomputing depth after earthworks is required, but does not by itself make an obstructed river physically valid.

   Preserve the public `riverAt` fields during migration. Its `floor` must equal the final solid ground used by the ordinary surface query, and `depth` must derive from that value. Centralize wetness policy so `trails.js:383–386` and other consumers do not maintain duplicate rules. Keep separate, documented ocean/estuary ownership rules where appropriate.

   Deliverable: agreement between world queries, the worker, and gameplay, including the measured railway failure. Avoid recursive planning through `height` or `biomeAt`.

3. **Plan feasible river reaches and solve their water elevations.**

   Use the existing river noise as a candidate-placement preference to retain broad visual character. Trace candidate paths on a coarser, terrain-aware planning grid and connect them to declared sources, basins, junctions, and outlets. Give each reach a consistent downstream direction. Resolve loops as actual basins with outlets or reroute them; an arbitrary noise loop must not be treated as a draining river.

   At each section, probe both sides of the proposed route. Determine feasible shoreline positions and the water levels those surroundings can contain. Solve elevations along the whole connected reach with downstream levels never increasing, matched levels at junctions, and bounded grades for ordinary flowing water. Water elevation should depend on distance along a reach, remaining constant across its section. Derive flow animation from that reach direction and grade. Basin surfaces use one level determined by their containing rim and outlet.

   Where containment fails, try a lower profile and corresponding bed incision, then a local route/width adjustment and modest terrain reshaping. Propagate changed levels along adjoining sections so a repair does not create a sudden longitudinal dip. If no solution is feasible within terrain-change limits, replan the connected reach or produce a coherent source/basin/outlet arrangement. Do not silently turn off one cell or create an unbordered water edge.

   Start with an explicit terrain-edit budget, for example at most about 2m of added bank fill and 6m of new incision relative to natural ground for an ordinary reach. These are proposed tuning limits, not established values for Wander; validate them against varied seeds before fixing them. Exceeding a limit should trigger replanning, not larger automatic embankments. The measured 6m sag is exactly the case where simply lifting a wall of earth to the old water height can look artificial.

   Make planning independent of camera position, chunk detail, worker assignment, and generation order. Use globally anchored planning regions with canonical shared boundary ports, outlet elevations, and stable reach ownership. Establish coarse downstream connections before solving fine reaches. A sampling halo alone cannot guarantee matching water levels when neighbouring regions independently choose outlets. Define this seam contract before implementation and test reverse load order and parallel worker generation.

   Deliverable: feasible, connected water profiles with explicit endpoints and no lateral surface bending. This is the largest design change and should be proved on bounded fixtures before expanding to arbitrary world regions.

4. **Generate the channel bed and both banks from those sections.**

   Shape each cross-section through a submerged bed, shallows, the shoreline at the water level, a bank crest above it, and a smooth transition to natural terrain. Let the left and right profiles differ. Preserve a steeper outer bend, a gentler inner shelf, exposed rock, and regional ground character where appropriate. Change bank position and terrain shape for visual variation, while holding the section's water level constant.

   Use a smooth, explicit bed-depth profile; reduce terrain noise near the shoreline so it cannot puncture a bank between planned sections. Blend terrain modifications through a finite corridor. Join neighbouring sections continuously and validate between them, including bend interiors where independently swept profiles can overlap or cross.

   At junctions, construct one shared wetted area and compatible bed. Prevent one reach's bank from forming a dam across another. At a basin, validate its full perimeter, not merely two cross-section samples. Reserve longitudinal openings for real sources, outlets, and falls.

   Tentative ordinary-bank crest clearance is 0.3–0.8m above water, adjusted for local character and the supported wave/tide envelope. Bank slopes and blend widths must fit the rendering error budget and feel believable on foot. The shoreline itself remains at water level; the clearance applies to the crest behind it.

   Deliverable: terrain that contains water without extreme berms, abrupt profile seams, or punctures. Enable this together with removal of the sinking `waterY` interpolation; removing the interpolation alone would reopen the original floating edges.

5. **Clip water to the actual final terrain and preserve that boundary across detail levels.**

   In `buildTerrainArrays`, retain signed depth `D = waterY - finalGroundY` at every relevant sample, including dry samples. Candidate river coverage must come from the planned river domain and connected wet region, so a hypothetical water plane does not flood unrelated low terrain.

   In `buildRiver`, clip each terrain triangle to `D >= 0` within that domain. On an edge with opposite depth signs, use `t = D0 / (D0 - D1)` to locate the shared intersection and interpolate position and attributes. This is exact for the two piecewise-linear surfaces on that triangle. Emit only wet polygons and reuse edge intersections with stable keys. Shore vertices carry zero depth; interior depth comes from the actual interpolated separation.

   An external lateral river-domain boundary with positive depth is a failed containment invariant, not a legitimate place to cut off the mesh. Declared sources, outlets, junctions, falls, and stitched chunk boundaries have separate continuity rules. This check prevents a flat sheet with a floating side edge from returning under the new implementation.

   Keep the terrain and water on the same refined topology around the river. Where a bank or narrow wet channel is unresolved, refine both together, using descriptor bounds and interior/error probes rather than only corner wetness. Start with a shared minimum detail in river corridors, then optimize using measured error. Subdividing water alone would reintroduce the old terrain mismatch.

   Update `Terrain.renderedHeightAt` and trail/prop seating helpers that assume a fixed grid to sample the same refined triangles. A base grid with indexed per-cell refinement overrides can preserve cheap lookups away from rivers. Reuse the existing triangle-interpolation convention in `terraincut.mjs`; bilinear quad interpolation is not generally equal to the rendered pair of triangles.

   Different terrain resolutions are not always nested in Wander. Establish canonical river-boundary samples at chunk edges and transition triangulation that both water and terrain consume. Preserve connectivity when simplifying distant rivers. Ground skirts do not count as riverbanks or as a water-seam solution. Publish terrain and water for a revised chunk together, and reject stale worker results using terrain and river-plan revisions.

   Replace the unconditional 0.02m geometric lift with a bounded depth-buffer bias, or a lift that tends to zero at the shoreline if a visual test establishes a need. Tune foam and alpha only after the boundary is correct. Review the shader's transparent depth writes and existing ocean handoff so invisible geometry does not occlude valid surfaces.

   Deliverable: water ending exactly on the visible bank, complete wet coverage, and stable shorelines while walking between chunks or changing quality.

6. **Integrate mouths, falls, material treatment, and world consumers.**

   Plan ocean mouths with a shared endpoint elevation and ownership zone. Validate the existing ±0.18m tide range at minimum and maximum tide; preserve river/ocean palette continuity while eliminating exposed lips or overlapping slabs. A tide transition is a longitudinal mouth condition, not permission to curl lateral edges downward.

   Author falls at planned longitudinal drops with a terrain lip and receiving pool. Replace the current `2m per cell` fall criterion with reach events and a resolution-independent criterion. A lateral shoreline must never create a waterfall. Basin and confluence joins must agree on water height and mesh ownership.

   Use actual shoreline distance and water depth for damp ground, silt, gravel, reeds, foam, and bank rocks. The current sea-level ground wetness treatment cannot describe an inland bank by itself. Dress the resolved terrain after geometry and placement queries agree.

   Recheck bridges and approaches, player/NPC wading and underwater effects, animal water access, vegetation exclusions, settlements, cave mouths, and railway portals. Derived plans must be rebuilt against the new river version; they must not continue using crossing locations or elevations selected from old wetness.

   Deliverable: the new geometry works as part of Wander's world rather than only in an isolated water mesh.

7. **Validate, profile, and release as a versioned world-generation change.**

   Run the new geometric tests, then the existing trail-crossing, walkable-surface, grounding, railway-terrain, settlement-placement, vegetation, and terrain tests relevant to the change. Add a nightly or explicit development seed sweep; keep the normal test suite focused on a small, diverse fixture set.

   Compare walking-height and overhead captures for the measured failures, low terrain on either side, tight bends, large basins, confluences, coast mouths, and supported drops. Walk along both banks, through a ford, under a bridge, across chunk seams, and back across a LOD transition. Repeat across desktop tiers and XR, in both chunk load directions, and at tide extremes. Inspect uncloaked geometry before relying on foam or fog.

   Measure planning latency, cached point-query time, worker build p50/p95, allocations, transferred bytes, triangle counts, and frame spikes against the baseline on the same device. Cache descriptors by seed, generation version, and globally anchored region; prewarm them during region activation and share serializable plans with workers. Height queries must perform bounded local lookups rather than rebuilding reaches or scanning both banks per call. Set a measured performance gate before broad rollout; a starting target is less than 20% added p95 terrain-build cost on the river fixture workload, subject to the existing device budgets.

   Add a river/world-generation revision to runtime and derived-cache identity. Verify multiplayer peers agree on it. Existing seeds determine newly changed geography, so decide how saved placements are validated or migrated; do not assume a seed alone guarantees compatibility across the change. Keep an explicit development comparison switch until fixtures pass, but do not mix old and new river geometry within one active world.

   Deliverable: a verified default implementation with stable cached queries, reproducible generation, and compatible placements.

**Acceptance gates**

| Property | Required evidence |
| --- | --- |
| Containment | Every ordinary wet reach has a continuous bed and bank on both sides. Every other boundary is a declared source, connection, outlet, basin rim, or fall. |
| Water shape | One water elevation per cross-section; downstream profiles satisfy grade constraints; basins have a shared level; no artificial side drops. |
| Contact | Shore vertices lie on final rendered ground within floating-point tolerance; target ≤1cm at nearby test coordinates. No external lateral domain edge with positive depth. |
| Coverage | No unexplained hole within a planned connected wet area; unresolved narrow features refine the shared terrain/water geometry. |
| Query agreement | Reported floor equals final ordinary ground, and wet/depth come from it. Suggested near-field render/query water-height error ≤5cm and wet-boundary displacement ≤10cm, excluding a documented shallow-water tolerance band. Use failed bounds to trigger refinement. |
| Detail transitions | Shared chunk-edge water and terrain intersections coincide; transitions introduce no crack, isolated fragment, bank loss, or metre-scale surface jump. Test all supported resolution pairings. |
| Integration | Crossings remain walkable, banks support feet and vegetation, raised ground is dry, and lowered terrain does not expose water edges. |
| Repeatability | Reordered region/chunk generation and main-thread/worker queries produce matching descriptor and boundary values. |
| Appearance and cost | Close-range captures pass without relying on obscuring effects; planning, rendering, and query performance meet the measured device budget. |

The numeric tolerances above are proposed engineering targets to calibrate during the fixture pass. Assertions should distinguish semantic generation constraints, Float32 geometry tolerances, visual error, and gameplay wetness thresholds. A test that merely proves the water disappears into the ground is insufficient.

**Expected code ownership**

| Area | Existing or proposed files |
| --- | --- |
| Natural terrain and canonical queries | `src/world.js`; proposed `src/riverfield.mjs` |
| Connected routes, levels, and immutable descriptors | Proposed `src/riverplanner.mjs` |
| Bed/bank profiles and containment | Proposed `src/riverterrain.mjs` |
| Sampling, shoreline clipping, shared refinement | `src/chunkgen.js`; proposed pure `src/rivermesh.mjs` helpers |
| Worker payloads, revisions, and chunk transitions | `src/worker.js`, `src/terrain.js` |
| Earthwork/query agreement and water reservations | `src/railwayterrain.mjs`, `src/railwayplanner.mjs` |
| River/ocean/fall appearance | `src/river.js`, `src/water.js`, `src/watercommon.js`, `src/waterfall.js` |
| Consumers and cache/version integration | `src/trails.js`, `src/trailcrossings.mjs`, `src/controls.js`, `src/main.js`, `src/worldruntime.mjs`, relevant settlement and multiplayer modules |
| Regression fixtures | Proposed river containment, river mesh, river LOD, and river integration tests under `tests/` |

The first usable milestone should combine steps 2–5 on the fixed reproduction cases: a consistent world query, feasible water profile, real banks, and a clipped water mesh. Shader polish should follow that milestone. The implementation risk is primarily terrain/profile feasibility and deterministic boundaries across planning regions; shader tuning cannot resolve either.
