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


/**
 * Indexes on tenant tables that may lead with a column other than school_id: `table.column`.
 * - sessions.token_hash: resolving a session establishes the tenant (named exception 4).
 * - whatsapp_numbers.waha_session, whatsapp_numbers.cloud_phone_number_id, message_deliveries.channel
 *   (the provider-reference index): a delivery webhook names a provider reference, not a school
 *   (named exception 5, phase-2-daily-operations.md §4.1).
 */
export const NON_SCHOOL_LEADING_INDEXES = new Set([
  'sessions.token_hash',
  'whatsapp_numbers.waha_session',
  'whatsapp_numbers.cloud_phone_number_id',
  'message_deliveries.channel',
]);

/**
 * `table.column` *_id columns on tenant tables that cannot be foreign keys. Each needs a stated
 * reason; a column waiting for its target table is not one (add the column with its FK instead).
 * - audit_log.subject_id: polymorphic, names a row of the table in subject_type.
 * - audit_log.actor_platform_user_id: points at the non-tenant platform_users. The FK cannot be
 *   declared in schema.prisma (prisma-relations.spec.ts allows a tenant model to relate only to
 *   School), and an FK absent from schema.prisma is dropped as drift by the next migration.
 * - idempotency_keys.subject_id: polymorphic, names a row of the table in subject_type.
 * - messages.subject_id: polymorphic, names a row of the table in subject_type (plan §5).
 * - whatsapp_numbers.cloud_phone_number_id: Meta's identifier for the number, not a row id.
 *
 * holidays.announcement_id was listed until slice 14 added its foreign key
 * (contracts/slice-14.md §11 item 7).
 */
export const NON_FK_ID_COLUMNS = new Set([
  'audit_log.subject_id',
  'audit_log.actor_platform_user_id',
  'idempotency_keys.subject_id',
  'messages.subject_id',
  'whatsapp_numbers.cloud_phone_number_id',
]);

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
    definition: `(actor_platform_user_id IS NOT NULL) OR ((action)::text = ANY ((ARRAY['platform_user.seeded'::character varying, 'login_failure_spike'::character varying])::text[]))`,
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
  // Wave A: trigger function behind classes_academic_year_immutable.
  {
    kind: 'function',
    name: 'asms_forbid_class_year_change',
    definition: "DETAIL = 'constraint: classes_academic_year_immutable'",
  },
  // Slice 3: academic structure.
  {
    kind: 'constraint',
    table: 'academic_years',
    name: 'academic_years_dates_check',
    definition: 'CHECK ((ends_on > starts_on))',
  },
  {
    kind: 'constraint',
    table: 'academic_years',
    name: 'academic_years_name_check',
    definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))",
  },
  {
    kind: 'constraint',
    table: 'classes',
    name: 'classes_name_check',
    definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))",
  },
  {
    kind: 'constraint',
    table: 'classes',
    name: 'classes_sort_order_check',
    definition: 'CHECK ((sort_order >= 0))',
  },
  {
    kind: 'trigger',
    table: 'classes',
    name: 'classes_academic_year_immutable',
    definition:
      'BEFORE UPDATE OF academic_year_id ON public.classes FOR EACH ROW WHEN ((old.academic_year_id IS DISTINCT FROM new.academic_year_id)) EXECUTE FUNCTION asms_forbid_class_year_change()',
  },
  {
    kind: 'index',
    table: 'sections',
    name: 'sections_school_id_class_id_name_key',
    definition: 'USING btree (school_id, class_id, name) WHERE (deleted_at IS NULL)',
  },
  {
    kind: 'constraint',
    table: 'sections',
    name: 'sections_capacity_check',
    definition: 'CHECK (((capacity IS NULL) OR (capacity >= 1)))',
  },
  {
    kind: 'constraint',
    table: 'sections',
    name: 'sections_name_check',
    definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))",
  },
  {
    kind: 'index',
    table: 'subjects',
    name: 'subjects_school_id_code_key',
    definition: 'USING btree (school_id, code) WHERE ((code IS NOT NULL) AND (deleted_at IS NULL))',
  },
  {
    kind: 'index',
    table: 'subjects',
    name: 'subjects_school_id_name_key',
    definition: 'USING btree (school_id, name) WHERE (deleted_at IS NULL)',
  },
  {
    kind: 'constraint',
    table: 'subjects',
    name: 'subjects_code_check',
    definition:
      "CHECK (((code IS NULL) OR (((code)::text = btrim((code)::text)) AND ((code)::text <> ''::text))))",
  },
  {
    kind: 'constraint',
    table: 'subjects',
    name: 'subjects_name_check',
    definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))",
  },
  // Slice 5: guardians.
  {
    kind: 'index',
    table: 'guardians',
    name: 'guardians_school_id_cnic_hash_key',
    definition: 'USING btree (school_id, cnic_hash) WHERE (cnic_hash IS NOT NULL)',
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_cnic_check',
    definition: "CHECK (((cnic IS NULL) OR ((cnic)::text ~~ 'v1:%'::text)))",
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_cnic_hash_check',
    definition: "CHECK (((cnic_hash IS NULL) OR (cnic_hash ~ '^[0-9a-f]{64}$'::text)))",
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_cnic_pair_check',
    definition: 'CHECK (((cnic IS NULL) = (cnic_hash IS NULL)))',
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_email_normalised_check',
    definition:
      "CHECK (((email IS NULL) OR (((email)::text = lower(btrim((email)::text))) AND (POSITION(('@'::text) IN (email)) > 1))))",
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_full_name_check',
    definition:
      "CHECK ((((full_name)::text = btrim((full_name)::text)) AND ((full_name)::text <> ''::text)))",
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_merged_check',
    definition: "CHECK (((status = 'merged'::guardian_status) = (merged_into_id IS NOT NULL)))",
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_merged_into_self_check',
    definition: 'CHECK (((merged_into_id IS NULL) OR (merged_into_id <> id)))',
  },
  {
    kind: 'constraint',
    table: 'guardians',
    name: 'guardians_phone_check',
    definition: "CHECK (((phone IS NULL) OR ((phone)::text ~ '^\\+[1-9][0-9]{7,14}$'::text)))",
  },
  // Slice 2: identity, sessions, roles, audit.
  {
    kind: 'index',
    table: 'staff',
    name: 'staff_school_id_cnic_hash_key',
    definition: 'USING btree (school_id, cnic_hash) WHERE (cnic_hash IS NOT NULL)',
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_cnic_check',
    definition: "CHECK (((cnic IS NULL) OR ((cnic)::text ~~ 'v1:%'::text)))",
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_cnic_hash_check',
    definition: "CHECK (((cnic_hash IS NULL) OR (cnic_hash ~ '^[0-9a-f]{64}$'::text)))",
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_cnic_pair_check',
    definition: 'CHECK (((cnic IS NULL) = (cnic_hash IS NULL)))',
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_full_name_check',
    definition:
      "CHECK ((((full_name)::text = btrim((full_name)::text)) AND ((full_name)::text <> ''::text)))",
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_phone_check',
    definition: "CHECK (((phone)::text ~ '^\\+[1-9][0-9]{7,14}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'users',
    name: 'users_email_normalised_check',
    definition:
      "CHECK (((email IS NULL) OR (((email)::text = lower(btrim((email)::text))) AND (POSITION(('@'::text) IN (email)) > 1))))",
  },
  {
    kind: 'constraint',
    table: 'users',
    name: 'users_email_verified_check',
    definition: 'CHECK (((email_verified_at IS NULL) OR (email IS NOT NULL)))',
  },
  {
    kind: 'constraint',
    table: 'users',
    name: 'users_password_hash_check',
    definition: "CHECK (((password_hash)::text ~~ '$argon2id$%'::text))",
  },
  {
    kind: 'constraint',
    table: 'users',
    name: 'users_person_check',
    definition: 'CHECK ((num_nonnulls(staff_id, guardian_id, student_id) >= 1))',
  },
  {
    kind: 'constraint',
    table: 'users',
    name: 'users_username_hash_check',
    definition: "CHECK ((username_hash ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'sessions',
    name: 'sessions_expires_at_check',
    definition: 'CHECK ((expires_at > created_at))',
  },
  {
    kind: 'constraint',
    table: 'sessions',
    name: 'sessions_token_hash_check',
    definition: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'user_tokens',
    name: 'user_tokens_email_check',
    definition: "CHECK (((purpose = 'email_verify'::user_token_purpose) = (email IS NOT NULL)))",
  },
  {
    kind: 'constraint',
    table: 'user_tokens',
    name: 'user_tokens_email_normalised_check',
    definition:
      "CHECK (((email IS NULL) OR (((email)::text = lower(btrim((email)::text))) AND (POSITION(('@'::text) IN (email)) > 1))))",
  },
  {
    kind: 'constraint',
    table: 'user_tokens',
    name: 'user_tokens_token_hash_check',
    definition: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    kind: 'index',
    table: 'user_roles',
    name: 'user_roles_school_id_user_id_system_role_key',
    definition:
      'USING btree (school_id, user_id, system_role) WHERE ((system_role IS NOT NULL) AND (ended_at IS NULL))',
  },
  {
    kind: 'constraint',
    table: 'user_roles',
    name: 'user_roles_assigned_by_check',
    // Slice-7 review (A8): IS NOT DISTINCT FROM, so a custom-role row cannot pass on NULL.
    definition:
      "CHECK (((assigned_by IS NOT NULL) OR (NOT (system_role IS DISTINCT FROM 'principal'::system_role))))",
  },
  {
    kind: 'constraint',
    table: 'user_roles',
    name: 'user_roles_ended_check',
    definition:
      'CHECK ((((ended_at IS NULL) = (ended_by IS NULL)) AND ((ended_at IS NULL) OR (ended_at >= assigned_at))))',
  },
  {
    kind: 'constraint',
    table: 'user_roles',
    name: 'user_roles_one_role_check',
    definition: 'CHECK ((num_nonnulls(system_role, custom_role_id) = 1))',
  },
  {
    kind: 'constraint',
    table: 'audit_log',
    name: 'audit_log_actor_check',
    // Migration 20261006130000_slice19_system_actor_audit (A19): a job's row has no actor and
    // names the job in its metadata.
    definition: "CHECK (((num_nonnulls(actor_user_id, actor_platform_user_id) = 1) OR ((num_nonnulls(actor_user_id, actor_platform_user_id) = 0) AND (metadata ? 'job'::text))))",
  },
  {
    kind: 'constraint',
    table: 'audit_log',
    name: 'audit_log_metadata_no_id_check',
    definition:
      "CHECK ((((metadata)::text !~ '[0-9]{13}'::text) AND ((metadata)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))",
  },
  {
    kind: 'constraint',
    table: 'audit_log',
    name: 'audit_log_reason_no_id_check',
    definition:
      "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))",
  },
  {
    kind: 'trigger',
    table: 'audit_log',
    name: 'audit_log_append_only',
    definition:
      'BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  {
    kind: 'trigger',
    table: 'audit_log',
    name: 'audit_log_no_truncate',
    definition:
      'BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()',
  }, // Wave B: shared trigger functions.
  {
    kind: 'function',
    name: 'asms_forbid_columns_change',
    definition: "DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_immutable'",
  },
  {
    kind: 'function',
    name: 'asms_require_idempotency_subject',
    definition: "DETAIL = 'constraint: idempotency_keys_subject_required'",
  },
  // Slice 4: staff, teacher assignments (the EXCLUDE is checked as a constraint; its gist index
  // shares the name).
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_left_on_after_joined_check',
    definition: 'CHECK (((left_on IS NULL) OR (joined_on IS NULL) OR (left_on >= joined_on)))',
  },
  {
    kind: 'constraint',
    table: 'staff',
    name: 'staff_left_on_check',
    definition: "CHECK (((left_on IS NULL) OR (status = 'left'::staff_status)))",
  },
  {
    kind: 'constraint',
    table: 'teacher_assignments',
    name: 'teacher_assignments_class_teacher_check',
    definition:
      "CHECK (((role <> 'class_teacher'::teacher_assignment_role) OR ((section_id IS NOT NULL) AND (subject_id IS NULL))))",
  },
  {
    kind: 'constraint',
    table: 'teacher_assignments',
    name: 'teacher_assignments_class_teacher_excl',
    definition:
      "EXCLUDE USING gist (school_id WITH =, section_id WITH =, daterange(starts_on, ends_on, '[]'::text) WITH &&) WHERE (((role = 'class_teacher'::teacher_assignment_role) AND (voided_at IS NULL)))",
  },
  {
    kind: 'constraint',
    table: 'teacher_assignments',
    name: 'teacher_assignments_dates_check',
    definition: 'CHECK (((ends_on IS NULL) OR (ends_on >= starts_on)))',
  },
  {
    kind: 'constraint',
    table: 'teacher_assignments',
    name: 'teacher_assignments_subject_teacher_check',
    definition:
      "CHECK (((role <> 'subject_teacher'::teacher_assignment_role) OR (subject_id IS NOT NULL)))",
  },
  {
    kind: 'constraint',
    table: 'teacher_assignments',
    name: 'teacher_assignments_voided_check',
    definition: 'CHECK (((voided_at IS NULL) = (voided_by IS NULL)))',
  },
  {
    kind: 'trigger',
    table: 'teacher_assignments',
    name: 'teacher_assignments_columns_immutable',
    definition:
      "BEFORE UPDATE ON public.teacher_assignments FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'academic_year_id', 'class_id', 'section_id', 'subject_id', 'role', 'starts_on', 'covers_assignment_id')",
  },
  // Slice 6: students, guardian links, enrolments, documents, uploads, idempotency.
  {
    kind: 'constraint',
    table: 'enrolments',
    name: 'enrolments_ended_check',
    definition:
      // Relaxed by one day in Phase 2: the zero-length enrolment of a same-day section or class
      // correction (contracts/slice-10.md §8.1).
      "CHECK ((((status = 'active'::enrolment_status) = (ended_on IS NULL)) AND ((ended_on IS NULL) OR (ended_on >= (started_on - 1)))))",
  },
  {
    kind: 'constraint',
    table: 'enrolments',
    name: 'enrolments_roll_no_check',
    definition: 'CHECK (((roll_no IS NULL) OR ((roll_no >= 1) AND (roll_no <= 9999))))',
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_endpoint_check',
    definition: "CHECK (((endpoint)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_key_check',
    definition: "CHECK (((key)::text ~ '^[A-Za-z0-9_-]{16,64}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_key_no_id_check',
    definition: "CHECK (((key)::text !~ '[0-9]{13}'::text))",
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_request_hash_check',
    definition: "CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_response_status_check',
    definition: 'CHECK (((response_status >= 200) AND (response_status <= 299)))',
  },
  {
    kind: 'constraint',
    table: 'idempotency_keys',
    name: 'idempotency_keys_subject_type_check',
    definition: "CHECK (((subject_type)::text ~ '^[a-z][a-z_]{0,31}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'staged_uploads',
    name: 'staged_uploads_expires_at_check',
    definition: 'CHECK ((expires_at > created_at))',
  },
  {
    kind: 'constraint',
    table: 'staged_uploads',
    name: 'staged_uploads_mime_check',
    definition:
      "CHECK (((mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'application/pdf'::character varying])::text[])))",
  },
  {
    kind: 'constraint',
    table: 'staged_uploads',
    name: 'staged_uploads_object_key_check',
    definition:
      "CHECK (((object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)))",
  },
  {
    kind: 'constraint',
    table: 'staged_uploads',
    name: 'staged_uploads_size_bytes_check',
    definition: 'CHECK (((size_bytes >= 1) AND (size_bytes <= 5242880)))',
  },
  {
    kind: 'constraint',
    table: 'student_documents',
    name: 'student_documents_mime_check',
    definition:
      "CHECK (((mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'application/pdf'::character varying])::text[])))",
  },
  {
    kind: 'constraint',
    table: 'student_documents',
    name: 'student_documents_object_key_check',
    definition:
      "CHECK (((object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)))",
  },
  {
    kind: 'constraint',
    table: 'student_documents',
    name: 'student_documents_photo_mime_check',
    definition:
      "CHECK (((type <> 'photo'::student_document_type) OR ((mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying])::text[]))))",
  },
  {
    kind: 'constraint',
    table: 'student_documents',
    name: 'student_documents_size_bytes_check',
    definition: 'CHECK (((size_bytes >= 1) AND (size_bytes <= 5242880)))',
  },
  {
    kind: 'constraint',
    table: 'student_status_changes',
    name: 'student_status_changes_reason_no_id_check',
    definition:
      "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))",
  },
  {
    kind: 'constraint',
    table: 'student_status_changes',
    name: 'student_status_changes_transition_check',
    definition:
      "CHECK (((from_status IS DISTINCT FROM to_status) AND ((from_status IS NOT NULL) OR (to_status = 'active'::student_status))))",
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_admission_no_check',
    definition: "CHECK (((admission_no)::text ~ '^[1-9][0-9]{0,11}$'::text))",
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_b_form_check',
    definition: "CHECK (((b_form IS NULL) OR ((b_form)::text ~~ 'v1:%'::text)))",
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_b_form_hash_check',
    definition: "CHECK (((b_form_hash IS NULL) OR (b_form_hash ~ '^[0-9a-f]{64}$'::text)))",
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_b_form_pair_check',
    definition: 'CHECK (((b_form IS NULL) = (b_form_hash IS NULL)))',
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_date_of_birth_check',
    definition: 'CHECK ((date_of_birth < admitted_on))',
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_full_name_check',
    definition:
      "CHECK ((((full_name)::text = btrim((full_name)::text)) AND ((full_name)::text <> ''::text)))",
  },
  {
    kind: 'constraint',
    table: 'students',
    name: 'students_notes_no_id_check',
    definition:
      "CHECK ((((notes)::text !~ '[0-9]{13}'::text) AND ((notes)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))",
  },
  {
    kind: 'index',
    table: 'enrolments',
    name: 'enrolments_section_roll_no_key',
    definition:
      "USING btree (school_id, section_id, roll_no) WHERE ((roll_no IS NOT NULL) AND (status = 'active'::enrolment_status))",
  },
  {
    kind: 'index',
    table: 'enrolments',
    name: 'enrolments_student_active_key',
    definition: "USING btree (school_id, student_id) WHERE (status = 'active'::enrolment_status)",
  },
  {
    kind: 'index',
    table: 'student_guardians',
    name: 'student_guardians_live_pair_key',
    definition: 'USING btree (school_id, student_id, guardian_id) WHERE (ended_at IS NULL)',
  },
  {
    kind: 'index',
    table: 'student_guardians',
    name: 'student_guardians_primary_key',
    definition:
      'USING btree (school_id, student_id) WHERE (is_primary_contact AND (ended_at IS NULL))',
  },
  {
    kind: 'index',
    table: 'students',
    name: 'students_school_id_b_form_hash_key',
    definition: 'USING btree (school_id, b_form_hash) WHERE (b_form_hash IS NOT NULL)',
  },
  {
    kind: 'trigger',
    table: 'enrolments',
    name: 'enrolments_columns_immutable',
    definition:
      "BEFORE UPDATE ON public.enrolments FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('student_id', 'academic_year_id', 'class_id', 'section_id')",
  },
  {
    kind: 'trigger',
    table: 'idempotency_keys',
    name: 'idempotency_keys_subject_required',
    definition:
      'AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asms_require_idempotency_subject()',
  },
  {
    kind: 'trigger',
    table: 'student_documents',
    name: 'student_documents_append_only',
    definition:
      'BEFORE DELETE OR UPDATE ON public.student_documents FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  {
    kind: 'trigger',
    table: 'student_documents',
    name: 'student_documents_no_truncate',
    definition:
      'BEFORE TRUNCATE ON public.student_documents FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  {
    kind: 'trigger',
    table: 'student_guardians',
    name: 'student_guardians_columns_immutable',
    definition:
      "BEFORE UPDATE ON public.student_guardians FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('student_id', 'guardian_id')",
  },
  {
    kind: 'trigger',
    table: 'student_status_changes',
    name: 'student_status_changes_append_only',
    definition:
      'BEFORE DELETE OR UPDATE ON public.student_status_changes FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  {
    kind: 'trigger',
    table: 'student_status_changes',
    name: 'student_status_changes_no_truncate',
    definition:
      'BEFORE TRUNCATE ON public.student_status_changes FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  // Slice 7: custom roles, grants (contracts/slice-7.md §6).
  {
    kind: 'function',
    name: 'asms_grant_end_only',
    definition: "DETAIL = 'constraint: user_capability_grants_end_only'",
  },
  {
    kind: 'index',
    table: 'user_roles',
    name: 'user_roles_school_id_user_id_custom_role_key',
    definition:
      'USING btree (school_id, user_id, custom_role_id) WHERE ((custom_role_id IS NOT NULL) AND (ended_at IS NULL))',
  },
  {
    kind: 'index',
    table: 'custom_roles',
    name: 'custom_roles_school_id_key_key',
    definition: "USING btree (school_id, key) WHERE (status = 'active'::custom_role_status)",
  },
  { kind: 'constraint', table: 'custom_roles', name: 'custom_roles_key_check' },
  { kind: 'constraint', table: 'custom_roles', name: 'custom_roles_name_check' },
  {
    kind: 'trigger',
    table: 'custom_roles',
    name: 'custom_roles_columns_immutable',
    definition: "EXECUTE FUNCTION asms_forbid_columns_change('key')",
  },
  {
    kind: 'constraint',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_no_role_manage_check',
    definition: "CHECK (((capability_key)::text <> 'role.manage'::text))",
  },
  {
    kind: 'constraint',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_key_format_check',
  },
  {
    kind: 'constraint',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_removed_check',
  },
  {
    kind: 'index',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_live_key',
    definition:
      'USING btree (school_id, custom_role_id, capability_key) WHERE (removed_at IS NULL)',
  },
  {
    kind: 'trigger',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_columns_immutable',
    definition:
      "EXECUTE FUNCTION asms_forbid_columns_change('custom_role_id', 'capability_key', 'added_by', 'added_at')",
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_no_role_manage_check',
    definition: "CHECK (((capability_key)::text <> 'role.manage'::text))",
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_key_format_check',
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_not_self_check',
    definition: 'CHECK ((granted_by <> user_id))',
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_revoked_check',
    definition:
      "((revoked_at IS NULL) OR (revoked_by IS NOT NULL) OR ((end_reason)::text = 'became principal'::text))",
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_reason_no_id_check',
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_end_reason_no_id_check',
  },
  {
    kind: 'index',
    table: 'user_capability_grants',
    name: 'user_capability_grants_live_key',
    definition:
      'USING btree (school_id, user_id, capability_key, effect) WHERE (revoked_at IS NULL)',
  },
  {
    kind: 'trigger',
    table: 'user_capability_grants',
    name: 'user_capability_grants_end_only',
    definition:
      'BEFORE DELETE OR UPDATE ON public.user_capability_grants FOR EACH ROW EXECUTE FUNCTION asms_grant_end_only()',
  },
  {
    kind: 'trigger',
    table: 'user_capability_grants',
    name: 'user_capability_grants_no_truncate',
    definition:
      'BEFORE TRUNCATE ON public.user_capability_grants FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()',
  },
  // Slice-7 review fixes (migration slice7_history_guards): L3, L4.
  {
    kind: 'function',
    name: 'asms_forbid_delete',
    definition: "DETAIL = 'constraint: ' || TG_TABLE_NAME || '_no_delete'",
  },
  {
    kind: 'function',
    name: 'asms_forbid_change_once_set',
    definition: "DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_frozen'",
  },
  {
    kind: 'function',
    name: 'asms_custom_role_archive_final',
    definition: "DETAIL = 'constraint: custom_roles_archive_final'",
  },
  {
    kind: 'function',
    name: 'asms_user_role_custom_role_active',
    definition: "DETAIL = 'constraint: user_roles_custom_role_active'",
  },
  ...(['custom_roles', 'custom_role_capabilities'] as const).flatMap((table): ExpectedObject[] => [
    {
      kind: 'trigger',
      table,
      name: `${table}_no_delete`,
      definition: `BEFORE DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()`,
    },
    {
      kind: 'trigger',
      table,
      name: `${table}_no_truncate`,
      definition: `BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()`,
    },
  ]),
  {
    kind: 'trigger',
    table: 'custom_roles',
    name: 'custom_roles_archive_final',
    definition: 'BEFORE UPDATE ON public.custom_roles FOR EACH ROW EXECUTE FUNCTION asms_custom_role_archive_final()',
  },
  {
    kind: 'trigger',
    table: 'custom_role_capabilities',
    name: 'custom_role_capabilities_removed_frozen',
    definition: "EXECUTE FUNCTION asms_forbid_change_once_set('removed_at', 'removed_by')",
  },
  {
    kind: 'trigger',
    table: 'user_roles',
    name: 'user_roles_columns_immutable',
    definition: "EXECUTE FUNCTION asms_forbid_columns_change('user_id', 'system_role', 'custom_role_id')",
  },
  {
    kind: 'trigger',
    table: 'user_roles',
    name: 'user_roles_ended_frozen',
    definition: "EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by')",
  },
  {
    kind: 'trigger',
    table: 'user_roles',
    name: 'user_roles_custom_role_active',
    definition: 'BEFORE INSERT ON public.user_roles FOR EACH ROW EXECUTE FUNCTION asms_user_role_custom_role_active()',
  },
  {
    kind: 'constraint',
    table: 'user_capability_grants',
    name: 'user_capability_grants_not_self_end_check',
    definition: 'CHECK (((revoked_by IS NULL) OR (revoked_by <> user_id)))',
  },
  ...PHASE_2_GROUNDWORK_OBJECTS(),
  ...WAVE_E_GROUNDWORK_OBJECTS(),
  ...SLICE_11_OBJECTS(),
  ...SLICE_14_OBJECTS(),
  ...PHASE_3_GROUNDWORK_OBJECTS(),
  ...SLICE_18_OBJECTS(),
  ...WAVE_I_OBJECTS(),
  ...WAVE_J_OBJECTS(),
];

