// Optional real-browser regression. Requires Playwright and Chrome.
// WANDER_PLAYWRIGHT_PATH can point to a bundled Playwright index.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), artifacts = await mkdtemp(join(tmpdir(), 'wander-interiors-'));
const server = createServer(async (req,res) => {
  try { let path = new URL(req.url,'http://localhost').pathname;
    if(path==='/')path='/index.html';if(path.includes('..'))throw new Error('Invalid path');
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    res.setHeader('content-type',path.endsWith('.html')?'text/html':/\.m?js$/.test(path)?'text/javascript':'application/octet-stream');
    res.end(await readFile(root+path));
  }catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({...(process.env.WANDER_CHROME_PATH?{executablePath:process.env.WANDER_CHROME_PATH}:{channel:'chrome'}),headless:true,args:['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],report={programs:[]};
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|interior|shader/i.test(m.text()))errors.push(m.text());});
async function ready(){await page.waitForFunction(()=>window.__interiorLab?.stream.rooms.size===window.__interiorLab?.building.rooms.length,null,{timeout:30000});}
async function sample(){await page.evaluate(()=>__interiorLab.resetSamples());await page.evaluate(()=>new Promise(resolve=>{let n=0;function tick(){if(++n>=180)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);}));return page.evaluate(()=>__interiorLab.stats());}
try {
  await page.goto(url+'/interior-lab.html?clean');await ready();
  const programs=await page.locator('#program option').evaluateAll(options=>options.map(o=>o.value));
  for(const program of programs){
    await page.selectOption('#program',program,{force:true});await page.evaluate(()=>__interiorLab.build());await ready();
    const stats=await page.evaluate(()=>__interiorLab.stats());assert.equal(stats.metrics.failures,0);assert.ok(stats.uploadMax<8,`${program}: single room upload too slow`);
    report.programs.push({program,...stats});
    if(['dwelling','barn','inn','church','infill-house'].includes(program)){
      await page.screenshot({path:join(artifacts,program+'-ground.png')});
      await page.evaluate(()=>__interiorLab.enter(__interiorLab.building.interior.levels.length-1));
      await page.screenshot({path:join(artifacts,program+'-upper.png')});
    }
  }
  await page.selectOption('#program','dwelling',{force:true});await page.evaluate(()=>__interiorLab.build());await ready();
  report.enabled=await sample();await page.evaluate(()=>__interiorLab.setEnabled(false));report.disabled=await sample();
  await page.evaluate(()=>__interiorLab.setEnabled(true));await ready();
  const cache=await page.evaluate(()=>{
    const lab=__interiorLab,stream=lab.stream,original={...lab.feet},loaded=stream.rooms.size;
    const far={x:1000,y:0,z:1000};stream.update(1,far);const retained=stream.rooms.size,hidden=[...stream.rooms.values()].every(r=>!r.group.visible);
    stream.update(16,far);const expired=stream.rooms.size;lab.place(original);return{loaded,retained,hidden,expired};
  });assert.equal(cache.retained,cache.loaded);assert.equal(cache.hidden,true);assert.equal(cache.expired,0);await ready();report.cache=cache;
  report.dense=await page.evaluate(async()=>{
    const{createBuildingPlan}=await import('/src/buildingplan.mjs');
    const buildings=Array.from({length:40},(_,i)=>createBuildingPlan({id:'stress:'+i,program:'row-house',seed:i+10,x:(i%8-4)*5.5,z:(Math.floor(i/8)-2)*8}));
    const lab=__interiorLab,release=lab.stream.register({id:'stress',buildings},lab.scene);
    await new Promise(resolve=>{let n=0;function tick(){if(++n>180)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);});
    const stats=lab.stats();release();return stats;
  });assert.ok(report.dense.metrics.activeRooms<=24);assert.ok(report.dense.metrics.bytes<=24*1024*1024);
  await page.evaluate(()=>__interiorLab.setNight(true));await page.screenshot({path:join(artifacts,'dwelling-night.png')});
  await page.goto(url+'/interior-lab.html?worker=off&clean');await ready();report.fallback=await page.evaluate(()=>__interiorLab.stats());assert.equal(report.fallback.metrics.failures,0);
  await page.goto(url+'/interior-lab.html?three=baseline&clean');await ready();report.r165=await page.evaluate(()=>__interiorLab.stats());
  if(process.argv.includes('--game')){
    await page.goto(url+'/?wanderSeed=20260612',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__wander,null,{timeout:120000});await page.evaluate(()=>{__wander.quality.setLevel(0);__wander.quality.locked=true;});
    await page.fill('#player-name','Interior QA');await page.click('#player-name-save');
    await page.waitForFunction(()=>document.getElementById('status').textContent.toLowerCase().includes('ready'),null,{timeout:120000});await page.click('#start-button');
    await page.evaluate(()=>__wander.toSettlement());await page.waitForFunction(()=>__wander.settlements.active.size>0&&!__wander.settlements.loading,null,{timeout:120000});
    const b=await page.evaluate(()=>[...__wander.settlements.active.values()][0].plan.buildings.find(b=>b.program==='inn'));
    report.game=await page.evaluate(async b=>{
      const w=__wander,{interiorWorld}=await import('/src/interiorarchitecture.mjs'),{planInterior,routeInterior}=await import('/src/interiorplan.mjs');
      const arrival=planInterior(b).anchors.filter(a=>a.kind==='inside'),first=interiorWorld(b,arrival.find(a=>a.floor===0)),last=interiorWorld(b,arrival.at(-1));
      const controls=w.controls;controls.rig.position.set(first.x,first.y,first.z);controls.speed=0;controls.verticalVelocity=0;controls.enabled=true;controls.inputLocked=false;
      const directions=[];
      for(const destination of [last,first]){
        const route=routeInterior(b,controls.rig.position,destination);let index=0,frames=0;
        for(;frames<20000&&index<route.length;frames++){
          const target=route[index],p=controls.rig.position,dx=target.x-p.x,dz=target.z-p.z;
          if(Math.hypot(dx,dz)<.14){index++;continue;}
          controls.yaw=Math.atan2(-dx,-dz);controls.keys.add('KeyW');controls.update(1/60);controls.keys.clear();
        }
        directions.push({points:route.length,reached:index,frames,actual:controls.rig.position.toArray(),expected:destination});
      }
      controls.speed=0;controls.rig.position.set(last.x,last.y,last.z);controls.yaw=b.yaw-Math.PI/2;controls.pitch=0;w.tick(.28);
      return{building:b.id,program:b.program,directions,pointerLock:w.pointerLock.locked};
    },b);
    for(const direction of report.game.directions){assert.equal(direction.reached,direction.points);assert.ok(Math.abs(direction.actual[1]-direction.expected.y)<.2,'Player finished on wrong floor');}
    await page.waitForTimeout(1000);await page.screenshot({path:join(artifacts,'game-upstairs.png')});
    report.game.metrics=await page.evaluate(()=>({...__wander.settlements.interiors.metrics}));
  }
  assert.deepEqual(errors,[]);report.errors=errors;
  await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log('PASS: interiors, cache eviction/reentry, dense-street limits, worker fallback, r185/r165 shaders'+(report.game?', real-game player stair traversal':''));console.log('Artifacts:',artifacts);console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(r=>server.close(r));}
