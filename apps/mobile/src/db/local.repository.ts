import { newIdempotencyKey, type AttendanceStatus } from '@asms/shared';
import { z } from 'zod';
import type { RegisterCountsDto } from '../api/contracts';
import { deleteOutboxFile, deleteOutboxFilesExcept } from '../media/files';
import { registerNaturalKey } from '../outbox/coalesce';
import {
  buildAttachmentBody,
  buildClaimBody,
  buildDiaryBody,
  buildExpenseBody,
  buildRegisterBody,
  buildRemarkBody,
  type ClaimInput,
  type DiaryInput,
  type ExpenseInput,
  type RegisterMarkInput,
  type RemarkInput,
} from '../outbox/bodies';
import { LANES } from '../outbox/lanes';
import type { OutboxState } from '../outbox/machine';
import { getDb, inExclusiveTransaction, readOwner, type Db } from './database';
import { enqueueIn, NoOwnerError } from './outbox.repository';
import { PURGE_ORPHAN_LOCAL_ROWS } from './schema';

// The only SQL on the local domain tables (slice-16 §8). A local row and its outbox row are
// written in one exclusive transaction; the local row holds ids and typed text only. The
// screens read these rows to show what is on the device and its state line.

/** The outbox side of a local row, for its state line. */
export type OutboxView = {
  id: string;
  state: OutboxState;
  responseStatus: number | null;
  responseCode: string | null;
  responseMessage: string | null;
  responseDetails: string | null;
  nextAttemptAt: string | null;
  updatedAt: string;
};

const OutboxViewRow = z.object({
  o_id: z.string().nullable(),
  o_state: z.enum(['pending', 'sending', 'done', 'failed']).nullable(),
  o_status: z.number().nullable(),
  o_code: z.string().nullable(),
  o_message: z.string().nullable(),
  o_details: z.string().nullable(),
  o_next: z.string().nullable(),
  o_updated: z.string().nullable(),
});

export const OUTBOX_COLUMNS =
  'o.id AS o_id, o.state AS o_state, o.response_status AS o_status, o.response_code AS o_code, ' +
  'o.response_message AS o_message, o.response_details AS o_details, ' +
  'o.next_attempt_at AS o_next, o.updated_at AS o_updated';

export function outboxOf(raw: unknown): OutboxView | null {
  const r = OutboxViewRow.parse(raw);
  if (r.o_id === null || r.o_state === null || r.o_updated === null) return null;
  return {
    id: r.o_id,
    state: r.o_state,
    responseStatus: r.o_status,
    responseCode: r.o_code,
    responseMessage: r.o_message,
    responseDetails: r.o_details,
    nextAttemptAt: r.o_next,
    updatedAt: r.o_updated,
  };
}

/** A write is never stored without its owner (slice-15 §7.6). */
export async function ownedTransaction(task: (txn: Db) => Promise<void>): Promise<void> {
  if ((await readOwner()) === null) throw new NoOwnerError();
  await inExclusiveTransaction(task);
}

// --- Registers ------------------------------------------------------------------------------

export type LocalMark = {
  enrolmentId: string;
  status: AttendanceStatus;
  note: string | null;
  arrivedAt: string | null;
};

export type LocalRegister = {
  id: string;
  sectionId: string;
  date: string;
  period: number;
  mode: 'new' | 'amend';
  reason: string | null;
  serverRegisterId: string | null;
  savedOnServerAt: string | null;
  summary: RegisterCountsDto | null;
  marks: LocalMark[];
  outbox: OutboxView | null;
};

const RegisterRow = z.object({
  id: z.string(),
  section_id: z.string(),
  date: z.string(),
  period: z.number(),
  mode: z.enum(['new', 'amend']),
  reason: z.string().nullable(),
  server_register_id: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  summary: z.string().nullable(),
});

const MarkRow = z.object({
  enrolment_id: z.string(),
  status: z.enum(['present', 'absent', 'late', 'on_leave']),
  note: z.string().nullable(),
  arrived_at: z.string().nullable(),
});

const Summary = z.object({
  roster: z.number(),
  marked: z.number(),
  present: z.number(),
  absent: z.number(),
  late: z.number(),
  onLeave: z.number(),
});

export type SaveRegisterInput = {
  sectionId: string;
  date: string;
  period: number;
  mode: 'new' | 'amend';
  /** In new mode every roster row; in amend mode only the changed rows. */
  marks: readonly RegisterMarkInput[];
  reason?: string | null;
};

/**
 * Saves a register on the device: the local row and its marks, and the outbox row — one
 * transaction. A pending row for the same (section, date, period) absorbs the write (marks by
 * enrolment, latest wins); a sending one leaves a new pending row behind it, and the local row
 * is repointed to it. The local marks are the latest intent per enrolment.
 */
