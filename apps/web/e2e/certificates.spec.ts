import { expect as baseExpect, test } from '@playwright/test';
import type { CertificateDto, CertificateSummaryDto } from '../lib/api/school-certificates-contract';
import type { StudentDetailDto, StudentDto } from '../lib/api/school-students-contract';
import { OFFICE_ME, PRINCIPAL_ME, STAMP, TABLET, TEACHER_ME, TODAY, calls, errorBody, expectNoSidewaysScroll, mockSchoolApi, open, page1 } from './support/wave-e';

// Certificates (phase-4-academic.md slice 34, R289-R293) against a mocked API: the register with
// its duplicate and void badges, the row menu by role (only a principal voids), issuing from the
// register with a student search and one idempotency key per form, the dues refusal in the
// office's words, print in a new tab, reissue and void with a reason, and the student page's
// Certificates tab (for every certificate.issue holder, with or without fee.statement.view).

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const BODY: CertificateDto['body'] = {
  schoolName: 'Green Valley School',
  studentName: 'Hamza Tariq',
  fatherName: 'Tariq Mehmood',
  admissionNo: '1001',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  admittedOn: '2025-04-01',
  studentStatus: 'withdrawn',
  academicYearName: '2026-27',
  className: 'Class 5',
  sectionName: 'A',
  attendedFrom: '2025-04-01',
  attendedTo: '2026-10-01',
  enrolments: [],
  conduct: 'Good',
  remarks: null,
  signatoryName: 'Amina Principal',
  result: null,
};

const certificate = (id: string, extra: Partial<CertificateDto> = {}): CertificateDto => ({
  id,
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  admissionNo: '1001',
  type: 'character',
  number: 1,
  label: 'CC-0001',
  issueNo: 1,
  reissueOfId: null,
  academicYearId: 'y1',
  academicYearName: '2026-27',
  title: 'Character Certificate',
  duesStatus: 'not_required',
  reason: null,
  issuedOn: TODAY,
  issuedByName: 'Bilal Office',
  printedCount: 0,
  voidedAt: null,
  voidedByName: null,
  voidReason: null,
  createdAt: STAMP,
  body: BODY,
  ...extra,
});

const LEAVING = certificate('c1', { type: 'leaving', label: 'LC-0001', title: 'School Leaving Certificate', duesStatus: 'override', reason: 'Leaving for abroad' });
const DUPLICATE = certificate('c2', { issueNo: 2, reissueOfId: 'c0', reason: 'Lost' });
const VOIDED = certificate('c3', { number: 2, label: 'CC-0002', voidedAt: STAMP, voidedByName: 'Amina Principal', voidReason: 'Issued in error' });
const REGISTER = [LEAVING, DUPLICATE, VOIDED];

const registerHandler =
  (rows: CertificateDto[] = REGISTER) =>
  ({ method, path }: { method: string; path: string }) =>
    method === 'GET' && path === '/certificates' ? { status: 200, body: page1(rows) } : undefined;

const menuOf = async (page: import('@playwright/test').Page, label: string) => {
  await page.getByRole('button', { name: `Actions for certificate ${label}` }).click();
  return page.getByRole('menu', { name: `Actions for certificate ${label}` });
};

