// Collapsible debug panel (lil-gui, three's bundled dat.gui successor) for
// live-tuning the Ghibli grade, post pipeline and world state.

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { windUniforms } from './wind.js';
import { groundDetailUniforms } from './grounddetail.js';
import { trailSurfaceUniforms } from './trailsurface.js';

export function setupDebugGUI({ post, sky, weather, rain, quality, chunkMgr = null, locationActions = null }) {
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
  f1.add(post, 'satBase', 0.8, 1.5, 0.01).name('saturation (day)');
  f1.add(g.uContrast, 'value', 0.8, 1.3, 0.01).name('base contrast');
  f1.add(post, 'autoShadowCol').name('shadow colour: auto');
  f1.addColor(g.uShadowCol, 'value').name('shadow colour (manual)');

  const f2 = gui.addFolder('Post FX');
  f2.add(post.bloom, 'strength', 0, 1, 0.01).name('bloom strength');
  f2.add(post.bloom, 'threshold', 0, 1.5, 0.01).name('bloom threshold');
  if (post.gtao) f2.add(post.gtao, 'enabled').name('SSAO');
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
  f3.add(quality, 'locked').name('lock quality tier');
  f3.add({ tier: quality.level }, 'tier', { potato: 0, low: 1, medium: 2, high: 3, ultra: 4 })
    .onChange((v) => quality.setLevel(+v));
  f3.close();

  // Location browser: explicit anchors plus safe random biome exploration.
  // Home is the original pre-trail summit; Trailhead is the current route spawn.
  let fLoc = null;
  if (locationActions) {
    fLoc = gui.addFolder('Locations');
    fLoc.add(locationActions, 'choice', {
      'Home — original summit': 'home',
      'Home surface — regression test': 'home-surface',
      'Trailhead — current spawn': 'trailhead',
      'Nearest trail': 'nearest-trail',
      'Nearest landmark': 'nearest-landmark',
      'Random safe location': 'random',
      'Random mountain': 'random-mountain',
      'Random beach': 'random-beach',
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
    fLoc.add(locationActions, 'current').name('current').listen().disable();
    fLoc.close();
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

  gui.close();   // start collapsed
  return gui;
}
