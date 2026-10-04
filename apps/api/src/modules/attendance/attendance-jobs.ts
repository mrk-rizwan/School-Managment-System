import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, deriveDayStatus } from '@asms/shared';
import { addDays, todayIn } from '../../common/school-clock';
import { NotificationService } from '../../messaging/notification.service';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AttendanceAlertRepository } from '../../repositories/attendance-alert.repository';
import { AttendanceRegisterRepository } from '../../repositories/attendance-register.repository';
import { UserRepository } from '../../repositories/user.repository';
import {
  AttendanceSummaryRepository,
  type DayStatusWrite,
  type SectionDayKey,
  type SectionDayMark,
} from '../../repositories/attendance-summary.repository';
import { MessageRepository } from '../../repositories/message.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { CalendarService } from '../calendar/calendar.service';
import { atTimeOn, SchoolSettingsReader } from '../../common/school-settings-reader';

// contracts/slice-11.md §8 (R129, R131): the worker side of attendance. Every body runs inside
// QueueTenancy.runAsSchool (src/jobs/job-runner.ts) with a SchoolId; nothing here is audited (no
// actor: the rows and messages are the record).

const MINUTE_MS = 60_000;
/** The outbox sweep's idle age and batch (slice-9 §7.9). */
const SWEEP_IDLE_MS = 2 * MINUTE_MS;
const SWEEP_LIMIT = 500;
/** The nightly net: the last 7 days, at most 200 section-days per school per run (§8.3). */
const NIGHTLY_DAYS = 7;
const NIGHTLY_LIMIT = 200;

/** §8.2: one section-day's materialised status and summary. */
@Injectable()
export class AttendanceRollup {
  constructor(
    private readonly summaries: AttendanceSummaryRepository,
    private readonly registers: AttendanceRegisterRepository,
    private readonly settings: SchoolSettingsReader,
  ) {}

  /**
   * Recomputes `attendance_day_status` for every enrolment marked on the section-day, then the
   * summary row, which is completed only if its version is still the one read first: a write
   * that landed meanwhile bumped it and its own job recomputes (no lost update). Returns whether
   * this run completed the row.
   */
  @Transactional()
  async recompute(schoolId: SchoolId, sectionId: bigint, date: Date, now: Date = new Date()): Promise<boolean> {
    const summary = await this.summaries.version(schoolId, sectionId, date);
    if (summary === null) return false;
    const marks = await this.summaries.marksOfSectionDay(schoolId, sectionId, date);
    const rows = dayStatusRows(marks);
    await this.summaries.upsertDayStatus(schoolId, sectionId, date, rows, now);
    const { periodsPerDay } = await this.settings.read(schoolId);
    const count = (status: DayStatusWrite['status']) => rows.filter((r) => r.status === status).length;
    return this.summaries.complete(
      schoolId,
      sectionId,
      date,
      summary.version,
      {
        rosterCount: await this.registers.rosterCount(schoolId, sectionId, date),
        registersRecorded: await this.registers.countForSectionDay(schoolId, sectionId, date),
        registersExpected: summary.mode === 'daily' ? 1 : periodsPerDay,
        present: count('present'),
        absent: count('absent'),
        late: count('late'),
        onLeave: count('on_leave'),
        partial: count('partial'),
      },
      now,
    );
  }
}

/** R127 per enrolment-day; the first late arrival is the lowest-period late mark's. */
export function dayStatusRows(marks: readonly SectionDayMark[]): DayStatusWrite[] {
  const byEnrolment = new Map<bigint, SectionDayMark[]>();
  for (const mark of marks) {
    const list = byEnrolment.get(mark.enrolmentId) ?? [];
    list.push(mark);
    byEnrolment.set(mark.enrolmentId, list);
  }
  return [...byEnrolment.values()].flatMap((periods) => {
    const first = periods[0];
    if (!first) return [];
    const { status, counts } = deriveDayStatus(periods);
    const firstLate = [...periods].sort((a, b) => a.period - b.period).find((p) => p.status === 'late');
    return [
      {
        enrolmentId: first.enrolmentId,
        studentId: first.studentId,
        status,
        recorded: counts.recorded,
        present: counts.present,
        late: counts.late,
        absent: counts.absent,
        leave: counts.leave,
        firstLateArrivedAt: firstLate?.arrivedAt ?? null,
      },
    ];
  });
}

const rollupJob = (key: SectionDayKey) => ({
  sectionId: key.sectionId,
  date: toDateString(key.date),
  version: key.version,
});

/** §8.3: the attendance sources of the outbox sweep, and the nightly recompute. */
@Injectable()
export class AttendanceSweeps {
  private readonly logger = new Logger('AttendanceSweeps');

