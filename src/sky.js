// Sky, sun, atmosphere and time of day. A physical sky shader drives the sun
// position; fog, light colour/intensity, stars and clouds all follow the
// same solar elevation so the whole scene stays in agreement.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { windUniforms } from './wind.js';
import { StormCloudDeck } from './clouddeck.js';

const DAY_LENGTH = 1400; // seconds for a full 24h cycle
const LUNAR_DAYS = 12;   // days per moon cycle (consumed by the night phase, P3)

// Base clear-sky shader settings; dusk animates AWAY from these per the day roll.
const SKY_BASE = { turbidity: 4.0, rayleigh: 1.55, mie: 0.004, mieG: 0.85 };

// Dawn is deliberately not dusk played backwards: paler pigments, cooler
// anti-sun fill and a gentler horizon reveal make morning feel newly uncovered.
const DAWN_PALETTES = [
  { name: 'apricot', sun: [1.00, 0.72, 0.42], sky: [1.00, 0.82, 0.66], opp: [0.66, 0.72, 0.88] },
  { name: 'rosewater', sun: [1.00, 0.62, 0.58], sky: [0.98, 0.76, 0.78], opp: [0.68, 0.68, 0.88] },
  { name: 'pearl', sun: [1.00, 0.84, 0.62], sky: [0.94, 0.88, 0.80], opp: [0.70, 0.78, 0.90] },
  { name: 'primrose', sun: [1.00, 0.80, 0.42], sky: [0.98, 0.86, 0.64], opp: [0.68, 0.76, 0.90] },
  { name: 'lavender', sun: [1.00, 0.68, 0.62], sky: [0.90, 0.76, 0.84], opp: [0.64, 0.66, 0.88] },
];

// Dusk palettes — pigment tints for the horizon fire (sun side), the mid sky,
// and the anti-sun horizon (the rose/violet "Belt of Venus"). The day roll picks
// one, so consecutive evenings wear different colours.
const DUSK_PALETTES = [
  { name: 'gold',    sun: [1.00, 0.58, 0.24], sky: [0.98, 0.66, 0.50], opp: [0.62, 0.55, 0.74] },
  { name: 'ember',   sun: [1.00, 0.34, 0.16], sky: [0.92, 0.42, 0.34], opp: [0.50, 0.42, 0.70] },
  { name: 'peach',   sun: [1.00, 0.74, 0.44], sky: [1.00, 0.82, 0.64], opp: [0.74, 0.70, 0.84] },
  { name: 'rose',    sun: [1.00, 0.48, 0.52], sky: [0.98, 0.62, 0.72], opp: [0.72, 0.56, 0.86] },
  { name: 'amber',   sun: [1.00, 0.64, 0.28], sky: [0.90, 0.66, 0.52], opp: [0.56, 0.60, 0.82] },
  { name: 'magenta', sun: [0.98, 0.40, 0.46], sky: [0.86, 0.46, 0.62], opp: [0.60, 0.48, 0.80] },
];

// reused per-frame scratch (single-threaded, so shared globals are safe)
const _cA = new THREE.Color(), _cB = new THREE.Color(), _cC = new THREE.Color();
const _cSun = new THREE.Color(), _cOpp = new THREE.Color();

function wrapAround(value, centre, span) {
  const half = span * 0.5;
  return centre + ((((value - centre + half) % span) + span) % span) - half;
}

