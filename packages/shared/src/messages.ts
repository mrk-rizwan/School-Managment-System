/**
 * Messaging values and the message-type table (phase-2-daily-operations.md §4.2, rule 0.12;
 * contracts/slice-9.md §2.1, §7.2, which win where they differ). Every outbound message has a
 * type listed here before any sender uses it; the type is a key of MESSAGE_TYPE_TABLE, so a
 * sender naming an unknown type does not compile. Each value set mirrors the Postgres enum of the
 * same name (migration 20261003183118_phase2_messaging).
 */

/** Every kind of message the platform sends. Phases 3 and 4 add fee and result types here. */
export const MESSAGE_TYPES = [
  'absence_alert',
  'late_advice',
  'attendance_corrected',
  'announcement_urgent',
  'announcement_normal',
  'holiday_notice',
  'diary_posted',
  'remark_posted',
  'register_unrecorded',
  'sms_cap_reached',
  'messaging_test',
  'whatsapp_session_down',
  'cover_assigned',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * urgent: WhatsApp and SMS together for a WhatsApp-capable guardian. normal: WhatsApp first, SMS
 * only after WhatsApp fails (or as the primary when the school's number is not connected) and only
 * if allowed. low: never leaves the app. internal: staff, push else email. platform: the platform
 * alert mailbox, email only, no `messages` row.
 */
export const MESSAGE_PRIORITIES = ['urgent', 'normal', 'low', 'internal', 'platform'] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

/** `in_app` marks inbox visibility in a channel plan; it never produces a delivery row. */
export const MESSAGE_CHANNELS = ['push', 'whatsapp', 'sms', 'email', 'in_app'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * The channels that leave the platform and have delivery rows: every channel but `in_app`. The
 * one list routing, the processor, usage and the delivery-health view share.
 */
export const EXTERNAL_CHANNELS = ['push', 'whatsapp', 'sms', 'email'] as const satisfies readonly MessageChannel[];
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];

/** A `messages` row: one per person per subject (R107). */
export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'failed', 'suppressed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * A `message_deliveries` row: one per attempt per channel (R108). Moves only forward:
 * accepted -> delivered | failed; suppressed is terminal. There is no "read" (rule 0.13).
 */
export const DELIVERY_STATUSES = ['accepted', 'delivered', 'failed', 'suppressed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Why a message or a leg was not sent. A suspended school is not a reason (owner, item 13). */
export const SUPPRESSION_REASONS = [
  'not_allowed',
  'cap_reached',
  'no_channel',
  'backdated',
  // A queued notice withdrawn because its subject was cancelled (contracts/slice-10.md §4.6).
  'subject_cancelled',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Provider failures, mapped; provider error text is never stored or returned (R111). */
export const DELIVERY_ERROR_CODES = [
  'timeout',
  'provider_unavailable',
  'rate_limited',
  'auth_failed',
  'rejected',
  'invalid_number',
  'not_on_whatsapp',
  'outside_window',
  'session_down',
  'unregistered_device',
  'dnd_blocked',
  'expired',
  'no_report',
  'unknown',
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

/** Why a school's WhatsApp number failed its health check (contracts/slice-9.md §7.8). */
export const WHATSAPP_ERROR_CODES = [
  'unreachable',
  'logged_out',
  'session_failed',
  'token_rejected',
  'number_mismatch',
  'unknown',
] as const;
export type WhatsAppErrorCode = (typeof WHATSAPP_ERROR_CODES)[number];

/**
 * `messages.subject_type`: what a message is about. With `subject_id` and the person it is R107's
 * idempotency key. Slice 9 uses messaging_test (id = the audit row) and sms_cap (id = YYYYMM).
 */
export const MESSAGE_SUBJECT_TYPES = [
  'messaging_test',
  'sms_cap',
  'attendance_alert',
  'register_deadline',
  'announcement',
  'diary_entry',
  'remark',
  'holiday',
  'holiday_cancellation',
  'teacher_assignment',
] as const;
export type MessageSubjectType = (typeof MESSAGE_SUBJECT_TYPES)[number];

/** Who a message type is addressed to. Recipient resolution is the sender's (slices 9-14). */
export const MESSAGE_AUDIENCES = [
  'student_guardians',
  'announcement_audience',
  'school_community',
  'section_guardians_and_students',
  'register_watchers',
  'principals',
  'requester',
  'staff_member',
  'platform_alert_mailbox',
] as const;
export type MessageAudience = (typeof MESSAGE_AUDIENCES)[number];

export interface MessageTypeSpec {
  readonly priority: MessagePriority;
  readonly audience: MessageAudience;
  /** The channels in the table's order; the routing matrix (R106) decides the legs. */
  readonly channels: readonly MessageChannel[];
  /** May appear in `school_settings.sms_allowed_types` (contracts/slice-9.md §4). */
  readonly smsEligible: boolean;
  /** In the platform default of `school_settings.sms_allowed_types` (register item 22). */
  readonly smsAllowedByDefault: boolean;
  /** The subject types its `messages` rows carry; none for a type that writes no row. */
  readonly subjectTypes: readonly MessageSubjectType[];
  /** The English template; each slice writes its own (contracts/slice-9.md §7.5). */
  readonly templateKey: string;
}

/** contracts/slice-9.md §7.2 plus slice 10's cover row. Adding a type is a row here and an enum value. */
export const MESSAGE_TYPE_TABLE: Readonly<Record<MessageType, MessageTypeSpec>> = {
  absence_alert: {
    priority: 'urgent',
    audience: 'student_guardians',
    channels: ['whatsapp', 'sms', 'push'],
    smsEligible: true,
    smsAllowedByDefault: true,
    subjectTypes: ['attendance_alert'],
    templateKey: 'absence_alert',
  },
  late_advice: {
    priority: 'normal',
    audience: 'student_guardians',
    channels: ['whatsapp', 'sms', 'push'],
    smsEligible: true,
    smsAllowedByDefault: true,
    subjectTypes: ['attendance_alert'],
    templateKey: 'late_advice',
  },
  attendance_corrected: {
    priority: 'normal',
    audience: 'student_guardians',
    channels: ['whatsapp', 'sms', 'push'],
    smsEligible: true,
    smsAllowedByDefault: true,
    subjectTypes: ['attendance_alert'],
    templateKey: 'attendance_corrected',
  },
  announcement_urgent: {
    priority: 'urgent',
    audience: 'announcement_audience',
    channels: ['whatsapp', 'sms', 'push'],
    smsEligible: true,
    smsAllowedByDefault: true,
    subjectTypes: ['announcement'],
    templateKey: 'announcement',
  },
  // Eligible but off by default: a school may allow it (SMS after a WhatsApp failure).
  announcement_normal: {
    priority: 'normal',
    audience: 'announcement_audience',
    channels: ['whatsapp', 'push'],
    smsEligible: true,
    smsAllowedByDefault: false,
    subjectTypes: ['announcement'],
    templateKey: 'announcement',
  },
  // Wave D sends it straight from holiday publish (subject holiday / holiday_cancellation); from
  // slice 14 it travels as an announcement (contracts/slice-10.md §4.7).
  holiday_notice: {
    priority: 'normal',
    audience: 'school_community',
    channels: ['whatsapp', 'push', 'sms'],
    smsEligible: true,
    smsAllowedByDefault: true,
    subjectTypes: ['holiday', 'holiday_cancellation', 'announcement'],
    templateKey: 'holiday_notice',
  },
  diary_posted: {
    priority: 'low',
    audience: 'section_guardians_and_students',
    channels: ['push', 'in_app'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['diary_entry'],
    templateKey: 'diary_posted',
  },
  remark_posted: {
    priority: 'low',
    audience: 'student_guardians',
    channels: ['push', 'in_app'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['remark'],
    templateKey: 'remark_posted',
  },
  register_unrecorded: {
    priority: 'internal',
    audience: 'register_watchers',
    channels: ['push', 'email'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['register_deadline'],
    templateKey: 'register_unrecorded',
  },
  sms_cap_reached: {
    priority: 'internal',
    audience: 'principals',
    channels: ['push', 'email'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['sms_cap'],
    templateKey: 'sms_cap_reached',
  },
  // The requested channel only; bypasses the allow list and counts against the cap (§5.1).
  messaging_test: {
    priority: 'normal',
    audience: 'requester',
    channels: ['whatsapp', 'sms', 'push'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['messaging_test'],
    templateKey: 'messaging_test',
  },
  // Email to PLATFORM_ALERT_EMAIL; no `messages` row (there is no tenant person).
  whatsapp_session_down: {
    priority: 'platform',
    audience: 'platform_alert_mailbox',
    channels: ['email'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: [],
    templateKey: 'whatsapp_session_down',
  },
  // contracts/slice-10.md §6 (R132): the covering teacher is told on assignment.
  cover_assigned: {
    priority: 'internal',
    audience: 'staff_member',
    channels: ['push', 'email'],
    smsEligible: false,
    smsAllowedByDefault: false,
    subjectTypes: ['teacher_assignment'],
    templateKey: 'cover_assigned',
  },
};

/**
 * The only types `school_settings.sms_allowed_types` may hold; the database refuses any other
 * (CHECK school_settings_sms_allowed_types_check).
 */
export const SMS_ELIGIBLE_TYPES: readonly MessageType[] = MESSAGE_TYPES.filter(
  (type) => MESSAGE_TYPE_TABLE[type].smsEligible,
);

/** The platform default of `school_settings.sms_allowed_types` (register item 22). */
export const DEFAULT_SMS_ALLOWED_TYPES: readonly MessageType[] = MESSAGE_TYPES.filter(
  (type) => MESSAGE_TYPE_TABLE[type].smsAllowedByDefault,
);

// -------------------------------------------------------------- providers and the school number

/** A school's WhatsApp number is paired through one of these (owner's §1.2 answer). */
export const WHATSAPP_PROVIDERS = ['waha', 'cloud_api'] as const;
export type WhatsAppProvider = (typeof WHATSAPP_PROVIDERS)[number];

/** `schools.whatsapp_provider`: a provider, or the platform-wide default. */
export const WHATSAPP_PROVIDER_CHOICES = [...WHATSAPP_PROVIDERS, 'platform_default'] as const;
export type WhatsAppProviderChoice = (typeof WHATSAPP_PROVIDER_CHOICES)[number];

/** Sendpk only for now (owner, 2026-10-03); a second adapter is a new value. */
export const SMS_PROVIDERS = ['sendpk'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** `schools.sms_provider`: a provider, or the platform-wide default. */
export const SMS_PROVIDER_CHOICES = [...SMS_PROVIDERS, 'platform_default'] as const;
export type SmsProviderChoice = (typeof SMS_PROVIDER_CHOICES)[number];

/** A school's WhatsApp number (`whatsapp_numbers.status`). */
export const WHATSAPP_STATUSES = ['pending', 'connected', 'down', 'disabled'] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];

/** `schools.sms_monthly_cap` until the platform sets one (owner, item 18). */
export const DEFAULT_SMS_MONTHLY_CAP = 500;
