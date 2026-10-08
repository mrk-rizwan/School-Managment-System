import { expect as baseExpect, test } from '@playwright/test';
import { Capability } from '@asms/shared';
import type { AcademicYearDto, ClassDto } from '../lib/api/school-academics-contract';
import type { PromotionDecisionDto, PromotionSheetDetailDto, PromotionSheetDto } from '../lib/api/school-promotion-contract';
import {
  CLASSES,
  OFFICE_ME,
  PRINCIPAL_ME,
  SECTIONS,
  STAMP,
  TABLET,
  TEACHER_ME,
  YEARS,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
} from './support/wave-e';

// Promotion and year end (phase-4-academic.md slice 35, R294-R299) against a mocked API: the
// sections of a year with their sheets, opening a sheet into the next year with one idempotency
// key, the sheet's proposals with arrears flags, an override that needs a reason, apply with a
// confirmation, the refusals in the office's words, and the academic-year close showing the
// sections still to promote.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const NEXT_YEAR: AcademicYearDto = { id: 'y2', name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned', createdAt: STAMP, updatedAt: STAMP };
const CLASS_SIX: ClassDto = { ...CLASSES[0]!, id: 'c6', academicYearId: 'y2', academicYearName: '2027-28', name: 'Class 6' };

const SHEET: PromotionSheetDto = {
  id: 'ps1',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  classId: 'c5',
  className: 'Class 5',
  classIsFinal: false,
  sectionId: 'sec-a',
  sectionName: 'A',
  targetYearId: 'y2',
  targetYearName: '2027-28',
  status: 'open',
  rows: 2,
  undecided: 1,
  openedByName: 'Amina Principal',
  openedAt: STAMP,
  appliedByName: null,
  appliedAt: null,
  updatedAt: STAMP,
};

const row = (id: string, extra: Partial<PromotionDecisionDto>): PromotionDecisionDto => ({
  id,
  enrolmentId: `e-${id}`,
  studentId: `st-${id}`,
  studentName: 'Hamza Tariq',
  admissionNo: '1001',
  studentStatus: 'active',
  rollNo: 1,
  enrolmentStatus: 'active',
  resultId: 'r1',
  resultSuperseded: false,
  percentBp: 7850,
  grade: 'B',
  passed: true,
  proposed: 'promote',
  decision: 'promote',
  reason: null,
  targetClassId: 'c6',
  targetClassName: 'Class 6',
  targetSectionId: 'sec-6a',
  targetSectionName: 'A',
  arrearsFlag: false,
  decidedByName: null,
  decidedAt: null,
  appliedAt: null,
  skipped: false,
  newEnrolmentId: null,
  revisedAfterApply: false,
  ...extra,
});

const PASS = row('d1', { arrearsFlag: true });
const FAIL = row('d2', {
  studentName: 'Hira Tariq',
  admissionNo: '1002',
  rollNo: 2,
  percentBp: 3000,
  grade: 'F',
  passed: false,
  proposed: 'detain',
  decision: null,
  targetClassId: null,
  targetClassName: null,
  targetSectionId: null,
  targetSectionName: null,
});
const DETAIL: PromotionSheetDetailDto = { ...SHEET, targetYearHasClasses: true, decisions: [PASS, FAIL] };

const handler = ({ method, path, url }: { method: string; path: string; url: URL }) => {
  if (method !== 'GET') return undefined;
  if (path === '/academic-years') return { status: 200, body: page1([...YEARS, NEXT_YEAR]) };
  if (path === '/promotion-sheets') return { status: 200, body: page1([SHEET]) };
  if (path === '/promotion-sheets/ps1') return { status: 200, body: DETAIL };
  if (path === '/classes' && url.searchParams.get('academicYearId') === 'y2') return { status: 200, body: page1([CLASS_SIX]) };
  if (path === '/classes/c6/sections') {
    return { status: 200, body: page1([{ ...SECTIONS[0]!, id: 'sec-6a', classId: 'c6' }, { ...SECTIONS[1]!, id: 'sec-6b', classId: 'c6' }]) };
  }
  return undefined;
};

