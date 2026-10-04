import { expect as baseExpect, test, type Page } from '@playwright/test';
import { randomBytes, randomInt } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { seedPlatformAdmin } from './support/seed';
import { totp } from './support/totp';

// Staff, teacher scope and admission against the REAL API (started by playwright.config.ts on
// the TEST database): a platform admin creates a school and its principal; the principal builds
// a year, a class with two sections, a staff member with a teacher login and a class-teacher
// assignment for section A (contracts/slice-4.md); then admits two siblings through the wizard
// (contracts/slice-6.md §6), one in each section, the first with a new guardian and a PNG
// document; finally the teacher signs in on the default password and sees only the student in
// their section (R-scope: rows come from assignment data, rule 13).
//
// Isolation as in school-real.spec.ts: a per-run platform admin, school code and random CNICs in
// TEST_DATABASE_URL. The development database is never touched; the rows stay in the test database.

const expect = baseExpect.configure({ timeout: 15_000 });

const digits = (count: number) =>
  Array.from({ length: count }, () => String(randomInt(0, 10))).join('');
/** 13 digits, not starting with 0 (rule 12: CNIC and B-Form logins). */
const identity = () => `${randomInt(1, 10)}${digits(12)}`;
/** 35201-1234567-1 */
const dashed = (value: string) => `${value.slice(0, 5)}-${value.slice(5, 12)}-${value.slice(12)}`;

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(-9);
const email = `e2e-${runId}@localhost`;
const initialPassword = `E2e-${randomBytes(12).toString('hex')}`;
const newPassword = `E2e-${randomBytes(12).toString('hex')}`;
const shortCode = `e2e${runId}`;
const schoolName = `E2E Students ${runId}`;
const principalCnic = identity();
const teacherCnic = identity();
const guardianCnic = identity();
const studentBForm = identity();
const teacherName = `Tariq Teacher ${runId}`;
const guardianName = `Ahmed Guardian ${runId}`;
const firstStudent = `Ali Student ${runId}`;
const secondStudent = `Sara Student ${runId}`;

