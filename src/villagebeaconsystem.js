// Rings church bells on the hour and keeps a few chimneys smoking in every
// settlement around the walker. Reads settlement plans directly, which are a
// pure function of the world, so a village two kilometres off has its bell
// and its smoke whether or not its houses have streamed in yet.

import * as THREE from 'three';
import { settlementPlansNear } from './settlementspatial.mjs';
import { BELL_RANGE, SMOKE_RANGE, bellHeard, bellStrikes, churchBells, smokingChimneys } from './villagebeacons.mjs';
import { ChimneySmoke } from './chimneysmoke.js';

const REFRESH_DISTANCE = 150;   // metres walked before nearby plans are looked up again
const BELLS_AT_ONCE = 3;        // the nearest few; more is a din, not a cue

export class VillageBeaconSystem {
  constructor({ scene, world, audio }) {
    Object.assign(this, { scene, world, audio });
    this.smoke = new ChimneySmoke(scene);
    this.plans = []; this.bells = [];
    this.lastQuery = null; this.lastHour = null; this.lastShift = null;
    this.facing = new THREE.Vector3();
    this.rung = [];
  }

  resetRegion(world = this.world) {
    this.world = world; this.plans = []; this.bells = []; this.lastQuery = null; this.lastShift = null;
    this.smoke.setChimneys([]);
  }

  refresh(player) {
    try { this.plans = settlementPlansNear(this.world, player.x, player.z, Math.max(BELL_RANGE, SMOKE_RANGE), []); }
    catch { this.plans = []; }
    this.bells = churchBells(this.plans);
    this.lastQuery = { x: player.x, z: player.z };
    this.lastShift = null;
  }

  /**
   * `hourOfDay` is the sky's clock (0–24). `muted` silences the bells (in a
   * cave, say) without losing count of the hours.
   */
  update(dt, { player, camera, renderer, hourOfDay, light = 1, muted = false }) {
    if (!player || !Number.isFinite(hourOfDay)) return;
    if (!this.lastQuery || Math.hypot(player.x - this.lastQuery.x, player.z - this.lastQuery.z) > REFRESH_DISTANCE) this.refresh(player);
    const shift = Math.floor(hourOfDay / 2);
    if (shift !== this.lastShift) {
      this.lastShift = shift;
      const lit = [];
      for (const plan of this.plans) {
        if (Math.hypot(plan.site.x - player.x, plan.site.z - player.z) > SMOKE_RANGE + plan.site.radius) continue;
        for (const top of smokingChimneys(plan, this.world.seed, hourOfDay)) lit.push({ key: top.buildingId, x: top.x, y: top.y, z: top.z });
      }
      this.smoke.setChimneys(lit);
    }
    this.smoke.update(dt, camera, renderer, light);
    const hour = Math.floor(hourOfDay);
    if (this.lastHour !== null && hour !== this.lastHour && !muted) this.ring(hour, player, camera);
    this.lastHour = hour;
  }

  ring(hour, player, camera) {
    camera?.getWorldDirection?.(this.facing);
    const facing = { x: this.facing.x || 0, z: this.facing.z || 1 };
    const heard = this.bells.map(bell => ({ bell, heard: bellHeard(bell, player, facing) })).filter(item => item.heard)
      .sort((a, b) => a.heard.distance - b.heard.distance).slice(0, BELLS_AT_ONCE);
    this.rung = heard.map(({ bell, heard: h }) => ({ settlementId: bell.settlementId, distance: Math.round(h.distance), pan: +h.pan.toFixed(2), gain: +h.gain.toFixed(2), note: bell.note }));
    for (const { bell, heard: h } of heard) this.audio?.ringBell?.(h, { note: bell.note, seed: bell.seed, strikes: bellStrikes(hour) });
    return this.rung;
  }
}
