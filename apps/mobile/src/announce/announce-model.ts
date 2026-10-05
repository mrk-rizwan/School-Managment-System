import {
  ANNOUNCEMENT_STATUS_LABELS,
  ApiError,
  ErrorCode,
  rateLimitMessage,
  describeApiError,
  type AnnouncementStatus,
  type AudienceInput,
  type AudienceKind,
} from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, isNetworkError, unwrap } from '../api/client';
import type {
  AnnouncementDto,
  AudiencePreviewDto,
  DeliverySummaryDto,
  MessagingUsageDto,
} from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import type { Cached } from '../db/cache';
import { useOnlineOnly } from '../net/connectivity';

// Announce (slice-16 §7.2, aligned with contracts/slice-14.md §2, §4, §12): the reduced
// audience picker's shapes, the preview line, the send outcomes, the usage and delivery words —
// all pure — and the one send of a saved draft.
// Delivery is "accepted / delivered / failed / suppressed" — there is no such thing as a message
// someone has opened (R150).

/** The mobile picker's kinds (slice-14 §12): broad kinds, one class, or one section. */
export type AudienceChoice =
  | { kind: 'everyone' | 'parents' | 'students' | 'staff' }
  | { kind: 'class' | 'section'; targetId: string | null; parentsOnly: boolean };

export type ChoiceKind = AudienceChoice['kind'];

export const CHOICE_LABELS: Record<ChoiceKind, string> = {
  everyone: 'Everyone',
  parents: 'All parents',
  students: 'All students',
  staff: 'All staff',
  class: 'One class',
  section: 'One section',
};

/** The request's audiences for a choice, or null while a class or section is not picked. */
export function audiencesFor(choice: AudienceChoice): AudienceInput[] | null {
  if (choice.kind === 'class' || choice.kind === 'section') {
    if (choice.targetId === null) return null;
    return [
      {
        kind: choice.kind,
        targetId: choice.targetId,
        roles: choice.parentsOnly ? ['parents'] : ['parents', 'students'],
      },
    ];
  }
  return [{ kind: choice.kind }];
}

const AUDIENCE_KIND_LABELS: Record<AudienceKind, string> = {
  everyone: 'Everyone',
  parents: 'All parents',
  students: 'All students',
  staff: 'All staff',
  class: 'A class',
  section: 'A section',
  student: 'One student',
  guardian: 'One family',
  staff_member: 'A staff member',
};

/**
 * An audience in words: a class, a section or a staff member by name; a student or a guardian
 * only by kind — the principal's phone never lists a child's or a parent's name (review L5).
 */
export function audienceLabel(a: { kind: AudienceKind; targetName: string | null }): string {
  const named = a.kind === 'class' || a.kind === 'section' || a.kind === 'staff_member';
  return named && a.targetName ? a.targetName : AUDIENCE_KIND_LABELS[a.kind];
}

export const SMS_SEGMENT_HINT = 160;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Reaches 83 people (60 parents, 20 students, 3 staff) · SMS: 120 units of 900 left". */
export function previewLine(preview: AudiencePreviewDto): string {
  const r = preview.recipients;
  const reach = `Reaches ${plural(r.total, 'person', 'people')} (${plural(r.guardians, 'parent', 'parents')}, ${plural(r.students, 'student', 'students')}, ${r.staff} staff)`;
  const sms = preview.sms.allowed
    ? `SMS: ${preview.sms.units} units of ${preview.sms.remaining} left`
    : 'SMS: none for this message';
  return `${reach} · ${sms}`;
}

const WARNINGS: Record<AudiencePreviewDto['warnings'][number], string> = {
  sms_cap_short: 'Not enough SMS left this month for this message.',
  sms_too_long: 'Over 3 SMS segments: shorten it or send as normal.',
  no_recipients: 'Nobody would receive this. Choose another audience.',
  whatsapp_not_connected: 'WhatsApp is not connected: parents get SMS instead.',
};

export const warningLines = (preview: AudiencePreviewDto) =>
  preview.warnings.map((w) => WARNINGS[w]);

export type PreviewState =
  | { kind: 'idle' }
  | { kind: 'ready'; preview: AudiencePreviewDto }
  | { kind: 'paused'; message: string }
  | { kind: 'error'; message: string };

/** A preview that failed: a 429 pauses counting (sending still works, the server recounts). */
export function previewFailure(error: unknown): PreviewState {
  if (error instanceof ApiError && error.status === 429) {
    const seconds = error.retryAfterSeconds;
    return {
      kind: 'paused',
      message:
        seconds === null
          ? 'Counting paused — try again in a moment.'
          : `Counting paused — try again in ${seconds} s.`,
    };
  }
  if (!(error instanceof ApiError)) {
    const message = isNetworkError(error)
      ? 'Cannot count without a connection.'
      : 'Cannot count right now. Try again.';
    return { kind: 'error', message };
  }
  return { kind: 'error', message: describeApiError(error) };
}

