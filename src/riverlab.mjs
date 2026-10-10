import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world.js?v=hydrology4';

import { riverMaterial } from './river.js?v=hydrology4';
import { createVegetationLibrary, buildScatterGroup } from './vegetation.js';
import { LakeReflection } from './waterreflection.js';
import { waterUniforms } from './watercommon.js';
import { WaterSystem } from './water.js';
import { buildBrookGroup } from './brookwater.js';
import { brooksForCell } from './forestbrooks.mjs';

const fixtures = [
  { seed: 20260612, x: -550, z: -960 },
  { seed: 20260612, x: -920, z: -960 },
  { seed: 4242, x: 640, z: -800 },
  { seed: 20260612, x: 2912, z: 1904, basin: true },
  { seed: 20260612, x: 536, z: 2680, basin: true },
  { seed: 20260612, x: -1847, z: -2191, reach: true, sourceX: -2000, sourceZ: -2200 },
  { seed: 20260612, x: 2600, z: 500, junction: true },
  { seed: 20260612, x: 2736, z: 3216, network: true },
  { seed: 4242, x: 288, z: 3912, drainage: true, basinId: 'basin:4242:288:3912' },
  { seed: 42, x: 4032, z: 960, drainage: true, basinId: 'basin:42:4032:960' },
  { seed: 4242, x: 5408, z: 48, drainage: true, basinId: 'basin:4242:5408:48' },
  { seed: 2, x: 3436, z: 412, regional: true, basinId: 'basin:2:3528:488' },
  { seed: 20260612, x: 2736, z: 3216, network: true, riverCharacter: true },
  { seed: 42, x: 4032, z: 960, drainage: true, lakeTransitions: true,
    riverCharacter: true, riverMeanders: true, riverMorphology: true, basinId: 'basin:42:4032:960' },
  { seed: 20260612, x: 2736, z: 3216, network: true, riverCharacter: true, riverMeanders: true },
  { seed: 20260612, x: 2736, z: 3216, network: true, riverCharacter: true, riverMeanders: true, riverMorphology: true },
  { seed: 42, x: 2052, z: 3555, regional: true, creek: true },
  { seed: 20260612, x: 0, z: 0, network: true, singleSource: true,
    riverCharacter: true, riverMeanders: true, riverMorphology: true },
  { seed: 20260612, x: -3328, z: -768, regional: true, trunk: true },
  { seed: 42, x: 1280, z: 3840, regional: true, trunk: true },
  { seed: 4242, x: 5408, z: 48, regional: true, basinId: 'basin:4242:5408:48' },
];
const selectedFixture = Number(new URLSearchParams(location.search).get('fixture'));
if (Number.isInteger(selectedFixture) && selectedFixture >= 0 && selectedFixture < fixtures.length) document.querySelector('#section').value = String(selectedFixture);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b7d2df');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 8000);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xe5f4ff, 0x66764e, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(-80, 180, -100); scene.add(sun);
const groundMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
const plainWater = new THREE.MeshStandardMaterial({ color: '#26b6c7', roughness: 0.5, side: THREE.DoubleSide });
const borderMaterial = new THREE.LineBasicMaterial({ color: '#e3ae5e' });
waterUniforms.uSkyHorizon.value.set('#b7d2df');
waterUniforms.uSkyZenith.value.set('#598cad');
waterUniforms.uFogColor.value.set('#b7d2df');
waterUniforms.uFogNear.value = 1000;
waterUniforms.uFogFar.value = 2000;
const group = new THREE.Group(); scene.add(group);
const scenery = new THREE.Group(); scene.add(scenery);
const creekScenery = new THREE.Group(); scene.add(creekScenery);
let vegetationLibrary;
const lakeReflection = new LakeReflection();
plainWater.userData.waterSurface = true;
waterUniforms.uSunDir.value.copy(sun.position).normalize();
let current, world, ocean;
const waters = [];
document.querySelector('#plan-review').onclick = async () => {
  const output = document.querySelector('#plan-stats');
  try {
    const response = await fetch('/__trailer_capture__/water-plan-review.json', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        plans: world.waterField?.plans, stats: document.querySelector('#stats').textContent,
      }) });
    if (!response.ok) throw new Error('Use the local serve.py preview to save a plan inspection.');
    const result = await response.json(); output.textContent = `Saved ${result.file}`;
  } catch (error) { output.textContent = error.message; }
};
document.querySelector('#network-view').onclick = () => {
  if (!waters.length) return;
  const bounds = new THREE.Box3();
  for (const mesh of waters) {
    mesh.geometry.computeBoundingBox(); bounds.union(mesh.geometry.boundingBox);
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z, 160);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(span * 0.15, span * 0.9, span * 0.65));
  controls.update();
};
document.querySelector('#capture-view').onclick = async () => {
  const output = document.querySelector('#capture-stats');
  const name = document.querySelector('#capture-name').value;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) { output.textContent = 'Use lowercase letters, numbers and hyphens.'; return; }
  renderer.render(scene, camera);
  const canvas = document.createElement('canvas');
  canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(renderer.domElement, 0, 0);
  ctx.fillStyle = 'rgba(22, 38, 42, 0.9)'; ctx.fillRect(0, canvas.height - 72, canvas.width, 72);
  ctx.fillStyle = '#fff'; ctx.font = `${Math.max(13, canvas.width / 95)}px sans-serif`;
  ctx.fillText(`${name} · ${document.querySelector('#section').selectedOptions[0].textContent}`, 16, canvas.height - 45);
  ctx.fillText(document.querySelector('#stats').textContent.slice(0, 185), 16, canvas.height - 22);
  try {
    const response = await fetch(`/__trailer_capture__/${name}.json`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        image: canvas.toDataURL('image/jpeg', 0.92), stats: document.querySelector('#stats').textContent,
        renderStats: document.querySelector('#render-stats').textContent,
        camera: camera.position.toArray(), target: controls.target.toArray(),
      }) });
    if (!response.ok) throw new Error('Use the local serve.py preview to save images.');
    const result = await response.json(); output.textContent = `Saved ${result.file}`;
  } catch (error) { output.textContent = error.message; }
};
document.querySelector('#gpu-benchmark').onclick = async () => {
  const button = document.querySelector('#gpu-benchmark'), output = document.querySelector('#gpu-stats');
  const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) { output.textContent = 'GPU timing is unavailable in this browser.'; return; }
  const previousMaterials = waters.map(mesh => mesh.material);
  const oceanIncluded = !!ocean?.mesh.visible, previousOceanMaterial = ocean?.mesh.material;
  let originalOcean = null;
  button.disabled = true; output.textContent = 'Comparing original and current shaders on the same geometry…';
  try {
    const { riverMaterial: original } = await import('/trailer/raw/water-baseline-river.mjs');
    Object.assign(original.uniforms, waterUniforms);
    if (oceanIncluded) {
      const { WaterSystem: OriginalOcean } = await import('/trailer/raw/water-baseline-ocean.mjs');
      originalOcean = new OriginalOcean(new THREE.Scene(), world);
      Object.assign(originalOcean.uniforms, ocean.uniforms);
    }
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const samples = { original: [], current: [] };
    for (let i = 0; i < 48; i++) {
      const name = Math.floor(i / 4) % 2 ? 'current' : 'original';
      for (const mesh of waters) mesh.material = name === 'original' ? original : riverMaterial;
      if (oceanIncluded) ocean.mesh.material = name === 'original' ? originalOcean.mesh.material : previousOceanMaterial;
      // Warm the selected program before timing a complete scene render.
      renderer.render(scene, camera); await nextFrame();
      const query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      renderer.render(scene, camera); gl.endQuery(ext.TIME_ELAPSED_EXT);
      while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) await nextFrame();
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) throw new Error('GPU timing was interrupted; repeat the comparison.');
      samples[name].push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(query);
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const result = { originalMs: median(samples.original), currentMs: median(samples.current), samples,
      stats: document.querySelector('#stats').textContent, camera: camera.position.toArray(), oceanIncluded };
    result.changePercent = (result.currentMs / result.originalMs - 1) * 100;
    output.textContent = `GPU scene median: original ${result.originalMs.toFixed(3)} ms → current ${result.currentMs.toFixed(3)} ms (${result.changePercent.toFixed(1)}%)`;
    await fetch('/__trailer_capture__/water-gpu-review.json', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
  } catch (error) { output.textContent = error.message; }
  finally {
    waters.forEach((mesh, i) => mesh.material = previousMaterials[i]);
    if (oceanIncluded) ocean.mesh.material = previousOceanMaterial;
    if (originalOcean) {
      originalOcean.mesh.geometry.dispose(); originalOcean.mesh.material.dispose();
      originalOcean.tex.dispose(); originalOcean.coarseTex.dispose();
    }
    button.disabled = false;
  }
};
function meshGeometry(data, river = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (river) {
    geometry.setAttribute('aWet', new THREE.BufferAttribute(data.wet, 1));
    geometry.setAttribute('aFlow', new THREE.BufferAttribute(data.flow, 2));
    if (data.body) geometry.setAttribute('aBody', new THREE.BufferAttribute(data.body, 4));
    geometry.computeVertexNormals();
  } else {
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  }
  return geometry;
}
function view(bank = false, along = false) {
  let { x, z } = current;
  // The original failure coordinate can become dry when its water level is
  // corrected. Aim at the nearest wet point so the bank camera still inspects
  // the river, instead of staring into newly restored ground.
  if (bank && !world.riverAt(x, z).wet) {
    let nearest = Infinity;
    for (let dz = -80; dz <= 80; dz += 4) for (let dx = -80; dx <= 80; dx += 4) {
      const distance = Math.hypot(dx, dz);
      if (distance < nearest && world.riverAt(current.x + dx, current.z + dz).wet) {
        nearest = distance; x = current.x + dx; z = current.z + dz;
      }
    }
  }
  const y = bank ? world.riverAt(x, z).y : world.height(x, z);
  controls.target.set(x, y, z);
  if (bank) {
    if (current.basin || current.reach || current.junction || current.network || current.drainage || current.regional) {
      let closest = null;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
        for (let d = 4; d <= 400; d += 2) {
          const bx = x + Math.cos(angle) * d, bz = z + Math.sin(angle) * d;
          if (!world.riverAt(bx, bz).wet && world.height(bx, bz) > y + 0.2) {
            if (!closest || d < closest.d) closest = { x: bx, z: bz, d };
            break;
          }
        }
      }
      if (closest) {
        camera.position.set(closest.x, world.height(closest.x, closest.z) + 1.7, closest.z);
        if (along && Number.isFinite(current.tangentX)) {
          controls.target.set(x + current.tangentX * 30, y, z + current.tangentZ * 30);
        }
        controls.update(); return;
      }
    }
    // Stand at the nearest containing bank, looking across the channel.
    const gx = world._riverSignalAt(x + 2, z) - world._riverSignalAt(x - 2, z);
    const gz = world._riverSignalAt(x, z + 2) - world._riverSignalAt(x, z - 2);
    const length = Math.hypot(gx, gz) || 1;
    let bx = x, bz = z;
    for (let d = 4; d <= 120; d += 2) {
      bx = x + gx / length * d; bz = z + gz / length * d;
      if (!world.riverAt(bx, bz).wet && world.height(bx, bz) > y + 0.2) break;
    }
    camera.position.set(bx, world.height(bx, bz) + 1.7, bz);
  } else if (current.creek) camera.position.set(x + 28, y + 36, z + 40);
  else if (current.regional) camera.position.set(x + 170, y + 250, z + 290);
  else if (current.riverMorphology) camera.position.set(x + 45, y + 75, z + 85);
  else camera.position.set(x + 85, y + 120, z + 145);
  controls.update();
}
const geometryWorker = new Worker(new URL('./worker.js?v=hydrology3', import.meta.url), { type: 'module' });
const pending = new Map();
let nextJob = 0, generation = 0, auditWorker = null, outletWorker = null;
geometryWorker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.type === 'built') request.resolve(data);
  else request.reject(new Error(data.error || 'Geometry worker failed'));
};
geometryWorker.onerror = error => {
  for (const request of pending.values()) request.reject(new Error(error.message));
  pending.clear();
};
let basinPlans = null;
async function prepareBasins() {
  if (basinPlans) return basinPlans;
  basinPlans = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology13', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.type === 'basins-planned') resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
    worker.postMessage({ type: 'plan-basins', id: 1, seed: 20260612, regionX: 0, regionZ: 0 });
  });
  return basinPlans;
}
async function prepareReach(fixture) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology13', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (['reach-planned', 'junction-planned', 'network-preview-planned', 'basin-drainage-planned', 'regional-preview-planned'].includes(data.type)) resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
    worker.postMessage({ type: fixture.regional ? 'plan-regional-preview' : fixture.drainage ? 'plan-basin-drainage-preview' : fixture.network ? 'plan-network-preview' : fixture.junction ? 'plan-junction-preview' : 'plan-reach-preview', id: 1,
      regionX: Math.floor(fixture.x / 4096), regionZ: Math.floor(fixture.z / 4096),
      seed: fixture.seed, basinId: fixture.basinId, riverCharacter: !!fixture.riverCharacter,
      creek: !!fixture.creek,
      trunk: !!fixture.trunk,
      singleSource: !!fixture.singleSource,
      riverMeanders: !!fixture.riverMeanders,
      riverMorphology: !!fixture.riverMorphology,
      lakeTransitions: !!fixture.lakeTransitions,
      x: (fixture.junction || fixture.regional) ? fixture.x : fixture.sourceX, z: (fixture.junction || fixture.regional) ? fixture.z : fixture.sourceZ });
  });
}
async function rebuild() {
  const token = ++generation;
  if (outletWorker) { outletWorker.terminate(); outletWorker = null; }
  document.querySelector('#outlets').disabled = false;
  document.querySelector('#outlet-stats').textContent = '';
  if (auditWorker) { auditWorker.terminate(); auditWorker = null; }
  document.querySelector('#audit').disabled = false;
  document.querySelector('#audit-stats').textContent = '';
  const fixture = fixtures[Number(document.querySelector('#section').value)];
  const url = new URL(location.href); url.searchParams.set('fixture', document.querySelector('#section').value); history.replaceState(null, '', url);
  document.querySelector('#stats').textContent = 'Planning terrain and water…';
  try {
    const basinData = fixture.basin ? await prepareBasins() : (fixture.reach || fixture.junction || fixture.network || fixture.drainage || fixture.regional) ? await prepareReach(fixture) : null;
    if (generation !== token) return;
    const candidateWorld = new World(fixture.seed, { waterPlans: basinData ? [basinData.plan] : null,
      crossingManifests: basinData?.manifest ? [basinData.manifest] : [] });
    const res = Number(document.querySelector('#resolution').value);
    const target = basinData?.target || fixture;
    const cx = Math.floor(target.x / 140), cz = Math.floor(target.z / 140);
    geometryWorker.postMessage({ type: 'init', seed: fixture.seed, waterPlans: candidateWorld.waterField?.plans || null,
      crossingManifests: basinData?.manifest ? [basinData.manifest] : null });
    const tasks = [];
    const radius = fixture.trunk ? 8 : fixture.network || fixture.drainage || fixture.regional ? 5 : 1;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      tasks.push(new Promise((resolve, reject) => {
        const id = ++nextJob;
        pending.set(id, { resolve, reject });
        geometryWorker.postMessage({ type: 'build', id, cx: cx + dx, cz: cz + dz, res, chunkSize: 140,
          doClutter: (!!fixture.creek || !!fixture.trunk) && Math.abs(dx) <= 2 && Math.abs(dz) <= 2,
          doTerrain: true, treeMode: Math.abs(dx) <= 1 && Math.abs(dz) <= 1 ? 'full' : null, treeDensityScale: 0.5, waterPlanHash: candidateWorld.waterPlanHash || null });
      }));
    }
    const chunks = await Promise.all(tasks);
    if (generation !== token) return;
    // Publish complete terrain and water in the same frame. Keep the previous
    // complete scene visible while the next fixture is being prepared.
    for (const child of [...group.children]) { child.geometry.dispose(); group.remove(child); }
    for (const child of [...scenery.children]) { child.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); scenery.remove(child); }
    for (const child of [...creekScenery.children]) {
      child.traverse(o => o.geometry?.dispose()); creekScenery.remove(child);
    }
    vegetationLibrary ||= createVegetationLibrary();
    waters.length = 0;
    current = { ...fixture, x: target.x, z: target.z }; world = candidateWorld;
    if (ocean) { ocean.resetRegion(world); ocean.mesh.visible = false; }
    let waterTriangles = 0;
    for (const { cx: ix, cz: iz, terrain, river, scatter, coastal, brooks } of chunks) {
      group.add(new THREE.Mesh(meshGeometry(terrain), groundMaterial));
      if (scatter) scenery.add(buildScatterGroup(vegetationLibrary, scatter, { shadows: false, coastal }));
      if (brooks) {
        creekScenery.add(buildBrookGroup(brooks));
        waterTriangles += (brooks.ribbon?.indices.length || 0) / 3;
      }
      if (river) {
        const mesh = new THREE.Mesh(meshGeometry(river, true), plainWater);
        mesh.renderOrder = 1; group.add(mesh); waters.push(mesh);
        waterTriangles += river.indices.length / 3;
      }
      const line = [], actualRes = terrain.res;
      for (const [ax, az, bx, bz] of [[0,0,140,0],[140,0,140,140],[140,140,0,140],[0,140,0,0]]) {
        for (let j=0;j<actualRes;j++) for (const t of [j/actualRes,(j+1)/actualRes]) {
          const x=ix*140+ax+(bx-ax)*t, z=iz*140+az+(bz-az)*t;
          line.push(x,world.height(x,z)+0.04,z);
        }
      }
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(line,3)),borderMaterial);
      lines.visible = document.querySelector('#borders').checked; group.add(lines);
    }
    document.querySelector('#stats').textContent = `${waterTriangles.toLocaleString()} water triangles · actual geometry workers · (${current.x}, ${current.z})`
      + (basinData ? ` · ${world.riverAt(current.x, current.z).kind} · plan ${basinData.plan.hash} · ${fixture.regional ? `${basinData.basinCount} connected basins; ${basinData.inletCount} incoming stream${basinData.inletCount === 1 ? '' : 's'}; regional generation` : fixture.drainage ? `${basinData.basinKind}; ${basinData.inletCount || 0} inlet${basinData.inletCount === 1 ? '' : 's'}; ${Math.round(basinData.outletLength)} m outlet to sea; development preview` : fixture.network ? `${basinData.sourceCount} sources; ${basinData.junctionCount} joins; ocean outlet` : fixture.junction ? 'joined junction; short inspection arms' : fixture.reach ? 'fresh river terrain; crossings regenerate' : 'legacy comparison preview'}` : '');
    if (basinData?.widthRange) document.querySelector('#stats').textContent +=
      ` · channel widths ${basinData.widthRange.min.toFixed(1)}–${basinData.widthRange.max.toFixed(1)} m · contribution-based character preview`;
    if (basinData?.trunk) document.querySelector('#stats').textContent +=
      ` · ${(basinData.trunk.length / 1000).toFixed(2)} km regional trunk · sinuosity ${basinData.trunk.sinuosity.toFixed(2)}`
      + ` · ${basinData.trunk.tributaries?.accepted || 0} feeding tributaries · ${basinData.trunk.delta?.arms || 1} delta arms`;
    if (basinData?.contactCount !== undefined) document.querySelector('#stats').textContent +=
      ` · ${basinData.contactCount} lake contacts with current transitions`;
    if (basinData?.meanders) document.querySelector('#stats').textContent +=
      ` · meanders ${basinData.meanders.status}` + (basinData.meanders.changedReaches
        ? `; ${basinData.meanders.changedReaches} reshaped reaches; ${basinData.meanders.maxExcursion.toFixed(1)} m bend excursion` : '');
    const inspection = basinData?.channelInspection;
    const channelViews = document.querySelector('#channel-views');
    channelViews.replaceChildren(); channelViews.hidden = !inspection;
    if (fixture.creek) {
      const creeks = brooksForCell(world, 4, 8).filter(b => b.drainage);
      if (creeks.length) {
        const creek = creeks[0], receiver = creek.drainage.receiver;
        channelViews.hidden = false;
        for (const target of [{ label: 'Forest creek', x: creek.pts[0], z: creek.pts[2] },
          { label: 'Creek joins tributary', x: receiver.x, z: receiver.z }]) {
          const button = document.createElement('button'); button.textContent = target.label;
          button.onclick = () => { current = { ...current, ...target }; view(); };
          channelViews.append(button);
        }
        document.querySelector('#stats').textContent += ` · ${creek.length.toFixed(0)} m forest creek → ${receiver.kind}`;
      }
    }
    if (inspection) {
      if (fixture.trunk) {
        const button = document.createElement('button'); button.textContent = 'Mountain viewpoint';
        button.onclick = () => {
          const target = inspection.views.find(v => v.kind === 'downstream') || current;
          const y = world.riverAt(target.x, target.z).y;
          const candidates = [];
          for (let dz = -1000; dz <= 1000; dz += 80) for (let dx = -1000; dx <= 1000; dx += 80) {
            const distance = Math.hypot(dx, dz); if (distance < 450 || distance > 1150) continue;
            // Sample an actual shared terrain vertex (4m water / 10m dry
            // grids). Arbitrary eye coordinates can sit below a coarse face.
            const x = Math.round((target.x + dx) / 20) * 20;
            const z = Math.round((target.z + dz) / 20) * 20, h = world.height(x, z);
            if (h < y + 55) continue;
            let visible = true;
            for (let s = 40; s < distance - 40; s += 40) {
              const t = s / distance;
              if (world.height(x - dx * t, z - dz * t) > h + 1.7 + (y - h - 1.7) * t + 1) { visible = false; break; }
            }
            const score = (h - y) / Math.sqrt(distance);
            if (visible) candidates.push({ x, z, h, score });
          }
          const terrain = group.children.filter(mesh => mesh.material === groundMaterial);
          const ray = new THREE.Raycaster(), aim = new THREE.Vector3(target.x, y, target.z);
          let best = null;
          for (const candidate of candidates.sort((a, b) => b.score - a.score).slice(0, 24)) {
            ray.set(new THREE.Vector3(candidate.x, 5000, candidate.z), new THREE.Vector3(0, -1, 0));
            const ground = ray.intersectObjects(terrain, false)[0];
            if (!ground) continue;
            const eye = ground.point.clone(); eye.y += 1.7;
            const direction = aim.clone().sub(eye), distance = direction.length();
            ray.set(eye, direction.normalize());
            const obstruction = ray.intersectObjects(terrain, false)[0];
            if (obstruction && obstruction.distance < distance - 40) continue;
            best = { ...candidate, h: ground.point.y }; break;
          }
          if (best) {
            camera.position.set(best.x, best.h + 1.7, best.z);
            controls.target.set(target.x, y, target.z); controls.update();
          }
        };
        channelViews.append(button);
        // Fixed regression location from the production trail solver on the
        // default regional fixture, also checked by regionaltrailcrossings.
        if (fixture.seed === 20260612) {
          const crossing = document.createElement('button'); crossing.textContent = 'River crossing';
          crossing.onclick = () => {
            const target = { x: -3977.744, z: 3.090 };
            current = { ...current, ...target };
            const y = world.riverAt(target.x, target.z).y;
            camera.position.set(target.x + 135, y + 80, target.z + 140);
            controls.target.set(target.x, y, target.z); controls.update();
          };
          channelViews.append(crossing);
        }
      }
      for (const target of inspection.views) {
        const button = document.createElement('button');
        button.textContent = target.label;
        button.onclick = () => {
          current = { ...current, ...target }; view();
          if (target.kind === 'mouth' || target.kind === 'delta') {
            ocean ||= new WaterSystem(scene, world);
            ocean.mesh.visible = true;
            if (target.kind === 'delta') {
              const points = [target, ...(target.outlets || [])];
              const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
              const z = points.reduce((sum, p) => sum + p.z, 0) / points.length;
              const radius = Math.max(...points.map(p => Math.hypot(p.x - x, p.z - z)));
              const distance = Math.max(440, radius * 2.4);
              camera.position.set(x + distance * 0.45, distance * 0.9, z + distance * 0.85);
              controls.target.set(x, 0, z);
            } else {
              camera.position.set(target.x + 35, world.height(target.x, target.z) + 12, target.z + 50);
              controls.target.set(target.x, 0, target.z);
            }
            controls.update();
          }
        };
        channelViews.append(button);
      }
      const bendView = inspection.views.find(target => target.kind === 'bend');
      if (bendView) {
        const button = document.createElement('button');
        button.textContent = 'Along the bend';
        button.onclick = () => { current = { ...current, ...bendView }; view(true, true); };
        channelViews.append(button);
      }
      if (inspection.growthRatio !== null) document.querySelector('#stats').textContent +=
        ` · mean headwater ${inspection.headwaterMeanWidth.toFixed(1)} m → downstream ${inspection.downstreamMeanWidth.toFixed(1)} m (${inspection.growthRatio.toFixed(1)}×)`;
    }
    if (fixture.basin || fixture.reach || fixture.junction || fixture.network || fixture.drainage || fixture.regional) document.querySelector('#material').checked = true;
    material(); view();
  } catch (error) {
    if (generation === token) document.querySelector('#stats').textContent = `Build rejected: ${error.message}`;
    console.error(error);
  }
}

