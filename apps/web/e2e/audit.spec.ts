import { DEFAULT_PASSWORD_INERT_ACTION_NAMES, ErrorCode } from '@asms/shared';
import { expect as baseExpect, test } from '@playwright/test';
import type { AuditEntryDto } from '../lib/api/school-audit-contract';
import type { MeDto } from '../lib/api/school-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TODAY,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
} from './support/wave-e';

// Phase 5 slice 46 (contracts/slice-46.md §4): the audit log. The default range is the last seven
// school days; a person or a record narrows it from a row; the action filter reaches the query;
// over 92 days is refused on the screen; masked values are shown as the API gives them; the four
// states, rule 24's prompt, and a tablet width without sideways scroll.

const expect = baseExpect.configure({ timeout: 15_000 });

const entry = (id: string, extra: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id,
  createdAt: STAMP,
  action: 'payment.voided',
  subjectType: 'payment',
  subjectId: '501',
  actor: { kind: 'user', userId: 'u-office', name: 'Bilal Office' },
  reason: 'Wrong family',
  details: [
    { key: 'amount', value: '2500' },
    { key: 'guardianPhone', value: '***' },
  ],
  ...extra,
});

const ENTRIES = [
  entry('a1'),
  entry('a2', {
    action: 'student.updated',
    subjectType: 'student',
    subjectId: '77',
    reason: null,
    details: [{ key: 'note', value: 'call *********67' }],
  }),
  entry('a3', {
    action: 'support.read',
    subjectType: 'student',
    subjectId: '77',
    actor: { kind: 'platform', userId: null, name: 'Platform support' },
    reason: null,
    details: [],
  }),
];

const search = (requests: Parameters<typeof calls>[0]) =>
  calls(requests, 'GET', '/audit-log').map((r) => Object.fromEntries(new URL(r.url()).searchParams));

test('the principal reads the last week, narrows by record, person and action, and the range is capped', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path }) => (method === 'GET' && path === '/audit-log' ? { status: 200, body: page1(ENTRIES) } : undefined),
  });
  await open(page, '/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  expect(search(requests)[0]).toMatchObject({ createdFrom: '2026-09-30', createdTo: TODAY, page: '1', limit: '25' });

  const voided = page.getByRole('row', { name: /payment\.voided/ });
  await expect(voided.getByText('Bilal Office')).toBeVisible();
  await expect(voided.getByText('Wrong family')).toBeVisible();
  await expect(voided.getByText('***')).toBeVisible();
  await expect(page.getByRole('row', { name: /support\.read/ }).getByText('Platform support')).toBeVisible();
  // A record with a page links there; one without does not.
  await expect(page.getByRole('row', { name: /student\.updated/ }).getByRole('link', { name: 'Student 77' })).toHaveAttribute('href', '/students/77');
  await expect(voided.getByRole('link')).toHaveCount(0);

  await page.getByRole('row', { name: /student\.updated/ }).getByRole('button', { name: 'History of Student 77' }).click();
  await expect.poll(() => search(requests).at(-1)).toMatchObject({ subjectType: 'student', subjectId: '77' });
  await page.getByRole('button', { name: 'Show every record' }).click();
  await voided.getByRole('button', { name: 'Only actions by Bilal Office' }).click();
  await expect(page.getByText('Actions by Bilal Office')).toBeVisible();
  await expect.poll(() => search(requests).at(-1)).toMatchObject({ actorUserId: 'u-office' });
  expect(search(requests).at(-1)).not.toHaveProperty('subjectType');

  await page.getByLabel('Action starts with').fill('payment');
  await expect.poll(() => search(requests).at(-1)).toMatchObject({ actionPrefix: 'payment', actorUserId: 'u-office' });

  const before = search(requests).length;
  await page.getByLabel('From', { exact: true }).fill('2026-07-01');
  await expect(page.getByText('Choose at most 92 days.')).toBeVisible();
  expect(search(requests)).toHaveLength(before);
});

test('filters may arrive in the address (a support-session notice links here)', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path }) => (method === 'GET' && path === '/audit-log' ? { status: 200, body: page1([ENTRIES[2]!]) } : undefined),
  });
  await open(page, '/audit?subjectType=support_session&subjectId=12&createdFrom=2026-10-01&createdTo=2026-10-06');
  await expect(page.getByText('History of Support session 12')).toBeVisible();
  expect(search(requests)[0]).toMatchObject({ subjectType: 'support_session', subjectId: '12', createdFrom: '2026-10-01' });
});

test('the empty, failed, no-permission and default-password states; tablet fits', async ({ page }) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, replies: { 'GET /audit-log': { status: 200, body: page1([]) } } });
  await page.setViewportSize(TABLET);
  await open(page, '/audit');
  await expect(page.getByText('Nothing recorded')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: { 'GET /audit-log': { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') } },
  });
  await open(page, '/audit');
  await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, {
    me: OFFICE_ME,
    replies: { 'GET /audit-log': { status: 403, body: errorBody(ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.') } },
  });
  await open(page, '/audit');
  await expect(page.getByText('You do not have access')).toBeVisible();
  // The office does not hold audit.view: no sidebar entry.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  await page.unrouteAll({ behavior: 'wait' });
  const defaultPassword: MeDto = { ...PRINCIPAL_ME, passwordIsDefault: true, blockedActions: [...DEFAULT_PASSWORD_INERT_ACTION_NAMES] };
  await mockSchoolApi(page, {
    me: defaultPassword,
    replies: {
      'GET /audit-log': { status: 403, body: errorBody(ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION, 'Change your password first.') },
    },
  });
  await open(page, '/audit');
  await expect(page.getByText('Change your password first')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
