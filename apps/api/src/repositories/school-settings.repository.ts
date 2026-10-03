import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface SchoolSettingsRecord {
  id: bigint;
  feeDueDay: number;
  studentLoginEnabled: boolean;
}

const SELECT = { id: true, feeDueDay: true, studentLoginEnabled: true } as const;

/** The school's one settings row (tenant table school_settings). */
@Injectable()
export class SchoolSettingsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Written once, in the transaction that creates the school. Student login starts off. */
  create(schoolId: SchoolId, data: { feeDueDay: number }): Promise<SchoolSettingsRecord> {
    return this.txHost.tx.schoolSettings.create({
      data: { schoolId, feeDueDay: data.feeDueDay, studentLoginEnabled: false },
      select: SELECT,
    });
  }

  find(schoolId: SchoolId): Promise<SchoolSettingsRecord | null> {
    return this.txHost.tx.schoolSettings.findFirst({ where: { schoolId }, select: SELECT });
  }
}
