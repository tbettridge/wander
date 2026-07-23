import * as THREE from 'three';
import { createClosedRailRoute } from './railwayroute.mjs';

const TRACK_GAUGE = 1.44;
const TRACK_HALF_GAUGE = TRACK_GAUGE * 0.5;
const RAIL_HEIGHT = 0.17;
const VIEW_NAMES = ['right window', 'left window', 'forward'];

const _sampleA = {};
const _sampleB = {};
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();

function manualLoopPoints(center) {
  const local = [
    [-222, -30], [-180, -120], [-88, -166], [38, -158],
    [150, -112], [218, -28], [205, 70], [124, 144],
    [12, 171], [-104, 148], [-190, 78],
  ];
  return local.map(([x, z]) => ({ x: center.x + x, z: center.z + z }));
}

export function findRailLabSite(world, near, {
  minRadius = 650,
  maxRadius = 3100,
} = {}) {
  let best = null;
  const probeCount = 12;
  for (let radius = minRadius; radius <= maxRadius; radius += 280) {
    for (let i = 0; i < 12; i++) {
      const angle = i / 12 * Math.PI * 2 + radius * 0.0017;
      const center = {
        x: near.x + Math.cos(angle) * radius,
        z: near.z + Math.sin(angle) * radius,
      };
      let minH = Infinity, maxH = -Infinity, slopeTotal = 0;
      let invalid = false;
      for (let p = 0; p < probeCount; p++) {
        const a = p / probeCount * Math.PI * 2;
        const x = center.x + Math.cos(a) * 210;
        const z = center.z + Math.sin(a) * 155;
        const biome = world.biomeAt(x, z);
        if (biome.h < 2.5 || biome.slope > 0.24 || world.riverAt(x, z).wet) {
          invalid = true;
          break;
        }
        minH = Math.min(minH, biome.h);
        maxH = Math.max(maxH, biome.h);
        slopeTotal += biome.slope;
      }
      if (invalid) continue;
      const relief = maxH - minH;
      const score = relief * 5 + slopeTotal * 18 + radius * 0.001;
      if (!best || score < best.score) best = { ...center, score, relief };
    }
  }
  return best || { x: near.x + 900, z: near.z + 900, score: Infinity, relief: 0 };
}

class OffsetRouteCurve extends THREE.Curve {
  constructor(route, lateral, vertical) {
    super();
    this.route = route;
    this.lateral = lateral;
    this.vertical = vertical;
    this.sample = {};
  }

  getPoint(t, target = new THREE.Vector3()) {
    const s = this.route.sampleAtDistance(t * this.route.length, this.sample);
    return target.set(
      s.x + s.rightX * this.lateral + s.upX * this.vertical,
      s.y + s.rightY * this.lateral + s.upY * this.vertical,
      s.z + s.rightZ * this.lateral + s.upZ * this.vertical,
    );
  }
}

