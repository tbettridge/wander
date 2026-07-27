// Three.js substitutes its live stereo ArrayCamera for every renderer.render()
// while WebXR is presenting, including renders aimed at ordinary texture
// targets. Temporarily disable that substitution for auxiliary passes so an
// orthographic cache camera cannot rewrite the headset cameras mid-frame.
export function renderOffscreen(renderer, target, scene, camera) {
  const previousTarget = renderer.getRenderTarget();
  const previousXREnabled = renderer.xr?.enabled;

  if (renderer.xr) renderer.xr.enabled = false;
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    if (renderer.xr) renderer.xr.enabled = previousXREnabled;
  }
}
