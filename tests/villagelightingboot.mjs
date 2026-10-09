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
    assert.equal(window.__WANDER_APP_BUILD__, 'station-lighting-1');
    const a = new URL('./src/npcavatar.js?v=6', base).href, b = new URL('./src/npcavatar.js?v=7', base).href;
    assert.equal(imports[a], imports[b]);
    assert.equal(imports[a], new URL('./src/npcavatar.js?v=station-lighting-1', base).href);
    for (const file of ['railwaystream.js', 'railstation.js', 'railstation.mjs']) {
      const url = new URL('./src/' + file, base).href;
      assert.equal(imports[url], url + '?v=station-lighting-1');
    }
    const helper = new URL('./src/villagelighting.mjs', base).href;
    assert.equal(imports[helper], helper + '?v=station-lighting-1');
    const settlement = new URL('./src/settlementstream.js?v=sharedworld18', base).href;
    assert.equal(imports[settlement], new URL('./src/settlementstream.js?v=station-lighting-1', base).href);
  }
});
test('application cache refresh preserves both pinned Three runtimes and addon routing', () => {
  for (const [choice, version] of [['candidate', '0.185.0'], ['baseline', '0.165.0']]) {
    const { imports } = configure('https://tbettridge.github.io/wander/', '?three=' + choice);
    assert.equal(imports.three, `https://unpkg.com/three@${version}/build/three.module.js`);
    assert.equal(imports['three/addons/'], `https://unpkg.com/three@${version}/examples/jsm/`);
  }
});
