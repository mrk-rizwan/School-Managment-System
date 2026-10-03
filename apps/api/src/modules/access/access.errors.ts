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
