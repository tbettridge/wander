# Regional river restoration

This corrective review builds on `3ece1b3`. The regional generator had replaced the prominent wide river with small local drainage networks. It now reserves a separate broad trunk before optional detail, while retaining tributaries, lake connections and forest creeks.

## Reviewed production geometry

The default seed `20260612`, region `(-1,-1)`, resolves nine neighbouring region candidates through the production planner. Its accepted main river is 2,037 m long with sinuosity 1.365. The channel reaches 111 m wide, varies through bends and narrows toward its source. Two existing local network sources feed it through fitted 417 m and 801 m tributaries. Their roughly 2 m spring noses widen to approximately 19 m and 27 m at the confluences. The tidal reach forks into two physical ocean outlets.

Local valley bends augment the broad drainage curve. Confluences move to calmer parts of that fitted curve, preserving its geometry and jointly solving all water levels. Inside bends have broader shallows and sediment margins; bank widths vary independently. Every accepted curve still passes the existing hydraulic, excavation, fold, ownership, containment and mesh limits. Unsupported proposals retain a validated route.

The shared river, lake, pond and ocean materials from the preceding effort remain in use. This correction changes regional geometry and crossing integration. Final cache revision 12 invalidates older generated water plans, including intermediate local revision-10/11 previews.

## Visual iterations

An independent evaluator uses these weights: distance presence 30%, macro meanders 20%, tributary hierarchy 15%, delta/mouth 10%, visible crossings 10%, water cohesion 10%, terrain integrity 5%. Every category must reach 3.5/5. Captures use actual production water and terrain geometry and materials. The overview loads limited distant vegetation; the mountain camera rests above the rendered mountain terrain.

| Round | Score | Finding |
| --- | --- | --- |
| 1 | Incomplete, failed | Broad trunk restored, but long J shape and missing feeders. |
| 2 | 61.5/100, failed | Feeders and timber crossing restored; macro bends, delta framing and landing vegetation still weak. |
| 3 | 69/100, provisional, failed | Mountain presence clear and landing obstruction fixed; meanders still modest. A dry-looking branch was confirmed to be an incoming creek source rather than an ocean outlet. |
| 4 | **73.5/100, passed** | Stronger valley bends, tapered creek springs, two visibly connected ocean mouths and a timber bridge with clear landings. |

The incoming-source concern led to a pointed spring profile with a gentler width opening. Dedicated inland-bend and confluence cameras now avoid the tidal fork. The delta camera includes its verified outgoing terminals.

Earlier network renders: [round 1](regional-r1-network.jpg), [round 2](regional-r2-network.jpg), [round 3](regional-r3-network.jpg).

Final renders: [whole network](regional-r4-network.jpg), [mountain and sea](regional-r4-mountain-sea.jpg), [inland bend](regional-r4-bend.jpg), [creek spring](regional-r4-source.jpg), [tributary join](regional-r4-join.jpg), [delta](regional-r4-delta.jpg), and [timber crossing](regional-r4-crossing.jpg). [Capture metadata](regional-review-evidence.json) preserves the actual camera and render statistics.

The lab uses production terrain/water builders and materials, with nearby vegetation. Its distant overview does not stream the full game's distant vegetation. The mountain image includes an occluding foreground peak; the prominent winding river is still visible beyond it. These images establish geometry and appearance in this fixture, rather than all-seed or all-device results.

A final [live worker regeneration](regional-final-generated-network.jpg) also reproduced the same 9,380 main-component grid coordinates and reach IDs in WebKit after removing the temporary frozen-plan loader. Its plan/component hashes are `fe4049c0` / `586e0962`; the V8 evaluator receipt is `c30f65f0` / `3b97b860`. Native floating-point rounding changes numeric payload hashes, with the largest floor/depth difference below 0.000000001 m; topology, all other grid arrays and 27,252 rendered water triangles agree. The overview deliberately hides the ocean to expose carving; its dark seabed terminals are diagnostic, while the delta and mountain-sea captures show the actual ocean handoff.

The final evaluator scores are **4 / 3.5 / 3.5 / 3.5 / 3.5 / 3.5 / 4**, in rubric order. Every category meets the stated gate for this inspected scene. Coarse bank facets, a simple two-outlet delta and relatively uniform surface patterns remain polish limits. [Independent judgement](regional-visual-judgement.json) records each category's evidence and scope.

## Crossing verification

Owned generation-3 river water remains queryable at mean sea level. Trail routing distinguishes tidal river reaches from the open ocean, and both rendered and walking crossing caches include the water/rail authority. Railway terrain installation, replacement and removal regenerate bridge heights and approaches. Wide timber bridges survey the whole wet span and receive supported approaches. Trees and saplings clear the trail corridor by its width plus 2 m.

The final main bridge is at `(-3977.74, 3.09)`, over a 105.27 m wet span. All 373 walking samples across its deck and approaches pass; minimum water clearance is 1.053 m against a 0.52 m requirement. The feeder crossing at `(-3668.44,104.71)` spans 25.82 m; all 316 walking samples pass and clearance is at least 0.528 m. A separate check verifies 244 tree roots, including riverside trees, with at least 2.187 m of clearance beyond trail width.

