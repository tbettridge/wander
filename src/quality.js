// Adaptive quality. Five tiers trade off pixel ratio, view distance, shadow
// resolution and vegetation density. The manager watches a smoothed FPS and
// steps tiers up/down with hysteresis, so capable hardware gets the full
// world and weak hardware stays smooth.
//
// treeRadius = full-geometry trees; impostorRadius = billboard trees (cheap),
// extending the forest past the streamed terrain toward the fog line.
// renderScale controls only the post composer's 3D/HDR working resolution; the
// canvas still uses pixelRatio, and the final grade pass sharpens the upscale.

export const TIERS = [
  { name: 'potato', pixelRatio: 0.7,  renderScale: 1.00, viewRadius: 3, treeRadius: 1, impostorRadius: 4,  grassRadius: 1, clutterRadius: 0, grassPerChunk: 0,    treeDensityScale: 0.5, clutterDensityScale: 0,   nearRes: 48,  shadowSize: 0 },
  { name: 'low',    pixelRatio: 0.85, renderScale: 1.00, viewRadius: 4, treeRadius: 2, impostorRadius: 6,  grassRadius: 1, clutterRadius: 1, grassPerChunk: 700,  treeDensityScale: 0.7, clutterDensityScale: 0.3,  nearRes: 56,  shadowSize: 0 },
  { name: 'medium', pixelRatio: 1.0,  renderScale: 1.00, viewRadius: 5, treeRadius: 3, impostorRadius: 8,  grassRadius: 2, clutterRadius: 1, grassPerChunk: 1500, treeDensityScale: 1.0, clutterDensityScale: 0.55, nearRes: 72,  shadowSize: 1024 },
  { name: 'high',   pixelRatio: 1.25, renderScale: 0.90, viewRadius: 6, treeRadius: 4, impostorRadius: 10, grassRadius: 2, clutterRadius: 2, grassPerChunk: 2200, treeDensityScale: 1.0, clutterDensityScale: 0.8,  nearRes: 96,  shadowSize: 2048 },
  // A 2048 map across the 224m stabilized shadow box is still ~11cm/texel.
  // 4096 quadrupled shadow raster cost for detail below the painterly geometry.
  //
  // treeRadius 4, not 5. Full-geometry trees are by far the largest thing in
  // the frame — measured at ring 5 (700-840m) they were 918 draw calls and
  // 1.86M triangles on their own, for trees the impostor path renders
  // convincingly at a fraction of the cost. Pulling the crossover in one ring
  // measured -18% draw calls, -7.5% triangles and -7.7% median frame time at
  // the same viewpoint. A second ring (treeRadius 3) bought only a further
  // 0.1ms for another 140m of lost real geometry, so the win is almost entirely
  // in this first step.
  { name: 'ultra',  pixelRatio: 2.0,  renderScale: 0.72, viewRadius: 7, treeRadius: 4, impostorRadius: 12, grassRadius: 3, clutterRadius: 3, grassPerChunk: 3000, treeDensityScale: 1.0, clutterDensityScale: 0.9,  nearRes: 112, shadowSize: 2048 },
];

export class QualityManager {
  constructor(renderer, applyFn, startLevel = 3) {
    this.renderer = renderer;
    this.applyFn = applyFn;
    this.level = startLevel;
    this.fps = 60;
    this.window = 0;
    this.frames = 0;
    this.goodWindows = 0;
    this.badWindows = 0;
    this.locked = false;
    // WebXR owns a separate presentation profile. While a headset session is
    // active, suspend desktop tier adaptation instead of interpreting the XR
    // compositor's refresh cadence as a reason to rewrite desktop settings.
    this.suspended = false;
    this.apply();
  }

  static guessInitialLevel() {
    const dm = navigator.deviceMemory || 8;
    const cores = navigator.hardwareConcurrency || 8;
    const mobile = /Android|iPhone|iPad|Quest|OculusBrowser/i.test(navigator.userAgent);
    if (mobile) return 1;
    if (dm <= 4 || cores <= 4) return 2;
    return 3;
  }

  get tier() { return TIERS[this.level]; }

  apply() {
    const t = this.tier;
    if (!this.renderer.xr.isPresenting) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, t.pixelRatio));
    }
    this.applyFn(t);
  }

  setLevel(level) {
    const next = Math.max(0, Math.min(TIERS.length - 1, level));
    if (next === this.level) return;
    this.level = next;
    this.apply();
  }

  setSuspended(suspended) {
    this.suspended = !!suspended;
    this.window = 0;
    this.frames = 0;
    this.goodWindows = 0;
    this.badWindows = 0;
  }

  tick(dt) {
    if (this.suspended) return;
    this.fps = this.fps * 0.96 + (1 / Math.max(dt, 1e-4)) * 0.04;
    this.window += dt;
    this.frames++;
    if (this.window < 4) return;
    const avg = this.frames / this.window;
    this.window = 0;
    this.frames = 0;
    if (this.locked) return;

    const xr = this.renderer.xr.isPresenting;
    const downAt = xr ? 60 : 45;
    const upAt = xr ? 68 : 56;

    if (avg < downAt) {
      this.goodWindows = 0;
      // require TWO consecutive slow windows: a single streaming hitch used to
      // drop the tier instantly, changing tree density/radii mid-walk (visible
      // as trees popping out of existence), then stepping back up seconds later
      this.badWindows++;
      if (this.badWindows >= 2) {
        this.badWindows = 0;
        this.setLevel(this.level - 1);
      }
    } else if (avg > upAt) {
      this.badWindows = 0;
      // require sustained headroom before stepping up
      this.goodWindows++;
      if (this.goodWindows >= 3) {
        this.goodWindows = 0;
        this.setLevel(this.level + 1);
      }
    } else {
      this.goodWindows = 0;
      this.badWindows = 0;
    }
  }
}