function ribbonGeometry(route, width, vertical = 0, segments = route.sampleCount) {
  const positions = new Float32Array(segments * 4 * 3);
  const normals = new Float32Array(segments * 4 * 3);
  const uvs = new Float32Array(segments * 4 * 2);
  const indices = new Uint32Array(segments * 6);
  const a = {}, b = {};
  for (let i = 0; i < segments; i++) {
    route.sampleAtDistance(i / segments * route.length, a);
    route.sampleAtDistance((i + 1) / segments * route.length, b);
    const samples = [a, a, b, b];
    const sides = [-1, 1, -1, 1];
    for (let k = 0; k < 4; k++) {
      const s = samples[k], side = sides[k];
      const vi = (i * 4 + k) * 3;
      positions[vi] = s.x + s.rightX * width * 0.5 * side + s.upX * vertical;
      positions[vi + 1] = s.y + s.upY * vertical;
      positions[vi + 2] = s.z + s.rightZ * width * 0.5 * side + s.upZ * vertical;
      normals[vi] = s.upX; normals[vi + 1] = s.upY; normals[vi + 2] = s.upZ;
      const ui = (i * 4 + k) * 2;
      uvs[ui] = side > 0 ? 1 : 0;
      uvs[ui + 1] = (i + (k >= 2 ? 1 : 0)) * 0.4;
    }
    const ii = i * 6, v = i * 4;
    indices.set([v, v + 2, v + 1, v + 2, v + 3, v + 1], ii);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function orientObjectAtRoute(object, route, distance, wheelbase = 4.2) {
  route.sampleAtDistance(distance + wheelbase * 0.5, _sampleA);
  route.sampleAtDistance(distance - wheelbase * 0.5, _sampleB);
  _position.set(
    (_sampleA.x + _sampleB.x) * 0.5,
    (_sampleA.y + _sampleB.y) * 0.5 + 0.22,
    (_sampleA.z + _sampleB.z) * 0.5,
  );
  _forward.set(
    _sampleA.x - _sampleB.x,
    _sampleA.y - _sampleB.y,
    _sampleA.z - _sampleB.z,
  ).normalize();
  _right.set(_forward.z, 0, -_forward.x).normalize();
  _up.crossVectors(_forward, _right).normalize();
  _matrix.makeBasis(_right, _up, _forward);
  object.position.copy(_position);
  object.quaternion.setFromRotationMatrix(_matrix);
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

function addWheel(parent, x, z, material) {
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.2, 12), material);
  wheel.rotation.z = Math.PI * 0.5;
  wheel.position.set(x, 0.48, z);
  parent.add(wheel);
}

function makeLocomotive(materials) {
  const root = new THREE.Group();
  addBox(root, [2.5, 0.42, 5.7], [0, 0.66, 0], materials.chassis);
  const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.76, 3.35, 12), materials.body);
  boiler.rotation.x = Math.PI * 0.5;
  boiler.position.set(0, 1.55, -0.55);
  root.add(boiler);
  addBox(root, [2.2, 2.2, 1.85], [0, 1.65, 1.75], materials.body);
  addBox(root, [2.55, 0.18, 2.15], [0, 2.82, 1.75], materials.roof);
  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.36, 1.15, 10), materials.chassis);
  chimney.position.set(0, 2.42, -1.45);
  root.add(chimney);
  for (const z of [-1.75, 0, 1.75]) for (const x of [-1.26, 1.26]) addWheel(root, x, z, materials.wheel);
  return root;
}

function makeCarriage(materials) {
  const root = new THREE.Group();
  addBox(root, [2.55, 0.38, 7.0], [0, 0.68, 0], materials.chassis);
  addBox(root, [2.48, 2.25, 6.75], [0, 1.72, 0], materials.carriage);
  addBox(root, [2.72, 0.2, 7.05], [0, 2.9, 0], materials.roof);
  for (const z of [-2.35, 2.35]) for (const x of [-1.27, 1.27]) addWheel(root, x, z, materials.wheel);
  for (const x of [-1.251, 1.251]) {
    for (const z of [-2.25, -0.75, 0.75, 2.25]) {
      addBox(root, [0.025, 0.82, 1.02], [x, 1.9, z], materials.window);
    }
  }
  return root;
}

function makeTestHalt(route, distance) {
  const root = new THREE.Group();
  root.name = 'Rail laboratory halt';
  const platformMat = new THREE.MeshStandardMaterial({ color: 0x8a806c, roughness: 1 });
  const timberMat = new THREE.MeshStandardMaterial({ color: 0x493b2d, roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3f5046, roughness: 0.9 });
  addBox(root, [3.1, 0.34, 25], [3.25, 0.04, 0], platformMat);
  for (const z of [-4.5, 4.5]) addBox(root, [0.16, 2.25, 0.16], [4.05, 1.25, z], timberMat);
  addBox(root, [2.6, 0.14, 10.6], [4.05, 2.4, 0], roofMat);
  addBox(root, [0.16, 1.8, 0.16], [4.75, 1.08, -7.8], timberMat);
  addBox(root, [0.16, 1.8, 0.16], [4.75, 1.08, -10.3], timberMat);
  addBox(root, [0.12, 0.75, 2.7], [4.75, 1.72, -9.05], roofMat);
  orientObjectAtRoute(root, route, distance, 8);
  // Vehicles sit above their wheels; the platform uses the route formation.
  root.position.y -= 0.22;
  return root;
}

