import type { AttendanceStatus } from '@asms/shared';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import type {
  AbsenteeRowDto,
  AttendanceMarkDto,
  DailySummaryDto,
  MarkChangeDto,
  PercentageRowDto,
  RegisterDto,
  RegisterViewDto,
  RosterRowDto,
  SectionDayDto,
  StudentAttendanceDto,
} from '../lib/api/school-attendance-contract';
import type { StudentDetailDto, StudentDto } from '../lib/api/school-students-contract';
import {
  OFFICE_ME,
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
  type Reply,
} from './support/wave-e';

// Student attendance (contracts/slice-11.md §4, §10, §13) against a mocked API: the register
// and its keyboard, amendments with a reason, the server's refusals, the arrival dialog, the
// registers console and its live tile, the summary, the reports and the student's tab.

const expect = baseExpect.configure({ timeout: 15_000 });

const mark = (enrolmentId: string, status: AttendanceStatus, extra: Partial<AttendanceMarkDto> = {}): AttendanceMarkDto => ({
  id: `m-${enrolmentId}`,
  registerId: 'r1',
  enrolmentId,
  studentId: `s-${enrolmentId}`,
  date: TODAY,
  period: 1,
  status,
  arrivedAt: null,
  note: null,
  amended: false,
  ...extra,
});
const rosterRow = (enrolmentId: string, name: string, rollNo: number, extra: Partial<RosterRowDto> = {}): RosterRowDto => ({
  enrolmentId,
  studentId: `s-${enrolmentId}`,
  studentFullName: name,
  rollNo,
  onRoster: true,
  mark: null,
  alert: null,
  ...extra,
});
const REGISTER: RegisterDto = {
  id: 'r1',
  sectionId: 'sec-a',
  sectionName: 'A',
  classId: 'c5',
  className: 'Class 5',
  academicYearId: 'y1',
  date: TODAY,
  period: 1,
  mode: 'daily',
  teachingDay: true,
  submittedBy: 'u-teacher',
  submittedByName: 'Ayesha Malik',
  submittedAt: '2026-10-06T03:05:00.000Z',
  lastAmendedBy: null,
  lastAmendedByName: null,
  lastAmendedAt: null,
  source: 'web',
};
const view = (extra: Partial<RegisterViewDto> = {}): RegisterViewDto => ({
  section: { id: 'sec-a', name: 'A', classId: 'c5', className: 'Class 5', academicYearId: 'y1', attendanceMode: 'daily' },
  date: TODAY,
  period: 1,
  periodsPerDay: 8,
  teachingDay: true,
  register: null,
  roster: [rosterRow('e1', 'Ali Khan', 1), rosterRow('e2', 'Fatima Zahra', 2), rosterRow('e3', 'Hamza Iqbal', 3)],
  canSubmit: true,
  amendable: true,
  callerRole: 'class_teacher',
  ...extra,
});
const RECORDED = view({
  register: { ...REGISTER, lastAmendedBy: 'u-principal', lastAmendedByName: 'Amina Principal', lastAmendedAt: '2026-10-06T04:10:00.000Z' },
  roster: [
    rosterRow('e1', 'Ali Khan', 1, { mark: mark('e1', 'present') }),
    rosterRow('e2', 'Fatima Zahra', 2, {
      mark: mark('e2', 'absent'),
      alert: {
        absence: 'sent',
        absenceCancelReason: null,
        absenceDueAt: null,
        absenceResolvedAt: '2026-10-06T04:31:00.000Z',
        lateAdvice: null,
        corrections: 0,
        correctionsCapped: false,
      },
    }),
    rosterRow('e3', 'Hamza Iqbal', 3, { mark: mark('e3', 'late', { arrivedAt: '08:40' }) }),
  ],
});

const submitResult = (created: boolean) => ({
  created,
  register: REGISTER,
  marks: [],
  summary: { roster: 3, marked: 3, present: 1, absent: 1, late: 1, onLeave: 0 },
  alerts: { absencePending: 1, absenceBackdated: 0, lateAdvicePending: 0, cancelled: 0, corrections: 0 },
});