[Detailed crossing proof](crossings-wide-regional-proof.json) records generated instances, support heights, deck lengths, chunk ownership and traversal samples. [Small crossing proof](crossings-regional-proof.json) also covers actual plank and timber crossings.

## Performance and regression evidence

Broad components use bounded 8 m planning grids and 4 m terrain/water subdivisions where no fine owner requires 2 m. Narrow owners retain fine sampling. A 6 km synthetic broad component remains within its mesh and serialization bounds. Shared exact lattice samples reduce repeated terrain work, and publication prioritizes supported tributary networks before optional standalone basins.

Connected lake systems retain priority before independent-network reservations. Regression testing caught a single-basin lake with an inlet being displaced despite connected ponds still surviving. Its actual original lake mesh `8917cb2d`, basin `basin:4242:5408:48`, and normal connected shore were restored within the 3 MB region budget. Lake-specific retention and drawn-shore assertions now protect that case. A fresh worker-generated lake review confirms continuous water at its three visible channel contacts and a calm reflected surface: [overview](regional-final-lake-overview-v12.jpg), [bank](regional-final-lake-bank-v12.jpg), [contacts](regional-final-lake-contacts-v12.jpg). [Lake capture metadata](regional-final-lake-capture-metadata.json) records the actual preview; the existing straight inlet reaches remain a visual limit.

CPU comparisons use the isolated preceding revision `3ece1b3`. Five exact seed/region cases are warmed and measured in three alternating runs per implementation. Arithmetic means for candidate planning are:

| Seed / region | Previous | Current | Change |
| --- | ---: | ---: | ---: |
| 20260612 / (-1,-1), reviewed main river | 2,254.32 ms | 2,589.23 ms | +14.86% |
| 20260612 / (0,0) | 3,008.35 ms | 3,114.00 ms | +3.51% |
| 1 / (0,0) | 1,756.32 ms | 1,752.40 ms | -0.22% |
| 42 / (0,0) | 2,336.42 ms | 2,358.59 ms | +0.95% |
| 4242 / (1,0) | 1,961.05 ms | 2,111.78 ms | +7.69% |
| Sum of case means | 11,316.46 ms | 11,925.99 ms | **+5.39%** |

The larger network adds candidate-planning work: the reviewed region now has seven systems and ten reaches versus five systems and seven reaches. This is a measured planning latency cost. Exact interval-union enumeration removes duplicated 2 m footprint work; complete plan hashes remain unchanged in its controls. Only measured optimizations were retained. Aggregate planning medians rise 9.18%; three samples per case show visible timing variability and do not establish a confidence interval.

For terrain and water construction, seven warmed alternating runs compare three representative broad-only chunks per eligible case. On identical current water fields, archived 2 m builders versus current native subdivisions cost **72.23% less CPU time** in aggregate medians. With each implementation's own accepted plan, the same chunk coordinates cost **54.07% less**. Four cases have eligible broad chunks; seed 1 has no installed broad component and is omitted from this part.

In the reviewed region, actual old/current construction costs 11.351 ms versus 4.880 ms for three chunks. The identical-field subdivision control reduces terrain from 10,360 to 2,730 triangles per chunk; water triangles also fall substantially. Separate 2 m component owners and direct narrow reaches still require the fine lattice. The broader component and serialized plan remain within the existing limits.

These measurements cover CPU candidate planning and terrain/water construction. They exclude plan decoding, vegetation, GPU rendering and whole-game FPS. They do not time a full nine-region resolved startup window. [Raw samples and counts](regional-performance.json) include the warmed alternating method, arithmetic means, medians, exact identities and both geometry controls.

Use an isolated checkout of `3ece1b3` to reproduce:

```sh
node scripts/benchmark-regional-water.mjs --baseline /path/to/previous-checkout --output docs/water-refinement/regional-performance.json
```

Stop animated game previews and other CPU-heavy work before timing.

## Final verification

The final revision-12 `npm test` run completes with **1,132 passing tests, zero failures and six existing TODOs** (1,138 total). Forty focused hydrology, lake, forest, cache, admission and terrain checks also pass. `git diff --check` is clean and `graft build` refreshes 6,877 nodes / 20,191 edges.

A fresh normal-game startup reaches **READY — CLICK TO WALK** with revision-12 generated water and zero browser errors since that load. This is a startup smoke; bridge traversal is established by the separate numerical deck/approach checks, rather than a first-person playthrough. Cache revision 12 forces old local generated water to refresh.

Visual review fixtures use actual worker generation:

- `river-lab.html?fixture=18`: reviewed broad river, mountain presence, tributaries, delta and timber crossing.
- `river-lab.html?fixture=19`: seed-42 regional network and actual small crossing families.
- `river-lab.html?fixture=20`: retained original connected lake and inlet, seed 4242.