export async function saveRegister(
  input: SaveRegisterInput,
  now: Date = new Date(),
): Promise<{ localRegisterId: string; outboxId: string }> {
  const body = buildRegisterBody(input);
  const stamp = now.toISOString();
  let result = { localRegisterId: '', outboxId: '' };
  await ownedTransaction(async (txn) => {
    const existing = await txn.getFirstAsync<{ id: string; reason: string | null }>(
      'SELECT id, reason FROM local_registers WHERE section_id = ? AND date = ? AND period = ?',
      [input.sectionId, input.date, input.period],
    );
    const localRegisterId = existing?.id ?? newIdempotencyKey();
    const outboxId = await enqueueIn(
      txn,
      {
        lane: 'submit_register',
        method: LANES.submit_register.method,
        path: `/api/v1/sections/${input.sectionId}/submit-register`,
        naturalKey: registerNaturalKey(input.sectionId, input.date, input.period),
        body,
        domainTable: LANES.submit_register.domainTable,
        domainId: localRegisterId,
      },
      now,
    );
    const reason = body.reason ?? existing?.reason ?? null;
    if (existing === null) {
      await txn.runAsync(
        `INSERT INTO local_registers (id, section_id, date, period, mode, reason, outbox_id,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localRegisterId,
          input.sectionId,
          input.date,
          input.period,
          input.mode,
          reason,
          outboxId,
          stamp,
          stamp,
        ],
      );
    } else {
      await txn.runAsync(
        `UPDATE local_registers SET mode = ?, reason = ?, outbox_id = ?, updated_at = ? WHERE id = ?`,
        [input.mode, reason, outboxId, stamp, localRegisterId],
      );
    }
    await mirrorMarks(txn, localRegisterId, body.marks);
    result = { localRegisterId, outboxId };
  });
  return result;
}

/**
 * slice-16 §10.2: the local marks follow the body, so the screen and what will be sent never
 * disagree. Upserted by enrolment: a merged pending body and the local marks hold the same
 * latest intent.
 */
async function mirrorMarks(
  txn: Db,
  localRegisterId: string,
  marks: readonly { enrolmentId: string; status: string; note?: string; arrivedAt?: string }[],
): Promise<void> {
  for (const mark of marks) {
    await txn.runAsync(
      `INSERT INTO local_marks (local_register_id, enrolment_id, status, note, arrived_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (local_register_id, enrolment_id) DO UPDATE SET
         status = excluded.status, note = excluded.note, arrived_at = excluded.arrived_at`,
      [localRegisterId, mark.enrolmentId, mark.status, mark.note ?? null, mark.arrivedAt ?? null],
    );
  }
}

export async function readRegister(
  sectionId: string,
  date: string,
  period: number,
): Promise<LocalRegister | null> {
  const db = await getDb();
  const raw = await db.getFirstAsync<unknown>(
    `SELECT r.id, r.section_id, r.date, r.period, r.mode, r.reason, r.server_register_id,
       r.saved_on_server_at, r.summary, ${OUTBOX_COLUMNS}
     FROM local_registers r LEFT JOIN outbox o ON o.id = r.outbox_id
     WHERE r.section_id = ? AND r.date = ? AND r.period = ?`,
    [sectionId, date, period],
  );
  if (raw === null) return null;
  const r = RegisterRow.parse(raw);
  const marks = (
    await db.getAllAsync<unknown>(
      'SELECT enrolment_id, status, note, arrived_at FROM local_marks WHERE local_register_id = ?',
      [r.id],
    )
  ).map((row) => {
    const m = MarkRow.parse(row);
    return { enrolmentId: m.enrolment_id, status: m.status, note: m.note, arrivedAt: m.arrived_at };
  });
  const summary = r.summary === null ? null : Summary.safeParse(JSON.parse(r.summary));
  return {
    id: r.id,
    sectionId: r.section_id,
    date: r.date,
    period: r.period,
    mode: r.mode,
    reason: r.reason,
    serverRegisterId: r.server_register_id,
    savedOnServerAt: r.saved_on_server_at,
    summary: summary?.success ? summary.data : null,
    marks,
    outbox: outboxOf(raw),
  };
}

/** The follow-up of a register's 2xx (slice-16 §10.3). */
export async function markRegisterSaved(
  outboxId: string,
  saved: { serverRegisterId: string | null; savedAt: string; summary: RegisterCountsDto | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_registers SET server_register_id = COALESCE(?, server_register_id),
       saved_on_server_at = ?, summary = COALESCE(?, summary), updated_at = ? WHERE outbox_id = ?`,
    [
      saved.serverRegisterId,
      saved.savedAt,
      saved.summary === null ? null : JSON.stringify(saved.summary),
      saved.savedAt,
      outboxId,
    ],
  );
}

// --- Diary entries and their photos ---------------------------------------------------------

export type LocalPhoto = { id: string; fileName: string; mime: string; sizeBytes: number };

export type AttachmentState = 'waiting' | 'queued' | 'done' | 'failed' | 'discarded';

export type LocalAttachment = {
  id: string;
  localEntryId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  state: AttachmentState;
  stagedUploadId: string | null;
  stagedExpiresAt: string | null;
  referenceRetries: number;
  outboxId: string | null;
};

export type LocalDiaryEntry = {
  id: string;
  sectionId: string;
  date: string;
  subjectId: string;
  topic: string;
  assignment: string | null;
  learningOutcome: string | null;
  dueOn: string | null;
  serverId: string | null;
  savedOnServerAt: string | null;
  state: 'queued' | 'done' | 'failed' | 'superseded_by_server' | 'discarded';
  outbox: OutboxView | null;
  photo: (LocalAttachment & { outbox: OutboxView | null }) | null;
};

const EntryRow = z.object({
  id: z.string(),
  section_id: z.string(),
  date: z.string(),
  subject_id: z.string(),
  topic: z.string(),
  assignment: z.string().nullable(),
  learning_outcome: z.string().nullable(),
  due_on: z.string().nullable(),
  server_id: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed', 'superseded_by_server', 'discarded']),
});

const AttachmentRow = z.object({
  id: z.string(),
  local_entry_id: z.string(),
  file_path: z.string(),
  mime: z.string(),
  size_bytes: z.number(),
  state: z.enum(['waiting', 'queued', 'done', 'failed', 'discarded']),
  staged_upload_id: z.string().nullable(),
  staged_expires_at: z.string().nullable(),
  reference_retries: z.number(),
  outbox_id: z.string().nullable(),
});

const ATTACHMENT_COLUMNS =
  'a.id, a.local_entry_id, a.file_path, a.mime, a.size_bytes, a.state, a.staged_upload_id, ' +
  'a.staged_expires_at, a.reference_retries, a.outbox_id';

function attachmentOf(raw: unknown): LocalAttachment {
  const a = AttachmentRow.parse(raw);
  return {
    id: a.id,
    localEntryId: a.local_entry_id,
    fileName: a.file_path,
    mime: a.mime,
    sizeBytes: a.size_bytes,
    state: a.state,
    stagedUploadId: a.staged_upload_id,
    stagedExpiresAt: a.staged_expires_at,
    referenceRetries: a.reference_retries,
    outboxId: a.outbox_id,
  };
}

/**
 * Saves a diary entry on the device: the local row, the outbox row (its id is the
 * Idempotency-Key), and — when a photo was chosen — the photo's row in state `waiting`, all in one
 * transaction. The photo is queued only once the entry has a server id (slice-16 §4.5).
 */
export async function saveDiaryEntry(
  sectionId: string,
  input: DiaryInput,
  photo: LocalPhoto | null,
  now: Date = new Date(),
  /** "Edit and resend": the failed local entry this one replaces; its waiting photo moves over. */
  replaces: string | null = null,
): Promise<{ localEntryId: string; outboxId: string }> {
  const body = buildDiaryBody(input);
  const stamp = now.toISOString();
  const localEntryId = newIdempotencyKey();
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: 'diary_entry',
        method: LANES.diary_entry.method,
        path: `/api/v1/sections/${sectionId}/diary-entries`,
        body,
        domainTable: LANES.diary_entry.domainTable,
        domainId: localEntryId,
      },
      now,
    );
    await txn.runAsync(
      `INSERT INTO local_diary_entries (id, section_id, date, subject_id, topic, assignment,
         learning_outcome, due_on, outbox_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        localEntryId,
        sectionId,
        body.date,
        body.subjectId,
        body.topic,
        body.assignment ?? null,
        body.learningOutcome ?? null,
        body.dueOn ?? null,
        outboxId,
        stamp,
        stamp,
      ],
    );
    if (photo !== null) {
      await txn.runAsync(
        `INSERT INTO local_attachments (id, local_entry_id, file_path, mime, size_bytes, state,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
        [photo.id, localEntryId, photo.fileName, photo.mime, photo.sizeBytes, stamp, stamp],
      );
    }
    if (replaces !== null)
      await replaceLocalRow(txn, 'local_diary_entries', replaces, localEntryId);
  });
  return { localEntryId, outboxId };
}