test('the year lists every section with its sheet; opening one goes into the next year with a key (R294)', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: {
      'POST /sections/sec-b/promotion-sheets': [
        { status: 409, body: errorBody('PROMOTION_FINAL_NOT_APPROVED', 'Approve the final result first.', { sectionId: 'sec-b' }) },
        { status: 201, body: { ...DETAIL, id: 'ps2', sectionId: 'sec-b', sectionName: 'B' } },
      ],
    },
  });
  await open(page, '/promotion');
  await expect(page.getByRole('row', { name: /Class 5 A/ })).toContainText('1 undecided');
  await expect(page.getByRole('row', { name: /Class 5 A/ })).toContainText('2027-28');
  await expect(page.getByRole('row', { name: /Class 5 B/ })).toContainText('Not opened');

  await page.getByRole('row', { name: /Class 5 B/ }).getByRole('button', { name: 'Open sheet' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Promote into')).toHaveValue('y2');
  await dialog.getByRole('button', { name: 'Open sheet' }).click();
  await expect(dialog).toContainText("Approve the section's final result");
  await dialog.getByRole('button', { name: 'Open sheet' }).click();
  await expect(page).toHaveURL(/\/promotion\/ps2$/);
  const posts = calls(requests, 'POST', '/sections/sec-b/promotion-sheets');
  expect(posts).toHaveLength(2);
  // The same key for a retried confirm: the second is a replay if the first had committed.
  const keys = posts.map((r) => r.headers()['idempotency-key']);
  expect(keys[0]).toMatch(KEY);
  expect(keys[1]).toBe(keys[0]);
  expect(posts[0]?.postDataJSON()).toEqual({ targetYearId: 'y2' });
});

test('the sheet shows proposals and arrears; an override needs a reason and saves the changed row (R295)', async ({ page }) => {
  const applied: PromotionSheetDetailDto = { ...DETAIL, status: 'applied', undecided: 0, appliedAt: STAMP, appliedByName: 'Amina Principal' };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: {
      'PATCH /promotion-sheets/ps1': [
        { status: 422, body: errorBody('VALIDATION_FAILED', 'Some fields are invalid.', { fields: [{ path: 'decisions[0].reason', code: 'INVALID_VALUE', message: 'Give a reason for deciding differently from the proposal' }] }) },
        { status: 200, body: { ...DETAIL, undecided: 0 } },
      ],
      'POST /promotion-sheets/ps1/apply': { status: 200, body: applied },
    },
  });
  await open(page, '/promotion/ps1');
  const pass = page.getByRole('row', { name: /Hamza Tariq/ });
  await expect(pass).toContainText('Fees owed');
  await expect(pass).toContainText('78.50 %');
  // Apply waits for every decision.
  await expect(page.getByRole('button', { name: 'Apply…' })).toBeDisabled();

  const fail = page.getByRole('row', { name: /Hira Tariq/ });
  await fail.getByLabel('Decision for Hira Tariq').selectOption('promote');
  await expect(fail.getByLabel('Reason for Hira Tariq')).toHaveAttribute('placeholder', /Required/);
  await fail.getByLabel('Class for Hira Tariq').selectOption('c6');
  await fail.getByLabel('Section for Hira Tariq').selectOption('sec-6b');
  await page.getByRole('button', { name: 'Save changes (1)' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Give a reason for deciding differently' })).toBeVisible();
  await fail.getByLabel('Reason for Hira Tariq').fill('Passed the re-sit');
  await page.getByRole('button', { name: 'Save changes (1)' }).click();
  await expect(page.getByText('Decisions saved.')).toBeVisible();
  const patches = calls(requests, 'PATCH', '/promotion-sheets/ps1');
  expect(patches[1]?.postDataJSON()).toEqual({
    decisions: [{ enrolmentId: 'e-d2', decision: 'promote', reason: 'Passed the re-sit', targetClassId: 'c6', targetSectionId: 'sec-6b' }],
  });
});

