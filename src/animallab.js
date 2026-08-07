import * as THREE from 'three';
import { AnimalSystem } from './animals.js?v=5';
import { ANIMAL_RECIPES, neckReach } from './animaldata.mjs';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const referenceLayer = document.querySelector('#reference-layer');
const referenceContext = referenceLayer.getContext('2d', { willReadFrequently: true });
const referenceRaster = document.createElement('canvas');
const referenceRasterContext = referenceRaster.getContext('2d', { willReadFrequently: true });
const exportCanvas = document.createElement('canvas');
const exportContext = exportCanvas.getContext('2d');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9d2c2);
scene.fog = new THREE.Fog(0xd9d2c2, 18, 28);
const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 40);

scene.add(new THREE.HemisphereLight(0xfff4dd, 0x6d746b, 2.0));
const sun = new THREE.DirectionalLight(0xffe0b2, 3.0);
sun.position.set(-5, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -5;
sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5;
sun.shadow.camera.bottom = -5;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200, 100, 100),
  new THREE.MeshStandardMaterial({ color: 0xb6b09f, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.004;
ground.receiveShadow = true;
scene.add(ground);

const labParams = new URLSearchParams(window.location.search);
document.body.classList.toggle('clean', labParams.has('clean'));
const animationPreview = {
  enabled: labParams.has('animate'),
  uneven: labParams.has('terrain'),
  speed: Number(labParams.get('motionSpeed') || 0.32),
  lastTime: performance.now(),
};
function previewTerrainHeight(x, z) {
  if (!animationPreview.uneven) return 0;
  return Math.sin(x * 1.35) * 0.065 + Math.sin(z * 0.72 + x * 0.35) * 0.085;
}
function updatePreviewGround() {
  const positions = ground.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setZ(i, previewTerrainHeight(positions.getX(i), -positions.getY(i)));
  }
  positions.needsUpdate = true;
  ground.geometry.computeVertexNormals();
}
updatePreviewGround();

const flatWorld = {
  seed: 20260720,
  height: previewTerrainHeight,
  biomeAt: () => ({ id: 'grassland', h: 1, slope: 0 }),
  riverAt: () => ({ wet: false, depth: 0 }),
};
const animals = new AnimalSystem(scene, flatWorld);
animals.populateNear(new THREE.Vector3());

let species = labParams.get('species') || 'fox';
let view = labParams.get('view') || 'left';
let selected = null;
const distantPlayer = new THREE.Vector3(1000, 0, 1000);
const referenceImage = new Image();
referenceImage.decoding = 'async';
const comparison = {
  mode: labParams.get('mode') || (labParams.has('clean') ? 'model' : 'overlay'),
  opacity: Number(labParams.get('opacity') || 0.52),
  offsetX: Number(labParams.get('x') || 0),
  offsetY: Number(labParams.get('y') || 0),
  scale: Number(labParams.get('scale') || 1),
  guides: !labParams.has('clean'),
  metrics: null,
  alignment: null,
};
let referenceReady = false;
let analysisDirty = true;
let analysisWidth = 1;
let analysisHeight = 1;
let modelMask = new Uint8Array(1);
let alignedReferenceMask = new Uint8Array(1);
let silhouettePixels = new Uint8Array(4);
const silhouetteMaterials = new WeakMap();
const silhouetteTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthBuffer: true,
  stencilBuffer: false,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
});

const cameraDirections = {
  front: [0, 0, 1],
  left: [1, 0, 0],
  back: [0, 0, -1],
  right: [-1, 0, 0],
};

function resizeAnalysisBuffers() {
  analysisWidth = Math.max(1, Math.round(window.innerWidth));
  analysisHeight = Math.max(1, Math.round(window.innerHeight));
  referenceLayer.width = analysisWidth;
  referenceLayer.height = analysisHeight;
  referenceLayer.style.width = `${analysisWidth}px`;
  referenceLayer.style.height = `${analysisHeight}px`;
  silhouetteTarget.setSize(analysisWidth, analysisHeight);
  silhouettePixels = new Uint8Array(analysisWidth * analysisHeight * 4);
  modelMask = new Uint8Array(analysisWidth * analysisHeight);
  alignedReferenceMask = new Uint8Array(analysisWidth * analysisHeight);
  analysisDirty = true;
}

function maskBounds(mask, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : {
    left, top, right: right + 1, bottom: bottom + 1,
    width: right - left + 1, height: bottom - top + 1,
  };
}

function hoofCentre(mask, width, bounds) {
  const bandTop = bounds.bottom - Math.max(4, Math.round(bounds.height * 0.075));
  let sum = 0;
  let count = 0;
  for (let y = bandTop; y < bounds.bottom; y++) {
    const row = y * width;
    for (let x = bounds.left; x < bounds.right; x++) {
      if (!mask[row + x]) continue;
      sum += x;
      count++;
    }
  }
  return count ? sum / count : (bounds.left + bounds.right) * 0.5;
}

function silhouetteMaterialFor(agent) {
  if (silhouetteMaterials.has(agent.mesh)) return silhouetteMaterials.get(agent.mesh);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  material.name = `${agent.recipe.id}-lab-silhouette`;
  material.onBeforeCompile = (shader) => agent.material.userData.injectVertexProjection(shader);
  material.customProgramCacheKey = () => `wander-animal-lab-silhouette-${agent.recipe.id}`;
  silhouetteMaterials.set(agent.mesh, material);
  return material;
}

