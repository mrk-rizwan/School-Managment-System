// The Phase 2 and 3 value sets are declared twice: as Postgres enums (the migrations) and in
// packages/shared (the API's DTOs and the clients). This reads the migrated catalog and fails on
// any difference, so a value added on one side only cannot ship.
import {
  ATTENDANCE_ALERT_CANCEL_REASONS,
  ATTENDANCE_ALERT_KINDS,
  ATTENDANCE_ALERT_STATUSES,
  ATTENDANCE_MODES,
  ATTENDANCE_STATUSES,
  DAY_STATUSES,
  DEFAULT_SMS_ALLOWED_TYPES,
  DELIVERY_ERROR_CODES,
  DELIVERY_STATUSES,
  DEVICE_PLATFORMS,
  DEVICE_UNREGISTERED_REASONS,
  HOLIDAY_KINDS,
  HOLIDAY_STATUSES,
  LATE_COUNTS_AS,
  LEAVE_COUNTS_AS,
  MESSAGE_CHANNELS,
  MESSAGE_PRIORITIES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  REGISTER_SOURCES,
  REMARK_CATEGORIES,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_STATUSES,
  AUDIENCE_KINDS,
  AUDIENCE_ROLES,
  REMARK_VISIBILITIES,
  SESSION_CHANNELS,
  SMS_ELIGIBLE_TYPES,
  SMS_PROVIDER_CHOICES,
  SMS_PROVIDERS,
  STAFF_ATTENDANCE_STATUSES,
  SUPPRESSION_REASONS,
  TEACHER_ROLES,
  WHATSAPP_ERROR_CODES,
  WHATSAPP_PROVIDER_CHOICES,
  WHATSAPP_PROVIDERS,
  WHATSAPP_STATUSES,
  FEE_FREQUENCIES,
  FEE_HEAD_CATEGORIES,
  FEE_HEAD_STATUSES,
  FEE_STRUCTURE_STATUSES,
  PAYMENT_ACCOUNT_KINDS,
  PAYMENT_ACCOUNT_STATUSES,
  CONCESSION_KINDS,
  CONCESSION_STATUSES,
  CHARGE_KINDS,
  CHARGE_STATUSES,
  CHARGE_RUN_KINDS,
  CHARGE_RUN_STATUSES,
  CAMPAIGN_STATUSES,
  PAYMENT_METHODS,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  LEAVE_CODES,
  LEAVE_TYPE_STATUSES,
  LEAVE_STATUSES,
  PLAN_STATUSES,
  INVOICE_STATUSES,
} from '@asms/shared';
import { Client } from 'pg';

