/**
 * School API types for staff contracts (phase-5-extended.md slice 39, contracts/slice-39.md),
 * taken from the generated OpenAPI document (`school.d.ts`). Screens import the client and the
 * DTO and body types from here, so a regenerated document is checked against them by the
 * typecheck.
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as staffContractsApi } from './client';

export type ContractType = Schemas['ContractType'];
export type StaffContractStatus = Schemas['StaffContractStatus'];
export type StaffContractDto = Schemas['StaffContractDto'];
export type MyStaffContractDto = Schemas['MyStaffContractDto'];
export type CreateStaffContractBody = Schemas['CreateStaffContractDto'];
export type EndStaffContractBody = Schemas['EndStaffContractDto'];
