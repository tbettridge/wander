// Waterfalls & cascades. The worker (chunkgen.buildFalls) detects steep drops
// in the river surface and emits near-vertical "curtain" quads plus mist seed
// points. Here we shade the curtains (fast downward streaks + foam at lip and
// plunge) and scatter soft billboard mist sprites at their bases. One shared
// material/texture across all chunks; per-frame uniforms track day/night + fog.

import * as THREE from 'three';

const MAX_MIST_PER_CHUNK = 10;

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWP;
void main() {
  vUv = uv;
  vWP = position;                 // curtain verts are authored in world space
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
uniform float uTime, uDay, uFogNear, uFogFar;
uniform vec3 uFogColor;
varying vec2 vUv;
varying vec3 vWP;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.7) * 0.25 + vnoise(p * 6.1) * 0.15; }

void main() {
  float day = 0.06 + 0.94 * uDay;
  // streaks stretched vertically (narrow in u, long in v), racing downward
  float streak = fbm2(vec2(vUv.x * 13.0, vUv.y * 4.0 - uTime * 3.4));
  float streak2 = fbm2(vec2(vUv.x * 26.0 + 5.0, vUv.y * 7.0 - uTime * 5.2));
  float white = 0.5 + 0.35 * streak + 0.25 * streak2;
  float foamTop = smoothstep(0.16, 0.0, vUv.y);    // brighter at the lip
  float foamBot = smoothstep(0.78, 1.0, vUv.y);    // brightest at the plunge
  white = clamp(white + foamTop * 0.5 + foamBot * 0.6, 0.0, 1.4);

  vec3 col = vec3(0.92, 0.96, 0.99) * day * white;
  float alpha = clamp(0.42 + 0.4 * streak + foamTop * 0.4 + foamBot * 0.5, 0.0, 1.0);

  float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWP));
  gl_FragColor = vec4(mix(col, uFogColor, fogF), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const uniforms = {
  uTime: { value: 0 },
  uDay: { value: 1 },
  uFogColor: { value: new THREE.Color() },
  uFogNear: { value: 200 },
  uFogFar: { value: 900 },
};

export const waterfallMaterial = new THREE.ShaderMaterial({
  vertexShader: VERT,
  fragmentShader: FRAG,
  uniforms,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// soft radial puff for mist
function makeMistTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const mistMaterial = new THREE.SpriteMaterial({
  map: typeof document !== 'undefined' ? makeMistTexture() : null,
  transparent: true, depthWrite: false, opacity: 0.5, fog: true,
});

// Build a chunk's waterfalls from the worker's fall data: a curtain mesh + a
// few mist sprites at the plunge bases.
export function buildWaterfallGroup(fall) {
  const group = new THREE.Group();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(fall.positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(fall.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(fall.indices, 1));
  geo.computeBoundingSphere();
  const curtain = new THREE.Mesh(geo, waterfallMaterial);
  curtain.renderOrder = 2;
  curtain.frustumCulled = true;
  group.add(curtain);

  // mist sprites — cap the count, prefer the biggest falls
  const n = fall.mist.length / 4;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fall.mist[b * 4 + 3] - fall.mist[a * 4 + 3]);
  const count = Math.min(n, MAX_MIST_PER_CHUNK);
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const size = fall.mist[i * 4 + 3];
    const s = new THREE.Sprite(mistMaterial);
    s.position.set(fall.mist[i * 4], fall.mist[i * 4 + 1] + size * 0.25, fall.mist[i * 4 + 2]);
    const sc = 2.5 + size * 0.8;
    s.scale.set(sc, sc, sc);
    group.add(s);
  }
  return group;
}

export function updateWaterfall(dt, sky, fog) {
  uniforms.uTime.value += dt;
  uniforms.uDay.value = THREE.MathUtils.smoothstep(sky.sunElevation, -0.04, 0.12);
  uniforms.uFogColor.value.copy(fog.color);
  uniforms.uFogNear.value = fog.near;
  uniforms.uFogFar.value = fog.far;
  mistMaterial.opacity = 0.18 + 0.42 * uniforms.uDay.value;
  mistMaterial.color.setScalar(0.4 + 0.6 * uniforms.uDay.value);
}
