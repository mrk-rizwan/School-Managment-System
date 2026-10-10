import { ApiError, ErrorCode } from '@asms/shared';
import { expect as baseExpect, test } from '@playwright/test';
import {
  cellProblems,
  draftFromSlots,
  serverProblems,
  slotsFromDraft,
  type OtherCell,
} from '../app/(school)/timetable/_lib/timetable-draft';
import { PRINCIPAL_ME, TEACHER_ME, calls, errorBody, mockSchoolApi, open, page1, type Handler } from './support/wave-e';
import {
  TT_FUTURE_VERSION,
  TT_SLOTS,
  TT_STAFF,
  TT_SUBJECTS,
  TT_SUBSTITUTION,
  TT_VERSION,
  ttGrid,
  ttWeek,
} from './support/timetable';

// Phase 5 slice 37 (contracts/slice-37.md §7): the section week, the week-grid editor (prefill
// from the live version, clashes highlighted live from the shared timetableClashes against the
// other sections' grid, a successful save with an Idempotency-Key, a server 409 on its cell) and
// voiding a future version. The first tests exercise the editor's pure draft helpers directly.

const expect = baseExpect.configure({ timeout: 15_000 });

// ---- the draft helpers, without a browser ----

const OTHERS: OtherCell[] = [
  { id: 'slot-b1', sectionId: 'sec-b', weekday: 1, period: 2, staffId: 'st-2', room: 'Room 7', label: 'Class 5 B' },
];
const CTX = { periodsPerDay: 4, weeklyOffDays: [0], others: OTHERS };

test('draft: slots come out Monday first then by period, blank rooms as null, half-filled cells left out', () => {
  const draft = {
    '0:1': { classSubjectId: 'cs-m', staffId: 'st-t', room: '' },
    '2:1': { classSubjectId: 'cs-e', staffId: 'st-2', room: '  ' },
    '1:3': { classSubjectId: 'cs-m', staffId: 'st-t', room: ' Lab 1 ' },
    '1:2': { classSubjectId: 'cs-m', staffId: '', room: '' },
  };
  const { slots, keys } = slotsFromDraft(draft);
  expect(keys).toEqual(['1:3', '2:1', '0:1']);
  expect(slots[0]).toEqual({ weekday: 1, period: 3, classSubjectId: 'cs-m', staffId: 'st-t', room: 'Lab 1' });
  expect(slots[1]!.room).toBeNull();
  expect(slotsFromDraft(draftFromSlots(TT_SLOTS)).slots).toHaveLength(2);
});

test('draft: problems name the half-filled cell, the off day, and a teacher or room clash with another section', () => {
  const problems = cellProblems(
    {
      '1:1': { classSubjectId: 'cs-m', staffId: '', room: '' },
      '0:1': { classSubjectId: 'cs-m', staffId: 'st-t', room: '' },
      '1:2': { classSubjectId: 'cs-m', staffId: 'st-2', room: '' },
      '1:3': { classSubjectId: 'cs-m', staffId: 'st-t', room: 'Lab 1' },
    },
    CTX,
  );
  expect(problems['1:1']).toEqual(['Choose both a subject and a teacher.']);
  expect(problems['0:1']).toEqual(['This is a weekly-off day.']);
  expect(problems['1:2']).toEqual(['The teacher is already timetabled in Class 5 B in this period.']);
  expect(problems['1:3']).toBeUndefined();
  // The room is compared trimmed and lower-cased, as the database does.
  const room = cellProblems({ '1:2': { classSubjectId: 'cs-m', staffId: 'st-t', room: ' room 7' } }, CTX);
  expect(room['1:2']).toEqual(['The room is already booked by Class 5 B in this period.']);
});

test('draft: a server refusal lands on the cells it names', () => {
  const submitted = slotsFromDraft({
    '1:1': { classSubjectId: 'cs-m', staffId: 'st-t', room: '' },
    '1:2': { classSubjectId: 'cs-e', staffId: 'st-2', room: '' },
    '2:1': { classSubjectId: 'cs-m', staffId: 'st-t', room: '' },
  });
  const clash = new ApiError(409, ErrorCode.TIMETABLE_SLOT_CLASH, 'Clash.', { kind: 'teacher', weekday: 1, period: 2, index: 1 }, null);
  expect(serverProblems(clash, submitted)).toEqual({ '1:2': ['The teacher is already timetabled elsewhere in this period.'] });
  const unassigned = new ApiError(
    409,
    ErrorCode.TIMETABLE_TEACHER_NOT_ASSIGNED,
    'No.',
    { staffId: 'st-t', classSubjectId: 'cs-m', sectionId: 'sec-a' },
    null,
  );
  expect(Object.keys(serverProblems(unassigned, submitted) ?? {})).toEqual(['1:1', '2:1']);
  const field = new ApiError(422, ErrorCode.VALIDATION_FAILED, 'Invalid.', {
    fields: [{ path: 'slots[2].staffId', code: 'REFERENCE_NOT_FOUND', message: 'No active staff member with that id' }],
  }, null);
  expect(serverProblems(field, submitted)).toEqual({ '2:1': ['Not an active member of staff.'] });
  const other = new ApiError(409, ErrorCode.TIMETABLE_VERSION_SUPERSEDED, 'Later.', { versionId: 'tv2' }, null);
  expect(serverProblems(other, submitted)).toBeNull();
});

