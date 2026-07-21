# WANDER

An infinite, procedurally generated open-world walking simulator for desktop
and WebXR, built on three.js and Tone.js. No build step, no assets — every
mountain, tree, cloud and sound is generated from parametric code and a seed.

## Run it

Serve the folder over HTTP (modules + WebXR require it):

```sh
python3 -m http.server 8473
# or: npx serve
```

Open http://localhost:8473. Click to walk. For VR, open the page in a
WebXR-capable browser (Quest browser over local network needs HTTPS — use
e.g. `npx serve --ssl-cert ...` or a tunnel) and press **Enter VR**.

**Controls** — desktop: WASD + mouse, shift to stride, esc to pause.
VR: left stick smooth locomotion, right stick snap turn.

## How the world is made

Everything samples one deterministic world model ([src/world.js](src/world.js)),
so terrain meshes, vegetation, the player's feet and the soundscape always agree.

- **Geology** ([world.js](src/world.js)): domain-warped continent noise shaped by a
  hypsometric spline (ocean shelves → coastal plains → uplands); ridged
  multifractal mountain ranges gated by a low-frequency mask; soft-terraced
  mesa country; erosion-modulated rolling detail; river channels carved by the
  zero-set of a warped fbm — gorges in high terrain, water-filled near coasts.
- **Climate & biomes**: temperature (latitude-like noise + altitude lapse rate)
  × moisture → ocean, beach, desert, savanna, jungle, grassland, forest,
  taiga, tundra, snow. Ground colour blends biome palettes with slope rock,
  alpine rock, snowline and shoreline wetness per vertex.
- **Terrain streaming** ([terrain.js](src/terrain.js)): 140 m chunks ring the player,
  64→32→16 vertex resolution by distance, skirt geometry hides LOD seams,
  normals from the height field so chunk borders shade seamlessly. A procedural
  ground-detail shader adds macro patchiness, fine albedo speckle and a
  noise-gradient normal perturbation up close, all distance-faded.
- **Walking trails** ([trails.js](src/trails.js)): deterministic landmark routes
  shared by terrain and vegetation generation. A mutual, four-link sector graph
  avoids cardinal grid bias while bounding junction degree and assigning
  primary, secondary and faint route classes. Each edge is solved through a
  bounded terrain corridor that favours walkable grades, contour traverses,
  limited switchbacks and shallow water crossings; crossings too deep to ford
  are retained as explicit bridge requirements for a later presentation phase.
  Worker-generated, LOD-conforming trail ribbons turn those routes into
  continuous painterly surfaces with warm earth-to-gravel pigment, softly
  feathered shoulders, irregular width and route-class hierarchy—independent
  of terrain vertex spacing. The same wear profile clears trees, understory and
  grass, keeping presentation and ecology aligned. Prepared edges use adaptive
  distance sampling, cached segment math and local spatial bins; callers can
  query either scalar wear or a richer tangent/side/arc-length profile. The
  opening spawn is selected from a scenic, gentle primary route so paths are
  immediately discoverable.
- **Threaded generation** ([worker.js](src/worker.js), [chunkgen.js](src/chunkgen.js)):
  all the heavy numeric work — height-field sampling, terrain geometry arrays,
  and vegetation/grass instance placement — runs in a pool of Web Workers
  (one per core, capped at 4), each owning its own deterministic `World`.
  Workers post back transferable typed arrays; the main thread only wraps them
  (zero-copy) into geometry and InstancedMeshes, bounded to a couple of chunks
  assembled per frame. Generation no longer touches the render thread, so
  streaming and teleports hold ~120 fps with no hitches (and headroom to raise
  near-chunk resolution). `chunkgen.js`/`vegdata.js` are THREE-free so they load
  in the worker, which doesn't share the page's import map.
- **Distant terrain** ([farterrain.js](src/farterrain.js)): a single radial horizon
  mesh, centred on the player, with exponentially spaced rings from 240 m out
  to 7.5 km. It samples the same world model and shares the terrain material,
  so far mountain ranges match what you'd reach by walking. It's sunk a few
  metres under the streamed chunks in the overlap so the two never z-fight,
  rebuilt a few rings per frame only when the player strays ~450 m, and fog
  reaches ~6.5 km to dissolve the world edge — revealing ranges kilometres off.
- **Vegetation** ([vegetation.js](src/vegetation.js)): nine parametric archetypes
  (conifer, broadleaf, dry tree, palm, cactus, shrubs, dead tree, rock) with
  seeded variants, scattered per chunk by biome recipe and rendered as
  InstancedMesh. Grass is instanced tufts with a vertex-shader wind sway,
  lit with up-facing normals so it matches the ground.
