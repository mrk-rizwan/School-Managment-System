import { bindOwner, getDb } from '../db/database';
import { enqueue, findItem, listByState, saveItem } from '../db/outbox.repository';
import { resetDevice } from '../test/fake-api';
import { mergeMarksBody, registerNaturalKey } from './coalesce';
import { transition } from './machine';

// slice-15 §7.4 coalescing, against real SQLite (node:sqlite behind expo-sqlite's interface —
// the native module cannot load in Jest; recorded in the WORKLOG).

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7'); // enqueue refuses rows without an owner (§7.6)
});

const key = registerNaturalKey('12', '2026-10-05', 1);
const register = (marks: [string, string][], reason?: string) => ({
  lane: 'submit_register',
  method: 'POST',
  path: '/api/v1/sections/12/submit-register',
  naturalKey: key,
  body: {
    marks: marks.map(([enrolmentId, status]) => ({ enrolmentId, status })),
    ...(reason === undefined ? {} : { reason }),
  },
});

describe('mergeMarksBody', () => {
  test('marks merge by enrolmentId, latest wins; order of first appearance kept', () => {
    const merged = mergeMarksBody(
      {
        marks: [
          { enrolmentId: '1', status: 'present' },
          { enrolmentId: '2', status: 'present' },
        ],
      },
      {
        marks: [
          { enrolmentId: '2', status: 'absent' },
          { enrolmentId: '3', status: 'late' },
        ],
      },
    );
    expect(merged.marks).toEqual([
      { enrolmentId: '1', status: 'present' },
      { enrolmentId: '2', status: 'absent' },
      { enrolmentId: '3', status: 'late' },
    ]);
  });

  test('the reason is kept unless the newer one is non-empty, and left out when none is', () => {
    expect(mergeMarksBody({ marks: [], reason: 'first' }, { marks: [] }).reason).toBe('first');
    expect(mergeMarksBody({ marks: [], reason: 'first' }, { marks: [], reason: '  ' }).reason).toBe(
      'first',
    );
    expect(
      mergeMarksBody({ marks: [], reason: 'first' }, { marks: [], reason: 'second' }).reason,
    ).toBe('second');
    // Never null: the server refuses `reason: null` with a terminal 422 (wave-F review).
    expect(mergeMarksBody({ marks: [] }, { marks: [] })).not.toHaveProperty('reason');
    expect(mergeMarksBody({ marks: [], reason: null }, { marks: [], reason: '' })).not.toHaveProperty(
      'reason',
    );
  });
});

describe('enqueue with a natural key', () => {
  test('two writes to one key while pending → one row, merged', async () => {
    const first = await enqueue(
      register(
        [
          ['1', 'present'],
          ['2', 'present'],
        ],
        'first',
      ),
    );
    const second = await enqueue(register([['2', 'absent']]));
    expect(second).toBe(first);
    const pending = await listByState('pending');
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.body)).toEqual({
      marks: [
        { enrolmentId: '1', status: 'present' },
        { enrolmentId: '2', status: 'absent' },
      ],
      reason: 'first',
    });
  });

  test('a write while the key is sending → a second, pending row; later writes merge into it', async () => {
    const first = await enqueue(register([['1', 'present']]));
    const inFlight = transition((await findItem(first))!, { type: 'send', now: new Date() }).item;
    await saveItem(inFlight);

    const second = await enqueue(register([['1', 'absent']]));
    expect(second).not.toBe(first);
    const third = await enqueue(register([['2', 'late']]));
    expect(third).toBe(second);

    expect((await findItem(first))!.state).toBe('sending');
    expect(JSON.parse((await findItem(first))!.body).marks).toEqual([
      { enrolmentId: '1', status: 'present' },
    ]);
    expect(JSON.parse((await findItem(second))!.body).marks).toEqual([
      { enrolmentId: '1', status: 'absent' },
      { enrolmentId: '2', status: 'late' },
    ]);
  });

  test('the partial unique index refuses a second pending row for one key', async () => {
    await enqueue(register([['1', 'present']]));
    const db = await getDb();
    const now = new Date().toISOString();
    await expect(
      db.runAsync(
        `INSERT INTO outbox (id, lane, method, path, natural_key, body, state, created_at, updated_at)
         VALUES ('dup', 'submit_register', 'POST', '/x', ?, '{}', 'pending', ?, ?)`,
        [key, now, now],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  test('rows without a natural key never coalesce', async () => {
    const lane = { lane: 'device_register', method: 'POST', path: '/api/v1/me/devices' };
    const a = await enqueue({ ...lane, body: { platform: 'android', pushToken: 'a' } });
    const b = await enqueue({ ...lane, body: { platform: 'android', pushToken: 'b' } });
    expect(a).not.toBe(b);
    expect(await listByState('pending')).toHaveLength(2);
  });
});
