import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world.js?v=hydrology3';

import { riverMaterial } from './river.js?v=hydrology3';
import { waterUniforms } from './watercommon.js';

const fixtures = [
  { seed: 20260612, x: -550, z: -960 },
  { seed: 20260612, x: -920, z: -960 },
  { seed: 4242, x: 640, z: -800 },
  { seed: 20260612, x: 2912, z: 1904, basin: true },
  { seed: 20260612, x: 536, z: 2680, basin: true },
  { seed: 20260612, x: -1847, z: -2191, reach: true, sourceX: -2000, sourceZ: -2200 },
];
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
function view(bank = false) {
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
    if (current.basin || current.reach) {
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
  } else camera.position.set(x + 85, y + 120, z + 145);
  controls.update();
}
const geometryWorker = new Worker(new URL('./worker.js?v=hydrology3', import.meta.url), { type: 'module' });
const pending = new Map();
let nextJob = 0, generation = 0;
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
    const worker = new Worker(new URL('./hydrologyworker.js', import.meta.url), { type: 'module' });
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
    const worker = new Worker(new URL('./hydrologyworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.type === 'reach-planned') resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
    worker.postMessage({ type: 'plan-reach-preview', id: 1, seed: fixture.seed, x: fixture.sourceX, z: fixture.sourceZ });
  });
}
async function rebuild() {
  const token = ++generation;
  const fixture = fixtures[Number(document.querySelector('#section').value)];
  document.querySelector('#stats').textContent = 'Planning terrain and water…';
  try {
    const basinData = fixture.basin ? await prepareBasins() : fixture.reach ? await prepareReach(fixture) : null;
    if (generation !== token) return;
    const candidateWorld = new World(fixture.seed, { waterPlans: basinData ? [basinData.plan] : null,
      crossingManifests: basinData?.manifest ? [basinData.manifest] : [] });
    const res = Number(document.querySelector('#resolution').value);
    const cx = Math.floor(fixture.x / 140), cz = Math.floor(fixture.z / 140);
    geometryWorker.postMessage({ type: 'init', seed: fixture.seed, waterPlans: candidateWorld.waterField?.plans || null,
      crossingManifests: basinData?.manifest ? [basinData.manifest] : null });
    const tasks = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      tasks.push(new Promise((resolve, reject) => {
        const id = ++nextJob;
        pending.set(id, { resolve, reject });
        geometryWorker.postMessage({ type: 'build', id, cx: cx + dx, cz: cz + dz, res, chunkSize: 140,
          doTerrain: true, waterPlanHash: candidateWorld.waterPlanHash || null });
      }));
    }
    const chunks = await Promise.all(tasks);
    if (generation !== token) return;
    // Publish complete terrain and water in the same frame. Keep the previous
    // complete scene visible while the next fixture is being prepared.
    for (const child of [...group.children]) { child.geometry.dispose(); group.remove(child); }
    waters.length = 0;
    current = fixture; world = candidateWorld;
    let waterTriangles = 0;
    for (const { cx: ix, cz: iz, terrain, river } of chunks) {
      group.add(new THREE.Mesh(meshGeometry(terrain), groundMaterial));
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
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(line,3)),borderMaterial));
    }
    document.querySelector('#stats').textContent = `${waterTriangles.toLocaleString()} water triangles · actual geometry workers · (${current.x}, ${current.z})`
      + (basinData ? ` · ${world.riverAt(current.x, current.z).kind} · plan ${basinData.plan.hash} · ${fixture.reach ? 'candidate only; migration pending' : 'existing crossings reserved'}` : '');
    if (fixture.basin || fixture.reach) document.querySelector('#material').checked = true;
    material(); view();
  } catch (error) {
    if (generation === token) document.querySelector('#stats').textContent = `Build rejected: ${error.message}`;
    console.error(error);
  }
}

function material() { for (const mesh of waters) mesh.material = document.querySelector('#material').checked ? riverMaterial : plainWater; }
document.querySelector('#section').onchange = rebuild;
document.querySelector('#resolution').onchange = rebuild;
document.querySelector('#overview').onclick = () => view();
document.querySelector('#bank').onclick = () => view(true);
document.querySelector('#wire').onchange = e => { groundMaterial.wireframe = e.target.checked; };
document.querySelector('#material').onchange = material;
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
rebuild();
renderer.setAnimationLoop(time => { waterUniforms.uTime.value = time / 1000; renderer.render(scene,camera); });
