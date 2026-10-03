import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface OwnSchoolRecord {
  id: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
}

const SELECT = { id: true, name: true, shortCode: true, status: true, timezone: true } as const;

/**
 * The school's own row, for tenant code (plan §3.2). Its only predicate is `id = schoolId`, so a
 * school can read nothing but itself.
 */
@Injectable()
export class OwnSchoolRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  find(schoolId: SchoolId): Promise<OwnSchoolRecord | null> {
    return this.txHost.tx.school.findUnique({ where: { id: schoolId }, select: SELECT });
  }
}
