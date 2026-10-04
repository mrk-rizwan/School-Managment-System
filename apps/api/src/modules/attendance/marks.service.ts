import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ARRIVAL_REASON, Capability, ErrorCode, type AttendanceStatus } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import {
  AttendanceMarkRepository,
  type MarkRecord,
} from '../../repositories/attendance-mark.repository';
import { AttendanceRegisterRepository } from '../../repositories/attendance-register.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { staleStatus } from '../access/access.errors';
import { PermissionsService, rowScope } from '../access/permissions.service';
import { CalendarService } from '../calendar/calendar.service';
import {
  attendanceLocked,
  AttendanceAccess,
  notATeachingDay,
  windowOpen,
  type WriteRole,
} from './attendance-access';
import { AttendanceAlertWriter } from './attendance-alerts';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import type {
  AmendMarkDto,
  AttendanceMarkDto,
  MarkChangeDto,
  MarkChangesQueryDto,
  RecordArrivalDto,
} from './attendance.dto';
import { toMarkDto } from './attendance.mappers';
import { RegistersService } from './registers.service';

// contracts/slice-11.md §4.3-§4.5 (R122, R123, R125, R126, R168): one mark's amendment, the gate's
// arrival, and a mark's history. Both writes lock the register, then the mark (§1.6), set the
// transaction-local actor and reason for the history trigger, and run the alert step exactly as a
// submit does. Online-only in the app (R162).

const SUBJECT = 'attendance_mark';

const arrivalNotAbsent = (status: AttendanceStatus | null): ApiException =>
  new ApiException(
    409,
    ErrorCode.ARRIVAL_NOT_ABSENT,
    status === null
      ? 'No attendance is recorded for that child today: record the register first.'
      : 'That child is not marked absent: amend the register instead.',
    { status },
  );

