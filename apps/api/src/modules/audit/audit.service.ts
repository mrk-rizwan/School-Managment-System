import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { addDays, assertRange, dayStart, SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  AuditReadsRepository,
  type AuditReadFilter,
  type AuditReadRow,
} from '../../repositories/audit-reads.repository';
import { fromDateString } from '../academics/academics.shared';
import { maskText, metadataDetails } from './audit-text';
import type { AuditActorDto, AuditEntryDto, ListAuditLogQueryDto } from './audit.dto';

// Phase 5 slice 46, the audit screen (contracts/slice-46.md §2; rule 40, R354). Read-only over
// audit_log through AuditReadsRepository; the one write is the viewer's own `audit.viewed`, at
// most once per actor per school day (§7.1 R57 list).

/** The widest date range, inclusive (§1.1 "Audit screen"). */
export const AUDIT_MAX_RANGE_DAYS = 92;

export const AUDIT_VIEWED_ACTION = 'audit.viewed';

/** The name a platform actor is shown by (support reads, slice 45; the platform's own writes). */
export const PLATFORM_ACTOR_NAME = 'Platform support';
const SYSTEM_ACTOR_NAME = 'System';

const filterRequired = (): ApiException =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [
      {
        path: 'actorUserId',
        code: ErrorCode.INVALID_VALUE,
        message: 'Give actorUserId, subjectType with subjectId, or createdFrom with createdTo',
      },
    ],
  });

const pairRequired = (path: string, other: string): ApiException =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code: ErrorCode.INVALID_VALUE, message: `${path} is required with ${other}` }],
  });

function actorOf(row: AuditReadRow): AuditActorDto {
  if (row.actorUserId !== null) {
    return { kind: 'user', userId: row.actorUserId.toString(), name: row.actorName ?? '' };
  }
  if (row.actorPlatformUserId !== null) return { kind: 'platform', userId: null, name: PLATFORM_ACTOR_NAME };
  return { kind: 'system', userId: null, name: SYSTEM_ACTOR_NAME };
}

export function toAuditEntryDto(row: AuditReadRow): AuditEntryDto {
  return {
    id: row.id.toString(),
    createdAt: row.createdAt,
    action: row.action,
    subjectType: row.subjectType,
    subjectId: row.subjectId?.toString() ?? null,
    actor: actorOf(row),
    reason: row.reason === null ? null : maskText(row.reason),
    details: metadataDetails(row.metadata),
  };
}

/**
 * §2.1: the required filter, the pairs, the 92-day range in the school's calendar. Shared with the
 * platform support audit view (contracts/slice-45.md §1), which applies the same rules.
 */
export function auditFilterOf(query: ListAuditLogQueryDto, timezone: string): AuditReadFilter {
  if ((query.subjectType === undefined) !== (query.subjectId === undefined)) {
    throw query.subjectType === undefined
      ? pairRequired('subjectType', 'subjectId')
      : pairRequired('subjectId', 'subjectType');
  }
  if ((query.createdFrom === undefined) !== (query.createdTo === undefined)) {
    throw query.createdFrom === undefined
      ? pairRequired('createdFrom', 'createdTo')
      : pairRequired('createdTo', 'createdFrom');
  }
  const filter: AuditReadFilter = {};
  if (query.actorUserId !== undefined) filter.actorUserId = BigInt(query.actorUserId);
  if (query.subjectType !== undefined && query.subjectId !== undefined) {
    filter.subject = { type: query.subjectType, id: BigInt(query.subjectId) };
  }
  if (query.createdFrom !== undefined && query.createdTo !== undefined) {
    const from = fromDateString(query.createdFrom);
    const to = fromDateString(query.createdTo);
    // Inclusive: 92 calendar days is 91 days apart.
    assertRange(from, to, AUDIT_MAX_RANGE_DAYS - 1, { field: 'createdTo', from: 'createdFrom' });
    filter.createdRange = { from: dayStart(timezone, from), to: dayStart(timezone, addDays(to, 1)) };
  }
  if (filter.actorUserId === undefined && filter.subject === undefined && filter.createdRange === undefined) {
    throw filterRequired();
  }
  if (query.actionPrefix !== undefined) {
    // A bare family means the family's actions: `payment` is `payment.*`, never `payment_account.*`.
    filter.actionPrefix = query.actionPrefix.includes('.') ? query.actionPrefix : `${query.actionPrefix}.`;
  }
  return filter;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly context: SchoolContext,
    private readonly reads: AuditReadsRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  async list(query: ListAuditLogQueryDto): Promise<Page<AuditEntryDto>> {
    const filter = await this.filterOf(query);
    const { rows, total } = await this.reads.page(
      this.context.schoolId,
      filter,
      (query.page - 1) * query.limit,
      query.limit,
    );
    await this.recordViewed();
    return toPage(rows.map(toAuditEntryDto), query, total);
  }

  async get(id: bigint): Promise<AuditEntryDto> {
    const row = await this.reads.find(this.context.schoolId, id);
    if (row === null) throw notFound();
    await this.recordViewed();
    return toAuditEntryDto(row);
  }

  /** §2.1, in the school's timezone. */
  private async filterOf(query: ListAuditLogQueryDto): Promise<AuditReadFilter> {
    return auditFilterOf(query, await this.clock.timezone(this.context.schoolId));
  }

  /** `audit.viewed`, at most once per actor per school day (R57). */
  private async recordViewed(): Promise<void> {
    const { schoolId, userId } = this.context.actor();
    const since = dayStart(await this.clock.timezone(schoolId), await this.clock.today(schoolId));
    if (await this.audit.existsForActorSince(schoolId, userId, AUDIT_VIEWED_ACTION, since)) return;
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: AUDIT_VIEWED_ACTION,
      subjectType: 'audit_log',
      subjectId: null,
    });
  }
}
