import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { baseWorldHeight } from './railwayterrain.mjs';
import { LocomotiveSmoke } from './railsmoke.js';
import { RailwayAudio } from './railaudio.js';
import {
  TrainScheduleModel,
  TRAIN_PHASE,
  forwardGap,
  nameRegionalStations,
  occupiedCarriageLanternLevel,
  PASSENGER_HINT_SECONDS,
  RAILWAY_SERVICE_DEFAULTS,
  stepPassengerHintTimer,
  xrSeatOriginOffset,
} from './railservice.mjs';

// --- shared temporaries -------------------------------------------------------
const _sampleA = {};
const _sampleB = {};
const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _pos2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _door = new THREE.Vector3();
const _trainDir = new THREE.Vector3();
const _seatOffset = {};

const VEHICLE_LIFT = 0.36;          // wheels rest on the railhead above the formation
const CARRIAGE_SPACING = 8.9;       // metres between vehicle centres along the route
const BOARD_RANGE = 3.6;            // how close a door must be to prompt boarding
const XR_BOARD_RANGE = 6.0;         // cover either usable VR platform, including room-scale offset
const PLATFORM_APPROACH = 46;       // how near a station platform surfaces its arrival board
// Real seat anchors along both benches. The local yaw faces inward across the
// aisle; headset tracking remains free on top of this comfortable base pose.
const SEAT_LAYOUT = Object.freeze([
  Object.freeze({ label: 'left front', x: -0.84, z: 1.5, yaw: -Math.PI * 0.5 }),
  Object.freeze({ label: 'right front', x: 0.84, z: 1.5, yaw: Math.PI * 0.5 }),
  Object.freeze({ label: 'left rear', x: -0.84, z: -1.5, yaw: -Math.PI * 0.5 }),
  Object.freeze({ label: 'right rear', x: 0.84, z: -1.5, yaw: Math.PI * 0.5 }),
]);

// Generate a self-contained velvet colour/bump pair. The two diagonal distance
// fields form the quilt diamonds; a deterministic fibre grain and recessed
// buttons keep the result from reading as a flat printed pattern. Separate
// seat/back layouts fit the long rectangular faces without stretching.
function makeQuiltedVelvetMaps(width, height, columns, rows, name) {
  const colourCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colourCanvas.width = bumpCanvas.width = width;
  colourCanvas.height = bumpCanvas.height = height;
  const colour = colourCanvas.getContext('2d');
  const bump = bumpCanvas.getContext('2d');
  const colourImage = colour.createImageData(width, height);
  const bumpImage = bump.createImageData(width, height);

  const fract = (v) => v - Math.floor(v);
  const distanceToInteger = (v) => Math.abs(fract(v + 0.5) - 0.5);
  const smooth = (a, b, v) => {
    const t = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = x / width * columns;
      const gy = y / height * rows;
      const seamDistance = Math.min(
        distanceToInteger(gx + gy),
        distanceToInteger(gx - gy),
      );
      const seam = 1 - smooth(0.018, 0.082, seamDistance);
      const puff = smooth(0.035, 0.30, seamDistance);
      const ridge = Math.exp(-((seamDistance - 0.105) ** 2) / 0.0018);
      const hash = fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
      const nap = Math.sin((gx * 0.7 - gy * 0.45) * Math.PI) * 0.5 + 0.5;
      const grain = (hash - 0.5) * 5;
      const i = (y * width + x) * 4;

      colourImage.data[i] = THREE.MathUtils.clamp(48 + puff * 42 + ridge * 13 - seam * 20 + nap * 5 + grain, 0, 255);
      colourImage.data[i + 1] = THREE.MathUtils.clamp(4 + puff * 7 + ridge * 2 - seam * 3 + grain * 0.16, 0, 255);
      colourImage.data[i + 2] = THREE.MathUtils.clamp(12 + puff * 13 + ridge * 5 - seam * 5 + nap * 2 + grain * 0.32, 0, 255);
      colourImage.data[i + 3] = 255;

      const heightValue = THREE.MathUtils.clamp(74 + puff * 142 + ridge * 22 - seam * 62 + grain, 0, 255);
      bumpImage.data[i] = bumpImage.data[i + 1] = bumpImage.data[i + 2] = heightValue;
      bumpImage.data[i + 3] = 255;
    }
  }
  colour.putImageData(colourImage, 0, 0);
  bump.putImageData(bumpImage, 0, 0);

  // Tuft buttons sit at alternating diamond vertices. A radial depression in
  // both maps makes them remain visible under the carriage's moving light.
  const spacingX = width / columns;
  const spacingY = height / (rows * 2);
  for (let row = 0; row <= rows * 2; row++) {
    const y = row * spacingY;
    const offset = row % 2 ? spacingX * 0.5 : 0;
    for (let col = -1; col <= columns; col++) {
      const x = col * spacingX + offset;
      const radius = Math.max(2.5, Math.min(spacingX, spacingY) * 0.13);
      const velvetButton = colour.createRadialGradient(x, y, 0, x, y, radius);
      velvetButton.addColorStop(0, '#170007');
      velvetButton.addColorStop(0.34, '#31000d');
      velvetButton.addColorStop(1, 'rgba(49,0,13,0)');
      colour.fillStyle = velvetButton;
      colour.fillRect(x - radius, y - radius, radius * 2, radius * 2);

      const bumpButton = bump.createRadialGradient(x, y, 0, x, y, radius);
      bumpButton.addColorStop(0, '#171717');
      bumpButton.addColorStop(0.42, '#555555');
      bumpButton.addColorStop(1, 'rgba(120,120,120,0)');
      bump.fillStyle = bumpButton;
      bump.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }

  const map = new THREE.CanvasTexture(colourCanvas);
  map.name = `${name} colour`;
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.anisotropy = 4;
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.name = `${name} relief`;
  bumpMap.minFilter = THREE.LinearMipmapLinearFilter;
  bumpMap.magFilter = THREE.LinearFilter;
  bumpMap.anisotropy = 4;
  return { map, bumpMap };
}

