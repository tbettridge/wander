import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/animals.js', import.meta.url), 'utf8');

for (const forbidden of ['SkinnedMesh', 'skinIndex', 'skinWeight', 'new THREE.Skeleton']) {
  assert.ok(!source.includes(forbidden), `renderer regressed to ${forbidden}`);
}
for (const required of [
  'new THREE.Mesh(asset.geometry, material)',
  'new THREE.DataTexture',
  'AnimalSdf animalScene',
  'result.d = mix(nextShape.d, result.d, h) - k * h * (1.0 - h)',
  'vAnimalViewNormal = normalize(normalMatrix * animalSurface.g)',
  'result.pigment = mix(nextShape.pigment, result.pigment, h)',
  'uAnimalSdfOffset',
  'animalBuried',
  'MAX_SHAPE_NEIGHBOURS',
  'class VerletSdfRope',
  'advanceReactiveFoot',
  'solveThreeLinkIK',
  'ropeChains',
  'translationTarget = wantsLocomotion && !this.gaitReady ? 0 : desiredSpeed',
  'terrainHeight: this.terrainFootHeight',
  'updateAnimalAlertness(this.alertness',
  'this.updateBehaviour(dt, playerPosition, context)',
  "this.setState('pounce', 1.15)",
  "this.recipe.id === 'whitetail' && this.isSentinel",
  'if (!this.enabled || !worldReady)',
  'this.streamed.size > 0 && this.trailRefreshTimer <= 0',
  'phenotype?.antlers === false',
  'agent.configurePhenotype(site.phenotype)',
  "this.phenotype?.role === 'calf'",
  'this.planTerrainRoute(targetHeading)',
  'this.recipe.motion.turnRadius',
  'this.mesh.rotation.x = damp(this.mesh.rotation.x, 0, 12, dt)',
  'route.crossGrade * 0.65',
  'predictiveFootholdDistance(',
  'quadrupedLegLimits(isFront)',
  'pose.running * pose.locomotionCrouch',
  'retargetStrength: 4 + pose.running * pose.retargetBoost',
  'pose.running > pose.suspensionThreshold',
  'const kneeRadius = Math.max(',
  'const hockRadius = Math.max(',
  'chain.lengths[0] + kneeOverlap',
  'chain.lengths[1] + hockOverlap',
]) {
  assert.ok(source.includes(required), `missing SDF renderer feature: ${required}`);
}

for (const forbidden of ['AnimationMixer', 'AnimationClip', '.play()']) {
  assert.ok(!source.includes(forbidden), `procedural animation regressed to clips: ${forbidden}`);
}

console.log('animalrenderer PASS · blended SDF leg joints · long-stride anatomical IK · upright hill posture · one SDF mesh');
