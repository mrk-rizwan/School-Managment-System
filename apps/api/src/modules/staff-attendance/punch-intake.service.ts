import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  isStaffWorkingDay,
  markFromPunch,
  punchDay,
  punchOutsideWindow,
  type PunchOutcome,
  type PunchResultOutcome,
} from '@asms/shared';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { SchoolClock } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  DevicePunchRepository,
  punchKey,
  type NewPunch,
} from '../../repositories/device-punch.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StaffAttendanceRepository } from '../../repositories/staff-attendance.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import type { DevicePunchBatchDto, DevicePunchBatchResultDto } from './biometric.dto';

// contracts/slice-44.md §2.2 (R345, A11). The school comes only from the device token the route
// guard resolved (DevicePunchService.authorise, @CurrentDevice); nothing in the body names one.

/** A device user id the identity CHECKs would refuse (device_punches_device_user_id_no_id_check). */
const IDENTITY_SHAPED = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const NATURAL_KEY = 'staff_attendance_natural_key';

/** A TIME column as Prisma reads it (1970-01-01 UTC) → `HH:MM:SS`. */
const clockOf = (value: Date): string => value.toISOString().slice(11, 19);

interface Planned {
  index: number;
  deviceUserId: string;
  punchedAt: Date;
  day: string;
  outcome: PunchResultOutcome;
  /** Set for a punch that is to be stored. */
  row?: NewPunch;
  /** Set for a `marked` punch. */
  mark?: { staffId: bigint; status: 'present' | 'late' };
}

