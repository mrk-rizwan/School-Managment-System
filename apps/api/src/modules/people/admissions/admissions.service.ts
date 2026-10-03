import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { createHmac } from 'node:crypto';
import { Capability, ErrorCode, READMISSIBLE_STATUSES } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException, fieldRefused } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { bFormAad, guardianCnicAad, identityHash } from '../../../common/identity';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../../repositories/enrolment.repository';
import { GuardianRepository, type GuardianRecord } from '../../../repositories/guardian.repository';
import {
  IDEMPOTENCY_KEY_UNIQUE,
  IdempotencyKeyRepository,
  type IdempotencyKeyRecord,
} from '../../../repositories/idempotency-key.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import {
  StagedUploadRepository,
  type StagedUploadRecord,
} from '../../../repositories/staged-upload.repository';
import { StudentDocumentRepository } from '../../../repositories/student-document.repository';
import { StudentGuardianRepository } from '../../../repositories/student-guardian.repository';
import { StudentStatusChangeRepository } from '../../../repositories/student-status-change.repository';
import { StudentRepository, type StudentRecord } from '../../../repositories/student.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import type { Scope } from '../../../tenancy/scope';
import { SchoolClock } from '../../../common/school-clock';
import {
  photoNotImage,
  stagedUploadUnusable,
  toDocumentDto,
} from '../../documents/documents.service';
import { isImageMime } from '../../documents/upload-processing';
import { guardianMerged, GuardiansService } from '../guardians/guardians.service';
import { EnrolmentsService } from '../students/enrolments.service';
import { GuardianLinksService } from '../students/guardian-links.service';
import { StudentsService, toEnrolmentDto } from '../students/students.service';
import {
  assertDateOfBirth,
  assertNotFuture,
  B_FORM_UNIQUE,
  primaryContactNeedsPhone,
  ROLL_NO_UNIQUE,
  rollNoTaken,
  studentBFormExists,
} from '../students/students.shared';
import type {
  AdmissionGuardianDto,
  AdmissionResultDto,
  CreateAdmissionDto,
  DuplicateMatch,
} from './admissions.dto';
import { fromDateString, toDateString } from '../../academics/academics.shared';

// contracts/slice-6.md §6.3, R33-R35, R82-R89, R97. One admission is one transaction whose first
// statement inserts the idempotency key; a refusal anywhere rolls everything back, key and
// admission number included (R87). A key-insert conflict is resolved outside the transaction
// (plan §3.3): the unique violation has aborted it, so the winner is read in a fresh statement.

const ENDPOINT = 'admissions';
/** Contract §6.3: generated once by the wizard; never 13 consecutive digits (R82). */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const GUARDIAN_CNIC_UNIQUE = 'guardians_school_id_cnic_hash_key';

export interface AdmissionOutcome {
  /** 201, or the stored status of the first, committed request (a replay). */
  status: number;
  replayed: boolean;
  result: AdmissionResultDto;
}

/** What admission needs about one submitted guardian once its references are resolved. */
interface ResolvedGuardian {
  index: number;
  dto: AdmissionGuardianDto;
  existing: GuardianRecord | null;
  newCnic: { digits: string; hash: string } | null;
}

const keyRefused = (message: string) =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path: 'Idempotency-Key', code: ErrorCode.INVALID_VALUE, message }],
  });

/** A 422 raised for a nested object, its field paths moved under `prefix`. */
export function underPath(prefix: string, error: unknown): unknown {
  if (!(error instanceof ApiException) || error.status !== 422 || !error.details) return error;
  const fields: unknown = error.details.fields;
  if (!Array.isArray(fields)) return error;
  return new ApiException(error.status, error.code, error.message, {
    ...error.details,
    fields: fields.map((field: unknown) =>
      typeof field === 'object' &&
      field !== null &&
      'path' in field &&
      typeof field.path === 'string'
        ? { ...field, path: field.path ? `${prefix}.${field.path}` : prefix }
        : field,
    ),
  });
}

