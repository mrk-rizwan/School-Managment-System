'use client';

import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { SearchField } from '@/components/list-filters';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, schoolApi, unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import { useListSearch } from '@/lib/list-search';
import type { AudienceSectionScope } from './audience-picker';

// The target choosers of the audience picker (contracts/slice-14.md §12.1): a class, a section,
// one student, one family (a guardian picked from a student), one staff member. Every list comes
// from an endpoint that is already scoped server-side for the caller; the client-side filtering
// here only spares the sender a 422 the server would give anyway. Nothing here names a phone
// number, an identity number or a guardian's relationship (R165).

const keys = {
  years: ['school', 'audience-picker', 'years'] as const,
  classes: (yearId: string) => ['school', 'audience-picker', 'classes', yearId] as const,
  sections: (classId: string) => ['school', 'audience-picker', 'sections', classId] as const,
  students: (q: string) => ['school', 'audience-picker', 'students', q] as const,
  guardians: (studentId: string) => ['school', 'audience-picker', 'guardians', studentId] as const,
  staff: (q: string) => ['school', 'audience-picker', 'staff', q] as const,
};

const SEARCH_LIMIT = 10;

export type Picked = { targetId: string; targetName: string };

type ClassOption = { id: string; name: string };

/** The classes the sender may choose from: every active class of a year (`all`), or those of their assignments. */
function useClassOptions(scope: AudienceSectionScope, yearId: string) {
  const all = scope === 'all';
  const classes = useQuery({
    queryKey: keys.classes(yearId),
    queryFn: () =>
      unwrap(
        schoolApi.GET('/api/v1/classes', {
          params: { query: { academicYearId: yearId, status: 'active', limit: OPTIONS_LIMIT, sort: 'sortOrder' } },
        }),
      ),
    enabled: all && yearId !== '',
  });
  if (!all) {
    const byId = new Map<string, ClassOption>();
    for (const row of scope) byId.set(row.classId, { id: row.classId, name: row.className });
    return { options: [...byId.values()].sort((x, y) => x.name.localeCompare(y.name)), pending: false, error: null };
  }
  return {
    options: (classes.data?.data ?? []).map((c) => ({ id: c.id, name: c.name })),
    pending: yearId === '' || classes.isPending,
    error: classes.error,
  };
}

/** A class's live sections, each marked whether the sender's scope reaches it (R144, mirrored). */
function useSectionOptions(scope: AudienceSectionScope, classId: string) {
  const sections = useQuery({
    queryKey: keys.sections(classId),
    queryFn: () =>
      unwrap(
        schoolApi.GET('/api/v1/classes/{id}/sections', {
          params: { path: { id: classId }, query: { limit: OPTIONS_LIMIT, sort: 'name' } },
        }),
      ),
    enabled: classId !== '',
  });
  const live = (sections.data?.data ?? []).filter((s) => s.archivedAt === null);
  const reaches = (sectionId: string) =>
    scope === 'all' || scope.some((row) => row.classId === classId && (row.sectionId === null || row.sectionId === sectionId));
  const options = live.map((s) => ({ id: s.id, name: s.name, inScope: reaches(s.id) }));
  return {
    options,
    pending: classId !== '' && sections.isPending,
    error: sections.error,
    /** A class is offered only when every live section of it is, and it has one (§12.1). */
    wholeClassInScope: options.length > 0 && options.every((s) => s.inScope),
  };
}

/** Open academic years, newest first, and the default: the first active one (rule 15: several may run). */
function useYearOptions(enabled: boolean) {
  const years = useQuery({
    queryKey: keys.years,
    queryFn: () =>
      unwrap(schoolApi.GET('/api/v1/academic-years', { params: { query: { limit: OPTIONS_LIMIT, sort: '-startsOn' } } })),
    enabled,
  });
  const open = (years.data?.data ?? []).filter((y) => y.status !== 'closed');
  return { open, fallback: open.find((y) => y.status === 'active')?.id ?? open[0]?.id ?? '', pending: enabled && years.isPending };
}