function makeVelvetMaterial(name, textureSpec) {
  const maps = makeQuiltedVelvetMaps(...textureSpec, name);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: maps.map,
    bumpMap: maps.bumpMap,
    bumpScale: 0.018,
    roughness: 0.74,
    metalness: 0,
    sheen: 0.9,
    sheenColor: new THREE.Color(0x74162a),
    sheenRoughness: 0.62,
  });
  material.name = name;
  return material;
}

function makeMaterials() {
  return {
    chassis: new THREE.MeshStandardMaterial({ color: 0x1f2422, roughness: 0.8 }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: 0.6, metalness: 0.3 }),
    boiler: new THREE.MeshStandardMaterial({ color: 0x2e4a3a, roughness: 0.55, metalness: 0.2 }),
    smokebox: new THREE.MeshStandardMaterial({ color: 0x1d2021, roughness: 0.5, metalness: 0.35 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xa08040, roughness: 0.35, metalness: 0.7 }),
    // Buffer beam / wheel-centre red, and the pale lining that picks out the
    // boiler bands and smokebox joint.
    livery: new THREE.MeshStandardMaterial({ color: 0x94403a, roughness: 0.68 }),
    lining: new THREE.MeshStandardMaterial({ color: 0x9aa08c, roughness: 0.6, metalness: 0.25 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xffde9e, roughness: 0.5, emissive: 0xffbe5c, emissiveIntensity: 0.35,
    }),
    carriage: new THREE.MeshStandardMaterial({ color: 0x8a4030, roughness: 0.82 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x53291f, roughness: 0.85 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x2b2f31, roughness: 0.9 }),
    door: new THREE.MeshStandardMaterial({ color: 0x5f2f22, roughness: 0.8 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x6a5138, roughness: 0.95 }),
    bench: new THREE.MeshStandardMaterial({ color: 0x7c5a36, roughness: 0.9 }),
    velvetSeat: makeVelvetMaterial('Quilted burgundy velvet · seat', [192, 768, 2, 8]),
    velvetBack: makeVelvetMaterial('Quilted burgundy velvet · back', [768, 192, 8, 3]),
    lanternMetal: new THREE.MeshStandardMaterial({ color: 0x8a6a32, roughness: 0.38, metalness: 0.72 }),
    lanternGlass: new THREE.MeshStandardMaterial({
      color: 0xffb45c, emissive: 0xff8a2a, emissiveIntensity: 0.03,
      roughness: 0.3, transparent: true, opacity: 0.88,
    }),
  };
}

function shadowless(mesh) {
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function addBox(parent, size, position, material) {
  const mesh = shadowless(new THREE.Mesh(new THREE.BoxGeometry(...size), material));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function addWheel(parent, x, z, material, radius = 0.43) {
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.2, 14), material);
  wheel.rotation.z = Math.PI * 0.5;
  wheel.position.set(x, radius + 0.05, z);
  parent.add(wheel);
}

function addCylinder(parent, rTop, rBottom, height, position, material, alongZ = false) {
  const mesh = shadowless(new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, height, 14), material,
  ));
  if (alongZ) mesh.rotation.x = Math.PI * 0.5;
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function addLanternSconce(parent, materials) {
  const fixture = new THREE.Group();
  fixture.name = 'Passenger-car lantern sconce';
  // Mounted on the inside of the rear end wall, with the arm and globe
  // projecting into the carriage where they are visible from every seat.
  fixture.position.set(0, 2.13, -3.40);
  parent.add(fixture);

  addBox(fixture, [0.28, 0.40, 0.055], [0, 0, 0], materials.lanternMetal).name = 'Lantern wall plate';
  addCylinder(fixture, 0.025, 0.025, 0.30, [0, 0.08, 0.17], materials.lanternMetal, true).name = 'Lantern arm';
  addCylinder(fixture, 0.035, 0.035, 0.19, [0, -0.03, 0.32], materials.lanternMetal).name = 'Lantern stem';
  addCylinder(fixture, 0.11, 0.08, 0.055, [0, -0.115, 0.32], materials.lanternMetal).name = 'Lantern cap';
  addCylinder(fixture, 0.09, 0.11, 0.055, [0, -0.405, 0.32], materials.lanternMetal).name = 'Lantern base';

  // Each carriage needs its own emissive value because only the occupied one
  // lights. The shared texture/material set remains reusable everywhere else.
  const globeMaterial = materials.lanternGlass.clone();
  globeMaterial.name = 'Occupied-car lantern glass';
  globeMaterial.userData.serviceOwned = true;
  const globe = shadowless(new THREE.Mesh(
    new THREE.SphereGeometry(0.145, 14, 10), globeMaterial,
  ));
  globe.name = 'Lantern globe';
  globe.scale.y = 1.08;
  globe.position.set(0, -0.26, 0.32);
  fixture.add(globe);

  const light = new THREE.PointLight(0xffc173, 0, 10, 1);
  light.name = 'Occupied passenger-car lantern light';
  light.position.copy(globe.position);
  light.castShadow = false;
  fixture.add(light);

  return { fixture, globe, globeMaterial, light, level: 0 };
}

/**
 * A spoked driving wheel, merged to ONE geometry so a six-driver locomotive
 * costs six draws rather than sixty. Built in the XZ plane (axle along X) to
 * match addWheel's orientation: tyre, thicker rim, hub, spokes, crank pin.
 */
