/**
 * School API types for fee setup (phase-3-financial.md slice 18): fee heads, fee structures and
 * the school's payment accounts, taken from the generated OpenAPI document (`school.d.ts`,
 * produced by `pnpm api:generate`). Screens import the client and the DTO, body and query types
 * from here, so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as feesApi } from './client';

// ---- Enums ----

export type FeeHeadCategory = Schemas['FeeHeadCategory'];
export type FeeFrequency = Schemas['FeeFrequency'];
export type FeeHeadStatus = Schemas['FeeHeadStatus'];
export type FeeStructureStatus = Schemas['FeeStructureStatus'];
export type PaymentAccountKind = Schemas['PaymentAccountKind'];
export type PaymentAccountStatus = Schemas['PaymentAccountStatus'];

// ---- Responses ----

export type FeeHeadDto = Schemas['FeeHeadDto'];
export type FeeStructureDto = Schemas['FeeStructureDto'];
export type FeeStructureHeadDto = Schemas['FeeStructureHeadDto'];
export type FeeStructureClassDto = Schemas['FeeStructureClassDto'];
export type CopyFeeStructuresResultDto = Schemas['CopyFeeStructuresResultDto'];
export type PaymentAccountDto = Schemas['PaymentAccountDto'];

// ---- Queries ----

export type FeeHeadListQuery = Query<'FeeHeadsController_list'>;
export type FeeHeadSort = Schemas['FeeHeadSort'];
export type FeeStructureListQuery = Query<'FeeStructuresController_list'>;
export type PaymentAccountListQuery = Query<'PaymentAccountsController_list'>;

// ---- Bodies ----

export type CreateFeeHeadBody = Schemas['CreateFeeHeadDto'];
export type UpdateFeeHeadBody = Schemas['UpdateFeeHeadDto'];
export type CreateFeeStructureBody = Schemas['CreateFeeStructureDto'];
export type CopyFeeStructuresBody = Schemas['CopyFeeStructuresDto'];
export type CreatePaymentAccountBody = Schemas['CreatePaymentAccountDto'];

// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/** 409 FEE_STRUCTURE_EXISTS: the active row for that class, head and month. */
export type FeeStructureExists = { structureId: string };
/** 409 FEE_STRUCTURE_NOT_LATER: the latest month already set for that class and head. */
export type FeeStructureNotLater = { latestEffectiveFrom: string };
