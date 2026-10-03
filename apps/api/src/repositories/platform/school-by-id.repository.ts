import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus } from '../generated/prisma/client';
import type { PrismaTxAdapter } from '../prisma';

/** The unbranded row a queue payload's school id resolves to. */
export interface QueueSchoolRow {
  readonly id: bigint;
  readonly status: SchoolStatus;
}

/**
 * Job-payload resolution (Phase 2 plan §4.1; CLAUDE.md named exception 3, widened): a queue job
 * carries its school id as a string, and this is the one read that turns it into a school row.
 * It returns the row unbranded; src/tenancy/queue.mint.ts, the only file allowed to import this
 * one (eslint.config.mjs), decides whether the job runs and applies the brand.
 * SchoolLookupRepository keeps its one by-code method.
 */
@Injectable()
export class SchoolByIdRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findById(id: bigint): Promise<QueueSchoolRow | null> {
    return this.txHost.tx.school.findFirst({ where: { id }, select: { id: true, status: true } });
  }
}
