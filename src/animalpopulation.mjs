// Data-only wildlife demographics. Families and visible phenotypes are kept
// separate from Three.js so sex, age, rarity and correlated body/antler size
// remain deterministic and regression-testable.

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function createAnimalPhenotype(species, descriptor = {}, rng = Math.random) {
  const sizeRoll = clamp(rng(), 0, 0.999999);
  const coatRoll = clamp(rng(), 0, 0.999999);
  const role = descriptor.role || (
    species === 'whitetail' ? 'buck' : species === 'moose' ? 'bull' : 'dog'
  );
  const juvenile = role === 'calf' || role === 'pup';
  const morph = descriptor.morph || 'normal';
  let scale = 1;
  let antlers = false;
  let antlerScale = 0;
  let coatLightness = (coatRoll - 0.5) * 0.045;
  let coatHue = (coatRoll - 0.5) * 0.022;
  let coatSaturation = 0;

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
    sex: descriptor.sex || (role === 'buck' || role === 'bull' || role === 'dog' ? 'male' : 'female'),
    juvenile,
    morph,
    scale,
    antlers,
    antlerScale,
    coatHue,
    coatSaturation,
    coatLightness,
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
  const role = species === 'whitetail' ? 'buck' : species === 'moose' ? 'bull' : 'dog';
  return createAnimalPhenotype(species, { role }, () => 0.5);
}
