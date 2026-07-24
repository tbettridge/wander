// Procedural train sounds on Tone.js, matching the Soundscape's no-assets
// approach. Three elements, all synthesized:
//  - rail-joint click-clack: paired transient knocks as each bogie crosses a
//    joint, spaced by real geometry (rail length / bogie wheelbase / speed).
//    This is a LOCAL sound — muffled when riding, gone within ~140m on foot.
//  - a steam whistle on its OWN 3D-panned path so it carries spatially for
//    kilometres (a real quill can be heard 5-15km across open country). It
//    bypasses the local muffle filter; distance attenuation and stereo come
//    from a Panner3D driven by the listener/camera each frame.
//  - varied blowing: patterns and cadence differ each time; only ~1/3 of
//    departures and ~1/10 of transits get a whistle.
// Everything is built lazily once the audio context is live.

const RAIL_LENGTH = 15;                 // metres between joints
const AXLE_OFFSETS = [0, 0.9, 4.7, 5.6]; // axle positions behind the lead axle
const QUILL = [466, 587, 698];          // Bb4 · D5 · F5 — a classic minor quill

// Whistle phrase library. Each entry is a list of PHRASES; a phrase is a burst
// of blasts ('S' short, 'L' long) blown close together, and phrases are
// separated by a longer break. Mirrors the variety the user asked for.
const WHISTLE_PATTERNS = [
  [['S', 'L'], ['S', 'L']],        // short-long · break · short-long (crossing)
  [['S', 'S'], ['S', 'S']],        // short-short · break · short-short
  [['L', 'S', 'S']],               // long-short-short
  [['S', 'L', 'L'], ['S', 'L']],   // short-long-long · break · short-long
  [['L']],                         // a lone long (approach)
  [['S', 'S']],                    // two shorts (acknowledge)
  [['L', 'L']],                    // two longs (open country)
];

function hasTone() {
  return typeof Tone !== 'undefined';
}

export class RailwayAudio {
  constructor(getBus = null) {
    this.getBus = getBus;               // () => Tone node (Soundscape master)
    this.enabled = false;
    this.built = false;
    this.trackPos = 0;                  // metres run since enable, for joints
    this.nextJoint = RAIL_LENGTH;
    this.transitCountdown = -1;         // >0 = a whistle scheduled this transit
    this.whistleBusy = 0;
  }

  /** True once the audio context is live (needs a user gesture) and, if a bus
   * was supplied, that bus exists — so we route through the Soundscape limiter
   * rather than straight to the destination. */
  canStart() {
    if (!hasTone() || Tone.context.state !== 'running') return false;
    return this.getBus ? !!this.getBus() : true;
  }

  async setEnabled(enabled) {
    this.enabled = !!enabled && hasTone();
    if (this.enabled && !this.built) {
      await Tone.start();
      this._build();
    }
    if (!this.built) return;
    this.outGain.gain.rampTo(this.enabled ? 1 : 0.0001, 0.25);
  }

