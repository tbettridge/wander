import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createLivingWorldState, serializeLivingWorldState, parseLivingWorldState } from '../src/livingworldstate.mjs';
import { buildNpcCommunityContext } from '../src/npccommunitycontext.mjs';
import { dailyNpcWhereaboutsDecision, npcPeopleConnected, npcWhereaboutsContext,
  npcWhereaboutsReply, npcPersonPoint, npcPersonPointPlaces } from '../src/npcwhereabouts.mjs';
import { fallbackChatReply, conversationSystemPrompt, compactDialogueContext, LivingWorldDirector } from '../src/livingworld.mjs';
import { findMentionedTarget } from '../src/livingworldcontext.mjs';
import { createEmote, pulsePoint, pulseDelivery } from '../src/npcsocial.mjs';
import { resolveNpcPointTarget } from '../src/npcpointing.mjs';
import { npcDialogueText } from '../src/npcspeech.mjs';

function fixture({ connected = true, day = 0 } = {}) {
  const state = createLivingWorldState({worldSeed: 42});state.clock.worldHours=day*24+12;
  const home=(id, household)=>({id,kind:'npc',name:id==='npc:speaker'?'Rowan Reed':'Mira Moss',role:'miller',householdId:household,
    residence:{originSettlementId:'village',residenceSettlementId:'village',householdId:household,homeBuildingId:`home:${household}`},
    location:{kind:'building',settlementId:'village',buildingId:`home:${household}`,nodeId:null}});
  state.entities['npc:speaker']=home('npc:speaker','reed');state.entities['npc:mira']=home('npc:mira','moss');
  state.entities['npc:mira'].workplaceId='mill';state.entities['npc:mira'].location.buildingId='mill';
  state.households={reed:{id:'reed',homeBuildingId:'home:reed',memberIds:['npc:speaker']},moss:{id:'moss',homeBuildingId:'home:moss',memberIds:['npc:mira']}};
  state.workplaces.mill={id:'mill',settlementId:'village',buildingId:'mill',displayName:'Harrow Mill',kind:'granary'};
  state.routines.shift={id:'shift',actorId:'npc:mira',workplaceId:'mill',kind:'work',state:'working',startHour:8,endHour:17,days:[0,1,2,3,4,5]};
  if(connected)state.relationships['npc:speaker->npc:mira']={ownerId:'npc:speaker',subjectId:'npc:mira',familiarity:.8,tags:['friend']};
  const plans=[{site:{id:'village',name:'Alderford'},buildings:[{id:'home:reed',x:0,z:0,program:'dwelling',ownerHouseholdId:'reed',displayName:'Reed House'},
    {id:'home:moss',x:-40,z:20,program:'dwelling',ownerHouseholdId:'moss',displayName:'Moss House'},
    {id:'mill',x:200,z:50,program:'granary',displayName:'Harrow Mill'}, {id:'inn',x:20,z:-100,program:'inn',displayName:'The Lantern Inn'}]}];
  const origin={x:5,z:10};
  const build=()=>{const community=buildNpcCommunityContext({state,speakerId:'npc:speaker',settlementPlans:plans,speakerPosition:origin});
    return {...npcWhereaboutsContext({state,community,speakerId:'npc:speaker',settlementPlans:plans,origin}),npc:{id:'npc:speaker',name:'Rowan Reed'},station:{name:'Alderford'},targets:[{id:'mill',name:'Harrow Mill',worldX:200,worldZ:50}]};};
  return {state,plans,origin,build};
}
function dayWith(connected, known) { for(let day=0;day<100;day++){const f=fixture({connected,day});if(f.build().personWhereabouts[0].known===known)return day;}throw Error('no matching day'); }

test('connected includes family, coworkers and either direction of established social links',()=>{
  const f=fixture();assert.equal(npcPeopleConnected(f.state,'npc:speaker','npc:mira'),true);
  f.state.relationships={};assert.equal(npcPeopleConnected(f.state,'npc:speaker','npc:mira'),false);
  f.state.entities['npc:speaker'].workplaceId='mill';assert.equal(npcPeopleConnected(f.state,'npc:speaker','npc:mira'),true);
  delete f.state.entities['npc:speaker'].workplaceId;f.state.entities['npc:mira'].householdId='reed';assert.equal(npcPeopleConnected(f.state,'npc:speaker','npc:mira'),true);
});

test('daily rolls approach 80 percent for connected people and 30 percent otherwise',()=>{
  for(const [connected,expected] of [[true,.8],[false,.3]]){
    const {state}=fixture({connected});let known=0;
    for(let day=0;day<10000;day++){state.clock.worldHours=day*24+12;known+=dailyNpcWhereaboutsDecision(state,'npc:speaker','npc:mira').known;}
    assert.ok(Math.abs(known/10000-expected)<.02, `${connected}: ${known/10000}`);
    assert.equal(Object.keys(state.npcWhereabouts.decisions).length,1,'older days are pruned');
  }
});

test('a failed daily roll survives repeated questions, reload and a new social connection',()=>{
  const f=fixture({connected:false,day:dayWith(false,false)});const unknown=f.build().personWhereabouts[0];assert.equal(unknown.known,false);
  f.state.relationships['npc:speaker->npc:mira']={ownerId:'npc:speaker',subjectId:'npc:mira',familiarity:1,tags:['friend']};
  assert.equal(f.build().personWhereabouts[0].known,false);
  f.state.clock.worldHours+=10;assert.equal(f.build().personWhereabouts[0].known,false);
  const loaded=parseLivingWorldState(serializeLivingWorldState(f.state),{worldSeed:42});
  assert.equal(dailyNpcWhereaboutsDecision(loaded,'npc:speaker','npc:mira').known,false);
  assert.equal(npcWhereaboutsReply(f.build(),'Where is Mira?').text,"I'm not sure where Mira Moss is today.");
});

