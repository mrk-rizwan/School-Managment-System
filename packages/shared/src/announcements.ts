/** Announcement values (phase-2-daily-operations.md §5, slice 14). */

export const ANNOUNCEMENT_CATEGORIES = ['holiday', 'exam', 'fee', 'event', 'general'] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const ANNOUNCEMENT_PRIORITIES = ['normal', 'urgent'] as const;
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITIES)[number];

export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

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
