import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, type MarkEntryOutcome } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import {
  AssessmentRepository,
  type AssessmentRecord,
} from '../../repositories/assessment.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { MarkRepository, type MarkRecord } from '../../repositories/mark.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import { yearClosed } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { ownChildCheck } from '../fees/fee-gates';
import { ResultRevisionService } from '../results/result-revision.service';
import type {
  AssessmentMarkDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksDto,
  AssessmentSubmitMarksResultDto,
  MarkEntryDto,
  MarkEntryResultDto,
} from './assessments.dto';
import { AssessmentsService } from './assessments.service';
import { assessmentLocked, assessmentVoided, toAssessmentMarkDto } from './assessments.shared';

// contracts/slice-30.md §3, §4 (phase-4-academic.md slice 30, R261, R262, R265, R266): the marks
// grid, its per-row submit and the approver's excusal. A mark is never edited: a change is a new
// live row superseding the old one in one transaction under the assessment's row lock. Marks entry
// writes no audit row — the supersedes chain with entered_by/at is the history (§7.1).

const markExceedsMax = (enrolmentId: string, max: number): ApiException =>
  new ApiException(409, ErrorCode.MARK_EXCEEDS_MAX, `A mark cannot exceed the maximum of ${max}.`, {
    enrolmentId,
    max,
  });

const notAnAbsence = (markId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.ILLEGAL_STATUS_TRANSITION,
    'Only a live, not yet excused absence can be excused.',
    {
      markId: markId.toString(),
    },
  );

/** What an entry asks for: a mark, or an absence. */
const valueOf = (entry: MarkEntryDto): { obtained: number | null; absent: boolean } =>
  entry.absent === true
    ? { obtained: null, absent: true }
    : { obtained: entry.obtained ?? null, absent: false };

@Injectable()
export class MarksService {
  constructor(
    private readonly context: SchoolContext,
    private readonly assessments: AssessmentRepository,
    private readonly marks: MarkRepository,
    private readonly years: AcademicYearRepository,
    private readonly resultSettings: ResultSettingsRepository,
    private readonly schoolSettings: SchoolSettingsRepository,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly views: AssessmentsService,
    private readonly revision: ResultRevisionService,
  ) {}

  // ------------------------------------------------------------------------------------ grid

