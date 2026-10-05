// The principal gate and the separation-of-duties refusals of Phase 3 (phase-3-financial.md §3.1,
// R232, R233, R253). A capability says who may use a route; these say who may take the decision.
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';

/** Why a money verb was refused to a caller who holds its key (§3.1 `details.reason`). */
export type MoneyRefusalReason = 'principal_required' | 'not_recorder' | 'not_requester' | 'not_collector' | 'own_child';

/** 403: the verb needs the principal role, which no grant or custom role confers. */
export const principalRequired = (): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only a principal can do this.', {
    reason: 'principal_required',
  });

/** 409: the actor is a guardian of the student this money row is for (R232). */
export const ownChild = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'You cannot do this for your own child. Ask a colleague.',
    { reason: 'own_child' },
  );

/**
 * R233: the one principal gate. Reads the system role only, so a grant of the verb's key or a
 * custom role holding it never satisfies it; the principal must also hold staff capacity (an
 * active staff record), as every capability does (R59).
 */
export function requirePrincipal(session: SchoolSessionContext): void {
  const { access } = session;
  if (!access.capacities.staff || !access.systemRoles.includes('principal')) throw principalRequired();
}

/**
 * Who may read fee heads, fee structures and payment accounts (§3.1): the finance key holders.
 * A teacher's role default holds none of them (R234).
 */
export const FINANCE_READERS: [Capability, ...Capability[]] = [
  Capability.FEE_HEAD_MANAGE,
  Capability.CHARGE_CREATE,
  Capability.FEE_STATEMENT_VIEW,
  Capability.PAYMENT_RECORD,
];