function buildTrack(route) {
  const group = new THREE.Group();
  group.name = 'Rail laboratory track';
  const ballastMat = new THREE.MeshStandardMaterial({ color: 0x746f62, roughness: 1 });
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x555348, roughness: 1 });
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x4e3829, roughness: 0.95 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x596064, roughness: 0.56, metalness: 0.45 });

  group.add(shadowless(new THREE.Mesh(ribbonGeometry(route, 3.6, -0.08), shoulderMat)));
  group.add(shadowless(new THREE.Mesh(ribbonGeometry(route, 2.75, 0.01), ballastMat)));

  const tubularSegments = Math.max(320, Math.ceil(route.length / 1.6));
  for (const lateral of [-TRACK_HALF_GAUGE, TRACK_HALF_GAUGE]) {
    const curve = new OffsetRouteCurve(route, lateral, RAIL_HEIGHT);
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(curve, tubularSegments, 0.055, 4, true),
      railMat,
    );
    rail.receiveShadow = true;
    group.add(rail);
  }

  const sleeperSpacing = 1.12;
  const sleeperCount = Math.floor(route.length / sleeperSpacing);
  const sleepers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.45, 0.12, 0.2),
    sleeperMat,
    sleeperCount,
  );
  const sample = {};
  for (let i = 0; i < sleeperCount; i++) {
    route.sampleAtDistance(i * route.length / sleeperCount, sample);
    _position.set(
      sample.x + sample.upX * 0.09,
      sample.y + sample.upY * 0.09,
      sample.z + sample.upZ * 0.09,
    );
    _right.set(sample.rightX, sample.rightY, sample.rightZ);
    _up.set(sample.upX, sample.upY, sample.upZ);
    _forward.set(sample.tangentX, sample.tangentY, sample.tangentZ);
    _matrix.makeBasis(_right, _up, _forward);
    _quaternion.setFromRotationMatrix(_matrix);
    _matrix.compose(_position, _quaternion, _scale);
    sleepers.setMatrixAt(i, _matrix);
  }
  sleepers.instanceMatrix.needsUpdate = true;
  sleepers.receiveShadow = true;
  sleepers.computeBoundingSphere();
  group.add(sleepers);
  return group;
}

export class RailLaboratory {
  constructor(scene, world, controls, { near, onBeforeTravel = null } = {}) {
    this.scene = scene;
    this.world = world;
    this.controls = controls;
    this.onBeforeTravel = onBeforeTravel;
    this.site = findRailLabSite(world, near || controls.rig.position);
    this.route = createClosedRailRoute(
      manualLoopPoints(this.site),
      (x, z) => world.height(x, z),
    );
    this.group = new THREE.Group();
    this.group.name = 'Phase 1 rail laboratory';
    this.scene.add(this.group);
    this.track = buildTrack(this.route);
    this.group.add(this.track);

    const materials = {
      chassis: new THREE.MeshStandardMaterial({ color: 0x252b2a, roughness: 0.78 }),
      wheel: new THREE.MeshStandardMaterial({ color: 0x171b1c, roughness: 0.66, metalness: 0.25 }),
      body: new THREE.MeshStandardMaterial({ color: 0x355343, roughness: 0.82 }),
      carriage: new THREE.MeshStandardMaterial({ color: 0x7a3d2e, roughness: 0.84 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x33383a, roughness: 0.88 }),
      window: new THREE.MeshStandardMaterial({ color: 0x8fb0b4, roughness: 0.28, metalness: 0.05 }),
    };
    this.locomotive = makeLocomotive(materials);
    this.carriage = makeCarriage(materials);
    this.group.add(this.locomotive, this.carriage);

    this.carriageOffset = 8.4;
    this.stationDistance = this.route.length * 0.08;
    this.distance = this.stationDistance;
    this.halt = makeTestHalt(this.route, this.stationDistance - 3.5);
    this.group.add(this.halt);
    this.riding = false;
    this.savedControlsEnabled = false;
    this.viewIndex = 0;
    this.seatAnchor = new THREE.Object3D();
    this.seatAnchor.position.set(0.72, 1.72, 0.15);
    this.carriage.add(this.seatAnchor);

    this.debug = {
      enabled: true,
      running: true,
      speed: 10,
      view: VIEW_NAMES[0],
      status: 'initializing…',
      jumpToLab: () => this.jumpToLab(),
      ride: () => this.board(),
      leave: () => this.leave(),
      nextView: () => this.nextView(),
      reset: () => { this.distance = this.stationDistance; },
    };
    this.update(0);
  }

