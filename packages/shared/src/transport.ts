/**
 * Transport value sets (Phase 5 rule 37, phase-5-extended.md §1.1, §3.2), for the API's DTOs and
 * the clients. Each mirrors the Postgres enum of the same name (migration
 * 20261009120100_phase5_groundwork); test/guardrails/shared-enums.e2e-spec.ts compares them.
 */

/** `vehicles.status`: a retired vehicle takes no new route (R329). */
export const VEHICLE_STATUSES = ['active', 'retired'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** `transport_routes.status`: archiving is refused while the route has live assignments (R329). */
export const TRANSPORT_ROUTE_STATUSES = ['active', 'archived'] as const;
export type TransportRouteStatus = (typeof TRANSPORT_ROUTE_STATUSES)[number];

/** Rule 37 / §1.1: a vehicle's seats, 1-120; over-assignment warns, never blocks (R331). */
export const VEHICLE_CAPACITY_MAX = 120;
