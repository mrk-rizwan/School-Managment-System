import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { RequestContextService } from '../tenancy/request-context';
import type { SchoolId } from '../tenancy/school-id';
import { ApiException } from './errors/api-exception';

/** Who is acting: the request's tenant and user, from the resolved session. */
export interface Actor {
  schoolId: SchoolId;
  userId: bigint;
}

/**
 * The tenant and the acting user for school services, from the session (never from input), so
 * no handler passes a SchoolId. Fails closed: a school route reached without a resolved session
 * is refused rather than run without a tenant.
 */
@Injectable()
export class SchoolContext {
  constructor(private readonly ctx: RequestContextService) {}

  get schoolId(): SchoolId {
    return this.actor().schoolId;
  }

  actor(): Actor {
    const { schoolId, userId } = this.ctx;
    if (schoolId === undefined || userId === undefined) {
      throw new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');
    }
    return { schoolId, userId };
  }
}
