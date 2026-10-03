import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  Capability,
  ErrorCode,
  READMISSIBLE_STATUSES,
  STUDENT_STATUS_TRANSITIONS,
  type StudentStatus,
} from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { bFormAad, identityHash, maskIdentityNumber } from '../../../common/identity';
import { readLocked } from '../../../common/locking';
import { toPage, type Page, type PageQueryDto } from '../../../common/pagination';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository, type AuditEntry } from '../../../repositories/audit-log.repository';
import {
  EnrolmentRepository,
  type EnrolmentView,
} from '../../../repositories/enrolment.repository';
import { SessionRepository } from '../../../repositories/session.repository';
import { StudentStatusChangeRepository } from '../../../repositories/student-status-change.repository';
import {
  StudentRepository,
  type StudentChanges,
  type StudentRecord,
} from '../../../repositories/student.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import type { Scope } from '../../../tenancy/scope';
import { SchoolClock } from '../../../common/school-clock';
import type {
  ChangeStatusDto,
  EnrolmentDto,
  ListStudentsQueryDto,
  StatusChangeDto,
  StudentDetailDto,
  StudentDto,
  StudentLookupDto,
  StudentLookupResultDto,
  UpdateStudentDto,
} from './students.dto';
import {
  assertDateOfBirth,
  assertNotFuture,
  B_FORM_UNIQUE,
  illegalTransition,
  studentBFormExists,
} from './students.shared';
import { fromDateString, toDateString } from '../../academics/academics.shared';

// contracts/slice-6.md §3.1-§3.6. B-Form digits live only in request bodies and in memory here:
// stored encrypted with their lookup hash, returned masked to student.update holders only, never
// logged or audited. Every read and write of a student takes the caller's Scope (§1).

type AuditMetadata = NonNullable<AuditEntry['metadata']>;
/** The capabilities the caller holds: some fields are nulled without them (contract decision 2). */
export type Held = ReadonlySet<Capability>;

const SUBJECT = 'student';

const CLOSES_ENROLMENT: readonly StudentStatus[] = ['withdrawn', 'transferred'];

export const toEnrolmentDto = (row: EnrolmentView): EnrolmentDto => ({
  id: row.id.toString(),
  studentId: row.studentId.toString(),
  academicYearId: row.academicYearId.toString(),
  academicYearName: row.academicYearName,
  classId: row.classId.toString(),
  className: row.className,
  sectionId: row.sectionId.toString(),
  sectionName: row.sectionName,
  rollNo: row.rollNo,
  status: row.status,
  startedOn: toDateString(row.startedOn),
  endedOn: row.endedOn === null ? null : toDateString(row.endedOn),
});

@Injectable()
export class StudentsService {
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly students: StudentRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly statusChanges: StudentStatusChangeRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    private readonly clock: SchoolClock,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  async list(
    session: SchoolSessionContext,
    query: ListStudentsQueryDto,
  ): Promise<Page<StudentDto>> {
    const schoolId = this.context.schoolId;
    const id = (value: string | undefined) => (value === undefined ? undefined : BigInt(value));
    const academicYearId = id(query.academicYearId);
    const classId = id(query.classId);
    const sectionId = id(query.sectionId);
    const { rows, total } = await this.students.list(schoolId, scopeOf(session), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(academicYearId === undefined ? {} : { academicYearId }),
      ...(classId === undefined ? {} : { classId }),
      ...(sectionId === undefined ? {} : { sectionId }),
      ...(query.gender === undefined ? {} : { gender: query.gender }),
      ...(query.hasBForm === undefined ? {} : { hasBForm: query.hasBForm }),
      ...(query.hasLogin === undefined ? {} : { hasLogin: query.hasLogin }),
      ...(query.admittedOnFrom === undefined
        ? {}
        : { admittedOnFrom: fromDateString(query.admittedOnFrom) }),
      ...(query.admittedOnTo === undefined
        ? {}
        : { admittedOnTo: fromDateString(query.admittedOnTo) }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'fullName',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, session, rows), query, total);
  }

  async get(session: SchoolSessionContext, id: bigint): Promise<StudentDetailDto> {
    const schoolId = this.context.schoolId;
    const row = await this.require(schoolId, scopeOf(session), id);
    return this.toDetailDto(schoolId, session, row);
  }

  /** By B-Form hash: at most one hit (unique per school). Not audited; nothing logged. */
  async lookup(
    session: SchoolSessionContext,
    dto: StudentLookupDto,
  ): Promise<StudentLookupResultDto> {
    const schoolId = this.context.schoolId;
    const hit = await this.students.findByBFormHash(
      schoolId,
      identityHash(dto.bForm, this.hashKey),
    );
    if (!hit) return { data: [], truncated: false };
    const [student] = await this.toDtos(schoolId, session, [hit]);
    return {
      data: student ? [{ student, readmissible: READMISSIBLE_STATUSES.includes(hit.status) }] : [],
      truncated: false,
    };
  }

