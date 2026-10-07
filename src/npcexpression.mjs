// Small additive clips for the game's procedural rigs. Lower-body contacts
// stay with the gait solver; these performances only use the head and arms.
export const NPC_GESTURES = Object.freeze({
  nod: { duration: 1.15, description: 'agree or affirm with a small head nod' },
  'shake-head': { duration: 1.25, description: 'gently disagree or refuse' },
  shrug: { duration: 1.65, description: 'uncertainty, helplessness or a light concession' },
  'open-hand': { duration: 1.8, description: 'explain or offer something with an open hand' },
  'hand-on-chest': { duration: 1.7, description: 'sincerity, gratitude or personal reassurance' },
  thoughtful: { duration: 2.0, description: 'consider an idea with a hand near the chin' },
  wave: { duration: 1.9, description: 'a brief friendly greeting or farewell' },
  bow: { duration: 1.5, description: 'a small polite bow of thanks or respect' },
  point: { duration: 3.5, description: 'point towards a known place named in the following sentence; use only places in the supplied context' },
});

export const NPC_GESTURE_INSTRUCTIONS = 'Body gesture library (silent markers): '
  + Object.entries(NPC_GESTURES).map(([name, clip]) => `<gesture:${name}> = ${clip.description}`).join('; ')
  + '. Use at most two per reply, only where the words warrant it. Put each at the START of a speech segment, immediately before the sentence it accompanies. '
  + 'When giving directions to a supplied place, start its sentence with <gesture:point> and keep any earlier greeting or explanation in a separate segment. '
  + 'Example: {"segments":[{"text":"<gesture:nod> Yes, that sounds sensible.","style":"warm, agreeable"}]}. '
  + 'A marker is a game animation instruction, never a spoken word, a vocal tag or a world fact. Do not invent gestures.';

const clamp = value => Math.max(0, Math.min(1, value));
const mix = value => {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (Math.imul(value ^ (value >>> 16), 0x45d9f3b) ^ (value >>> 16)) >>> 0;
};

// Independent, irregular blink times for every character, even without speech.
export function npcBlinkAt(seconds, seed = 1) {
  const time = Math.max(0, Number(seconds) || 0) + (mix(seed) % 4500) / 1000;
  const cycle = Math.floor(time / 4.5), phase = time % 4.5;
  const start = 0.4 + (mix(seed ^ cycle) % 3200) / 1000;
  const pulse = offset => {
    const t = (phase - start - offset) / 0.18;
    return t >= 0 && t <= 1 ? Math.sin(Math.PI * t) ** 2 : 0;
  };
  return Math.max(pulse(0), mix(seed + cycle) % 7 === 0 ? pulse(0.3) : 0);
}

// 20 ms RMS windows track syllable energy and close the mouth during pauses.
// The envelope is tiny compared with the PCM buffer and cheap to sample per frame.
export function buildSpeechEnvelope(samples, sampleRate = 24000) {
  const window = Math.max(1, Math.round(sampleRate * 0.02));
  const values = new Float32Array(Math.ceil(samples.length / window));
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const end = Math.min(samples.length, (i + 1) * window);
    let sum = 0;
    for (let j = i * window; j < end; j++) sum += samples[j] * samples[j];
    values[i] = Math.sqrt(sum / (end - i * window));
    peak = Math.max(peak, values[i]);
  }
  return { values, step: window / sampleRate, duration: samples.length / sampleRate,
    peak: Math.max(0.035, peak), gate: Math.max(0.006, peak * 0.055) };
}

export function mouthAmountAt(envelope, seconds) {
  if (!envelope || seconds < 0 || seconds >= envelope.duration) return 0;
  const index = seconds / envelope.step, i = Math.floor(index);
  const a = envelope.values[i] || 0, b = envelope.values[i + 1] ?? a;
  const energy = a + (b - a) * (index - i);
  return Math.sqrt(clamp((energy - envelope.gate) / (envelope.peak - envelope.gate)));
}

export function npcGesturePose(name, seconds, hand = 'right') {
  const clip = Object.hasOwn(NPC_GESTURES, name) ? NPC_GESTURES[name] : null;
  if (!clip || !Number.isFinite(seconds) || seconds < 0 || seconds >= clip.duration) return null;
  const t = seconds / clip.duration, weight = Math.sin(Math.PI * t) ** 0.8;
  const side = hand === 'left' ? 'left' : 'right', sign = side === 'left' ? -1 : 1;
  const pose = {};
  const rotate = (bone, x = 0, y = 0, z = 0) => { pose[bone] = [x * weight, y * weight, z * weight]; };
  switch (name) {
    case 'nod': rotate('head', 0.13 * (1 - Math.cos(t * Math.PI * 4))); break;
    case 'shake-head': rotate('head', 0, Math.sin(t * Math.PI * 4) * 0.23); break;
    case 'shrug':
      for (const [key, outward] of [['left', -1], ['right', 1]]) {
        rotate(`${key}UpperArm`, -0.25, 0, outward * 0.34);
        rotate(`${key}Forearm`, -0.65);
        rotate(`${key}Hand`, 0.18);
      }
      rotate('head', 0, 0, 0.06); break;
    case 'open-hand':
      rotate(`${side}UpperArm`, -0.48, 0, sign * 0.2);
      rotate(`${side}Forearm`, -0.62); rotate(`${side}Hand`, 0.12); break;
    case 'hand-on-chest':
      rotate(`${side}UpperArm`, -0.7, 0, -sign * 0.24);
      rotate(`${side}Forearm`, -1.12); rotate('head', 0.05); break;
    case 'thoughtful':
      rotate(`${side}UpperArm`, -0.7, 0, -sign * 0.18);
      rotate(`${side}Forearm`, -1.4); rotate('head', 0.06, 0, sign * 0.05); break;
    case 'wave':
      rotate(`${side}UpperArm`, -0.9, 0, sign * 0.65);
      rotate(`${side}Forearm`, -1.2);
      rotate(`${side}Hand`, 0, 0, Math.sin(t * Math.PI * 8) * 0.4); break;
    case 'bow': rotate('chest', 0.18); rotate('head', 0.12); break;
  }
  return pose;
}
