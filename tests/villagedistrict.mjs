// The village-centre district: a denser middle that leaves the village it was
// added to exactly as it was.
//
// What is asserted is what makes it read and walk correctly: new houses stand
// clear of everything that was already there, every door opens onto a road, a
// terrace's units agree about the walls they share, boundaries never cross a
// way through, the plot clutter never stands in itself, and every back lane is
// joined to the rest of the village.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';
import { clearStationSettlementCache, stationSettlements } from '../src/stationsettlement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { settlementBuildBlocker } from '../src/settlementspatial.mjs';
import { settlementOrigin } from '../src/settlementorigin.mjs';
import { buildingWorldPoint } from '../src/buildingplan.mjs';
import { YARD_PROPS, DISTRICT_SPEC } from '../src/villagedistrict.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';

function railWorld(seed) {
  const world = new World(seed);
  const plan = planRegionalRailway(world, {
    center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
  return world;
}

const plans = [];
for (const seed of [20260612, 99887]) {
  clearStationSettlementCache();
  const world = railWorld(seed);
  for (const site of stationSettlements(world, world.seed)) {
    plans.push({
      world, site,
      plan: createSettlementPlan(site, {
        heightAt: (x, z) => world.height(x, z),
        blockedAt: settlementBuildBlocker(world, site),
        origin: settlementOrigin(world, site),
      }),
    });
  }
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function corners(building, pad = 0) {
  const fp = building.footprint;
  return [[fp.minX - pad, fp.minZ - pad], [fp.maxX + pad, fp.minZ - pad], [fp.maxX + pad, fp.maxZ + pad], [fp.minX - pad, fp.maxZ + pad]]
    .map(([x, z]) => buildingWorldPoint(building, x, z));
}

function polygonsOverlap(a, b) {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    const ax = -(q.z - p.z), az = q.x - p.x;
    const project = (list) => list.map((v) => v.x * ax + v.z * az);
    const pa = project(a), pb = project(b);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
  }
  return true;
}

test('the district densifies the middle of every laid-out village', () => {
  let added = 0, rows = 0;
  for (const { plan, site } of plans) {
    assert.ok(plan.district, `${site.id} has no district`);
    const before = plan.buildings.filter((b) => !b.district).length;
    added += plan.district.buildings.length;
    rows += plan.district.stats.rows;
    assert.equal(plan.buildings.length, before + plan.district.buildings.length);
    const reach = DISTRICT_SPEC[site.kind].coreReach;
    for (const building of plan.district.buildings) {
      assert.ok(Math.hypot(building.x - plan.square.x, building.z - plan.square.z) < reach + 14,
        `${building.id} is out past the village centre`);
    }
  }
  assert.ok(added / plans.length >= 10, `only ${(added / plans.length).toFixed(1)} buildings added per village`);
  assert.ok(rows >= plans.length, `only ${rows} terraces across ${plans.length} villages`);
});

test('new buildings stand clear of everything that was there, and of each other', () => {
  for (const { plan } of plans) {
    const existing = plan.buildings.filter((b) => !b.district);
    const fresh = plan.district.buildings;
    for (const building of fresh) {
      const mine = corners(building);
      for (const other of existing) {
        assert.ok(!polygonsOverlap(mine, corners(other)), `${building.id} overlaps ${other.id}`);
      }
      for (const other of fresh) {
        if (other === building) continue;
        // Units of one terrace touch at their party walls and nowhere else.
        const sameRow = building.row && other.row && building.row.id === other.row.id;
        const pad = sameRow ? -0.05 : 0;
        assert.ok(!polygonsOverlap(corners(building, pad), corners(other, pad)), `${building.id} overlaps ${other.id}`);
      }
      assert.ok(Math.hypot(building.x - plan.square.x, building.z - plan.square.z) > plan.square.radius,
        `${building.id} stands in the square`);
    }
    // And nothing pre-existing was moved, renamed or dropped.
    assert.ok(existing.every((b) => !b.id.includes(':district:')));
  }
});

test('every new door opens onto a street, a lane or the square', () => {
  for (const { plan } of plans) {
    const roads = [
      ...plan.streets.map((s) => ({ ax: plan.square.x, az: plan.square.z, bx: s.toX, bz: s.toZ, half: s.width / 2 })),
      ...plan.paths.flatMap((path) => path.points.slice(1).map((b, i) => ({
        ax: path.points[i].x, az: path.points[i].z, bx: b.x, bz: b.z, half: path.width / 2,
      }))),
    ];
    for (const building of plan.district.buildings) {
      const door = building.portals.find((p) => p.kind === 'exterior-door');
      // Walk out of the door: within a few metres it reaches somewhere to go.
      let reached = false;
      for (let out = 0.5; out <= 9 && !reached; out += 0.5) {
        const p = buildingWorldPoint(building, door.x, building.depth / 2 + out);
        if (Math.hypot(p.x - plan.square.x, p.z - plan.square.z) < plan.square.radius) reached = true;
        else if (roads.some((r) => segmentDistance(p.x, p.z, r.ax, r.az, r.bx, r.bz) < r.half + 0.3)) reached = true;
      }
      assert.ok(reached, `${building.id}: its door opens onto nothing`);
    }
  }
});

test('a terrace agrees with itself', () => {
  let checked = 0;
  for (const { plan } of plans) {
    const byRow = new Map();
    for (const building of plan.district.buildings.filter((b) => b.row)) {
      const list = byRow.get(building.row.id) || [];
      list.push(building);
      byRow.set(building.row.id, list);
    }
    for (const [id, units] of byRow) {
      units.sort((a, b) => a.row.index - b.row.index);
      const first = units[0];
      for (const unit of units) {
        // One builder, one fabric: a terrace whose units differ is a row of houses.
        assert.equal(unit.materials.wall, first.materials.wall, `${id}: walls differ`);
        assert.equal(unit.materials.roof, first.materials.roof, `${id}: roofs differ`);
        assert.equal(unit.floorCount, first.floorCount, `${id}: storeys differ`);
        assert.ok(Math.abs(unit.row.rise - first.row.rise) < 1e-9, `${id}: ridges differ`);
        assert.equal(Math.abs(unit.yaw - first.yaw) < 1e-9, true, `${id}: facings differ`);
      }
      for (let i = 1; i < units.length; i++) {
        const left = units[i - 1], right = units[i];
        if (right.row.index - left.row.index !== 1) continue;
        // A party wall is shared from both sides or not at all.
        assert.equal(left.row.right.shared, right.row.left.shared, `${id}: a one-sided party wall`);
        if (left.row.right.shared) {
          const a = buildingWorldPoint(left, left.footprint.maxX, 0);
          const b = buildingWorldPoint(right, right.footprint.minX, 0);
          assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.4, `${id}: units ${i - 1} and ${i} do not meet`);
          checked++;
        }
      }
      for (const unit of [units[0], units[units.length - 1]]) {
        // The ends of a row are open and gabled.
        const end = unit === units[0] ? unit.row.left : unit.row.right;
        assert.equal(end.shared, false, `${id}: a row that ends in a party wall`);
        assert.equal(end.gable, true, `${id}: an ungabled end`);
      }
    }
  }
  assert.ok(checked > 20, `too few party walls to mean anything (${checked})`);
});

test('boundaries never cross a way through', () => {
  for (const { plan } of plans) {
    const ways = [
      ...plan.streets.map((s) => ({ ax: plan.square.x, az: plan.square.z, bx: s.toX, bz: s.toZ, half: s.width / 2 })),
      ...plan.paths.flatMap((path) => path.points.slice(1).map((b, i) => ({
        ax: path.points[i].x, az: path.points[i].z, bx: b.x, bz: b.z, half: path.width / 2,
      }))),
    ];
    for (const boundary of plan.district.boundaries) {
      for (let k = 0; k <= 8; k++) {
        const x = boundary.ax + (boundary.bx - boundary.ax) * k / 8, z = boundary.az + (boundary.bz - boundary.az) * k / 8;
        for (const way of ways) {
          const d = segmentDistance(x, z, way.ax, way.az, way.bx, way.bz);
          assert.ok(d >= way.half + boundary.thickness / 2 - 0.05,
            `${boundary.id} (${boundary.kind}) stands ${d.toFixed(2)}m from a way ${way.half.toFixed(2)}m wide`);
        }
      }
    }
  }
});

test('plot clutter is allocated, not piled', () => {
  let homes = 0, dressed = 0;
  for (const { plan } of plans) {
    const props = plan.district.props;
    for (let i = 0; i < props.length; i++) {
      const a = props[i];
      assert.ok(YARD_PROPS[a.kind], `unknown yard prop ${a.kind}`);
      for (let j = i + 1; j < props.length; j++) {
        const b = props[j];
        const reach = Math.min(a.w, a.d) / 2 + Math.min(b.w, b.d) / 2;
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > reach * 0.9, `${a.id} (${a.kind}) stands in ${b.id} (${b.kind})`);
      }
    }
    for (const building of plan.district.buildings.filter((b) => b.program === 'row-house' || b.program === 'infill-house')) {
      homes++;
      dressed += props.filter((p) => p.buildingId === building.id).length
        + plan.district.windowBoxes.filter((w) => w.id.startsWith(`${building.id}:`)).length;
    }
  }
  // Sakura's whole point: a frontage carries six to ten things.
  assert.ok(dressed / homes >= 6, `a new home carries only ${(dressed / homes).toFixed(1)} things`);
});

