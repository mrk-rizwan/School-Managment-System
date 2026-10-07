import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { DEFAULT_EXAM_MAX_MARKS, ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { toPage, type Page } from '../../common/pagination';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  ClassSubjectRepository,
  type ClassSubjectRecord,
} from '../../repositories/class-subject.repository';
import {
  ClassRepository,
  type ClassChanges,
  type ClassRecord,
} from '../../repositories/class.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { SectionRepository, type SectionRecord } from '../../repositories/section.repository';
import { SubjectRepository } from '../../repositories/subject.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { type ArchiveDto, type Changes, classArchived, yearClosed } from './academics.shared';
import type {
  ClassDto,
  ClassSubjectDto,
  ClassSubjectEntryDto,
  CopySectionsDto,
  CopySectionsResultDto,
  CreateClassDto,
  ListClassesQueryDto,
  ListClassSubjectsQueryDto,
  UpdateClassDto,
} from './classes.dto';
import { toSectionDto } from './sections.dto';

const SUBJECT = 'class';

export function toClassDto(row: ClassRecord): ClassDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    academicYearName: row.academicYearName,
    name: row.name,
    sortOrder: row.sortOrder,
    attendanceMode: row.attendanceMode,
    status: row.status,
    nextClassId: row.nextClassId?.toString() ?? null,
    nextClassName: row.nextClassName,
    isFinal: row.isFinal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toClassSubjectDto(row: ClassSubjectRecord): ClassSubjectDto {
  return {
    id: row.id.toString(),
    classId: row.classId.toString(),
    subjectId: row.subjectId.toString(),
    subjectName: row.subjectName,
    subjectCode: row.subjectCode,
    sortOrder: row.sortOrder,
    examMaxMarks: row.examMaxMarks,
  };
}

const yearNotFound = () =>
  fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');

