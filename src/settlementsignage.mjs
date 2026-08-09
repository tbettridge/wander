// Deterministic, renderer-free business signage design and placement.

import { buildingWorldPoint } from './buildingplan.mjs';
import { frontageAssetMetadata } from './settlementfrontagecatalog.mjs';

export const SETTLEMENT_SIGNAGE_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function signageHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export const SIGN_PALETTES = deepFreeze({
  'gold-on-black': { board: '#171817', edge: '#8d7340', ink: '#d4b56a', accent: '#aa8b4d' },
  'red-on-taupe': { board: '#a99b84', edge: '#5d4438', ink: '#782e2a', accent: '#875b46' },
  'cream-on-oxblood': { board: '#542628', edge: '#2f1d1c', ink: '#eadab7', accent: '#c6a56c' },
  'charcoal-on-parchment': { board: '#d1c3a3', edge: '#71634f', ink: '#302f2a', accent: '#765d3d' },
  'ivory-on-forest': { board: '#273d34', edge: '#17261f', ink: '#e5dbc0', accent: '#aa9160' },
  'umber-on-stone': { board: '#aaa18f', edge: '#5f594e', ink: '#4d3025', accent: '#7f6447' },
});

export const SIGN_TYPOGRAPHY = deepFreeze({
  'roman-small-caps': { family: 'Georgia, "Times New Roman", serif', weight: '700', tracking: 0.075, transform: 'upper' },
  'garamond-book': { family: 'Garamond, "EB Garamond", Georgia, serif', weight: '600', tracking: 0.025, transform: 'title' },
  'baskerville-title': { family: 'Baskerville, "Libre Baskerville", Georgia, serif', weight: '600', tracking: 0.04, transform: 'title' },
  'palatino-inscription': { family: 'Palatino, "Palatino Linotype", Georgia, serif', weight: '700', tracking: 0.055, transform: 'upper' },
});

export const SIGN_GRAPHIC_LAYOUTS = Object.freeze([
  'centred-rule', 'divided-two-line', 'arched-name', 'left-flourish', 'double-frame',
]);
export const SIGN_MOUNTS = Object.freeze(['above-door', 'wall-side', 'projecting', 'post']);

const PROGRAM_LABELS = Object.freeze({
  barn: 'Barn', workshop: 'Workshop', inn: 'Inn', smithy: 'Smithy', granary: 'Granary',
});

function pick(values, key, channel) {
  return values[signageHash(`${key}:business-sign:${channel}`) % values.length];
}

function windowOpenings(building) {
  const count = building.program === 'barn' ? 1
    : Math.max(2, Math.floor(building.width / building.style.windowRhythm));
  const result = [];
  for (let floor = 0; floor < building.floorCount; floor++) for (let index = 0; index < count; index++) {
    const x = -building.width / 2 + (index + 0.5) * (building.width / count);
    if (Math.abs(x) > 0.95 || floor > 0) {
      result.push({ x, bottom: floor * building.floorHeight + 0.86, width: 1.28, height: 1.38 });
    }
  }
  return result;
}

function rectanglesOverlap(a, b, gap = 0) {
  return a.left < b.right + gap && a.right > b.left - gap
    && a.bottom < b.top + gap && a.top > b.bottom - gap;
}

