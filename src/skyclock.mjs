// The game clock's pace, kept THREE-free so anything that needs to say what
// time it will be (a station keeper reading the timetable, a test) advances
// time exactly as sky.js does.

// Seconds for 24 game hours at the daytime rate: about 15.6 real minutes of daylight.
export const SKY_DAY_LENGTH = 1867;
// Night passes faster: enough to enjoy the stars, not enough to get lost.
export const SKY_NIGHT_RATE = 5.83;
const NIGHT_ELEVATION = -0.06;

export function skySunElevation(time = 0) {
  return Math.sin((time - 0.25) * Math.PI * 2);
}

/** How many game seconds pass per real second at this time of day. */
export function skyClockRate(time = 0) {
  return skySunElevation(time) < NIGHT_ELEVATION ? SKY_NIGHT_RATE : 1;
}

/**
 * Advance an unwrapped day fraction (0.5 is noon today, 1.25 is six tomorrow
 * morning) by `seconds` of real time, in steps no longer than `step`.
 */
export function skyTimeAfter(time, seconds, step = 1) {
  let t = Number(time) || 0;
  let left = Math.max(0, Number(seconds) || 0);
  while (left > 0) {
    const dt = Math.min(step, left);
    t += (dt * skyClockRate(t)) / SKY_DAY_LENGTH;
    left -= dt;
  }
  return t;
}
