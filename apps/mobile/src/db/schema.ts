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
];

/** Created before any migration runs, so the version can be read. */
export const META_DDL =
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);';

export const SCHEMA_VERSION = MIGRATIONS.length;
