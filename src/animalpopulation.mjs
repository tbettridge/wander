// Data-only wildlife demographics. Families and visible phenotypes are kept
// separate from Three.js so sex, age, rarity and correlated body/antler size
// remain deterministic and regression-testable.

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

// The coat colours a horse comes in, as the colour SYSTEM rather than a single
// hue: a horse's body, its points (mane, tail, lower legs) and its soft parts
// are three related colours, and which combination you get is the "colour" a
// horseman would name. Bay is a red body with black points; chestnut has no
// black on it anywhere; a grey is a dark skin under white hair.
export const HORSE_COLOURS = Object.freeze({
  bay: { coat: 0x7a4a2b, dark: 0x1d1714, light: 0x9c6337, cream: 0xcfae86 },
  chestnut: { coat: 0x8f4a22, dark: 0x6d3417, light: 0xb2683a, cream: 0xdcb388 },
  black: { coat: 0x241f1e, dark: 0x100d0d, light: 0x3b3331, cream: 0x6b5f59 },
  grey: { coat: 0xb9b4ad, dark: 0x8e8880, light: 0xd8d4cd, cream: 0xeeebe4 },
  palomino: { coat: 0xc09048, dark: 0xe8dcc0, light: 0xd7ab63, cream: 0xf3ead2 },
  dun: { coat: 0xa8895a, dark: 0x2b241d, light: 0xc4a878, cream: 0xdccdae },
});
const HORSE_COLOUR_NAMES = Object.freeze(Object.keys(HORSE_COLOURS));

/** Pick a coat colour. Bay and chestnut are much the commonest, as in life. */
export function rollHorseColour(rng = Math.random) {
  const roll = clamp(rng(), 0, 0.999999);
  if (roll < 0.30) return 'bay';
  if (roll < 0.54) return 'chestnut';
  if (roll < 0.70) return 'black';
  if (roll < 0.84) return 'grey';
  if (roll < 0.94) return 'dun';
  return 'palomino';
}

// White markings are inherited independently of coat colour, so they are rolled
// separately: a horse can be any colour with any combination of face and leg
// white. Roughly two in three carry something, which is about right.
export function rollHorseMarkings(rng = Math.random) {
  return {
    face: rng() < 0.46,     // a star running into a blaze
    socks: rng() < 0.42,    // white to the fetlock or the cannon
  };
}

export function createAnimalPhenotype(species, descriptor = {}, rng = Math.random) {
  const sizeRoll = clamp(rng(), 0, 0.999999);
  const coatRoll = clamp(rng(), 0, 0.999999);
  const role = descriptor.role || (
    species === 'whitetail' ? 'buck' : species === 'moose' ? 'bull'
      : species === 'horse' ? 'mare' : 'dog'
  );
  const juvenile = role === 'calf' || role === 'pup' || role === 'foal';
  const morph = descriptor.morph || 'normal';
  let scale = 1;
  let antlers = false;
  let antlerScale = 0;
  let coatLightness = (coatRoll - 0.5) * 0.045;
  let coatHue = (coatRoll - 0.5) * 0.022;
  let coatSaturation = 0;
  let markings = null;

  if (species === 'whitetail') {
    if (role === 'buck') {
      scale = 0.91 + sizeRoll * 0.17;
      antlers = true;
      // Body mass, coat darkness and rack size tell one consistent age story.
      antlerScale = 0.58 + sizeRoll * 0.68;
      coatLightness += 0.015 - sizeRoll * 0.095;
    } else {
      scale = 0.90 + sizeRoll * 0.09;
      coatLightness += 0.025;
    }
  } else if (species === 'moose') {
    if (role === 'bull') {
      scale = 0.97 + sizeRoll * 0.12;
      antlers = true;
      antlerScale = 0.88 + sizeRoll * 0.32;
      coatLightness -= 0.025 + sizeRoll * 0.035;
    } else if (role === 'calf') {
      scale = 0.58 + sizeRoll * 0.11;
      coatLightness += 0.13;
      coatSaturation += 0.035;
    } else {
      scale = 0.88 + sizeRoll * 0.10;
      coatLightness += 0.015;
    }
  } else if (species === 'horse') {
    // Colour is carried on `morph`, so the per-instance hue jitter that the
    // other species use has to be turned almost all the way down here: a grey
    // shifted 20 degrees around the wheel stops being a grey.
    coatHue *= 0.25;
    coatLightness *= 0.5;
    markings = descriptor.markings || rollHorseMarkings(rng);
    if (role === 'foal') {
      // Long-legged and short-bodied, the way foals are — the scale is uniform
      // so this reads mostly as "small", but small is most of it.
      scale = 0.62 + sizeRoll * 0.10;
      coatLightness += 0.06;
    } else if (role === 'stallion') {
      scale = 1.01 + sizeRoll * 0.09;
      coatSaturation += 0.02;
    } else {
      scale = 0.94 + sizeRoll * 0.08;
    }
  } else if (species === 'fox') {
    if (role === 'pup') {
      scale = 0.56 + sizeRoll * 0.12;
      coatLightness += 0.085;
      coatSaturation -= 0.035;
    } else if (role === 'vixen') {
      scale = 0.91 + sizeRoll * 0.09;
      coatLightness += 0.018;
    } else {
      scale = 0.98 + sizeRoll * 0.10;
      coatLightness -= 0.018;
      coatSaturation += 0.018;
    }
  }

  return Object.freeze({
    species,
    role,
    sex: descriptor.sex
      || (role === 'buck' || role === 'bull' || role === 'dog' || role === 'stallion' ? 'male' : 'female'),
    juvenile,
    morph,
    scale,
    antlers,
    antlerScale,
    coatHue,
    coatSaturation,
    coatLightness,
    markings,
    playfulPounces: role === 'pup',
  });
}

