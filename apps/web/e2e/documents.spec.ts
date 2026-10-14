import { ErrorCode } from '@asms/shared';
import { expect as baseExpect, test } from '@playwright/test';
import type { IncompleteAdmissionDto, QueuedDocumentDto } from '../lib/api/school-documents-contract';
import {
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
} from './support/wave-e';

// Phase 5 slice 40 (contracts/slice-40.md §4): the verification queue (verify, reject with a
// reason, the caller's own upload never decided), its four states, the incomplete-admissions
// report, the student's checklist, and the Documents section of the Approvals board.

const expect = baseExpect.configure({ timeout: 15_000 });

const doc = (id: string, extra: Partial<QueuedDocumentDto> = {}): QueuedDocumentDto => ({
  id,
  studentId: 'st1',
  type: 'b_form',
  mime: 'application/pdf',
  sizeBytes: 40_000,
  uploadedBy: 'u-other',
  uploadedByName: 'Sara Office',
  createdAt: STAMP,
  status: 'uploaded',
  decidedAt: null,
  decidedByName: null,
  rejectReason: null,
  student: { id: 'st1', admissionNo: '1001', fullName: 'Ali Khan', className: 'Class 5', sectionName: 'A' },
  ownUpload: false,
  ...extra,
});

const QUEUE = [doc('d1'), doc('d2', { type: 'photo', mime: 'image/jpeg', uploadedBy: 'u-office', uploadedByName: 'Bilal Office', ownUpload: true })];

test('queue: the office verifies one, cannot decide its own upload, and rejects with a reason', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: ({ method, path }) => {
      if (method === 'GET' && path === '/documents') return { status: 200, body: page1(QUEUE) };
      if (method === 'POST' && path === '/documents/d1/verify') return { status: 200, body: { ...doc('d1'), status: 'verified' } };
      if (method === 'POST' && path === '/documents/d1/reject') return { status: 200, body: { ...doc('d1'), status: 'rejected' } };
      return undefined;
    },
  });
  await open(page, '/documents');
  const own = page.getByRole('row', { name: /Photo/ });
  await expect(own.getByText('You uploaded this; another member of staff checks it.')).toBeVisible();
  await expect(own.getByRole('button', { name: /Verify/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Verify B-Form of Ali Khan' }).click();
  await expect(page.getByText('B-Form verified.')).toBeVisible();
  expect(calls(requests, 'POST', '/documents/d1/verify')).toHaveLength(1);

  await page.getByRole('button', { name: 'Reject B-Form of Ali Khan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject B-Form' });
  await dialog.getByRole('textbox').fill('The scan is blurred');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('B-Form rejected.')).toBeVisible();
  expect(calls(requests, 'POST', '/documents/d1/reject')[0]!.postDataJSON()).toEqual({ reason: 'The scan is blurred' });

  // Filters reach the query; the default is the awaiting queue, oldest first.
  expect(new URL(calls(requests, 'GET', '/documents')[0]!.url()).searchParams.get('status')).toBe('uploaded');
  await page.getByLabel('Type').selectOption('photo');
  await expect
    .poll(() => calls(requests, 'GET', '/documents').map((r) => new URL(r.url()).searchParams.get('type')))
    .toContain('photo');
});

