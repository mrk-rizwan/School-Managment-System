import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { diffMarks } from '../../common/diff';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AttendanceAlertRepository } from '../../repositories/attendance-alert.repository';
import {
  AttendanceMarkRepository,
  type MarkRecord,
  type MarkWrite,
} from '../../repositories/attendance-mark.repository';
import type { MarkDiff } from '../../common/diff';
import {
  AttendanceRegisterRepository,
  type RegisterSection,
} from '../../repositories/attendance-register.repository';
import { AttendanceSummaryRepository } from '../../repositories/attendance-summary.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import {
  assertRegisterDate,
  assertWritablePeriod,
  attendanceLocked,
  AttendanceAccess,
  notATeachingDay,
  windowOpen,
} from './attendance-access';
import { AttendanceAlertWriter } from './attendance-alerts';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import type {
  RegisterQueryDto,
  RegisterSubmitResultDto,
  RegisterViewDto,
  SubmitRegisterDto,
} from './attendance.dto';
import { alertsByChildDay, alertSummary, childDayKey, toMarkDto, toRegisterDto } from './attendance.mappers';

// contracts/slice-11.md §3, §4.1, §4.2 (R118-R126, R174, R175): the register view and the submit.
// Lock order of a submit: students FOR SHARE (id order) → the register → its marks (one
// statement) → the child-days' alert rows → messages (written by the processor, not here).

const SUBJECT = 'attendance_register';

type Planned = MarkDiff<MarkWrite, MarkRecord>;

@Injectable()
export class RegistersService {
  constructor(
    private readonly access: AttendanceAccess,
    private readonly registers: AttendanceRegisterRepository,
    private readonly marks: AttendanceMarkRepository,
    private readonly alerts: AttendanceAlertRepository,
    private readonly summaries: AttendanceSummaryRepository,
    private readonly alertWriter: AttendanceAlertWriter,
    private readonly changeContext: ChangeContextRepository,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** §4.1: the register (or the empty one to fill in) with its roster, marks and alert state. */
  async view(session: SchoolSessionContext, sectionId: bigint, query: RegisterQueryDto): Promise<RegisterViewDto> {
    const { schoolId } = session;
    const section = await this.section(schoolId, sectionId);
    const date = fromDateString(query.date);
    const { callerRole, writeRole, scope } = await this.access.readRole(session, sectionId, date, {
      period: query.period,
      mode: section.attendanceMode,
    });
    const today = await this.clock.today(schoolId);
    assertRegisterDate(date, today, section);
    const settings = await this.settings.read(schoolId);
    const teachingDay = await this.calendar.isTeachingDay(schoolId, date);
    const register = await this.registers.findView(schoolId, sectionId, date, query.period);
    const roster = await this.registers.roster(schoolId, sectionId, date, register?.id ?? null);
    const marks = register === null ? [] : await this.marks.listForRegister(schoolId, register.id);
    const byEnrolment = new Map(marks.map((m) => [m.enrolmentId, m]));
    const alerts = alertsByChildDay(
      await this.alerts.listForChildDays(schoolId, scope, roster.map((r) => r.studentId), date),
    );
    const canSubmit = this.access.canWrite(writeRole, register?.mode ?? section.attendanceMode);
    return {
      section: {
        id: section.id.toString(),
        name: section.name,
        classId: section.classId.toString(),
        className: section.className,
        academicYearId: section.academicYearId.toString(),
        attendanceMode: section.attendanceMode,
      },
      date: query.date,
      period: query.period,
      periodsPerDay: settings.periodsPerDay,
      teachingDay,
      register: register === null ? null : toRegisterDto(register, section, teachingDay),
      roster: roster.map((row) => {
        const mark = byEnrolment.get(row.enrolmentId);
        return {
          enrolmentId: row.enrolmentId.toString(),
          studentId: row.studentId.toString(),
          studentFullName: row.fullName,
          rollNo: row.rollNo,
          onRoster: row.onRoster,
          mark: mark ? toMarkDto(mark) : null,
          alert: alertSummary(alerts.get(childDayKey(row.studentId, date)) ?? []),
        };
      }),
      canSubmit,
      amendable:
        canSubmit && teachingDay && (writeRole === 'all' || windowOpen(date, today, settings.windowDays)),
      callerRole,
    };
  }

  /**
   * §4.2: one transaction. Shape refusals first, then the section, the dated scope, the date
   * rules, the roster (all-or-nothing), the register row (insert-or-lock on its natural key), the
   * diff, the window and the reason, one mark statement, the alert step and the audit row. An
   * identical replay writes nothing and is 200 whatever the window (R125).
   */
  @Transactional()
  async submit(
    session: SchoolSessionContext,
    sectionId: bigint,
    dto: SubmitRegisterDto,
  ): Promise<RegisterSubmitResultDto> {
    const { schoolId } = session;
    const userId = session.access.userId;
    const items = assertShape(dto);
    const section = await this.section(schoolId, sectionId);
    const date = fromDateString(dto.date);
    const role = await this.access.writeRole(session, sectionId, date, section.attendanceMode, dto.period);
    const today = await this.clock.today(schoolId);
    const now = this.clock.now();
    assertRegisterDate(date, today, section);
    if (!(await this.calendar.isTeachingDay(schoolId, date))) throw notATeachingDay();
    const settings = await this.settings.read(schoolId);
    assertWritablePeriod(dto.period, section.attendanceMode, settings.periodsPerDay);

    // Step 5: the roster under FOR SHARE of its students, then every item must be on it.
    await this.registers.shareRosterStudents(schoolId, sectionId, date);
    const existingRegister = await this.registers.findView(schoolId, sectionId, date, dto.period);
    const roster = await this.registers.roster(schoolId, sectionId, date, existingRegister?.id ?? null);
    const studentOf = new Map(roster.map((r) => [r.enrolmentId, r.studentId]));
    const unknown = items.flatMap((item, i) => (studentOf.has(item.enrolmentId) ? [] : [i]));
    if (unknown.length > 0) {
      throw new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
        fields: unknown.map((i) => ({
          path: `marks[${i}].enrolmentId`,
          code: ErrorCode.REFERENCE_NOT_FOUND,
          message: 'not on the roster of this section on that date',
        })),
      });
    }

