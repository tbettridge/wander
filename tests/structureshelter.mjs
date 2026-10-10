import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILDING_PROGRAMS, createBuildingPlan, buildingWorldPoint } from '../src/buildingplan.mjs';
import { interiorBaseY } from '../src/interiorarchitecture.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { MAX_RAIN_COVERS, buildingRainCovers, pointBelowRainCover, roofCoverFromMatrix, selectRainCovers } from '../src/structureshelter.mjs';

test('all building programs shelter ground and upper floors while leaving exterior rain visible', () => {
  for (const program of BUILDING_PROGRAMS) for (let seed = 1; seed <= 30; seed++) {
    const b = createBuildingPlan({id:`rain:${program}:${seed}`,program,seed,x:43,y:12,z:-18,yaw:seed*.37});
    const covers = buildingRainCovers(b), core = covers[0];
    for (const room of b.interior.rooms) {
      const p = buildingWorldPoint(b,(room.bounds.minX+room.bounds.maxX)/2,(room.bounds.minZ+room.bounds.maxZ)/2);
      p.y=interiorBaseY(b)+room.y+1.6;
      assert.equal(covers.some(cover=>pointBelowRainCover(cover,p)),true,room.id);
    }
    assert.equal(pointBelowRainCover(core,{x:core.x,y:core.y+core.rise+.1,z:core.z}),false,'rain above the roof remains');
    const outside=buildingWorldPoint(b,0,b.depth/2+2);outside.y=b.y+1;
    assert.equal(pointBelowRainCover(core,outside),false,'clear doorway/window exterior remains rainy');
    for(const key of ['x','z','y','halfWidth','halfDepth','cos','sin','rise','kind'])assert.ok(Number.isFinite(core[key]),key);
  }
});

test('moving carriage roofs follow world yaw, position, and track pitch', () => {
  for(const yaw of [0,.7,2.4])for(const pitch of [-.15,0,.2]){
    const c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
    const e=[c,0,-s,0, s*sp,cp,c*sp,0, s*cp,-sp,c*cp,0, 140,32,-75,1];
    const cover=roofCoverFromMatrix(e,1.36,3.625,3.44);
    const transform=(x,y,z)=>({x:e[0]*x+e[4]*y+e[8]*z+e[12],y:e[1]*x+e[5]*y+e[9]*z+e[13],z:e[2]*x+e[6]*y+e[10]*z+e[14]});
    for(const z of [-3,0,3]){
      assert.equal(pointBelowRainCover(cover,transform(0,2.6,z)),true,'standing/seated passenger stays dry');
      assert.equal(pointBelowRainCover(cover,transform(0,4,z)),false,'drops above carriage remain');
    }
    assert.equal(pointBelowRainCover(cover,transform(2.5,2.2,0)),false,'rain beside carriage remains');
    const moved=roofCoverFromMatrix([...e.slice(0,12),240,32,-75,1],1.36,3.625,3.44);
    assert.equal(pointBelowRainCover(moved,transform(0,2.6,0)),false,'old train location is no longer sheltered');
  }
});

test('rain shelter selection is bounded and prioritizes occupied shelter in a dense street', () => {
  const covers=Array.from({length:100},(_,i)=>({x:i-50,z:0,y:5,halfWidth:2,halfDepth:3,cos:1,sin:0,kind:0,rise:0,slopeX:0,slopeZ:0}));
  const point={x:35,y:2,z:0},out=[];
  assert.equal(selectRainCovers(covers,point,out),out);
  assert.equal(out.length,MAX_RAIN_COVERS);
  assert.equal(pointBelowRainCover(out[0],point),true);
  assert.equal(selectRainCovers(covers,{x:1000,y:2,z:0},out).length,0);
});

test('animals cannot cross open house doors or tunnel through rotated buildings', () => {
  for(const program of BUILDING_PROGRAMS)for(let seed=1;seed<=12;seed++){
    const b=createBuildingPlan({id:`animal:${program}:${seed}`,program,seed,x:17,y:7,z:-23,yaw:seed*.31});
    const state={portals:Object.fromEntries(b.portals.map(p=>[p.id,{progress:1}]))};
    const index=new StructureCollisionIndex(()=>state),release=index.registerPlan({id:b.id,buildings:[b],props:[]});
    const door=b.portals.find(p=>p.kind==='exterior-door');
    const start=buildingWorldPoint(b,door.x,b.depth/2+4);start.y=b.y+.16;
    const end=buildingWorldPoint(b,door.x,-b.depth/2-4);end.y=start.y;
    const result=index.resolveAnimalMovement(end,start,2.4);
    assert.equal(result.blocked,true,b.id);
    assert.equal(index.animalBlocked(end.x,end.z,2.4),false,b.id+' ended in a building');
    // Ordinary player entry stays open; animal exclusion is a separate query.
    const entry=buildingWorldPoint(b,door.x,b.depth/2-.15);entry.y=interiorBaseY(b)+.16;
    assert.equal(index.collides(entry.x,entry.z,entry.y,.2),null,b.id+' player doorway changed');
    const rain=[];index.collectRainCovers(rain);assert.ok(rain.length>0);
    release();assert.equal(index.animalBlocked(b.x,b.z,2.4),false);assert.equal(index.collectRainCovers([]).length,0);
  }
});

test('newly streamed buildings expel existing animals and preserve tangent travel', () => {
  const b=createBuildingPlan({id:'recovery',program:'dwelling',seed:8});
  const index=new StructureCollisionIndex();index.registerPlan({id:b.id,buildings:[b],props:[]});
  const position={x:b.x,y:99,z:b.z};
  index.resolveAnimalMovement(position,{...position},2.4);
  assert.equal(index.animalBlocked(position.x,position.z,2.4),false);
  assert.equal(position.y,99,'animal ground sampling still owns root height');
  const side=b.width/2+2.5,start=buildingWorldPoint(b,side,-b.depth/2-3),end=buildingWorldPoint(b,side,b.depth/2+3);
  index.resolveAnimalMovement(end,start,.5);
  assert.equal(index.animalBlocked(end.x,end.z,.5),false);
  const expected=buildingWorldPoint(b,side,b.depth/2+3);assert.ok(Math.hypot(end.x-expected.x,end.z-expected.z)<.01);
});
