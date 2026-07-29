// Small material-routing registry shared by streamed world systems. Desktop
// materials remain the source of truth; XR registers deliberate lightweight
// counterparts and swaps only those known pairs. This avoids a generic
// Standard→Lambert conversion accidentally stripping a hero material's custom
// uniforms, animation or transparency behavior.

const desktopToXR = new WeakMap();
const xrToDesktop = new WeakMap();
let xrActive = false;

export const xrMaterialVariantDebug = {
  active: false,
  registered: 0,
  routedAssignments: 0,
  lastReplacements: 0,
};

export function registerXRMaterialVariant(desktopMaterial, xrMaterial) {
  if (!desktopMaterial || !xrMaterial || desktopMaterial === xrMaterial) return xrMaterial;
  if (!desktopToXR.has(desktopMaterial)) xrMaterialVariantDebug.registered++;
  desktopToXR.set(desktopMaterial, xrMaterial);
  xrToDesktop.set(xrMaterial, desktopMaterial);
  return xrMaterial;
}

export function setXRMaterialVariants(active) {
  xrActive = !!active;
  xrMaterialVariantDebug.active = xrActive;
  if (xrActive) xrMaterialVariantDebug.routedAssignments = 0;
  return xrActive;
}

export function materialVariantFor(material, active = xrActive) {
  if (!material) return material;
  if (active) {
    const variant = desktopToXR.get(material) || material;
    if (variant !== material) xrMaterialVariantDebug.routedAssignments++;
    return variant;
  }
  return xrToDesktop.get(material) || material;
}

export function applyXRMaterialVariants(root, active = xrActive) {
  if (!root?.traverse) return 0;
  let replacements = 0;
  root.traverse((object) => {
    if (!object?.material) return;
    if (Array.isArray(object.material)) {
      const next = object.material.map((material) => materialVariantFor(material, active));
      if (next.some((material, index) => material !== object.material[index])) {
        object.material = next;
        replacements++;
      }
      return;
    }
    const next = materialVariantFor(object.material, active);
    if (next !== object.material) {
      object.material = next;
      replacements++;
    }
  });
  xrMaterialVariantDebug.lastReplacements = replacements;
  return replacements;
}
