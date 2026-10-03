// Refusals shared by the slice-4 services (contracts/slice-4.md §6).
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../../common/errors/api-exception';

export const selfForbidden = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot do this to your own account.');

export const staffNotActive = (): ApiException =>
  new ApiException(409, ErrorCode.STAFF_NOT_ACTIVE, 'This staff member is not active.');

export const loginExists = (): ApiException =>
  new ApiException(409, ErrorCode.LOGIN_ALREADY_EXISTS, 'This staff member already has a login.');

export const lastPrincipal = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.LAST_PRINCIPAL,
    'The school must keep at least one active principal.',
  );

export type DeniedReason = 'target_is_principal' | 'target_exceeds_actor' | 'role_exceeds_actor';

export const denied = (reason: DeniedReason): ApiException =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    reason === 'target_is_principal'
      ? 'Only a principal can do this to a principal.'
      : reason === 'role_exceeds_actor'
        ? 'That role holds permissions you do not hold.'
        : 'This account holds permissions you do not hold.',
    { reason },
  );
