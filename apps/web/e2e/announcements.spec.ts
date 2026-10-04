import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { AudienceInput } from '@asms/shared';
import type {
  AnnouncementDto,
  AudiencePreviewDto,
  DeliverySummaryDto,
  InboxItemDto,
  PreviewAudienceBody,
} from '../lib/api/school-announcements-contract';
import type { GuardianLinkDto, StudentDto } from '../lib/api/school-students-contract';
import type { StaffDto } from '../lib/api/school-staff-contract';
import {
  NOW,
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Handler,
  type Reply,
} from './support/wave-e';

// Announcements, the audience picker and the inbox (contracts/slice-14.md §5, §7, §12) against a
// mocked API: the list and its filters, compose with the debounced preview and the
// Idempotency-Key, the send and schedule confirms, cancel with a reason, the delivery summary
// (never the word "read"), the inbox; every refusal code of §9, and each screen's loading, empty,
// error and no-permission states.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const DESKTOP = { width: 1280, height: 900 };

const announcement = (id: string, extra: Partial<AnnouncementDto> = {}): AnnouncementDto => ({
  id,
  title: 'School closed tomorrow',
  body: 'Due to heavy rain the school will remain closed on Wednesday.',
  category: 'general',
  priority: 'normal',
  messageType: 'announcement_normal',
  status: 'draft',
  audiences: [{ kind: 'everyone', targetId: null, targetName: null, roles: [] }],
  scheduledAt: null,
  expiresOn: null,
  hasAttachment: false,
  attachmentMime: null,
  attachmentSizeBytes: null,
  holidayId: null,
  createdBy: 'u-principal',
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  updatedAt: STAMP,
  sentAt: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  recipientCount: 0,
  sendFailedAt: null,
  smsSegments: null,
  ...extra,
});
const SENT = announcement('a1', {
  status: 'sent',
  priority: 'urgent',
  messageType: 'announcement_urgent',
  sentAt: '2026-10-05T04:00:00.000Z',
  recipientCount: 412,
  smsSegments: 1,
  hasAttachment: true,
  attachmentMime: 'image/png',
  attachmentSizeBytes: 120_000,
});
const DRAFT = announcement('a2', {
  title: 'Class 5 trip forms',
  category: 'event',
  audiences: [
    { kind: 'section', targetId: 'sec-a', targetName: 'Class 5 A', roles: ['parents'] },
    { kind: 'student', targetId: 'st-s1', targetName: 'Ali Khan', roles: [] },
  ],
  expiresOn: '2026-10-20',
});
const SCHEDULED = announcement('a3', { status: 'scheduled', scheduledAt: '2026-10-07T04:00:00.000Z', title: 'Exam timetable' });
const CANCELLED = announcement('a4', {
  status: 'cancelled',
  cancelledAt: STAMP,
  cancelledBy: 'u-principal',
  cancelReason: 'Wrong date',
  title: 'Old notice',
});

const preview = (body: PreviewAudienceBody, extra: Partial<AudiencePreviewDto> = {}): AudiencePreviewDto => {
  const byAudience = body.audiences.map((a) => ({
    kind: a.kind,
    targetId: a.targetId ?? null,
    targetName: a.targetId ? `Name of ${a.targetId}` : null,
    persons: a.kind === 'everyone' ? 412 : 40,
  }));
  const total = byAudience.reduce((n, a) => n + a.persons, 0);
  const allowed = body.priority === 'urgent';
  return {
    recipients: { total, guardians: total - 30, staff: 20, students: 10 },
    byAudience,
    sms: { allowed, legs: allowed ? 150 : 0, segments: 1, units: allowed ? 150 : 0, remaining: 480, cap: 500 },
    warnings: [],
    computedAt: STAMP,
    ...extra,
  };
};

