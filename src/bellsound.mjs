// The sound of one strike of a cast church bell, as samples. Pure, so the
// same bell can be rendered in a test or a script as in the game.
//
// A church bell is not a chime. Its character is its partials: the hum an
// octave below the note, the prime, the minor-third "tierce" that makes a
// bell sound like a bell and not an organ, the quint, the bright nominal an
// octave up, and a cluster above it. Each dies away at its own rate, the hum
// last, so a bell rings bright and settles into a long low murmur. Every
// partial is a close pair (the bell is not perfectly round), which gives the
// slow warble you hear after the strike, and the clapper adds a click.

/** Partials relative to the prime: ratio, strength at the strike, seconds to fall to 1/e. */
export const BELL_PARTIALS = Object.freeze([
  { name: 'hum', ratio: 0.5, amp: 0.5, tau: 5.2 },
  { name: 'prime', ratio: 1.0, amp: 0.38, tau: 3.4 },
  { name: 'tierce', ratio: 1.19, amp: 0.55, tau: 2.8 },
  { name: 'quint', ratio: 1.505, amp: 0.18, tau: 1.7 },
  { name: 'nominal', ratio: 2.0, amp: 0.7, tau: 2.1 },
  { name: 'deciem', ratio: 2.61, amp: 0.2, tau: 0.95 },
  { name: 'superquint', ratio: 3.01, amp: 0.34, tau: 0.85 },
  { name: 'octave nominal', ratio: 4.05, amp: 0.24, tau: 0.5 },
  { name: 'upper third', ratio: 5.36, amp: 0.14, tau: 0.3 },
  { name: 'upper fifth', ratio: 6.1, amp: 0.1, tau: 0.22 },
]);

function random(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * One strike of a bell whose prime is `frequency` Hz, `seconds` long,
 * normalised to a peak of 0.9. `seed` sets the small imperfections (warble
 * rates, phases), so each tower's bell is its own.
 */
export function churchBellSamples(frequency, { sampleRate = 44100, seconds = 12, seed = 1 } = {}) {
  const rng = random(seed);
  const length = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(length);
  for (const partial of BELL_PARTIALS) {
    const f = frequency * partial.ratio;
    if (f > sampleRate * 0.45) continue;
    // The pair: a fraction of a hertz to a couple of hertz apart, set by how out-of-round the bell is.
    const split = (0.25 + rng() * 1.2) * (partial.ratio < 1.6 ? 0.6 : 1);
    const voices = [{ f: f - split / 2, phase: rng() * Math.PI * 2, share: 0.55 }, { f: f + split / 2, phase: rng() * Math.PI * 2, share: 0.45 }];
    for (const voice of voices) {
      const step = 2 * Math.PI * voice.f / sampleRate, decay = Math.exp(-1 / (partial.tau * sampleRate));
      let level = partial.amp * voice.share, phase = voice.phase;
      for (let i = 0; i < length; i++) {
        out[i] += Math.sin(phase) * level;
        phase += step; level *= decay;
        if (level < 1e-5) break;
      }
    }
  }
  // The clapper: a short bright click, and a few quick inharmonic clangs above.
  let last = 0;
  for (let i = 0; i < Math.min(length, Math.round(sampleRate * 0.04)); i++) {
    const noise = rng() * 2 - 1, bright = noise - last; last = noise;
    out[i] += bright * 0.22 * Math.exp(-i / (sampleRate * 0.005));
  }
  for (const ratio of [7.9, 9.4, 11.2]) {
    const step = 2 * Math.PI * frequency * ratio / sampleRate;
    if (frequency * ratio > sampleRate * 0.45) continue;
    for (let i = 0; i < Math.min(length, Math.round(sampleRate * 0.3)); i++) out[i] += Math.sin(i * step) * 0.06 * Math.exp(-i / (sampleRate * 0.045));
  }
  // A strike does not start at full volume in the same sample: a 2 ms onset avoids a digital pop.
  const onset = Math.round(sampleRate * 0.002);
  for (let i = 0; i < onset; i++) out[i] *= i / onset;
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] *= 0.9 / peak;
  return out;
}

/** Strength of one frequency in a stretch of samples (Goertzel), for tests. */
export function toneStrength(samples, frequency, sampleRate, from = 0, to = samples.length) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = samples[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (to - from);
}
