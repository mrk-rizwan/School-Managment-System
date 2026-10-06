import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { StaffDto } from '../lib/api/school-staff-contract';
import type {
  MyStaffAttendanceDto,
  StaffAttendanceDto,
  StaffDayDto,
  StaffMarkDto,
} from '../lib/api/school-staff-attendance-contract';
import {
  PRINCIPAL_ME,
  STAMP,
  TEACHER_ME,
  TODAY,
  calls,
  errorBody,
  mockSchoolApi,
  open,
  page1,
  TABLET,
  expectNoSidewaysScroll,
  type Handler,
} from './support/wave-e';

// Staff attendance (contracts/slice-12.md §4, §8) against a mocked API: the day sheet with its
// own-row rule, touched-rows-only saves, amendments with a reason, the refusals, the staff
// detail tab and "My attendance".

const expect = baseExpect.configure({ timeout: 15_000 });

const staffMark = (staffId: string, status: StaffMarkDto['status'], extra: Partial<StaffMarkDto> = {}): StaffMarkDto => ({
  id: `sm-${staffId}`,
  staffId,
  date: TODAY,
  status,
  note: null,
  markedBy: 'u-office',
  markedByName: 'Bilal Office',
  markedAt: '2026-10-06T03:15:00.000Z',
  amended: false,
  lastAmendedAt: null,
  lastAmendedByName: null,
  ...extra,
});
const day = (staffId: string, fullName: string, mark: StaffMarkDto | null = null): StaffDayDto => ({
  staffId,
  fullName,
  designation: 'Teacher',
  staffStatus: 'active',
  mark,
  approvedLeave: null,
});
const DAY = [
  day('st-p', 'Amina Principal'),
  day('st-1', 'Ayesha Malik'),
  day('st-2', 'Imran Ali', staffMark('st-2', 'present')),
  day('st-3', 'Sadia Noor'),
];

function sheetHandler(): Handler {
  return ({ method, path }) => {
    if (method === 'GET' && path === '/staff-attendance') return { status: 200, body: page1(DAY) };
    if (method === 'POST' && path === '/staff-attendance/submit') {
      return {
        status: 200,
        body: { date: TODAY, workingDay: true, marks: [], summary: { staff: 4, marked: 3, present: 1, absent: 2, late: 0, onLeave: 0 } },
      };
    }
    return undefined;
  };
}

const radio = (page: Page, name: string, status: string) =>
  page.getByRole('radiogroup', { name: `Attendance for ${name}` }).getByRole('radio', { name: status });

test('day sheet: own row read-only with the reason; two absentees saved alone; keyboard marks', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: sheetHandler() });
  await open(page, '/staff-attendance');
  await expect(page.getByRole('heading', { name: 'Staff attendance' })).toBeVisible();
  const own = page.locator('tr[data-staff="st-p"]');
  await expect(own.getByTestId('own-row-hint')).toHaveText('You cannot mark your own attendance. Another member of staff records it.');
  await expect(radio(page, 'Amina Principal', 'Present')).toBeDisabled();

  await radio(page, 'Ayesha Malik', 'Absent').click();
  await page.locator('tr[data-staff="st-3"]').focus();
  await page.keyboard.press('a');
  await page.getByLabel('Note for Sadia Noor').fill('Sick leave not applied');
  await page.getByRole('button', { name: 'Save (2)' }).click();
  await expect(page.getByText('Saved. 3 of 4 recorded: 1 present, 2 absent, 0 late, 0 on leave.')).toBeVisible();
  expect(calls(requests, 'POST', '/staff-attendance/submit')[0].postDataJSON()).toEqual({
    date: TODAY,
    marks: [
      { staffId: 'st-1', status: 'absent' },
      { staffId: 'st-3', status: 'absent', note: 'Sick leave not applied' },
    ],
  });
  const q = new URL(calls(requests, 'GET', '/staff-attendance')[0].url()).searchParams;
  expect([q.get('date'), q.get('limit')]).toEqual([TODAY, '50']);
  expect(unmocked).toEqual([]);
});

