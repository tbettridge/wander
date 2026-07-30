// Lighthouse lamp + rotating beam. The tower itself is a static landmark mesh
// (landmarkmesh.js); this system owns everything that moves or glows: the
// shared lamp-room material's emissive pulse, a pair of opposed volumetric
// beam cones sweeping the horizon, and a glow sprite that flashes as a beam
// crosses the camera. Everything is night-gated, and mist feeds the beams —
// in a valley-mist night the sweep is the point of the whole landmark.

import * as THREE from 'three';
import { smoothstep } from './noise.js';
import { lighthouseLampMaterial } from './landmarkmesh.js?v=4';

const BEAM_LEN = 950;
const BEAM_PERIOD = 14;              // seconds per full revolution

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255, 232, 190, 1)');
  g.addColorStop(0.25, 'rgba(255, 210, 140, 0.55)');
  g.addColorStop(1, 'rgba(255, 190, 110, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LighthouseFx {
  constructor(scene) {
    this.scene = scene;
    this._t = Math.random() * BEAM_PERIOD;
    this._anchor = new THREE.Vector3();

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    // beam: cone shell, narrow at the lamp, flaring + fading with distance.
    // Additive and depth-tested, so terrain occludes it but it lights the sky.
    const beamGeo = new THREE.CylinderGeometry(9.5, 0.55, BEAM_LEN, 10, 1, true);
    beamGeo.translate(0, BEAM_LEN / 2, 0);
    beamGeo.rotateX(Math.PI / 2);          // extend along +Z
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(1.0, 0.87, 0.62) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform float uIntensity;
        uniform vec3 uColor;
        void main() {
          // clamp before pow: interpolation can put vUv.y a hair past 1.0 at
          // the cone's far ring, and pow(negative, 2.1) is NaN on the GPU —
          // additive-blended NaN survives into the bloom mip chain and smears
          // a huge black "curtain" across the frame whenever the far end of
          // the cone is on screen (i.e. as a beam sweeps past the camera)
          float t = clamp(1.0 - vUv.y, 0.0, 1.0);
          float a = pow(t, 2.1) * uIntensity;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    // an invisible-by-alpha cone must never darken the GTAO prepass or draw
    // ink silhouettes (same lesson as the river ribbon)
    this.beamMat.userData.excludeFromAO = true;

    this.pivot = new THREE.Group();
    for (const flip of [0, Math.PI]) {
      const beam = new THREE.Mesh(beamGeo, this.beamMat);
      beam.rotation.y = flip;
      beam.rotation.x = 0.02;             // a touch of downward throw
      this.pivot.add(beam);
    }
    this.group.add(this.pivot);

    // lamp glow sprite — flares when a beam sweeps across the viewer
    const spriteMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    });
    spriteMat.userData.excludeFromAO = true;
    this.glow = new THREE.Sprite(spriteMat);
    this.group.add(this.glow);
  }

  // landmarks: the LandmarkManager (streams the tower meshes + lamp anchors)
  update(dt, playerPos, sky, weather, landmarks) {
    this._t = (this._t + dt) % BEAM_PERIOD;

    const day = smoothstep(-0.05, 0.12, sky.sunElevation);
    const night = 1 - day;

    // nearest streamed-in lighthouse (there is at most ~1 in range)
    let best = null, bd = Infinity;
    landmarks.eachLighthouse((obj) => {
      const d = (obj.position.x - playerPos.x) ** 2 + (obj.position.z - playerPos.z) ** 2;
      if (d < bd) { bd = d; best = obj; }
    });

    if (!best || night < 0.03) {
      this.group.visible = false;
      lighthouseLampMaterial.emissiveIntensity = 0.15 + night * 0.55;
      return;
    }

    const anchor = best.getObjectByName('lampAnchor');
    if (!anchor) { this.group.visible = false; return; }
    anchor.getWorldPosition(this._anchor);
    this.group.position.copy(this._anchor);
    this.group.visible = true;

    const angle = (this._t / BEAM_PERIOD) * Math.PI * 2;
    this.pivot.rotation.y = angle;

    // flash: how squarely a beam points at the camera right now
    const dx = playerPos.x - this._anchor.x;
    const dz = playerPos.z - this._anchor.z;
    const camAz = Math.atan2(dx, dz);
    const flash = Math.pow(Math.abs(Math.cos(angle - camAz)), 60);

    const mist = (weather && weather.mist) || 0;
    const rain = (weather && weather.rain) || 0;
    this.beamMat.uniforms.uIntensity.value = night * (0.13 + mist * 0.55 + rain * 0.18);

    const dist = Math.sqrt(bd);
    this.glow.scale.setScalar(20 + flash * 26 + dist * 0.004);
    this.glow.material.opacity = night * (0.10 + 0.8 * flash);

    lighthouseLampMaterial.emissiveIntensity = 0.15 + night * (0.7 + flash * 2.4);
  }
}
