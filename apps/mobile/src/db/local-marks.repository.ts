import { newIdempotencyKey } from '@asms/shared';
import { z } from 'zod';
import type { AssessmentSubmitMarksDto, MarkEntryResultDto } from '../api/contracts';
import { assessmentNaturalKey } from '../outbox/coalesce';
import {
  buildAssessmentBody,
  buildMarksBody,
  type AssessmentInput,
  type MarkEntryInput,
} from '../outbox/bodies';
import { LANES } from '../outbox/lanes';
import { rebaseEntries } from '../marks/marks-model';
import { getDb, inExclusiveTransaction, type Db } from './database';
import { OUTBOX_COLUMNS, outboxOf, ownedTransaction, type OutboxView } from './local.repository';
import { enqueueIn, rewritePendingIn } from './outbox.repository';

// Phase 4 slice 30 (plan §3.8): the only SQL on local_assessments and local_assessment_marks. A
// class test created offline is a local row with its outbox row (assessment_create, keyed by the
// outbox id); a mark typed on the grid is the latest intent per (assessment, enrolment), with its
// own client entry key and the live mark it was based on. Marks on a test still on the device wait
// (no outbox row) and are queued in the transaction that writes the test's server id — the
// diary_attachment re-target pattern. Ids, numbers and the typed test name only.

export type LocalAssessment = {
  id: string;
  sectionId: string;
  classSubjectId: string;
  subjectId: string;
  testType: AssessmentInput['testType'];
  name: string;
  maxMarks: number;
  heldOn: string;
  serverId: string | null;
  savedOnServerAt: string | null;
  state: 'queued' | 'done' | 'failed' | 'discarded';
  outbox: OutboxView | null;
};

const AssessmentRow = z.object({
  id: z.string(),
  section_id: z.string(),
  class_subject_id: z.string(),
  subject_id: z.string(),
  test_type: z.enum(['daily', 'weekly', 'monthly', 'other']),
  name: z.string(),
  max_marks: z.number(),
  held_on: z.string(),
  server_id: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed', 'discarded']),
});

function assessmentOf(raw: unknown): LocalAssessment {
  const r = AssessmentRow.parse(raw);
  return {
    id: r.id,
    sectionId: r.section_id,
    classSubjectId: r.class_subject_id,
    subjectId: r.subject_id,
    testType: r.test_type,
    name: r.name,
    maxMarks: r.max_marks,
    heldOn: r.held_on,
    serverId: r.server_id,
    savedOnServerAt: r.saved_on_server_at,
    state: r.state,
    outbox: outboxOf(raw),
  };
}

const ASSESSMENT_COLUMNS =
  't.id, t.section_id, t.class_subject_id, t.subject_id, t.test_type, t.name, t.max_marks, ' +
  't.held_on, t.server_id, t.saved_on_server_at, t.state';

export type MarkState = 'waiting' | 'queued' | 'done' | 'changed_elsewhere' | 'failed';

export type LocalAssessmentMark = {
  enrolmentId: string;
  clientEntryKey: string;
  obtained: number | null;
  absent: boolean;
  basedOnMarkId: string | null;
  state: MarkState;
  serverMarkId: string | null;
  updatedAt: string;
  outbox: OutboxView | null;
};

const MarkRow = z.object({
  enrolment_id: z.string(),
  client_entry_key: z.string(),
  obtained: z.number().nullable(),
  absent: z.number(),
  based_on_mark_id: z.string().nullable(),
  state: z.enum(['waiting', 'queued', 'done', 'changed_elsewhere', 'failed']),
  server_mark_id: z.string().nullable(),
  updated_at: z.string(),
});

/** Which test a grid is for: the server's id, or (offline-created, not yet sent) the local id. */
export type AssessmentRef = { serverId: string } | { localId: string };

/**
 * Saves a class test on the device: the local row and its outbox row (the outbox id is the
 * Idempotency-Key), one transaction. `replaces` ("edit and resend"): the failed local test this
 * one replaces; its outbox row is deleted and the marks waiting for it move to the new one.
 */
