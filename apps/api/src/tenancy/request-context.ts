import { Injectable } from '@nestjs/common';
import { ClsService, type ClsStore } from 'nestjs-cls';
import type { SchoolId } from './school-id';

// Filled by session resolution (slice 2). Services read it; repositories never do, because
// schoolId is always their explicit first argument.
export interface RequestContext extends ClsStore {
  schoolId?: SchoolId;
  userId?: bigint;
  sessionId?: bigint;
}

/**
 * Read-only access to the request context for application code. A plain ClsService would accept
 * any value as the tenant (`cls.set('schoolId', body.schoolId)`) and let `get<T>()` claim any
 * type, so nestjs-cls may be imported only inside src/tenancy/** (eslint.config.mjs).
 *
 * The store is a true runtime private (`#cls`), not a TypeScript `private`: bracket access
 * (`ctx['cls']`) reaches a TS-private member and would hand out the raw ClsService.
 * Writing the tenant is SessionEstablisher's job (session-establisher.ts), not this class's.
 */
@Injectable()
export class RequestContextService {
  readonly #cls: ClsService<RequestContext>;

  constructor(cls: ClsService<RequestContext>) {
    this.#cls = cls;
  }

  /** The tenant of the current request; undefined before session resolution has run. */
  get schoolId(): SchoolId | undefined {
    return this.#cls.get('schoolId');
  }

  get userId(): bigint | undefined {
    return this.#cls.get('userId');
  }

  get sessionId(): bigint | undefined {
    return this.#cls.get('sessionId');
  }
}
