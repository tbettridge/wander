import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world.js';
import { prepareWaterPreview, waterPreviewSpawn } from './hydrologypreview.mjs';
import { DistantWaterLandscape } from './distantwater.js';
import { findWatershedViewpoints } from './watershedviewpoints.mjs';
import { createWorldLoadMetrics } from './worldloadmetrics.mjs';
import { waterWorkerPlans } from './waterstage.mjs';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const seed = query.get('wanderSeed') === '4242' ? 4242 : 2;
$('fixture').value = String(seed);
$('reload').onclick = () => {
  if (Number($('fixture').value) !== seed) {
    query.delete('waterPreviewRegionX'); query.delete('waterPreviewRegionZ');
  }
  query.set('wanderSeed', $('fixture').value);
  location.search = query.toString();
};
query.set('waterPreview', 'regional');
if (!query.has('waterPreviewRegionX')) query.set('waterPreviewRegionX', seed === 4242 ? '1' : '0');
if (!query.has('waterPreviewRegionZ')) query.set('waterPreviewRegionZ', '0');
const metrics = createWorldLoadMetrics({ scope: 'inspection', navigationStart: 0,
  requiredGates: ['field', 'scene', 'viewpoints', 'first-draw'] });
metrics.startStage('app-launch');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b7d2df');
scene.fog = new THREE.Fog('#b7d2df', 4000, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.2, 14000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxDistance = 7000;
scene.add(new THREE.HemisphereLight(0xe5f4ff, 0x66764e, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(-80, 180, -100); scene.add(sun);
const terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
const waterMaterial = new THREE.MeshStandardMaterial({ color: '#337c91', roughness: 0.3,
  metalness: 0.18, side: THREE.DoubleSide });
const landscape = new DistantWaterLandscape(scene, { three: THREE, terrainMaterial, waterMaterial });
let world, preview, views, complete = false, flight = null, lastFrame = null, maximumFrameGap = 0;
let lastProgressUpdate = 0;
let descriptorReport = null, reportWorker = null;
function place(point) {
  flight = null;
  camera.position.set(point.x, point.y, point.z);
  controls.target.set(views.target.x, views.target.y, views.target.z);
  controls.update();
}
function survey() {
  place({ x: views.target.x + 1000, y: views.target.y + 1600, z: views.target.z + 1900 });
}
function measurements() {
  $('measurements').textContent = JSON.stringify({
    seed, prototype: true, coverage: 'Accepted regional window only; no new cross-region drainage',
    load: metrics.snapshot(), geometry: landscape.ready?.stats,
    viewpoints: views, maximumFrameGapMs: Math.round(maximumFrameGap),
    descriptorReport,
    limitations: ['Coarse inspection terrain; bank detail and walking are not acceptance-tested here',
      'Persistent reload evidence is separate from browser-restart verification'],
  }, null, 2);
}
$('overview').onclick = survey;
$('overlook').onclick = () => place(views.overlook);
$('bank').onclick = () => place(views.bank);
$('descent').onclick = () => {
  place(views.overlook);
  flight = { started: performance.now(), from: { ...views.overlook }, to: views.bank };
};
$('show-water').onchange = () => landscape.getObject3D()?.traverse(object => {
  if (object.isMesh && object.name.startsWith('distant-water-')) object.visible = $('show-water').checked;
});
$('wireframe').onchange = () => { terrainMaterial.wireframe = $('wireframe').checked; };
$('descriptor-report').onclick = () => {
  $('descriptor-report').disabled = true;
  descriptorReport = { state: 'Measuring in a worker…' }; measurements();
  reportWorker = new Worker(new URL('./watershedreportworker.js', import.meta.url), { type: 'module' });
  const finish = report => {
    descriptorReport = report; reportWorker.terminate(); reportWorker = null;
    $('descriptor-report').disabled = false; measurements();
  };
  reportWorker.onmessage = ({ data }) => finish(data.type === 'descriptor-report-ready'
    ? data.report : { error: data.error || 'Descriptor report failed' });
  reportWorker.onerror = error => finish({ error: error.message });
  reportWorker.postMessage({ type: 'descriptor-report', seed,
    regionX: Number(query.get('waterPreviewRegionX')), regionZ: Number(query.get('waterPreviewRegionZ')),
    waterPlansJSON: waterWorkerPlans(world.waterField) });
};
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
window.addEventListener('pagehide', () => { preview?.stream?.dispose(); landscape.dispose(); reportWorker?.terminate(); });
renderer.setAnimationLoop(now => {
  if (document.hidden) { lastFrame = null; return; }
  if (complete && lastFrame != null) maximumFrameGap = Math.max(maximumFrameGap, now - lastFrame);
  lastFrame = now;
  if (!complete && landscape.debug.state === 'preparing' && now - lastProgressUpdate > 1000) {
    lastProgressUpdate = now;
    const { completed, total } = landscape.debug;
    $('status').textContent = total
      ? `Building distant terrain and water… ${completed} of ${total} tiles prepared.`
      : 'Preparing accepted water data for the distant landscape…';
  }
  if (flight) {
    const t = Math.min(1, (now - flight.started) / 18000), eased = t * t * (3 - 2 * t);
    const x = THREE.MathUtils.lerp(flight.from.x, flight.to.x, eased);
    const z = THREE.MathUtils.lerp(flight.from.z, flight.to.z, eased);
    const water = world.riverAt(x, z);
    const floor = Math.max(world.height(x, z), water.wet ? water.y : -Infinity) + 1.7;
    camera.position.set(x, Math.max(floor, THREE.MathUtils.lerp(flight.from.y, flight.to.y, eased)), z);
    controls.update();
    if (t === 1) flight = null;
  }
  renderer.render(scene, camera);
});

try {
  metrics.startStage('water-planning');
  preview = await prepareWaterPreview(seed, query.toString());
  metrics.endStage('water-planning', undefined, preview.stream.profiling);
  metrics.markGate('field');
  const progress = preview.stream.progress;
  if (progress?.completed === 25 && progress.total === 25) metrics.setCacheEvidence({
    workerFresh: true, persistentHits: progress.reused, persistentMisses: 25 - progress.reused,
  });
  world = new World(seed, { waterField: preview.preparedField, generationVersion: 3 });
  const spawn = waterPreviewSpawn(world, query.toString());
  if (!spawn) throw new Error('No accepted water feature found in this fixture');
  const focus = { x: spawn.x + spawn.tangentX, z: spawn.z + spawn.tangentZ };
  $('status').textContent = 'Building distant terrain and finding a real overlook…';
  metrics.startStage('scene-preparation');
  const result = await Promise.all([
    landscape.attachWorld(world, { center: focus, radius: 4000 }),
    findWatershedViewpoints(world, focus),
  ]);
  views = result[1];
  metrics.endStage('scene-preparation');
  metrics.markGate('scene'); metrics.markGate('viewpoints');
  survey();
  renderer.render(scene, camera);
  metrics.markFirstDraw({ rendered: true, drawCalls: renderer.info.render.calls });
  metrics.markInspectionReady();
  complete = true; lastFrame = null;
  $('overview').disabled = false;
  $('descriptor-report').disabled = false;
  $('overlook').disabled = !views.overlook;
  $('bank').disabled = !views.bank;
  $('descent').disabled = !views.overlook || !views.bank;
  $('status').textContent = `Inspection ready · 4 km terrain radius. ${views.overlook
    ? 'A terrain-grounded overlook is available.' : 'No unobstructed ground overlook found; survey view is available.'} This is not a full-game loading benchmark.`;
  measurements();
  console.info('[watershed-inspection]', JSON.stringify(metrics.snapshot()));
  document.querySelector('details').addEventListener('toggle', measurements);
} catch (error) {
  $('status').textContent = `Landscape preparation failed: ${error.message}`;
  console.error(error);
  preview?.stream?.dispose(); landscape.cancel();
  measurements();
}