const STUDENT_ROW: StudentDto = {
  id: 'st1',
  admissionNo: '1001',
  fullName: 'Hamza Tariq',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: null,
  status: 'withdrawn',
  admittedOn: '2025-04-01',
  current: null,
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const ENROLMENTS = page1([
  {
    id: 'e1',
    studentId: 'st1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 7,
    status: 'left',
    startedOn: '2026-04-01',
    endedOn: '2026-10-01',
  },
]);

test('the register shows duplicate and void badges; the office reissues and prints but only a principal voids (R293)', async ({ page }) => {
  await mockSchoolApi(page, { me: OFFICE_ME, handler: registerHandler() });
  await open(page, '/certificates');
  await expect(page.getByRole('row', { name: /LC-0001/ })).toContainText('Overridden');
  await expect(page.getByRole('row', { name: /LC-0001/ })).toContainText('School Leaving Certificate');
  await expect(page.getByRole('row', { name: /CC-0001/ })).toContainText('Duplicate 2');
  await expect(page.getByRole('row', { name: /CC-0002/ })).toContainText('Voided');

  let menu = await menuOf(page, 'LC-0001');
  await expect(menu.getByRole('menuitem', { name: 'Print' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reissue' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Void' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A voided certificate can still be printed (it prints VOID), never reissued.
  menu = await menuOf(page, 'CC-0002');
  await expect(menu.getByRole('menuitem', { name: 'Print' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reissue' })).toHaveCount(0);
});

test('a principal voids with a reason; filters reach the query string', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: registerHandler(),
    replies: { 'POST /certificates/c1/void': { status: 200, body: { ...LEAVING, voidedAt: STAMP, voidReason: 'Wrong class printed' } } },
  });
  await open(page, '/certificates');
  const menu = await menuOf(page, 'LC-0001');
  await menu.getByRole('menuitem', { name: 'Void' }).click();
  const dialog = page.getByRole('dialog');
  // Wave N review: a void voids the number, duplicates included, and it cannot be reissued.
  await expect(dialog).toContainText('every duplicate of it');
  await expect(dialog).toContainText('cannot be reissued');
  await dialog.getByRole('textbox').fill('Wrong class printed');
  await dialog.getByRole('button', { name: 'Void' }).click();
  await expect(page.getByText('LC-0001 voided.')).toBeVisible();
  expect(calls(requests, 'POST', '/certificates/c1/void')[0].postDataJSON()).toEqual({ reason: 'Wrong class printed' });

  await page.getByLabel('Type').selectOption('leaving');
  await page.getByLabel('Status').selectOption('voided');
  await expect
    .poll(() => calls(requests, 'GET', '/certificates').map((r) => new URL(r.url()).search).at(-1))
    .toMatch(/type=leaving.*voided=true|voided=true.*type=leaving/);
});

test('reissue asks for a reason and sends an idempotency key; print opens the print view in a new tab', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: registerHandler(),
    replies: { 'POST /certificates/c1/reissue': { status: 201, body: { ...LEAVING, id: 'c9', issueNo: 2, reason: 'Original lost' } } },
  });
  await page.context().route('**/api/v1/certificates/*/print', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Certificate</title><p>Printed</p>' }),
  );
  await open(page, '/certificates');
  let menu = await menuOf(page, 'LC-0001');
  await menu.getByRole('menuitem', { name: 'Reissue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Original lost');
  await dialog.getByRole('button', { name: 'Reissue' }).click();
  await expect(page.getByText('LC-0001 reissued as duplicate 2.')).toBeVisible();
  const [reissue] = calls(requests, 'POST', '/certificates/c1/reissue');
  expect(reissue.headers()['idempotency-key']).toMatch(KEY);
  expect(reissue.postDataJSON()).toEqual({ reason: 'Original lost' });

  menu = await menuOf(page, 'LC-0001');
  const opened = page.context().waitForEvent('page');
  await menu.getByRole('menuitem', { name: 'Print' }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).pathname).toBe('/api/v1/certificates/c1/print');
  await tab.close();
});

test('issuing from the register: find the student, pick the type; a dues refusal is explained and the retry keeps its key', async ({ page }) => {
  const issued = certificate('c7', { type: 'leaving', label: 'LC-0002', title: 'School Leaving Certificate', duesStatus: 'cleared', studentId: 'st1' });
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: (call) => {
      if (call.method === 'GET' && call.path === '/students') return { status: 200, body: page1([STUDENT_ROW]) };
      if (call.method === 'GET' && call.path === '/students/st1/enrolments') return { status: 200, body: ENROLMENTS };
      return registerHandler()(call);
    },
    replies: {
      'POST /students/st1/certificates': [
        { status: 409, body: errorBody('CERTIFICATE_DUES_BLOCK', 'The student has unpaid dues.', { outstanding: 3000 }) },
        { status: 201, body: issued },
      ],
    },
  });
  await open(page, '/certificates');
  await page.getByRole('button', { name: 'Issue certificate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Name or admission number').fill('Hamza');
  await dialog.getByRole('button', { name: /Hamza Tariq/ }).click();
  await expect(dialog.getByText('To Hamza Tariq.', { exact: false })).toBeVisible();

  // The title is asked only for `other`, which needs one before anything is sent, and may not
  // read as a leaving certificate.
  await expect(dialog.getByLabel('Title')).toHaveCount(0);
  await dialog.getByLabel('Certificate').selectOption('other');
  await dialog.getByRole('button', { name: 'Issue certificate' }).click();
  await expect(dialog.getByText('Give the certificate a title.')).toBeVisible();
  await dialog.getByLabel('Title').fill('School Leaving Certificate');
  await dialog.getByRole('button', { name: 'Issue certificate' }).click();
  await expect(dialog.getByText('For a leaving certificate, choose the School leaving type.')).toBeVisible();
  expect(calls(requests, 'POST', '/students/st1/certificates')).toHaveLength(0);

  await dialog.getByLabel('Certificate').selectOption('leaving');
  await expect(dialog.getByLabel('Title')).toHaveCount(0);
  await dialog.getByLabel('Academic year').selectOption('y1');
  await dialog.getByLabel('Conduct (optional)').fill('Good');
  await dialog.getByRole('button', { name: 'Issue certificate' }).click();
  await expect(dialog.getByText(/owes Rs 3,000/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Issue certificate' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('School Leaving Certificate LC-0002 issued to Hamza Tariq.')).toBeVisible();

  const posts = calls(requests, 'POST', '/students/st1/certificates');
  expect(posts).toHaveLength(2);
  expect(posts[0].postDataJSON()).toEqual({ type: 'leaving', academicYearId: 'y1', conduct: 'Good' });
  expect(posts[0].headers()['idempotency-key']).toMatch(KEY);
  // One opened form, one key: the retry after the refusal is the same request.
  expect(posts[1].headers()['idempotency-key']).toBe(posts[0].headers()['idempotency-key']);
});

const STUDENT: StudentDetailDto = {
  id: 'st1',
  admissionNo: '1001',
  fullName: 'Hamza Tariq',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'withdrawn',
  admittedOn: '2025-04-01',
  current: null,
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: null,
  photoDocumentId: null,
};

const studentHandler = ({ method, path }: { method: string; path: string }) => {
  if (method !== 'GET') return undefined;
  if (path === '/students/st1') return { status: 200, body: STUDENT };
  if (path === '/school/settings') return { status: 200, body: { feeDueDay: 10, studentLoginEnabled: true, updatedAt: STAMP } };
  if (path === '/students/st1/dues-clearance') {
    return { status: 200, body: { studentId: 'st1', outstanding: 0, openCharges: [], advance: 0, cleared: true, override: null } };
  }
  if (path === '/students/st1/certificates') {
    // The summary carries no body, dues status or reason (wave N review).
    const summary = Object.fromEntries(
      Object.entries(LEAVING).filter(([key]) => !['body', 'duesStatus', 'reason'].includes(key)),
    ) as CertificateSummaryDto;
    return { status: 200, body: page1([summary]) };
  }
  if (path === '/students/st1/enrolments') return { status: 200, body: ENROLMENTS };
  if (path === '/students/st1/fee-statement') {
    return {
      status: 200,
      body: {
        totals: { charged: 0, concession: 0, adjustments: 0, paid: 0, outstanding: 0, advance: 0 },
        charges: page1([]),
        payments: [],
        adjustments: [],
        concessions: [],
      },
    };
  }
  return undefined;
};

test('the student page’s Certificates tab lists the student’s certificates and issues one there', async ({ page }) => {
  const issued = certificate('c8', { label: 'CC-0003', number: 3 });
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: studentHandler,
    replies: { 'POST /students/st1/certificates': { status: 201, body: issued } },
  });
  await open(page, '/students/st1');
  await page.getByRole('tab', { name: 'Certificates' }).click();
  await expect(page.getByRole('row', { name: /LC-0001/ })).toContainText('School Leaving Certificate');
  await page.getByRole('button', { name: 'Issue certificate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Remarks (optional)').fill('Took part in the science fair');
  await dialog.getByRole('button', { name: 'Issue certificate' }).click();
  await expect(page.getByText('Character Certificate CC-0003 issued to Hamza Tariq.')).toBeVisible();
  expect(calls(requests, 'POST', '/students/st1/certificates')[0].postDataJSON()).toEqual({
    type: 'character',
    remarks: 'Took part in the science fair',
  });
});

test('a certificate.issue holder without fee.statement.view reaches the student’s certificates; the Fees tab stays hidden', async ({ page }) => {
  const me = {
    ...OFFICE_ME,
    capabilities: OFFICE_ME.capabilities.filter((c) => c !== 'fee.statement.view'),
    capabilityScopes: OFFICE_ME.capabilityScopes.filter((s) => s.capability !== 'fee.statement.view'),
  };
  await mockSchoolApi(page, { me, handler: studentHandler });
  await open(page, '/students/st1');
  await expect(page.getByRole('tab', { name: 'Fees' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Certificates' }).click();
  await expect(page.getByRole('row', { name: /LC-0001/ })).toContainText('School Leaving Certificate');
  await expect(page.getByRole('button', { name: 'Issue certificate' })).toBeVisible();
});

test('the sidebar shows Certificates to certificate.issue holders only; the register fits a tablet', async ({ page }) => {
  await mockSchoolApi(page, { me: TEACHER_ME });
  await open(page, '/students');
  await expect(page.getByRole('link', { name: 'Certificates' })).toHaveCount(0);

  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, { me: OFFICE_ME, handler: registerHandler() });
  await open(page, '/certificates');
  await expect(page.getByRole('link', { name: 'Certificates' }).first()).toBeVisible();
  await expectNoSidewaysScroll(page);
});
