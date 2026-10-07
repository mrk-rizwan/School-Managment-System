import type { ReasonDto } from '../../common/reason.dto';
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { LeaveTypeRepository, type LeaveTypeRecord } from '../../repositories/leave-type.repository';
import type { CreateLeaveTypeDto, LeaveTypeDto, ListLeaveTypesQueryDto } from './leave.dto';

const SUBJECT = 'leave_type';

export function toLeaveTypeDto(row: LeaveTypeRecord): LeaveTypeDto {
  return {
    id: row.id.toString(),
    name: row.name,
    code: row.code,
    daysPerYear: row.daysPerYear,
    paid: row.paid,
    status: row.status,
    archivedAt: row.archivedAt,
    seeded: row.createdBy === null,
  };
}

export const leaveTypeNameTaken = (leaveTypeId?: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.LEAVE_TYPE_NAME_TAKEN,
    'A leave type of that name already exists.',
    leaveTypeId === undefined ? { field: 'name' } : { field: 'name', leaveTypeId: leaveTypeId.toString() },
  );

/** Leave types (phase-3-financial.md slice 24, R209). Frozen once created; archive is final. */
@Injectable()
export class LeaveTypesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly types: LeaveTypeRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(query: ListLeaveTypesQueryDto): Promise<Page<LeaveTypeDto>> {
    const { rows, total } = await this.types.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toLeaveTypeDto), query, total);
  }

  /** A taken live name is refused with the holder's id; the partial unique index catches a race. */
  @Transactional()
  async create(dto: CreateLeaveTypeDto): Promise<LeaveTypeDto> {
    const { schoolId, userId } = this.context.actor();
    if (dto.code === 'unpaid' && dto.paid) {
      throw fieldRefused('paid', ErrorCode.INVALID_VALUE, 'Unpaid leave is never paid');
    }
    const same = await this.types.findLiveByName(schoolId, dto.name);
    if (same) throw leaveTypeNameTaken(same.id);
    const row = await this.types.create(schoolId, {
      name: dto.name,
      code: dto.code,
      daysPerYear: dto.daysPerYear ?? null,
      paid: dto.paid,
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_type.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { name: row.name, code: row.code, daysPerYear: row.daysPerYear, paid: row.paid },
    });
    return toLeaveTypeDto(row);
  }

  /** Final. Requests keep their type; a new request naming it is LEAVE_TYPE_ARCHIVED. A repeat is a no-op. */
  @Transactional()
  async archive(id: bigint, dto: ReasonDto): Promise<LeaveTypeDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await readLocked(
      () => this.types.findById(schoolId, id),
      (found) => this.types.lockIfUnchanged(schoolId, found),
    );
    if (row.status === 'archived') return toLeaveTypeDto(row);
    const archived = await this.types.archive(schoolId, id, userId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_type.archived',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { name: row.name, code: row.code },
    });
    return toLeaveTypeDto(archived);
  }
}