- **Procedural wildlife** ([animals.js](src/animals.js),
  [animaldata.mjs](src/animaldata.mjs)): white-tail deer, fox and moose are
  generated from reusable primitive-body recipes and merged into one ordinary
  mesh draw call per animal. A mobile-oriented vertex shader projects those
  disconnected capsule/cone shells onto their smooth-min SDF union, derives
  continuous normals from the SDF gradient, blends pigment by shape proximity,
  and tucks buried shells beneath the shared skin. A clip-free reactive step
  planner keeps hooves fixed in world space through stance, uses species-tuned
  lateral-sequence timing, and pre-rolls the first hoof lift before body
  translation begins. Footholds are predicted from the upcoming stance time;
  the complete flex-then-advance swing path is checked against live terrain so
  hooves clear rising slopes before every three-link leg is solved with
  constrained IK. The animal root remains world-upright on hills while each
  leg independently absorbs the ground-height difference beneath its hoof. A
  lightweight terrain planner scores forward steering arcs by mean/worst and
  cross-slope grade, safety and destination progress, favoring oblique hill
  traverses over either the fall line or a pure contour and limiting rotation
  by each species' moving turn radius. Peripheral player awareness preserves grazing and roaming at a
  distance, pauses without look-at rotation inside 16m, and triggers flight
  only inside 8m. Locomotion is divided into explicit animation classes rather
  than one compromise gait: deer and moose use a stiffer ungulate walk/trot,
  while foxes transition into a deeper, spinally articulated lead-lag canid
  gallop with longer reach. Elongated distal leg segments restore the slender
  metapodial proportions of all three species. Leg shafts extend through their skeletal pivots
  into rounded knee/elbow and hock/carpal SDF masses, giving the smooth-min
  skin enough overlapping volume to eliminate mechanical hourglass joints
  throughout the gait. Multi-segment tails and ears are
  Verlet physics ropes whose overlapping primitives remain shapes in that same
  SDF union, producing inertial flop without seams or extra draws. New species are primarily
  proportion, palette and accent data rather than new modelling or animation
  code. Open [animal-lab.html](animal-lab.html) while the server is running for
  calibrated front/side/back model-sheet comparisons. The lab auto-aligns the
  supplied references to the hoof baseline and reports silhouette overlap,
  model/reference coverage, upper/body/leg-region scores and width error; it
  also provides overlay, difference, guide, nudge and PNG-export controls plus
  a live gait/IK inspector with speed and uneven-ground stress controls.
- **Tree impostors** ([impostors.js](src/impostors.js)): each tall archetype is
  rendered once at startup (render-to-texture) into a billboard; distant trees
  are drawn as cheap cross-quad impostors at the exact positions the full trees
  would occupy. Full geometry near the player gives way to billboards in an
  outer band that extends past the streamed terrain, so forests fade into the
  fog line instead of popping in at a hard radius — and the full↔impostor swap
  never shifts a tree (both modes draw identical scatter RNG). Billboards track
  the day/night cycle and are fogged like everything else.
- **Atmosphere** ([sky.js](src/sky.js)): physical sky shader, full day/night cycle
  (nights run faster), sun + hemisphere lighting and fog colour all driven by
  solar elevation, drifting procedural clouds, stars.
- **Weather** ([weather.js](src/weather.js), [clouddeck.js](src/clouddeck.js),
  [rain.js](src/rain.js)): deterministic day-rolled fronts that evolve between
  fair, dramatic, overcast and storm states; shared wind drives vegetation,
  cloud layers, overhead storm cover and player-relative rain.
- **Sound** ([audio.js](src/audio.js)): all Tone.js synthesis — gusting wind that
  rises with altitude and calms under forest canopy, rain/thunder, weather-aware
  daytime birdsong and a nocturnal insect chorus, plus surf/river noise near
  water and surface-aware footsteps
  (sand / grass / rock / snow / wading).
- **Adaptive quality** ([quality.js](src/quality.js)): five tiers (potato → ultra)
  trading pixel ratio, view distance, shadow resolution and vegetation
  density. A smoothed-FPS controller steps tiers with hysteresis; VR targets
  ~72 Hz, desktop ~60.
- **Weather comfort:** the start/pause overlay exposes gentler rain motion and
  independent thunder muting. The rain renderer also scales its active instance
  count with both precipitation strength and the current quality tier.

## Tuning

- World seed: `new World(20260612)` in [main.js](src/main.js)
- Day length: `DAY_LENGTH` in [sky.js](src/sky.js)
- Quality tiers: `TIERS` in [quality.js](src/quality.js)
- Biome vegetation recipes: `RECIPES` in [vegetation.js](src/vegetation.js)
- Animal species recipes: `ANIMAL_RECIPES` in [animaldata.mjs](src/animaldata.mjs)
- Debug console: `__wander.teleport(x, z)`, `__wander.sky.time = 0.5`,
  `__wander.quality.setLevel(4)`, `__wander.showAnimals()`. The debug menu's
  **Procedural animals** folder can stage all three species directly in front
  of the player; the **Locations** folder can
  return to the original summit, jump to the trailhead, find nearby trails or
  landmarks, revisit the Home surface regression-test face, and sample safe
  random biomes. **Ground detail** exposes the shared painted-texture strength
  and subtle surface-tooth controls for live art-direction checks.