/** Classes and copy-sections (contracts/slice-3.md §3). */
@Injectable()
export class ClassesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly sections: SectionRepository,
    private readonly audit: AuditLogRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  async list(query: ListClassesQueryDto): Promise<Page<ClassDto>> {
    const { rows, total } = await this.classes.list(this.context.schoolId, {
      ...(query.academicYearId === undefined
        ? {}
        : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'sortOrder',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toClassDto), query, total);
  }

  async get(id: bigint): Promise<ClassDto> {
    const row = await this.classes.findById(this.context.schoolId, id);
    if (!row) throw notFound();
    return toClassDto(row);
  }

  /** The class's live subjects in print order (contracts/slice-29.md §4). */
  async listSubjects(id: bigint, query: ListClassSubjectsQueryDto): Promise<Page<ClassSubjectDto>> {
    const { schoolId } = this.context;
    if (!(await this.classes.findById(schoolId, id))) throw notFound();
    const { rows, total } = await this.classSubjects.listForClass(schoolId, id, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      descending: query.sort === '-sortOrder',
    });
    return toPage(rows.map(toClassSubjectDto), query, total);
  }

  /** In a year not closed. A taken name is 409 CLASS_NAME_TAKEN (constraint mapper). */
  @Transactional()
  async create(dto: CreateClassDto): Promise<ClassDto> {
    const { schoolId, userId } = this.context.actor();
    const academicYearId = BigInt(dto.academicYearId);
    await this.lockOpenYear(schoolId, academicYearId, yearNotFound);
    const row = await this.classes.create(schoolId, {
      academicYearId,
      name: dto.name,
      sortOrder: dto.sortOrder ?? 0,
      attendanceMode: dto.attendanceMode,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'class.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { academicYearId: dto.academicYearId, name: row.name },
    });
    return toClassDto(row);
  }

  /**
   * Plain attributes under the class lock. The year changes only while the class has no section
   * (409 CLASS_YEAR_IMMUTABLE; trigger classes_academic_year_immutable is the database's line).
   * Neither the class's year nor the target year may be closed.
   */
  @Transactional()
  async update(id: bigint, dto: UpdateClassDto): Promise<ClassDto> {
    const { schoolId, userId } = this.context.actor();
    // The subject list belongs to the class's year: moving the year and replacing the list in one
    // request would leave the list checked against one year and stored under the other.
    if (dto.academicYearId !== undefined && dto.subjects !== undefined) {
      throw fieldRefused(
        'subjects',
        ErrorCode.INVALID_VALUE,
        'Change the year and the subjects in separate requests',
      );
    }
    const row = await this.lockClass(schoolId, id);
    if (row.status === 'archived') throw classArchived();

    const target = dto.academicYearId === undefined ? undefined : BigInt(dto.academicYearId);
    const movesYear = target !== undefined && target !== row.academicYearId;
    // Both years locked in id order, so two moves in opposite directions cannot deadlock.
    const yearIds = movesYear
      ? [row.academicYearId, target].sort((a, b) => (a < b ? -1 : 1))
      : [row.academicYearId];
    for (const yearId of yearIds) {
      await this.lockOpenYear(schoolId, yearId, yearNotFound);
    }
    // Any enrolment of the class names one of its sections, and sections are never deleted, so
    // this also refuses a class with enrolments (contracts/slice-6.md §9).
    if (movesYear && (await this.sections.existsForClass(schoolId, id))) {
      throw new ApiException(
        409,
        ErrorCode.CLASS_YEAR_IMMUTABLE,
        'The academic year of a class cannot change once it has sections.',
        { field: 'academicYearId' },
      );
    }

    const data: ClassChanges = {};
    const changes: Changes = {};
    if (movesYear) {
      data.academicYearId = target;
      changes.academicYearId = { from: row.academicYearId.toString(), to: target.toString() };
    }
    if (dto.name !== undefined && dto.name !== row.name) {
      data.name = dto.name;
      changes.name = { from: row.name, to: dto.name };
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== row.sortOrder) {
      data.sortOrder = dto.sortOrder;
      changes.sortOrder = { from: row.sortOrder, to: dto.sortOrder };
    }
    if (dto.attendanceMode !== undefined && dto.attendanceMode !== row.attendanceMode) {
      data.attendanceMode = dto.attendanceMode;
      changes.attendanceMode = { from: row.attendanceMode, to: dto.attendanceMode };
    }
    await this.promotionLinkChanges(schoolId, row, dto, data, changes);
    if (dto.subjects !== undefined) await this.replaceSubjects(schoolId, userId, row, dto.subjects, dto.reason);
    if (Object.keys(changes).length === 0) return toClassDto(row);

    const updated = await this.classes.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'class.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toClassDto(updated);
  }

  /**
   * nextClassId and isFinal (rule 30, phase-4-academic.md §3.2 "Classes"): the next class is
   * another class of the school, not archived (its year is checked when a promotion sheet opens);
   * a final class has none (CHECK classes_next_class_check is the database's line).
   */
  private async promotionLinkChanges(
    schoolId: SchoolId,
    row: ClassRecord,
    dto: UpdateClassDto,
    data: ClassChanges,
    changes: Changes,
  ): Promise<void> {
    const next =
      dto.nextClassId === undefined ? undefined : dto.nextClassId === null ? null : BigInt(dto.nextClassId);
    if (next !== undefined && next !== row.nextClassId) {
      if (next !== null) {
        const target = await this.classes.findById(schoolId, next);
        if (!target || next === row.id) {
          throw fieldRefused('nextClassId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class');
        }
        if (target.status === 'archived') {
          throw fieldRefused('nextClassId', ErrorCode.INVALID_VALUE, 'The next class is archived');
        }
      }
      data.nextClassId = next;
      changes.nextClassId = { from: row.nextClassId?.toString() ?? null, to: next?.toString() ?? null };
    }
    if (dto.isFinal !== undefined && dto.isFinal !== row.isFinal) {
      data.isFinal = dto.isFinal;
      changes.isFinal = { from: String(row.isFinal), to: String(dto.isFinal) };
    }
    const finalAfter = data.isFinal ?? row.isFinal;
    const nextAfter = data.nextClassId === undefined ? row.nextClassId : data.nextClassId;
    if (finalAfter && nextAfter !== null) {
      throw fieldRefused('isFinal', ErrorCode.INVALID_VALUE, 'A final class has no next class');
    }
  }

  /**
   * The class's whole subject list (contracts/slice-29.md §4, R257): listed subjects are added or
   * re-ordered, a live subject left out is archived (a reason is required). The checks that need
   * later tables arrive with them: CLASS_SUBJECT_IN_USE (marks, results; waves N and O) and
   * CLASS_SUBJECTS_FROZEN (a submitted or approved sheet; wave O). The caller holds the class and
   * year locks. One audit row when anything changed.
   */
  private async replaceSubjects(
    schoolId: SchoolId,
    userId: bigint,
    row: ClassRecord,
    entries: readonly ClassSubjectEntryDto[],
    reason: string | undefined,
  ): Promise<void> {
    const wanted = entries.map((e) => ({
      subjectId: BigInt(e.subjectId),
      sortOrder: e.sortOrder,
      examMaxMarks: e.examMaxMarks ?? DEFAULT_EXAM_MAX_MARKS,
    }));
    const ids = wanted.map((w) => w.subjectId);
    const duplicate = ids.findIndex((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== -1) {
      throw fieldRefused(`subjects[${duplicate}].subjectId`, ErrorCode.INVALID_VALUE, 'A subject is listed twice');
    }
    const live = await this.subjects.liveIds(schoolId, ids);
    const missing = ids.findIndex((id) => !live.has(id));
    if (missing !== -1) {
      throw fieldRefused(`subjects[${missing}].subjectId`, ErrorCode.REFERENCE_NOT_FOUND, 'No such subject');
    }

    const current = await this.classSubjects.liveForClass(schoolId, row.id);
    const removed = current.filter((c) => !ids.includes(c.subjectId));
    if (removed.length > 0 && reason === undefined) {
      throw fieldRefused('reason', ErrorCode.INVALID_VALUE, 'A reason is required when a subject is removed');
    }
    let added = 0;
    let changed = 0;
    for (const w of wanted) {
      const existing = current.find((c) => c.subjectId === w.subjectId);
      if (!existing) {
        await this.classSubjects.create(schoolId, { academicYearId: row.academicYearId, classId: row.id, ...w });
        added += 1;
      } else if (existing.sortOrder !== w.sortOrder || existing.examMaxMarks !== w.examMaxMarks) {
        await this.classSubjects.update(schoolId, existing.id, {
          sortOrder: w.sortOrder,
          examMaxMarks: w.examMaxMarks,
        });
        changed += 1;
      }
    }
    await this.classSubjects.archive(
      schoolId,
      removed.map((r) => r.id),
      userId,
    );
    if (added + changed + removed.length === 0) return;
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'class.subjects_updated',
      subjectType: SUBJECT,
      subjectId: row.id,
      ...(removed.length > 0 && reason !== undefined ? { reason } : {}),
      metadata: {
        added,
        changed,
        removed: removed.length,
        removedSubjectIds: removed.map((r) => r.subjectId.toString()).join(','),
      },
    });
  }

  /** Final (no unarchive in v1). Refused while an active enrolment references it (slice 6). */
  @Transactional()
  async archive(id: bigint, dto: ArchiveDto): Promise<ClassDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lockClass(schoolId, id);
    if (row.status === 'archived') return toClassDto(row);
    await this.assertNoActiveEnrolments(schoolId, id);
    const archived = await this.classes.archive(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'class.archived',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {},
    });
    return toClassDto(archived);
  }

  /**
   * Copies every live section of `fromClassId` (name, capacity) that the target lacks a live
   * section of that name for. The target is locked, so a repeat or a concurrent copy creates
   * nothing twice. One audit row when anything was created.
   */
  @Transactional()
  async copySections(id: bigint, dto: CopySectionsDto): Promise<CopySectionsResultDto> {
    const { schoolId, userId } = this.context.actor();
    const fromClassId = BigInt(dto.fromClassId);
    if (fromClassId === id) {
      throw fieldRefused(
        'fromClassId',
        ErrorCode.INVALID_VALUE,
        'fromClassId must be another class',
      );
    }
    await this.lockOpenClass(schoolId, id);
    const source = await this.classes.findById(schoolId, fromClassId);
    if (!source) {
      throw fieldRefused('fromClassId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class');
    }

    const existing = new Set((await this.sections.listLive(schoolId, id)).map((s) => s.name));
    const created: SectionRecord[] = [];
    const skippedNames: string[] = [];
    for (const section of await this.sections.listLive(schoolId, fromClassId)) {
      if (existing.has(section.name)) {
        skippedNames.push(section.name);
        continue;
      }
      created.push(
        await this.sections.create(schoolId, {
          classId: id,
          name: section.name,
          capacity: section.capacity,
        }),
      );
    }
    if (created.length > 0) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'class.sections_copied',
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { fromClassId: dto.fromClassId, created: created.length },
      });
    }
    return { created: created.map(toSectionDto), skippedNames };
  }

  /**
   * Locks a class that accepts changes (new sections, section edits, copies): it exists, is
   * active, and its year is not closed. Both rows stay locked to the end of the transaction.
   */
  async lockOpenClass(schoolId: SchoolId, id: bigint): Promise<ClassRecord> {
    const row = await this.lockClass(schoolId, id);
    if (row.status === 'archived') throw classArchived();
    await this.lockOpenYear(schoolId, row.academicYearId, notFound);
    return row;
  }

  /**
   * 409 CLASS_HAS_ACTIVE_ENROLMENTS while an active enrolment references the class. Inside
   * archive's transaction and under the class's row lock; enrolling into the class locks it too
   * (EnrolmentsService.lockTarget).
   */
  async assertNoActiveEnrolments(schoolId: SchoolId, classId: bigint): Promise<void> {
    if (await this.enrolments.hasActiveInClass(schoolId, classId)) {
      throw new ApiException(
        409,
        ErrorCode.CLASS_HAS_ACTIVE_ENROLMENTS,
        'This class still has students enrolled.',
      );
    }
  }

  private lockClass(schoolId: SchoolId, id: bigint): Promise<ClassRecord> {
    return readLocked(
      () => this.classes.findById(schoolId, id),
      (row) => this.classes.lockIfUnchanged(schoolId, row),
    );
  }

  private async lockOpenYear(
    schoolId: SchoolId,
    id: bigint,
    missing: () => ApiException,
  ): Promise<void> {
    const year = await readLocked(
      () => this.years.findById(schoolId, id),
      (row) => this.years.lockIfUnchanged(schoolId, row),
      missing,
    );
    if (year.status === 'closed') throw yearClosed();
  }
}
