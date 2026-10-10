# Water refinement review

The subsequent [regional river restoration](regional-river-restoration.md) restores the broad winding main river, feeding tributaries, ocean delta and trail crossings. The evidence below documents the preceding water material and local-network effort.

Validated locally against `a45e08cb14be3dfbb490e5ecf40d8ce093faab8f`. This review covers rivers, tributaries, forest creeks, connected ponds/lakes, and the ocean.

## What changed

- Rivers use irregular, terrain-tested bends, rounded drainage paths, and bounded alignment into confluences. Width varies along a reach and grows with upstream contribution. Bank widths, slopes, and shoulders vary independently on either side. Inner bends are shallower and slower; outer bends are deeper and faster.
- Forest brooks in the regional world become small connected creeks where a valid receiving river or basin is available. Their packed endpoints are checked against actual wet receiving geometry and water levels. The reviewed creek is 166 m long and feeds a three-reach network with two confluences and an ocean outlet.
- Ponds and lakes retain their physical water levels and can have inlets, outlets, and inland connections. Modern connector profiles are attempted first; constrained connections retain validated conservative geometry when necessary. Inland receiving basins do not require an ocean outlet.
- River, creek, lake, pond, and ocean materials share a restrained palette, painted depth bands, broad reflections, quieter highlights, and wind motion. Moving water uses bounded two-phase current advection; still basins use calmer motion. Ocean normals use broad analytic waves. Existing planar reflections remain available.
- Terrain banks use earth, sediment, and moss instead of inland coastal chalk. Water clips against the same final terrain used by gameplay. Basin ownership survives shoreline clipping, removing repeated pale foam wedges. Ocean draw order and creek handoff use actual receiving water to avoid opaque seams and dry-bank fades.
- Planning and mesh work reuse exact terrain samples and validated geometry, avoid unnecessary rebakes and allocations, and retain mesh budgets. Creek mesh generation reuses ground samples. Cache revision 9 invalidates earlier water layouts, including intermediate local review plans.

Protected contacts, water levels, sparse-mesh containment, terrain agreement, and budgets take precedence over proposed decorative bends. Some short or constrained reaches retain their terrain-authored paths. This is deterministic procedural morphology, not an erosion simulation.

## Visual evaluation

An independent evaluator inspected actual browser renders after successive iterations using a fixed rubric. Scores use a 1–5 scale: organic winding 20%, width/pools 20%, natural banks 20%, junctions/connections 15%, visual cohesion 15%, and integrity 10%. The evaluator's aspirational full-pass gate is at least 3.5 in every category with continuous contacts.

| Round | Weighted score /100 | Main finding or change |
| --- | ---: | --- |
| 1 | 51.5 | Initial reference: uniform widths, weak bends and banks. |
| 2 | 60 | Better variation and a common water treatment. |
| 3 | 57 | Ocean-mouth opaque apron exposed. |
| 4 | 63 | Mouth transition corrected. |
| 5 | 63 | Banks and local pools still weak. |
| 6 | 67 | Clearer winding and downstream growth; coastal bank pigment issue exposed. |
| 7 | 67 | Pigment improved; repeated bank steps remain visible. |
| 8 | Draft only | Stronger main-stem shaping; narrow-channel blue beads rejected. |
| 9 | 65.5 | Shore alpha improved, but narrow-channel continuity still weak. |
| 10 | 67 | Physical wet core and affine shoreline fixed continuity. |
| 11 | 63 | Expanded creek evaluation exposed a bank lip and bright rectangular handoff. River-only subset scored 67. |
| 12 | 67 | Actual-wet creek handoff corrected the blocking seam. |
| 13 | 67 | Fresh basin, creek, single-source river, network, and ocean inspection. Pond shoreline ownership is fixed; local width/pool contrast and bank facets remain below the evaluator's full-pass gate. |

Representative early and final captures:

| View | Earlier iteration | Final iteration |
| --- | --- | --- |
| River network | [Round 2](water-r2-network.jpg) | [Round 13](water-r13-network.jpg) |
| Bend and tributary | [Round 2](water-r2-bend.jpg) | [Round 13](water-r13-bend.jpg) |
| Pond shoreline | [Round 11](water-r11-modern-pond.jpg) | [Round 13](water-r13-modern-pond.jpg) |
| Creek contact | [Round 11](water-r11-creek-join.jpg) | [Round 13](water-r13-creek-join.jpg) |
| Ocean mouth | [Round 3](water-r3-mouth.jpg) | [Round 13](water-r13-mouth.jpg) |

Additional final views: [bank](water-r13-bank.jpg), [headwater](water-r13-headwater.jpg), [regional pond chain](water-r13-regional-pond.jpg), [creek bank](water-r13-creek-bank.jpg), [creek spring](water-r13-creek-spring.jpg), and [single-source regional river](water-r13-regional-single-river.jpg).

