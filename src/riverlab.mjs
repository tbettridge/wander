import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world.js?v=hydrology4';

import { riverMaterial } from './river.js?v=hydrology3';
import { createVegetationLibrary, buildScatterGroup } from './vegetation.js';
import { LakeReflection } from './waterreflection.js';
import { waterUniforms } from './watercommon.js';

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
  { seed: 42, x: 4032, z: 960, drainage: true, lakeTransitions: true, basinId: 'basin:42:4032:960' },
  { seed: 20260612, x: 2736, z: 3216, network: true, riverCharacter: true, riverMeanders: true },
  { seed: 20260612, x: 2736, z: 3216, network: true, riverCharacter: true, riverMeanders: true, riverMorphology: true },
];
const selectedFixture = Number(new URLSearchParams(location.search).get('fixture'));
if (Number.isInteger(selectedFixture) && selectedFixture >= 0 && selectedFixture < fixtures.length) document.querySelector('#section').value = String(selectedFixture);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b7d2df');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);
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
let vegetationLibrary;
const lakeReflection = new LakeReflection();
plainWater.userData.waterSurface = true;
waterUniforms.uSunDir.value.copy(sun.position).normalize();
let current, world;
const waters = [];
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
  } else if (current.regional) camera.position.set(x + 170, y + 250, z + 290);
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
    const radius = fixture.network || fixture.drainage || fixture.regional ? 5 : 1;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      tasks.push(new Promise((resolve, reject) => {
        const id = ++nextJob;
        pending.set(id, { resolve, reject });
        geometryWorker.postMessage({ type: 'build', id, cx: cx + dx, cz: cz + dz, res, chunkSize: 140,
          doTerrain: true, treeMode: Math.abs(dx) <= 1 && Math.abs(dz) <= 1 ? 'full' : null, treeDensityScale: 0.5, waterPlanHash: candidateWorld.waterPlanHash || null });
      }));
    }
    const chunks = await Promise.all(tasks);
    if (generation !== token) return;
    // Publish complete terrain and water in the same frame. Keep the previous
    // complete scene visible while the next fixture is being prepared.
    for (const child of [...group.children]) { child.geometry.dispose(); group.remove(child); }
    for (const child of [...scenery.children]) { child.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); scenery.remove(child); }
    vegetationLibrary ||= createVegetationLibrary();
    waters.length = 0;
    current = { ...fixture, x: target.x, z: target.z }; world = candidateWorld;
    let waterTriangles = 0;
    for (const { cx: ix, cz: iz, terrain, river, scatter, coastal } of chunks) {
      group.add(new THREE.Mesh(meshGeometry(terrain), groundMaterial));
      if (scatter) scenery.add(buildScatterGroup(vegetationLibrary, scatter, { shadows: false, coastal }));
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
    if (basinData?.contactCount !== undefined) document.querySelector('#stats').textContent +=
      ` · ${basinData.contactCount} lake contacts with current transitions`;
    if (basinData?.meanders) document.querySelector('#stats').textContent +=
      ` · meanders ${basinData.meanders.status}` + (basinData.meanders.changedReaches
        ? `; ${basinData.meanders.changedReaches} reshaped reaches; ${basinData.meanders.maxExcursion.toFixed(1)} m bend excursion` : '');
    const inspection = basinData?.channelInspection;
    const channelViews = document.querySelector('#channel-views');
    channelViews.replaceChildren(); channelViews.hidden = !inspection;
    if (inspection) {
      for (const target of inspection.views) {
        const button = document.createElement('button');
        button.textContent = target.label;
        button.onclick = () => { current = { ...current, ...target }; view(); };
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
  renderer.render(scene, camera);
  timingFrames++;
  if (time - timingStart > 1000) {
    document.querySelector('#render-stats').textContent = `${Math.round(timingFrames * 1000 / (time - timingStart))} fps`
      + (waterUniforms.uLakeReflectionReady.value ? ` · shoreline reflection · ${lakeReflection.cost.toFixed(1)} ms CPU submit` : '');
    timingStart = time; timingFrames = 0;
  }
});