  constructor(
    private readonly alerts: AttendanceAlertRepository,
    private readonly summaries: AttendanceSummaryRepository,
    private readonly rollup: AttendanceRollup,
    private readonly outbox: OutboxDispatcher,
    private readonly settings: SchoolSettingsReader,
  ) {}

  /**
   * Pending alerts due over 2 minutes ago are re-enqueued (`alert:<id>:s<minute>`); stale
   * summaries are enqueued at their current version (the same id their own write used, so a
   * pending job collapses onto it and a lost one is recovered).
   */
  async outboxSweep(schoolId: SchoolId, now: Date = new Date()): Promise<{ alerts: number; rollups: number }> {
    const due = await this.alerts.listDue(schoolId, new Date(now.getTime() - SWEEP_IDLE_MS), SWEEP_LIMIT);
    const minute = Math.floor(now.getTime() / MINUTE_MS);
    await this.outbox.alerts(
      schoolId,
      due.map((id) => ({ id, dueAt: now, sweepMinute: minute })),
      now,
    );
    const stale = await this.summaries.listStale(schoolId, SWEEP_LIMIT);
    await this.outbox.rollups(schoolId, stale.map(rollupJob));
    return { alerts: due.length, rollups: stale.length };
  }

  /**
   * 00:30 school time: every stale section-day plus every section-day of the last 7 days with a
   * summary row, each recomputed in its own transaction, at most 200 per run.
   */
  async nightly(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const { timezone } = await this.settings.read(schoolId);
    const today = todayIn(timezone, now);
    const keys = new Map<string, SectionDayKey>();
    for (const key of [
      ...(await this.summaries.listStale(schoolId, NIGHTLY_LIMIT)),
      ...(await this.summaries.listSince(schoolId, addDays(today, -NIGHTLY_DAYS), NIGHTLY_LIMIT)),
    ]) {
      keys.set(`${key.sectionId}:${toDateString(key.date)}`, key);
    }
    const batch = [...keys.values()].slice(0, NIGHTLY_LIMIT);
    if (keys.size > NIGHTLY_LIMIT) {
      this.logger.warn({ deferred: keys.size - NIGHTLY_LIMIT }, 'nightly recompute deferred section-days');
    }
    for (const key of batch) await this.rollup.recompute(schoolId, key.sectionId, key.date, now);
    return batch.length;
  }
}

/** §8.4 (R129): one `register_unrecorded` per school per teaching day, after the deadline. */
@Injectable()
export class RegisterDeadlineSweep {
  constructor(
    private readonly registers: AttendanceRegisterRepository,
    private readonly users: UserRepository,
    private readonly messages: MessageRepository,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationService,
  ) {}

  /** The register watchers: confirmed holders of attendance.student.mark with all scope. */
  async watchers(schoolId: SchoolId): Promise<bigint[]> {
    const staffIds: bigint[] = [];
    for (const candidate of await this.users.watcherCandidates(
      schoolId,
      Capability.ATTENDANCE_STUDENT_MARK,
    )) {
      const access = await this.permissions.load(schoolId, candidate.userId);
      if (!access?.capacities.staff) continue;
      const line = access.lines.find((l) => l.capability === Capability.ATTENDANCE_STUDENT_MARK);
      if (line && line.scope !== 'assigned_sections') staffIds.push(candidate.staffId);
    }
    return staffIds;
  }

  /** 'sent', or why nothing was sent. Idempotent by R107's subject `register_deadline / YYYYMMDD`. */
  @Transactional()
  async run(
    schoolId: SchoolId,
    now: Date = new Date(),
  ): Promise<'sent' | 'before_deadline' | 'not_teaching_day' | 'already_sent' | 'all_recorded' | 'no_watchers'> {
    const settings = await this.settings.read(schoolId);
    const today = todayIn(settings.timezone, now);
    if (now < atTimeOn(settings.timezone, today, settings.registerDeadlineTime)) return 'before_deadline';
    if (!(await this.calendar.isTeachingDay(schoolId, today))) return 'not_teaching_day';
    const subjectId = BigInt(toDateString(today).replaceAll('-', ''));
    if ((await this.messages.findBySubject(schoolId, 'register_deadline', subjectId)).length > 0) {
      return 'already_sent';
    }
    const unrecorded = await this.registers.unrecordedForDeadline(schoolId, today);
    if (unrecorded.length === 0) return 'all_recorded';
    const watchers = await this.watchers(schoolId);
    if (watchers.length === 0) return 'no_watchers';
    await this.notifications.send(schoolId, {
      type: 'register_unrecorded',
      subject: { type: 'register_deadline', id: subjectId },
      recipients: watchers.map((staffId) => ({ staffId })),
      vars: {
        date: today,
        deadlineTime: settings.registerDeadlineTime,
        sections: unrecorded.map((s) => ({
          className: s.className,
          sectionName: s.sectionName,
          coverStaffName: s.coverStaffName,
        })),
      },
    });
    return 'sent';
  }
}
