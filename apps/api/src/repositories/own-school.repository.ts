import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus, SmsProviderChoice, WhatsAppProviderChoice } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export interface OwnSchoolRecord {
  id: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  timezone: string;
  /** Set by the platform (owner's item 18); read-only to the school (contracts/slice-9.md §4). */
  smsMonthlyCap: number;
  /** Set by the platform (contracts/slice-9.md §6.1); `platform_default` defers to platform_settings. */
  whatsappProvider: WhatsAppProviderChoice;
  smsProvider: SmsProviderChoice;
}

const SELECT = {
  id: true,
  name: true,
  shortCode: true,
  status: true,
  timezone: true,
  smsMonthlyCap: true,
  whatsappProvider: true,
  smsProvider: true,
} as const;

/**
 * The school's own row, for tenant code (plan §3.2). Its only predicate is `id = schoolId`, so a
 * school can read nothing but itself.
 */
@Injectable()
export class OwnSchoolRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  find(schoolId: SchoolId): Promise<OwnSchoolRecord | null> {
    return this.txHost.tx.school.findFirst({ where: { id: schoolId }, select: SELECT });
  }
}