const DELIVERY: DeliverySummaryDto = {
  announcementId: 'a1',
  status: 'sent',
  recipients: { total: 412, guardians: 380, staff: 22, students: 10 },
  messages: { queued: 5, sending: 2, sent: 100, delivered: 290, failed: 6, suppressed: 9 },
  byChannel: [
    { channel: 'push', accepted: 30, delivered: 25, failed: 0, suppressed: 0 },
    { channel: 'whatsapp', accepted: 300, delivered: 280, failed: 4, suppressed: 3 },
    { channel: 'sms', accepted: 150, delivered: 140, failed: 2, suppressed: 6 },
    { channel: 'email', accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
  ],
  suppressions: [
    { reason: 'duplicate_phone', count: 5 },
    { reason: 'no_channel', count: 3 },
    { reason: 'cap_reached', count: 1 },
  ],
  smsSegmentsPerMessage: 1,
  smsUnitsReserved: 150,
  computedAt: STAMP,
};

const STUDENT: StudentDto = {
  id: 'st-s1',
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
};
const LINK = (id: string, guardianId: string, name: string, endedAt: string | null = null): GuardianLinkDto => ({
  id,
  studentId: 'st-s1',
  guardianId,
  guardianFullName: name,
  relationship: 'father',
  isPrimaryContact: true,
  isFeePayer: true,
  canLogin: true,
  phone: '+923001234567',
  endedAt,
  contactCapability: 'whatsapp',
  guardianCnicMasked: '35201-*****-1',
  guardianAddress: 'House 12, Lahore',
  guardianUserId: null,
});
const STAFF_MEMBER: StaffDto = {
  id: 'st-x',
  fullName: 'Imran Ali',
  cnicMasked: null,
  hasCnic: false,
  phone: '+923001112223',
  designation: 'Science teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: null,
  systemRoles: ['teacher'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
};

const INBOX: InboxItemDto[] = [
  {
    id: 'm1',
    kind: 'announcement',
    messageType: 'announcement_urgent',
    subjectType: 'announcement',
    subjectId: 'a1',
    title: 'School closed tomorrow',
    body: 'Due to heavy rain the school will remain closed on Wednesday.',
    category: 'general',
    priority: 'urgent',
    sentAt: '2026-10-05T04:00:00.000Z',
    expiresOn: '2026-10-10',
    hasAttachment: true,
    attachmentMime: 'image/png',
    announcementId: 'a1',
    viaStudents: [
      { studentId: 'st-s1', fullName: 'Ali Khan' },
      { studentId: 'st-s2', fullName: 'Sara Khan' },
    ],
  },
  {
    id: 'm2',
    kind: 'notice',
    messageType: 'absence_alert',
    subjectType: 'attendance_alert',
    subjectId: 'al1',
    title: 'Green Valley School: absence',
    body: 'Ali Khan was marked absent today.',
    category: null,
    priority: 'urgent',
    sentAt: '2026-10-04T04:00:00.000Z',
    expiresOn: null,
    hasAttachment: false,
    attachmentMime: null,
    announcementId: null,
    viaStudents: [{ studentId: 'st-s1', fullName: 'Ali Khan' }],
  },
  {
    id: 'm3',
    kind: 'announcement',
    messageType: 'announcement_normal',
    subjectType: 'announcement',
    subjectId: 'a5',
    title: 'Fee due on the 10th',
    body: 'Kindly deposit before the due date.',
    category: 'fee',
    priority: 'normal',
    sentAt: '2026-10-01T04:00:00.000Z',
    expiresOn: null,
    hasAttachment: false,
    attachmentMime: null,
    announcementId: 'a5',
    viaStudents: [],
  },
];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The announcement routes, the picker's lookups and the inbox; `rows` may be added to by a create. */
function announcementsHandler(rows: AnnouncementDto[] = [SENT, DRAFT, SCHEDULED, CANCELLED]): Handler {
  return ({ method, path, url, request }) => {
    if (method === 'GET' && path === '/announcements') return { status: 200, body: page1(rows) };
    if (method === 'POST' && path === '/announcements/preview-audience') {
      return { status: 200, body: preview(request.postDataJSON() as PreviewAudienceBody) };
    }
    if (method === 'POST' && path === '/announcements') {
      const { audiences, stagedUploadId, ...body } = request.postDataJSON() as Omit<AnnouncementDto, 'audiences'> & {
        audiences: AudienceInput[];
        stagedUploadId?: string;
      };
      const created = announcement('a9', {
        ...body,
        audiences: audiences.map((a) => ({ kind: a.kind, targetId: a.targetId ?? null, targetName: null, roles: a.roles ?? [] })),
        hasAttachment: stagedUploadId !== undefined,
        attachmentMime: stagedUploadId !== undefined ? 'image/png' : null,
        status: 'draft',
      });
      rows.push(created);
      return { status: 201, body: created };
    }
    const one = path.match(/^\/announcements\/([^/]+)(\/[a-z-]+)?$/);
    const found = one && rows.find((r) => r.id === one[1]);
    if (found) {
      if (method === 'GET' && !one[2]) return { status: 200, body: found };
      if (method === 'PATCH' && !one[2]) return { status: 200, body: { ...found, ...(request.postDataJSON() as object) } };
      if (method === 'GET' && one[2] === '/delivery') return { status: 200, body: { ...DELIVERY, announcementId: found.id } };
      if (method === 'POST' && one[2] === '/send') {
        // Send now answers `sending` (contracts/slice-14.md §5.5); the server's job has finished by
        // the next read, which answers `sent`.
        if (found.scheduledAt) {
          const scheduled = { ...found, status: 'scheduled' as const };
          rows.splice(rows.indexOf(found), 1, scheduled);
          return { status: 200, body: scheduled };
        }
        rows.splice(rows.indexOf(found), 1, { ...found, status: 'sent', sentAt: STAMP, recipientCount: 412, sendFailedAt: null });
        return { status: 200, body: { ...found, status: 'sending', sendFailedAt: null } };
      }
      if (method === 'POST' && one[2] === '/cancel') {
        const cancelled = { ...found, status: 'cancelled' as const, cancelledAt: STAMP, cancelReason: (request.postDataJSON() as { reason: string }).reason };
        rows.splice(rows.indexOf(found), 1, cancelled);
        return { status: 200, body: cancelled };
      }
    }
    if (method === 'GET' && path === '/students') return { status: 200, body: page1(url.searchParams.get('q') ? [STUDENT] : []) };
    if (method === 'GET' && path === '/students/st-s1/guardian-links') {
      return { status: 200, body: page1([LINK('l1', 'g1', 'Ahmed Khan'), LINK('l2', 'g2', 'Old Guardian', STAMP), LINK('l3', 'g3', 'Saima Khan')]) };
    }
    if (method === 'GET' && path === '/staff') return { status: 200, body: page1([STAFF_MEMBER]) };
    if (method === 'POST' && path === '/uploads') {
      return { status: 201, body: { id: 'up1', mime: 'image/png', sizeBytes: PNG.length, expiresAt: STAMP } };
    }
    if (method === 'GET' && path === '/me/inbox') return { status: 200, body: page1(INBOX) };
    const item = path.match(/^\/me\/inbox\/([^/]+)$/);
    const message = item && INBOX.find((m) => m.id === item[1]);
    if (method === 'GET' && message) return { status: 200, body: message };
    return undefined;
  };
}

const refuse = (status: number, code: Parameters<typeof errorBody>[0], details: Parameters<typeof errorBody>[2] = null): Reply => ({
  status,
  body: errorBody(code, `Refused: ${code}.`, details),
});
const fieldRefusal = (path: string, code: string): Reply => ({
  status: 422,
  body: { error: { code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', details: { fields: [{ path, code, message: 'No such target' }] }, requestId: 'req-test' } },
});

const lastPreview = (requests: Parameters<typeof calls>[0]) =>
  calls(requests, 'POST', '/announcements/preview-audience').at(-1)?.postDataJSON() as PreviewAudienceBody | undefined;

async function fillCompose(page: Page, { title = 'School closed tomorrow', body = 'Due to heavy rain the school will remain closed.' } = {}) {
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Message').fill(body);
}

async function addEveryone(page: Page) {
  await page.getByRole('radio', { name: 'Everyone' }).click();
  await page.getByRole('button', { name: 'Add everyone' }).click();
}

/** Rule 0.13: delivery is tracked, opening is not; no screen claims otherwise. */
async function expectNoReadWord(page: Page) {
  const text = await page.locator('main, body').first().innerText();
  expect(text).not.toMatch(/\bread\b/i);
}

// ---- List ----

test('list: rows with status, recipients and SMS segments; filters reach the query; 1280 and tablet', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const { requests, unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler() });
  await open(page, '/announcements');
  await expect(page.getByRole('heading', { name: 'Announcements' })).toBeVisible();
  const sent = page.getByRole('row', { name: /School closed tomorrow/ });
  await expect(sent).toContainText('Sent');
  await expect(sent).toContainText('412');
  await expect(sent).toContainText('Urgent');
  await expect(page.getByRole('row', { name: /Class 5 trip forms/ })).toContainText('Class 5 A (parents only), Ali Khan');
  await expect(page.getByRole('row', { name: /Exam timetable/ })).toContainText('Scheduled');
  await expect(page.getByRole('row', { name: /Old notice/ })).toContainText('Cancelled');
  await expectNoSidewaysScroll(page);

  await page.getByLabel('Status').selectOption('sent');
  await page.getByLabel('Category').selectOption('exam');
  await page.getByLabel('Priority').selectOption('urgent');
  await page.getByLabel('Written from').fill('2026-10-01');
  await page.getByLabel('Written to').fill('2026-10-06');
  await page.getByLabel('Order').selectOption('-sentAt');
  await expect
    .poll(() => {
      const q = new URL(calls(requests, 'GET', '/announcements').at(-1)!.url()).searchParams;
      return [q.get('status'), q.get('category'), q.get('priority'), q.get('createdFrom'), q.get('createdTo'), q.get('sort'), q.get('page')];
    })
    .toEqual(['sent', 'exam', 'urgent', '2026-10-01', '2026-10-06', '-sentAt', '1']);
  // A backwards range is refused on the screen, not sent.
  await page.getByLabel('Written to').fill('2026-09-01');
  await expect(page.getByText('Cannot be before the start date.')).toBeVisible();
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  expect(unmocked).toEqual([]);
});

test('list: empty, error with retry, and refused (403) states', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /announcements': [
        { status: 200, body: page1([]) },
        // A 5xx is retried twice before the screen gives up.
        refuse(500, 'INTERNAL_ERROR'),
        refuse(500, 'INTERNAL_ERROR'),
        refuse(500, 'INTERNAL_ERROR'),
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Denied.') },
      ],
    },
  });
  await open(page, '/announcements');
  await expect(page.getByText('No announcements yet')).toBeVisible();
  await page.getByLabel('Status').selectOption('draft');
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('You do not have access')).toBeVisible();
});

