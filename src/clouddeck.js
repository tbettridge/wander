// Overhead-safe overcast/storm ceiling. Unlike the vertical cumulus cards, this
// is a shallow upper hemisphere viewed from inside, so its perspective remains
// convincing at the zenith. A generated tileable noise texture supplies two
// wind-carried layers in one inexpensive full-sky pass.

import * as THREE from 'three';
import { mulberry32, smoothstep } from './noise.js';
import { windUniforms } from './wind.js';

function makeNoiseTexture(seed = 8841) {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const rng = mulberry32(seed);
  const octaves = [
    { cells: 4, weight: 0.48 },
    { cells: 8, weight: 0.27 },
    { cells: 16, weight: 0.16 },
    { cells: 32, weight: 0.09 },
  ].map(({ cells, weight }) => ({
    cells, weight,
    grid: Float32Array.from({ length: cells * cells }, () => rng()),
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (const octave of octaves) {
        const { cells, grid, weight } = octave;
        const gx = x * cells / size, gy = y * cells / size;
        const ix = Math.floor(gx), iy = Math.floor(gy);
        let fx = gx - ix, fy = gy - iy;
        fx = fx * fx * (3 - 2 * fx);
        fy = fy * fy * (3 - 2 * fy);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const y0 = iy % cells, y1 = (iy + 1) % cells;
        const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
        const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
        value += ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * weight;
      }
      const v = Math.round(smoothstep(0.18, 0.82, value) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX = /* glsl */`
varying vec3 vDeckWorld;
varying float vDeckHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDeckWorld = world.xyz;
  vDeckHeight = position.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */`
uniform sampler2D uDeckNoise;
uniform vec2 uWindOffset;
uniform float uCoverage, uShade, uStorm, uDay, uTwilight;
uniform vec3 uFogColor, uTwilightColor;
varying vec3 vDeckWorld;
varying float vDeckHeight;

void main() {
  // Broad ceiling and a quicker ragged under-layer. Both use the integrated
  // world wind, so changing direction bends their path without phase jumps.
  vec2 broadUv = (vDeckWorld.xz - uWindOffset * 0.70) * 0.00018;
  vec2 raggedUv = (vDeckWorld.xz - uWindOffset * 0.48) * 0.00055 + vec2(0.37, 0.19);
  float broad = texture2D(uDeckNoise, broadUv).r;
  float ragged = texture2D(uDeckNoise, raggedUv).r;
  float field = broad * 0.72 + ragged * 0.28;

  float threshold = mix(0.72, 0.39, uCoverage);
  float body = smoothstep(threshold - 0.10, threshold + 0.10, field);
  float deckAmount = smoothstep(0.58, 0.90, uCoverage);
  float sheet = smoothstep(0.72, 0.98, uCoverage) * mix(0.34, 0.72, uStorm);
  float alpha = max(body * (0.34 + uCoverage * 0.61), sheet) * deckAmount;

  // The shallow dome dissolves before its equator, avoiding a visible ring at
  // the horizon while retaining a solid, perspective-correct overhead ceiling.
  float horizon = smoothstep(0.025, 0.15, vDeckHeight);
  alpha *= horizon;

  float darkness = clamp(uShade + uStorm * 0.16, 0.0, 1.0);
  vec3 dayCloud = mix(vec3(0.86, 0.90, 0.95), vec3(0.22, 0.25, 0.31), darkness);
  vec3 nightCloud = mix(vec3(0.075, 0.09, 0.13), vec3(0.025, 0.032, 0.05), darkness);
  vec3 color = mix(nightCloud, dayCloud, uDay);
  color *= 0.72 + broad * 0.20 + ragged * 0.08;
  // Keep warm pigment low on the dome: overcast/storm twilight is a restrained
  // horizon event, while broken clouds can still catch a little colour.
  float twilightBand = (1.0 - smoothstep(0.18, 0.74, vDeckHeight)) * uTwilight;
  twilightBand *= (1.0 - uShade * 0.65) * (1.0 - uStorm * 0.35);
  color = mix(color, mix(color, uTwilightColor, 0.55), twilightBand);
  color = mix(uFogColor, color, smoothstep(0.06, 0.30, vDeckHeight));

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.97));
}`;

export class StormCloudDeck {
  constructor(scene) {
    this.uniforms = {
      uDeckNoise: { value: makeNoiseTexture() },
      uWindOffset: windUniforms.uWindOffset,
      uCoverage: { value: 0 },
      uShade: { value: 0 },
      uStorm: { value: 0 },
      uDay: { value: 1 },
      uFogColor: { value: new THREE.Color(0xc4d3e0) },
      uTwilight: { value: 0 },
      uTwilightColor: { value: new THREE.Color(1, 0.72, 0.48) },
    };
    const geometry = new THREE.SphereGeometry(1, 64, 18, 0, Math.PI * 2, 0, Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.scale.set(5200, 900, 5200);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2; // behind the remaining horizon cloud cards
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(playerPos, weather, day, fogColor, twilight = 0, twilightColor = null) {
    const coverage = weather?.flatCover || 0;
    const amount = smoothstep(0.56, 0.88, coverage);
    this.mesh.visible = amount > 0.002;
    if (!this.mesh.visible) return;
    this.mesh.position.set(playerPos.x, playerPos.y - 40, playerPos.z);
    this.uniforms.uCoverage.value = coverage;
    this.uniforms.uShade.value = weather?.cloudShade || 0;
    this.uniforms.uStorm.value = weather?.storm || 0;
    this.uniforms.uDay.value = day;
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uTwilight.value = twilight;
    if (twilightColor) this.uniforms.uTwilightColor.value.copy(twilightColor);
  }
}