/** JSON with object keys sorted at every depth and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, member]) => `${JSON.stringify(k)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

@Injectable()
export class AdmissionsService {
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly keys: IdempotencyKeyRepository,
    private readonly students: StudentRepository,
    private readonly studentsService: StudentsService,
    private readonly links: StudentGuardianRepository,
    private readonly linksService: GuardianLinksService,
    private readonly enrolments: EnrolmentRepository,
    private readonly enrolmentsService: EnrolmentsService,
    private readonly statusChanges: StudentStatusChangeRepository,
    private readonly guardians: GuardianRepository,
    private readonly guardiansService: GuardiansService,
    private readonly staged: StagedUploadRepository,
    private readonly documents: StudentDocumentRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    private readonly clock: SchoolClock,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  /**
   * Contract §6.3 steps 1-6. The guard has already checked student.create (step 1, R85); the
   * ValidationPipe the body's shape (step 2).
   */
  async admit(
    session: SchoolSessionContext,
    dto: CreateAdmissionDto,
    rawKey: string | undefined,
  ): Promise<AdmissionOutcome> {
    const actor = this.context.actor();
    this.assertMayWriteGuardians(session, dto);
    const key = this.parseKey(rawKey);
    const today = await this.clock.today(actor.schoolId);
    this.assertShape(dto, today);
    const requestHash = this.requestHash(dto);

    const stored = await this.keys.find(actor.schoolId, actor.userId, ENDPOINT, key);
    if (stored) return this.replay(session, stored, requestHash);

    const bFormHash = dto.student.bForm ? identityHash(dto.student.bForm, this.hashKey) : null;
    let studentId: bigint;
    try {
      studentId = await this.admitInTransaction(actor, scopeOf(session), dto, key, requestHash, today);
    } catch (error) {
      // Rolled back. R89: a racing same-key submit committed first; replay it (step 6).
      const constraint = summariseDatabaseError(error)?.constraint;
      if (constraint === IDEMPOTENCY_KEY_UNIQUE) {
        const winner = await this.keys.find(actor.schoolId, actor.userId, ENDPOINT, key);
        if (winner) return this.replay(session, winner, requestHash);
      }
      throw await this.conflictAfterRollback(
        actor.schoolId,
        scopeOf(session),
        error,
        constraint,
        bFormHash,
        dto,
      );
    }
    return { status: 201, replayed: false, result: await this.result(session, studentId) };
  }

  /**
   * The AdmissionResultDto of a committed admission, read fresh: the student, their current
   * enrolment, live guardian links, documents and what logins can be issued now. A replay
   * returns the same shape for the same student (R33).
   */
  async result(session: SchoolSessionContext, studentId: bigint): Promise<AdmissionResultDto> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const held = session.access.capabilities;
    const row = await this.studentsService.require(schoolId, scope, studentId);
    const student = await this.studentsService.toDetailDto(schoolId, session, row);
    const enrolment =
      (await this.enrolments.findActiveForStudent(schoolId, scope, studentId)) ??
      (await this.enrolments.listForStudent(schoolId, scope, studentId, { skip: 0, take: 1 }))
        .rows[0];
    if (!enrolment) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    const [view] = await this.enrolments.withNames(schoolId, [enrolment]);
    const links = await this.links.views(
      schoolId,
      await this.links.liveForStudent(schoolId, scope, studentId),
    );
    const documents = await this.documents.listAllForStudent(schoolId, scope, studentId);
    const settings = await this.settings.find(schoolId);
    if (!view) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return {
      student,
      enrolment: toEnrolmentDto(view),
      guardianLinks: links.map((link) => this.linksService.toDto(schoolId, held, link)),
      documents: documents.map(toDocumentDto),
      loginOffers: {
        student:
          (settings?.studentLoginEnabled ?? false) &&
          row.status === 'active' &&
          row.bForm !== null &&
          row.userId === null,
        guardians: links.map((link) => ({
          guardianId: link.guardianId.toString(),
          fullName: link.guardian.fullName,
          available: link.canLogin && link.guardian.cnic !== null && link.guardian.userId === null,
        })),
      },
    };
  }

  // ------------------------------------------------------------------------------ steps

  /**
   * Creating a guardian, or letting one log in, is guardian.manage's everywhere else (POST
   * /guardians, guardian links); admission under student.create alone does not bypass it. Linking
   * an existing guardian without a login needs only student.create. Before the key, as the guard.
   */
  private assertMayWriteGuardians(session: SchoolSessionContext, dto: CreateAdmissionDto): void {
    const writes = dto.guardians.some((g) => g.newGuardian !== undefined || g.canLogin);
    if (writes && !session.access.capabilities.has(Capability.GUARDIAN_MANAGE)) {
      throw new ApiException(
        403,
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to do this.',
      );
    }
  }

  private parseKey(raw: string | undefined): string {
    if (raw === undefined || raw === '') throw keyRefused('The Idempotency-Key header is required');
    if (!KEY_PATTERN.test(raw)) {
      throw keyRefused('Idempotency-Key must be 16-64 characters of A-Z, a-z, 0-9, _ and -');
    }
    if (/[0-9]{13}/.test(raw)) {
      throw keyRefused('Idempotency-Key must not contain 13 consecutive digits');
    }
    return raw;
  }

  /** Step 2's rules across fields (the DTO checks each field). Nothing is read or written. */
  private assertShape(dto: CreateAdmissionDto, today: Date): void {
    const { student, guardians } = dto;
    const dateOfBirth = fromDateString(student.dateOfBirth);
    const admittedOn =
      student.admittedOn === undefined ? today : fromDateString(student.admittedOn);
    assertNotFuture(admittedOn, today, 'student.admittedOn');
    assertDateOfBirth(dateOfBirth, today, 'student.dateOfBirth');
    if (dateOfBirth >= admittedOn) {
      throw fieldRefused(
        'student.dateOfBirth',
        ErrorCode.INVALID_VALUE,
        'dateOfBirth must be before the admission date',
      );
    }

    guardians.forEach((g, i) => {
      if ((g.guardianId === undefined) === (g.newGuardian === undefined)) {
        throw fieldRefused(
          `guardians[${i}]`,
          ErrorCode.INVALID_VALUE,
          'Give exactly one of guardianId and newGuardian',
        );
      }
    });
    if (guardians.filter((g) => g.isPrimaryContact).length !== 1) {
      throw fieldRefused(
        'guardians',
        ErrorCode.INVALID_VALUE,
        'Exactly one guardian must be the primary contact',
      );
    }
    if (!guardians.some((g) => g.isFeePayer)) {
      throw fieldRefused(
        'guardians',
        ErrorCode.INVALID_VALUE,
        'At least one guardian must be a fee payer',
      );
    }
    const firstRepeat = <T>(values: (T | undefined)[]): number => {
      const seen = new Set<T>();
      return values.findIndex((v) => {
        if (v === undefined) return false;
        if (seen.has(v)) return true;
        seen.add(v);
        return false;
      });
    };
    const repeatedId = firstRepeat(guardians.map((g) => g.guardianId));
    if (repeatedId >= 0) {
      throw fieldRefused(
        `guardians[${repeatedId}].guardianId`,
        ErrorCode.INVALID_VALUE,
        'This guardian is listed twice',
      );
    }
    const repeatedCnic = firstRepeat(guardians.map((g) => g.newGuardian?.cnic ?? undefined));
    if (repeatedCnic >= 0) {
      throw fieldRefused(
        `guardians[${repeatedCnic}].newGuardian.cnic`,
        ErrorCode.INVALID_VALUE,
        'This CNIC is listed twice',
      );
    }
    const repeatedUpload = firstRepeat((dto.documents ?? []).map((d) => d.stagedUploadId));
    if (repeatedUpload >= 0) {
      throw fieldRefused(
        `documents[${repeatedUpload}].stagedUploadId`,
        ErrorCode.INVALID_VALUE,
        'This upload is listed twice',
      );
    }
  }

  /**
   * HMAC-SHA256 under IDENTITY_HASH_KEY of `admissions|` + the canonical body without
   * acknowledgedDuplicateStudentIds (contract §6.3 step 3). The body holds identity digits; only
   * this hash is stored (R82).
   */
  private requestHash(dto: CreateAdmissionDto): string {
    const { acknowledgedDuplicateStudentIds: _ignored, ...hashed } = dto;
    return createHmac('sha256', Buffer.from(this.hashKey, 'base64'))
      .update(`${ENDPOINT}|${canonicalJson(hashed)}`)
      .digest('hex');
  }

  /** Step 4 / step 6: the same request replays the stored result; any other is refused (R83). */
  private async replay(
    session: SchoolSessionContext,
    stored: IdempotencyKeyRecord,
    requestHash: string,
  ): Promise<AdmissionOutcome> {
    if (stored.requestHash !== requestHash || stored.subjectId === null) {
      throw new ApiException(
        409,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different admission.',
      );
    }
    return {
      status: stored.responseStatus,
      replayed: true,
      result: await this.result(session, stored.subjectId),
    };
  }

  /**
   * A B-Form, guardian CNIC or roll number taken by a concurrent write since the in-transaction
   * check: the same 409 as that check, read in a fresh statement. Anything else passes through.
   */
  private async conflictAfterRollback(
    schoolId: SchoolId,
    scope: Scope,
    error: unknown,
    constraint: string | null | undefined,
    bFormHash: string | null,
    dto: CreateAdmissionDto,
  ): Promise<unknown> {
    if (constraint === B_FORM_UNIQUE && bFormHash !== null) {
      const holder = await this.students.findByBFormHash(schoolId, bFormHash);
      if (holder) return this.bFormExists(holder);
    }
    const rollNo = dto.enrolment.rollNo ?? null;
    if (constraint === ROLL_NO_UNIQUE && rollNo !== null) {
      const sectionId = BigInt(dto.enrolment.sectionId);
      const holder = await this.enrolments.findActiveByRollNo(schoolId, sectionId, rollNo);
      if (holder) return rollNoTaken(holder.id);
    }
    if (constraint === GUARDIAN_CNIC_UNIQUE) {
      for (const g of dto.guardians) {
        const cnic = g.newGuardian?.cnic;
        if (!cnic) continue;
        const refusal = await this.guardianCnicExists(scope, cnic);
        if (refusal) return refusal;
      }
    }
    return error;
  }

  @Transactional()
  private async admitInTransaction(
    actor: Actor,
    scope: Scope,
    dto: CreateAdmissionDto,
    key: string,
    requestHash: string,
    today: Date,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    // First statement (step 5): a concurrent same-key submit now waits on the unique index.
    const keyId = await this.keys.insert(schoolId, {
      userId,
      endpoint: ENDPOINT,
      key,
      requestHash,
      responseStatus: 201,
      subjectType: 'student',
    });

    // References in contract order (§6.3): guardians and staged uploads (the 422 shape
    // refusals), then the target class and section, locked. Guardians are locked before the
    // section, class and year; nothing locks those first and a guardian after.
    const guardians = await this.resolveGuardians(schoolId, dto.guardians);
    const uploads = await this.resolveUploads(schoolId, userId, dto);
    const classId = BigInt(dto.enrolment.classId);
    const sectionId = BigInt(dto.enrolment.sectionId);
    let academicYearId: bigint;
    try {
      ({ academicYearId } = (
        await this.enrolmentsService.lockTarget(schoolId, classId, sectionId)
      ).klass);
    } catch (error) {
      throw underPath('enrolment', error);
    }

    // Possible duplicate (R87, R88): only an existing primary guardian can match.
    const primary = guardians.find((g) => g.dto.isPrimaryContact);
    if (!primary) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    const dateOfBirth = fromDateString(dto.student.dateOfBirth);
    if (primary.existing) {
      await this.assertNoUnacknowledgedDuplicate(
        schoolId,
        scope,
        dto,
        dateOfBirth,
        primary.existing.id,
      );
    }

    // Refusals.
    const bForm = dto.student.bForm
      ? { digits: dto.student.bForm, hash: identityHash(dto.student.bForm, this.hashKey) }
      : null;
    if (bForm) {
      const holder = await this.students.findByBFormHash(schoolId, bForm.hash);
      if (holder) throw this.bFormExists(holder);
    }
    for (const g of guardians) {
      if (!g.newCnic) continue;
      const refusal = await this.guardianCnicExists(scope, g.newCnic.digits);
      if (refusal) throw refusal;
    }
    const primaryPhone = primary.existing
      ? primary.existing.phone
      : (primary.dto.newGuardian?.phone ?? null);
    if (primaryPhone === null) throw primaryContactNeedsPhone();
    const rollNo = dto.enrolment.rollNo ?? null;
    if (rollNo !== null) {
      const holder = await this.enrolments.findActiveByRollNo(schoolId, sectionId, rollNo);
      if (holder) throw rollNoTaken(holder.id);
    }

    // Writes.
    const admittedOn =
      dto.student.admittedOn === undefined ? today : fromDateString(dto.student.admittedOn);
    const student = await this.students.create(schoolId, {
      admissionNo: await this.students.nextAdmissionNo(schoolId),
      fullName: dto.student.fullName,
      gender: dto.student.gender,
      dateOfBirth,
      bForm: bForm && this.encryption.encrypt(bForm.digits, bFormAad(schoolId)),
      bFormHash: bForm?.hash ?? null,
      admittedOn,
      notes: dto.student.notes ?? null,
    });
    const newGuardianIds: string[] = [];
    const linkedGuardianIds: string[] = [];
    for (const g of guardians) {
      const guardianId = g.existing ? g.existing.id : await this.createGuardian(actor, g);
      (g.existing ? linkedGuardianIds : newGuardianIds).push(guardianId.toString());
      await this.links.create(schoolId, {
        studentId: student.id,
        guardianId,
        relationship: g.dto.relationship,
        isPrimaryContact: g.dto.isPrimaryContact,
        isFeePayer: g.dto.isFeePayer,
        canLogin: g.dto.canLogin,
      });
    }
    const enrolment = await this.enrolments.create(schoolId, {
      studentId: student.id,
      academicYearId,
      classId,
      sectionId,
      rollNo,
      startedOn: admittedOn,
    });
    for (const { upload, type, index } of uploads) {
      if (!(await this.staged.consume(schoolId, userId, upload.id, new Date()))) {
        throw stagedUploadUnusable(`documents[${index}].stagedUploadId`);
      }
      await this.documents.create(schoolId, {
        studentId: student.id,
        type,
        objectKey: upload.objectKey,
        mime: upload.mime,
        sizeBytes: upload.sizeBytes,
        uploadedBy: userId,
      });
    }
    await this.statusChanges.record(schoolId, {
      studentId: student.id,
      fromStatus: null,
      toStatus: 'active',
      reason: null,
      changedBy: userId,
      effectiveOn: admittedOn,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'student.admitted',
      subjectType: 'student',
      subjectId: student.id,
      metadata: {
        enrolmentId: enrolment.id.toString(),
        classId: classId.toString(),
        sectionId: sectionId.toString(),
        // Comma-separated: audit metadata holds scalars and objects, not arrays.
        newGuardianIds: newGuardianIds.join(','),
        linkedGuardianIds: linkedGuardianIds.join(','),
        documentCount: uploads.length,
        acknowledgedDuplicateStudentIds: (dto.acknowledgedDuplicateStudentIds ?? []).join(','),
      },
    });
    await this.keys.setSubject(schoolId, keyId, student.id);
    return student.id;
  }

  // ---------------------------------------------------------------------------- helpers

  /**
   * Existing guardians are locked (their phone decides R30) in id order, so two admissions
   * naming the same guardians cannot deadlock. Unknown → 422 REFERENCE_NOT_FOUND; merged → 409.
   */
  private async resolveGuardians(
    schoolId: SchoolId,
    submitted: AdmissionGuardianDto[],
  ): Promise<ResolvedGuardian[]> {
    const resolved: ResolvedGuardian[] = submitted.map((dto, index) => ({
      index,
      dto,
      existing: null,
      newCnic: dto.newGuardian?.cnic
        ? { digits: dto.newGuardian.cnic, hash: identityHash(dto.newGuardian.cnic, this.hashKey) }
        : null,
    }));
    const byId = [...resolved]
      .filter((g) => g.dto.guardianId !== undefined)
      .sort((a, b) => (BigInt(a.dto.guardianId ?? '0') < BigInt(b.dto.guardianId ?? '0') ? -1 : 1));
    for (const g of byId) {
      try {
        g.existing = await this.guardiansService.lock(schoolId, BigInt(g.dto.guardianId ?? '0'));
      } catch (error) {
        if (error instanceof ApiException && error.status === 404) {
          throw fieldRefused(
            `guardians[${g.index}].guardianId`,
            ErrorCode.REFERENCE_NOT_FOUND,
            'No such guardian',
          );
        }
        throw error;
      }
      if (g.existing.status === 'merged') {
        throw new ApiException(409, ErrorCode.GUARDIAN_MERGED, guardianMerged().message, {
          mergedIntoId: g.existing.mergedIntoId?.toString() ?? null,
        });
      }
    }
    return resolved;
  }

  /** R91: each staged id must be the caller's, unconsumed and unexpired; a photo an image. */
  private async resolveUploads(
    schoolId: SchoolId,
    userId: bigint,
    dto: CreateAdmissionDto,
  ): Promise<
    {
      upload: StagedUploadRecord;
      type: NonNullable<CreateAdmissionDto['documents']>[number]['type'];
      index: number;
    }[]
  > {
    const submitted = dto.documents ?? [];
    const rows = new Map(
      (
        await this.staged.findOwned(
          schoolId,
          userId,
          submitted.map((d) => BigInt(d.stagedUploadId)),
        )
      ).map((row) => [row.id, row]),
    );
    const now = new Date();
    return submitted.map((d, index) => {
      const upload = rows.get(BigInt(d.stagedUploadId));
      if (!upload || upload.consumedAt !== null || upload.expiresAt <= now) {
        throw stagedUploadUnusable(`documents[${index}].stagedUploadId`);
      }
      if (d.type === 'photo' && !isImageMime(upload.mime))
        throw photoNotImage(`documents[${index}].type`);
      return { upload, type: d.type, index };
    });
  }

  private async assertNoUnacknowledgedDuplicate(
    schoolId: SchoolId,
    scope: Scope,
    dto: CreateAdmissionDto,
    dateOfBirth: Date,
    guardianId: bigint,
  ): Promise<void> {
    const acknowledged = new Set(dto.acknowledgedDuplicateStudentIds ?? []);
    const matches = await this.students.findPossibleDuplicates(schoolId, {
      fullName: dto.student.fullName,
      dateOfBirth,
      guardianId,
    });
    if (!matches.some((m) => !acknowledged.has(m.id.toString()))) return;
    const classes = new Map(
      (
        await this.enrolments.activeForStudents(
          schoolId,
          scope,
          matches.map((m) => m.id),
        )
      ).map((e) => [e.studentId, e.className]),
    );
    const details: DuplicateMatch[] = matches.map((m) => ({
      studentId: m.id.toString(),
      admissionNo: m.admissionNo,
      fullName: m.fullName,
      dateOfBirth: toDateString(m.dateOfBirth),
      status: m.status,
      className: classes.get(m.id) ?? null,
    }));
    throw new ApiException(
      409,
      ErrorCode.ADMISSION_POSSIBLE_DUPLICATE,
      'A student with this name and date of birth is already linked to this guardian.',
      { matches: details },
    );
  }

  private bFormExists(holder: StudentRecord): ApiException {
    return studentBFormExists({
      studentId: holder.id.toString(),
      readmissible: READMISSIBLE_STATUSES.includes(holder.status),
    });
  }

  /** GUARDIAN_CNIC_EXISTS naming the holder's survivor (the guardian lookup follows merges). */
  private async guardianCnicExists(scope: Scope, digits: string): Promise<ApiException | null> {
    const { data } = await this.guardiansService.lookup(scope, { cnic: digits });
    const survivor = data[0]?.guardian;
    if (!survivor) return null;
    return new ApiException(
      409,
      ErrorCode.GUARDIAN_CNIC_EXISTS,
      'A guardian with this CNIC already exists.',
      {
        guardianId: survivor.id,
      },
    );
  }

  /** As POST /guardians (slice 5): encrypted CNIC with its hash, audited without values. */
  private async createGuardian(actor: Actor, g: ResolvedGuardian): Promise<bigint> {
    const { schoolId } = actor;
    const input = g.dto.newGuardian;
    if (!input) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    const row = await this.guardians.create(schoolId, {
      fullName: input.fullName,
      cnic: g.newCnic && this.encryption.encrypt(g.newCnic.digits, guardianCnicAad(schoolId)),
      cnicHash: g.newCnic?.hash ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      contactCapability: input.contactCapability,
      address: input.address ?? null,
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'guardian.created',
      subjectType: 'guardian',
      subjectId: row.id,
      metadata: {
        hasCnic: row.cnic !== null,
        hasPhone: row.phone !== null,
        contactCapability: row.contactCapability,
      },
    });
    return row.id;
  }
}
