import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import {
  planSettlementBusinessSigns,
  SIGN_GRAPHIC_LAYOUTS,
  SIGN_MOUNTS,
  SIGN_PALETTES,
  SIGN_TYPOGRAPHY,
  validateSettlementBusinessSigns,
} from '../src/settlementsignage.mjs';
import { collisionSegmentsForBusinessSign } from '../src/structurecollision.mjs';

const world = {
  seed: 20260612,
  height() { return 18; },
  biomeAt() { return { h: 18, slope: 0.03, m: 0.55, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function corpus(limit = 24) {
  const plans = [];
  for (let z = -10; z <= 10 && plans.length < limit; z++) for (let x = -10; x <= 10 && plans.length < limit; x++) {
    const site = settlementForCell(world, x, z, world.seed);
    if (!site) continue;
    const plan = createSettlementPlan(site, {
      heightAt: world.height.bind(world), authoritativeWaterAt: () => false,
    });
    plans.push({ ...plan, businessSigns: planSettlementBusinessSigns(plan) });
  }
  return plans;
}

test('business signs are deterministic, surname-authored, smaller, and generously padded', () => {
  for (const plan of corpus(10)) {
    const first = planSettlementBusinessSigns(plan);
    const second = planSettlementBusinessSigns(plan);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(validateSettlementBusinessSigns(plan, first), { valid: true, errors: [] });
    for (const sign of first) {
      const building = plan.buildings.find((entry) => entry.id === sign.buildingId);
      assert.equal(sign.surname, building.ownerSurname);
      assert.equal(sign.displayName, building.displayName);
      assert.ok(sign.placement.dimensions.width <= 2.1);
      assert.ok(sign.placement.dimensions.height <= 0.82);
      assert.ok(sign.paddingRatio >= 0.14);
      assert.match(SIGN_TYPOGRAPHY[sign.typographyId].family, /serif/i);
    }
  }
});

test('settlement corpus varies graphic layout, serif treatment, palette, and mounting', () => {
  const signs = corpus().flatMap((plan) => plan.businessSigns);
  assert.ok(signs.length > 20, 'fixture should include enough owned businesses');
  assert.ok(new Set(signs.map((sign) => sign.layoutId)).size >= 4);
  assert.ok(new Set(signs.map((sign) => sign.typographyId)).size >= 3);
  assert.ok(new Set(signs.map((sign) => sign.paletteId)).size >= 5);
  assert.ok(new Set(signs.map((sign) => sign.placement.mount)).size >= 3);
  assert.ok(signs.every((sign) => SIGN_GRAPHIC_LAYOUTS.includes(sign.layoutId)));
  assert.ok(signs.every((sign) => SIGN_MOUNTS.includes(sign.placement.mount)));
  assert.ok(signs.every((sign) => SIGN_PALETTES[sign.paletteId]));
});

test('only freestanding post signs add compact, unloadable movement collision', () => {
  const plans = corpus();
  const signs = plans.flatMap((plan) => plan.businessSigns.map((sign) => ({ plan, sign })));
  const post = signs.find(({ sign }) => sign.placement.mount === 'post');
  assert.ok(post, 'fixture should exercise a post-mounted sign');
  const building = post.plan.buildings.find((entry) => entry.id === post.sign.buildingId);
  assert.equal(collisionSegmentsForBusinessSign(building, post.sign).length, 16);
  for (const { plan, sign } of signs.filter((entry) => entry.sign.placement.mount !== 'post')) {
    const owner = plan.buildings.find((entry) => entry.id === sign.buildingId);
    assert.deepEqual(collisionSegmentsForBusinessSign(owner, sign), []);
  }
});
