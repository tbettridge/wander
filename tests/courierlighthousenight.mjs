import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { CourierController, initializeCourier } from '../src/courier.mjs';
import { COURIER_ROLES } from '../src/couriercontent.mjs';
import { BEAM_SIGHT_RANGE, HORIZON_ARCHIVIST, HORIZON_REACTIONS, LAMP_OUT_FROM_HOUR, LAMP_UNSEEN_HOUR, SPOUSE_HOME_HOUR, addBeamArms, beamDirections,
  beamSide, beamVisibleFrom, keeperFeverLine, keeperLog, lampNight, lampOutDoorNote, lampOutDue, lampOutLetters, lampOutLit, lightShortName,
  twoHandsLines } from '../src/courierlighthouse.mjs';
import { addRoadArm } from '../src/courierroads.mjs';
import { STORY_FIRST, beatDone, storyNeeds } from '../src/courierstory.mjs';

/**
 * The tutorial round plus a lighthouse kept by Ada Firth and her partner
 * Sam, six kilometres from the post town A, as in tests/courierlighthouse.mjs.
 */
function fixture({ alone = false } = {}) {
  const state = createLivingWorldState({ worldSeed: 20260612, playerId: 'player:local' });
  const places = { A: { id: 'a', name: 'Ravenkeld', x: 0, z: 0 }, B: { id: 'b', name: 'Oakgate', x: 1000, z: 0 }, H: { id: 'h', name: 'Holtwick', x: 500, z: 300 } };
  const light = { key: 'M1_0', id: 'M1_0', name: 'Firth Lighthouse', kind: 'lighthouse', x: 6000, z: 0 };
  const cast = Object.fromEntries(Object.entries(COURIER_ROLES).map(([role, place]) => {
    const id = 'npc:' + role; state.entities[id] = { id, kind: 'npc', name: role, inTransit: false };
    return [role, { id, name: role, place }];
  }));
  const person = (id, name, at, address, role = 'resident') => {
    state.entities[id] = { id, kind: 'npc', name, inTransit: false };
    return { id, name, role, home: { id: id + ':home', name: name + '’s home', x: at.x, z: at.z, address } };
  };
  const keeper = person('npc:keeper', 'Ada Firth', light, 'Ada Firth’s household, the keeper’s house at the foot of Firth Lighthouse', 'lighthouse keeper');
  const spouse = alone ? null : person('npc:spouse', 'Sam Firth', light, 'the keeper’s house', 'keeper’s spouse');
  const townsfolk = [person('npc:chandler', 'Rowan Hale', places.A, 'north of the well'), person('npc:baker', 'Elis Moor', places.A, 'south of the well')];
  const where = { 'npc:keeper': light, 'npc:spouse': light, 'npc:chandler': places.A, 'npc:baker': places.A };
  const player = { x: 0, z: 0, y: 2 };
  initializeCourier(state, { places, cast, routes: {} });
  const controller = new CourierController({ getState: () => state, getPlayer: () => player,
    getNpcPosition: id => where[id] || places[cast[id.replace('npc:', '')]?.place],
    getSourcePosition: id => id === 'board:M1_0' ? light : places[id.split(':')[1]],
    getPlace: key => key === light.key ? light : null });
  const visit = place => Object.assign(player, place === 'L' ? light : places[place]);
  return { state, controller, visit, player, keeper, spouse, townsfolk, light, cast };
}
const lightRef = light => ({ id: light.id, key: light.key, name: light.name });

test('the lamp goes dark once, on an evening after the courier has watched it come on', () => {
  const due = over => lampOutDue({ lampOut: null, seenLit: 4, night: 5, hour: 16.2, near: true, keeperUp: false, ...over });
  assert.equal(due(), true);
  assert.equal(due({ seenLit: null }), false, 'never before the courier has seen it lit');
  assert.equal(due({ night: 4 }), false, 'not the same night it was seen');
  assert.equal(due({ near: false }), false, 'not with the courier out of sight of it');
  assert.equal(due({ keeperUp: true }), false, 'not once the keeper is on the stair');
  assert.equal(due({ hour: LAMP_OUT_FROM_HOUR - 0.1 }), false);
  assert.equal(due({ hour: LAMP_UNSEEN_HOUR }), false, 'not once the lamp would have been lit unseen');
  assert.equal(due({ lampOut: { night: 5 } }), false, 'once in the game');
  assert.equal(lampNight(6, 2), 5, 'two in the morning belongs to the night before');
});

