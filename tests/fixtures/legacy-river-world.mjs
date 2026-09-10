// Preserve the terrain that exposed the cave collar/collision regressions.
// These fixtures intentionally exercise the pre-bank-revision placements;
// tests/cavegen.mjs and tests/rivers.mjs exercise current world generation.
import { World as CurrentWorld } from '../../src/world.js';
import { smoothstep, lerp } from '../../src/noise.js';

export class World extends CurrentWorld {
  height(x, z, riverOut) {
    const natural = {};
    const h = this._naturalHeight(x, z, natural);
    const { base, wx, wz } = natural;
    const rv = Math.abs(this.river.fbm(wx * 0.0005 + 41, wz * 0.0005, 3));
    const ch = (1 - smoothstep(0, 0.05, rv))
      * (1 - smoothstep(50, 85, base))
      * (1 - smoothstep(14, 34, h - base));
    const head = base - 0.8;
    const carve = ch > 0.001 ? Math.max(h - (head - 1.4), 0) * Math.pow(ch, 1.6) : 0;
    const floor = h - carve;
    if (riverOut) Object.assign(riverOut, {
      base: h, ch, floor, head,
      waterY: lerp(floor - 1.2, head, smoothstep(0, 0.18, ch)),
    });
    return floor;
  }

  riverAt(x, z) {
    const o = {};
    this.height(x, z, o);
    const depth = o.waterY - o.floor;
    const wet = depth > 0.03 && o.waterY > 0.25 && o.ch > 0.001;
    return { wet, y: o.waterY, ySmooth: o.head, depth: wet ? depth : 0, floor: o.floor };
  }
}
