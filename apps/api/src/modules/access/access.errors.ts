// Refusals of the slice-7 services (contracts/slice-7.md §7).
import { ErrorCode, type Capability } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';

/** R46, R94: nobody hands out, or edits a role to hold, a capability they do not hold. */
export const capabilityNotHeld = (capabilities: readonly Capability[]): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not hold some of these permissions.', {
    reason: 'capability_not_held',
    capabilities: [...capabilities],
  });

export const customRoleArchived = (): ApiException =>
  new ApiException(409, ErrorCode.CUSTOM_ROLE_ARCHIVED, 'This custom role is archived.');

export const customRoleKeyTaken = (customRoleId: bigint): ApiException =>
  new ApiException(409, ErrorCode.CUSTOM_ROLE_KEY_TAKEN, 'An active custom role has that key.', {
    customRoleId: customRoleId.toString(),
  });

export const grantExists = (grantId: bigint): ApiException =>
  new ApiException(409, ErrorCode.GRANT_EXISTS, 'The user already has that grant or revoke.', {
    grantId: grantId.toString(),
  });

export const customRoleInUse = (holderCount: number): ApiException =>
  new ApiException(409, ErrorCode.CUSTOM_ROLE_IN_USE, 'Remove this role from everyone who holds it first.', {
    holderCount,
  });

/** Principals are unrestricted peers: no grant or revoke row is ever made for one. */
export const targetIsPrincipal = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.TARGET_IS_PRINCIPAL,
    'A principal holds every permission; grants and revokes do not apply.',
  );

/**
 * A dated, role-aware write outside the caller's assignment on the row's date (contracts/
 * slice-13.md §1.3, decision 13; R175): 403, not 404, because the section or student is visible
 * to the caller. Slice 11 answers a register dated outside the assignment with the same refusal.
 */
export const notAssignedOnDate = (): ApiException =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    'You were not assigned to this class on that date.',
    { reason: 'not_assigned_on_date' },
  );

/**
 * A mark amendment whose `fromStatus` is not the stored status (contracts/slice-11.md §4.3,
 * slice-12.md §4.3): the row changed since the client loaded it.
 */
export const staleStatus = (currentStatus: string): ApiException =>
  new ApiException(
    409,
    ErrorCode.STALE_STATUS,
    'The mark changed since you loaded it. Reload and try again.',
    { currentStatus },
  );

/** Only the author, or a school-wide holder, may change another teacher's row (slice-13 §4.4, §5.3). */
export const notAuthor = (): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only the author can change this.', {
    reason: 'not_author',
  });