function renderModelMask() {
  const previousTarget = renderer.getRenderTarget();
  const previousBackground = scene.background;
  const groundWasVisible = ground.visible;
  const previousMaterial = selected.mesh.material;
  scene.background = new THREE.Color(0x000000);
  ground.visible = false;
  selected.mesh.material = silhouetteMaterialFor(selected);
  renderer.setRenderTarget(silhouetteTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(
    silhouetteTarget, 0, 0, analysisWidth, analysisHeight, silhouettePixels,
  );
  renderer.setRenderTarget(previousTarget);
  scene.background = previousBackground;
  ground.visible = groundWasVisible;
  selected.mesh.material = previousMaterial;

  modelMask.fill(0);
  for (let sourceY = 0; sourceY < analysisHeight; sourceY++) {
    const targetY = analysisHeight - sourceY - 1;
    for (let x = 0; x < analysisWidth; x++) {
      const source = (sourceY * analysisWidth + x) * 4;
      if (silhouettePixels[source] > 127) modelMask[targetY * analysisWidth + x] = 1;
    }
  }
  return maskBounds(modelMask, analysisWidth, analysisHeight);
}

function rasterizeReference(modelBounds) {
  const scale = (modelBounds.height / referenceImage.naturalHeight) * comparison.scale;
  const width = Math.max(1, Math.round(referenceImage.naturalWidth * scale));
  const height = Math.max(1, Math.round(referenceImage.naturalHeight * scale));
  referenceRaster.width = width;
  referenceRaster.height = height;
  referenceRasterContext.clearRect(0, 0, width, height);
  referenceRasterContext.imageSmoothingEnabled = true;
  referenceRasterContext.imageSmoothingQuality = 'high';
  referenceRasterContext.drawImage(referenceImage, 0, 0, width, height);
  const rgba = referenceRasterContext.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] > 80 ? 1 : 0;
  const bounds = maskBounds(mask, width, height);
  return { width, height, mask, bounds, scale };
}

function bandIoU(top, bottom) {
  let intersection = 0;
  let union = 0;
  for (let y = top; y < bottom; y++) {
    const row = y * analysisWidth;
    for (let x = 0; x < analysisWidth; x++) {
      const model = modelMask[row + x];
      const reference = alignedReferenceMask[row + x];
      if (model && reference) intersection++;
      if (model || reference) union++;
    }
  }
  return union ? intersection / union : 0;
}

function calculateMetrics(modelBounds, reference) {
  const referenceFoot = hoofCentre(reference.mask, reference.width, reference.bounds);
  const modelFoot = hoofCentre(modelMask, analysisWidth, modelBounds);
  const x = Math.round(modelFoot - referenceFoot + comparison.offsetX);
  const y = Math.round(modelBounds.bottom - reference.height + comparison.offsetY);
  alignedReferenceMask.fill(0);
  let referenceCount = 0;
  for (let sourceY = 0; sourceY < reference.height; sourceY++) {
    const targetY = sourceY + y;
    if (targetY < 0 || targetY >= analysisHeight) continue;
    for (let sourceX = 0; sourceX < reference.width; sourceX++) {
      if (!reference.mask[sourceY * reference.width + sourceX]) continue;
      const targetX = sourceX + x;
      if (targetX < 0 || targetX >= analysisWidth) continue;
      alignedReferenceMask[targetY * analysisWidth + targetX] = 1;
      referenceCount++;
    }
  }

  let modelCount = 0;
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < modelMask.length; i++) {
    const model = modelMask[i];
    const referencePixel = alignedReferenceMask[i];
    if (model) modelCount++;
    if (model && referencePixel) intersection++;
    if (model || referencePixel) union++;
  }
  const upperEnd = Math.round(modelBounds.top + modelBounds.height * 0.34);
  const bodyEnd = Math.round(modelBounds.top + modelBounds.height * 0.64);
  const referenceBounds = maskBounds(alignedReferenceMask, analysisWidth, analysisHeight);
  const metrics = {
    iou: intersection / Math.max(1, union),
    modelCoverage: intersection / Math.max(1, modelCount),
    referenceCoverage: intersection / Math.max(1, referenceCount),
    upper: bandIoU(modelBounds.top, upperEnd),
    body: bandIoU(upperEnd, bodyEnd),
    legs: bandIoU(bodyEnd, modelBounds.bottom),
    widthError: referenceBounds
      ? (modelBounds.width / Math.max(1, referenceBounds.width) - 1) : 0,
    baselineError: referenceBounds ? referenceBounds.bottom - modelBounds.bottom : 0,
  };
  comparison.alignment = { x, y, width: reference.width, height: reference.height, modelBounds, referenceBounds };
  comparison.metrics = metrics;
  return metrics;
}

function drawDifference() {
  const image = referenceContext.createImageData(analysisWidth, analysisHeight);
  const pixels = image.data;
  for (let i = 0; i < modelMask.length; i++) {
    const model = modelMask[i];
    const reference = alignedReferenceMask[i];
    if (!model && !reference) continue;
    const p = i * 4;
    if (model && reference) {
      pixels[p] = 42; pixels[p + 1] = 42; pixels[p + 2] = 48; pixels[p + 3] = 175;
    } else if (model) {
      pixels[p] = 20; pixels[p + 1] = 190; pixels[p + 2] = 210; pixels[p + 3] = 190;
    } else {
      pixels[p] = 225; pixels[p + 1] = 65; pixels[p + 2] = 70; pixels[p + 3] = 190;
    }
  }
  referenceContext.putImageData(image, 0, 0);
}

function drawGuides() {
  const { modelBounds, referenceBounds } = comparison.alignment || {};
  if (!modelBounds || !referenceBounds) return;
  referenceContext.save();
  referenceContext.lineWidth = 1;
  referenceContext.setLineDash([6, 5]);
  referenceContext.strokeStyle = 'rgba(20,190,210,.85)';
  referenceContext.strokeRect(modelBounds.left + 0.5, modelBounds.top + 0.5,
    modelBounds.width, modelBounds.height);
  referenceContext.strokeStyle = 'rgba(225,65,70,.85)';
  referenceContext.strokeRect(referenceBounds.left + 0.5, referenceBounds.top + 0.5,
    referenceBounds.width, referenceBounds.height);
  referenceContext.setLineDash([]);
  referenceContext.strokeStyle = 'rgba(255,220,120,.78)';
  referenceContext.beginPath();
  referenceContext.moveTo(0, modelBounds.bottom + 0.5);
  referenceContext.lineTo(analysisWidth, modelBounds.bottom + 0.5);
  referenceContext.stroke();
  referenceContext.strokeStyle = 'rgba(255,255,255,.28)';
  for (const fraction of [0.34, 0.64]) {
    const y = modelBounds.top + modelBounds.height * fraction;
    referenceContext.beginPath();
    referenceContext.moveTo(modelBounds.left, y);
    referenceContext.lineTo(modelBounds.right, y);
    referenceContext.stroke();
  }
  referenceContext.restore();
}