function makeSpokedWheelGeometry(radius, spokes) {
  const parts = [];
  const rim = new THREE.CylinderGeometry(radius, radius, 0.16, 20);
  parts.push(rim);
  const tread = new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, 0.09, 20);
  parts.push(tread);
  const hub = new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, 0.24, 10);
  parts.push(hub);
  for (let i = 0; i < spokes; i++) {
    const angle = (i / spokes) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(0.075, radius * 0.86, 0.075);
    spoke.rotateX(Math.PI * 0.5);          // lie the spoke in the wheel's plane
    spoke.rotateY(angle);
    // BoxGeometry is centred, so after rotation the spoke already spans the
    // wheel through the hub — no offset needed.
    parts.push(spoke);
  }
  // crank pin, offset from centre, on the outer face
  const pin = new THREE.CylinderGeometry(radius * 0.1, radius * 0.1, 0.14, 8);
  pin.rotateZ(Math.PI * 0.5);
  pin.translate(0.14, radius * 0.55, 0);
  parts.push(pin);
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  for (const g of parts) g.dispose();
  merged.rotateZ(Math.PI * 0.5);           // axle along X, like addWheel
  return merged;
}

function addSpokedWheel(parent, geometry, x, z, material, radius) {
  const wheel = new THREE.Mesh(geometry, material);
  wheel.position.set(x, radius + 0.05, z);
  parent.add(wheel);
  return wheel;
}

/** Small steam locomotive facing FORWARD along +Z (the direction of travel):
 * smokebox and chimney lead, the cab trails.
 *
 * The massing follows the Hoshi-no-Tani engine: a banded boiler running into a
 * wider smokebox, a flared chimney cap, a two-stage brass dome with safety
 * valves behind it, outside cylinders and guide bars at the front, and a red
 * buffer beam with a slatted cowcatcher. Those are the details that read as
 * "steam locomotive" in silhouette rather than "tube on wheels".
 *
 * Dimensions stay inside the previous footprint on purpose: the chimney top is
 * still at local (0, 3.25, 2.5) because the smoke emitter anchors there, and
 * the 4.6m wheelbase passed to placeVehicle still spans the drivers. */
function makeLocomotive(materials) {
  const root = new THREE.Group();
  root.name = 'Regional locomotive';
  addBox(root, [2.5, 0.46, 6.4], [0, 0.66, 0], materials.chassis);
  addBox(root, [2.34, 0.24, 4.4], [0, 0.95, 0.6], materials.chassis); // running board

  // Boiler barrel with a darker, wider smokebox ahead of it and a pale band on
  // the joint between them.
  addCylinder(root, 0.8, 0.8, 3.5, [0, 1.62, 0.75], materials.boiler, true);
  addCylinder(root, 0.84, 0.84, 0.55, [0, 1.62, 2.6], materials.smokebox, true);
  addCylinder(root, 0.87, 0.87, 0.08, [0, 1.62, 2.3], materials.lining, true);

  // Boiler bands: five thin rings down the barrel. Cheap, and the single
  // biggest thing separating a steam boiler from a plain cylinder.
  for (const z of [-0.75, -0.1, 0.55, 1.2, 1.85]) {
    addCylinder(root, 0.815, 0.815, 0.06, [0, 1.62, z], materials.lining, true);
  }

  // Chimney: a stack with a flared cap. Top stays at y 3.25 for the smoke.
  addCylinder(root, 0.19, 0.22, 0.72, [0, 2.66, 2.5], materials.smokebox);
  addCylinder(root, 0.30, 0.20, 0.26, [0, 3.12, 2.5], materials.smokebox);

  // Two-stage brass steam dome with a small crown, then the safety valves.
  addCylinder(root, 0.30, 0.36, 0.30, [0, 2.42, 1.2], materials.brass);
  addCylinder(root, 0.09, 0.30, 0.12, [0, 2.63, 1.2], materials.brass);
  for (const z of [0.42, 0.14]) {
    addCylinder(root, 0.08, 0.10, 0.26, [0, 2.42, z], materials.brass);
  }

  // Outside cylinders and guide bars, low at the front between the frames and
  // the running board — the parts a driving rod would actually connect to.
  for (const x of [-1.04, 1.04]) {
    addBox(root, [0.26, 0.32, 0.62], [x, 0.92, 2.35], materials.smokebox);
    addBox(root, [0.22, 0.07, 0.44], [x, 1.12, 2.35], materials.lining);
    addBox(root, [0.09, 0.04, 0.66], [x, 0.96, 1.72], materials.lining);
  }

  // Buffer beam in the livery red, a slatted cowcatcher, and a lamp.
  addBox(root, [2.5, 0.36, 0.12], [0, 0.72, 3.12], materials.livery);
  for (let i = 0; i < 5; i++) {
    const x = (i / 4 - 0.5) * 1.9;
    const slat = shadowless(new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.05, 0.62), materials.chassis,
    ));
    slat.position.set(x, 0.46, 3.34);
    slat.rotation.x = -0.62;
    root.add(slat);
  }
  addBox(root, [0.24, 0.26, 0.2], [0, 2.18, 2.86], materials.lamp);

  // Handrails down both sides of the boiler.
  for (const x of [-0.78, 0.78]) {
    addCylinder(root, 0.028, 0.028, 3.9, [x, 1.98, 0.9], materials.brass, true);
  }

  // Cab at the rear: solid lower panels, open side windows, roof.
  addBox(root, [2.34, 1.9, 0.08], [0, 2.0, -2.9], materials.boiler);   // back wall
  addBox(root, [2.34, 0.7, 0.08], [0, 2.7, -1.2], materials.boiler);   // front spectacle plate
  for (const x of [-1.13, 1.13]) {
    addBox(root, [0.08, 1.0, 1.7], [x, 1.55, -2.05], materials.boiler); // lower side
    addBox(root, [0.08, 0.9, 0.3], [x, 2.5, -2.75], materials.boiler);  // rear post
    addBox(root, [0.08, 0.9, 0.3], [x, 2.5, -1.35], materials.boiler);  // front post
  }
  addBox(root, [2.7, 0.12, 2.1], [0, 3.06, -2.05], materials.roof);

  // Three spoked drivers under the boiler, a small leading axle under the
  // smokebox. One shared geometry per size across all six drivers.
  const driver = makeSpokedWheelGeometry(0.5, 10);
  for (const z of [0.9, -0.1, -1.1]) {
    for (const x of [-1.26, 1.26]) addSpokedWheel(root, driver, x, z, materials.wheel, 0.5);
  }
  const pony = makeSpokedWheelGeometry(0.32, 8);
  for (const x of [-1.26, 1.26]) addSpokedWheel(root, pony, x, 2.3, materials.wheel, 0.32);
  return root;
}