// A year around today, so the default admission date and assignment start fall inside it.
const thisYear = new Date().getFullYear();
const yearName = `${thisYear}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => seedPlatformAdmin(email, initialPassword));

/** A valid 8 × 8 grey PNG: the API decodes and re-encodes every image (upload-processing.ts). */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0); // width
  header.writeUInt32BE(8, 4); // height
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill(0x80)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The platform admin's first sign-in: password, authenticator enrolment, password change. */
async function platformFirstSignIn(page: Page) {
  await page.goto('/platform/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Fails here, before anything is written, if the API on :3461 is not on the test database.
  await expect(page, 'the API must run on TEST_DATABASE_URL').toHaveURL(/\/platform\/enrol$/);

  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  const secretText = page.getByTestId('totp-secret');
  await expect(secretText).toBeVisible();
  const secret = (await secretText.textContent())?.replace(/\s/g, '') ?? '';
  await page.getByLabel('Authenticator code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page).toHaveURL(/\/platform\/change-password$/);
  await page.getByLabel('Current password').fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/platform\/schools$/);
}

/** School sign-in on the default password (rule 12: the identity digits). */
async function schoolSignIn(page: Page, cnic: string) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('School code').fill(shortCode);
  await page.getByLabel('CNIC or B-Form number').fill(cnic);
  await page.getByLabel('Password').fill(cnic);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
}

async function addSection(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add section' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add section' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Add section' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('table').getByText(name, { exact: true })).toBeVisible();
}

/** Wizard steps 3–5: year, class and section, then (optionally) one document, then submit. */
async function placeAndAdmit(page: Page, fullName: string, section: string, withDocument: boolean) {
  await page.getByLabel('Academic year').selectOption({ label: yearName });
  await page.getByLabel('Class').selectOption({ label: 'Class 1' });
  await page.getByLabel('Section').selectOption({ label: section });
  await page.getByRole('button', { name: 'Continue' }).click();

  if (withDocument) {
    await page.getByLabel('Type').selectOption('b_form');
    await page.getByLabel(/^File/).setInputFiles({ name: 'bform.png', mimeType: 'image/png', buffer: tinyPng() });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByText(/— bform\.png,/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByRole('button', { name: 'Skip' }).click();
  }

  await page.getByRole('button', { name: 'Admit student' }).click();
  await expect(page.getByText(`${fullName} is admitted`)).toBeVisible();
}

test('staff, a class teacher, two admissions; the teacher sees only their section', async ({ browser }) => {
  test.setTimeout(300_000);

  // ---- Platform admin: the school and its principal.
  const platformContext = await browser.newContext();
  const admin = await platformContext.newPage();
  await platformFirstSignIn(admin);
  await admin.getByRole('link', { name: 'New school' }).first().click();
  await admin.getByLabel('School name').fill(schoolName);
  await admin.getByLabel('Short code').fill(shortCode);
  await admin.getByRole('button', { name: 'Create school' }).click();
  await expect(admin.getByRole('heading', { name: schoolName })).toBeVisible();
  await admin.getByRole('button', { name: 'Issue principal login' }).click();
  const issue = admin.getByRole('dialog');
  await issue.getByLabel('Full name').fill('Amina Principal');
  await issue.getByLabel('CNIC').fill(principalCnic);
  await issue.getByLabel('Mobile number').fill(`0300${digits(7)}`);
  await issue.getByRole('button', { name: 'Issue login' }).click();
  await expect(issue.getByText('Principal login issued')).toBeVisible();
  await platformContext.close();

  // ---- Principal: a year, a class, sections A and B.
  const schoolContext = await browser.newContext();
  const page = await schoolContext.newPage();
  await schoolSignIn(page, principalCnic);

  await page.goto('/academics/years');
  await page.getByRole('button', { name: 'New academic year' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(yearName);
  await dialog.getByLabel('Starts on').fill(`${thisYear}-01-01`);
  await dialog.getByLabel('Ends on').fill(`${thisYear}-12-31`);
  await dialog.getByRole('button', { name: 'Create year' }).click();
  await expect(dialog).toBeHidden();

  await page.goto('/academics/classes');
  await page.getByRole('button', { name: 'New class' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Class 1');
  await dialog.getByLabel('Attendance is taken').selectOption('daily');
  await dialog.getByRole('button', { name: 'Create class' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('table').getByRole('link', { name: 'Class 1' }).click();
  await expect(page.getByRole('heading', { name: 'Class 1' })).toBeVisible();
  await addSection(page, 'A');
  await addSection(page, 'B');

  // ---- Staff: a teacher with a login and a class-teacher assignment for 1 A.
  await page.goto('/staff/new');
  await page.getByLabel('Full name').fill(teacherName);
  await page.getByLabel('CNIC (optional)').fill(teacherCnic);
  await page.getByLabel('Mobile phone').fill(`0301${digits(7)}`);
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page).toHaveURL(/\/staff\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { name: teacherName })).toBeVisible();

  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('button', { name: 'Issue login' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Role').selectOption('teacher');
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Has a login, as Teacher/)).toBeVisible();

  await page.getByRole('tab', { name: 'Teaching assignments' }).click();
  await page.getByRole('button', { name: 'Add assignment' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Role').selectOption('class_teacher');
  await expect(dialog.getByLabel('Session')).not.toHaveValue('');
  await dialog.getByLabel('Class').selectOption({ label: 'Class 1' });
  await dialog.getByLabel('Section').selectOption({ label: 'A' });
  await dialog.getByRole('button', { name: 'Add assignment' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Class 1/ }).getByText('Active today')).toBeVisible();

  // ---- Admission 1: a new guardian (CNIC and phone searched first), 1 A, a PNG document.
  await page.goto('/admissions/new');
  await page.getByLabel('Student’s B-Form or CRC number').fill(studentBForm);
  await page.getByRole('button', { name: 'Check B-Form' }).click();
  await page.getByLabel('Full name').fill(firstStudent);
  await page.getByLabel('Gender').selectOption('male');
  await page.getByLabel('Date of birth').fill(`${thisYear - 8}-05-04`);
  await page.getByRole('button', { name: 'Continue' }).click();

  const guardianPhone = `0302${digits(7)}`;
  await page.getByLabel('Guardian’s CNIC').fill(guardianCnic);
  await page.getByRole('button', { name: 'Search by CNIC' }).click();
  await expect(page.getByText('No guardian has this CNIC.')).toBeVisible();
  await page.getByLabel('Guardian’s mobile phone').fill(guardianPhone);
  await page.getByRole('button', { name: 'Search by phone' }).click();
  await expect(page.getByText('No guardian has this phone number.')).toBeVisible();
  await page.getByRole('button', { name: 'Add a new guardian' }).click();
  await expect(page.getByLabel('CNIC (optional)')).toHaveValue(dashed(guardianCnic));
  await page.getByLabel('Full name').fill(guardianName);
  await page.getByRole('radio', { name: /WhatsApp/ }).check();
  await page.getByRole('button', { name: 'Add guardian' }).click();
  await page.getByLabel('Relationship').selectOption('father');
  await page.getByRole('button', { name: 'Continue' }).click();
  await placeAndAdmit(page, firstStudent, 'A', true);

  // ---- Admission 2: a sibling in 1 B, the same guardian found by CNIC and linked.
  await page.getByRole('button', { name: 'Admit another student' }).click();
  await page.getByLabel('Student’s B-Form or CRC number').fill(identity());
  await page.getByRole('button', { name: 'Check B-Form' }).click();
  await page.getByLabel('Full name').fill(secondStudent);
  await page.getByLabel('Gender').selectOption('female');
  await page.getByLabel('Date of birth').fill(`${thisYear - 7}-02-10`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Guardian’s CNIC').fill(guardianCnic);
  await page.getByRole('button', { name: 'Search by CNIC' }).click();
  await expect(page.getByText(`— father of ${firstStudent}`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: `Link ${guardianName}` }).click();
  await page.getByLabel('Relationship').selectOption('father');
  await page.getByRole('button', { name: 'Continue' }).click();
  await placeAndAdmit(page, secondStudent, 'B', false);

  // ---- The principal sees both; the document is on the first record.
  await page.goto('/students');
  await expect(page.getByRole('row').filter({ hasText: firstStudent })).toContainText('Class 1 A');
  await expect(page.getByRole('row').filter({ hasText: secondStudent })).toContainText('Class 1 B');
  await page.getByRole('link', { name: firstStudent }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'B-Form' })).toContainText('Image');
  await schoolContext.close();

  // ---- The teacher, on the default password, sees only the student in their section.
  const teacherContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  await schoolSignIn(teacher, teacherCnic);
  await teacher.goto('/students');
  const table = teacher.getByRole('table');
  await expect(table.getByRole('row').filter({ hasText: firstStudent })).toBeVisible();
  await expect(table.getByText(secondStudent)).toHaveCount(0);
  // The header row and the one student.
  await expect(table.getByRole('row')).toHaveCount(2);
  await teacherContext.close();
});