test('on the dark night the lamp stays out until somebody lights it, then burns until sunrise', () => {
  assert.equal(lampOutLit({ hour: 18.5 }), false);
  assert.equal(lampOutLit({ hour: 21.5 }), false);
  assert.equal(lampOutLit({ hour: SPOUSE_HOME_HOUR }), true, 'the spouse home at ten lights it');
  assert.equal(lampOutLit({ hour: 18.5, litHour: 18.2 }), true, 'lit by the courier');
  assert.equal(lampOutLit({ hour: 18.1, litHour: 18.2 }), false);
  assert.equal(lampOutLit({ hour: 19.5, homeHour: 19.2 }), true, 'a spouse sent home early lights it when they get there');
  assert.equal(lampOutLit({ hour: 2 }), true);
  assert.equal(lampOutLit({ hour: 7 }), false, 'out at sunrise');
});

test('the fever powders go up on the post town board, the courier lights the lamp, and letters come the next post day', () => {
  const { state, controller: c, visit, keeper, spouse, townsfolk, light } = fixture();
  assert.equal(c.noteLampSeen(3), true);
  assert.equal(c.noteLampSeen(4), false, 'the first night seen is kept');
  const out = c.beginLampOut({ night: 4, light: lightRef(light), keeper, spouse, townKey: 'A', senders: townsfolk });
  assert.equal(out.spouse, 'npc:spouse');
  assert.equal(c.beginLampOut({ night: 5, light: lightRef(light), keeper, spouse, townKey: 'A', senders: townsfolk }), null, 'once');
  const powders = c.feverPowders();
  assert.equal(powders.def.title, 'Fever Powders for Ada');
  assert.equal(c.placeOf(powders.def.sender), 'A');
  assert.equal(powders.def.recipient, keeper.id);
  assert.ok(c.boardJobs('A').some(job => job.id === powders.def.id), 'pinned in the post town');
  assert.match(powders.def.description, /while Sam is away/);
  visit('L');
  const lit = c.lightLamp({ hour: 18.3 });
  assert.equal(lit.ok, true);
  assert.equal(state.courier.plot.lampOut.litBy, 'courier');
  assert.equal(c.lightLamp({ hour: 18.4 }).ok, false, 'already lit');
  // Fetch the medicine.
  visit('A');
  assert.equal(c.accept(powders.def.id, powders.def.sender).ok, true);
  visit('L');
  const handed = c.handoff(powders.def.id, keeper.id);
  assert.equal(handed.ok, true);
  assert.match(handed.message, /Willow bark/);
  assert.equal(Object.values(state.courier.plot.jobs).some(def => def.inReplyTo === powders.def.id), false, 'no answer to carry back');
  const read = () => c.takeLampOutLetters({ watchers: [{ name: 'Wynn Tarr', place: 'Saltmarsh' }, { name: 'Ida Crane', place: 'Gull End' }],
    light: light.name, keeper: keeper.name, spouse: spouse.name });
  assert.equal(read(), null, 'not the same post day');
  state.courier.plot.postDay = (state.courier.plot.postDay || 0) + 1;
  const letters = read();
  assert.equal(letters.length, 3, 'one from each watcher, and one from the keeper');
  assert.equal(letters[0].title, 'A letter from Saltmarsh');
  assert.match(letters[0].text, /Wynn Tarr, Saltmarsh$/);
  assert.match(letters[2].text, /You lit it\./);
  assert.match(letters[2].text, /The powders did their work/);
  assert.match(letters[2].text, /Ada Firth, and Sam$/);
  assert.equal(read(), null, 'once');
});