test('a person with no announcement capability: Inbox in the nav, no Announcements; the list and composer refuse', async ({ page }) => {
  const parent = { ...TEACHER_ME, roles: [], capabilities: [], capabilityScopes: [], assignments: [], staffId: null };
  const { requests } = await mockSchoolApi(page, { me: parent, handler: announcementsHandler() });
  await open(page, '/announcements');
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'Inbox' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Announcements' })).toHaveCount(0);
  await expect(page.getByText('You do not have access')).toBeVisible();
  await open(page, '/announcements/new');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveCount(0);
  expect(calls(requests, 'GET', '/announcements')).toHaveLength(0);
});

// ---- Compose ----

test('principal composes: live counter and preview, urgent, attachment, send confirm with the numbers, one Idempotency-Key', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const rows = [SENT];
  const { requests, unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler(rows) });
  await open(page, '/announcements/new');
  await expect(page.getByRole('heading', { name: 'New announcement' })).toBeVisible();
  await expect(page.getByText('Choose who receives it.')).toBeVisible();
  // Nothing is previewed before an audience exists.
  expect(calls(requests, 'POST', '/announcements/preview-audience')).toHaveLength(0);

  await fillCompose(page);
  await expect(page.getByTestId('body-counter')).toHaveText('48 of 1800 characters');
  await addEveryone(page);
  // Everyone combines with nothing: the narrower steps say so.
  await page.getByRole('radio', { name: 'A class' }).click();
  await expect(page.getByText('Everyone already includes this.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('audience-chip')).toHaveText(/Everyone\s*412 people/);
  await expect(page.getByTestId('audience-total')).toHaveText('412 people in total, each once');
  await expect(page.getByTestId('preview-summary')).toContainText('412 people · not sent by SMS');
  await expect(page.getByTestId('body-counter')).toHaveText('48 of 1800 characters · not sent by SMS');

  await page.getByLabel('Priority').selectOption('urgent');
  await expect(page.getByTestId('preview-summary')).toContainText('412 people · 150 SMS units of 480 remaining · 1 segment');
  await expect(page.getByTestId('body-counter')).toHaveText('48 of 1800 characters · 1 SMS segment');
  expect(lastPreview(requests)).toEqual({
    audiences: [{ kind: 'everyone' }],
    priority: 'urgent',
    hasAttachment: false,
    title: 'School closed tomorrow',
    body: 'Due to heavy rain the school will remain closed.',
  });

  await page.getByLabel('Category').selectOption('holiday');
  await page.getByLabel('Expires on (optional)').fill('2026-10-08');
  await page.getByLabel('Attachment (optional)').setInputFiles({ name: 'notice.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('announcement-attachment')).toContainText('notice.png');
  await expect.poll(() => lastPreview(requests)?.hasAttachment).toBe(true);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Send…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Send this announcement now?' });
  await expect(confirm.getByTestId('send-confirm-numbers')).toContainText('412 people · 150 SMS units of 480 remaining · 1 segment');
  await expect(confirm.getByText('Urgent: WhatsApp and SMS together.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/announcements\/a9$/);
  // Send now answers `sending`; the detail polls the record until the server's job has sent it.
  await expect(page.getByText('Sending now. This page shows when it has gone.')).toBeVisible();
  await expect(page.getByText('to 412 people', { exact: false })).toBeVisible();
  await expect(page.getByTestId('delivery-summary')).toBeVisible();

  const posts = calls(requests, 'POST', '/announcements');
  expect(posts).toHaveLength(1);
  expect(posts[0].headers()['idempotency-key']).toMatch(KEY);
  expect(posts[0].postDataJSON()).toEqual({
    title: 'School closed tomorrow',
    body: 'Due to heavy rain the school will remain closed.',
    category: 'holiday',
    priority: 'urgent',
    audiences: [{ kind: 'everyone' }],
    expiresOn: '2026-10-08',
    stagedUploadId: 'up1',
  });
  expect(calls(requests, 'POST', '/announcements/a9/send')).toHaveLength(1);
  expect(unmocked).toEqual([]);
});

test('compose at tablet width: the picker and the form fit without sideways scroll', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler() });
  await open(page, '/announcements/new');
  await page.getByRole('radio', { name: 'A section' }).click();
  await expect(page.getByLabel('Academic year')).toHaveValue('y1');
  await expectNoSidewaysScroll(page);
});

test('save draft: refused creates keep the key; a reused key is replaced; then saved, later saves are PATCHes', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([]),
    replies: {
      'POST /announcements': [refuse(429, 'RATE_LIMITED'), refuse(409, 'IDEMPOTENCY_KEY_REUSED')],
    },
  });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await addEveryone(page);
  const save = page.getByRole('button', { name: 'Save draft' });
  await save.click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await save.click();
  await expect(page.getByText('This form was already used for a different announcement.', { exact: false })).toBeVisible();
  await save.click();
  await expect(page).toHaveURL(/\/announcements\/a9$/);
  await expect(page.getByText('Draft saved.')).toBeVisible();
  const keys = calls(requests, 'POST', '/announcements').map((r) => r.headers()['idempotency-key']);
  expect(keys).toHaveLength(3);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
});

