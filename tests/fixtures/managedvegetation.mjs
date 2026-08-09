import {
  createManagedVegetationReservation,
  createReservationShape,
} from '../../src/managedvegetation.mjs';

export const managedVegetationSettlementFixture = Object.freeze({
  settlementId: 'settlement:managed-vegetation-fixture',
  worldSeed: 20260612,
  opportunities: Object.freeze([
    Object.freeze({
      id: 'cultivation:household:0:rear',
      buildingId: 'settlement:managed-vegetation-fixture:building:0',
      householdId: 'settlement:managed-vegetation-fixture:household:0',
      familyFrontageId: 'settlement:managed-vegetation-fixture:building:0:family-frontage:v1',
      reservationDependencyIds: Object.freeze(['reserve:house:0', 'reserve:path:0']),
    }),
    Object.freeze({
      id: 'cultivation:household:1:side',
      buildingId: 'settlement:managed-vegetation-fixture:building:1',
      householdId: 'settlement:managed-vegetation-fixture:household:1',
      familyFrontageId: 'settlement:managed-vegetation-fixture:building:1:family-frontage:v1',
      reservationDependencyIds: Object.freeze(['reserve:house:1']),
    }),
  ]),
});

export const managedVegetationReservations = Object.freeze([
  createManagedVegetationReservation({
    id: 'reserve:house:0',
    source: 'building',
    shape: createReservationShape({
      kind: 'oriented-rectangle',
      center: { x: 0, z: 0 },
      halfExtents: { x: 3.5, z: 2.5 },
      yaw: 0.2,
    }),
  }),
  createManagedVegetationReservation({
    id: 'reserve:house:1',
    source: 'building',
    shape: createReservationShape({
      kind: 'axis-aligned-rectangle',
      center: { x: 12, z: 3 },
      halfExtents: { x: 3, z: 2.5 },
    }),
  }),
  createManagedVegetationReservation({
    id: 'reserve:path:0',
    source: 'circulation',
    shape: createReservationShape({
      kind: 'segment',
      from: { x: -14, z: 5 },
      to: { x: 18, z: 5 },
      width: 2,
    }),
  }),
]);

// This is an authoritative fact-shaped handoff from the existing world water
// query. The fixture supplies the fact; managed vegetation does not derive it.
export const authoritativeWaterReservations = Object.freeze([
  createManagedVegetationReservation({
    id: 'water:river:fixture:channel',
    source: 'authoritative-world-water',
    shape: createReservationShape({
      kind: 'circle',
      center: { x: 50, z: 50 },
      radius: 7,
    }),
  }),
]);

export const managedVegetationPlanBaseline = Object.freeze({
  version: 1,
  settlementId: 'settlement:managed-vegetation-fixture',
  worldSeed: 20260612,
  status: 'prepared',
  placement: 'deferred',
  placements: Object.freeze([]),
  reservationDependencyIds: Object.freeze([
    'reserve:house:0',
    'reserve:house:1',
    'reserve:path:0',
    'water:river:fixture:channel',
  ]),
  presentations: Object.freeze([
    Object.freeze({
      id: 'managed-vegetation:cultivation:household:0:rear:v1',
      opportunityId: 'cultivation:household:0:rear',
      buildingId: 'settlement:managed-vegetation-fixture:building:0',
      householdId: 'settlement:managed-vegetation-fixture:household:0',
      familyFrontageId: 'settlement:managed-vegetation-fixture:building:0:family-frontage:v1',
      assetId: 'placeholder:managed-vegetation:cultivated-planting:v1',
      assetVersion: 1,
      channels: Object.freeze({
        'cultivation-habit': 'placeholder:managed-vegetation:cultivation-habit:v1',
        'bed-pattern': 'placeholder:managed-vegetation:bed-pattern:v1',
        'asset-variant': 'placeholder:managed-vegetation:asset-variant:v1',
      }),
      reservationDependencyIds: Object.freeze([
        'reserve:house:0',
        'reserve:house:1',
        'reserve:path:0',
        'water:river:fixture:channel',
      ]),
    }),
    Object.freeze({
      id: 'managed-vegetation:cultivation:household:1:side:v1',
      opportunityId: 'cultivation:household:1:side',
      buildingId: 'settlement:managed-vegetation-fixture:building:1',
      householdId: 'settlement:managed-vegetation-fixture:household:1',
      familyFrontageId: 'settlement:managed-vegetation-fixture:building:1:family-frontage:v1',
      assetId: 'placeholder:managed-vegetation:cultivated-planting:v1',
      assetVersion: 1,
      channels: Object.freeze({
        'cultivation-habit': 'placeholder:managed-vegetation:cultivation-habit:v1',
        'bed-pattern': 'placeholder:managed-vegetation:bed-pattern:v1',
        'asset-variant': 'placeholder:managed-vegetation:asset-variant:v1',
      }),
      reservationDependencyIds: Object.freeze([
        'reserve:house:0',
        'reserve:house:1',
        'reserve:path:0',
        'water:river:fixture:channel',
      ]),
    }),
  ]),
});
