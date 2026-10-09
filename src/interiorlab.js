import * as THREE from 'three';
import { createBuildingPlan, BUILDING_PROGRAMS } from './buildingplan.mjs';
import { buildBuilding } from './settlementstream.js';
import { InteriorStream } from './interiorstream.js';
import { interiorWorld, interiorLocal, interiorWalkableClaims, interiorBaseY } from './interiorarchitecture.mjs';
import { planInterior, routeInterior } from './interiorplan.mjs';
import { StructureCollisionIndex } from './structurecollision.mjs';
import { WalkableSurface } from './walkablesurface.mjs';

const params = new URLSearchParams(location.search);
document.body.classList.toggle('clean', params.has('clean'));
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xbacdd3);
const camera = new THREE.PerspectiveCamera(65, innerWidth/innerHeight, 0.05, 300);
const ambient = new THREE.HemisphereLight(0xfff3d5, 0x756b59, 1.5); scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffe0b2, 2.6); sun.position.set(-16, 30, 25); sun.castShadow=true;
sun.shadow.mapSize.set(1024,1024); Object.assign(sun.shadow.camera,{left:-25,right:25,top:25,bottom:-25,near:1,far:100}); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300,300),new THREE.MeshStandardMaterial({color:0x7c8a60})); ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);
for (let i=0;i<12;i++) {
 const tree=new THREE.Group(), trunk=new THREE.Mesh(new THREE.CylinderGeometry(.2,.3,3,6),new THREE.MeshStandardMaterial({color:0x786044})); trunk.position.y=1.5; tree.add(trunk);
 const crown=new THREE.Mesh(new THREE.ConeGeometry(2,5,7),new THREE.MeshStandardMaterial({color:0x526d4e})); crown.position.y=4.5;tree.add(crown);
 const angle=i*Math.PI/6;tree.position.set(Math.sin(angle)*22,0,Math.cos(angle)*22);scene.add(tree);
}
const programInput=document.querySelector('#program'),seedInput=document.querySelector('#seed');
for(const p of BUILDING_PROGRAMS) programInput.add(new Option(p,p)); programInput.value=params.get('program')||'dwelling'; seedInput.value=params.get('seed')||6;
let building, shell, stream, release, collision, surface, feet={x:0,y:.16,z:0}, heading=0, pitch=0, night=false, enabled=true, decorations=true, elapsed=0, frames=[], assembly=[], uploads=[];
const keys=new Set();addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)return;keys.add(e.key.toLowerCase());if(e.key.startsWith('Arrow'))e.preventDefault();});addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
function disposeShell(){if(!shell)return;const materials=new Set();shell.traverse(o=>{o.geometry?.dispose();if(o.material)materials.add(o.material);});for(const m of materials)m.dispose();scene.remove(shell);}
function build(){release?.();stream?.dispose();disposeShell();
 const program=programInput.value,seed=+seedInput.value||1;
 building=createBuildingPlan({id:`lab:${program}:${seed}`,program,seed,form:program==='dwelling'?{floorCount:2}:null});
 shell=new THREE.Group();scene.add(shell);const doors=new Map();buildBuilding(shell,building,doors);for(const pivot of doors.values())pivot.rotation.y=-Math.PI*.5;
 stream=new InteriorStream({worker:params.get('worker')!=='off'});release=stream.register({id:'lab',buildings:[building]},scene);
 collision=new StructureCollisionIndex(()=>({features:{interiorsEnabled:enabled},portals:Object.fromEntries(building.portals.map(p=>[p.id,{progress:1}]))}));collision.registerPlan({id:'lab',buildings:[building],props:[]});
 surface=new WalkableSurface({seed:1,height:()=>0});surface.registerClaim({id:'ground',y:interiorBaseY(building)+.16,contains(x,z){const p=interiorLocal(building,{x,z});return Math.abs(p.x)<=building.width/2+.5&&Math.abs(p.z)<=building.depth/2+.5;}});surface.registerClaims(interiorWalkableClaims(building));
 frames=[];assembly=[];uploads=[];enter(0);
}
function enter(floor){const room=building.interior.rooms.filter(r=>r.floor===Math.min(floor,building.interior.levels.length-1)).at(-1);
 const anchor=planInterior(building).anchors.find(a=>a.roomId===room.id&&a.kind==='inside');feet=interiorWorld(building,anchor);heading=Math.PI/2;pitch=0;
}
function outside(){const door=building.portals.find(p=>p.kind==='exterior-door');feet=interiorWorld(building,{x:door.x,z:building.depth/2+3,y:.16});heading=Math.PI;pitch=0;}
function quantile(a,q){if(!a.length)return 0;return [...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*q))];}
let last=performance.now(),previousCount=0;
function frame(now){const dt=Math.min(.05,(now-last)/1000);last=now;elapsed+=dt;const start=performance.now();
 if(keys.has('a'))heading+=dt*1.6;if(keys.has('d'))heading-=dt*1.6;
 const forward=Number(keys.has('arrowup'))-Number(keys.has('arrowdown')),side=Number(keys.has('arrowleft'))-Number(keys.has('arrowright'));
 const previous={...feet};feet.x+=(Math.sin(heading)*forward+Math.cos(heading)*side)*dt*2;feet.z+=(Math.cos(heading)*forward-Math.sin(heading)*side)*dt*2;
 collision.resolveMovement(feet,previous,.34);feet.y=surface.structureAt(feet.x,feet.z,feet.y)?.y??0;
 camera.position.set(feet.x,feet.y+1.6,feet.z);camera.lookAt(feet.x+Math.sin(heading),feet.y+1.6+pitch,feet.z+Math.cos(heading));
 stream.update(dt,feet,{day:night?.03:1,time:elapsed,enabled,decorations,budgetMs:1});
 ambient.intensity=night?.15:1.5;sun.intensity=night?.03:2.6;scene.background.set(night?0x18232c:0xbacdd3);
 renderer.render(scene,camera);frames.push(performance.now()-start);assembly.push(stream.metrics.assemblyMs);
 if(stream.rooms.size>previousCount)uploads.push(stream.metrics.assemblyMs);previousCount=stream.rooms.size;if(frames.length>600){frames.shift();assembly.shift();}
 document.querySelector('#stats').textContent=`${building.program} · ${building.interior.levels.map(l=>l.kind).join(' / ')}\nRooms ${stream.metrics.activeRooms} active / ${stream.metrics.warmRooms} retained · queue ${stream.metrics.pending}\nInterior ${(stream.metrics.bytes/1024).toFixed(0)} KiB · ${stream.metrics.triangles} triangles\nDraws ${renderer.info.render.calls} · scene triangles ${renderer.info.render.triangles}\nCPU frame p95 ${quantile(frames,.95).toFixed(2)} ms · assembly p95 ${quantile(assembly,.95).toFixed(2)} ms\nFloor ${feet.y.toFixed(2)} m · worker ${stream.worker?'on':'fallback'} · failures ${stream.metrics.failures}`;
 requestAnimationFrame(frame);
}
document.querySelector('#rebuild').onclick=build;document.querySelector('#outside').onclick=outside;document.querySelector('#inside').onclick=()=>enter(0);document.querySelector('#upstairs').onclick=()=>enter(building.interior.levels.length-1);
document.querySelector('#night').onclick=()=>night=!night;document.querySelector('#enabled').onclick=()=>enabled=!enabled;document.querySelector('#decor').onclick=()=>decorations=!decorations;
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
window.__interiorLab={renderer,scene,camera,get building(){return building;},get stream(){return stream;},get surface(){return surface;},get collision(){return collision;},get feet(){return feet;},enter,outside,build,
 look:(yaw,vertical=0)=>{heading=yaw;pitch=vertical;},place:p=>{feet={...p};},setEnabled:v=>enabled=v,setNight:v=>night=v,setDecorations:v=>decorations=v,
 stats:()=>({metrics:{...stream.metrics},draws:renderer.info.render.calls,triangles:renderer.info.render.triangles,cpuP95:quantile(frames,.95),assemblyP95:quantile(assembly,.95),uploadMax:Math.max(0,...uploads),geometry:renderer.info.memory.geometries,programs:renderer.info.programs.length}),
 resetSamples:()=>{frames=[];assembly=[];uploads=[];},route:(from,to)=>routeInterior(building,from,to)};
build();requestAnimationFrame(frame);
