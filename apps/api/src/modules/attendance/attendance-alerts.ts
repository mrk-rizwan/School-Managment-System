import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  deriveDayStatus,
  type AttendanceAlertKind,
  type DayStatus,
  type MessageType,
} from '@asms/shared';
import { NotificationService } from '../../messaging/notification.service';
import type { AlertJob } from '../../messaging/outbox-dispatcher';
import {
  AttendanceAlertRepository,
  type AlertRecord,
  type NewAlert,
} from '../../repositories/attendance-alert.repository';
import {
  AttendanceMarkRepository,
  type ChildPeriod,
} from '../../repositories/attendance-mark.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { CalendarService } from '../calendar/calendar.service';
import { atTimeOn, SchoolSettingsReader, type AttendanceSettings } from '../../common/school-settings-reader';

// contracts/slice-11.md §6 (R126, R168): the alert lifecycle. The writer (every mark write, in the
// writer's transaction) only creates and cancels rows; the processor (queue `attendance`, job
// `attendance-alert`) is the only sender. Every outbound attendance message has its alert row as
// subject, so R107 makes each send idempotent per row per guardian. Lock order: students →
// registers → marks → alerts (id order) → messages (§1.6).

const MINUTE_MS = 60_000;
/** An absence or late alert is due no sooner than 30 minutes after the write (§6.1). */
const GRACE_MS = 30 * MINUTE_MS;
/** At most three absence rows and three corrected rows per child-day (§6.1). */
const MAX_SEQ = 3;

/** A child's day as derived from its recorded periods: what a parent was or will be told. */
export interface DayState {
  status: DayStatus;
  firstLateArrivedAt: string | null;
}

export function dayState(periods: readonly ChildPeriod[]): DayState | null {
  if (periods.length === 0) return null;
  return {
    status: deriveDayStatus(periods).status,
    firstLateArrivedAt: periods.find((p) => p.status === 'late')?.arrivedAt ?? null,
  };
}

const sameDay = (a: DayState | null, b: DayState | null): boolean =>
  a?.status === b?.status && a?.firstLateArrivedAt === b?.firstLateArrivedAt;

/** What a write did to alert rows (RegisterSubmitResultDto.alerts) and what to enqueue. */
export interface AlertOutcome {
  absencePending: number;
  absenceBackdated: number;
  lateAdvicePending: number;
  cancelled: number;
  corrections: number;
  /** A fourth absence or corrected row was due and not created (§6.2). */
  correctionCapped: boolean;
  /** Pending rows created, to enqueue after commit with their due time. */
  jobs: AlertJob[];
}

const emptyOutcome = (): AlertOutcome => ({
  absencePending: 0,
  absenceBackdated: 0,
  lateAdvicePending: 0,
  cancelled: 0,
  corrections: 0,
  correctionCapped: false,
  jobs: [],
});

const latest = (rows: readonly AlertRecord[], kind: AttendanceAlertKind): AlertRecord | undefined =>
  rows.filter((r) => r.kind === kind).sort((a, b) => a.seq - b.seq).at(-1);

const sameDate = (a: Date, b: Date): boolean => a.getTime() === b.getTime();

/**
 * §6.2: the writer's alert step. Call `snapshot` before the mark statement and `afterWrite` after
 * it, in the same transaction, for the children whose marks were created or amended.
 */
@Injectable()
export class AttendanceAlertWriter {
  constructor(
    private readonly alerts: AttendanceAlertRepository,
    private readonly marks: AttendanceMarkRepository,
  ) {}

  /** Each child's day before the write (a corrected notice follows only a real change). */
  async snapshot(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    date: Date,
  ): Promise<Map<bigint, DayState | null>> {
    const days = await this.marks.childDays(schoolId, studentIds, date);
    return new Map(studentIds.map((id) => [id, dayState(days.get(id) ?? [])]));
  }

