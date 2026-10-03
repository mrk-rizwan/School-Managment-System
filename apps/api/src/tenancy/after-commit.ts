// Work that must happen only once the ambient transaction has committed - enqueueing a message
// job (R105), never on rollback (CLAUDE.md "Transactions"). @nestjs-cls/transactional has no
// commit hook, so the Prisma adapter is wrapped: callbacks registered against a transaction's
// client run after its $transaction resolves (committed) and are dropped when it rejects (rolled
// back). A nested @Transactional() (a savepoint) shares its parent's client, so its callbacks run
// at the outer commit. Callbacks run in registration order, outside any transaction; one that
// throws does not stop the rest and never reaches the caller, whose transaction has already
// committed.
import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { failureLog } from '../common/errors/failure-log';
import type { GuardedPrismaClient, PrismaTxAdapter } from '../repositories/prisma';

type Callback = () => Promise<void>;

const pending = new WeakMap<object, Callback[]>();
const logger = new Logger('AfterCommit');

async function runCommitted(client: object): Promise<void> {
  const callbacks = pending.get(client);
  pending.delete(client);
  for (const callback of callbacks ?? []) {
    try {
      await callback();
    } catch (error) {
      logger.error(failureLog(error), 'after-commit callback failed');
    }
  }
}

type AdapterOptions = ConstructorParameters<typeof TransactionalAdapterPrisma<GuardedPrismaClient>>[0];

/** The Prisma adapter with an after-commit step (registered in TenancyModule). */
export class AfterCommitPrismaAdapter extends TransactionalAdapterPrisma<GuardedPrismaClient> {
  constructor(options: AdapterOptions) {
    super(options);
    const base = this.optionsFactory;
    this.optionsFactory = (prisma: GuardedPrismaClient) => {
      const inner = base(prisma);
      return {
        ...inner,
        wrapWithTransaction: async (txOptions, fn, setClient): Promise<unknown> => {
          let client: object | undefined;
          const result: unknown = await inner.wrapWithTransaction(txOptions, fn, (tx) => {
            if (tx !== undefined) client = tx;
            setClient(tx);
          });
          // The committed client is cleared from the context first: a callback runs outside the
          // transaction (a repository call uses the plain client, a @Transactional() opens a new
          // transaction whose own callbacks run at its own commit), never on the closed one.
          setClient(undefined);
          if (client !== undefined) await runCommitted(client);
          return result;
        },
      };
    };
  }
}

/** Registers work to run after the ambient transaction commits. */
@Injectable()
export class AfterCommit {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Throws outside a transaction: "after commit" would have no meaning there. */
  register(callback: Callback): void {
    if (!this.txHost.isTransactionActive()) {
      throw new Error('AfterCommit.register needs an active transaction');
    }
    const client: object = this.txHost.tx;
    const list = pending.get(client);
    if (list) list.push(callback);
    else pending.set(client, [callback]);
  }
}
