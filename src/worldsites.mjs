import {
  inLandmarkHalo, landmarksAround, majorLandmarksAround, fortifiedOutpostsAround,
} from './landmarks.js';
import { inSettlementHalo, settlementsAround } from './settlementplacement.mjs';

export function worldSitesAround(world, x, z, seed, radius, out = []) {
  out.length = 0;
  const landmarks = [];
  landmarksAround(world, x, z, seed, radius, landmarks);
  majorLandmarksAround(world, x, z, seed, radius, landmarks, true);
  const outposts = [];
  fortifiedOutpostsAround(world, x, z, seed, radius, outposts);
  landmarks.push(...outposts);
  const settlements = settlementsAround(world, x, z, seed, radius, []);
  for (const site of landmarks) out.push({ ...site, siteKind: 'landmark' });
  for (const site of settlements) out.push({ ...site, siteKind: 'settlement' });
  return out;
}

export function inWorldSiteHalo(sites, x, z) {
  const landmarks = sites.filter((site) => site.siteKind === 'landmark');
  const settlements = sites.filter((site) => site.siteKind === 'settlement');
  return inLandmarkHalo(landmarks, x, z) || inSettlementHalo(settlements, x, z);
}