/** Queues the entry's waiting photos for the server entry `serverId`; never one queued twice. */
async function queueWaitingPhotos(
  txn: Db,
  localEntryId: string,
  serverId: string,
  now: Date,
): Promise<number> {
  const waiting = await txn.getAllAsync<{ id: string }>(
    "SELECT id FROM local_attachments WHERE local_entry_id = ? AND state = 'waiting' AND outbox_id IS NULL",
    [localEntryId],
  );
  for (const { id } of waiting) {
    const outboxId = await enqueueIn(
      txn,
      {
        lane: 'diary_attachment',
        method: LANES.diary_attachment.method,
        path: `/api/v1/diary-entries/${serverId}`,
        body: buildAttachmentBody(id),
        domainTable: LANES.diary_attachment.domainTable,
        domainId: id,
      },
      now,
    );
    await txn.runAsync(
      "UPDATE local_attachments SET state = 'queued', outbox_id = ?, updated_at = ? WHERE id = ?",
      [outboxId, now.toISOString(), id],
    );
  }
  return waiting.length;
}

/**
 * The follow-up of a diary entry's 2xx (slice-16 §10.3): the server id is written, and each photo
 * waiting for it is queued in the same transaction. Returns how many photos were queued.
 */
export async function markDiarySaved(
  outboxId: string,
  serverId: string | null,
  now: Date = new Date(),
): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const entry = await txn.getFirstAsync<{ id: string }>(
      'SELECT id FROM local_diary_entries WHERE outbox_id = ?',
      [outboxId],
    );
    if (entry === null) return;
    const stamp = now.toISOString();
    await txn.runAsync(
      `UPDATE local_diary_entries SET server_id = COALESCE(?, server_id), saved_on_server_at = ?,
         state = 'done', updated_at = ? WHERE id = ?`,
      [serverId, stamp, stamp, entry.id],
    );
    if (serverId !== null) queued = await queueWaitingPhotos(txn, entry.id, serverId, now);
  });
  return queued;
}

/**
 * `409 DIARY_ENTRY_EXISTS` → "open the existing entry": the local entry is superseded by the
 * server's, and its waiting photo is re-targeted to that entry (or discarded by the caller).
 */
export async function supersedeByServerEntry(
  localEntryId: string,
  serverEntryId: string,
  attachPhoto: boolean,
  now: Date = new Date(),
): Promise<void> {
  await inExclusiveTransaction(async (txn) => {
    const stamp = now.toISOString();
    await txn.runAsync(
      `UPDATE local_diary_entries SET state = 'superseded_by_server', server_id = ?, updated_at = ?
       WHERE id = ?`,
      [serverEntryId, stamp, localEntryId],
    );
    if (attachPhoto) await queueWaitingPhotos(txn, localEntryId, serverEntryId, now);
    else
      await txn.runAsync(
        "UPDATE local_attachments SET state = 'discarded', updated_at = ? WHERE local_entry_id = ? AND state = 'waiting'",
        [stamp, localEntryId],
      );
  });
  await sweepPhotoFiles();
}

/**
 * Startup, beside recoverStaleItems (slice-16 §4.5): a photo still `waiting` whose entry already
 * has a server id (a crash between the two writes) is queued; a photo whose entry was discarded
 * is marked failed. Idempotent: a photo with an outbox row is never queued again.
 */
export async function recoverWaitingAttachments(now: Date = new Date()): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const entries = await txn.getAllAsync<{ id: string; server_id: string; state: string }>(
      `SELECT DISTINCT e.id, e.server_id, e.state FROM local_diary_entries e
       JOIN local_attachments a ON a.local_entry_id = e.id
       WHERE a.state = 'waiting' AND a.outbox_id IS NULL AND e.server_id IS NOT NULL`,
    );
    for (const entry of entries) {
      queued += await queueWaitingPhotos(txn, entry.id, entry.server_id, now);
    }
    await txn.runAsync(
      `UPDATE local_attachments SET state = 'failed', updated_at = ?
       WHERE state = 'waiting' AND local_entry_id IN
         (SELECT id FROM local_diary_entries WHERE state = 'discarded')`,
      [now.toISOString()],
    );
    // The same for the files of the staged_upload_patch lanes (an expense's receipt).
    queued += await recoverWaitingFiles(txn, now);
  });
  return queued;
}