/**
 * A passenger carriage whose walls are REAL thin panels — solid from both
 * sides — with genuinely open window cut-outs to look through. From a seat the
 * interior reads as walls, benches and a wood floor; the world (or a dark
 * tunnel lining) shows only through the window openings and doorways.
 */
function makeCarriage(materials) {
  const root = new THREE.Group();
  root.name = 'Regional carriage';
  addBox(root, [2.55, 0.38, 7.0], [0, 0.68, 0], materials.chassis);
  addBox(root, [2.42, 0.05, 6.94], [0, 0.9, 0], materials.floor);
  addBox(root, [2.72, 0.14, 7.25], [0, 2.92, 0], materials.roof);
  addBox(root, [2.58, 0.05, 7.1], [0, 2.845, 0], materials.trim); // ceiling lining
  for (const z of [-2.35, 2.35]) for (const x of [-1.27, 1.27]) addWheel(root, x, z, materials.wheel);

  // Side walls: sill band, header band, and window-band pillars, leaving four
  // open window bays per side plus the central doorway.
  const wallT = 0.06;
  const windowBandSegments = [
    [-3.5, -3.05], [-2.2, -1.95], [-1.1, -0.62],
    [0.62, 1.1], [1.95, 2.2], [3.05, 3.5],
  ];
  for (const x of [-1.24, 1.24]) {
    for (const [z0, z1] of [[-3.5, -0.62], [0.62, 3.5]]) { // sill (split at doorway)
      addBox(root, [wallT, 0.68, z1 - z0], [x, 1.21, (z0 + z1) / 2], materials.carriage);
    }
    addBox(root, [wallT, 0.5, 7.0], [x, 2.6, 0], materials.carriage); // header
    for (const [z0, z1] of windowBandSegments) {
      addBox(root, [wallT, 0.8, z1 - z0], [x, 1.95, (z0 + z1) / 2], materials.carriage);
    }
    // Window rails top and bottom of the open bays.
    addBox(root, [wallT + 0.02, 0.06, 7.0], [x, 1.58, 0], materials.trim);
    addBox(root, [wallT + 0.02, 0.06, 7.0], [x, 2.32, 0], materials.trim);
  }
  // Solid end walls.
  for (const z of [-3.47, 3.47]) {
    addBox(root, [2.54, 1.98, wallT], [0, 1.86, z], materials.carriage);
  }

  // Half-height sliding doors amidships on both sides. The lower edge stays at
  // the floor and the top lands on the window sill, leaving the entire upper
  // doorway open for an unobstructed view whether the panel is open or shut.
  const doors = [];
  const doorWidth = 1.16;
  const doorBottom = 0.87;
  const doorHeight = 0.74;
  for (const side of [-1, 1]) {
    const panel = shadowless(new THREE.Mesh(
      new THREE.BoxGeometry(0.05, doorHeight, doorWidth), materials.door,
    ));
    panel.name = 'Half-height sliding door';
    const closedZ = 0;
    const openZ = -doorWidth * 0.92;
    const panelY = doorBottom + doorHeight * 0.5;
    panel.position.set(side * 1.27, panelY, closedZ);
    root.add(panel);
    doors.push({ panel, side, closedZ, openZ, localX: side * 1.27, localY: panelY });
  }

  // Four longitudinal bench sections under the windows: front and rear on
  // each side. Their centre gap matches the two opposing doorways, forming a
  // clear cross-car egress instead of running the seats through the entrances.
  const benchEnd = 3.0;
  const doorwayHalfWidth = 0.62;
  const benchRuns = [
    { label: 'rear', z0: -benchEnd, z1: -doorwayHalfWidth },
    { label: 'front', z0: doorwayHalfWidth, z1: benchEnd },
  ];
  for (const x of [-0.84, 0.84]) {
    const sideLabel = x < 0 ? 'left' : 'right';
    for (const run of benchRuns) {
      const section = new THREE.Group();
      section.name = `${sideLabel} ${run.label} passenger bench`;
      section.position.x = x;
      root.add(section);

      const length = run.z1 - run.z0;
      const centreZ = (run.z0 + run.z1) * 0.5;
      addBox(section, [0.52, 0.09, length], [0, 1.06, centreZ], materials.bench);
      addBox(section, [0.05, 0.55, length], [Math.sign(x) * 0.31, 1.4, centreZ], materials.bench);

      // Fitted upholstery overlays the timber frame. A shallow seat pad and a
      // full rectangular back pad share the same dark-red velvet treatment,
      // with separately proportioned procedural maps so the quilting stays
      // square instead of stretching along the carriage.
      const cushionLength = length - 0.08;
      const seatCushion = addBox(
        section, [0.48, 0.08, cushionLength], [0, 1.145, centreZ], materials.velvetSeat,
      );
      seatCushion.name = `${sideLabel} ${run.label} velvet seat cushion`;
      const backX = Math.sign(x) * 0.31;
      const backCushionX = backX - Math.sign(x) * (0.025 + 0.028);
      const backCushion = addBox(
        section, [0.056, 0.49, cushionLength], [backCushionX, 1.4, centreZ], materials.velvetBack,
      );
      backCushion.name = `${sideLabel} ${run.label} velvet back cushion`;
    }
  }

  const lantern = addLanternSconce(root, materials);

  // Four actual passenger positions, all at eye height with the open window
  // band. Switching seats reparents the camera between these anchors.
  const seats = SEAT_LAYOUT.map((spec) => {
    const seat = new THREE.Object3D();
    seat.name = `Passenger seat · ${spec.label}`;
    seat.position.set(spec.x, 1.75, spec.z);
    seat.userData.label = spec.label;
    seat.userData.yaw = spec.yaw;
    root.add(seat);
    return seat;
  });

  return { root, doors, seats, seat: seats[0], lantern };
}

