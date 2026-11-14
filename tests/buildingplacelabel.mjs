import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingPlaceLabel } from '../src/settlementnames.mjs';

test('stepping inside names the household, the business or the village building', () => {
  assert.equal(buildingPlaceLabel({ program: 'dwelling', ownerSurname: 'Barton' }), 'the Barton household');
  assert.equal(buildingPlaceLabel({ program: 'row-house', ownerSurname: 'Fallow' }), 'the Fallow household');
  assert.equal(buildingPlaceLabel({ program: 'dwelling' }), 'a cottage');
  assert.equal(buildingPlaceLabel({ program: 'smithy', ownerSurname: 'Kirk' }), 'Kirk’s Smithy');
  assert.equal(buildingPlaceLabel({ program: 'general-store', ownerSurname: 'Abbey' }), 'Abbey’s General Store');
  assert.equal(buildingPlaceLabel({ program: 'inn' }), 'the Inn');
  assert.equal(buildingPlaceLabel({ program: 'church' }, { settlementName: 'Oakgate' }), 'Oakgate church');
  // In First Post the village is learned from its name board, never from the HUD.
  assert.equal(buildingPlaceLabel({ program: 'church' }), 'the church');
  assert.equal(buildingPlaceLabel({ program: 'community-hall' }), 'the reading room');
  assert.equal(buildingPlaceLabel(null), null);
});