function turnAngle(current, target, amount) {
  const delta = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return current + delta * amount;
}

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// Big puffy Ghibli cumulus: a cluster of overlapping radial puffs — bright
// white cauliflower tops over blue-grey shaded base lobes with a flat bottom.
function makeCumulusTexture(seed) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const ctx = c.getContext('2d');
  const rng = mulberry32(seed);
  const baseY = 118;
  const puff = (x, y, r, bright) => {
    const g = ctx.createRadialGradient(x, y - r * 0.3, r * 0.12, x, y, r);
    const col = bright ? '255,255,255' : '198,210,230';
    g.addColorStop(0, `rgba(${col},0.95)`);
    g.addColorStop(0.65, `rgba(${col},0.7)`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  const n = 5 + (rng() * 3 | 0);
  for (let i = 0; i < n; i++) {              // shaded base lobes
    const x = 42 + 172 * (i / (n - 1)) + (rng() - 0.5) * 16;
    puff(x, baseY - 16, 26 + rng() * 15, false);
  }
  for (let i = 0; i < n * 2 + 3; i++) {      // bright cauliflower tops
    const t = rng();
    const x = 52 + 152 * t + (rng() - 0.5) * 20;
    const dome = Math.sin(t * Math.PI);      // taller in the middle
    puff(x, baseY - 26 - rng() * 46 * (0.4 + dome), 15 + rng() * 20 * (0.5 + dome), true);
  }
  // flat cloud base
  ctx.clearRect(0, baseY + 10, 256, 160 - baseY - 10);
  return new THREE.CanvasTexture(c);
}

// High streaky cirrus — thin wind-combed filaments. These are the ingredient
// that makes a sunset legendary: they hang high enough to catch the sun's light
// long after it has left the ground, and hold dusk colour into the blue hour.
function makeCirrusTexture(seed) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, 512, 128);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const streaks = 26 + (rng() * 12 | 0);
  for (let i = 0; i < streaks; i++) {
    const y = 16 + rng() * 96;
    const x0 = rng() * 460, len = 70 + rng() * 300;
    const wob = (rng() - 0.5) * 12;
    ctx.strokeStyle = `rgba(255,255,255,${0.05 + rng() * 0.11})`;
    ctx.lineWidth = 1.2 + rng() * 3.5;
    ctx.beginPath();
    for (let s = 0; s <= 9; s++) {
      const t = s / 9, px = x0 + len * t, py = y + Math.sin(t * 3.14159 + i) * wob;
      if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

// Moon disc with painted maria, phase carved by an offset shadow circle
// (approximate terminator — reads right at game scale). Redrawn once per day.
function drawMoonTexture(canvas, phase) {
  const S = 128, R = 54;
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  // soft-edged silver disc
  const g = ctx.createRadialGradient(64, 64, R * 0.55, 64, 64, R);
  g.addColorStop(0, 'rgba(232,238,248,1)');
  g.addColorStop(0.88, 'rgba(214,224,240,0.95)');
  g.addColorStop(1, 'rgba(200,212,232,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(64, 64, R, 0, Math.PI * 2); ctx.fill();
  // maria blotches
  const rng = mulberry32(77);
  ctx.fillStyle = 'rgba(150,164,190,0.28)';
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2, r = rng() * R * 0.55;
    ctx.beginPath();
    ctx.ellipse(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 6 + rng() * 13, 5 + rng() * 10, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // phase: carve a dark circle sliding across (0 = new, 0.5 = full, 1 = new)
  const illum = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const side = phase < 0.5 ? 1 : -1;              // waxing lit on one side, waning the other
  const dx = illum * 2.15 * R;                     // 0 → covers all, >2R → clear
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(64 + side * dx, 64, R * 1.04, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return illum;
}

export class SkySystem {
  constructor(scene, renderer, seed = 12345) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 9.5 / 24; // start mid-morning (fraction of a day)

    // --- day script: one seeded roll per day decides today's sky character ---
    // (clouds, cirrus, dusk palette & drama, moon phase, weather — see rollDay).
    // Deterministic, so a given day looks the same every visit; the variety is
    // what makes time feel like it's passing.
    this.seed = seed >>> 0;
    this.dayIndex = 0;
    this.day = this.rollDay(this.dayIndex);
    this._prevTime = this.time;
    this.duskWarmthScale = 1;   // read by post.update for the golden-hour grade

    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = SKY_BASE.turbidity;   // clear pastel sky; dusk animates these
    u.rayleigh.value = SKY_BASE.rayleigh;
    u.mieCoefficient.value = SKY_BASE.mie;
    u.mieDirectionalG.value = SKY_BASE.mieG;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95;
    sc.near = 50; sc.far = 700;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa8ccf0, 0x6a6350, 0.55);
    scene.add(this.hemi);

    this.moonGlow = new THREE.DirectionalLight(0x8aa2c8, 0); // faint fill at night
    scene.add(this.moonGlow);

    scene.fog = new THREE.Fog(0xc4d3e0, 200, 900);

    // --- night sky: a rotating star dome -----------------------------------
    // Full-sphere field (the dome slowly wheels around a celestial pole, so
    // stars rise and set) with per-star magnitude + colour temperature (blue-
    // white / gold / a few red), shader twinkle, and a Milky Way band: a few
    // thousand faint stars gaussian-clustered along a tilted great circle.
    const rng = mulberry32(99);
    const N_MAIN = 2600, N_MILKY = 3800, N_ALL = N_MAIN + N_MILKY;
    const starPos = new Float32Array(N_ALL * 3);
    const starCol = new Float32Array(N_ALL * 3);
    const starSize = new Float32Array(N_ALL);
    const R = 8500;
    const setStar = (i, x, y, z, r, g, b, s) => {
      starPos[i * 3] = x; starPos[i * 3 + 1] = y; starPos[i * 3 + 2] = z;
      starCol[i * 3] = r; starCol[i * 3 + 1] = g; starCol[i * 3 + 2] = b;
      starSize[i] = s;
    };
    for (let i = 0; i < N_MAIN; i++) {
      const t = rng() * Math.PI * 2, p = Math.acos(rng() * 2 - 1);
      const x = R * Math.sin(p) * Math.cos(t), y = R * Math.cos(p), z = R * Math.sin(p) * Math.sin(t);
      const mag = Math.pow(rng(), 2.6);            // few bright, many faint
      const tone = rng();
      let cr, cg, cb;
      if (tone < 0.62)      { cr = 0.80; cg = 0.87; cb = 1.00; }   // blue-white
      else if (tone < 0.90) { cr = 1.00; cg = 0.94; cb = 0.80; }   // warm gold
      else if (tone < 0.975){ cr = 1.00; cg = 0.99; cb = 0.97; }   // white
      else                  { cr = 1.00; cg = 0.62; cb = 0.48; }   // red giants
      const v = 0.35 + mag * 0.75;
      setStar(i, x, y, z, cr * v, cg * v, cb * v, 1.0 + mag * 2.6);
    }
    // Milky Way: band-local ring + gaussian thickness, tilted into place
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0.3, 0.5));
    const bv = new THREE.Vector3();
    for (let i = 0; i < N_MILKY; i++) {
      const a = rng() * Math.PI * 2;
      const gauss = (rng() + rng() + rng() - 1.5) / 1.5;           // ~gaussian -1..1
      const th = gauss * 0.16 * (0.6 + 0.8 * Math.abs(Math.sin(a * 1.7))); // clumpy band
      bv.set(Math.cos(a), Math.sin(th), Math.sin(a)).normalize().multiplyScalar(R * 0.995);
      bv.applyQuaternion(tilt);
      const v = 0.10 + Math.pow(rng(), 1.8) * 0.34;                // faint dust glow
      const warm = rng() * 0.15;
      setStar(N_MAIN + i, bv.x, bv.y, bv.z, (0.82 + warm) * v, 0.86 * v, 1.0 * v, 0.7 + rng() * 1.3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
    this.starUniforms = { uOpacity: { value: 0 }, uTime: { value: 0 } };
    const starMat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: /* glsl */`
        attribute float aSize;
        uniform float uTime;
        varying vec3 vCol;
        varying float vTw;
        void main() {
          vCol = color;
          // per-star twinkle from a position hash (bright stars twinkle less)
          float h = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453);
          vTw = 0.80 + 0.20 * sin(uTime * (1.5 + h * 2.5) + h * 40.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity;
        varying vec3 vCol;
        varying float vTw;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float fall = smoothstep(0.5, 0.12, length(d));
          gl_FragColor = vec4(vCol * vTw, fall * uOpacity);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.stars.frustumCulled = false;
    this.starDome = new THREE.Group();
    this.starDome.add(this.stars);
    scene.add(this.starDome);
    this._poleAxis = new THREE.Vector3(0.32, 1, 0.1).normalize(); // celestial pole
    this._domeQ = new THREE.Quaternion();

    // --- moon: billboard disc, phase redrawn per day, drives the night light --
    this._moonCanvas = document.createElement('canvas');
    this.moonIllum = drawMoonTexture(this._moonCanvas, this.day.moonPhase);
    this._moonPhaseDrawn = this.day.moonPhase;
    this._moonTex = new THREE.CanvasTexture(this._moonCanvas);
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this._moonTex, transparent: true, fog: false, depthWrite: false, opacity: 0,
      })
    );
    this.moon.scale.setScalar(560);
    this.moon.frustumCulled = false;
    scene.add(this.moon);
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.nightAmt = 0;

    // --- shooting stars: a small pool of additive line streaks ---------------
    this.meteors = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xdfe9ff, transparent: true, opacity: 0, fog: false,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(g, mat);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.meteors.push({ line, head: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dur: 1, active: false });
    }
    this._meteorTimer = 8 + Math.random() * 20;

    // clouds: drifting translucent planes high above the player
    this.clouds = new THREE.Group();
    const cloudTex = makeCloudTexture();
    const crng = mulberry32(4242);
    for (let i = 0; i < 34; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: cloudTex, transparent: true, depthWrite: false, fog: false,
          side: THREE.DoubleSide,   // flat planes seen from BELOW (was up-only!)
          opacity: 0.55 + crng() * 0.3,
        })
      );
      m.rotation.x = -Math.PI / 2;
      const s = 320 + crng() * 700;
      m.scale.set(s, s * (0.5 + crng() * 0.5), 1);
      m.position.set((crng() - 0.5) * 5200, 420 + crng() * 260, (crng() - 0.5) * 5200);
      m.userData.baseOpacity = m.material.opacity;
      m.userData.coverThresh = crng();   // feathered against the evolving flat-cover value
      this.clouds.add(m);
    }
    scene.add(this.clouds);

    // big puffy cumulus: vertical billboards (yaw-faced to the camera each
    // frame) so they read as towering clouds from the ground
    this.cumulus = new THREE.Group();
    const cumTex = [makeCumulusTexture(11), makeCumulusTexture(23), makeCumulusTexture(47)];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: cumTex[i % 3], transparent: true, depthWrite: false, fog: false,
          side: THREE.DoubleSide,
          opacity: 0.85,
        })
      );
      const w = 520 + crng() * 780;
      m.scale.set(w, w * 0.55, 1);
      m.position.set((crng() - 0.5) * 5600, 560 + crng() * 320, (crng() - 0.5) * 5600);
      m.userData.baseOpacity = 0.72 + crng() * 0.2;
      m.userData.coverThresh = crng() * 0.85;   // big cumulus lean toward being present
      this.cumulus.add(m);
    }
    scene.add(this.cumulus);
    // per-frame (x, z, radius, strength) ground-shadow anchors, one per cumulus
    this.cumulusShadows = new Float32Array(4 * this.cumulus.children.length);

    // high cirrus: weather-controlled and high enough to catch dusk fire longest
    this.cirrus = new THREE.Group();
    const cirTex = [makeCirrusTexture(7), makeCirrusTexture(31), makeCirrusTexture(53)];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: cirTex[i % 3], transparent: true, depthWrite: false, fog: false,
          side: THREE.DoubleSide, opacity: 0.5,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = crng() * Math.PI;
      const w = 900 + crng() * 1400;
      m.scale.set(w, w * (0.28 + crng() * 0.22), 1);
      m.position.set((crng() - 0.5) * 7000, 1050 + crng() * 550, (crng() - 0.5) * 7000);
      m.userData.baseOpacity = 0.35 + crng() * 0.3;
      m.userData.coverThresh = crng();
      m.userData.windSkew = (crng() - 0.5) * 0.3;
      this.cirrus.add(m);
    }
    scene.add(this.cirrus);
    this.cloudDeck = new StormCloudDeck(scene);

    this.viewDistance = 800;
    this.horizonDistance = 6500; // fog far — reaches the distant terrain ring
    this._fogColor = new THREE.Color();
    this._sunDir = new THREE.Vector3();
  }

  setViewDistance(d) {
    this.viewDistance = d;
  }

  get sunDir() {
    return this._sunDir;
  }

  // elevation in -1..1 (sin of solar altitude)
  get sunElevation() {
    return Math.sin((this.time - 0.25) * Math.PI * 2);
  }

  // One seeded roll per day fixes today's sky character. Deterministic from the
  // world seed + day index, so everyone sees the same evening on the same day,
  // but each day differs — most modest, the occasional one spectacular.
  rollDay(idx) {
    const s = ((this.seed >>> 0) ^ (Math.imul(idx | 0, 0x9e3779b1) >>> 0)) >>> 0;
    const rng = mulberry32(s);
    const quality = rng();                       // overall drama
    let cloudCover = 0.15 + rng() * 0.55;        // moderate by default
    const r2 = rng();
    if (r2 < 0.14) cloudCover = 0.02 + rng() * 0.12;      // rare crystal-clear day
    else if (r2 > 0.86) cloudCover = 0.80 + rng() * 0.20; // rare overcast day
    // cirrus: usually little, ~40% of days catch some, the spectacle ingredient
    const cirrusAmt = rng() < 0.4 ? 0.35 + rng() * 0.65 : rng() * 0.12;
    const turbidity = rng();                     // 0..1 → dusk haze / redness
    const mieBoost = Math.pow(rng(), 1.6);       // skewed low; big glowing-sun days rare
    const dawnPaletteIdx = (rng() * DAWN_PALETTES.length) | 0;
    const duskPaletteIdx = (rng() * DUSK_PALETTES.length) | 0;
    const dawnQuality = 0.25 + rng() * 0.55;     // softer and less theatrical than dusk
    const duskQuality = 0.3 + quality * 0.7;     // afterglow richness & how long it lingers
    // rolled now, consumed by later phases:
    const moonPhase = (((idx % LUNAR_DAYS) + LUNAR_DAYS) % LUNAR_DAYS) / LUNAR_DAYS; // P3
    const mistAmt = rng() < 0.25 ? 0.3 + rng() * 0.7 : 0;                            // P4
    const events = { meteors: rng() < 0.14, aurora: rng() < 0.05 };                  // P3/P4
    return {
      idx, quality, cloudCover, cirrusAmt, turbidity, mieBoost,
      dawnPaletteIdx, dawnPalette: DAWN_PALETTES[dawnPaletteIdx], dawnQuality,
      duskPaletteIdx, duskPalette: DUSK_PALETTES[duskPaletteIdx],
      // `palette` stays as a compatibility alias for debug/external handles.
      palette: DUSK_PALETTES[duskPaletteIdx], duskQuality, moonPhase, mistAmt, events,
    };
  }

  update(dt, playerPos, weather) {
    // advance time; roll a fresh day at each midnight wrap (time 1 -> 0). Night
    // passes 3.5x faster — enough to enjoy the stars, not enough to get lost.
    const rate = this.sunElevation < -0.06 ? 3.5 : 1;
    this.time = (this.time + (dt * rate) / DAY_LENGTH) % 1;
    if (this.time < this._prevTime - 0.5) { this.dayIndex++; this.day = this.rollDay(this.dayIndex); }
    this._prevTime = this.time;

    const elev = this.sunElevation;
    const azim = this.time * Math.PI * 2 + Math.PI / 2;
    const alt = Math.asin(clamp(elev, -1, 1));
    this._sunDir.set(Math.cos(alt) * Math.cos(azim), Math.sin(alt), Math.cos(alt) * Math.sin(azim));
    this.sky.material.uniforms.sunPosition.value.copy(this._sunDir);
    this.sky.position.copy(playerPos);

    const day = smoothstep(-0.04, 0.12, elev);
    const D = this.day;
    const rising = this.time < 0.5;
    const twilightQuality = rising ? D.dawnQuality : D.duskQuality;
    const palette = rising ? D.dawnPalette : D.duskPalette;

    // --- twilight timeline: dawn and dusk share solar geometry but not palette
    // or quality. Dusk lingers longer; dawn arrives with a softer, cooler roll.
    const sUp = smoothstep(0.30, 0.02, elev);                  // fades in as the sun drops
    const belowHorizonReach = rising
      ? 0.16 + 0.08 * twilightQuality
      : 0.13 + 0.17 * twilightQuality;
    const sDn = smoothstep(-belowHorizonReach, -0.02, elev);
    const twilight = sUp * sDn;
    const horizonGlow = Math.exp(-(elev * elev) / (0.05 * 0.05)); // the sun-on-the-horizon moment
    const warmSide = smoothstep(-0.10, 0.06, elev);            // warm (sun up) -> cool (sun down)
    const brokenCloudDrama = smoothstep(0.25, 0.65, weather?.cumulusCover ?? 0)
      * (1 - smoothstep(0.75, 0.95, weather?.flatCover ?? 0));
    const denseSuppression = smoothstep(0.72, 0.95, weather?.flatCover ?? 0);
    const twilightWeatherScale = (1 + brokenCloudDrama * 0.35)
      * (1 - denseSuppression * 0.65) * (1 - (weather?.storm ?? 0) * 0.35);
    const twilightColorAmount = twilight * twilightWeatherScale;

    // sun light follows the player so the shadow frustum stays tight. Fade it
    // over a WIDER low band than `day` so the sun keeps warmly side-lighting the
    // land as it reaches and dips below the horizon — golden hour, long shadows —
    // instead of the ground going black the instant the sky turns colour.
    const weatherSun = weather?.sunScale ?? 1;
    const mist = weather?.mist ?? 0;
    this.sun.intensity = smoothstep(-0.12, 0.10, elev) * 3.1 * weatherSun * lerp(1, 0.72, mist);
    // warm GOLD at the horizon (not a dark blood-orange): capped saturation and
    // a lifted floor on lightness so low sun lights the land luminously.
    this.sun.color.setHSL(0.09, clamp(0.72 - elev * 0.8, 0, 0.68), lerp(0.74, 0.99, smoothstep(0, 0.35, elev)));
    this.sun.position.copy(playerPos).addScaledVector(this._sunDir, 380);
    this.sun.target.position.copy(playerPos);

    // sky-fill: at dusk the grazing sun barely touches flat ground, so it's the
    // sky dome that lights the land — pump the fill up and keep it clearly BLUE
    // so shaded slopes glow deep dusk-blue (Ghibli) instead of going muddy. The
    // warmth stays with the sun and the sky; the ground reads cool against it.
    // --- night state: the moon rides opposite the sun, so it climbs as night
    // falls; its rolled phase decides how bright the night is.
    const night = this.nightAmt = 1 - day;
    const illum = this.moonIllum;
    // The weather timeline owns celestial visibility. A full moon still lends
    // a little blue presence behind thin cloud, while dense rain/storm cover
    // genuinely erases it along with the stars.
    const moonVisibility = weather?.moonVisibility ?? 1;
    const starVisibility = weather?.starVisibility ?? 1;
    this.moonDir.copy(this._sunDir).negate();
    if (this._moonPhaseDrawn !== this.day.moonPhase) {   // day rolled → redraw phase
      this.moonIllum = drawMoonTexture(this._moonCanvas, this.day.moonPhase);
      this._moonPhaseDrawn = this.day.moonPhase;
      this._moonTex.needsUpdate = true;
    }
    this.moon.position.copy(playerPos).addScaledVector(this.moonDir, 8200);
    this.moon.lookAt(playerPos);
    this.moon.material.opacity = smoothstep(0.06, -0.10, elev)
      * smoothstep(-0.06, 0.10, this.moonDir.y) * moonVisibility;

    const hemiBase = 0.06 + day * 0.78 + twilight * 0.42 + night * illum * 0.07;
    this.hemi.intensity = hemiBase * lerp(1, weather?.hemiScale ?? 1, day) * lerp(1, 1.12, mist);
    // a SOFT cool grey-blue fill (not saturated blue) — luminous shaded slopes
    // that read as muted dusk, which the grade then keeps pastel.
    this.hemi.color.setRGB(0.56 + twilight * 0.02, 0.62 + twilight * 0.02, 0.74);
    // moonlight: a directional silver fill from the moon's true direction —
    // full-moon nights read silvery and legible, new-moon nights stay deep.
    this.moonGlow.intensity = night * (0.025 + 0.16 * illum) * moonVisibility;
    this.moonGlow.position.copy(playerPos).addScaledVector(this.moonDir, 380);
    this.moonGlow.target.position.copy(playerPos);
    if (!this.moonGlow.target.parent) this.scene.add(this.moonGlow.target);

    // --- physical sky: animate turbidity/mie/rayleigh at dusk per the day roll,
    // so consecutive evenings differ — a big glowing sun on high-mie days, deep
    // red embers on hazy days, a quiet pastel fade on clear ones.
    // Gentle: enough turbidity/mie for an orange horizon + bright sun disc, but
    // rayleigh stays low so the ZENITH keeps its blue and the sky reads as a
    // gradient, not a flat red wash. (Over-cranking these drowned the dome.)
    const su = this.sky.material.uniforms;
    const weatherTurbidity = lerp(SKY_BASE.turbidity, weather?.turbidity ?? SKY_BASE.turbidity, day);
    const weatherRayleigh = lerp(SKY_BASE.rayleigh, weather?.rayleigh ?? SKY_BASE.rayleigh, day);
    const weatherMie = lerp(SKY_BASE.mie, weather?.mie ?? SKY_BASE.mie, day);
    su.turbidity.value = weatherTurbidity + twilight * (3.0 + D.turbidity * 3.0) + mist * 2.0;
    su.rayleigh.value = weatherRayleigh + twilight * 0.65;
    su.mieCoefficient.value = weatherMie + twilight * (0.001 + D.mieBoost * 0.012) + mist * 0.009;
    su.mieDirectionalG.value = SKY_BASE.mieG + twilight * 0.05;

    // --- fog: blue-grey by day, today's dusk palette at the rims (warm sun-side
    // easing to cool anti-sun), deep at night.
    _cSun.setRGB(palette.sun[0], palette.sun[1], palette.sun[2]);
    _cOpp.setRGB(palette.opp[0], palette.opp[1], palette.opp[2]);
    // a WARM DISTANT HAZE, not a colour bath: the mid palette tone lightly nudged
    // toward sun/anti-sun, applied at a modest blend so far hills glow at sunset
    // while the mid-ground keeps its form.
    _cA.setRGB(palette.sky[0], palette.sky[1], palette.sky[2])
      .lerp(_cSun, warmSide * 0.30).lerp(_cOpp, (1 - warmSide) * 0.30);
    // night floor rises with moonlight: full-moon nights are indigo, not black
    _cB.setRGB(
      lerp(0.012 + 0.020 * illum * night, 0.72, day),
      lerp(0.016 + 0.028 * illum * night, 0.80, day),
      lerp(0.030 + 0.058 * illum * night, 0.88, day)
    );
    this._fogColor.copy(_cB).lerp(_cA, twilightColorAmount * (0.22 + 0.15 * twilightQuality));
    this.scene.fog.color.copy(this._fogColor);
    const clearFogNear = this.viewDistance * 0.7;
    const weatherFogNear = this.viewDistance * (weather?.fogNearScale ?? 0.7);
    let fogNear = lerp(clearFogNear, weatherFogNear, day);
    let fogFar = lerp(this.horizonDistance, weather?.fogFar ?? this.horizonDistance, day);
    const mistFogNear = 25 + this.viewDistance * 0.04;
    const mistFogFar = Math.max(650, this.viewDistance * 1.25);
    fogNear = lerp(fogNear, mistFogNear, mist);
    fogFar = lerp(fogFar, mistFogFar, mist);
    this.scene.fog.near = fogNear;
    this.scene.fog.far = fogFar;
    if (mist > 0.001) {
      _cC.setRGB(0.62, 0.70, 0.80).lerp(_cSun, horizonGlow * 0.42);
      this.scene.fog.color.lerp(_cC, mist * 0.72);
    }
    this.cloudDeck.update(playerPos, weather, day, this.scene.fog.color, twilightColorAmount, _cA);

    // golden-hour grade push, read by post.update (dramatic days grade warmer)
    const morningRestraint = rising ? 0.62 : 1;
    this.duskWarmthScale = 1 + twilightQuality * 0.7 * twilightColorAmount * morningRestraint
      + horizonGlow * (rising ? 0.16 : 0.30);

    // star dome: fade in with dark, wheel slowly around the celestial pole so
    // constellations rise and set across the night
    this.starUniforms.uOpacity.value = smoothstep(0.02, -0.18, elev) * 0.95 * starVisibility;
    this.starUniforms.uTime.value += dt;
    this.starDome.position.copy(playerPos);
    this.starDome.quaternion.setFromAxisAngle(this._poleAxis, -this.time * Math.PI * 2 * 0.5);

    // shooting stars: brief additive streaks; meteor-shower nights fire often
    if (night > 0.5 && starVisibility > 0.08) {
      this._meteorTimer -= dt * (this.day.events.meteors ? 10 : 1) * starVisibility;
      if (this._meteorTimer <= 0) {
        this._meteorTimer = 16 + Math.random() * 38;
        const m = this.meteors.find((mm) => !mm.active);
        if (m) {
          const az = Math.random() * Math.PI * 2, altA = 0.35 + Math.random() * 0.75;
          m.head.set(
            playerPos.x + Math.cos(az) * Math.cos(altA) * 5200,
            playerPos.y + Math.sin(altA) * 5200,
            playerPos.z + Math.sin(az) * Math.cos(altA) * 5200
          );
          const dAz = az + (Math.random() - 0.5) * 1.6;
          m.vel.set(Math.cos(dAz) * 2600, -(900 + Math.random() * 1600), Math.sin(dAz) * 2600);
          m.dur = 0.55 + Math.random() * 0.5;
          m.life = 0; m.active = true; m.line.visible = true;
        }
      }
    }
    for (const m of this.meteors) {
      if (!m.active) continue;
      m.life += dt;
      const t01 = m.life / m.dur;
      if (t01 >= 1) { m.active = false; m.line.visible = false; m.line.material.opacity = 0; continue; }
      m.head.addScaledVector(m.vel, dt);
      const p = m.line.geometry.attributes.position;
      p.setXYZ(0, m.head.x, m.head.y, m.head.z);
      p.setXYZ(1, m.head.x - m.vel.x * 0.16, m.head.y - m.vel.y * 0.16, m.head.z - m.vel.z * 0.16);
      p.needsUpdate = true;
      m.line.material.opacity = Math.sin(t01 * Math.PI) * 0.9 * night * starVisibility;
    }

    // --- clouds: every layer rides the shared prevailing wind. Coverage is a
    // feathered opacity threshold, so evolving weather never pops meshes on/off.
    // Tinting still follows bearing to the sun (fire toward sunset, rose away).
    const sunAz = Math.atan2(this._sunDir.z, this._sunDir.x);
    const cloudLight = 0.12 + day * 0.85 + twilight * 0.13;
    const windDir = windUniforms.uWindDir.value;
    const windSpeed = windUniforms.uWindSpeed.value;
    const flatCover = weather?.flatCover ?? D.cloudCover;
    const cumulusCover = weather?.cumulusCover ?? D.cloudCover;
    const cirrusCover = weather?.cirrusCover ?? D.cirrusAmt;
    const weatherShade = weather?.cloudShade ?? 0;
    // High ice clouds catch the sun first at dawn and last at dusk; low cloud
    // bases remain in shadow until the sun is almost at the horizon.
    const flatTwilight = smoothstep(-0.04, 0.02, elev)
      * (1 - smoothstep(0.28, 0.42, elev)) * twilightWeatherScale;
    const cumulusTwilight = smoothstep(-0.09, -0.005, elev)
      * (1 - smoothstep(0.30, 0.46, elev)) * twilightWeatherScale;
    const cirrusTwilight = smoothstep(-(0.22 + 0.10 * twilightQuality), -0.02, elev)
      * (1 - smoothstep(0.32, 0.50, elev)) * twilightWeatherScale;
    const paint = (c, layerCover, speedScale, billboard, layerTwilight) => {
      c.position.x += dt * windDir.x * windSpeed * speedScale;
      c.position.z += dt * windDir.y * windSpeed * speedScale;
      c.position.x = wrapAround(c.position.x, playerPos.x, 5600);
      c.position.z = wrapAround(c.position.z, playerPos.z, 5600);
      const presence = smoothstep(
        c.userData.coverThresh - 0.10,
        c.userData.coverThresh + 0.10,
        layerCover,
      );
      c.material.opacity = Math.min(1,
        c.userData.baseOpacity * cloudLight * (0.6 + 0.7 * layerCover) * presence);
      const dx = c.position.x - playerPos.x, dz = c.position.z - playerPos.z;
      if (billboard) {
        // A vertical card cannot represent a cloud directly overhead. Fade it
        // before the viewing angle exposes its flatness; the dome deck fills
        // that part of the sky under dense dramatic/overcast conditions.
        const horizontal = Math.hypot(dx, dz);
        const altitude = Math.max(80, c.position.y - playerPos.y);
        const zenithFade = smoothstep(0.32, 0.85, horizontal / altitude);
        const stormFade = 1 - smoothstep(0.08, 0.65, weather?.storm ?? 0);
        c.material.opacity *= zenithFade * stormFade;
      }
      c.visible = c.material.opacity > 0.006;
      if (!c.visible) return;
      if (billboard) c.rotation.y = Math.atan2(playerPos.x - c.position.x, playerPos.z - c.position.z);
      const caz = Math.atan2(c.position.z - playerPos.z, c.position.x - playerPos.x);
      const ad = Math.abs(((caz - sunAz + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const towardSun = 1 - ad / Math.PI;                 // 1 sun-side .. 0 anti-sun
      const cb = lerp(0.22, lerp(1, 0.48, weatherShade), day);
      _cA.copy(_cOpp).lerp(_cSun, towardSun);             // dusk tint by bearing
      _cB.setRGB(cb, cb, cb).lerp(_cA, layerTwilight);
      _cC.copy(_cSun).multiplyScalar(horizonGlow * towardSun * 0.7); // sun-side rim
      c.material.color.copy(_cB).add(_cC);
    };
    for (const c of this.clouds.children) paint(c, flatCover, 0.70, false, flatTwilight);
    for (const c of this.cumulus.children) paint(c, cumulusCover, 0.55, true, cumulusTwilight);

    // Anchor ground shadows to the ACTUAL cumulus billboards: project each
    // visible cloud along the sun ray onto the ground plane and publish
    // (x, z, radius, strength) for the atmosphere injection to darken. Clouds
    // then feel physically overhead — their shade arrives before they do.
    {
      const arr = this.cumulusShadows;
      const sd = this._sunDir;
      const inv = 1 / Math.max(sd.y, 0.25);      // clamp so dawn shadows don't fly to infinity
      let w = 0;
      for (const c of this.cumulus.children) {
        if (w >= arr.length) break;
        const strength = c.visible ? Math.min(1, c.material.opacity * 1.35) * day : 0;
        if (strength < 0.02) continue;
        const drop = Math.max(80, c.position.y - playerPos.y);
        arr[w++] = c.position.x - sd.x * inv * drop;
        arr[w++] = c.position.z - sd.z * inv * drop;
        arr[w++] = c.scale.x * 0.30;             // soft disc ~1/3 of the card width
        arr[w++] = strength;
      }
      for (; w < arr.length; w++) arr[w] = 0;    // unused slots: zero strength
    }

    // --- cirrus: the high layer travels faster and slowly combs into the wind.
    // Its per-card coverage threshold is feathered like the lower cloud pools.
    const windAngle = Math.atan2(windDir.y, windDir.x);
    for (const c of this.cirrus.children) {
      c.position.x += dt * windDir.x * windSpeed * 1.25;
      c.position.z += dt * windDir.y * windSpeed * 1.25;
      c.position.x = wrapAround(c.position.x, playerPos.x, 7000);
      c.position.z = wrapAround(c.position.z, playerPos.z, 7000);
      c.rotation.z = turnAngle(c.rotation.z, windAngle + c.userData.windSkew, 1 - Math.exp(-dt * 0.12));
      const presence = smoothstep(
        c.userData.coverThresh - 0.12,
        c.userData.coverThresh + 0.12,
        cirrusCover,
      );
      c.material.opacity = Math.min(0.95,
        c.userData.baseOpacity * presence * (0.35 + 0.65 * cirrusCover)
        * (0.3 + 0.6 * day + 0.85 * cirrusTwilight));
      c.visible = c.material.opacity > 0.006;
      if (!c.visible) continue;
      const caz = Math.atan2(c.position.z - playerPos.z, c.position.x - playerPos.x);
      const ad = Math.abs(((caz - sunAz + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const towardSun = 1 - ad / Math.PI;
      const cb = lerp(0.55, lerp(1, 0.62, weatherShade), day);
      _cA.copy(_cOpp).lerp(_cSun, 0.35 + 0.65 * towardSun);
      _cB.setRGB(cb, cb, cb).lerp(_cA, cirrusTwilight);
      c.material.color.copy(_cB);
    }

    // keep golden hour luminous — don't let exposure sag to the night floor
    // while the sky is still lit; the extra lift fades as true night arrives.
    this.renderer.toneMappingExposure = lerp(0.50, 0.62, day) + twilight * 0.12 + horizonGlow * 0.06 + mist * 0.025;
  }

  clockString() {
    const hours = this.time * 24;
    const hh = Math.floor(hours);
    const mm = Math.floor((hours - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}