function material() { for (const mesh of waters) mesh.material = document.querySelector('#material').checked ? riverMaterial : plainWater; }
document.querySelector('#outlets').onclick = () => {
  const fixture = fixtures[Number(document.querySelector('#section').value)];
  const button = document.querySelector('#outlets'), output = document.querySelector('#outlet-stats');
  button.disabled = true; output.textContent = 'Following basin spill routes…';
  const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology8', import.meta.url), { type: 'module' });
  outletWorker = worker;
  const complete = () => { worker.terminate(); outletWorker = null; button.disabled = false; };
  worker.onmessage = ({ data }) => {
    if (outletWorker !== worker) return;
    complete();
    if (data.type !== 'basin-outlets-surveyed') { output.textContent = `Survey failed: ${data.error}`; return; }
    const title = document.createElement('p');
    title.textContent = `Fresh region (${data.report.regionX}, ${data.report.regionZ}): `
      + `${data.report.outlets.filter(o => o.status === 'candidate').length} candidate outlets. `
      + 'Planning only; lake/river connections are not activated.';
    const rows = data.report.outlets.map(outlet => {
      const row = document.createElement('p');
      row.textContent = `${outlet.basinId}: ` + (outlet.status === 'candidate'
        ? `${outlet.downstream.arc.toFixed(0)} m sill route; at least ${outlet.minimumCut.toFixed(2)} m excavation; `
          + `${(outlet.level - outlet.downstream.waterY).toFixed(2)} m water-level drop. `
          + `Banks: ${outlet.bankFit.status === 'fitted' ? 'fitted' : (outlet.bankFit.reason || outlet.bankFit.status).replaceAll('-', ' ')}.`
        : outlet.reason.replaceAll('-', ' '));
      return row;
    });
    output.replaceChildren(title, ...rows);
  };
  worker.onerror = error => {
    if (outletWorker !== worker) return;
    complete(); output.textContent = `Survey failed: ${error.message}`;
  };
  worker.postMessage({ type: 'survey-basin-outlets', id: 1, seed: fixture.seed,
    regionX: Math.floor(fixture.x / 4096), regionZ: Math.floor(fixture.z / 4096) });
};
document.querySelector('#audit').onclick = () => {
  const fixture = fixtures[Number(document.querySelector('#section').value)];
  const button = document.querySelector('#audit'), output = document.querySelector('#audit-stats');
  button.disabled = true;
  output.textContent = 'Checking preserved water levels and approach support…';
  const worker = new Worker(new URL('./hydrologyworker.js?v=hydrology5', import.meta.url), { type: 'module' });
  auditWorker = worker;
  const complete = () => { worker.terminate(); auditWorker = null; button.disabled = false; };
  worker.onmessage = ({ data }) => {
    if (auditWorker !== worker) return;
    complete();
    if (data.type !== 'migration-audited') { output.textContent = `Audit failed: ${data.error}`; return; }
    const report = data.report;
    const title = document.createElement('div');
    title.textContent = `Seed ${report.seed}, region (${report.regionX}, ${report.regionZ}): `
      + `${report.diagnostics.candidates} candidates, ${report.diagnostics.retained} retained. Full component migration remains pending.`;
    if (report.footprint) {
      const footprint = report.footprint;
      title.textContent += ` Legacy footprint: ${footprint.containment}, ${footprint.diagnostics.cells} cells surveyed.`
        + ` ${footprint.diagnostics.closedComponents} complete component boundaries; ${footprint.diagnostics.sourceExcludedCells} source-gated cells excluded.`
        + ` ${footprint.diagnostics.oceanTerminalCells} deep-ocean handoff cells.`
        + (footprint.containment === 'unresolved' ? ' Search budget reached; no complete boundary established.' : ' Replacement and crossing coverage still require validation.');
    }
    title.textContent += ` Drainage graph: ${report.diagnostics.componentCandidates} candidate components,`
      + ` ${report.diagnostics.componentRetained} retained.`;
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = 'Crossing results'; details.append(summary);
    for (const result of report.results) {
      const row = document.createElement('p');
      row.textContent = `${result.id}: ${(result.reason || result.status).replaceAll('-', ' ')}`;
      details.append(row);
    }
    const componentDetails = document.createElement('details'), componentSummary = document.createElement('summary');
    componentSummary.textContent = 'Drainage component results'; componentDetails.append(componentSummary);
    for (const component of report.components) {
      const row = document.createElement('p');
      row.textContent = `${component.crossingIds.length} crossing${component.crossingIds.length === 1 ? '' : 's'}: `
        + `${(component.reason || component.status).replaceAll('-', ' ')}`;
      row.title = component.crossingIds.join('\n'); componentDetails.append(row);
    }
    output.replaceChildren(title, details, componentDetails);
  };
  worker.onerror = error => {
    if (auditWorker !== worker) return;
    complete(); output.textContent = `Audit failed: ${error.message}`;
  };
  worker.postMessage({ type: 'audit-migration', id: 1, seed: fixture.seed,
    regionX: Math.floor(fixture.x / 4096), regionZ: Math.floor(fixture.z / 4096) });
};
document.querySelector('#section').onchange = rebuild;
document.querySelector('#resolution').onchange = rebuild;
document.querySelector('#overview').onclick = () => view();
document.querySelector('#bank').onclick = () => view(true);
document.querySelector('#wire').onchange = e => { groundMaterial.wireframe = e.target.checked; };
document.querySelector('#material').onchange = material;
document.querySelector('#scenery').onchange = e => { scenery.visible = e.target.checked; };
document.querySelector('#borders').onchange = e => { for (const o of group.children) if (o.isLineSegments) o.visible = e.target.checked; };
document.querySelector('#panel-toggle').onclick = () => {
  const panel = document.querySelector('aside'); panel.hidden = !panel.hidden;
  document.querySelector('#panel-toggle').textContent = panel.hidden ? 'Show controls' : 'Hide controls';
};
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
rebuild();
let previousTime = 0, timingFrames = 0, timingStart = 0;
renderer.setAnimationLoop(time => {
  const dt = Math.min(0.1, (time - previousTime) / 1000); previousTime = time;
  waterUniforms.uTime.value = time / 1000;
  if (world) lakeReflection.update(renderer, scene, camera, world, dt);
  if (ocean?.mesh.visible) ocean.update(dt, camera.position);
  renderer.render(scene, camera);
  timingFrames++;
  if (time - timingStart > 1000) {
    document.querySelector('#render-stats').textContent = `${Math.round(timingFrames * 1000 / (time - timingStart))} fps`
      + (waterUniforms.uLakeReflectionReady.value ? ` · shoreline reflection · ${lakeReflection.cost.toFixed(1)} ms CPU submit` : '');
    timingStart = time; timingFrames = 0;
  }
});
