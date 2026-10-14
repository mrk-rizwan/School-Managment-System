import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, DEFAULT_REQUIRED_DOCUMENT_TYPES, DOCUMENT_TYPES, ErrorCode, type DocumentType } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import { addDays, assertRange, SchoolClock } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import {
  StudentDocumentRepository,
  type StudentDocumentRecord,
} from '../../repositories/student-document.repository';
import { StudentRepository } from '../../repositories/student.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { PermissionsService } from '../access/permissions.service';
import { fromDateString, toDateString } from '../academics/academics.shared';
import type { StudentDocumentDto } from './documents.dto';
import { toDocumentDto } from './documents.service';
import type {
  ChecklistStatus,
  DocumentChecklistDto,
  IncompleteAdmissionDto,
  IncompleteAdmissionsQueryDto,
  ListDocumentQueueQueryDto,
  MyDocumentChecklistDto,
  QueuedDocumentDto,
} from './verification.dto';

// Phase 5 slice 40 (contracts/slice-40.md §2; rule 36; R322-R325). Verification is a query on the
// student, never a gate (R324): nothing here is read by admission, enrolment or a status change.

/** The incomplete-admissions report's default window, and its widest (§2.4). */
export const INCOMPLETE_DEFAULT_DAYS = 90;
export const INCOMPLETE_MAX_DAYS = 3660;

/** How a family is told about a type (R322: fixed text, never the office's reason). */
const FAMILY_NAMES: Readonly<Record<DocumentType, string>> = {
  b_form: 'B-Form',
  photo: 'photo',
  previous_school_leaving: 'previous school leaving certificate',
  guardian_cnic: 'guardian CNIC copy',
  other: 'document',
};

export function familyNote(type: DocumentType, status: ChecklistStatus): string | null {
  if (status === 'rejected') return `Please re-upload the ${FAMILY_NAMES[type]}.`;
  if (status === 'missing') return `Please send the ${FAMILY_NAMES[type]} to the school office.`;
  return null;
}

export const documentAlreadyDecided = (row: StudentDocumentRecord): ApiException =>
  new ApiException(409, ErrorCode.DOCUMENT_ALREADY_DECIDED, 'This document has already been decided.', {
    documentId: row.id.toString(),
    status: row.status,
  });

/** R322: the same refusal as the student_documents_not_self trigger (constraints-phase5.ts). */
export const ownUpload = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'Nobody verifies or rejects a document they uploaded.', {
    reason: 'own_upload',
  });

// Every school has its settings row from creation; its absence is a data fault, not a 404.
const settingsMissing = () => new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');

/** A required type's status from the newest row of the type (R323). */
const statusOf = (row: StudentDocumentRecord | undefined): ChecklistStatus => row?.status ?? 'missing';

