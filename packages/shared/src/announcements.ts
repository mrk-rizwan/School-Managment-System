/** Announcement values (phase-2-daily-operations.md §5, slice 14). */

export const ANNOUNCEMENT_CATEGORIES = ['holiday', 'exam', 'fee', 'event', 'general'] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const ANNOUNCEMENT_PRIORITIES = ['normal', 'urgent'] as const;
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITIES)[number];

export const ANNOUNCEMENT_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/** Display labels, shared by the web and the mobile app. */
export const ANNOUNCEMENT_CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  holiday: 'Holiday',
  exam: 'Exam',
  fee: 'Fee',
  event: 'Event',
  general: 'General',
};
export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

/** `everyone` combines with nothing; `staff` and `staff_member` need announcement.send.school. */
export const AUDIENCE_KINDS = [
  'everyone',
  'parents',
  'students',
  'staff',
  'class',
  'section',
  'student',
  'guardian',
  'staff_member',
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** Roles within a `class`, `section` or `student` audience; default both. */
export const AUDIENCE_ROLES = ['parents', 'students'] as const;
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];

/** What an inbox item is (contracts/slice-14.md §2.1): an announcement, or any other message. */
export const INBOX_ITEM_KINDS = ['announcement', 'notice'] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

/** Kinds that need announcement.send.school (plan slice 14; concept slide 02 "whole school"). */
export const SCHOOL_WIDE_AUDIENCE_KINDS = [
  'everyone',
  'parents',
  'students',
  'staff',
  'staff_member',
] as const satisfies readonly AudienceKind[];
/** Kinds that take a targetId. */
export const TARGETED_AUDIENCE_KINDS = [
  'class',
  'section',
  'student',
  'guardian',
  'staff_member',
] as const satisfies readonly AudienceKind[];
/** Kinds that take roles (default both). */
export const ROLE_AUDIENCE_KINDS = [
  'class',
  'section',
  'student',
] as const satisfies readonly AudienceKind[];

export const ANNOUNCEMENT_BODY_MAX = 1800;
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_SMS_MAX_SEGMENTS = 3;
/** `audiences` holds 1-20 items. */
export const ANNOUNCEMENT_AUDIENCES_MAX = 20;

/** One audience item as the API takes it (contracts/slice-14.md §2.2). */
export interface AudienceInput {
  kind: AudienceKind;
  /** Required for TARGETED_AUDIENCE_KINDS, absent otherwise. */
  targetId?: string;
  /** ROLE_AUDIENCE_KINDS only; absent = both. */
  roles?: AudienceRole[];
}

/** The message type an announcement travels as (holiday notices keep their own allow-list entry). */
export const messageTypeOf = (a: {
  priority: AnnouncementPriority;
  holidayId: string | bigint | null;
}): 'holiday_notice' | 'announcement_urgent' | 'announcement_normal' =>
  a.holidayId !== null
    ? 'holiday_notice'
    : a.priority === 'urgent'
      ? 'announcement_urgent'
      : 'announcement_normal';

const includes = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

export type AudiencesProblemReason =
  | 'empty'
  | 'too_many'
  | 'everyone_not_alone'
  | 'target_forbidden'
  | 'target_required'
  | 'roles_forbidden'
  | 'roles_empty'
  | 'duplicate';

/**
 * Why `audiences` is not acceptable, or null: the API's 422 rules of contracts/slice-14.md §4.1,
 * for the picker to refuse early. `index` names the offending item (null: the whole list).
 */
export function audiencesProblem(
  audiences: readonly AudienceInput[],
): { index: number | null; reason: AudiencesProblemReason } | null {
  if (audiences.length === 0) return { index: null, reason: 'empty' };
  if (audiences.length > ANNOUNCEMENT_AUDIENCES_MAX) return { index: null, reason: 'too_many' };
  if (audiences.length > 1 && audiences.some((a) => a.kind === 'everyone')) {
    return { index: null, reason: 'everyone_not_alone' };
  }
  const seen = new Set<string>();
  for (const [index, a] of audiences.entries()) {
    const targeted = includes(TARGETED_AUDIENCE_KINDS, a.kind);
    if (!targeted && a.targetId !== undefined) return { index, reason: 'target_forbidden' };
    if (targeted && a.targetId === undefined) return { index, reason: 'target_required' };
    if (a.roles !== undefined) {
      if (!includes(ROLE_AUDIENCE_KINDS, a.kind)) return { index, reason: 'roles_forbidden' };
      if (a.roles.length === 0 || new Set(a.roles).size !== a.roles.length) {
        return { index, reason: 'roles_empty' };
      }
    }
    const key = `${a.kind}:${a.targetId ?? ''}`;
    if (seen.has(key)) return { index, reason: 'duplicate' };
    seen.add(key);
  }
  return null;
}

const targetOrder = (a?: string, b?: string): number => {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  // Ids are decimal strings: shorter is smaller.
  return a.length - b.length || (a < b ? -1 : 1);
};

/**
 * Collapses duplicates (roles merged), drops everything else when `everyone` is present, and sorts
 * by kind in AUDIENCE_KINDS order then targetId ascending. Roles are in AUDIENCE_ROLES order.
 */
export function normaliseAudiences(audiences: readonly AudienceInput[]): AudienceInput[] {
  if (audiences.some((a) => a.kind === 'everyone')) return [{ kind: 'everyone' }];
  const byKey = new Map<string, AudienceInput>();
  for (const a of audiences) {
    const key = `${a.kind}:${a.targetId ?? ''}`;
    const existing = byKey.get(key);
    // Absent roles mean both, so a merge with an absent side stays absent.
    const roles =
      a.roles === undefined || (existing !== undefined && existing.roles === undefined)
        ? undefined
        : [...(existing?.roles ?? []), ...a.roles];
    byKey.set(key, {
      kind: a.kind,
      ...(a.targetId === undefined ? {} : { targetId: a.targetId }),
      ...(roles === undefined ? {} : { roles: AUDIENCE_ROLES.filter((r) => roles.includes(r)) }),
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      AUDIENCE_KINDS.indexOf(a.kind) - AUDIENCE_KINDS.indexOf(b.kind) ||
      targetOrder(a.targetId, b.targetId),
  );
}
