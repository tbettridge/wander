// Fireflies: a handful of drifting warm glow-points that come out at night in
// meadows and forest clearings near the player. Rendered as additive shader
// points with HDR colour, so the bloom pass gives each one a soft halo — pure
// night magic for ~zero cost (one draw call, N tiny points, CPU wander is a
// few dozen sines per frame). Follows the butterflies respawn pattern.

import * as THREE from 'three';

const N = 44;
const RANGE = 40;            // stay within this radius of the player

export class Fireflies {
  constructor(scene, world) {
    this.world = world;

    const pos = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3 + 1] = -100; phase[i] = Math.random() * 100; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uGlow: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aPhase;
        uniform float uTime;
        varying float vBlink;
        void main() {
          // slow lantern blink, each firefly on its own rhythm (never fully off)
          vBlink = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (0.7 + fract(aPhase) * 0.8) + aPhase), 2.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (6.5 + 2.0 * vBlink) * (60.0 / max(-mv.z, 4.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity, uGlow;
        varying float vBlink;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float fall = smoothstep(0.5, 0.08, d);
          // HDR warm chartreuse — bright enough to cross the bloom threshold
          vec3 col = vec3(1.35, 1.9, 0.55) * vBlink * uGlow;
          gl_FragColor = vec4(col, fall * vBlink * uOpacity);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.userData.excludeFromAO = true;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);

    this.f = Array.from({ length: N }, () => ({
      ax: 0, az: 0, ay: 0,          // anchor (ground point + hover base)
      alive: false,
      checkT: Math.random() * 3,
      p1: Math.random() * 10, p2: Math.random() * 10, p3: Math.random() * 10,
      r: 0.8 + Math.random() * 1.6, // wander radius
    }));
    this.t = 0;
    this.activity = 0;
  }

  // firefly habitat: low, gentle, grassy/forested ground (meadow edges, glades)
  habitatAt(x, z) {
    const b = this.world.biomeAt(x, z);
    if (b.h < 1.5 || b.h > 55 || b.slope > 0.3) return null;
    if (!(b.id === 'grassland' || b.id === 'forest' || b.id === 'jungle' || b.id === 'taiga')) return null;
    return b;
  }

  update(dt, playerPos, sky, weather = null) {
    this.t += dt;
    // Clear, calm nights are alive; gusts, rain and storms put the lanterns
    // away. Keep the old solar fallback so the system remains reusable alone.
    const nightTarget = weather?.fireflyActivity ?? (sky.sunElevation < -0.05 ? 1 : 0);
    const response = 1 - Math.exp(-dt * (nightTarget > this.activity ? 1.8 : 4.5));
    this.activity += (nightTarget - this.activity) * response;
    const u = this.uniforms;
    const moonlight = (weather?.moonVisibility ?? 1) * (sky.moonIllum ?? 0);
    // They remain physically active under a bright moon, but their small glow
    // reads a little softer; clouded nights let the lights carry further.
    u.uOpacity.value = this.activity * (0.76 + (1 - moonlight) * 0.24);
    u.uGlow.value = 0.78 + (1 - moonlight) * 0.22;
    u.uTime.value = this.t;
    this.points.visible = u.uOpacity.value > 0.02;
    if (!this.points.visible) return;

    const posAttr = this.points.geometry.attributes.position;
    for (let i = 0; i < N; i++) {
      const f = this.f[i];
      f.checkT -= dt;
      const dx = f.ax - playerPos.x, dz = f.az - playerPos.z;
      if (f.checkT <= 0 || dx * dx + dz * dz > RANGE * RANGE) {
        f.checkT = 2 + Math.random() * 2;
        if (!f.alive || dx * dx + dz * dz > RANGE * RANGE) {
          const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * (RANGE - 8);
          const nx = playerPos.x + Math.cos(a) * r, nz = playerPos.z + Math.sin(a) * r;
          const bio = this.habitatAt(nx, nz);
          if (bio) { f.ax = nx; f.az = nz; f.ay = bio.h; f.alive = true; }
          else if (!this.habitatAt(f.ax, f.az)) f.alive = false;
        }
      }
      if (!f.alive) { posAttr.setXYZ(i, 0, -100, 0); continue; }
      // lazy figure-eight drift around the anchor, hovering 0.4–1.6 m up
      const t = this.t;
      posAttr.setXYZ(i,
        f.ax + Math.sin(t * 0.31 + f.p1) * f.r + Math.sin(t * 0.83 + f.p2) * 0.5,
        f.ay + 0.9 + Math.sin(t * 0.47 + f.p3) * 0.55,
        f.az + Math.cos(t * 0.27 + f.p2) * f.r + Math.cos(t * 0.71 + f.p1) * 0.5
      );
    }
    posAttr.needsUpdate = true;
  }
}