export async function listLocalDiaryEntries(sectionId: string): Promise<LocalDiaryEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT e.id, e.section_id, e.date, e.subject_id, e.topic, e.assignment, e.learning_outcome,
       e.due_on, e.server_id, e.saved_on_server_at, e.state, ${OUTBOX_COLUMNS}
     FROM local_diary_entries e LEFT JOIN outbox o ON o.id = e.outbox_id
     WHERE e.section_id = ? AND e.state != 'discarded'
     ORDER BY e.date DESC, e.created_at DESC`,
    [sectionId],
  );
  const entries: LocalDiaryEntry[] = [];
  for (const raw of rows) {
    const e = EntryRow.parse(raw);
    const photoRaw = await db.getFirstAsync<unknown>(
      `SELECT ${ATTACHMENT_COLUMNS}, ${OUTBOX_COLUMNS}
       FROM local_attachments a LEFT JOIN outbox o ON o.id = a.outbox_id
       WHERE a.local_entry_id = ? AND a.state != 'discarded' ORDER BY a.created_at DESC LIMIT 1`,
      [e.id],
    );
    entries.push({
      id: e.id,
      sectionId: e.section_id,
      date: e.date,
      subjectId: e.subject_id,
      topic: e.topic,
      assignment: e.assignment,
      learningOutcome: e.learning_outcome,
      dueOn: e.due_on,
      serverId: e.server_id,
      savedOnServerAt: e.saved_on_server_at,
      state: e.state,
      outbox: outboxOf(raw),
      photo: photoRaw === null ? null : { ...attachmentOf(photoRaw), outbox: outboxOf(photoRaw) },
    });
  }
  return entries;
}

export async function getAttachment(id: string): Promise<LocalAttachment | null> {
  const db = await getDb();
  const raw = await db.getFirstAsync<unknown>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM local_attachments a WHERE a.id = ?`,
    [id],
  );
  return raw === null ? null : attachmentOf(raw);
}

/** Photos waiting for their entry (the sync sheet lists them; they have no outbox row yet). */
export async function listWaitingAttachments(): Promise<LocalAttachment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM local_attachments a WHERE a.state = 'waiting' ORDER BY a.created_at`,
  );
  return rows.map(attachmentOf);
}

// --- Files of the staged_upload_patch lanes ---------------------------------------------------
//
// A lane whose sender is `staged_upload_patch` keeps its file row in the lane's domainTable: the
// diary photo in local_attachments (slice 16), every later file — an expense's receipt (slice 23),
// a deposit slip (slice 21) — in local_files. Both tables carry the same file columns, so the
// sender reads and updates either through these functions.

export type UploadTable = 'local_attachments' | 'local_files';

export const UPLOAD_TABLES: readonly UploadTable[] = ['local_attachments', 'local_files'];

export function uploadTableOf(table: string | null): UploadTable | null {
  return UPLOAD_TABLES.find((t) => t === table) ?? null;
}

/** A file row as the sender needs it, from either upload table. */
export type UploadFile = Omit<LocalAttachment, 'localEntryId'>;

const UploadFileRow = AttachmentRow.omit({ local_entry_id: true });

export async function getUploadFile(table: UploadTable, id: string): Promise<UploadFile | null> {
  const db = await getDb();
  const raw = await db.getFirstAsync<unknown>(
    `SELECT a.id, a.file_path, a.mime, a.size_bytes, a.state, a.staged_upload_id,
       a.staged_expires_at, a.reference_retries, a.outbox_id FROM ${table} a WHERE a.id = ?`,
    [id],
  );
  if (raw === null) return null;
  const a = UploadFileRow.parse(raw);
  return {
    id: a.id,
    fileName: a.file_path,
    mime: a.mime,
    sizeBytes: a.size_bytes,
    state: a.state,
    stagedUploadId: a.staged_upload_id,
    stagedExpiresAt: a.staged_expires_at,
    referenceRetries: a.reference_retries,
    outboxId: a.outbox_id,
  };
}

export async function setStagedUpload(
  id: string,
  stagedUploadId: string,
  expiresAt: string,
  table: UploadTable = 'local_attachments',
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ${table} SET staged_upload_id = ?, staged_expires_at = ?, updated_at = ? WHERE id = ?`,
    [stagedUploadId, expiresAt, new Date().toISOString(), id],
  );
}

/** The staged upload was refused as gone: the next attempt uploads again; the refusal is counted. */
export async function clearStagedUpload(
  id: string,
  table: UploadTable = 'local_attachments',
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ${table} SET staged_upload_id = NULL, staged_expires_at = NULL,
       reference_retries = reference_retries + 1, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

/** The file is on the server: its row says so and the file is deleted from the phone. */
export async function markUploadDone(table: UploadTable, id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ file_path: string }>(
    `SELECT file_path FROM ${table} WHERE id = ?`,
    [id],
  );
  await db.runAsync(
    `UPDATE ${table} SET state = 'done', staged_upload_id = NULL, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
  if (row !== null) deleteOutboxFile(row.file_path);
}
// --- Remarks --------------------------------------------------------------------------------

export type LocalRemark = {
  id: string;
  studentId: string;
  date: string;
  category: string;
  text: string;
  visibility: string | null;
  subjectId: string | null;
  serverId: string | null;
  savedOnServerAt: string | null;
  state: 'queued' | 'done' | 'failed' | 'discarded';
  outbox: OutboxView | null;
};

const RemarkRow = z.object({
  id: z.string(),
  student_id: z.string(),
  date: z.string(),
  category: z.string(),
  text: z.string(),
  visibility: z.string().nullable(),
  subject_id: z.string().nullable(),
  server_id: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed', 'discarded']),
});

/** Saves a remark on the device; the outbox id is the Idempotency-Key. One transaction. */
export async function saveRemark(
  studentId: string,
  input: RemarkInput,
  now: Date = new Date(),
  /** "Edit and resend": the failed local remark this one replaces. */
  replaces: string | null = null,
): Promise<{ localRemarkId: string; outboxId: string }> {
  const body = buildRemarkBody(input);
  const stamp = now.toISOString();
  const localRemarkId = newIdempotencyKey();
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: 'remark',
        method: LANES.remark.method,
        path: `/api/v1/students/${studentId}/remarks`,
        body,
        domainTable: LANES.remark.domainTable,
        domainId: localRemarkId,
      },
      now,
    );
    await txn.runAsync(
      `INSERT INTO local_remarks (id, student_id, date, category, text, visibility, subject_id,
         outbox_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        localRemarkId,
        studentId,
        body.date,
        body.category,
        body.text,
        body.visibility ?? null,
        body.subjectId ?? null,
        outboxId,
        stamp,
        stamp,
      ],
    );
    if (replaces !== null) await replaceLocalRow(txn, 'local_remarks', replaces, localRemarkId);
  });
  return { localRemarkId, outboxId };
}