@Injectable()
export class PunchIntakeService {
  constructor(
    private readonly punches: DevicePunchRepository,
    private readonly marks: StaffAttendanceRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly calendar: CalendarService,
    private readonly clock: SchoolClock,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * Always answers every punch (no 4xx for a punch the body shape allowed). A manual mark landing on
   * a day in the same instant fails the natural key; the batch runs once more and sees it.
   */
  async receive(schoolId: SchoolId, dto: DevicePunchBatchDto): Promise<DevicePunchBatchResultDto> {
    const run = () => this.receiveInTransaction(schoolId, dto);
    return recoverConstraint(NATURAL_KEY, run, run);
  }

  @Transactional()
  private async receiveInTransaction(
    schoolId: SchoolId,
    dto: DevicePunchBatchDto,
  ): Promise<DevicePunchBatchResultDto> {
    const receivedAt = this.clock.now();
    const timezone = await this.clock.timezone(schoolId);
    const lateAfterRaw = (await this.settings.find(schoolId))?.staffLateAfter ?? null;
    const lateAfter = lateAfterRaw === null ? null : clockOf(lateAfterRaw);

    // 1. Parse; reject what is outside the window or shaped like an identity number.
    const planned: Planned[] = dto.punches.map((p, index) => {
      const punchedAt = new Date(p.punchedAt);
      const rejected =
        Number.isNaN(punchedAt.getTime()) ||
        punchOutsideWindow(punchedAt, receivedAt) ||
        IDENTITY_SHAPED.test(p.deviceUserId);
      return {
        index,
        deviceUserId: p.deviceUserId,
        punchedAt,
        day: rejected ? '' : punchDay(punchedAt, timezone),
        outcome: rejected ? 'rejected' : 'stored',
      };
    });
    const accepted = planned.filter((p) => p.outcome !== 'rejected');
    const directions = new Map(dto.punches.map((p, i) => [i, p.direction ?? null]));

    // 2. What the school holds now: the mapping, the stored keys, the marked days, the calendar.
    const holders = await this.punches.holders(schoolId, [...new Set(accepted.map((p) => p.deviceUserId))]);
    const seen = await this.punches.storedKeys(schoolId, accepted);
    const days = [...new Set(accepted.map((p) => p.day))].sort();
    const marked = await this.marks.markedDays(
      schoolId,
      [...new Set([...holders.values()].map((h) => h.staffId))],
      days.map(fromDateString),
    );
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const calendar =
      firstDay === undefined || lastDay === undefined
        ? null
        : (await this.calendar.calendar(schoolId, fromDateString(firstDay), fromDateString(lastDay))).value;

    // 3. Decide in punchedAt order, so the day's first punch is the one that marks.
    const ordered = [...accepted].sort(
      (a, b) => a.punchedAt.getTime() - b.punchedAt.getTime() || a.index - b.index,
    );
    for (const p of ordered) {
      const key = punchKey(p.deviceUserId, p.punchedAt);
      if (seen.has(key)) {
        p.outcome = 'duplicate';
        continue;
      }
      seen.add(key);
      const holder = holders.get(p.deviceUserId);
      let outcome: PunchOutcome;
      if (holder === undefined) outcome = 'unmapped';
      else if (holder.status !== 'active') outcome = 'inactive';
      else {
        const dayKey = `${holder.staffId}|${p.day}`;
        const markable =
          calendar !== null &&
          isStaffWorkingDay(p.day, calendar) &&
          (holder.joinedOn === null || fromDateString(p.day) >= holder.joinedOn) &&
          !marked.has(dayKey);
        if (markable) {
          marked.add(dayKey);
          p.mark = { staffId: holder.staffId, status: markFromPunch(p.punchedAt, lateAfter, timezone) };
          outcome = 'marked';
        } else {
          outcome = 'stored';
        }
      }
      p.outcome = outcome;
      p.row = {
        staffId: holder?.staffId ?? null,
        deviceUserId: p.deviceUserId,
        punchedAt: p.punchedAt,
        direction: directions.get(p.index) ?? null,
        outcome,
      };
    }

    // 4. Store (ON CONFLICT DO NOTHING), then the marks of the punches that made one.
    const toStore = ordered.filter((p) => p.row !== undefined);
    const inserted = new Map(
      (await this.punches.insert(schoolId, toStore.flatMap((p): NewPunch[] => (p.row === undefined ? [] : [p.row])))).map((r) => [
        punchKey(r.deviceUserId, r.punchedAt),
        r.id,
      ]),
    );
    const punchIds = new Map<number, bigint>();
    for (const p of toStore) {
      const id = inserted.get(punchKey(p.deviceUserId, p.punchedAt));
      // Absent: a concurrent request stored the same punch first (it marked, if anything did).
      if (id === undefined) {
        p.outcome = 'duplicate';
        delete p.mark;
      } else {
        punchIds.set(p.index, id);
      }
    }
    const markedPunches = toStore.flatMap((p) => {
      const devicePunchId = punchIds.get(p.index);
      return p.mark === undefined || devicePunchId === undefined
        ? []
        : [{ staffId: p.mark.staffId, date: fromDateString(p.day), status: p.mark.status, devicePunchId }];
    });
    const marks = new Map(
      (await this.marks.createDeviceMarks(schoolId, markedPunches)).map((m) => [m.devicePunchId, m.id]),
    );

    // 5. Audit what was refused; the punch rows are the record of the rest.
    const rejected = planned.filter((p) => p.outcome === 'rejected').length;
    if (rejected > 0) {
      await this.audit.recordSystem(schoolId, {
        action: 'device_punch.rejected',
        subjectType: 'school',
        subjectId: schoolId,
        metadata: { job: 'device', count: rejected, received: planned.length },
      });
    }

    return {
      results: dto.punches.map((p, index) => {
        const plan = planned[index];
        const punchId = punchIds.get(index);
        const markId = punchId === undefined ? undefined : marks.get(punchId);
        return {
          deviceUserId: p.deviceUserId,
          punchedAt: p.punchedAt,
          outcome: plan?.outcome ?? 'rejected',
          staffAttendanceId: plan?.outcome === 'marked' && markId !== undefined ? markId.toString() : null,
        };
      }),
    };
  }
}