test('the next in-game day can change what the same NPC knows',()=>{
  const f=fixture();const outcomes=new Set();for(let d=0;d<30;d++){f.state.clock.worldHours=d*24+12;outcomes.add(f.build().personWhereabouts[0].known);}assert.equal(outcomes.size,2);
});

test('known leads hedge and point to work, a visiting inn, and then home',()=>{
  const f=fixture({day:dayWith(true,true)});let context=f.build();let reply=npcWhereaboutsReply(context,'Where can I find Mira?');
  assert.match(reply.text,/<gesture:point> Mira Moss should be at Harrow Mill right now, where they work/);
  assert.deepEqual(npcPersonPoint(context,'Ask Mira—over there.').place.worldX,200);
  f.state.entities['npc:mira'].location.buildingId='inn';context=f.build();assert.match(npcWhereaboutsReply(context,'Where is Mira today?').text,/I think Mira Moss might be at The Lantern Inn today/);
  assert.equal(npcPersonPoint(context,'Mira should be over there.').place.worldZ,-100);
  f.state.entities['npc:mira'].location.buildingId='home:moss';context=f.build();assert.match(npcWhereaboutsReply(context,'Where is Mira?').text,/should be at home/);
  assert.equal(context.personWhereabouts[0].place.worldX,-40);
});

test('unknown daily whereabouts are removed from prompts and cannot point via a named workplace',()=>{
  const f=fixture({day:dayWith(true,false)}),context=f.build();const person=context.personWhereabouts[0];
  assert.equal(person.known,false);assert.equal(person.place,undefined);
  assert.equal(context.homeCommunity.residents.find(r=>r.id==='npc:mira').status.kind,'unknown');
  assert.equal(npcPersonPointPlaces(context).length,0);
  assert.equal(npcPersonPoint(context,'Mira is at Harrow Mill now.').place,null);
  const prompt=conversationSystemPrompt(compactDialogueContext(context,{level:2,currentText:'Where is Mira?'}));
  assert.match(prompt,/If known is false/);assert.match(prompt,/do not infer a location/);
  assert.ok(prompt.includes('personWhereabouts'));assert.ok(!prompt.includes('"kind":"working"'));
  assert.equal(fallbackChatReply(context,'Where is Mira?').text,person.line);
});

test('an unknown lead stays blocked across both the person and the subsequent over-there speech segments',async()=>{
  const f=fixture({day:dayWith(true,false)}),context=f.build();const source=await readFile(new URL('../src/stationkeeper.js',import.meta.url),'utf8');
  const perform=source.slice(source.indexOf('  performSpeechSegment('),source.indexOf('\n  focusDialogue('));
  const point=source.slice(source.indexOf('  pointOut('),source.indexOf('\n  conversationPartner('));
  const host=vm.runInNewContext(`new (class {${perform}\n${point}})()`,{npcPersonPoint,findMentionedTarget,npcDialogueText,pulseDelivery,pulsePoint,resolveNpcPointTarget});
  const actor={avatar:{root:{position:f.origin}},emote:createEmote(1)};host.actorById=()=>actor;host.conversationContext=context;
  host.performSpeechSegment('npc:speaker',{input:'Mira is at Harrow Mill now.',gesture:'point'});assert.equal(actor.emote.pointLive,false);
  host.performSpeechSegment('npc:speaker',{input:'Over there.',gesture:'point'});assert.equal(actor.emote.pointLive,false);
});

test('direct person-location questions use the authored daily decision even when AI is available',async()=>{
  const f=fixture({day:dayWith(true,true)}),context=f.build();const director=new LivingWorldDirector();director._canAttempt=()=>true;
  director.runtime.enqueue=()=>{throw Error('must not ask a model to reroll daily knowledge');};
  const reply=await director.requestChatReply(context,'Where is Mira?','test');assert.equal(reply.source,'authored');assert.match(reply.reply.text,/should be at Harrow Mill/);
});

test('a person away on a train cannot be guessed at their home shift',()=>{
  const f=fixture({day:dayWith(true,true)});f.state.entities['npc:mira'].location={kind:'train-seat',runId:'train',carriageIndex:0,seatIndex:0};f.state.entities['npc:mira'].itineraryId='trip';
  const context=f.build();assert.equal(context.personWhereabouts[0].known,false);assert.equal(npcPersonPointPlaces(context).length,0);
});

test('daily whereabouts do not replace permanent home/job answers or historical stories',()=>{
 const f=fixture({day:dayWith(true,false)}),c=f.build();
 assert.equal(npcWhereaboutsReply(c,"Where is Mira's house?"),null);
 assert.equal(npcWhereaboutsReply(c,"Where is Mira's home?"),null);
 assert.equal(npcWhereaboutsReply(c,'Where does Mira work?'),null);
 assert.equal(npcPersonPoint(c,'Mira lives at Moss House.'),null);
 assert.equal(npcPersonPoint(c,'Mira works at Harrow Mill.'),null);
 assert.equal(npcWhereaboutsReply(c,'I saw Mira at Harrow Mill yesterday.',{response:true}),null);
 assert.match(npcWhereaboutsReply(c,'Mira is at Harrow Mill right now.',{response:true}).text,/not sure/);
});
