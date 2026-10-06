import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { launchCameraAsync } from 'expo-image-picker';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import { Share } from 'react-native';
import type { MyClaimDto, MyDuesDto, MyReceiptDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { bindOwner, getDb } from '../db/database';
import { listLocalClaims, markClaimSaved, saveClaim } from '../db/local.repository';
import { listByState } from '../db/outbox.repository';
import { resetDevice } from '../test/fake-api';
import { CACHE, DOCUMENT, fileExists, filesUnder, putFile } from '../test/file-system';
import { guardianMe, TODAY } from '../test/fixtures';
import { IDENTITY_PATTERN, PHONE_PATTERN } from '../test/patterns';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { DepositSlipScreen } from './DepositSlipScreen';
import { receiptText } from './fees';
import { FeesScreen } from './FeesScreen';

// Phase 3 slice 21 (§3.9, R198, R199): a child's Fees — dues, slips and receipts rendered natively
// and shared as text, FLAG_SECURE — and a deposit slip saved in airplane mode, then sent.

const DUES: MyDuesDto = {
  studentId: '501',
  academicYearId: null,
  outstanding: 6000,
  advance: 0,
  nextDueOn: '2026-10-10',
  charges: [
    {
      id: 'ch1',
      academicYearId: '3',
      feeHeadName: 'Tuition',
      kind: 'generated',
      period: '2026-09',
      description: 'Tuition September 2026',
      dueOn: '2026-09-10',
      grossAmount: 3000,
      concessionAmount: 0,
      amount: 3000,
      paidAmount: 0,
      creditedAmount: 0,
      outstanding: 3000,
      status: 'open',
    },
  ],
  claimsAccepted: true,
};

const CLAIM: MyClaimDto = {
  id: '77',
  studentId: '501',
  method: 'bank_transfer',
  claimedAmount: 4000,
  paidOn: '2026-10-02',
  reference: 'MZN-778812',
  note: null,
  hasImage: true,
  submittedByMe: false,
  status: 'verified',
  decidedAt: '2026-10-05T04:00:00.000Z',
  decisionReason: 'The slip shows Rs 3,500',
  verifiedAmount: 3500,
  verifiedPaidOn: null,
  receiptId: '9',
  createdAt: '2026-10-04T04:00:00.000Z',
};

const RECEIPT: MyReceiptDto = {
  id: '9',
  receiptLabel: '17/2026-27',
  academicYearId: '3',
  academicYearName: '2026-27',
  amount: 6000,
  paidOn: '2026-10-01',
  method: 'cash',
  lines: [{ studentId: '501', studentName: 'Ali Raza', feeHeadName: 'Tuition', period: '2026-09', amount: 3000 }],
  otherChildrenAmount: 3000,
  issuedAt: '2026-10-01T04:00:00.000Z',
  voidedAt: null,
};

const page = <T,>(data: T[]) => ({ data, page: 1, limit: 10, total: data.length });
const READS = {
  'GET /api/v1/me/children/501/dues': () => ({ status: 200, body: DUES }),
  'GET /api/v1/me/children/501/payment-claims': () => ({ status: 200, body: page([CLAIM]) }),
  'GET /api/v1/me/receipts': () => ({ status: 200, body: page([RECEIPT]) }),
};

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('the Fees screen: dues, a verified slip with the office reason, a receipt rendered natively and shared as text; secure', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  await renderSignedIn(<FeesScreen studentId="501" secure />, guardianMe(), READS);
  expect(await screen.findByTestId('fees.outstanding')).toHaveTextContent(/Rs 6,000/);
  expect(screen.getByTestId('fees.charge.ch1')).toHaveTextContent(/Tuition Sep 2026/);
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
  fireEvent.press(await screen.findByTestId('fees.claim.77'));
  expect(await screen.findByText('The slip shows Rs 3,500')).toBeOnTheScreen();
  expect(screen.queryByTestId('fees.claim.withdraw')).toBeNull();
  fireEvent.press(screen.getByTestId('fees.claimSheet.close'));

  fireEvent.press(await screen.findByTestId('fees.receipt.9'));
  expect(await screen.findByText('Other children')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('fees.receipt.share'));
  const text = share.mock.calls[0]![0] as { message: string };
  expect(text.message).toBe(receiptText(RECEIPT, guardianMe().school.name));
  expect(text.message).toContain('Ali Raza: Tuition Sep 2026: Rs 3,000');
  expect(text.message).not.toMatch(IDENTITY_PATTERN);
  expect(text.message).not.toMatch(PHONE_PATTERN);

  fireEvent.press(screen.getByTestId('fees.upload'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/children/[studentId]/deposit-slip', params: { studentId: '501' } });
});

test('no payment account: no upload button, the office takes fees', async () => {
  await renderSignedIn(<FeesScreen studentId="501" secure />, guardianMe(), {
    ...READS,
    'GET /api/v1/me/children/501/dues': () => ({ status: 200, body: { ...DUES, claimsAccepted: false } }),
  });
  expect(await screen.findByText('The school takes fees at the office.')).toBeOnTheScreen();
  expect(screen.queryByTestId('fees.upload')).toBeNull();
});

test('a slip saved in airplane mode: one claim row under its outbox id, the slip waits, then both reach the server and the slip leaves the phone', async () => {
  putFile(`${CACHE}ImagePicker/slip.jpg`, 700_000);
  (launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: `${CACHE}ImagePicker/slip.jpg`, width: 1200, height: 1600, mimeType: 'image/jpeg' }],
  });
  const { fake, view } = await renderSignedIn(<DepositSlipScreen studentId="501" secure />, guardianMe(), {
    'GET /api/v1/me/payment-accounts': () => ({ status: 200, body: page([]) }),
    'POST /api/v1/me/children/501/payment-claims': () => ({ status: 201, body: { ...CLAIM, id: '78', status: 'pending', hasImage: false } }),
    'POST /api/v1/me/uploads': () => ({
      status: 201,
      body: { id: 'u5', mime: 'image/jpeg', sizeBytes: 300_000, expiresAt: '2026-10-07T04:00:00.000Z' },
    }),
    'PATCH /api/v1/me/children/501/payment-claims/78': () => ({ status: 200, body: { ...CLAIM, id: '78', status: 'pending' } }),
  });
  setOnline(false);
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
  fireEvent.press(await screen.findByTestId('depositSlip.method.jazzcash'));
  fireEvent.changeText(screen.getByTestId('depositSlip.amount'), '3000');
  fireEvent.changeText(screen.getByTestId('depositSlip.reference'), 'JC-4411');
  fireEvent.press(screen.getByTestId('depositSlip.camera'));
  expect(await screen.findByTestId('depositSlip.chosen')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('depositSlip.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());
  // Saved: leaving the screen keeps the slip, which the outbox now owns.
  view.unmount();

  const [item] = await listByState('pending');
  expect([item!.lane, item!.path]).toEqual(['payment_claim', '/api/v1/me/children/501/payment-claims']);
  expect(JSON.parse(item!.body)).toEqual({ method: 'jazzcash', claimedAmount: 3000, paidOn: TODAY, reference: 'JC-4411' });
  const [local] = await listLocalClaims('501');
  expect(local).toMatchObject({ claimedAmount: 3000, state: 'queued', slip: { state: 'waiting', outboxId: null } });
  const file = `${DOCUMENT}outbox/${local!.slip!.fileName}`;
  expect(fileExists(file)).toBe(true);

  setOnline(true);
  await settleOutbox();
  await settleOutbox();
  const calls = fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  expect(calls).toEqual([
    'POST /api/v1/me/children/501/payment-claims',
    'POST /api/v1/me/uploads',
    'PATCH /api/v1/me/children/501/payment-claims/78',
  ]);
  const post = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/payment-claims'))!;
  expect(post.headers.get('Idempotency-Key')).toBe(item!.id);
  expect(post.body).not.toHaveProperty('stagedUploadId');
  expect(fileExists(file)).toBe(false);
});

test('a slip is required, whole rupees only, and no identity number or phone in the text', async () => {
  await renderSignedIn(<DepositSlipScreen studentId="501" secure />, guardianMe(), {
    'GET /api/v1/me/payment-accounts': () => ({ status: 200, body: page([]) }),
  });
  fireEvent.press(await screen.findByTestId('depositSlip.method.bank_transfer'));
  fireEvent.changeText(screen.getByTestId('depositSlip.amount'), '12.50');
  fireEvent.changeText(screen.getByTestId('depositSlip.note'), 'Call 03001234567');
  fireEvent.press(screen.getByTestId('depositSlip.save'));
  expect(await screen.findByTestId('depositSlip.amount.error')).toHaveTextContent('Enter whole rupees, 1 or more.');
  expect(screen.getByTestId('depositSlip.note.error')).toHaveTextContent('Do not type an identity number or a phone number here.');
  expect(screen.getByText('Photograph the slip.')).toBeOnTheScreen();
  expect(await listByState('pending')).toEqual([]);
});

test('a slip picked but never saved is deleted from the phone when the screen goes', async () => {
  putFile(`${CACHE}ImagePicker/slip.jpg`, 700_000);
  (launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: `${CACHE}ImagePicker/slip.jpg`, width: 1200, height: 1600, mimeType: 'image/jpeg' }],
  });
  const { view } = await renderSignedIn(<DepositSlipScreen studentId="501" secure />, guardianMe(), {
    'GET /api/v1/me/payment-accounts': () => ({ status: 200, body: page([]) }),
  });
  fireEvent.press(await screen.findByTestId('depositSlip.camera'));
  expect(await screen.findByTestId('depositSlip.chosen')).toBeOnTheScreen();
  expect(filesUnder(`${DOCUMENT}outbox/`)).toHaveLength(1);
  view.unmount();
  expect(filesUnder(`${DOCUMENT}outbox/`)).toEqual([]);
  expect(await listLocalClaims('501')).toEqual([]);
});