test('found at the market, the spouse goes home early and lights the lamp late', () => {
  const { state, controller: c, keeper, spouse, townsfolk, light } = fixture();
  c.noteLampSeen(1);
  c.beginLampOut({ night: 2, light: lightRef(light), keeper, spouse, townKey: 'A', senders: townsfolk });
  const fetched = c.fetchSpouse({ hour: 18.6 });
  assert.equal(fetched.homeHour, 18.6 + 0.75);
  assert.equal(c.fetchSpouse({ hour: 19 }), null, 'once');
  assert.equal(lampOutLit({ hour: 19.5, litHour: fetched.litHour, homeHour: fetched.homeHour }), true);
  state.courier.plot.postDay = (state.courier.plot.postDay || 0) + 1;
  const letters = c.takeLampOutLetters({ watchers: [], light: light.name, keeper: keeper.name, spouse: spouse.name });
  assert.equal(letters.length, 1);
  assert.match(letters[0].text, /You found Sam at the market/);
  assert.match(letters[0].text, /Sam sat up with me/);
});

test('a keeper who lives alone has nobody in town: their own words, and no spouse to fetch', () => {
  const { controller: c, keeper, townsfolk, light } = fixture({ alone: true });
  c.noteLampSeen(1);
  const out = c.beginLampOut({ night: 2, light: lightRef(light), keeper, spouse: null, townKey: 'A', senders: townsfolk });
  assert.equal(out.spouse, null);
  assert.equal(c.fetchSpouse({ hour: 18 }), null);
  assert.match(c.feverPowders().def.description, /with nobody else at home/);
  assert.match(keeperFeverLine({ stage: 'dark', keeper: 'Ada Firth', spouse: null, town: 'Ravenkeld' }), /there is nobody else here/);
  assert.doesNotMatch(keeperFeverLine({ stage: 'lit', keeper: 'Ada Firth', spouse: null, town: 'Ravenkeld', sender: 'Rowan Hale' }), /My other half|market/);
  const [letter] = lampOutLetters({ keeper: 'Ada Firth', light: 'Firth Lighthouse', lit: 'late' });
  assert.match(letter.text, /I got myself up the stair at ten/);
});

test('the keeper’s words on the dark night name the matches, the town and the powders, with no AI', () => {
  const dark = keeperFeverLine({ stage: 'dark', keeper: 'Ada Firth', spouse: 'Sam Firth', town: 'Ravenkeld' });
  assert.match(dark, /Sam is in Ravenkeld/);
  assert.match(dark, /matches are on the shelf beside the lamp/);
  assert.match(keeperFeverLine({ stage: 'lit', keeper: 'Ada Firth', spouse: 'Sam Firth', town: 'Ravenkeld', sender: 'Rowan Hale' }), /Rowan keeps fever powders/);
  assert.equal(lampOutDoorNote({ surname: 'Firth' }), 'Keeper laid up with a fever. Please knock and come in. — The Firths');
  const late = lampOutLetters({ seed: 9, night: 2, keeper: 'Ada Firth', light: 'Firth Lighthouse', watchers: [{ name: 'Wynn Tarr', place: 'Saltmarsh' }] });
  assert.doesNotMatch(late[0].text, /\{|\}/, 'every name filled in');
  assert.equal(lightShortName('Firth Lighthouse'), 'Firth Light');
});