export async function markRemarkSaved(
  outboxId: string,
  serverId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const db = await getDb();
  const stamp = now.toISOString();
  await db.runAsync(
    `UPDATE local_remarks SET server_id = COALESCE(?, server_id), saved_on_server_at = ?,
       state = 'done', updated_at = ? WHERE outbox_id = ?`,
    [serverId, stamp, stamp, outboxId],
  );
}

export async function listLocalRemarks(studentId: string): Promise<LocalRemark[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT r.id, r.student_id, r.date, r.category, r.text, r.visibility, r.subject_id,
       r.server_id, r.saved_on_server_at, r.state, ${OUTBOX_COLUMNS}
     FROM local_remarks r LEFT JOIN outbox o ON o.id = r.outbox_id
     WHERE r.student_id = ? AND r.state != 'discarded' ORDER BY r.created_at DESC`,
    [studentId],
  );
  return rows.map((raw) => {
    const r = RemarkRow.parse(raw);
    return {
      id: r.id,
      studentId: r.student_id,
      date: r.date,
      category: r.category,
      text: r.text,
      visibility: r.visibility,
      subjectId: r.subject_id,
      serverId: r.server_id,
      savedOnServerAt: r.saved_on_server_at,
      state: r.state,
      outbox: outboxOf(raw),
    };
  });
}

// --- Expenses and their receipts (Phase 3 slice 23, §3.9) -----------------------------------

/** The owner row a waiting file is queued behind: its server id, and its child for a claim. */
type FileOwner = { serverId: string; studentId: string | null };

/** Each owner table of local_files: the lane that sends its file, and the PATCH path. */
const FILE_LANES = {
  local_expenses: {
    lane: 'expense_receipt',
    path: ({ serverId }: FileOwner) => `/api/v1/expenses/${serverId}/receipt`,
  },
  // Slice 21: a deposit slip, PATCHed onto its claim (R243).
  local_claims: {
    lane: 'payment_claim_image',
    path: ({ serverId, studentId }: FileOwner) =>
      `/api/v1/me/children/${studentId ?? ''}/payment-claims/${serverId}`,
  },
} as const satisfies Record<
  string,
  { lane: keyof typeof LANES; path: (owner: FileOwner) => string }
>;

type FileOwnerTable = keyof typeof FILE_LANES;

export type LocalExpense = {
  id: string;
  category: string;
  amount: number;
  spentOn: string;
  description: string;
  payee: string | null;
  method: string;
  reference: string | null;
  serverId: string | null;
  expenseNo: number | null;
  /** The status the server answered with (recorded, pending_approval or approved). */
  serverStatus: string | null;
  savedOnServerAt: string | null;
  state: 'queued' | 'done' | 'failed' | 'discarded';
  outbox: OutboxView | null;
  receipt: (UploadFile & { outbox: OutboxView | null }) | null;
};

const ExpenseRow = z.object({
  id: z.string(),
  category: z.string(),
  amount: z.number(),
  spent_on: z.string(),
  description: z.string(),
  payee: z.string().nullable(),
  method: z.string(),
  reference: z.string().nullable(),
  server_id: z.string().nullable(),
  expense_no: z.number().nullable(),
  server_status: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed', 'discarded']),
});

/**
 * Saves an expense on the device: the local row, the outbox row (its id is the Idempotency-Key)
 * and — when a receipt was photographed — the file row in state `waiting`, all in one
 * transaction. The receipt is queued once the expense has a server id.
 */
export async function saveExpense(
  input: ExpenseInput,
  receipt: LocalPhoto | null,
  now: Date = new Date(),
  /** "Edit and resend": the failed local expense this one replaces; its waiting receipt moves over. */
  replaces: string | null = null,
): Promise<{ localExpenseId: string; outboxId: string }> {
  const body = buildExpenseBody(input);
  const stamp = now.toISOString();
  const localExpenseId = newIdempotencyKey();
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: 'expense',
        method: LANES.expense.method,
        path: LANES.expense.path,
        body,
        domainTable: LANES.expense.domainTable,
        domainId: localExpenseId,
      },
      now,
    );
    await txn.runAsync(
      `INSERT INTO local_expenses (id, category, amount, spent_on, description, payee, method,
         reference, outbox_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        localExpenseId,
        body.category,
        body.amount,
        body.spentOn,
        body.description,
        body.payee ?? null,
        body.method,
        body.reference ?? null,
        outboxId,
        stamp,
        stamp,
      ],
    );
    if (receipt !== null) {
      await txn.runAsync(
        `INSERT INTO local_files (id, owner_table, owner_id, file_path, mime, size_bytes, state,
           created_at, updated_at) VALUES (?, 'local_expenses', ?, ?, ?, ?, 'waiting', ?, ?)`,
        [receipt.id, localExpenseId, receipt.fileName, receipt.mime, receipt.sizeBytes, stamp, stamp],
      );
    }
    if (replaces !== null) await replaceLocalRow(txn, 'local_expenses', replaces, localExpenseId);
  });
  return { localExpenseId, outboxId };
}