/** Every table's DELETE and TRUNCATE refusal (asms_forbid_delete, rule 4). */
function noDeleteTriggers(...tables: string[]): ExpectedObject[] {
  return tables.flatMap((table): ExpectedObject[] => [
    {
      kind: 'trigger',
      table,
      name: `${table}_no_delete`,
      definition: `BEFORE DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()`,
    },
    {
      kind: 'trigger',
      table,
      name: `${table}_no_truncate`,
      definition: `BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()`,
    },
  ]);
}

/** The identity-number CHECK every free-text column carries, as pg_get_constraintdef prints it. */
function noIdCheck(column: string): string {
  return `CHECK ((((${column})::text !~ '[0-9]{13}'::text) AND ((${column})::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))`;
}

/**
 * Phase 2 groundwork (migrations 20261003182514_phase2_teacher_cover_role,
 * 20261003183118_phase2_messaging, 20261003184500_phase2_calendar_settings). A function, not a
 * literal, only because it is declared after EXPECTED_OBJECTS reads it.
 */
function PHASE_2_GROUNDWORK_OBJECTS(): ExpectedObject[] {
  return [
    // ---- schools, platform_settings, platform_delivery_health (non-tenant)
    {
      kind: 'constraint',
      table: 'schools',
      name: 'schools_sms_monthly_cap_check',
      definition: 'CHECK (((sms_monthly_cap >= 0) AND (sms_monthly_cap <= 100000)))',
    },
    {
      kind: 'constraint',
      table: 'platform_settings',
      name: 'platform_settings_one_row_check',
      definition: 'CHECK ((id = 1))',
    },
    ...noDeleteTriggers('platform_settings'),
    {
      kind: 'constraint',
      table: 'platform_delivery_health',
      name: 'platform_delivery_health_counts_check',
      definition:
        'CHECK (((accepted >= 0) AND (delivered >= 0) AND (failed >= 0) AND (suppressed >= 0) AND (sms_used >= 0) AND (sms_cap >= 0)))',
    },
    {
      kind: 'trigger',
      table: 'platform_delivery_health',
      name: 'platform_delivery_health_columns_immutable',
      definition: "EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'day', 'channel')",
    },
    // ---- whatsapp_numbers
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_phone_check',
      definition: "CHECK (((phone)::text ~ '^\\+[1-9][0-9]{7,14}$'::text))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_provider_check',
      definition:
        "CHECK ((((provider = 'waha'::whatsapp_provider) AND (cloud_phone_number_id IS NULL) AND (cloud_access_token IS NULL)) OR ((provider = 'cloud_api'::whatsapp_provider) AND (waha_session IS NULL) AND (cloud_phone_number_id IS NOT NULL) AND (cloud_access_token IS NOT NULL))))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_waha_session_check',
      definition: "CHECK (((waha_session)::text ~ '^[a-z0-9_]{1,64}$'::text))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_cloud_phone_number_id_check',
      definition: "CHECK (((cloud_phone_number_id)::text ~ '^[0-9]{1,32}$'::text))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_cloud_access_token_check',
      definition: "CHECK (((cloud_access_token)::text ~~ 'v1:%'::text))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_inbound_ignored_count_check',
      definition: 'CHECK ((inbound_ignored_count >= 0))',
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_paired_check',
      definition: 'CHECK (((paired_at IS NULL) OR (paired_by IS NOT NULL)))',
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_disabled_check',
      definition:
        "CHECK ((((status = 'disabled'::whatsapp_status) = (disabled_at IS NOT NULL)) AND ((disabled_at IS NULL) = (disabled_by IS NULL)) AND ((disabled_at IS NULL) = (disabled_reason IS NULL))))",
    },
    {
      kind: 'constraint',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_disabled_reason_no_id_check',
      definition: noIdCheck('disabled_reason'),
    },
    {
      kind: 'index',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_school_id_live_key',
      definition: "USING btree (school_id) WHERE (status <> 'disabled'::whatsapp_status)",
    },
    {
      kind: 'trigger',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_columns_immutable',
      definition:
        "EXECUTE FUNCTION asms_forbid_columns_change('provider', 'phone', 'cloud_phone_number_id')",
    },
    {
      kind: 'trigger',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_waha_session_frozen',
      definition: "EXECUTE FUNCTION asms_forbid_change_once_set('waha_session')",
    },
    {
      kind: 'trigger',
      table: 'whatsapp_numbers',
      name: 'whatsapp_numbers_disabled_frozen',
      definition:
        "EXECUTE FUNCTION asms_forbid_change_once_set('disabled_at', 'disabled_by', 'disabled_reason', 'status')",
    },
    ...noDeleteTriggers('whatsapp_numbers'),
    // ---- devices
    {
      kind: 'constraint',
      table: 'devices',
      name: 'devices_app_version_check',
      definition: "CHECK (((app_version)::text ~ '^[0-9]{1,4}(\\.[0-9]{1,4}){2}$'::text))",
    },
    {
      kind: 'constraint',
      table: 'devices',
      name: 'devices_push_token_check',
      definition:
        "CHECK ((((push_token)::text <> ''::text) AND ((push_token)::text = btrim((push_token)::text))))",
    },
    {
      kind: 'constraint',
      table: 'devices',
      name: 'devices_unregistered_check',
      definition: 'CHECK (((unregistered_at IS NULL) = (unregistered_reason IS NULL)))',
    },
    {
      kind: 'trigger',
      table: 'devices',
      name: 'devices_columns_immutable',
      definition: "EXECUTE FUNCTION asms_forbid_columns_change('user_id')",
    },
    // No DELETE refusal: a device row is a push address, not history; the session purge deletes
    // a purged session's devices (migration 20261004090000_devices_purgeable).
    // ---- messages
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_recipient_check',
      definition: 'CHECK ((num_nonnulls(guardian_id, staff_id, student_id) = 1))',
    },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_subject_type_check',
      definition: "CHECK (((subject_type)::text ~ '^[a-z][a-z_]{0,31}$'::text))",
    },
    { kind: 'constraint', table: 'messages', name: 'messages_body_no_id_check', definition: noIdCheck('body') },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_media_object_key_check',
      definition:
        "CHECK (((media_object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)))",
    },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_channel_plan_check',
      definition:
        'CHECK (((channel_plan IS NOT NULL) AND (array_position(channel_plan, NULL::message_channel) IS NULL)))',
    },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_suppressed_check',
      definition: "CHECK (((status = 'suppressed'::message_status) = (suppressed_reason IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_finished_check',
      definition:
        "CHECK (((finished_at IS NULL) = (status = ANY (ARRAY['queued'::message_status, 'sending'::message_status]))))",
    },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_claimed_check',
      definition: "CHECK (((status <> 'sending'::message_status) OR (claimed_at IS NOT NULL)))",
    },
    ...(['guardian', 'staff', 'student'] as const).map(
      (person): ExpectedObject => ({
        kind: 'index',
        table: 'messages',
        name: `messages_subject_${person}_key`,
        definition: `USING btree (school_id, subject_type, subject_id, ${person}_id) WHERE (${person}_id IS NOT NULL)`,
      }),
    ),
    {
      kind: 'trigger',
      table: 'messages',
      name: 'messages_columns_immutable',
      definition:
        "EXECUTE FUNCTION asms_forbid_columns_change('type', 'priority', 'subject_type', 'subject_id', 'guardian_id', 'staff_id', 'student_id', 'body', 'media_object_key', 'created_at')",
    },
    ...noDeleteTriggers('messages'),
    // ---- message_deliveries
    {
      kind: 'function',
      name: 'asms_message_delivery_forward_only',
      definition: "DETAIL = 'constraint: message_deliveries_forward_only'",
    },
    {
      kind: 'trigger',
      table: 'message_deliveries',
      name: 'message_deliveries_forward_only',
      definition:
        'BEFORE DELETE OR UPDATE ON public.message_deliveries FOR EACH ROW EXECUTE FUNCTION asms_message_delivery_forward_only()',
    },
    {
      kind: 'trigger',
      table: 'message_deliveries',
      name: 'message_deliveries_no_truncate',
      definition:
        'BEFORE TRUNCATE ON public.message_deliveries FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()',
    },
    {
      kind: 'index',
      table: 'message_deliveries',
      name: 'message_deliveries_provider_ref_key',
      definition: 'USING btree (channel, provider_ref_hash) WHERE (provider_ref_hash IS NOT NULL)',
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_attempt_check',
      definition: 'CHECK ((attempt >= 1))',
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_segments_check',
      definition: 'CHECK ((segments >= 1))',
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_provider_ref_hash_check',
      definition: "CHECK ((provider_ref_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_to_masked_no_id_check',
      definition: "CHECK (((to_masked)::text !~ '[0-9]{7}'::text))",
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_status_check',
      definition:
        "CHECK ((((status = 'delivered'::delivery_status) = (delivered_at IS NOT NULL)) AND ((status = 'failed'::delivery_status) = (failed_at IS NOT NULL))))",
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_error_code_check',
      definition: "CHECK (((error_code IS NULL) OR (status = 'failed'::delivery_status)))",
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_suppressed_check',
      definition: "CHECK (((status = 'suppressed'::delivery_status) = (suppressed_reason IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'message_deliveries',
      name: 'message_deliveries_poll_ref_check',
      definition:
        "CHECK (((poll_ref IS NULL) OR ((poll_ref ~~ 'v1:%'::text) AND (channel = 'sms'::message_channel) AND (status = 'accepted'::delivery_status))))",
    },
    // ---- message_usage
    {
      kind: 'constraint',
      table: 'message_usage',
      name: 'message_usage_year_month_check',
      definition: "CHECK ((year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))",
    },
    {
      kind: 'constraint',
      table: 'message_usage',
      name: 'message_usage_sent_count_check',
      definition: 'CHECK ((sent_count >= 0))',
    },
    {
      kind: 'trigger',
      table: 'message_usage',
      name: 'message_usage_columns_immutable',
      definition: "EXECUTE FUNCTION asms_forbid_columns_change('year_month', 'channel')",
    },
    ...noDeleteTriggers('message_usage'),
    // ---- school_settings
    {
      kind: 'constraint',
      table: 'school_settings',
      name: 'school_settings_periods_per_day_check',
      definition: 'CHECK (((periods_per_day >= 1) AND (periods_per_day <= 12)))',
    },
    {
      kind: 'constraint',
      table: 'school_settings',
      name: 'school_settings_weekly_off_days_check',
      definition:
        'CHECK (((weekly_off_days IS NOT NULL) AND (array_position(weekly_off_days, NULL::smallint) IS NULL) AND (weekly_off_days <@ ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint]) AND (cardinality(weekly_off_days) < 7)))',
    },
    {
      kind: 'constraint',
      table: 'school_settings',
      name: 'school_settings_attendance_amend_window_days_check',
      definition:
        'CHECK (((attendance_amend_window_days >= 0) AND (attendance_amend_window_days <= 30)))',
    },
    {
      kind: 'constraint',
      table: 'school_settings',
      name: 'school_settings_late_cutoff_time_check',
      definition:
        "CHECK (((late_counts_as <> 'absent_after_cutoff'::late_counts_as) OR (late_cutoff_time IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'school_settings',
      name: 'school_settings_sms_allowed_types_check',
      definition:
        // Widened by 20261005181500_phase3_groundwork with the SMS-eligible fee types.
        "(sms_allowed_types <@ ARRAY['absence_alert'::message_type, 'late_advice'::message_type, 'attendance_corrected'::message_type, 'announcement_urgent'::message_type, 'announcement_normal'::message_type, 'holiday_notice'::message_type, 'fee_charged'::message_type, 'fee_due_reminder'::message_type, 'fee_overdue'::message_type, 'receipt_issued'::message_type, 'payment_claim_rejected'::message_type])",
    },
    // ---- teacher_assignments: cover
    {
      kind: 'constraint',
      table: 'teacher_assignments',
      name: 'teacher_assignments_cover_check',
      definition:
        "CHECK (((role <> 'cover'::teacher_assignment_role) OR ((section_id IS NOT NULL) AND (subject_id IS NULL) AND (ends_on IS NOT NULL))))",
    },
    {
      kind: 'constraint',
      table: 'teacher_assignments',
      name: 'teacher_assignments_covers_check',
      definition:
        "CHECK (((covers_assignment_id IS NULL) OR (role = 'cover'::teacher_assignment_role)))",
    },
    // ---- holidays
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_live_excl',
      definition:
        "EXCLUDE USING gist (school_id WITH =, daterange(starts_on, ends_on, '[]'::text) WITH &&) WHERE ((status <> 'cancelled'::holiday_status))",
    },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_dates_check',
      definition: 'CHECK ((ends_on >= starts_on))',
    },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_name_check',
      definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))",
    },
    { kind: 'constraint', table: 'holidays', name: 'holidays_name_no_id_check', definition: noIdCheck('name') },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_description_no_id_check',
      definition: noIdCheck('description'),
    },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_cancel_reason_no_id_check',
      definition: noIdCheck('cancel_reason'),
    },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_published_check',
      definition:
        "CHECK ((((published_at IS NULL) = (published_by IS NULL)) AND ((status <> 'published'::holiday_status) OR (published_at IS NOT NULL)) AND ((status <> 'draft'::holiday_status) OR (published_at IS NULL))))",
    },
    {
      kind: 'constraint',
      table: 'holidays',
      name: 'holidays_cancelled_check',
      definition:
        "CHECK ((((status = 'cancelled'::holiday_status) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)) AND ((cancelled_at IS NULL) = (cancel_reason IS NULL))))",
    },
    {
      kind: 'trigger',
      table: 'holidays',
      name: 'holidays_published_frozen',
      definition:
        "EXECUTE FUNCTION asms_forbid_change_once_set('published_at', 'published_by', 'starts_on', 'ends_on', 'kind', 'name')",
    },
    {
      kind: 'trigger',
      table: 'holidays',
      name: 'holidays_cancelled_frozen',
      definition:
        "EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason', 'status', 'starts_on', 'ends_on', 'name', 'description', 'kind', 'applies_to_staff', 'announcement_id')",
    },
    ...noDeleteTriggers('holidays'),
  ];
}

