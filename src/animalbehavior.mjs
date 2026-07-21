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

export function animalAwareness(distance, fleeDistance = 8, pauseDistance = 16) {
  if (distance < fleeDistance) return 'flee';
  if (distance < pauseDistance) return 'pause';
  return 'unconcerned';
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
