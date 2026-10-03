import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  MessageChannel,
  SchoolStatus,
  WhatsAppErrorCode,
  WhatsAppStatus,
} from '@asms/shared';
import type { Prisma } from '../generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from '../prisma';
import type { SchoolId } from '../../tenancy/school-id';

// platform_delivery_health (named exception 6; contracts/slice-9.md §6.3, §7.11; R114): the
// per-school, per-day, per-channel rollup and the platform's only window onto messaging. Counts,
// statuses and caps only. The writer (upsert) is called only by the per-school rollup job in
// src/jobs (a NAMED_EXCEPTION_SITES entry); the reader only by src/modules/platform/**. Neither
// touches messages, message_deliveries or whatsapp_numbers.

export interface HealthCounts {
  accepted: number;
  delivered: number;
  failed: number;
  suppressed: number;
}

export interface HealthSnapshot {
  whatsappStatus: WhatsAppStatus | null;
  whatsappLastHealthyAt: Date | null;
  whatsappLastErrorCode: WhatsAppErrorCode | null;
  smsUsed: number;
  smsCap: number;
}

export interface HealthRow extends HealthCounts, HealthSnapshot {
  schoolId: bigint;
  day: Date;
  channel: MessageChannel;
  computedAt: Date;
}

export interface HealthSchool {
  id: bigint;
  name: string;
  shortCode: string;
  status: SchoolStatus;
  smsMonthlyCap: number;
}

@Injectable()
export class DeliveryHealthRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The rollup's write for one school, day and channel. */
  async upsert(
    schoolId: SchoolId,
    day: Date,
    channel: MessageChannel,
    data: HealthCounts & HealthSnapshot & { computedAt: Date },
  ): Promise<void> {
    await this.txHost.tx.platformDeliveryHealth.upsert({
      where: { schoolId_day_channel: { schoolId, day, channel } },
      create: { schoolId, day, channel, ...data },
      update: data,
      select: { id: true },
    });
  }

  /** Schools for the health view: a status filter (default: all but terminated) and a search. */
  schools(query: { schoolStatus?: SchoolStatus; q?: string }): Promise<HealthSchool[]> {
    const where: Prisma.SchoolWhereInput = {
      ...(query.schoolStatus === undefined
        ? { status: { not: 'terminated' } }
        : { status: query.schoolStatus }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: escapeLike(query.q), mode: 'insensitive' } },
              { shortCode: { startsWith: escapeLike(query.q.toLowerCase()) } },
            ],
          }),
    };
    return this.txHost.tx.school.findMany({
      where,
      select: { id: true, name: true, shortCode: true, status: true, smsMonthlyCap: true },
      orderBy: { id: 'asc' },
    });
  }

  /** The rollup rows of these schools on these days. */
  rows(schoolIds: readonly bigint[], days: readonly Date[]): Promise<HealthRow[]> {
    if (schoolIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.platformDeliveryHealth.findMany({
      where: { schoolId: { in: [...schoolIds] }, day: { in: [...days] } },
      select: {
        schoolId: true,
        day: true,
        channel: true,
        accepted: true,
        delivered: true,
        failed: true,
        suppressed: true,
        whatsappStatus: true,
        whatsappLastHealthyAt: true,
        whatsappLastErrorCode: true,
        smsUsed: true,
        smsCap: true,
        computedAt: true,
      },
    });
  }
}
