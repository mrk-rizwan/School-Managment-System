'use client';

import { useQuery } from '@tanstack/react-query';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { academics } from '@/lib/api/school-academics-contract';
import { academicsKeys } from './academics-ui';

// The academic structure as dropdown options: the list endpoints at their largest page
// (contracts/slice-6.md §10). One query key per list, so every screen shares the cache.

/** Wraps each request; the admission wizard passes its re-authenticating guard. */
export type Call = <T>(request: () => Promise<T>) => Promise<T>;
const direct: Call = (request) => request();

/** Every academic year, newest first. */
export function useYears(call: Call = direct) {
  const query = { limit: OPTIONS_LIMIT, sort: '-startsOn' } as const;
  return useQuery({
    queryKey: [...academicsKeys.years, 'options'],
    queryFn: () => call(() => unwrap(academics.GET('/api/v1/academic-years', { params: { query } }))),
  });
}

/** A year's classes in order: the active ones, or every one with `includeArchived`. */
export function useClasses(
  academicYearId: string,
  { call = direct, includeArchived = false }: { call?: Call; includeArchived?: boolean } = {},
) {
  const query = {
    academicYearId,
    limit: OPTIONS_LIMIT,
    sort: 'sortOrder',
    ...(!includeArchived && { status: 'active' as const }),
  } as const;
  return useQuery({
    queryKey: [...academicsKeys.classes, 'options', query],
    queryFn: () => call(() => unwrap(academics.GET('/api/v1/classes', { params: { query } }))),
    enabled: academicYearId !== '',
  });
}

/** A class's sections, by name. */
export function useSections(classId: string, call: Call = direct) {
  const query = { limit: OPTIONS_LIMIT, sort: 'name' } as const;
  return useQuery({
    queryKey: [...academicsKeys.sections(classId), 'options'],
    queryFn: () =>
      call(() =>
        unwrap(academics.GET('/api/v1/classes/{id}/sections', { params: { path: { id: classId }, query } })),
      ),
    enabled: classId !== '',
  });
}

/** Every page of a list (page size 50, the API's cap) until its total. */
export async function allPages<T>(page: (n: number) => Promise<{ data: T[]; total: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let n = 1; ; n++) {
    const { data, total } = await page(n);
    out.push(...data);
    if (data.length === 0 || out.length >= total) return out;
  }
}

/** A class of the year with its live sections (useYearSections). */
export interface YearClassSections {
  id: string;
  name: string;
  sections: { id: string; name: string }[];
}

/**
 * A year's classes, each with its live sections, every page: the active classes, or every one
 * with `includeArchived`. The result-sheet and promotion screens pick a section from it.
 */
export function useYearSections(
  academicYearId: string,
  { enabled = true, includeArchived = false }: { enabled?: boolean; includeArchived?: boolean } = {},
) {
  return useQuery({
    queryKey: [...academicsKeys.classes, 'year-sections', academicYearId, { includeArchived }],
    queryFn: async (): Promise<YearClassSections[]> => {
      const classes = await allPages((page) =>
        unwrap(
          academics.GET('/api/v1/classes', {
            params: {
              query: { academicYearId, page, limit: OPTIONS_LIMIT, ...(!includeArchived && { status: 'active' as const }) },
            },
          }),
        ),
      );
      const out: YearClassSections[] = [];
      for (const klass of classes) {
        const sections = await allPages((page) =>
          unwrap(
            academics.GET('/api/v1/classes/{id}/sections', {
              params: { path: { id: klass.id }, query: { page, limit: OPTIONS_LIMIT } },
            }),
          ),
        );
        out.push({ id: klass.id, name: klass.name, sections: sections.map((s) => ({ id: s.id, name: s.name })) });
      }
      return out;
    },
    enabled: enabled && academicYearId !== '',
  });
}

/** Every subject, by name; fetched only while `enabled`. */
export function useSubjectOptions(enabled = true) {
  const query = { limit: OPTIONS_LIMIT, sort: 'name' } as const;
  return useQuery({
    queryKey: [...academicsKeys.subjects, 'options'],
    queryFn: () => unwrap(academics.GET('/api/v1/subjects', { params: { query } })),
    enabled,
  });
}