function makeStyledPanel(styles) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '6',
    color: 'rgba(255,255,255,.9)',
    font: '12px/1.6 "Helvetica Neue", Arial, sans-serif',
    letterSpacing: '.5px',
    textShadow: '0 1px 3px rgba(0,0,0,.85)',
    pointerEvents: 'none',
    userSelect: 'none',
    display: 'none',
  }, styles);
  document.body.appendChild(el);
  return el;
}

/**
 * A passenger service running the regional loop: one train that cruises, stops
 * and dwells at each station, with on-foot boarding, seated travel between
 * stations, and a route-map / next-station display. Walking inside the carriage
 * is deferred (Phase 8) — boarding seats the player immediately.
 */
export class RegionalRailwayService {
  constructor(scene, world, controls, { onBeforeTravel = null, audioBus = null } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.onBeforeTravel = onBeforeTravel;
    this.smoke = new LocomotiveSmoke(scene);
    this.trainAudio = new RailwayAudio(audioBus);
    this._chimney = new THREE.Vector3();
    this._trainForward = new THREE.Vector3();

    this.plan = null;
    this.route = null;
    this.stations = [];
    this.schedule = null;

    this.group = new THREE.Group();
    this.group.name = 'Regional railway service';
    this.group.visible = false;
    this.scene.add(this.group);

    this.materials = makeMaterials();
    this.locomotive = null;
    this.carriages = [];

    this.riding = false;
    this.ridingCarriage = -1;
    this.savedControlsEnabled = false;
    this.viewIndex = 0;
    this.seatIndex = 0;
    // WebXR cameras already contain the headset's floor-relative eye pose. A
    // separate origin below the authored eye-level seat prevents that height
    // from being added twice while the carriage carries the player.
    this.xrSeatOrigin = new THREE.Object3D();
    this.xrSeatOrigin.name = 'XR passenger tracking origin';
    this.interactionCue = null;
    this.ridingHintTimer = 0;
    this.notice = '';
    this.noticeTimer = 0;
    this._prevKeys = { board: false, view: false };

    // HUD surfaces (created lazily-safe; harmless if document is absent).
    this.promptEl = makeStyledPanel({
      left: '50%', bottom: '15%', transform: 'translateX(-50%)',
      textAlign: 'center', padding: '7px 16px',
      background: 'rgba(10,16,22,.5)', borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.16)',
    });
    this.mapEl = makeStyledPanel({
      top: '10px', right: '12px', minWidth: '150px',
      padding: '10px 14px', textAlign: 'left',
      background: 'rgba(10,16,22,.42)', borderRadius: '10px',
      border: '1px solid rgba(255,255,255,.14)',
    });

