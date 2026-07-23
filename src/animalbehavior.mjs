// Data-only wildlife steering helpers. Keeping route scoring independent from
// Three.js makes the behaviour deterministic and inexpensive to test.

const TAU = Math.PI * 2;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// Compatibility for tabs that still hold the previous animals.js module in
// memory while this data-only helper has refreshed. The live planner below no
// longer uses hard distance bands, but retaining this tiny export prevents a
// mixed ES-module cache from aborting the entire game during development.
export function animalAwareness(distance, fleeDistance = 8, pauseDistance = 16) {
  if (distance < fleeDistance) return 'flee';
  if (distance < pauseDistance) return 'pause';
  return 'unconcerned';
}

// Awareness is deliberately continuous. A hard distance switch made animals
// forget the player the instant they crossed a radius and could alternate
// between grazing and flight at the boundary. Perception raises this value;
// remembered danger and calm surroundings let it drain at different rates.
export function updateAnimalAlertness(current, {
  dt = 0,
  distance = Infinity,
  sightRange = 42,
  visible = false,
  inView = false,
  playerSpeed = 0,
  groupAlarm = 0,
  memory = 0,
  sensitivity = 1,
} = {}) {
  const safeDt = clamp(dt, 0, 0.5);
  const sight = visible && distance < sightRange
    ? smooth01(1 - distance / sightRange) * (inView ? 1 : 0.38)
    : 0;
  // Quiet walking is only audible nearby; sprinting or landing from a debug
  // teleport carries farther. Cap the speed contribution so a bad frame cannot
  // globally alarm wildlife.
  const audibleSpeed = clamp(playerSpeed, 0, 8);
  const hearingRange = 5 + audibleSpeed * 4.2;
  const hearing = distance < hearingRange
    ? smooth01(1 - distance / Math.max(hearingRange, 0.01))
      * smooth01((audibleSpeed - 0.12) / 2.8)
    : 0;
  let stimulus = clamp(Math.max(sight, hearing * 0.86, groupAlarm), 0, 1);
  // A clearly visible close approach should provoke escape within one planning
  // tick rather than requiring the animal to politely wait for the meter.
  if (visible && distance < 7.5) stimulus = 1;

  const target = clamp(stimulus * sensitivity, 0, 1);
  const rising = target > current;
  const rate = rising
    ? 3.8 + target * 2.2
    : (memory > 0 ? 0.075 : 0.20);
  const next = current + (target - current) * (1 - Math.exp(-rate * safeDt));
  return clamp(next, 0, 1);
}

export function alertnessStage(alertness) {
  if (alertness >= 0.72) return 'escape';
  if (alertness >= 0.43) return 'alert';
  if (alertness >= 0.18) return 'suspicious';
  return 'calm';
}

