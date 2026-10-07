/**
 * Platform API types for billing: plans, a school's plan and cap, invoices and the monthly run
 * (contracts/slice-26.md §1), taken from the generated OpenAPI document (`platform.d.ts`, produced
 * by `pnpm api:generate`). Screens import the client and the types from here, so a regenerated
 * document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './platform';

type Schemas = components['schemas'];

export { platformApi as billingApi } from './client';

export type PlanStatus = Schemas['PlanStatus'];
export type InvoiceStatus = Schemas['InvoiceStatus'];
export type BillingSkipReason = Schemas['BillingSkipReason'];

export type PlanDto = Schemas['PlanDto'];
export type UpdatePlanBody = Schemas['UpdatePlanDto'];
export type PlanListQuery = NonNullable<operations['PlansController_list']['parameters']['query']>;

export type SubscriptionDto = Schemas['SubscriptionDto'];
export type SchoolBillingDto = Schemas['SchoolBillingDto'];

export type InvoiceDto = Schemas['InvoiceDto'];
export type InvoiceListQuery = NonNullable<operations['InvoicesController_list']['parameters']['query']>;
export type IssueMonthResultDto = Schemas['IssueMonthResultDto'];