test('queue: a decision a colleague took first is explained, the empty and failed states read plainly', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_ME,
    replies: {
      'GET /documents': [
        { status: 200, body: page1([doc('d1')]) },
        { status: 200, body: page1([]) },
      ],
      'POST /documents/d1/verify': {
        status: 409,
        body: errorBody(ErrorCode.DOCUMENT_ALREADY_DECIDED, 'This document has already been decided.', { documentId: 'd1', status: 'verified' }),
      },
    },
  });
  await open(page, '/documents');
  await page.getByRole('button', { name: 'Verify B-Form of Ali Khan' }).click();
  await expect(page.getByText('This document has already been checked. The list has been refreshed.')).toBeVisible();
  await expect(page.getByText('Nothing to check')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, { me: OFFICE_ME, replies: { 'GET /documents': { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') } } });
  await open(page, '/documents');
  await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();
});

test('incomplete admissions: the last 90 days by default, missing, awaiting and rejected per student; tablet fits', async ({ page }) => {
  const row: IncompleteAdmissionDto = {
    studentId: 'st1',
    admissionNo: '1001',
    fullName: 'Ali Khan',
    admittedOn: '2026-09-01',
    className: 'Class 5',
    sectionName: 'A',
    missing: ['photo'],
    awaiting: [],
    rejected: ['b_form'],
  };
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: ({ method, path }) => (method === 'GET' && path === '/documents/incomplete-admissions' ? { status: 200, body: page1([row]) } : undefined),
  });
  await page.setViewportSize(TABLET);
  await open(page, '/documents/incomplete');
  const line = page.getByRole('row', { name: /Ali Khan/ });
  await expect(line.getByText('Missing: Photo')).toBeVisible();
  await expect(line.getByText('Rejected: B-Form')).toBeVisible();
  const query = new URL(calls(requests, 'GET', '/documents/incomplete-admissions')[0]!.url()).searchParams;
  expect([query.get('admittedFrom'), query.get('admittedTo')]).toEqual(['2026-07-08', '2026-10-06']);
  await expectNoSidewaysScroll(page);
});

test('student page: the checklist above the documents, verify from the row; a teacher sees no Documents entry', async ({ page }) => {
  const student = {
    id: 'st1',
    admissionNo: '1001',
    fullName: 'Ali Khan',
    gender: 'male',
    dateOfBirth: '2016-05-04',
    hasBForm: true,
    bFormMasked: '35202-*****-3',
    status: 'active',
    admittedOn: '2026-09-01',
    current: null,
    userId: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    documentsIncomplete: true,
    notes: null,
    photoDocumentId: null,
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path }) => {
      if (method === 'GET' && path === '/students/st1') return { status: 200, body: student };
      if (method === 'GET' && path === '/students') return { status: 200, body: page1([student]) };
      if (method === 'GET' && path === '/students/st1/documents') return { status: 200, body: page1([doc('d1')]) };
      if (method === 'GET' && path === '/students/st1/document-checklist') {
        return {
          status: 200,
          body: {
            studentId: 'st1',
            items: [
              { type: 'b_form', status: 'uploaded', document: doc('d1') },
              { type: 'photo', status: 'missing', document: null },
            ],
            complete: false,
          },
        };
      }
      if (method === 'POST' && path === '/documents/d1/verify') return { status: 200, body: { ...doc('d1'), status: 'verified' } };
      if (method === 'GET' && path.startsWith('/students/st1/')) return { status: 200, body: page1([]) };
      return undefined;
    },
  });
  await open(page, '/students');
  await expect(page.getByRole('row', { name: /Ali Khan/ }).getByText('Documents incomplete')).toBeVisible();

  await open(page, '/students/st1');
  await page.getByRole('tab', { name: 'Documents' }).click();
  const checklist = page.getByTestId('documents.checklist');
  await expect(checklist.getByText('Awaiting check')).toBeVisible();
  await expect(checklist.getByText('Missing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verify B-Form' }).click();
  await expect(page.getByText('B-Form verified.')).toBeVisible();
  expect(calls(requests, 'POST', '/documents/d1/verify')).toHaveLength(1);

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, { me: TEACHER_ME, handler: () => undefined });
  await open(page, '/my-attendance');
  await expect(page.getByRole('link', { name: 'Documents' })).toHaveCount(0);
});

test('approvals: the office sees the Documents section with its count, linking to the queue', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/me/approvals' ? { status: 200, body: { documents: { count: 2, items: QUEUE } } } : undefined,
  });
  await open(page, '/approvals');
  const section = page.getByTestId('approvals.documents');
  await expect(section.getByTestId('approvals.documents.count')).toHaveText('2');
  await expect(section.getByText('Ali Khan · Photo')).toBeVisible();
  await expect(section.getByText('your upload')).toBeVisible();
  await expect(section.getByRole('link', { name: 'Open queue' })).toHaveAttribute('href', '/documents');
});
