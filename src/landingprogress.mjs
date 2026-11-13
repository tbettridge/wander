// What the landing page says while the world is made or opened. The loading
// code reports itself in the status line (hydrologypreview.mjs, main.js,
// courierruntime.js); this turns those messages into a stage, how far through
// the whole load that is, and a line a player can read.

/** Stages in load order, each with the share of the bar it fills. */
export const LANDING_STAGES = Object.freeze([
  { id: 'start', from: 0, to: 0.03, label: 'Starting up' },
  { id: 'water', from: 0.03, to: 0.56, label: 'Laying out rivers, lakes and valleys' },
  { id: 'joining', from: 0.56, to: 0.6, label: 'Joining the rivers to the hills' },
  { id: 'shore', from: 0.6, to: 0.64, label: 'Finding dry ground to stand on' },
  { id: 'terrain', from: 0.64, to: 0.84, label: 'Raising the land and planting the woods' },
  { id: 'shaders', from: 0.84, to: 0.9, label: 'Mixing the light and colour' },
  { id: 'courier', from: 0.9, to: 0.97, label: 'Sorting the post: villages, people and roads' },
  { id: 'starting-place', from: 0.97, to: 0.995, label: 'Choosing where your round begins' },
  { id: 'ready', from: 1, to: 1, label: 'Ready' },
]);
const STAGE = new Map(LANDING_STAGES.map(stage => [stage.id, stage]));

/**
 * Read one status message. Returns `{ stage, fraction, label, error, cached }`:
 * `fraction` is how far through the whole load it is (0–1), `cached` is true
 * or false when the message says whether the landscape was restored or made.
 */
export function landingStage(message, { shadersAtStart = null } = {}) {
  const text = String(message || '').trim();
  const at = (id, within = 0, label = null) => {
    const stage = STAGE.get(id);
    return { stage: id, fraction: stage.from + (stage.to - stage.from) * Math.max(0, Math.min(1, within)), label: label || stage.label, error: false, cached: null };
  };
  if (!text) return at('start');
  if (/could not|unavailable|failed|reload to retry/i.test(text)) return { stage: 'error', fraction: null, label: text, error: true, cached: null };
  if (/^ready\b/i.test(text)) return at('ready');
  const water = text.match(/^(Creating|Restoring) your landscape… (\d+) of (\d+) surrounding areas prepared/i);
  if (water) {
    const done = Number(water[2]), total = Math.max(1, Number(water[3]));
    return { ...at('water', done / total, STAGE.get('water').label + ' · ' + done + ' of ' + total), cached: /restoring/i.test(water[1]) ? true : done >= 3 ? false : null };
  }
  if (/^(Creating|Restoring) your landscape/i.test(text)) return at('water', 0);
  if (/^Joining rivers and lakes/i.test(text)) return at('joining', 0.5);
  const shore = text.match(/lakeshore… (\d+) of (\d+)/i);
  if (shore) return at('shore', Number(shore[1]) / Math.max(1, Number(shore[2])));
  if (/lake ?shore|around your lake|dry ground/i.test(text)) return at('shore', 0.3);
  // The page's own placeholder, before any loading code has spoken.
  if (/^generating terrain/i.test(text)) return at('start', 0.5);
  if (/^Preparing terrain/i.test(text)) return at('terrain', 0);
  const shaders = text.match(/^Preparing shaders… (\d+) left/i);
  if (shaders) {
    const left = Number(shaders[1]), first = Math.max(left, shadersAtStart || left);
    return at('shaders', first ? 1 - left / first : 1);
  }
  if (/courier communities|their roads/i.test(text)) return at('courier', 0.2);
  if (/courier starting place/i.test(text)) return at('starting-place', 0.3);
  return at('terrain', 0.5, null);
}

/**
 * Where the bar should stand `seconds` into a stage that has not reported
 * again: it keeps creeping toward the end of the stage, ever more slowly, so
 * a long step never looks frozen and never claims to be done.
 */
export function landingCreep(reading, seconds) {
  const stage = STAGE.get(reading?.stage);
  if (!stage || reading.stage === 'ready') return reading?.fraction ?? 0;
  const room = Math.max(0, stage.to - reading.fraction);
  return reading.fraction + room * 0.85 * (1 - Math.exp(-Math.max(0, seconds) / 25));
}

/** The words for the card: a world made for the first time, or one opened from this device. */
export function landingCopy({ firstBuild, courierMode = true }) {
  if (firstBuild) return {
    title: 'Creating your world',
    note: '<strong>This happens only once.</strong> Wander is building this countryside on your device: its rivers, lakes, villages and the roads between them. The first time takes a minute or two. After that it is saved here, and '
      + (courierMode ? 'your round' : 'your world') + ' opens much faster.',
  };
  return { title: 'Opening your world', note: 'Your world is saved on this device, so it opens much faster than the first time.' };
}

/** 83 → "1:23". */
export function landingElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