function wallClear(building, x, y, width, height, { bracketOnly = false } = {}) {
  const rect = {
    left: x - (bracketOnly ? 0.1 : width / 2), right: x + (bracketOnly ? 0.1 : width / 2),
    bottom: y - height / 2, top: y + height / 2,
  };
  if (rect.left < -building.width / 2 + 0.2 || rect.right > building.width / 2 - 0.2
    || rect.bottom < 0.3 || rect.top > building.floorCount * building.floorHeight - 0.2) return false;
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  const openings = [
    { left: door.x - door.width / 2, right: door.x + door.width / 2, bottom: 0, top: door.height },
    ...windowOpenings(building).map((opening) => ({
      left: opening.x - opening.width / 2, right: opening.x + opening.width / 2,
      bottom: opening.bottom, top: opening.bottom + opening.height,
    })),
  ];
  return !openings.some((opening) => rectanglesOverlap(rect, opening, 0.16));
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function worldToBuilding(building, point) {
  const dx = point.x - building.x, dz = point.z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function postClear(plan, building, localX, localZ) {
  const point = buildingWorldPoint(building, localX, localZ);
  for (const path of plan.paths || []) for (let index = 1; index < path.points.length; index++) {
    if (distanceToSegment(point, path.points[index - 1], path.points[index]) < (path.width || 1.65) / 2 + 0.48) return false;
  }
  for (const other of plan.buildings || []) {
    if (other.id === building.id) continue;
    const local = worldToBuilding(other, point);
    const footprint = other.footprint || {
      minX: -other.width / 2, maxX: other.width / 2,
      minZ: -other.depth / 2, maxZ: other.depth / 2,
    };
    if (local.x > footprint.minX - 0.5 && local.x < footprint.maxX + 0.5
      && local.z > footprint.minZ - 0.5 && local.z < footprint.maxZ + 0.5) return false;
  }
  const frontage = (plan.familyFrontages || []).find((entry) => entry.buildingId === building.id);
  for (const entry of [...(frontage?.attachments || []), ...(frontage?.yardElements || [])]) {
    const metadata = frontageAssetMetadata(entry.assetId);
    if (!metadata || !entry.placement) continue;
    const radius = Math.hypot(metadata.halfExtents.x, metadata.halfExtents.z) + 0.36;
    if (Math.hypot(point.x - entry.placement.x, point.z - entry.placement.z) < radius) return false;
  }
  for (const placement of plan.managedVegetation?.placements || []) {
    const half = placement.footprint?.halfExtents;
    if (half && Math.hypot(point.x - placement.x, point.z - placement.z) < Math.hypot(half.x, half.z) + 0.35) return false;
  }
  return true;
}

function mountDimensions(mount, layout) {
  if (mount === 'above-door') return { width: layout === 'arched-name' ? 1.72 : 2.05, height: 0.58, depth: 0.09 };
  if (mount === 'projecting') return { width: layout === 'double-frame' ? 1.12 : 0.98, height: 0.82, depth: 0.09 };
  if (mount === 'post') return { width: layout === 'arched-name' ? 1.55 : 1.78, height: 0.74, depth: 0.1 };
  return { width: layout === 'divided-two-line' ? 1.72 : 1.92, height: 0.72, depth: 0.09 };
}

function tryMount(plan, building, mount, layout) {
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  const dimensions = mountDimensions(mount, layout);
  const h = building.floorCount * building.floorHeight;
  if (mount === 'above-door' && !building.style.porch) {
    const y = door.height + 0.18 + dimensions.height / 2;
    if (wallClear(building, door.x, y, dimensions.width, dimensions.height)) {
      return { mount, localX: door.x, localY: y, localZ: building.depth / 2 + 0.29, yaw: 0, dimensions };
    }
  }
  if (mount === 'wall-side') {
    const y = Math.min(h - dimensions.height / 2 - 0.28, Math.max(1.8, door.height * 0.78));
    for (const side of [1, -1]) {
      const x = side * (building.width / 2 - dimensions.width / 2 - 0.3);
      if (wallClear(building, x, y, dimensions.width, dimensions.height)) {
        return { mount, localX: x, localY: y, localZ: building.depth / 2 + 0.29, yaw: 0, dimensions };
      }
    }
  }
  if (mount === 'projecting' && !building.style.porch) {
    const y = Math.min(h - dimensions.height / 2 - 0.3, Math.max(2.15, door.height + 0.08));
    for (const side of [1, -1]) {
      const x = side * (building.width / 2 - 0.42);
      if (wallClear(building, x, y, dimensions.width, dimensions.height, { bracketOnly: true })) {
        return {
          mount, localX: x, localY: y,
          localZ: building.depth / 2 + 0.38 + dimensions.width / 2,
          yaw: Math.PI / 2, dimensions,
        };
      }
    }
  }
  if (mount === 'post') {
    const z = building.depth / 2 + 1.42;
    for (const side of [1, -1]) {
      const x = door.x + side * (door.width / 2 + dimensions.width / 2 + 0.72);
      if (Math.abs(x) + dimensions.width / 2 > building.width / 2 + 1.15) continue;
      if (postClear(plan, building, x, z)) {
        return { mount, localX: x, localY: 0, localZ: z, yaw: 0, dimensions, boardCenterY: 1.55 };
      }
    }
  }
  return null;
}

export function planSettlementBusinessSigns(plan) {
  const signs = [];
  for (const building of plan.buildings || []) {
    if (!building.ownerSurname || building.program === 'dwelling') continue;
    const key = building.ownerHouseholdId || building.id;
    const layoutId = pick(SIGN_GRAPHIC_LAYOUTS, key, 'graphic-layout');
    const paletteId = pick(Object.keys(SIGN_PALETTES), key, 'palette');
    const typographyId = pick(Object.keys(SIGN_TYPOGRAPHY), key, 'typography');
    const preferred = pick(SIGN_MOUNTS, building.id, 'mount');
    const mounts = [preferred, ...SIGN_MOUNTS.filter((entry) => entry !== preferred)];
    let placement = null;
    for (const mount of mounts) {
      placement = tryMount(plan, building, mount, layoutId);
      if (placement) break;
    }
    if (!placement) continue;
    signs.push({
      id: `${building.id}:business-sign:v${SETTLEMENT_SIGNAGE_VERSION}`,
      version: SETTLEMENT_SIGNAGE_VERSION, buildingId: building.id,
      householdId: building.ownerHouseholdId, surname: building.ownerSurname,
      displayName: building.displayName, programLabel: PROGRAM_LABELS[building.program] || building.program,
      paletteId, typographyId, layoutId, paddingRatio: placement.mount === 'projecting' ? 0.18 : 0.15,
      placement,
    });
  }
  return deepFreeze(signs);
}

export function validateSettlementBusinessSigns(plan, signs = plan.businessSigns || []) {
  const errors = [];
  for (const sign of signs) {
    const building = plan.buildings?.find((entry) => entry.id === sign.buildingId);
    if (!building || !sign.surname || !SIGN_PALETTES[sign.paletteId]
      || !SIGN_TYPOGRAPHY[sign.typographyId] || !SIGN_GRAPHIC_LAYOUTS.includes(sign.layoutId)) {
      errors.push(`identity:${sign.id || 'unknown'}`); continue;
    }
    if (!SIGN_MOUNTS.includes(sign.placement?.mount)
      || ![sign.placement.localX, sign.placement.localY, sign.placement.localZ,
        sign.placement.yaw, sign.placement.dimensions?.width, sign.placement.dimensions?.height]
        .every(Number.isFinite)) errors.push(`placement:${sign.id}`);
    if (sign.placement.dimensions.width > 2.1 || sign.placement.dimensions.height > 0.82) errors.push(`scale:${sign.id}`);
    if (!(sign.paddingRatio >= 0.14 && sign.paddingRatio <= 0.2)) errors.push(`padding:${sign.id}`);
  }
  return deepFreeze({ valid: errors.length === 0, errors });
}
