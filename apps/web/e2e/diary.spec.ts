import { expect as baseExpect, test } from '@playwright/test';
import type { DiaryEntryDto, RemarkDto } from '../lib/api/school-diary-contract';
import type { SchoolSettingsDto } from '../lib/api/school-messaging-contract';
import type { StudentDetailDto } from '../lib/api/school-students-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TEACHER_ME,
  TODAY,
  assignment,
  calls,
  errorBody,
  mockSchoolApi,
  open,
  page1,
  TABLET,
  expectNoSidewaysScroll,
  type Handler,
} from './support/wave-e';

// The section diary and student remarks (contracts/slice-13.md §4, §5, §11) against a mocked
// API: day and week views, the entry form with a staged attachment and its Idempotency-Key, the
// edit window, the refusals; the remarks tab with corrections that supersede.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const entry = (id: string, subjectId: string, subjectName: string, extra: Partial<DiaryEntryDto> = {}): DiaryEntryDto => ({
  id,
  sectionId: 'sec-a',
  classId: 'c5',
  academicYearId: 'y1',
  date: TODAY,
  subjectId,
  subjectName,
  authorStaffId: 'st-t',
  authorName: 'Ayesha Malik',
  topic: 'Fractions: adding unlike denominators',
  assignment: 'Exercise 4.2, questions 1 to 10',
  learningOutcome: null,
  dueOn: '2026-10-08',
  hasAttachment: false,
  attachmentMime: null,
  attachmentSizeBytes: null,
  editWindowEndsOn: '2026-10-09',
  createdAt: '2026-10-06T04:00:00.000Z',
  updatedAt: '2026-10-06T04:00:00.000Z',
  ...extra,
});
const MATHS = entry('d1', 'sub-m', 'Mathematics', {
  hasAttachment: true,
  attachmentMime: 'image/jpeg',
  attachmentSizeBytes: 182_000,
  updatedAt: '2026-10-06T04:20:00.000Z',
});
const ENGLISH = entry('d2', 'sub-e', 'English', {
  topic: 'Reading: The Selfish Giant',
  assignment: null,
  dueOn: null,
  authorStaffId: 'st-x',
  authorName: 'Imran Ali',
  hasAttachment: true,
  attachmentMime: 'application/pdf',
  attachmentSizeBytes: 90_000,
});
const OLD = entry('d3', 'sub-u', 'Urdu', { date: '2026-09-28', topic: 'Old poem', editWindowEndsOn: '2026-10-01' });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function diaryHandler(entries: DiaryEntryDto[]): Handler {
  return ({ method, path }) => {
    if (method === 'GET' && path === '/sections/sec-a/diary-entries') return { status: 200, body: page1(entries) };
    const one = path.match(/^\/diary-entries\/([^/]+)$/);
    const found = one && entries.find((e) => e.id === one[1]);
    if (found && method === 'GET') return { status: 200, body: found };
    if (found && method === 'PATCH') return { status: 200, body: found };
    if (method === 'POST' && path === '/uploads') {
      return { status: 201, body: { id: 'up1', mime: 'image/png', sizeBytes: PNG.length, expiresAt: STAMP } };
    }
    if (method === 'POST' && path === '/sections/sec-a/diary-entries') return { status: 201, body: entry('d9', 'sub-u', 'Urdu') };
    return undefined;
  };
}

