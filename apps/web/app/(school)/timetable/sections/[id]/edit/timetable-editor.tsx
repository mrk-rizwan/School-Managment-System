'use client';

import {
  addDaysTo,
  ApiError,
  Capability,
  ErrorCode,
  newIdempotencyKey,
  TIMETABLE_ROOM_MAX,
} from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { BackLink, NoPermissionState, QueryStates, StateCard } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { academics, type ClassSubjectDto } from '@/lib/api/school-academics-contract';
import { timetableApi, type SectionTimetableDto } from '@/lib/api/school-timetable-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { academicsKeys } from '../../../../academics/_lib/academics-ui';
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from '../../../../settings/_lib/settings-ui';
import {
  cellKey,
  cellProblems,
  draftFromSlots,
  EMPTY_CELL,
  serverProblems,
  slotsFromDraft,
  type CellDraft,
  type CellProblems,
  type Draft,
  type OtherCell,
} from '../../../_lib/timetable-draft';
import {
  periodsOf,
  timetableErrorMessage,
  timetableKeys,
  useActiveStaff,
  weekHref,
  type StaffOption,
} from '../../../_lib/timetable-ui';

// contracts/slice-37.md §2.2, §7: the week-grid editor. Weekday × period cells, each with a
// subject of the class, a teacher and an optional room, prefilled from the version live today.
// Clashes are highlighted as the draft changes, by the shared `timetableClashes` against the
// other sections' timetables on the start date (GET /timetable/grid, one call per weekday); the
// API checks again and a refusal is shown on the cells it names. Saving creates a new version
// from the start date (one Idempotency-Key per opening of the editor).

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function TimetableEditor({ sectionId }: { sectionId: string }) {
  const { can } = useCapabilities();
  const today = todayInSchool();
  const week = useQuery({
    queryKey: timetableKeys.week(sectionId, today),
    queryFn: () =>
      unwrap(
        timetableApi.GET('/api/v1/sections/{id}/timetable', { params: { path: { id: sectionId }, query: { date: today } } }),
      ),
  });
  const liveVersionId = week.data?.days.find((d) => d.date === today)?.versionId ?? null;
  const live = useQuery({
    queryKey: timetableKeys.version(liveVersionId ?? ''),
    queryFn: () =>
      unwrap(timetableApi.GET('/api/v1/timetable-versions/{id}', { params: { path: { id: liveVersionId! } } })),
    enabled: liveVersionId !== null,
  });
  const classId = week.data?.section.classId ?? '';
  const subjects = useQuery({
    queryKey: [...academicsKeys.classSubjects(classId), { limit: OPTIONS_LIMIT, sort: 'sortOrder' }],
    queryFn: () =>
      unwrap(
        academics.GET('/api/v1/classes/{id}/subjects', {
          params: { path: { id: classId }, query: { limit: OPTIONS_LIMIT, sort: 'sortOrder' } },
        }),
      ),
    enabled: classId !== '',
  });
  const staff = useActiveStaff();

  const title = week.data ? `Edit timetable · ${week.data.section.className} ${week.data.section.name}` : 'Edit timetable';
  // One combined state for everything the form needs before it can be shown.
  const ready = {
    data:
      week.data && subjects.data && staff.data && (liveVersionId === null || live.data)
        ? { week: week.data, subjects: subjects.data.data, staff: staff.data }
        : undefined,
    isPending: week.isPending || (classId !== '' && subjects.isPending) || staff.isPending || (liveVersionId !== null && live.isPending),
    error: week.error ?? subjects.error ?? staff.error ?? live.error,
    refetch: () => {
      void week.refetch();
      void subjects.refetch();
      void staff.refetch();
      if (liveVersionId !== null) void live.refetch();
    },
  };

  return (
    <>
      <BackLink href={weekHref(sectionId)}>Timetable</BackLink>
      <PageHeader title={title} description="Each change is saved as a new version that starts on the date you choose." />
      {!can(Capability.TIMETABLE_MANAGE) ? (
        <StateCard>
          <NoPermissionState description="Only someone who manages the timetable can edit it." />
        </StateCard>
      ) : (
        <QueryStates
          query={ready}
          loadingRows={10}
          notFound={{ title: 'Section not found', description: 'It may have been archived.' }}
        >
          {({ week: w, subjects: s, staff: st }) => (
            <EditorForm
              key={liveVersionId ?? 'new'}
              week={w}
              subjects={s}
              staff={st}
              initialDraft={draftFromSlots(live.data?.slots ?? [])}
              // Today, unless the live version itself started today (void it first to redo today).
              initialFrom={liveVersionId === null || (live.data?.effectiveFrom ?? today) < today ? today : addDaysTo(today, 1)}
              liveFrom={live.data?.effectiveFrom ?? null}
            />
          )}
        </QueryStates>
      )}
    </>
  );
}

