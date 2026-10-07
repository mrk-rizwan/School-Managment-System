import { queryClient } from '../api/query-client';
import { queryKeys } from '../api/query-keys';
import { cacheKey, readCache, writeCache } from '../db/cache';
import { bindOwner } from '../db/database';
import {
  getAttachment,
  listLocalDiaryEntries,
  listLocalRemarks,
  readRegister,
  saveDiaryEntry,
  saveRegister,
  saveRemark,
} from '../db/local.repository';
import * as outbox from '../db/outbox.repository';
import { listByState } from '../db/outbox.repository';
import {
  installFakeApi,
  resetDevice,
  SERVER_DATE,
  submitRegisterProblem,
} from '../test/fake-api';
import { DOCUMENT, putFile } from '../test/file-system';
import { recorded, registerView, TODAY } from '../test/fixtures';
import { onSaved, outboxWorker, sendItem } from './runtime';
import { OutboxWorker } from './worker';

// slice-16 §10.3 (outbox/follow-ups.spec.ts): each lane's follow-up after the server's 2xx.

const NOW = new Date('2026-10-04T04:00:00.000Z');

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7');
});

/**
 * Runs the queue to rest. A follow-up that queues a write triggers the app's own worker too, and
 * since the claim is atomic (wave N review) whichever worker claims an item sends it: wait for both.
 */
async function run() {
  const worker = new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true, onSaved });
  await worker.trigger('enqueued');
  await worker.idle();
  await outboxWorker.idle();
  await worker.idle();
}

const summary = { roster: 3, marked: 3, present: 2, absent: 1, late: 0, onLeave: 0 };

test('submit_register with no view on the phone: the server register id, the response time and the counts; its keys invalidated', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  installFakeApi({
    'POST /api/v1/sections/12/submit-register': () => ({
      status: 201,
      body: {
        register: recorded(registerView()).register,
        summary,
        marks: [],
        created: true,
        alerts: {},
      },
    }),
  });
  await saveRegister(
    {
      sectionId: '12',
      date: TODAY,
      period: 1,
      mode: 'new',
      marks: [{ enrolmentId: '101', status: 'absent' }],
    },
    NOW,
  );
  await run();
  const local = await readRegister('12', TODAY, 1);
  expect(local).toMatchObject({
    serverRegisterId: '900',
    savedOnServerAt: new Date(SERVER_DATE).toISOString(),
    summary,
  });
  const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
  expect(keys).toContain(JSON.stringify(queryKeys.register('12', TODAY, 1)));
  expect(keys).toContain(JSON.stringify(['attendance-registers', TODAY]));
  expect(keys).toContain(JSON.stringify(['attendance-reports']));
});

test('submit_register with the view on the phone: the view is rebuilt from the response, never refetched (R160)', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const view = registerView();
  const key = queryKeys.register('12', TODAY, 1);
  const cacheRowKey = cacheKey('/api/v1/sections/12/register', { date: TODAY, period: 1 });
  await writeCache(cacheRowKey, view, SERVER_DATE);
  queryClient.setQueryData(key, { body: view, serverTime: new Date(SERVER_DATE).toISOString(), serverTimeIsDevice: false });
  const done = recorded(view);
  const fake = installFakeApi({
    'POST /api/v1/sections/12/submit-register': () => ({
      status: 201,
      body: {
        register: done.register,
        summary,
        marks: done.roster.map((row, i) => ({
          ...row.mark!,
          status: i === 0 ? 'absent' : 'present',
          outcome: 'created',
        })),
        created: true,
        alerts: {},
      },
    }),
  });
  await saveRegister(
    {
      sectionId: '12',
      date: TODAY,
      period: 1,
      mode: 'new',
      marks: view.roster.map((row, i) => ({
        enrolmentId: row.enrolmentId,
        status: i === 0 ? 'absent' : 'present',
      })),
    },
    NOW,
  );
  await run();
  const next = queryClient.getQueryData<{ body: typeof view }>(key)!.body;
  expect(next.register?.id).toBe('900');
  expect(next.roster.map((r) => r.mark?.status)).toEqual(['absent', 'present', 'present']);
  expect(next.roster[0]!.mark).not.toHaveProperty('outcome');
  // The offline copy is the same view.
  expect((await readCache<typeof view>(cacheRowKey))!.body.register?.id).toBe('900');
  // Only the POST went out; the register key was not invalidated (no refetch of the roster).
  expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /api/v1/sections/12/submit-register',
  ]);
  // The lane asks for the minimal answer; the view was rebuilt from what was sent plus the ids.
  expect(fake.calls[0]!.headers.get('Prefer')).toBe('return=minimal');
  expect(next.roster[0]!.mark).toMatchObject({
    id: 'm101',
    enrolmentId: '101',
    studentId: '501',
    registerId: '900',
    status: 'absent',
    note: null,
    arrivedAt: null,
    amended: false,
  });
  const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
  expect(keys).not.toContain(JSON.stringify(key));
  expect(keys).toContain(JSON.stringify(['attendance-registers', TODAY]));
});

