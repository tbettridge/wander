// In-page probe: where every visible NPC's feet are, against what is drawn
// under them.
//
// Evaluated in the game page (playbot --attach / --hold). For each resident,
// station actor and regional walker it casts a ray straight down through the
// drawn scene (terrain chunks and settlement geometry, never NPC bodies) and
// compares the hit with the NPC's root and with its lowest sole. A positive
// gap is a floating NPC, a negative one is an NPC sunk into what they stand on.
//
// Returns plain data so the node side can tabulate it.
async (opts = {}) => {
  const THREE = await import('three');
  const W = window.__wander;
  const scene = W.scene;
  const player = W.controls.rig.position;
  const range = opts.range ?? 60;
  const roots = [];
  const seen = new Set();
  const add = (root, kind, id, extra = {}) => {
    if (!root || seen.has(root) || !root.visible) return;
    seen.add(root);
    roots.push({ root, kind, id, ...extra });
  };
  for (const current of W.settlements.active.values()) {
    for (const resident of current.residents || []) {
      add(resident.root, 'resident', resident.actorId, {
        site: current.site?.id,
        phase: resident.task?.phase || null,
        inside: resident.insideBuildingId || null,
        dormant: !!resident.dormant,
      });
    }
  }
  for (const actor of W.livingWorld.actors || []) {
    add(actor.avatar?.root, actor.sharedMobilityPresentation ? 'mobility-actor' : (actor.roaming ? 'traveller' : 'station'), actor.identity?.id, {
      platform: actor.platformY !== null && actor.platformY !== undefined,
    });
  }
  for (const presentation of W.npcMobility?.presentations?.values?.() || []) {
    add(presentation.actor?.avatar?.root || presentation.root, 'walker', presentation.actor?.actorId || presentation.actorId, {
      mode: presentation.actor?.mobilityPose?.mode || null,
      rail: !!presentation.actor?.mobilityPose?.supportMatrix,
    });
  }
  const npcRoots = new Set(roots.map((entry) => entry.root));
  const underNpc = (object) => {
    for (let o = object; o; o = o.parent) if (npcRoots.has(o) || o.userData?.actorId) return true;
    return false;
  };
  // The drawn ground: terrain chunks and everything a settlement builds, minus
  // people, glass, glow and anything see-through or instanced (grass, trees).
  const targets = [];
  scene.traverseVisible((object) => {
    if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh) return;
    if (underNpc(object)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!material || material.visible === false) return;
    const name = `${object.name || ''} ${object.parent?.name || ''}`;
    if (/water|river|lake|sea|glow|sky|cloud|fog|rain|lantern|beam|shadow/i.test(name)) return;
    if (material.transparent && material.opacity < 0.2) return;
    targets.push(object);
  });
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const out = [];
  scene.updateMatrixWorld(true);
  for (const entry of roots) {
    const p = entry.root.position;
    const distance = Math.hypot(p.x - player.x, p.z - player.z);
    if (distance > range) continue;
    origin.set(p.x, p.y + 2.2, p.z);
    ray.set(origin, down); ray.far = 8;
    const hits = ray.intersectObjects(targets, false);
    const hit = hits[0] || null;
    // The soles: the lowest of the two foot bones, less the ankle.
    const bones = entry.root.userData?.rig?.bones || null;
    let sole = null;
    entry.root.traverse((object) => {
      if (!object.isBone || !/foot/i.test(object.name)) return;
      object.getWorldPosition(foot);
      sole = sole === null ? foot.y : Math.min(sole, foot.y);
    });
    const walkable = W.walkableSurface.groundAt(p.x, p.z, p.y + 0.8);
    const terrain = W.world.height(p.x, p.z);
    const drawnTerrain = W.chunkMgr.renderedHeightAt ? W.chunkMgr.renderedHeightAt(p.x, p.z) : null;
    const claim = W.walkableSurface.structureAt(p.x, p.z, p.y + 0.8);
    out.push({
      kind: entry.kind, id: entry.id, site: entry.site || null, phase: entry.phase || null,
      inside: entry.inside || null, mode: entry.mode || null, rail: entry.rail || false, platform: entry.platform || false,
      x: +p.x.toFixed(2), z: +p.z.toFixed(2), distance: +distance.toFixed(1),
      rootY: +p.y.toFixed(3),
      soleY: sole === null ? null : +sole.toFixed(3),
      hitY: hit ? +hit.point.y.toFixed(3) : null,
      hitName: hit ? (hit.object.name || hit.object.parent?.name || hit.object.type) : null,
      walkableY: +walkable.toFixed(3), terrainY: +terrain.toFixed(3),
      drawnTerrainY: drawnTerrain === null ? null : +drawnTerrain.toFixed(3),
      claim: claim ? claim.id : null,
      gap: hit ? +(p.y - hit.point.y).toFixed(3) : null,
    });
  }
  return { player: { x: player.x, z: player.z }, targets: targets.length, npcs: out };
}
