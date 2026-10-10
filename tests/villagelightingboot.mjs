import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const boot = readFileSync(new URL('../src/threeruntime.js', import.meta.url), 'utf8');
function configure(baseURI, search = '') {
  let imports;
  const window = {};
  runInNewContext(boot, {
    window, URL, URLSearchParams, location: { search }, localStorage: { getItem: () => null },
    document: { baseURI, createElement: () => ({}), currentScript: { after: element => { imports = JSON.parse(element.textContent).imports; } } },
  });
  return { imports, window };
}
test('cached NPC parent imports resolve to one fresh material/geometry module on Pages and local hosts', () => {
  for (const base of ['https://tbettridge.github.io/wander/', 'http://localhost:8474/index.html']) {
    const { imports, window } = configure(base);
    assert.equal(window.__WANDER_APP_BUILD__, 'lighthouse-residents-1');
    const a = new URL('./src/npcavatar.js?v=6', base).href, b = new URL('./src/npcavatar.js?v=7', base).href;
    assert.equal(imports[a], imports[b]);
    assert.equal(imports[a], new URL('./src/npcavatar.js?v=lighthouse-residents-1', base).href);
    for (const file of ['railwaystream.js', 'railstation.js', 'railstation.mjs', 'npcjourneylantern.js', 'npcjourneylantern.mjs']) {
      const url = new URL('./src/' + file, base).href;
      assert.equal(imports[url], url + '?v=lighthouse-residents-1');
    }
    const mobility = new URL('./src/npcmobilitypresentation.js?v=2', base).href;
    assert.equal(imports[mobility], new URL('./src/npcmobilitypresentation.js?v=lighthouse-residents-1', base).href);
    const helper = new URL('./src/villagelighting.mjs', base).href;
    assert.equal(imports[helper], helper + '?v=lighthouse-residents-1');
    const settlement = new URL('./src/settlementstream.js?v=sharedworld18', base).href;
    assert.equal(imports[settlement], new URL('./src/settlementstream.js?v=lighthouse-residents-1', base).href);
  }
});
test('application cache refresh preserves both pinned Three runtimes and addon routing', () => {
  for (const [choice, version] of [['candidate', '0.185.0'], ['baseline', '0.165.0']]) {
    const { imports } = configure('https://tbettridge.github.io/wander/', '?three=' + choice);
    assert.equal(imports.three, `https://unpkg.com/three@${version}/build/three.module.js`);
    assert.equal(imports['three/addons/'], `https://unpkg.com/three@${version}/examples/jsm/`);
  }
});
test('cached settlement dependencies and household aliases upgrade to one rural generation', () => {
  for (const base of ['https://tbettridge.github.io/wander/', 'http://localhost:8474/index.html']) {
    const { imports } = configure(base);
    for (const file of ['buildingmassing.mjs', 'buildingopenings.mjs', 'buildingplan.mjs', 'familyfrontage.mjs',
      'interiorcatalog.mjs', 'interiorplan.mjs', 'npchousehold.mjs', 'npcroutine.mjs',
      'settlementfrontagecatalog.mjs', 'settlementlayout.mjs', 'settlementnames.mjs', 'settlementplan.mjs',
      'settlementprops.mjs', 'settlementsignage.mjs', 'settlementspatial.mjs', 'villagedistrict.mjs']) {
      const url = new URL('./src/' + file, base).href;
      assert.equal(imports[url], url + '?v=lighthouse-residents-1');
    }
    const households = new URL('./src/npchousehold.mjs', base).href;
    assert.equal(imports[households + '?v=2'], imports[households]);
  }
});

test('cached lighthouse and collision aliases resolve to one release generation', () => {
  for (const base of ['https://tbettridge.github.io/wander/', 'http://localhost:8474/index.html']) {
    const { imports, window } = configure(base);
    for (const [file, version] of [['landmarkmesh.js', '6'], ['structurecollision.mjs', '2'], ['npcresidentidentity.mjs', '2']]) {
      const url = new URL('./src/' + file, base).href;
      assert.equal(imports[url + '?v=' + version], imports[url]);
      assert.equal(imports[url], url + '?v=' + window.__WANDER_APP_BUILD__);
    }
  }
});