/** The other sections' slots on `date`, every weekday, and the school's weekly-off days. */
function useOthers(yearId: string, sectionId: string, date: string) {
  return useQuery({
    queryKey: timetableKeys.others(yearId, date),
    queryFn: async () => {
      const grids = await Promise.all(
        [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
          unwrap(timetableApi.GET('/api/v1/timetable/grid', { params: { query: { academicYearId: yearId, date, weekday } } })),
        ),
      );
      return {
        weeklyOffDays: grids[0]!.weeklyOffDays,
        sections: grids.flatMap((g) => g.sections),
      };
    },
    select: (data) => ({
      weeklyOffDays: data.weeklyOffDays,
      others: data.sections
        .filter((s) => s.sectionId !== sectionId)
        .flatMap((s) =>
          s.cells.map(
            (c): OtherCell => ({
              id: c.id,
              sectionId: s.sectionId,
              weekday: c.weekday,
              period: c.period,
              staffId: c.staffId,
              room: c.room,
              label: `${s.className} ${s.sectionName}`,
            }),
          ),
        ),
    }),
    enabled: DATE.test(date),
  });
}

function EditorForm({
  week,
  subjects,
  staff,
  initialDraft,
  initialFrom,
  liveFrom,
}: {
  week: SectionTimetableDto;
  subjects: ClassSubjectDto[];
  staff: StaffOption[];
  initialDraft: Draft;
  initialFrom: string;
  liveFrom: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const today = todayInSchool();
  const sectionId = week.section.id;
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [effectiveFrom, setEffectiveFrom] = useState(initialFrom);
  const [serverIssues, setServerIssues] = useState<CellProblems | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const others = useOthers(week.section.academicYearId, sectionId, effectiveFrom);
  const weeklyOffDays = useMemo(() => others.data?.weeklyOffDays ?? [], [others.data]);
  const problems = useMemo(
    () => cellProblems(draft, { periodsPerDay: week.periodsPerDay, weeklyOffDays, others: others.data?.others ?? [] }),
    [draft, week.periodsPerDay, weeklyOffDays, others.data],
  );
  const submitted = useMemo(() => slotsFromDraft(draft), [draft]);
  const dateValid = DATE.test(effectiveFrom) && effectiveFrom >= today;
  const problemCount = Object.keys(problems).length;
  const days = WEEKDAY_ORDER.filter(
    (w) => !weeklyOffDays.includes(w) || Object.keys(draft).some((k) => k.startsWith(`${w}:`)),
  );

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        timetableApi.POST('/api/v1/sections/{id}/timetable-versions', {
          params: { path: { id: sectionId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { effectiveFrom, slots: submitted.slots },
        }),
      ),
    onSuccess: (version) => {
      toast.success(`Timetable saved. It applies from ${formatDay(version.effectiveFrom)}.`);
      void queryClient.invalidateQueries({ queryKey: timetableKeys.all });
      router.push(weekHref(sectionId));
    },
    onError: (error) => {
      // A refused body will change before the next try: it gets a new key.
      if (error instanceof ApiError && error.status < 500) setIdempotencyKey(newIdempotencyKey());
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) {
        setRefusal('Something changed while saving. Try again.');
        return;
      }
      setServerIssues(serverProblems(error, submitted));
      setRefusal(timetableErrorMessage(error));
    },
  });

  const update = (key: string, change: Partial<CellDraft>) => {
    setDraft((current) => {
      const next = { ...(current[key] ?? EMPTY_CELL), ...change };
      const copy = { ...current };
      if (next.classSubjectId === '' && next.staffId === '' && next.room === '') delete copy[key];
      else copy[key] = next;
      return copy;
    });
    setServerIssues(null);
  };

  const dateId = useId();
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setRefusal(null);
        save.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1.5 sm:w-48">
          <Label htmlFor={dateId}>Starts on</Label>
          <Input
            id={dateId}
            type="date"
            min={today}
            value={effectiveFrom}
            aria-invalid={!dateValid || undefined}
            onChange={(e) => {
              setEffectiveFrom(e.target.value);
              setServerIssues(null);
            }}
          />
        </div>
        <p className="text-sm text-muted-foreground sm:pb-1.5">
          {liveFrom
            ? `Prefilled from the timetable in use since ${formatDay(liveFrom)}; it ends the day before the new one starts.`
            : 'This section has no timetable in use today.'}
        </p>
      </div>
      {!dateValid && <p className="text-sm text-destructive">The start date must be today or later.</p>}
      {others.error && (
        <Alert>
          <AlertDescription>
            The other sections’ timetables could not be loaded, so clashes with them are checked only when you save.
          </AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 px-4">Period</TableHead>
              {days.map((w) => (
                <TableHead key={w} className="min-w-44">
                  {WEEKDAY_LABELS[w]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {periodsOf(week.periodsPerDay).map((period) => (
              <TableRow key={period}>
                <TableCell className="px-4 align-top font-medium">{period}</TableCell>
                {days.map((w) => {
                  const key = cellKey(w, period);
                  return (
                    <TableCell key={w} className="align-top">
                      <EditorCell
                        weekday={w}
                        period={period}
                        cell={draft[key] ?? EMPTY_CELL}
                        problems={[...(problems[key] ?? []), ...(serverIssues?.[key] ?? [])]}
                        subjects={subjects}
                        staff={staff}
                        onChange={(change) => update(key, change)}
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {refusal && (
        <Alert variant="destructive">
          <AlertDescription data-testid="editor.refusal">{refusal}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {others.isFetching
            ? 'Checking the other sections…'
            : problemCount > 0
              ? `${problemCount} ${problemCount === 1 ? 'period needs' : 'periods need'} attention.`
              : `${submitted.slots.length} ${submitted.slots.length === 1 ? 'lesson' : 'lessons'} a week.`}
        </span>
        <Button type="submit" disabled={save.isPending || problemCount > 0 || submitted.slots.length === 0 || !dateValid}>
          {save.isPending ? 'Saving…' : 'Save timetable'}
        </Button>
      </div>
    </form>
  );
}

function EditorCell({
  weekday,
  period,
  cell,
  problems,
  subjects,
  staff,
  onChange,
}: {
  weekday: number;
  period: number;
  cell: CellDraft;
  problems: string[];
  subjects: ClassSubjectDto[];
  staff: StaffOption[];
  onChange: (change: Partial<CellDraft>) => void;
}) {
  const where = `${WEEKDAY_LABELS[weekday]} period ${period}`;
  const flagged = problems.length > 0;
  const errorId = useId();
  return (
    <div
      data-testid={`editor.cell.${weekday}.${period}`}
      data-problem={flagged ? 'true' : undefined}
      className={cn('grid gap-1 rounded-md p-1', flagged && 'bg-destructive/10 ring-1 ring-destructive')}
    >
      <NativeSelect
        aria-label={`Subject, ${where}`}
        value={cell.classSubjectId}
        aria-invalid={flagged || undefined}
        aria-describedby={flagged ? errorId : undefined}
        onChange={(e) => onChange({ classSubjectId: e.target.value })}
      >
        <option value="">No lesson</option>
        {subjects.map((s) => (
          <option key={s.id} value={s.id}>
            {s.subjectName}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label={`Teacher, ${where}`}
        value={cell.staffId}
        aria-invalid={flagged || undefined}
        onChange={(e) => onChange({ staffId: e.target.value })}
      >
        <option value="">Teacher</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.fullName}
          </option>
        ))}
      </NativeSelect>
      <Input
        aria-label={`Room, ${where}`}
        placeholder="Room (optional)"
        maxLength={TIMETABLE_ROOM_MAX}
        value={cell.room}
        onChange={(e) => onChange({ room: e.target.value })}
      />
      {flagged && (
        <ul id={errorId} className="grid gap-0.5 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