export async function saveLocalAssessment(
  input: AssessmentInput & { subjectId: string },
  now: Date = new Date(),
  replaces: string | null = null,
): Promise<{ localId: string; outboxId: string }> {
  const body = buildAssessmentBody(input);
  const stamp = now.toISOString();
  const localId = newIdempotencyKey();
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: 'assessment_create',
        method: LANES.assessment_create.method,
        path: LANES.assessment_create.path,
        body,
        domainTable: LANES.assessment_create.domainTable,
        domainId: localId,
      },
      now,
    );
    await txn.runAsync(
      `INSERT INTO local_assessments (id, section_id, class_subject_id, subject_id, test_type, name,
         max_marks, held_on, outbox_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        localId,
        body.sectionId,
        body.classSubjectId,
        input.subjectId,
        body.testType,
        body.name,
        body.maxMarks,
        body.heldOn,
        outboxId,
        stamp,
        stamp,
      ],
    );
    if (replaces !== null) {
      const old = await txn.getFirstAsync<{ outbox_id: string | null }>(
        'SELECT outbox_id FROM local_assessments WHERE id = ?',
        [replaces],
      );
      if (old !== null) {
        await txn.runAsync(
          "UPDATE local_assessment_marks SET local_assessment_id = ? WHERE local_assessment_id = ? AND state = 'waiting'",
          [localId, replaces],
        );
        if (old.outbox_id !== null)
          await txn.runAsync('DELETE FROM outbox WHERE id = ?', [old.outbox_id]);
        await txn.runAsync('DELETE FROM local_assessments WHERE id = ?', [replaces]);
      }
    }
  });
  return { localId, outboxId };
}

/**
 * The follow-up of a test's 2xx: the server id is written and the marks waiting for it are
 * re-targeted and queued as one marks_enter row, in the same transaction. Returns how many marks
 * were queued.
 */
export async function markAssessmentSaved(
  outboxId: string,
  serverId: string | null,
  now: Date = new Date(),
): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const test = await txn.getFirstAsync<{ id: string }>(
      'SELECT id FROM local_assessments WHERE outbox_id = ?',
      [outboxId],
    );
    if (test === null) return;
    const stamp = now.toISOString();
    await txn.runAsync(
      `UPDATE local_assessments SET server_id = COALESCE(?, server_id), saved_on_server_at = ?,
         state = 'done', updated_at = ? WHERE id = ?`,
      [serverId, stamp, stamp, test.id],
    );
    if (serverId !== null) queued = await queueWaitingMarks(txn, test.id, serverId, now);
  });
  return queued;
}

/** Re-targets a local test's waiting marks to its server id and queues them; never one twice. */
async function queueWaitingMarks(
  txn: Db,
  localId: string,
  serverId: string,
  now: Date,
): Promise<number> {
  const waiting = await txn.getAllAsync<unknown>(
    `SELECT enrolment_id, client_entry_key, obtained, absent, based_on_mark_id, state,
       server_mark_id, updated_at FROM local_assessment_marks
     WHERE local_assessment_id = ? AND state = 'waiting' AND outbox_id IS NULL`,
    [localId],
  );
  if (waiting.length === 0) return 0;
  const entries = waiting.map((raw) => {
    const m = MarkRow.parse(raw);
    return {
      enrolmentId: m.enrolment_id,
      obtained: m.obtained,
      absent: m.absent === 1,
      clientEntryKey: m.client_entry_key,
      basedOnMarkId: null,
    };
  });
  const outboxId = await enqueueMarks(txn, serverId, entries, now);
  await txn.runAsync(
    `UPDATE local_assessment_marks SET assessment_id = ?, local_assessment_id = NULL, outbox_id = ?,
       state = 'queued', updated_at = ? WHERE local_assessment_id = ? AND state = 'waiting'`,
    [serverId, outboxId, now.toISOString(), localId],
  );
  return waiting.length;
}

function enqueueMarks(
  txn: Db,
  serverId: string,
  entries: readonly MarkEntryInput[],
  now: Date,
): Promise<string> {
  return enqueueIn(
    txn,
    {
      lane: 'marks_enter',
      method: LANES.marks_enter.method,
      path: `/api/v1/assessments/${serverId}/submit-marks`,
      naturalKey: assessmentNaturalKey(serverId),
      body: buildMarksBody(entries),
      domainTable: LANES.marks_enter.domainTable,
      domainId: serverId,
    },
    now,
  );
}

/** A grid row as typed: a mark or an absence, and the live mark the phone saw (or null). */
export type MarkInput = {
  enrolmentId: string;
  obtained: number | null;
  absent: boolean;
  basedOnMarkId: string | null;
};

/**
 * Saves typed marks on the device (§3.8): each row the latest intent per enrolment with a fresh
 * entry key, and — for a test the server has — one marks_enter row (a pending one absorbs them);
 * for a test still on the device the rows wait. One transaction.
 */
export async function saveMarks(
  ref: AssessmentRef,
  marks: readonly MarkInput[],
  now: Date = new Date(),
): Promise<void> {
  if (marks.length === 0) return;
  const stamp = now.toISOString();
  await ownedTransaction(async (txn) => {
    const serverId = 'serverId' in ref ? ref.serverId : await serverIdOf(txn, ref.localId);
    const entries: MarkEntryInput[] = marks.map((mark) => ({
      enrolmentId: mark.enrolmentId,
      obtained: mark.absent ? null : mark.obtained,
      absent: mark.absent,
      clientEntryKey: newIdempotencyKey(),
      basedOnMarkId: mark.basedOnMarkId,
    }));
    const outboxId = serverId === null ? null : await enqueueMarks(txn, serverId, entries, now);
    for (const entry of entries) {
      const where =
        serverId !== null
          ? { column: 'assessment_id', value: serverId }
          : { column: 'local_assessment_id', value: (ref as { localId: string }).localId };
      await txn.runAsync(
        `DELETE FROM local_assessment_marks WHERE ${where.column} = ? AND enrolment_id = ?`,
        [where.value, entry.enrolmentId],
      );
      await txn.runAsync(
        `INSERT INTO local_assessment_marks (id, assessment_id, local_assessment_id, enrolment_id,
           client_entry_key, obtained, absent, based_on_mark_id, outbox_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.clientEntryKey,
          serverId,
          serverId === null ? (ref as { localId: string }).localId : null,
          entry.enrolmentId,
          entry.clientEntryKey,
          entry.obtained,
          entry.absent ? 1 : 0,
          entry.basedOnMarkId,
          outboxId,
          outboxId === null ? 'waiting' : 'queued',
          stamp,
          stamp,
        ],
      );
    }
  });
}

