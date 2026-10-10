'use client';

import { Capability, ErrorCode } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import { staffApi } from '@/lib/api/school-staff-contract';
import type { TimetableVersionStatus } from '@/lib/api/school-timetable-contract';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { allPages, useYearSections } from '../../academics/_lib/options';

// Shared by the timetable screens (contracts/slice-37.md §7): query keys, labels, refusals, the
// tabs and the section picker.

export const timetableKeys = {
  all: ['school', 'timetable'] as const,
  week: (sectionId: string, date: string) => ['school', 'timetable', 'week', sectionId, date] as const,
  version: (id: string) => ['school', 'timetable', 'version', id] as const,
  versions: (query: object) => ['school', 'timetable', 'versions', query] as const,
  substitutions: (query: object) => ['school', 'timetable', 'substitutions', query] as const,
  grid: (query: object) => ['school', 'timetable', 'grid', query] as const,
  others: (yearId: string, date: string) => ['school', 'timetable', 'others', yearId, date] as const,
};

export const weekHref = (sectionId: string) => `/timetable?section=${encodeURIComponent(sectionId)}`;
export const editHref = (sectionId: string) => `/timetable/sections/${encodeURIComponent(sectionId)}/edit`;

export const VERSION_STATUS_LABELS: Record<TimetableVersionStatus, string> = {
  live: 'In use',
  future: 'Starts later',
  past: 'Ended',
  voided: 'Voided',
};

export const versionStatusVariant = (
  status: TimetableVersionStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' =>
  status === 'live' ? 'default' : status === 'future' ? 'secondary' : status === 'voided' ? 'destructive' : 'outline';

/** 1..periodsPerDay. */
export const periodsOf = (periodsPerDay: number) => Array.from({ length: periodsPerDay }, (_, i) => i + 1);

const TIMETABLE_REFUSALS: RefusalMessages = {
  [ErrorCode.TIMETABLE_VERSION_SUPERSEDED]:
    'This section already has a timetable starting on that date or after it. Void it first under Versions.',
  [ErrorCode.TIMETABLE_VERSION_NOT_FUTURE]: 'Only a timetable starting today or later can be voided.',
  [ErrorCode.TIMETABLE_SLOT_CLASH]: (details) =>
    details.kind === 'room'
      ? 'A room would be booked twice in the same period.'
      : details.kind === 'section'
        ? 'Two lessons would share a period.'
        : 'A teacher would be in two places in the same period.',
  [ErrorCode.TIMETABLE_OFF_DAY]: 'A lesson falls on a weekly-off day.',
  [ErrorCode.TIMETABLE_TEACHER_NOT_ASSIGNED]:
    'A teacher does not teach that subject in this section on the start date. Assign them first (Staff → Assignments).',
  [ErrorCode.TIMETABLE_SUBSTITUTION_EXISTS]:
    'That period already has a substitute, or the substitute is already covering another class then.',
  [ErrorCode.TIMETABLE_SUBSTITUTION_NOT_TIMETABLED]: 'No lesson is timetabled in that period on that date.',
  [ErrorCode.TIMETABLE_SUBSTITUTION_SAME_TEACHER]: 'That is the regular teacher of the lesson.',
  [ErrorCode.TIMETABLE_SUBSTITUTIONS_EXIST]: (details) => {
    const ids = Array.isArray(details.substitutionIds) ? details.substitutionIds.length : 0;
    return `${ids === 1 ? 'A substitution is' : `${ids || 'Some'} substitutions are`} booked on the dates this change affects. Void ${ids === 1 ? 'it' : 'them'} first under Substitutions.`;
  },
  [ErrorCode.NOT_A_TEACHING_DAY]: 'That date is not a teaching day.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'The academic year is closed.',
  [ErrorCode.CONCURRENT_UPDATE]: 'The timetable changed meanwhile. Reload and try again.',
};

export const timetableErrorMessage = (error: unknown): string => refusalMessage(error, TIMETABLE_REFUSALS);

const TABS = [
  { href: '/timetable', label: 'Week' },
  { href: '/timetable/versions', label: 'Versions' },
  { href: '/timetable/substitutions', label: 'Substitutions' },
  { href: '/timetable/grid', label: 'Grid' },
] as const;

/** The timetable area's tabs, for `timetable.manage` holders; everyone else sees only the week. */
export function TimetableTabs() {
  const pathname = usePathname();
  const { can } = useCapabilities();
  if (!can(Capability.TIMETABLE_MANAGE)) return null;
  return (
    <nav aria-label="Timetable" className="mb-6 flex gap-1 overflow-x-auto border-b">
      {TABS.map(({ href, label }) => {
        const active = href === '/timetable' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A year's sections as one select, grouped by class; `allLabel` adds an "any section" option. */
export function SectionSelect({
  yearId,
  value,
  onChange,
  allLabel,
  label = 'Section',
  className = 'sm:w-56',
}: {
  yearId: string;
  value: string;
  onChange: (sectionId: string) => void;
  allLabel?: string;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const classes = useYearSections(yearId);
  return (
    <div className={cn('grid w-full gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} disabled={classes.isPending} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel ?? 'Choose a section'}</option>
        {(classes.data ?? []).map((klass) =>
          klass.sections.length === 0 ? null : (
            <optgroup key={klass.id} label={klass.name}>
              {klass.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {klass.name} {s.name}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </NativeSelect>
    </div>
  );
}

export type StaffOption = { id: string; fullName: string };

/** Every active member of staff, by name (every page): the teacher and substitute pickers. */
export function useActiveStaff() {
  return useQuery({
    queryKey: ['school', 'staff', 'options', 'active-all'],
    queryFn: async (): Promise<StaffOption[]> =>
      (
        await allPages((page) =>
          unwrap(
            staffApi.GET('/api/v1/staff', {
              params: { query: { status: 'active', page, limit: OPTIONS_LIMIT, sort: 'fullName' } },
            }),
          ),
        )
      ).map((s) => ({ id: s.id, fullName: s.fullName })),
  });
}
