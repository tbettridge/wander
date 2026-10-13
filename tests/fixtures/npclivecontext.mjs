import { generateSettlementCohort } from '../../src/settlementcohort.mjs';
import { createLivingWorldState, setLivingWorldFeatures } from '../../src/livingworldstate.mjs';
import { activateSettlementResidents } from '../../src/npcresidenceregistry.mjs';
import { buildNpcCommunityContext } from '../../src/npccommunitycontext.mjs';
import { npcWhereaboutsContext } from '../../src/npcwhereabouts.mjs';
import { CourierController, initializeCourier } from '../../src/courier.mjs';
import { COURIER_ROLES } from '../../src/couriercontent.mjs';

// Use the production settlement/household generators, including a large
// station village. Tiny single-NPC fixtures missed the startup regression.
export function generatedLiveContexts() {
  const plans = generateSettlementCohort({ seeds: [20260612] });
  const state = createLivingWorldState({ worldSeed: 20260612 });
  setLivingWorldFeatures(state, { unifiedNpcMobilityEnabled: true });
  for (const plan of plans) activateSettlementResidents(plan, state);
  const residents = plan => Object.values(state.entities).filter(person => person.residence?.residenceSettlementId === plan.site.id);
  const largest = [...plans].sort((a, b) => residents(b).length - residents(a).length).slice(0, 3);
  const places = Object.fromEntries(['A', 'B', 'H'].map((key, i) => [key, {
    id: largest[i].site.id, name: largest[i].site.id, x: largest[i].site.x, z: largest[i].site.z,
  }]));
  const cast = {};
  for (const [i, key] of ['A', 'B', 'H'].entries()) {
    const people = residents(largest[i]);
    Object.entries(COURIER_ROLES).filter(([, place]) => place === key).forEach(([role], n) => {
      const person = people[n], home = largest[i].buildings.find(building => building.id === person.residence.homeBuildingId);
      cast[role] = { id: person.id, name: person.name, place: key,
        home: { id: home.id, name: `${person.name}'s home`, x: home.x, z: home.z,
          address: `${person.name}'s household near the central well in ${places[key].name}` } };
    });
  }
  initializeCourier(state, { places, cast, routes: {} });
  const courier = new CourierController({ getState: () => state, getPlayer: () => places.A,
    getNpcPosition: () => places.A, getSourcePosition: () => places.A });
  return plans.map(plan => {
    const npc = residents(plan)[0], origin = plan.site;
    const community = buildNpcCommunityContext({ state, speakerId: npc.id, settlementPlans: plans, speakerPosition: origin });
    return { ...npcWhereaboutsContext({ state, community, speakerId: npc.id, settlementPlans: plans, origin }),
      npc: { id: npc.id, name: npc.name, role: npc.role }, station: { name: plan.site.id }, targets: [],
      courier: courier.contextForNpc(npc.id) };
  });
}
