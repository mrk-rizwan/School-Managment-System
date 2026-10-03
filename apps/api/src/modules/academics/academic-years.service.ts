import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, type AcademicYearStatus } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { toPage, type Page } from '../../common/pagination';
import {
  AcademicYearRepository,
  type AcademicYearRecord,
} from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { type Changes, fromDateString, toDateString, yearClosed } from './academics.shared';
import type {
  AcademicYearDto,
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
} from './academic-years.dto';

const SUBJECT = 'academic_year';

/** A typo guard on the year's span (contract §2.3). */
const MAX_SPAN_DAYS = 731;
const DAY_MS = 24 * 60 * 60 * 1000;

export function toAcademicYearDto(year: AcademicYearRecord): AcademicYearDto {
  return {
    id: year.id.toString(),
    name: year.name,
    startsOn: toDateString(year.startsOn),
    endsOn: toDateString(year.endsOn),
    status: year.status,
    createdAt: year.createdAt,
    updatedAt: year.updatedAt,
  };
}

/** endsOn after startsOn, within MAX_SPAN_DAYS; reported on endsOn (contract §2.3). */
function assertSpan(startsOn: Date, endsOn: Date): void {
  const days = (endsOn.getTime() - startsOn.getTime()) / DAY_MS;
  if (days <= 0) {
    throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, 'endsOn must be after startsOn');
  }
  if (days > MAX_SPAN_DAYS) {
    throw fieldRefused(
      'endsOn',
      ErrorCode.INVALID_VALUE,
      `endsOn must be at most ${MAX_SPAN_DAYS} days after startsOn`,
    );
  }
}

/** Which transitions each action makes (contract §2: planned → active, planned | active → closed). */
const TRANSITIONS: Record<'activate' | 'close', readonly AcademicYearStatus[]> = {
  activate: ['planned'],
  close: ['planned', 'active'],
};

/** Academic years (contracts/slice-3.md §2). */
@Injectable()
export class AcademicYearsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly years: AcademicYearRepository,
    private readonly audit: AuditLogRepository,
    private readonly enrolments: EnrolmentRepository,
  ) {}

  async list(query: ListAcademicYearsQueryDto): Promise<Page<AcademicYearDto>> {
    const { rows, total } = await this.years.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      sort: query.sort ?? '-startsOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toAcademicYearDto), query, total);
  }

  async get(id: bigint): Promise<AcademicYearDto> {
    const year = await this.years.findById(this.context.schoolId, id);
    if (!year) throw notFound();
    return toAcademicYearDto(year);
  }

  /** Created `planned`. A taken name is 409 ACADEMIC_YEAR_NAME_TAKEN (constraint mapper). */
  @Transactional()
  async create(dto: CreateAcademicYearDto): Promise<AcademicYearDto> {
    const { schoolId, userId } = this.context.actor();
    const startsOn = fromDateString(dto.startsOn);
    const endsOn = fromDateString(dto.endsOn);
    assertSpan(startsOn, endsOn);
    const year = await this.years.create(schoolId, { name: dto.name, startsOn, endsOn });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_year.created',
      subjectType: SUBJECT,
      subjectId: year.id,
      metadata: { name: year.name, startsOn: dto.startsOn, endsOn: dto.endsOn },
    });
    return toAcademicYearDto(year);
  }

  /** Plain attributes, decided under the row lock; the date rule on the merged result. */
  @Transactional()
  async update(id: bigint, dto: UpdateAcademicYearDto): Promise<AcademicYearDto> {
    const { schoolId, userId } = this.context.actor();
    const year = await this.lock(schoolId, id);
    if (year.status === 'closed') throw yearClosed();

    const data: { name?: string; startsOn?: Date; endsOn?: Date } = {};
    const changes: Changes = {};
    if (dto.name !== undefined && dto.name !== year.name) {
      data.name = dto.name;
      changes.name = { from: year.name, to: dto.name };
    }
    for (const field of ['startsOn', 'endsOn'] as const) {
      const value = dto[field];
      const current = toDateString(year[field]);
      if (value !== undefined && value !== current) {
        data[field] = fromDateString(value);
        changes[field] = { from: current, to: value };
      }
    }
    if (Object.keys(changes).length === 0) return toAcademicYearDto(year);
    assertSpan(data.startsOn ?? year.startsOn, data.endsOn ?? year.endsOn);

    const updated = await this.years.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_year.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toAcademicYearDto(updated);
  }

  /** planned → active. Several years may be active at once (rule 15). */
  @Transactional()
  activate(id: bigint): Promise<AcademicYearDto> {
    return this.transition(id, 'activate', 'active');
  }

  /**
   * planned | active → closed, final. Refused while any enrolment in the year is active (R44),
   * checked under the year's row lock. Closing does not archive classes.
   */
  @Transactional()
  close(id: bigint): Promise<AcademicYearDto> {
    return this.transition(id, 'close', 'closed');
  }

  /**
   * R44: 409 ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS while any enrolment in the year is `active`.
   * Inside close's transaction and under the year's row lock; enrolling into a class of the year
   * locks the year too (EnrolmentsService.lockTarget), so none can slip in between.
   */
  async assertNoActiveEnrolments(schoolId: SchoolId, yearId: bigint): Promise<void> {
    if (await this.enrolments.hasActiveInYear(schoolId, yearId)) {
      throw new ApiException(
        409,
        ErrorCode.ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS,
        'This academic year still has active enrolments.',
      );
    }
  }

  private async transition(
    id: bigint,
    action: 'activate' | 'close',
    to: AcademicYearStatus,
  ): Promise<AcademicYearDto> {
    const { schoolId, userId } = this.context.actor();
    const year = await this.lock(schoolId, id);
    const from = year.status;
    // A double-submitted dialog: unchanged, no audit row.
    if (from === to) return toAcademicYearDto(year);
    if (!TRANSITIONS[action].includes(from)) {
      throw new ApiException(
        409,
        ErrorCode.ILLEGAL_STATUS_TRANSITION,
        `A ${from} academic year cannot become ${to}.`,
        { from, to },
      );
    }
    if (to === 'closed') await this.assertNoActiveEnrolments(schoolId, id);
    const updated = await this.years.update(schoolId, id, { status: to });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: action === 'activate' ? 'academic_year.activated' : 'academic_year.closed',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { from, to },
    });
    return toAcademicYearDto(updated);
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<AcademicYearRecord> {
    return readLocked(
      () => this.years.findById(schoolId, id),
      (row) => this.years.lockIfUnchanged(schoolId, row),
    );
  }
}
