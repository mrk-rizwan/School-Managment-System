/**
 * Rule 24 (CLAUDE.md; R225, Phase 5 R355): what a user may not do while they still sign in with
 * the default password, which colleagues may know (it is their CNIC or B-Form digits). Two layers:
 *
 * - Two capability keys are inert outright (DEFAULT_PASSWORD_INERT_CAPABILITIES): the holder does
 *   not hold them until the password is changed.
 * - Phase 5 reaches the money-out verbs and a few others by route (DEFAULT_PASSWORD_INERT_ACTIONS):
 *   each route carries `@DefaultPasswordInert('<action>')` (apps/api src/common/auth/route-access.ts)
 *   and is refused 403 DEFAULT_PASSWORD_BLOCKS_ACTION after its capability check. The key itself
 *   stays held, so a clerk can still record cash on a default password.
 *
 * The action names are stable (the web greys a button by `/me`'s `blockedActions`, slice 46); the
 * routes are data, and the API's route snapshot compares the decorated routes with this table.
 */
import { Capability } from './capabilities';

/** Inert while the holder still signs in with the default password (R225). */
export const DEFAULT_PASSWORD_INERT_CAPABILITIES: readonly Capability[] = [
  Capability.USER_ACCOUNT_MANAGE,
  Capability.ROLE_MANAGE,
];

/** A route as the API declares it: method and path under /api/v1, `:id` for path parameters. */
export interface InertRoute {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
}

/**
 * R355's list, action name → route. Routes owned by a later Phase 5 slice are listed now and
 * marked by that slice (opening-balance import: 43; device-token rotate: 44; the audit screen: 46,
 * which also applies the marker to the existing routes). Where R355 names a verb the system has no
 * route for (a payment-account update, a payroll run's own mark-paid, a salary-advance approval),
 * there is nothing to mark.
 */
export const DEFAULT_PASSWORD_INERT_ACTIONS = {
  'payment.refund': { method: 'POST', path: '/payments/:id/refund' },
  'payment.void': { method: 'POST', path: '/payments/:id/void' },
  'payment.reverse_refund': { method: 'POST', path: '/payments/:id/reverse-refund' },
  'payment_account.create': { method: 'POST', path: '/payment-accounts' },
  'payment_account.disable': { method: 'POST', path: '/payment-accounts/:id/disable' },
  'payroll_run.finalise': { method: 'POST', path: '/payroll-runs/:id/finalise' },
  'payslip.mark_paid': { method: 'POST', path: '/payslips/:id/mark-paid' },
  'salary_advance.grant': { method: 'POST', path: '/salary-advances' },
  'expense.approve': { method: 'POST', path: '/expenses/:id/approve' },
  // The payee is edited through the expense PATCH (slice 46 decides whether the marker refuses
  // every edit or only a payee change).
  'expense.payee_change': { method: 'PATCH', path: '/expenses/:id' },
  'cash_handover.confirm': { method: 'POST', path: '/cash-handovers/:id/confirm' },
  'cash_handover.resolve_shortfall': { method: 'POST', path: '/cash-handovers/:id/resolve-shortfall' },
  'charge.void': { method: 'POST', path: '/charges/:id/void' },
  'charge.waive': { method: 'POST', path: '/charges/:id/waive' },
  'dues_clearance.override': { method: 'POST', path: '/students/:id/dues-clearance/override' },
  'import.opening_balances': { method: 'POST', path: '/imports/opening-balances' },
  'device_token.rotate': { method: 'POST', path: '/school/device-token/rotate' },
  'audit_log.view': { method: 'GET', path: '/audit-log' },
} as const satisfies Record<string, InertRoute>;

export type DefaultPasswordInertAction = keyof typeof DEFAULT_PASSWORD_INERT_ACTIONS;

/** The action names, in table order (`/me`'s `blockedActions` lists them while the password is the default). */
export const DEFAULT_PASSWORD_INERT_ACTION_NAMES = Object.keys(
  DEFAULT_PASSWORD_INERT_ACTIONS,
) as DefaultPasswordInertAction[];
