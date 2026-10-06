/**
 * School API types for salary (phase-3-financial.md slice 25, contracts/slice-25.md): salary
 * structures, advances, payroll runs and payslips, taken from the generated OpenAPI document
 * (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and the DTO, body and
 * query types from here, so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as payrollApi } from './client';

// ---- Enums ----

export type SalaryComponentKind = Schemas['SalaryComponentKind'];
export type AdvanceStatus = Schemas['AdvanceStatus'];
export type PayrollRunStatus = Schemas['PayrollRunStatus'];
export type PayslipStatus = Schemas['PayslipStatus'];
export type PayslipLineKind = Schemas['PayslipLineKind'];
export type CounterPaymentMethod = Schemas['CounterPaymentMethod'];

// ---- Responses ----

export type SalaryStructureDto = Schemas['SalaryStructureDto'];
export type MySalaryStructureDto = Schemas['MySalaryStructureDto'];
export type AdvanceDto = Schemas['AdvanceDto'];
export type PayrollRunDto = Schemas['PayrollRunDto'];
export type PayslipDto = Schemas['PayslipDto'];

// ---- Bodies ----

export type CreateSalaryStructureBody = Schemas['CreateSalaryStructureDto'];
export type SalaryComponentBody = Schemas['SalaryComponentDto'];
export type CreateAdvanceBody = Schemas['CreateAdvanceDto'];
export type AdjustPayslipBody = Schemas['AdjustPayslipDto'];
export type MarkPayslipPaidBody = Schemas['MarkPayslipPaidDto'];