/** The register route answering `current`; a successful submit makes the register recorded. */
function registerHandler(state: { view: RegisterViewDto }): Handler {
  return ({ method, path }) => {
    if (method === 'GET' && path === '/sections/sec-a/register') return { status: 200, body: state.view };
    if (method === 'POST' && path === '/sections/sec-a/submit-register') {
      const created = state.view.register === null;
      state.view = RECORDED;
      return { status: created ? 201 : 200, body: submitResult(created) };
    }
    return undefined;
  };
}

const row = (page: Page, enrolmentId: string) => page.locator(`tr[data-enrolment="${enrolmentId}"]`);
const radio = (page: Page, name: string, status: string) =>
  page.getByRole('radiogroup', { name: `Attendance for ${name}` }).getByRole('radio', { name: status });

test('class teacher takes the first register with the keyboard; the whole roster is sent', async ({ page }) => {
  const state = { view: view() };
  const { requests, unmocked } = await mockSchoolApi(page, { me: TEACHER_ME, handler: registerHandler(state) });
  await open(page, '/attendance/register');

  // One section of their own: it opens on its own, today, period 1.
  await expect(page.getByRole('heading', { name: 'Attendance register' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Class 5 A', pressed: true })).toBeVisible();
  const read = new URL(calls(requests, 'GET', '/sections/sec-a/register')[0].url()).searchParams;
  expect([read.get('date'), read.get('period')]).toEqual([TODAY, '1']);
  await expect(page.getByTestId('register-recorded')).toContainText('Not recorded yet today');
  // Daily mode: no period picker.
  await expect(page.getByLabel('Period')).toHaveCount(0);

  await row(page, 'e1').focus();
  await page.keyboard.press('p');
  await expect(row(page, 'e2')).toBeFocused();
  await page.keyboard.press('a');
  await page.keyboard.press('l');
  // The last row keeps the focus; the arrows move it.
  await expect(row(page, 'e3')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'e2')).toBeFocused();
  await expect(radio(page, 'Ali Khan', 'Present')).toHaveAttribute('aria-checked', 'true');
  await expect(radio(page, 'Fatima Zahra', 'Absent')).toHaveAttribute('aria-checked', 'true');
  await expect(radio(page, 'Hamza Iqbal', 'Late')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('register-counts')).toHaveText('Present 1 · Absent 1 · Late 1 · On leave 0');

  await page.getByLabel('Arrival time of Hamza Iqbal').fill('08:40');
  await page.getByLabel('Note for Fatima Zahra').fill('Fever, mother called');
  await page.getByRole('button', { name: 'Save register' }).click();
  await expect(page.getByText('Register saved: 1 present, 1 absent, 1 late, 0 on leave.')).toBeVisible();
  expect(calls(requests, 'POST', '/sections/sec-a/submit-register')[0].postDataJSON()).toEqual({
    date: TODAY,
    period: 1,
    marks: [
      { enrolmentId: 'e1', status: 'present' },
      { enrolmentId: 'e2', status: 'absent', note: 'Fever, mother called' },
      { enrolmentId: 'e3', status: 'late', arrivedAt: '08:40' },
    ],
  });
  // Reloaded as recorded, with who recorded it and when.
  await expect(page.getByTestId('register-recorded')).toContainText('Recorded by Ayesha Malik at 08:05');
  await expect(page.getByTestId('register-recorded')).toContainText('amended by Amina Principal at 09:10');
  await expect(row(page, 'e2')).toContainText('told 09:31');
  expect(unmocked).toEqual([]);
});

test('a first save with a child unmarked is stopped before the server; "Mark the rest present" fills it', async ({ page }) => {
  const state = { view: view() };
  const { requests } = await mockSchoolApi(page, { me: TEACHER_ME, handler: registerHandler(state) });
  await open(page, '/attendance/register');
  await radio(page, 'Ali Khan', 'Absent').click();
  await page.getByRole('button', { name: 'Save register' }).click();
  await expect(page.getByText('2 children are not marked.', { exact: false })).toBeVisible();
  expect(calls(requests, 'POST', '/sections/sec-a/submit-register')).toHaveLength(0);
  await page.getByRole('button', { name: 'Mark the rest present' }).click();
  await expect(page.getByTestId('register-counts')).toHaveText('Present 2 · Absent 1 · Late 0 · On leave 0');
  // Nobody is missing any more: the warning goes with them.
  await expect(page.getByText('children are not marked.', { exact: false })).toHaveCount(0);
  await expect(row(page, 'e2')).not.toHaveClass(/bg-destructive/);
});

test('ROSTER_INCOMPLETE from the server (an admission meanwhile) is explained and the roster reloaded', async ({ page }) => {
  const state = { view: view() };
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: registerHandler(state),
    replies: {
      'POST /sections/sec-a/submit-register': {
        status: 422,
        body: errorBody('ROSTER_INCOMPLETE', 'Every child must be marked.', { missing: ['e9'] }),
      },
    },
  });
  await open(page, '/attendance/register');
  await page.getByRole('button', { name: 'Mark the rest present' }).click();
  await page.getByRole('button', { name: 'Save register' }).click();
  await expect(page.getByText('Mark every child on the register before saving it for the first time.')).toBeVisible();
  await expect.poll(() => calls(requests, 'GET', '/sections/sec-a/register').length).toBeGreaterThan(1);
});

