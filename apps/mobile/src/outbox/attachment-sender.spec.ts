import { setBearerToken } from '../api/client';
import { bindOwner, getDb } from '../db/database';
import {
  getAttachment,
  markDiarySaved,
  saveDiaryEntry,
  setStagedUpload,
} from '../db/local.repository';
import { findItem, listByState, saveItem } from '../db/outbox.repository';
import * as outbox from '../db/outbox.repository';
import { errorBody, installFakeApi, resetDevice, type Handler } from '../test/fake-api';
import { DOCUMENT, fileExists, putFile } from '../test/file-system';
import { TODAY } from '../test/fixtures';
import { sendAttachment, STAGED_MARGIN_MS } from './attachment-sender';
import { transition } from './machine';
import { onSaved, sendItem } from './runtime';
import { OutboxWorker } from './worker';

// slice-16 §4.5, §10.1 (outbox/attachment-sender.spec.ts): upload then PATCH, through the real
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
  return { fake, outcome: await sendAttachment(item, now) };
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
