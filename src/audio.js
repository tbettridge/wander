// Procedural soundscape built on Tone.js — weather-driven wind, rain and
// thunder; birdsong by day and insects by night; surf/river noise near water;
// and surface-aware footsteps. Everything is synthesized; no samples.

const FOOTSTEP_SURFACES = {
  sand:  { type: 'brown', filter: 700,  vol: -23, decay: 0.10 },
  grass: { type: 'pink',  filter: 1400, vol: -26, decay: 0.07 },
  rock:  { type: 'white', filter: 2600, vol: -24, decay: 0.05 },
  snow:  { type: 'pink',  filter: 900,  vol: -22, decay: 0.12 },
  water: { type: 'white', filter: 1100, vol: -19, decay: 0.16 },
};

function surfaceForBiome(id, slope, wading) {
  if (wading) return 'water';
  if (slope > 0.45) return 'rock';
  if (id === 'beach' || id === 'desert') return 'sand';
  if (id === 'snow' || id === 'tundra') return 'snow';
  return 'grass';
}

export class Soundscape {
  constructor() {
    this.started = false;
    this.paramTimer = 0;
    this.birdTimer = 2;
    this.shorebirdTimer = 3;
    this.thunderTimer = 5 + Math.random() * 8;
    this.thunderEnabled = true;
  }

