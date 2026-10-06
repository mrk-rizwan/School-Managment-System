// Constraint → refusal mappings for slice 24, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-I builds never edit the same file.
import { ErrorCode } from '@asms/shared';
import { ApiException } from './api-exception';

const ownLeave = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot decide your own leave. Ask a colleague.', {
    reason: 'own_leave',
  });

export const SLICE_24_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // R211: a concurrent overlapping request (the service checks first; this is the race loser).
  leave_requests_live_excl: () =>
    new ApiException(409, ErrorCode.LEAVE_OVERLAPS, 'This overlaps another leave request.'),
  leave_types_live_name_key: () =>
    new ApiException(409, ErrorCode.LEAVE_TYPE_NAME_TAKEN, 'A leave type of that name already exists.', {
      field: 'name',
    }),
  // R210, R253: the trigger behind the service check (a second principal appointed between them).
  leave_requests_not_self: ownLeave,
  leave_requests_self_approved_unwarranted: ownLeave,
  leave_types_paid_check: () =>
    new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
      fields: [{ path: 'paid', code: ErrorCode.INVALID_VALUE, message: 'Unpaid leave is never paid' }],
    }),
};
