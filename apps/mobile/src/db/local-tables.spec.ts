import { Image } from 'expo-image';
import { loseSession, wipeAll } from '../auth/wipe';
import { transition, type OutboxItem } from '../outbox/machine';
import { resetDevice } from '../test/fake-api';
import { DOCUMENT, fileExists, filesUnder, putFile } from '../test/file-system';
import { TODAY } from '../test/fixtures';
import { databaseFileExists } from '../test/sqlite-adapter';
import {
  bindOwner,
  DATABASE_NAME,
  discardExpiredUnsent,
  getDb,
  UNSENT_WINDOW_MS,
  wipeForSessionLoss,
} from './database';
import {
  discardItem,
  listLocalDiaryEntries,
  markDiarySaved,
  readRegister,
  recoverWaitingAttachments,
  resendWithRemedy,
  saveDiaryEntry,
  saveRegister,
  saveRemark,
} from './local.repository';
import { findItem, listByState, purgeFinished, saveItem } from './outbox.repository';

// slice-16 §8: the local domain tables' lifecycle, every row of the table, against real SQLite.

const OUTBOX_DIR = `${DOCUMENT}outbox`;
const T0 = new Date('2026-10-04T04:00:00.000Z');
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7');
});

async function count(table: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/** Drives an outbox row through the pure machine: send, then the server's answer. */
async function finish(id: string, status: number, at: Date = T0): Promise<OutboxItem> {
  const item = (await findItem(id))!;
  const sending = transition(item, { type: 'send', now: at }).item;
  const done = transition(sending, {
    type: 'outcome',
    outcome: {
      kind: 'response',
      status,
      code: status >= 400 ? 'X' : null,
      message: null,
      retryAfterSeconds: null,
    },
    now: at,
  }).item;
  await saveItem(done);
  return done;
}

function photo(id: string) {
  putFile(`${OUTBOX_DIR}/${id}.jpg`, 300_000);
  return { id, fileName: `${id}.jpg`, mime: 'image/jpeg', sizeBytes: 300_000 };
}

const register = (marks: [string, 'present' | 'absent'][]) => ({
  sectionId: '12',
  date: TODAY,
  period: 1,
  mode: 'new' as const,
  marks: marks.map(([enrolmentId, status]) => ({ enrolmentId, status })),
});

describe('save', () => {
  test('the local row and the outbox row are written together, pointing at each other', async () => {
    const { localRegisterId, outboxId } = await saveRegister(register([['101', 'absent']]), T0);
    const item = (await findItem(outboxId))!;
    expect(item).toMatchObject({ domainTable: 'local_registers', domainId: localRegisterId });
    expect((await readRegister('12', TODAY, 1))?.outbox?.id).toBe(outboxId);
  });

  test('a failure in either write leaves neither', async () => {
    await saveDiaryEntry('12', { date: TODAY, subjectId: '7', topic: 'One' }, photo('p1'), T0);
    // The same photo id again: the attachment insert fails, so the entry and its outbox row roll back.
    await expect(
      saveDiaryEntry('12', { date: TODAY, subjectId: '8', topic: 'Two' }, photo('p1'), T0),
    ).rejects.toThrow();
    expect(await count('local_diary_entries')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect(await count('local_attachments')).toBe(1);
  });

  test('two offline edits of one register: one outbox row, one local row, marks = the merged body', async () => {
    await saveRegister(
      register([
        ['101', 'present'],
        ['102', 'present'],
      ]),
      T0,
    );
    await saveRegister({ ...register([['102', 'absent']]), mode: 'new' }, T0);
    expect(await listByState('pending')).toHaveLength(1);
    expect(await count('local_registers')).toBe(1);
    const local = (await readRegister('12', TODAY, 1))!;
    const body = JSON.parse((await listByState('pending'))[0]!.body) as {
      marks: { enrolmentId: string; status: string }[];
    };
    expect(local.marks.map((m) => [m.enrolmentId, m.status]).sort()).toEqual(
      body.marks.map((m) => [m.enrolmentId, m.status]).sort(),
    );
  });

  test('an edit while sending: a second pending row, the same local row repointed to it', async () => {
    const first = await saveRegister(register([['101', 'present']]), T0);
    const item = (await findItem(first.outboxId))!;
    await saveItem(transition(item, { type: 'send', now: T0 }).item);
    const second = await saveRegister(register([['101', 'absent']]), T0);
    expect(second.outboxId).not.toBe(first.outboxId);
    expect(second.localRegisterId).toBe(first.localRegisterId);
    const local = (await readRegister('12', TODAY, 1))!;
    expect(local.outbox?.id).toBe(second.outboxId);
    expect(local.marks).toEqual([
      { enrolmentId: '101', status: 'absent', note: null, arrivedAt: null },
    ]);
  });
});

describe('outbox done and failed', () => {
  test('done: the row is kept and says saved on server; purged with its outbox row after 7 days', async () => {
    const { outboxId } = await saveDiaryEntry(
      '12',
      { date: TODAY, subjectId: '7', topic: 'One' },
      null,
      T0,
    );
    await finish(outboxId, 201);
    await markDiarySaved(outboxId, '300', T0);
    const [entry] = await listLocalDiaryEntries('12');
    expect(entry).toMatchObject({
      serverId: '300',
      state: 'done',
      savedOnServerAt: T0.toISOString(),
    });
    expect(await purgeFinished(new Date(T0.getTime() + 6 * DAY))).toBe(0);
    expect(await count('local_diary_entries')).toBe(1);
    expect(await purgeFinished(new Date(T0.getTime() + 8 * DAY))).toBe(1);
    expect(await count('local_diary_entries')).toBe(0);
  });

  test('failed: the row is kept with its failed outbox row, and purged with it after 7 days', async () => {
    const { outboxId } = await saveRemark(
      '501',
      { date: TODAY, category: 'general', text: 'Good' },
      T0,
    );
    await finish(outboxId, 409);
    expect(await count('local_remarks')).toBe(1);
    await purgeFinished(new Date(T0.getTime() + 8 * DAY));
    expect(await count('local_remarks')).toBe(0);
  });
});

describe('discard and remedy', () => {
  test('discard: the outbox row, the local row and the photo file go together', async () => {
    const { outboxId } = await saveDiaryEntry(
      '12',
      { date: TODAY, subjectId: '7', topic: 'One' },
      photo('p2'),
      T0,
    );
    expect(fileExists(`${OUTBOX_DIR}/p2.jpg`)).toBe(true);
    await discardItem(outboxId);
    expect(await count('outbox')).toBe(0);
    expect(await count('local_diary_entries')).toBe(0);
    expect(await count('local_attachments')).toBe(0);
    expect(fileExists(`${OUTBOX_DIR}/p2.jpg`)).toBe(false);
  });

  test('a remedy makes a new pending row and repoints the local row to it', async () => {
    const { outboxId } = await saveRegister(register([['101', 'absent']]), T0);
    const failed = await finish(outboxId, 409);
    const next = await resendWithRemedy(failed, {
      ...JSON.parse(failed.body),
      reason: 'Checked again',
    });
    expect(next).not.toBe(outboxId);
    expect((await readRegister('12', TODAY, 1))?.outbox?.id).toBe(next);
    expect(await listByState('failed')).toHaveLength(1);
  });
});

describe('the wipes', () => {
  test('wipeAll: the file, the outbox folder and the image cache', async () => {
    await saveDiaryEntry('12', { date: TODAY, subjectId: '7', topic: 'One' }, photo('p3'), T0);
    await wipeAll();
    expect(databaseFileExists(DATABASE_NAME)).toBe(false);
    expect(filesUnder(OUTBOX_DIR)).toEqual([]);
    expect(Image.clearDiskCache).toHaveBeenCalled();
  });

  test('session loss keeps the unsent writes and their waiting photos, and deletes the rest', async () => {
    // Kept: a pending register, a pending entry with a waiting photo.
    await saveRegister(register([['101', 'absent']]), T0);
    await saveDiaryEntry('12', { date: TODAY, subjectId: '7', topic: 'Kept' }, photo('kept'), T0);
    // Deleted: a done remark, a failed entry with a waiting photo.
    const done = await saveRemark('501', { date: TODAY, category: 'general', text: 'Done' }, T0);
    await finish(done.outboxId, 201);
    const failed = await saveDiaryEntry(
      '12',
      { date: TODAY, subjectId: '8', topic: 'Gone' },
      photo('gone'),
      T0,
    );
    await finish(failed.outboxId, 422);

    const kept = await loseSession();
    expect(kept).toBe(2);
    expect(await count('local_registers')).toBe(1);
    expect(await count('local_remarks')).toBe(0);
    expect((await listLocalDiaryEntries('12')).map((e) => e.topic)).toEqual(['Kept']);
    expect(await count('local_attachments')).toBe(1);
    expect(fileExists(`${OUTBOX_DIR}/kept.jpg`)).toBe(true);
    expect(fileExists(`${OUTBOX_DIR}/gone.jpg`)).toBe(false);
    expect(Image.clearDiskCache).toHaveBeenCalled();
  });

  test('past the 7-day unsent window the kept rows go with their outbox rows', async () => {
    await saveRegister(register([['101', 'absent']]), T0);
    await saveDiaryEntry('12', { date: TODAY, subjectId: '7', topic: 'Kept' }, photo('p4'), T0);
    await wipeForSessionLoss(T0);
    const discarded = await discardExpiredUnsent(new Date(T0.getTime() + UNSENT_WINDOW_MS + 1));
    expect(discarded.map((d) => d.lane).sort()).toEqual(['diary_entry', 'submit_register']);
    expect(await count('local_registers')).toBe(0);
    expect(await count('local_diary_entries')).toBe(0);
    expect(await count('local_attachments')).toBe(0);
  });
});

describe('startup', () => {
  test('recoverWaitingAttachments queues a photo whose entry already has a server id, once', async () => {
    const { localEntryId } = await saveDiaryEntry(
      '12',
      { date: TODAY, subjectId: '7', topic: 'One' },
      photo('p5'),
      T0,
    );
    // A crash between writing the server id and queueing the photo.
    const db = await getDb();
    await db.runAsync(
      "UPDATE local_diary_entries SET server_id = '300', state = 'done' WHERE id = ?",
      [localEntryId],
    );
    expect(await recoverWaitingAttachments(T0)).toBe(1);
    expect(await recoverWaitingAttachments(T0)).toBe(0);
    const photos = (await listByState('pending')).filter((i) => i.lane === 'diary_attachment');
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/diary-entries/300' });
  });

  test('a photo whose entry was discarded is marked failed', async () => {
    const { localEntryId } = await saveDiaryEntry(
      '12',
      { date: TODAY, subjectId: '7', topic: 'One' },
      photo('p6'),
      T0,
    );
    const db = await getDb();
    await db.runAsync("UPDATE local_diary_entries SET state = 'discarded' WHERE id = ?", [
      localEntryId,
    ]);
    await recoverWaitingAttachments(T0);
    expect(await db.getFirstAsync("SELECT state FROM local_attachments WHERE id = 'p6'")).toEqual({
      state: 'failed',
    });
  });
});
