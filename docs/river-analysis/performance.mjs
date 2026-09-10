// CPU-only terrain + river mesh benchmark. Optionally pass a checkout of the
// baseline commit; no Three.js, network or GPU is involved.
// node docs/river-analysis/performance.mjs [baseline-checkout]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World } from '../../src/world.js';
import * as current from '../../src/chunkgen.js';

function measure(WorldType, mesh) {
  const world = new WorldType(20260612), cold = [], warm = [];
  for (let pass = 0; pass < 5; pass++) {
    for (let z = -8; z <= -6; z++) for (let x = -5; x <= -3; x++) {
      const start = performance.now();
      const terrain = mesh.buildTerrainArrays(world, x, z, 96, 140);
      mesh.buildRiver(x, z, 96, 140, terrain.river);
      (pass ? warm : cold).push(performance.now() - start);
    }
  }
  const summarize = (times) => {
    times.sort((a, b) => a - b);
    return { samples: times.length, medianMs: times[Math.floor(times.length * 0.5)],
      p95Ms: times[Math.floor(times.length * 0.95)] };
  };
  return { firstPass: summarize(cold), warm: summarize(warm) };
}

const result = { method: 'Node CPU only; seed 20260612; nine chunks; resolution 96; five passes. First pass includes JIT and cache warmup.' };
if (process.argv[2]) {
  const root = resolve(process.argv[2]);
  const { World: OldWorld } = await import(pathToFileURL(resolve(root, 'src/world.js')).href);
  const old = await import(pathToFileURL(resolve(root, 'src/chunkgen.js')).href);
  result.baseline = measure(OldWorld, old);
}
result.current = measure(World, current);
console.log(JSON.stringify(result, null, 2));