function renderMetrics(metrics) {
  const entries = [
    ['overlap', metrics.iou],
    ['model fit', metrics.modelCoverage],
    ['ref fit', metrics.referenceCoverage],
    ['upper', metrics.upper],
    ['body', metrics.body],
    ['legs', metrics.legs],
  ];
  document.querySelector('#fit-metrics').innerHTML = entries.map(([label, value]) => (
    `<div class="metric"><b>${Math.round(value * 100)}%</b><span>${label}</span></div>`
  )).join('');
  const width = `${metrics.widthError >= 0 ? '+' : ''}${(metrics.widthError * 100).toFixed(1)}%`;
  document.querySelector('#fit-status').textContent = `Width error ${width} · baseline ${metrics.baselineError >= 0 ? '+' : ''}${metrics.baselineError}px · arrows nudge reference`;
}

function measureAndDraw() {
  if (!selected || !referenceReady) return;
  const modelBounds = renderModelMask();
  if (!modelBounds) return;
  const reference = rasterizeReference(modelBounds);
  const metrics = calculateMetrics(modelBounds, reference);
  referenceContext.clearRect(0, 0, analysisWidth, analysisHeight);
  const { x, y, width, height } = comparison.alignment;
  if (comparison.mode === 'overlay' || comparison.mode === 'reference') {
    if (comparison.mode === 'reference') {
      referenceContext.fillStyle = 'rgba(217,210,194,.88)';
      referenceContext.fillRect(0, 0, analysisWidth, analysisHeight);
    }
    referenceContext.globalAlpha = comparison.mode === 'reference' ? 1 : comparison.opacity;
    referenceContext.drawImage(referenceImage, x, y, width, height);
    referenceContext.globalAlpha = 1;
  } else if (comparison.mode === 'difference') {
    drawDifference();
  }
  if (comparison.guides && comparison.mode !== 'model') drawGuides();
  renderMetrics(metrics);
}

function setMode(mode) {
  comparison.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  analysisDirty = true;
}

function setControl(id, key, formatter) {
  const input = document.querySelector(`#${id}`);
  const output = document.querySelector(`#${id}-value`);
  input.value = comparison[key];
  const update = () => {
    comparison[key] = Number(input.value);
    output.textContent = formatter(comparison[key]);
    analysisDirty = true;
  };
  input.addEventListener('input', update);
  update();
}

function loadReference() {
  referenceReady = false;
  document.querySelector('#fit-status').textContent = 'Loading calibrated reference…';
  referenceImage.onload = () => {
    referenceReady = true;
    analysisDirty = true;
  };
  referenceImage.src = `./assets/animal-references/${species}-${view}.png?v=3`;
}

