// R116's pure functions (packages/shared/src/calendar.ts, contracts/slice-10.md §3). The caller
// passes only published holidays; these cases are the contract's.
import {
  isStaffWorkingDay,
  isTeachingDay,
  teachingDays,
  weekdayOf,
  type SchoolCalendar,
} from '@asms/shared';

// October 2026: the 4th, 11th, 18th and 25th are Sundays.
const sundaysOff: SchoolCalendar = { weeklyOffDays: [0], holidays: [] };

describe('teaching days (R116)', () => {
  it('weekday is the date’s own day, 0 = Sunday', () => {
    expect(weekdayOf('2026-10-04')).toBe(0);
    expect(weekdayOf('2026-10-03')).toBe(6);
  });

  it('counts calendar days minus weekly-off days, both ends inclusive', () => {
    expect(teachingDays('2026-10-01', '2026-10-31', sundaysOff)).toBe(27);
    expect(teachingDays('2026-10-05', '2026-10-05', sundaysOff)).toBe(1);
    expect(teachingDays('2026-10-04', '2026-10-04', sundaysOff)).toBe(0);
    expect(teachingDays('2026-10-31', '2026-10-01', sundaysOff)).toBe(0);
    expect(teachingDays('2026-10-01', '2026-10-31', { weeklyOffDays: [], holidays: [] })).toBe(31);
  });

  it('subtracts holiday ranges; a holiday on a weekly-off day is not counted twice', () => {
    const calendar: SchoolCalendar = {
      weeklyOffDays: [0],
      holidays: [
        // Mon 12 - Sun 18 October: six teaching days lost, not seven.
        { startsOn: '2026-10-12', endsOn: '2026-10-18', appliesToStaff: true },
        // A public holiday on Sunday the 25th changes nothing.
        { startsOn: '2026-10-25', endsOn: '2026-10-25', appliesToStaff: true },
      ],
    };
    expect(teachingDays('2026-10-01', '2026-10-31', calendar)).toBe(21);
    expect(isTeachingDay('2026-10-12', calendar)).toBe(false);
    expect(isTeachingDay('2026-10-19', calendar)).toBe(true);
  });

  it('a teaching holiday that does not apply to staff is still a staff working day', () => {
    const calendar: SchoolCalendar = {
      weeklyOffDays: [0],
      holidays: [{ startsOn: '2026-10-20', endsOn: '2026-10-20', appliesToStaff: false }],
    };
    expect(isTeachingDay('2026-10-20', calendar)).toBe(false);
    expect(isStaffWorkingDay('2026-10-20', calendar)).toBe(true);
    expect(isStaffWorkingDay('2026-10-18', calendar)).toBe(false);
  });

  it('refuses anything but a real YYYY-MM-DD date', () => {
    for (const date of ['2026-02-30', '2026-1-01', '01-10-2026', '']) {
      expect(() => isTeachingDay(date, sundaysOff)).toThrow(RangeError);
    }
  });
});