test('the flash gives directions: which side it lies as you walk the road home', () => {
  // +Z north, +X west: facing north, east (-X) is on your right.
  assert.equal(beamSide({ x: 0, z: 1 }, { x: -1, z: 0 }), 'on your right');
  assert.equal(beamSide({ x: 0, z: 1 }, { x: 1, z: 0 }), 'on your left');
  assert.equal(beamSide({ x: 0, z: 1 }, { x: 0, z: 1 }), 'straight ahead of you');
  assert.equal(beamSide({ x: 0, z: 1 }, { x: 0, z: -1 }), 'at your back');
  assert.equal(beamSide({ x: 0, z: 1 }, { x: -1, z: -0.8 }), 'over your right shoulder');
  const said = beamDirections({ from: { x: 0, z: 0 }, lamp: { x: 0, z: -2000 }, toward: { x: 0, z: 300 }, home: 'Ravenkeld', light: 'Firth Light' });
  assert.equal(said, 'Going back to Ravenkeld tonight? Keep the flash of Firth Light at your back until you strike the road. Once the hills hide it, the road posts will see you home.');
  assert.match(beamDirections({ from: { x: 0, z: 0 }, lamp: { x: 0, z: 100 }, toward: { x: 0, z: 300 }, home: 'Ravenkeld', light: 'Firth Light' }),
    /Walk away from the tower/);
});

test('the beam is hidden behind a hill and out of range, and seen over flat ground', () => {
  const lamp = { x: 0, y: 40, z: 0 };
  const flat = () => 0, hill = (x) => (x > 900 && x < 1100 ? 80 : 0);
  assert.equal(beamVisibleFrom({ x: 2000, z: 0 }, lamp, flat), true);
  assert.equal(beamVisibleFrom({ x: 2000, z: 0 }, lamp, hill), false, 'a ridge between');
  assert.equal(beamVisibleFrom({ x: -2000, z: 0 }, lamp, hill), true, 'the other side is clear');
  assert.equal(beamVisibleFrom({ x: BEAM_SIGHT_RANGE + 10, z: 0 }, lamp, flat), false, 'too far for the haze');
});

test('road posts in sight get one Firth Light arm, at the bottom, and none when full, blind or already pointing there', () => {
  const lamp = { x: 0, y: 40, z: 0 };
  const posts = [
    { x: 500, z: 0, arms: [{ destination: 'Ravenkeld', toward: { x: 600, z: 0 }, owner: 'B' }] },
    { x: 2000, z: 0, arms: [{ destination: 'Oakgate', toward: { x: 2100, z: 0 }, owner: null }] },
    { x: 400, z: 0, arms: ['a', 'b', 'c', 'd'].map(name => ({ destination: name, toward: { x: 0, z: 1 } })) },
  ];
  const added = addBeamArms(posts, { lamp, name: 'Firth Light', heightAt: x => (x > 900 && x < 1100 ? 80 : 0) });
  assert.deepEqual(added, [posts[0]]);
  assert.deepEqual(posts[0].arms[1], { destination: 'Firth Light', toward: { x: 0, z: 0 }, owner: 'B', beam: true });
  assert.equal(addBeamArms(posts, { lamp, name: 'Firth Light', heightAt: () => 0 }).includes(posts[0]), false, 'one arm a post');
  // A road arm added later goes above the beam arm.
  addRoadArm(posts, { x: 500, z: 0, destination: 'Holtwick', toward: { x: 500, z: 100 } });
  assert.deepEqual(posts[0].arms.map(arm => arm.destination), ['Ravenkeld', 'Holtwick', 'Firth Light']);
});

test('the log holds one night in two hands: the spouse hands over their side, and comparing them is a memory', () => {
  const { state, controller: c, visit, keeper, spouse, light } = fixture();
  state.courier.evidence[STORY_FIRST] = { id: STORY_FIRST, sourceIds: [] };
  const log = keeperLog({ seed: 5, day: 0, keeper: keeper.name, light: light.name, spouse: spouse.name });
  assert.deepEqual(log.twoHands, twoHandsLines({ seed: 5, keeper: keeper.name, spouse: spouse.name }));
  assert.notEqual(log.twoHands.night.keeperWeather, log.twoHands.night.spouseWeather, 'different weather');
  const read = c.readKeeperLog({ keeper, spouse: { id: spouse.id, name: spouse.name }, light: lightRef(light), log });
  assert.equal(read.ok, true);
  assert.match(read.message, /“A log in two hands”|written twice|night written twice/);
  assert.ok(state.courier.evidence['two-hands-keeper']);
  assert.equal(state.courier.evidence['two-hands-spouse'], undefined, 'the spouse’s side is theirs to give');
  assert.equal(storyNeeds(state.courier).some(need => need.account.startsWith('two-hands') || need.account === 'horizon'), false,
    'the director never goes looking for it');
  visit('L');
  const offered = c.handedHere(spouse.id).map(item => item.accountId);
  assert.deepEqual(offered, ['two-hands-spouse']);
  const got = c.receive('two-hands-spouse', spouse.id);
  assert.equal(got.ok, true);
  assert.match(got.document.text, /That entry is mine/);
  assert.equal(c.compare('two-hands').ok, true);
  assert.equal(beatDone(state.courier, 'memory'), true, 'two people remember the same night differently');
});