// ---- the screens ----

const handler: Handler = ({ method, path, url }) => {
  if (method !== 'GET') return undefined;
  if (path === '/sections/sec-a/timetable') return { status: 200, body: ttWeek() };
  if (path === '/timetable-versions/tv1') return { status: 200, body: TT_VERSION };
  if (path === '/classes/c5/subjects') return { status: 200, body: page1(TT_SUBJECTS) };
  if (path === '/staff') return { status: 200, body: page1(TT_STAFF) };
  if (path === '/timetable/grid') {
    return {
      status: 200,
      body: ttGrid(url.searchParams.get('date') ?? '', Number(url.searchParams.get('weekday'))),
    };
  }
  if (path === '/timetable-versions') return { status: 200, body: page1([TT_FUTURE_VERSION, TT_VERSION]) };
  return undefined;
};

test('the week shows each day’s lessons, the substitute, a lesson without an assigned teacher, and Edit for the principal', async ({
  page,
}) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler });
  await open(page, '/timetable?section=sec-a');
  const monday = page.getByTestId('week.cell.1.1');
  await expect(monday).toContainText('Mathematics');
  await expect(monday).toContainText('Substitute: Imran Ali');
  await expect(monday).toContainText('Room Lab 1');
  await expect(page.getByTestId('week.cell.2.1')).toContainText('No assigned teacher');
  await expect(page.getByText('No school on Sunday.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/timetable/sections/sec-a/edit');
  await expect(page.getByRole('navigation', { name: 'Timetable' }).getByRole('link', { name: 'Versions' })).toBeVisible();
});

test('a teacher reads the week of their own section, without Edit or the management tabs', async ({ page }) => {
  await mockSchoolApi(page, { me: TEACHER_ME, handler });
  await open(page, '/timetable');
  await expect(page.getByTestId('week.cell.1.1')).toContainText('Mathematics');
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Timetable' })).toHaveCount(0);
});

test('the editor prefills the live version, highlights a clash with another section, and saves a new version', async ({
  page,
}) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'POST /sections/sec-a/timetable-versions': { status: 201, body: { ...TT_VERSION, id: 'tv3', effectiveFrom: '2026-10-06' } } },
  });
  await open(page, '/timetable/sections/sec-a/edit');
  await expect(page.getByRole('heading', { name: 'Edit timetable · Class 5 A' })).toBeVisible();
  await expect(page.getByLabel('Subject, Monday period 1')).toHaveValue('cs-m');
  await expect(page.getByLabel('Room, Monday period 1')).toHaveValue('Lab 1');
  await expect(page.getByLabel('Teacher, Tuesday period 1')).toHaveValue('st-2');
  // The live version began before today, so the new one can start today (wave R review).
  await expect(page.getByLabel('Starts on')).toHaveValue('2026-10-06');
  // Sunday is a weekly-off day: no column.
  await expect(page.getByLabel('Subject, Sunday period 1')).toHaveCount(0);

  const cell = page.getByTestId('editor.cell.1.2');
  await page.getByLabel('Subject, Monday period 2').selectOption('cs-e');
  await expect(cell).toContainText('Choose both a subject and a teacher.');
  await page.getByLabel('Teacher, Monday period 2').selectOption('st-2');
  await expect(cell).toHaveAttribute('data-problem', 'true');
  await expect(cell).toContainText('The teacher is already timetabled in Class 5 B in this period.');
  const save = page.getByRole('button', { name: 'Save timetable' });
  await expect(save).toBeDisabled();
  await expect(page.getByText('1 period needs attention.')).toBeVisible();

  await page.getByLabel('Teacher, Monday period 2').selectOption('st-t');
  await page.getByLabel('Room, Monday period 2').fill('ROOM 7');
  await expect(cell).toContainText('The room is already booked by Class 5 B in this period.');
  await page.getByLabel('Room, Monday period 2').fill('');
  await expect(cell).not.toHaveAttribute('data-problem', 'true');
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page).toHaveURL(/\/timetable\?section=sec-a$/);
  const post = calls(requests, 'POST', '/sections/sec-a/timetable-versions')[0]!;
  expect(post.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(post.postDataJSON()).toEqual({
    effectiveFrom: '2026-10-06',
    slots: [
      { weekday: 1, period: 1, classSubjectId: 'cs-m', staffId: 'st-t', room: 'Lab 1' },
      { weekday: 1, period: 2, classSubjectId: 'cs-e', staffId: 'st-t', room: null },
      { weekday: 2, period: 1, classSubjectId: 'cs-e', staffId: 'st-2', room: null },
    ],
  });
});