  /**
   * §3.1: the assessment and its grid — the section's enrolments in force on held_on, each with
   * its live mark — read under the read scope of held_on; outside it 404.
   */
  async grid(session: SchoolSessionContext, id: bigint): Promise<AssessmentMarksDto> {
    const schoolId = this.context.schoolId;
    const on = await this.assessments.scopeDateOf(schoolId, id);
    const scope = on && (await this.permissions.marksReadScopeOf(session, on));
    const row = scope ? await this.assessments.find(schoolId, scope, id) : null;
    if (!row || !scope) throw notFound();
    const roster = await this.marks.roster(schoolId, scope, row);
    const live = new Map(
      (await this.marks.liveForAssessment(schoolId, scope, id)).map((m) => [m.enrolmentId, m]),
    );
    const pending = new Map(
      (await this.marks.pendingForAssessment(schoolId, scope, id)).map((m) => [m.enrolmentId, m]),
    );
    const { guardianId, userId } = session.access;
    const ownChildren =
      guardianId === null
        ? new Set<bigint>()
        : await this.marks.childrenAmong(
            schoolId,
            guardianId,
            roster.map((r) => r.studentId),
          );
    const [assessment] = await this.views.views(session, scope, [row]);
    if (!assessment) throw notFound();
    return {
      assessment,
      rows: roster.map((r) => {
        const mark = live.get(r.enrolmentId) ?? null;
        return {
          enrolmentId: r.enrolmentId.toString(),
          student: {
            id: r.studentId.toString(),
            fullName: r.fullName,
            admissionNo: r.admissionNo,
            rollNo: r.rollNo,
          },
          markId: mark?.id.toString() ?? null,
          obtained: mark?.obtained ?? null,
          absent: mark?.absent ?? false,
          excused: mark?.excused ?? false,
          status: mark?.status ?? null,
          enteredAt: mark?.enteredAt ?? null,
          ownChildOf: ownChildren.has(r.studentId) ? userId.toString() : null,
          pendingCorrectionId: pending.get(r.enrolmentId)?.id.toString() ?? null,
          pendingCorrectionMine: pending.get(r.enrolmentId)?.enteredBy === userId,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------------- submit

  /**
   * §3.2 (R262): one transaction under the assessment's row lock. Per entry, in request order:
   * a resend of a key already written answers what it wrote; an entry whose `basedOnMarkId` is
   * not the live mark answers changed_elsewhere and writes nothing; the same value answers
   * unchanged; otherwise a new live row (superseding the live one). A mark above the maximum, a
   * locked or a voided assessment refuses the whole request. An entry for a student not on the
   * grid is omitted.
   */
  @Transactional()
  async submit(
    session: SchoolSessionContext,
    id: bigint,
    dto: AssessmentSubmitMarksDto,
  ): Promise<AssessmentSubmitMarksResultDto> {
    const { schoolId, userId } = this.context.actor();
    this.assertWellFormed(dto);
    const on = await this.assessments.scopeDateOf(schoolId, id);
    const scope = on && (await this.permissions.marksWriteScopeOf(session, on));
    if (!scope) throw notFound();
    const row = await readLocked(
      () => this.assessments.findWritable(schoolId, scope, id),
      (found) => this.assessments.lockIfUnchanged(schoolId, scope, found),
    );
    if (row.voidedAt !== null) throw assessmentVoided(row.id);
    // R265: a test with locked_at, or any assessment whose section-term sheet is submitted or later.
    if (row.lockedAt !== null || (await this.views.sheetLocks(schoolId, row))) {
      throw assessmentLocked(row.id);
    }
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    for (const entry of dto.entries) {
      const { obtained } = valueOf(entry);
      if (obtained !== null && obtained > row.maxMarks)
        throw markExceedsMax(entry.enrolmentId, row.maxMarks);
    }

    const roster = new Map(
      (await this.marks.roster(schoolId, scope, row)).map((r) => [r.enrolmentId, r]),
    );
    const live = new Map(
      (await this.marks.liveForAssessment(schoolId, scope, id)).map((m) => [m.enrolmentId, m]),
    );
    // §2.4: a student a submitted (or later) sheet of the class-term has locked takes no new mark
    // here either, whatever this assessment's section (a moved student's old-section marks).
    const lockedStudents = await this.assessments.sheetLockedStudents(
      schoolId,
      row,
      [...roster.values()].map((r) => r.studentId),
    );
    const keyed = new Map<string, MarkRecord>();
    for (const mark of await this.marks.findByEntryKeys(
      schoolId,
      scope,
      id,
      dto.entries.map((e) => e.clientEntryKey),
    )) {
      keyed.set(`${mark.enrolmentId}|${mark.clientEntryKey}`, mark);
    }

    const results: MarkEntryResultDto[] = [];
    const created: bigint[] = [];
    for (const entry of dto.entries) {
      const enrolmentId = BigInt(entry.enrolmentId);
      const student = roster.get(enrolmentId);
      if (!student) continue;
      const answer = (outcome: MarkEntryOutcome, markId: bigint | null): void => {
        results.push({
          clientEntryKey: entry.clientEntryKey,
          enrolmentId: entry.enrolmentId,
          markId: markId?.toString() ?? null,
          outcome,
        });
      };
      const current = live.get(enrolmentId) ?? null;

      // A resend of an entry already written (R262): answer what it did; a row superseded since
      // by someone else's entry is changed_elsewhere.
      const resent = keyed.get(`${enrolmentId}|${entry.clientEntryKey}`);
      if (resent) {
        if (resent.status === 'live')
          answer(resent.supersedesId === null ? 'created' : 'superseded', resent.id);
        else answer('changed_elsewhere', current?.id ?? null);
        continue;
      }
      const based = entry.basedOnMarkId === null ? null : BigInt(entry.basedOnMarkId);
      if ((current?.id ?? null) !== based) {
        answer('changed_elsewhere', current?.id ?? null);
        continue;
      }
      const value = valueOf(entry);
      if (current && current.obtained === value.obtained && current.absent === value.absent) {
        answer('unchanged', current.id);
        continue;
      }
      if (lockedStudents.has(student.studentId)) throw assessmentLocked(row.id);
      if (current && !(await this.marks.supersede(schoolId, scope, row, current.id))) {
        answer('changed_elsewhere', null);
        continue;
      }
      const mark = await this.marks.insertLive(schoolId, scope, row, {
        enrolmentId,
        studentId: student.studentId,
        ...value,
        excused: false,
        supersedesId: current?.id ?? null,
        correctionReason: null,
        enteredBy: userId,
        clientEntryKey: entry.clientEntryKey,
      });
      live.set(enrolmentId, mark);
      if (current) {
        answer('superseded', mark.id);
      } else {
        answer('created', mark.id);
        created.push(student.studentId);
      }
    }

    if (row.kind === 'test' && created.length > 0)
      await this.notifyTestMarked(schoolId, row, created, roster);
    const [assessment] = await this.views.views(session, scope, [row]);
    if (!assessment) throw notFound();
    return { assessment, entries: results };
  }

  /** One entry per enrolment, and exactly one of a mark or an absence (422 on the entry). */
  private assertWellFormed(dto: AssessmentSubmitMarksDto): void {
    const seen = new Set<string>();
    dto.entries.forEach((entry, i) => {
      if (seen.has(entry.enrolmentId)) {
        throw fieldRefused(
          `entries[${i}].enrolmentId`,
          ErrorCode.INVALID_VALUE,
          'Each student appears once',
        );
      }
      seen.add(entry.enrolmentId);
      const hasMark = entry.obtained !== undefined && entry.obtained !== null;
      if (hasMark === (entry.absent === true)) {
        throw fieldRefused(
          `entries[${i}].obtained`,
          ErrorCode.INVALID_VALUE,
          'Give a mark, or absent: true, not both',
        );
      }
    });
  }

  /**
   * R266: `test_marked` only with the year's notify_class_tests on, only for a test, and only for
   * a student's first mark on it (a re-entry does not notify again): in-app and a title-only push
   * to the student's live guardians and their own login (the type's channels; never SMS).
   */
  private async notifyTestMarked(
    schoolId: SchoolId,
    row: AssessmentRecord,
    studentIds: readonly bigint[],
    roster: ReadonlyMap<bigint, { studentId: bigint; fullName: string }>,
  ): Promise<void> {
    const settings = await this.resultSettings.findForYear(schoolId, row.academicYearId);
    if (!settings?.notifyClassTests) return;
    const studentLogin = await this.schoolSettings.studentLoginEnabled(schoolId);
    const recipients = await this.marks.testMarkedRecipients(schoolId, studentIds, studentLogin);
    const names = new Map([...roster.values()].map((r) => [r.studentId, r.fullName]));
    for (const studentId of studentIds) {
      const people = recipients.get(studentId);
      if (!people || (people.guardianIds.length === 0 && !people.student)) continue;
      await this.notifications.send(schoolId, {
        type: 'test_marked',
        subject: { type: 'assessment', id: row.id },
        recipients: [
          ...people.guardianIds.map((guardianId) => ({ guardianId })),
          ...(people.student ? [{ studentId }] : []),
        ],
        vars: { studentName: names.get(studentId) ?? '', testName: row.name },
      });
    }
  }

  // ---------------------------------------------------------------------------------- excuse

  /**
   * §4 (result.approve): a live, not yet excused absence becomes excused — a new live row
   * (absent, excused, the reason, entered by the approver) superseding it, under the
   * assessment's row lock; a locked test still takes it. Refused on the approver's own child
   * (SELF_ACTION_FORBIDDEN own_child) unless they are the sole principal (recorded
   * selfApproved). Written within the caller's marks write scope (the principal's is `all`).
   */
  @Transactional()
  async excuse(
    session: SchoolSessionContext,
    markId: bigint,
    reason: string,
  ): Promise<AssessmentMarkDto> {
    const { schoolId, userId } = this.context.actor();
    const on = await this.marks.scopeDateOf(schoolId, markId);
    const scope = on && (await this.permissions.marksWriteScopeOf(session, on));
    if (!scope) throw notFound();
    const found = await this.marks.find(schoolId, scope, markId);
    if (!found) throw notFound();
    const row = await this.lockAssessment(schoolId, scope, found.assessmentId);
    // Re-read under the lock: an entry may have superseded it meanwhile.
    const mark = await this.marks.find(schoolId, scope, markId);
    if (!mark) throw notFound();
    if (row.voidedAt !== null) throw assessmentVoided(row.id);
    if (mark.status !== 'live' || !mark.absent || mark.excused) throw notAnAbsence(mark.id);
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, mark.studentId);
    const target = { studentId: mark.studentId, classId: row.classId, termId: row.termId };
    const published = await this.revision.publishedTermResultOf(schoolId, target);
    if (!published) await this.revision.refuseIfApprovedUnpublished(schoolId, target);

    if (!(await this.marks.supersede(schoolId, scope, row, mark.id))) throw notAnAbsence(mark.id);
    const excused = await this.marks.insertLive(schoolId, scope, row, {
      enrolmentId: mark.enrolmentId,
      studentId: mark.studentId,
      obtained: null,
      absent: true,
      excused: true,
      supersedesId: mark.id,
      correctionReason: reason,
      enteredBy: userId,
      clientEntryKey: null,
    });
    // contracts/slice-32.md §4: after publication an excusal is a correction — the approver's own
    // decision, so it revises the results at once (no second person: excusing is result.approve's).
    const revision = published ? await this.revision.revise(session, target, userId) : null;
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'mark.excused',
      subjectType: 'assessment',
      subjectId: row.id,
      reason,
      metadata: {
        markId: excused.id.toString(),
        supersedesId: mark.id.toString(),
        enrolmentId: mark.enrolmentId.toString(),
        ownChild: selfApproved,
        selfSubmitter: revision?.selfApproved ?? false,
        selfApproved: selfApproved || (revision?.selfApproved ?? false),
        revisedResultId: revision?.resultId.toString() ?? null,
      },
    });
    return toAssessmentMarkDto(excused);
  }

  /** The assessment under its row lock, inside the write scope; outside it 404. */
  private lockAssessment(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    id: bigint,
  ): Promise<AssessmentRecord> {
    return readLocked(
      () => this.assessments.findWritable(schoolId, scope, id),
      (found) => this.assessments.lockIfUnchanged(schoolId, scope, found),
    );
  }
}