function fitCamera() {
  if (!selected) return;
  const dimensions = selected.rig.dimensions;
  const recipe = selected.recipe;
  const neck = neckReach(recipe.neck);
  const antlerLift = recipe.antlers.length ? (species === 'moose' ? 1.25 : 0.9) : 0.25;
  const totalHeight = dimensions.bodyY + neck.rise + recipe.head[1] + antlerLift;
  const totalLength = recipe.body[2] + neck.forward + recipe.muzzle[2] + recipe.tail.length * 0.65;
  const sideView = view === 'left' || view === 'right';
  const aspect = window.innerWidth / window.innerHeight;
  const verticalHalf = Math.max(
    totalHeight * 0.58,
    sideView ? totalLength * 0.60 / Math.max(0.5, aspect) : 0,
  );
  camera.top = verticalHalf;
  camera.bottom = -verticalHalf;
  camera.left = -verticalHalf * aspect;
  camera.right = verticalHalf * aspect;
  const targetY = selected.mesh.position.y + totalHeight * 0.46;
  const targetX = selected.mesh.position.x;
  const targetZ = selected.mesh.position.z;
  const direction = cameraDirections[view];
  camera.position.set(
    targetX + direction[0] * 10,
    targetY + 0.05,
    targetZ + direction[2] * 10,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(targetX, targetY, targetZ);
  camera.updateProjectionMatrix();
}

function selectAnimal(nextSpecies = species, nextView = view) {
  species = nextSpecies;
  view = nextView;
  selected = animals.agents.find((agent) => agent.recipe.id === species);
  for (const agent of animals.agents) agent.mesh.visible = agent === selected;
  selected.mesh.position.set(0, 0, 0);
  selected.mesh.rotation.set(0, 0, 0);
  selected.heading = 0;
  selected.mesh.position.y = flatWorld.height(0, 0);
  selected.speed = 0;
  selected.motionPreviewSpeed = animationPreview.enabled
    ? selected.recipe.motion.run * animationPreview.speed : null;
  selected.state = animationPreview.enabled ? 'roam' : 'idle';
  selected.stateTimer = 99999;
  selected.previewTimer = 99999;
  selected.cachedGroundY = flatWorld.height(0, 0);
  selected.target.set(0, 0, 1000);
  selected.invalidateProceduralAnimation();
  selected.update(0, distantPlayer, true);
  fitCamera();

  document.querySelectorAll('[data-species]').forEach((button) => {
    button.classList.toggle('active', button.dataset.species === species);
  });
  // The editor is bound to one species' recipe, so switching subject has to
  // rebind it — otherwise the sliders keep editing the animal you left.
  if (typeof rebindAnatomyEditor === 'function') rebindAnatomyEditor();
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  const front = selected.recipe.leg.front.lengths.map((n) => n.toFixed(2)).join(' / ');
  const hind = selected.recipe.leg.hind.lengths.map((n) => n.toFixed(2)).join(' / ');
  document.querySelector('#metrics').textContent = `${selected.recipe.name} · ${view} view · front ${front}m · hind ${hind}m`;
  comparison.offsetX = 0;
  comparison.offsetY = 0;
  comparison.scale = 1;
  document.querySelector('#offset-x').value = 0;
  document.querySelector('#offset-x-value').textContent = '0px';
  document.querySelector('#offset-y').value = 0;
  document.querySelector('#offset-y-value').textContent = '0px';
  document.querySelector('#scale').value = 1;
  document.querySelector('#scale-value').textContent = '100%';
  loadReference();
  analysisDirty = true;
}

document.querySelector('#species').addEventListener('click', (event) => {
  if (event.target.dataset.species) selectAnimal(event.target.dataset.species, view);
});
document.querySelector('#views').addEventListener('click', (event) => {
  if (event.target.dataset.view) selectAnimal(species, event.target.dataset.view);
});
document.querySelector('#modes').addEventListener('click', (event) => {
  if (event.target.dataset.mode) setMode(event.target.dataset.mode);
});
document.querySelector('#auto-align').addEventListener('click', () => {
  comparison.offsetX = 0;
  comparison.offsetY = 0;
  comparison.scale = 1;
  for (const [id, value, label] of [
    ['offset-x', 0, '0px'], ['offset-y', 0, '0px'], ['scale', 1, '100%'],
  ]) {
    document.querySelector(`#${id}`).value = value;
    document.querySelector(`#${id}-value`).textContent = label;
  }
  analysisDirty = true;
});
document.querySelector('#toggle-guides').addEventListener('click', (event) => {
  comparison.guides = !comparison.guides;
  event.currentTarget.classList.toggle('active', comparison.guides);
  analysisDirty = true;
});
document.querySelector('#export-comparison').addEventListener('click', () => {
  exportCanvas.width = analysisWidth;
  exportCanvas.height = analysisHeight;
  exportContext.clearRect(0, 0, analysisWidth, analysisHeight);
  exportContext.drawImage(renderer.domElement, 0, 0, analysisWidth, analysisHeight);
  exportContext.drawImage(referenceLayer, 0, 0);
  const link = document.createElement('a');
  link.download = `${species}-${view}-${comparison.mode}.png`;
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
});
const motionSpeed = document.querySelector('#motion-speed');
motionSpeed.value = animationPreview.speed;
document.querySelector('#motion-speed-value').textContent = `${Math.round(animationPreview.speed * 100)}%`;
motionSpeed.addEventListener('input', () => {
  animationPreview.speed = Number(motionSpeed.value);
  document.querySelector('#motion-speed-value').textContent = `${Math.round(animationPreview.speed * 100)}%`;
  if (selected && animationPreview.enabled) {
    selected.motionPreviewSpeed = selected.recipe.motion.run * animationPreview.speed;
  }
});
document.querySelector('#toggle-animation').addEventListener('click', (event) => {
  animationPreview.enabled = !animationPreview.enabled;
  event.currentTarget.classList.toggle('active', animationPreview.enabled);
  event.currentTarget.textContent = animationPreview.enabled ? 'pause reactive gait' : 'play reactive gait';
  if (animationPreview.enabled) {
    setMode('model');
    selected.motionPreviewSpeed = selected.recipe.motion.run * animationPreview.speed;
    selected.state = 'roam';
    selected.stateTimer = 99999;
    selected.target.set(selected.mesh.position.x, 0, selected.mesh.position.z + 1000);
    selected.invalidateProceduralAnimation();
    referenceContext.clearRect(0, 0, analysisWidth, analysisHeight);
  } else {
    selectAnimal(species, view);
  }
});
document.querySelector('#toggle-terrain').addEventListener('click', (event) => {
  animationPreview.uneven = !animationPreview.uneven;
  event.currentTarget.classList.toggle('active', animationPreview.uneven);
  updatePreviewGround();
  selected.cachedGroundY = flatWorld.height(selected.mesh.position.x, selected.mesh.position.z);
  selected.invalidateProceduralAnimation();
  analysisDirty = true;
});
setControl('opacity', 'opacity', (value) => `${Math.round(value * 100)}%`);
setControl('offset-x', 'offsetX', (value) => `${value}px`);
setControl('offset-y', 'offsetY', (value) => `${value}px`);
setControl('scale', 'scale', (value) => `${Math.round(value * 100)}%`);
document.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 5 : 1;
  if (event.key === 'ArrowLeft') comparison.offsetX -= step;
  if (event.key === 'ArrowRight') comparison.offsetX += step;
  if (event.key === 'ArrowUp') comparison.offsetY -= step;
  if (event.key === 'ArrowDown') comparison.offsetY += step;
  for (const [id, key] of [['offset-x', 'offsetX'], ['offset-y', 'offsetY']]) {
    document.querySelector(`#${id}`).value = comparison[key];
    document.querySelector(`#${id}-value`).textContent = `${comparison[key]}px`;
  }
  analysisDirty = true;
});
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeAnalysisBuffers();
  fitCamera();
});

if (labParams.has('clean')) document.querySelector('#panel').hidden = true;
resizeAnalysisBuffers();
setMode(comparison.mode);
document.querySelector('#toggle-guides').classList.toggle('active', comparison.guides);
document.querySelector('#toggle-animation').classList.toggle('active', animationPreview.enabled);
document.querySelector('#toggle-animation').textContent = animationPreview.enabled
  ? 'pause reactive gait' : 'play reactive gait';