/** "By class" and "By section": a class select, and for a section a section select under it. */
export function ClassSectionChooser({
  scope,
  level,
  disabled,
  onAdd,
}: {
  scope: AudienceSectionScope;
  level: 'class' | 'section';
  disabled: boolean;
  onAdd: (kind: 'class' | 'section', picked: Picked) => void;
}) {
  const classId = useId();
  const sectionId = useId();
  const yearSelectId = useId();
  const years = useYearOptions(scope === 'all');
  const [yearChoice, setYearChoice] = useState('');
  const yearId = yearChoice || years.fallback;
  const [klass, setKlass] = useState('');
  const [section, setSection] = useState('');
  const classes = useClassOptions(scope, yearId);
  const sections = useSectionOptions(scope, klass);
  const className = classes.options.find((c) => c.id === klass)?.name ?? '';
  const sectionOptions = sections.options.filter((s) => s.inScope);
  const chosenSection = sectionOptions.find((s) => s.id === section);

  const classProblem =
    level === 'class' && klass !== '' && !sections.pending && !sections.error
      ? sections.options.length === 0
        ? 'This class has no sections, so nobody would receive it.'
        : !sections.wholeClassInScope
          ? 'You teach only some sections of this class. Choose a section instead.'
          : null
      : null;
  const canAdd =
    !disabled && klass !== '' && !sections.pending && (level === 'class' ? classProblem === null && !sections.error : chosenSection !== undefined);

  const add = () => {
    if (level === 'class') onAdd('class', { targetId: klass, targetName: className });
    else if (chosenSection) onAdd('section', { targetId: chosenSection.id, targetName: `${className} ${chosenSection.name}` });
    setSection('');
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-3">
        {scope === 'all' && (
          <div className="grid w-full gap-1.5 sm:w-44">
            <Label htmlFor={yearSelectId}>Academic year</Label>
            <NativeSelect
              id={yearSelectId}
              value={yearId}
              disabled={disabled || years.pending}
              onChange={(event) => (setYearChoice(event.target.value), setKlass(''), setSection(''))}
            >
              {years.pending && <option value="">Loading…</option>}
              {years.open.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={classId}>Class</Label>
          <NativeSelect
            id={classId}
            value={klass}
            disabled={disabled || classes.pending}
            onChange={(event) => (setKlass(event.target.value), setSection(''))}
          >
            <option value="">{classes.pending ? 'Loading…' : 'Choose…'}</option>
            {classes.options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {level === 'section' && (
          <div className="grid w-full gap-1.5 sm:w-36">
            <Label htmlFor={sectionId}>Section</Label>
            <NativeSelect
              id={sectionId}
              value={section}
              disabled={disabled || klass === '' || sections.pending}
              onChange={(event) => setSection(event.target.value)}
            >
              <option value="">{sections.pending ? 'Loading…' : 'Choose…'}</option>
              {sectionOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button type="button" variant="outline" disabled={!canAdd} onClick={add}>
          <PlusIcon />
          {level === 'class' ? 'Add class' : 'Add section'}
        </Button>
      </div>
      {classProblem && <p className="text-xs text-muted-foreground">{classProblem}</p>}
      {(classes.error ?? sections.error) && (
        <p className="text-xs text-destructive">{describeApiError(classes.error ?? sections.error)}</p>
      )}
      {scope !== 'all' && classes.options.length === 0 && (
        <p className="text-xs text-muted-foreground">You have no class or section assignment today.</p>
      )}
    </div>
  );
}

/** A search box with up to ten results, each with an Add (or Choose) button. */
function SearchResults<T extends { id: string }>({
  label,
  placeholder,
  query,
  search,
  setSearch,
  hint,
  render,
  actionLabel,
  onPick,
  disabled,
}: {
  label: string;
  placeholder: string;
  query: { data: T[] | undefined; isFetching: boolean; error: unknown };
  search: string;
  setSearch: (value: string) => void;
  hint?: string;
  render: (row: T) => React.ReactNode;
  actionLabel: (row: T) => string;
  onPick: (row: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-2">
      <SearchField value={search} onChange={setSearch} placeholder={placeholder} hint={hint} className="sm:w-80" />
      {query.error ? (
        <p className="text-xs text-destructive">{describeApiError(query.error)}</p>
      ) : query.data ? (
        query.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {label} found.</p>
        ) : (
          <ul className="grid gap-1" aria-label={`Matching ${label}`}>
            {query.data.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">{render(row)}</span>
                <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={actionLabel(row)} onClick={() => onPick(row)}>
                  <PlusIcon />
                  {actionLabel(row).split(' ')[0]}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : query.isFetching ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : null}
    </div>
  );
}

type StudentRow = { id: string; fullName: string; where: string | null };

/** GET /students?q=&status=active, already scoped to what the caller may see. */
function useStudentSearch(raw: string) {
  const term = useListSearch(raw);
  const q = term.q ?? '';
  const result = useQuery({
    queryKey: keys.students(q),
    queryFn: () =>
      unwrap(schoolApi.GET('/api/v1/students', { params: { query: { q, status: 'active', limit: SEARCH_LIMIT, sort: 'fullName' } } })),
    enabled: q !== '',
    select: (page): StudentRow[] =>
      page.data.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        where: s.current ? `${s.current.className} ${s.current.sectionName}` : null,
      })),
  });
  const hint = term.identity ? 'Search by name or admission number, not an identity number.' : term.hint;
  return { result: { ...result, data: q === '' ? undefined : result.data }, hint };
}

/** The student search step of "One student" and "One family": results with an Add or Choose button. */
function StudentSearch({
  search,
  setSearch,
  placeholder,
  verb,
  disabled,
  onPick,
}: {
  search: string;
  setSearch: (value: string) => void;
  placeholder: string;
  verb: 'Add' | 'Choose';
  disabled: boolean;
  onPick: (student: StudentRow) => void;
}) {
  const { result, hint } = useStudentSearch(search);
  return (
    <SearchResults<StudentRow>
      label="students"
      placeholder={placeholder}
      query={result}
      search={search}
      setSearch={setSearch}
      hint={hint}
      disabled={disabled}
      render={(s) => (
        <>
          {s.fullName}
          {s.where && <span className="text-muted-foreground"> · {s.where}</span>}
        </>
      )}
      actionLabel={(s) => `${verb} ${s.fullName}`}
      onPick={onPick}
    />
  );
}

/** "One student": the student and, by default, their family. */
export function StudentChooser({ disabled, onAdd }: { disabled: boolean; onAdd: (picked: Picked) => void }) {
  const [search, setSearch] = useState('');
  return (
    <StudentSearch
      search={search}
      setSearch={setSearch}
      placeholder="Student name or admission number"
      verb="Add"
      disabled={disabled}
      onPick={(s) => onAdd({ targetId: s.id, targetName: s.fullName })}
    />
  );
}

/** "One family": find the student, then choose one of their live guardians (GET /students/:id/guardian-links). */
export function FamilyChooser({ disabled, onAdd }: { disabled: boolean; onAdd: (picked: Picked) => void }) {
  // Kept here, so "Choose another student" returns to the same results.
  const [search, setSearch] = useState('');
  const [student, setStudent] = useState<StudentRow | null>(null);
  const guardians = useQuery({
    queryKey: keys.guardians(student?.id ?? ''),
    queryFn: () =>
      unwrap(
        schoolApi.GET('/api/v1/students/{id}/guardian-links', {
          params: { path: { id: student?.id ?? '' }, query: { limit: OPTIONS_LIMIT } },
        }),
      ),
    enabled: student !== null,
    // Only the name: never the phone, identity number or relationship (R165).
    select: (page) =>
      page.data.filter((l) => l.endedAt === null).map((l) => ({ id: l.guardianId, fullName: l.guardianFullName })),
  });

  if (!student) {
    return (
      <StudentSearch
        search={search}
        setSearch={setSearch}
        placeholder="Find the family by a child’s name"
        verb="Choose"
        disabled={disabled}
        onPick={setStudent}
      />
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Family of <span className="font-medium">{student.fullName}</span>
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setStudent(null)}>
          Choose another student
        </Button>
      </div>
      {guardians.error ? (
        <p className="text-xs text-destructive">{describeApiError(guardians.error)}</p>
      ) : guardians.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : guardians.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">This student has no guardian on record.</p>
      ) : (
        <ul className="grid gap-1" aria-label="Guardians">
          {guardians.data.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate">{g.fullName}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Add ${g.fullName}`}
                onClick={() => onAdd({ targetId: g.id, targetName: g.fullName })}
              >
                <PlusIcon />
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "One staff member" (announcement.send.school only): GET /staff?q=&status=active. */
export function StaffChooser({ disabled, onAdd }: { disabled: boolean; onAdd: (picked: Picked) => void }) {
  const [search, setSearch] = useState('');
  const term = useListSearch(search);
  const q = term.q ?? '';
  const staff = useQuery({
    queryKey: keys.staff(q),
    queryFn: () =>
      unwrap(schoolApi.GET('/api/v1/staff', { params: { query: { q, status: 'active', limit: SEARCH_LIMIT, sort: 'fullName' } } })),
    enabled: q !== '',
    select: (page) => page.data.map((s) => ({ id: s.id, fullName: s.fullName, designation: s.designation })),
  });
  return (
    <SearchResults
      label="staff"
      placeholder="Staff name or designation"
      query={{ ...staff, data: q === '' ? undefined : staff.data }}
      search={search}
      setSearch={setSearch}
      hint={term.identity ? 'Search by name, not an identity number.' : term.hint}
      disabled={disabled}
      render={(s) => (
        <>
          {s.fullName}
          {s.designation && <span className="text-muted-foreground"> · {s.designation}</span>}
        </>
      )}
      actionLabel={(s) => `Add ${s.fullName}`}
      onPick={(s) => onAdd({ targetId: s.id, targetName: s.fullName })}
    />
  );
}