test('teacher: no Everyone or staff kinds; only their own section; a class with a section outside scope is not offered', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: TEACHER_ME, handler: announcementsHandler([]) });
  await open(page, '/announcements/new');
  const kinds = page.getByRole('radiogroup', { name: 'Audience type' }).getByRole('radio');
  await expect(kinds).toHaveText(['A class', 'A section', 'One student', 'One family']);
  await expect(page.getByText('Everyone', { exact: true })).toHaveCount(0);

  // Class 5 has sections A and B; the teacher teaches A only.
  await page.getByLabel('Class', { exact: true }).selectOption('c5');
  await expect(page.getByText('You teach only some sections of this class. Choose a section instead.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add class' })).toBeDisabled();
  // No year select: the teacher's classes come from their assignments.
  await expect(page.getByLabel('Academic year')).toHaveCount(0);

  await page.getByRole('radio', { name: 'A section' }).click();
  await page.getByLabel('Class', { exact: true }).selectOption('c5');
  await expect(page.getByLabel('Section', { exact: true }).locator('option')).toHaveText(['Choose…', 'A']);
  await page.getByLabel('Section', { exact: true }).selectOption('sec-a');
  await page.getByRole('button', { name: 'Add section' }).click();
  const chip = page.getByTestId('audience-chip');
  await expect(chip).toContainText('Class 5 A');
  // Roles: Parents and Students, both on; the last one on stays on.
  await chip.getByRole('button', { name: 'students' }).click();
  await expect(chip.getByRole('button', { name: 'parents' })).toBeDisabled();
  await expect.poll(() => lastPreview(requests)?.audiences).toEqual([{ kind: 'section', targetId: 'sec-a', roles: ['parents'] }]);
  await expect(chip).toContainText('40 people');
});