test('changing a recorded mark asks for a reason; the server’s race list reads "changed since you loaded"', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: sheetHandler(),
    replies: {
      'POST /staff-attendance/submit': [
        {
          status: 409,
          body: errorBody('AMENDMENT_REASON_REQUIRED', 'Reason required.', {
            amendments: [{ staffId: 'st-1', markId: 'sm-st-1', from: 'late', to: 'absent', noteChanged: false }],
          }),
        },
      ],
    },
  });
  await open(page, '/staff-attendance');
  await radio(page, 'Imran Ali', 'Late').click();
  await radio(page, 'Ayesha Malik', 'Absent').click();
  await page.getByRole('button', { name: 'Save (2)' }).click();
  const first = page.getByRole('dialog', { name: 'Why are these marks changing?' });
  await expect(first.getByTestId('amendment-list')).toHaveText('Imran Ali: Present → Late');
  await first.getByLabel('Reason').fill('Came at 9');
  await first.getByRole('button', { name: 'Save changes' }).click();
  const race = page.getByRole('dialog', { name: 'Changed since you loaded' });
  await expect(race.getByTestId('amendment-list')).toHaveText('Ayesha Malik: Late → Absent');
  await race.getByLabel('Reason').fill('She did not come');
  await race.getByRole('button', { name: 'Save changes' }).click();
  await expect(race).toBeHidden();
  const posts = calls(requests, 'POST', '/staff-attendance/submit');
  expect(posts[0].postDataJSON()).toMatchObject({ reason: 'Came at 9' });
  expect(posts[1].postDataJSON()).toMatchObject({ reason: 'She did not come' });
});

test('refusals: own row in the payload, a staff holiday, a concurrent create', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: sheetHandler(),
    replies: {
      'POST /staff-attendance/submit': [
        { status: 409, body: errorBody('SELF_ACTION_FORBIDDEN', 'Self.', { staffId: 'st-p' }) },
        { status: 409, body: errorBody('NOT_A_TEACHING_DAY', 'Not a working day for staff', { reason: 'staff_holiday' }) },
        { status: 409, body: errorBody('CONCURRENT_UPDATE', 'Concurrent.') },
      ],
    },
  });
  await open(page, '/staff-attendance');
  await radio(page, 'Ayesha Malik', 'Absent').click();
  const save = page.getByRole('button', { name: 'Save (1)' });
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'You cannot mark your own attendance. Another member of staff records it.' })).toBeVisible();
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'This is a holiday for staff, so attendance is not recorded.' })).toBeVisible();
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Someone else saved at the same moment. Reload and try again.' })).toBeVisible();
});

test('a weekly day off shows why and offers no save', async ({ page }) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: sheetHandler() });
  await open(page, '/staff-attendance');
  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByLabel('Date')).toHaveValue('2026-10-04');
  await expect(page.getByTestId('staff-day-off')).toContainText('4 Oct 2026 is a weekly day off');
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next day' })).toBeEnabled();
});

test('a holiday for staff blocks the sheet up front; one staff work through does not', async ({ page }) => {
  let appliesToStaff = true;
  const handler = sheetHandler();
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      call.path === '/calendar/teaching-days'
        ? {
            status: 200,
            body: {
              dateFrom: TODAY,
              dateTo: TODAY,
              teachingDays: 0,
              weeklyOffDays: [0],
              holidays: [
                { id: 'h1', name: 'Founders Day', kind: 'public', startsOn: TODAY, endsOn: TODAY, appliesToStaff },
              ],
            },
          }
        : handler(call),
  });
  await open(page, '/staff-attendance');
  await expect(page.getByTestId('staff-day-off')).toContainText('is a holiday for staff, so staff attendance is not recorded');
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);

  appliesToStaff = false;
  await page.reload();
  await expect(page.getByText('Staff work through this holiday')).toBeVisible();
  await expect(page.getByTestId('staff-day-off')).toHaveCount(0);
  await radio(page, 'Ayesha Malik', 'Absent').click();
  await expect(page.getByRole('button', { name: 'Save (1)' })).toBeVisible();
});

