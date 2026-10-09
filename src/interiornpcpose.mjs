// Furniture changes the visual skeleton, never the canonical actor's floor.
// The actor retains a reachable approach spot while their body occupies a seat
// or mattress. The ordinary locomotion pose resets all offsets on departure.
export function normalizeInteriorFurniturePose(value) {
  if(!value || !['sit','sleep'].includes(value.kind))return null;
  const bounded=(v,min,max,fallback)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):fallback;
  return {kind:value.kind,height:bounded(value.height,.3,.8,.55),offsetX:bounded(value.offsetX,-4,4,0),offsetZ:bounded(value.offsetZ,-4,4,0)};
}
export function applyInteriorFurniturePose(bones, pose, scaleY = 1) {
  if (!pose || !['sit', 'sleep'].includes(pose.kind)) return;
  const scale = Math.max(0.1, scaleY);
  bones.hips.position.x = (pose.offsetX || 0) / scale;
  bones.hips.position.z = (pose.offsetZ || 0) / scale;
  bones.hips.position.y = Math.max(0.3, Math.min(0.8, pose.height || 0.55)) / scale;
  bones.hips.rotation.set(pose.kind === 'sleep' ? -Math.PI / 2 : 0, 0, 0);
  bones.spine.rotation.set(0, 0, 0); bones.chest.rotation.set(0, 0, 0);
  for (const side of ['left', 'right']) {
    bones[`${side}Thigh`].rotation.set(pose.kind === 'sit' ? -Math.PI / 2 : 0, 0, 0);
    bones[`${side}Shin`].rotation.set(pose.kind === 'sit' ? Math.PI / 2 : 0, 0, 0);
    bones[`${side}Foot`].rotation.set(0, 0, 0);
    bones[`${side}UpperArm`].rotation.x = pose.kind === 'sit' ? -0.3 : 0.1;
    bones[`${side}Forearm`].rotation.x = pose.kind === 'sit' ? -0.9 : -0.15;
  }
}
