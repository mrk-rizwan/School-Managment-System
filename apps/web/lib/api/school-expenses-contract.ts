/**
 * School API types for expenses (phase-3-financial.md slice 23), taken from the generated OpenAPI
 * document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and the DTO,
 * body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as expensesApi } from './client';

export type ExpenseCategory = Schemas['ExpenseCategory'];
export type RecordableExpenseCategory = Schemas['RecordableExpenseCategory'];
export type ExpenseStatus = Schemas['ExpenseStatus'];
export type CounterPaymentMethod = Schemas['CounterPaymentMethod'];

export type ExpenseDto = Schemas['ExpenseDto'];
export type ExpenseListQuery = Query<'ExpensesController_list'>;

export type UpdateExpenseBody = Schemas['UpdateExpenseDto'];

/** 409 EXPENSE_NOT_OPEN, EXPENSE_NOT_PENDING, EXPENSE_RECEIPT_EXISTS. */
export type ExpenseRefusal = { expenseId: string };