@Injectable()
export class DocumentVerificationService {
  constructor(
    private readonly context: SchoolContext,
    private readonly documents: StudentDocumentRepository,
    private readonly students: StudentRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * GET /documents (§2.1): the queue, oldest first by default, through the document.verify scope
   * (computed here, so the Approvals read, a @RequireStaff route, gets the same rows).
   */
  async queue(session: SchoolSessionContext, query: ListDocumentQueueQueryDto): Promise<Page<QueuedDocumentDto>> {
    const { schoolId, userId } = this.context.actor();
    const scope = await this.permissions.can(schoolId, session.access, Capability.DOCUMENT_VERIFY);
    if (!scope) return toPage([], query, 0);
    const { rows, total } = await this.documents.listQueue(schoolId, scope, {
      status: query.status ?? 'uploaded',
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      sort: query.sort ?? 'createdAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((row) => ({
        ...toDocumentDto(row),
        student: { id: row.studentId.toString(), ...row.student },
        ownUpload: row.uploadedBy === userId,
      })),
      query,
      total,
    );
  }

  @Transactional()
  async verify(session: SchoolSessionContext, id: bigint): Promise<StudentDocumentDto> {
    return this.decide(session, id, 'verified', null);
  }

  @Transactional()
  async reject(session: SchoolSessionContext, id: bigint, reason: string): Promise<StudentDocumentDto> {
    return this.decide(session, id, 'rejected', reason);
  }

  /** GET /students/:id/document-checklist (§2.3, R323). */
  async checklist(session: SchoolSessionContext, studentId: bigint): Promise<DocumentChecklistDto> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const { types, newest } = await this.newestFor(schoolId, scope, studentId);
    const items = types.map((type) => {
      const row = newest.get(type);
      return { type, status: statusOf(row), document: row ? toDocumentDto(row) : null };
    });
    return {
      studentId: studentId.toString(),
      items,
      complete: items.every((item) => item.status === 'verified'),
    };
  }

  /**
   * GET /me/children/:id/documents, GET /me/student/documents (§2.5): the family's checklist,
   * status and fixed text only. A child outside the capacity scope is 404.
   */
  async family(session: SchoolSessionContext, childId: bigint | null): Promise<MyDocumentChecklistDto> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const id = childId ?? (scope.kind === 'students' ? scope.ids[0] : undefined);
    if (id === undefined || scope.kind !== 'students' || !scope.ids.includes(id)) throw notFound();
    const { types, newest } = await this.newestFor(schoolId, scope, id);
    return {
      studentId: id.toString(),
      items: types.map((type) => {
        const status = statusOf(newest.get(type));
        return { type, status, note: familyNote(type, status) };
      }),
    };
  }

  /** GET /documents/incomplete-admissions (§2.4, R323). */
  async incompleteAdmissions(
    session: SchoolSessionContext,
    query: IncompleteAdmissionsQueryDto,
  ): Promise<Page<IncompleteAdmissionDto>> {
    const schoolId = this.context.schoolId;
    const to = query.admittedTo === undefined ? await this.clock.today(schoolId) : fromDateString(query.admittedTo);
    const from =
      query.admittedFrom === undefined ? addDays(to, -INCOMPLETE_DEFAULT_DAYS) : fromDateString(query.admittedFrom);
    assertRange(from, to, INCOMPLETE_MAX_DAYS, { field: 'admittedTo', from: 'admittedFrom' });
    const types = await this.requiredTypes(schoolId);
    const { rows, total } = await this.documents.incompleteAdmissions(schoolId, scopeOf(session), {
      from,
      to,
      types,
      sort: query.sort ?? 'admittedOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((r) => ({
        studentId: r.studentId.toString(),
        admissionNo: r.admissionNo,
        fullName: r.fullName,
        admittedOn: toDateString(r.admittedOn),
        className: r.className,
        sectionName: r.sectionName,
        missing: r.missing,
        awaiting: r.awaiting,
        rejected: r.rejected,
      })),
      query,
      total,
    );
  }

  /**
   * The list badge (§2.6): for each student of a page, whether a required type's newest row is
   * missing, awaiting or rejected. The documents are read through the caller's scope too.
   */
  async incompleteAmong(schoolId: SchoolId, scope: Scope, studentIds: readonly bigint[]): Promise<Set<bigint>> {
    if (studentIds.length === 0) return new Set();
    // A badge only: a school without its settings row (a data fault) reads the column default
    // rather than failing the students page.
    const types = await this.requiredTypes(schoolId, true);
    if (types.length === 0) return new Set();
    const verified = new Map<bigint, number>();
    for (const row of await this.documents.newestOfTypes(schoolId, scope, studentIds, types)) {
      if (row.status === 'verified') verified.set(row.studentId, (verified.get(row.studentId) ?? 0) + 1);
    }
    return new Set(studentIds.filter((id) => (verified.get(id) ?? 0) < types.length));
  }

  /**
   * §2.2, R322. The document is read through the caller's scope (404 outside it); a decided one is
   * final (409 DOCUMENT_ALREADY_DECIDED); the uploader never decides it (409
   * SELF_ACTION_FORBIDDEN own_upload, no sole-principal exception). One conditional update decides
   * it; a racing decision that got there first answers DOCUMENT_ALREADY_DECIDED. Nothing else
   * changes: no student, enrolment or status is touched (R324).
   */
  private async decide(
    session: SchoolSessionContext,
    id: bigint,
    status: 'verified' | 'rejected',
    reason: string | null,
  ): Promise<StudentDocumentDto> {
    const { schoolId, userId } = this.context.actor();
    const scope = scopeOf(session);
    const row = await this.documents.findById(schoolId, scope, id);
    if (!row) throw notFound();
    if (row.status !== 'uploaded') throw documentAlreadyDecided(row);
    if (row.uploadedBy === userId) throw ownUpload();
    if ((await this.documents.decide(schoolId, id, { status, by: userId, at: new Date(), reason })) === 0) {
      const now = await this.documents.findById(schoolId, scope, id);
      throw now ? documentAlreadyDecided(now) : notFound();
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: status === 'verified' ? 'document.verified' : 'document.rejected',
      subjectType: 'student_document',
      subjectId: id,
      ...(reason === null ? {} : { reason }),
      metadata: { studentId: row.studentId.toString(), type: row.type },
    });
    const decided = await this.documents.findById(schoolId, scope, id);
    if (!decided) throw notFound();
    return toDocumentDto(decided);
  }

  private async newestFor(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<{ types: DocumentType[]; newest: Map<DocumentType, StudentDocumentRecord> }> {
    if (!(await this.students.findById(schoolId, scope, studentId))) throw notFound();
    const types = await this.requiredTypes(schoolId);
    const rows = await this.documents.newestForStudent(schoolId, scope, studentId, types);
    return { types, newest: new Map(rows.map((row) => [row.type, row])) };
  }

  private async requiredTypes(schoolId: SchoolId, orDefault = false): Promise<DocumentType[]> {
    const settings = await this.settings.find(schoolId);
    if (!settings && !orDefault) throw settingsMissing();
    const required = settings?.requiredDocumentTypes ?? DEFAULT_REQUIRED_DOCUMENT_TYPES;
    return DOCUMENT_TYPES.filter((type) => required.includes(type));
  }
}
