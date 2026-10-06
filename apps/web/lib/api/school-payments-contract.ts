/**
 * School API types for payments (phase-3-financial.md slice 20, contracts/slice-20.md): the
 * counter's family dues and preview, payments, receipts, reversals, cash custody and handovers,
 * taken from the generated OpenAPI document (`school.d.ts`). Screens import from here so a
 * regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as paymentsApi } from './client';

export type CounterPaymentMethod = Schemas['CounterPaymentMethod'];
export type PaymentMethod = Schemas['PaymentMethod'];
export type PaymentStatus = Schemas['PaymentStatus'];
export type HandoverStatus = Schemas['HandoverStatus'];
export type ShortfallResolution = Schemas['ShortfallResolution'];

export type GuardianDuesDto = Schemas['GuardianDuesDto'];
export type GuardianChildDuesDto = Schemas['GuardianChildDuesDto'];
export type PaymentIntent = Schemas['PaymentIntentDto'];
export type PaymentPreviewDto = Schemas['PaymentPreviewDto'];
export type PaymentDto = Schemas['PaymentDto'];
export type ReceiptDto = Schemas['ReceiptDto'];
export type ReversalDto = Schemas['ReversalDto'];
export type CustodyDto = Schemas['CustodyDto'];
export type HandoverDto = Schemas['HandoverDto'];

export type PaymentListQuery = Query<'PaymentsController_list'>;
export type HandoverListQuery = Query<'CashHandoversController_list'>;

/** 409 REFUND_EXCEEDS_UNALLOCATED and NOTHING_TO_CARRY_FORWARD. */
export type Unallocated = { paymentId: string; unallocated: number };

/** The print view: opened in a new tab with the session cookie (R237). */
export const receiptPrintUrl = (receiptId: string): string => `/api/v1/receipts/${receiptId}/print`;
