import { Injectable } from '@nestjs/common';
import type { AttendanceValueSettings } from '@asms/shared';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
import { SchoolSettingsRepository } from '../repositories/school-settings.repository';
import type { SchoolId } from '../tenancy/school-id';
import { dayStart } from './school-clock';

// The attendance settings of one school (plan §4.5) with its time zone, read per request or job,
// never cached: student attendance (slice 11) and the diary's edit window (slice 13, which shares
// attendance_amend_window_days, decision 5) read them through this one reader. TIME columns
// arrive as 1970-01-01 UTC instants and become `HH:MM` here. A school always has its settings row
// (written when it is created); the column defaults stand in when a row is missing.

const MINUTE_MS = 60_000;

export interface AttendanceSettings {
  timezone: string;
  periodsPerDay: number;
  windowDays: number;
  /** `HH:MM`. */
  registerDeadlineTime: string;
  /** `HH:MM`. */
  absenceAlertTime: string;
  lateAdviceEnabled: boolean;
  weeklyOffDays: number[];
  value: AttendanceValueSettings;
}

/** A TIME column value (a 1970-01-01 UTC instant) as `HH:MM`. */
export const timeOfDay = (value: Date): string => value.toISOString().slice(11, 16);

/** The instant of `HH:MM` on a calendar date in the school's time zone. */
export function atTimeOn(timezone: string, day: Date, time: string): Date {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return new Date(dayStart(timezone, day).getTime() + (hours * 60 + minutes) * MINUTE_MS);
}

@Injectable()
export class SchoolSettingsReader {
  constructor(
    private readonly settings: SchoolSettingsRepository,
    private readonly school: OwnSchoolRepository,
  ) {}

  async read(schoolId: SchoolId): Promise<AttendanceSettings> {
    const school = await this.school.find(schoolId);
    if (!school) throw new Error('school row missing for a resolved tenant');
    const row = await this.settings.find(schoolId);
    return {
      timezone: school.timezone,
      periodsPerDay: row?.periodsPerDay ?? 8,
      windowDays: row?.attendanceAmendWindowDays ?? 3,
      registerDeadlineTime: row ? timeOfDay(row.registerDeadlineTime) : '10:00',
      absenceAlertTime: row ? timeOfDay(row.absenceAlertTime) : '09:30',
      lateAdviceEnabled: row?.lateAdviceEnabled ?? false,
      weeklyOffDays: [...(row?.weeklyOffDays ?? [0])].sort((a, b) => a - b),
      value: {
        lateCountsAs: row?.lateCountsAs ?? 'present',
        lateCutoffTime: row?.lateCutoffTime ? timeOfDay(row.lateCutoffTime) : null,
        leaveCountsAs: row?.leaveCountsAs ?? 'excused',
      },
    };
  }
}