  async start() {
    if (this.started || typeof Tone === 'undefined') return;
    await Tone.start();
    this.started = true;

    this.master = new Tone.Gain(0.9);
    this.limiter = new Tone.Limiter(-3);
    this.master.connect(this.limiter);
    this.limiter.toDestination();

    // --- wind: pink noise through a slowly wandering lowpass
    this.windFilter = new Tone.Filter({ type: 'lowpass', frequency: 350, Q: 0.6 });
    this.windGain = new Tone.Gain(0.0);
    this.windWobble = new Tone.Gain(1);
    this.windNoise = new Tone.Noise('pink');
    this.windNoise.chain(this.windFilter, this.windWobble, this.windGain, this.master);
    this.windNoise.start();
    this.windLFO = new Tone.LFO({ frequency: 0.07, min: 0.75, max: 1.25 });
    // gentle amplitude shimmer on top of the gust envelope
    this.windLFO.connect(this.windWobble.gain);
    this.windLFO.start();

    // --- water: brown noise through a bandpass, gain by proximity
    this.waterFilter = new Tone.Filter({ type: 'bandpass', frequency: 620, Q: 0.8 });
    this.waterGain = new Tone.Gain(0.0);
    this.waterNoise = new Tone.Noise('brown');
    this.waterNoise.chain(this.waterFilter, this.waterGain, this.master);
    this.waterNoise.start();
    this.waterLFO = new Tone.LFO({ frequency: 0.13, min: 380, max: 900 });
    this.waterLFO.connect(this.waterFilter.frequency);
    this.waterLFO.start();

    // --- exposed coast: a separate breathing breaker bed. Brown water noise
    // supplies the body; this brighter pink/white pair adds the advancing crash
    // and retreating hiss that distinguish open surf from a river or pond.
    this.surfFilter = new Tone.Filter({ type: 'bandpass', frequency: 980, Q: 0.72 });
    this.surfWobble = new Tone.Gain(1);
    this.surfGain = new Tone.Gain(0.0);
    this.surfNoise = new Tone.Noise('pink');
    this.surfNoise.chain(this.surfFilter, this.surfWobble, this.surfGain, this.master);
    this.surfNoise.start();
    this.surfLFO = new Tone.LFO({ frequency: 0.115, min: 0.20, max: 1.0 });
    this.surfLFO.connect(this.surfWobble.gain);
    this.surfLFO.start();

    this.surfHissHP = new Tone.Filter({ type: 'highpass', frequency: 1900, Q: 0.35 });
    this.surfHissLP = new Tone.Filter({ type: 'lowpass', frequency: 6200, Q: 0.28 });
    this.surfHissWobble = new Tone.Gain(1);
    this.surfHissGain = new Tone.Gain(0.0);
    this.surfHissNoise = new Tone.Noise('white');
    this.surfHissNoise.chain(
      this.surfHissHP, this.surfHissLP, this.surfHissWobble, this.surfHissGain, this.master,
    );
    this.surfHissNoise.start();
    this.surfHissLFO = new Tone.LFO({ frequency: 0.115, phase: 105, min: 0.08, max: 1.0 });
    this.surfHissLFO.connect(this.surfHissWobble.gain);
    this.surfHissLFO.start();

    // --- streams: river flow. Pink noise through a lowpass whose cutoff and
    // gain both rise with flow speed (calm babble → bright rush on rapids),
    // gated by river proximity. A slow wobble on the cutoff adds burble.
    this.streamFilter = new Tone.Filter({ type: 'lowpass', frequency: 700, Q: 0.9 });
    this.streamWobble = new Tone.Gain(1);   // burble: LFO-driven amplitude shimmer
    this.streamGain = new Tone.Gain(0.0);   // proximity/rapids gain (ramped in update)
    this.streamNoise = new Tone.Noise('pink');
    this.streamNoise.chain(this.streamFilter, this.streamWobble, this.streamGain, this.master);
    this.streamNoise.start();
    // LFO drives the wobble gain (not the filter frequency — connecting an LFO
    // into a signal collapses its ramp range, which would break the rampTo below)
    this.streamLFO = new Tone.LFO({ frequency: 0.5, min: 0.72, max: 1.0 });
    this.streamLFO.connect(this.streamWobble.gain);
    this.streamLFO.start();

    // --- waterfall roar: deep brown noise, louder & fuller near a fall
    this.roarFilter = new Tone.Filter({ type: 'lowpass', frequency: 1100, Q: 0.6 });
    this.roarGain = new Tone.Gain(0.0);
    this.roarNoise = new Tone.Noise('brown');
    this.roarNoise.chain(this.roarFilter, this.roarGain, this.master);
    this.roarNoise.start();

    // --- footsteps
    this.stepFilter = new Tone.Filter({ type: 'lowpass', frequency: 1200, Q: 0.5 });
    this.stepVol = new Tone.Volume(-25);
    this.stepSynth = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.002, decay: 0.08, sustain: 0 },
    });
    this.stepSynth.chain(this.stepFilter, this.stepVol, this.master);

    // --- birds: a small pool of whistle voices. Each is a continuously
    // running sine whose pitch is *swept* per syllable (real chirps are
    // glissandi, not fixed notes) under a smooth tapered gain envelope, with a
    // little vibrato for the reedy syrinx quality. A shared highpass + reverb
    // bus seats them in the outdoor space. Calls are built from species-like
    // motifs (see chirp()).
    this.birdBus = new Tone.Gain(1);
    this.birdHP = new Tone.Filter({ type: 'highpass', frequency: 1500, Q: 0.5 });
    this.birdReverb = new Tone.Reverb({ decay: 1.6, preDelay: 0.01, wet: 0.22 });
    this.birdVol = new Tone.Volume(-11);
    this.birdBus.chain(this.birdHP, this.birdReverb, this.birdVol, this.master);

    this.birdVoices = [];
    for (let i = 0; i < 3; i++) {
      const osc = new Tone.Oscillator({ type: 'sine', frequency: 3000 }).start();
      const env = new Tone.Gain(0.0001);
      const panner = new Tone.Panner(0);
      osc.chain(env, panner, this.birdBus);
      // vibrato: a fast, shallow pitch wobble added on top of the sweep
      const vibrato = new Tone.LFO({
        frequency: 20 + Math.random() * 8, min: -16, max: 16,
      }).start();
      vibrato.connect(osc.frequency);
      this.birdVoices.push({ osc, env, panner, busyUntil: 0 });
    }

    // --- night chorus: a very narrow, gentle insect bed. It is deliberately
    // quiet and does not use samples; weather provides the activity gate in
    // update(), so it naturally falls away with wind, rain and storms.
    this.insectFilter = new Tone.Filter({ type: 'bandpass', frequency: 4100, Q: 5.5 });
    this.insectWobble = new Tone.Gain(1);
    this.insectGain = new Tone.Gain(0.0);
    this.insectNoise = new Tone.Noise('pink');
    this.insectNoise.chain(this.insectFilter, this.insectWobble, this.insectGain, this.master);
    this.insectNoise.start();
    this.insectLFO = new Tone.LFO({ frequency: 0.32, min: 0.48, max: 1.0 });
    this.insectLFO.connect(this.insectWobble.gain);
    this.insectLFO.start();

    // --- rain: broad high-frequency patter over a softer pink body. The
    // weather timeline drives one gain, so drizzle grows continuously into a
    // downpour without starting/stopping audio nodes.
    this.rainHP = new Tone.Filter({ type: 'highpass', frequency: 900, Q: 0.35 });
    this.rainLP = new Tone.Filter({ type: 'lowpass', frequency: 7600, Q: 0.3 });
    this.rainWobble = new Tone.Gain(1);
    this.rainGain = new Tone.Gain(0.0);
    this.rainNoise = new Tone.Noise('white');
    this.rainNoise.chain(this.rainHP, this.rainLP, this.rainWobble, this.rainGain, this.master);
    this.rainNoise.start();
    this.rainLFO = new Tone.LFO({ frequency: 0.11, min: 0.82, max: 1.0 });
    this.rainLFO.connect(this.rainWobble.gain);
    this.rainLFO.start();

    // Occasional brown-noise thunder sits below the wind/rain bed. It is only
    // scheduled during a strong storm; Phase 6 intentionally keeps it rare.
    this.thunderFilter = new Tone.Filter({ type: 'lowpass', frequency: 360, Q: 0.7 });
    this.thunderVol = new Tone.Volume(-7);
    this.thunderSynth = new Tone.NoiseSynth({
      noise: { type: 'brown' },
      envelope: { attack: 0.08, decay: 3.2, sustain: 0.18, release: 2.8 },
    });
    this.thunderSynth.chain(this.thunderFilter, this.thunderVol, this.master);
    this.thunderVol.mute = !this.thunderEnabled;
  }

  setComfort({ thunderEnabled = true } = {}) {
    this.thunderEnabled = !!thunderEnabled;
    if (this.thunderVol) this.thunderVol.mute = !this.thunderEnabled;
  }

  footstep(biomeId, slope, wading) {
    if (!this.started) return;
    const s = FOOTSTEP_SURFACES[surfaceForBiome(biomeId, slope, wading)];
    this.stepSynth.noise.type = s.type;
    this.stepSynth.envelope.decay = s.decay * (0.9 + Math.random() * 0.3);
    this.stepFilter.frequency.value = s.filter * (0.85 + Math.random() * 0.3);
    this.stepVol.volume.value = s.vol + Math.random() * 2;
    this.stepSynth.triggerAttackRelease(0.1);
  }

  // One swept syllable on a voice: continuous pitch glissando through `points`
  // (Hz control points) under a fast-attack / smooth-decay gain envelope.
  playSyllable(voice, t, points, dur, amp) {
    const f = voice.osc.frequency;
    f.setValueAtTime(points[0], t);
    const seg = dur / Math.max(1, points.length - 1);
    for (let i = 1; i < points.length; i++) {
      f.exponentialRampToValueAtTime(points[i], t + seg * i);
    }
    const g = voice.env.gain;
    const atk = Math.min(0.012, dur * 0.3);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(amp, t + atk);                              // quick attack
    g.exponentialRampToValueAtTime(Math.max(amp * 0.3, 0.001), t + dur);  // natural decay
    g.linearRampToValueAtTime(0.0001, t + dur + 0.008);                   // settle to silence
  }

  // Species-like motifs. Each returns a list of syllables {points, dur, gap, amp}
  // built around a base pitch; pitches are continuous sweeps, not fixed notes.
  static MOTIFS = {
    warble(base) {                       // cheerful up / up-down phrases (robin-ish)
      const out = [];
      const n = 3 + (Math.random() * 4 | 0);
      let p = base;
      for (let i = 0; i < n; i++) {
        const f0 = p * (0.85 + Math.random() * 0.3);
        const up = f0 * (1.15 + Math.random() * 0.4);
        const points = Math.random() < 0.5 ? [f0, up] : [f0, up, f0 * (0.85 + Math.random() * 0.15)];
        out.push({ points, dur: 0.06 + Math.random() * 0.08, gap: 0.03 + Math.random() * 0.06, amp: 0.4 + Math.random() * 0.3 });
        p = base * (0.9 + Math.random() * 0.4);
      }
      return out;
    },
    trill(base) {                        // fast buzzy repeated blips (chipping sparrow)
      const out = [];
      const n = 8 + (Math.random() * 9 | 0);
      const f0 = base * (0.9 + Math.random() * 0.3);
      const up = f0 * (1.12 + Math.random() * 0.18);
      const dur = 0.028 + Math.random() * 0.022;
      const gap = 0.018 + Math.random() * 0.022;
      for (let i = 0; i < n; i++) out.push({ points: [f0, up], dur, gap, amp: 0.3 + Math.random() * 0.2 });
      return out;
    },
    twoNote(base) {                      // clear descending whistles (chickadee fee-bee)
      const a = base * (1.0 + Math.random() * 0.15);
      const b = a * (0.7 + Math.random() * 0.12);
      return [
        { points: [a, a * 0.97], dur: 0.16 + Math.random() * 0.1, gap: 0.06 + Math.random() * 0.06, amp: 0.5 + Math.random() * 0.3 },
        { points: [b, b * 0.96], dur: 0.18 + Math.random() * 0.12, gap: 0.0, amp: 0.45 + Math.random() * 0.3 },
      ];
    },
    rising(base) {                       // a long sweeping whistle or two (wren)
      const out = [];
      const n = 1 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const f0 = base * (0.65 + Math.random() * 0.2);
        out.push({ points: [f0, f0 * (1.5 + Math.random() * 0.5)], dur: 0.18 + Math.random() * 0.14, gap: 0.05 + Math.random() * 0.05, amp: 0.45 + Math.random() * 0.3 });
      }
      return out;
    },
    chirp(base) {                        // simple short sparrow chirps
      const out = [];
      const n = 1 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const f0 = base * (0.95 + Math.random() * 0.2);
        out.push({ points: [f0, f0 * (1.2 + Math.random() * 0.2)], dur: 0.05 + Math.random() * 0.05, gap: 0.05 + Math.random() * 0.07, amp: 0.4 + Math.random() * 0.3 });
      }
      return out;
    },
  };

  static MOTIF_PICK = ['warble', 'warble', 'trill', 'twoNote', 'rising', 'chirp', 'chirp'];

  chirp() {
    const voice = this.birdVoices.find((v) => v.busyUntil < Tone.now());
    if (!voice) return; // all voices busy — let the existing songs breathe
    const base = 2100 + Math.random() * 1900;
    const name = Soundscape.MOTIF_PICK[(Math.random() * Soundscape.MOTIF_PICK.length) | 0];
    const sylls = Soundscape.MOTIFS[name](base);
    const loud = 0.6 + Math.random() * 0.4;
    voice.panner.pan.value = Math.random() * 1.5 - 0.75;
    let t = Tone.now() + 0.02;
    for (const s of sylls) {
      try { this.playSyllable(voice, t, s.points, s.dur, s.amp * loud); } catch (e) { /* scheduling race */ }
      t += s.dur + s.gap;
    }
    voice.busyUntil = t + 0.05;
  }

  shorebirdCall() {
    const voice = this.birdVoices.find((v) => v.busyUntil < Tone.now());
    if (!voice) return;
    voice.panner.pan.value = Math.random() * 1.7 - 0.85;
    const notes = 3 + (Math.random() * 4 | 0);
    const base = 3150 + Math.random() * 850;
    let t = Tone.now() + 0.02;
    for (let i = 0; i < notes; i++) {
      const f = base * (0.94 + Math.random() * 0.15);
      const dur = 0.035 + Math.random() * 0.028;
      try { this.playSyllable(voice, t, [f, f * 1.13, f * 1.02], dur, 0.32 + Math.random() * 0.18); } catch (e) { /* scheduling race */ }
      t += dur + 0.045 + Math.random() * 0.045;
    }
    voice.busyUntil = t + 0.04;
  }

  // state: { altitude, forestness, nearWater, coastPresence, coastExposure,
  //          riverNear, riverFlow, dayness,
  //          windStrength, windSpeed, rain, storm, birdActivity, nocturnalActivity,
  //          biomeId, slope, wading }
  update(dt, state, footstep) {
    if (!this.started) return;

    if (footstep) this.footstep(state.biomeId, state.slope, state.wading);

    // throttle parameter automation to ~4 Hz
    this.paramTimer -= dt;
    if (this.paramTimer <= 0) {
      this.paramTimer = 0.25;
      const altF = Math.min(1, Math.max(0, state.altitude / 220));
      const shelter = state.forestness * 0.45; // trees calm the wind
      const wind = Math.min(1, Math.max(0, state.windStrength ?? 0.4));
      const speed = Math.min(1, Math.max(0, (state.windSpeed ?? 7) / 18));
      const windAmt = (0.035 + wind * 0.14 + altF * 0.10) * (1 - shelter);
      this.windGain.gain.rampTo(windAmt, 0.4);
      this.windFilter.frequency.rampTo(220 + wind * 650 + speed * 180 + altF * 450, 0.5);
      const coast = Math.min(1, Math.max(0, state.coastPresence || 0));
      const exposure = Math.min(1.35, Math.max(0.65, state.coastExposure || 0.8));
      this.waterGain.gain.rampTo(state.nearWater * (0.12 + coast * 0.045), 0.6);
      this.surfGain.gain.rampTo(coast * (0.075 + exposure * 0.075), 0.65);
      this.surfFilter.frequency.rampTo(720 + exposure * 620 + (state.windStrength || 0) * 260, 0.7);
      this.surfHissGain.gain.rampTo(coast * (0.018 + exposure * 0.026), 0.72);
      this.surfHissHP.frequency.rampTo(1650 + exposure * 720, 0.8);

      // river flow: louder and brighter on rapids, gated by proximity
      const rNear = state.riverNear || 0, rFlow = state.riverFlow || 0;
      this.streamGain.gain.rampTo(rNear * (0.03 + rFlow * 0.14), 0.5);
      this.streamFilter.frequency.rampTo(450 + rFlow * 2800 + rNear * 150, 0.5);

      // waterfall roar: deep and loud, scaled by fall proximity
      const fall = state.fallNear || 0;
      this.roarGain.gain.rampTo(fall * 0.24, 0.6);
      this.roarFilter.frequency.rampTo(700 + fall * 1400, 0.6);

      // Forests and water margins carry more of the night chorus, but a dry,
      // calm weather gate remains the final word. The wobble above supplies
      // breathing room without modulating the automated base gain itself.
      const nightLife = Math.min(1, Math.max(0, state.nocturnalActivity ?? (1 - state.dayness)));
      const nightHabitat = 0.20 + state.forestness * 0.58 + state.nearWater * 0.22;
      this.insectGain.gain.rampTo(nightLife * nightHabitat * 0.028, 0.8);
      this.insectFilter.frequency.rampTo(3650 + nightLife * 850 + state.nearWater * 240, 0.7);

      const rain = Math.min(1, Math.max(0, state.rain ?? 0));
      const rainBody = Math.pow(rain, 0.72);
      this.rainGain.gain.rampTo(rainBody * (0.055 + rain * 0.065) * (1 - shelter * 0.18), 0.55);
      this.rainHP.frequency.rampTo(720 + rain * 900, 0.6);
      this.rainLP.frequency.rampTo(5200 + rain * 4300, 0.6);
    }

    const storm = Math.min(1, Math.max(0, state.storm ?? 0));
    if (storm > 0.45 && this.thunderEnabled) {
      this.thunderTimer -= dt * (0.45 + storm * 0.75);
      if (this.thunderTimer <= 0) {
        const duration = 2.8 + Math.random() * 2.6;
        try {
          this.thunderFilter.frequency.value = 260 + Math.random() * 190;
          this.thunderSynth.triggerAttackRelease(duration, Tone.now() + 0.02, 0.45 + storm * 0.42);
        } catch (e) { /* audio scheduling race during tab suspend/resume */ }
        this.thunderTimer = 8 + Math.random() * 18;
      }
    } else {
      // Do not bank a long clear-weather delay; an arriving storm should become
      // sonically legible within a few seconds, without thunder firing instantly.
      this.thunderTimer = Math.min(this.thunderTimer, 6);
    }

    // birdsong: forests, daytime — frequent enough to feel like a chorus, with
    // 3 voices so calls can overlap and answer each other
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 0.5 + Math.random() * 1.6;
      const birdActivity = state.birdActivity ?? state.dayness;
      const p = state.forestness * birdActivity * 0.8;
      if (Math.random() < p) this.chirp();
    }


    // Sandpiper-like piping is tied to the strand rather than forest cover.
    this.shorebirdTimer -= dt;
    if (this.shorebirdTimer <= 0) {
      this.shorebirdTimer = 1.8 + Math.random() * 4.2;
      const coast = Math.min(1, Math.max(0, state.coastPresence || 0));
      const birdActivity = state.birdActivity ?? state.dayness;
      if (Math.random() < coast * birdActivity * 0.72) this.shorebirdCall();
    }
  }
}
