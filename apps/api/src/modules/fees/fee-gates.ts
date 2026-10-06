// Slice 19's use of the Phase 3 gates (phase-3-financial.md §3.1, R232, R233, R253): which key a
// verb needs beyond its route's, and the own-child refusal with the sole-principal exception.
import { ErrorCode, type Capability } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';
import type { SchoolId } from '../../tenancy/school-id';
import { ownChild } from '../access/money-gates';
import type { PermissionsService } from '../access/permissions.service';

/** A system principal with staff capacity (requirePrincipal's predicate, as a value). */
export const isPrincipal = (session: SchoolSessionContext): boolean =>
  session.access.capacities.staff && session.access.systemRoles.includes('principal');

/** 403 unless the caller holds `capability` (a verb whose route admits more than one key). */
export function requireHeld(session: SchoolSessionContext, capability: Capability): void {
  if (!session.access.capabilities.has(capability)) {
    throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');
  }
}

/**
 * R232 with R253's exception: false when the student is not the actor's own child; true
 * (`selfApproved`) when it is and the actor is the school's sole active principal, read under the
 * settings-row lock (call inside the writing transaction); otherwise 409 own_child.
 */
export async function ownChildCheck(
  permissions: PermissionsService,
  session: SchoolSessionContext,
  schoolId: SchoolId,
  studentId: bigint,
): Promise<boolean> {
  const userId = session.access.userId;
  if (!(await permissions.actorIsGuardianOf(schoolId, userId, studentId))) return false;
  if (isPrincipal(session) && (await permissions.isSolePrincipal(schoolId, userId))) return true;
  throw ownChild();
}
