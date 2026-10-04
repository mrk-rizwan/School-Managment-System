import { api, unwrapWithDate } from '../api/client';
import type { MyDiaryEntryDto, MyRemarkDto, StudentAttendanceDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';

// Whose records a family screen shows (slice-16 §5): a guardian's child through /me/children/:id,
// or a student's own through /me/student. The child and student screens are one set of
// components bound to one of these, read through one builder.

export type FamilySource = { kind: 'child'; studentId: string } | { kind: 'own' };

type Range = { dateFrom: string; dateTo: string };
type Page<T> = { data: T[]; total: number; page: number; limit: number };

type Results = {
  attendance: StudentAttendanceDto;
  diary: Page<MyDiaryEntryDto>;
  remarks: Page<MyRemarkDto>;
};
type Resource = keyof Results;
type Query = { dateFrom?: string; dateTo?: string; limit?: number; page?: number };

const PATHS: Record<Resource, string> = {
  attendance: 'attendance',
  diary: 'diary-entries',
  remarks: 'remarks',
};

/** The typed request per resource and owner; the builder below is the only caller. */
function request(source: FamilySource, resource: Resource, query: Query) {
  const child = source.kind === 'child' ? { path: { id: source.studentId }, query } : null;
  switch (resource) {
    case 'attendance': {
      const range = query as Range;
      return child
        ? api.GET('/api/v1/me/children/{id}/attendance', { params: { ...child, query: range } })
        : api.GET('/api/v1/me/student/attendance', { params: { query: range } });
    }
    case 'diary':
      return child
        ? api.GET('/api/v1/me/children/{id}/diary-entries', { params: child })
        : api.GET('/api/v1/me/student/diary-entries', { params: { query } });
    case 'remarks':
      return child
        ? api.GET('/api/v1/me/children/{id}/remarks', { params: child })
        : api.GET('/api/v1/me/student/remarks', { params: { query } });
  }
}

/**
 * One family read: its query key (query-keys.ts), its cache path and params, and its fetch.
 * Attendance takes a date range; the diary a range and a page of 25; remarks a page of 25.
 */
export function familyRead<R extends Resource>(
  source: FamilySource,
  resource: R,
  range: R extends 'remarks' ? null : Range,
) {
  const page = 1;
  // Only the two dates: a month passed in carries its title, which is no query parameter.
  const dates = range === null ? null : { dateFrom: range.dateFrom, dateTo: range.dateTo };
  const query: Query =
    resource === 'attendance'
      ? { ...dates! }
      : resource === 'diary'
        ? { ...dates!, limit: 25, page }
        : { limit: 25, page };
  const parts =
    resource === 'attendance'
      ? [range!.dateFrom, range!.dateTo]
      : resource === 'diary'
        ? [range!.dateFrom, range!.dateTo, page]
        : [page];
  const studentId = source.kind === 'child' ? source.studentId : null;
  const base = studentId === null ? '/api/v1/me/student' : `/api/v1/me/children/${studentId}`;
  return {
    key: queryKeys.family(studentId, resource, ...parts),
    path: `${base}/${PATHS[resource]}`,
    params: query,
    fetch: () =>
      unwrapWithDate<Results[R]>(
        request(source, resource, query) as Promise<{
          data?: Results[R];
          error?: unknown;
          response: Response;
        }>,
      ),
  };
}

/** The entry's base path: `/thumbnail` and `/attachment` hang off it. */
export function attachmentBase(source: FamilySource, entryId: string): string {
  return source.kind === 'child'
    ? `/api/v1/me/children/${source.studentId}/diary-entries/${entryId}`
    : `/api/v1/me/student/diary-entries/${entryId}`;
}
