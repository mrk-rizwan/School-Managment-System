import { setBearerToken } from '../api/client';
import { bindOwner, getDb } from '../db/database';
import {
  discardItem,
  getAttachment,
  getUploadFile,
  listLocalClaims,
  listLocalExpenses,
  markClaimSaved,
  markDiarySaved,
  markExpenseSaved,
  saveClaim,
  saveDiaryEntry,
  saveExpense,
  setStagedUpload,
} from '../db/local.repository';
import { findItem, listByState, saveItem } from '../db/outbox.repository';
import * as outbox from '../db/outbox.repository';
import { errorBody, installFakeApi, resetDevice, type Handler } from '../test/fake-api';
import { DOCUMENT, fileExists, putFile } from '../test/file-system';
import { TODAY } from '../test/fixtures';
import * as files from '../media/files';
import { logText } from '../platform/log';
import { sendStagedUploadPatch, STAGED_MARGIN_MS } from './staged-upload-sender';
import { SEND_FAILED_ON_PHONE } from './outcome';
import { remedyFor } from './lanes';
import { transition } from './machine';
import { onSaved, outboxWorker, sendItem } from './runtime';
import { OutboxWorker } from './worker';

// slice-16 §4.5, §10.1 (outbox/staged-upload-sender.spec.ts): upload then PATCH, through the real
// client and SQLite; every outcome of the photo lane.

const TOKEN = 'A'.repeat(43);
const FILE = `${DOCUMENT}outbox/p1.jpg`;
const NOW = new Date('2026-10-04T04:00:00.000Z');
const LATER = '2026-10-05T04:00:00.000Z';

const staged = (id = 'u1') => ({ id, mime: 'image/jpeg', sizeBytes: 300_000, expiresAt: LATER });
const entry = { id: '300', sectionId: '12', hasAttachment: true };

/** A diary entry saved with a photo, reached the server as entry 300: its photo row is queued. */
async function queuedPhoto(): Promise<string> {
  putFile(FILE, 300_000);
  const { outboxId } = await saveDiaryEntry(
    '12',
    { date: TODAY, subjectId: '7', topic: 'Board work' },
    { id: 'p1', fileName: 'p1.jpg', mime: 'image/jpeg', sizeBytes: 300_000 },
    NOW,
  );
  const item = (await findItem(outboxId))!;
  await saveItem({ ...item, state: 'done' });
  await markDiarySaved(outboxId, '300', NOW);
  const photo = (await listByState('pending')).find((i) => i.lane === 'diary_attachment');
  return photo!.id;
}

async function send(routes: Record<string, Handler>, now = NOW) {
  const fake = installFakeApi(routes);
  const id = (await listByState('pending')).find((i) => i.lane === 'diary_attachment')!.id;
  const item = (await findItem(id))!;
  return { fake, outcome: await sendStagedUploadPatch(item, now) };
}

const upload = (reply: Handler = () => ({ status: 201, body: staged() })) => ({
  'POST /api/v1/uploads': reply,
});
const patch = (reply: Handler = () => ({ status: 200, body: entry })) => ({
  'PATCH /api/v1/diary-entries/300': reply,
});

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7');
  setBearerToken(TOKEN);
});

test('the photo is queued only once its entry has a server id, as a PATCH of that entry', async () => {
  putFile(FILE, 300_000);
  await saveDiaryEntry(
    '12',
    { date: TODAY, subjectId: '7', topic: 'Board work' },
    { id: 'p1', fileName: 'p1.jpg', mime: 'image/jpeg', sizeBytes: 300_000 },
    NOW,
  );
  expect((await listByState('pending')).map((i) => i.lane)).toEqual(['diary_entry']);
  expect(await getAttachment('p1')).toMatchObject({ state: 'waiting', outboxId: null });
});

