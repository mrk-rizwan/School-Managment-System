// The Phase 2 value sets are declared twice: as Postgres enums (the migrations) and in
// packages/shared (the API's DTOs and the clients). This reads the migrated catalog and fails on
// any difference, so a value added on one side only cannot ship.
import {
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
  REMARK_VISIBILITIES,
  SESSION_CHANNELS,
  SMS_ELIGIBLE_TYPES,
  SMS_PROVIDER_CHOICES,
  SMS_PROVIDERS,
  SUPPRESSION_REASONS,
  TEACHER_ROLES,
  WHATSAPP_ERROR_CODES,
  WHATSAPP_PROVIDER_CHOICES,
  WHATSAPP_PROVIDERS,
  WHATSAPP_STATUSES,
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
