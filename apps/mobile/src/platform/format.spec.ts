import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_STATUS_LABELS,
  ANNOUNCEMENT_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUSES,
  dayInSchool,
  formatDate,
  formatTime,
  isTodayInSchool,
  REMARK_CATEGORIES,
  REMARK_CATEGORY_LABELS,
} from '@asms/shared';
import { sentLabel } from '../inbox/inbox-model';
import { markWord } from '../attendance/register-model';
import { statusTone } from '../ui/theme';

// The formatters and labels @asms/shared gives both clients (packages/shared/src/format.ts and
// the enum label maps). Pakistan is UTC+5 all year: no daylight saving to cross.

describe('formatTime: HH:MM, 24-hour, in school time', () => {
  test.each([
    ['2026-10-04T04:32:00.000Z', '09:32'],
    ['2026-10-04T19:00:00.000Z', '00:00'],
    ['2026-10-04T19:05:00.000Z', '00:05'],
    ['2026-10-04T18:59:00.000Z', '23:59'],
    ['2026-10-04T07:00:00.000Z', '12:00'],
  ])('%s → %s', (iso, time) => {
    expect(formatTime(iso)).toBe(time);
  });
});

describe('dayInSchool: the Pakistan calendar day of an instant', () => {
  test.each([
    ['2026-10-04T04:32:00.000Z', '2026-10-04'],
    ['2026-10-04T18:59:59.000Z', '2026-10-04'],
    ['2026-10-04T19:00:00.000Z', '2026-10-05'],
    ['2026-12-31T19:00:00.000Z', '2027-01-01'],
  ])('%s → %s', (iso, day) => {
    expect(dayInSchool(iso)).toBe(day);
  });
});

describe('isTodayInSchool and the "time if today, else the date" rule', () => {
  test.each([
    ['2026-10-04T04:32:00.000Z', '2026-10-04', true, '09:32'],
    ['2026-10-04T19:00:00.000Z', '2026-10-04', false, formatDate('2026-10-04T19:00:00.000Z')],
    ['2026-10-04T19:00:00.000Z', '2026-10-05', true, '00:00'],
    ['2026-10-01T04:32:00.000Z', '2026-10-04', false, formatDate('2026-10-01T04:32:00.000Z')],
  ])('%s on %s', (iso, today, isToday, label) => {
    expect(isTodayInSchool(iso, today)).toBe(isToday);
    expect(sentLabel(iso, today)).toBe(label);
  });
});

describe('labels: one per value, both clients read the same words', () => {
  test.each([
    ['announcement categories', ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_CATEGORY_LABELS],
    ['announcement statuses', ANNOUNCEMENT_STATUSES, ANNOUNCEMENT_STATUS_LABELS],
    ['remark categories', REMARK_CATEGORIES, REMARK_CATEGORY_LABELS],
    ['attendance statuses', ATTENDANCE_STATUSES, ATTENDANCE_STATUS_LABELS],
  ] as const)('%s', (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect((labels as Record<string, string>)[value]).toMatch(/^[A-Z]/);
    }
  });

  test('an attendance status: "On leave" as a label and a chip, "on leave" mid-sentence', () => {
    expect(ATTENDANCE_STATUS_LABELS.on_leave).toBe('On leave');
    expect(statusTone('on_leave').word).toBe('On leave');
    expect(markWord('on_leave')).toBe('on leave');
    expect(ATTENDANCE_STATUSES.map(markWord)).toEqual(['present', 'absent', 'late', 'on leave']);
  });
});
