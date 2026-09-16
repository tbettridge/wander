import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { refineBasinConnection } from '../src/basinmembership.mjs';
import { fitRiverReach } from '../src/riverterrain.mjs';
import { buildLakeRiverContacts, sampleLakeRiverTransition } from '../src/lakecontacts.mjs';

function fixture() {
  const world = new World(7, { generationVersion: 3 });
  world._naturalHeight = (x, z, out) => {
    const radius = Math.hypot(x, z);
    const height = radius < 18 ? 1 : Math.min(8, 1 + (radius - 18) * 0.25);
    if (out) out.h = height;
    return height;
  };
  const basin = refineBasinConnection(world, {
    id: 'lake:fixture', kind: 'lake', level: 4, centerX: 0, centerZ: 0,
    bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  });
  const fit = (id, points, options = {}) => fitRiverReach(world,
    { status: 'candidate', source: id, points },
    { basins: [basin], id: `reach:${id}`, halfWidth: 2, oceanMouth: false, ...options });
  const inlet = fit('inlet-a', [{ x: -60, z: 0, waterY: 5 }, { x: 0, z: 0, waterY: 4 }],
    { sourceClosure: true });
  const inletTwo = fit('inlet-b', [{ x: -60, z: 16, waterY: 5 }, { x: 0, z: 16, waterY: 4 }],
    { sourceClosure: true });
  const outlet = fit('outlet', [{ x: 0, z: 8, waterY: 4 }, { x: 60, z: 8, waterY: 3 }],
    { sourceClosure: false });
  return { world, basin, inlet, inletTwo, outlet };
}

function assertFiniteTree(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) value.forEach(assertFiniteTree);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteTree);
}

test('contacts come from a fitted reach crossing connected wet lake membership', () => {
  const { basin, inlet, outlet } = fixture();
  assert.equal(inlet.status, 'fitted');
  assert.equal(outlet.status, 'fitted');
  const result = buildLakeRiverContacts([outlet, inlet], [basin]);
  assert.equal(result.status, 'built');
  assert.deepEqual(result.contacts.map(contact => contact.role), ['inlet', 'outlet']);
  assert.deepEqual(result.contacts.map(contact => contact.lakeId), ['lake:fixture', 'lake:fixture']);
  assert.deepEqual(result.contacts.map(contact => contact.reachId), ['reach:inlet-a', 'reach:outlet']);
  for (const contact of result.contacts) {
    assert.equal(contact.lakeHead, basin.level);
    assert.equal(contact.waterY, basin.level);
    assert.equal(contact.connectedWet, true);
    assert.equal(contact.membership, 'wetBasinAt');
    assert.ok(contact.transitionExtent.upstream > 0);
    assert.ok(contact.transitionExtent.downstream > 0);
    assert.ok(contact.transitionExtent.lateral > 0);
    assert.ok(contact.transitionExtent.total <= 2 * 96);
    assert.ok(contact.bounds.minX <= contact.position.x && contact.position.x <= contact.bounds.maxX);
    assert.ok(contact.bounds.minZ <= contact.position.z && contact.position.z <= contact.bounds.maxZ);
    assertFiniteTree(contact);
  }
});

test('inlet and outlet flow keep the fitted downstream direction while fading in lake water', () => {
  const { basin, inlet, outlet } = fixture();
  const { contacts } = buildLakeRiverContacts([inlet, outlet], [basin]);
  const inletContact = contacts.find(contact => contact.role === 'inlet');
  const outletContact = contacts.find(contact => contact.role === 'outlet');
  for (const [contact, sign] of [[inletContact, 1], [outletContact, -1]]) {
    const x = contact.position.x + sign * 4 * contact.tangent.x;
    const z = contact.position.z + sign * 4 * contact.tangent.z;
    const sample = {};
    assert.equal(sampleLakeRiverTransition(contact, basin, x, z, sample), true);
    const downstream = sample.flowX * contact.tangent.x + sample.flowZ * contact.tangent.z;
    assert.ok(downstream > 0, `${contact.role} current points downstream`);
    assert.ok(sample.flowAttenuation > 0);
    assert.ok(sample.flowTransmission < 1);
    assert.equal(sample.waterY, basin.level);
    assert.equal(sample.bodyId, basin.id);
  }
});

test('multiple fitted inlets retain distinct reach ownership and deterministic ordering', () => {
  const { basin, inlet, inletTwo, outlet } = fixture();
  const first = buildLakeRiverContacts([inletTwo, outlet, inlet], [basin]);
  const second = buildLakeRiverContacts([inlet, outlet, inletTwo], [basin]);
  assert.equal(first.status, 'built');
  assert.deepEqual(first.contacts, second.contacts);
  const inlets = first.contacts.filter(contact => contact.role === 'inlet');
  assert.equal(inlets.length, 2);
  assert.equal(new Set(inlets.map(contact => contact.reachId)).size, 2);
  assert.equal(new Set(inlets.map(contact => contact.ownerId)).size, 2);
  assert.ok(Math.hypot(inlets[0].position.x - inlets[1].position.x,
    inlets[0].position.z - inlets[1].position.z) > 8);
});

test('disconnected low hollows and dry shoreline samples never acquire transition ownership', () => {
  const { basin, inlet } = fixture();
  const disconnected = structuredClone(basin);
  disconnected.id = 'lake:disconnected';
  disconnected.grid.signed = disconnected.grid.signed.map((value, index) => {
    const col = index % disconnected.grid.cols;
    const row = Math.floor(index / disconnected.grid.cols);
    const x = disconnected.grid.x0 + col * disconnected.grid.step;
    const z = disconnected.grid.z0 + row * disconnected.grid.step;
    // Expose low-looking disconnected lobes in the rectangle with negative
    // membership, as a real refined basin does. The whole test basin remains
    // dry to this reach even though its bounds cover the fitted path.
    return (x > 20 && z > -8 && z < 8) || value > 0 ? -0.5 : value;
  });
  const result = buildLakeRiverContacts([inlet], [disconnected]);
  assert.equal(result.status, 'built');
  assert.equal(result.contacts.length, 0);

  const connected = buildLakeRiverContacts([inlet], [basin]);
  const contact = connected.contacts[0], dry = {};
  const x = contact.position.x - contact.tangent.x;
  const z = contact.position.z - contact.tangent.z;
  assert.equal(sampleLakeRiverTransition(contact, basin, x, z, dry), false);
  assert.deepEqual(dry, {});
});

test('malformed or duplicate ownership inputs reject without publishing contacts', () => {
  const { basin, inlet } = fixture();
  assert.equal(buildLakeRiverContacts([inlet, { ...inlet, id: inlet.id }], [basin]).reason,
    'duplicate-reach-id');
  assert.equal(buildLakeRiverContacts([inlet], [basin, { ...basin }]).reason, 'duplicate-lake-id');
  assert.equal(buildLakeRiverContacts([{ status: 'fitted', id: 'bad', points: [] }], [basin]).reason,
    'invalid-fitted-reach');
});
