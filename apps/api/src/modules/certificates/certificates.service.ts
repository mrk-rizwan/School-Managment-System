import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { certificateLabel, ErrorCode, type CertificateType, type DuesStatus, type StudentStatus } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { bFormAad } from '../../common/identity';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import type { SafeHtml } from '../../common/print-view';
import type { ReasonDto } from '../../common/reason.dto';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  CertificateRepository,
  type CertificateBodyResult,
  type CertificateRecord,
} from '../../repositories/certificate.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { requirePrincipal } from '../access/money-gates';
import { FinanceReportsService } from '../finance-reports/finance-reports.service';
import { ResultCardsService } from '../results/result-cards.service';
import type { ResultDto } from '../results/results.dto';
import { buildCertificateBody, CERTIFICATE_TITLES } from './certificate-body';
import { certificatePage } from './certificate-print';
import type {
  CertificateDto,
  CertificateSummaryDto,
  IssueCertificateDto,
  ListCertificatesQueryDto,
  ListStudentCertificatesQueryDto,
} from './certificates.dto';

// phase-4-academic.md slice 34 (R289-R293, §1.1 rule 29, §7.1); contracts/slice-34.md. The
// database holds the same lines (migration 20261007160000_wave_n_assessments_certificates); the
// service refuses first, with the contract's codes.

const ENDPOINT = 'certificates';
const SUBJECT = 'certificate';
/** A student's whole enrolment history fits one read (a student has a handful a year at most). */
const ENROLMENT_HISTORY = { skip: 0, take: 50 };
/** A leaving certificate needs the student to have left (A10, R290). */
const LEFT: readonly StudentStatus[] = ['withdrawn', 'transferred', 'alumni'];
/** An `other` certificate's title may not read as a leaving certificate ("leaving", "leaver"). */
const LEAVING_WORDING = /leav/i;
/** Used only when the school has neither a signatory nor an active principal. */
const FALLBACK_SIGNATORY = 'Principal';

export interface CertificateCreateOutcome {
  replayed: boolean;
  certificate: CertificateDto;
}

const certificateRefusal = (code: ErrorCode, message: string) => (certificateId: bigint) =>
  new ApiException(409, code, message, { certificateId: certificateId.toString() });

export const certificateVoided = certificateRefusal(
  ErrorCode.CERTIFICATE_VOIDED,
  'This certificate has been voided. Issue a new one instead.',
);

/** R290: only a student who has left gets a leaving certificate. No certificate exists yet. */
const studentNotLeft = (studentId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.CERTIFICATE_STUDENT_NOT_LEFT,
    'A leaving certificate is issued only after the student is withdrawn, transferred or has completed school.',
    { studentId: studentId.toString() },
  );

/** Rule 20, R290: unpaid dues block the leaving certificate until paid or overridden. */
const duesBlock = (outstanding: number): ApiException =>
  new ApiException(
    409,
    ErrorCode.CERTIFICATE_DUES_BLOCK,
    'The student has unpaid dues. Collect them, or ask a principal to override, before issuing a leaving certificate.',
    { outstanding },
  );

/** A11: academic and completion certificates print the published result of the named year. */
const NEEDS_RESULT: readonly CertificateType[] = ['academic', 'completion'];

const noResult = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.CERTIFICATE_NO_RESULT,
    'No result of that academic year is published for the student yet.',
    { certificateId: null },
  );

/** The card as the body's marks table (a snapshot: a later correction changes nothing issued). */
function bodyResultOf(card: ResultDto): CertificateBodyResult {
  return {
    termName: card.termName ?? 'Final',
    isFinal: card.isFinal,
    className: card.className,
    sectionName: card.sectionName,
    subjects: card.subjects.map((s) => ({
      subjectName: s.subjectName,
      obtained: s.status === 'assessed' ? s.obtained : null,
      max: s.max,
      percentBp: s.percentBp,
      grade: s.grade,
      examAbsent: s.examAbsent,
      examExcused: s.examExcused,
    })),
    totalObtained: card.totalObtained,
    totalMax: card.totalMax,
    percentBp: card.percentBp,
    grade: card.grade,
    passed: card.passed,
  };
}