test('changing a saved mark asks for a reason listing the change, and sends only that mark', async ({ page }) => {
  const state = { view: RECORDED };
  const { requests } = await mockSchoolApi(page, { me: TEACHER_ME, handler: registerHandler(state) });
  await open(page, '/attendance/register');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await radio(page, 'Ali Khan', 'Absent').click();
  await page.getByRole('button', { name: 'Save changes (1)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Why are these marks changing?' });
  await expect(dialog.getByTestId('amendment-list')).toHaveText('Ali Khan: Present → Absent');
  await dialog.getByLabel('Reason').fill('Left after assembly');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/sections/sec-a/submit-register')[0].postDataJSON()).toEqual({
    date: TODAY,
    period: 1,
    reason: 'Left after assembly',
    marks: [{ enrolmentId: 'e1', status: 'absent' }],
  });
});

test('AMENDMENT_REASON_REQUIRED from a race shows "changed since you loaded" and resubmits with the reason', async ({ page }) => {
  const state = { view: view() };
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: registerHandler(state),
    replies: {
      'POST /sections/sec-a/submit-register': [
        {
          status: 409,
          body: errorBody('AMENDMENT_REASON_REQUIRED', 'A reason is required.', {
            amendments: [{ enrolmentId: 'e2', markId: 'm-e2', from: 'present', to: 'absent', noteChanged: false }],
          }),
        },
      ],
    },
  });
  await open(page, '/attendance/register');
  await page.getByRole('button', { name: 'Mark the rest present' }).click();
  await radio(page, 'Fatima Zahra', 'Absent').click();
  await page.getByRole('button', { name: 'Save register' }).click();
  const dialog = page.getByRole('dialog', { name: 'Changed since you loaded' });
  await expect(dialog.getByTestId('amendment-list')).toHaveText('Fatima Zahra: Present → Absent');
  await dialog.getByLabel('Reason').fill('She is absent today');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  const posts = calls(requests, 'POST', '/sections/sec-a/submit-register');
  expect(posts).toHaveLength(2);
  expect(posts[1].postDataJSON()).toMatchObject({ reason: 'She is absent today' });
});

test('refusals: window closed, not a teaching day, subject teacher in daily mode', async ({ page }) => {
  const state = { view: RECORDED };
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: registerHandler(state),
    replies: {
      'POST /sections/sec-a/submit-register': [
        { status: 409, body: errorBody('ATTENDANCE_LOCKED', 'Locked.', { date: TODAY, windowDays: 3 }) },
        { status: 409, body: errorBody('NOT_A_TEACHING_DAY', 'Not a teaching day.') },
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.', { reason: 'subject_teacher_daily_mode' }) },
      ],
    },
  });
  await open(page, '/attendance/register');
  const save = async () => {
    await page.getByRole('button', { name: /^Save changes \(\d+\)$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Correction');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
  };
  await radio(page, 'Ali Khan', 'Late').click();
  await save();
  await expect(page.getByRole('alert').filter({ hasText: 'The amendment window (3 days) has closed for 6 Oct 2026.' })).toBeVisible();
  await save();
  await expect(page.getByRole('alert').filter({ hasText: 'This is not a teaching day' })).toBeVisible();
  await save();
  await expect(page.getByRole('alert').filter({ hasText: 'its class teacher marks the register' })).toBeVisible();
});