test('upload, then PATCH with the staged id: multipart with the bearer, no JSON type, no Origin', async () => {
  await queuedPhoto();
  const { fake, outcome } = await send({ ...upload(), ...patch() });
  expect(outcome).toMatchObject({ kind: 'response', status: 200 });
  const [up, change] = fake.calls;
  expect(up!.path).toBe('/api/v1/uploads');
  expect(up!.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  expect(up!.headers.get('X-App-Version')).toBe('0.1.0');
  expect(up!.headers.get('Content-Type') ?? '').not.toContain('application/json');
  expect(up!.headers.has('Origin')).toBe(false);
  expect(up!.headers.has('Cookie')).toBe(false);
  // The stored photo is the file part, as expo/fetch sends it: its name, its type, its bytes.
  expect(up!.parts).toEqual([
    { field: 'file', filename: 'p1.jpg', type: 'image/jpeg', size: 300_000 },
  ]);
  expect(change!.method).toBe('PATCH');
  expect(change!.body).toEqual({ stagedUploadId: 'u1' });
  expect(change!.headers.has('Idempotency-Key')).toBe(false);
});

test('a staged id that is still fresh is reused: no second upload', async () => {
  await queuedPhoto();
  await setStagedUpload('p1', 'u9', LATER);
  const { fake } = await send({ ...upload(), ...patch() });
  expect(fake.calls.map((c) => c.path)).toEqual(['/api/v1/diary-entries/300']);
  expect(fake.calls[0]!.body).toEqual({ stagedUploadId: 'u9' });
});

test('a staged id expiring within five minutes is uploaded again', async () => {
  await queuedPhoto();
  await setStagedUpload(
    'p1',
    'u9',
    new Date(NOW.getTime() + STAGED_MARGIN_MS - 1000).toISOString(),
  );
  const { fake } = await send({
    ...upload(() => ({ status: 201, body: staged('u2') })),
    ...patch(),
  });
  expect(fake.calls.map((c) => c.path)).toEqual(['/api/v1/uploads', '/api/v1/diary-entries/300']);
  expect(fake.calls[1]!.body).toEqual({ stagedUploadId: 'u2' });
});

test.each([
  [413, 'PAYLOAD_TOO_LARGE'],
  [415, 'UNSUPPORTED_MEDIA_TYPE'],
])(
  'an upload refused with %i never heals: a terminal 422 with the server code',
  async (status, code) => {
    await queuedPhoto();
    const { outcome, fake } = await send({
      ...upload(() => ({ status, body: errorBody(code, 'Refused') })),
      ...patch(),
    });
    expect(outcome).toMatchObject({ kind: 'response', status: 422, code });
    expect(fake.calls).toHaveLength(1);
  },
);

test.each([[429], [503], [500]])(
  'an upload answered %i is retried later (not terminal)',
  async (status) => {
    await queuedPhoto();
    const { outcome } = await send({
      ...upload(() => ({ status, body: errorBody('SERVICE_UNAVAILABLE', 'Busy') })),
    });
    expect(outcome).toMatchObject({ kind: 'response', status });
  },
);

test('a network failure during the upload is a network outcome', async () => {
  await queuedPhoto();
  const { outcome } = await send({ ...upload(() => 'network') });
  expect(outcome).toEqual({ kind: 'network' });
});

test('a part the runtime refuses is a terminal failure on the phone, never retried as offline', async () => {
  await queuedPhoto();
  // React Native's { uri, name, type } part, which expo/fetch refuses before sending anything.
  jest
    .spyOn(files, 'outboxUploadFile')
    .mockReturnValue({ uri: FILE, name: 'p1.jpg', type: 'image/jpeg' } as unknown as Blob);
  const { outcome, fake } = await send({ ...upload(), ...patch() });
  expect(fake.calls).toHaveLength(0);
  expect(outcome).toMatchObject({ kind: 'response', status: 422, code: SEND_FAILED_ON_PHONE });
  const item = (await listByState('pending')).find((i) => i.lane === 'diary_attachment')!;
  const sending = transition(item, { type: 'send', now: NOW }).item;
  expect(transition(sending, { type: 'outcome', outcome, now: NOW }).item.state).toBe('failed');
  expect(logText()).toMatch(/error outbox\.send_threw/);
});

test('REFERENCE_NOT_FOUND: the first is a network outcome (re-upload), the second is terminal', async () => {
  await queuedPhoto();
  await setStagedUpload('p1', 'u9', LATER);
  const gone = patch(() => ({
    status: 422,
    body: errorBody('REFERENCE_NOT_FOUND', 'The upload is gone'),
  }));
  const first = await send({ ...upload(), ...gone });
  expect(first.outcome).toEqual({ kind: 'network' });
  expect(await getAttachment('p1')).toMatchObject({ stagedUploadId: null, referenceRetries: 1 });
  const second = await send({ ...upload(), ...gone });
  expect(second.fake.calls.map((c) => c.path)).toEqual([
    '/api/v1/uploads',
    '/api/v1/diary-entries/300',
  ]);
  expect(second.outcome).toMatchObject({
    kind: 'response',
    status: 422,
    code: 'REFERENCE_NOT_FOUND',
  });
});

test('DIARY_ENTRY_LOCKED is terminal', async () => {
  await queuedPhoto();
  const { outcome } = await send({
    ...upload(),
    ...patch(() => ({ status: 409, body: errorBody('DIARY_ENTRY_LOCKED', 'Locked') })),
  });
  expect(outcome).toMatchObject({ kind: 'response', status: 409, code: 'DIARY_ENTRY_LOCKED' });
});

test('the file is gone: a terminal 422 the server never sees', async () => {
  await queuedPhoto();
  const db = await getDb();
  await db.runAsync("UPDATE local_attachments SET file_path = 'missing.jpg' WHERE id = 'p1'");
  const { outcome, fake } = await send({ ...upload(), ...patch() });
  expect(outcome).toMatchObject({ status: 422, code: 'ATTACHMENT_FILE_MISSING' });
  expect(fake.calls).toHaveLength(0);
});

test('a 401 is returned as it is: the machine pauses the queue', async () => {
  await queuedPhoto();
  const { outcome } = await send({
    ...upload(() => ({ status: 401, body: errorBody('AUTH_REQUIRED', 'Sign in') })),
  });
  expect(outcome).toMatchObject({ kind: 'response', status: 401 });
  const item = (await listByState('pending')).find((i) => i.lane === 'diary_attachment')!;
  const sending = transition(item, { type: 'send', now: NOW }).item;
  expect(transition(sending, { type: 'outcome', outcome, now: NOW }).effects).toEqual(['pause']);
});

test('through the worker: done deletes the file and marks the photo done', async () => {
  await queuedPhoto();
  installFakeApi({ ...upload(), ...patch() });
  const worker = new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true, onSaved });
  await worker.trigger('enqueued');
  await worker.idle();
  expect(fileExists(FILE)).toBe(false);
  expect(await getAttachment('p1')).toMatchObject({ state: 'done' });
  expect(await listByState('done')).toEqual(
    expect.arrayContaining([expect.objectContaining({ lane: 'diary_attachment' })]),
  );
});

