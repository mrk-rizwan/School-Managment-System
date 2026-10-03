// The NotificationService's input types (contracts/slice-9.md §7.1). TemplateVars<T> is the
// per-type variable shape: a type whose template is not written yet maps to `never`, so a sender
// for it does not compile until its slice adds the template (plan rule 0.12). Vars never carry a
// phone number, an identity number or a token (R111); the school's name is supplied by the
// service from `schools.name`, never by the sender.
import type { MessageSubjectType, MessageType } from '@asms/shared';

/** One person a message is addressed to. Exactly one key. */
export type Recipient =
  | { readonly guardianId: bigint }
  | { readonly staffId: bigint }
  | { readonly studentId: bigint };

/** Dates are calendar dates (`@db.Date` values, UTC midnight); times are instants. */
export interface TemplateVarsMap {
  absence_alert: never;
  late_advice: never;
  attendance_corrected: never;
  announcement_urgent: never;
  announcement_normal: never;
  /** Notice (subject `holiday`) or cancellation (subject `holiday_cancellation`), slice 10 §4.7. */
  holiday_notice: {
    readonly name: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
    /** Notice only; omitted or null when there is no next teaching day. */
    readonly reopensOn?: Date | null;
  };
  diary_posted: never;
  remark_posted: never;
  register_unrecorded: never;
  sms_cap_reached: { readonly cap: number; readonly nextMonthStart: Date };
  messaging_test: { readonly senderName: string; readonly time: Date };
  /** Not sent through send(): no `messages` row (§7.2). */
  whatsapp_session_down: never;
  /** slice-10.md §6 step 8 (R132). */
  cover_assigned: {
    readonly className: string;
    readonly sectionName: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
  };
}

export type TemplateVars<T extends MessageType> = TemplateVarsMap[T];

export interface SendInput<T extends MessageType> {
  readonly type: T;
  readonly subject: { readonly type: MessageSubjectType; readonly id: bigint };
  readonly recipients: readonly Recipient[];
  readonly vars: TemplateVars<T>;
  /** Announcement types only (slice 14). */
  readonly body?: string;
  /** Announcement types only (slice 14). */
  readonly media?: { readonly objectKey: string; readonly mime: string };
}

export interface SendResult {
  readonly created: number;
  readonly existing: number;
}