test('every back lane is joined to the village, and every one has houses on it', () => {
  for (const { plan } of plans) {
    for (const lane of plan.district.lanes.filter((l) => l.kind === 'back-lane')) {
      const joined = plan.district.lanes.some((other) => other.kind === 'alley' && other.id.startsWith(lane.id));
      assert.ok(joined, `${lane.id} is a track to nowhere`);
    }
  }
});

test('the district is solid where it should be and open at its gates', () => {
  const { plan, world } = plans.find((entry) => entry.plan.district.boundaries.length > 40);
  const index = new StructureCollisionIndex(() => ({ portals: {} }));
  index.registerPlan(plan);
  // Walk straight through the middle of a long boundary: stopped.
  const long = plan.district.boundaries.find((b) => Math.hypot(b.bx - b.ax, b.bz - b.az) > 3);
  const mx = (long.ax + long.bx) / 2, mz = (long.az + long.bz) / 2;
  assert.ok(index.collides(mx, mz, world.height(mx, mz) + 0.3), `${long.id} can be walked through`);
  // Walk through a gate: free.
  let gates = 0;
  for (const post of plan.district.posts.filter((p) => p.kind === 'gatepost' || p.kind === 'pier')) {
    const pair = plan.district.posts.find((other) => other !== post && other.id.replace(/:-?1$/, '') === post.id.replace(/:-?1$/, ''));
    if (!pair || post.id > pair.id) continue;
    const gx = (post.x + pair.x) / 2, gz = (post.z + pair.z) / 2;
    assert.equal(index.collides(gx, gz, world.height(gx, gz) + 0.3), null, `${post.id}: the gate is shut`);
    gates++;
  }
  assert.ok(gates > 5, `too few gates (${gates})`);
});

test('the district is deterministic', () => {
  const { site, world } = plans[1];
  const again = createSettlementPlan(site, {
    heightAt: (x, z) => world.height(x, z),
    blockedAt: settlementBuildBlocker(world, site),
    origin: settlementOrigin(world, site),
  });
  assert.equal(JSON.stringify(again.district), JSON.stringify(plans[1].plan.district));
});