    // Step 6: insert-or-lock; a concurrent first submit serialises here.
    const created = await this.registers.insertIfAbsent(schoolId, {
      sectionId,
      classId: section.classId,
      academicYearId: section.academicYearId,
      date,
      period: dto.period,
      mode: section.attendanceMode,
      submittedBy: userId,
      submittedAt: now,
      source: session.channel === 'bearer' ? 'app' : 'web',
    });
    const register = await this.registers.lockByNaturalKey(schoolId, sectionId, date, dto.period);
    if (register === null) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');

    // Step 7 (R119): the first submit covers the whole roster.
    if (created) {
      const sent = new Set(items.map((i) => i.enrolmentId));
      const missing = roster.filter((r) => r.onRoster && !sent.has(r.enrolmentId));
      if (missing.length > 0) {
        throw new ApiException(
          422,
          ErrorCode.ROSTER_INCOMPLETE,
          'The first submit of a register must mark every child on the roster.',
          { missing: missing.map((r) => r.enrolmentId.toString()) },
        );
      }
    }

    // Step 8: the diff against the register's marks, read under its lock.
    const current = new Map(
      (await this.marks.listForRegister(schoolId, register.id)).map((m) => [m.enrolmentId, m]),
    );
    const planned: Planned[] = diffMarks(
      items,
      current,
      (item) => item.enrolmentId,
      (item, row) => row.status === item.status && row.note === item.note && row.arrivedAt === item.arrivedAt,
    );
    const amended = planned.filter((p) => p.outcome === 'amended');
    const writes = planned.filter((p) => p.outcome !== 'unchanged');
    const open = windowOpen(date, today, settings.windowDays);
    if (writes.length > 0 && role !== 'all' && !open) {
      throw attendanceLocked(dto.date, settings.windowDays);
    }
    if (amended.length > 0 && dto.reason === undefined) {
      throw new ApiException(
        409,
        ErrorCode.AMENDMENT_REASON_REQUIRED,
        'Some marks differ from what is recorded: confirm the changes with a reason.',
        {
          amendments: amended.map(({ item, existing }) => ({
            enrolmentId: item.enrolmentId.toString(),
            markId: existing?.id.toString() ?? null,
            from: existing?.status ?? null,
            to: item.status,
            noteChanged: existing?.note !== item.note,
          })),
        },
      );
    }

