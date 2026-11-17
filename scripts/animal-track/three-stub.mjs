// A tiny stand-in for three.js, for driving wildlife behaviour in Node.
//
// The animal simulation needs the behaviour code in src/animals.js, not its
// meshes: positions, headings, states and targets. That code holds its vectors
// in THREE types, so this supplies just enough of them (real vector maths, inert
// geometry and materials) for the module to load and the agents to steer. It is
// never used by the game.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  applyQuaternion() { return this; }
  applyMatrix4() { return this; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
}
export class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
}
export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { return this.set(q.x, q.y, q.z, q.w); }
  setFromEuler() { return this; }
  setFromAxisAngle() { return this; }
  multiply() { return this; }
  invert() { return this; }
}
export class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  compose() { return this; }
  decompose(p, q, s) { p?.set?.(0, 0, 0); s?.set?.(1, 1, 1); return this; }
  multiplyMatrices() { return this; }
  makeRotationFromEuler() { return this; }
  copy() { return this; }
  invert() { return this; }
}
export class Euler {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
export class Color {
  constructor() { this.r = this.g = this.b = 0; }
  set() { return this; }
  copy() { return this; }
  offsetHSL() { return this; }
}
class Inert { constructor() { this.userData = {}; } dispose() {} }
export class Group extends Inert {
  constructor() { super(); this.children = []; this.visible = true; }
  add() {} remove() {}
}
export class Mesh extends Group {}
export class Bone extends Group {}
export class BufferGeometry extends Inert {}
export class SphereGeometry extends BufferGeometry {}
export class CapsuleGeometry extends BufferGeometry {}
export class CylinderGeometry extends BufferGeometry {}
export class ConeGeometry extends BufferGeometry {}
export class LatheGeometry extends BufferGeometry {}
export class Float32BufferAttribute extends Inert {}
export class DataTexture extends Inert {}
export class MeshStandardMaterial extends Inert {}
export class MeshDepthMaterial extends Inert {}
export const NearestFilter = 1003;
export const RGBAFormat = 1023;
export const FloatType = 1015;
export const RGBADepthPacking = 3201;
export function mergeGeometries() { return new BufferGeometry(); }
