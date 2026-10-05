import { newIdempotencyKey, type AttendanceStatus } from '@asms/shared';
import { z } from 'zod';
import type { RegisterCountsDto } from '../api/contracts';
import { deleteOutboxFile, deleteOutboxFilesExcept } from '../media/files';
import { registerNaturalKey } from '../outbox/coalesce';
import {
  buildAttachmentBody,
  buildDiaryBody,
  buildRegisterBody,
  buildRemarkBody,
  type DiaryInput,
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

const OUTBOX_COLUMNS =
  'o.id AS o_id, o.state AS o_state, o.response_status AS o_status, o.response_code AS o_code, ' +
  'o.response_message AS o_message, o.response_details AS o_details, ' +
  'o.next_attempt_at AS o_next, o.updated_at AS o_updated';

function outboxOf(raw: unknown): OutboxView | null {
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
async function ownedTransaction(task: (txn: Db) => Promise<void>): Promise<void> {
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

export async function setStagedUpload(
  id: string,
  stagedUploadId: string,
  expiresAt: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE local_attachments SET staged_upload_id = ?, staged_expires_at = ?, updated_at = ? WHERE id = ?',
    [stagedUploadId, expiresAt, new Date().toISOString(), id],
  );
}

/** The staged upload was refused as gone: the next attempt uploads again; the refusal is counted. */
export async function clearStagedUpload(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE local_attachments SET staged_upload_id = NULL, staged_expires_at = NULL,
       reference_retries = reference_retries + 1, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

/** The photo is on the server: its row says so and its file is deleted. */
export async function markAttachmentDone(id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ file_path: string }>(
    'SELECT file_path FROM local_attachments WHERE id = ?',
    [id],
  );
  await db.runAsync(
    `UPDATE local_attachments SET state = 'done', staged_upload_id = NULL, updated_at = ?
     WHERE id = ?`,
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
    await txn.runAsync('DELETE FROM outbox WHERE id = ?', [outboxId]);
    await txn.runAsync('DELETE FROM local_diary_entries WHERE outbox_id = ?', [outboxId]);
    // A discarded photo's row (and, by the foreign key, an entry's photos) go too.
    await txn.runAsync('DELETE FROM local_attachments WHERE outbox_id = ?', [outboxId]);
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
  table: 'local_diary_entries' | 'local_remarks',
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
  if (old.outbox_id !== null)
    await txn.runAsync('DELETE FROM outbox WHERE id = ?', [old.outbox_id]);
  await txn.runAsync(`DELETE FROM ${table} WHERE id = ?`, [oldId]);
}

const LOCAL_TABLES = new Set([
  'local_registers',
  'local_diary_entries',
  'local_attachments',
  'local_remarks',
]);

/**
 * Deletes every photo file no live row points at (after a discard, a session loss, the unsent
 * window, a purge, and at startup). Done photos lost their files at `done`.
 */
export async function sweepPhotoFiles(): Promise<void> {
  const db = await getDb();
  const kept = await db.getAllAsync<{ file_path: string }>(
    "SELECT file_path FROM local_attachments WHERE state IN ('waiting', 'queued')",
  );
  deleteOutboxFilesExcept(kept.map((row) => row.file_path));
}