@Injectable()
export class CertificatesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly certificates: CertificateRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly roles: UserRoleRepository,
    private readonly audit: AuditLogRepository,
    private readonly dues: FinanceReportsService,
    private readonly idempotency: IdempotentRequests,
    private readonly encryption: FieldEncryption,
    private readonly clock: SchoolClock,
    private readonly resultCards: ResultCardsService,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  /** The register (R293: voided rows are listed, as voided). */
  async list(session: SchoolSessionContext, query: ListCertificatesQueryDto): Promise<Page<CertificateDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.certificates.list(schoolId, scopeOf(session), {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.studentId === undefined ? {} : { studentId: BigInt(query.studentId) }),
      ...(query.issuedFrom === undefined ? {} : { issuedFrom: fromDateString(query.issuedFrom) }),
      ...(query.issuedTo === undefined ? {} : { issuedTo: fromDateString(query.issuedTo) }),
      ...(query.voided === undefined ? {} : { voided: query.voided }),
      descending: (query.sort ?? '-issuedOn') === '-issuedOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  /** A student's certificates without bodies; a student outside the caller's scope is 404. */
  async listForStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    query: ListStudentCertificatesQueryDto,
  ): Promise<Page<CertificateSummaryDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    if (!(await this.certificates.findStudent(schoolId, scope, studentId))) throw notFound();
    const { rows, total } = await this.certificates.list(schoolId, scope, {
      studentId,
      descending: (query.sort ?? '-issuedOn') === '-issuedOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const dtos = await this.toDtos(schoolId, rows);
    return toPage(
      dtos.map(({ body: _body, duesStatus: _dues, reason: _reason, ...summary }) => summary),
      query,
      total,
    );
  }

  async get(session: SchoolSessionContext, id: bigint): Promise<CertificateDto> {
    const schoolId = this.context.schoolId;
    const row = await this.certificates.findById(schoolId, scopeOf(session), id);
    if (!row) throw notFound();
    return this.toDto(schoolId, row);
  }

  // ---------------------------------------------------------------------------------- issue

  /** R289-R291. Keyed (endpoint `certificates`, path id the student): a replay answers 200. */
  async issue(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: IssueCertificateDto,
    rawKey: string | undefined,
  ): Promise<CertificateCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, studentId, dto, rawKey, (claim) =>
      this.issueInTransaction(session, actor, studentId, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, certificate: await this.get(session, outcome.subjectId) };
    return { replayed: false, certificate: outcome.value };
  }

  @Transactional()
  private async issueInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    studentId: bigint,
    dto: IssueCertificateDto,
    claim: IdempotencyClaim,
  ): Promise<CertificateDto> {
    // The first statement: a racing same-key request now waits on the unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const scope = scopeOf(session);
    const student = await this.certificates.findStudent(schoolId, scope, studentId);
    if (!student) throw notFound();
    const { rows } = await this.enrolments.listForStudent(schoolId, scope, studentId, ENROLMENT_HISTORY);
    const enrolments = await this.enrolments.withNames(schoolId, rows);

    // §1.1: the named year must be one the student was enrolled in; default the last enrolment's.
    let academicYearId: bigint | null = null;
    if (dto.academicYearId !== undefined) {
      academicYearId = BigInt(dto.academicYearId);
      if (!enrolments.some((e) => e.academicYearId === academicYearId)) {
        throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'The student has no enrolment in that academic year');
      }
    } else {
      // listForStudent reads newest first.
      academicYearId = enrolments[0]?.academicYearId ?? null;
    }
    if (academicYearId === null && dto.type !== 'other') {
      throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'The student has no enrolment to certify');
    }
    if (dto.type === 'other' && dto.title === undefined) {
      throw fieldRefused('title', ErrorCode.INVALID_VALUE, 'title is required for an "other" certificate');
    }
    // Wave N review: a title is an `other` certificate's own, and never a leaving certificate's
    // (only the leaving type is gated on status and dues, R290). CHECK certificates_title_other_check.
    if (dto.type !== 'other' && dto.title !== undefined) {
      throw fieldRefused('title', ErrorCode.INVALID_VALUE, 'title is given only to an "other" certificate');
    }
    if (dto.title !== undefined && LEAVING_WORDING.test(dto.title)) {
      throw fieldRefused('title', ErrorCode.INVALID_VALUE, 'An "other" certificate may not be titled as a leaving certificate');
    }

    // R290: the leaving certificate needs a student who has left and dues cleared or overridden;
    // the figure comes from the dues endpoint only (§5.1).
    let duesStatus: DuesStatus = 'not_required';
    let reason: string | null = null;
    if (dto.type === 'leaving') {
      if (!LEFT.includes(student.status)) throw studentNotLeft(studentId);
      const clearance = await this.dues.clearance(studentId);
      if (!clearance.cleared) throw duesBlock(clearance.outstanding);
      if (clearance.override !== null) {
        duesStatus = 'override';
        reason = clearance.override.reason === '' ? 'Dues overridden by a principal' : clearance.override.reason;
      } else {
        duesStatus = 'cleared';
      }
    }

    // A11 (wave P): the marks table — the named year's published final, else its last published term.
    let result: CertificateBodyResult | null = null;
    if (NEEDS_RESULT.includes(dto.type)) {
      const card =
        academicYearId === null
          ? null
          : await this.resultCards.certificateResultFor(schoolId, studentId, academicYearId);
      if (!card) throw noResult();
      result = bodyResultOf(card);
    }

    const { signatoryName, defaulted } = await this.signatory(schoolId, userId);
    const body = buildCertificateBody({
      schoolName: session.school.name,
      student,
      fatherName: await this.certificates.fatherName(schoolId, studentId),
      enrolments,
      academicYearId,
      conduct: dto.conduct ?? null,
      remarks: dto.remarks ?? null,
      signatoryName,
      result,
    });
    // The counter last, just before the insert (R289: gapless in commit order).
    const number = await this.certificates.nextNumber(schoolId, dto.type);
    const row = await this.certificates.create(schoolId, {
      studentId,
      type: dto.type,
      number,
      issueNo: 1,
      reissueOfId: null,
      academicYearId,
      title: dto.title ?? null,
      body,
      reason,
      duesStatus,
      issuedBy: userId,
      issuedOn: await this.clock.today(schoolId),
    });
    await recordSubject(row.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'certificate.issued',
      subjectType: SUBJECT,
      subjectId: row.id,
      ...(reason === null ? {} : { reason }),
      metadata: {
        studentId: studentId.toString(),
        type: row.type,
        label: certificateLabel(row.type, row.number),
        academicYearId: academicYearId?.toString() ?? null,
        duesStatus,
        signatoryDefaulted: defaulted,
      },
    });
    return this.toDto(schoolId, row);
  }

  /**
   * certificate_signatory_name, defaulted at the first issue to the active principal's name
   * (§1.1); the fallback only when the school has no active principal.
   */
  private async signatory(schoolId: SchoolId, actorUserId: bigint): Promise<{ signatoryName: string; defaulted: boolean }> {
    const settings = await this.settings.find(schoolId);
    const current = settings?.certificateSignatoryName ?? null;
    if (current !== null) return { signatoryName: current, defaulted: false };
    const [principal] = await this.roles.activePrincipalUserIds(schoolId);
    const name = principal === undefined ? '' : ((await this.certificates.names(schoolId, [principal])).get(principal) ?? '');
    if (name === '') return { signatoryName: FALLBACK_SIGNATORY, defaulted: false };
    const defaulted = await this.settings.defaultCertificateSignatory(schoolId, name);
    // Someone set one between the read and the write: use theirs.
    if (!defaulted) return { signatoryName: (await this.settings.find(schoolId))?.certificateSignatoryName ?? name, defaulted };
    // A settings change like any other (R57): the same row PATCH /school/settings writes. (A
    // write that changed a row found the settings row, so `settings` is set.)
    if (settings) {
      await this.audit.record(schoolId, {
        actorUserId,
        action: 'school_settings.updated',
        subjectType: 'school_settings',
        subjectId: settings.id,
        metadata: { changes: { certificateSignatoryName: { from: null, to: name } } },
      });
    }
    return { signatoryName: name, defaulted };
  }

  // -------------------------------------------------------------------------------- reissue

  /**
   * R289: the same type and number, issue_no + 1, the original's body and student copied; prints
   * DUPLICATE. Keyed (endpoint `certificates`, path id the certificate reissued).
   */
  async reissue(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReasonDto,
    rawKey: string | undefined,
  ): Promise<CertificateCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, id, dto, rawKey, (claim) =>
      this.reissueInTransaction(session, actor, id, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, certificate: await this.get(session, outcome.subjectId) };
    return { replayed: false, certificate: outcome.value };
  }

  @Transactional()
  private async reissueInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    id: bigint,
    dto: ReasonDto,
    claim: IdempotencyClaim,
  ): Promise<CertificateDto> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const original = await readLocked(
      () => this.certificates.findById(schoolId, scopeOf(session), id),
      (row) => this.certificates.lockIfUnchanged(schoolId, row),
    );
    // The number's rows locked first (as a void takes them): a void of any issue of the number
    // voids the number, and a voided number is never reissued (wave N review).
    await this.certificates.lockNumber(schoolId, original.type, original.number);
    if (original.voidedAt !== null || (await this.certificates.numberVoided(schoolId, original.type, original.number))) {
      throw certificateVoided(id);
    }
    // Backstop: two issues of one number committed at once lose on
    // certificates_school_id_type_number_issue_no_key (409 CONCURRENT_UPDATE, retryable).
    const issueNo = (await this.certificates.lastIssueNo(schoolId, original.type, original.number)) + 1;
    const row = await this.certificates.create(schoolId, {
      studentId: original.studentId,
      type: original.type,
      number: original.number,
      issueNo,
      reissueOfId: original.id,
      academicYearId: original.academicYearId,
      title: original.title,
      body: original.body,
      reason: dto.reason,
      duesStatus: original.duesStatus,
      issuedBy: userId,
      issuedOn: await this.clock.today(schoolId),
    });
    await recordSubject(row.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'certificate.reissued',
      subjectType: SUBJECT,
      subjectId: row.id,
      reason: dto.reason,
      metadata: {
        reissueOfId: original.id.toString(),
        studentId: row.studentId.toString(),
        label: certificateLabel(row.type, row.number),
        issueNo,
      },
    });
    return this.toDto(schoolId, row);
  }

  // ----------------------------------------------------------------------------------- void

  /**
   * R293: a principal only (R233's gate). Voiding a certificate voids its NUMBER: every live issue
   * of (type, number) is stamped in one statement (wave N review), and the number is never reused.
   */
  @Transactional()
  async void(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<CertificateDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.certificates.findById(schoolId, scopeOf(session), id);
    if (!row) throw notFound();
    requirePrincipal(session);
    if (row.voidedAt !== null) throw certificateVoided(id);
    await this.certificates.lockNumber(schoolId, row.type, row.number);
    const issueNos = await this.certificates.voidNumber(schoolId, row.type, row.number, userId, dto.reason, new Date());
    // Voided meanwhile through another issue of the number.
    if (!issueNos.includes(row.issueNo)) throw certificateVoided(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'certificate.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      // Every issue the void stamped, ascending: "1, 2" (audit metadata holds no arrays).
      metadata: { label: certificateLabel(row.type, row.number), issueNo: row.issueNo, issueNos: issueNos.join(', ') },
    });
    const voided = await this.certificates.findById(schoolId, scopeOf(session), id);
    if (!voided) throw notFound();
    return this.toDto(schoolId, voided);
  }

  // ---------------------------------------------------------------------------------- print

  /**
   * The print view (R292, §7.1): the only place the B-Form appears, decrypted here from
   * students.b_form under the school-bound AAD, only for a non-voided leaving certificate while
   * certificate_show_identity_no is on. Every print is audited and counted.
   */
  @Transactional()
  async print(session: SchoolSessionContext, id: bigint): Promise<SafeHtml> {
    const { schoolId, userId } = this.context.actor();
    const scope = scopeOf(session);
    const row = await this.certificates.findById(schoolId, scope, id);
    if (!row) throw notFound();
    let identityNumber: string | null = null;
    if (row.type === 'leaving' && row.voidedAt === null && (await this.settings.find(schoolId))?.certificateShowIdentityNo === true) {
      const cipher = await this.certificates.studentBForm(schoolId, scope, row.studentId);
      identityNumber = cipher === null ? null : this.encryption.decrypt(cipher, bFormAad(schoolId));
    }
    await this.certificates.countPrint(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'certificate.printed',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { certificateId: id.toString(), issueNo: row.issueNo, identityPrinted: identityNumber !== null },
    });
    return certificatePage(await this.toDto(schoolId, row), identityNumber);
  }

  // ------------------------------------------------------------------------------- mapping

  private async toDto(schoolId: SchoolId, row: CertificateRecord): Promise<CertificateDto> {
    const [dto] = await this.toDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /** One names read for the page. */
  private async toDtos(schoolId: SchoolId, rows: readonly CertificateRecord[]): Promise<CertificateDto[]> {
    const names = await this.certificates.names(
      schoolId,
      rows.flatMap((r) => (r.voidedBy === null ? [r.issuedBy] : [r.issuedBy, r.voidedBy])),
    );
    return rows.map((r) => ({
      id: r.id.toString(),
      studentId: r.studentId.toString(),
      studentName: r.studentName,
      admissionNo: r.admissionNo,
      type: r.type,
      number: r.number,
      label: certificateLabel(r.type, r.number),
      issueNo: r.issueNo,
      reissueOfId: r.reissueOfId?.toString() ?? null,
      academicYearId: r.academicYearId?.toString() ?? null,
      academicYearName: r.academicYearName,
      title: r.title ?? CERTIFICATE_TITLES[r.type],
      duesStatus: r.duesStatus,
      reason: r.reason,
      issuedOn: toDateString(r.issuedOn),
      issuedByName: names.get(r.issuedBy) ?? '',
      printedCount: r.printedCount,
      voidedAt: r.voidedAt,
      voidedByName: r.voidedBy === null ? null : (names.get(r.voidedBy) ?? ''),
      voidReason: r.voidReason,
      createdAt: r.createdAt,
      body: r.body,
    }));
  }
}
