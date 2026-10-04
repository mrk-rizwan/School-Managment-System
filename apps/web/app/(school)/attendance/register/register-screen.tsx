'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { attendanceApi } from '@/lib/api/school-attendance-contract';
import { todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../../students/_lib/placement';
import { AttendanceTabs } from '../_lib/attendance-nav';
import { attendanceKeys, mySections } from '../_lib/attendance-ui';
import { RegisterSheet } from './register-sheet';

// contracts/slice-11.md §13, "Register": the section (the caller's own from GET /me first, any
// other through the class pickers), the date (today by default, never the future) and, in period
// mode only, the period.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function RegisterScreen({
  initialSectionId,
  initialDate,
  initialPeriod,
}: {
  initialSectionId?: string;
  initialDate?: string;
  initialPeriod?: number;
}) {
  const today = todayInSchool();
  const me = useSchoolMe();
  const dateId = useId();
  const periodId = useId();
  const mine = mySections(me.data, today);
  const [sectionId, setSectionId] = useState(initialSectionId ?? '');
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const [date, setDate] = useState(initialDate && DATE.test(initialDate) && initialDate <= today ? initialDate : today);
  const [period, setPeriod] = useState(initialPeriod && initialPeriod >= 1 && initialPeriod <= 12 ? initialPeriod : 1);
  // With nothing chosen yet, a teacher with exactly one section starts on it.
  const chosen = sectionId || (mine.length === 1 ? mine[0].sectionId : '');
  const validDate = DATE.test(date) && date <= today;

  const view = useQuery({
    queryKey: attendanceKeys.register(chosen, date, period),
    queryFn: () =>
      unwrap(
        attendanceApi.GET('/api/v1/sections/{id}/register', {
          params: { path: { id: chosen }, query: { date, period } },
        }),
      ),
    enabled: chosen !== '' && validDate,
  });
  const data = view.data;
  // A section the caller is assigned to on another date is 403 not_assigned_on_date; one they
  // never teach, or that does not exist, is 404 (slice-11 §1.2, ruling 2026-10-04).
  const notAssignedOnDate =
    view.error instanceof ApiError && (view.error.details as { reason?: string } | null)?.reason === 'not_assigned_on_date';
  const periodMode = data?.section.attendanceMode === 'period';
  const periods = Math.max(data?.periodsPerDay ?? 1, period);

  return (
    <>
      <PageHeader
        title="Attendance register"
        description={
          data ? `${data.section.className} ${data.section.name}` : 'Choose a section and a date to take or read its register.'
        }
      />
      <AttendanceTabs />
      <div className="mb-6 grid gap-4">
        {mine.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Your sections">
            <span className="text-sm text-muted-foreground">Your sections:</span>
            {mine.map((s) => (
              <button
                key={s.sectionId}
                type="button"
                aria-pressed={chosen === s.sectionId}
                onClick={() => {
                  setSectionId(s.sectionId);
                  setPlacement(NO_PLACEMENT);
                  setPeriod(1);
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  chosen === s.sectionId ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted',
                )}
              >
                {s.className} {s.sectionName}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <PlacementSelects
            value={placement}
            compact
            onChange={(next) => {
              setPlacement(next);
              if (next.sectionId) {
                setSectionId(next.sectionId);
                setPeriod(1);
              }
            }}
          />
          <div className="grid w-full gap-1.5 sm:w-44">
            <Label htmlFor={dateId}>Date</Label>
            <Input id={dateId} type="date" max={today} value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          {periodMode && (
            <div className="grid w-full gap-1.5 sm:w-32">
              <Label htmlFor={periodId}>Period</Label>
              <NativeSelect id={periodId} value={String(period)} onChange={(event) => setPeriod(Number(event.target.value))}>
                {Array.from({ length: periods }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    Period {i + 1}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </div>
        {!validDate && <p className="text-sm text-destructive">Choose a date that is not in the future.</p>}
      </div>

      {chosen === '' ? (
        <StateCard>
          <EmptyState title="Choose a section" description="Pick one of your sections, or a class and section above." />
        </StateCard>
      ) : (
        validDate && (
          <QueryStates
            query={view}
            loadingRows={8}
            noPermission={notAssignedOnDate ? 'You were not assigned to this section on that date. Choose another date or section.' : undefined}
            notFound={{
              title: 'Not one of your registers',
              description: 'This section is not one you teach, or it does not exist. Choose another.',
            }}
          >
            {(register) => (
              <RegisterSheet
                // A fresh sheet for every register and every saved version of it.
                key={`${register.section.id}|${register.date}|${register.period}|${register.register?.submittedAt}|${register.register?.lastAmendedAt}|${register.roster.length}`}
                view={register}
              />
            )}
          </QueryStates>
        )
      )}
    </>
  );
}