// --- Phase 3 slice 23 (§3.9, R207): the expense lane and its receipt through the same sender ----

const RECEIPT = `${DOCUMENT}outbox/r1.jpg`;
const expenseInput = {
  category: 'stationery',
  amount: 450,
  spentOn: TODAY,
  description: 'Chalk and dusters',
  method: 'cash',
} as const;
const savedExpense = { id: '900', expenseNo: 12, status: 'pending_approval', hasReceipt: false };

function drain() {
  const worker = new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true, onSaved });
  return worker.trigger('enqueued').then(() => worker.idle());
}

/** An expense with a photographed receipt, saved on the phone. */
async function expenseWithReceipt(): Promise<string> {
  putFile(RECEIPT, 200_000);
  const { outboxId } = await saveExpense(
    expenseInput,
    { id: 'r1', fileName: 'r1.jpg', mime: 'image/jpeg', sizeBytes: 200_000 },
    NOW,
  );
  return outboxId;
}

test('an expense is sent under its outbox id; its receipt waits for the server id, then is uploaded and PATCHed', async () => {
  // One worker here: the app's own, which the follow-up nudges, stays still.
  jest.spyOn(outboxWorker, 'trigger').mockResolvedValue();
  const outboxId = await expenseWithReceipt();
  // The receipt has no outbox row until the expense is on the server.
  expect((await listByState('pending')).map((i) => i.lane)).toEqual(['expense']);
  expect(await getUploadFile('local_files', 'r1')).toMatchObject({ state: 'waiting', outboxId: null });

  const fake = installFakeApi({
    'POST /api/v1/expenses': () => ({ status: 201, body: savedExpense }),
    ...upload(),
    'PATCH /api/v1/expenses/900/receipt': () => ({ status: 200, body: { ...savedExpense, hasReceipt: true } }),
  });
  await drain();
  const [create] = fake.calls;
  expect(create!.headers.get('Idempotency-Key')).toBe(outboxId);
  expect(create!.body).toEqual({ ...expenseInput });
  // The follow-up queued the receipt behind the expense; a second pass sends anything left.
  await drain();
  expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /api/v1/expenses',
    'POST /api/v1/uploads',
    'PATCH /api/v1/expenses/900/receipt',
  ]);
  expect(fake.calls[2]!.body).toEqual({ stagedUploadId: 'u1' });
  expect(fake.calls[2]!.headers.has('Idempotency-Key')).toBe(false);
  // The phone deletes the slip once the server has it.
  expect(fileExists(RECEIPT)).toBe(false);
  expect(await getUploadFile('local_files', 'r1')).toMatchObject({ state: 'done' });
  const receipt = (await listByState('done')).find((i) => i.lane === 'expense_receipt')!;
  expect([receipt.path, receipt.domainTable]).toEqual(['/api/v1/expenses/900/receipt', 'local_files']);
  const [local] = await listLocalExpenses();
  expect(local).toMatchObject({ serverId: '900', expenseNo: 12, serverStatus: 'pending_approval', state: 'done' });
});

