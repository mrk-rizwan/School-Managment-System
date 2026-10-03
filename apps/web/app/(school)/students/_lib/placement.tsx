'use client';

import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { academics } from '@/lib/api/school-academics-contract';
import { OPTIONS_LIMIT, academicsKeys } from '../../academics/_lib/academics-ui';

// Year → class → section pickers over the academic-structure list endpoints (contracts/slice-6.md
// §10: dropdowns use the list endpoints with limit=50). Used by the list filters, the admission
// wizard, readmission and change-class.

export type Placement = { academicYearId: string; classId: string; sectionId: string };
export const NO_PLACEMENT: Placement = { academicYearId: '', classId: '', sectionId: '' };

/** Wraps each request; the admission wizard passes its re-authenticating guard. */
type Call = <T>(request: () => Promise<T>) => Promise<T>;
const direct: Call = (request) => request();

export function useYears(call: Call = direct) {
  const query = { limit: OPTIONS_LIMIT, sort: '-startsOn' } as const;
  return useQuery({
    queryKey: [...academicsKeys.years, 'options', query],
    queryFn: () => call(() => unwrap(academics.GET('/api/v1/academic-years', { params: { query } }))),
  });
}

export function useClasses(academicYearId: string, call: Call = direct) {
  const query = { academicYearId, status: 'active', limit: OPTIONS_LIMIT, sort: 'sortOrder' } as const;
  return useQuery({
    queryKey: [...academicsKeys.classes, 'options', query],
    queryFn: () => call(() => unwrap(academics.GET('/api/v1/classes', { params: { query } }))),
    enabled: academicYearId !== '',
  });
}

export function useSections(classId: string, call: Call = direct) {
  const query = { limit: OPTIONS_LIMIT, sort: 'name' } as const;
  return useQuery({
    queryKey: [...academicsKeys.sections(classId), 'options', query],
    queryFn: () =>
      call(() =>
        unwrap(academics.GET('/api/v1/classes/{id}/sections', { params: { path: { id: classId }, query } })),
      ),
    enabled: classId !== '',
  });
}

/**
 * Three dependent selects. Changing the year clears class and section; changing the class clears
 * the section. With `anyLabel` each select offers "any" (filters); without it, a choice is asked
 * for. `fixedYearId` hides the year select (a class move stays in its year, R38). Closed years are
 * left out unless `includeClosedYears` (filters over history).
 */
export function PlacementSelects({
  value,
  onChange,
  anyLabel,
  fixedYearId,
  includeClosedYears = false,
  disabled,
  call,
  errors,
  compact = false,
}: {
  value: Placement;
  onChange: (value: Placement) => void;
  anyLabel?: string;
  fixedYearId?: string;
  includeClosedYears?: boolean;
  disabled?: boolean;
  call?: Call;
  errors?: Partial<Record<keyof Placement, string>>;
  /** Filter-bar widths instead of a form column. */
  compact?: boolean;
}) {
  const ids = { year: useId(), cls: useId(), section: useId() };
  const yearId = fixedYearId ?? value.academicYearId;
  const years = useYears(call);
  const classes = useClasses(yearId, call);
  const sections = useSections(value.classId, call);
  const yearOptions = (years.data?.data ?? []).filter(
    (y) => includeClosedYears || y.status !== 'closed',
  );
  const blank = anyLabel ?? 'Choose…';
  const width = compact ? 'w-full sm:w-44' : 'w-full';

  const select = (
    id: string,
    label: string,
    current: string,
    options: { id: string; name: string }[],
    loading: boolean,
    onPick: (id: string) => void,
    error: string | undefined,
    off: boolean,
  ) => (
    <div className={`grid gap-1.5 ${width}`}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={current}
        disabled={disabled || off}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onPick(event.target.value)}
      >
        <option value="">{loading ? 'Loading…' : blank}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </NativeSelect>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );

  return (
    <>
      {fixedYearId === undefined &&
        select(
          ids.year,
          'Academic year',
          value.academicYearId,
          yearOptions,
          years.isPending,
          (academicYearId) => onChange({ academicYearId, classId: '', sectionId: '' }),
          errors?.academicYearId,
          false,
        )}
      {select(
        ids.cls,
        'Class',
        value.classId,
        classes.data?.data ?? [],
        classes.isFetching,
        (classId) => onChange({ academicYearId: yearId, classId, sectionId: '' }),
        errors?.classId,
        yearId === '',
      )}
      {select(
        ids.section,
        'Section',
        value.sectionId,
        sections.data?.data ?? [],
        sections.isFetching,
        (sectionId) => onChange({ ...value, academicYearId: yearId, sectionId }),
        errors?.sectionId,
        value.classId === '',
      )}
    </>
  );
}