document.querySelector('#toggle-terrain').classList.toggle('active', animationPreview.uneven);
selectAnimal();
renderer.setAnimationLoop((time) => {
  const dt = Math.min(0.05, Math.max(0, (time - animationPreview.lastTime) / 1000));
  animationPreview.lastTime = time;
  if (animationPreview.enabled && selected) {
    selected.motionPreviewSpeed = selected.recipe.motion.run * animationPreview.speed;
    selected.state = 'roam';
    selected.stateTimer = 99999;
    selected.target.set(selected.mesh.position.x, 0, selected.mesh.position.z + 1000);
    selected.update(dt, distantPlayer, true);
    fitCamera();
    referenceContext.clearRect(0, 0, analysisWidth, analysisHeight);
    const swinging = Object.values(selected.footStates).filter((state) => state.swinging).length;
    const errors = Object.values(selected.legSolvers).map((solver) => solver.lastError || 0);
    const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    const swingMargins = Object.values(selected.footStates)
      .filter((state) => state.swinging)
      .map((state) => state.terrainMargin || 0);
    const clearance = swingMargins.length
      ? `${Math.round(Math.min(...swingMargins) * 100)}cm clear` : 'contact';
    const stepReadout = Object.entries(selected.footStates).map(([name, state]) => (
      state.swinging ? `${name.replace('front', 'F').replace('hind', 'H').replace('Left', 'L').replace('Right', 'R')} ${Math.round(state.progress * 100)}%` : ''
    )).filter(Boolean).join(' · ');
    const strideLength = Math.max(0, ...Object.values(selected.footStates)
      .filter((state) => state.swinging)
      .map((state) => Math.hypot(state.goal[0] - state.start[0], state.goal[2] - state.start[2])));
    const gaitClass = selected.lastPose?.gaitClass || selected.recipe.gait.class;
    const locomotionState = selected.gaitReady
      ? `${selected.speed.toFixed(2)}m/s` : 'pre-roll';
    document.querySelector('#animation-status').textContent = `${gaitClass} · ${locomotionState} · ${Math.round(strideLength * 100)}cm stride · ${4 - swinging} planted · ${swinging} stepping · ${clearance} · IK ${Math.round(meanError * 100)}cm · ${stepReadout || 'stance'} · 3 SDF ropes`;
  }
  if (typeof syncPrimitiveProxies === 'function') syncPrimitiveProxies();
  renderer.render(scene, camera);
  if (!animationPreview.enabled && analysisDirty && referenceReady) {
    analysisDirty = false;
    measureAndDraw();
  }
});

window.__animalLab = {
  animals,
  select: selectAnimal,
  compare: () => { analysisDirty = true; },
  setMode,
  get selected() { return selected; },
  get fit() { return comparison.metrics; },
  get alignment() { return comparison.alignment; },
};

// ---------------------------------------------------------------------------
// Anatomy editor.
//
// Every animal here is authored as data — the renderer only reads dimensions,
// angles and colours out of a recipe — so tuning anatomy does not need a
// modelling tool, it needs the recipe made editable and the model rebuilt. That
// is all this is: sliders bound to recipe paths, a rebuild on change, and a way
// to see the SDF primitives the smooth-min surface is hiding.
//
// The values live in the SCALED recipe, because that is what the renderer
// consumes. `export recipe` converts back to the raw sheet units that
// animaldata.mjs is authored in, so what you copy out is what you paste in.
// ---------------------------------------------------------------------------

var anatomyEditorReady = false;   // eslint-disable-line no-var -- hoisting is the point
const editState = {
  enabled: false,
  showPrimitives: false,
  recipes: new Map(),
  proxies: null,
  selectedShape: -1,
  rebuildQueued: false,
};

const readPath = (object, path) => path.split('.').reduce((node, key) => node?.[key], object);
function writePath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((node, key) => node[key], object)[last] = value;
}

// The sculpt block is optional on a recipe — the renderer falls back to the
// literals it was authored with. The editor injects those same defaults so the
// sliders exist for every species, and an exported recipe then carries them
// explicitly.
const SCULPT_DEFAULTS = Object.freeze({
  chestOffset: [0, 0.04, 0],
  rumpOffset: [0, 0.01, 0],
  chestRotation: [0, 0, 0],
  rumpRotation: [0, 0, 0],
  // Whole-limb rotation at the root: pitch, then yaw and roll, both mirrored.
  foreSplay: [0, 0, 0],
  hindSplay: [0, 0, 0],
  foreMass: { size: [1.08, 0.27, 1.12], offset: [0, -0.30, -0.10], rotation: [0, 0, 0] },
  hindMass: { size: [1.25, 0.32, 1.32], offset: [0, -0.34, 0], rotation: [0, 0, 0] },
});

function editableRecipe(id) {
  if (!editState.recipes.has(id)) {
    const clone = structuredClone(animals.assets.get(id).recipe);
    clone.sculpt = { ...structuredClone(SCULPT_DEFAULTS), ...(clone.sculpt || {}) };
    editState.recipes.set(id, clone);
  }
  return editState.recipes.get(id);
}

// The band a slider spans is centred on the PRISTINE value, not the live one.
// Tracking the live value would slide the range out from under the handle as
// you drag. Bands are deliberately tight: the first version ran 0 to 2.6x the
// value across ~200 px, so a single pixel moved a dimension by half a percent
// of its whole range and fine work was impossible.
function pristineRecipe(id) {
  const base = ANIMAL_RECIPES[id];
  const clone = structuredClone(base);
  clone.sculpt = { ...structuredClone(SCULPT_DEFAULTS), ...(clone.sculpt || {}) };
  return clone;
}