test('teacher: diary home → section; day view grouped with edited badge, picture on tap, download; week view range', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, { me: TEACHER_ME, handler: diaryHandler([MATHS, ENGLISH]) });
  await page.route('**/api/v1/diary-entries/d1/thumbnail', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/v1/diary-entries/d2/attachment', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="diary-d2.pdf"' },
      body: Buffer.from('%PDF-1.4\n'),
    }),
  );
  await open(page, '/diary');
  await page.getByRole('link', { name: 'Class 5 A' }).click();
  await expect(page.getByRole('heading', { name: 'Class 5 A diary' })).toBeVisible();
  const q = new URL(calls(requests, 'GET', '/sections/sec-a/diary-entries')[0].url()).searchParams;
  expect([q.get('dateFrom'), q.get('dateTo'), q.get('limit')]).toEqual([TODAY, TODAY, '50']);

  const maths = page.getByTestId('diary-entry-d1');
  await expect(page.getByRole('region', { name: '6 Oct 2026' }).locator('[data-testid^="diary-entry-"]')).toHaveCount(2);
  // Ordered by subject inside the day.
  await expect(page.locator('[data-testid^="diary-entry-"]').first()).toContainText('English');
  await expect(maths.getByText('Edited')).toBeVisible();
  await expect(maths).toContainText('Due 8 Oct 2026');
  // Thumbnails load only when asked for.
  await expect(maths.getByRole('img')).toHaveCount(0);
  await maths.getByRole('button', { name: 'Show picture' }).click();
  await expect(maths.getByRole('img', { name: 'Attachment to the Mathematics entry' })).toHaveAttribute('src', '/api/v1/diary-entries/d1/thumbnail');
  // A PDF has no picture, only a download.
  const english = page.getByTestId('diary-entry-d2');
  await expect(english.getByRole('button', { name: 'Show picture' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await english.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('diary-d2.pdf');

  await page.getByRole('tab', { name: 'week' }).click();
  await expect
    .poll(() =>
      calls(requests, 'GET', '/sections/sec-a/diary-entries').some((r) => {
        const p = new URL(r.url()).searchParams;
        return p.get('dateFrom') === '2026-10-05' && p.get('dateTo') === '2026-10-11';
      }),
    )
    .toBe(true);
  expect(unmocked).toEqual([]);
});

test('new entry: staged attachment, Idempotency-Key, the whole body', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: TEACHER_ME, handler: diaryHandler([]) });
  await open(page, '/sections/sec-a/diary');
  await expect(page.getByText('Nothing written for 6 Oct 2026')).toBeVisible();
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New diary entry' });
  await expect(dialog.getByLabel('Date')).toHaveValue(TODAY);
  // A class teacher writes any subject.
  await expect(dialog.getByLabel('Subject').locator('option')).toHaveCount(4);
  await dialog.getByLabel('Subject').selectOption('sub-u');
  await dialog.getByLabel('Topic').fill('Nazm: Lab pe aati hai dua');
  await dialog.getByLabel('Homework (optional)').fill('Learn the first two verses');
  await dialog.getByLabel('Due on (optional)').fill('2026-10-07');
  await dialog.getByLabel('Attachment (optional)').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: PNG });
  await expect(dialog.getByTestId('diary-attachment')).toContainText('board.png');
  await dialog.getByRole('button', { name: 'Write entry' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Entry written.')).toBeVisible();
  const post = calls(requests, 'POST', '/sections/sec-a/diary-entries')[0];
  expect(post.headers()['idempotency-key']).toMatch(KEY);
  expect(post.postDataJSON()).toEqual({
    date: TODAY,
    subjectId: 'sub-u',
    topic: 'Nazm: Lab pe aati hai dua',
    assignment: 'Learn the first two verses',
    dueOn: '2026-10-07',
    stagedUploadId: 'up1',
  });
});

test('create refusals: already written (opens it), subject not assigned, not assigned on the date, key reused', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: diaryHandler([MATHS]),
    replies: {
      'POST /sections/sec-a/diary-entries': [
        { status: 409, body: errorBody('SUBJECT_NOT_ASSIGNED', 'Not assigned.') },
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.', { reason: 'not_assigned_on_date' }) },
        { status: 409, body: errorBody('IDEMPOTENCY_KEY_REUSED', 'Reused.') },
        { status: 409, body: errorBody('DIARY_ENTRY_EXISTS', 'Exists.', { entryId: 'd1' }) },
      ],
    },
  });
  await open(page, '/sections/sec-a/diary');
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New diary entry' });
  await dialog.getByLabel('Subject').selectOption('sub-m');
  await dialog.getByLabel('Topic').fill('Fractions');
  const write = dialog.getByRole('button', { name: 'Write entry' });
  await write.click();
  await expect(dialog.getByText('You do not teach this subject in this section on that date.')).toBeVisible();
  await write.click();
  await expect(dialog.getByText('You were not assigned to this section on that date.')).toBeVisible();
  await write.click();
  await expect(dialog.getByText('This form was already used for a different entry.', { exact: false })).toBeVisible();
  await write.click();
  await expect(dialog.getByText('Already written for this date and subject.')).toBeVisible();
  const keys = calls(requests, 'POST', '/sections/sec-a/diary-entries').map((r) => r.headers()['idempotency-key']);
  // Refused creates keep the key; a reused key is replaced.
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).toBe(keys[1]);
  expect(keys[3]).not.toBe(keys[2]);
  await dialog.getByRole('button', { name: 'Open the existing entry' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Mathematics, 6 Oct 2026' })).toBeVisible();
});

