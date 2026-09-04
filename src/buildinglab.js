// A model sheet for buildings, in the spirit of the animal one.
//
// Architecture is a comparative judgement. One house on a hillside tells you
// almost nothing about whether the generator has range; a row of them at the
// same scale, under the same light, from the same angle, tells you in a glance
// which programs read as themselves and which are the same box twice. So this
// lays buildings out on a strip and points a flat orthographic camera at them,
// which is the view a model sheet has used since long before any of this.
//
// It calls the SAME mesh builder the streaming path calls. A lab that drew its
// own approximation of a house would flatter or libel the real one, and either
// way would not be evidence.

import * as THREE from 'three';
import { createBuildingPlan, BUILDING_PROGRAMS } from './buildingplan.mjs';
import { buildBuilding } from './settlementstream.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9d2c2);
const camera = new THREE.OrthographicCamera(-40, 40, 20, -20, 0.1, 600);

scene.add(new THREE.HemisphereLight(0xfff4dd, 0x6d746b, 1.5));
const sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
sun.position.set(-60, 90, 70);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 90, bottom: -90, near: 1, far: 400 });
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900),
  new THREE.MeshStandardMaterial({ color: 0xb9b4a2, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const sheetRoot = new THREE.Group();
scene.add(sheetRoot);

const params = new URLSearchParams(window.location.search);
document.body.classList.toggle('clean', params.has('clean'));

// Village styles as settlementplan mints them, so the sheet shows the taste a
// real place would be built with rather than an invented one.
function styleFor(index) {
  const rng = mulberry(0x5eed + index * 7919);
  return {
    massingComplexity: rng(), roofBias: rng(), hipBias: rng() * 0.6,
    wallBias: rng(), trimHue: rng(),
  };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clearSheet() {
  sheetRoot.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
  });
  sheetRoot.clear();
}

/**
 * Lay a list of building plans out in a row, spaced by their own footprints.
 *
 * The camera never orbits. A sheet whose camera swings round puts the row on a
 * diagonal and shrinks everything at the far end, which is the one thing a
 * comparative view cannot afford. Turning each BUILDING instead keeps the row
 * square to the frame and every subject the same size, so the differences you
 * see are the buildings' and not perspective's.
 */
function layout(plans, yaw) {
  clearSheet();
  const gap = 5;
  let cursor = 0;
  const spans = [];
  for (const plan of plans) {
    const half = Math.max(plan.width, 6) / 2 + Math.abs(plan.masses.reduce(
      (widest, mass) => Math.max(widest, Math.abs(mass.dx) + mass.width / 2), 0,
    ) - plan.width / 2);
    cursor += half;
    const placed = { ...plan, x: cursor, y: 0, z: 0, yaw };
    buildBuilding(sheetRoot, placed, new Map(), null);
    spans.push({ id: plan.id, program: plan.program, x: cursor, width: plan.width, depth: plan.depth,
      height: plan.floorCount * plan.floorHeight, masses: plan.masses.length,
      roles: plan.masses.map((mass) => mass.role).join('+'),
      roof: `${plan.roof.kind}/${plan.roof.pitch.toFixed(2)}`,
      materials: `${plan.materials.wall}+${plan.materials.roof}` });
    cursor += half + gap;
  }
  sheetRoot.position.x = -cursor / 2;
  return { spans, extent: cursor };
}

const SHEETS = {
  // One of every program the generator can build, at a fixed seed, so the
  // question "does a smithy read as a smithy" has a place to be asked.
  programs: () => BUILDING_PROGRAMS.map((program, index) => createBuildingPlan({
    id: `sheet:${program}`, program, seed: 40503 + index * 977, style: styleFor(3),
  })),
  // The same program twelve times. This is the row that says whether a street
  // of houses is a street or a terrace of one house repeated.
  dwellings: () => Array.from({ length: 12 }, (unused, index) => createBuildingPlan({
    id: `sheet:dwelling:${index}`, program: 'dwelling', seed: 1000 + index * 7919, style: styleFor(3),
  })),
  // One dwelling per village taste, to show how much of a place's character
  // the style actually carries.
  styles: () => Array.from({ length: 10 }, (unused, index) => createBuildingPlan({
    id: `sheet:style:${index}`, program: 'dwelling', seed: 2024, style: styleFor(index),
  })),
};

// The yaw each subject is turned to, and how far the camera is lifted. Front is
// square on; three-quarter is the angle that shows a wing and a roof plane at
// once, which is where massing actually reads.
const VIEWS = {
  front: { yaw: 0, elevation: 0.16 },
  'three-quarter': { yaw: -0.66, elevation: 0.34 },
  side: { yaw: -Math.PI / 2, elevation: 0.16 },
};

let currentSheet = params.get('sheet') || 'programs';
let currentView = params.get('view') || 'three-quarter';
let lastExtent = 90;

/**
 * Fit the frame to what is actually on the sheet.
 *
 * Sizing the camera from the row's length alone leaves a strip of houses adrift
 * in a field of ground, because the row is long and a house is not tall. Fitting
 * to the rendered bounds instead fills the frame with subject, which is the
 * whole reason to make a sheet rather than take a photograph.
 */
function frame() {
  const view = VIEWS[currentView] || VIEWS['three-quarter'];
  const span = Math.max(lastExtent, 30);
  camera.position.set(0, span * view.elevation, span);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  // Project the sheet's corners into camera space and fit to that box.
  const bounds = new THREE.Box3().setFromObject(sheetRoot);
  if (bounds.isEmpty()) return;
  const inverse = camera.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const corner = new THREE.Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).applyMatrix4(inverse);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      }
    }
  }
  const margin = 1.04;
  const aspect = window.innerWidth / window.innerHeight;
  let halfWidth = ((maxX - minX) / 2) * margin;
  let halfHeight = ((maxY - minY) / 2) * margin;
  // Grow whichever axis is short so nothing is squeezed by the viewport shape.
  if (halfWidth / halfHeight < aspect) halfWidth = halfHeight * aspect;
  else halfHeight = halfWidth / aspect;
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  camera.left = centerX - halfWidth; camera.right = centerX + halfWidth;
  camera.top = centerY + halfHeight; camera.bottom = centerY - halfHeight;
  camera.updateProjectionMatrix();
}

