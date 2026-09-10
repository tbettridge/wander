import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world.js?v=riverbanks2';
import { buildTerrainArrays, buildRiver } from './chunkgen.js?v=riverbanks2';
import { riverMaterial } from './river.js';
import { waterUniforms } from './watercommon.js';

const fixtures = [
  { seed: 20260612, x: -550, z: -960 },
  { seed: 20260612, x: -920, z: -960 },
  { seed: 4242, x: 640, z: -800 },
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
function rebuild() {
  for (const child of [...group.children]) { child.geometry.dispose(); group.remove(child); }
  waters.length = 0;
  current = fixtures[Number(document.querySelector('#section').value)];
  world = new World(current.seed);
  const res = Number(document.querySelector('#resolution').value);
  const cx = Math.floor(current.x / 140), cz = Math.floor(current.z / 140);
  let waterTriangles = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const ix = cx + dx, iz = cz + dz;
    const terrain = buildTerrainArrays(world, ix, iz, res, 140);
    group.add(new THREE.Mesh(meshGeometry(terrain), groundMaterial));
    const river = buildRiver(ix, iz, res, 140, terrain.river);
    if (river) {
      const mesh = new THREE.Mesh(meshGeometry(river, true), plainWater);
      mesh.renderOrder = 1; group.add(mesh); waters.push(mesh);
      waterTriangles += river.indices.length / 3;
    }
    const line = [];
    for (const [ax, az, bx, bz] of [[0,0,140,0],[140,0,140,140],[140,140,0,140],[0,140,0,0]]) {
      for (let j=0;j<res;j++) for (const t of [j/res,(j+1)/res]) {
        const x=ix*140+ax+(bx-ax)*t, z=iz*140+az+(bz-az)*t;
        line.push(x,world.height(x,z)+0.04,z);
      }
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(line,3)),borderMaterial));
  }
  document.querySelector('#stats').textContent = `${waterTriangles.toLocaleString()} water triangles · nine 140m chunks · (${current.x}, ${current.z})`;
  material(); view();
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
