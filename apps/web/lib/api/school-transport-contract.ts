/**
 * School API types for transport (phase-5-extended.md slice 41, contracts/slice-41.md), taken
 * from the generated OpenAPI document (`school.d.ts`). Screens import the client and the DTO and
 * body types from here, so a regenerated document is checked against them by the typecheck.
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as transportApi } from './client';

export type VehicleDto = Schemas['VehicleDto'];
export type VehicleFilter = Schemas['VehicleFilter'];
export type TransportRouteDto = Schemas['TransportRouteDto'];
export type TransportRouteDetailDto = Schemas['TransportRouteDetailDto'];
export type TransportRouteFilter = Schemas['TransportRouteFilter'];
export type TransportStopDto = Schemas['TransportStopDto'];
export type TransportRouteAmountDto = Schemas['TransportRouteAmountDto'];
export type TransportAssignmentDto = Schemas['TransportAssignmentDto'];
export type TransportAssignmentCreatedDto = Schemas['TransportAssignmentCreatedDto'];
export type TransportAssignmentStatus = Schemas['TransportAssignmentStatus'];
export type StudentTransportDto = Schemas['StudentTransportDto'];
export type CreateVehicleBody = Schemas['CreateVehicleDto'];
export type UpdateVehicleBody = Schemas['UpdateVehicleDto'];
export type CreateTransportRouteBody = Schemas['CreateTransportRouteDto'];
export type UpdateTransportRouteBody = Schemas['UpdateTransportRouteDto'];
export type StopInput = Schemas['StopInputDto'];
