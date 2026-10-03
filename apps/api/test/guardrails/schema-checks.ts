// The schema guard (plan 0.5, R60). Reads the migrated database's catalog, not Prisma metadata,
// so hand-written SQL in migrations is checked too. Every check returns violations as readable
// strings, which lets the self-test assert that each one fires.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ClientBase } from 'pg';
import { NON_TENANT_MODELS, TENANT_MODELS } from '../../src/repositories/query-guard';

/**
 * Tables that legitimately carry no tenant key (CLAUDE.md named exception 1, plus Prisma's own).
 * Derived from the query guard's model list so the two allowlists cannot drift.
 */
export const NON_TENANT_TABLES: ReadonlySet<string> = new Set([
  ...Object.values(NON_TENANT_MODELS),
  '_prisma_migrations',
]);

export interface SchemaField {
  name: string;
  type: string;
}
export interface SchemaModel {
  name: string;
  fields: SchemaField[];
  table: string | undefined;
}

/** The models of a schema.prisma text: name, fields and @@map table. */
export function parseModels(schema: string): SchemaModel[] {
  return [...schema.matchAll(/^[ \t]*model\s+(\w+)\s*\{([\s\S]*?)^[ \t]*\}/gm)].map(
    ([, name, body]) => {
      const lines = (body ?? '').split('\n').map((line) => line.replace(/\/\/.*$/, '').trim());
      return {
        name: name ?? '',
        fields: lines.flatMap((line) => {
          const field = /^(\w+)\s+(\w+)/.exec(line);
          return field?.[1] && field[2] ? [{ name: field[1], type: field[2] }] : [];
        }),
        table: lines.map((line) => /^@@map\("([^"]+)"\)/.exec(line)?.[1]).find(Boolean),
      };
    },
  );
}

/**
 * The tables of the models the query guard treats as tenant models (TENANT_MODELS, derived from
 * the generated client), mapped through prisma/schema.prisma. The schema guard requires the
 * tenant tables it finds in the database to be exactly these: a tenant table no model maps is
 * one the query guard never sees.
 */
export function tenantModelTables(
  schema: string = readFileSync(join(resolve(__dirname, '../..'), 'prisma/schema.prisma'), 'utf8'),
  tenantModels: ReadonlySet<string> = TENANT_MODELS,
): ReadonlySet<string> {
  const models = parseModels(schema);
  return new Set(
    [...tenantModels].map((name) => models.find((m) => m.name === name)?.table ?? name),
  );
}

/** The trigger function every tenant table attaches BEFORE UPDATE (migration school_id_immutable). */
export const SCHOOL_ID_IMMUTABLE_FUNCTION = 'asms_forbid_school_id_change';

/** Indexes on tenant tables that may lead with a column other than school_id: `table.column`. */
export const NON_SCHOOL_LEADING_INDEXES = new Set(['sessions.token_hash']);

export type ExpectedObject =
  | {
      kind: 'index' | 'constraint' | 'trigger';
      table: string;
      name: string;
      /** A fragment that must appear in pg_get_indexdef / pg_get_constraintdef / pg_get_triggerdef. */
      definition?: string;
    }
  | {
      /** A trigger function: its body carries the constraint name the error mapper reads. */
      kind: 'function';
      name: string;
      /** A fragment that must appear in pg_get_functiondef. */
      definition?: string;
    };

/**
 * Hand-written partial indexes, CHECKs, the exclusion constraint, triggers and trigger functions.
 * Prisma cannot express them, so nothing else notices when a migration drops one. Each slice
 * appends what it adds.
 *
 * Trigger functions raise SQLSTATE 23514 with DETAIL 'constraint: <name>': Prisma 7's pg adapter
 * forwards detail but drops the constraint field for every code except 23505 and 23503
 * (migration 20261002163440_trigger_errors_name_constraint).
 */
