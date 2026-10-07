/**
 * School API types for the finance reports, fee reminders and dues clearance
 * (phase-3-financial.md slice 22), taken from the generated OpenAPI document (`school.d.ts`).
 * Screens import from here so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as reportsApi } from './client';

export type ReportRowDto = Schemas['ReportRowDto'];
export type AmountCountDto = Schemas['AmountCountDto'];

export type DefaulterDto = Schemas['DefaulterDto'];
export type DefaulterSort = Schemas['DefaulterSort'];
export type DefaultersQuery = Query<'FinanceReportsController_defaulters'>;

export type CollectionsReportDto = Schemas['CollectionsReportDto'];
export type CollectionGroup = Schemas['CollectionGroup'];
export type CollectionBasis = Schemas['CollectionBasis'];
export type CollectionsQuery = Query<'FinanceReportsController_collections'>;

export type OutstandingReportDto = Schemas['OutstandingReportDto'];
export type OutstandingGroup = Schemas['OutstandingGroup'];
export type OutstandingQuery = Query<'FinanceReportsController_outstanding'>;

export type DailyCashReportDto = Schemas['DailyCashReportDto'];

export type ConcessionsReportDto = Schemas['ConcessionsReportDto'];
export type ConcessionGroup = Schemas['ConcessionGroup'];
export type ConcessionsQuery = Query<'FinanceReportsController_concessions'>;

export type ExpensesReportDto = Schemas['ExpensesReportDto'];
export type ExpenseGroup = Schemas['ExpenseGroup'];
export type ExpensesReportQuery = Query<'FinanceReportsController_expenses'>;

export type PayrollReportDto = Schemas['PayrollReportDto'];
export type PayrollMonthDto = Schemas['PayrollMonthDto'];
export type PayrollReportQuery = Query<'FinanceReportsController_payroll'>;

export type ReminderKind = Schemas['ReminderKind'];
export type RemindersSentDto = Schemas['RemindersSentDto'];

export type DuesClearanceDto = Schemas['DuesClearanceDto'];