/** An append-only table's UPDATE/DELETE and TRUNCATE refusals (asms_forbid_append_only_change). */
function appendOnlyTriggers(table: string): ExpectedObject[] {
  return [
    {
      kind: 'trigger',
      table,
      name: `${table}_append_only`,
      definition: `BEFORE DELETE OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION asms_forbid_append_only_change()`,
    },
    {
      kind: 'trigger',
      table,
      name: `${table}_no_truncate`,
      definition: `BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_append_only_change()`,
    },
  ];
}

/**
 * Phase 2 wave E groundwork (migration 20261004120000_phase2_attendance_diary): attendance, staff
 * attendance, diary and remarks. The §4.6 history function, the summary version bump, the alert,
 * not-self and supersede rules.
 */
function WAVE_E_GROUNDWORK_OBJECTS(): ExpectedObject[] {
  return [
    // ---- trigger functions
    {
      kind: 'function',
      name: 'asms_record_change',
      definition: "v_refusal := changes_table || '_actor_required'",
    },
    {
      kind: 'function',
      name: 'asms_record_change',
      definition: "v_refusal := changes_table || '_reason_required'",
    },
    {
      kind: 'function',
      name: 'asms_record_change',
      definition: "NULLIF(current_setting('asms.actor_user_id', true), '')",
    },
    {
      kind: 'function',
      name: 'asms_attendance_summary_bump',
      definition: 'DO UPDATE SET version = attendance_daily_summary.version + 1',
    },
    {
      kind: 'function',
      name: 'asms_attendance_alert_status_final',
      definition: "DETAIL = 'constraint: attendance_alerts_status_final'",
    },
    // Slice 11 review (migration 20261004140000): capped_at is the one column a final alert takes, once.
    {
      kind: 'function',
      name: 'asms_attendance_alert_status_final',
      definition: "DETAIL = 'constraint: attendance_alerts_capped_at_immutable'",
    },
    {
      kind: 'function',
      name: 'asms_staff_attendance_not_self',
      definition: "DETAIL = 'constraint: staff_attendance_not_self'",
    },
    {
      kind: 'function',
      name: 'asms_remark_superseded_by_successor',
      definition: "DETAIL = 'constraint: remarks_superseded_by_successor'",
    },
    {
      kind: 'function',
      name: 'asms_remark_mark_superseded',
      definition: 'UPDATE remarks SET superseded_at = NEW.created_at',
    },
    // ---- attendance_registers
    {
      kind: 'constraint',
      table: 'attendance_registers',
      name: 'attendance_registers_amended_check',
      definition: 'CHECK (((last_amended_by IS NULL) = (last_amended_at IS NULL)))',
    },
    {
      kind: 'constraint',
      table: 'attendance_registers',
      name: 'attendance_registers_daily_period_check',
      definition:
        "CHECK (((mode <> 'daily'::attendance_mode) OR (period = 1)))",
    },
    {
      kind: 'constraint',
      table: 'attendance_registers',
      name: 'attendance_registers_period_check',
      definition: 'CHECK (((period >= 1) AND (period <= 12)))',
    },
    // ---- attendance_marks
    {
      kind: 'constraint',
      table: 'attendance_marks',
      name: 'attendance_marks_natural_key',
      definition: 'UNIQUE (school_id, enrolment_id, date, period)',
    },
    { kind: 'constraint', table: 'attendance_marks', name: 'attendance_marks_note_no_id_check', definition: noIdCheck('note') },
    // ---- attendance_mark_changes
    {
      kind: 'constraint',
      table: 'attendance_mark_changes',
      name: 'attendance_mark_changes_reason_check',
      definition:
        "CHECK (((reason)::text <> ''::text))",
    },
    { kind: 'constraint', table: 'attendance_mark_changes', name: 'attendance_mark_changes_reason_no_id_check', definition: noIdCheck('reason') },
    // ---- attendance_alerts
    {
      kind: 'constraint',
      table: 'attendance_alerts',
      name: 'attendance_alerts_cancelled_check',
      definition:
        "CHECK (((status = 'cancelled'::attendance_alert_status) = (cancel_reason IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'attendance_alerts',
      name: 'attendance_alerts_seq_check',
      definition: 'CHECK ((seq >= 1))',
    },
    // ---- attendance_day_status
    {
      kind: 'constraint',
      table: 'attendance_day_status',
      name: 'attendance_day_status_periods_check',
      definition:
        'CHECK ((((periods_recorded >= 1) AND (periods_recorded <= 12)) AND (periods_present >= 0) AND (periods_late >= 0) AND (periods_absent >= 0) AND (periods_leave >= 0) AND ((((periods_present + periods_late) + periods_absent) + periods_leave) = periods_recorded)))',
    },
    // ---- attendance_daily_summary
    {
      kind: 'constraint',
      table: 'attendance_daily_summary',
      name: 'attendance_daily_summary_counts_check',
      definition:
        'CHECK (((registers_expected >= 0) AND (registers_recorded >= 0) AND (roster_count >= 0) AND (present >= 0) AND (absent >= 0) AND (late >= 0) AND (on_leave >= 0) AND (partial >= 0)))',
    },
    {
      kind: 'constraint',
      table: 'attendance_daily_summary',
      name: 'attendance_daily_summary_version_check',
      definition:
        'CHECK (((version >= 1) AND (computed_version >= 0) AND (computed_version <= version)))',
    },
    // ---- staff_attendance
    { kind: 'constraint', table: 'staff_attendance', name: 'staff_attendance_note_no_id_check', definition: noIdCheck('note') },
    // ---- staff_attendance_changes
    {
      kind: 'constraint',
      table: 'staff_attendance_changes',
      name: 'staff_attendance_changes_reason_check',
      definition:
        "CHECK (((reason)::text <> ''::text))",
    },
    { kind: 'constraint', table: 'staff_attendance_changes', name: 'staff_attendance_changes_reason_no_id_check', definition: noIdCheck('reason') },
    // ---- diary_entries
    { kind: 'constraint', table: 'diary_entries', name: 'diary_entries_assignment_no_id_check', definition: noIdCheck('assignment') },
    {
      kind: 'constraint',
      table: 'diary_entries',
      name: 'diary_entries_attachment_check',
      definition:
        "CHECK ((((attachment_object_key IS NULL) = (attachment_mime IS NULL)) AND ((attachment_object_key IS NULL) = (attachment_size_bytes IS NULL)) AND ((attachment_object_key IS NULL) OR (((attachment_object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)) AND ((attachment_mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'application/pdf'::character varying])::text[])) AND ((attachment_size_bytes >= 1) AND (attachment_size_bytes <= 5242880))))))",
    },
    {
      kind: 'constraint',
      table: 'diary_entries',
      name: 'diary_entries_due_on_check',
      definition: 'CHECK (((due_on IS NULL) OR (due_on >= date)))',
    },
    { kind: 'constraint', table: 'diary_entries', name: 'diary_entries_learning_outcome_no_id_check', definition: noIdCheck('learning_outcome') },
    {
      kind: 'constraint',
      table: 'diary_entries',
      name: 'diary_entries_topic_check',
      definition:
        "CHECK ((((topic)::text = btrim((topic)::text)) AND ((topic)::text <> ''::text)))",
    },
    { kind: 'constraint', table: 'diary_entries', name: 'diary_entries_topic_no_id_check', definition: noIdCheck('topic') },
    // ---- diary_entry_changes
    { kind: 'constraint', table: 'diary_entry_changes', name: 'diary_entry_changes_reason_no_id_check', definition: noIdCheck('reason') },
    // ---- remarks
    {
      kind: 'constraint',
      table: 'remarks',
      name: 'remarks_supersedes_self_check',
      definition: 'CHECK (((supersedes_id IS NULL) OR (supersedes_id <> id)))',
    },
    {
      kind: 'constraint',
      table: 'remarks',
      name: 'remarks_correction_check',
      definition: 'CHECK (((supersedes_id IS NULL) = (correction_reason IS NULL)))',
    },
    {
      kind: 'constraint',
      table: 'remarks',
      name: 'remarks_correction_reason_no_id_check',
      definition: noIdCheck('correction_reason'),
    },
    {
      kind: 'constraint',
      table: 'remarks',
      name: 'remarks_text_check',
      definition:
        "CHECK ((((text)::text = btrim((text)::text)) AND ((text)::text <> ''::text)))",
    },
    { kind: 'constraint', table: 'remarks', name: 'remarks_text_no_id_check', definition: noIdCheck('text') },
    // ---- attendance_registers
    {
      kind: 'trigger',
      table: 'attendance_registers',
      name: 'attendance_registers_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.attendance_registers FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('section_id', 'class_id', 'academic_year_id', 'date', 'period', 'mode', 'submitted_by', 'submitted_at', 'source')",
    },
    ...noDeleteTriggers('attendance_registers'),
    // ---- attendance_marks
    {
      kind: 'trigger',
      table: 'attendance_marks',
      name: 'attendance_marks_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.attendance_marks FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('register_id', 'enrolment_id', 'date', 'period', 'created_at')",
    },
    {
      kind: 'trigger',
      table: 'attendance_marks',
      name: 'attendance_marks_history',
      definition:
        "BEFORE UPDATE ON public.attendance_marks FOR EACH ROW EXECUTE FUNCTION asms_record_change('attendance_mark_changes', 'mark_id', 'reason_required', 'status', 'note', 'arrived_at')",
    },
    ...noDeleteTriggers('attendance_marks'),
    {
      kind: 'trigger',
      table: 'attendance_marks',
      name: 'attendance_marks_summary_bump_insert',
      definition:
        'AFTER INSERT ON public.attendance_marks REFERENCING NEW TABLE AS changed_marks FOR EACH STATEMENT EXECUTE FUNCTION asms_attendance_summary_bump()',
    },
    {
      kind: 'trigger',
      table: 'attendance_marks',
      name: 'attendance_marks_summary_bump_update',
      definition:
        'AFTER UPDATE ON public.attendance_marks REFERENCING NEW TABLE AS changed_marks FOR EACH STATEMENT EXECUTE FUNCTION asms_attendance_summary_bump()',
    },
    // ---- attendance_mark_changes
    ...appendOnlyTriggers('attendance_mark_changes'),
    // ---- attendance_arrivals
    ...appendOnlyTriggers('attendance_arrivals'),
    // ---- attendance_alerts
    {
      kind: 'trigger',
      table: 'attendance_alerts',
      name: 'attendance_alerts_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.attendance_alerts FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('enrolment_id', 'student_id', 'date', 'kind', 'seq', 'created_at')",
    },
    ...noDeleteTriggers('attendance_alerts'),
    {
      kind: 'trigger',
      table: 'attendance_alerts',
      name: 'attendance_alerts_status_final',
      definition:
        'BEFORE UPDATE ON public.attendance_alerts FOR EACH ROW EXECUTE FUNCTION asms_attendance_alert_status_final()',
    },
    // ---- attendance_day_status
    {
      kind: 'trigger',
      table: 'attendance_day_status',
      name: 'attendance_day_status_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.attendance_day_status FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('enrolment_id', 'student_id', 'section_id', 'date')",
    },
    ...noDeleteTriggers('attendance_day_status'),
    // ---- attendance_daily_summary
    {
      kind: 'trigger',
      table: 'attendance_daily_summary',
      name: 'attendance_daily_summary_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.attendance_daily_summary FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('section_id', 'class_id', 'academic_year_id', 'date')",
    },
    ...noDeleteTriggers('attendance_daily_summary'),
    // ---- staff_attendance
    {
      kind: 'trigger',
      table: 'staff_attendance',
      name: 'staff_attendance_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'date', 'marked_by', 'marked_at')",
    },
    {
      kind: 'trigger',
      table: 'staff_attendance',
      name: 'staff_attendance_history',
      definition:
        "BEFORE UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION asms_record_change('staff_attendance_changes', 'staff_attendance_id', 'reason_required', 'status', 'note')",
    },
    ...noDeleteTriggers('staff_attendance'),
    {
      kind: 'trigger',
      table: 'staff_attendance',
      name: 'staff_attendance_not_self',
      definition:
        'BEFORE INSERT OR UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION asms_staff_attendance_not_self()',
    },
    // ---- staff_attendance_changes
    ...appendOnlyTriggers('staff_attendance_changes'),
    // ---- diary_entries
    {
      kind: 'trigger',
      table: 'diary_entries',
      name: 'diary_entries_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.diary_entries FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('section_id', 'class_id', 'academic_year_id', 'date', 'subject_id', 'author_staff_id', 'created_at')",
    },
    {
      kind: 'trigger',
      table: 'diary_entries',
      name: 'diary_entries_history',
      definition:
        "BEFORE UPDATE ON public.diary_entries FOR EACH ROW EXECUTE FUNCTION asms_record_change('diary_entry_changes', 'diary_entry_id', 'reason_optional', 'topic', 'assignment', 'learning_outcome', 'due_on', 'attachment_object_key')",
    },
    ...noDeleteTriggers('diary_entries'),
    // ---- diary_entry_changes
    ...appendOnlyTriggers('diary_entry_changes'),
    // ---- remarks
    {
      kind: 'trigger',
      table: 'remarks',
      name: 'remarks_columns_immutable',
      definition:
        "BEFORE UPDATE ON public.remarks FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('enrolment_id', 'student_id', 'author_staff_id', 'subject_id', 'date', 'category', 'text', 'visibility', 'supersedes_id', 'correction_reason', 'created_at')",
    },
    {
      kind: 'trigger',
      table: 'remarks',
      name: 'remarks_mark_superseded',
      definition:
        'AFTER INSERT ON public.remarks FOR EACH ROW WHEN ((new.supersedes_id IS NOT NULL)) EXECUTE FUNCTION asms_remark_mark_superseded()',
    },
    ...noDeleteTriggers('remarks'),
    {
      kind: 'trigger',
      table: 'remarks',
      name: 'remarks_superseded_at_frozen',
      definition:
        "BEFORE UPDATE ON public.remarks FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at')",
    },
    {
      kind: 'trigger',
      table: 'remarks',
      name: 'remarks_superseded_by_successor',
      definition:
        'BEFORE INSERT OR UPDATE ON public.remarks FOR EACH ROW EXECUTE FUNCTION asms_remark_superseded_by_successor()',
    },
    {
      kind: 'index',
      table: 'diary_entries',
      name: 'diary_entries_attachment_object_key_key',
      definition:
        'ON public.diary_entries USING btree (school_id, attachment_object_key) WHERE (attachment_object_key IS NOT NULL)',
    },
    {
      kind: 'index',
      table: 'remarks',
      name: 'remarks_supersedes_id_key',
      definition:
        'ON public.remarks USING btree (school_id, supersedes_id) WHERE (supersedes_id IS NOT NULL)',
    },
  ];
}

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
      // `_ids` too, so an array of ids can never dodge the check (Phase 2 plan §5).
      (c) => c.table === table && /_(id|by|ids)$/.test(c.column),
    )) {
      if (NON_FK_ID_COLUMNS.has(`${table}.${column}`)) continue;
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

/** Slice 11 (migration 20261004131100_slice11_attendance, contracts/slice-11.md §12). */
function SLICE_11_OBJECTS(): ExpectedObject[] {
  return [
    {
      kind: 'index',
      table: 'attendance_daily_summary',
      name: 'attendance_daily_summary_stale_idx',
      definition: 'USING btree (school_id, date) WHERE (computed_version <> version)',
    },
  ];
}

/** Slice 14 (migration 20261004150100_slice14_announcements, contracts/slice-14.md §11). */
function SLICE_14_OBJECTS(): ExpectedObject[] {
  const trigger = (table: string, name: string, definition: string): ExpectedObject => ({
    kind: 'trigger',
    table,
    name,
    definition,
  });
  const immutable = (table: string, columns: string): ExpectedObject =>
    trigger(
      table,
      `${table}_columns_immutable`,
      `BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change(${columns})`,
    );
  return [
    {
      kind: 'function',
      name: 'asms_announcement_final_frozen',
      definition: "DETAIL = 'constraint: announcements_final_frozen'",
    },
    {
      // 20261004160000_slice14_send_failures: the job's give-up is the one way out of `sending`
      // other than `sent`.
      kind: 'function',
      name: 'asms_announcement_final_frozen',
      definition: "(NEW.status = 'draft' AND NEW.send_failed_at IS NOT NULL)",
    },
    // ---- messages
    { kind: 'constraint', table: 'messages', name: 'messages_title_no_id_check', definition: noIdCheck('title') },
    {
      kind: 'constraint',
      table: 'messages',
      name: 'messages_title_check',
      definition: "CHECK (((title IS NULL) OR ((subject_type)::text = 'announcement'::text)))",
    },
    // ---- announcements
    { kind: 'constraint', table: 'announcements', name: 'announcements_title_no_id_check', definition: noIdCheck('title') },
    { kind: 'constraint', table: 'announcements', name: 'announcements_body_no_id_check', definition: noIdCheck('body') },
    { kind: 'constraint', table: 'announcements', name: 'announcements_cancel_reason_no_id_check', definition: noIdCheck('cancel_reason') },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_title_check',
      definition: "CHECK ((((title)::text = btrim((title)::text)) AND ((title)::text <> ''::text)))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_body_check',
      definition: "CHECK ((((body)::text = btrim((body)::text)) AND ((body)::text <> ''::text)))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_attachment_check',
      definition:
        "CHECK ((((attachment_object_key IS NULL) = (attachment_mime IS NULL)) AND ((attachment_object_key IS NULL) = (attachment_size_bytes IS NULL)) AND ((attachment_object_key IS NULL) OR (((attachment_object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)) AND ((attachment_mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'application/pdf'::character varying])::text[])) AND ((attachment_size_bytes >= 1) AND (attachment_size_bytes <= 5242880))))))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_scheduled_check',
      definition:
        "CHECK (((status <> 'scheduled'::announcement_status) OR (scheduled_at IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_sent_check',
      definition: "CHECK (((status = 'sent'::announcement_status) = (sent_at IS NOT NULL)))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_cancelled_check',
      definition:
        "CHECK ((((status = 'cancelled'::announcement_status) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)) AND ((cancelled_at IS NULL) = (cancel_reason IS NULL))))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_send_failures_check',
      definition: 'CHECK ((send_failures >= 0))',
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_send_failed_check',
      definition: "CHECK (((send_failed_at IS NULL) OR (status = 'draft'::announcement_status)))",
    },
    {
      kind: 'constraint',
      table: 'announcements',
      name: 'announcements_recipient_count_check',
      definition:
        "CHECK (((recipient_count >= 0) AND ((status = ANY (ARRAY['sending'::announcement_status, 'sent'::announcement_status])) OR (recipient_count = 0))))",
    },
    {
      kind: 'index',
      table: 'announcements',
      name: 'announcements_attachment_object_key_key',
      definition:
        'ON public.announcements USING btree (school_id, attachment_object_key) WHERE (attachment_object_key IS NOT NULL)',
    },
    immutable('announcements', "'created_by', 'holiday_id', 'created_at'"),
    trigger(
      'announcements',
      'announcements_final_frozen',
      'BEFORE UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION asms_announcement_final_frozen()',
    ),
    ...noDeleteTriggers('announcements'),
    // ---- announcement_audiences (no no-delete trigger: decision 12)
    {
      kind: 'constraint',
      table: 'announcement_audiences',
      name: 'announcement_audiences_target_check',
      definition: "((staff_id IS NOT NULL) = (kind = 'staff_member'::audience_kind))",
    },
    {
      kind: 'constraint',
      table: 'announcement_audiences',
      name: 'announcement_audiences_roles_check',
      definition:
        'CHECK (((roles IS NOT NULL) AND (array_position(roles, NULL::audience_role) IS NULL) AND ((cardinality(roles) = 1) OR ((cardinality(roles) = 2) AND (roles[1] <> roles[2])))))',
    },
    {
      kind: 'index',
      table: 'announcement_audiences',
      name: 'announcement_audiences_target_key',
      definition:
        'USING btree (school_id, announcement_id, kind, COALESCE(class_id, (0)::bigint), COALESCE(section_id, (0)::bigint), COALESCE(student_id, (0)::bigint), COALESCE(guardian_id, (0)::bigint), COALESCE(staff_id, (0)::bigint))',
    },
    immutable(
      'announcement_audiences',
      "'announcement_id', 'kind', 'class_id', 'section_id', 'student_id', 'guardian_id', 'staff_id', 'roles', 'created_at'",
    ),
    trigger(
      'announcement_audiences',
      'announcement_audiences_no_truncate',
      'BEFORE TRUNCATE ON public.announcement_audiences FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()',
    ),
    // ---- announcement_recipients
    {
      kind: 'constraint',
      table: 'announcement_recipients',
      name: 'announcement_recipients_person_check',
      definition: 'CHECK ((num_nonnulls(guardian_id, staff_id, student_id) = 1))',
    },
    ...(['guardian', 'staff', 'student'] as const).map(
      (person): ExpectedObject => ({
        kind: 'index',
        table: 'announcement_recipients',
        name: `announcement_recipients_${person}_key`,
        definition: `USING btree (school_id, announcement_id, ${person}_id) WHERE (${person}_id IS NOT NULL)`,
      }),
    ),
    immutable('announcement_recipients', "'announcement_id', 'guardian_id', 'staff_id', 'student_id', 'created_at'"),
    trigger(
      'announcement_recipients',
      'announcement_recipients_message_id_frozen',
      "BEFORE UPDATE ON public.announcement_recipients FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('message_id')",
    ),
    ...noDeleteTriggers('announcement_recipients'),
    // ---- announcement_recipient_students
    immutable('announcement_recipient_students', "'announcement_recipient_id', 'student_id', 'created_at'"),
    ...noDeleteTriggers('announcement_recipient_students'),
  ];
}

