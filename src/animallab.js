import * as THREE from 'three';
import { AnimalSystem } from './animals.js';
import { neckReach } from './animaldata.mjs';

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