/** Queues the owner's waiting files for its server row `serverId`; never one queued twice. */
async function queueWaitingFiles(
  txn: Db,
  ownerTable: FileOwnerTable,
  ownerId: string,
  owner: FileOwner,
  now: Date,
): Promise<number> {
  const { lane, path } = FILE_LANES[ownerTable];
  const waiting = await txn.getAllAsync<{ id: string }>(
    `SELECT id FROM local_files
      WHERE owner_table = ? AND owner_id = ? AND state = 'waiting' AND outbox_id IS NULL`,
    [ownerTable, ownerId],
  );
  for (const { id } of waiting) {
    const outboxId = await enqueueIn(
      txn,
      {
        lane,
        method: LANES[lane].method,
        path: path(owner),
        body: buildAttachmentBody(id),
        domainTable: LANES[lane].domainTable,
        domainId: id,
      },
      now,
    );
    await txn.runAsync(
      "UPDATE local_files SET state = 'queued', outbox_id = ?, updated_at = ? WHERE id = ?",
      [outboxId, now.toISOString(), id],
    );
  }
  return waiting.length;
}

/**
 * The follow-up of an expense's 2xx: the server's id, number and status are written, and a
 * receipt waiting for it is queued in the same transaction. Returns how many files were queued.
 */
export async function markExpenseSaved(
  outboxId: string,
  server: { id: string; expenseNo: number | null; status: string | null } | null,
  now: Date = new Date(),
): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const expense = await txn.getFirstAsync<{ id: string }>(
      'SELECT id FROM local_expenses WHERE outbox_id = ?',
      [outboxId],
    );
    if (expense === null) return;
    const stamp = now.toISOString();
    await txn.runAsync(
      `UPDATE local_expenses SET server_id = COALESCE(?, server_id),
         expense_no = COALESCE(?, expense_no), server_status = COALESCE(?, server_status),
         saved_on_server_at = ?, state = 'done', updated_at = ? WHERE id = ?`,
      [server?.id ?? null, server?.expenseNo ?? null, server?.status ?? null, stamp, stamp, expense.id],
    );
    if (server !== null) {
      queued = await queueWaitingFiles(
        txn,
        'local_expenses',
        expense.id,
        { serverId: server.id, studentId: null },
        now,
      );
    }
  });
  return queued;
}

/** Startup: a receipt or a slip still waiting whose owner already has a server id is queued. */
async function recoverWaitingFiles(txn: Db, now: Date): Promise<number> {
  let queued = 0;
  const owners = await txn.getAllAsync<{ id: string; server_id: string }>(
    `SELECT DISTINCT e.id, e.server_id FROM local_expenses e
       JOIN local_files f ON f.owner_table = 'local_expenses' AND f.owner_id = e.id
      WHERE f.state = 'waiting' AND f.outbox_id IS NULL AND e.server_id IS NOT NULL`,
  );
  for (const owner of owners) {
    queued += await queueWaitingFiles(
      txn,
      'local_expenses',
      owner.id,
      { serverId: owner.server_id, studentId: null },
      now,
    );
  }
  const claims = await txn.getAllAsync<{ id: string; server_id: string; student_id: string }>(
    `SELECT DISTINCT c.id, c.server_id, c.student_id FROM local_claims c
       JOIN local_files f ON f.owner_table = 'local_claims' AND f.owner_id = c.id
      WHERE f.state = 'waiting' AND f.outbox_id IS NULL AND c.server_id IS NOT NULL`,
  );
  for (const claim of claims) {
    queued += await queueWaitingFiles(
      txn,
      'local_claims',
      claim.id,
      { serverId: claim.server_id, studentId: claim.student_id },
      now,
    );
  }
  return queued;
}

/** The expenses on this phone, newest first, with their receipt's state. */
export async function listLocalExpenses(): Promise<LocalExpense[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT e.id, e.category, e.amount, e.spent_on, e.description, e.payee, e.method, e.reference,
       e.server_id, e.expense_no, e.server_status, e.saved_on_server_at, e.state, ${OUTBOX_COLUMNS}
     FROM local_expenses e LEFT JOIN outbox o ON o.id = e.outbox_id
     WHERE e.state != 'discarded' ORDER BY e.created_at DESC`,
  );
  const expenses: LocalExpense[] = [];
  for (const raw of rows) {
    const e = ExpenseRow.parse(raw);
    const fileRaw = await db.getFirstAsync<{ id: string }>(
      `SELECT f.id FROM local_files f
        WHERE f.owner_table = 'local_expenses' AND f.owner_id = ? AND f.state != 'discarded'
        ORDER BY f.created_at DESC LIMIT 1`,
      [e.id],
    );
    const file = fileRaw === null ? null : await getUploadFile('local_files', fileRaw.id);
    const fileOutboxRaw =
      file?.outboxId == null
        ? null
        : await db.getFirstAsync<unknown>(`SELECT ${OUTBOX_COLUMNS} FROM outbox o WHERE o.id = ?`, [
            file.outboxId,
          ]);
    const fileOutbox = fileOutboxRaw === null ? null : outboxOf(fileOutboxRaw);
    expenses.push({
      id: e.id,
      category: e.category,
      amount: e.amount,
      spentOn: e.spent_on,
      description: e.description,
      payee: e.payee,
      method: e.method,
      reference: e.reference,
      serverId: e.server_id,
      expenseNo: e.expense_no,
      serverStatus: e.server_status,
      savedOnServerAt: e.saved_on_server_at,
      state: e.state,
      outbox: outboxOf(raw),
      receipt: file === null ? null : { ...file, outbox: fileOutbox },
    });
  }
  return expenses;
}

// --- Deposit claims and their slips (Phase 3 slice 21, §3.9) -----------------------------------

export type LocalClaim = {
  id: string;
  studentId: string;
  method: string;
  claimedAmount: number;
  paidOn: string;
  reference: string | null;
  serverId: string | null;
  savedOnServerAt: string | null;
  state: 'queued' | 'done' | 'failed' | 'discarded';
  outbox: OutboxView | null;
  slip: (UploadFile & { outbox: OutboxView | null }) | null;
};

const ClaimRow = z.object({
  id: z.string(),
  student_id: z.string(),
  method: z.string(),
  claimed_amount: z.number(),
  paid_on: z.string(),
  reference: z.string().nullable(),
  server_id: z.string().nullable(),
  saved_on_server_at: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed', 'discarded']),
});

/**
 * Saves a deposit claim on the device (R199): the local row, the outbox row (its id is the
 * Idempotency-Key) and the slip's file row in state `waiting`, all in one transaction. The slip
 * is queued once the claim has a server id, and deleted from the phone once the server has it.
 */
export async function saveClaim(
  studentId: string,
  input: ClaimInput,
  slip: LocalPhoto,
  now: Date = new Date(),
): Promise<{ localClaimId: string; outboxId: string }> {
  const body = buildClaimBody(input);
  const stamp = now.toISOString();
  const localClaimId = newIdempotencyKey();
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: 'payment_claim',
        method: LANES.payment_claim.method,
        path: LANES.payment_claim.path.replace(':id', studentId),
        body,
        domainTable: LANES.payment_claim.domainTable,
        domainId: localClaimId,
      },
      now,
    );
    await txn.runAsync(
      `INSERT INTO local_claims (id, student_id, method, claimed_amount, paid_on, reference, note,
         outbox_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        localClaimId,
        studentId,
        body.method,
        body.claimedAmount,
        body.paidOn,
        body.reference ?? null,
        body.note ?? null,
        outboxId,
        stamp,
        stamp,
      ],
    );
    await txn.runAsync(
      `INSERT INTO local_files (id, owner_table, owner_id, file_path, mime, size_bytes, state,
         created_at, updated_at) VALUES (?, 'local_claims', ?, ?, ?, ?, 'waiting', ?, ?)`,
      [slip.id, localClaimId, slip.fileName, slip.mime, slip.sizeBytes, stamp, stamp],
    );
  });
  return { localClaimId, outboxId };
}