test('apply is confirmed and keyed; a refusal shows in the dialog', async ({ page }) => {
  const ready: PromotionSheetDetailDto = { ...DETAIL, undecided: 0, decisions: [PASS, { ...FAIL, decision: 'detain', targetClassId: 'c5', targetClassName: 'Class 5', targetSectionId: 'sec-a', targetSectionName: 'A' }] };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => (call.method === 'GET' && call.path === '/promotion-sheets/ps1' ? { status: 200, body: ready } : handler(call)),
    replies: {
      'POST /promotion-sheets/ps1/apply': [
        { status: 409, body: errorBody('PROMOTION_RESULT_SUPERSEDED', 'Decide again.', { enrolmentIds: ['e-d1'] }) },
      ],
    },
  });
  await open(page, '/promotion/ps1');
  await page.getByRole('button', { name: 'Apply…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('cannot be undone');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toContainText('corrected since the sheet read them');
  const posts = calls(requests, 'POST', '/promotion-sheets/ps1/apply');
  expect(posts[0]?.headers()['idempotency-key']).toMatch(KEY);
});

test('an applied sheet is read-only, with its revised and skipped rows marked', async ({ page }) => {
  const applied: PromotionSheetDetailDto = {
    ...DETAIL,
    status: 'applied',
    undecided: 0,
    appliedAt: STAMP,
    appliedByName: 'Amina Principal',
    decisions: [{ ...PASS, appliedAt: STAMP, newEnrolmentId: 'e9', revisedAfterApply: true }, { ...FAIL, decision: 'detain', reason: 'Repeats', skipped: true }],
  };
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => (call.method === 'GET' && call.path === '/promotion-sheets/ps1' ? { status: 200, body: applied } : handler(call)),
  });
  await open(page, '/promotion/ps1');
  await expect(page.getByText('The sheet can no longer change.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Hamza Tariq/ })).toContainText('Result revised after apply');
  await expect(page.getByRole('row', { name: /Hira Tariq/ })).toContainText('Skipped');
  await expect(page.getByRole('button', { name: 'Apply…' })).toHaveCount(0);
  await expect(page.getByLabel('Decision for Hamza Tariq')).toHaveCount(0);
});

test('changing a decision drops the old target (the server picks the new default); Complete only on a final class (R295)', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'PATCH /promotion-sheets/ps1': { status: 200, body: { ...DETAIL, undecided: 0 } } },
  });
  await open(page, '/promotion/ps1');
  const fail = page.getByRole('row', { name: /Hira Tariq/ });
  const decision = fail.getByLabel('Decision for Hira Tariq');
  // Class 5 is not a final class: Complete is not offered.
  await expect(decision.locator('option', { hasText: 'Complete' })).toHaveCount(0);
  await decision.selectOption('promote');
  await fail.getByLabel('Class for Hira Tariq').selectOption('c6');
  await fail.getByLabel('Section for Hira Tariq').selectOption('sec-6b');
  // Detain instead: the class chosen for promote no longer applies.
  await decision.selectOption('detain');
  await expect(fail.getByLabel('Class for Hira Tariq')).toHaveValue('');
  await expect(fail.getByLabel('Section for Hira Tariq')).toHaveValue('');
  await page.getByRole('button', { name: 'Save changes (1)' }).click();
  await expect(page.getByText('Decisions saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/promotion-sheets/ps1')[0]?.postDataJSON()).toEqual({
    decisions: [{ enrolmentId: 'e-d2', decision: 'detain' }],
  });

  // A final class's sheet offers it.
  const finalDetail: PromotionSheetDetailDto = { ...DETAIL, classIsFinal: true };
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => (call.method === 'GET' && call.path === '/promotion-sheets/ps1' ? { status: 200, body: finalDetail } : handler(call)),
  });
  await open(page, '/promotion/ps1');
  await expect(page.getByLabel('Decision for Hira Tariq').locator('option', { hasText: 'Complete' })).toHaveCount(1);
});