test('teacher: an audience refused by the server is highlighted on its chip (REFERENCE_NOT_FOUND)', async ({ page }) => {
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: announcementsHandler([]),
    replies: { 'POST /announcements': fieldRefusal('audiences[0].targetId', 'REFERENCE_NOT_FOUND') },
  });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await page.getByRole('radio', { name: 'A section' }).click();
  await page.getByLabel('Class', { exact: true }).selectOption('c5');
  await page.getByLabel('Section', { exact: true }).selectOption('sec-a');
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  const chip = page.getByTestId('audience-chip');
  await expect(chip).toHaveAttribute('data-invalid', 'true');
  await expect(chip).toContainText('Not found, or outside the classes and students you can reach.');
  // Changing the audience clears the mark.
  await chip.getByRole('button', { name: 'students' }).click();
  await expect(page.getByTestId('audience-chip')).not.toHaveAttribute('data-invalid', 'true');
});

test('office clerk (school-wide scope, no .school): any class with a year select, but not Everyone or staff', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: OFFICE_ME, handler: announcementsHandler([]) });
  await open(page, '/announcements/new');
  await expect(page.getByRole('radiogroup', { name: 'Audience type' }).getByRole('radio')).toHaveText([
    'A class',
    'A section',
    'One student',
    'One family',
  ]);
  await expect(page.getByLabel('Academic year')).toHaveValue('y1');
  await page.getByLabel('Class', { exact: true }).selectOption('c5');
  await page.getByRole('button', { name: 'Add class' }).click();
  await expect(page.getByTestId('audience-chip')).toContainText('Class 5');
  await expect.poll(() => lastPreview(requests)?.audiences).toEqual([{ kind: 'class', targetId: 'c5' }]);
});

test('one student, one family (live guardians, names only), one staff member; chips are removable; at most one copy each', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler([]) });
  await open(page, '/announcements/new');

  await page.getByRole('radio', { name: 'One student' }).click();
  await page.getByLabel('Search').fill('Ali');
  await page.getByRole('button', { name: 'Add Ali Khan' }).click();
  await page.getByRole('button', { name: 'Add Ali Khan' }).click();

  await page.getByRole('radio', { name: 'One family' }).click();
  await page.getByLabel('Search').fill('Ali');
  await page.getByRole('button', { name: 'Choose Ali Khan' }).click();
  const guardians = page.getByRole('list', { name: 'Guardians' });
  // The ended link is not offered; no phone, identity number or relationship is shown.
  await expect(guardians.getByRole('listitem')).toHaveText([/Ahmed Khan/, /Saima Khan/]);
  await expect(guardians).not.toContainText('+92');
  await expect(guardians).not.toContainText('father');
  await page.getByRole('button', { name: 'Add Saima Khan' }).click();

  await page.getByRole('radio', { name: 'One staff member' }).click();
  await page.getByLabel('Search').fill('Imran');
  await page.getByRole('button', { name: 'Add Imran Ali' }).click();

  await expect(page.getByTestId('audience-chip')).toHaveText([/Ali Khan/, /Family: Saima Khan/, /Staff: Imran Ali/]);
  await expect
    .poll(() => lastPreview(requests)?.audiences)
    .toEqual([
      { kind: 'student', targetId: 'st-s1' },
      { kind: 'guardian', targetId: 'g3' },
      { kind: 'staff_member', targetId: 'st-x' },
    ] satisfies AudienceInput[]);
  const staffQuery = new URL(calls(requests, 'GET', '/staff').at(-1)!.url()).searchParams;
  expect([staffQuery.get('q'), staffQuery.get('status')]).toEqual(['Imran', 'active']);
  await page.getByRole('button', { name: 'Remove Staff: Imran Ali' }).click();
  await expect(page.getByTestId('audience-chip')).toHaveCount(2);
});

test('preview warnings: too long for SMS inline on the message, allowance short, nobody in the audience, WhatsApp not connected', async ({ page }) => {
  const warned: Reply = {
    status: 200,
    body: preview(
      { audiences: [{ kind: 'everyone' }], priority: 'urgent' },
      {
        warnings: ['sms_too_long', 'sms_cap_short', 'no_recipients', 'whatsapp_not_connected'],
        sms: { allowed: true, legs: 300, segments: 4, units: 1200, remaining: 480, cap: 500 },
      },
    ),
  };
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler([]), replies: { 'POST /announcements/preview-audience': warned } });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await addEveryone(page);
  await expect(page.getByTestId('body-error')).toHaveText('Over 3 SMS segments; shorten or send as normal.');
  const summary = page.getByTestId('preview-summary');
  await expect(summary).toContainText('Needs 1200 SMS units; 480 remain this month. Send as normal, or shorten.');
  await expect(summary).toContainText('Nobody is in this audience today.');
  await expect(summary).toContainText('The school’s WhatsApp is not connected');
});

test('a preview refusal (audience_requires_school) is shown under the picker', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([]),
    replies: { 'POST /announcements/preview-audience': refuse(403, 'PERMISSION_DENIED', { reason: 'audience_requires_school' }) },
  });
  await open(page, '/announcements/new');
  await addEveryone(page);
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Only someone allowed to message the whole school can choose Everyone, all parents, all students or staff.',
    }),
  ).toBeVisible();
});