// Context goals are selected from needs plus a small temperament jitter. This
// helper is data-only so goal ordering remains deterministic and testable even
// though the expensive terrain/site search stays in animals.js.
export function chooseAnimalGoal(weights, randomValue = 0.5) {
  const entries = Object.entries(weights || {}).filter(([, value]) => value > 0);
  if (!entries.length) return 'home';
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let cursor = clamp(randomValue, 0, 0.999999) * total;
  for (const [name, value] of entries) {
    cursor -= value;
    if (cursor <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

export function terrainSpeedScale(grade) {
  // Full speed on gentle ground, then a strong falloff beyond roughly 10%.
  // Absolute grade treats steep descents as cautiously as steep climbs.
  return 1 - smooth01((Math.abs(grade) - 0.10) / 0.25) * 0.62;
}

export function turnSpeedScale(turnAngle) {
  return 1 - smooth01((Math.abs(turnAngle) - 0.45) / 2.35) * 0.56;
}

export function arcTurnRate(speed, authoredTurnRate, minimumRadius) {
  if (speed <= 0 || authoredTurnRate <= 0 || minimumRadius <= 0) return 0;
  return Math.min(authoredTurnRate, speed / minimumRadius);
}

// Select a locally reachable heading rather than a complete global path. The
// animal considers a fan of forward arcs and heavily penalizes the maximum and
// mean grade along each arc. Repeating this at a low frequency produces smooth
// contour-following paths without a navmesh or per-frame search.
export function chooseTerrainHeading({
  x,
  z,
  currentHeading,
  targetHeading,
  lookAhead = 8,
  sampleHeight,
  traversable = null,
  turnPreference = 1,
}) {
  const maxArc = 1.12;
  const targetOffset = clamp(angleDelta(currentHeading, targetHeading), -maxArc, maxArc);
  const offsets = [-maxArc, -0.74, -0.37, 0, 0.37, 0.74, maxArc, targetOffset];
  const fractions = [0.28, 0.60, 1];
  const originHeight = sampleHeight(x, z);
  const gradientProbe = Math.min(1.5, Math.max(0.7, lookAhead * 0.14));
  const gradientX = (
    sampleHeight(x + gradientProbe, z) - sampleHeight(x - gradientProbe, z)
  ) / (gradientProbe * 2);
  const gradientZ = (
    sampleHeight(x, z + gradientProbe) - sampleHeight(x, z - gradientProbe)
  ) / (gradientProbe * 2);
  const slopeMagnitude = Math.hypot(gradientX, gradientZ);
  const directDelta = angleDelta(currentHeading, targetHeading);
  let best = null;

  for (let candidateIndex = 0; candidateIndex < offsets.length; candidateIndex++) {
    const offset = offsets[candidateIndex];
    // Ignore duplicate fan rays, including a target ray that matches a preset.
    if (offsets.findIndex((value) => Math.abs(value - offset) < 1e-4) !== candidateIndex) continue;
    const heading = currentHeading + offset;
    let previousDistance = 0;
    let previousHeight = originHeight;
    let gradeSum = 0;
    let maxGrade = 0;
    let safe = true;

    for (const fraction of fractions) {
      const distance = lookAhead * fraction;
      const sampleX = x + Math.sin(heading) * distance;
      const sampleZ = z + Math.cos(heading) * distance;
      const height = sampleHeight(sampleX, sampleZ);
      const segmentGrade = Math.abs(height - previousHeight)
        / Math.max(0.01, distance - previousDistance);
      gradeSum += segmentGrade;
      maxGrade = Math.max(maxGrade, segmentGrade);
      // Grade is sampled along the arc; the more expensive water/land test is
      // only needed at its endpoint.
      if (traversable && fraction >= 1 && !traversable(sampleX, sampleZ)) safe = false;
      previousDistance = distance;
      previousHeight = height;
    }

    const meanGrade = gradeSum / fractions.length;
    const alignment = Math.cos(angleDelta(heading, targetHeading));
    const forwardX = Math.sin(heading), forwardZ = Math.cos(heading);
    const directionalGrade = Math.abs(gradientX * forwardX + gradientZ * forwardZ);
    const crossGrade = Math.abs(gradientX * forwardZ - gradientZ * forwardX);
    const fallLineRatio = slopeMagnitude > 1e-4 ? directionalGrade / slopeMagnitude : 0;
    // On meaningful slopes prefer an oblique traverse: about 25 degrees off
    // the contour (65 degrees off the fall line). Pure contour travel forces
    // maximum left/right leg disparity; the fall line creates maximum climb or
    // descent. The middle ground is the anatomically stable choice.
    const traversePenalty = slopeMagnitude > 0.08
      ? Math.abs(fallLineRatio - 0.42) * slopeMagnitude * 38
      : 0;
    const reversing = Math.abs(directDelta) > Math.PI * 0.72;
    const preferredSide = reversing ? Math.sign(offset || turnPreference) * turnPreference * 0.12 : 0;
    const score = alignment * 3.2
      - meanGrade * 12
      - maxGrade * 18
      - traversePenalty
      - Math.abs(offset) * 0.18
      + preferredSide
      - (safe ? 0 : 100);
    if (!best || score > best.score) {
      best = {
        heading: ((heading % TAU) + TAU) % TAU,
        grade: maxGrade,
        meanGrade,
        crossGrade,
        directionalGrade,
        fallLineRatio,
        slopeMagnitude,
        safe,
        score,
      };
    }
  }

  return best || {
    heading: ((currentHeading % TAU) + TAU) % TAU,
    grade: Infinity,
    meanGrade: Infinity,
    crossGrade: Infinity,
    directionalGrade: Infinity,
    fallLineRatio: 0,
    slopeMagnitude,
    safe: false,
    score: -Infinity,
  };
}