test('read only: window closed, a day declared a holiday afterwards, a viewer', async ({ page }) => {
  const state = { view: { ...RECORDED, amendable: false } };
  await mockSchoolApi(page, { me: TEACHER_ME, handler: registerHandler(state) });
  await open(page, '/attendance/register');
  await expect(page.getByTestId('register-read-only')).toContainText('The amendment window has closed for 6 Oct 2026.');
  await expect(radio(page, 'Ali Khan', 'Absent')).toBeDisabled();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);

  state.view = { ...RECORDED, teachingDay: false, amendable: false };
  await page.reload();
  await expect(page.getByTestId('register-read-only')).toContainText('declared a holiday after the register was taken');

  state.view = { ...RECORDED, canSubmit: false, amendable: false, callerRole: 'viewer' };
  await page.reload();
  await expect(page.getByTestId('register-read-only')).toContainText('You can read this register but not change it.');
  await expect(page.getByRole('button', { name: 'Actions for Ali Khan' })).toBeVisible();
});

test('"Correct this mark" is offered inside the window, and after it only to a school-wide holder', async ({ page }) => {
  const state = { view: { ...RECORDED, amendable: false } };
  await mockSchoolApi(page, { me: TEACHER_ME, handler: registerHandler(state) });
  await open(page, '/attendance/register');
  // Window closed for the class teacher: the history only, no correction the server would refuse.
  await page.getByRole('button', { name: 'Actions for Ali Khan' }).click();
  await expect(page.getByRole('menuitem', { name: 'Mark history' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Correct this mark' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The principal (callerRole all) corrects after the window.
  state.view = { ...RECORDED, amendable: false, callerRole: 'all' };
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Ali Khan' }).click();
  await expect(page.getByRole('menuitem', { name: 'Correct this mark' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Inside the window the class teacher corrects too.
  state.view = RECORDED;
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Ali Khan' }).click();
  await expect(page.getByRole('menuitem', { name: 'Correct this mark' })).toBeVisible();
});

test('a register out of scope is "not one of yours", one on an unassigned date says so; a period-mode class shows the period picker', async ({ page }) => {
  const state = { view: view({ section: { ...view().section, attendanceMode: 'period' }, periodsPerDay: 6 }) };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      call.path === '/sections/sec-b/register'
        ? { status: 404, body: errorBody('NOT_FOUND', 'Not found.') }
        : call.path === '/sections/sec-c/register'
          ? { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.', { reason: 'not_assigned_on_date' }) }
          : registerHandler(state)(call),
  });
  await open(page, '/attendance/register?section=sec-a');
  await page.getByLabel('Period').selectOption('4');
  await expect.poll(() => calls(requests, 'GET', '/sections/sec-a/register').map((r) => new URL(r.url()).searchParams.get('period'))).toContain('4');
  await expect(page.getByLabel('Period').locator('option')).toHaveCount(6);

  await page.goto('/attendance/register?section=sec-b');
  await expect(page.getByText('Not one of your registers')).toBeVisible();

  // Assigned to the section on another date: 403, not 404 (slice-11 §1.2).
  await page.goto('/attendance/register?section=sec-c');
  await expect(page.getByText('You were not assigned to this section on that date.')).toBeVisible();
  await expect(page.getByText('Not one of your registers')).toHaveCount(0);
});

test('correct one mark: STALE_STATUS names the colleague’s value and reloads; history lists changes', async ({ page }) => {
  const state = { view: RECORDED };
  const changes: MarkChangeDto[] = [
    {
      id: 'ch1',
      markId: 'm-e3',
      fromStatus: 'absent',
      toStatus: 'late',
      noteChanged: false,
      fromArrivedAt: null,
      toArrivedAt: '08:40',
      changedBy: 'u-office',
      changedByName: 'Bilal Office',
      changedAt: '2026-10-06T03:40:00.000Z',
      reason: 'Arrived at 08:40',
    },
  ];
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: (call) =>
      call.path === '/attendance-marks/m-e3/changes' ? { status: 200, body: page1(changes) } : registerHandler(state)(call),
    replies: {
      'POST /attendance-marks/m-e1/amend': [
        { status: 409, body: errorBody('STALE_STATUS', 'Stale.', { currentStatus: 'late' }) },
        { status: 200, body: mark('e1', 'absent') },
      ],
    },
  });
  await open(page, '/attendance/register');

  await page.getByRole('button', { name: 'Actions for Hamza Iqbal' }).click();
  await page.getByRole('menuitem', { name: 'Mark history' }).click();
  const history = page.getByRole('dialog', { name: 'Mark history' });
  await expect(history).toContainText('Absent → Late');
  await expect(history).toContainText('Bilal Office');
  await expect(history).toContainText('Arrived at 08:40');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Actions for Ali Khan' }).click();
  await page.getByRole('menuitem', { name: 'Correct this mark' }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct Ali Khan\'s mark' });
  await dialog.getByRole('radio', { name: 'Absent' }).click();
  await dialog.getByLabel('Reason').fill('Was not in class');
  await dialog.getByRole('button', { name: 'Correct mark' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Someone else changed this mark to Late after you loaded it.');
  await expect.poll(() => calls(requests, 'GET', '/sections/sec-a/register').length).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: 'Correct mark' }).click();
  await expect(dialog).toBeHidden();
  const amends = calls(requests, 'POST', '/attendance-marks/m-e1/amend');
  expect(amends[0].postDataJSON()).toEqual({ fromStatus: 'present', status: 'absent', reason: 'Was not in class' });
});

const STUDENT: StudentDto = {
  id: 's-e2',
  admissionNo: '1002',
  fullName: 'Fatima Zahra',
  gender: 'female',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2025-04-01',
  current: {
    enrolmentId: 'e2',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 2,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const sectionDay = (sectionId: string, sectionName: string, extra: Partial<SectionDayDto> = {}): SectionDayDto => ({
  sectionId,
  sectionName,
  classId: 'c5',
  className: 'Class 5',
  academicYearId: 'y1',
  date: TODAY,
  mode: 'daily',
  rosterCount: 30,
  registersExpected: 1,
  registersRecorded: 0,
  recorded: false,
  submittedBy: null,
  submittedByName: null,
  submittedAt: null,
  classTeacherName: 'Ayesha Malik',
  classTeacherStaffId: 'st-ayesha',
  coverStaffName: null,
  coverStaffIds: [],
  declaredHolidayAfter: false,
  periods: [],
  ...extra,
});

function consoleHandler(): Handler {
  return ({ method, path, url }) => {
    if (method === 'GET' && path === '/attendance-registers') {
      const recorded = url.searchParams.get('recorded');
      const rows =
        recorded === 'false'
          ? [sectionDay('sec-a', 'A'), sectionDay('sec-b', 'B', { classTeacherName: 'Sadia Noor', classTeacherStaffId: 'st-sadia', coverStaffName: 'Imran Ali', coverStaffIds: ['st-imran'] })]
          : [
              sectionDay('sec-a', 'A'),
              sectionDay('sec-c', 'Rose', {
                recorded: true,
                registersRecorded: 1,
                submittedBy: 'u-teacher',
                submittedByName: 'Ayesha Malik',
                submittedAt: '2026-10-06T03:05:00.000Z',
                declaredHolidayAfter: true,
              }),
            ];
      return { status: 200, body: page1(rows) };
    }
    if (method === 'GET' && path === '/students') return { status: 200, body: page1([STUDENT]) };
    return undefined;
  };
}

test('registers console: the live tile names who should record and who covers; the list flags a later holiday', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: consoleHandler() });
  await open(page, '/attendance');
  const tile = page.getByTestId('unrecorded-tile');
  await expect(tile).toContainText('2 registers not recorded');
  await expect(tile).toContainText('Class teacher Sadia Noor · covered by Imran Ali');
  await expect(tile.getByRole('link', { name: 'Record Class 5 A' })).toHaveAttribute('href', `/attendance/register?section=sec-a&date=${TODAY}`);
  // Cover is arranged only where there is none.
  await expect(tile.getByRole('link', { name: 'Arrange cover' })).toHaveCount(1);
  // It opens the class teacher's Teaching assignments, where the cover dialog lives.
  await expect(tile.getByRole('link', { name: 'Arrange cover for Class 5 A' })).toHaveAttribute('href', '/staff/st-ayesha?tab=assignments');
  const tileQuery = new URL(calls(requests, 'GET', '/attendance-registers')[0].url()).searchParams;
  expect(tileQuery.get('recorded')).toBe('false');
  expect(tileQuery.get('date')).toBe(TODAY);

  await expect(page.getByText('Recorded on a day later declared a holiday')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ayesha Malik, 08:05' })).toBeVisible();
  await page.getByLabel('Recorded', { exact: true }).selectOption('yes');
  await expect
    .poll(() => calls(requests, 'GET', '/attendance-registers').some((r) => new URL(r.url()).searchParams.get('recorded') === 'true'))
    .toBe(true);
  expect(unmocked).toEqual([]);
});

test('arrival dialog: ARRIVAL_NOT_ABSENT says to amend the register; then the arrival is recorded', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: consoleHandler(),
    replies: {
      'POST /attendance-arrivals': [
        { status: 409, body: errorBody('ARRIVAL_NOT_ABSENT', 'Not absent.', { status: 'present' }) },
        { status: 409, body: errorBody('ARRIVAL_NOT_ABSENT', 'Not absent.', { status: null }) },
        { status: 200, body: mark('e2', 'late', { arrivedAt: '09:55' }) },
      ],
    },
  });
  await open(page, '/attendance');
  await page.getByRole('button', { name: 'Record arrival' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record a late arrival' });
  await expect(dialog.getByLabel('Arrived at')).toHaveValue('10:00');
  await dialog.getByLabel('Search').fill('Fatima');
  await dialog.getByRole('button', { name: /Fatima Zahra/ }).click();
  await dialog.getByLabel('Arrived at').fill('09:55');
  await dialog.getByRole('button', { name: 'Record arrival' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Fatima Zahra is marked present today — amend the register instead.');
  await dialog.getByRole('button', { name: 'Record arrival' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('No register has been recorded for Fatima Zahra today. The register comes first.');
  await dialog.getByRole('button', { name: 'Record arrival' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Fatima Zahra recorded as arrived at 09:55.')).toBeVisible();
  expect(calls(requests, 'POST', '/attendance-arrivals')[2].postDataJSON()).toEqual({
    studentId: 's-e2',
    date: TODAY,
    arrivedAt: '09:55',
  });
});

test('daily summary shows counts and "updating…" for a stale row', async ({ page }) => {
  const row: DailySummaryDto = {
    sectionId: 'sec-a',
    sectionName: 'A',
    classId: 'c5',
    className: 'Class 5',
    date: TODAY,
    mode: 'daily',
    registersExpected: 1,
    registersRecorded: 1,
    rosterCount: 30,
    present: 26,
    absent: 2,
    late: 1,
    onLeave: 1,
    partial: 0,
    unrecorded: 0,
    teachingDay: true,
    computedAt: STAMP,
    stale: true,
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ path }) => (path === '/attendance-reports/daily-summary' ? { status: 200, body: page1([row]) } : undefined),
  });
  await open(page, '/attendance/summary');
  await expect(page.getByRole('link', { name: 'Class 5 A' })).toBeVisible();
  await expect(page.getByText('updating…')).toBeVisible();
  const q = new URL(calls(requests, 'GET', '/attendance-reports/daily-summary')[0].url()).searchParams;
  expect([q.get('dateFrom'), q.get('dateTo')]).toEqual(['2026-09-30', TODAY]);
  await page.getByLabel('From').fill('2026-01-01');
  await expect(page.getByText('Choose at most 92 days.')).toBeVisible();
});

test('reports: absentees with what the family was told; percentage with "no recorded days"', async ({ page }) => {
  const absentee: AbsenteeRowDto = {
    studentId: 's-e2',
    fullName: 'Fatima Zahra',
    rollNo: 2,
    enrolmentId: 'e2',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    status: 'absent',
    arrivedAt: null,
    alert: {
      absence: 'cancelled',
      absenceCancelReason: 'backdated',
      absenceDueAt: null,
      absenceResolvedAt: STAMP,
      lateAdvice: null,
      corrections: 2,
      correctionsCapped: true,
    },
  };
  const percentage = (studentId: string, fullName: string, value: number | null): PercentageRowDto => ({
    studentId,
    fullName,
    rollNo: 1,
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    percentage: value,
    countedDays: value === null ? 0 : 20,
    teachingDays: 22,
  });
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ path }) => {
      if (path === '/attendance-reports/absentees') return { status: 200, body: page1([absentee]) };
      if (path === '/attendance-reports/percentage') {
        return { status: 200, body: page1([percentage('s1', 'Ali Khan', 68.5), percentage('s2', 'Zoya New', null)]) };
      }
      return undefined;
    },
  });
  await open(page, '/attendance/reports');
  await expect(page.getByRole('cell', { name: 'backdated · corrected ×2 · corrections capped' })).toBeVisible();
  await page.getByLabel('Day').selectOption('partial');
  await expect
    .poll(() => calls(requests, 'GET', '/attendance-reports/absentees').some((r) => new URL(r.url()).searchParams.get('status') === 'partial'))
    .toBe(true);

  await page.getByRole('tab', { name: 'Percentage' }).click();
  await expect(page.getByRole('cell', { name: '68.5%' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'No recorded days' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '20 recorded of 22' })).toBeVisible();
  const q = new URL(calls(requests, 'GET', '/attendance-reports/percentage').at(-1)!.url()).searchParams;
  expect(q.get('below')).toBe('75');
});