// Slider ranges are derived from the CURRENT value rather than fixed, so the
// same definitions give a usable range on a fox and on a moose.
function anatomySpecs(recipe) {
  const specs = [];
  const base = pristineRecipe(species);
  const add = (group, label, path, kind = 'size') => {
    const value = readPath(recipe, path);
    if (!Number.isFinite(value)) return;
    const anchor = readPath(base, path);
    const centre = Number.isFinite(anchor) ? anchor : value;
    const magnitude = Math.abs(centre) || 0.15;
    // Tight bands around the authored value, so the full width of the slider
    // is spent on the range you actually want to explore.
    let min = Math.max(0, magnitude * 0.45);
    let max = magnitude * 1.75;
    if (kind === 'angle') { min = centre - 0.9; max = centre + 0.9; }
    else if (kind === 'ratio') { min = Math.max(0.01, magnitude * 0.3); max = magnitude * 2.1; }
    else if (kind === 'unit') { min = 0.5; max = 0.82; }
    else if (kind === 'freq') { min = magnitude * 0.4; max = magnitude * 1.9; }
    else if (kind === 'signed') { min = centre - magnitude * 1.3; max = centre + magnitude * 1.3; }
    else if (kind === 'mul') { min = centre - 0.9; max = centre + 0.9; }
    else if (kind === 'tilt') {
      // Rotations default to zero, so like placement offsets they need an
      // absolute band. Just over a quarter turn each way is far more than any
      // of these wants and still leaves useful resolution.
      min = centre - 0.9; max = centre + 0.9;
    }
    else if (kind === 'place') {
      // A placement offset defaults to nearly zero, so its own magnitude is a
      // useless yardstick — a band of plus or minus a centimetre cannot move a
      // rump anywhere. Measured against the barrel instead, which is the thing
      // the mass is being positioned inside.
      const reach = (base.body?.[1] || 0.3) * 1.3;
      min = centre - reach; max = centre + reach;
    }
    // Widen just enough to keep an already-edited value reachable.
    min = Math.min(min, value); max = Math.max(max, value);
    // 1000 steps across the band: fine enough that a pixel of travel is a
    // sub-step, so the handle moves continuously rather than snapping.
    specs.push({ group, label, path, min, max, step: (max - min) / 1000 });
  };
  const triple = (group, label, path, kind) => {
    for (let i = 0; i < 3; i++) add(group, `${label}${'xyz'[i]}`, `${path}.${i}`, kind);
  };

  triple('Torso', 'body ', 'body');
  triple('Torso', 'chest ', 'chest');
  triple('Torso', 'rump ', 'rump');
  add('Torso', 'torsoY', 'torsoY', 'signed');
  add('Torso', 'bodyLift', 'bodyLift', 'ratio');
  add('Torso', 'shoulderZ', 'shoulderZ', 'signed');
  add('Torso', 'hipZ', 'hipZ', 'signed');

  add('Neck', 'lower len', 'neck.lengths.0');
  add('Neck', 'upper len', 'neck.lengths.1');
  add('Neck', 'lower rad', 'neck.radii.0');
  add('Neck', 'upper rad', 'neck.radii.1');
  add('Neck', 'lower bind', 'neck.bind.0', 'angle');
  add('Neck', 'upper bind', 'neck.bind.1', 'angle');

  triple('Head', 'skull ', 'head');
  add('Head', 'pitch', 'headPitch', 'angle');
  triple('Head', 'muzzle ', 'muzzle');
  triple('Head', 'ear ', 'ear');
  add('Head', 'ear angle', 'earAngle', 'angle');

  for (const end of ['front', 'hind']) {
    const group = end === 'front' ? 'Fore limb' : 'Hind limb';
    for (let i = 0; i < 3; i++) add(group, `seg${i + 1} len`, `leg.${end}.lengths.${i}`);
    for (let i = 0; i < 3; i++) add(group, `seg${i + 1} rad`, `leg.${end}.radii.${i}`);
    for (let i = 0; i < 3; i++) add(group, `seg${i + 1} bind`, `leg.${end}.bind.${i}`, 'angle');
    add(group, 'spread x', `leg.${end}.x`);
    add(group, 'stagger', `leg.${end}.stagger`, 'signed');
    triple(group, 'splay ', `sculpt.${end === 'front' ? 'foreSplay' : 'hindSplay'}`, 'tilt');
  }
  triple('Hoof', 'hoof ', 'leg.hoof');

  add('Tail', 'length', 'tail.length');
  add('Tail', 'radius', 'tail.radius');
  add('Tail', 'tip radius', 'tail.tipRadius');
  add('Tail', 'root', 'tail.root', 'ratio');
  add('Tail', 'lift', 'tail.lift', 'signed');
  add('Tail', 'angle', 'tail.angle', 'angle');
  add('Tail', 'bend', 'tail.bend', 'angle');

  add('Gait', 'walk Hz', 'gait.walkHz', 'freq');
  add('Gait', 'run Hz', 'gait.runHz', 'freq');
  add('Gait', 'duty', 'gait.dutyFactor', 'unit');
  add('Gait', 'stride', 'gait.stride', 'ratio');
  add('Gait', 'lift', 'gait.lift', 'ratio');
  add('Gait', 'bob', 'gait.bob');

  // Where the chest and rump masses sit inside the barrel, and how the limb
  // muscle is proportioned. These shape the silhouette without disturbing any
  // bone the gait solver reads.
  triple('Rump & chest', 'rump off ', 'sculpt.rumpOffset', 'place');
  triple('Rump & chest', 'rump rot ', 'sculpt.rumpRotation', 'tilt');
  triple('Rump & chest', 'chest off ', 'sculpt.chestOffset', 'place');
  triple('Rump & chest', 'chest rot ', 'sculpt.chestRotation', 'tilt');
  for (const [group, key] of [['Fore muscle', 'foreMass'], ['Hind muscle', 'hindMass']]) {
    triple(group, 'size ', `sculpt.${key}.size`, 'mul');
    triple(group, 'offset ', `sculpt.${key}.offset`, 'mul');
    triple(group, 'rot ', `sculpt.${key}.rotation`, 'tilt');
  }
  return specs;
}