/** The announcement id a reused-key or replay answer names, when it names one; else null. */
export function reusedKeyId(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const d = error.details as { id?: unknown; subjectId?: unknown; announcementId?: unknown } | null;
  const id = d?.announcementId ?? d?.subjectId ?? d?.id;
  return typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) ? id : null;
}

export type SendFailure =
  | { kind: 'cap'; message: string }
  | { kind: 'key_reused'; message: string }
  | { kind: 'other'; message: string };

/** What the composer says when create or send is refused (slice-16 §7.2, slice-14 §9). */
export function sendFailure(error: unknown, draftSaved: boolean): SendFailure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'other',
      message: draftSaved
        ? 'Saved as a draft but not sent. Send again, or send it from the list.'
        : isNetworkError(error)
          ? 'No connection. Sending needs a connection.'
          : 'Not sent. Try again.',
    };
  }
  if (error.status === 429) return { kind: 'other', message: rateLimitMessage(error) };
  switch (error.code) {
    case ErrorCode.SMS_CAP_EXCEEDED: {
      const d = (error.details ?? {}) as { smsUnits?: number; remaining?: number };
      return {
        kind: 'cap',
        message: `This needs ${d.smsUnits ?? 'more'} SMS units; ${d.remaining ?? 0} are left this month. Send as normal (no SMS) or ask the platform to raise the cap.`,
      };
    }
    case ErrorCode.SMS_TOO_LONG:
      return { kind: 'other', message: 'Shorten the message or send as normal.' };
    case ErrorCode.ANNOUNCEMENT_NO_RECIPIENTS:
      return { kind: 'other', message: 'Nobody would receive this. Choose another audience.' };
    case ErrorCode.IDEMPOTENCY_KEY_REUSED:
      return { kind: 'key_reused', message: 'This was already saved. Opening the draft.' };
    default:
      if (error.fieldErrors.some((f) => f.path.startsWith('audiences'))) {
        return { kind: 'other', message: 'That class or section is not available.' };
      }
      return { kind: 'other', message: describeApiError(error) };
  }
}

const STATUS_LABELS: Record<AnnouncementStatus, string> = {
  ...ANNOUNCEMENT_STATUS_LABELS,
  // Send-now answers `sending` and a job delivers it (slice-14 change, wave F): a success.
  sending: 'Sending…',
};

/**
 * Sending a saved draft, online only (R162): `gate` enables the button; `send(id)` posts it,
 * shows the answer on its detail at once (send-now answers `sending`, a job delivers it) and
 * fetches every announcement list and detail again. Retry-safe by state: an announcement already
 * sent answers 200 (slice-14 §5.5).
 */
export function useSendAnnouncement() {
  const client = useQueryClient();
  const gate = useOnlineOnly('send_announcement');
  async function send(id: string): Promise<void> {
    const result = await unwrap(
      api.POST('/api/v1/announcements/{id}/send', { params: { path: { id } } }),
    );
    client.setQueryData<Cached<AnnouncementDto>>(queryKeys.announcement(id), (old) =>
      old === undefined ? old : { ...old, body: result },
    );
    await client.invalidateQueries({ queryKey: ['announcements'] });
  }
  return { gate, send };
}

/** A draft whose send failed five times (`sendFailedAt`); a new send clears it on the server. */
export const SEND_FAILED_TEXT = 'Sending failed. Try again.';

/** The status word a row shows: a failed send says so, else the status. */
export const statusWord = (a: { status: AnnouncementStatus; sendFailedAt: string | null }) =>
  a.status === 'draft' && a.sendFailedAt !== null ? SEND_FAILED_TEXT : STATUS_LABELS[a.status];

/** How often a page holding a `sending` announcement reads it again while open (the web's 3 s). */
export const SENDING_REFRESH_MS = 3000;

/** "SMS this month: 120 of 1000 · 880 left". */
export function usageLine(usage: MessagingUsageDto): string {
  const used = usage.months[0]?.byChannel.find((c) => c.channel === 'sms')?.count ?? 0;
  return `SMS this month: ${used} of ${usage.cap} · ${usage.remaining} left`;
}

const CHANNEL_NAMES: Record<DeliverySummaryDto['byChannel'][number]['channel'], string> = {
  push: 'App',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
};

/** One line per channel: "WhatsApp: 40 accepted · 38 delivered · 1 failed · 2 suppressed". */
export function deliveryLines(delivery: DeliverySummaryDto): string[] {
  return delivery.byChannel.map(
    (c) =>
      `${CHANNEL_NAMES[c.channel]}: ${c.accepted} accepted · ${c.delivered} delivered · ${c.failed} failed · ${c.suppressed} suppressed`,
  );
}
