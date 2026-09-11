# River overhaul implementation checkpoint

Updated 2026-09-11. The approved scope is in [river-lake-overhaul-plan.md](river-lake-overhaul-plan.md). This is an implementation checkpoint, not a completion or release declaration. Normal game startup still uses generation 2. No overhaul commit has been pushed.

## Available for inspection

Serve the repository and open `river-lab.html`. The selector contains the historical failure cases, a new valley lake, a sheltered pond, and a terrain-led river candidate. These use the actual geometry worker and production water material. The river candidate is explicitly **not migrated**: adjoining legacy river terrain can leave visible seams beyond its fitted bank envelope.

For the actual game, `index.html?wanderSeed=20260612&waterPreview=basins` plans region (0, 0) before startup and places the player beside a basin. This is a fixed-region development preview, not streamed generation or multiplayer support. Other seeds have algorithm tests but have not received the same full-game visual review.

## Implemented

- Extraction of realized crossing construction recipes, versioned JSON manifests, immutable validation and restored runtime route indexes. Four original complete scatter payloads remain byte-for-byte identical. Restored route/crossing lookup and conflicting duplicate rejection are tested.
- Terrain-derived connected closed basins with deterministic identity, fixed water levels, shoreline grids and natural bathymetry. Existing crossing approaches, trail strips, landmark/settlement sites and known railway corridors are excluded during planning.
- Basin terrain, water mesh, walking depth and underwater identity share the same field. A canonical 4 m terrain lattice preserves the basin grid's shoreline triangles across requested LODs.
- Water kind, flow, turbidity, exposure and sea ownership reach the geometry worker and shader. Inland basin water does not disappear through ocean-distance ownership. Bank pigments and clustered sheltered reeds are included.
- Worker plan hashes, stale-result rejection and bounded initialization retry. Lab fixture replacement publishes complete terrain and water together.
- Bounded terrain-led candidate routing to actual ocean cells, canonical boundary portals, downhill interval fitting, metre-based river sections, continuous bend-dependent bank profiles, and cut/fill constraints.
- Narrow river candidate sampling and rendering through the same serialized field and actual worker, with a canonical 2 m terrain grid. Water is level across each analytical section; mesh shoreline contacts are tested against the exact terrain triangles.
- A shared junction-level solver and deterministic route-graph merge, including incompatible tributaries and ambiguous downstream ownership rejection. These are not yet the activated network planner. Overlapping reach descriptors are rejected until junction geometry is implemented.

## Verified

- Full suite: **628 passed, 0 failed, 6 existing TODOs** (634 total). Subsequent overlap-rejection changes also passed targeted hydrology tests.
- Full-game visual inspection at seed 20260612: visible lake surface and shoreline, matching underwater tint/depth, preserved bridge visible above water, no water-plan error reported. The reviewed preview basin nodes had no railway clearance overlap.
- Lab visual inspection: visible candidate river and banks using the production material. The preview exposes the unresolved legacy-terrain transition; it is not hidden or counted as a successful migration.
- Alternating warm terrain + water generation benchmark, 8 representative chunks at requested resolution 64, 56 samples per baseline/current case, review tabs closed:
  - Committed baseline median 3.396 ms, p95 4.056 ms.
  - Current generation-2 path median 3.429 ms, p95 4.027 ms.
  - Mixed basin-preview workload median 4.323 ms, p95 5.864 ms (32 samples; changed canonical geometry).
  - Cold protected region planning 368.1 ms; installation 14.9 ms. Plan approximately 76.8 KB; crossing manifest approximately 960 KB.
- These are desktop CPU measurements, not mobile/XR certification. Cold planning has not met the proposed 250 ms target.

## Work still required before release

1. Assemble whole drainage components, preserve crossing approach terrain and safe water intervals, and remove old river carving only when its entire replacement is valid. Current candidate fitting alone does not authorize a migration. The lab seam between new and old terrain is evidence of this missing step.
2. Fit and mesh shared confluences, sources and mouths from the solved component graph. Bind all realized crossing constraints, not just hand-selected test anchors. Report complete retained legacy components explicitly.
3. Connect flowing basins to validated inlet/outlet heads; add the remaining geologic basin variants and review encounter frequency across adjacent regions. Current generated basins are closed depressions.
4. Implement bounded regional planning/cache/ownership and atomic streamed activation across main-thread physics, terrain, water, vegetation and workers. The constructor-only preview is not this streaming system.
5. Complete full-game crossing traversal/NPC, broader seeds, low/high LOD seams, sustained streaming, mobile/XR visual and performance checks. Resolve planning latency and identity with rail layouts supplied before capture.
6. Remove development-only limitations, choose the generation/cache migration, then commit and push the completed result only after release gates pass.