  async afterWrite(
    schoolId: SchoolId,
    input: {
      date: Date;
      studentIds: readonly bigint[];
      before: ReadonlyMap<bigint, DayState | null>;
      now: Date;
      today: Date;
      settings: AttendanceSettings;
    },
  ): Promise<AlertOutcome> {
    const outcome = emptyOutcome();
    const studentIds = [...new Set(input.studentIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (studentIds.length === 0) return outcome;
    const locked = await this.alerts.lockChildDays(schoolId, studentIds, input.date);
    const days = await this.marks.childDays(schoolId, studentIds, input.date);
    const isToday = sameDate(input.date, input.today);
    const dueAt = new Date(
      Math.max(
        input.now.getTime() + GRACE_MS,
        atTimeOn(input.settings.timezone, input.today, input.settings.absenceAlertTime).getTime(),
      ),
    );

    for (const studentId of studentIds) {
      const periods = days.get(studentId) ?? [];
      const day = dayState(periods);
      const first = periods[0];
      if (day === null || first === undefined) continue;
      const rows = locked.filter((r) => r.studentId === studentId);
      const absence = latest(rows, 'absence');
      const late = latest(rows, 'late');
      const corrected = rows.filter((r) => r.kind === 'corrected').sort((a, b) => a.seq - b.seq);
      const base = { enrolmentId: first.enrolmentId, studentId, date: input.date };

      const insert = async (row: Omit<NewAlert, keyof typeof base>): Promise<void> => {
        const created = await this.alerts.insert(schoolId, { ...base, ...row }, input.now);
        if (created.status === 'pending') outcome.jobs.push({ id: created.id, dueAt: created.dueAt });
      };
      const cancel = async (row: AlertRecord): Promise<void> => {
        await this.alerts.resolve(schoolId, row.id, { status: 'cancelled', reason: 'mark_changed' }, input.now);
        outcome.cancelled += 1;
      };
      // After a sent absence alert, a change to the day is told as a correction: at most three,
      // and a pending one already states the day as it will be when sent (natural debounce).
      // A fourth row of a kind was due: nothing is sent; the kind's latest row records the cap.
      const capped = async (row: AlertRecord | undefined): Promise<void> => {
        outcome.correctionCapped = true;
        if (row !== undefined) await this.alerts.markCapped(schoolId, row.id, input.now);
      };
      const correct = async (): Promise<void> => {
        if (sameDay(input.before.get(studentId) ?? null, day)) return;
        if (corrected.at(-1)?.status === 'pending') return;
        if (corrected.length >= MAX_SEQ) return capped(corrected.at(-1));
        await insert({
          kind: 'corrected',
          seq: corrected.length + 1,
          dueAt: input.now,
          status: 'pending',
          cancelReason: null,
        });
        outcome.corrections += 1;
      };

      if (day.status === 'absent') {
        if (absence === undefined || absence.cancelReason === 'mark_changed') {
          const seq = (absence?.seq ?? 0) + 1;
          if (seq > MAX_SEQ) await capped(absence);
          else if (isToday) {
            await insert({ kind: 'absence', seq, dueAt, status: 'pending', cancelReason: null });
            outcome.absencePending += 1;
          } else {
            await insert({ kind: 'absence', seq, dueAt: input.now, status: 'cancelled', cancelReason: 'backdated' });
            outcome.absenceBackdated += 1;
          }
        } else if (absence.status === 'sent') {
          await correct();
        }
      } else if (absence?.status === 'pending') {
        await cancel(absence);
      } else if (absence?.status === 'sent') {
        await correct();
      }

      const hasLate = periods.some((p) => p.status === 'late');
      if (hasLate && day.status !== 'absent' && input.settings.lateAdviceEnabled && late === undefined) {
        if (!isToday) {
          await insert({ kind: 'late', seq: 1, dueAt: input.now, status: 'cancelled', cancelReason: 'backdated' });
        } else if (absence?.status !== 'sent') {
          await insert({ kind: 'late', seq: 1, dueAt, status: 'pending', cancelReason: null });
          outcome.lateAdvicePending += 1;
        }
      }
      if (!hasLate && late?.status === 'pending') await cancel(late);
    }
    return outcome;
  }
}

/** The message type each kind sends. */
const MESSAGE: Record<AttendanceAlertKind, MessageType> = {
  absence: 'absence_alert',
  late: 'late_advice',
  corrected: 'attendance_corrected',
};

export type ProcessResult = 'sent' | 'cancelled' | 'none';

/**
 * §6.4: the processor of one alert row. Reads the row, then locks its whole child-day in id
 * order (the writer's order, so the two never deadlock) and re-checks that the row is still
 * pending and due: a replay, a cancelled row or an early sweep re-enqueue ends with no effect.
 * Recipients are resolved now (§6.3). Worker transitions are not audited: the row is the record.
 */
@Injectable()
export class AttendanceAlertProcessor {
  constructor(
    private readonly alerts: AttendanceAlertRepository,
    private readonly marks: AttendanceMarkRepository,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly notifications: NotificationService,
  ) {}

  @Transactional()
  async run(schoolId: SchoolId, alertId: bigint, now: Date = new Date()): Promise<ProcessResult> {
    const found = await this.alerts.findById(schoolId, alertId);
    if (!found || found.status !== 'pending' || found.dueAt > now) return 'none';
    const rows = await this.alerts.lockChildDays(schoolId, [found.studentId], found.date);
    const alert = rows.find((r) => r.id === alertId);
    if (!alert || alert.status !== 'pending' || alert.dueAt > now) return 'none';

    if (!(await this.calendar.isTeachingDay(schoolId, alert.date))) {
      await this.alerts.resolve(schoolId, alert.id, { status: 'cancelled', reason: 'holiday' }, now);
      return 'cancelled';
    }
    const periods = (await this.marks.childDays(schoolId, [alert.studentId], alert.date)).get(alert.studentId) ?? [];
    const day = dayState(periods);
    const hasLate = periods.some((p) => p.status === 'late');

    switch (alert.kind) {
      case 'absence':
        if (day?.status === 'absent') return this.send(schoolId, alert, day, now);
        await this.alerts.resolve(schoolId, alert.id, { status: 'cancelled', reason: 'mark_changed' }, now);
        // An arrival before the alert was due: the late advice instead, if the school sends one.
        if (hasLate && day !== null && !rows.some((r) => r.kind === 'late')) {
          const { lateAdviceEnabled } = await this.settings.read(schoolId);
          if (lateAdviceEnabled) {
            const lateRow = await this.alerts.insert(
              schoolId,
              {
                enrolmentId: alert.enrolmentId,
                studentId: alert.studentId,
                date: alert.date,
                kind: 'late',
                seq: 1,
                dueAt: now,
                status: 'pending',
                cancelReason: null,
              },
              now,
            );
            await this.send(schoolId, lateRow, day, now);
          }
        }
        return 'cancelled';
      case 'late':
        if (hasLate && day !== null && day.status !== 'absent') return this.send(schoolId, alert, day, now);
        await this.alerts.resolve(schoolId, alert.id, { status: 'cancelled', reason: 'mark_changed' }, now);
        return 'cancelled';
      case 'corrected':
        if (day === null) {
          await this.alerts.resolve(schoolId, alert.id, { status: 'cancelled', reason: 'mark_changed' }, now);
          return 'cancelled';
        }
        return this.send(schoolId, alert, day, now);
    }
  }

  /** §6.4 step 4: recipients now; none → cancelled link_ended, else one message each → sent. */
  private async send(schoolId: SchoolId, alert: AlertRecord, day: DayState, now: Date): Promise<ProcessResult> {
    const guardians = await this.alerts.recipients(schoolId, alert.studentId);
    const subject = await this.alerts.subject(schoolId, alert.enrolmentId);
    if (guardians.length === 0 || subject === null) {
      await this.alerts.resolve(schoolId, alert.id, { status: 'cancelled', reason: 'link_ended' }, now);
      return 'cancelled';
    }
    const recipients = guardians.map((guardianId) => ({ guardianId }));
    const common = { subject: { type: 'attendance_alert' as const, id: alert.id }, recipients };
    const who = { ...subject, date: alert.date };
    switch (MESSAGE[alert.kind]) {
      case 'absence_alert':
        await this.notifications.send(schoolId, { type: 'absence_alert', ...common, vars: who });
        break;
      case 'late_advice':
        await this.notifications.send(schoolId, {
          type: 'late_advice',
          ...common,
          vars: { ...who, arrivedAt: day.firstLateArrivedAt },
        });
        break;
      default:
        await this.notifications.send(schoolId, {
          type: 'attendance_corrected',
          ...common,
          vars: { ...who, status: day.status, arrivedAt: day.firstLateArrivedAt },
        });
    }
    await this.alerts.resolve(schoolId, alert.id, { status: 'sent' }, now);
    return 'sent';
  }
}