/**
 * The follow-up of a claim's 2xx: the server's id is written and the waiting slip is queued in
 * the same transaction. Returns how many files were queued.
 */
export async function markClaimSaved(
  outboxId: string,
  server: { id: string } | null,
  now: Date = new Date(),
): Promise<number> {
  let queued = 0;
  await inExclusiveTransaction(async (txn) => {
    const claim = await txn.getFirstAsync<{ id: string; student_id: string }>(
      'SELECT id, student_id FROM local_claims WHERE outbox_id = ?',
      [outboxId],
    );
    if (claim === null) return;
    const stamp = now.toISOString();
    await txn.runAsync(
      `UPDATE local_claims SET server_id = COALESCE(?, server_id), saved_on_server_at = ?,
         state = 'done', updated_at = ? WHERE id = ?`,
      [server?.id ?? null, stamp, stamp, claim.id],
    );
    if (server !== null) {
      queued = await queueWaitingFiles(
        txn,
        'local_claims',
        claim.id,
        { serverId: server.id, studentId: claim.student_id },
        now,
      );
    }
  });
  return queued;
}

/** A child's claims on this phone (not yet, or only just, on the server), newest first. */
export async function listLocalClaims(studentId: string): Promise<LocalClaim[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT c.id, c.student_id, c.method, c.claimed_amount, c.paid_on, c.reference, c.server_id,
       c.saved_on_server_at, c.state, ${OUTBOX_COLUMNS}
     FROM local_claims c LEFT JOIN outbox o ON o.id = c.outbox_id
     WHERE c.student_id = ? AND c.state != 'discarded' ORDER BY c.created_at DESC`,
    [studentId],
  );
  const claims: LocalClaim[] = [];
  for (const raw of rows) {
    const c = ClaimRow.parse(raw);
    const fileRaw = await db.getFirstAsync<{ id: string }>(
      `SELECT f.id FROM local_files f
        WHERE f.owner_table = 'local_claims' AND f.owner_id = ? AND f.state != 'discarded'
        ORDER BY f.created_at DESC LIMIT 1`,
      [c.id],
    );
    const file = fileRaw === null ? null : await getUploadFile('local_files', fileRaw.id);
    const fileOutboxRaw =
      file?.outboxId == null
        ? null
        : await db.getFirstAsync<unknown>(`SELECT ${OUTBOX_COLUMNS} FROM outbox o WHERE o.id = ?`, [
            file.outboxId,
          ]);
    claims.push({
      id: c.id,
      studentId: c.student_id,
      method: c.method,
      claimedAmount: c.claimed_amount,
      paidOn: c.paid_on,
      reference: c.reference,
      serverId: c.server_id,
      savedOnServerAt: c.saved_on_server_at,
      state: c.state,
      outbox: outboxOf(raw),
      slip:
        file === null
          ? null
          : { ...file, outbox: fileOutboxRaw === null ? null : outboxOf(fileOutboxRaw) },
    });
  }
  return claims;
}

// --- Discard, remedies and residue ----------------------------------------------------------

/**
 * Discard (sync sheet or screen, slice-16 §8): the outbox row is deleted and its local row with
 * it, in one transaction; a photo's file is deleted. A discarded diary entry takes its photos.
 */
export async function discardItem(outboxId: string): Promise<void> {
  await inExclusiveTransaction(async (txn) => {
    // Photos queued behind a discarded entry go with it.
    await txn.runAsync(
      `DELETE FROM outbox WHERE id IN (SELECT a.outbox_id FROM local_attachments a
         JOIN local_diary_entries e ON e.id = a.local_entry_id WHERE e.outbox_id = ?)`,
      [outboxId],
    );
    // Receipts queued behind a discarded expense go with it, and slips behind a discarded claim.
    await txn.runAsync(
      `DELETE FROM outbox WHERE id IN (SELECT f.outbox_id FROM local_files f
         JOIN local_expenses e ON f.owner_table = 'local_expenses' AND e.id = f.owner_id
        WHERE e.outbox_id = ?)`,
      [outboxId],
    );
    await txn.runAsync(
      `DELETE FROM outbox WHERE id IN (SELECT f.outbox_id FROM local_files f
         JOIN local_claims c ON f.owner_table = 'local_claims' AND c.id = f.owner_id
        WHERE c.outbox_id = ?)`,
      [outboxId],
    );
    await txn.runAsync('DELETE FROM outbox WHERE id = ?', [outboxId]);
    await txn.runAsync('DELETE FROM local_diary_entries WHERE outbox_id = ?', [outboxId]);
    // A discarded photo's row (and, by the foreign key, an entry's photos) go too.
    await txn.runAsync('DELETE FROM local_attachments WHERE outbox_id = ?', [outboxId]);
    // A discarded expense takes its receipt; a discarded receipt goes alone.
    await txn.runAsync(
      `DELETE FROM local_files WHERE owner_table = 'local_expenses'
         AND owner_id IN (SELECT id FROM local_expenses WHERE outbox_id = ?)`,
      [outboxId],
    );
    await txn.runAsync('DELETE FROM local_expenses WHERE outbox_id = ?', [outboxId]);
    // A discarded claim takes its slip.
    await txn.runAsync(
      `DELETE FROM local_files WHERE owner_table = 'local_claims'
         AND owner_id IN (SELECT id FROM local_claims WHERE outbox_id = ?)`,
      [outboxId],
    );
    await txn.runAsync('DELETE FROM local_claims WHERE outbox_id = ?', [outboxId]);
    await txn.runAsync('DELETE FROM local_files WHERE outbox_id = ?', [outboxId]);
    // Slice 30: a discarded test takes the marks waiting for it (the foreign key cascades); a
    // discarded marks row takes its entries.
    await txn.runAsync('DELETE FROM local_assessments WHERE outbox_id = ?', [outboxId]);
    await txn.runAsync('DELETE FROM local_assessment_marks WHERE outbox_id = ?', [outboxId]);
    await txn.execAsync(PURGE_ORPHAN_LOCAL_ROWS);
  });
  await sweepPhotoFiles();
}

/** A photo still waiting for its entry, discarded from the sync sheet. */
export async function discardWaitingAttachment(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM local_attachments WHERE id = ? AND state IN ('waiting', 'failed')",
    [id],
  );
  await sweepPhotoFiles();
}

/**
 * A remedy's new pending row (slice-15 §7.4, slice-16 §9): the failed row stays until its purge;
 * the local row is repointed to the new one. `body` replaces the body when the remedy changes it
 * (a register's added reason, a reloaded roster).
 */
export async function resendWithRemedy(
  failed: {
    id: string;
    lane: string;
    method: string;
    path: string;
    naturalKey: string | null;
    body: string;
    domainTable: string | null;
    domainId: string | null;
  },
  body: unknown = JSON.parse(failed.body),
  now: Date = new Date(),
): Promise<string> {
  let outboxId = '';
  await ownedTransaction(async (txn) => {
    outboxId = await enqueueIn(
      txn,
      {
        lane: failed.lane,
        method: failed.method,
        path: failed.path,
        naturalKey: failed.naturalKey,
        body,
        domainTable: failed.domainTable,
        domainId: failed.domainId,
      },
      now,
    );
    const table = failed.domainTable;
    if (table !== null && LOCAL_TABLES.has(table)) {
      await txn.runAsync(`UPDATE ${table} SET outbox_id = ?, updated_at = ? WHERE id = ?`, [
        outboxId,
        now.toISOString(),
        failed.domainId,
      ]);
    }
    // Slice 30: a marks row's entries follow the outbox row (domainId is the assessment).
    if (failed.lane === 'marks_enter') {
      await txn.runAsync(
        "UPDATE local_assessment_marks SET outbox_id = ?, state = 'queued', updated_at = ? WHERE outbox_id = ?",
        [outboxId, now.toISOString(), failed.id],
      );
    }
    if (failed.lane === 'submit_register' && failed.domainId !== null) {
      const marks = (body as { marks?: { enrolmentId: string; status: string }[] }).marks ?? [];
      await mirrorMarks(txn, failed.domainId, marks);
    }
  });
  return outboxId;
}

/**
 * "Edit and resend" (slice-16 §4.4, §4.6): the failed row and its outbox row are deleted in the
 * new row's transaction; a diary entry's waiting photo moves to the new entry.
 */
async function replaceLocalRow(
  txn: Db,
  table: 'local_diary_entries' | 'local_remarks' | 'local_expenses',
  oldId: string,
  newId: string,
): Promise<void> {
  const old = await txn.getFirstAsync<{ outbox_id: string | null }>(
    `SELECT outbox_id FROM ${table} WHERE id = ?`,
    [oldId],
  );
  if (old === null) return;
  if (table === 'local_diary_entries') {
    await txn.runAsync(
      "UPDATE local_attachments SET local_entry_id = ? WHERE local_entry_id = ? AND state = 'waiting'",
      [newId, oldId],
    );
  }
  if (table === 'local_expenses') {
    await txn.runAsync(
      `UPDATE local_files SET owner_id = ?
        WHERE owner_table = 'local_expenses' AND owner_id = ? AND state = 'waiting'`,
      [newId, oldId],
    );
  }
  if (old.outbox_id !== null)
    await txn.runAsync('DELETE FROM outbox WHERE id = ?', [old.outbox_id]);
  await txn.runAsync(`DELETE FROM ${table} WHERE id = ?`, [oldId]);
}

const LOCAL_TABLES = new Set([
  'local_registers',
  'local_diary_entries',
  'local_attachments',
  'local_remarks',
  'local_expenses',
  'local_files',
  'local_claims',
  'local_assessments',
]);

/**
 * Deletes every photo file no live row points at (after a discard, a session loss, the unsent
 * window, a purge, and at startup). Done photos lost their files at `done`.
 */
export async function sweepPhotoFiles(): Promise<void> {
  const db = await getDb();
  const kept = await db.getAllAsync<{ file_path: string }>(
    `SELECT file_path FROM local_attachments WHERE state IN ('waiting', 'queued')
     UNION ALL SELECT file_path FROM local_files WHERE state IN ('waiting', 'queued')`,
  );
  deleteOutboxFilesExcept(kept.map((row) => row.file_path));
}
