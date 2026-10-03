import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { toPage, type Page } from '../../common/pagination';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SubjectRepository, type SubjectRecord } from '../../repositories/subject.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { ArchiveDto, Changes } from './academics.shared';
import type {
  CreateSubjectDto,
  ListSubjectsQueryDto,
  SubjectDto,
  UpdateSubjectDto,
} from './subjects.dto';

const SUBJECT = 'subject';

export function toSubjectDto(subject: SubjectRecord): SubjectDto {
  return {
    id: subject.id.toString(),
    name: subject.name,
    code: subject.code,
    archivedAt: subject.deletedAt,
    createdAt: subject.createdAt,
    updatedAt: subject.updatedAt,
  };
}

/** Subjects (contracts/slice-3.md §5). */
@Injectable()
export class SubjectsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly subjects: SubjectRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(query: ListSubjectsQueryDto): Promise<Page<SubjectDto>> {
    const { rows, total } = await this.subjects.list(this.context.schoolId, {
      includeArchived: query.includeArchived ?? false,
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'name',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toSubjectDto), query, total);
  }

  async get(id: bigint): Promise<SubjectDto> {
    const subject = await this.subjects.findById(this.context.schoolId, id);
    if (!subject) throw notFound();
    return toSubjectDto(subject);
  }

  /** A taken live name or code is 409 SUBJECT_NAME_TAKEN / SUBJECT_CODE_TAKEN (constraint mapper). */
  @Transactional()
  async create(dto: CreateSubjectDto): Promise<SubjectDto> {
    const { schoolId, userId } = this.context.actor();
    const subject = await this.subjects.create(schoolId, {
      name: dto.name,
      code: dto.code ?? null,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'subject.created',
      subjectType: SUBJECT,
      subjectId: subject.id,
      metadata: { name: subject.name, code: subject.code },
    });
    return toSubjectDto(subject);
  }

  /** Name and code (null clears). An archived subject is frozen. */
  @Transactional()
  async update(id: bigint, dto: UpdateSubjectDto): Promise<SubjectDto> {
    const { schoolId, userId } = this.context.actor();
    const subject = await this.lock(schoolId, id);
    if (subject.deletedAt !== null) {
      throw new ApiException(
        409,
        ErrorCode.SUBJECT_ARCHIVED,
        'An archived subject cannot be changed.',
      );
    }

    const data: { name?: string; code?: string | null } = {};
    const changes: Changes = {};
    if (dto.name !== undefined && dto.name !== subject.name) {
      data.name = dto.name;
      changes.name = { from: subject.name, to: dto.name };
    }
    if (dto.code !== undefined && dto.code !== subject.code) {
      data.code = dto.code;
      changes.code = { from: subject.code, to: dto.code };
    }
    if (Object.keys(changes).length === 0) return toSubjectDto(subject);

    const updated = await this.subjects.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'subject.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toSubjectDto(updated);
  }

  /**
   * No reference check in Phase 1: subject-teacher assignments keep pointing at the archived row,
   * so the history stays readable.
   */
  @Transactional()
  async archive(id: bigint, dto: ArchiveDto): Promise<SubjectDto> {
    const { schoolId, userId } = this.context.actor();
    const subject = await this.lock(schoolId, id);
    if (subject.deletedAt !== null) return toSubjectDto(subject);
    const updated = await this.subjects.archive(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'subject.archived',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {},
    });
    return toSubjectDto(updated);
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<SubjectRecord> {
    return readLocked(
      () => this.subjects.findById(schoolId, id),
      (row) => this.subjects.lockIfUnchanged(schoolId, row),
    );
  }
}