function member(species, role, morph, rng) {
  return createAnimalPhenotype(species, { role, morph }, rng);
}

export function createAnimalFamily(species, rng = Math.random) {
  if (species === 'moose') {
    if (rng() < 0.43) {
      return Object.freeze({ kind: 'solitary-bull', members: [member(species, 'bull', 'normal', rng)] });
    }
    const members = [member(species, 'cow', 'normal', rng)];
    if (rng() < 0.58) {
      const calfCount = rng() < 0.35 ? 2 : 1;
      for (let i = 0; i < calfCount; i++) members.push(member(species, 'calf', 'normal', rng));
    }
    return Object.freeze({ kind: members.length > 1 ? 'cow-and-calves' : 'solitary-cow', members });
  }

  if (species === 'whitetail') {
    if (rng() < 0.38) {
      const buckCount = rng() < 0.56 ? 1 : 2;
      const members = Array.from({ length: buckCount }, () => member(species, 'buck', 'normal', rng));
      return Object.freeze({ kind: buckCount > 1 ? 'bachelor-bucks' : 'solitary-buck', members });
    }
    const doeCount = rng() < 0.45 ? 3 : 2;
    const members = Array.from({ length: doeCount }, () => member(species, 'doe', 'normal', rng));
    return Object.freeze({ kind: 'doe-herd', members });
  }

  if (species === 'horse') {
    // A village's horses, not a wild band — and each is its OWN colour, because
    // they are individually owned animals rather than siblings.
    //
    // Two to four. At one-to-three a settlement often came out with a single
    // horse standing on its own, which reads as a stray rather than as the
    // animals belonging to the place.
    const count = rng() < 0.34 ? 2 : rng() < 0.76 ? 3 : 4;
    const members = [];
    for (let i = 0; i < count; i++) {
      const role = i === 0 && rng() < 0.34 ? 'stallion' : 'mare';
      members.push(member(species, role, rollHorseColour(rng), rng));
    }
    // A mare in company often has a foal at foot.
    if (count > 1 && rng() < 0.34) {
      members.push(member(species, 'foal', members[members.length - 1].morph, rng));
    }
    return Object.freeze({ kind: 'village-horses', members });
  }

  // Fox colour morphs are family genetics: about 0.6% white and 0.6% black.
  const morphRoll = rng();
  const morph = morphRoll < 0.006 ? 'white' : morphRoll < 0.012 ? 'black' : 'normal';
  const female = rng() >= 0.50;
  const members = [member(species, female ? 'vixen' : 'dog', morph, rng)];
  if (female && rng() < 0.32) {
    const pupCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < pupCount; i++) members.push(member(species, 'pup', morph, rng));
  }
  return Object.freeze({ kind: members.length > 1 ? 'vixen-and-pups' : female ? 'vixen' : 'dog-fox', members });
}

export function showcaseAnimalPhenotype(species) {
  const role = species === 'whitetail' ? 'buck' : species === 'moose' ? 'bull'
    : species === 'horse' ? 'stallion' : 'dog';
  const morph = species === 'horse' ? 'bay' : 'normal';
  return createAnimalPhenotype(species, { role, morph }, () => 0.5);
}