// Rebuilding the model is a few milliseconds, but a slider drag fires far
// faster than that. Coalescing to one rebuild per frame keeps dragging smooth
// without ever showing a stale shape.
// Rebuild the MODEL only — never the panel.
//
// This used to call selectAnimal, which rebinds the editor, and rebinding
// rebuilds the slider DOM from scratch. Doing that on every frame of a drag
// destroyed the very input the pointer was holding, so the handle stopped
// following the mouse after one frame. That, not the cost of the rebuild, is
// what made the sliders feel stuck: the geometry work is about 4 ms.
//
// It also refit the camera each frame, which made the model jump about while
// being edited. The camera is refit on release instead, in `commitAnatomyEdit`.
function applyAnatomyRebuild() {
  animals.rebuildSpecies(species, editableRecipe(species));
  selected = animals.agents.find((agent) => agent.recipe.id === species);
  if (!selected) return;
  for (const agent of animals.agents) {
    agent.mesh.visible = agent === selected && !editState.showPrimitives;
  }
  selected.mesh.position.set(0, flatWorld.height(0, 0), 0);
  selected.mesh.rotation.set(0, 0, 0);
  selected.heading = 0;
  selected.speed = 0;
  selected.motionPreviewSpeed = animationPreview.enabled
    ? selected.recipe.motion.run * animationPreview.speed : null;
  selected.state = animationPreview.enabled ? 'roam' : 'idle';
  selected.stateTimer = 99999;
  selected.previewTimer = 99999;
  selected.cachedGroundY = flatWorld.height(0, 0);
  selected.target.set(0, 0, 1000);
  selected.invalidateProceduralAnimation();
  selected.update(0, distantPlayer, true);
  if (editState.showPrimitives) buildPrimitiveProxies();
}

function queueAnatomyRebuild() {
  if (editState.rebuildQueued) return;
  editState.rebuildQueued = true;
  requestAnimationFrame(() => {
    editState.rebuildQueued = false;
    applyAnatomyRebuild();
  });
}

// On release: reframe, and refresh the readouts the panel shows.
function commitAnatomyEdit() {
  fitCamera();
  const front = selected?.recipe.leg.front.lengths.map((n) => n.toFixed(2)).join(' / ');
  const hind = selected?.recipe.leg.hind.lengths.map((n) => n.toFixed(2)).join(' / ');
  if (front) {
    document.querySelector('#metrics').textContent =
      `${selected.recipe.name} · ${view} view · front ${front}m · hind ${hind}m`;
  }
}

function buildAnatomySliders() {
  const host = document.querySelector('#anatomy-sliders');
  host.innerHTML = '';
  if (!editState.enabled) return;
  const recipe = editableRecipe(species);
  let currentGroup = null;
  for (const spec of anatomySpecs(recipe)) {
    if (spec.group !== currentGroup) {
      currentGroup = spec.group;
      const heading = document.createElement('div');
      heading.className = 'section-title';
      heading.style.marginTop = '9px';
      heading.textContent = currentGroup;
      host.appendChild(heading);
    }
    const row = document.createElement('label');
    row.className = 'control';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min; input.max = spec.max; input.step = spec.step;
    input.value = readPath(recipe, spec.path);
    const readout = document.createElement('span');
    readout.className = 'value';
    readout.textContent = Number(input.value).toFixed(3);
    input.addEventListener('input', () => {
      writePath(recipe, spec.path, Number(input.value));
      readout.textContent = Number(input.value).toFixed(4);
      queueAnatomyRebuild();
    });
    // Reframing mid-drag makes the subject jump under the cursor, so it waits
    // for the pointer to come up.
    input.addEventListener('change', commitAnatomyEdit);
    row.append(name, input, readout);
    host.appendChild(row);
  }
}

// --- primitives ------------------------------------------------------------
// The rendered surface is a smooth-min over these, so nothing about the shapes
// themselves is visible in the final model. Drawn as wireframes on their own
// bones, they show what is actually being blended and where each one sits.
function disposePrimitiveProxies() {
  if (!editState.proxies) return;
  editState.proxies.traverse((child) => {
    if (child.isMesh) { child.geometry.dispose(); child.material.dispose(); }
  });
  editState.proxies.parent?.remove(editState.proxies);
  editState.proxies = null;
}

function buildPrimitiveProxies() {
  disposePrimitiveProxies();
  if (!selected) return;
  const asset = animals.assets.get(species);
  const group = new THREE.Group();
  group.name = 'primitive-proxies';
  scene.add(group);
  editState.proxies = group;
  asset.shapes.forEach((shape, index) => {
    const bone = selected.rig.byName[shape.boneName];
    if (!bone) return;
    const p = shape.params;
    let geometry;
    if (shape.type === 1) geometry = new THREE.CapsuleGeometry(p.x, Math.max(0.01, p.y * 2), 3, 10);
    else if (shape.type === 2) geometry = new THREE.ConeGeometry(p.x, Math.max(0.01, p.y * 2), 10);
    else { geometry = new THREE.SphereGeometry(1, 12, 8); geometry.scale(p.x, p.y, p.z); }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: index === editState.selectedShape ? 0xffcf6a : 0x63d0ff,
      wireframe: true, transparent: true,
      opacity: index === editState.selectedShape ? 0.95 : 0.34,
      depthTest: false,
    }));
    mesh.renderOrder = 20;
    mesh.userData.shapeIndex = index;
    mesh.userData.shape = shape;
    // Held in the SCENE and driven from the bone's world matrix each frame,
    // rather than parented to the bone. Parenting is the obvious thing and is
    // wrong here: the bones live inside the skinned mesh, so hiding the skin to
    // look at the primitives hid the primitives with it.
    mesh.userData.bone = bone;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    group.userData.tracked = group.userData.tracked || [];
    group.userData.tracked.push(mesh);
  });
}

