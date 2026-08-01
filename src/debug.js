// Collapsible debug panel (lil-gui, three's bundled dat.gui successor) for
// live-tuning the Ghibli grade, post pipeline and world state.

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { windUniforms } from './wind.js';
import { groundDetailUniforms } from './grounddetail.js';
import { trailSurfaceUniforms } from './trailsurface.js?v=3';
import { atmoUniforms } from './atmosphere.js';
import { painterFoliageUniforms } from './painterfoliage.js';

export function setupDebugGUI({ post, sky, weather, rain, quality, chunkMgr = null, locationActions = null, renderer = null, controls = null, cave = null, carriedLantern = null, animals = null, railLab = null, regionalRailway = null, regionalRailwayTrack = null, regionalRailwayService = null, livingWorldPopulation = null, shadowDebug = null, grassTrailDebug = null, xrPerformance = null, xrRuntime = null, xrBenchmark = null, xrGrassFieldDebug = null, xrMaterialVariantDebug = null, xrWorldDebug = null, xrExperiments = null }) {
  const gui = new GUI({ title: 'WANDER' });
  gui.domElement.style.zIndex = '20';   // above the start overlay

  const g = post.grade.uniforms;
  const f1 = gui.addFolder('Ghibli look');
  f1.add(g.uGhibli, 'value', 0, 1, 0.01).name('master blend');
  f1.add(g.uLift, 'value', 0, 0.3, 0.005).name('shadow lift');
  f1.add(g.uPastelVal, 'value', 0.8, 1.05, 0.005).name('airiness (lower=brighter)');
  f1.add(g.uPastelCon, 'value', 0.85, 1.05, 0.005).name('contrast soften');
  f1.add(g.uPaper, 'value', 0, 1, 0.01).name('paper grain');
  f1.add(g.uGroup, 'value', 0, 0.4, 0.005).name('value grouping');
  f1.add(painterFoliageUniforms.enabled, 'value').name('painter foliage');
  f1.add(painterFoliageUniforms.strength, 'value', 0, 1, 0.01).name('foliage paint strength');
  f1.add(painterFoliageUniforms.grouping, 'value', 0, 0.5, 0.01).name('foliage value grouping');
  f1.addColor(painterFoliageUniforms.shadowTint, 'value').name('foliage shadow pigment');
  f1.add(post, 'satBase', 0.8, 1.5, 0.01).name('saturation (day)');
  f1.add(g.uContrast, 'value', 0.8, 1.3, 0.01).name('base contrast');
  f1.add(post, 'autoShadowCol').name('shadow colour: auto');
  f1.addColor(g.uShadowCol, 'value').name('shadow colour (manual)');

  const f2 = gui.addFolder('Post FX');
  f2.add(post, 'inkEnabled').name('A1 ink contours');
  f2.add(post.ink, 'strength', 0, 1, 0.01).name('ink strength');
  f2.add(post.ink, 'threshold', 0.01, 0.12, 0.002).name('ink selectivity');
  f2.add(post.ink, 'fadeDistance', 100, 320, 5).name('ink fade distance');
  f2.add(post, 'godRaysEnabled').name('A2 god rays');
  f2.add(post.godRays, 'baseStrength', 0, 0.5, 0.01).name('ray strength');
  f2.add(post.godRays, 'enabled').name('rays active now').listen().disable();
  f2.add(post.bloom, 'strength', 0, 1, 0.01).name('bloom strength');
  f2.add(post.bloom, 'threshold', 0, 1.5, 0.01).name('bloom threshold');
  if (post.gtao) f2.add(post.gtao, 'enabled').name('SSAO');
  if (post.gtao) f2.add(post, 'gtaoResolutionScale', 0.25, 1, 0.05).name('AO resolution scale').listen();
  f2.add(post, 'fxaaEnabled').name('luma FXAA');
  f2.add(post, 'wetness', 0, 1, 0.01).name('distance wash');
  f2.add(post, 'msaaMode', {
    'tier default': 'auto',
    'off (0×)': '0',
    '2×': '2',
    'old baseline (4×)': '4',
  }).name('MSAA override');
  f2.add(post, 'msaaSamples').name('MSAA active').listen().disable();
  f2.add(post, 'renderScale', 0.5, 1, 0.01).name('3D render scale').listen();
  f2.close();

  const fGround = gui.addFolder('Ground detail');
  const groundDbg = { trailMeshes: 'loading…' };
  fGround.add(groundDetailUniforms.strength, 'value', 0, 1, 0.01).name('painted texture');
  fGround.add(groundDetailUniforms.relief, 'value', 0, 1, 0.01).name('surface tooth');
  fGround.add(trailSurfaceUniforms.visibility, 'value', 0, 1, 0.01).name('trail surface');
  fGround.add(trailSurfaceUniforms.detail, 'value', 0, 1, 0.01).name('trail pigment detail');
  fGround.add(groundDbg, 'trailMeshes').name('loaded trail chunks').listen().disable();
  fGround.close();

  const f3 = gui.addFolder('World');
  f3.add(sky, 'time', 0, 1, 0.001).listen().name('time of day');
  f3.add(atmoUniforms.uAtmoCloudCacheEnabled, 'value').name('cached cloud shadows');
  f3.add(quality, 'locked').name('lock quality tier');
  f3.add({ tier: quality.level }, 'tier', { potato: 0, low: 1, medium: 2, high: 3, ultra: 4 })
    .onChange((v) => quality.setLevel(+v));
  if (controls) f3.add({ jump: () => controls.requestJump() }, 'jump').name('↑ jump (space)');
  f3.close();

  if (xrPerformance) {
    const fXR = gui.addFolder('XR presentation');
    fXR.add(xrPerformance.debug, 'profile', {
      Painterly: 'painterly',
      Survival: 'survival',
    }).name('next session profile').listen()
      .onChange((value) => xrPerformance.selectProfile(value));
    if (xrRuntime) {
      fXR.add(xrRuntime.debug, 'mode', {
        Auto: 'auto',
        'Force full': 'full',
        'Force assisted': 'assisted',
        'Force recovery': 'recovery',
      }).name('runtime governor').listen()
        .onChange((value) => xrRuntime.setMode(value));
      fXR.add(xrRuntime.debug, 'stage').name('runtime stage').listen().disable();
      fXR.add(xrRuntime.debug, 'pressure').name('headroom').listen().disable();
      fXR.add(xrRuntime.debug, 'transitions').name('stage changes').listen().disable();
    }
    fXR.add(xrPerformance.telemetry, 'state').listen().disable();
    fXR.add(xrPerformance.telemetry, 'profile').name('active profile').listen().disable();
    fXR.add(xrPerformance.telemetry, 'display').name('eye buffer').listen().disable();
    fXR.add(xrPerformance.telemetry, 'supportedRates').name('supported Hz').listen().disable();
    fXR.add(xrPerformance.telemetry, 'frame').name('display frames').listen().disable();
    fXR.add(xrPerformance.telemetry, 'cpu').name('CPU').listen().disable();
    fXR.add(xrPerformance.telemetry, 'gpu').name('GPU').listen().disable();
    fXR.add(xrPerformance.telemetry, 'missed').name('missed frames').listen().disable();
    fXR.add(xrPerformance.telemetry, 'render').name('XR scene').listen().disable();
    fXR.add(xrPerformance.telemetry, 'visuals').name('XR visuals').listen().disable();
    if (xrWorldDebug) {
      fXR.add(xrWorldDebug, 'tier').name('world tier').listen().disable();
      fXR.add(xrWorldDebug, 'geometry').name('world reach').listen().disable();
    }
    if (xrGrassFieldDebug) {
      fXR.add(xrGrassFieldDebug, 'mode').name('grass tiers').listen().disable();
      fXR.add(xrGrassFieldDebug, 'plan').name('grass plan').listen().disable();
      fXR.add(xrGrassFieldDebug, 'triangles').name('mid grass triangles').listen().disable();
    }
    if (xrMaterialVariantDebug) {
      fXR.add(xrMaterialVariantDebug, 'active').name('XR material variants').listen().disable();
      fXR.add(xrMaterialVariantDebug, 'registered').name('variant materials').listen().disable();
      fXR.add(xrMaterialVariantDebug, 'routedAssignments').name('XR material assignments').listen().disable();
      fXR.add(xrMaterialVariantDebug, 'lastReplacements').name('material swaps').listen().disable();
    }
    if (xrExperiments) {
      const fExperiments = fXR.addFolder('Experimental A/B');
      fExperiments.add(xrExperiments.debug, 'threeRuntime', {
        'r185 default · XR recommended': 'candidate',
        'r165 fallback': 'baseline',
      }).name('Three.js lane').listen()
        .onChange((value) => xrExperiments.selectThreeRuntime(value));
      fExperiments.add(xrExperiments.debug, 'activeThree').name('active runtime').listen().disable();
      fExperiments.add(xrExperiments.debug, 'applyThreeRuntime').name('reload selected Three.js');
      fExperiments.add(xrExperiments.debug, 'runtimeAction').name('runtime status').listen().disable();
      fExperiments.add(xrExperiments.debug, 'compositorMode', {
        'scene sprite (default)': 'scene',
        'compositor quad HUD': 'quad',
      }).name('XR HUD path').listen()
        .onChange((value) => xrExperiments.setCompositorMode(value));
      fExperiments.add(xrExperiments.compositor.debug, 'capability').name('Layers support').listen().disable();
      fExperiments.add(xrExperiments.compositor.debug, 'status').name('quad HUD').listen().disable();
      fExperiments.add(xrExperiments.compositor.debug, 'uploads').name('HUD uploads').listen().disable();
      fExperiments.add(xrExperiments.debug, 'multiviewMode', {
        Off: 'off',
        'full scene (experimental)': 'render',
        'isolated probe': 'probe',
      }).name('OVR multiview').listen()
        .onChange((value) => xrExperiments.setMultiviewMode(value));
      fExperiments.add(xrExperiments.multiview.debug, 'capability').name('multiview support').listen().disable();
      fExperiments.add(xrExperiments.multiviewRenderer.debug, 'status').name('scene renderer').listen().disable();
      fExperiments.add(xrExperiments.multiviewRenderer.debug, 'views').name('scene views').listen().disable();
      fExperiments.add(xrExperiments.multiviewRenderer.debug, 'fallback').name('fallback reason').listen().disable();
      fExperiments.add(xrExperiments.multiview.debug, 'run').name('run multiview A/B');
      fExperiments.add(xrExperiments.multiview.debug, 'status').name('probe status').listen().disable();
      fExperiments.add(xrExperiments.multiview.debug, 'latest').name('probe result').listen().disable();
      fExperiments.add(xrExperiments.debug, 'reset').name('reset experiment flags');
      fExperiments.close();
    }
    fXR.add(xrPerformance.telemetry, 'lastSession').name('last headset run').listen().disable();
    if (xrBenchmark) {
      const fBench = fXR.addFolder('Quest 2 benchmark');
      const sceneChoices = Object.fromEntries(
        xrBenchmark.scenes.map((scene) => [scene.label, scene.id]),
      );
      fBench.add(xrBenchmark.debug, 'warmupSeconds', 0, 20, 1).name('warm-up seconds');
      fBench.add(xrBenchmark.debug, 'sampleSeconds', 5, 120, 5).name('sample seconds');
      fBench.add(xrBenchmark.debug, 'settleTimeoutSeconds', 0, 45, 1).name('stream wait timeout');
      fBench.add(xrBenchmark.debug, 'repetitions', 1, 5, 1).name('repetitions');
      fBench.add(xrBenchmark.debug, 'controlled').name('lock input + Recovery');
      fBench.add(xrBenchmark.debug, 'scene', sceneChoices).name('single scene').listen();
      fBench.add(xrBenchmark.debug, 'runSuite').name('run all four scenes');
      fBench.add(xrBenchmark.debug, 'runScene').name('run selected scene');
      fBench.add(xrBenchmark.debug, 'stop').name('stop benchmark');
      fBench.add(xrBenchmark.debug, 'download').name('download latest JSON');
      fBench.add(xrBenchmark.debug, 'status').listen().disable();
      fBench.add(xrBenchmark.debug, 'latest').listen().disable();
      fBench.close();
    }
    fXR.close();
  }

  // Location browser: explicit anchors plus safe random biome exploration.
  // Home is the original pre-trail summit; Trailhead is the current route spawn.
  let fLoc = null;
  if (locationActions) {
    fLoc = gui.addFolder('Locations');
    fLoc.add(locationActions, 'choice', {
      'Home — original summit': 'home',
      'Home surface — regression test': 'home-surface',
      'Trailhead — current spawn': 'trailhead',
      'Rail laboratory — manual loop': 'rail-lab',
      'Regional railway — first station': 'regional-railway',
      'Trail crossing — stepping stones': 'trail-stepping',
      'Trail crossing — fallen log': 'trail-log',
      'Trail crossing — plank bridge': 'trail-bridge',
      'Random NPC — travelling if any': 'random-npc',
      'Phase-1 generated cave': 'cave-spike',
      'Nearest trail': 'nearest-trail',
      'Nearest cave trail': 'nearest-cave-trail',
      'Sea cave — cliff path': 'sea-cave-path',
      'Nearest landmark': 'nearest-landmark',
      'Nearest Great Tree': 'great-tree',
      'Next Great Tree': 'next-great-tree',
      'Nearest watchtower ruin': 'watchtower',
      'Lighthouse — nearest coast': 'lighthouse',
      'Random safe location': 'random',
      'Random mountain': 'random-mountain',
      'Random beach': 'random-beach',
      'Coast — dune': 'coast-dune',
      'Coast — shingle': 'coast-shingle',
      'Coast — rocky headland': 'coast-rocky',
      'Coast — chalk cliffs': 'coast-chalk',
      'Random desert': 'random-desert',
      'Random savanna': 'random-savanna',
      'Random grassland': 'random-grassland',
      'Random forest': 'random-forest',
      'Random jungle': 'random-jungle',
      'Random taiga': 'random-taiga',
    }).name('destination').listen();
    fLoc.add(locationActions, 'go').name('go to destination');
    fLoc.add(locationActions, 'randomJump').name('random safe jump');
    fLoc.add(locationActions, 'home').name('⌂ home');
    fLoc.add(locationActions, 'homeSurface').name('⌂ home surface test');
    fLoc.add(locationActions, 'trailhead').name('↝ trailhead');
    fLoc.add(locationActions, 'railLab').name('🚂 rail laboratory');
    fLoc.add(locationActions, 'regionalRailway').name('⌘ regional railway plan');
    fLoc.add(locationActions, 'caveTrail').name('◇↝ cave trail');
    fLoc.add(locationActions, 'seaCavePath').name('≈◇ sea cave path');
    fLoc.add(locationActions, 'steppingCrossing').name('≋ stepping stones');
    fLoc.add(locationActions, 'logCrossing').name('≋ log crossing');
    fLoc.add(locationActions, 'plankBridge').name('≋ plank bridge');
    fLoc.add(locationActions, 'randomNpc').name('☻ random NPC');
    if (cave) fLoc.add(locationActions, 'cave').name('◇ cave experiment');
    fLoc.add(locationActions, 'greatTree').name('♣ Great Tree');
    fLoc.add(locationActions, 'nextGreatTree').name('♣ next Great Tree');
    fLoc.add(locationActions, 'watchtower').name('🏰 watchtower ruin');
    fLoc.add(locationActions, 'lighthouse').name('☼ lighthouse');
    fLoc.add(locationActions, 'current').name('current').listen().disable();
    fLoc.close();
  }

  if (railLab) {
    const fRail = gui.addFolder('Rail laboratory');
    fRail.add(railLab.debug, 'enabled').name('show laboratory');
    fRail.add(railLab.debug, 'running').name('train running');
    fRail.add(railLab.debug, 'speed', 0, 18, 0.25).name('speed (m/s)');
    fRail.add(railLab.debug, 'view', {
      'right window': 'right window',
      'left window': 'left window',
      forward: 'forward',
    }).name('passenger view').listen().onChange((value) => railLab.setView(value));
    fRail.add(railLab.debug, 'jumpToLab').name('jump to laboratory halt');
    fRail.add(railLab.debug, 'ride').name('board passenger car');
    fRail.add(railLab.debug, 'leave').name('leave train');
    fRail.add(railLab.debug, 'nextView').name('next passenger view');
    fRail.add(railLab.debug, 'reset').name('reset train position');
    fRail.add(railLab.debug, 'status').listen().disable();
    fRail.close();
  }

  if (regionalRailway) {
    const fRailPlan = gui.addFolder('Regional railway planner');
    fRailPlan.add(regionalRailway.debug, 'enabled').name('show plan')
      .onChange((value) => regionalRailway.setVisible(value));
    fRailPlan.add(regionalRailway.debug, 'terrainEnabled').name('terrain integration')
      .onChange((value) => regionalRailway.setTerrainEnabled(value));
    fRailPlan.add(regionalRailway.debug, 'trackEnabled').name('stream production track')
      .onChange((value) => regionalRailway.setTrackEnabled(value));
    fRailPlan.add(regionalRailway.debug, 'stationCount', 4, 6, 1).name('station count');
    fRailPlan.add(regionalRailway.debug, 'generate').name('generate regional loop');
    fRailPlan.add(regionalRailway.debug, 'jumpToPlan').name('jump to first station');
    fRailPlan.add(regionalRailway.debug, 'previousStation').name('← previous station');
    fRailPlan.add(regionalRailway.debug, 'nextStation').name('next station →');
    fRailPlan.add(regionalRailway.debug, 'printPlan').name('print plan to console');
    fRailPlan.add(regionalRailway.debug, 'status').listen().disable();
    fRailPlan.add(regionalRailway.debug, 'structures').listen().disable();
    if (regionalRailwayTrack) {
      fRailPlan.add(regionalRailwayTrack.debug, 'streamRadius', 1, 5, 1).name('track stream radius')
        .onChange((value) => regionalRailwayTrack.setStreamRadius(value));
      fRailPlan.add(regionalRailwayTrack.debug, 'masonryArches').name('Hoshi masonry structures')
        .onChange((value) => regionalRailwayTrack.setMasonryArches(value));
      fRailPlan.add(regionalRailwayTrack.debug, 'masonryProfile').name('masonry detail').listen().disable();
      fRailPlan.add(regionalRailwayTrack.debug, 'status').name('track streaming').listen().disable();
    }
    fRailPlan.close();
  }

  if (regionalRailwayService) {
    const fService = gui.addFolder('Regional passenger service');
    fService.add(regionalRailwayService.debug, 'board').name('board nearest door');
    fService.add(regionalRailwayService.debug, 'cycleView').name('switch seat');
    fService.add(regionalRailwayService.debug, 'leave').name('alight / step down');
    fService.add(regionalRailwayService.debug, 'smoke').name('chimney smoke');
    fService.add(regionalRailwayService.debug, 'sounds').name('train sounds');
    fService.add(regionalRailwayService.debug, 'testWhistle').name('🔊 test whistle');
    fService.add(regionalRailwayService.debug, 'status').listen().disable();
    fService.close();
  }

  if (livingWorldPopulation) {
    const fPeople = gui.addFolder('Living World population');
    fPeople.add(livingWorldPopulation.debug, 'enabled').name('show residents')
      .onChange((value) => livingWorldPopulation.setEnabled(value));
    fPeople.add(livingWorldPopulation.debug, 'residentsPerStation', 3, 7, 1)
      .name('residents per station')
      .onChange((value) => livingWorldPopulation.setResidentsPerStation(value));
    fPeople.add(livingWorldPopulation.debug, 'talkToNearest').name('test nearest NPC chat');
    fPeople.add(livingWorldPopulation.debug, 'status').name('population').listen().disable();
    fPeople.close();
  }

  if (cave) {
    const fCave = gui.addFolder('Cave entrance + streaming');
    fCave.add(cave.debug, 'resolution', { low: 32, medium: 48, high: 64 }).name('block resolution');
    fCave.add(cave.debug, 'wireframe').name('wireframe').onChange((v) => cave.setWireframe(v));
    fCave.add(cave.debug, 'surfaceDebug').name('surface semantics').onChange((v) => cave.setSurfaceDebug(v));
    fCave.add(cave.materialStyle, 'strength', 0, 1, 0.01).name('painted geology').onChange((v) => cave.setMaterialStrength(v));
    fCave.add(cave.hydrology, 'enabled').name('cave water').onChange((v) => cave.setHydrologyEnabled(v));
    fCave.add(cave.dressing, 'enabled').name('cave dressing').onChange((v) => cave.setDressingEnabled(v));
    fCave.add(cave.debug, 'lightingEnabled').name('cave atmosphere').onChange((v) => cave.setLightingEnabled(v));
    fCave.add(cave.atmosphere, 'navigationFill', 0, 0.2, 0.005).name('navigation fill');
    fCave.add(cave.debug, 'inspect').name('inspect entrance (orbit)').onChange((v) => cave.setInspection(v));
    fCave.add(cave.debug, 'showGraph').name('show topology graph').onChange((v) => cave.setShowGraph(v));
    fCave.add(cave.debug, 'previousAnchor').name('← previous valid anchor');
    fCave.add(cave.debug, 'nextAnchor').name('next valid anchor →');
    fCave.add(cave.debug, 'nextGeology').name('next geology →');
    fCave.add(cave.debug, 'previousChamber').name('← previous chamber');
    fCave.add(cave.debug, 'nextChamber').name('next chamber →');
    fCave.add(cave.debug, 'reviewLighting').name('☼ review entrance light');
    fCave.add(cave.debug, 'reviewWater').name('≋ review cave water');
    fCave.add(cave.debug, 'previewSurface').name('preview + preload entrance');
    fCave.add(cave.debug, 'enter').name('approach seamless entrance');
    fCave.add(cave.debug, 'exit').name('exit to surface');
    fCave.add(cave.debug, 'rebuild').name('rebuild at resolution');
    fCave.add(cave.debug, 'audit').name('run deterministic audit');
    fCave.add(cave.debug, 'state').listen().disable();
    fCave.add(cave.debug, 'collision').listen().disable();
    fCave.add(cave.debug, 'atmosphere').listen().disable();
    fCave.add(cave.debug, 'hydrology').listen().disable();
    fCave.add(cave.debug, 'dressing').listen().disable();
    fCave.add(cave.debug, 'anchor').listen().disable();
    fCave.add(cave.debug, 'placement').listen().disable();
    fCave.add(cave.debug, 'topology').listen().disable();
    fCave.add(cave.debug, 'graph').listen().disable();
    fCave.add(cave.debug, 'streaming').listen().disable();
    fCave.add(cave.debug, 'metrics').listen().disable();
    fCave.add(cave.debug, 'auditResult').name('audit').listen().disable();
    fCave.close();
  }

  if (carriedLantern) {
    const fLantern = gui.addFolder('Carried lantern');
    fLantern.add(carriedLantern, 'enabled').name('lit / carried')
      .onChange((value) => carriedLantern.setEnabled(value));
    fLantern.close();
  }

  if (animals) {
    const fAnimals = gui.addFolder('Procedural animals');
    const preview = (species) => animals.preview(
      species,
      controls?.rig.position || animals.lastPlayer,
      controls?.yaw || 0,
    );
    const animalActions = {
      deer: () => preview('whitetail'),
      fox: () => preview('fox'),
      moose: () => preview('moose'),
      showcase: () => animals.previewAll(
        controls?.rig.position || animals.lastPlayer,
        controls?.yaw || 0,
      ),
      resurvey: () => animals.resurvey(controls?.rig.position || animals.lastPlayer),
    };
    fAnimals.add(animals.debug, 'enabled').name('wildlife enabled');
    fAnimals.add(animals.debug, 'animationScale', 0, 2, 0.05).name('animation speed');
    // Which species inhabit the world (deer off by default). Re-surveys so the
    // change takes effect immediately at the player.
    const restream = () => animals.resurvey(controls?.rig.position || animals.lastPlayer);
    fAnimals.add(animals.debug, 'spawnFox').name('fox roams').onChange(restream);
    fAnimals.add(animals.debug, 'spawnMoose').name('moose roams').onChange(restream);
    fAnimals.add(animals.debug, 'spawnDeer').name('deer roams').onChange(restream);
    fAnimals.add(animals.debug, 'spawnChance', 0.02, 0.6, 0.01).name('spawn density').onChange(restream);
    fAnimals.add(animalActions, 'deer').name('preview white-tail');
    fAnimals.add(animalActions, 'fox').name('preview fox');
    fAnimals.add(animalActions, 'moose').name('preview moose');
    fAnimals.add(animalActions, 'showcase').name('show all three');
    fAnimals.add(animalActions, 'resurvey').name('resurvey (new scatter)');
    fAnimals.add(animals.debug, 'status').listen().disable();
    fAnimals.close();
  }

  // Day script: read out today's rolled sky, jump the sun to dusk, and reroll
  // the day to audition the variety (the seeded per-day sky character).
  const f4 = gui.addFolder('Day script');
  const dbg = {
    palette: '', quality: 0, cloudCover: 0, cirrus: 0, mie: 0, turbidity: 0, moon: 0,
    events: '', jumpToDusk() { sky.time = 0.755; },  // just past sunset (elev≈0), into the dusk band
    reroll() { sky.dayIndex++; sky.day = sky.rollDay(sky.dayIndex); refresh(); },
  };
  const ctrls = [
    f4.add(dbg, 'palette').name('dawn → dusk').listen(),
    f4.add(dbg, 'quality', 0, 1).name('drama').listen().disable(),
    f4.add(dbg, 'cloudCover', 0, 1).name('cloud cover').listen().disable(),
    f4.add(dbg, 'cirrus', 0, 1).name('cirrus').listen().disable(),
    f4.add(dbg, 'mie', 0, 1).name('sun glow (mie)').listen().disable(),
    f4.add(dbg, 'turbidity', 0, 1).name('haze/redness').listen().disable(),
    f4.add(dbg, 'moon', 0, 1).name('moon phase').listen().disable(),
    f4.add(dbg, 'events').name('events').listen(),
  ];

  // Weather inspector and phase audition controls.
  const f5 = gui.addFolder('Weather timeline');
  const jump = (time) => {
    sky.time = time;
    weather.update(sky.dayIndex, sky.time, sky.sunElevation, sky.moonIllum);
  };
  const wdbg = {
    mode: 'auto', scenario: '', current: '', transition: '', solar: '',
    forceMistyDawn: false, cloudCover: 0, mist: 0, wind: '', windTarget: '',
    dayLife: '', nightLife: '', skyVisibility: '', precipitation: '',
    predawn() { jump(0.23); },
    sunrise() { jump(0.25); },
    mistyMorning() { jump(0.27); },
    noon() { jump(0.50); },
    goldenHour() { jump(0.68); },
    sunset() { jump(0.75); },
    blueHour() { jump(0.77); },
    midnight() { jump(0.00); },
    faceSun() {
      if (!controls) return;
      controls.yaw = Math.atan2(-sky.sunDir.x, -sky.sunDir.z);
      controls.pitch = Math.asin(Math.max(-1, Math.min(1, sky.sunDir.y)));
    },
    printTimeline() {
      console.table(weather.planForDay(sky.dayIndex).knots.map((k) => ({
        hour: +k.hour.toFixed(2), archetype: k.archetype,
        windDegrees: +(k.windAngle * 180 / Math.PI).toFixed(0),
      })));
    },
    audit() { console.log('Weather audit', weather.audit(1000, sky.dayIndex)); },
  };
  f5.add(wdbg, 'mode', {
    auto: 'auto', clear: 'clear', scattered: 'scattered', dramatic: 'dramatic',
    overcast: 'overcast', 'storm (rain + thunder)': 'storm',
  })
    .name('force weather').listen()
    .onChange((value) => weather.setForced(value === 'auto' ? null : value));
  f5.add(wdbg, 'forceMistyDawn').name('force misty dawn').listen()
    .onChange((value) => weather.setForcedMistyDawn(value));
  f5.add(wdbg, 'scenario').listen().disable();
  f5.add(wdbg, 'current').listen().disable();
  f5.add(wdbg, 'transition').listen().disable();
  f5.add(wdbg, 'solar').listen().disable();
  f5.add(wdbg, 'cloudCover', 0, 1).name('cloud cover').listen().disable();
  f5.add(wdbg, 'mist', 0, 1).listen().disable();
  f5.add(wdbg, 'wind').name('shared wind').listen().disable();
  f5.add(wdbg, 'windTarget').name('weather target').listen().disable();
  f5.add(wdbg, 'dayLife').name('day ecology').listen().disable();
  f5.add(wdbg, 'nightLife').name('night ecology').listen().disable();
  f5.add(wdbg, 'skyVisibility').name('night sky').listen().disable();
  f5.add(wdbg, 'precipitation').name('precipitation').listen().disable();
  f5.add(wdbg, 'predawn').name('◷ predawn');
  f5.add(wdbg, 'sunrise').name('◷ sunrise');
  f5.add(wdbg, 'mistyMorning').name('◷ misty morning');
  f5.add(wdbg, 'noon').name('◷ noon');
  f5.add(wdbg, 'goldenHour').name('◷ golden hour');
  f5.add(wdbg, 'sunset').name('◷ sunset');
  f5.add(wdbg, 'blueHour').name('◷ blue hour');
  f5.add(wdbg, 'midnight').name('◷ midnight');
  if (controls) f5.add(wdbg, 'faceSun').name('☀ face sun (review)');
  f5.add(wdbg, 'printTimeline').name('print today to console');
  f5.add(wdbg, 'audit').name('audit 1000 days');

  const refresh = () => {
    if (locationActions) locationActions.refresh();
    if (chunkMgr) {
      let trailChunks = 0, trailVertices = 0;
      for (const chunk of chunkMgr.chunks.values()) {
        if (!chunk.trail) continue;
        trailChunks++;
        trailVertices += chunk.trail.geometry.attributes.position?.count || 0;
      }
      groundDbg.trailMeshes = `${trailChunks} chunks · ${trailVertices} vertices`;
    }
    const d = sky.day;
    dbg.palette = `${d.dawnPalette.name} → ${d.duskPalette.name}`; dbg.quality = +d.quality.toFixed(2);
    dbg.cloudCover = +d.cloudCover.toFixed(2); dbg.cirrus = +d.cirrusAmt.toFixed(2);
    dbg.mie = +d.mieBoost.toFixed(2); dbg.turbidity = +d.turbidity.toFixed(2);
    dbg.moon = +d.moonPhase.toFixed(2);
    dbg.events = [d.events.meteors && 'meteors', d.events.aurora && 'aurora'].filter(Boolean).join(', ') || '—';
    const w = weather.current;
    wdbg.mode = weather.forcedArchetype || 'auto';
    wdbg.forceMistyDawn = weather.forcedMistyDawn;
    wdbg.scenario = w.scenario;
    wdbg.current = w.archetype;
    wdbg.transition = `${w.fromArchetype} → ${w.toArchetype} · ${Math.round(w.transition * 100)}%`;
    wdbg.solar = w.solarPhase;
    wdbg.cloudCover = +w.cloudCover.toFixed(2);
    wdbg.mist = +w.mist.toFixed(2);
    const wd = windUniforms.uWindDir.value;
    const actualAngle = (Math.atan2(wd.y, wd.x) * 180 / Math.PI + 360) % 360;
    wdbg.wind = `${Math.round(actualAngle)}° · ${windUniforms.uWindSpeed.value.toFixed(1)} m/s · ${windUniforms.uWindStrength.value.toFixed(2)}`;
    wdbg.windTarget = `${Math.round(w.windAngle * 180 / Math.PI)}° · ${w.windSpeed.toFixed(1)} m/s · ${w.windStrength.toFixed(2)}`;
    wdbg.dayLife = `butterflies ${w.butterflyActivity.toFixed(2)} · birds ${w.birdActivity.toFixed(2)}`;
    wdbg.nightLife = `fireflies ${w.fireflyActivity.toFixed(2)} · chorus ${w.nocturnalActivity.toFixed(2)}`;
    wdbg.skyVisibility = `stars ${w.starVisibility.toFixed(2)} · moon ${w.moonVisibility.toFixed(2)}`;
    const dropCount = rain?.mesh.geometry.instanceCount ?? 0;
    wdbg.precipitation = `rain ${w.rain.toFixed(2)} · visible ${rain?.intensity.toFixed(2) ?? '—'} · ${dropCount} drops · storm ${w.storm.toFixed(2)}`;
  };
  refresh();
  setInterval(refresh, 1500);   // keep the readout live as days roll at midnight
  f4.add(dbg, 'jumpToDusk').name('▶ jump to dusk');
  f4.add(dbg, 'reroll').name('🎲 reroll day');
  f4.close();
  f5.close();

  // live GPU/scene cost readout, so every visual change gets a number
  if (renderer) {
    const fp = gui.addFolder('Perf');
    const perf = { drawCalls: 0, triangles: 0, batching: '—', geometries: 0, textures: 0 };
    fp.add(perf, 'drawCalls').listen().disable();
    fp.add(perf, 'triangles').listen().disable();
    fp.add(perf, 'batching').listen().disable();
    fp.add(perf, 'geometries').listen().disable();
    fp.add(perf, 'textures').listen().disable();
    if (shadowDebug) {
      fp.add(shadowDebug, 'surface').name('sun shadow').listen().disable();
      fp.add(shadowDebug, 'grass').name('grass shadow').listen().disable();
    }
    if (grassTrailDebug) {
      fp.add(grassTrailDebug, 'state').name('grass trail prep').listen().disable();
      fp.add(grassTrailDebug, 'cache').name('trail cache').listen().disable();
      fp.add(grassTrailDebug, 'timing').name('trail worker').listen().disable();
      fp.add(grassTrailDebug, 'late').name('late trail fields').listen().disable();
    }
    if (chunkMgr?.assemblyDebug) {
      fp.add(chunkMgr.assemblyDebug, 'queue').name('assembly queue').listen().disable();
      fp.add(chunkMgr.assemblyDebug, 'timing').name('assembly frame').listen().disable();
      fp.add(chunkMgr.assemblyDebug, 'lastProps').name('last clutter').listen().disable();
      fp.add(chunkMgr.assemblyDebug, 'peak').name('assembly peak').listen().disable();
    }
    setInterval(() => {
      perf.drawCalls = renderer.info.render.calls;
      perf.triangles = renderer.info.render.triangles;
      if (chunkMgr) {
        let meshes = 0, objects = 0, replaced = 0;
        for (const chunk of chunkMgr.chunks.values()) {
          for (const layer of [chunk.veg, chunk.clutter]) {
            if (!layer) continue;
            for (const child of layer.children) {
              if (!child.isBatchedMesh) continue;
              meshes++;
              objects += child.userData.batchedObjectCount || 0;
              replaced += child.userData.replacedDrawCalls || 0;
            }
          }
        }
        perf.batching = `${meshes} meshes · ${objects} props · ${replaced} old draws`;
      }
      perf.geometries = renderer.info.memory.geometries;
      perf.textures = renderer.info.memory.textures;
    }, 500);
    fp.close();
  }

  gui.close();   // start collapsed
  return gui;
}
