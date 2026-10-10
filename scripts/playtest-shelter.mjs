// Real WebGL rain masking and live animal movement regression.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),artifacts=await mkdtemp(join(tmpdir(),'wander-shelter-'));
const server=createServer(async(req,res)=>{
  try{
    let path=new URL(req.url,'http://localhost').pathname;if(path==='/')path='/index.html';if(path.includes('..'))throw new Error('Invalid path');
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    res.setHeader('content-type',path.endsWith('.html')?'text/html':/\.m?js$/.test(path)?'text/javascript':'application/octet-stream');
    res.end(await readFile(root+path));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],report={renderers:[]};
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'&&/THREE|shader|rain/i.test(message.text()))errors.push(message.text());});
try{
  for(const renderer of ['upgraded','baseline']){
    await page.goto(url+`/interior-lab.html?three=${renderer}`);
    await page.waitForFunction(()=>window.__interiorLab?.stream.rooms.size>0);
    const result=await page.evaluate(async()=>{
      const THREE=await import('three'),{RainSystem}=await import('/src/rain.js'),
        {buildingRainCovers,roofCoverFromMatrix}=await import('/src/structureshelter.mjs'),
        {createBuildingPlan}=await import('/src/buildingplan.mjs'),
        {RegionalRailwayService}=await import('/src/railservice.js'),
        {InterregionalTrain}=await import('/src/interregionaltrain.js');
      const renderer=__interiorLab.renderer,scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,100);
      const target=new THREE.WebGLRenderTarget(256,256),pixels=new Uint8Array(256*256*4),rain=new RainSystem(scene);
      rain.uniforms.uWindStrength.value=0;rain.uniforms.uWindSpeed.value=0;rain.uniforms.uWindDir.value.set(1,0);
      const b=createBuildingPlan({id:'rain-browser',program:'dwelling',seed:4});
      let covers=[];rain.setRoofProvider(out=>out.push(...covers));
      function sample(x,y){
        rain.update(0,new THREE.Vector3(),{rain:1},{sunElevation:1});
        rain.uniforms.uTime.value=0;rain.uniforms.uIntensity.value=1;rain.mesh.visible=true;
        const geometry=rain.mesh.geometry;geometry.instanceCount=1;
        geometry.attributes.aOrigin.setXYZ(0,x,0,0);geometry.attributes.aOrigin.needsUpdate=true;
        geometry.attributes.aPhase.setX(0,(38-y)/45);geometry.attributes.aPhase.needsUpdate=true;
        geometry.attributes.aThreshold.setX(0,0);geometry.attributes.aThreshold.needsUpdate=true;
        geometry.attributes.aSize.setX(0,1);geometry.attributes.aSize.needsUpdate=true;
        camera.position.set(x,y,5);camera.lookAt(x,y,0);renderer.setRenderTarget(target);renderer.setClearColor(0,1);renderer.clear();renderer.render(scene,camera);
        renderer.readRenderTargetPixels(target,0,0,256,256,pixels);renderer.setRenderTarget(null);
        let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>3)count++;return count;
      }
      rain.intensity=1;
      const open=sample(0,2);covers=buildingRainCovers(b);const insideHouse=sample(0,2);
      const outdoors=sample(b.width/2+3,2),aboveRoof=sample(0,covers[0].y+covers[0].rise+3);
      const carriage=new THREE.Object3D();carriage.rotation.set(.1,.8,0);carriage.updateMatrixWorld(true);
      covers=RegionalRailwayService.prototype.collectRainCovers.call({group:{visible:true},carriages:[{root:carriage}]},[]);
      const insideTrain=sample(covers[0].x,2),besideTrain=sample(5,2);
      carriage.position.x=20;carriage.updateMatrixWorld(true);
      covers=RegionalRailwayService.prototype.collectRainCovers.call({group:{visible:true},carriages:[{root:carriage}]},[]);
      const oldTrainPosition=sample(0,2),movingTrain=sample(covers[0].x,2);
      const commuter=new InterregionalTrain(new THREE.Scene());commuter.root.visible=true;
      covers=commuter.collectRainCovers();const redTrainCovers=covers.length;
      // Wind-slanted streak tips also disappear before they can cross a roof.
      covers=[roofCoverFromMatrix(new THREE.Matrix4().elements,5,5,3)];
      rain.uniforms.uWindStrength.value=.8;rain.uniforms.uWindSpeed.value=0;
      const tipCrossing=sample(0,3.4);
      target.dispose();rain.mesh.geometry.dispose();rain.mesh.material.dispose();
      return{open,insideHouse,outdoors,aboveRoof,insideTrain,besideTrain,oldTrainPosition,movingTrain,redTrainCovers,tipCrossing};
    });
    for(const key of ['open','outdoors','aboveRoof','besideTrain','oldTrainPosition'])assert.ok(result[key]>20,`${renderer}: ${key} lost outdoor rain`);
    for(const key of ['insideHouse','insideTrain','movingTrain','tipCrossing'])assert.equal(result[key],0,`${renderer}: ${key} leaked through a roof`);
    assert.equal(result.redTrainCovers,2);report.renderers.push({renderer,...result});
    console.log('Rain pixel checks passed:',renderer);
  }
  report.animals=await page.evaluate(async()=>{
    const THREE=await import('three'),{AnimalSystem}=await import('/src/animals.js'),{StructureCollisionIndex}=await import('/src/structurecollision.mjs'),
      {createBuildingPlan}=await import('/src/buildingplan.mjs');
    const world={seed:4,height:()=>3,biomeAt:()=>({id:'grassland',h:3,slope:0,m:.5}),riverAt:()=>({wet:false,depth:0}),groveFactor:()=>0,openFactor:()=>1};
    const system=new AnimalSystem(new THREE.Scene(),world),index=new StructureCollisionIndex();
    const b=createBuildingPlan({id:'animal-browser',program:'dwelling',seed:8,y:3});
    index.registerPlan({id:b.id,buildings:[b],props:[]});system.setStructureCollision(index);
    const results=[];
    try{
      for(const species of ['horse','moose','fox','whitetail']){
        const agent=system.acquireAgent(species);agent.place(0,b.depth/2+5);agent.heading=Math.PI;
        agent.state='roam';agent.stateTimer=999;agent.previewTimer=999;agent.motionPreviewSpeed=5;agent.target.set(0,3,-30);
        const player=new THREE.Vector3(100,3,100),start=performance.now();let crossed=false;
        for(let i=0;i<240;i++){agent.update(1/60,player);crossed ||= index.animalBlocked(agent.mesh.position.x,agent.mesh.position.z,agent.structureRadius);}
        const elapsed=performance.now()-start,stoppedOutside=agent.mesh.position.z>=b.depth/2+agent.structureRadius-.01;
        agent.mesh.position.set(0,3,0);agent.update(1/60,player);const recovered=!index.animalBlocked(agent.mesh.position.x,agent.mesh.position.z,agent.structureRadius);
        agent.place(0,0);const spawnClear=!index.animalBlocked(agent.mesh.position.x,agent.mesh.position.z,agent.structureRadius);
        results.push({species,crossed,stoppedOutside,recovered,spawnClear,cpuMsPerStep:elapsed/240});system.releaseAgent(agent,species);
      }
      return results;
    }finally{system.dispose();}
  });
  for(const result of report.animals){assert.equal(result.crossed,false,result.species);for(const key of ['stoppedOutside','recovered','spawnClear'])assert.equal(result[key],true,`${result.species}: ${key}`);}
  console.log('Live animal movement checks passed: horse, moose, fox, whitetail');
  if(process.argv.includes('--game')){
    await page.goto(url+'/?wanderSeed=20260612');await page.waitForFunction(()=>window.__wander,null,{timeout:120000});
    await page.evaluate(()=>{__wander.quality.setLevel(0);__wander.quality.locked=true;});
    await page.fill('#player-name','Shelter QA');await page.click('#player-name-save');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.toLowerCase().includes('ready'),null,{timeout:120000});
    await page.click('#start-button');await page.evaluate(()=>__wander.toSettlement());
    await page.waitForFunction(()=>__wander.settlements.active.size>0&&!__wander.settlements.loading,null,{timeout:120000});
    await page.evaluate(()=>{if(!__wander.regionalRailwayService.carriages.length)__wander.regionalRailway.generate();});
    await page.waitForFunction(()=>__wander.regionalRailwayService.group.visible&&__wander.regionalRailwayService.carriages.length===2,null,{timeout:120000});
    report.game=await page.evaluate(()=>{
      const w=__wander,b=[...w.settlements.active.values()][0].plan.buildings.find(b=>b.program==='inn');
      w.rain.intensity=1;w.rain.update(.016,{...w.controls.rig.position,x:b.x,y:b.y+.2,z:b.z},{rain:1},w.sky,w.scene.fog);
      const buildingCovers=w.rain.roofCovers.length,animalBoundary=w.animals.structureCollision.animalBlocked(b.x,b.z,2.4);
      const service=w.regionalRailwayService;const carriage=service.carriages[0];carriage.root.updateWorldMatrix(true,false);
      const passenger=carriage.root.localToWorld(new w.controls.rig.position.constructor(0,2.4,0));
      w.rain.update(.016,passenger,{rain:1},w.sky,w.scene.fog);
      return{buildingCovers,animalBoundary,trainCovers:service.collectRainCovers().length,visibleRain:w.rain.mesh.visible,coverCount:w.rain.uniforms.uRainCoverCount.value};
    });
    assert.ok(report.game.buildingCovers>0);assert.equal(report.game.animalBoundary,true);assert.equal(report.game.trainCovers,2);assert.equal(report.game.visibleRain,true);assert.ok(report.game.coverCount>0);
  }
  assert.deepEqual(errors,[]);report.errors=errors;
  await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));
  console.log('PASS: GPU rain clipping preserves exterior rain; live animals avoid buildings; renderer r185/r165'+(report.game?'; live game shelter providers':''));
  console.log('Artifacts:',artifacts);console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
