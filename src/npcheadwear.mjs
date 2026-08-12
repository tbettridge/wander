// Where hair sits on a head, and how much of it a hat covers.
//
// The renderer builds these as primitives; the numbers live here because two
// separate builders have to agree about them. A hat authored without knowing
// how wide the hair underneath it is will be too small, and the hair will push
// out through its side — which is exactly what happened when hair and hats
// stopped sharing a slot and became independent layers.
//
// Head-local units, matching the head group the meshes are parented to: the
// skull is an ellipsoid of 0.235 x 0.255 x 0.220 centred on the origin.

export const NPC_SKULL_RADII = Object.freeze([0.235, 0.255, 0.220]);

/**
 * Each hair style's crown, as an ellipsoid.
 *
 * Every one is wider than the skull it sits on, which is what makes it read as
 * hair rather than as a painted scalp — and is also why no hat crown authored
 * to skull width can contain one.
 */
export const HAIR_SHELLS = Object.freeze({
  crop: Object.freeze({ centre: [0, 0.125, -0.045], radii: [0.245, 0.15, 0.21] }),
  bob: Object.freeze({ centre: [0, 0.015, -0.07], radii: [0.27, 0.29, 0.21] }),
  bun: Object.freeze({ centre: [0, 0.08, -0.14], radii: [0.25, 0.25, 0.19] }),
  braid: Object.freeze({ centre: [0, 0.06, -0.09], radii: [0.26, 0.26, 0.21] }),
  long: Object.freeze({ centre: [0, 0.02, -0.06], radii: [0.275, 0.30, 0.225] }),
});

/**
 * The height each hat sits at.
 *
 * Above this line the hat owns the head and no hair may appear. Below it, hair
 * showing is the entire point — it is what stops a hat reading as a helmet.
 */
export const HAT_RIM = Object.freeze({ cap: 0.135, brim: 0.150, kerchief: 0.045 });

/**
 * The hair crown, cut off at the hat's rim.
 *
 * Growing a hat until it swallowed a whole hair shell would have meant absurd
 * hats: the shells are 0.245–0.275 across at their widest and a hat has to
 * meet the head somewhere. So the shell is squashed instead. Its underside
 * stays exactly where it was — that is the hair you are meant to see — and its
 * top comes down to the rim. What emerges below the hat is unchanged; what used
 * to emerge through the hat no longer exists.
 *
 * A bare head, or hair already shorter than the rim, is returned untouched.
 */
export function tuckedHairShell(style, hat) {
  const shell = HAIR_SHELLS[style];
  if (!shell) return null;
  const rim = HAT_RIM[hat];
  if (rim === undefined) return shell;
  const bottom = shell.centre[1] - shell.radii[1];
  if (shell.centre[1] + shell.radii[1] <= rim) return shell;
  const radiusY = Math.max(0.02, (rim - bottom) * 0.5);
  return Object.freeze({
    centre: Object.freeze([shell.centre[0], bottom + radiusY, shell.centre[2]]),
    radii: Object.freeze([shell.radii[0], radiusY, shell.radii[2]]),
  });
}

/** Where a bun's knot goes: high on a bare head, at the nape under a hat. */
export function bunKnotHeight(hat) {
  const rim = HAT_RIM[hat];
  return rim === undefined ? 0.22 : Math.min(0.22, rim - 0.14);
}

/** An ellipsoid's horizontal radii at height `y`, or null where it has ended. */
export function shellRadiiAt(shell, y) {
  const t = (y - shell.centre[1]) / shell.radii[1];
  if (Math.abs(t) >= 1) return null;
  const factor = Math.sqrt(1 - t * t);
  return [shell.radii[0] * factor, shell.radii[2] * factor];
}

/** The highest point of a shell. */
export function shellTop(shell) {
  return shell.centre[1] + shell.radii[1];
}