test('create refusals of §9: SMS_TOO_LONG on the message; audience_requires_school; archived, inactive and merged targets; stagedUploadId', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([]),
    replies: {
      'POST /announcements': [
        refuse(409, 'SMS_TOO_LONG', { segments: 4, maxSegments: 3 }),
        refuse(403, 'PERMISSION_DENIED', { reason: 'audience_requires_school' }),
        refuse(409, 'CLASS_ARCHIVED'),
        refuse(409, 'SECTION_ARCHIVED'),
        refuse(409, 'STUDENT_NOT_ACTIVE'),
        refuse(409, 'GUARDIAN_MERGED', { mergedIntoId: 'g7' }),
        refuse(409, 'STAFF_NOT_ACTIVE'),
        fieldRefusal('stagedUploadId', 'REFERENCE_NOT_FOUND'),
      ],
    },
  });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await addEveryone(page);
  const save = page.getByRole('button', { name: 'Save draft' });
  const expectRoot = async (text: string) => {
    await save.click();
    await expect(page.getByRole('alert').filter({ hasText: text })).toBeVisible();
  };
  await save.click();
  await expect(page.getByTestId('body-error')).toHaveText('Over 3 SMS segments (4); shorten it or send as normal.');
  await expectRoot('Only someone allowed to message the whole school can choose Everyone');
  await expectRoot('A class in the audience is archived. Remove it.');
  await expectRoot('A section in the audience is archived. Remove it.');
  await expectRoot('A student in the audience has left the school. Remove them.');
  await expectRoot('A family in the audience was merged into another record.');
  await expectRoot('A staff member in the audience has left. Remove them.');
  await expectRoot('The attachment expired before it was saved. Choose the file again.');
  // Every refused create kept the one key.
  expect(new Set(calls(requests, 'POST', '/announcements').map((r) => r.headers()['idempotency-key'])).size).toBe(1);
});

test('send refusals after the draft exists: NO_RECIPIENTS and SMS_CAP_EXCEEDED explained; the retry PATCHes the draft, never creates again', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([]),
    replies: {
      'POST /announcements/a9/send': [
        refuse(409, 'ANNOUNCEMENT_NO_RECIPIENTS', { audiences: 1 }),
        refuse(409, 'SMS_CAP_EXCEEDED', { smsUnits: 600, remaining: 480, cap: 500 }),
      ],
    },
  });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await addEveryone(page);
  await page.getByLabel('Priority').selectOption('urgent');
  await expect(page.getByTestId('preview-summary')).toContainText('SMS units');
  const sendOnce = async () => {
    await page.getByRole('button', { name: 'Send…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  };
  await sendOnce();
  await expect(page.getByRole('alert').filter({ hasText: 'Nobody is in this audience today. Choose a different audience.' })).toBeVisible();
  await page.getByLabel('Title').fill('School closed on Wednesday');
  await sendOnce();
  await expect(page.getByRole('alert').filter({ hasText: 'Needs 600 SMS units; 480 remain. Send as normal, or shorten.' })).toBeVisible();
  await page.getByLabel('Priority').selectOption('normal');
  await sendOnce();
  await expect(page).toHaveURL(/\/announcements\/a9$/);
  expect(calls(requests, 'POST', '/announcements')).toHaveLength(1);
  const patches = calls(requests, 'PATCH', '/announcements/a9').map((r) => r.postDataJSON());
  expect(patches).toEqual([{ title: 'School closed on Wednesday' }, { priority: 'normal' }]);
});

test('schedule: the time is checked on the screen, sent as an instant, and the confirm says when', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler([]) });
  await open(page, '/announcements/new');
  await fillCompose(page);
  await addEveryone(page);
  await page.getByLabel('Schedule for later').check();
  await page.getByLabel('Send at (Pakistan time)').fill('2026-10-06T09:00');
  await page.getByRole('button', { name: 'Schedule…' }).click();
  await expect(page.getByText('Choose a time at least a minute from now and within 90 days.')).toBeVisible();
  await page.getByLabel('Send at (Pakistan time)').fill('2026-10-07T09:00');
  await page.getByLabel('Expires on (optional)').fill('2026-10-01');
  await page.getByRole('button', { name: 'Schedule…' }).click();
  await expect(page.getByText('The expiry cannot be in the past.')).toBeVisible();
  await page.getByLabel('Expires on (optional)').fill('');
  await page.getByRole('button', { name: 'Schedule…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Schedule this announcement?' });
  await expect(confirm).toContainText('It goes at 7 Oct 2026, 09:00');
  await confirm.getByRole('button', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(/\/announcements\/a9$/);
  expect(calls(requests, 'POST', '/announcements')[0].postDataJSON()).toMatchObject({ scheduledAt: '2026-10-07T04:00:00.000Z' });
});

// ---- Detail ----

