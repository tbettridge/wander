import assert from 'node:assert/strict';
import {
  createAnimalFamily,
  createAnimalPhenotype,
  showcaseAnimalPhenotype,
} from '../src/animalpopulation.mjs';

function sequence(values, fallback = 0.5) {
  let index = 0;
  return () => values[index++] ?? fallback;
}

const smallBuck = createAnimalPhenotype('whitetail', { role: 'buck' }, sequence([0.05, 0.5]));
const largeBuck = createAnimalPhenotype('whitetail', { role: 'buck' }, sequence([0.95, 0.5]));
assert.ok(largeBuck.scale > smallBuck.scale, 'large buck did not gain body mass');
assert.ok(largeBuck.antlerScale > smallBuck.antlerScale, 'large buck did not gain a larger rack');
assert.ok(largeBuck.coatLightness < smallBuck.coatLightness, 'mature buck was not darker');
assert.equal(createAnimalPhenotype('whitetail', { role: 'doe' }, sequence([0.5, 0.5])).antlers,
  false, 'doe retained antlers');

const mooseFamily = createAnimalFamily('moose', sequence([
  0.8,       // cow branch
  0.5, 0.5,  // cow phenotype
  0.2, 0.2,  // calves present, two calves
  0.4, 0.5, 0.6, 0.5,
]));
assert.equal(mooseFamily.kind, 'cow-and-calves');
assert.deepEqual(mooseFamily.members.map((animal) => animal.role), ['cow', 'calf', 'calf']);
assert.ok(mooseFamily.members.slice(1).every((calf) => !calf.antlers && calf.scale < 0.7),
  'moose calves were not small and antlerless');
assert.ok(mooseFamily.members[1].coatLightness > mooseFamily.members[0].coatLightness,
  'moose calf was not lighter than its mother');

const foxFamily = createAnimalFamily('fox', sequence([
  0.5, 0.8,   // normal morph, female
  0.5, 0.5,   // vixen phenotype
  0.1, 0.4,   // puppies present, two puppies
  0.4, 0.5, 0.6, 0.5,
]));
assert.equal(foxFamily.kind, 'vixen-and-pups');
assert.deepEqual(foxFamily.members.map((animal) => animal.role), ['vixen', 'pup', 'pup']);
assert.ok(foxFamily.members.slice(1).every((pup) => pup.playfulPounces && pup.scale < 0.7),
  'fox puppies were not small playful pouncers');

const whiteFox = createAnimalFamily('fox', sequence([0.001, 0.2, 0.5, 0.5]));
const blackFox = createAnimalFamily('fox', sequence([0.008, 0.2, 0.5, 0.5]));
assert.equal(whiteFox.members[0].morph, 'white', 'rare white fox roll was lost');
assert.equal(blackFox.members[0].morph, 'black', 'rare black fox roll was lost');

assert.equal(showcaseAnimalPhenotype('moose').role, 'bull');
assert.equal(showcaseAnimalPhenotype('whitetail').role, 'buck');

console.log('animalpopulation PASS · sex/age families · correlated buck racks · rare fox morphs');
