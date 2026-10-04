'use client';

import { ANNOUNCEMENT_SMS_MAX_SEGMENTS, Capability, ErrorCode, type AnnouncementCategory, type AnnouncementPriority, type AnnouncementStatus } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import { refusalMessage, toApiError, type RefusalMessages } from '@/lib/api/errors';
import {
  announcementsApi,
  type AnnouncementDto,
  type AudienceDto,
  type SuppressionReason,
} from '@/lib/api/school-announcements-contract';
import type { MeDto } from '@/lib/api/school-contract';
import { capabilityScope } from '@/lib/school-session';
import type { AudienceSectionScope } from '@/components/audience-picker/audience-picker';
import { saveBlob } from '../../students/_lib/documents';

// Pieces shared by the announcement screens (contracts/slice-14.md §5, §12).

export const announcementKeys = {
  all: ['school', 'announcements'] as const,
  list: ['school', 'announcements', 'list'] as const,
  detail: (id: string) => ['school', 'announcements', 'detail', id] as const,
  delivery: (id: string) => ['school', 'announcements', 'delivery', id] as const,
  preview: ['school', 'announcements', 'preview'] as const,
  inbox: ['school', 'inbox'] as const,
  inboxItem: (id: string) => ['school', 'inbox', 'item', id] as const,
};

export const announcementHref = (id: string) => `/announcements/${id}`;

export const CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  holiday: 'Holiday',
  exam: 'Exam',
  fee: 'Fee',
  event: 'Event',
  general: 'General',
};
export const PRIORITY_LABELS: Record<AnnouncementPriority, string> = { normal: 'Normal', urgent: 'Urgent' };
export const STATUS_LABELS: Record<AnnouncementStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  cancelled: 'Cancelled',
};
const STATUS_VARIANT = {
  draft: 'outline',
  scheduled: 'secondary',
  sending: 'secondary',
  sent: 'default',
  cancelled: 'ghost',
} as const satisfies Record<AnnouncementStatus, string>;

/**
 * A send now answers `sending`: the server writes the messages in a background job (contracts/
 * slice-14.md §5.5, decision 9 reversed) and the detail page shows the row become `sent`.
 */
export const SENDING_TOAST = 'Sending now. This page shows when it has gone.';

export function AnnouncementStatusBadge({ status }: { status: AnnouncementStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: AnnouncementPriority }) {
  return priority === 'urgent' ? <Badge variant="destructive">Urgent</Badge> : <span className="text-muted-foreground">Normal</span>;
}

/** §12 "Announcement detail": suppression reasons in plain words. */
export const SUPPRESSION_LABELS: Record<SuppressionReason, string> = {
  no_channel: 'No phone or app',
  not_allowed: 'SMS off for this type',
  cap_reached: 'SMS allowance used',
  duplicate_phone: 'Same phone as another recipient',
  subject_cancelled: 'Withdrawn before sending',
  backdated: 'Out of date by the time it could go',
};

/** What content a status still allows (§5.1, R146). */
export const isEditable = (a: Pick<AnnouncementDto, 'status'>) => a.status === 'draft' || a.status === 'scheduled';

/** "Class 5 A", "Everyone", … for an audience line. */
export function audienceLabel(a: Pick<AudienceDto, 'kind' | 'targetName' | 'roles'>): string {
  const roles = a.roles.length === 1 ? ` (${a.roles[0] === 'parents' ? 'parents' : 'students'} only)` : '';
  switch (a.kind) {
    case 'everyone':
      return 'Everyone';
    case 'parents':
      return 'All parents';
    case 'students':
      return 'All students';
    case 'staff':
      return 'All staff';
    case 'guardian':
      return `Family: ${a.targetName ?? 'unknown'}`;
    default:
      return `${a.targetName ?? 'Unknown'}${roles}`;
  }
}

/**
 * Who may send to whom, as GET /me shows it (§1.2, §12.1): broad kinds need
 * announcement.send.school; the section reach is `all` when either held key is school-wide, else
 * today's assignments (with a whole-class subject row reaching the whole class).
 */