test('the keeper’s frightened page goes to the station archivist as a letter, and each reader answers it', () => {
  const { state, controller: c, visit, keeper, light, cast } = fixture({ alone: true });
  state.courier.evidence[STORY_FIRST] = { id: STORY_FIRST, sourceIds: [] };
  const log = keeperLog({ seed: 5, day: 0, keeper: keeper.name, light: light.name });
  assert.match(log.horizon.join(' '), /the same line at the same distance/);
  c.readKeeperLog({ keeper, light: lightRef(light), log });
  assert.ok(state.courier.evidence.horizon);
  const letter = Object.values(state.courier.plot.jobs).find(def => def.horizon);
  assert.ok(letter, 'the keeper offers a letter for the archivist');
  assert.equal(c.npc(letter.recipient).id, cast.archivist.id);
  assert.equal(letter.sender, keeper.id);
  visit('L');
  assert.equal(c.accept(letter.id, keeper.id).ok, true);
  visit(cast.archivist.place);
  const handed = c.handoff(letter.id, cast.archivist.id);
  assert.equal(handed.ok, true);
  assert.ok(Object.values(HORIZON_ARCHIVIST).some(line => handed.message.startsWith(line)), handed.message);
  visit('A');
  const said = c.shareEvidence('npc:chandler', ['horizon']);
  assert.equal(said.ok, true);
  assert.ok(said.message.endsWith(HORIZON_REACTIONS[said.stance]), said.message);
  visit('L');
  assert.match(c.shareEvidence(keeper.id, ['horizon']).message, /./);
});

test('in the real world, the beam reaches the post town by the coast and not Ravenkeld behind the hills', async () => {
  const { World } = await import('../src/world.js');
  const { majorLandmarksAround } = await import('../src/landmarks.js');
  const { settlementsAround } = await import('../src/settlementplacement.mjs');
  const { lighthousePlanInWorld, lighthouseWorldPoint } = await import('../src/lighthouseplan.mjs');
  const world = new World(20260612, { generationVersion: 3 });
  const ravenkeld = { x: 4483, z: 1450 };
  const landmark = majorLandmarksAround(world, ravenkeld.x, ravenkeld.z, world.seed, 9000, []).filter(item => item.type === 'lighthouse')
    .sort((a, b) => Math.hypot(a.x - ravenkeld.x, a.z - ravenkeld.z) - Math.hypot(b.x - ravenkeld.x, b.z - ravenkeld.z))[0];
  const plan = lighthousePlanInWorld(world, landmark), lamp = lighthouseWorldPoint(plan, 0, plan.lampY, 0);
  const height = (x, z) => world.height(x, z);
  assert.equal(beamVisibleFrom(ravenkeld, lamp, height), false, 'Ravenkeld is behind the hills');
  const sites = settlementsAround(world, lamp.x, lamp.z, world.seed, 7000, []);
  const town = sites.find(site => site.id === 'settlement:3:1');
  assert.ok(town, 'the coast town is there');
  assert.equal(beamVisibleFrom(town, lamp, height), true, 'the coast town sees the flash');
  assert.ok(sites.some(site => !beamVisibleFrom(site, lamp, height)), 'and some places inland do not');
});