async function serverIdOf(txn: Db, localId: string): Promise<string | null> {
  const row = await txn.getFirstAsync<{ server_id: string | null }>(
    'SELECT server_id FROM local_assessments WHERE id = ?',
    [localId],
  );
  return row?.server_id ?? null;
}

/**
 * The follow-up of a marks row's 2xx (§3.8): each entry's outcome on its local row (rows re-typed
 * since keep their newer intent), and every entry queued behind it for the same student re-based
 * on the mark this one made, so it does not come back changed_elsewhere.
 */
export async function markMarksSaved(
  outboxId: string,
  assessmentId: string,
  sent: AssessmentSubmitMarksDto,
  results: readonly MarkEntryResultDto[],
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  const basedOn = new Map(sent.entries.map((e) => [e.clientEntryKey, e.basedOnMarkId ?? null]));
  const rebases = results
    .filter((r) => r.outcome !== 'changed_elsewhere' && r.markId !== null)
    .map((r) => ({
      enrolmentId: r.enrolmentId,
      from: basedOn.get(r.clientEntryKey) ?? null,
      to: r.markId!,
    }));
  await inExclusiveTransaction(async (txn) => {
    for (const result of results) {
      await txn.runAsync(
        `UPDATE local_assessment_marks SET state = ?, server_mark_id = ?, updated_at = ?
         WHERE outbox_id = ? AND client_entry_key = ?`,
        [
          result.outcome === 'changed_elsewhere' ? 'changed_elsewhere' : 'done',
          result.markId,
          stamp,
          outboxId,
          result.clientEntryKey,
        ],
      );
    }
    // An entry the server omitted (the student is not on the grid): nothing was written for it,
    // so the row goes and the grid shows the server's.
    await txn.runAsync(
      "DELETE FROM local_assessment_marks WHERE outbox_id = ? AND state = 'queued'",
      [outboxId],
    );
    if (rebases.length === 0) return;
    await rewritePendingIn(
      txn,
      assessmentNaturalKey(assessmentId),
      (raw) => JSON.stringify(rebaseEntries(JSON.parse(raw) as AssessmentSubmitMarksDto, rebases)),
      now,
    );
    for (const rebase of rebases) {
      await txn.runAsync(
        `UPDATE local_assessment_marks SET based_on_mark_id = ? WHERE assessment_id = ? AND enrolment_id = ?
           AND state = 'queued' AND based_on_mark_id IS ?`,
        [rebase.to, assessmentId, rebase.enrolmentId, rebase.from],
      );
    }
  });
}

