// Blocking, dependency-free boot selector. Import maps are immutable once the
// module graph starts, so the debug A/B control persists a choice and reloads.
(function configureThreeRuntime() {
  const definitions = {
    baseline: { id: 'baseline', label: 'r165 fallback', revision: '165', version: '0.165.0' },
    candidate: { id: 'candidate', label: 'r185 default · XR recommended', revision: '185', version: '0.185.0' },
  };
  const normalize = (value) => {
    const key = String(value || '').trim().toLowerCase();
    return ['baseline', 'fallback', 'r165', '165'].includes(key) ? 'baseline' : 'candidate';
  };
  let stored = 'candidate';
  try { stored = localStorage.getItem('wander.xrExperiments.threeRuntime.v2') || stored; } catch (error) { /* optional */ }
  const requested = new URLSearchParams(location.search).get('three');
  const selected = definitions[normalize(requested == null ? stored : requested)];
  // The managed Chrome profile used by contributors blocks jsDelivr while
  // allowing the project's existing unpkg-hosted runtime assets. Keep Three
  // pinned exactly as before, but source it from the permitted HTTPS host so a
  // blocked CDN cannot prevent main.js from executing at all.
  const packageRoot = `https://unpkg.com/three@${selected.version}`;
  const metadata = Object.freeze({ ...selected, packageRoot });
  window.__WANDER_THREE_RUNTIME__ = metadata;

  // A changed entry alone cannot refresh cached parents' relative imports.
  // Normalize the lighting release's old and unversioned module URLs to one
  // fresh URL per file, preserving shared NPC classes and night uniforms.
  // Bump this build whenever a mapped module changes in a later release.
  const appBuild = 'village-lighting-1';
  window.__WANDER_APP_BUILD__ = appBuild;
  const changedModules = {
    'settlementstream.js': ['sharedworld18'],
    'villagedistrictvisuals.js': [],
    'villagelighting.js': [],
    'villagelighting.mjs': [],
    'npcavatar.js': ['6', '7'],
    'npcbodybake.js': [],
    'animals.js': ['5', '6'],
    'carriedlantern.js': ['7'],
  };
  const appImports = {};
  for (const [file, oldVersions] of Object.entries(changedModules)) {
    const url = new URL(`./src/${file}`, document.baseURI).href;
    const fresh = `${url}?v=${appBuild}`;
    appImports[url] = fresh;
    for (const version of oldVersions) appImports[`${url}?v=${version}`] = fresh;
  }

  const importMap = document.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify({
    imports: {
      ...appImports,
      three: `${packageRoot}/build/three.module.js`,
      'three/addons/': `${packageRoot}/examples/jsm/`,
    },
  });
  document.currentScript.after(importMap);
}());
