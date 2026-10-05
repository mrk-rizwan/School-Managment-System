import type { Capability } from '@asms/shared';
import { api, unwrapWithDate } from '../api/client';
import type { MeDto, SubjectDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { schoolWide } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { useCachedQuery } from '../db/use-cached-query';

// The subjects a staff member may tag on a section (slice-16 §4.4, §4.6): the diary composer and
// the remark form.

type Subject = { id: string; name: string };

/**
 * Where the subject list comes from (slice-16 §4.4): the school's list when the key is held
 * school-wide (`MeDto.capabilityScopes`, slice-14 §8 — the principal, a grant) or the caller is
 * the section's class teacher or cover; else a subject teacher's own subjects on the section.
 * Without either, nothing: scope comes from assignments, never from the key alone (rule 13).
 */
export function ownSubjects(
  me: Pick<MeDto, 'assignments' | 'capabilities' | 'capabilityScopes'>,
  capability: Capability,
  sectionId: string,
  classId: string | null,
): Subject[] | 'all' {
  if (schoolWide(me, capability)) return 'all';
  const onSection = me.assignments.filter(
    (a) => a.sectionId === sectionId || (a.sectionId === null && a.classId === classId),
  );
  if (onSection.some((a) => a.role === 'class_teacher' || a.role === 'cover')) return 'all';
  const subjects = new Map<string, string>();
  for (const a of onSection) {
    if (a.subjectId !== null && a.subjectName !== null) subjects.set(a.subjectId, a.subjectName);
  }
  return [...subjects].map(([id, name]) => ({ id, name }));
}

/**
 * The subjects to offer: the caller's own, or the school's unarchived list (read only while
 * `enabled`). `loading` while the school's list is wanted and not yet here.
 */
export function useSubjectChoices(
  capability: Capability,
  sectionId: string,
  classId: string | null,
  enabled = true,
): { subjects: Subject[]; loading: boolean } {
  const { me } = useSession();
  const own = me ? ownSubjects(me.body, capability, sectionId, classId) : [];
  const school = useCachedQuery<{ data: SubjectDto[] }>(
    queryKeys.subjects,
    '/api/v1/subjects',
    { limit: 50 },
    () => unwrapWithDate(api.GET('/api/v1/subjects', { params: { query: { limit: 50 } } })),
    { enabled: own === 'all' && enabled },
  );
  if (own !== 'all') return { subjects: own, loading: false };
  return {
    subjects: (school.data?.body.data ?? [])
      .filter((s) => s.archivedAt === null)
      .map((s) => ({ id: s.id, name: s.name })),
    loading: school.isPending,
  };
}