@Injectable()
export class MarksService {
  constructor(
    private readonly access: AttendanceAccess,
    private readonly permissions: PermissionsService,
    private readonly marks: AttendanceMarkRepository,
    private readonly registers: AttendanceRegisterRepository,
    private readonly registerService: RegistersService,
    private readonly alertWriter: AttendanceAlertWriter,
    private readonly changeContext: ChangeContextRepository,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /**
   * §4.3: PATCH semantics on note and arrivedAt. An identical request is a 200 replay (fromStatus
   * unchecked); a stale fromStatus is 409 STALE_STATUS; a section-scoped caller past the window is
   * 409 ATTENDANCE_LOCKED. A day that is no longer a teaching day can still be corrected.
   */
  @Transactional()
  async amend(session: SchoolSessionContext, markId: bigint, dto: AmendMarkDto): Promise<AttendanceMarkDto> {
    const { schoolId } = session;
    if (typeof dto.arrivedAt === 'string' && dto.status !== 'late') {
      throw fieldRefused('arrivedAt', ErrorCode.INVALID_VALUE, 'arrivedAt is allowed only on a late mark');
    }
    const found = await this.marks.findById(schoolId, markId);
    if (!found) throw notFound();
    const role = await this.access.writeRole(session, found.sectionId, found.date, found.mode);
    if (!(await this.registers.lock(schoolId, found.registerId))) throw notFound();
    const mark = await this.marks.lock(schoolId, markId);
    if (!mark) throw notFound();

    const target = {
      status: dto.status,
      note: dto.note === undefined ? mark.note : dto.note,
      arrivedAt:
        dto.arrivedAt !== undefined ? dto.arrivedAt : dto.status === 'late' ? mark.arrivedAt : null,
    };
    if (target.status === mark.status && target.note === mark.note && target.arrivedAt === mark.arrivedAt) {
      return toMarkDto(mark);
    }
    if (dto.fromStatus !== mark.status) throw staleStatus(mark.status);
    const today = await this.clock.today(schoolId);
    const settings = await this.settings.read(schoolId);
    const open = windowOpen(mark.date, today, settings.windowDays);
    if (role !== 'all' && !open) throw attendanceLocked(toDateString(mark.date), settings.windowDays);

    const correctionCapped = await this.write(session, mark, target, dto.reason, {
      today,
      settings,
      arrival: null,
    });
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'attendance_mark.amended',
      subjectType: SUBJECT,
      subjectId: mark.id,
      reason: dto.reason,
      metadata: {
        enrolmentId: mark.enrolmentId.toString(),
        studentId: mark.studentId.toString(),
        date: toDateString(mark.date),
        period: mark.period,
        from: mark.status,
        to: target.status,
        noteChanged: target.note !== mark.note,
        afterWindow: !open,
        correctionCapped,
      },
    });
    return this.reread(schoolId, mark.id);
  }

  /**
   * §4.4 (R168): the gate. Moves the child's lowest-period mark of the day from absent to late
   * with the arrival time and the automatic reason; a replay of the same arrival is 200; any
   * other first mark (or none) is 409 ARRIVAL_NOT_ABSENT.
   */
  @Transactional()
  async arrival(session: SchoolSessionContext, dto: RecordArrivalDto): Promise<AttendanceMarkDto> {
    const { schoolId } = session;
    const date = fromDateString(dto.date);
    const today = await this.clock.today(schoolId);
    if (date > today) throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date must not be in the future');
    const studentId = BigInt(dto.studentId);
    await this.assertVisible(session, studentId, date);

    const periods = (await this.marks.childDays(schoolId, [studentId], date)).get(studentId) ?? [];
    const first = periods[0];
    if (!first) throw arrivalNotAbsent(null);
    const found = await this.marks.findById(schoolId, first.markId);
    if (!found) throw notFound();
    const role: WriteRole = await this.access.writeRole(session, found.sectionId, date, found.mode);
    if (!(await this.registers.lock(schoolId, found.registerId))) throw notFound();
    const mark = await this.marks.lock(schoolId, first.markId);
    if (!mark) throw notFound();
    if (mark.status === 'late' && mark.arrivedAt === dto.arrivedAt) {
      if (await this.marks.hasArrival(schoolId, mark.id, dto.arrivedAt)) return toMarkDto(mark);
    }
    if (mark.status !== 'absent') throw arrivalNotAbsent(mark.status);
    if (!(await this.calendar.isTeachingDay(schoolId, date))) throw notATeachingDay();
    const settings = await this.settings.read(schoolId);
    const open = windowOpen(date, today, settings.windowDays);
    if (role !== 'all' && !open) throw attendanceLocked(dto.date, settings.windowDays);

    await this.write(
      session,
      mark,
      { status: 'late', note: mark.note, arrivedAt: dto.arrivedAt },
      ARRIVAL_REASON(dto.arrivedAt),
      { today, settings, arrival: dto.arrivedAt },
    );
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'attendance_mark.arrival_recorded',
      subjectType: SUBJECT,
      subjectId: mark.id,
      metadata: {
        studentId: studentId.toString(),
        date: dto.date,
        period: mark.period,
        arrivedAt: dto.arrivedAt,
        afterWindow: !open,
      },
    });
    return this.reread(schoolId, mark.id);
  }

  /** §4.5: a mark's change rows, newest first by default, on the read scope of its date. */
  async changes(
    session: SchoolSessionContext,
    markId: bigint,
    query: MarkChangesQueryDto,
  ): Promise<Page<MarkChangeDto>> {
    const { schoolId } = session;
    const mark = await this.marks.findById(schoolId, markId);
    if (!mark) throw notFound();
    await this.access.readRole(session, mark.sectionId, mark.date);
    const { rows, total } = await this.marks.changes(
      schoolId,
      markId,
      query.sort ?? '-changedAt',
      (query.page - 1) * query.limit,
      query.limit,
    );
    return toPage(
      rows.map((r) => ({
        id: r.id.toString(),
        markId: r.markId.toString(),
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        noteChanged: r.noteChanged,
        fromArrivedAt: r.fromArrivedAt,
        toArrivedAt: r.toArrivedAt,
        changedBy: r.changedBy.toString(),
        changedByName: r.changedByName,
        changedAt: r.changedAt,
        reason: r.reason,
      })),
      query,
      total,
    );
  }

  /**
   * The arrival's visibility (§4.4): an enrolment of the student in force on the date whose
   * section is in the caller's mark scope on that date (school-wide: any); else 404.
   */
  private async assertVisible(session: SchoolSessionContext, studentId: bigint, date: Date): Promise<void> {
    const scope = await this.permissions.scopeOf(session, {
      capability: Capability.ATTENDANCE_STUDENT_MARK,
      on: date,
    });
    if (scope === null) throw notFound();
    const enrolments = await this.registers.enrolmentsInForce(session.schoolId, rowScope(scope), studentId, date);
    const visible = enrolments.some((e) => scope.kind === 'all' || scope.sections.has(e.sectionId));
    if (!visible) throw notFound();
  }

  /** One mark's write with history, register amender, alert step and after-commit jobs. */
  private async write(
    session: SchoolSessionContext,
    mark: MarkRecord,
    target: { status: AttendanceStatus; note: string | null; arrivedAt: string | null },
    reason: string,
    ctx: { today: Date; settings: Awaited<ReturnType<SchoolSettingsReader['read']>>; arrival: string | null },
  ): Promise<boolean> {
    const { schoolId } = session;
    const userId = session.access.userId;
    const now = this.clock.now();
    const before = await this.alertWriter.snapshot(schoolId, [mark.studentId], mark.date);
    await this.changeContext.setChangeContext(userId, reason);
    await this.marks.update(schoolId, mark.id, target);
    if (ctx.arrival !== null) await this.marks.insertArrival(schoolId, mark.id, ctx.arrival, userId, now);
    await this.registers.setAmended(schoolId, mark.registerId, userId, now);
    const outcome = await this.alertWriter.afterWrite(schoolId, {
      date: mark.date,
      studentIds: [mark.studentId],
      before,
      now,
      today: ctx.today,
      settings: ctx.settings,
    });
    await this.registerService.enqueueRollup(schoolId, mark.sectionId, mark.date);
    this.outbox.alertsAfterCommit(schoolId, outcome.jobs);
    return outcome.correctionCapped;
  }

  private async reread(schoolId: SchoolId, id: bigint): Promise<AttendanceMarkDto> {
    const mark = await this.marks.findById(schoolId, id);
    if (!mark) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return toMarkDto(mark);
  }
}