test('a teacher has no reports tab, and the reports page refuses them with the no-access state', async ({ page }) => {
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ path }) =>
      path.startsWith('/attendance-reports/') ? { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.') } : undefined,
  });
  await open(page, '/attendance/reports');
  await expect(page.getByRole('navigation', { name: 'Attendance' }).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expect(page.getByText('You do not have access')).toBeVisible();
  // The sidebar: attendance and the diary, never staff attendance.
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'Attendance', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Diary' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'My attendance' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Staff attendance' })).toHaveCount(0);
});

const DETAIL: StudentDetailDto = { ...STUDENT, notes: null, photoDocumentId: null };

function studentAttendance(percentage: number | null): StudentAttendanceDto {
  const days = Array.from({ length: 31 }, (_, i) => {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    const status = percentage === null || sunday || date > TODAY ? null : date === '2026-10-05' ? ('absent' as const) : ('present' as const);
    return { date, teachingDay: !sunday, enrolled: true, status, value: status === null ? null : status === 'present' ? 1 : 0, periods: [] };
  });
  return {
    studentId: 's-e2',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
    percentage,
    countedDays: percentage === null ? 0 : 5,
    teachingDays: 5,
    present: percentage === null ? 0 : 4,
    absent: percentage === null ? 0 : 1,
    late: 0,
    onLeave: 0,
    partial: 0,
    excludedLeaveDays: 0,
    unrecorded: percentage === null ? 5 : 0,
    days,
  };
}

