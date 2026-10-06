// Slice 25 test support: a school whose working days are Monday to Saturday (Sunday off, no
// holiday), its seeded leave types, staff with salary structures, staff attendance marks and
// approved leave written as the slice-12 and slice-24 services would leave them. September 2026 has
// 26 such working days.
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { StaffAttendanceStatus } from '@asms/shared';
import { PayrollPrepare } from '../../src/modules/payroll/payroll-prepare.job';
import type { SchoolId } from '../../src/tenancy/school-id';
import { asSchool } from '../messaging/support';
import { createSchool, testDb, type TestSchool } from '../support/schools';
import { day } from '../support/students';

export const db = () => testDb();

/**
 * A SchoolClock stand-in (createTestApp overrides) whose "today" is `state.today` (Asia/Karachi),
 * for a whole suite; a test moves it when it needs another day.
 */
export function fixedClock(start: string) {
  const state = { today: start };
  const value = {
    now: () => new Date(Date.parse(`${state.today}T07:00:00.000Z`)),
    today: () => Promise.resolve(day(state.today)),
    timezone: () => Promise.resolve('Asia/Karachi'),
  };
  return { state, value };
}

export interface LeaveTypes {
  casual: bigint;
  sick: bigint;
  unpaid: bigint;
}

/** A school with settings (Sunday off unless `weeklyOffDays`), finance seeds and leave types. */
export async function payrollSchool(weeklyOffDays: number[] = [0]): Promise<{ school: TestSchool; types: LeaveTypes }> {
  const school = await createSchool();
  await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, weeklyOffDays } });
  await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
  const rows = await db().leaveType.findMany({ where: { schoolId: school.id }, select: { id: true, code: true } });
  const of = (code: string) => {
    const row = rows.find((r) => r.code === code);
    if (!row) throw new Error(`no seeded ${code} leave type`);
    return row.id;
  };
  return { school, types: { casual: of('casual'), sick: of('sick'), unpaid: of('unpaid') } };
}

/** Staff attendance marks, recorded by `markedBy` (never the person: staff_attendance_not_self). */
export async function marks(
  school: TestSchool,
  staffId: bigint,
  markedBy: bigint,
  days: Record<string, StaffAttendanceStatus>,
): Promise<void> {
  await db().staffAttendance.createMany({
    data: Object.entries(days).map(([date, status]) => ({ schoolId: school.id, staffId, date: day(date), status, markedBy })),
  });
}

/** An approved leave request (or ended early on `endedEarlyOn`), decided by `decidedBy`. */
export async function approvedLeave(
  school: TestSchool,
  staffId: bigint,
  leaveTypeId: bigint,
  startsOn: string,
  endsOn: string,
  decidedBy: bigint,
  endedEarlyOn?: string,
): Promise<void> {
  await db().leaveRequest.create({
    data: {
      schoolId: school.id,
      staffId,
      leaveTypeId,
      startsOn: day(startsOn),
      endsOn: day(endsOn),
      workingDays: 1,
      reason: 'Family matter',
      requestedBy: decidedBy,
      status: endedEarlyOn === undefined ? 'approved' : 'ended_early',
      decidedBy,
      decidedAt: new Date(),
      ...(endedEarlyOn === undefined ? {} : { endedEarlyOn: day(endedEarlyOn) }),
    },
  });
}

/** Every September 2026 working day (Sunday off) not in `except`, as `status`. */
export function september(status: StaffAttendanceStatus, except: readonly string[] = []): Record<string, StaffAttendanceStatus> {
  const out: Record<string, StaffAttendanceStatus> = {};
  for (let d = 1; d <= 30; d++) {
    const iso = `2026-09-${String(d).padStart(2, '0')}`;
    if (new Date(`${iso}T00:00:00Z`).getUTCDay() === 0 || except.includes(iso)) continue;
    out[iso] = status;
  }
  return out;
}

/** The pay-day job body for one school at `now`. */
export const payDay = (app: NestExpressApplication, schoolId: SchoolId, now: Date): Promise<bigint | null> =>
  asSchool(app, schoolId, () => app.get(PayrollPrepare, { strict: false }).run(schoolId, now));

/** `isoDay` at `hour` o'clock in Asia/Karachi (UTC+5). */
export const karachi = (isoDay: string, hour = 8): Date =>
  new Date(Date.parse(`${isoDay}T00:00:00.000Z`) + (hour - 5) * 3_600_000);