    const outcome = { absencePending: 0, absenceBackdated: 0, lateAdvicePending: 0, cancelled: 0, corrections: 0 };
    if (writes.length > 0) {
      const studentIds = writes.flatMap(({ item }) => {
        const studentId = studentOf.get(item.enrolmentId);
        return studentId === undefined ? [] : [studentId];
      });
      const before = await this.alertWriter.snapshot(schoolId, studentIds, date);
      // Step 9: one statement; the history trigger reads the transaction-local actor and reason.
      await this.changeContext.setChangeContext(userId, dto.reason ?? null);
      await this.marks.upsertForRegister(schoolId, register, writes.map((w) => w.item));
      if (!created) await this.registers.setAmended(schoolId, register.id, userId, now);
      // Step 10.
      const alerts = await this.alertWriter.afterWrite(schoolId, { date, studentIds, before, now, today, settings });
      const { jobs, correctionCapped, ...counts } = alerts;
      Object.assign(outcome, counts);
      // Step 11.
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: created ? 'attendance_register.submitted' : 'attendance_register.amended',
        subjectType: SUBJECT,
        subjectId: register.id,
        ...(dto.reason === undefined ? {} : { reason: dto.reason }),
        metadata: created
          ? {
              sectionId: sectionId.toString(),
              date: dto.date,
              period: dto.period,
              mode: register.mode,
              marks: writes.length,
              afterWindow: !open,
              source: register.source,
            }
          : {
              date: dto.date,
              period: dto.period,
              created: writes.length - amended.length,
              amended: amended.length,
              afterWindow: !open,
              correctionCapped,
              source: register.source,
            },
      });
      // Step 12, after commit.
      await this.enqueueRollup(schoolId, sectionId, date);
      this.outbox.alertsAfterCommit(schoolId, jobs);
    }

    const rosterCount = roster.filter((r) => r.onRoster).length;
    return this.result(schoolId, section, register.id, { date, period: dto.period, planned, rosterCount, created, alerts: outcome });
  }

  /** The rollup job of a section-day at the version this transaction's statement left (§8.2). */
  async enqueueRollup(schoolId: SchoolId, sectionId: bigint, date: Date): Promise<void> {
    const summary = await this.summaries.version(schoolId, sectionId, date);
    if (summary === null) return;
    this.outbox.rollupsAfterCommit(schoolId, [
      { sectionId, date: toDateString(date), version: summary.version },
    ]);
  }

  private async result(
    schoolId: SchoolId,
    section: RegisterSection,
    registerId: bigint,
    input: {
      date: Date;
      period: number;
      planned: readonly Planned[];
      rosterCount: number;
      created: boolean;
      alerts: RegisterSubmitResultDto['alerts'];
    },
  ): Promise<RegisterSubmitResultDto> {
    const { date, period, planned, rosterCount, created, alerts } = input;
    const view = await this.registers.findView(schoolId, section.id, date, period);
    if (view === null || view.id !== registerId) {
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    const marks = await this.marks.listForRegister(schoolId, registerId);
    const byEnrolment = new Map(marks.map((m) => [m.enrolmentId, m]));
    const count = (status: string) => marks.filter((m) => m.status === status).length;
    return {
      created,
      register: toRegisterDto(view, section, await this.calendar.isTeachingDay(schoolId, date)),
      marks: planned.flatMap(({ item, outcome }) => {
        const mark = byEnrolment.get(item.enrolmentId);
        return mark ? [{ ...toMarkDto(mark), outcome }] : [];
      }),
      summary: {
        roster: rosterCount,
        marked: marks.length,
        present: count('present'),
        absent: count('absent'),
        late: count('late'),
        onLeave: count('on_leave'),
      },
      alerts,
    };
  }

  private async section(schoolId: SchoolId, sectionId: bigint): Promise<RegisterSection> {
    const section = await this.registers.findSection(schoolId, sectionId);
    if (!section) throw notFound();
    return section;
  }
}

/** §4.2 step 1, before any read: no repeated enrolment; arrivedAt only on a late mark. */
function assertShape(dto: SubmitRegisterDto): MarkWrite[] {
  const seen = new Set<string>();
  const fields: { path: string; code: ErrorCode; message: string }[] = [];
  dto.marks.forEach((mark, i) => {
    if (seen.has(mark.enrolmentId)) {
      fields.push({
        path: `marks[${i}].enrolmentId`,
        code: ErrorCode.INVALID_VALUE,
        message: 'an enrolment appears once per submit',
      });
    }
    seen.add(mark.enrolmentId);
    if (mark.arrivedAt !== undefined && mark.status !== 'late') {
      fields.push({
        path: `marks[${i}].arrivedAt`,
        code: ErrorCode.INVALID_VALUE,
        message: 'arrivedAt is allowed only on a late mark',
      });
    }
  });
  const [only] = fields;
  if (only && fields.length === 1) throw fieldRefused(only.path, only.code, only.message);
  if (fields.length > 0) {
    throw new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', { fields });
  }
  return dto.marks.map((mark) => ({
    enrolmentId: BigInt(mark.enrolmentId),
    status: mark.status,
    note: mark.note ?? null,
    arrivedAt: mark.arrivedAt ?? null,
  }));
}