test('draft detail: send through the confirm (fresh preview); cancel with a reason', async ({ page }) => {
  const rows = [DRAFT, announcement('a5', { title: 'Second draft' })];
  const { requests } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler(rows) });
  await open(page, '/announcements/a2');
  await expect(page.getByRole('heading', { name: 'Class 5 trip forms' })).toBeVisible();
  await expect(page.getByText('Class 5 A (parents only)')).toBeVisible();
  await page.getByRole('button', { name: 'Send…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Send this announcement now?' });
  await expect(confirm.getByTestId('send-confirm-numbers')).toContainText('80 people · not sent by SMS');
  expect(lastPreview(requests)).toEqual({
    audiences: [
      { kind: 'section', targetId: 'sec-a', roles: ['parents'] },
      { kind: 'student', targetId: 'st-s1' },
    ],
    priority: 'normal',
    holiday: false,
    title: 'Class 5 trip forms',
    body: DRAFT.body,
    hasAttachment: false,
  });
  await confirm.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Sending now. This page shows when it has gone.')).toBeVisible();
  await expect(page.getByTestId('sending-now')).toBeVisible();
  await expect(page.getByTestId('delivery-summary')).toBeHidden();
  // Polled until the record is `sent`: then who it reached, and the delivery summary.
  await expect(page.getByText('to 412 people', { exact: false })).toBeVisible();
  await expect(page.getByTestId('delivery-summary')).toBeVisible();
  expect(calls(requests, 'GET', '/announcements/a2').length).toBeGreaterThanOrEqual(2);

  await open(page, '/announcements/a5');
  await page.getByRole('button', { name: 'Cancel announcement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this announcement?' });
  await dialog.getByLabel('Reason').fill('Wrong date');
  await dialog.getByRole('button', { name: 'Cancel announcement' }).click();
  await expect(page.getByText('Announcement cancelled. Nothing was sent.')).toBeVisible();
  expect(calls(requests, 'POST', '/announcements/a5/cancel')[0].postDataJSON()).toEqual({ reason: 'Wrong date' });
  await expect(page.getByRole('button', { name: 'Cancel announcement' })).toHaveCount(0);
});

test('a draft whose send the server gave up on says so, and can be sent again', async ({ page }) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler([{ ...DRAFT, sendFailedAt: '2026-10-05T04:10:00.000Z' }]) });
  await open(page, '/announcements/a2');
  await expect(page.getByTestId('send-failed')).toContainText('Sending failed on');
  await expect(page.getByTestId('send-failed')).toContainText('nobody was sent it');
  await expect(page.getByRole('button', { name: 'Send…' })).toBeVisible();
});

test('detail refusals: ANNOUNCEMENT_CANCELLED on send, ANNOUNCEMENT_SENT on cancel', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([DRAFT]),
    replies: {
      'POST /announcements/a2/send': refuse(409, 'ANNOUNCEMENT_CANCELLED'),
      'POST /announcements/a2/cancel': refuse(409, 'ANNOUNCEMENT_SENT', { status: 'sent' }),
    },
  });
  await open(page, '/announcements/a2');
  await page.getByRole('button', { name: 'Send…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This announcement is cancelled. Write a new one instead.' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel announcement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this announcement?' });
  await dialog.getByLabel('Reason').fill('Changed plan');
  await dialog.getByRole('button', { name: 'Cancel announcement' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This announcement has been sent, so it cannot change. Write a new one to correct it.' }),
  ).toBeVisible();
});

test('sent detail: no edit or cancel; delivery per channel with suppression reasons in plain words; polls while sending; never "read"', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  let deliveries = 0;
  const handler = announcementsHandler([SENT]);
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => {
      if (call.path === '/announcements/a1/delivery') {
        deliveries += 1;
        return {
          status: 200,
          body: deliveries === 1 ? DELIVERY : { ...DELIVERY, messages: { ...DELIVERY.messages, queued: 0, sending: 0 } },
        };
      }
      return handler(call);
    },
  });
  await page.route('**/api/v1/announcements/a1/thumbnail', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/v1/announcements/a1/attachment', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Content-Disposition': 'attachment; filename="announcement-a1.png"' },
      body: PNG,
    }),
  );
  await page.clock.install({ time: NOW });
  await page.goto('/announcements/a1');
  await expect(page.getByRole('heading', { name: 'School closed tomorrow' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel announcement' })).toHaveCount(0);
  const summary = page.getByTestId('delivery-summary');
  await expect(summary).toContainText('7 still going out. This page updates every 30 seconds.');
  await expect(summary.getByTestId('channel-whatsapp')).toHaveText(/WhatsApp\s*300\s*280\s*4\s*3/);
  await expect(summary.getByTestId('channel-email')).toHaveText(/Email\s*0\s*0\s*0\s*0/);
  await expect(summary.getByTestId('suppression-duplicate_phone')).toHaveText(/Same phone as another recipient\s*5/);
  await expect(summary.getByTestId('suppression-no_channel')).toHaveText(/No phone or app\s*3/);
  await expect(summary.getByTestId('suppression-cap_reached')).toHaveText(/SMS allowance used\s*1/);
  await expect(summary).toContainText('SMS: 150 units used, 1 per message.');
  await expectNoReadWord(page);

  await page.clock.fastForward('00:31');
  await expect(summary).toContainText('Finished. 290 delivered, 6 failed, 9 not sent.');
  expect(calls(requests, 'GET', '/announcements/a1/delivery').length).toBeGreaterThanOrEqual(2);
  // Finished: no more polling.
  const settled = calls(requests, 'GET', '/announcements/a1/delivery').length;
  await page.clock.fastForward('01:05');
  expect(calls(requests, 'GET', '/announcements/a1/delivery')).toHaveLength(settled);

  // The picture loads on tap; the file downloads under its served name.
  await expect(page.getByRole('img', { name: 'Attachment to this announcement' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show picture' }).click();
  await expect(page.getByRole('img', { name: 'Attachment to this announcement' })).toHaveAttribute('src', '/api/v1/announcements/a1/thumbnail');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('announcement-a1.png');
  await expectNoSidewaysScroll(page);
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  await expectNoReadWord(page);
  expect(unmocked).toEqual([]);
});

test('detail: not found (404), no permission (403) and failure states', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /announcements/zz': refuse(404, 'NOT_FOUND'),
      'GET /announcements/yy': refuse(403, 'PERMISSION_DENIED'),
      'GET /announcements/xx': refuse(500, 'INTERNAL_ERROR'),
    },
  });
  await open(page, '/announcements/zz');
  await expect(page.getByText('Announcement not found')).toBeVisible();
  await open(page, '/announcements/yy');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await open(page, '/announcements/xx');
  await expect(page.getByText('Something went wrong')).toBeVisible();
});