test('a discarded slip reads "Slip discarded", and is not listed on the phone once the server has the claim', async () => {
  const slipFile = (name: string) => {
    putFile(`${DOCUMENT}outbox/${name}`, 300_000);
    return { id: name, fileName: name, mime: 'image/jpeg', sizeBytes: 300_000 };
  };
  const input = { method: 'bank_transfer' as const, claimedAmount: 2000, paidOn: TODAY, reference: '', note: '' };
  // One claim the server lists (77), one that has not reached it; both slips discarded.
  await bindOwner(guardianMe().id, guardianMe().school.id);
  const onServer = await saveClaim('501', input, slipFile('a.jpg'));
  await markClaimSaved(onServer.outboxId, { id: '77' });
  const waiting = await saveClaim('501', { ...input, claimedAmount: 1500 }, slipFile('b.jpg'));
  const db = await getDb();
  await db.runAsync(`UPDATE local_files SET state = 'discarded' WHERE owner_table = 'local_claims'`);
  await renderSignedIn(<FeesScreen studentId="501" secure />, guardianMe(), READS);
  // The server's list must have arrived before "not listed on the phone" can be asserted.
  await screen.findByTestId('fees.claim.77');
  expect(await screen.findByTestId(`fees.local.${waiting.localClaimId}.slip`)).toHaveTextContent('Slip discarded');
  expect(screen.queryByTestId(`fees.local.${onServer.localClaimId}`)).toBeNull();
  expect(screen.queryByText('Slip: with the school')).toBeNull();
});