/**
 * Phase 3 groundwork (migration 20261005181500_phase3_groundwork, phase-3-financial.md §3.8, §4):
 * the settings, platform and school CHECKs. The widened SMS allow-list CHECK is above.
 */
function PHASE_3_GROUNDWORK_OBJECTS(): ExpectedObject[] {
  return [
    { kind: 'constraint', table: 'platform_settings', name: 'platform_settings_grace_days_check', definition: "CHECK (((grace_days >= 0) AND (grace_days <= 90)))" },
    { kind: 'constraint', table: 'platform_settings', name: 'platform_settings_invoice_counter_check', definition: "CHECK ((invoice_counter >= 0))" },
    { kind: 'constraint', table: 'platform_settings', name: 'platform_settings_invoice_due_day_check', definition: "CHECK (((invoice_due_day >= 1) AND (invoice_due_day <= 28)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_expense_approval_threshold_check', definition: "CHECK ((expense_approval_threshold >= 0))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_fee_cutoff_day_check', definition: "CHECK (((fee_cutoff_day >= 1) AND (fee_cutoff_day <= 28)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_fee_reminder_days_before_check', definition: "CHECK (((fee_reminder_days_before >= 0) AND (fee_reminder_days_before <= 10)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_late_fee_amount_check', definition: "CHECK (((late_fee_amount IS NULL) OR (late_fee_amount > 0)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_late_fee_enabled_check', definition: "CHECK (((NOT late_fee_enabled) OR ((late_fee_amount IS NOT NULL) AND (late_fee_enabled_at IS NOT NULL))))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_late_fee_grace_days_check', definition: "CHECK (((late_fee_grace_days >= 0) AND (late_fee_grace_days <= 30)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_overdue_reminder_every_days_check', definition: "CHECK (((overdue_reminder_every_days >= 7) AND (overdue_reminder_every_days <= 30)))" },
    { kind: 'constraint', table: 'school_settings', name: 'school_settings_pay_day_check', definition: "CHECK (((pay_day >= 1) AND (pay_day <= 28)))" },
    { kind: 'constraint', table: 'schools', name: 'schools_terminated_at_check', definition: "CHECK (((status = 'terminated'::school_status) = (terminated_at IS NOT NULL)))" },
  ];
}

/** Slice 18 (migration 20261005182000_slice18_fee_setup, phase-3-financial.md §3.2, §4). */
function SLICE_18_OBJECTS(): ExpectedObject[] {
  return [
    // 20261006080000_slice18_review_fixes: a fixed search_path, and R232's merge family.
    { kind: 'function', name: 'asms_seed_school_finance', definition: "SET search_path TO 'public'" },
    {
      kind: 'function',
      name: 'asms_guardian_merge_family',
      definition: '(next.id = cur.merged_into_id OR next.merged_into_id = cur.id)',
    },
    {
      kind: 'function',
      name: 'asms_seed_school_finance',
      definition: 'ON CONFLICT ("school_id", "name") DO NOTHING',
    },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_admission_refundable_check', definition: "CHECK (((category <> 'admission'::fee_head_category) OR (NOT refundable)))" },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_archive_reason_no_id_check', definition: "CHECK ((((archive_reason)::text !~ '[0-9]{13}'::text) AND ((archive_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_archived_check', definition: "CHECK ((((status = 'archived'::fee_head_status) = (archived_at IS NOT NULL)) AND ((archived_at IS NULL) = (archived_by IS NULL)) AND ((archived_at IS NULL) = (archive_reason IS NULL))))" },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_fine_concession_check', definition: "CHECK (((category <> 'fine'::fee_head_category) OR (NOT concession_eligible)))" },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'constraint', table: 'fee_heads', name: 'fee_heads_name_no_id_check', definition: "CHECK ((((name)::text !~ '[0-9]{13}'::text) AND ((name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'fee_structures', name: 'fee_structures_amount_check', definition: "CHECK ((amount >= 0))" },
    { kind: 'constraint', table: 'fee_structures', name: 'fee_structures_effective_from_check', definition: "CHECK ((effective_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'constraint', table: 'fee_structures', name: 'fee_structures_reason_check', definition: "CHECK (((reason IS NULL) OR (((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text))))" },
    { kind: 'constraint', table: 'fee_structures', name: 'fee_structures_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'fee_structures', name: 'fee_structures_superseded_check', definition: "CHECK ((((status = 'superseded'::fee_structure_status) = (superseded_at IS NOT NULL)) AND ((superseded_by IS NULL) OR (status = 'superseded'::fee_structure_status)) AND ((superseded_by IS NULL) OR (superseded_by <> id))))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_account_no_check', definition: "CHECK ((((account_no)::text ~ '^[0-9A-Za-z-]{4,34}$'::text) AND ((account_no)::text !~ '^[0-9]{13}$'::text) AND ((account_no)::text !~ '^[0-9]{5}-[0-9]{7}-[0-9]$'::text)))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_bank_name_check', definition: "CHECK ((((bank_name IS NULL) OR (((bank_name)::text = btrim((bank_name)::text)) AND ((bank_name)::text <> ''::text))) AND ((kind = 'bank'::payment_account_kind) OR (bank_name IS NULL))))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_bank_name_no_id_check', definition: "CHECK ((((bank_name)::text !~ '[0-9]{13}'::text) AND ((bank_name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_disable_reason_no_id_check', definition: "CHECK ((((disable_reason)::text !~ '[0-9]{13}'::text) AND ((disable_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_disabled_check', definition: "CHECK ((((status = 'disabled'::payment_account_status) = (disabled_at IS NOT NULL)) AND ((disabled_at IS NULL) = (disabled_by IS NULL)) AND ((disabled_at IS NULL) = (disable_reason IS NULL))))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_title_check', definition: "CHECK ((((title)::text = btrim((title)::text)) AND ((title)::text <> ''::text)))" },
    { kind: 'constraint', table: 'school_payment_accounts', name: 'school_payment_accounts_title_no_id_check', definition: "CHECK ((((title)::text !~ '[0-9]{13}'::text) AND ((title)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'index', table: 'fee_heads', name: 'fee_heads_live_name_key', definition: "ON public.fee_heads USING btree (school_id, lower((name)::text)) WHERE (status <> 'archived'::fee_head_status)" },
    { kind: 'index', table: 'fee_heads', name: 'fee_heads_one_fine_key', definition: "ON public.fee_heads USING btree (school_id) WHERE ((category = 'fine'::fee_head_category) AND (status <> 'archived'::fee_head_status))" },
    { kind: 'index', table: 'fee_heads', name: 'fee_heads_one_tuition_key', definition: "ON public.fee_heads USING btree (school_id) WHERE ((category = 'tuition'::fee_head_category) AND (status <> 'archived'::fee_head_status))" },
    { kind: 'index', table: 'fee_structures', name: 'fee_structures_active_key', definition: "ON public.fee_structures USING btree (school_id, class_id, fee_head_id, effective_from) WHERE (status = 'active'::fee_structure_status)" },
    { kind: 'trigger', table: 'fee_heads', name: 'fee_heads_archived_frozen', definition: "BEFORE UPDATE ON public.fee_heads FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('archived_at', 'archived_by', 'archive_reason', 'status', 'name', 'concession_eligible', 'refundable')" },
    { kind: 'trigger', table: 'fee_heads', name: 'fee_heads_columns_immutable', definition: "BEFORE UPDATE ON public.fee_heads FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('category', 'frequency', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'fee_structures', name: 'fee_structures_columns_immutable', definition: "BEFORE UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'class_id', 'fee_head_id', 'amount', 'effective_from', 'reason', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'fee_structures', name: 'fee_structures_superseded_by_frozen', definition: "BEFORE UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_by')" },
    { kind: 'trigger', table: 'fee_structures', name: 'fee_structures_superseded_frozen', definition: "BEFORE UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at', 'status')" },
    { kind: 'trigger', table: 'school_payment_accounts', name: 'school_payment_accounts_columns_immutable', definition: "BEFORE UPDATE ON public.school_payment_accounts FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('kind', 'title', 'account_no', 'bank_name', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'school_payment_accounts', name: 'school_payment_accounts_disabled_frozen', definition: "BEFORE UPDATE ON public.school_payment_accounts FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('disabled_at', 'disabled_by', 'disable_reason', 'status')" },
    ...noDeleteTriggers('fee_heads', 'fee_structures', 'school_payment_accounts'),
  ];
}

/**
 * Wave I schema groundwork (migrations 20261006100000_wave_i_expense_category to
 * 20261006100400_slice26_platform_billing, phase-3-financial.md §3.1, §3.2, §4): slices 19, 23, 24
 * and 26. Every hand-written CHECK, exclusion constraint, partial or expression index, trigger and
 * trigger function on the fourteen new tables.
 */
function WAVE_I_OBJECTS(): ExpectedObject[] {
  return [
    // ---- functions
    { kind: 'function', name: 'asms_status_transition', definition: "DETAIL = 'constraint: ' || v_name" },
    { kind: 'function', name: 'asms_status_transition', definition: "current_setting(v_parts[3], true) = 'on'" },
    { kind: 'function', name: 'asms_forbid_change_unless_status', definition: "DETAIL = 'constraint: ' || TG_TABLE_NAME || '_' || col || '_frozen'" },
    { kind: 'function', name: 'asms_user_is_guardian_of', definition: 'asms_guardian_merge_family(p_school_id, u.guardian_id)' },
    { kind: 'function', name: 'asms_is_sole_principal', definition: 'FOR NO KEY UPDATE' },
    { kind: 'function', name: 'asms_concession_own_child', definition: "v_refusal := 'concessions_own_child'" },
    { kind: 'function', name: 'asms_concession_own_child', definition: "v_refusal := 'concessions_self_approved_unwarranted'" },
    { kind: 'function', name: 'asms_charge_campaign_audience_draft_only', definition: "DETAIL = 'constraint: charge_campaign_audiences_draft_only'" },
    { kind: 'function', name: 'asms_charge_own_child', definition: "DETAIL = 'constraint: charges_own_child'" },
    { kind: 'function', name: 'asms_charge_adjustment_credit', definition: "DETAIL = 'constraint: charges_adjustment_target_open'" },
    { kind: 'function', name: 'asms_expense_not_self', definition: "DETAIL = 'constraint: expenses_not_self'" },
    { kind: 'function', name: 'asms_leave_request_not_self', definition: "v_refusal := 'leave_requests_actor_required'" },
    { kind: 'function', name: 'asms_leave_request_not_self', definition: "v_refusal := 'leave_requests_self_approved_unwarranted'" },
    // 20261006100300_slice24_leave: the seed gains the three leave types.
    { kind: 'function', name: 'asms_seed_school_finance', definition: "(3, 'Unpaid leave', 'unpaid', NULL::smallint, false)" },
    // ---- concessions
    { kind: 'constraint', table: 'concessions', name: 'concessions_decided_check', definition: "CHECK ((((status <> 'requested'::concession_status) = (decided_at IS NOT NULL)) AND ((decided_at IS NULL) = (decided_by IS NULL)) AND ((status <> 'rejected'::concession_status) OR (decision_reason IS NOT NULL))))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_decision_reason_no_id_check', definition: "CHECK ((((decision_reason)::text !~ '[0-9]{13}'::text) AND ((decision_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_effective_from_check', definition: "CHECK ((effective_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_end_reason_no_id_check', definition: "CHECK ((((end_reason)::text !~ '[0-9]{13}'::text) AND ((end_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_ended_check', definition: "CHECK ((((status = 'ended'::concession_status) = (ended_at IS NOT NULL)) AND ((ended_at IS NULL) = (ended_by IS NULL)) AND ((ended_at IS NULL) = (end_reason IS NULL))))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_reason_check', definition: "CHECK ((((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text)))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_self_approved_check', definition: "CHECK (((NOT self_approved) OR (status = ANY (ARRAY['approved'::concession_status, 'ended'::concession_status]))))" },
    { kind: 'constraint', table: 'concessions', name: 'concessions_value_check', definition: "CHECK ((((kind = 'percentage'::concession_kind) AND ((value >= 1) AND (value <= 100))) OR ((kind = 'fixed'::concession_kind) AND (value > 0))))" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_columns_immutable', definition: "BEFORE UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('student_id', 'academic_year_id', 'enrolment_id', 'kind', 'value', 'effective_from', 'reason', 'requested_by', 'requested_at', 'created_at')" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_decided_frozen', definition: "BEFORE UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by', 'decision_reason', 'self_approved')" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_ended_frozen', definition: "BEFORE UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_at', 'ended_by', 'end_reason')" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_no_delete', definition: "BEFORE DELETE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_no_truncate', definition: "BEFORE TRUNCATE ON public.concessions FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_own_child', definition: "BEFORE INSERT OR UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_concession_own_child()" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_school_id_immutable', definition: "BEFORE UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'concessions', name: 'concessions_status_transition', definition: "BEFORE UPDATE ON public.concessions FOR EACH ROW EXECUTE FUNCTION asms_status_transition('requested:approved', 'requested:rejected', 'approved:ended')" },
    // ---- concession_heads
    { kind: 'trigger', table: 'concession_heads', name: 'concession_heads_columns_immutable', definition: "BEFORE UPDATE ON public.concession_heads FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('concession_id', 'fee_head_id', 'created_at')" },
    { kind: 'trigger', table: 'concession_heads', name: 'concession_heads_no_delete', definition: "BEFORE DELETE ON public.concession_heads FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'concession_heads', name: 'concession_heads_no_truncate', definition: "BEFORE TRUNCATE ON public.concession_heads FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'concession_heads', name: 'concession_heads_school_id_immutable', definition: "BEFORE UPDATE ON public.concession_heads FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- charge_runs
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_campaign_check', definition: "CHECK (((kind = 'campaign'::charge_run_kind) = (campaign_id IS NOT NULL)))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_counts_check', definition: "CHECK (((students_charged >= 0) AND (charges_inserted >= 0) AND (charges_skipped >= 0)))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_error_code_check', definition: "CHECK ((((status = 'failed'::charge_run_status) = (error_code IS NOT NULL)) AND ((error_code IS NULL) OR ((error_code)::text ~ '^[a-z][a-z_]{0,31}$'::text))))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_period_check', definition: "CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_regenerate_voided_check', definition: "CHECK (((NOT regenerate_voided) OR (kind = 'monthly'::charge_run_kind)))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_skipped_classes_check', definition: "CHECK (((jsonb_typeof(skipped_classes) = 'array'::text) AND (NOT jsonb_path_exists(skipped_classes, '$[*]?(@.type() != \"object\")'::jsonpath, '{}'::jsonb, true)) AND (NOT jsonb_path_exists(skipped_classes, '$[*].keyvalue()?(@.\"key\" != \"classId\" && @.\"key\" != \"reason\")'::jsonpath, '{}'::jsonb, true))))" },
    { kind: 'constraint', table: 'charge_runs', name: 'charge_runs_times_check', definition: "CHECK ((((status = ANY (ARRAY['done'::charge_run_status, 'failed'::charge_run_status])) = (finished_at IS NOT NULL)) AND ((status <> ALL (ARRAY['running'::charge_run_status, 'done'::charge_run_status])) OR (started_at IS NOT NULL)) AND ((status <> 'queued'::charge_run_status) OR (started_at IS NULL))))" },
    { kind: 'index', table: 'charge_runs', name: 'charge_runs_period_key', definition: "ON public.charge_runs USING btree (school_id, academic_year_id, period, kind) WHERE (status = ANY (ARRAY['queued'::charge_run_status, 'running'::charge_run_status]))" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_columns_immutable', definition: "BEFORE UPDATE ON public.charge_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'period', 'kind', 'campaign_id', 'triggered_by', 'queued_at', 'regenerate_voided')" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_finished_frozen', definition: "BEFORE UPDATE ON public.charge_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('finished_at', 'started_at', 'students_charged', 'charges_inserted', 'charges_skipped', 'skipped_classes', 'error_code')" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_no_delete', definition: "BEFORE DELETE ON public.charge_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_no_truncate', definition: "BEFORE TRUNCATE ON public.charge_runs FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_school_id_immutable', definition: "BEFORE UPDATE ON public.charge_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'charge_runs', name: 'charge_runs_status_transition', definition: "BEFORE UPDATE ON public.charge_runs FOR EACH ROW EXECUTE FUNCTION asms_status_transition('queued:running', 'queued:failed', 'running:done', 'running:failed')" },
    // ---- charge_campaigns
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_cancel_reason_no_id_check', definition: "CHECK ((((cancel_reason)::text !~ '[0-9]{13}'::text) AND ((cancel_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_cancelled_check', definition: "CHECK ((((status = 'cancelled'::campaign_status) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)) AND ((cancelled_at IS NULL) = (cancel_reason IS NULL))))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_description_check', definition: "CHECK (((description IS NULL) OR (((description)::text = btrim((description)::text)) AND ((description)::text <> ''::text))))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_description_no_id_check', definition: "CHECK ((((description)::text !~ '[0-9]{13}'::text) AND ((description)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_generated_check', definition: "CHECK ((((generated_at IS NULL) = (generated_count IS NULL)) AND ((generated_count IS NULL) OR (generated_count >= 0)) AND ((status <> 'generated'::campaign_status) OR (generated_at IS NOT NULL)) AND ((status <> ALL (ARRAY['draft'::campaign_status, 'generating'::campaign_status])) OR (generated_at IS NULL))))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'constraint', table: 'charge_campaigns', name: 'charge_campaigns_name_no_id_check', definition: "CHECK ((((name)::text !~ '[0-9]{13}'::text) AND ((name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_cancelled_frozen', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason')" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_columns_immutable', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('created_by', 'created_at')" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_content_frozen', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status('draft', 'name', 'academic_year_id', 'fee_head_id', 'amount', 'due_on', 'description', 'apply_concessions')" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_generated_frozen', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('generated_at', 'generated_count')" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_no_delete', definition: "BEFORE DELETE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_no_truncate', definition: "BEFORE TRUNCATE ON public.charge_campaigns FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_school_id_immutable', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'charge_campaigns', name: 'charge_campaigns_status_transition', definition: "BEFORE UPDATE ON public.charge_campaigns FOR EACH ROW EXECUTE FUNCTION asms_status_transition('draft:generating', 'draft:cancelled', 'generating:generated', 'generating:draft', 'generated:cancelled')" },
    // ---- charge_campaign_audiences
    { kind: 'constraint', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_kind_check', definition: "CHECK ((kind = ANY (ARRAY['everyone'::audience_kind, 'students'::audience_kind, 'class'::audience_kind, 'section'::audience_kind, 'student'::audience_kind])))" },
    { kind: 'constraint', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_target_check', definition: "CHECK ((((class_id IS NOT NULL) = (kind = 'class'::audience_kind)) AND ((section_id IS NOT NULL) = (kind = 'section'::audience_kind)) AND ((student_id IS NOT NULL) = (kind = 'student'::audience_kind))))" },
    { kind: 'index', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_target_key', definition: "ON public.charge_campaign_audiences USING btree (school_id, campaign_id, kind, COALESCE(class_id, (0)::bigint), COALESCE(section_id, (0)::bigint), COALESCE(student_id, (0)::bigint))" },
    { kind: 'trigger', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_columns_immutable', definition: "BEFORE UPDATE ON public.charge_campaign_audiences FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('campaign_id', 'kind', 'class_id', 'section_id', 'student_id', 'created_at')" },
    { kind: 'trigger', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_draft_only', definition: "BEFORE INSERT OR DELETE OR UPDATE ON public.charge_campaign_audiences FOR EACH ROW EXECUTE FUNCTION asms_charge_campaign_audience_draft_only()" },
    { kind: 'trigger', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_no_truncate', definition: "BEFORE TRUNCATE ON public.charge_campaign_audiences FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charge_campaign_audiences', name: 'charge_campaign_audiences_school_id_immutable', definition: "BEFORE UPDATE ON public.charge_campaign_audiences FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- charges
    { kind: 'constraint', table: 'charges', name: 'charges_adjustment_check', definition: "CHECK (((kind = 'adjustment'::charge_kind) = (adjusts_charge_id IS NOT NULL)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_adjustment_row_check', definition: "CHECK (((kind <> 'adjustment'::charge_kind) OR ((status = 'settled'::charge_status) AND (amount > 0) AND (allocated_amount = 0) AND (credited_amount = 0))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_allocated_amount_check', definition: "CHECK (((allocated_amount >= 0) AND ((allocated_amount + credited_amount) <= amount)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_amount_check', definition: "CHECK (((amount >= 0) AND (amount = (gross_amount - concession_amount))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_campaign_check', definition: "CHECK (((kind = 'campaign'::charge_kind) = (campaign_id IS NOT NULL)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_closed_unallocated_check', definition: "CHECK (((status <> ALL (ARRAY['voided'::charge_status, 'waived'::charge_status])) OR (allocated_amount = 0)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_concession_amount_check', definition: "CHECK ((concession_amount >= 0))" },
    { kind: 'constraint', table: 'charges', name: 'charges_credited_amount_check', definition: "CHECK ((credited_amount >= 0))" },
    { kind: 'constraint', table: 'charges', name: 'charges_description_check', definition: "CHECK ((((description)::text = btrim((description)::text)) AND ((description)::text <> ''::text)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_description_no_id_check', definition: "CHECK ((((description)::text !~ '[0-9]{13}'::text) AND ((description)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_generated_frequency_check', definition: "CHECK (((kind <> 'generated'::charge_kind) OR (head_frequency = ANY (ARRAY['monthly'::fee_frequency, 'once'::fee_frequency, 'yearly'::fee_frequency]))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_generated_period_check', definition: "CHECK (((kind <> 'generated'::charge_kind) OR ((head_frequency = 'monthly'::fee_frequency) = (period IS NOT NULL))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_gross_amount_check', definition: "CHECK ((gross_amount >= 0))" },
    { kind: 'constraint', table: 'charges', name: 'charges_late_fee_period_check', definition: "CHECK (((kind <> 'late_fee'::charge_kind) OR (period IS NOT NULL)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_late_fee_target_check', definition: "CHECK (((kind = 'late_fee'::charge_kind) = (late_fee_for_charge_id IS NOT NULL)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_period_check', definition: "CHECK (((period IS NULL) OR (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_settled_check', definition: "CHECK (((status = 'settled'::charge_status) = (settled_at IS NOT NULL)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_settled_outstanding_check', definition: "CHECK (((kind = 'adjustment'::charge_kind) OR (status = ANY (ARRAY['voided'::charge_status, 'waived'::charge_status])) OR ((status = 'settled'::charge_status) = ((allocated_amount + credited_amount) = amount))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_void_reason_no_id_check', definition: "CHECK ((((void_reason)::text !~ '[0-9]{13}'::text) AND ((void_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_voided_check', definition: "CHECK ((((status = 'voided'::charge_status) = (voided_at IS NOT NULL)) AND ((voided_at IS NULL) = (voided_by IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL))))" },
    { kind: 'constraint', table: 'charges', name: 'charges_waive_reason_no_id_check', definition: "CHECK ((((waive_reason)::text !~ '[0-9]{13}'::text) AND ((waive_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'charges', name: 'charges_waived_check', definition: "CHECK ((((status = 'waived'::charge_status) = (waived_at IS NOT NULL)) AND ((waived_at IS NULL) = (waived_by IS NULL)) AND ((waived_at IS NULL) = (waive_reason IS NULL)) AND ((status <> 'waived'::charge_status) OR (kind = 'late_fee'::charge_kind))))" },
    { kind: 'index', table: 'charges', name: 'charges_campaign_key', definition: "ON public.charges USING btree (school_id, campaign_id, enrolment_id) WHERE (campaign_id IS NOT NULL)" },
    { kind: 'index', table: 'charges', name: 'charges_generated_key', definition: "ON public.charges USING btree (school_id, student_id, fee_head_id, period) WHERE ((kind = 'generated'::charge_kind) AND (head_frequency = 'monthly'::fee_frequency) AND (status <> 'voided'::charge_status))" },
    { kind: 'index', table: 'charges', name: 'charges_late_fee_key', definition: "ON public.charges USING btree (school_id, student_id, period) WHERE ((kind = 'late_fee'::charge_kind) AND (status <> 'voided'::charge_status))" },
    { kind: 'index', table: 'charges', name: 'charges_once_key', definition: "ON public.charges USING btree (school_id, student_id, fee_head_id, enrolment_id) WHERE ((kind = 'generated'::charge_kind) AND (head_frequency = 'once'::fee_frequency) AND (status <> 'voided'::charge_status))" },
    { kind: 'index', table: 'charges', name: 'charges_open_by_student_idx', definition: "ON public.charges USING btree (school_id, student_id) INCLUDE (amount, allocated_amount, credited_amount, due_on) WHERE (status = 'open'::charge_status)" },
    { kind: 'index', table: 'charges', name: 'charges_yearly_key', definition: "ON public.charges USING btree (school_id, student_id, fee_head_id, academic_year_id) WHERE ((kind = 'generated'::charge_kind) AND (head_frequency = 'yearly'::fee_frequency) AND (status <> 'voided'::charge_status))" },
    { kind: 'trigger', table: 'charges', name: 'charges_adjustment_credit', definition: "AFTER INSERT ON public.charges FOR EACH ROW WHEN ((new.kind = 'adjustment'::charge_kind)) EXECUTE FUNCTION asms_charge_adjustment_credit()" },
    { kind: 'trigger', table: 'charges', name: 'charges_columns_immutable', definition: "BEFORE UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('enrolment_id', 'student_id', 'academic_year_id', 'fee_head_id', 'head_frequency', 'kind', 'period', 'campaign_id', 'late_fee_for_charge_id', 'adjusts_charge_id', 'concession_id', 'gross_amount', 'concession_amount', 'amount', 'description', 'due_on', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'charges', name: 'charges_no_delete', definition: "BEFORE DELETE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charges', name: 'charges_no_truncate', definition: "BEFORE TRUNCATE ON public.charges FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'charges', name: 'charges_own_child', definition: "BEFORE INSERT OR UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_charge_own_child()" },
    { kind: 'trigger', table: 'charges', name: 'charges_school_id_immutable', definition: "BEFORE UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'charges', name: 'charges_status_transition', definition: "BEFORE UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:settled', 'open:voided', 'open:waived', 'settled:open:asms.reversing_payment')" },
    { kind: 'trigger', table: 'charges', name: 'charges_voided_frozen', definition: "BEFORE UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason')" },
    { kind: 'trigger', table: 'charges', name: 'charges_waived_frozen', definition: "BEFORE UPDATE ON public.charges FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('waived_at', 'waived_by', 'waive_reason')" },
    // ---- expenses
    { kind: 'constraint', table: 'expenses', name: 'expenses_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_decided_check', definition: "CHECK ((((decided_at IS NULL) = (decided_by IS NULL)) AND ((status <> ALL (ARRAY['approved'::expense_status, 'rejected'::expense_status])) OR (decided_at IS NOT NULL)) AND ((status <> ALL (ARRAY['recorded'::expense_status, 'pending_approval'::expense_status])) OR (decided_at IS NULL)) AND ((status <> 'rejected'::expense_status) OR (decision_reason IS NOT NULL))))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_decision_reason_no_id_check', definition: "CHECK ((((decision_reason)::text !~ '[0-9]{13}'::text) AND ((decision_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_description_check', definition: "CHECK ((((description)::text = btrim((description)::text)) AND ((description)::text <> ''::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_description_no_id_check', definition: "CHECK ((((description)::text !~ '[0-9]{13}'::text) AND ((description)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_expense_no_check', definition: "CHECK ((expense_no > 0))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_method_check', definition: "CHECK ((method <> 'carried_forward'::payment_method))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_payee_check', definition: "CHECK (((payee IS NULL) OR (((payee)::text = btrim((payee)::text)) AND ((payee)::text <> ''::text))))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_payee_no_id_check', definition: "CHECK ((((payee)::text !~ '[0-9]{13}'::text) AND ((payee)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_receipt_check', definition: "CHECK ((((receipt_object_key IS NULL) = (receipt_mime IS NULL)) AND ((receipt_object_key IS NULL) = (receipt_size_bytes IS NULL)) AND ((receipt_object_key IS NULL) OR (((receipt_object_key)::text ~ (('^'::text || (school_id)::text) || '/[0-9A-HJKMNP-TV-Z]{26}\\.(jpg|png|pdf)$'::text)) AND ((receipt_mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'application/pdf'::character varying])::text[])) AND ((receipt_size_bytes >= 1) AND (receipt_size_bytes <= 5242880))))))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_reference_check', definition: "CHECK (((reference IS NULL) OR (((reference)::text = btrim((reference)::text)) AND ((reference)::text <> ''::text))))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_reference_no_id_check', definition: "CHECK ((((reference)::text !~ '[0-9]{13}'::text) AND ((reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_self_approved_check', definition: "CHECK (((NOT self_approved) OR ((decided_by = recorded_by) AND (status = ANY (ARRAY['approved'::expense_status, 'voided'::expense_status])))))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_void_reason_no_id_check', definition: "CHECK ((((void_reason)::text !~ '[0-9]{13}'::text) AND ((void_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'expenses', name: 'expenses_voided_check', definition: "CHECK ((((status = 'voided'::expense_status) = (voided_at IS NOT NULL)) AND ((voided_at IS NULL) = (voided_by IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL))))" },
    { kind: 'index', table: 'expenses', name: 'expenses_receipt_object_key_key', definition: "ON public.expenses USING btree (school_id, receipt_object_key) WHERE (receipt_object_key IS NOT NULL)" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_columns_immutable', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('expense_no', 'recorded_by', 'recorded_at')" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_content_frozen', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status('recorded,pending_approval', 'category', 'amount', 'spent_on', 'description', 'payee', 'method', 'reference')" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_decided_frozen', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by', 'decision_reason', 'self_approved')" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_no_delete', definition: "BEFORE DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_no_truncate', definition: "BEFORE TRUNCATE ON public.expenses FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_not_self', definition: "BEFORE INSERT OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_expense_not_self()" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_receipt_frozen', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('receipt_object_key', 'receipt_mime', 'receipt_size_bytes')" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_school_id_immutable', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_status_transition', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_status_transition('recorded:approved', 'recorded:rejected', 'recorded:voided', 'pending_approval:approved', 'pending_approval:rejected', 'pending_approval:voided', 'approved:voided')" },
    { kind: 'trigger', table: 'expenses', name: 'expenses_voided_frozen', definition: "BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason')" },
    // ---- leave_types
    { kind: 'constraint', table: 'leave_types', name: 'leave_types_archived_check', definition: "CHECK ((((status = 'archived'::leave_type_status) = (archived_at IS NOT NULL)) AND ((archived_at IS NULL) = (archived_by IS NULL))))" },
    { kind: 'constraint', table: 'leave_types', name: 'leave_types_days_per_year_check', definition: "CHECK (((days_per_year IS NULL) OR ((days_per_year >= 1) AND (days_per_year <= 366))))" },
    { kind: 'constraint', table: 'leave_types', name: 'leave_types_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'constraint', table: 'leave_types', name: 'leave_types_name_no_id_check', definition: "CHECK ((((name)::text !~ '[0-9]{13}'::text) AND ((name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'leave_types', name: 'leave_types_paid_check', definition: "CHECK (((code <> 'unpaid'::leave_code) OR (NOT paid)))" },
    { kind: 'index', table: 'leave_types', name: 'leave_types_live_name_key', definition: "ON public.leave_types USING btree (school_id, lower((name)::text)) WHERE (status = 'active'::leave_type_status)" },
    { kind: 'trigger', table: 'leave_types', name: 'leave_types_archived_frozen', definition: "BEFORE UPDATE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('archived_at', 'archived_by', 'status')" },
    { kind: 'trigger', table: 'leave_types', name: 'leave_types_columns_immutable', definition: "BEFORE UPDATE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('name', 'code', 'days_per_year', 'paid', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'leave_types', name: 'leave_types_no_delete', definition: "BEFORE DELETE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'leave_types', name: 'leave_types_no_truncate', definition: "BEFORE TRUNCATE ON public.leave_types FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'leave_types', name: 'leave_types_school_id_immutable', definition: "BEFORE UPDATE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- leave_requests
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_cancel_reason_no_id_check', definition: "CHECK ((((cancel_reason)::text !~ '[0-9]{13}'::text) AND ((cancel_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_cancelled_check', definition: "CHECK ((((status = 'cancelled'::leave_status) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)) AND ((cancelled_at IS NULL) = (cancel_reason IS NULL))))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_dates_check', definition: "CHECK (((ends_on >= starts_on) AND ((ends_on - starts_on) <= 59)))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_decided_check', definition: "CHECK ((((decided_at IS NULL) = (decided_by IS NULL)) AND ((status <> ALL (ARRAY['approved'::leave_status, 'rejected'::leave_status, 'ended_early'::leave_status])) OR (decided_at IS NOT NULL)) AND ((status <> 'pending'::leave_status) OR (decided_at IS NULL)) AND ((status <> 'rejected'::leave_status) OR (decision_reason IS NOT NULL))))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_decision_reason_no_id_check', definition: "CHECK ((((decision_reason)::text !~ '[0-9]{13}'::text) AND ((decision_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_ended_early_check', definition: "CHECK ((((status = 'ended_early'::leave_status) = (ended_early_on IS NOT NULL)) AND ((ended_early_on IS NULL) OR ((ended_early_on >= starts_on) AND (ended_early_on <= ends_on)))))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_live_excl', definition: "EXCLUDE USING gist (school_id WITH =, staff_id WITH =, daterange(starts_on, COALESCE(ended_early_on, ends_on), '[]'::text) WITH &&) WHERE ((status = ANY (ARRAY['pending'::leave_status, 'approved'::leave_status, 'ended_early'::leave_status])))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_reason_check', definition: "CHECK ((((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text)))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_self_approved_check', definition: "CHECK (((NOT self_approved) OR ((status = ANY (ARRAY['approved'::leave_status, 'cancelled'::leave_status, 'ended_early'::leave_status])) AND (decided_at IS NOT NULL))))" },
    { kind: 'constraint', table: 'leave_requests', name: 'leave_requests_working_days_check', definition: "CHECK (((working_days >= 0) AND (working_days <= 60)))" },
    { kind: 'index', table: 'leave_requests', name: 'leave_requests_live_excl', definition: "ON public.leave_requests USING gist (school_id, staff_id, daterange(starts_on, COALESCE(ended_early_on, ends_on), '[]'::text)) WHERE (status = ANY (ARRAY['pending'::leave_status, 'approved'::leave_status, 'ended_early'::leave_status]))" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_cancelled_frozen', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cancelled_at', 'cancelled_by', 'cancel_reason')" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_columns_immutable', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'leave_type_id', 'starts_on', 'ends_on', 'working_days', 'reason', 'requested_by', 'requested_at', 'on_behalf')" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_cover_assignment_id_frozen', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('cover_assignment_id')" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_decided_frozen', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('decided_at', 'decided_by', 'decision_reason', 'self_approved')" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_ended_early_on_frozen', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_early_on')" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_no_delete', definition: "BEFORE DELETE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_no_truncate', definition: "BEFORE TRUNCATE ON public.leave_requests FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_not_self', definition: "BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_leave_request_not_self()" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_school_id_immutable', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'leave_requests', name: 'leave_requests_status_transition', definition: "BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION asms_status_transition('pending:approved', 'pending:rejected', 'pending:cancelled', 'approved:cancelled', 'approved:ended_early')" },
    // ---- platform_plans
    { kind: 'constraint', table: 'platform_plans', name: 'platform_plans_archived_check', definition: "CHECK (((status = 'archived'::plan_status) = (archived_at IS NOT NULL)))" },
    { kind: 'constraint', table: 'platform_plans', name: 'platform_plans_band_check', definition: "CHECK (((min_students >= 0) AND ((max_students IS NULL) OR (max_students >= min_students))))" },
    { kind: 'constraint', table: 'platform_plans', name: 'platform_plans_band_excl', definition: "EXCLUDE USING gist (int4range(min_students, max_students, '[]'::text) WITH &&) WHERE ((status = 'active'::plan_status))" },
    { kind: 'constraint', table: 'platform_plans', name: 'platform_plans_money_check', definition: "CHECK (((monthly_price >= 0) AND (sms_allowance >= 0)))" },
    { kind: 'constraint', table: 'platform_plans', name: 'platform_plans_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'index', table: 'platform_plans', name: 'platform_plans_band_excl', definition: "ON public.platform_plans USING gist (int4range(min_students, max_students, '[]'::text)) WHERE (status = 'active'::plan_status)" },
    { kind: 'trigger', table: 'platform_plans', name: 'platform_plans_archived_frozen', definition: "BEFORE UPDATE ON public.platform_plans FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('archived_at', 'status', 'name', 'monthly_price', 'sms_allowance')" },
    { kind: 'trigger', table: 'platform_plans', name: 'platform_plans_columns_immutable', definition: "BEFORE UPDATE ON public.platform_plans FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('min_students', 'max_students', 'created_at')" },
    { kind: 'trigger', table: 'platform_plans', name: 'platform_plans_no_delete', definition: "BEFORE DELETE ON public.platform_plans FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_plans', name: 'platform_plans_no_truncate', definition: "BEFORE TRUNCATE ON public.platform_plans FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    // ---- platform_subscriptions
    { kind: 'constraint', table: 'platform_subscriptions', name: 'platform_subscriptions_dates_check', definition: "CHECK (((ended_on IS NULL) OR (ended_on >= started_on)))" },
    { kind: 'constraint', table: 'platform_subscriptions', name: 'platform_subscriptions_pinned_check', definition: "CHECK (((NOT pinned) OR ((reason IS NOT NULL) AND (assigned_by IS NOT NULL))))" },
    { kind: 'constraint', table: 'platform_subscriptions', name: 'platform_subscriptions_reason_check', definition: "CHECK (((reason IS NULL) OR (((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text))))" },
    { kind: 'constraint', table: 'platform_subscriptions', name: 'platform_subscriptions_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'index', table: 'platform_subscriptions', name: 'platform_subscriptions_live_key', definition: "ON public.platform_subscriptions USING btree (school_id) WHERE (ended_on IS NULL)" },
    { kind: 'trigger', table: 'platform_subscriptions', name: 'platform_subscriptions_columns_immutable', definition: "BEFORE UPDATE ON public.platform_subscriptions FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'plan_id', 'started_on', 'pinned', 'assigned_by', 'reason', 'created_at')" },
    { kind: 'trigger', table: 'platform_subscriptions', name: 'platform_subscriptions_ended_on_frozen', definition: "BEFORE UPDATE ON public.platform_subscriptions FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_on')" },
    { kind: 'trigger', table: 'platform_subscriptions', name: 'platform_subscriptions_no_delete', definition: "BEFORE DELETE ON public.platform_subscriptions FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_subscriptions', name: 'platform_subscriptions_no_truncate', definition: "BEFORE TRUNCATE ON public.platform_subscriptions FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    // ---- platform_school_metrics
    { kind: 'constraint', table: 'platform_school_metrics', name: 'platform_school_metrics_active_students_check', definition: "CHECK ((active_students >= 0))" },
    { kind: 'trigger', table: 'platform_school_metrics', name: 'platform_school_metrics_columns_immutable', definition: "BEFORE UPDATE ON public.platform_school_metrics FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'day')" },
    { kind: 'trigger', table: 'platform_school_metrics', name: 'platform_school_metrics_no_delete', definition: "BEFORE DELETE ON public.platform_school_metrics FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_school_metrics', name: 'platform_school_metrics_no_truncate', definition: "BEFORE TRUNCATE ON public.platform_school_metrics FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    // ---- platform_invoices
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_amounts_check', definition: "CHECK (((amount >= 0) AND (student_count >= 0)))" },
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_invoice_no_check', definition: "CHECK (((invoice_no)::text ~ '^INV-[0-9]{4}-[0-9]{5}$'::text))" },
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_paid_check', definition: "CHECK (((status = 'paid'::invoice_status) = (paid_at IS NOT NULL)))" },
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_void_reason_no_id_check', definition: "CHECK ((((void_reason)::text !~ '[0-9]{13}'::text) AND ((void_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_voided_check', definition: "CHECK ((((status = 'void'::invoice_status) = (voided_at IS NOT NULL)) AND ((voided_at IS NULL) = (voided_by IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL))))" },
    { kind: 'constraint', table: 'platform_invoices', name: 'platform_invoices_year_month_check', definition: "CHECK ((year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'index', table: 'platform_invoices', name: 'platform_invoices_month_key', definition: "ON public.platform_invoices USING btree (school_id, year_month) WHERE (status <> 'void'::invoice_status)" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_columns_immutable', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('school_id', 'invoice_no', 'year_month', 'plan_id', 'student_count', 'amount', 'due_on', 'issued_at')" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_no_delete', definition: "BEFORE DELETE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_no_truncate', definition: "BEFORE TRUNCATE ON public.platform_invoices FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_overdue_frozen', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('overdue_at')" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_paid_frozen', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('paid_at')" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_status_transition', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_status_transition('issued:paid', 'issued:void')" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_suspension_eligible_frozen', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('suspension_eligible_at')" },
    { kind: 'trigger', table: 'platform_invoices', name: 'platform_invoices_voided_frozen', definition: "BEFORE UPDATE ON public.platform_invoices FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at', 'voided_by', 'void_reason')" },
    // ---- platform_payments
    { kind: 'constraint', table: 'platform_payments', name: 'platform_payments_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'platform_payments', name: 'platform_payments_reference_check', definition: "CHECK ((((reference)::text = btrim((reference)::text)) AND ((reference)::text <> ''::text)))" },
    { kind: 'constraint', table: 'platform_payments', name: 'platform_payments_reference_no_id_check', definition: "CHECK ((((reference)::text !~ '[0-9]{13}'::text) AND ((reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'trigger', table: 'platform_payments', name: 'platform_payments_columns_immutable', definition: "BEFORE UPDATE ON public.platform_payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('invoice_id', 'amount', 'received_on', 'reference', 'recorded_by', 'created_at')" },
    { kind: 'trigger', table: 'platform_payments', name: 'platform_payments_no_delete', definition: "BEFORE DELETE ON public.platform_payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'platform_payments', name: 'platform_payments_no_truncate', definition: "BEFORE TRUNCATE ON public.platform_payments FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
  ];
}

/**
 * Wave J (migrations 20261006140000_slice20_payments, 20261006140100_slice25_payroll): payments,
 * allocations, receipts, reversals, cash handovers; salary structures, advances, payroll runs,
 * payslips and recoveries. Definitions copied from the migrated catalog.
 */
function WAVE_J_OBJECTS(): ExpectedObject[] {
  return [
    // ---- functions
    { kind: 'function', name: 'asms_user_is_guardian', definition: 'asms_guardian_merge_family(p_school_id, u.guardian_id)' },
    { kind: 'function', name: 'asms_payment_init', definition: "v_refusal := 'payments_born_verified'" },
    { kind: 'function', name: 'asms_payment_init', definition: "v_refusal := 'payments_carried_from_check'" },
    { kind: 'function', name: 'asms_payment_init', definition: 'NEW.unallocated_amount := NEW.amount' },
    { kind: 'function', name: 'asms_payment_handover_open', definition: "DETAIL = 'constraint: payments_handover_open'" },
    { kind: 'function', name: 'asms_payment_own_child', definition: "DETAIL = 'constraint: payments_own_child'" },
    { kind: 'function', name: 'asms_payment_advance_student_required', definition: "DETAIL = 'constraint: payments_advance_student_required'" },
    { kind: 'function', name: 'asms_payment_allocations_apply', definition: "v_refusal := 'payment_allocations_own_child'" },
    { kind: 'function', name: 'asms_payment_allocations_apply', definition: 'ORDER BY c.id FOR UPDATE' },
    { kind: 'function', name: 'asms_payment_allocations_reverse', definition: "DETAIL = 'constraint: payment_allocations_admission_reversal'" },
    { kind: 'function', name: 'asms_payment_allocations_reverse', definition: "set_config('asms.reversing_payment', coalesce(v_previous, ''), true)" },
    { kind: 'function', name: 'asms_payment_reversal_not_self', definition: "v_refusal := 'payment_reversals_not_self'" },
    { kind: 'function', name: 'asms_payment_reversal_not_self', definition: "v_refusal := 'payment_reversals_own_child'" },
    { kind: 'function', name: 'asms_payment_reversal_not_self', definition: "v_refusal := 'payment_reversals_payment_in_handover'" },
    { kind: 'function', name: 'asms_payment_reversal_apply', definition: "set_config('asms.reversing_payment', 'on', true)" },
    { kind: 'function', name: 'asms_payment_reversal_apply', definition: 'WAVE K HOOK' },
    { kind: 'function', name: 'asms_payment_reversal_carry_forward_linked', definition: "DETAIL = 'constraint: payment_reversals_carry_forward_linked'" },
    { kind: 'function', name: 'asms_cash_handover_shortfall', definition: "v_refusal := 'cash_handovers_shortfall_reversal'" },
    { kind: 'function', name: 'asms_cash_handover_expected_matches', definition: "DETAIL = 'constraint: cash_handovers_expected_matches'" },
    { kind: 'function', name: 'asms_salary_structure_not_self', definition: "v_refusal := 'salary_structures_self_approved_unwarranted'" },
    { kind: 'function', name: 'asms_salary_advance_not_self', definition: "DETAIL = 'constraint: salary_advances_not_self'" },
    { kind: 'function', name: 'asms_payslip_run_guard', definition: "v_refusal := 'payslips_run_finalised'" },
    { kind: 'function', name: 'asms_payslip_line_draft_only', definition: "v_refusal := 'payslip_lines_adjustment_kept'" },
    { kind: 'function', name: 'asms_payslip_adjust_not_self', definition: "DETAIL = 'constraint: payslip_adjust_not_self'" },
    { kind: 'function', name: 'asms_salary_advance_recovery_apply', definition: "v_refusal := 'salary_advance_recoveries_advance_open'" },
    // ---- cash_handovers
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_confirm_note_check', definition: "CHECK (((confirm_note IS NULL) OR (((confirm_note)::text = btrim((confirm_note)::text)) AND ((confirm_note)::text <> ''::text))))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_confirm_note_no_id_check', definition: "CHECK ((((confirm_note)::text !~ '[0-9]{13}'::text) AND ((confirm_note)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_confirmed_check', definition: "CHECK ((((status = 'confirmed'::handover_status) = (confirmed_at IS NOT NULL)) AND ((confirmed_at IS NULL) = (confirmed_by IS NULL)) AND ((confirmed_at IS NULL) = (counted_amount IS NULL)) AND ((confirmed_at IS NULL) = (shortfall_amount IS NULL)) AND ((confirmed_at IS NULL) = (surplus_amount IS NULL)) AND ((confirmed_at IS NOT NULL) OR (confirm_note IS NULL))))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_counted_check', definition: "CHECK (((counted_amount >= 0) AND (shortfall_amount >= 0) AND (surplus_amount >= 0) AND ((counted_amount - expected_amount) = (surplus_amount - shortfall_amount)) AND ((shortfall_amount = 0) OR (surplus_amount = 0))))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_expected_check', definition: "CHECK (((payment_count > 0) AND (expected_amount > 0)))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_not_self_check', definition: "CHECK (((confirmed_by <> collector_user_id) AND (confirmed_by <> opened_by)))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_note_check', definition: "CHECK (((note IS NULL) OR (((note)::text = btrim((note)::text)) AND ((note)::text <> ''::text))))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_note_no_id_check', definition: "CHECK ((((note)::text !~ '[0-9]{13}'::text) AND ((note)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_on_behalf_check', definition: "CHECK ((on_behalf = (opened_by <> collector_user_id)))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_resolution_check', definition: "CHECK ((((shortfall_resolution IS NULL) OR ((status = 'confirmed'::handover_status) AND (shortfall_amount > 0))) AND ((shortfall_resolution IS NULL) = (shortfall_resolved_at IS NULL)) AND ((shortfall_resolution IS NULL) = (shortfall_resolved_by IS NULL)) AND ((shortfall_resolution IS NULL) = (shortfall_resolution_reason IS NULL)) AND ((NOT (shortfall_resolution IS DISTINCT FROM 'written_off'::shortfall_resolution)) = (shortfall_expense_id IS NOT NULL)) AND ((NOT (shortfall_resolution IS DISTINCT FROM 'explained_by_void'::shortfall_resolution)) = (shortfall_reversal_id IS NOT NULL))))" },
    { kind: 'constraint', table: 'cash_handovers', name: 'cash_handovers_shortfall_resolution_reason_no_id_check', definition: "CHECK ((((shortfall_resolution_reason)::text !~ '[0-9]{13}'::text) AND ((shortfall_resolution_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'index', table: 'cash_handovers', name: 'cash_handovers_open_key', definition: "ON public.cash_handovers USING btree (school_id, collector_user_id) WHERE (status = 'open'::handover_status)" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_columns_immutable', definition: "BEFORE UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('collector_user_id', 'collector_staff_id', 'opened_by', 'on_behalf', 'expected_amount', 'payment_count', 'opened_at', 'note')" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_confirmed_frozen', definition: "BEFORE UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('confirmed_at', 'confirmed_by', 'counted_amount', 'shortfall_amount', 'surplus_amount', 'confirm_note')" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_expected_matches', definition: "AFTER INSERT ON public.cash_handovers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asms_cash_handover_expected_matches()" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_no_delete', definition: "BEFORE DELETE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_no_truncate', definition: "BEFORE TRUNCATE ON public.cash_handovers FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_school_id_immutable', definition: "BEFORE UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_shortfall', definition: "BEFORE INSERT OR UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_cash_handover_shortfall()" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_shortfall_resolution_frozen', definition: "BEFORE UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('shortfall_resolution', 'shortfall_resolved_at', 'shortfall_resolved_by', 'shortfall_resolution_reason', 'shortfall_expense_id', 'shortfall_reversal_id')" },
    { kind: 'trigger', table: 'cash_handovers', name: 'cash_handovers_status_transition', definition: "BEFORE UPDATE ON public.cash_handovers FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:confirmed')" },
    // ---- payment_allocations
    { kind: 'constraint', table: 'payment_allocations', name: 'payment_allocations_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'index', table: 'payment_allocations', name: 'payment_allocations_live_key', definition: "ON public.payment_allocations USING btree (school_id, payment_id, charge_id) WHERE (reversed_at IS NULL)" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_apply', definition: "AFTER INSERT ON public.payment_allocations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION asms_payment_allocations_apply()" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_columns_immutable', definition: "BEFORE UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('payment_id', 'charge_id', 'student_id', 'academic_year_id', 'amount', 'created_at')" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_no_delete', definition: "BEFORE DELETE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_no_truncate', definition: "BEFORE TRUNCATE ON public.payment_allocations FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_reverse', definition: "AFTER UPDATE ON public.payment_allocations REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION asms_payment_allocations_reverse()" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_reversed_at_frozen', definition: "BEFORE UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('reversed_at')" },
    { kind: 'trigger', table: 'payment_allocations', name: 'payment_allocations_school_id_immutable', definition: "BEFORE UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- payment_reversals
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_approved_check', definition: "CHECK (((kind = ANY (ARRAY['refund'::reversal_kind, 'refund_reversal'::reversal_kind])) = (approved_by IS NOT NULL)))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_carried_to_check', definition: "CHECK (((kind = 'carried_forward'::reversal_kind) OR (carried_to_payment_id IS NULL)))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_reason_check', definition: "CHECK ((((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text)))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_refund_method_check', definition: "CHECK ((((kind = 'refund'::reversal_kind) = (refund_method IS NOT NULL)) AND ((refund_method IS NULL) OR (refund_method <> 'carried_forward'::payment_method)) AND ((kind = 'refund'::reversal_kind) OR (refund_reference IS NULL))))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_refund_reference_check', definition: "CHECK (((refund_reference IS NULL) OR (((refund_reference)::text = btrim((refund_reference)::text)) AND ((refund_reference)::text <> ''::text))))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_refund_reference_no_id_check', definition: "CHECK ((((refund_reference)::text !~ '[0-9]{13}'::text) AND ((refund_reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payment_reversals', name: 'payment_reversals_reverses_check', definition: "CHECK (((kind = 'refund_reversal'::reversal_kind) = (reverses_id IS NOT NULL)))" },
    { kind: 'index', table: 'payment_reversals', name: 'payment_reversals_carried_to_key', definition: "ON public.payment_reversals USING btree (school_id, carried_to_payment_id) WHERE (carried_to_payment_id IS NOT NULL)" },
    { kind: 'index', table: 'payment_reversals', name: 'payment_reversals_reverses_key', definition: "ON public.payment_reversals USING btree (school_id, reverses_id) WHERE (reverses_id IS NOT NULL)" },
    { kind: 'index', table: 'payment_reversals', name: 'payment_reversals_void_key', definition: "ON public.payment_reversals USING btree (school_id, payment_id) WHERE (kind = 'void'::reversal_kind)" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_apply', definition: "AFTER INSERT ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_payment_reversal_apply()" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_carried_to_payment_id_frozen', definition: "BEFORE UPDATE ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('carried_to_payment_id')" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_carry_forward_linked', definition: "AFTER INSERT ON public.payment_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind = 'carried_forward'::reversal_kind)) EXECUTE FUNCTION asms_payment_reversal_carry_forward_linked()" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_columns_immutable', definition: "BEFORE UPDATE ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('payment_id', 'academic_year_id', 'kind', 'reverses_id', 'amount', 'reason', 'requested_by', 'approved_by', 'refund_method', 'refund_reference', 'created_at')" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_no_delete', definition: "BEFORE DELETE ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_no_truncate', definition: "BEFORE TRUNCATE ON public.payment_reversals FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_not_self', definition: "BEFORE INSERT ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_payment_reversal_not_self()" },
    { kind: 'trigger', table: 'payment_reversals', name: 'payment_reversals_school_id_immutable', definition: "BEFORE UPDATE ON public.payment_reversals FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- payments
    { kind: 'constraint', table: 'payments', name: 'payments_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'payments', name: 'payments_carried_forward_check', definition: "CHECK (((method = 'carried_forward'::payment_method) = (carried_from_reversal_id IS NOT NULL)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_handover_cash_check', definition: "CHECK (((method = 'cash'::payment_method) OR (handover_id IS NULL)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_payer_check', definition: "CHECK ((num_nonnulls(payer_guardian_id, payer_name) = 1))" },
    { kind: 'constraint', table: 'payments', name: 'payments_payer_name_check', definition: "CHECK (((payer_name IS NULL) OR (((payer_name)::text = btrim((payer_name)::text)) AND ((payer_name)::text <> ''::text))))" },
    { kind: 'constraint', table: 'payments', name: 'payments_payer_name_no_id_check', definition: "CHECK ((((payer_name)::text !~ '[0-9]{13}'::text) AND ((payer_name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_reference_check', definition: "CHECK (((reference IS NULL) OR (((reference)::text = btrim((reference)::text)) AND ((reference)::text <> ''::text))))" },
    { kind: 'constraint', table: 'payments', name: 'payments_reference_no_id_check', definition: "CHECK ((((reference)::text !~ '[0-9]{13}'::text) AND ((reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_reference_required_check', definition: "CHECK (((method <> ALL (ARRAY['bank_transfer'::payment_method, 'jazzcash'::payment_method, 'easypaisa'::payment_method])) OR (reference IS NOT NULL)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_unallocated_amount_check', definition: "CHECK (((unallocated_amount >= 0) AND (unallocated_amount <= amount)))" },
    { kind: 'constraint', table: 'payments', name: 'payments_voided_check', definition: "CHECK (((status = 'voided'::payment_status) = (voided_at IS NOT NULL)))" },
    { kind: 'index', table: 'payments', name: 'payments_carried_from_reversal_key', definition: "ON public.payments USING btree (school_id, carried_from_reversal_id) WHERE (carried_from_reversal_id IS NOT NULL)" },
    { kind: 'trigger', table: 'payments', name: 'payments_advance_for_student_id_frozen', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('advance_for_student_id')" },
    { kind: 'trigger', table: 'payments', name: 'payments_advance_student_required', definition: "AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION asms_payment_advance_student_required()" },
    { kind: 'trigger', table: 'payments', name: 'payments_columns_immutable', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('academic_year_id', 'payer_guardian_id', 'payer_name', 'method', 'amount', 'received_on', 'reference', 'carried_from_reversal_id', 'recorded_by', 'recorded_at', 'verified_by', 'verified_at')" },
    { kind: 'trigger', table: 'payments', name: 'payments_handover_id_frozen', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('handover_id')" },
    { kind: 'trigger', table: 'payments', name: 'payments_handover_open', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_payment_handover_open()" },
    { kind: 'trigger', table: 'payments', name: 'payments_no_delete', definition: "BEFORE DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payments', name: 'payments_no_truncate', definition: "BEFORE TRUNCATE ON public.payments FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payments', name: 'payments_own_child', definition: "BEFORE INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_payment_own_child()" },
    { kind: 'trigger', table: 'payments', name: 'payments_school_id_immutable', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'payments', name: 'payments_status_transition', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_status_transition('verified:voided')" },
    { kind: 'trigger', table: 'payments', name: 'payments_unallocated_init', definition: "BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_payment_init()" },
    { kind: 'trigger', table: 'payments', name: 'payments_voided_at_frozen', definition: "BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at')" },
    // ---- payroll_runs
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_finalise_reason_no_id_check', definition: "CHECK ((((finalise_reason)::text !~ '[0-9]{13}'::text) AND ((finalise_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_finalised_check', definition: "CHECK ((((status = 'finalised'::payroll_run_status) = (finalised_at IS NOT NULL)) AND ((finalised_at IS NULL) = (finalised_by IS NULL)) AND ((finalised_at IS NOT NULL) OR (finalise_reason IS NULL))))" },
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_skipped_check', definition: "CHECK (((jsonb_typeof(skipped) = 'array'::text) AND (NOT jsonb_path_exists(skipped, '$[*]?(@.type() != \"object\")'::jsonpath, '{}'::jsonb, true)) AND (NOT jsonb_path_exists(skipped, '$[*].keyvalue()?(@.\"key\" != \"staffId\" && @.\"key\" != \"reason\")'::jsonpath, '{}'::jsonb, true))))" },
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_totals_check', definition: "CHECK (((staff_count >= 0) AND (total_net >= 0)))" },
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_working_days_check', definition: "CHECK (((working_days >= 0) AND (working_days <= 31)))" },
    { kind: 'constraint', table: 'payroll_runs', name: 'payroll_runs_year_month_check', definition: "CHECK ((year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_columns_immutable', definition: "BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('year_month')" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_content_frozen', definition: "BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_unless_status('draft', 'working_days', 'prepared_at', 'prepared_by', 'staff_count', 'skipped', 'total_net')" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_finalised_frozen', definition: "BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('finalised_at', 'finalised_by', 'finalise_reason')" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_no_delete', definition: "BEFORE DELETE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_no_truncate', definition: "BEFORE TRUNCATE ON public.payroll_runs FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_school_id_immutable', definition: "BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'payroll_runs', name: 'payroll_runs_status_transition', definition: "BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION asms_status_transition('draft:finalised')" },
    // ---- payslip_lines
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_adjustment_check', definition: "CHECK ((((kind = 'adjustment'::payslip_line_kind) = (created_by IS NOT NULL)) AND ((kind = 'adjustment'::payslip_line_kind) = (reason IS NOT NULL)) AND ((kind = 'adjustment'::payslip_line_kind) OR (adjusts_payslip_id IS NULL)) AND ((adjusts_payslip_id IS NULL) OR (adjusts_payslip_id <> payslip_id))))" },
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_amount_check', definition: "CHECK ((((kind = 'adjustment'::payslip_line_kind) AND (amount <> 0)) OR ((kind <> 'adjustment'::payslip_line_kind) AND (amount > 0))))" },
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_name_no_id_check', definition: "CHECK ((((name)::text !~ '[0-9]{13}'::text) AND ((name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_reason_check', definition: "CHECK (((reason IS NULL) OR (((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text))))" },
    { kind: 'constraint', table: 'payslip_lines', name: 'payslip_lines_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'trigger', table: 'payslip_lines', name: 'payslip_adjust_not_self', definition: "BEFORE INSERT ON public.payslip_lines FOR EACH ROW EXECUTE FUNCTION asms_payslip_adjust_not_self()" },
    { kind: 'trigger', table: 'payslip_lines', name: 'payslip_lines_columns_immutable', definition: "BEFORE UPDATE ON public.payslip_lines FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('payslip_id', 'staff_id', 'kind', 'name', 'amount', 'adjusts_payslip_id', 'reason', 'created_by', 'created_at')" },
    { kind: 'trigger', table: 'payslip_lines', name: 'payslip_lines_draft_only', definition: "BEFORE INSERT OR DELETE OR UPDATE ON public.payslip_lines FOR EACH ROW EXECUTE FUNCTION asms_payslip_line_draft_only()" },
    { kind: 'trigger', table: 'payslip_lines', name: 'payslip_lines_no_truncate', definition: "BEFORE TRUNCATE ON public.payslip_lines FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payslip_lines', name: 'payslip_lines_school_id_immutable', definition: "BEFORE UPDATE ON public.payslip_lines FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- payslips
    { kind: 'constraint', table: 'payslips', name: 'payslips_amounts_check', definition: "CHECK (((basic >= 0) AND (allowances_total >= 0) AND (deductions_total >= 0) AND (absence_deduction >= 0) AND (advance_recovery >= 0)))" },
    { kind: 'constraint', table: 'payslips', name: 'payslips_days_check', definition: "CHECK ((((employed_working_days >= 0) AND (employed_working_days <= 31)) AND ((unpaid_days >= 0) AND (unpaid_days <= employed_working_days)) AND ((unmarked_days >= 0) AND (unmarked_days <= employed_working_days))))" },
    { kind: 'constraint', table: 'payslips', name: 'payslips_net_check', definition: "CHECK (((net = (((((basic + allowances_total) - deductions_total) - absence_deduction) - advance_recovery) + adjustment_total)) AND (net >= 0)))" },
    { kind: 'constraint', table: 'payslips', name: 'payslips_paid_check', definition: "CHECK ((((status = 'paid'::payslip_status) = (paid_on IS NOT NULL)) AND ((paid_on IS NULL) = (paid_method IS NULL)) AND ((paid_on IS NULL) = (paid_by IS NULL)) AND ((paid_on IS NOT NULL) OR (paid_reference IS NULL)) AND ((paid_method IS NULL) OR (paid_method <> 'carried_forward'::payment_method))))" },
    { kind: 'constraint', table: 'payslips', name: 'payslips_paid_reference_check', definition: "CHECK (((paid_reference IS NULL) OR (((paid_reference)::text = btrim((paid_reference)::text)) AND ((paid_reference)::text <> ''::text))))" },
    { kind: 'constraint', table: 'payslips', name: 'payslips_paid_reference_no_id_check', definition: "CHECK ((((paid_reference)::text !~ '[0-9]{13}'::text) AND ((paid_reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_columns_immutable', definition: "BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('run_id', 'staff_id', 'created_at')" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_no_delete', definition: "BEFORE DELETE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_no_truncate', definition: "BEFORE TRUNCATE ON public.payslips FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_paid_frozen', definition: "BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('paid_on', 'paid_method', 'paid_reference', 'paid_by')" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_run_guard', definition: "BEFORE INSERT OR UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_payslip_run_guard()" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_school_id_immutable', definition: "BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'payslips', name: 'payslips_status_transition', definition: "BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION asms_status_transition('pending:paid')" },
    // ---- receipt_lines
    { kind: 'constraint', table: 'receipt_lines', name: 'receipt_lines_advance_check', definition: "CHECK ((((charge_id IS NULL) = (fee_head_name IS NULL)) AND ((charge_id IS NOT NULL) OR (period IS NULL))))" },
    { kind: 'constraint', table: 'receipt_lines', name: 'receipt_lines_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'receipt_lines', name: 'receipt_lines_fee_head_name_no_id_check', definition: "CHECK ((((fee_head_name)::text !~ '[0-9]{13}'::text) AND ((fee_head_name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'receipt_lines', name: 'receipt_lines_period_check', definition: "CHECK (((period IS NULL) OR (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)))" },
    { kind: 'trigger', table: 'receipt_lines', name: 'receipt_lines_columns_immutable', definition: "BEFORE UPDATE ON public.receipt_lines FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('receipt_id', 'academic_year_id', 'student_id', 'charge_id', 'fee_head_name', 'period', 'amount', 'created_at')" },
    { kind: 'trigger', table: 'receipt_lines', name: 'receipt_lines_no_delete', definition: "BEFORE DELETE ON public.receipt_lines FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'receipt_lines', name: 'receipt_lines_no_truncate', definition: "BEFORE TRUNCATE ON public.receipt_lines FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'receipt_lines', name: 'receipt_lines_school_id_immutable', definition: "BEFORE UPDATE ON public.receipt_lines FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- receipts
    { kind: 'constraint', table: 'receipts', name: 'receipts_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'receipts', name: 'receipts_receipt_no_check', definition: "CHECK ((receipt_no > 0))" },
    { kind: 'trigger', table: 'receipts', name: 'receipts_columns_immutable', definition: "BEFORE UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('payment_id', 'academic_year_id', 'receipt_no', 'amount', 'issued_at', 'issued_by')" },
    { kind: 'trigger', table: 'receipts', name: 'receipts_no_delete', definition: "BEFORE DELETE ON public.receipts FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'receipts', name: 'receipts_no_truncate', definition: "BEFORE TRUNCATE ON public.receipts FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'receipts', name: 'receipts_school_id_immutable', definition: "BEFORE UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'receipts', name: 'receipts_voided_at_frozen', definition: "BEFORE UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('voided_at')" },
    // ---- salary_advance_recoveries
    { kind: 'constraint', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'trigger', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_apply', definition: "AFTER INSERT ON public.salary_advance_recoveries FOR EACH ROW EXECUTE FUNCTION asms_salary_advance_recovery_apply()" },
    { kind: 'trigger', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_columns_immutable', definition: "BEFORE UPDATE ON public.salary_advance_recoveries FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('advance_id', 'payslip_id', 'staff_id', 'amount', 'created_at')" },
    { kind: 'trigger', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_no_delete', definition: "BEFORE DELETE ON public.salary_advance_recoveries FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_no_truncate', definition: "BEFORE TRUNCATE ON public.salary_advance_recoveries FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_advance_recoveries', name: 'salary_advance_recoveries_school_id_immutable', definition: "BEFORE UPDATE ON public.salary_advance_recoveries FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- salary_advances
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_instalment_amount_check', definition: "CHECK (((instalment_amount > 0) AND (instalment_amount <= amount)))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_paid_method_check', definition: "CHECK ((paid_method <> 'carried_forward'::payment_method))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_paid_reference_check', definition: "CHECK (((paid_reference IS NULL) OR (((paid_reference)::text = btrim((paid_reference)::text)) AND ((paid_reference)::text <> ''::text))))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_paid_reference_no_id_check', definition: "CHECK ((((paid_reference)::text !~ '[0-9]{13}'::text) AND ((paid_reference)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_recover_from_check', definition: "CHECK ((recover_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_recovered_check', definition: "CHECK (((recovered_amount >= 0) AND (recovered_amount <= amount)))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_status_check', definition: "CHECK (((status = 'recovered'::advance_status) = (recovered_amount = amount)))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_write_off_reason_no_id_check', definition: "CHECK ((((write_off_reason)::text !~ '[0-9]{13}'::text) AND ((write_off_reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'salary_advances', name: 'salary_advances_written_off_check', definition: "CHECK ((((status = 'written_off'::advance_status) = (written_off_at IS NOT NULL)) AND ((written_off_at IS NULL) = (written_off_by IS NULL)) AND ((written_off_at IS NULL) = (write_off_reason IS NULL))))" },
    { kind: 'index', table: 'salary_advances', name: 'salary_advances_expense_key', definition: "ON public.salary_advances USING btree (school_id, expense_id) WHERE (expense_id IS NOT NULL)" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_columns_immutable', definition: "BEFORE UPDATE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'amount', 'granted_on', 'recover_from', 'instalment_amount', 'approved_by', 'paid_method', 'paid_reference', 'expense_id', 'created_at')" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_no_delete', definition: "BEFORE DELETE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_no_truncate', definition: "BEFORE TRUNCATE ON public.salary_advances FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_not_self', definition: "BEFORE INSERT OR UPDATE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_salary_advance_not_self()" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_school_id_immutable', definition: "BEFORE UPDATE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_status_transition', definition: "BEFORE UPDATE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_status_transition('open:recovered', 'open:written_off')" },
    { kind: 'trigger', table: 'salary_advances', name: 'salary_advances_written_off_frozen', definition: "BEFORE UPDATE ON public.salary_advances FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('written_off_at', 'written_off_by', 'write_off_reason')" },
    // ---- salary_structure_components
    { kind: 'constraint', table: 'salary_structure_components', name: 'salary_structure_components_amount_check', definition: "CHECK ((amount > 0))" },
    { kind: 'constraint', table: 'salary_structure_components', name: 'salary_structure_components_name_check', definition: "CHECK ((((name)::text = btrim((name)::text)) AND ((name)::text <> ''::text)))" },
    { kind: 'constraint', table: 'salary_structure_components', name: 'salary_structure_components_name_no_id_check', definition: "CHECK ((((name)::text !~ '[0-9]{13}'::text) AND ((name)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'salary_structure_components', name: 'salary_structure_components_position_check', definition: "CHECK (((\"position\" >= 0) AND (\"position\" <= 19)))" },
    { kind: 'trigger', table: 'salary_structure_components', name: 'salary_structure_components_columns_immutable', definition: "BEFORE UPDATE ON public.salary_structure_components FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('structure_id', 'kind', 'name', 'amount', 'position', 'created_at')" },
    { kind: 'trigger', table: 'salary_structure_components', name: 'salary_structure_components_no_delete', definition: "BEFORE DELETE ON public.salary_structure_components FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_structure_components', name: 'salary_structure_components_no_truncate', definition: "BEFORE TRUNCATE ON public.salary_structure_components FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_structure_components', name: 'salary_structure_components_school_id_immutable', definition: "BEFORE UPDATE ON public.salary_structure_components FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    // ---- salary_structures
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_basic_check', definition: "CHECK ((basic >= 0))" },
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_dates_check', definition: "CHECK (((ended_on IS NULL) OR (ended_on >= effective_from)))" },
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_live_excl', definition: "EXCLUDE USING gist (school_id WITH =, staff_id WITH =, daterange(effective_from, ended_on, '[]'::text) WITH &&) WHERE ((status = 'active'::salary_structure_status))" },
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_reason_check', definition: "CHECK ((((reason)::text = btrim((reason)::text)) AND ((reason)::text <> ''::text)))" },
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_reason_no_id_check', definition: "CHECK ((((reason)::text !~ '[0-9]{13}'::text) AND ((reason)::text !~ '[0-9]{5}-[0-9]{7}-[0-9]'::text)))" },
    { kind: 'constraint', table: 'salary_structures', name: 'salary_structures_superseded_check', definition: "CHECK ((((status = 'superseded'::salary_structure_status) = (superseded_at IS NOT NULL)) AND ((superseded_by IS NULL) OR (status = 'superseded'::salary_structure_status)) AND ((superseded_by IS NULL) OR (superseded_by <> id))))" },
    { kind: 'index', table: 'salary_structures', name: 'salary_structures_live_excl', definition: "ON public.salary_structures USING gist (school_id, staff_id, daterange(effective_from, ended_on, '[]'::text)) WHERE (status = 'active'::salary_structure_status)" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_columns_immutable', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_columns_change('staff_id', 'basic', 'effective_from', 'reason', 'created_by', 'self_approved', 'created_at')" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_ended_on_frozen', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('ended_on')" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_no_delete', definition: "BEFORE DELETE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_no_truncate', definition: "BEFORE TRUNCATE ON public.salary_structures FOR EACH STATEMENT EXECUTE FUNCTION asms_forbid_delete()" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_not_self', definition: "BEFORE INSERT ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_salary_structure_not_self()" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_school_id_immutable', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_school_id_change()" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_status_transition', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_status_transition('active:superseded')" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_superseded_by_frozen', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_by')" },
    { kind: 'trigger', table: 'salary_structures', name: 'salary_structures_superseded_frozen', definition: "BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION asms_forbid_change_once_set('superseded_at', 'status')" },
  ];
}
