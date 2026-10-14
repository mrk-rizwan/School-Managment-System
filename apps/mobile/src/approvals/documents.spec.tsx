import { ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import type { QueuedDocumentDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { LANES, ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice, type FakeApi } from '../test/fake-api';
import { meFixture } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { ApprovalsScreen } from './ApprovalsScreen';

// Phase 5 slice 40 (contracts/slice-40.md §5, R322): the Documents section of the Approvals tab.
// Verify and reject are online-only; the caller's own upload offers no decision.

const APPROVALS = 'GET /api/v1/me/approvals';

const doc = (id: string, extra: Partial<QueuedDocumentDto> = {}): QueuedDocumentDto => ({
  id,
  studentId: '301',
  type: 'b_form',
  mime: 'image/jpeg',
  sizeBytes: 40_000,
  uploadedBy: '90',
  uploadedByName: 'Sara Office',
  createdAt: '2026-10-06T04:00:00.000Z',
  status: 'uploaded',
  decidedAt: null,
  decidedByName: null,
  rejectReason: null,
  student: { id: '301', admissionNo: '1001', fullName: 'Hamza Tariq', className: 'Class 5', sectionName: 'A' },
  ownUpload: false,
  ...extra,
});

const BODY = { documents: { count: 2, items: [doc('81'), doc('82', { type: 'photo', ownUpload: true })] } };
const office = () => meFixture({ capabilities: ['document.view', 'document.upload', 'document.verify'] });
const reads = (fake: FakeApi) => fake.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/me/approvals').length;

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('R322: verifying and rejecting a document are online-only, never an outbox lane', () => {
  const decisions = ['verify_document', 'reject_document'];
  expect(ONLINE_ONLY_ACTIONS).toEqual(expect.arrayContaining(decisions));
  expect(Object.keys(LANES)).toEqual(expect.not.arrayContaining(decisions));
});

test('the section lists the documents with the count; one\'s own upload is marked', async () => {
  await renderSignedIn(<ApprovalsScreen secure />, office(), { [APPROVALS]: () => ({ status: 200, body: BODY }) });
  expect(await screen.findByText('Documents · 2')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.document.81')).toHaveTextContent(/Hamza Tariq · B-Form.*Class 5 A/);
  expect(screen.getByTestId('approvals.document.82')).toHaveTextContent(/Your upload/);
});

test('verifies a document (the image on tap) and reads the list again', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/documents/81/verify': () => ({ status: 200, body: { ...doc('81'), status: 'verified' } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.document.81'));
  expect(screen.getByTestId('attachment.show')).toBeOnTheScreen();
  // Security L3: an identity scan is never written to the phone's disk cache.
  fireEvent.press(screen.getByTestId('attachment.show'));
  expect(screen.getByTestId('attachment.thumbnail').props.cachePolicy).toBe('none');
  fireEvent.press(screen.getByTestId('attachment.showFull'));
  expect(screen.getByTestId('attachment.full').props.cachePolicy).toBe('none');
  fireEvent.press(screen.getByTestId('approvals.document.verify'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('B-Form verified.'));
  expect(fake.calls.some((c) => c.path === '/api/v1/documents/81/verify')).toBe(true);
  await eventually(() => expect(reads(fake)).toBe(2));
});

test('rejects a document with a reason', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/documents/81/reject': () => ({ status: 200, body: { ...doc('81'), status: 'rejected' } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.document.81'));
  fireEvent.press(screen.getByTestId('approvals.document.reject'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'The scan is blurred');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('B-Form rejected.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/documents/81/reject')?.body).toEqual({ reason: 'The scan is blurred' });
});

test('one\'s own upload cannot be decided; a decision taken elsewhere shows the server\'s word', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/documents/81/verify': () => ({
      status: 409,
      body: errorBody(ErrorCode.DOCUMENT_ALREADY_DECIDED, 'This document has already been decided.'),
    }),
  });
  fireEvent.press(await screen.findByTestId('approvals.document.82'));
  expect(screen.getByTestId('approvals.document.own')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.document.verify')).toBeDisabled();
  expect(screen.getByTestId('approvals.document.reject')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Close'));

  fireEvent.press(await screen.findByTestId('approvals.document.81'));
  fireEvent.press(screen.getByTestId('approvals.document.verify'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('This document has already been decided.'));
  await eventually(() => expect(reads(fake)).toBe(2));
});