  _build() {
    this.built = true;
    const destination = this.getBus?.() || Tone.getDestination();

    this.outGain = new Tone.Gain(0.0001);
    this.outGain.connect(destination);

    // --- click-clack: local sound through a perspective (muffle) filter -----
    this.perspective = new Tone.Filter({ type: 'lowpass', frequency: 2600, Q: 0.4 });
    this.perspective.connect(this.outGain);
    this.clackGain = new Tone.Gain(0);
    this.clackGain.connect(this.perspective);
    this.clackBand = new Tone.Filter({ type: 'bandpass', frequency: 1500, Q: 1.1 });
    this.clackNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    });
    this.clackNoise.chain(this.clackBand, this.clackGain);
    this.clackThump = new Tone.MembraneSynth({
      pitchDecay: 0.015, octaves: 3,
      envelope: { attack: 0.001, decay: 0.085, sustain: 0, release: 0.03 },
      volume: -10,
    });
    this.clackThump.connect(this.clackGain);

    // --- whistle: its own spatial path, far-reaching, NOT muffled ------------
    // A gentle rolloff keeps it audible for kilometres; the Panner3D places it
    // at the locomotive and pans/attenuates against the listener (camera).
    this.whistlePanner = new Tone.Panner3D({
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      refDistance: 70,
      rolloffFactor: 0.16,
      maxDistance: 16000,
    });
    this.whistlePanner.connect(this.outGain);
    this.whistleEcho = new Tone.FeedbackDelay({ delayTime: 0.28, feedback: 0.26, wet: 0.16 });
    this.whistleEcho.connect(this.whistlePanner);
    this.whistleGain = new Tone.Gain(0.0001);
    this.whistleVibrato = new Tone.Vibrato({ frequency: 5.2, depth: 0.015 });
    this.whistleGain.connect(this.whistleEcho);
    this.whistleVibrato.connect(this.whistleGain);
    this.whistleVoices = QUILL.map((frequency, i) => {
      const osc = new Tone.Oscillator({
        frequency,
        type: i === 0 ? 'triangle' : 'sine',
        volume: i === 0 ? -6 : -9 - i * 2,
      });
      osc.connect(this.whistleVibrato);
      osc.start();
      return osc;
    });
    this.whistleBreath = new Tone.Noise('white');
    this.whistleBreathBand = new Tone.Filter({ type: 'bandpass', frequency: 640, Q: 3.2 });
    this.whistleBreathGain = new Tone.Gain(0);
    this.whistleBreath.chain(this.whistleBreathBand, this.whistleBreathGain, this.whistleGain);
    this.whistleBreath.start();
  }

  /** One clack: randomized so no two joints sound stamped from the same die. */
  _clack(when, heavy) {
    const jitter = 0.9 + Math.random() * 0.25;
    this.clackBand.frequency.setValueAtTime(1250 + Math.random() * 700, when);
    this.clackNoise.triggerAttackRelease(0.05, when, 0.55 * jitter);
    if (heavy) this.clackThump.triggerAttackRelease(64 + Math.random() * 14, 0.09, when, 0.7 * jitter);
  }

  /** A single whistle blast with scoop-up attack and sagging release. */
  _blast(when, duration, level) {
    for (let i = 0; i < this.whistleVoices.length; i++) {
      const f = QUILL[i];
      const voice = this.whistleVoices[i].frequency;
      voice.cancelScheduledValues(when);
      voice.setValueAtTime(f * 0.93, when);
      voice.exponentialRampToValueAtTime(f, when + 0.13);
      voice.setValueAtTime(f, when + duration);
      voice.exponentialRampToValueAtTime(f * 0.955, when + duration + 0.4);
    }
    const g = this.whistleGain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(0.0001, when);
    g.exponentialRampToValueAtTime(level, when + 0.09);
    g.setValueAtTime(level, when + duration);
    g.exponentialRampToValueAtTime(0.0001, when + duration + 0.55);
    const b = this.whistleBreathGain.gain;
    b.cancelScheduledValues(when);
    b.setValueAtTime(0.0001, when);
    b.exponentialRampToValueAtTime(level * 0.45, when + 0.07);
    b.setValueAtTime(level * 0.3, when + duration);
    b.exponentialRampToValueAtTime(0.0001, when + duration + 0.4);
  }

  _randomPattern() {
    return WHISTLE_PATTERNS[(Math.random() * WHISTLE_PATTERNS.length) | 0];
  }

  _playPattern(phrases, level = 0.8) {
    const SHORT = 0.4, LONG = 1.3, INTRA = 0.24, PHRASE_BREAK = 0.8;
    let t = Tone.now() + 0.03;
    const start = t;
    for (let p = 0; p < phrases.length; p++) {
      for (const token of phrases[p]) {
        const dur = token === 'L' ? LONG : SHORT;
        this._blast(t, dur, level);
        t += dur + INTRA;
      }
      if (p < phrases.length - 1) t += PHRASE_BREAK;
    }
    this.whistleBusy = (t - start) + 1.0;
  }

  /** Blow the whistle. `pattern` may be an explicit phrase list; otherwise a
   * random one is chosen so the cadence varies each time. */
  whistle(pattern = null) {
    if (!this.built || this.whistleBusy > 0) return;
    this._playPattern(Array.isArray(pattern) ? pattern : this._randomPattern());
  }

  async testWhistle() {
    if (!hasTone()) return;
    if (!this.built) { await Tone.start(); this._build(); this.outGain.gain.rampTo(1, 0.1); }
    this.whistleBusy = 0;
    this.whistle();
  }

  /** Called on each station departure: ~1/3 blow now, and ~1/10 of transits
   * schedule one lonely whistle somewhere along the way. */
  onDeparture() {
    if (!this.enabled) return;
    if (Math.random() < 0.33) this.whistle();
    this.transitCountdown = Math.random() < 0.10 ? 25 + Math.random() * 70 : -1;
  }

  _updateListener(l) {
    const ctx = Tone.getContext().rawContext;
    const lis = ctx.listener;
    if (!lis) return;
    if (lis.positionX) {
      const t = ctx.currentTime;
      lis.positionX.setValueAtTime(l.x, t);
      lis.positionY.setValueAtTime(l.y, t);
      lis.positionZ.setValueAtTime(l.z, t);
      lis.forwardX.setValueAtTime(l.fx, t);
      lis.forwardY.setValueAtTime(l.fy, t);
      lis.forwardZ.setValueAtTime(l.fz, t);
      lis.upX.setValueAtTime(0, t); lis.upY.setValueAtTime(1, t); lis.upZ.setValueAtTime(0, t);
    } else if (lis.setPosition) {
      lis.setPosition(l.x, l.y, l.z);
      lis.setOrientation(l.fx, l.fy, l.fz, 0, 1, 0);
    }
  }

  /**
   * @param state {
   *   speed, riding, moving, distance,   // m/s, bool, bool, metres to train
   *   train: {x,y,z},                    // whistle source (locomotive)
   *   listener: {x,y,z,fx,fy,fz},        // camera position + forward
   * }
   */
  update(dt, state) {
    if (!this.enabled || !this.built || !(dt > 0)) return;
    this.whistleBusy = Math.max(0, this.whistleBusy - dt);

    // Spatialize the whistle every frame so it is already positioned when blown.
    if (state.listener) this._updateListener(state.listener);
    if (state.train) this.whistlePanner.setPosition(state.train.x, state.train.y, state.train.z);

    const { speed = 0, riding = false, distance = 0, moving = false } = state;

    // Click-clack perspective: aboard = close but muffled; on foot it thins and
    // darkens with distance, silent beyond ~140m.
    const reach = Math.max(0, 1 - distance / 140);
    const proximity = riding ? 1 : reach * reach;
    this.perspective.frequency.rampTo(riding ? 1500 : 2400 + reach * 2200, 0.3);

    if (speed > 0.9) {
      this.trackPos += speed * dt;
      const gain = (riding ? 0.4 : 0.55) * proximity * Math.min(1, speed / 9);
      this.clackGain.gain.rampTo(gain, 0.2);
      while (this.trackPos >= this.nextJoint) {
        const late = (this.trackPos - this.nextJoint) / speed;
        const base = Tone.now() - Math.min(late, 0.05);
        for (let a = 0; a < AXLE_OFFSETS.length; a++) {
          this._clack(base + AXLE_OFFSETS[a] / speed + 0.01, a % 2 === 0);
        }
        this.nextJoint += RAIL_LENGTH;
      }
    } else {
      this.clackGain.gain.rampTo(0, 0.4);
    }

    // The occasional lonely whistle scheduled for this transit.
    if (moving && this.transitCountdown > 0) {
      this.transitCountdown -= dt;
      if (this.transitCountdown <= 0) { this.transitCountdown = -1; this.whistle(); }
    }
  }

  dispose() {
    if (!this.built) return;
    for (const osc of this.whistleVoices) { osc.stop(); osc.dispose(); }
    this.whistleBreath.stop();
    for (const node of [
      this.whistleBreath, this.whistleBreathBand, this.whistleBreathGain,
      this.whistleVibrato, this.whistleGain, this.whistleEcho, this.whistlePanner,
      this.clackNoise, this.clackBand, this.clackThump, this.clackGain,
      this.perspective, this.outGain,
    ]) node.dispose();
    this.built = false;
  }
}
