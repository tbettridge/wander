import assert from 'node:assert/strict';
import {
  ROCK_CLUSTER_RADIUS,
  rockClustersForChunk,
  rockPlacementsForChunk,
} from '../src/rockscatter.mjs';

const world = {
  seed: 7419,
  height(x, z) {
    return 54 + x * 0.085 - z * 0.045
      + Math.sin(x * 0.035) * 5.5 + Math.cos(z * 0.027) * 4.0;
  },
  biomeAt(x, z) {
    const h = this.height(x, z);
    const e = 1.5;
    const dx = this.height(x - e, z) - this.height(x + e, z);
    const dz = this.height(x, z - e) - this.height(x, z + e);
    const slope = 1 - (e * 2) / Math.hypot(dx, e * 2, dz);
    return { id: h > 58 ? 'taiga' : 'grassland', h, slope };
  },
};

const size = 140;
const first = rockPlacementsForChunk(world, 0, 0, size);
const again = rockPlacementsForChunk(world, 0, 0, size);
assert.deepEqual(first, again, 'rock placement is not deterministic');
assert.ok(first.length > 8, 'fixture did not produce a useful clustered rock sample');

const clusters = rockClustersForChunk(world, 0, 0, size);
const grouped = clusters.filter((cluster) => cluster.members.length > 1);
assert.ok(grouped.length > 0, 'fixture produced no multi-rock clusters');
for (const cluster of grouped) {
  const leader = cluster.members.find((member) => member.leader);
  assert.ok(leader, 'cluster has no dominant rock');
  for (const member of cluster.members) {
    assert.ok(member.scale <= leader.scale + 1e-9, 'secondary rock exceeds its leader');
    assert.ok(Math.hypot(member.x - cluster.x, member.z - cluster.z)
      <= ROCK_CLUSTER_RADIUS * 2.05, 'cluster member escaped its bounded footprint');
  }
}

// Half-open ownership: members from clusters spanning the x=140 boundary must
// appear in exactly one of the two adjacent chunks.
const adjacent = rockPlacementsForChunk(world, 1, 0, size);
const identity = (member) => `${member.x.toFixed(8)},${member.z.toFixed(8)}`;
const leftKeys = new Set(first.map(identity));
for (const member of adjacent) {
  assert.ok(!leftKeys.has(identity(member)), `duplicate cross-chunk rock at ${identity(member)}`);
  assert.ok(member.x >= size && member.x < size * 2, 'right chunk owns an out-of-range member');
}
for (const member of first) {
  assert.ok(member.x >= 0 && member.x < size, 'left chunk owns an out-of-range member');
}

assert.ok(first.some((member) => member.type === 'boulder'), 'size hierarchy has no boulders');
assert.ok(first.some((member) => member.type === 'rock'), 'size hierarchy has no small field rocks');
assert.ok(first.every((member) => member.variant >= 0 && member.variant < 8), 'invalid rock variant');

console.log(`rockscatter PASS · ${clusters.length} clusters · ${first.length} members · deterministic ownership`);