/** The tests of a section on the device that the server has not answered yet (queued or failed). */
export async function listLocalAssessments(sectionId: string): Promise<LocalAssessment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT ${ASSESSMENT_COLUMNS}, ${OUTBOX_COLUMNS}
     FROM local_assessments t LEFT JOIN outbox o ON o.id = t.outbox_id
     WHERE t.section_id = ? AND t.server_id IS NULL AND t.state != 'discarded'
     ORDER BY t.held_on DESC, t.created_at DESC`,
    [sectionId],
  );
  return rows.map(assessmentOf);
}

export async function getLocalAssessment(localId: string): Promise<LocalAssessment | null> {
  const db = await getDb();
  const raw = await db.getFirstAsync<unknown>(
    `SELECT ${ASSESSMENT_COLUMNS}, ${OUTBOX_COLUMNS}
     FROM local_assessments t LEFT JOIN outbox o ON o.id = t.outbox_id WHERE t.id = ?`,
    [localId],
  );
  return raw === null ? null : assessmentOf(raw);
}

/** The device's marks for a test: every row not yet answered, and the answered ones until purged. */
export async function readLocalMarks(ref: AssessmentRef): Promise<LocalAssessmentMark[]> {
  const db = await getDb();
  const [column, value] =
    'serverId' in ref ? ['assessment_id', ref.serverId] : ['local_assessment_id', ref.localId];
  const rows = await db.getAllAsync<unknown>(
    `SELECT m.enrolment_id, m.client_entry_key, m.obtained, m.absent, m.based_on_mark_id, m.state,
       m.server_mark_id, m.updated_at, ${OUTBOX_COLUMNS}
     FROM local_assessment_marks m LEFT JOIN outbox o ON o.id = m.outbox_id
     WHERE m.${column} = ? ORDER BY m.updated_at`,
    [value],
  );
  return rows.map((raw) => {
    const m = MarkRow.parse(raw);
    return {
      enrolmentId: m.enrolment_id,
      clientEntryKey: m.client_entry_key,
      obtained: m.obtained,
      absent: m.absent === 1,
      basedOnMarkId: m.based_on_mark_id,
      state: m.state,
      serverMarkId: m.server_mark_id,
      updatedAt: m.updated_at,
      outbox: outboxOf(raw),
    };
  });
}

/** "Reload": a changed-elsewhere row is dropped; the grid then shows the server's mark. */
export async function dropChangedElsewhere(ref: AssessmentRef): Promise<void> {
  if (!('serverId' in ref)) return;
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM local_assessment_marks WHERE assessment_id = ? AND state IN ('changed_elsewhere', 'failed')",
    [ref.serverId],
  );
}

/** Startup: marks still waiting for a test that already has its server id (a crash between writes). */
export async function recoverWaitingMarks(now: Date = new Date()): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const tests = await txn.getAllAsync<{ id: string; server_id: string }>(
      `SELECT DISTINCT t.id, t.server_id FROM local_assessments t
       JOIN local_assessment_marks m ON m.local_assessment_id = t.id
       WHERE m.state = 'waiting' AND m.outbox_id IS NULL AND t.server_id IS NOT NULL`,
    );
    for (const test of tests) queued += await queueWaitingMarks(txn, test.id, test.server_id, now);
  });
  return queued;
}
