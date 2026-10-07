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
  'hand-beats': { duration: 2.6, sustain: true, description: 'small, subtle rhythmic hand beats for ordinary conversation, explanations or storytelling; the default when no more specific gesture fits' },
  'laugh-bounce': { duration: 2.0, description: 'light laughing shoulder bounces, accompanying a chuckle or laugh' },
  'hold-on': { duration: 2.3, bothHands: true, description: 'raise BOTH palms outward to warn, object, interrupt or say hold on' },
  'crossed-arms': { duration: 3.0, sustain: true, bothHands: true, description: 'fold arms across the chest to show defensiveness, anger or guardedness' },
  downcast: { duration: 2.6, description: 'glance down and lower the head in embarrassment, regret or sadness' },
  'hands-behind-back': { duration: 3.8, sustain: true, bothHands: true, description: 'rest both arms behind the back while gently swaying with affinity, comfort or ease' },
  'hair-tuck': { duration: 2.5, description: 'brush hair behind an ear with one hand; shy, self-conscious or flirtatious when appropriate to the character and conversation' },
  'look-over-shoulder': { duration: 2.4, description: 'look over one shoulder while sharing gossip, a secret or checking surroundings' },
  'fearful-glance': { duration: 2.3, description: 'look quickly from side to side with fear or nervous vigilance' },
  'curious-lean': { duration: 2.6, description: 'tilt the head and lean the upper body slightly forward with curiosity, interest or a question' },
});

export const NPC_GESTURE_INSTRUCTIONS = 'Body gesture library (silent markers): '
  + Object.entries(NPC_GESTURES).map(([name, clip]) => `<gesture:${name}> = ${clip.description}`).join('; ')
  + '. Every dialogue reply MUST contain one or two gesture markers in total: at least one and no more than two. '
  + 'If no specific gesture fits, use <gesture:hand-beats> for subtle conversational emphasis or storytelling. '
  + 'Use the rest of the library whenever it better expresses the story, emotion or meaning. Put each marker at the START of a speech segment, immediately before the sentence it accompanies. '
  + 'Pair a laughing shoulder bounce with <chuckle> or <laugh> at the start of that phrase when laughter is appropriate. '
  + 'Choose gestures that fit the character, age, personality, mood and available hands. Two-handed gestures need both hands free. '
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

export function npcGestureWeight(name, seconds, duration = NPC_GESTURES[name]?.duration) {
  const clip = Object.hasOwn(NPC_GESTURES, name) ? NPC_GESTURES[name] : null;
  if (!clip || !Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0 || seconds < 0 || seconds >= duration) return 0;
  if (clip.sustain) {
    const ramp = Math.min(0.4, duration * 0.25);
    const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
    return smooth(seconds / ramp) * smooth((duration - seconds) / ramp);
  }
  return Math.sin(Math.PI * seconds / duration) ** 0.8;
}

export function npcGesturePose(name, seconds, hand = 'right', duration = NPC_GESTURES[name]?.duration) {
  const clip = Object.hasOwn(NPC_GESTURES, name) ? NPC_GESTURES[name] : null;
  if (!clip || !Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0 || seconds < 0 || seconds >= duration) return null;
  const t = seconds / duration, weight = npcGestureWeight(name, seconds, duration);
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
    case 'hand-beats': {
      const beat = Math.sin(seconds * Math.PI * 2 * 0.9);
      rotate(`${side}UpperArm`, -0.22 - beat * 0.035, 0, sign * 0.08);
      rotate(`${side}Forearm`, -0.4 - beat * 0.11);
      rotate(`${side}Hand`, 0.08 + beat * 0.04);
      rotate('chest', beat * 0.006); break;
    }
    case 'laugh-bounce': {
      const bounce = Math.sin(seconds * Math.PI * 2 * 3.2);
      rotate('chest', -0.035 + bounce * 0.025);
      rotate('head', -0.04 + bounce * 0.035);
      rotate('leftUpperArm', 0, 0, -0.025 * bounce);
      rotate('rightUpperArm', 0, 0, 0.025 * bounce); break;
    }
    case 'hold-on': rotate('head', -0.035); rotate('chest', -0.035); break;
    case 'crossed-arms': rotate('head', -0.025, 0, -sign * 0.035); rotate('chest', -0.025); break;
    case 'downcast': rotate('head', 0.26, 0, sign * 0.045); rotate('chest', 0.045); break;
    case 'hands-behind-back': {
      const sway = Math.sin(seconds * 1.35) * 0.035;
      rotate('chest', -0.025, 0, sway); rotate('spine', 0, 0, sway * 0.45);
      rotate('head', -0.015, 0, -sway * 0.35); break;
    }
    case 'hair-tuck': rotate('head', 0.025, -sign * 0.08, -sign * 0.08); break;
    case 'look-over-shoulder': rotate('head', 0.02, sign * 0.95); rotate('chest', 0, sign * 0.25); break;
    case 'fearful-glance': {
      const glance = Math.sin(seconds * Math.PI * 2 * 1.5);
      rotate('head', 0.045, glance * 0.64); rotate('chest', 0.04, glance * 0.045); break;
    }
    case 'curious-lean': rotate('head', -0.035, -sign * 0.035, sign * 0.12); rotate('chest', 0.1); rotate('spine', 0.035); break;
  }
  return pose;
}

export function npcGestureArmTargets(name, seconds, dims, hand = 'right', duration = NPC_GESTURES[name]?.duration) {
  const weight = npcGestureWeight(name, seconds, duration);
  if (!weight) return [];
  const side = hand === 'left' ? 'left' : 'right', sides = ['left', 'right'];
  const target = (key, anchor, offset, palm = 0, back = false) => ({
    side: key, anchor, offset, palm, weight,
    pole: [key === 'left' ? -1 : 1, -0.65, back ? -0.6 : 0.5],
  });
  const sign = key => key === 'left' ? -1 : 1;
  switch (name) {
    case 'hold-on':
      return sides.map(key => ({ ...target(key, 'chest', [sign(key) * dims.shoulderJointWidth * 0.65,
        -dims.upperArm * 0.12, dims.forearm * 1.35 + dims.girth.chest * 0.4]),
        palmPitch: Math.PI, pole: [sign(key) * 0.35, -0.9, -0.1] }));
    case 'crossed-arms':
      return sides.map(key => target(key, 'chest', [-sign(key) * dims.shoulderJointWidth * 0.4,
        -dims.upperArm * (key === 'left' ? 0.3 : 0.58), dims.girth.chest + dims.girth.elbow * 1.5], Math.PI));
    case 'hands-behind-back':
      return sides.map(key => target(key, 'chest', [-sign(key) * dims.shoulderJointWidth * 0.08,
        -dims.upperArm * (key === 'left' ? 0.95 : 1.08), -Math.max(dims.girth.chest, dims.girth.pelvis) * 1.7 - 0.04], 0, true));
    case 'hair-tuck': {
      const brush = Math.sin(Math.PI * Math.min(1, seconds / duration)) ** 2;
      return [target(side, 'head', [sign(side) * 0.26, 0.05 + brush * 0.05, 0.1 - brush * 0.15], -sign(side) * Math.PI / 2)];
    }
    default: return [];
  }
}

export function npcGestureChestBounce(name, seconds, duration, torsoLength) {
  const weight = name === 'laugh-bounce' ? npcGestureWeight(name, seconds, duration) : 0;
  return weight ? Math.abs(Math.sin(seconds * Math.PI * 2 * 3.2)) * weight * torsoLength * 0.035 : 0;
}