test('a subject teacher is offered only their own subjects', async ({ page }) => {
  const me = {
    ...TEACHER_ME,
    assignments: [assignment({ id: 'ta2', role: 'subject_teacher', subjectId: 'sub-e', subjectName: 'English' })],
  };
  await mockSchoolApi(page, { me, handler: diaryHandler([]) });
  await open(page, '/sections/sec-a/diary');
  await page.getByRole('button', { name: 'New entry' }).click();
  const options = page.getByRole('dialog').getByLabel('Subject').locator('option');
  await expect(options).toHaveText(['Choose…', 'English']);
});

test('edit window: the author edits inside it without a reason; after it the author is locked; another teacher sees no control', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: TEACHER_ME, handler: diaryHandler([MATHS, ENGLISH, OLD]) });
  await open(page, '/sections/sec-a/diary');
  await page.getByRole('tab', { name: 'week' }).click();
  await expect(page.getByTestId('diary-entry-d2').getByRole('button', { name: /Edit/ })).toHaveCount(0);
  await expect(page.getByTestId('diary-entry-d3').getByTestId('edit-locked')).toHaveText(
    'The edit window closed on 1 Oct 2026; ask the principal.',
  );
  await page.getByRole('button', { name: 'Edit Mathematics entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Mathematics, 6 Oct 2026' });
  await expect(dialog.getByLabel(/Reason/)).toHaveCount(0);
  await dialog.getByLabel('Topic').fill('Fractions: like and unlike denominators');
  await dialog.getByRole('button', { name: 'Remove the attachment' }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'PATCH', '/diary-entries/d1')[0].postDataJSON()).toEqual({
    topic: 'Fractions: like and unlike denominators',
    stagedUploadId: null,
  });
});

test('principal after the window must give a reason; DIARY_ENTRY_LOCKED and not_author are explained', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: diaryHandler([MATHS, ENGLISH, OLD]),
    replies: {
      'PATCH /diary-entries/d3': [
        { status: 409, body: errorBody('DIARY_ENTRY_LOCKED', 'Locked.') },
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.', { reason: 'not_author' }) },
      ],
    },
  });
  await open(page, '/sections/sec-a/diary');
  await page.getByRole('tab', { name: 'week' }).click();
  await page.getByRole('button', { name: 'Edit Urdu entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Urdu, 28 Sept 2026' });
  await dialog.getByLabel('Topic').fill('Old poem, corrected');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('The edit window has closed: give a reason of at least 3 characters.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/diary-entries/d3')).toHaveLength(0);
  await dialog.getByLabel('Reason for the change').fill('Wrong poem named');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('The edit window closed on 1 Oct 2026; ask the principal.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Only the teacher who wrote this entry, or the principal, can change it.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/diary-entries/d3')[0].postDataJSON()).toEqual({
    topic: 'Old poem, corrected',
    reason: 'Wrong poem named',
  });
});

