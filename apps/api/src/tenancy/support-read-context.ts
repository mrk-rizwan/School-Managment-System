import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Propagation, TransactionHost } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../common/errors/api-exception';
import { ChangeContextRepository } from '../repositories/change-context.repository';
import type { PrismaTxAdapter } from '../repositories/prisma';
import { SupportWriteRefusedError } from '../repositories/query-guard';
import type { RequestContext } from './request-context';

// Exception 7 (phase-5-extended.md §3.1, rule 35; contracts/slice-45.md §2.2, §3): the context a
// platform support read runs in. Two of the three read-only layers are set here, in this order:
// the transaction is opened READ ONLY in Postgres (any write is SQLSTATE 25006), then the CLS
// store carries `support: true`, so the query guard refuses every write before it reaches the
// database. Lint confines the support module to its two repositories (the third layer).

/** Postgres's read_only_sql_transaction, as the driver adapter forwards it. */
const READ_ONLY_SQLSTATE = '25006';

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

/** A write refused by the READ ONLY transaction, in any of the shapes Prisma 7 + adapter-pg raise. */
export function isReadOnlyViolation(error: unknown): boolean {
  const cause = field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
  return (
    field(cause, 'originalCode') === READ_ONLY_SQLSTATE ||
    field(field(error, 'cause'), 'originalCode') === READ_ONLY_SQLSTATE ||
    field(error, 'code') === READ_ONLY_SQLSTATE
  );
}

export const supportWriteRefused = (): ApiException =>
  new ApiException(403, ErrorCode.SUPPORT_WRITE_REFUSED, 'Support access is read-only.');

@Injectable()
export class SupportReadContext {
  readonly #cls: ClsService<RequestContext>;

  constructor(
    cls: ClsService<RequestContext>,
    private readonly txHost: TransactionHost<PrismaTxAdapter>,
    private readonly transactionSettings: ChangeContextRepository,
  ) {
    this.#cls = cls;
  }

  /**
   * Runs `fn` in a fresh interactive transaction (never an enclosing one) opened READ ONLY, inside
   * a nested CLS context carrying `support: true`; the flag dies with the nested context. A write
   * attempted inside, by the guard or by Postgres, leaves as 403 SUPPORT_WRITE_REFUSED.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#cls.run({ ifNested: 'inherit' }, () =>
        this.txHost.withTransaction(Propagation.RequiresNew, async () => {
          await this.transactionSettings.readOnly();
          this.#cls.set('support', true);
          return fn();
        }),
      );
    } catch (error) {
      if (error instanceof SupportWriteRefusedError || isReadOnlyViolation(error)) {
        throw supportWriteRefused();
      }
      throw error;
    }
  }
}
