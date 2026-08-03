export function createLocationRef(kind, key, extras = {}) {
  if (!kind || !key) throw new TypeError('Location refs require kind and key.');
  return Object.freeze({ kind: String(kind), key: String(key), ...extras });
}

export function buildSettlementLocationGraph(plan) {
  const nodes = new Map();
  const edges = new Map();
  const addNode = (ref, data = {}) => { nodes.set(ref.key, { ...ref, ...data }); edges.set(ref.key, edges.get(ref.key) || []); };
  const connect = (a, b, kind, cost = 1) => {
    if (!nodes.has(a) || !nodes.has(b)) throw new Error(`Cannot connect missing location ${a} -> ${b}`);
    edges.get(a).push({ to: b, kind, cost }); edges.get(b).push({ to: a, kind, cost });
  };
  addNode(createLocationRef('settlement-entrance', plan.site.regionalEntrance.key), plan.site.regionalEntrance);
  for (const building of plan.buildings) {
    const outside = `${building.id}:outside`;
    addNode(createLocationRef('building-exterior', outside), { x: building.x, y: building.y, z: building.z, buildingId: building.id });
    connect(plan.site.regionalEntrance.key, outside, 'street', Math.hypot(building.x - plan.site.regionalEntrance.x, building.z - plan.site.regionalEntrance.z));
    for (const room of building.rooms) addNode(createLocationRef('room', room.id), { buildingId: building.id, purpose: room.purpose });
    for (const portal of building.portals) {
      const fromKey = portal.kind === 'exterior-door' ? outside : portal.from.key;
      connect(fromKey, portal.to.key, 'portal', 1);
    }
    for (const anchor of building.actionAnchors) {
      addNode(createLocationRef('action-anchor', anchor.id), { ...anchor, buildingId: building.id });
      connect(anchor.roomId, anchor.id, 'room', 0.5);
    }
  }
  return { id: `${plan.id}:locations`, nodes, edges };
}

export function routeLocations(graph, fromKey, toKey) {
  if (fromKey === toKey) return { from: fromKey, to: toKey, steps: [], cost: 0 };
  if (!graph.nodes.has(fromKey) || !graph.nodes.has(toKey)) return null;
  const frontier = [{ key: fromKey, cost: 0 }], best = new Map([[fromKey, 0]]), previous = new Map();
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
    const current = frontier.shift();
    if (current.cost !== best.get(current.key)) continue;
    if (current.key === toKey) break;
    for (const edge of graph.edges.get(current.key) || []) {
      const cost = current.cost + edge.cost;
      if (cost >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, cost); previous.set(edge.to, { from: current.key, edge }); frontier.push({ key: edge.to, cost });
    }
  }
  if (!previous.has(toKey)) return null;
  const steps = [];
  for (let key = toKey; key !== fromKey;) {
    const item = previous.get(key); steps.push({ from: item.from, to: key, kind: item.edge.kind, cost: item.edge.cost }); key = item.from;
  }
  steps.reverse();
  return { from: fromKey, to: toKey, steps, cost: best.get(toKey) };
}

export function compressRoutePlan(route) {
  if (!route) return null;
  const portals = route.steps.filter((step) => step.kind === 'portal');
  return { from: route.from, to: route.to, nextPortal: portals[0]?.to || null, portalCount: portals.length, cost: route.cost };
}