test('a principal also assigned to the section edits any entry, as the server allows; the form asks for the reason the card implies', async ({ page }) => {
  const me = {
    ...PRINCIPAL_ME,
    assignments: [assignment({ id: 'ta3', role: 'subject_teacher', subjectId: 'sub-e', subjectName: 'English' })],
  };
  const { requests } = await mockSchoolApi(page, { me, handler: diaryHandler([MATHS, ENGLISH, OLD]) });
  await open(page, '/sections/sec-a/diary');
  await page.getByRole('tab', { name: 'week' }).click();
  // Someone else's entries, inside and after the window: editable, never locked or hidden.
  await expect(page.getByTestId('edit-locked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit .* entry$/ })).toHaveCount(3);

  await page.getByRole('button', { name: 'Edit Mathematics entry' }).click();
  const inside = page.getByRole('dialog', { name: 'Edit Mathematics, 6 Oct 2026' });
  await expect(inside.getByLabel('Reason (optional)')).toBeVisible();
  await inside.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Edit Urdu entry' }).click();
  const after = page.getByRole('dialog', { name: 'Edit Urdu, 28 Sept 2026' });
  await after.getByLabel('Topic').fill('Old poem, corrected');
  await after.getByRole('button', { name: 'Save changes' }).click();
  await expect(after.getByText('The edit window has closed: give a reason of at least 3 characters.')).toBeVisible();
  await after.getByLabel('Reason for the change').fill('Wrong poem named');
  await after.getByRole('button', { name: 'Save changes' }).click();
  await expect(after).toBeHidden();
  expect(calls(requests, 'PATCH', '/diary-entries/d3')[0].postDataJSON()).toEqual({
    topic: 'Old poem, corrected',
    reason: 'Wrong poem named',
  });
});

test('office staff have no diary entry and are refused a section diary', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: ({ path }) =>
      path === '/sections/sec-a/diary-entries' ? { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.') } : undefined,
  });
  await open(page, '/sections/sec-a/diary');
  await expect(page.getByRole('navigation').first().getByRole('link', { name: 'Diary' })).toHaveCount(0);
  await expect(page.getByText('The diary is kept by the section’s teachers and the principal.')).toBeVisible();
});

// ---- Remarks ----

const STUDENT: StudentDetailDto = {
  id: 's1',
  admissionNo: '1001',
  fullName: 'Ali Khan',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2025-04-01',
  current: {
    enrolmentId: 'e1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 1,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: null,
  photoDocumentId: null,
};
const remark = (id: string, text: string, extra: Partial<RemarkDto> = {}): RemarkDto => ({
  id,
  studentId: 's1',
  enrolmentId: 'e1',
  date: '2026-10-05',
  category: 'behaviour',
  text,
  visibility: 'guardian',
  subjectId: null,
  subjectName: null,
  authorStaffId: 'st-t',
  authorName: 'Ayesha Malik',
  supersedesId: null,
  supersededAt: null,
  supersededById: null,
  correctionReason: null,
  createdAt: STAMP,
  ...extra,
});
const CORRECTION = remark('rm2', 'Helped a classmate tidy the room.', { supersedesId: 'rm1', correctionReason: 'Wrong child named' });
const ORIGINAL = remark('rm1', 'Pushed a classmate in the queue.', { supersededAt: STAMP, supersededById: 'rm2' });
const OTHERS = remark('rm3', 'Excellent reading today.', { category: 'academic', authorStaffId: 'st-x', authorName: 'Imran Ali', date: '2026-10-02' });
const SETTINGS = { remarkDefaultVisibility: 'guardian', remarkNotifyGuardians: false } as Partial<SchoolSettingsDto>;

function remarksHandler(): Handler {
  return ({ method, path, url }) => {
    if (path === '/students/s1') return { status: 200, body: STUDENT };
    if (path === '/school/settings') return { status: 200, body: SETTINGS };
    if (method === 'GET' && path === '/students/s1/remarks') {
      const all = url.searchParams.get('includeSuperseded') === 'true';
      return { status: 200, body: page1(all ? [CORRECTION, OTHERS, ORIGINAL] : [CORRECTION, OTHERS]) };
    }
    if (method === 'POST' && path === '/students/s1/remarks') return { status: 201, body: remark('rm9', 'New') };
    return undefined;
  };
}

test('remarks: the correction carries its reason; "show corrected" lists the original struck through under it', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, { me: TEACHER_ME, handler: remarksHandler() });
  await open(page, '/students/s1');
  await page.getByRole('tab', { name: 'Remarks' }).click();
  await expect(page.getByTestId('correction-reason')).toHaveText('Correction: Wrong child named');
  await expect(page.getByText('Pushed a classmate in the queue.')).toHaveCount(0);
  await page.getByLabel('Show corrected').check();
  const rows = page.getByRole('row');
  // Header, the correction, its original right under it, then the other remark.
  await expect(rows.nth(2)).toContainText('Pushed a classmate in the queue.');
  await expect(rows.nth(2).locator('s').first()).toBeVisible();
  await expect(rows.nth(3)).toContainText('Excellent reading today.');
  expect(new URL(calls(requests, 'GET', '/students/s1/remarks').at(-1)!.url()).searchParams.get('includeSuperseded')).toBe('true');
  // The teacher is assigned to Ali's section: they correct their own remark, not a colleague's.
  await expect(page.getByRole('button', { name: 'Actions for the remark of 5 Oct 2026' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Actions for the remark of 2 Oct 2026' })).toHaveCount(0);
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  expect(unmocked).toEqual([]);
});

test('new remark: Idempotency-Key, the school default visibility; a date outside the assignment is refused on the date', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: remarksHandler(),
    replies: {
      'POST /students/s1/remarks': [
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.', { reason: 'not_assigned_on_date' }) },
      ],
    },
  });
  await open(page, '/students/s1');
  await page.getByRole('tab', { name: 'Remarks' }).click();
  await page.getByRole('button', { name: 'New remark' }).click();
  const dialog = page.getByRole('dialog', { name: 'New remark' });
  // A teacher cannot read the settings: the server applies the school's default.
  await expect(dialog.getByLabel('Seen by')).toHaveValue('');
  await dialog.getByLabel('Category').selectOption('homework');
  await dialog.getByLabel('Remark').fill('Homework missing three days running.');
  await dialog.getByLabel('Date').fill('2026-03-01');
  await dialog.getByRole('button', { name: 'Save remark' }).click();
  await expect(dialog.getByText('You were not assigned to this section on that date.')).toBeVisible();
  await dialog.getByLabel('Date').fill(TODAY);
  await dialog.getByRole('button', { name: 'Save remark' }).click();
  await expect(dialog).toBeHidden();
  const posts = calls(requests, 'POST', '/students/s1/remarks');
  expect(posts[1].headers()['idempotency-key']).toMatch(KEY);
  expect(posts[1].headers()['idempotency-key']).toBe(posts[0].headers()['idempotency-key']);
  expect(posts[1].postDataJSON()).toEqual({ date: TODAY, category: 'homework', text: 'Homework missing three days running.' });
});

