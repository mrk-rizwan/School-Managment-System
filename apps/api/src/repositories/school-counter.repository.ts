import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

/** Per-school sequences, e.g. `admission_no` (tenant table school_counters). */
export type SchoolCounterName = 'admission_no';

export interface SchoolCounterRecord {
  id: bigint;
  name: string;
  value: bigint;
}

const SELECT = { id: true, name: true, value: true } as const;

@Injectable()
export class SchoolCounterRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Starts a counter at 0 (nothing issued yet). */
  create(schoolId: SchoolId, name: SchoolCounterName): Promise<SchoolCounterRecord> {
    return this.txHost.tx.schoolCounter.create({
      data: { schoolId, name, value: 0n },
      select: SELECT,
    });
  }

  find(schoolId: SchoolId, name: SchoolCounterName): Promise<SchoolCounterRecord | null> {
    return this.txHost.tx.schoolCounter.findFirst({ where: { schoolId, name }, select: SELECT });
  }
}