test('student attendance tab: heat map and "{n} recorded of {m} teaching days"; "no recorded days" when empty', async ({ page }) => {
  const replies: Record<string, Reply[]> = {
    'GET /students/s-e2/attendance': [
      { status: 200, body: studentAttendance(80) },
      { status: 200, body: studentAttendance(null) },
    ],
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies,
    handler: ({ path }) => {
      if (path === '/students/s-e2') return { status: 200, body: DETAIL };
      return undefined;
    },
  });
  await open(page, '/students/s-e2');
  await page.getByRole('tab', { name: 'Attendance' }).click();
  await expect(page.getByTestId('attendance-percentage')).toContainText('80.0% — 5 recorded of 5 teaching days');
  await expect(page.locator('[data-date="2026-10-05"]')).toHaveAttribute('data-status', 'absent');
  await expect(page.locator('[data-date="2026-10-04"]')).toHaveAttribute('data-status', 'off');
  await expect(page.locator('[data-date="2026-10-02"]')).toHaveAttribute('data-status', 'present');
  const q = new URL(calls(requests, 'GET', '/students/s-e2/attendance')[0].url()).searchParams;
  expect([q.get('dateFrom'), q.get('dateTo')]).toEqual(['2026-10-01', '2026-10-31']);

  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.getByTestId('attendance-percentage')).toContainText('No recorded days');
});

test('tablet 768px: the register with its roster and the student attendance tab do not scroll sideways', async ({ page }) => {
  await page.setViewportSize(TABLET);
  const state = { view: RECORDED };
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: (call) =>
      call.path === '/students/s-e2'
        ? { status: 200, body: DETAIL }
        : call.path === '/students/s-e2/attendance'
          ? { status: 200, body: studentAttendance(80) }
          : registerHandler(state)(call),
  });
  await open(page, '/attendance/register');
  await expect(row(page, 'e3')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.goto('/students/s-e2');
  await page.getByRole('tab', { name: 'Attendance' }).click();
  await expect(page.getByTestId('attendance-percentage')).toBeVisible();
  await expectNoSidewaysScroll(page);
});
