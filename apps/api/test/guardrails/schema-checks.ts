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
 * - holidays.announcement_id: FK added in slice 14 with the announcements table. The one
 *   recorded exception to "a column waiting for its target table is not a reason" (the Phase 2
 *   groundwork ships the holidays shape before slice 14; contracts/slice-10.md §4.7). Slice 14
 *   adds the FK and removes this entry.
 */
export const NON_FK_ID_COLUMNS = new Set([
  'audit_log.subject_id',
  'audit_log.actor_platform_user_id',
  'idempotency_keys.subject_id',
  'messages.subject_id',
  'whatsapp_numbers.cloud_phone_number_id',
  'holidays.announcement_id',
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
    definition: 'CHECK ((num_nonnulls(actor_user_id, actor_platform_user_id) = 1))',
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
        "(sms_allowed_types <@ ARRAY['absence_alert'::message_type, 'late_advice'::message_type, 'attendance_corrected'::message_type, 'announcement_urgent'::message_type, 'announcement_normal'::message_type, 'holiday_notice'::message_type])",
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
