import type { AssessmentSubmitMarksDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { bindOwner } from '../db/database';
import { readLocalMarks, saveMarks } from '../db/local-marks.repository';
import { saveRegister } from '../db/local.repository';
import * as outbox from '../db/outbox.repository';
import { listByState } from '../db/outbox.repository';
import { installFakeApi, resetDevice, type FakeRequest } from '../test/fake-api';
import { recorded, registerView, TODAY } from '../test/fixtures';
import { onSaved, outboxWorker, sendItem } from './runtime';
import { OutboxWorker, type WorkerStore } from './worker';

// Wave N review: the worker claims a pending row atomically and sends the row as claimed. A Save
// that merges into the row between the scan and the claim is sent with it; before the fix the
// send transition wrote back the body the scan had read, and the merged entry was lost (for
// marks, its local row was then deleted as "omitted by the server").

const NOW = new Date('2026-10-04T04:00:00.000Z');

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7');
});
afterEach(() => queryClient.clear());

/** A store whose scan lets `during` run after the due rows are read, before they are claimed. */
function racingStore(during: () => Promise<void>): WorkerStore {
  let ran = false;
  return {
    ...outbox,
    async listDue(now: Date) {
      const due = await outbox.listDue(now);
      if (!ran) {
        ran = true;
        await during();
      }
      return due;
    },
  };
}

async function run(store: WorkerStore) {
  const worker = new OutboxWorker({ store, send: sendItem, isOnline: () => true, onSaved });
  await worker.trigger('enqueued');
  await worker.idle();
  await outboxWorker.idle();
}

test('marks_enter: a Save that coalesces during a scan is sent, and its local mark is kept', async () => {
  const sent: AssessmentSubmitMarksDto[] = [];
  installFakeApi({
    'POST /api/v1/assessments/500/submit-marks': (request: FakeRequest) => {
      const body = request.body as AssessmentSubmitMarksDto;
      sent.push(body);
      return {
        status: 200,
        body: {
          assessmentId: '500',
          entries: body.entries.map((e) => ({
            clientEntryKey: e.clientEntryKey,
            enrolmentId: e.enrolmentId,
            markId: `m-${e.enrolmentId}`,
            outcome: 'created',
          })),
        },
      };
    },
  });
  await saveMarks({ serverId: '500' }, [
    { enrolmentId: 'e1', obtained: 5, absent: false, basedOnMarkId: null },
  ]);
  await run(
    racingStore(() =>
      saveMarks({ serverId: '500' }, [
        { enrolmentId: 'e2', obtained: 7, absent: false, basedOnMarkId: null },
      ]),
    ),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]!.entries.map((e) => e.enrolmentId)).toEqual(['e1', 'e2']);
  const marks = await readLocalMarks({ serverId: '500' });
  expect(marks.map((m) => [m.enrolmentId, m.state, m.serverMarkId])).toEqual([
    ['e1', 'done', 'm-e1'],
    ['e2', 'done', 'm-e2'],
  ]);
  expect(await listByState('pending')).toEqual([]);
});

test('submit_register: a Save that coalesces during a scan is sent with the first', async () => {
  const sent: { marks: { enrolmentId: string; status: string }[] }[] = [];
  installFakeApi({
    'POST /api/v1/sections/12/submit-register': (request: FakeRequest) => {
      sent.push(request.body as (typeof sent)[number]);
      return {
        status: 201,
        body: {
          register: recorded(registerView()).register,
          summary: { roster: 3, marked: 2, present: 1, absent: 1, late: 0, onLeave: 0 },
          marks: [],
          created: true,
          alerts: {},
        },
      };
    },
  });
  const register = (enrolmentId: string, status: 'present' | 'absent') =>
    saveRegister(
      { sectionId: '12', date: TODAY, period: 1, mode: 'new', marks: [{ enrolmentId, status }] },
      NOW,
    );
  await register('101', 'absent');
  await run(racingStore(() => register('102', 'present').then(() => undefined)));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.marks).toEqual([
    { enrolmentId: '101', status: 'absent' },
    { enrolmentId: '102', status: 'present' },
  ]);
  expect(await listByState('pending')).toEqual([]);
});

test('a row that left pending before the claim is not sent again', async () => {
  let posts = 0;
  installFakeApi({
    'POST /api/v1/assessments/500/submit-marks': () => {
      posts += 1;
      return { status: 200, body: { assessmentId: '500', entries: [] } };
    },
  });
  await saveMarks({ serverId: '500' }, [
    { enrolmentId: 'e1', obtained: 5, absent: false, basedOnMarkId: null },
  ]);
  const [item] = await listByState('pending');
  await run(
    racingStore(async () => {
      await outbox.claimPending(item!.id, NOW);
    }),
  );
  expect(posts).toBe(0);
  expect(await outbox.findItem(item!.id)).toMatchObject({ state: 'sending', attempts: 1 });
});