The evaluator's final category scores are **3.5 / 3.0 / 3.0 / 3.5 / 3.5 / 4.0**, in rubric order: **67/100**. This is an improvement from the initial 51.5, with the blocking mouth/creek contact defects corrected, but it does **not** meet the evaluator's aspirational full-pass gate. Visible bank facets at the 2 m terrain lattice, subtle inner sediment bars/local pools, and a polygonal spring tip remain. The reviewed single-source route receives width/bank character but retains its terrain-authored centerline when the fitted meander proposal is rejected.

The lab loads production terrain/water geometry and materials, with nearby vegetation; its distant overview does not load the full game's distant clutter. Screenshots compare iterations, not an untouched original art baseline. [Capture metadata](review-evidence.json) records plan hashes, camera positions, targets, and render statistics. Representative images are retained; the full capture metadata includes discarded visual experiments.

## Performance

CPU comparisons use an isolated original source tree, alternate original/current order, warm both implementations, and report medians. Planning runs the same three regional requests, with their actual accepted geometry. Terrain and creek mesh comparisons use the same current water plan/accepted creek for both implementations so triangle counts match exactly.

| Workload | Original median | Current median | Change |
| --- | ---: | ---: | ---: |
| Region seed 1, (0, 0) | 2,060.15 ms | 2,078.26 ms | +0.88% |
| Region seed 42, (0, 0) | 2,191.10 ms | 2,146.18 ms | −2.05% |
| Region seed 4242, (1, 0) | 1,742.16 ms | 1,790.51 ms | +2.78% |
| Planning aggregate | 5,993.41 ms | 6,014.95 ms | +0.36% |
| Wet terrain, seed 1, three chunks | 20.12 ms | 18.65 ms | −7.29% |
| Wet terrain, seed 42, three chunks | 18.32 ms | 17.39 ms | −5.03% |
| Wet terrain, seed 4242, three chunks | 19.83 ms | 18.82 ms | −5.09% |
| Wet terrain aggregate | 58.27 ms | 54.87 ms | −5.83% |
| Same creek mesh | 2.258 ms | 0.537 ms | −76.24% |

Planning is essentially unchanged in this sample: the small aggregate increase is within observed run variation. Across these regions, serialized plan size changes from 8,753,819 to 8,736,359 bytes (−0.2%); water cells change from 75,550 to 75,620 (+0.09%). The revised accepted layouts add one reach and one water system across the three requests. Creek geometry stays at 118 water / 590 bed triangles. These timings exclude whole-game startup, creek tracing, and browser/GPU work. [Raw CPU measurements](performance.json) include all samples, coordinates, and geometry counts.

The final ocean-inclusive mouth comparison measured **5.319 ms original → 4.845 ms current (−8.9%)**, on plan `b59aa3c4`, with material and scenery enabled. The GPU comparison alternates original/current water programs on identical current geometry, camera, depth textures, and scenery. WebGL `EXT_disjoint_timer_query_webgl2` times the complete scene render, with 24 valid samples per variant and a warm render before each sample. [Final raw GPU samples](final-gpu.json) preserve this paired result. An earlier iteration measured a larger reduction; its absolute timings differ, and it is not substituted for this final measurement. This measures that scene; it does not establish whole-game FPS or all-device performance.

## Verification and reproduction

- Full `npm test`: **1,102 passing, 0 failures, 6 existing TODOs** (1,108 total).
- After final cache revision 9, cache/default-water/shared-world agreement checks: **21 passing**.
- New focused coverage includes physical confluence continuity, standalone morphology, bounded mesh reuse, irregular banks, inner/outer bend behavior, connected basin profiles/fallbacks, shoreline ownership, exact planning samples, and an actual forest creek feeding a larger ocean-bound network.
- Independent code audit: no remaining actionable correctness or performance issues found by inspection.
- Final normal-game startup regenerated the landscape under cache revision 9 and reached **READY — CLICK TO WALK**, with no captured water startup errors. The earlier WebKit stack overflow from spreading sparse mesh coordinates was fixed. Automated pointer-lock restrictions prevented a walking playthrough. Whole-game FPS was not compared in this startup check.
- `git diff --check` passes. Repository graph refreshed after the source changes.

Run `python3 serve.py 8475`, then open `http://127.0.0.1:8475/river-lab.html?fixture=15` for the network; fixtures 13, 11, 16, and 17 show the modern pond, regional basin chain, connected forest creek, and single-source regional river. Use the bank, network, headwater, confluence, and mouth camera buttons. Fixture 5 is a legacy comparison and does not demonstrate modern single-source shaping.

To reproduce CPU and create temporary GPU baseline modules, obtain the original revision in a separate directory, then run:

```sh
node scripts/benchmark-water-refinement.mjs /path/to/original docs/water-refinement/performance.json
```

Run the lab's GPU compare button after closing other rendered game tabs and waiting for planning/tests to finish. Save captures through the local server. Temporary baseline modules and raw captures are review outputs, not runtime dependencies of the game.