test('a clash the server finds is shown on its cell, and the save can be retried with a new key', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: {
      'POST /sections/sec-a/timetable-versions': {
        status: 409,
        body: errorBody('TIMETABLE_SLOT_CLASH', 'The room is already booked in that period.', {
          kind: 'room',
          weekday: 1,
          period: 1,
          index: 0,
          conflictingSlotId: 'slot-x',
        }),
      },
    },
  });
  await open(page, '/timetable/sections/sec-a/edit');
  await page.getByRole('button', { name: 'Save timetable' }).click();
  const cell = page.getByTestId('editor.cell.1.1');
  await expect(cell).toHaveAttribute('data-problem', 'true');
  await expect(cell).toContainText('The room is already booked in this period.');
  await expect(page.getByTestId('editor.refusal')).toHaveText('A room would be booked twice in the same period.');
  await expect(page).toHaveURL(/\/edit$/);

  // Changing the room clears the server's mark; the retry carries a different key.
  await page.getByLabel('Room, Monday period 1').fill('Lab 2');
  await expect(cell).not.toHaveAttribute('data-problem', 'true');
  await page.getByRole('button', { name: 'Save timetable' }).click();
  await expect.poll(() => calls(requests, 'POST', '/sections/sec-a/timetable-versions').length).toBe(2);
  const [first, second] = calls(requests, 'POST', '/sections/sec-a/timetable-versions');
  expect(second!.headers()['idempotency-key']).not.toBe(first!.headers()['idempotency-key']);
});

test('substitutions booked on the affected dates are named as the reason a save is refused', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: {
      'POST /sections/sec-a/timetable-versions': {
        status: 409,
        body: errorBody('TIMETABLE_SUBSTITUTIONS_EXIST', 'Void them first.', { substitutionIds: ['sub1', 'sub2'] }),
      },
    },
  });
  await open(page, '/timetable/sections/sec-a/edit');
  await page.getByRole('button', { name: 'Save timetable' }).click();
  await expect(page.getByTestId('editor.refusal')).toHaveText(
    '2 substitutions are booked on the dates this change affects. Void them first under Substitutions.',
  );
});

test('a version starting today can be voided the same day', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      call.method === 'GET' && call.path === '/timetable-versions'
        ? { status: 200, body: page1([{ ...TT_VERSION, id: 'tv5', effectiveFrom: '2026-10-06' }, TT_VERSION]) }
        : handler(call),
  });
  await open(page, '/timetable/versions');
  await expect(page.getByRole('button', { name: /^Actions for timetable/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Actions for timetable of Class 5 A from 2026-10-06' })).toBeVisible();
});

test('a version that has not started yet is voided with a reason', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'POST /timetable-versions/tv2/void': { status: 200, body: { ...TT_FUTURE_VERSION, status: 'voided' } } },
  });
  await open(page, '/timetable/versions');
  await expect(page.getByRole('table').getByText('Starts later')).toBeVisible();
  // Only the future version has actions.
  await expect(page.getByRole('button', { name: /^Actions for timetable/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Actions for timetable of Class 5 A from 2026-11-01' }).click();
  await page.getByRole('menuitem', { name: 'Void' }).click();
  const dialog = page.getByRole('dialog', { name: 'Void this timetable?' });
  await dialog.getByLabel('Reason').fill('Entered by mistake');
  await dialog.getByRole('button', { name: 'Void timetable' }).click();
  await expect(page.getByText('is voided.')).toBeVisible();
  expect(calls(requests, 'POST', '/timetable-versions/tv2/void')[0]!.postDataJSON()).toEqual({ reason: 'Entered by mistake' });
});

test('a substitution is added for a timetabled period, with an Idempotency-Key', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      call.method === 'GET' && call.path === '/timetable-substitutions'
        ? { status: 200, body: page1([]) }
        : handler(call),
    replies: { 'POST /sections/sec-a/timetable-substitutions': { status: 201, body: TT_SUBSTITUTION } },
  });
  await open(page, '/timetable/substitutions');
  await expect(page.getByText('No substitutions')).toBeVisible();
  await page.getByRole('button', { name: 'Add substitution' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add substitution' });
  await dialog.getByLabel('Section').selectOption('sec-a');
  await dialog.getByLabel('Date').fill('2026-10-05');
  // The periods offered are the lessons timetabled that day.
  await dialog.getByLabel('Period').selectOption({ label: 'Period 1 · Mathematics (Ayesha Malik)' });
  await dialog.getByLabel('Substitute').selectOption('st-2');
  await dialog.getByLabel('Reason').fill('Ayesha is at a training day');
  await dialog.getByRole('button', { name: 'Add substitution' }).click();
  await expect(page.getByText('Imran Ali substitutes in Class 5 A, period 1.')).toBeVisible();
  const post = calls(requests, 'POST', '/sections/sec-a/timetable-substitutions')[0]!;
  expect(post.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(post.postDataJSON()).toEqual({ date: '2026-10-05', period: 1, staffId: 'st-2', reason: 'Ayesha is at a training day' });
});
