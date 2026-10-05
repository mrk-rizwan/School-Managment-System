import { Capability } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { TeacherAssignmentDto } from '../lib/api/school-calendar-contract';
import type { MeDto } from '../lib/api/school-contract';
import type { StaffDto } from '../lib/api/school-staff-contract';

// Cover assignment from the staff assignments tab (contracts/slice-10.md §6, §13) against a
// mocked API answered in the browser.

const expect = baseExpect.configure({ timeout: 15_000 });
const STAMP = '2026-09-01T05:00:00.000Z';

const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  blockedCapabilities: [],
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
  capabilityScopes: [],
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};

const staffRow = (id: string, fullName: string, extra: Partial<StaffDto> = {}): StaffDto => ({
  id,
  fullName,
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: `u-${id}`,
  systemRoles: ['teacher'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});
const AYESHA = staffRow('st1', 'Ayesha Malik');
const BILAL = staffRow('st2', 'Bilal Ahmed', { designation: 'Senior teacher' });

const assignment = (id: string, extra: Partial<TeacherAssignmentDto> = {}): TeacherAssignmentDto => ({
  id,
  staffId: 'st1',
  staffFullName: 'Ayesha Malik',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  subjectId: null,
  subjectName: null,
  role: 'class_teacher',
  startsOn: '2026-04-01',
  endsOn: null,
  voidedAt: null,
  activeToday: true,
  createdAt: STAMP,
  coversAssignmentId: null,
  coversStaffFullName: null,
  ...extra,
});

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
async function mockApi(page: Page, state: { assignments: TeacherAssignmentDto[]; replies?: Record<string, Reply[]> }) {
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const reply = state.replies?.[`${method} ${path}`]?.shift();
    if (reply) return json(reply.status, reply.body);
    if (method === 'GET' && path === '/me') return json(200, PRINCIPAL_ME);
    if (method === 'GET' && path === '/staff') return json(200, { data: [AYESHA, BILAL], page: 1, limit: 50, total: 2 });
    if (method === 'GET' && path === '/staff/st1') return json(200, AYESHA);
    if (method === 'GET' && path === '/staff/st1/teacher-assignments') {
      return json(200, { data: state.assignments, page: 1, limit: 25, total: state.assignments.length });
    }
    if (method === 'POST' && path === '/staff/st2/teacher-assignments') {
      const b = request.postDataJSON() as Partial<TeacherAssignmentDto>;
      return json(201, assignment('ta-cover', { ...b, staffId: 'st2', staffFullName: 'Bilal Ahmed', role: 'cover' }));
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

async function openAssignments(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-04T05:00:00Z'));
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Teaching assignments' }).click();
}

async function fillCover(page: Page) {
  await page.getByRole('button', { name: 'Actions for Class 5 A' }).click();
  await page.getByRole('menuitem', { name: 'Arrange cover' }).click();
  const dialog = page.getByRole('dialog', { name: 'Arrange cover: Class 5 A' });
  await expect(dialog.getByLabel('Covering teacher').locator('option')).toHaveText(['Choose…', 'Bilal Ahmed · Senior teacher']);
  await dialog.getByLabel('Covering teacher').selectOption('st2');
  await expect(dialog.getByLabel('First day')).toHaveValue('2026-10-04');
  await expect(dialog.getByRole('button', { name: 'Arrange cover' })).toBeDisabled();
  await dialog.getByLabel('Last day').fill('2026-10-09');
  return dialog;
}

const posts = (requests: Request[]) =>
  requests.filter((r) => r.method() === 'POST' && r.url().endsWith('/staff/st2/teacher-assignments'));

test('arrange cover posts a cover assignment to the covering teacher, naming the covered row', async ({ page }) => {
  const requests = await mockApi(page, { assignments: [assignment('ta1')] });
  await openAssignments(page);
  const dialog = await fillCover(page);
  await dialog.getByRole('button', { name: 'Arrange cover' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bilal Ahmed is covering Class 5 A from 4 Oct 2026 to 9 Oct 2026.')).toBeVisible();
  expect(posts(requests)[0].postDataJSON()).toEqual({
    role: 'cover',
    classId: 'c5',
    sectionId: 'sec-a',
    startsOn: '2026-10-04',
    endsOn: '2026-10-09',
    coversAssignmentId: 'ta1',
  });
});

test('cover refusals are explained: capability not held, self, already covering', async ({ page }) => {
  const requests = await mockApi(page, {
    assignments: [assignment('ta1')],
    replies: {
      'POST /staff/st2/teacher-assignments': [
        { status: 409, body: errorBody('CAPABILITY_NOT_HELD', 'Not held.', { capability: 'attendance.student.mark' }) },
        { status: 409, body: errorBody('SELF_ACTION_FORBIDDEN', 'Self.') },
        { status: 409, body: errorBody('ASSIGNMENT_EXISTS', 'Exists.', { assignmentId: 'ta9' }) },
      ],
    },
  });
  await openAssignments(page);
  const dialog = await fillCover(page);
  // Not standing in for the class teacher: no covered row is sent.
  await dialog.getByLabel('Covering for Ayesha Malik, the class teacher').uncheck();
  await dialog.getByRole('button', { name: 'Arrange cover' }).click();
  await expect(dialog.getByText(/^Bilal Ahmed cannot mark registers/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Arrange cover' }).click();
  await expect(dialog.getByText('You cannot assign cover to yourself. Ask your principal to arrange it.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Arrange cover' }).click();
  await expect(dialog.getByText('Bilal Ahmed already covers this section on some of these dates.')).toBeVisible();
  expect(posts(requests)[0].postDataJSON()).toMatchObject({ coversAssignmentId: null });
});

test('a cover row says whom it covers; subject rows offer no cover', async ({ page }) => {
  await mockApi(page, {
    assignments: [
      assignment('ta2', { role: 'cover', startsOn: '2026-10-04', endsOn: '2026-10-09', coversAssignmentId: 'ta7', coversStaffFullName: 'Sadia Noor' }),
      assignment('ta3', { role: 'subject_teacher', sectionId: 'sec-b', sectionName: 'B', subjectId: 'sub-m', subjectName: 'Mathematics' }),
    ],
  });
  await openAssignments(page);
  await expect(page.getByText('Covering for Sadia Noor')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Class 5 B' }).click();
  await expect(page.getByRole('menuitem', { name: 'Arrange cover' })).toHaveCount(0);
});