function describeSelectedPrimitive() {
  const host = document.querySelector('#selected-primitive');
  const asset = animals.assets.get(species);
  const shape = asset.shapes[editState.selectedShape];
  if (!shape) { host.textContent = editState.showPrimitives ? 'click a primitive to inspect it' : ''; return; }
  const kind = ['ellipsoid', 'capsule', 'cone'][shape.type] || 'shape';
  host.textContent = `#${editState.selectedShape} ${kind} on ${shape.boneName} · `
    + `${shape.params.x.toFixed(3)} × ${shape.params.y.toFixed(3)} × ${shape.params.z.toFixed(3)}`
    + ` · blend ${shape.blend.toFixed(3)}`;
}

const primitiveRaycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!editState.showPrimitives || !editState.proxies) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  primitiveRaycaster.setFromCamera(ndc, camera);
  const hits = primitiveRaycaster.intersectObjects(editState.proxies.userData.tracked || [], false);
  editState.selectedShape = hits.length ? hits[0].object.userData.shapeIndex : -1;
  buildPrimitiveProxies();
  describeSelectedPrimitive();
});

// Sheet-unit conversion, mirroring metricRecipe in animaldata.mjs: everything
// it multiplies by `scale` on the way in is divided by it on the way out.
function exportRecipe() {
  const recipe = structuredClone(editableRecipe(species));
  const k = recipe.scale ?? 1;
  const div = (value) => Number((value / k).toFixed(4));
  const vec = (a) => a.map(div);
  if (k !== 1) {
    recipe.body = vec(recipe.body); recipe.chest = vec(recipe.chest); recipe.rump = vec(recipe.rump);
    recipe.torsoY = div(recipe.torsoY);
    for (const end of ['front', 'hind']) {
      const chain = recipe.leg[end];
      chain.lengths = vec(chain.lengths); chain.radii = vec(chain.radii);
      chain.x = div(chain.x); chain.stagger = div(chain.stagger);
    }
    recipe.leg.hoof = vec(recipe.leg.hoof);
    recipe.neck.lengths = vec(recipe.neck.lengths); recipe.neck.radii = vec(recipe.neck.radii);
    recipe.head = vec(recipe.head); recipe.muzzle = vec(recipe.muzzle); recipe.ear = vec(recipe.ear);
    recipe.tail.length = div(recipe.tail.length);
    recipe.tail.radius = div(recipe.tail.radius);
    recipe.tail.tipRadius = div(recipe.tail.tipRadius);
    recipe.tail.lift = div(recipe.tail.lift);
    recipe.shoulderZ = div(recipe.shoulderZ); recipe.hipZ = div(recipe.hipZ);
    recipe.gait.bob = div(recipe.gait.bob);
    recipe.motion.turnRadius = div(recipe.motion.turnRadius);
  }
  const round = (value) => (typeof value === 'number' ? Number(value.toFixed(4)) : value);
  const text = JSON.stringify(recipe, (key, value) => round(value), 2);
  console.info(`[anatomy] ${species} recipe in sheet units:\n${text}`);
  navigator.clipboard?.writeText(text).catch(() => {});
  document.querySelector('#selected-primitive').textContent = 'recipe copied to clipboard and logged';
  return text;
}

document.querySelector('#toggle-edit').addEventListener('click', (event) => {
  editState.enabled = !editState.enabled;
  event.currentTarget.classList.toggle('active', editState.enabled);
  event.currentTarget.textContent = editState.enabled ? 'editing anatomy' : 'edit anatomy';
  buildAnatomySliders();
});

document.querySelector('#toggle-primitives').addEventListener('click', (event) => {
  editState.showPrimitives = !editState.showPrimitives;
  event.currentTarget.classList.toggle('active', editState.showPrimitives);
  if (editState.showPrimitives) buildPrimitiveProxies();
  else { disposePrimitiveProxies(); editState.selectedShape = -1; }
  if (selected) selected.mesh.visible = !editState.showPrimitives;
  describeSelectedPrimitive();
});

document.querySelector('#reset-anatomy').addEventListener('click', () => {
  editState.recipes.delete(species);
  animals.rebuildSpecies(species, ANIMAL_RECIPES[species]);
  selectAnimal(species, view);
  buildAnatomySliders();
  if (editState.showPrimitives) buildPrimitiveProxies();
});

document.querySelector('#export-anatomy').addEventListener('click', exportRecipe);

// Species changes have to rebind the sliders to the new recipe.
const labSelectAnimal = selectAnimal;
window.__animalLab.edit = {
  state: editState,
  recipe: (id = species) => editableRecipe(id),
  export: exportRecipe,
  rebuild: queueAnatomyRebuild,
  refresh: () => {
    buildAnatomySliders();
    if (editState.showPrimitives) buildPrimitiveProxies();
    describeSelectedPrimitive();
  },
};
void labSelectAnimal;

// Declared as a function so `selectAnimal` — which runs before this block is
// evaluated — can call it by hoisted name. The readiness flag is a `var` for
// the same reason: `selectAnimal` fires once during module init, before the
// editor's own consts exist, and reading a const in its dead zone throws even
// through `typeof`.
function rebindAnatomyEditor() {
  if (!anatomyEditorReady) return;
  if (editState.enabled) buildAnatomySliders();
  if (editState.showPrimitives) { editState.selectedShape = -1; buildPrimitiveProxies(); }
  if (selected) selected.mesh.visible = !editState.showPrimitives;
}

anatomyEditorReady = true;
rebindAnatomyEditor();

// Primitives follow the pose by copying their bone's world transform, since
// they are deliberately not parented to it (see buildPrimitiveProxies).
function syncPrimitiveProxies() {
  if (!anatomyEditorReady || !editState.showPrimitives || !editState.proxies) return;
  for (const mesh of editState.proxies.userData.tracked || []) {
    const bone = mesh.userData.bone;
    if (!bone) continue;
    bone.updateWorldMatrix(true, false);
    mesh.matrix.copy(bone.matrixWorld).multiply(mesh.userData.shape.localMatrix);
    mesh.matrixWorldNeedsUpdate = true;
  }
}
