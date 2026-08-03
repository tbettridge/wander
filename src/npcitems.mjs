export const ITEM_KINDS = Object.freeze([
  'letter', 'parcel', 'tools', 'basket', 'lantern', 'walking-stick',
  'damaged-equipment', 'map', 'boot-kit',
]);

export const ITEM_PRESENTATION = Object.freeze({
  letter: { slot: 'hand', prop: 'letter', silhouette: 'thin-envelope' },
  parcel: { slot: 'both-hands', prop: 'parcel', silhouette: 'wide-box' },
  tools: { slot: 'hip', prop: 'tools', silhouette: 'small-toolbox' },
  basket: { slot: 'hand', prop: 'basket', silhouette: 'open-handled-basket' },
  lantern: { slot: 'hand', prop: 'lantern', silhouette: 'round-hanging-lantern' },
  'walking-stick': { slot: 'hand', prop: 'staff', silhouette: 'tall-grounded-stick' },
  'damaged-equipment': { slot: 'both-hands', prop: 'damaged-equipment', silhouette: 'irregular-broken-box' },
  map: { slot: 'both-hands', prop: 'map', silhouette: 'wide-flat-sheet' },
  'boot-kit': { slot: 'hip', prop: 'tools', silhouette: 'compact-boot-kit' },
});
export const INTENT_PROP_RENDER_BUDGET = Object.freeze({ maxHandSlots: 2, maxBodySlots: 2, dynamicLights: 0, xrResidentCapReduction: 0 });

export function createItem(state, input) {
  if (!input?.id || !ITEM_KINDS.includes(input.kind)) throw new TypeError('Item needs a stable id and supported kind.');
  const existing = state.projections.items[input.id];
  if (existing) return existing;
  const item = {
    id: String(input.id), kind: input.kind, ownerId: input.ownerId || null,
    condition: input.condition || 'usable', purpose: input.purpose || 'ambient',
    relatedCommitmentId: input.relatedCommitmentId || null,
  };
  state.projections.items[item.id] = item;
  state.revision++;
  return item;
}

export function transferItem(state, itemId, toOwnerId, { eventId = null, condition = null } = {}) {
  const item = state.projections.items[itemId];
  if (!item) return { transferred: false, reason: 'missing-item' };
  if (eventId && item.lastTransferEventId === eventId) return { transferred: false, duplicate: true, item };
  item.ownerId = toOwnerId || null;
  if (condition) item.condition = condition;
  if (eventId) item.lastTransferEventId = eventId;
  state.revision++;
  return { transferred: true, item };
}

export function itemsForOwner(state, ownerId) {
  return Object.values(state?.projections?.items || {}).filter((item) => item.ownerId === ownerId);
}

export function deriveNpcLoadout(state, actorId) {
  const items = itemsForOwner(state, actorId).sort((a, b) => purposeRank(b) - purposeRank(a) || a.id.localeCompare(b.id));
  const loadout = { leftHand: null, rightHand: null, hip: null, back: null, overflow: [], occupiedHands: 0 };
  for (const item of items) {
    const display = ITEM_PRESENTATION[item.kind] || { slot: 'back', prop: item.kind };
    const view = { itemId: item.id, kind: item.kind, prop: display.prop, condition: item.condition, purpose: item.purpose };
    if (display.slot === 'both-hands' && !loadout.leftHand && !loadout.rightHand) {
      loadout.leftHand = view; loadout.rightHand = view; loadout.occupiedHands = 2;
    } else if (display.slot === 'hand' && (!loadout.rightHand || !loadout.leftHand)) {
      const key = !loadout.rightHand ? 'rightHand' : 'leftHand'; loadout[key] = view; loadout.occupiedHands++;
    } else if (display.slot === 'hip' && !loadout.hip) loadout.hip = view;
    else if (!loadout.back) loadout.back = view;
    else loadout.overflow.push(view);
  }
  return loadout;
}

export function auditIntentPropCatalog() {
  const core = ['letter', 'parcel', 'tools', 'basket', 'lantern', 'walking-stick', 'damaged-equipment'];
  const silhouettes = core.map((kind) => ITEM_PRESENTATION[kind]?.silhouette).filter(Boolean);
  return {
    ok: silhouettes.length === core.length && new Set(silhouettes).size === core.length,
    supported: core.filter((kind) => ITEM_PRESENTATION[kind]),
    distinctSilhouettes: new Set(silhouettes).size,
    budget: { ...INTENT_PROP_RENDER_BUDGET },
  };
}

export function freeGestureHand(loadout) {
  if (!loadout?.rightHand) return 'right';
  if (!loadout?.leftHand) return 'left';
  return null;
}

function purposeRank(item) {
  return ({ safety: 5, handoff: 4, commitment: 3, action: 2, ambient: 1 })[item.purpose] || 0;
}
