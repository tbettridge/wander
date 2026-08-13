import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { baseWorldHeight } from './railwayterrain.mjs';
import { LocomotiveSmoke } from './railsmoke.js';
import { RailwayAudio } from './railaudio.js';
import {
  createRailServiceEpoch,
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
import { RailPassengerManifest } from './railpassengers.mjs';
import { planRailPassengerPresentations } from './railpassengerpresentation.mjs';
import { stationVillageName } from './settlementspatial.mjs';
import {
  RAIL_CARRIAGE,
  RAIL_CARRIAGE_SEATS,
  carriageAisleStandForSeat,
  carriageAlightingApproach,
  carriageAlightingRecovery,
  carriageBoardingApproach,
  carriageDoorIsPassable,
  carriageThresholdCrossing,
  nearestCarriageSeat,
  resolveCarriageMovementLocal,
} from './railcarriage.mjs?v=3';
import { npcRailCarriageLocalPose } from './npcrailtransfer.mjs';

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
const _localPlayer = new THREE.Vector3();
const _localPrevious = new THREE.Vector3();
const _worldResolved = new THREE.Vector3();
const _worldFloor = new THREE.Vector3();
const _gangwayA = new THREE.Vector3();
const _gangwayB = new THREE.Vector3();
const _gangwayCenter = new THREE.Vector3();
const _gangwayVector = new THREE.Vector3();
const _gangwayRight = new THREE.Vector3();
const _gangwayOtherRight = new THREE.Vector3();
const _gangwayUp = new THREE.Vector3();

const VEHICLE_LIFT = 0.36;          // wheels rest on the railhead above the formation
const CARRIAGE_SPACING = 8.9;       // metres between vehicle centres along the route
const BOARD_RANGE = 3.6;            // how close a door must be to prompt boarding
const XR_BOARD_RANGE = 6.0;         // cover either usable VR platform, including room-scale offset
const PLATFORM_APPROACH = 46;       // how near a station platform surfaces its arrival board
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

function addLanternSconce(parent, materials, wallEnd = -1) {
  const fixture = new THREE.Group();
  fixture.name = 'Passenger-car lantern sconce';
  // Mount only on the solid outward bulkhead. The coupled bulkhead is now an
  // open vestibule, so leaving the old rear-wall fixture there made it appear
  // to float in (and partly obstruct) the new passage.
  fixture.position.set(0, 2.13, wallEnd * 3.40);
  fixture.rotation.y = wallEnd > 0 ? Math.PI : 0;
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
function makeCarriage(materials, { interCarEnd = 0 } = {}) {
  const layout = RAIL_CARRIAGE;
  const root = new THREE.Group();
  root.name = 'Regional carriage';
  addBox(root, [2.55, 0.38, 7.0], [0, 0.68, 0], materials.chassis);
  addBox(root, [2.42, 0.05, 6.94], [0, layout.floorY - 0.025, 0], materials.floor);
  addBox(root, [2.72, layout.roofHeight, 7.25], [0, layout.roofCenterY, 0], materials.roof);
  addBox(root, [2.58, 0.05, 7.1], [0, layout.ceilingY + 0.025, 0], materials.trim); // ceiling lining
  for (const z of [-2.35, 2.35]) for (const x of [-1.27, 1.27]) addWheel(root, x, z, materials.wheel);

  // Side walls form one continuous load path from sill to the raised roof.
  // Slim full-height mullions leave two broad viewing bays on either side of
  // the doorway; the old short posts and floating waist-level upper rail made
  // the raised ceiling look detached from the body shell.
  const wallT = 0.06;
  const sidePosts = [
    [-3.5, -3.28], [-2.08, -1.90], [-0.82, -layout.doorwayHalfWidth],
    [layout.doorwayHalfWidth, 0.82], [1.90, 2.08], [3.28, 3.5],
  ];
  const lowerPanelHeight = layout.sideSillTopY - layout.sidePanelBottomY;
  const lowerPanelY = layout.sidePanelBottomY + lowerPanelHeight * 0.5;
  const postHeight = layout.sideHeaderBottomY - layout.sideSillTopY;
  const postY = layout.sideSillTopY + postHeight * 0.5;
  const headerHeight = layout.ceilingY - layout.sideHeaderBottomY;
  const headerY = layout.sideHeaderBottomY + headerHeight * 0.5;
  const trim = layout.windowTrimThickness;
  for (const x of [-1.24, 1.24]) {
    for (const [z0, z1] of [[-3.5, -0.62], [0.62, 3.5]]) { // sill (split at doorway)
      addBox(root, [wallT, lowerPanelHeight, z1 - z0],
        [x, lowerPanelY, (z0 + z1) / 2], materials.carriage);
    }
    // The header closes directly against the ceiling lining, while its raised
    // underside leaves a little over two metres above the carriage floor at
    // the doorway and a tall, uninterrupted window opening beside each seat.
    addBox(root, [wallT, headerHeight, 7.0], [x, headerY, 0], materials.carriage);
    for (const [z0, z1] of sidePosts) {
      addBox(root, [wallT, postHeight, z1 - z0],
        [x, postY, (z0 + z1) / 2], materials.carriage);
    }

    // A capped sill stops at the doorway; the upper cap is continuous and acts
    // as the door lintel. Both sit against solid wall members instead of
    // floating across the glass area.
    for (const [z0, z1] of [[-3.5, -layout.doorwayHalfWidth], [layout.doorwayHalfWidth, 3.5]]) {
      addBox(root, [wallT + 0.02, trim, z1 - z0],
        [x, layout.sideSillTopY + trim * 0.5, (z0 + z1) / 2], materials.trim);
    }
    addBox(root, [wallT + 0.02, trim, 7.0],
      [x, layout.sideHeaderBottomY - trim * 0.5, 0], materials.trim);

    // Narrow vertical beads outline the large window bays and make every post,
    // corner and doorway jamb read as one joined timber surround.
    const frameEdges = [...new Set(sidePosts.flat())];
    const beadHeight = postHeight - trim * 2;
    for (const z of frameEdges) {
      addBox(root, [wallT + 0.02, beadHeight, 0.035],
        [x, postY, z], materials.trim);
    }
  }
  // The outward end remains a solid bulkhead. At the coupled end, two sturdy
  // jambs and a lintel continue the body shell around a permanently open
  // vestibule doorway, giving passengers a clear route into the next car.
  for (const end of [-1, 1]) {
    const z = end * 3.47;
    const height = layout.ceilingY - 0.87;
    if (end !== Math.sign(interCarEnd)) {
      addBox(root, [2.54, height, wallT], [0, 0.87 + height / 2, z], materials.carriage);
      continue;
    }
    const endHalfWidth = 1.27;
    const openingHalfWidth = layout.gangwayDoorHalfWidth;
    const jambWidth = endHalfWidth - openingHalfWidth;
    const jambCenter = openingHalfWidth + jambWidth * 0.5;
    for (const x of [-jambCenter, jambCenter]) {
      const jambPanel = addBox(
        root, [jambWidth, height, wallT], [x, 0.87 + height / 2, z], materials.carriage,
      );
      jambPanel.name = 'Open vestibule end panel';
    }
    const lintelHeight = layout.ceilingY - layout.gangwayDoorTopY;
    const lintelPanel = addBox(root, [openingHalfWidth * 2, lintelHeight, wallT],
      [0, layout.gangwayDoorTopY + lintelHeight * 0.5, z], materials.carriage);
    lintelPanel.name = 'Open vestibule lintel panel';
    const openingHeight = layout.gangwayDoorTopY - layout.floorY;
    for (const x of [-openingHalfWidth, openingHalfWidth]) {
      addBox(root, [0.055, openingHeight, wallT + 0.025],
        [x, layout.floorY + openingHeight * 0.5, z], materials.trim);
    }
    addBox(root, [openingHalfWidth * 2 + 0.055, 0.055, wallT + 0.025],
      [0, layout.gangwayDoorTopY, z], materials.trim);
    const threshold = addBox(root, [layout.gangwayHalfWidth * 2, 0.08, 0.38],
      [0, layout.floorY - 0.04, z + end * 0.16], materials.floor);
    threshold.name = 'Open vestibule floor tongue';
    const thresholdBand = addBox(root, [layout.gangwayHalfWidth * 2 + 0.04, 0.025, 0.06],
      [0, layout.floorY + 0.012, z + end * 0.31], materials.brass);
    thresholdBand.name = 'Vestibule threshold band';
  }

  // Half-height sliding doors amidships on both sides. The lower edge stays at
  // the floor and the top lands on the window sill, leaving the entire upper
  // doorway open for an unobstructed view whether the panel is open or shut.
  const doors = [];
  const doorWidth = layout.doorWidth;
  const doorBottom = layout.doorBottom;
  const doorHeight = layout.doorHeight;
  for (const side of [-1, 1]) {
    const panel = shadowless(new THREE.Mesh(
      new THREE.BoxGeometry(0.05, doorHeight, doorWidth), materials.door,
    ));
    panel.name = 'Half-height sliding door';
    const closedZ = 0;
    const openZ = layout.doorOpenZ;
    const panelY = doorBottom + doorHeight * 0.5;
    panel.position.set(side * 1.27, panelY, closedZ);
    root.add(panel);
    doors.push({ panel, side, closedZ, openZ, localX: side * 1.27, localY: panelY });
  }

  // Four longitudinal bench sections under the windows: front and rear on
  // each side. Their centre gap matches the two opposing doorways, forming a
  // clear cross-car egress instead of running the seats through the entrances.
  const benchEnd = 3.0;
  const doorwayHalfWidth = layout.doorwayHalfWidth;
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

  const lantern = addLanternSconce(root, materials, interCarEnd === -1 ? 1 : -1);

  // Four actual passenger positions, all at eye height with the open window
  // band. Switching seats reparents the camera between these anchors.
  const seats = RAIL_CARRIAGE_SEATS.map((spec) => {
    const seat = new THREE.Object3D();
    seat.name = `Passenger seat · ${spec.label}`;
    seat.position.set(spec.x, 1.75, spec.z);
    seat.userData.label = spec.label;
    seat.userData.yaw = spec.yaw;
    root.add(seat);
    return seat;
  });

  return { root, doors, seats, seat: seats[0], lantern, layout, interCarEnd };
}

/** A single articulated deck spans the live distance and angle between cars. */
function makeInterCarGangway(materials) {
  const layout = RAIL_CARRIAGE;
  const root = new THREE.Group();
  root.name = 'Inter-car passenger gangway';
  const width = layout.gangwayHalfWidth * 2;
  const floor = addBox(root, [width, 0.12, 1], [0, -0.06, 0], materials.floor);
  floor.name = 'Articulated gangway bridge';
  for (const z of [-0.4, -0.2, 0, 0.2, 0.4]) {
    const deckJoint = addBox(root, [width + 0.035, 0.018, 0.028],
      [0, 0.009, z], materials.trim);
    deckJoint.name = 'Gangway deck joint';
  }
  for (const side of [-1, 1]) {
    const x = side * layout.gangwayHalfWidth;
    const guard = addBox(root, [0.08, 0.48, 1], [x, 0.24, 0], materials.carriage);
    guard.name = 'Gangway side guard';
    const rail = addBox(root, [0.08, 0.08, 1], [x, 0.84, 0], materials.brass);
    rail.name = 'Gangway handrail';
    for (const z of [-0.42, 0, 0.42]) {
      const post = addBox(root, [0.075, 0.78, 0.075], [x, 0.47, z], materials.trim);
      post.name = 'Gangway rail post';
    }
    for (const z of [-0.485, 0.485]) {
      const portalPost = addBox(root, [0.085, 2.14, 0.07], [side * 0.58, 1.07, z], materials.trim);
      portalPost.name = 'Gangway portal upright';
    }
  }
  for (const z of [-0.485, 0.485]) {
    const portalHeader = addBox(root, [1.245, 0.09, 0.07], [0, 2.14, z], materials.trim);
    portalHeader.name = 'Gangway portal header';
  }
  return root;
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
 * and dwells at each station. Players cross the physical doorway, walk on the
 * moving floor, optionally use an unclaimed seat, and cross back onto a platform
 * only while the doors are open at a stop.
 */
export class RegionalRailwayService {
  constructor(scene, world, controls, {
    onBeforeTravel = null,
    audioBus = null,
    passengerManifestProvider = null,
    passengerIdentityProvider = null,
    passengerAvatarFactory = null,
    npcDoorHoldProvider = null,
    scheduleSnapshotProvider = null,
    onScheduleSnapshot = null,
  } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.onBeforeTravel = onBeforeTravel;
    this.passengerManifestProvider = typeof passengerManifestProvider === 'function'
      ? passengerManifestProvider : null;
    this.passengerIdentityProvider = typeof passengerIdentityProvider === 'function'
      ? passengerIdentityProvider : null;
    this.passengerAvatarFactory = typeof passengerAvatarFactory === 'function'
      ? passengerAvatarFactory : null;
    this.npcDoorHoldProvider = typeof npcDoorHoldProvider === 'function'
      ? npcDoorHoldProvider : null;
    this._passengerPresentations = new Map();
    this.scheduleSnapshotProvider = typeof scheduleSnapshotProvider === 'function'
      ? scheduleSnapshotProvider : null;
    this.onScheduleSnapshot = typeof onScheduleSnapshot === 'function'
      ? onScheduleSnapshot : null;
    this._scheduleSnapshotElapsed = 0;
    this._passengerManifestReadFailed = false;
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
    this.gangway = null;

    this.riding = false; // aboard, whether standing or seated
    this.seated = false;
    this.ridingCarriage = -1;
    this.savedControlsEnabled = false;
    this.viewIndex = 0;
    this.seatIndex = -1;
    this._standingLocal = new THREE.Vector3();
    this._lastStandingLocal = new THREE.Vector3();
    this._lastOnFootPosition = this.controls.rig.position.clone();
    this._trainEnvironmentRelease = null;
    // WebXR cameras already contain the headset's floor-relative eye pose. A
    // separate origin below the authored eye-level seat prevents that height
    // from being added twice while the carriage carries the player.
    this.xrSeatOrigin = new THREE.Object3D();
    this.xrSeatOrigin.name = 'XR passenger tracking origin';
    this.interactionCue = null;
    this.ridingHintTimer = 0;
    this.notice = '';
    this.noticeTimer = 0;
    this._prevKeys = { interact: false, view: false };

    this._trainEnvironment = {
      isIndoor: () => true,
      floorHeight: (x, z) => this.trainFloorHeight(x, z),
      resolveMovement: (position, previous) => this.resolveInteriorMovement(position, previous),
    };
    this._trainObstacleRelease = this.controls.registerObstacleResolver?.(
      'regional-passenger-train',
      { resolveMovement: (position, previous) => this.resolveExteriorMovement(position, previous) },
      20,
    ) || null;

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
    this.clearPassengerPresentations();
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
    this.gangway = null;
    this.interactionCue = null;
    this.ridingHintTimer = 0;
    this._scheduleSnapshotElapsed = 0;
  }

  setPlan(plan = null) {
    // Preserve the final fraction of a second before replacing a compatible
    // service plan. This callback is optional and remains inert in legacy play.
    this.publishScheduleSnapshot(true);
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

    // Named after the villages they serve, as everywhere else that names them.
    // Without the supplier this call quietly re-named every station from its
    // biome, overwriting the village names the track stream had just set — and
    // because the service takes the plan last, its names were the ones on the
    // departure board while the platform sign beside it read the village's.
    nameRegionalStations(plan, {
      world: this.world, seed: plan.seed,
      placeName: (station) => stationVillageName(this.world, station),
    });

    // Visit stations in the order they appear along the route.
    const stopOrder = this.stations
      .map((s, i) => ({ i, d: s.routeDistance }))
      .sort((a, b) => a.d - b.d);
    this.stopStationByOrder = stopOrder.map((s) => s.i);
    const stopDistances = stopOrder.map((s) => s.d);
    const freshSchedule = new TrainScheduleModel(this.route.length, stopDistances, {
      ...RAILWAY_SERVICE_DEFAULTS,
      serviceId: 'regional',
      serviceEpoch: createRailServiceEpoch(this.route.length, stopOrder.map(({ i, d }) => ({
        distance: d,
        stationId: this.stations[i]?.id ?? `station:${i}`,
      }))),
    });
    this.schedule = this.restoreScheduleSnapshot(freshSchedule, plan);

    this.locomotive = makeLocomotive(this.materials);
    this.locomotive.traverse((o) => { if (o.geometry) o.userData.serviceOwned = true; });
    this.group.add(this.locomotive);
    for (let i = 0; i < 2; i++) {
      const carriage = makeCarriage(this.materials, { interCarEnd: i === 0 ? -1 : 1 });
      carriage.root.traverse((o) => { if (o.geometry) o.userData.serviceOwned = true; });
      this.group.add(carriage.root);
      this.carriages.push(carriage);
    }
    this.gangway = makeInterCarGangway(this.materials);
    this.gangway.traverse((o) => { if (o.geometry) o.userData.serviceOwned = true; });
    this.group.add(this.gangway);

    this.group.visible = true;
    this.buildRouteMap();
    this.update(0, this.controls.rig.position);
    this.publishScheduleSnapshot(true);
    this.debug.status = `${this.stations.length} stations · ${(this.route.length / 1000).toFixed(1)}km loop`;
  }

  /**
   * Resume only a snapshot authored for this exact service alignment. Route
   * regeneration or corrupt state must never strand the visible train, so an
   * incompatible provider result quietly preserves the established fresh start.
   */
  restoreScheduleSnapshot(freshSchedule, plan = null) {
    if (!this.scheduleSnapshotProvider) return freshSchedule;
    try {
      const snapshot = this.scheduleSnapshotProvider(
        freshSchedule.serviceId, freshSchedule, plan,
      );
      if (!snapshot) return freshSchedule;
      const restored = TrainScheduleModel.restore(snapshot);
      if (!this.scheduleRoutesMatch(freshSchedule, restored)) return freshSchedule;
      return restored;
    } catch {
      return freshSchedule;
    }
  }

  scheduleRoutesMatch(expected, restored) {
    if (!expected || !restored
      || expected.serviceId !== restored.serviceId
      || expected.serviceEpoch !== restored.serviceEpoch
      || expected.serviceDay !== restored.serviceDay
      || expected.stopCount !== restored.stopCount
      || Math.abs(expected.length - restored.length) > 1e-6) return false;
    return expected.stops.every((stop, index) => {
      const candidate = restored.stops[index];
      return candidate?.index === stop.index
        && Math.abs(candidate.distance - stop.distance) <= 1e-6;
    });
  }

  publishScheduleSnapshot(force = false) {
    if (!this.schedule || !this.onScheduleSnapshot) return false;
    if (!force && this._scheduleSnapshotElapsed < 1) return false;
    this._scheduleSnapshotElapsed = 0;
    try {
      this.onScheduleSnapshot(
        this.schedule.serviceId, this.schedule.snapshot(), this.schedule,
      );
      return true;
    } catch {
      // Persistence cannot be allowed to interrupt locomotion or player input.
      return false;
    }
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

  interCarriageEndpoints() {
    const leading = this.carriages[0]?.root;
    const trailing = this.carriages[1]?.root;
    if (!leading || !trailing) return false;
    leading.updateWorldMatrix(true, false);
    trailing.updateWorldMatrix(true, false);
    _gangwayA.set(0, RAIL_CARRIAGE.floorY, -RAIL_CARRIAGE.halfLength);
    _gangwayB.set(0, RAIL_CARRIAGE.floorY, RAIL_CARRIAGE.halfLength);
    leading.localToWorld(_gangwayA);
    trailing.localToWorld(_gangwayB);
    return true;
  }

  gangwayProjection(x, z) {
    if (!this.interCarriageEndpoints()) return null;
    const dx = _gangwayB.x - _gangwayA.x;
    const dz = _gangwayB.z - _gangwayA.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-6) return null;
    const t = ((x - _gangwayA.x) * dx + (z - _gangwayA.z) * dz) / lengthSquared;
    const nearestX = _gangwayA.x + dx * t;
    const nearestZ = _gangwayA.z + dz * t;
    return {
      t,
      lateral: Math.hypot(x - nearestX, z - nearestZ),
      floorY: THREE.MathUtils.lerp(_gangwayA.y, _gangwayB.y, t),
    };
  }

  updateInterCarGangway() {
    if (!this.gangway || !this.interCarriageEndpoints()) return;
    _gangwayCenter.copy(_gangwayA).add(_gangwayB).multiplyScalar(0.5);
    _gangwayVector.copy(_gangwayB).sub(_gangwayA);
    const length = _gangwayVector.length();
    if (length < 1e-5) {
      this.gangway.visible = false;
      return;
    }
    _gangwayVector.multiplyScalar(1 / length);
    _gangwayUp.set(0, 1, 0).applyQuaternion(this.carriages[0].root.quaternion);
    _gangwayOtherRight.set(0, 1, 0).applyQuaternion(this.carriages[1].root.quaternion);
    _gangwayUp.add(_gangwayOtherRight).normalize();
    _gangwayRight.crossVectors(_gangwayUp, _gangwayVector).normalize();
    _gangwayUp.crossVectors(_gangwayVector, _gangwayRight).normalize();
    _matrix.makeBasis(_gangwayRight, _gangwayUp, _gangwayVector);
    this.gangway.position.copy(_gangwayCenter);
    this.gangway.quaternion.setFromRotationMatrix(_matrix);
    this.gangway.scale.set(1, 1, length);
    this.gangway.visible = true;
    this.gangway.updateWorldMatrix(true, true);
  }

  // The schedule distance marks where the *first carriage* rests, so a dwelling
  // train presents that carriage's doors at the platform; the locomotive rides
  // one spacing ahead, and further carriages trail behind.
  carriageDistance(carriageIndex) {
    return this.schedule.distance - carriageIndex * CARRIAGE_SPACING;
  }

  /** Resolve durable NPC transfer choreography against the live moving car. */
  npcPassengerWorldPose(transfer) {
    const local = npcRailCarriageLocalPose(transfer);
    const carriage = this.carriages[transfer?.carriageIndex];
    if (!local || !carriage?.root || transfer.runId !== this.schedule?.serviceRunId) return null;
    carriage.root.updateWorldMatrix(true, false);
    _pos.set(local.x, local.y, local.z);
    carriage.root.localToWorld(_pos);
    _forward.set(Math.sin(local.yaw), 0, Math.cos(local.yaw));
    _forward.applyQuaternion(carriage.root.quaternion);
    return {
      x: _pos.x, y: _pos.y, z: _pos.z,
      heading: Math.atan2(_forward.x, _forward.z),
      progress: Number(transfer.progress) || 0,
      mode: local.mode,
      seated: local.seated,
      railPhase: transfer.phase,
    };
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

  /**
   * Optional, read-only bridge to the living-world passenger authority.
   * Signature: provider(schedule.serviceRunId, schedule) => RailPassengerManifest|null.
   * The renderer never creates, reserves, boards, or alights passengers.
   */
  passengerManifest() {
    this._passengerManifestReadFailed = false;
    if (!this.schedule || !this.passengerManifestProvider) return null;
    try {
      const manifest = this.passengerManifestProvider(this.schedule.serviceRunId, this.schedule);
      if (manifest == null) return null;
      if (manifest instanceof RailPassengerManifest) return manifest;
    } catch {
      // Corrupt persisted authority fails closed below; controls remain intact.
    }
    this._passengerManifestReadFailed = true;
    if (this.debug) this.debug.passengerAuthority = 'unavailable';
    return null;
  }

  setPassengerManifestProvider(provider = null) {
    const next = typeof provider === 'function' ? provider : null;
    if (next !== this.passengerManifestProvider) this.clearPassengerPresentations();
    this.passengerManifestProvider = next;
    this._passengerManifestReadFailed = false;
  }

  /**
   * Opt-in visual bridge for unified NPC mobility. Both providers are required:
   * identityProvider(personId, reservation, schedule) supplies canonical identity;
   * avatarFactory({ identity, reservation, schedule, anchor }) supplies a visual.
   * With either provider absent, no synthetic passenger identity is invented.
   */
  setPassengerPresentationProviders({ identityProvider = null, avatarFactory = null } = {}) {
    const nextIdentityProvider = typeof identityProvider === 'function'
      ? identityProvider : null;
    const nextAvatarFactory = typeof avatarFactory === 'function'
      ? avatarFactory : null;
    if (nextIdentityProvider !== this.passengerIdentityProvider
      || nextAvatarFactory !== this.passengerAvatarFactory) {
      this.clearPassengerPresentations();
    }
    this.passengerIdentityProvider = nextIdentityProvider;
    this.passengerAvatarFactory = nextAvatarFactory;
    if (!this.passengerIdentityProvider || !this.passengerAvatarFactory) {
      this.clearPassengerPresentations();
    }
  }

  passengerPresentationRecords() {
    return [...this._passengerPresentations.values()].map(({ record }) => record);
  }

  removePassengerPresentation(key) {
    const presentation = this._passengerPresentations.get(key);
    if (!presentation) return false;
    this._passengerPresentations.delete(key);
    try { presentation.root?.removeFromParent?.(); } catch { /* presentation is optional */ }
    try { presentation.dispose?.(); } catch { /* disposal cannot interrupt the train */ }
    return true;
  }

  clearPassengerPresentations() {
    for (const key of [...this._passengerPresentations.keys()]) {
      this.removePassengerPresentation(key);
    }
  }

  mountPassengerPresentation(presentation, anchor) {
    if (!presentation?.root || !anchor?.add
      || !presentation.root.position?.set || !presentation.root.rotation?.set) return false;
    const local = presentation.seatLocalPosition || { x: 0, y: -1.75, z: 0 };
    const yaw = Number.isFinite(presentation.seatLocalYaw)
      ? presentation.seatLocalYaw : (anchor.userData.yaw ?? 0);
    anchor.add(presentation.root);
    presentation.root.position.set(
      Number(local.x) || 0,
      Number.isFinite(Number(local.y)) ? Number(local.y) : -1.75,
      Number(local.z) || 0,
    );
    presentation.root.rotation.set(0, yaw, 0);
    return true;
  }

  createPassengerPresentation(record) {
    const anchor = this.passengerSeatAnchor(record.carriageIndex, record.seatIndex);
    if (!anchor) return false;
    let created = null;
    let root = null;
    try {
      const reservation = this._passengerReservationById?.get(record.reservationId) ?? null;
      const identity = this.passengerIdentityProvider(
        record.personId, reservation, this.schedule,
      );
      if (!identity) return false;
      created = this.passengerAvatarFactory({
        identity, reservation, schedule: this.schedule, anchor,
      });
      root = created?.root ?? created?.object ?? created;
      const presentation = {
        record,
        root,
        update: typeof created?.update === 'function' ? created.update.bind(created) : null,
        dispose: typeof created?.dispose === 'function' ? created.dispose.bind(created) : null,
        seatLocalPosition: created?.seatLocalPosition,
        seatLocalYaw: created?.seatLocalYaw,
        identity,
        reservation,
      };
      if (!this.mountPassengerPresentation(presentation, anchor)) {
        try { presentation.dispose?.(); } catch { /* optional visual */ }
        try { root?.removeFromParent?.(); } catch { /* optional visual */ }
        return false;
      }
      this._passengerPresentations.set(record.key, presentation);
      return true;
    } catch {
      // A bad identity or avatar is omitted; train movement and input continue.
      try { root?.removeFromParent?.(); } catch { /* optional visual */ }
      try { created?.dispose?.(); } catch { /* optional visual */ }
      return false;
    }
  }

  /** Mirror boarded NPC reservations without ever mutating their manifest. */
  reconcilePassengerPresentations(dt = 0) {
    if (!this.schedule || !this.passengerIdentityProvider || !this.passengerAvatarFactory) {
      this.clearPassengerPresentations();
      return false;
    }
    const manifest = this.passengerManifest();
    if (!manifest) {
      this.clearPassengerPresentations();
      return false;
    }

    let reservations;
    let plan;
    try {
      reservations = manifest.reservations({ includeAlighted: true });
      this._passengerReservationById = new Map(
        reservations.map((reservation) => [reservation.reservationId, reservation]),
      );
      plan = planRailPassengerPresentations(this.passengerPresentationRecords(), {
        runId: this.schedule.serviceRunId,
        reservations,
      });
    } catch {
      this._passengerReservationById = null;
      this.clearPassengerPresentations();
      return false;
    }

    for (const operation of plan.operations) {
      if (operation.type === 'remove') this.removePassengerPresentation(operation.record.key);
    }
    for (const operation of plan.operations) {
      if (operation.type === 'create') this.createPassengerPresentation(operation.record);
      if (operation.type === 'update') {
        const existing = this._passengerPresentations.get(operation.record.key);
        const anchor = this.passengerSeatAnchor(
          operation.record.carriageIndex, operation.record.seatIndex,
        );
        if (!existing || existing.record.personId !== operation.record.personId
          || !anchor || !this.mountPassengerPresentation(existing, anchor)) {
          this.removePassengerPresentation(operation.record.key);
          this.createPassengerPresentation(operation.record);
        } else {
          existing.record = operation.record;
          existing.reservation = this._passengerReservationById.get(operation.record.reservationId);
        }
      }
    }

    for (const [key, presentation] of this._passengerPresentations) {
      try {
        presentation.reservation = this._passengerReservationById.get(
          presentation.record.reservationId,
        ) ?? presentation.reservation;
        presentation.update?.({
          dt: Math.max(0, Number(dt) || 0),
          identity: presentation.identity,
          reservation: presentation.reservation,
          schedule: this.schedule,
          anchor: this.passengerSeatAnchor(
            presentation.record.carriageIndex, presentation.record.seatIndex,
          ),
        });
      } catch {
        this.removePassengerPresentation(key);
      }
    }
    this._passengerReservationById = null;
    return true;
  }

  /** Safe authored anchor lookup for the later NPC avatar materializer. */
  passengerSeatAnchor(carriageIndex, seatIndex) {
    if (!Number.isInteger(carriageIndex) || !Number.isInteger(seatIndex)
      || carriageIndex < 0 || seatIndex < 0) return null;
    return this.carriages[carriageIndex]?.seats?.[seatIndex] ?? null;
  }

  npcClaimsSeat(manifest, carriageIndex, seatIndex) {
    if (!manifest) return false;
    // A reservation for a later stop is already a capacity claim. Letting the
    // player switch into it would create a conflict only when that NPC reached
    // the door, which is much harder to resolve without a visible teleport.
    return manifest.reservations({ includeAlighted: false }).some((reservation) => (
      reservation.kind === 'npc'
      && reservation.carriageIndex === carriageIndex
      && reservation.seatIndex === seatIndex
    ));
  }

  activeCarriage() {
    return this.carriages[this.ridingCarriage] || null;
  }

  vehicleYaw(root) {
    if (!root) return 0;
    _trainDir.set(0, 0, 1).applyQuaternion(root.quaternion);
    return Math.atan2(_trainDir.x, _trainDir.z);
  }

  trainFloorHeight(x, z) {
    const gangway = this.gangwayProjection(x, z);
    if (gangway && gangway.t >= 0 && gangway.t <= 1
      && gangway.lateral <= RAIL_CARRIAGE.gangwayHalfWidth + 0.12) {
      return gangway.floorY;
    }
    const root = this.activeCarriage()?.root;
    if (!root) return null;
    root.updateWorldMatrix(true, false);
    _worldFloor.set(0, RAIL_CARRIAGE.floorY, 0);
    root.localToWorld(_worldFloor);
    _up.set(0, 1, 0).applyQuaternion(root.quaternion);
    if (Math.abs(_up.y) < 1e-5) return _worldFloor.y;
    return _worldFloor.y
      - (_up.x * (x - _worldFloor.x) + _up.z * (z - _worldFloor.z)) / _up.y;
  }

  resolveInteriorMovement(position, previous) {
    const root = this.activeCarriage()?.root;
    if (!this.riding || this.seated || !root) return null;
    root.updateWorldMatrix(true, false);
    _localPlayer.copy(position);
    _localPrevious.copy(previous);
    root.worldToLocal(_localPlayer);
    root.worldToLocal(_localPrevious);
    const result = resolveCarriageMovementLocal(_localPlayer, _localPrevious, {
      doorFactor: this.schedule?.doorFactor ?? 0,
      includeBenches: true,
      interCarEnd: this.activeCarriage()?.interCarEnd ?? 0,
    });
    _worldResolved.copy(_localPlayer);
    root.localToWorld(_worldResolved);
    this.transferAcrossGangway(_worldResolved);
    position.x = _worldResolved.x;
    position.z = _worldResolved.z;
    return {
      ...result,
      acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z),
      floorHeight: this.trainFloorHeight(position.x, position.z),
    };
  }

  transferAcrossGangway(worldPosition) {
    if (!this.riding || this.seated || this.carriages.length < 2) return false;
    const projection = this.gangwayProjection(worldPosition.x, worldPosition.z);
    if (!projection || projection.t < -0.12 || projection.t > 1.12
      || projection.lateral > RAIL_CARRIAGE.gangwayHalfWidth + 0.18) return false;
    let targetIndex = this.ridingCarriage;
    // A small dead band prevents ownership flicker if the player stands on the
    // articulated midpoint while the consist bends through a curve.
    if (this.ridingCarriage === 0 && projection.t >= 0.52) targetIndex = 1;
    if (this.ridingCarriage === 1 && projection.t <= 0.48) targetIndex = 0;
    if (targetIndex === this.ridingCarriage) return false;
    const target = this.carriages[targetIndex];
    target.root.updateWorldMatrix(true, false);
    _localPlayer.copy(worldPosition);
    target.root.worldToLocal(_localPlayer);
    _localPlayer.y = RAIL_CARRIAGE.floorY;
    this.ridingCarriage = targetIndex;
    this._standingLocal.copy(_localPlayer);
    this._lastStandingLocal.copy(_localPlayer);
    return true;
  }

  resolveExteriorMovement(position, previous) {
    if (this.riding || !this.schedule || !this.group.visible) return null;
    const originalX = position.x, originalZ = position.z;
    let blocked = false;
    for (const carriage of this.carriages) {
      const root = carriage.root;
      root.updateWorldMatrix(true, false);
      _localPlayer.copy(position);
      _localPrevious.copy(previous);
      root.worldToLocal(_localPlayer);
      root.worldToLocal(_localPrevious);
      const closeEnough = Math.abs(_localPlayer.x) <= RAIL_CARRIAGE.wallX + 1
        && Math.abs(_localPlayer.z) <= RAIL_CARRIAGE.halfLength + 1
        && _localPlayer.y >= -0.25
        && _localPlayer.y <= RAIL_CARRIAGE.ceilingY + 0.35;
      if (!closeEnough) continue;
      const result = resolveCarriageMovementLocal(_localPlayer, _localPrevious, {
        doorFactor: this.schedule.doorFactor,
        includeBenches: false,
      });
      if (!result.blocked) continue;
      blocked = true;
      _worldResolved.copy(_localPlayer);
      root.localToWorld(_worldResolved);
      position.x = _worldResolved.x;
      position.z = _worldResolved.z;
    }
    if (!blocked) return null;
    return {
      blocked: true,
      acceptedDistance: Math.hypot(position.x - previous.x, position.z - previous.z),
      displacedDistance: Math.hypot(position.x - originalX, position.z - originalZ),
    };
  }

  enableTrainEnvironment() {
    this._trainEnvironmentRelease?.();
    this._trainEnvironmentRelease = this.controls.setEnvironmentOverride?.(
      'regional-passenger-carriage', this._trainEnvironment, 100,
    ) || null;
  }

  disableTrainEnvironment() {
    this._trainEnvironmentRelease?.();
    this._trainEnvironmentRelease = null;
  }

  enterStanding(carriageIndex, localPosition = null, side = 1) {
    const carriage = this.carriages[carriageIndex];
    if (this.riding || !carriage || !this.schedule?.atStation
      || !carriageDoorIsPassable(this.schedule.doorFactor)) return false;
    this.onBeforeTravel?.();
    this.savedControlsEnabled = this.controls.enabled;
    this.riding = true;
    this.seated = false;
    this.ridingCarriage = carriageIndex;
    this.seatIndex = -1;
    this.controls.enabled = true;
    this.controls.allowLook = false;
    this.controls.keys.delete('Space');
    this.controls.jumpQueued = false;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    const local = this._standingLocal;
    if (localPosition) local.copy(localPosition);
    else local.set(side * (RAIL_CARRIAGE.interiorHalfWidth - 0.05), RAIL_CARRIAGE.floorY, 0);
    local.x = THREE.MathUtils.clamp(
      local.x, -RAIL_CARRIAGE.interiorHalfWidth + 0.05,
      RAIL_CARRIAGE.interiorHalfWidth - 0.05,
    );
    local.y = RAIL_CARRIAGE.floorY;
    local.z = THREE.MathUtils.clamp(
      local.z, -RAIL_CARRIAGE.interiorHalfLength + RAIL_CARRIAGE.playerRadius,
      RAIL_CARRIAGE.interiorHalfLength - RAIL_CARRIAGE.playerRadius,
    );
    carriage.root.updateWorldMatrix(true, false);
    _worldResolved.copy(local);
    carriage.root.localToWorld(_worldResolved);
    this.controls.rig.position.copy(_worldResolved);
    this._lastStandingLocal.copy(local);
    this.enableTrainEnvironment();
    this.ridingHintTimer = PASSENGER_HINT_SECONDS.boarding;
    this.flash(`Aboard — ${this.currentDestinationLabel()}`);
    return true;
  }

  tryBoardNearest() {
    if (this.riding || !this.schedule?.atStation
      || !carriageDoorIsPassable(this.schedule.doorFactor)) return false;
    const near = this.nearestDoor(this.controls.rig.position);
    if (!near || near.dist > this.boardRange()) return false;
    const root = this.carriages[near.carriage]?.root;
    if (!root) return false;
    _localPlayer.copy(this.controls.rig.position);
    root.worldToLocal(_localPlayer);
    const side = Math.sign(_localPlayer.x) || 1;
    _localPlayer.x = side * (RAIL_CARRIAGE.interiorHalfWidth - 0.05);
    return this.enterStanding(near.carriage, _localPlayer, side);
  }

  board(carriageIndex) {
    if (this.riding || !this.carriages[carriageIndex]) return false;
    return this.enterStanding(carriageIndex, null, 1);
  }

  trySitNearest() {
    const carriage = this.activeCarriage();
    if (!this.riding || this.seated || !carriage) return false;
    const manifest = this.passengerManifest();
    if (this._passengerManifestReadFailed) {
      this.flash('Passenger records are unavailable', 2.2);
      return false;
    }
    carriage.root.updateWorldMatrix(true, false);
    _localPlayer.copy(this.controls.rig.position);
    carriage.root.worldToLocal(_localPlayer);
    const nearest = nearestCarriageSeat(
      _localPlayer.x, _localPlayer.z,
      (index) => this.npcClaimsSeat(manifest, this.ridingCarriage, index),
    );
    if (!nearest) {
      this.flash('Move beside an available seat to sit down', 1.8);
      return false;
    }
    return this.sit(nearest.index);
  }

  sit(seatIndex) {
    const seat = this.passengerSeatAnchor(this.ridingCarriage, seatIndex);
    if (!this.riding || this.seated || !seat) return false;
    this.controls.enabled = false;
    this.controls.allowLook = true; // free mouselook from the seat
    this.controls.keys.clear();
    this.controls.speed = 0;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    this.seatIndex = seatIndex;
    this.seated = true;
    this.controls.camera.rotation.order = 'YXZ';
    this.attachCameraToSeat(seat);
    this.viewIndex = this.seatIndex;
    this.applyView();
    this.ridingHintTimer = PASSENGER_HINT_SECONDS.seatSwitch;
    this.flash(`Seated: ${seat.userData.label}`, 1.5);
    return true;
  }

  standUp({ silent = false } = {}) {
    const carriage = this.activeCarriage();
    const stand = carriageAisleStandForSeat(this.seatIndex);
    if (!this.riding || !this.seated || !carriage || !stand) return false;
    this.controls.camera.getWorldDirection(_trainDir);
    const camera = this.controls.camera;
    const xr = this.controls.renderer.xr.isPresenting;
    this.controls.allowLook = false;
    camera.rotation.order = 'XYZ';
    this.controls.rig.add(camera);
    this.xrSeatOrigin.removeFromParent();
    this._standingLocal.set(stand.x, stand.y, stand.z);
    carriage.root.updateWorldMatrix(true, false);
    _worldResolved.copy(this._standingLocal);
    carriage.root.localToWorld(_worldResolved);
    this.controls.rig.position.copy(_worldResolved);
    this.controls.yaw = Math.atan2(-_trainDir.x, -_trainDir.z);
    this.controls.pitch = Math.asin(THREE.MathUtils.clamp(_trainDir.y, -1, 1));
    this.controls.rig.rotation.y = this.controls.yaw;
    if (!xr) {
      camera.position.set(0, this.controls.eyeHeight, 0);
      camera.rotation.set(this.controls.pitch, 0, 0);
    }
    this.controls.enabled = true;
    this.controls.speed = 0;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    this.seated = false;
    this.seatIndex = -1;
    this._lastStandingLocal.copy(this._standingLocal);
    if (!silent) this.flash('Standing in carriage', 1.4);
    return true;
  }

  /** Administrative escape used by plan replacement/debug teardown. Normal
   * passengers alight only by walking across an open station doorway. */
  leave(reposition = true) {
    if (!this.riding) return;
    if (this.seated) this.standUp({ silent: true });
    this.disableTrainEnvironment();

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
    this.seated = false;
    this.ridingCarriage = -1;
    this.seatIndex = -1;
    this.ridingHintTimer = 0;
    this._lastOnFootPosition.copy(this.controls.rig.position);
  }

  activeSeat() {
    if (!this.seated) return null;
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
    if (!this.riding || !this.seated) return false;
    const carriage = this.carriages[this.ridingCarriage];
    if (!carriage?.seats?.length) return false;
    const manifest = this.passengerManifest();
    if (this._passengerManifestReadFailed) {
      this.flash('Passenger records are unavailable', 2.2);
      return false;
    }
    let nextSeat = this.seatIndex;
    for (let offset = 1; offset < carriage.seats.length; offset++) {
      const candidate = (this.seatIndex + offset) % carriage.seats.length;
      if (!this.npcClaimsSeat(manifest, this.ridingCarriage, candidate)) {
        nextSeat = candidate;
        break;
      }
    }
    if (nextSeat === this.seatIndex) return false;
    this.seatIndex = nextSeat;
    this.viewIndex = this.seatIndex;
    const seat = this.activeSeat();
    this.attachCameraToSeat(seat);
    this.applyView();
    this.ridingHintTimer = Math.max(this.ridingHintTimer, PASSENGER_HINT_SECONDS.seatSwitch);
    this.flash(`Seat: ${seat.userData.label}`, 1.5);
    return true;
  }

  detectWalkingBoarding() {
    if (this.riding || !this.schedule?.atStation
      || !carriageDoorIsPassable(this.schedule.doorFactor)) return false;
    for (let index = 0; index < this.carriages.length; index++) {
      const root = this.carriages[index].root;
      root.updateWorldMatrix(true, false);
      _localPrevious.copy(this._lastOnFootPosition);
      _localPlayer.copy(this.controls.rig.position);
      root.worldToLocal(_localPrevious);
      root.worldToLocal(_localPlayer);
      const crossing = carriageThresholdCrossing(_localPrevious, _localPlayer, {
        doorFactor: this.schedule.doorFactor,
        direction: 'enter',
      }) || carriageBoardingApproach(_localPrevious, _localPlayer, {
        doorFactor: this.schedule.doorFactor,
      });
      if (crossing) {
        _localPlayer.z = crossing.z;
        return this.enterStanding(index, _localPlayer, crossing.side);
      }
    }
    return false;
  }

  exitStanding(crossing, localPosition) {
    const carriage = this.activeCarriage();
    if (!this.riding || this.seated || !carriage || !crossing?.exiting) return false;
    const stationIndex = this.schedule.currentStationIndex;
    const outside = _localPlayer.copy(localPosition);
    outside.x = crossing.side * (
      RAIL_CARRIAGE.wallX + RAIL_CARRIAGE.playerRadius + 0.08
    );
    outside.y = RAIL_CARRIAGE.floorY;
    carriage.root.localToWorld(outside);
    this.disableTrainEnvironment();
    const baseFloor = this.controls.baseEnvironment?.floorHeight?.(outside.x, outside.z);
    outside.y = Number.isFinite(baseFloor)
      ? baseFloor
      : this.controls.surfaceHeight(outside.x, outside.z, outside.y + 0.5);
    this.controls.rig.position.copy(outside);
    this.controls.enabled = this.savedControlsEnabled;
    this.controls.allowLook = false;
    this.controls.speed = 0;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    this.riding = false;
    this.seated = false;
    this.ridingCarriage = -1;
    this.seatIndex = -1;
    this.ridingHintTimer = 0;
    this._lastOnFootPosition.copy(outside);
    this.flash(`Alighted at ${this.stationName(stationIndex)}`);
    return true;
  }

  captureStandingBeforeTrainMoves() {
    const carriage = this.activeCarriage();
    if (!this.riding || this.seated || !carriage) return null;
    carriage.root.updateWorldMatrix(true, false);
    _localPlayer.copy(this.controls.rig.position);
    carriage.root.worldToLocal(_localPlayer);
    const crossing = carriageThresholdCrossing(this._lastStandingLocal, _localPlayer, {
      doorFactor: this.schedule.doorFactor,
      direction: 'exit',
    }) || carriageAlightingApproach(this._lastStandingLocal, _localPlayer, {
      doorFactor: this.schedule.doorFactor,
    }) || carriageAlightingRecovery(_localPlayer, {
      doorFactor: this.schedule.doorFactor,
    });
    if (crossing && this.schedule.atStation
      && carriageDoorIsPassable(this.schedule.doorFactor)) {
      _localPlayer.z = crossing.z;
      this.exitStanding(crossing, _localPlayer);
      return null;
    }

    // Keep the doors fully open while a passenger's capsule overlaps the
    // threshold. This is both kinder at the end of a dwell and prevents a
    // closing panel from pinning someone halfway in the doorway.
    if (this.schedule.atStation
      && Math.abs(Math.abs(_localPlayer.x) - RAIL_CARRIAGE.wallX)
        <= RAIL_CARRIAGE.playerRadius + 0.15
      && Math.abs(_localPlayer.z) <= RAIL_CARRIAGE.doorwayHalfWidth) {
      this.schedule.dwellRemaining = Math.max(this.schedule.dwellRemaining, 2.2);
    }
    this._standingLocal.copy(_localPlayer);
    this._standingLocal.y = RAIL_CARRIAGE.floorY;
    return {
      carriage,
      local: this._standingLocal.clone(),
      yaw: this.vehicleYaw(carriage.root),
    };
  }

  carryStandingPassenger(carry) {
    if (!carry || !this.riding || this.seated) return;
    carry.carriage.root.updateWorldMatrix(true, false);
    _worldResolved.copy(carry.local);
    carry.carriage.root.localToWorld(_worldResolved);
    this.controls.rig.position.copy(_worldResolved);
    const yawDelta = THREE.MathUtils.euclideanModulo(
      this.vehicleYaw(carry.carriage.root) - carry.yaw + Math.PI,
      Math.PI * 2,
    ) - Math.PI;
    this.controls.yaw += yawDelta;
    this.controls.rig.rotation.y += yawDelta;
    this._lastStandingLocal.copy(carry.local);
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
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

    // Controls have already applied this frame's world-space walk. Read it in
    // the carriage's OLD transform, then move the train and reapply that local
    // point in the NEW transform so walking and vehicle motion compose cleanly.
    if (canInteract && !this.riding) this.detectWalkingBoarding();
    const standingCarry = this.captureStandingBeforeTrainMoves();

    if (this.schedule.atStation && this.npcDoorHoldProvider) {
      try {
        if (this.npcDoorHoldProvider(this.schedule.serviceRunId, this.schedule)) {
          this.schedule.dwellRemaining = Math.max(this.schedule.dwellRemaining, 2.5);
        }
      } catch { /* optional safety hold must not interrupt the service */ }
    }
    this.schedule.step(dt);
    this._scheduleSnapshotElapsed += Math.max(0, Number(dt) || 0);
    this.publishScheduleSnapshot(this.schedule.justArrived || this.schedule.justDeparted);
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
    this.updateInterCarGangway();

    this.reconcilePassengerPresentations(dt);

    if (this.seated) this.syncSeatedRig();
    else this.carryStandingPassenger(standingCarry);

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

    // Boarding and alighting are physical doorway crossings. E/B only toggles
    // sitting at a nearby seat; V/X retains the existing seat-switch shortcut.
    const keys = this.controls.keys;
    const interactDown = keys.has('KeyE');
    const viewDown = keys.has('KeyV');
    const xrAction = !!this.controls.xrActions?.interactPressed;
    const xrSwitchSeat = !!this.controls.xrActions?.switchSeatPressed;
    const interact = canInteract && (this.controls.enabled || this.riding);
    if (interact && this.riding
      && ((interactDown && !this._prevKeys.interact) || xrAction)) {
      if (this.seated) this.standUp();
      else this.trySitNearest();
    }
    if (interact && this.seated
      && ((viewDown && !this._prevKeys.view) || xrSwitchSeat)) this.cycleView();
    this._prevKeys.interact = interactDown;
    this._prevKeys.view = viewDown;

    if (this.noticeTimer > 0) this.noticeTimer -= dt;
    if (this.riding) this.ridingHintTimer = stepPassengerHintTimer(this.ridingHintTimer, dt);
    // Only surface passenger HUD once the player is actually in the world
    // (walking or aboard) — never behind the start overlay.
    this.refreshHud(playerPos, interact);
    this.debug.status = `${this.schedule.phase} · ${this.currentDestinationLabel()} · ${this.schedule.velocity.toFixed(1)}m/s`;
    if (!this.riding) this._lastOnFootPosition.copy(this.controls.rig.position);
  }

  syncSeatedRig() {
    const seat = this.activeSeat();
    if (!seat) return;
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
    const interactButton = xr ? 'B' : 'E';
    const seatButton = xr ? 'X' : 'V';

    if (this.riding) {
      const showRidingHint = this.ridingHintTimer > 0;
      this.interactionCue = showRidingHint ? {
        mode: 'riding',
        primaryButton: 'B',
        primaryAction: this.seated ? 'STAND' : 'SIT NEAR SEAT',
        ...(this.seated ? {
          secondaryButton: 'X',
          secondaryAction: 'SWITCH SEAT',
        } : {}),
      } : null;
      this.mapEl.style.display = 'block';
      this.refreshRouteMap();
      if (!showRidingHint) {
        this.setPrompt('');
      } else if (this.seated) {
        const destination = this.schedule.atStation
          ? this.stationName(this.schedule.currentStationIndex)
          : this.stationName(this.schedule.nextStationIndex);
        this.setPrompt(`<b>${destination}</b> · <b>${interactButton}</b> stand · <b>${seatButton}</b> switch seat`);
      } else if (this.schedule.atStation) {
        this.setPrompt(`<b>${this.stationName(this.schedule.currentStationIndex)}</b> · walk through the open doorway to alight · <b>${interactButton}</b> sit near a seat`);
      } else {
        const eta = Math.max(1, Math.round(this.schedule.etaSeconds));
        this.setPrompt(`Next: <b>${this.stationName(this.schedule.nextStationIndex)}</b> · ~${eta}s · walk around or <b>${interactButton}</b> sit near a seat`);
      }
      return;
    }

    // On foot: show the boarding prompt at a dwelling train, or a platform
    // arrival board when standing near a station.
    const near = this.nearestDoor(playerPos);
    if (this.schedule.atStation && near && near.dist <= this.boardRange()) {
      this.interactionCue = null;
      this.mapEl.style.display = 'block';
      this.refreshRouteMap();
      this.setPrompt(`Walk through the open doorway to board · ${this.currentDestinationLabel()}`);
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

  dispose() {
    this.publishScheduleSnapshot(true);
    if (this.riding) this.leave(false);
    this.clearTrain();
    this.group.removeFromParent();
    this.promptEl?.remove?.();
    this.mapEl?.remove?.();
    this.smoke.dispose?.();
    this.trainAudio.dispose?.();
    this.disableTrainEnvironment();
    this._trainObstacleRelease?.();
    this._trainObstacleRelease = null;
    this.schedule = null;
    this.plan = null;
    this.route = null;
    this.stations = [];
  }
}