  setView(name) {
    const index = VIEW_NAMES.indexOf(name);
    this.viewIndex = index >= 0 ? index : 0;
    this.debug.view = VIEW_NAMES[this.viewIndex];
    const yaw = [-Math.PI * 0.5, Math.PI * 0.5, Math.PI][this.viewIndex];
    this.seatAnchor.rotation.set(0, yaw, 0);
    if (this.riding) this.controls.camera.quaternion.identity();
  }

  nextView() {
    this.setView(VIEW_NAMES[(this.viewIndex + 1) % VIEW_NAMES.length]);
  }

  jumpToLab() {
    this.onBeforeTravel?.();
    if (this.riding) this.leave(false);
    const sample = this.route.sampleAtDistance(this.stationDistance, {});
    const x = sample.x + sample.rightX * 5.2;
    const z = sample.z + sample.rightZ * 5.2;
    this.controls.place(x, z);
    this.controls.yaw = Math.atan2(x - sample.x, z - sample.z);
    return { x, z, routeDistance: sample.distance };
  }

  board() {
    if (this.riding) return;
    this.onBeforeTravel?.();
    this.savedControlsEnabled = this.controls.enabled;
    this.controls.enabled = false;
    this.controls.keys.clear();
    this.controls.speed = 0;
    this.controls.verticalVelocity = 0;
    this.controls.grounded = true;
    this.seatAnchor.add(this.controls.camera);
    this.controls.camera.position.set(0, 0, 0);
    this.controls.camera.quaternion.identity();
    this.riding = true;
    this.setView(this.debug.view);
  }

  leave(placeBesideTrack = true) {
    if (!this.riding) return;
    const camera = this.controls.camera;
    this.controls.rig.add(camera);
    camera.position.set(0, this.controls.eyeHeight, 0);
    camera.rotation.set(this.controls.pitch, 0, 0);
    const sample = this.route.sampleAtDistance(this.distance - this.carriageOffset, {});
    if (placeBesideTrack) {
      const x = sample.x + sample.rightX * 4.4;
      const z = sample.z + sample.rightZ * 4.4;
      this.controls.place(x, z);
      this.controls.yaw = Math.atan2(-sample.tangentX, -sample.tangentZ);
    }
    this.controls.enabled = this.savedControlsEnabled;
    this.riding = false;
  }

  update(dt) {
    this.group.visible = this.debug.enabled;
    if (this.debug.running && this.debug.enabled) {
      this.distance = (this.distance + Math.max(0, this.debug.speed) * dt) % this.route.length;
    }
    orientObjectAtRoute(this.locomotive, this.route, this.distance, 4.4);
    orientObjectAtRoute(this.carriage, this.route, this.distance - this.carriageOffset, 5.2);

    if (this.riding) {
      // PlayerControls still owns the ordinary camera bob while disabled. The
      // passenger seat owns its local pose, so cancel that write each frame.
      this.controls.camera.position.set(0, 0, 0);
      this.controls.camera.quaternion.identity();
      this.seatAnchor.getWorldPosition(_position);
      this.controls.rig.position.copy(_position);
      this.controls.rig.position.y -= this.controls.eyeHeight;
      this.controls.speed = this.debug.running ? this.debug.speed : 0;
    }
    this.debug.status = `${Math.round(this.route.length)}m loop · ${(this.route.maxGrade * 100).toFixed(1)}% max grade · ${this.debug.speed.toFixed(1)}m/s${this.riding ? ' · aboard' : ''}`;
  }
}
