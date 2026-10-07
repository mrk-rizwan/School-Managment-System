/**
 * School API types for staff leave (phase-3-financial.md slice 24, contracts/slice-24.md): leave
 * types, a staff member's own requests and balance, and the approvers' queue, taken from the
 * generated OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the
 * client and the DTO, body and query types from here, so a regenerated document is checked
 * against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as leaveApi } from './client';

// ---- Enums ----

export type LeaveCode = Schemas['LeaveCode'];
export type LeaveStatus = Schemas['LeaveStatus'];
export type LeaveTypeStatus = Schemas['LeaveTypeStatus'];

// ---- Responses ----

export type LeaveTypeDto = Schemas['LeaveTypeDto'];
export type LeaveBalanceDto = Schemas['LeaveBalanceDto'];
export type LeaveRequestDto = Schemas['LeaveRequestDto'];
/** GET /staff/:id/leave-requests (staff.view): without reason and decisionReason. */
export type StaffLeaveRequestDto = Schemas['StaffLeaveRequestDto'];

// ---- Queries ----

export type LeaveRequestListQuery = Query<'LeaveRequestsController_list'>;

// ---- Bodies ----


// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/** 409 LEAVE_BALANCE_EXCEEDED: the working days left for that year. */
export type LeaveBalanceExceeded = { balance: number; year: number };
/** 409 LEAVE_OVERLAPS: the live request in the way. */
export type LeaveOverlaps = { leaveRequestId?: string };
