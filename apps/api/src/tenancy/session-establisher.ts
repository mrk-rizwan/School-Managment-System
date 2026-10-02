import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from './request-context';
import type { SchoolId } from './school-id';

/** What session resolution establishes for the request: the tenant and who is acting. */
export interface EstablishedSession {
  readonly schoolId: SchoolId;
  readonly userId: bigint;
  readonly sessionId: bigint;
}

/**
 * Sets the request's tenant. Session resolution (CLAUDE.md named exception 4) lives in
 * src/tenancy/** and is the only code that may use this: importing this file anywhere else is
 * refused by lint, and TenancyModule does not export the provider. An import boundary cannot be
 * dodged with a computed key (`ctx[k](...)`), which a method-name ban could.
 */
@Injectable()
export class SessionEstablisher {
  readonly #cls: ClsService<RequestContext>;

  constructor(cls: ClsService<RequestContext>) {
    this.#cls = cls;
  }

  establishSession(session: EstablishedSession): void {
    this.#cls.set('schoolId', session.schoolId);
    this.#cls.set('userId', session.userId);
    this.#cls.set('sessionId', session.sessionId);
  }
}
