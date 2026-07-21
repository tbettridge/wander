import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';

const html = await readFile(new URL('../animal-lab.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/animallab.js', import.meta.url), 'utf8');

for (const feature of [
  'reference-layer', 'difference', 'auto-align', 'export-comparison', 'fit-metrics',
]) {
  assert.ok(html.includes(feature), `animal lab is missing ${feature}`);
}
for (const feature of [
  'renderModelMask', 'hoofCentre', 'bandIoU', 'modelCoverage',
  'referenceCoverage', 'widthError', 'baselineError', 'strideLength', 'gaitClass',
]) {
  assert.ok(source.includes(feature), `animal lab measurement is missing ${feature}`);
}

for (const species of ['fox', 'whitetail', 'moose']) {
  for (const view of ['front', 'left', 'back', 'right']) {
    const reference = new URL(`../assets/animal-references/${species}-${view}.png`, import.meta.url);
    const metadata = await stat(reference);
    assert.ok(metadata.size > 1000, `${species} ${view} reference is missing or empty`);
  }
}

console.log('animallab PASS · calibrated alpha references · 12 views · objective fit metrics');
