import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { toPage, type Page } from '../../common/pagination';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { SectionRepository, type SectionRecord } from '../../repositories/section.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { SchoolClock } from '../../common/school-clock';
import type { ArchiveDto, Changes } from './academics.shared';
import { ClassesService } from './classes.service';
import {
  toSectionDto,
  type CreateSectionDto,
  type ListSectionsQueryDto,
  type SectionDto,
  type UpdateSectionDto,
} from './sections.dto';

const SUBJECT = 'section';

/** Sections (contracts/slice-3.md §4). */
@Injectable()
export class SectionsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly classesService: ClassesService,
    private readonly audit: AuditLogRepository,
    private readonly enrolments: EnrolmentRepository,
    // Slice 4; both from the global AccessModule.
    private readonly assignments: TeacherAssignmentRepository,
    private readonly clock: SchoolClock,
  ) {}

  async listForClass(classId: bigint, query: ListSectionsQueryDto): Promise<Page<SectionDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.classes.findById(schoolId, classId))) throw notFound();
    const { rows, total } = await this.sections.listForClass(schoolId, classId, {
      includeArchived: query.includeArchived ?? false,
      sort: query.sort ?? 'name',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toSectionDto), query, total);
  }

  /** Archived sections are returned: the history follows the section. */
  async get(id: bigint): Promise<SectionDto> {
    const section = await this.sections.findById(this.context.schoolId, id);
    if (!section) throw notFound();
    return toSectionDto(section);
  }

  /** In an active class of a year not closed. A taken live name is 409 SECTION_NAME_TAKEN. */
  @Transactional()
  async create(classId: bigint, dto: CreateSectionDto): Promise<SectionDto> {
    const { schoolId, userId } = this.context.actor();
    await this.classesService.lockOpenClass(schoolId, classId);
    const section = await this.sections.create(schoolId, {
      classId,
      name: dto.name,
      capacity: dto.capacity ?? null,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'section.created',
      subjectType: SUBJECT,
      subjectId: section.id,
      metadata: { classId: classId.toString(), name: section.name },
    });
    return toSectionDto(section);
  }

  /**
   * Name and capacity (null clears). An archived section is frozen; so is every section of an
   * archived class or of a class in a closed year (contract decision 5).
   */
  @Transactional()
  async update(id: bigint, dto: UpdateSectionDto): Promise<SectionDto> {
    const { schoolId, userId } = this.context.actor();
    const section = await this.lock(schoolId, id);
    if (section.deletedAt !== null) throw archived();
    await this.classesService.lockOpenClass(schoolId, section.classId);

    const data: { name?: string; capacity?: number | null } = {};
    const changes: Changes = {};
    if (dto.name !== undefined && dto.name !== section.name) {
      data.name = dto.name;
      changes.name = { from: section.name, to: dto.name };
    }
    if (dto.capacity !== undefined && dto.capacity !== section.capacity) {
      data.capacity = dto.capacity;
      changes.capacity = { from: section.capacity, to: dto.capacity };
    }
    if (Object.keys(changes).length === 0) return toSectionDto(section);

    const updated = await this.sections.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'section.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toSectionDto(updated);
  }

  /**
   * Sets the archive mark. Its name may then be reused by a new section of the class. Like an
   * edit, refused in an archived class or a closed year (contract decision 5); archiving an
   * already archived section is a no-op.
   */
  @Transactional()
  async archive(id: bigint, dto: ArchiveDto): Promise<SectionDto> {
    const { schoolId, userId } = this.context.actor();
    const section = await this.lock(schoolId, id);
    if (section.deletedAt !== null) return toSectionDto(section);
    await this.classesService.lockOpenClass(schoolId, section.classId);
    await this.assertSectionUnused(schoolId, id);
    const updated = await this.sections.archive(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'section.archived',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {},
    });
    return toSectionDto(updated);
  }

  /**
   * 409 SECTION_IN_USE while an active enrolment (slice 6) or a teacher assignment not yet ended
   * (`ends_on IS NULL OR ends_on >= today`, slice 4) references the section. Inside archive's
   * transaction and under the section's row lock; enrolling into a section locks it too
   * (EnrolmentsService.lockTarget), so neither can slip in between.
   */
  async assertSectionUnused(schoolId: SchoolId, sectionId: bigint): Promise<void> {
    if (await this.enrolments.hasActiveInSection(schoolId, sectionId)) throw sectionInUse();
    await this.assertNoLiveAssignments(schoolId, sectionId);
  }

  /**
   * contracts/slice-4.md §4.5: a live teacher assignment on the section not ended before today.
   * An assignment insert locks the section's class first and archive holds that lock here, so
   * none can slip in between.
   */
  private async assertNoLiveAssignments(schoolId: SchoolId, sectionId: bigint): Promise<void> {
    const today = await this.clock.today(schoolId);
    if (await this.assignments.existsNotEndedOnSection(schoolId, sectionId, today)) {
      throw sectionInUse();
    }
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<SectionRecord> {
    return readLocked(
      () => this.sections.findById(schoolId, id),
      (row) => this.sections.lockIfUnchanged(schoolId, row),
    );
  }
}

const sectionInUse = () =>
  new ApiException(409, ErrorCode.SECTION_IN_USE, 'This section is still in use.');

const archived = () =>
  new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'An archived section cannot be changed.');
