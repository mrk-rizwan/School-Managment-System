// The device schema as a versioned array (slice-15 §7.2). Entry n moves the file from version n
// to n + 1; meta.schema_version records the level. Never edit a shipped entry: append one.

export const MIGRATIONS: readonly string[] = [
  // 1 — slice 15: meta, read cache, outbox.
  `
  CREATE TABLE cache (
    key TEXT PRIMARY KEY NOT NULL,
    body TEXT NOT NULL,
    server_time TEXT NOT NULL,
    server_time_is_device INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY NOT NULL,
    lane TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    natural_key TEXT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NULL,
    sending_since TEXT NULL,
    response_status INTEGER NULL,
    response_code TEXT NULL,
    response_message TEXT NULL,
    domain_table TEXT NULL,
    domain_id TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX outbox_lane_state_created ON outbox (lane, state, created_at);
  CREATE UNIQUE INDEX outbox_pending_natural_key ON outbox (natural_key)
    WHERE natural_key IS NOT NULL AND state = 'pending';
  `,
  // 2 — slice 16 §8: the offline writes' local rows. Ids and typed text only: no student name,
  // number or phone. Each row points at its outbox row; the outbox row points back.
  `
  CREATE TABLE local_registers (
    id TEXT PRIMARY KEY NOT NULL,
    section_id TEXT NOT NULL,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('new', 'amend')),
    reason TEXT NULL,
    outbox_id TEXT NULL,
    server_register_id TEXT NULL,
    saved_on_server_at TEXT NULL,
    summary TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (section_id, date, period)
  );
  CREATE TABLE local_marks (
    local_register_id TEXT NOT NULL REFERENCES local_registers (id) ON DELETE CASCADE,
    enrolment_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'on_leave')),
    note TEXT NULL,
    arrived_at TEXT NULL,
    UNIQUE (local_register_id, enrolment_id)
  );
  CREATE TABLE local_diary_entries (
    id TEXT PRIMARY KEY NOT NULL,
    section_id TEXT NOT NULL,
    date TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    assignment TEXT NULL,
    learning_outcome TEXT NULL,
    due_on TEXT NULL,
    outbox_id TEXT NULL,
    server_id TEXT NULL,
    saved_on_server_at TEXT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('queued', 'done', 'failed', 'superseded_by_server', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE local_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    local_entry_id TEXT NOT NULL REFERENCES local_diary_entries (id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'queued', 'done', 'failed', 'discarded')),
    staged_upload_id TEXT NULL,
    staged_expires_at TEXT NULL,
    reference_retries INTEGER NOT NULL DEFAULT 0,
    outbox_id TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE local_remarks (
    id TEXT PRIMARY KEY NOT NULL,
    student_id TEXT NOT NULL,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    visibility TEXT NULL,
    subject_id TEXT NULL,
    outbox_id TEXT NULL,
    server_id TEXT NULL,
    saved_on_server_at TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'done', 'failed', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX local_registers_outbox ON local_registers (outbox_id);
  CREATE INDEX local_diary_entries_section ON local_diary_entries (section_id, date);
  CREATE INDEX local_attachments_entry ON local_attachments (local_entry_id);
  CREATE INDEX local_remarks_student ON local_remarks (student_id);
  `,
  // 3 — slice 16b (wave-F review): what the server said a refused write would change — for a
  // register, the amendments it names (ids and statuses, never a name), shown by the remedy.
  `
  ALTER TABLE outbox ADD COLUMN response_details TEXT NULL;
  `,
  // 4 — Phase 3 slice 23 (§3.9): an expense captured offline, and the generic file row of the
  // staged_upload_patch lanes (an expense's receipt; slice 21's claim image). A file row waits
  // for its owner's server id, then is queued as a PATCH of that row. Typed text and ids only.
  `
  CREATE TABLE local_expenses (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL,
    spent_on TEXT NOT NULL,
    description TEXT NOT NULL,
    payee TEXT NULL,
    method TEXT NOT NULL,
    reference TEXT NULL,
    outbox_id TEXT NULL,
    server_id TEXT NULL,
    expense_no INTEGER NULL,
    server_status TEXT NULL,
    saved_on_server_at TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'done', 'failed', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE local_files (
    id TEXT PRIMARY KEY NOT NULL,
    owner_table TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'queued', 'done', 'failed', 'discarded')),
    staged_upload_id TEXT NULL,
    staged_expires_at TEXT NULL,
    reference_retries INTEGER NOT NULL DEFAULT 0,
    outbox_id TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX local_expenses_created ON local_expenses (created_at);
  CREATE INDEX local_files_owner ON local_files (owner_table, owner_id);
  `,
];

/**
 * Local rows follow their outbox row (slice-16 §8): once it is gone — purged after seven days,
 * discarded, or deleted by a session loss or the seven-day unsent window — the local row goes
 * too. A photo still waiting for its entry stays while the entry has a live outbox row or a
 * server id; an entry stays while it still has a photo row (the photo's PATCH needs it). Run in
 * the transaction that deleted the outbox rows.
 */
export const PURGE_ORPHAN_LOCAL_ROWS = `
  DELETE FROM local_attachments
   WHERE (outbox_id IS NOT NULL AND outbox_id NOT IN (SELECT id FROM outbox))
      OR (outbox_id IS NULL AND local_entry_id IN (
            SELECT e.id FROM local_diary_entries e
             WHERE e.server_id IS NULL
               AND (e.outbox_id IS NULL OR e.outbox_id NOT IN (SELECT id FROM outbox))));
  DELETE FROM local_registers
   WHERE outbox_id IS NULL OR outbox_id NOT IN (SELECT id FROM outbox);
  DELETE FROM local_remarks
   WHERE outbox_id IS NULL OR outbox_id NOT IN (SELECT id FROM outbox);
  DELETE FROM local_diary_entries
   WHERE (outbox_id IS NULL OR outbox_id NOT IN (SELECT id FROM outbox))
     AND NOT EXISTS (SELECT 1 FROM local_attachments a WHERE a.local_entry_id = local_diary_entries.id);
  DELETE FROM local_files
   WHERE (outbox_id IS NOT NULL AND outbox_id NOT IN (SELECT id FROM outbox))
      OR (outbox_id IS NULL AND owner_table = 'local_expenses' AND owner_id IN (
            SELECT e.id FROM local_expenses e
             WHERE e.server_id IS NULL
               AND (e.outbox_id IS NULL OR e.outbox_id NOT IN (SELECT id FROM outbox))));
  DELETE FROM local_expenses
   WHERE (outbox_id IS NULL OR outbox_id NOT IN (SELECT id FROM outbox))
     AND NOT EXISTS (SELECT 1 FROM local_files f
                      WHERE f.owner_table = 'local_expenses' AND f.owner_id = local_expenses.id);
`;

/** Created before any migration runs, so the version can be read. */
export const META_DDL =
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);';

export const SCHEMA_VERSION = MIGRATIONS.length;