test('EXPENSE_RECEIPT_EXISTS is terminal: shown, and discarded with its file', async () => {
  await expenseWithReceipt();
  installFakeApi({
    'POST /api/v1/expenses': () => ({ status: 201, body: savedExpense }),
    ...upload(),
    'PATCH /api/v1/expenses/900/receipt': () => ({
      status: 409,
      body: errorBody('EXPENSE_RECEIPT_EXISTS', 'This expense already has a receipt.'),
    }),
  });
  await drain();
  await drain();
  const [failed] = await listByState('failed');
  expect(failed).toMatchObject({ lane: 'expense_receipt', responseCode: 'EXPENSE_RECEIPT_EXISTS' });
  expect(remedyFor(failed!.lane, failed!.responseCode)).toBe('discard');
  await discardItem(failed!.id);
  expect(await getUploadFile('local_files', 'r1')).toBeNull();
  expect(fileExists(RECEIPT)).toBe(false);
});

test('a receipt whose staged upload is gone is uploaded again once', async () => {
  const outboxId = await expenseWithReceipt();
  const item = (await findItem(outboxId))!;
  await saveItem({ ...item, state: 'done' });
  await markExpenseSaved(outboxId, savedExpense, NOW);
  await setStagedUpload('r1', 'u9', LATER, 'local_files');
  const gone = () => ({ status: 422, body: errorBody('REFERENCE_NOT_FOUND', 'The upload is gone') });
  const fake = installFakeApi({ ...upload(), 'PATCH /api/v1/expenses/900/receipt': gone });
  const queued = (await listByState('pending')).find((i) => i.lane === 'expense_receipt')!;
  expect(await sendStagedUploadPatch(queued, NOW)).toEqual({ kind: 'network' });
  expect(await getUploadFile('local_files', 'r1')).toMatchObject({ stagedUploadId: null, referenceRetries: 1 });
  expect(fake.calls.map((c) => c.path)).toEqual(['/api/v1/expenses/900/receipt']);
});

test('a discarded expense takes its waiting receipt and the file', async () => {
  const outboxId = await expenseWithReceipt();
  await discardItem(outboxId);
  expect(await listLocalExpenses()).toEqual([]);
  expect(await getUploadFile('local_files', 'r1')).toBeNull();
  expect(fileExists(RECEIPT)).toBe(false);
});

// --- Phase 3 slice 21 (§3.9, R199, R243): a guardian's deposit claim and its slip --------------

const SLIP = `${DOCUMENT}outbox/s1.jpg`;
const claimInput = { method: 'jazzcash', claimedAmount: 3000, paidOn: TODAY, reference: 'JC-4411' } as const;
const savedClaim = { id: '77', studentId: '501', status: 'pending', hasImage: false };
const slipUpload = (reply: Handler = () => ({ status: 201, body: staged('s9') })) => ({
  'POST /api/v1/me/uploads': reply,
});

/** A deposit claim with its photographed slip, saved on the phone (airplane mode). */
async function claimWithSlip(): Promise<string> {
  putFile(SLIP, 150_000);
  const { outboxId } = await saveClaim(
    '501',
    claimInput,
    { id: 's1', fileName: 's1.jpg', mime: 'image/jpeg', sizeBytes: 150_000 },
    NOW,
  );
  return outboxId;
}

