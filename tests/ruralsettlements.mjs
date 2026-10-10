import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { cachedSettlementPlan, buildingLocalPoint } from '../src/settlementspatial.mjs';
import { planInterior } from '../src/interiorplan.mjs';
import { planVenues } from '../src/npcvenues.mjs';
import { assignWorkplacesAndRoutines } from '../src/npcroutine.mjs';
import { planSettlementBusinessSigns } from '../src/settlementsignage.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { reservationShapesOverlap } from '../src/managedvegetation.mjs';

const samples = [];
for (const seed of [20260612, 99887]) {
  const world = new World(seed), sites = new Map();
  outer: for (let r = 0; r <= 15; r++) for (let ci = -r; ci <= r; ci++) for (let cj = -r; cj <= r; cj++) {
    if (Math.max(Math.abs(ci), Math.abs(cj)) !== r) continue;
    const site = settlementForCell(world, ci, cj);
    if (site && !sites.has(site.kind)) sites.set(site.kind, site);
    if (sites.size === 4) break outer;
  }
  assert.equal(sites.size, 4);
  for (const site of sites.values()) samples.push({ world, plan: cachedSettlementPlan(world, site) });
}

test('rural places have well greens, loose lanes and farm buildings without urban infill or markets', () => {
  for (const { plan } of samples) {
    assert.ok(plan.square);
    assert.equal(plan.props.filter(p => p.kind === 'well').length, 1);
    const well = plan.props.find(p => p.kind === 'well');
    assert.equal(well.x, plan.square.x); assert.equal(well.z, plan.square.z);
    assert.ok(plan.buildings.some(b => b.program === 'barn'));
    assert.ok(plan.buildings.some(b => b.program === 'dwelling'));
    assert.ok(plan.streets.length >= 2 && plan.streets.length <= 4);
    assert.ok(plan.buildings.every(b => !b.district && !b.row));
    assert.equal(plan.district.buildings.length, 0);
    assert.equal(plan.district.lanes.length, 0);
    assert.ok(plan.props.every(p => p.kind !== 'market-stall'));
    assert.ok(plan.district.lines.every(p => p.kind === 'washing'));
    assert.equal(planVenues(plan).market, null);
    if (plan.site.kind === 'farmstead') {
      assert.ok(plan.buildings.length <= 4);
      assert.ok(plan.buildings.every(b => ['dwelling', 'barn', 'granary'].includes(b.program)));
    } else assert.equal(plan.buildings.filter(b => b.program === 'general-store').length, 1);
  }
});

test('rural furnishings and family store ownership support real shopkeeper workplaces', () => {
  for (const { plan } of samples) {
    for (const building of plan.buildings) {
      assert.ok(building.terrainFit.valid, building.id);
      assert.equal(planInterior(building).diagnostics.requiredOmissions, 0, building.id);
    }
    const store = plan.buildings.find(b => b.program === 'general-store');
    if (!store) continue;
    assert.ok(store.ownerHouseholdId && store.ownerSurname);
    assert.ok(plan.familyFrontages.some(f => f.buildingId === store.id && f.application.serviceCueId === 'service.store-delivery'));
    const interior = planInterior(store), shop = interior.rooms.find(r => r.purpose === 'store');
    assert.ok(shop);
    assert.ok(interior.placements.some(p => p.roomId === shop.id && p.assetId === 'counter'));
    assert.ok(interior.placements.some(p => p.roomId === shop.id && p.assetId === 'shelf'));
    assert.ok(interior.placements.every(p => p.assetId !== 'workbench'));
    assert.ok(planSettlementBusinessSigns(plan).some(s => s.buildingId === store.id && s.programLabel === 'General Store'));
    const id = `${store.id}:keeper`, state = { entities: { [id]: { id, householdId: store.ownerHouseholdId, homeKey: 'home' } } };
    assignWorkplacesAndRoutines(plan, state);
    assert.equal(state.workplaces[store.id].kind, 'general-store');
    assert.equal(state.entities[id].role, 'shopkeeper');
    assert.equal(state.entities[id].workplaceId, store.id);
    assert.ok(state.workplaces[store.id].inventory.provisions > 0);
  }
});

test('rural lanterns are sparse, solid, and clear of the walking network', () => {
  for (const { world, plan } of samples) {
    const lamps = plan.district.posts.filter(p => p.kind === 'lantern-post');
    assert.ok(lamps.some(p => p.id.includes(':well-lamp:')), `${plan.site.id} has no well lamp`);
    assert.ok(lamps.length <= ({ farmstead: 2, hamlet: 3, village: 5, town: 6 })[plan.site.kind]);
    const index = new StructureCollisionIndex(() => ({ portals: {} })); index.registerPlan(plan);
    for (const lamp of lamps) {
      assert.equal(world.riverAt(lamp.x, lamp.z).wet, false);
      assert.ok(index.collides(lamp.x, lamp.z, lamp.y, 0.34), lamp.id);
      for (const path of plan.paths) for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1], b = path.points[i], dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((lamp.x - a.x) * dx + (lamp.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        assert.ok(Math.hypot(lamp.x - a.x - dx * t, lamp.z - a.z - dz * t) > (path.width || 1.65) / 2 + 0.34, lamp.id);
      }
    }
  }
});

test('rural greens and lanes stay clear of whole building footprints and every doorstep is connected', () => {
  for (const { plan } of samples) {
    const adjacency = new Map(plan.localGraph.nodes.map(n => [n.key, []]));
    for (const edge of plan.localGraph.edges) {
      adjacency.get(edge.from).push(edge.to); adjacency.get(edge.to).push(edge.from);
    }
    const reached = new Set([plan.site.regionalEntrance.key]), queue = [...reached];
    while (queue.length) for (const next of adjacency.get(queue.shift())) if (!reached.has(next)) { reached.add(next); queue.push(next); }
    for (const node of plan.localGraph.nodes.filter(n => n.kind === 'door-approach')) assert.ok(reached.has(node.key));
    for (const street of plan.streets) {
      const n = Math.ceil(Math.hypot(street.toX - street.fromX, street.toZ - street.fromZ));
      for (let i = 0; i <= n; i++) for (const b of plan.buildings) {
        const p = buildingLocalPoint(b, street.fromX + (street.toX - street.fromX) * i / n, street.fromZ + (street.toZ - street.fromZ) * i / n);
        const fp = b.footprint;
        assert.ok(p.x < fp.minX - street.width / 2 || p.x > fp.maxX + street.width / 2
          || p.z < fp.minZ - street.width / 2 || p.z > fp.maxZ + street.width / 2, `${b.id} blocks ${street.id}`);
      }
    }
  }
});

test('cultivated plots keep their ground clear of new rural yard clutter and fences', () => {
  let planted = 0;
  for (const { plan } of samples) for (const planting of plan.managedVegetation.placements) {
    planted++;
    for (const prop of plan.district.props) {
      const shape = { kind: 'oriented-rectangle', center: { x: prop.x, z: prop.z },
        halfExtents: { x: prop.w / 2, z: prop.d / 2 }, yaw: prop.yaw };
      assert.equal(reservationShapesOverlap(planting.footprint, shape), false, prop.id);
    }
    for (const boundary of plan.district.boundaries) {
      const shape = { kind: 'segment', from: { x: boundary.ax, z: boundary.az },
        to: { x: boundary.bx, z: boundary.bz }, width: boundary.thickness };
      assert.equal(reservationShapesOverlap(planting.footprint, shape), false, boundary.id);
    }
  }
  assert.ok(planted > 0);
});