test('the year lists every section even past one page of 50 (sheets and sections paged to their totals)', async ({ page }) => {
  const many = Array.from({ length: 55 }, (_, i) => ({ ...SECTIONS[0]!, id: `s${i + 1}`, name: `S${String(i + 1).padStart(2, '0')}` }));
  const lastSheet: PromotionSheetDto = { ...SHEET, id: 'ps55', sectionId: 's55', sectionName: 'S55', status: 'applied', undecided: 0, appliedAt: STAMP };
  const pageOf = <T,>(all: T[], url: URL) => {
    const n = Number(url.searchParams.get('page') ?? '1');
    const limit = Number(url.searchParams.get('limit') ?? '25');
    return { status: 200, body: { data: all.slice((n - 1) * limit, n * limit), page: n, limit, total: all.length } };
  };
  const sheets = [...Array.from({ length: 50 }, (_, i) => ({ ...SHEET, id: `x${i}`, sectionId: `other-${i}` })), lastSheet];
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path, url }) => {
      if (method !== 'GET') return undefined;
      if (path === '/academic-years') return { status: 200, body: page1([...YEARS, NEXT_YEAR]) };
      if (path === '/promotion-sheets') return pageOf(sheets, url);
      if (path === '/classes') return pageOf([CLASSES[0]!], url);
      if (path === '/classes/c5/sections') return pageOf(many, url);
      return undefined;
    },
  });
  await open(page, '/promotion');
  await expect(page.getByRole('row', { name: /Class 5 S55/ })).toContainText('Applied');
  await expect(page.getByRole('row', { name: /Class 5 S51/ })).toContainText('Not opened');
});

test('the principal cancels an open sheet with a reason; a cancelled sheet says so and the section can open again', async ({ page }) => {
  const cancelled: PromotionSheetDetailDto = { ...DETAIL, status: 'cancelled' };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'POST /promotion-sheets/ps1/cancel': { status: 200, body: cancelled } },
  });
  await open(page, '/promotion/ps1');
  await page.getByRole('button', { name: 'Cancel sheet…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Cancel sheet' })).toBeDisabled();
  await dialog.getByLabel('Reason for cancelling').fill('Opened into the wrong year');
  await dialog.getByRole('button', { name: 'Cancel sheet' }).click();
  await expect(page.getByText('Promotion sheet cancelled.')).toBeVisible();
  expect(calls(requests, 'POST', '/promotion-sheets/ps1/cancel')[0]?.postDataJSON()).toEqual({ reason: 'Opened into the wrong year' });

  // The cancelled sheet, read back.
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => {
      if (call.method === 'GET' && call.path === '/promotion-sheets/ps1') return { status: 200, body: cancelled };
      if (call.method === 'GET' && call.path === '/promotion-sheets') return { status: 200, body: page1([{ ...SHEET, status: 'cancelled' }]) };
      return handler(call);
    },
  });
  await open(page, '/promotion/ps1');
  await expect(page.getByText('Nobody was moved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel sheet…' })).toHaveCount(0);
  await open(page, '/promotion');
  const rowA = page.getByRole('row', { name: /Class 5 A/ });
  await expect(rowA).toContainText('Cancelled');
  await expect(rowA.getByRole('button', { name: 'Open sheet' })).toBeVisible();
});

test('a teacher granted assessment.define sees no Cancel (principal only)', async ({ page }) => {
  await mockSchoolApi(page, {
    me: { ...TEACHER_ME, capabilities: [...TEACHER_ME.capabilities, Capability.ASSESSMENT_DEFINE] },
    handler,
  });
  await open(page, '/promotion/ps1');
  await expect(page.getByRole('button', { name: 'Apply…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel sheet…' })).toHaveCount(0);
});

test('closing a year lists the sections whose promotion is not applied (R299)', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'POST /academic-years/y1/close': {
        status: 409,
        body: errorBody('PROMOTION_INCOMPLETE', 'Apply the promotion sheets first.', {
          sections: [{ sectionId: 'sec-a', sectionName: 'A', className: 'Class 5' }],
        }),
      },
    },
  });
  await open(page, '/academics/years');
  await page.getByRole('button', { name: 'Actions for 2026-27' }).click();
  await page.getByRole('menuitem', { name: 'Close year' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close 2026-27?' });
  await dialog.getByRole('button', { name: 'Close year permanently' }).click();
  await expect(dialog).toContainText('Still open: Class 5 A');
  await expect(dialog.getByRole('link', { name: 'Go to Promotion' })).toHaveAttribute('href', '/promotion');
});

test('the office (no assessment.define) has no Promotion in the menu; the sheet fits a tablet', async ({ page }) => {
  await mockSchoolApi(page, { me: OFFICE_ME, handler });
  await open(page, '/students');
  await expect(page.getByRole('link', { name: 'Promotion' })).toHaveCount(0);
  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler });
  await open(page, '/promotion/ps1');
  await expectNoSidewaysScroll(page);
});