test('edit: the record fills the form with its audience names; only the changes are PATCHed; ANNOUNCEMENT_SENT explained', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: announcementsHandler([DRAFT]),
    replies: { 'PATCH /announcements/a2': [refuse(409, 'ANNOUNCEMENT_SENT', { status: 'sent' })] },
  });
  await open(page, '/announcements/a2/edit');
  await expect(page.getByRole('heading', { name: 'Edit announcement' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Class 5 trip forms');
  await expect(page.getByTestId('audience-chip')).toHaveText([/Class 5 A/, /Ali Khan/]);
  await expect(page.getByTestId('audience-chip').first().getByRole('button', { name: 'students' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Category').selectOption('exam');
  await page.getByRole('button', { name: 'Remove Ali Khan' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This announcement has been sent, so it cannot change.' })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/announcements\/a2$/);
  expect(calls(requests, 'PATCH', '/announcements/a2').at(-1)!.postDataJSON()).toEqual({
    category: 'exam',
    audiences: [{ kind: 'section', targetId: 'sec-a', roles: ['parents'] }],
  });
  expect(calls(requests, 'POST', '/announcements')).toHaveLength(0);
});

test('edit of a sent or cancelled announcement says it cannot change', async ({ page }) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: announcementsHandler([SENT, CANCELLED]) });
  await open(page, '/announcements/a1/edit');
  await expect(page.getByText('This announcement is sent')).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveCount(0);
  await open(page, '/announcements/a4/edit');
  await expect(page.getByText('This announcement is cancelled')).toBeVisible();
});

// ---- Inbox ----

test('inbox: newest first, urgent edge, category or notice tag, "about" children, filters; 1280 and tablet', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const { requests, unmocked } = await mockSchoolApi(page, { me: TEACHER_ME, handler: announcementsHandler() });
  await open(page, '/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  const items = page.getByTestId('inbox-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('About Ali Khan and Sara Khan');
  await expect(items.nth(0)).toContainText('Urgent');
  await expect(items.nth(0)).toContainText('Attachment');
  await expect(items.nth(0)).toHaveClass(/border-l-destructive/);
  await expect(items.nth(1)).toContainText('Notice');
  await expect(items.nth(2)).toContainText('Fee');
  await expect(items.nth(2)).not.toHaveClass(/border-l-destructive/);
  await expectNoSidewaysScroll(page);
  await page.getByLabel('Show').selectOption('announcement');
  await page.getByLabel('Category').selectOption('fee');
  await expect
    .poll(() => {
      const q = new URL(calls(requests, 'GET', '/me/inbox').at(-1)!.url()).searchParams;
      return [q.get('kind'), q.get('category'), q.get('page')];
    })
    .toEqual(['announcement', 'fee', '1']);
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  await expectNoReadWord(page);
  expect(unmocked).toEqual([]);
});

test('inbox item: body, attachment on tap and download; expired or not addressed to me is not found', async ({ page }) => {
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: announcementsHandler(),
    replies: { 'GET /me/inbox/m404': refuse(404, 'NOT_FOUND') },
  });
  await page.route('**/api/v1/me/inbox/m1/thumbnail', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/v1/me/inbox/m1/attachment', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Content-Disposition': 'attachment; filename="announcement-a1.png"' },
      body: PNG,
    }),
  );
  await open(page, '/inbox');
  await page.getByRole('link', { name: /School closed tomorrow/ }).click();
  await expect(page.getByRole('heading', { name: 'School closed tomorrow' })).toBeVisible();
  await expect(page.getByTestId('inbox-body')).toHaveText(INBOX[0].body);
  await expect(page.getByText('Until 10 Oct 2026')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Attachment to this message' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show picture' }).click();
  await expect(page.getByRole('img', { name: 'Attachment to this message' })).toHaveAttribute('src', '/api/v1/me/inbox/m1/thumbnail');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('announcement-a1.png');
  await expectNoSidewaysScroll(page);

  await open(page, '/inbox/m404');
  await expect(page.getByText('Message not found')).toBeVisible();
});

test('inbox: empty, failed with retry, and loading states', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    replies: { 'GET /me/inbox': [{ status: 200, body: page1([]) }, refuse(500, 'INTERNAL_ERROR')] },
  });
  await open(page, '/inbox');
  await expect(page.getByText('No messages yet')).toBeVisible();
  await page.getByLabel('Show').selectOption('notice');
  await expect(page.getByText('Something went wrong')).toBeVisible();

  // Loading: the first page is held back.
  await page.route(/\/api\/v1\/me\/inbox\?/, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1(INBOX)) });
  });
  await page.goto('/inbox');
  await expect(page.getByRole('status', { name: 'Loading' }).last()).toBeVisible();
  release();
  await expect(page.getByTestId('inbox-item')).toHaveCount(3);
});