function build() {
  let plans = (SHEETS[currentSheet] || SHEETS.programs)();
  // `from`/`count` cut a window out of a long sheet. Eleven buildings across a
  // screen gives each of them seventy pixels, which is enough to count them and
  // not enough to look at them.
  const from = Number(params.get('from')) || 0;
  const count = Number(params.get('count')) || 0;
  if (from || count) plans = plans.slice(from, count ? from + count : undefined);
  const view = VIEWS[currentView] || VIEWS['three-quarter'];
  const { spans, extent } = layout(plans, view.yaw);
  lastExtent = extent;
  frame();
  document.querySelector('#readout').textContent =
    `${spans.length} buildings · ${currentSheet} · ${currentView}`;
  window.__buildingLab = { sheet: currentSheet, view: currentView, spans };
  for (const group of ['sheets', 'views']) {
    const key = group === 'sheets' ? currentSheet : currentView;
    for (const button of document.querySelectorAll(`#${group} button`)) {
      button.classList.toggle('active', button.dataset.sheet === key || button.dataset.view === key);
    }
  }
}

for (const button of document.querySelectorAll('#sheets button')) {
  button.addEventListener('click', () => { currentSheet = button.dataset.sheet; build(); });
}
for (const button of document.querySelectorAll('#views button')) {
  button.addEventListener('click', () => { currentView = button.dataset.view; build(); });
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  frame();
});

// Exposed so a screenshot harness can switch sheets without clicking.
window.__buildingLabShow = (sheet, view) => {
  if (sheet) currentSheet = sheet;
  if (view) currentView = view;
  build();
  return window.__buildingLab;
};

build();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