test('amend one mark: STALE_STATUS reloads the day and asks again', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: sheetHandler(),
    replies: {
      'POST /staff-attendance/sm-st-2/amend': [
        { status: 409, body: errorBody('STALE_STATUS', 'Stale.', { currentStatus: 'absent' }) },
        { status: 200, body: staffMark('st-2', 'on_leave') },
      ],
    },
  });
  await open(page, '/staff-attendance');
  await page.getByRole('button', { name: 'Actions for Imran Ali' }).click();
  await page.getByRole('menuitem', { name: 'Amend with reason' }).click();
  const dialog = page.getByRole('dialog', { name: 'Amend Imran Ali' });
  await dialog.getByRole('radio', { name: 'On leave' }).click();
  await dialog.getByLabel('Reason').fill('Leave approved');
  await dialog.getByRole('button', { name: 'Amend' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Someone else changed this mark to Absent');
  await expect.poll(() => calls(requests, 'GET', '/staff-attendance').length).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: 'Amend' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/staff-attendance/sm-st-2/amend')[0].postDataJSON()).toEqual({
    fromStatus: 'present',
    status: 'on_leave',
    reason: 'Leave approved',
  });
});

test('a teacher has no staff attendance entry and is refused the sheet', async ({ page }) => {
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ path }) =>
      path === '/staff-attendance' ? { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.') } : undefined,
  });
  await open(page, '/staff-attendance');
  await expect(page.getByRole('navigation').first().getByRole('link', { name: 'Staff attendance' })).toHaveCount(0);
  await expect(page.getByText('You do not have access')).toBeVisible();
});

function month(withNotes: boolean): StaffAttendanceDto {
  const days = Array.from({ length: 31 }, (_, i) => {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    const status = date === '2026-10-02' ? ('absent' as const) : date === '2026-10-01' ? ('present' as const) : null;
    return {
      date,
      workingDay: !sunday,
      employed: true,
      status,
      note: withNotes && status === 'absent' ? 'Wedding in the family' : null,
      markedByName: withNotes && status ? 'Bilal Office' : null,
      amended: false,
    };
  });
  return {
    staffId: 'st1',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
    workingDays: 27,
    present: 1,
    absent: 1,
    late: 0,
    onLeave: 0,
    unrecorded: 25,
    days,
  };
}

const STAFF: StaffDto = {
  id: 'st1',
  fullName: 'Ayesha Malik',
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Senior teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: 'u7',
  systemRoles: ['teacher'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
};

test('staff detail → Attendance: counts, unrecorded of working days, notes and who marked', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ path }) => {
      if (path === '/staff/st1') return { status: 200, body: STAFF };
      if (path === '/staff/st1/attendance') return { status: 200, body: month(true) };
      return undefined;
    },
  });
  await open(page, '/staff/st1');
  await page.getByRole('tab', { name: 'Attendance' }).click();
  await expect(page.getByTestId('staff-attendance-counts')).toContainText('25 unrecorded of 27 working days');
  await expect(page.getByRole('list', { name: 'Marks this month' })).toContainText('“Wedding in the family”');
  await expect(page.getByRole('list', { name: 'Marks this month' })).toContainText('marked by Bilal Office');
  await expect(page.locator('[data-date="2026-10-02"]')).toHaveAttribute('data-status', 'absent');
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  const q = new URL(calls(requests, 'GET', '/staff/st1/attendance')[0].url()).searchParams;
  expect([q.get('dateFrom'), q.get('dateTo')]).toEqual(['2026-10-01', '2026-10-31']);
});

test('My attendance: the teacher’s own month, without notes or who marked', async ({ page }) => {
  const { days, ...rest } = month(false);
  const mine: MyStaffAttendanceDto = {
    ...rest,
    days: days.map((d) => ({ date: d.date, workingDay: d.workingDay, employed: d.employed, status: d.status, amended: d.amended })),
  };
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ path }) => (path === '/me/staff/attendance' ? { status: 200, body: mine } : undefined),
  });
  await open(page, '/my-attendance');
  await expect(page.getByRole('heading', { name: 'My attendance' })).toBeVisible();
  await expect(page.getByTestId('staff-attendance-counts')).toContainText('25 unrecorded of 27 working days');
  await expect(page.getByRole('list', { name: 'Marks this month' })).toHaveCount(0);
  await expect(page.getByRole('navigation').first().getByRole('link', { name: 'My attendance' })).toHaveAttribute('aria-current', 'page');
});