test('principal sees the school default named; correcting writes a new row; REMARK_SUPERSEDED reloads', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: remarksHandler(),
    replies: {
      'POST /remarks/rm3/correct': [{ status: 409, body: errorBody('REMARK_SUPERSEDED', 'Superseded.', { supersededById: 'rm7' }) }],
      'POST /remarks/rm2/correct': [{ status: 201, body: remark('rm8', 'Helped tidy the room after lunch.') }],
    },
  });
  await open(page, '/students/s1');
  await page.getByRole('tab', { name: 'Remarks' }).click();
  await page.getByRole('button', { name: 'New remark' }).click();
  await expect(page.getByRole('dialog').getByLabel('Seen by').locator('option').first()).toHaveText('School default (Guardians)');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Actions for the remark of 5 Oct 2026' }).click();
  await page.getByRole('menuitem', { name: 'Correct' }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct this remark' });
  await dialog.getByLabel('Corrected remark').fill('Helped tidy the room after lunch.');
  await dialog.getByLabel('Seen by').selectOption('student');
  await dialog.getByLabel('Reason').fill('Detail added');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/remarks/rm2/correct')[0].postDataJSON()).toEqual({
    text: 'Helped tidy the room after lunch.',
    reason: 'Detail added',
    visibility: 'student',
  });

  await page.getByRole('button', { name: 'Actions for the remark of 2 Oct 2026' }).click();
  await page.getByRole('menuitem', { name: 'Correct' }).click();
  const second = page.getByRole('dialog', { name: 'Correct this remark' });
  await second.getByLabel('Corrected remark').fill('Excellent reading and spelling today.');
  await second.getByLabel('Reason').fill('More detail');
  await second.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('This remark was already corrected. The list now shows the correction.')).toBeVisible();
  await expect(second).toBeHidden();
});