test('submit_register from a server that ignores Prefer: the full answer is read instead', async () => {
  const view = registerView();
  const key = queryKeys.register('12', TODAY, 1);
  queryClient.setQueryData(key, {
    body: view,
    serverTime: new Date(SERVER_DATE).toISOString(),
    serverTimeIsDevice: false,
  });
  const done = recorded(view);
  installFakeApi({
    'POST /api/v1/sections/12/submit-register': () => ({
      status: 201,
      ignorePrefer: true,
      body: {
        register: done.register,
        summary,
        marks: done.roster.map((row) => ({ ...row.mark!, note: 'from the server', outcome: 'created' })),
        created: true,
        alerts: {},
      },
    }),
  });
  await saveRegister(
    {
      sectionId: '12',
      date: TODAY,
      period: 1,
      mode: 'new',
      marks: view.roster.map((row) => ({ enrolmentId: row.enrolmentId, status: 'present' })),
    },
    NOW,
  );
  await run();
  const next = queryClient.getQueryData<{ body: typeof view }>(key)!.body;
  // The full shape's own fields, not a rebuild from the request.
  expect(next.roster.map((r) => r.mark?.note)).toEqual(Array(3).fill('from the server'));
});

test('two offline edits of one register merge into one body the server accepts: sent and saved (wave-F review)', async () => {
  let posted: Record<string, unknown> | null = null;
  installFakeApi({
    'POST /api/v1/sections/12/submit-register': (request) => {
      posted = request.body as Record<string, unknown>;
      return {
        status: 201,
        body: { register: recorded(registerView()).register, summary, marks: [], created: true, alerts: {} },
      };
    },
  });
  const edit = (status: 'present' | 'absent') =>
    saveRegister(
      {
        sectionId: '12',
        date: TODAY,
        period: 1,
        mode: 'new',
        marks: [
          { enrolmentId: '101', status },
          { enrolmentId: '102', status: 'present' },
        ],
      },
      NOW,
    );
  await edit('present');
  await edit('absent');
  expect(await listByState('pending')).toHaveLength(1);
  await run();
  expect(posted).not.toBeNull();
  expect(posted!).not.toHaveProperty('reason');
  expect(posted!.marks).toEqual([
    { enrolmentId: '101', status: 'absent' },
    { enrolmentId: '102', status: 'present' },
  ]);
  expect(await listByState('done')).toHaveLength(1);
  expect(await readRegister('12', TODAY, 1)).toMatchObject({ serverRegisterId: '900' });
});

test('the fake API refuses a submit as the server does: reason null or too short is a 422', () => {
  const body = { date: TODAY, period: 1, marks: [{ enrolmentId: '101', status: 'present' }] };
  expect(submitRegisterProblem(body)).toBeNull();
  expect(submitRegisterProblem({ ...body, reason: null })).toBe('reason');
  expect(submitRegisterProblem({ ...body, reason: 'no' })).toBe('reason');
  expect(submitRegisterProblem({ ...body, reason: 'Corrected after roll call' })).toBeNull();
  expect(submitRegisterProblem({ ...body, marks: [] })).toBe('marks');
  expect(
    submitRegisterProblem({ ...body, marks: [{ enrolmentId: '101', status: 'present', arrivedAt: '08:40' }] }),
  ).toBe('marks[0].arrivedAt');
  expect(submitRegisterProblem({ ...body, sectionName: 'A' })).toBe('sectionName');
});

test('diary_entry: the server id, then each waiting photo is queued exactly once', async () => {
  putFile(`${DOCUMENT}outbox/p1.jpg`);
  installFakeApi({
    'POST /api/v1/sections/12/diary-entries': () => ({
      status: 201,
      body: { id: '300', sectionId: '12' },
    }),
    // The photo's own sends fail for now: it stays queued, never queued twice.
    'POST /api/v1/uploads': () => 'network',
  });
  await saveDiaryEntry(
    '12',
    { date: TODAY, subjectId: '7', topic: 'Board work' },
    { id: 'p1', fileName: 'p1.jpg', mime: 'image/jpeg', sizeBytes: 1000 },
    NOW,
  );
  await run();
  const [entry] = await listLocalDiaryEntries('12');
  expect(entry).toMatchObject({ serverId: '300', state: 'done' });
  expect(await getAttachment('p1')).toMatchObject({ state: 'queued' });
  const photos = (await listByState('pending')).filter((i) => i.lane === 'diary_attachment');
  expect(photos).toHaveLength(1);
  expect(photos[0]!.path).toBe('/api/v1/diary-entries/300');
  await run();
  expect((await listByState('pending')).filter((i) => i.lane === 'diary_attachment')).toHaveLength(
    1,
  );
});

test('remark: the server id; the student remarks invalidated', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  installFakeApi({
    'POST /api/v1/students/501/remarks': () => ({ status: 201, body: { id: '77' } }),
  });
  await saveRemark('501', { date: TODAY, category: 'general', text: 'Good work' }, NOW);
  await run();
  expect((await listLocalRemarks('501'))[0]).toMatchObject({ serverId: '77', state: 'done' });
  expect(invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))).toContain(
    JSON.stringify(['students', '501', 'remarks']),
  );
});

test('a malformed 2xx body is ignored: the item is still done (the server has it)', async () => {
  installFakeApi({
    'POST /api/v1/students/501/remarks': () => ({ status: 201, body: { surprise: true } }),
  });
  await saveRemark('501', { date: TODAY, category: 'general', text: 'Good work' }, NOW);
  await run();
  expect(await listByState('done')).toHaveLength(1);
  expect((await listLocalRemarks('501'))[0]).toMatchObject({ serverId: null, state: 'done' });
});