export const EXPECTED_OBJECTS: ExpectedObject[] = [
  // Slice 1: trigger functions.
  {
    kind: 'function',
    name: SCHOOL_ID_IMMUTABLE_FUNCTION,
    definition: `DETAIL = 'constraint: ' || TG_TABLE_NAME || '_school_id_immutable'`,
  },
  {
    kind: 'function',
    name: 'asms_forbid_short_code_change',
    definition: `DETAIL = 'constraint: schools_short_code_immutable'`,
  },
  {
    kind: 'function',
    name: 'asms_forbid_append_only_change',
    definition: `DETAIL = 'constraint: ' || TG_TABLE_NAME || '_append_only'`,
  },
  // Slice 1: schools.
  {
    kind: 'constraint',
    table: 'schools',
    name: 'schools_short_code_format_check',
    definition: `(short_code)::text ~ '^[a-z0-9]{3,12}$'::text`,
  },
  {
    kind: 'trigger',
    table: 'schools',
    name: 'schools_short_code_immutable',
    definition:
      'BEFORE UPDATE ON public.schools FOR EACH ROW EXECUTE FUNCTION asms_forbid_short_code_change()',
  },
  // Slice 1: platform_users.
  {
    kind: 'constraint',
    table: 'platform_users',
    name: 'platform_users_email_normalised_check',
    definition: '(email)::text = lower(btrim((email)::text))',
  },
  {
    kind: 'constraint',
    table: 'platform_users',
    name: 'platform_users_password_hash_check',
    definition: `(password_hash)::text ~~ '$argon2id$%'::text`,
  },
  {
    kind: 'constraint',
    table: 'platform_users',
    name: 'platform_users_totp_secret_check',
    definition: `(totp_secret)::text ~~ 'v1:%'::text`,
  },
  {
    kind: 'constraint',
    table: 'platform_users',
    name: 'platform_users_totp_enrolled_check',
    definition: '(totp_enrolled_at IS NULL) OR (totp_secret IS NOT NULL)',
  },
  // Slice 1: platform_sessions.
  {
    kind: 'constraint',
    table: 'platform_sessions',
    name: 'platform_sessions_token_hash_check',
    definition: `token_hash ~ '^[0-9a-f]{64}$'::text`,
  },
  {
    kind: 'constraint',
    table: 'platform_sessions',
    name: 'platform_sessions_expires_at_check',
    definition: 'expires_at > created_at',
  },
  // Slice 1: platform_audit_log.
  {
    kind: 'constraint',
    table: 'platform_audit_log',
    name: 'platform_audit_log_metadata_no_id_check',
    definition: `((metadata)::text !~ '[0-9]{13}'::text) AND ((metadata)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)`,
  },
  {
    kind: 'constraint',
    table: 'platform_audit_log',
    name: 'platform_audit_log_reason_no_id_check',
    definition: `((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)`,
  },
  {
    kind: 'constraint',
    table: 'platform_audit_log',
    name: 'platform_audit_log_actor_check',
    definition: `(actor_platform_user_id IS NOT NULL) OR ((action)::text = 'platform_user.seeded'::text)`,
  },
  {
    kind: 'trigger',
    table: 'platform_audit_log',
    name: 'platform_audit_log_append_only',
    definition:
      'BEFORE DELETE OR UPDATE ON public.platform_audit_log FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  {
    kind: 'trigger',
    table: 'platform_audit_log',
    name: 'platform_audit_log_no_truncate',
    definition:
      'BEFORE TRUNCATE ON public.platform_audit_log FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  // Slice 1: tenant tables. Their school_id FK and immutability trigger are checked generically by
  // checkSchema; these are the table-specific CHECKs.
  {
    kind: 'constraint',
    table: 'school_settings',
    name: 'school_settings_fee_due_day_check',
    definition: '(fee_due_day >= 1) AND (fee_due_day <= 28)',
  },
  {
    kind: 'constraint',
    table: 'school_counters',
    name: 'school_counters_name_check',
    definition: `(name)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text`,
  },
  {
    kind: 'constraint',
    table: 'school_counters',
    name: 'school_counters_value_check',
    definition: 'value >= 0',
  },
];

interface Column {
  table: string;
  column: string;
  type: string;
  notNull: boolean;
}
interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}
interface Index {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  partial: boolean;
}