    this.debug = {
      status: 'no service',
      // Effects on by default; sounds enable once the audio context is live
      // (the "click to walk" gesture that starts the soundscape).
      smoke: true,
      sounds: true,
      board: () => this.tryBoardNearest(),
      leave: () => this.leave(),
      cycleView: () => this.cycleView(),
      testWhistle: () => this.trainAudio.testWhistle(),
    };
  }

  // --- plan lifecycle ---------------------------------------------------------

  clearTrain() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse?.((o) => {
        if (o.geometry && o.userData.serviceOwned) o.geometry.dispose?.();
        const objectMaterials = o.material
          ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const material of objectMaterials) {
          if (material.userData.serviceOwned) material.dispose?.();
        }
      });
    }
    this.locomotive = null;
    this.carriages = [];
    this.interactionCue = null;
    this.ridingHintTimer = 0;
  }

  setPlan(plan = null) {
    if (this.riding) this.leave(false);
    this.clearTrain();
    this.plan = plan;
    this.route = plan?.route || null;
    this.stations = plan?.stations || [];
    if (!plan || !this.route || this.stations.length < 2) {
      this.schedule = null;
      this.group.visible = false;
      this.setPrompt('');
      this.mapEl.style.display = 'none';
      this.debug.status = 'no service';
      return;
    }

    nameRegionalStations(plan, { world: this.world, seed: plan.seed });

    // Visit stations in the order they appear along the route.
    const stopOrder = this.stations
      .map((s, i) => ({ i, d: s.routeDistance }))
      .sort((a, b) => a.d - b.d);
    this.stopStationByOrder = stopOrder.map((s) => s.i);
    const stopDistances = stopOrder.map((s) => s.d);
    this.schedule = new TrainScheduleModel(this.route.length, stopDistances, {
      ...RAILWAY_SERVICE_DEFAULTS,
    });

    this.locomotive = makeLocomotive(this.materials);
    this.locomotive.traverse((o) => { if (o.geometry) o.userData.serviceOwned = true; });
    this.group.add(this.locomotive);
    for (let i = 0; i < 2; i++) {
      const carriage = makeCarriage(this.materials);
      carriage.root.traverse((o) => { if (o.geometry) o.userData.serviceOwned = true; });
      this.group.add(carriage.root);
      this.carriages.push(carriage);
    }

    this.group.visible = true;
    this.buildRouteMap();
    this.update(0, this.controls.rig.position);
    this.debug.status = `${this.stations.length} stations · ${(this.route.length / 1000).toFixed(1)}km loop`;
  }

  // --- placement --------------------------------------------------------------

  placeVehicle(object, distance, wheelbase) {
    this.route.sampleAtDistance(distance + wheelbase * 0.5, _sampleA);
    this.route.sampleAtDistance(distance - wheelbase * 0.5, _sampleB);
    _pos.set(
      (_sampleA.x + _sampleB.x) * 0.5,
      (_sampleA.y + _sampleB.y) * 0.5 + VEHICLE_LIFT,
      (_sampleA.z + _sampleB.z) * 0.5,
    );
    _forward.set(_sampleA.x - _sampleB.x, _sampleA.y - _sampleB.y, _sampleA.z - _sampleB.z).normalize();
    _right.set(_forward.z, 0, -_forward.x).normalize();
    _up.crossVectors(_forward, _right).normalize();
    _matrix.makeBasis(_right, _up, _forward);
    object.position.copy(_pos);
    object.quaternion.setFromRotationMatrix(_matrix);
  }

  // The schedule distance marks where the *first carriage* rests, so a dwelling
  // train presents that carriage's doors at the platform; the locomotive rides
  // one spacing ahead, and further carriages trail behind.
  carriageDistance(carriageIndex) {
    return this.schedule.distance - carriageIndex * CARRIAGE_SPACING;
  }

  locoDistance() {
    return this.schedule.distance + CARRIAGE_SPACING;
  }

  // --- boarding / leaving -----------------------------------------------------

  nearestDoor(playerPos) {
    let best = null;
    for (let c = 0; c < this.carriages.length; c++) {
      const carriage = this.carriages[c];
      for (const door of carriage.doors) {
        _door.set(door.localX, door.localY, door.closedZ);
        carriage.root.localToWorld(_door);
        const dist = Math.hypot(_door.x - playerPos.x, _door.z - playerPos.z);
        if (!best || dist < best.dist) best = { dist, carriage: c };
      }
    }
    return best;
  }

  boardRange() {
    return this.controls.renderer.xr.isPresenting ? XR_BOARD_RANGE : BOARD_RANGE;
  }

  tryBoardNearest() {
    if (this.riding || !this.schedule) return false;
    const near = this.nearestDoor(this.controls.rig.position);
    if (!near || near.dist > this.boardRange()) return false;
    this.board(near.carriage);
    return true;
  }

  board(carriageIndex) {
    if (this.riding || !this.carriages[carriageIndex]) return;
    this.onBeforeTravel?.();
    this.savedControlsEnabled = this.controls.enabled;
    this.controls.enabled = false;
    this.controls.allowLook = true; // free mouselook from the seat
    this.controls.keys.clear();
    this.controls.speed = 0;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    this.ridingCarriage = carriageIndex;
    this.seatIndex = 0;
    const seat = this.activeSeat();
    this.controls.camera.rotation.order = 'YXZ';
    this.attachCameraToSeat(seat);
    this.riding = true;
    this.viewIndex = this.seatIndex;
    this.applyView();
    this.ridingHintTimer = PASSENGER_HINT_SECONDS.boarding;
    this.flash(`Boarded — ${this.currentDestinationLabel()}`);
  }

  /** Leave the train. On a platform → step onto it; between stations → step
   * down safely beside the line (velocity is not inherited because seated travel
   * keeps the rig kinematic; Phase 8 adds momentum transfer). */
  leave(reposition = true) {
    if (!this.riding) return;
    const camera = this.controls.camera;
    const xr = this.controls.renderer.xr.isPresenting;
    this.controls.allowLook = false;
    camera.rotation.order = 'XYZ';
    this.controls.rig.add(camera);
    this.xrSeatOrigin.removeFromParent();
    if (!xr) {
      camera.position.set(0, this.controls.eyeHeight, 0);
      camera.rotation.set(this.controls.pitch, 0, 0);
    }

    if (reposition && this.schedule) {
      const atStation = this.schedule.atStation;
      const distance = this.carriageDistance(Math.max(0, this.ridingCarriage));
      const sample = this.route.sampleAtDistance(distance, {});
      // Step down toward whichever side is lower, so the player never lands
      // inside an embankment; on a platform that is the boarded side.
      const offset = 4.6;
      const leftX = sample.x - sample.rightX * offset, leftZ = sample.z - sample.rightZ * offset;
      const rightX = sample.x + sample.rightX * offset, rightZ = sample.z + sample.rightZ * offset;
      const leftH = this.world.height(leftX, leftZ);
      const rightH = this.world.height(rightX, rightZ);
      const useRight = rightH <= leftH;
      const x = useRight ? rightX : leftX;
      const z = useRight ? rightZ : leftZ;
      this.controls.place(x, z);
      this.controls.yaw = Math.atan2(sample.x - x, sample.z - z);
      this.flash(atStation
        ? `Alighted at ${this.stationName(this.schedule.currentStationIndex)}`
        : 'You step down beside the line');
    }
    this.controls.enabled = this.savedControlsEnabled;
    this.riding = false;
    this.ridingCarriage = -1;
    this.seatIndex = 0;
    this.ridingHintTimer = 0;
  }

  activeSeat() {
    const carriage = this.carriages[this.ridingCarriage];
    return carriage?.seats?.[this.seatIndex] || carriage?.seat || null;
  }

  attachCameraToSeat(seat = this.activeSeat()) {
    if (!seat) return;
    const camera = this.controls.camera;
    if (this.controls.renderer.xr.isPresenting) {
      // Capture the headset pose while it is still expressed in the current
      // tracking space, then move that tracking origin beneath the authored
      // eye anchor. Object3D.add deliberately keeps the camera's local pose.
      const seatYaw = seat.userData.yaw ?? 0;
      xrSeatOriginOffset(camera.position, seatYaw, _seatOffset);
      seat.add(this.xrSeatOrigin);
      this.xrSeatOrigin.position.set(_seatOffset.x, _seatOffset.y, _seatOffset.z);
      this.xrSeatOrigin.rotation.set(0, seatYaw, 0);
      this.xrSeatOrigin.add(camera);
      return;
    }
    seat.add(camera);
    this.xrSeatOrigin.removeFromParent();
    camera.position.set(0, 0, 0);
  }

  applyView() {
    const seat = this.activeSeat();
    this.controls.yaw = seat?.userData?.yaw ?? 0;
    this.controls.pitch = 0;
    if (this.controls.renderer.xr.isPresenting && this.xrSeatOrigin.parent === seat) {
      this.xrSeatOrigin.rotation.set(0, this.controls.yaw, 0);
    }
  }

  cycleView() {
    if (!this.riding) return;
    const carriage = this.carriages[this.ridingCarriage];
    if (!carriage?.seats?.length) return;
    this.seatIndex = (this.seatIndex + 1) % carriage.seats.length;
    this.viewIndex = this.seatIndex;
    const seat = this.activeSeat();
    this.attachCameraToSeat(seat);
    this.applyView();
    this.ridingHintTimer = Math.max(this.ridingHintTimer, PASSENGER_HINT_SECONDS.seatSwitch);
    this.flash(`Seat: ${seat.userData.label}`, 1.5);
  }

  // --- naming / HUD helpers ---------------------------------------------------

  stationName(planIndex) {
    const station = this.stations.find((s) => s.index === planIndex);
    return station?.name || `Station ${planIndex + 1}`;
  }

  currentDestinationLabel() {
    if (!this.schedule) return '';
    return `next: ${this.stationName(this.schedule.nextStationIndex)}`;
  }

  buildRouteMap() {
    this.mapEl.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = 'REGIONAL LINE';
    Object.assign(title.style, { opacity: '.6', fontSize: '10px', letterSpacing: '2px', marginBottom: '6px' });
    this.mapEl.appendChild(title);
    this.mapRows = [];
    // List stations in visiting order.
    for (const stationIndex of this.stopStationByOrder) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '1px 0';
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '7px', height: '7px', borderRadius: '50%',
        background: 'rgba(255,255,255,.35)', flex: '0 0 auto',
      });
      const label = document.createElement('span');
      label.textContent = this.stationName(stationIndex);
      row.append(dot, label);
      this.mapEl.appendChild(row);
      this.mapRows.push({ stationIndex, dot, label, row });
    }
  }

  refreshRouteMap() {
    if (!this.mapRows) return;
    const nextIndex = this.schedule.nextStationIndex;
    const currentIndex = this.schedule.currentStationIndex;
    for (const r of this.mapRows) {
      const isNext = r.stationIndex === nextIndex && currentIndex < 0;
      const isHere = r.stationIndex === currentIndex;
      r.dot.style.background = isHere ? '#f2c14e' : isNext ? '#8fd0ff' : 'rgba(255,255,255,.35)';
      r.label.style.opacity = (isHere || isNext) ? '1' : '.62';
      r.label.style.fontWeight = (isHere || isNext) ? '600' : '400';
    }
  }

  setPrompt(text) {
    if (!text) { this.promptEl.style.display = 'none'; return; }
    this.promptEl.innerHTML = text;
    this.promptEl.style.display = 'block';
  }

  flash(text, seconds = 2.6) {
    this.notice = text;
    this.noticeTimer = seconds;
  }

  // --- per-frame --------------------------------------------------------------

  update(dt, playerPos, canInteract = true, nightAmount = 0) {
    if (!this.schedule) {
      this.interactionCue = null;
      return;
    }

    this.schedule.step(dt);
    if (this.schedule.justArrived) {
      this.flash(`Arriving — ${this.stationName(this.schedule.currentStationIndex)}`, 3);
      if (this.riding) this.ridingHintTimer = PASSENGER_HINT_SECONDS.arrival;
    }
    if (this.schedule.justDeparted) this.trainAudio.onDeparture();

    // Orient the whole consist along the alignment.
    this.placeVehicle(this.locomotive, this.locoDistance(), 4.6);
    for (let c = 0; c < this.carriages.length; c++) {
      this.placeVehicle(this.carriages[c].root, this.carriageDistance(c), 5.2);
      // Slide doors according to dwell progress.
      const open = this.schedule.doorFactor;
      for (const door of this.carriages[c].doors) {
        door.panel.position.z = door.closedZ + (door.openZ - door.closedZ) * open;
      }

      // One low-output point light follows the player rather than lighting the
      // whole consist. The fixture exists in both boardable cars, but only the
      // occupied one fades up as the sky enters night.
      const lantern = this.carriages[c].lantern;
      if (lantern) {
        const target = occupiedCarriageLanternLevel(nightAmount, c, this.ridingCarriage);
        lantern.level = THREE.MathUtils.damp(lantern.level, target, 4.5, dt);
        lantern.light.intensity = lantern.level * 2;
        lantern.light.visible = lantern.level > 0.001;
        lantern.globeMaterial.emissiveIntensity = 0.03 + lantern.level * 0.72;
      }
    }

    if (this.riding) this.syncSeatedRig();

    // Optional effects (GUI-controlled, off by default).
    if (this.smoke.enabled !== this.debug.smoke) this.smoke.setEnabled(this.debug.smoke);
    if (this.debug.smoke && this.locomotive) {
      this._chimney.set(0, 3.25, 2.5);
      this.locomotive.localToWorld(this._chimney);
      this._trainForward.set(0, 0, 1).applyQuaternion(this.locomotive.quaternion);
      this.smoke.update(dt, this._chimney, this._trainForward, this.schedule.velocity);
    }
    // Enable train audio once the context is live (post-gesture); disable when
    // the flag is cleared. Gating on canStart() avoids a dead pre-gesture build.
    if (this.debug.sounds && !this.trainAudio.enabled && this.trainAudio.canStart()) {
      this.trainAudio.setEnabled(true);
    } else if (!this.debug.sounds && this.trainAudio.enabled) {
      this.trainAudio.setEnabled(false);
    }
    if (this.trainAudio.enabled && this.locomotive && this.carriages.length) {
      const c0 = this.carriages[0].root.position;
      const trainDistance = this.riding ? 0
        : Math.hypot(c0.x - playerPos.x, c0.z - playerPos.z);
      // Whistle source rides at the locomotive; listener follows the camera.
      const loco = this.locomotive.position;
      this.controls.camera.getWorldPosition(_pos2);
      this.controls.camera.getWorldDirection(_trainDir);
      this.trainAudio.update(dt, {
        speed: this.schedule.velocity,
        riding: this.riding,
        distance: trainDistance,
        moving: this.schedule.velocity > 0.5,
        train: { x: loco.x, y: loco.y + 2.6, z: loco.z },
        listener: {
          x: _pos2.x, y: _pos2.y, z: _pos2.z,
          fx: _trainDir.x, fy: _trainDir.y, fz: _trainDir.z,
        },
      });
    }

    // Desktop keeps E/V. Quest uses B for board/alight and X to move to the
    // next physical seat anchor; PlayerControls has already edge-detected them.
    const keys = this.controls.keys;
    const boardDown = keys.has('KeyE');
    const viewDown = keys.has('KeyV');
    const xrAction = !!this.controls.xrActions?.interactPressed;
    const xrSwitchSeat = !!this.controls.xrActions?.switchSeatPressed;
    const interact = canInteract && (this.controls.enabled || this.riding);
    if (interact && ((boardDown && !this._prevKeys.board) || xrAction)) {
      if (this.riding) this.leave(true);
      else if (!this.controls.renderer.xr.isPresenting || this.schedule.atStation) {
        this.tryBoardNearest();
      }
    }
    if (interact && this.riding
      && ((viewDown && !this._prevKeys.view) || xrSwitchSeat)) this.cycleView();
    this._prevKeys.board = boardDown;
    this._prevKeys.view = viewDown;

    if (this.noticeTimer > 0) this.noticeTimer -= dt;
    if (this.riding) this.ridingHintTimer = stepPassengerHintTimer(this.ridingHintTimer, dt);
    // Only surface passenger HUD once the player is actually in the world
    // (walking or aboard) — never behind the start overlay.
    this.refreshHud(playerPos, interact);
    this.debug.status = `${this.schedule.phase} · ${this.currentDestinationLabel()} · ${this.schedule.velocity.toFixed(1)}m/s`;
  }

  syncSeatedRig() {
    const seat = this.activeSeat();
    const xr = this.controls.renderer.xr.isPresenting;
    // A session can begin or end while already aboard. Switch camera ownership
    // lazily once a tracked pose exists, avoiding a doubled eye-height in XR
    // while retaining the original desktop seat-local camera.
    if (xr) {
      if (this.controls.camera.parent !== this.xrSeatOrigin
          && (this.controls.camera.parent !== seat
            || this.controls.camera.position.lengthSq() > 1e-6)) {
        this.attachCameraToSeat(seat);
        this.applyView();
      }
    } else {
      if (this.controls.camera.parent !== seat) this.attachCameraToSeat(seat);
      this.controls.camera.position.set(0, 0, 0);
      this.controls.camera.rotation.set(this.controls.pitch, this.controls.yaw, 0);
    }

    // The physics rig stays glued underneath so streaming, audio and weather
    // all read the passenger's true position. The camera itself rides either
    // the desktop eye anchor or the calibrated XR tracking origin above.
    seat.getWorldPosition(_pos2);
    this.controls.rig.position.copy(_pos2);
    this.controls.rig.position.y -= this.controls.eyeHeight;
    this.controls.speed = this.schedule.velocity;
  }

  nearestStation(playerPos) {
    let best = null;
    for (const station of this.stations) {
      const d = Math.hypot(station.x - playerPos.x, station.z - playerPos.z);
      if (!best || d < best.d) best = { d, station };
    }
    return best;
  }

  refreshHud(playerPos, active = true) {
    if (!active) {
      this.mapEl.style.display = 'none';
      this.setPrompt('');
      this.interactionCue = null;
      return;
    }
    const notice = this.noticeTimer > 0 ? this.notice : '';
    const xr = this.controls.renderer.xr.isPresenting;
    const boardButton = xr ? 'B' : 'E';
    const seatButton = xr ? 'X' : 'V';

    if (this.riding) {
      const showRidingHint = this.ridingHintTimer > 0;
      this.interactionCue = showRidingHint ? {
        mode: 'riding',
        primaryButton: 'B',
        primaryAction: 'ALIGHT',
        secondaryButton: 'X',
        secondaryAction: 'SWITCH SEAT',
      } : null;
      this.mapEl.style.display = 'block';
      this.refreshRouteMap();
      if (!showRidingHint) {
        this.setPrompt('');
      } else if (this.schedule.atStation) {
        this.setPrompt(`<b>${this.stationName(this.schedule.currentStationIndex)}</b> · doors open · <b>${boardButton}</b> alight · <b>${seatButton}</b> switch seat`);
      } else {
        const eta = Math.max(1, Math.round(this.schedule.etaSeconds));
        this.setPrompt(`Next: <b>${this.stationName(this.schedule.nextStationIndex)}</b> · ~${eta}s · <b>${seatButton}</b> switch seat`);
      }
      return;
    }

    // On foot: show the boarding prompt at a dwelling train, or a platform
    // arrival board when standing near a station.
    const near = this.nearestDoor(playerPos);
    if (this.schedule.atStation && near && near.dist <= this.boardRange()) {
      this.interactionCue = {
        mode: 'board',
        primaryButton: 'B',
        primaryAction: 'BOARD TRAIN',
      };
      this.mapEl.style.display = 'block';
      this.refreshRouteMap();
      this.setPrompt(`<b>${boardButton}</b> board · ${this.currentDestinationLabel()}`);
      return;
    }

    this.interactionCue = null;

    const nearStation = this.nearestStation(playerPos);
    if (nearStation && nearStation.d <= PLATFORM_APPROACH) {
      this.mapEl.style.display = 'block';
      this.refreshRouteMap();
      const here = nearStation.station.routeDistance;
      const gap = forwardGap(this.schedule.distance, here, this.route.length);
      const speed = Math.max(this.schedule.velocity, this.schedule.cruiseSpeed * 0.6, 1);
      const eta = gap < 8 ? 'now' : `~${Math.round(gap / speed)}s`;
      const arriving = gap < 60 && !this.schedule.atStation ? ' · approaching' : '';
      this.setPrompt(`<b>${nearStation.station.name}</b> · next train ${eta}${arriving}${notice ? ` · ${notice}` : ''}`);
      return;
    }

    this.mapEl.style.display = 'none';
    this.setPrompt(notice);
  }
}