export function senderReach(me: MeDto | undefined, today: string): { canSend: boolean; canSchoolWide: boolean; scope: AudienceSectionScope } {
  const held = me?.capabilities ?? [];
  const canSchoolWide = held.includes(Capability.ANNOUNCEMENT_SEND_SCHOOL);
  const canSend = canSchoolWide || held.includes(Capability.ANNOUNCEMENT_SEND_SCOPE);
  const school = capabilityScope(me, Capability.ANNOUNCEMENT_SEND_SCHOOL);
  const scoped = capabilityScope(me, Capability.ANNOUNCEMENT_SEND_SCOPE);
  if (school === 'all' || scoped === 'all') return { canSend, canSchoolWide, scope: 'all' };
  const live = (me?.assignments ?? []).filter((a) => a.startsOn <= today && (a.endsOn === null || a.endsOn >= today));
  return {
    canSend,
    canSchoolWide,
    scope: live.map((a) => ({ classId: a.classId, className: a.className, sectionId: a.sectionId, sectionName: a.sectionName })),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const ANNOUNCEMENT_REFUSALS: RefusalMessages = {
  [ErrorCode.ANNOUNCEMENT_SENT]: 'This announcement has been sent, so it cannot change. Write a new one to correct it.',
  [ErrorCode.ANNOUNCEMENT_CANCELLED]: 'This announcement is cancelled. Write a new one instead.',
  [ErrorCode.ANNOUNCEMENT_NO_RECIPIENTS]: 'Nobody is in this audience today. Choose a different audience.',
  [ErrorCode.SMS_TOO_LONG]: (d) =>
    `Over ${ANNOUNCEMENT_SMS_MAX_SEGMENTS} SMS segments (${String(d.segments ?? 'more')}); shorten it or send as normal.`,
  [ErrorCode.SMS_CAP_EXCEEDED]: (d) =>
    `Needs ${plural(Number(d.smsUnits ?? 0), 'SMS unit')}; ${String(d.remaining ?? 0)} remain. Send as normal, or shorten.`,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'This form was already used for a different announcement. Save again to send it as a new one.',
  [`${ErrorCode.PERMISSION_DENIED}:audience_requires_school`]:
    'Only someone allowed to message the whole school can choose Everyone, all parents, all students or staff.',
  [ErrorCode.CLASS_ARCHIVED]: 'A class in the audience is archived. Remove it.',
  [ErrorCode.SECTION_ARCHIVED]: 'A section in the audience is archived. Remove it.',
  [ErrorCode.STUDENT_NOT_ACTIVE]: 'A student in the audience has left the school. Remove them.',
  [ErrorCode.GUARDIAN_MERGED]: 'A family in the audience was merged into another record. Remove it and choose the family again.',
  [ErrorCode.STAFF_NOT_ACTIVE]: 'A staff member in the audience has left. Remove them.',
  [ErrorCode.NOT_FOUND]: 'This announcement no longer exists, or it is not yours to change.',
};

/** One sentence for an announcement refusal (§9); anything else is `describeApiError`. */
export const announcementErrorMessage = (error: unknown) => refusalMessage(error, ANNOUNCEMENT_REFUSALS);

/** GET /announcements/:id/attachment, saved under the name its Content-Disposition gives. */
export async function downloadAnnouncementAttachment(id: string): Promise<void> {
  const { data, error, response } = await announcementsApi.GET('/api/v1/announcements/{id}/attachment', {
    params: { path: { id } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) throw toApiError(response, error);
  saveBlob(data, response, `announcement-${id}`);
}

/** GET /me/inbox/:id/attachment, the recipient's copy. */
export async function downloadInboxAttachment(id: string): Promise<void> {
  const { data, error, response } = await announcementsApi.GET('/api/v1/me/inbox/{id}/attachment', {
    params: { path: { id } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) throw toApiError(response, error);
  saveBlob(data, response, `announcement-${id}`);
}

// ---- Schedule times. Every school is on Asia/Karachi (CLAUDE.md, assumed unless corrected): UTC+5, no DST ----

const KARACHI_MS = 5 * 60 * 60 * 1000;
/** A `datetime-local` value, read as Karachi time, as an ISO instant. */
export const localToInstant = (local: string) => new Date(`${local}:00+05:00`).toISOString();
/** An ISO instant as a Karachi `datetime-local` value. */
export const instantToLocal = (iso: string) => new Date(new Date(iso).getTime() + KARACHI_MS).toISOString().slice(0, 16);