async function readCatalog(db: ClientBase, schema: string) {
  const tables = (
    await db.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY 1`,
      [schema],
    )
  ).rows.map((r) => r.table);

  const columns = (
    await db.query<Column>(
      `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS "notNull"
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
      [schema],
    )
  ).rows;

  // Column arrays keep key order, so (school_id, parent_id) pairs with (school_id, id) positionally.
  const foreignKeys = (
    await db.query<ForeignKey>(
      `SELECT con.conname AS name, c.relname AS table, rc.relname AS "refTable",
              confdeltype AS "onDelete", confupdtype AS "onUpdate",
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, i)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.i)::text[] AS columns,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, i)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.i)::text[] AS "refColumns"
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND con.contype = 'f'`,
      [schema],
    )
  ).rows;

  // Key columns only: INCLUDE columns do not order or constrain the index, so they satisfy no
  // check. An expression column (attnum 0) is reported as '<expr>', never dropped.
  const indexes = (
    await db.query<Index>(
      `SELECT ic.relname AS name, c.relname AS table, i.indisunique AS unique, i.indisprimary AS primary,
              i.indpred IS NOT NULL AS partial,
              ARRAY(SELECT COALESCE(a.attname, '<expr>') FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
                    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum AND k.attnum <> 0
                    WHERE k.n <= i.indnkeyatts ORDER BY k.n)::text[] AS columns
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1`,
      [schema],
    )
  ).rows;

  // Row-level BEFORE UPDATE triggers that are enabled, by the function they call. tgtype bits:
  // 1 = ROW, 2 = BEFORE, 16 = UPDATE.
  const immutableTriggers = (
    await db.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND p.proname = $2
         AND t.tgtype & 1 = 1 AND t.tgtype & 2 = 2 AND t.tgtype & 16 = 16`,
      [schema, SCHOOL_ID_IMMUTABLE_FUNCTION],
    )
  ).rows.map((r) => r.table);

  return { tables, columns, foreignKeys, indexes, immutableTriggers };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const RULES: Record<string, string> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/** Runs every structural check against one schema and returns the violations found. */
export async function checkSchema(
  db: ClientBase,
  schema = 'public',
  expectedTenantTables: ReadonlySet<string> = tenantModelTables(),
): Promise<string[]> {
  const { tables, columns, foreignKeys, indexes, immutableTriggers } = await readCatalog(
    db,
    schema,
  );
  const tenantTables = new Set(tables.filter((t) => !NON_TENANT_TABLES.has(t)));
  const violations: string[] = [];

  for (const table of tenantTables) {
    if (!expectedTenantTables.has(table)) {
      violations.push(
        `${table}: a tenant table that no tenant model maps; the query guard never sees it`,
      );
    }
  }
  for (const table of expectedTenantTables) {
    if (!tenantTables.has(table)) {
      violations.push(`${table}: mapped by a tenant model but not a tenant table in the database`);
    }
  }

  for (const table of tenantTables) {
    const schoolId = columns.find((c) => c.table === table && c.column === 'school_id');
    if (!schoolId || schoolId.type !== 'bigint' || !schoolId.notNull) {
      violations.push(`${table}: needs school_id bigint NOT NULL`);
    }
    if (
      !foreignKeys.some(
        (fk) =>
          fk.table === table &&
          fk.refTable === 'schools' &&
          same(fk.columns, ['school_id']) &&
          same(fk.refColumns, ['id']),
      )
    ) {
      violations.push(`${table}: needs a foreign key (school_id) REFERENCES schools (id)`);
    }
    if (!immutableTriggers.includes(table)) {
      violations.push(
        `${table}: needs a BEFORE UPDATE row trigger calling ${SCHOOL_ID_IMMUTABLE_FUNCTION}()`,
      );
    }
    // Plain (non-partial) unique: the target of every composite foreign key into this table.
    if (
      !indexes.some(
        (i) => i.table === table && i.unique && !i.partial && same(i.columns, ['school_id', 'id']),
      )
    ) {
      violations.push(`${table}: needs a unique index on exactly (school_id, id)`);
    }
    for (const { column } of columns.filter(
      (c) => c.table === table && /_(id|by)$/.test(c.column),
    )) {
      if (!foreignKeys.some((fk) => fk.table === table && fk.columns.includes(column))) {
        violations.push(`${table}.${column}: an *_id / *_by column must be a foreign key`);
      }
    }
  }

  for (const fk of foreignKeys) {
    if (tenantTables.has(fk.table) && tenantTables.has(fk.refTable)) {
      const at = fk.columns.indexOf('school_id');
      if (at === -1 || fk.refColumns[at] !== 'school_id') {
        violations.push(
          `${fk.name}: a foreign key between tenant tables must pair school_id with school_id`,
        );
      }
    }
    if (
      !indexes.some(
        (i) => i.table === fk.table && sameSet(i.columns.slice(0, fk.columns.length), fk.columns),
      )
    ) {
      violations.push(`${fk.name}: no index on ${fk.table} leads with (${fk.columns.join(', ')})`);
    }
    for (const [action, code] of [
      ['ON DELETE', fk.onDelete],
      ['ON UPDATE', fk.onUpdate],
    ] as const) {
      if (code === 'c' || code === 'n' || code === 'd') {
        violations.push(
          `${fk.name}: ${action} ${RULES[code]?.toUpperCase()} is not allowed (rule 4: never hard-delete)`,
        );
      }
    }
  }

  for (const index of indexes) {
    if (!tenantTables.has(index.table) || index.primary || index.columns[0] === 'school_id')
      continue;
    if (!NON_SCHOOL_LEADING_INDEXES.has(`${index.table}.${index.columns[0]}`)) {
      violations.push(`${index.name}: an index on a tenant table must lead with school_id`);
    }
  }

  return violations;
}

/** Checks that each named hand-written object exists and, if given, matches its definition. */
export async function checkExpectedObjects(
  db: ClientBase,
  expected: readonly ExpectedObject[],
  schema = 'public',
): Promise<string[]> {
  const violations: string[] = [];
  for (const object of expected) {
    if (object.kind === 'function') {
      const { rows } = await db.query<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2`,
        [schema, object.name],
      );
      const def = rows[0]?.def;
      if (def === undefined) {
        violations.push(`function ${object.name} is missing`);
      } else if (object.definition && !def.includes(object.definition)) {
        violations.push(`function ${object.name} has changed: ${def}`);
      }
      continue;
    }
    const sql = {
      index: `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
              JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND ic.relname = $3`,
      constraint: `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
                   JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3`,
      trigger: `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal`,
    }[object.kind];
    const { rows } = await db.query<{ def: string }>(sql, [schema, object.table, object.name]);
    const def = rows[0]?.def;
    if (def === undefined) {
      violations.push(`${object.kind} ${object.table}.${object.name} is missing`);
    } else if (object.definition && !def.includes(object.definition)) {
      violations.push(`${object.kind} ${object.table}.${object.name} has changed: ${def}`);
    }
  }
  return violations;
}