test('a claim is sent under its outbox id; its slip waits, then goes to /me/uploads and is PATCHed onto the claim', async () => {
  jest.spyOn(outboxWorker, 'trigger').mockResolvedValue();
  const outboxId = await claimWithSlip();
  expect((await listByState('pending')).map((i) => i.lane)).toEqual(['payment_claim']);
  expect(await getUploadFile('local_files', 's1')).toMatchObject({ state: 'waiting', outboxId: null });
  const [onPhone] = await listLocalClaims('501');
  expect(onPhone).toMatchObject({ claimedAmount: 3000, serverId: null, slip: { state: 'waiting' } });

  const fake = installFakeApi({
    'POST /api/v1/me/children/501/payment-claims': () => ({ status: 201, body: savedClaim }),
    ...slipUpload(),
    'PATCH /api/v1/me/children/501/payment-claims/77': () => ({ status: 200, body: { ...savedClaim, hasImage: true } }),
  });
  await drain();
  await drain();
  expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /api/v1/me/children/501/payment-claims',
    'POST /api/v1/me/uploads',
    'PATCH /api/v1/me/children/501/payment-claims/77',
  ]);
  expect(fake.calls[0]!.headers.get('Idempotency-Key')).toBe(outboxId);
  expect(fake.calls[0]!.body).toEqual({ ...claimInput });
  expect(fake.calls[2]!.body).toEqual({ stagedUploadId: 's9' });
  // R199: the phone deletes the slip once the server has it.
  expect(fileExists(SLIP)).toBe(false);
  expect(await getUploadFile('local_files', 's1')).toMatchObject({ state: 'done' });
  const [local] = await listLocalClaims('501');
  expect(local).toMatchObject({ serverId: '77', state: 'done', slip: { state: 'done' } });
});

test('CLAIM_IMAGE_EXISTS after a re-upload means an earlier send landed: done, the slip deleted', async () => {
  jest.spyOn(outboxWorker, 'trigger').mockResolvedValue();
  const outboxId = await claimWithSlip();
  const item = (await findItem(outboxId))!;
  await saveItem({ ...item, state: 'done' });
  await markClaimSaved(outboxId, savedClaim, NOW);
  installFakeApi({
    ...slipUpload(),
    'PATCH /api/v1/me/children/501/payment-claims/77': () => ({
      status: 409,
      body: errorBody('CLAIM_IMAGE_EXISTS', 'This claim already has its slip.'),
    }),
  });
  await drain();
  expect(fileExists(SLIP)).toBe(false);
  expect(await getUploadFile('local_files', 's1')).toMatchObject({ state: 'done' });
  expect((await listByState('failed')).length).toBe(0);
});

test('CLAIM_NOT_PENDING (withdrawn, expired, decided) is shown and discarded with its slip', async () => {
  const outboxId = await claimWithSlip();
  const item = (await findItem(outboxId))!;
  await saveItem({ ...item, state: 'done' });
  await markClaimSaved(outboxId, savedClaim, NOW);
  installFakeApi({
    ...slipUpload(),
    'PATCH /api/v1/me/children/501/payment-claims/77': () => ({
      status: 409,
      body: errorBody('CLAIM_NOT_PENDING', 'This claim has already been decided.'),
    }),
  });
  await drain();
  const [failed] = await listByState('failed');
  expect(failed).toMatchObject({ lane: 'payment_claim_image', responseCode: 'CLAIM_NOT_PENDING' });
  expect(remedyFor(failed!.lane, failed!.responseCode)).toBe('discard');
  await discardItem(failed!.id);
  expect(await getUploadFile('local_files', 's1')).toBeNull();
  expect(fileExists(SLIP)).toBe(false);
});

test('a refused claim (CLAIM_LIMIT_REACHED) is discarded with its waiting slip', async () => {
  const outboxId = await claimWithSlip();
  installFakeApi({
    'POST /api/v1/me/children/501/payment-claims': () => ({
      status: 409,
      body: errorBody('CLAIM_LIMIT_REACHED', 'At most 10 deposit slips a day.'),
    }),
  });
  await drain();
  const [failed] = await listByState('failed');
  expect(failed).toMatchObject({ id: outboxId, lane: 'payment_claim', responseCode: 'CLAIM_LIMIT_REACHED' });
  expect(remedyFor('payment_claim', 'CLAIM_LIMIT_REACHED')).toBe('discard');
  await discardItem(outboxId);
  expect(await listLocalClaims('501')).toEqual([]);
  expect(await getUploadFile('local_files', 's1')).toBeNull();
  expect(fileExists(SLIP)).toBe(false);
});
