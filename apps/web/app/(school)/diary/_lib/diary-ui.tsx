'use client';

import { Capability, ErrorCode } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@/lib/api/client';
import { NOT_ASSIGNED_ON_DATE, refusalMessage, toApiError, type RefusalMessages } from '@/lib/api/errors';
import { academics } from '@/lib/api/school-academics-contract';
import { diaryApi, type DiaryEntryDto } from '@/lib/api/school-diary-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { capabilityScope } from '@/lib/school-session';
import { academicsKeys } from '../../academics/_lib/academics-ui';
import { mySections } from '../../attendance/_lib/attendance-ui';
import { saveBlob } from '../../students/_lib/documents';
import type { MeDto } from '@/lib/api/school-contract';

// Pieces shared by the diary screens (contracts/slice-13.md §4, §11).

export const diaryKeys = {
  all: ['school', 'diary'] as const,
  section: (sectionId: string) => ['school', 'diary', 'section', sectionId] as const,
  entry: (id: string) => ['school', 'diary', 'entry', id] as const,
};

export const diaryHref = (sectionId: string) => `/sections/${sectionId}/diary`;

/** `<img src>` of an image attachment's thumbnail (§4.5): cookie-authenticated, loaded on tap only. */
export const diaryThumbnailUrl = (entryId: string) => `/api/v1/diary-entries/${entryId}/thumbnail`;

/** Edited after it was written. */
export const isEdited = (entry: DiaryEntryDto) => entry.updatedAt > entry.createdAt;

/**
 * How the caller stands in this section today (GET /me assignments): assigned and, if so, which
 * subjects they may write. Who may edit which entry is `entryEditability`.
 */
export function sectionStanding(me: MeDto | undefined, sectionId: string, today: string) {
  const mine = mySections(me, today).find((s) => s.sectionId === sectionId);
  const anySubject = !mine || mine.roles.includes('class_teacher') || mine.roles.includes('cover');
  return { assigned: mine !== undefined, subjectIds: anySubject ? null : mine.subjectIds };
}

/**
 * Whether the caller holds diary.write school-wide: GET /me `capabilityScopes` says `all` (a
 * principal, a custom role or a grant), the server's own rule (contracts/slice-14.md §8). A
 * teacher holding it only through the teacher default (`assigned_sections`) gets the section rules.
 */
const writesSchoolWide = (me: MeDto | undefined): boolean => capabilityScope(me, Capability.DIARY_WRITE) === 'all';

export type EntryEditability = {
  /** The card's Edit button, the "window closed" line, or nothing (§11). */
  state: 'editable' | 'locked' | 'hidden';
  afterWindow: boolean;
  /** The edit form's reason field: absent, optional, or required (after the window). */
  reason: 'none' | 'optional' | 'required';
};

/**
 * §4.4 and §11, the server's rule: the author edits inside the window; after it a section-scoped
 * author is locked; a school-wide holder edits any entry, with a reason after the window (optional
 * inside it, on someone else's entry). Another section teacher sees no control (`not_author`).
 * The section card and the edit form both read this, so they agree.
 */
export function entryEditability(entry: DiaryEntryDto, me: MeDto | undefined, today = todayInSchool()): EntryEditability {
  const byAuthor = me?.staffId != null && entry.authorStaffId === me.staffId;
  const afterWindow = today > entry.editWindowEndsOn;
  if (writesSchoolWide(me)) {
    return { state: 'editable', afterWindow, reason: afterWindow ? 'required' : byAuthor ? 'none' : 'optional' };
  }
  if (!byAuthor) return { state: 'hidden', afterWindow, reason: 'none' };
  return { state: afterWindow ? 'locked' : 'editable', afterWindow, reason: 'none' };
}

/** GET /sections/:id and its class, for the screen's title. */
export function useSectionTitle(sectionId: string) {
  const section = useQuery({
    queryKey: [...academicsKeys.all, 'section', sectionId],
    queryFn: () => unwrap(academics.GET('/api/v1/sections/{id}', { params: { path: { id: sectionId } } })),
  });
  const classId = section.data?.classId ?? '';
  const klass = useQuery({
    queryKey: academicsKeys.class(classId),
    queryFn: () => unwrap(academics.GET('/api/v1/classes/{id}', { params: { path: { id: classId } } })),
    enabled: classId !== '',
  });
  return section.data && klass.data ? `${klass.data.name} ${section.data.name}` : null;
}

const DIARY_REFUSALS: RefusalMessages = {
  [ErrorCode.DIARY_ENTRY_EXISTS]: 'Already written for this date and subject.',
  [ErrorCode.SUBJECT_NOT_ASSIGNED]: 'You do not teach this subject in this section on that date.',
  [ErrorCode.SUBJECT_ARCHIVED]: 'That subject is archived.',
  [ErrorCode.SECTION_ARCHIVED]: 'This section is archived, so its diary is closed.',
  [ErrorCode.CLASS_ARCHIVED]: 'This class is archived, so its diary is closed.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'This academic year is closed, so its diary cannot change.',
  [ErrorCode.AMENDMENT_REASON_REQUIRED]: 'The edit window has closed: give a reason for the change.',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'This form was already used for a different entry. Save again to send it as a new one.',
  [`${ErrorCode.PERMISSION_DENIED}:not_author`]: 'Only the teacher who wrote this entry, or the principal, can change it.',
  [`${ErrorCode.PERMISSION_DENIED}:not_assigned_on_date`]: NOT_ASSIGNED_ON_DATE,
};

/** One sentence for a diary refusal (§8); anything else is `describeApiError`. */
export function diaryErrorMessage(error: unknown, entry?: Pick<DiaryEntryDto, 'editWindowEndsOn'>): string {
  return refusalMessage(error, {
    ...DIARY_REFUSALS,
    [ErrorCode.DIARY_ENTRY_LOCKED]: entry
      ? `The edit window closed on ${formatDay(entry.editWindowEndsOn)}; ask the principal.`
      : 'The edit window has closed; ask the principal.',
  });
}

/** GET /diary-entries/:id/attachment, saved under the name its Content-Disposition gives. */
export async function downloadDiaryAttachment(entryId: string): Promise<void> {
  const { data, error, response } = await diaryApi.GET('/api/v1/diary-entries/{id}/attachment', {
    params: { path: { id: entryId } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) throw toApiError(response, error);
  saveBlob(data, response, `diary-${entryId}`);
}