const PAIRS: [string, readonly string[]][] = [
  ['message_type', MESSAGE_TYPES],
  ['message_priority', MESSAGE_PRIORITIES],
  ['message_channel', MESSAGE_CHANNELS],
  ['message_status', MESSAGE_STATUSES],
  ['delivery_status', DELIVERY_STATUSES],
  ['suppression_reason', SUPPRESSION_REASONS],
  ['delivery_error_code', DELIVERY_ERROR_CODES],
  ['whatsapp_error_code', WHATSAPP_ERROR_CODES],
  ['whatsapp_provider', WHATSAPP_PROVIDERS],
  ['whatsapp_provider_choice', WHATSAPP_PROVIDER_CHOICES],
  ['sms_provider', SMS_PROVIDERS],
  ['sms_provider_choice', SMS_PROVIDER_CHOICES],
  ['whatsapp_status', WHATSAPP_STATUSES],
  ['device_platform', DEVICE_PLATFORMS],
  ['device_unregistered_reason', DEVICE_UNREGISTERED_REASONS],
  ['session_channel', SESSION_CHANNELS],
  ['holiday_kind', HOLIDAY_KINDS],
  ['holiday_status', HOLIDAY_STATUSES],
  ['late_counts_as', LATE_COUNTS_AS],
  ['leave_counts_as', LEAVE_COUNTS_AS],
  ['remark_visibility', REMARK_VISIBILITIES],
  ['teacher_assignment_role', TEACHER_ROLES],
  // Wave E groundwork (slices 11-13).
  ['attendance_mode', ATTENDANCE_MODES],
  ['attendance_status', ATTENDANCE_STATUSES],
  ['day_status', DAY_STATUSES],
  ['staff_attendance_status', STAFF_ATTENDANCE_STATUSES],
  ['register_source', REGISTER_SOURCES],
  ['attendance_alert_kind', ATTENDANCE_ALERT_KINDS],
  ['attendance_alert_status', ATTENDANCE_ALERT_STATUSES],
  ['attendance_alert_cancel_reason', ATTENDANCE_ALERT_CANCEL_REASONS],
  ['remark_category', REMARK_CATEGORIES],
  // Slice 14 (contracts/slice-14.md §2.1).
  ['announcement_category', ANNOUNCEMENT_CATEGORIES],
  ['announcement_priority', ANNOUNCEMENT_PRIORITIES],
  ['announcement_status', ANNOUNCEMENT_STATUSES],
  ['audience_kind', AUDIENCE_KINDS],
  ['audience_role', AUDIENCE_ROLES],
  // Phase 3 slice 18 (phase-3-financial.md §4). Each later slice adds its own.
  ['fee_head_category', FEE_HEAD_CATEGORIES],
  ['fee_frequency', FEE_FREQUENCIES],
  ['fee_head_status', FEE_HEAD_STATUSES],
  ['fee_structure_status', FEE_STRUCTURE_STATUSES],
  ['payment_account_kind', PAYMENT_ACCOUNT_KINDS],
  ['payment_account_status', PAYMENT_ACCOUNT_STATUSES],
  // Wave I (slices 19, 23, 24, 26).
  ['concession_kind', CONCESSION_KINDS],
  ['concession_status', CONCESSION_STATUSES],
  ['charge_kind', CHARGE_KINDS],
  ['charge_status', CHARGE_STATUSES],
  ['charge_run_kind', CHARGE_RUN_KINDS],
  ['charge_run_status', CHARGE_RUN_STATUSES],
  ['campaign_status', CAMPAIGN_STATUSES],
  ['payment_method', PAYMENT_METHODS],
  ['expense_category', EXPENSE_CATEGORIES],
  ['expense_status', EXPENSE_STATUSES],
  ['leave_code', LEAVE_CODES],
  ['leave_type_status', LEAVE_TYPE_STATUSES],
  ['leave_status', LEAVE_STATUSES],
  ['plan_status', PLAN_STATUSES],
  ['invoice_status', INVOICE_STATUSES],
];

/** The quoted `'value'::message_type` literals of a catalog expression, in order. */
const messageTypes = (expression: string) =>
  [...expression.matchAll(/'([a-z_]+)'::message_type/g)].map((match) => match[1]);

describe('Postgres enums match packages/shared', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(() => db.end());

  it.each(PAIRS)('%s has exactly the shared values, in order', async (type, values) => {
    const { rows } = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [type],
    );
    expect(rows.map((r) => r.label)).toEqual([...values]);
  });

  it('school_settings.sms_allowed_types: the CHECK is SMS_ELIGIBLE_TYPES, the default DEFAULT_SMS_ALLOWED_TYPES', async () => {
    const check = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'school_settings_sms_allowed_types_check'`,
    );
    expect(messageTypes(check.rows[0]?.def ?? '')).toEqual([...SMS_ELIGIBLE_TYPES]);
    const column = await db.query<{ def: string }>(
      `SELECT column_default AS def FROM information_schema.columns
       WHERE table_name = 'school_settings' AND column_name = 'sms_allowed_types'`,
    );
    expect(messageTypes(column.rows[0]?.def ?? '')).toEqual([...DEFAULT_SMS_ALLOWED_TYPES]);
  });
});