  async update(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateStudentDto,
  ): Promise<StudentDetailDto> {
    const actor = this.context.actor();
    const bForm = dto.bForm === undefined ? undefined : this.identity(dto.bForm);
    try {
      return await this.updateInTransaction(actor, session, id, dto, bForm);
    } catch (error) {
      throw await this.bFormConflict(actor.schoolId, error, bForm ?? null);
    }
  }

  /**
   * R36 on the locked row (contract §3.6). Leaving `active` revokes the student login's sessions:
   * the student capacity requires an active student (§9).
   */
  @Transactional()
  async changeStatus(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeStatusDto,
  ): Promise<StudentDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, scopeOf(session), id);
    const from = row.status;
    const to = dto.status;
    if (READMISSIBLE_STATUSES.includes(from) && to === 'active') {
      throw illegalTransition(
        { from, to, hint: 'readmit' },
        'A student who has left returns through readmission.',
      );
    }
    if (!STUDENT_STATUS_TRANSITIONS[from].includes(to)) {
      throw illegalTransition({ from, to }, `A ${from} student cannot become ${to}.`);
    }

    const effectiveOn = fromDateString(dto.effectiveOn);
    assertNotFuture(effectiveOn, await this.clock.today(schoolId), 'effectiveOn');
    const active = await this.enrolments.findActiveForStudent(schoolId, scopeOf(session), id);
    const last = await this.statusChanges.latestForStudent(schoolId, id);
    const notBefore = [row.admittedOn, active?.startedOn, last?.effectiveOn].reduce<Date>(
      (latest, date) => (date !== undefined && date > latest ? date : latest),
      row.admittedOn,
    );
    if (effectiveOn < notBefore) {
      throw fieldRefused(
        'effectiveOn',
        ErrorCode.INVALID_VALUE,
        `effectiveOn must be on or after ${toDateString(notBefore)} (admission, current enrolment or last status change)`,
      );
    }

    let enrolmentClosed = false;
    if (CLOSES_ENROLMENT.includes(to) && active) {
      enrolmentClosed = (await this.enrolments.close(schoolId, active.id, effectiveOn)) === 1;
    }
    const updated = await this.students.update(schoolId, id, { status: to });
    await this.statusChanges.record(schoolId, {
      studentId: id,
      fromStatus: from,
      toStatus: to,
      reason: dto.reason,
      changedBy: userId,
      effectiveOn,
    });
    if (from === 'active' && row.userId !== null) {
      await this.sessions.revokeAllForUser(schoolId, row.userId, new Date());
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'student.status_changed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { from, to, effectiveOn: dto.effectiveOn, enrolmentClosed },
    });
    return this.toDetailDto(schoolId, session, updated);
  }

  async statusChangeList(
    session: SchoolSessionContext,
    id: bigint,
    query: PageQueryDto,
  ): Promise<Page<StatusChangeDto>> {
    const schoolId = this.context.schoolId;
    await this.require(schoolId, scopeOf(session), id);
    const { rows, total } = await this.statusChanges.listForStudent(schoolId, scopeOf(session), id, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((row) => ({
        id: row.id.toString(),
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        reason: row.reason,
        effectiveOn: toDateString(row.effectiveOn),
        changedBy: row.changedBy.toString(),
        changedByName: row.changedByName,
        createdAt: row.createdAt,
      })),
      query,
      total,
    );
  }

  /** The student in scope, or 404 (absent and out of scope look the same, contract §1). */
  async require(schoolId: SchoolId, scope: Scope, id: bigint): Promise<StudentRecord> {
    const row = await this.students.findById(schoolId, scope, id);
    if (!row) throw notFound();
    return row;
  }

  /**
   * Reads the student in scope, locks it if unchanged since the read (readLocked), and reads it
   * again under the lock: its login lives on users and does not move updated_at. Every write to
   * a student, its guardian links or its enrolments takes this lock first, so R28/R29 and the
   * one-active-enrolment rule are decided on current data. Call inside a transaction.
   */
  async lock(schoolId: SchoolId, scope: Scope, id: bigint): Promise<StudentRecord> {
    await readLocked(
      () => this.students.findById(schoolId, scope, id),
      (row) => this.students.lockIfUnchanged(schoolId, row),
    );
    return this.require(schoolId, scope, id);
  }

  /**
   * StudentDto for a page of rows, with each one's active enrolment (one batched read, through the
   * caller's scope). Field visibility follows the caller's capabilities.
   */
  async toDtos(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    rows: StudentRecord[],
  ): Promise<StudentDto[]> {
    const held = session.access.capabilities;
    const current = new Map(
      (
        await this.enrolments.activeForStudents(
          schoolId,
          scopeOf(session),
          rows.map((r) => r.id),
        )
      ).map((e) => [e.studentId, e]),
    );
    return rows.map((row) => this.toDto(schoolId, held, row, current.get(row.id) ?? null));
  }

  async toDetailDto(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    row: StudentRecord,
  ): Promise<StudentDetailDto> {
    const held = session.access.capabilities;
    const [dto] = await this.toDtos(schoolId, session, [row]);
    if (!dto) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    const photo = held.has(Capability.DOCUMENT_VIEW)
      ? await this.students.latestPhotoDocumentId(schoolId, row.id)
      : null;
    return {
      ...dto,
      notes: held.has(Capability.STUDENT_UPDATE) ? row.notes : null,
      photoDocumentId: photo?.toString() ?? null,
    };
  }

  private toDto(
    schoolId: SchoolId,
    held: Held,
    row: StudentRecord,
    current: EnrolmentView | null,
  ): StudentDto {
    return {
      id: row.id.toString(),
      admissionNo: row.admissionNo,
      fullName: row.fullName,
      gender: row.gender,
      dateOfBirth: toDateString(row.dateOfBirth),
      hasBForm: row.bForm !== null,
      bFormMasked:
        row.bForm === null || !held.has(Capability.STUDENT_UPDATE)
          ? null
          : maskIdentityNumber(this.encryption.decrypt(row.bForm, bFormAad(schoolId))),
      status: row.status,
      admittedOn: toDateString(row.admittedOn),
      current: current && {
        enrolmentId: current.id.toString(),
        academicYearId: current.academicYearId.toString(),
        academicYearName: current.academicYearName,
        classId: current.classId.toString(),
        className: current.className,
        sectionId: current.sectionId.toString(),
        sectionName: current.sectionName,
        rollNo: current.rollNo,
      },
      userId: row.userId?.toString() ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Decided under the row lock. Nothing actually changing is no write and no audit row. The audit
   * records that the B-Form or notes changed, never their value.
   */
  @Transactional()
  private async updateInTransaction(
    actor: Actor,
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateStudentDto,
    bForm: Identity | null | undefined,
  ): Promise<StudentDetailDto> {
    const { schoolId } = actor;
    const row = await this.lock(schoolId, scopeOf(session), id);
    if (bForm !== undefined && row.userId !== null) {
      throw new ApiException(
        409,
        ErrorCode.STUDENT_BFORM_LOCKED,
        'The B-Form number cannot be changed once the student has a login: it is the username.',
      );
    }

    const data: StudentChanges = {};
    const changes: Record<string, AuditMetadata[string]> = {};
    if (dto.fullName !== undefined && dto.fullName !== row.fullName) {
      data.fullName = dto.fullName;
      changes.fullName = { from: row.fullName, to: dto.fullName };
    }
    if (dto.gender !== undefined && dto.gender !== row.gender) {
      data.gender = dto.gender;
      changes.gender = { from: row.gender, to: dto.gender };
    }
    if (dto.dateOfBirth !== undefined && dto.dateOfBirth !== toDateString(row.dateOfBirth)) {
      const dateOfBirth = fromDateString(dto.dateOfBirth);
      assertDateOfBirth(dateOfBirth, await this.clock.today(schoolId));
      if (dateOfBirth >= row.admittedOn) {
        throw fieldRefused(
          'dateOfBirth',
          ErrorCode.INVALID_VALUE,
          'dateOfBirth must be before the admission date',
        );
      }
      data.dateOfBirth = dateOfBirth;
      changes.dateOfBirth = { from: toDateString(row.dateOfBirth), to: dto.dateOfBirth };
    }
    if (bForm !== undefined && (bForm?.hash ?? null) !== row.bFormHash) {
      if (bForm) await this.assertBFormFree(schoolId, bForm, row.id);
      data.bForm = bForm && this.encryption.encrypt(bForm.digits, bFormAad(schoolId));
      data.bFormHash = bForm?.hash ?? null;
      changes.bForm = { changed: true };
    }
    if (dto.notes !== undefined && dto.notes !== row.notes) {
      data.notes = dto.notes;
      changes.notes = { changed: true };
    }
    if (Object.keys(changes).length === 0) return this.toDetailDto(schoolId, session, row);

    const updated = await this.students.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'student.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return this.toDetailDto(schoolId, session, updated);
  }

  /** R25: refuses a B-Form already on another student of the school, pointing at it. */
  private async assertBFormFree(schoolId: SchoolId, bForm: Identity, self: bigint): Promise<void> {
    const holder = await this.students.findByBFormHash(schoolId, bForm.hash);
    if (holder && holder.id !== self) {
      throw studentBFormExists({ studentId: holder.id.toString() });
    }
  }

  /**
   * The race loser of two writes of one B-Form: the unique violation aborted its transaction, so
   * the winner is read here in a fresh statement and the same 409 returned.
   */
  private async bFormConflict(
    schoolId: SchoolId,
    error: unknown,
    bForm: Identity | null,
  ): Promise<unknown> {
    if (bForm === null || summariseDatabaseError(error)?.constraint !== B_FORM_UNIQUE) return error;
    const holder = await this.students.findByBFormHash(schoolId, bForm.hash);
    return holder ? studentBFormExists({ studentId: holder.id.toString() }) : error;
  }

  /** The DTO has already normalised the input to 13 digits. */
  private identity(digits: string | null): Identity | null {
    return digits === null ? null : { digits, hash: identityHash(digits, this.hashKey) };
  }
}

interface Identity {
  digits: string;
  hash: string;
}
