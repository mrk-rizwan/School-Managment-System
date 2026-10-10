'use client';

import { addDaysTo, newIdempotencyKey } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, RowActions } from '@/components/data-table';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import {
  timetableApi,
  type TimetableSubstitutionDto,
  type TimetableSubstitutionListQuery,
} from '@/lib/api/school-timetable-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useYearSections } from '../../academics/_lib/options';
import { useDefaultYearId, YearFilter } from '../../reports/_lib/reports-ui';
import { SectionSelect, timetableErrorMessage, timetableKeys, useActiveStaff } from '../_lib/timetable-ui';

// contracts/slice-37.md §2.4, §7: substitutions in a date range (at most 92 days, the API's
// bound), voided ones on request; create (one Idempotency-Key per opened form) and void.

const LIMIT = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function SubstitutionList() {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const [sectionId, setSectionId] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysTo(today, 30));
  const [includeVoided, setIncludeVoided] = useState(false);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<TimetableSubstitutionDto | null>(null);
  const [page, setPage] = useListPage([sectionId, from, to, includeVoided]);
  const rangeValid = DATE.test(from) && DATE.test(to) && from <= to && to <= addDaysTo(from, 92);

  const query: TimetableSubstitutionListQuery = {
    page,
    limit: LIMIT,
    from,
    to,
    ...(sectionId && { sectionId }),
    ...(includeVoided && { includeVoided: true }),
  };
  const substitutions = useQuery({
    queryKey: timetableKeys.substitutions(query),
    queryFn: () => unwrap(timetableApi.GET('/api/v1/timetable-substitutions', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: rangeValid,
  });

  const voidSubstitution = useMutation({
    mutationFn: ({ s, reason }: { s: TimetableSubstitutionDto; reason: string }) =>
      unwrap(
        timetableApi.POST('/api/v1/timetable-substitutions/{id}/void', { params: { path: { id: s.id } }, body: { reason } }),
      ),
    onSuccess: () => toast.success('Substitution voided.'),
    onError: (error) => toast.error(timetableErrorMessage(error)),
    onSettled: () => {
      setVoiding(null);
      void queryClient.invalidateQueries({ queryKey: timetableKeys.all });
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, TimetableSubstitutionDto>();
    return [
      column.accessor('date', {
        header: 'Date',
        cell: (info) => (
          <span className="grid">
            <span className="whitespace-nowrap">{formatDay(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">Period {info.row.original.period}</span>
          </span>
        ),
      }),
      column.accessor('sectionName', {
        header: 'Section',
        cell: (info) => (
          <span className="grid">
            <span className="font-medium">
              {info.row.original.className} {info.getValue()}
            </span>
            {info.row.original.subjectName && (
              <span className="text-xs text-muted-foreground">{info.row.original.subjectName}</span>
            )}
          </span>
        ),
      }),
      column.accessor('teacherName', {
        header: 'Substitute',
        cell: (info) => (
          <span className="grid">
            <span>{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">
              for {info.row.original.regularTeacherName ?? 'no timetabled teacher'}
            </span>
          </span>
        ),
      }),
      column.accessor('reason', {
        header: 'Reason',
        cell: (info) => (
          <span className="grid gap-0.5">
            <span>{info.getValue()}</span>
            {info.row.original.voidedAt && (
              <span className="flex flex-wrap items-center gap-1">
                <Badge variant="destructive">Voided</Badge>
                <span className="text-xs text-muted-foreground">{info.row.original.voidReason}</span>
              </span>
            )}
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) =>
          info.row.original.voidedAt === null ? (
            <RowActions
              label={`substitution on ${info.row.original.date} period ${info.row.original.period}`}
              actions={[{ label: 'Void', onSelect: () => setVoiding(info.row.original), destructive: true }]}
            />
          ) : null,
      }),
    ];
  }, []);

  const fromId = useId();
  const toId = useId();
  const voidedId = useId();
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <YearFilter
            value={yearId}
            onChange={(id) => {
              setChosenYear(id);
              setSectionId('');
            }}
          />
          <SectionSelect yearId={yearId} value={sectionId} onChange={setSectionId} allLabel="All sections" />
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={fromId}>From</Label>
            <Input id={fromId} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={toId}>To</Label>
            <Input id={toId} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 pb-1.5">
            <input
              id={voidedId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={includeVoided}
              onChange={(e) => setIncludeVoided(e.target.checked)}
            />
            <Label htmlFor={voidedId}>Show voided</Label>
          </div>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden />
          Add substitution
        </Button>
      </div>
      {!rangeValid && (
        <p className="mb-4 text-sm text-destructive">Choose a range of at most 92 days, the start not after the end.</p>
      )}
      <DataTable
        columns={columns}
        query={substitutions}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No substitutions"
        emptyDescription="Substitutions in this range appear here, newest first."
      />
      <Dialog open={creating} onOpenChange={(open) => (open ? undefined : setCreating(false))}>
        <DialogContent>
          {creating && <SubstitutionForm yearId={yearId} initialSectionId={sectionId} onDone={() => setCreating(false)} />}
        </DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => (open ? undefined : setVoiding(null))}
        title="Void this substitution?"
        description={
          voiding
            ? `${voiding.teacherName} for ${voiding.className} ${voiding.sectionName}, ${formatDay(voiding.date)} period ${voiding.period}. The regular teacher takes the period again.`
            : undefined
        }
        confirmLabel="Void substitution"
        minLength={3}
        destructive
        pending={voidSubstitution.isPending}
        onConfirm={(reason) => voiding && voidSubstitution.mutate({ s: voiding, reason })}
      />
    </>
  );
}

const substitutionSchema = z.object({
  sectionId: z.string().min(1, 'Choose a section.'),
  date: z.string().regex(DATE, 'Choose a date.'),
  period: z.string().min(1, 'Choose a period.'),
  staffId: z.string().min(1, 'Choose the substitute.'),
  reason: z.string().trim().min(3, 'At least 3 characters.').max(500),
});
type SubstitutionValues = z.infer<typeof substitutionSchema>;

function SubstitutionForm({
  yearId,
  initialSectionId,
  onDone,
}: {
  yearId: string;
  initialSectionId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  // One key per opened form: a retried save is a replay, never a second substitution.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const form = useForm<SubstitutionValues>({
    resolver: zodResolver(substitutionSchema),
    defaultValues: { sectionId: initialSectionId, date: todayInSchool(), period: '', staffId: '', reason: '' },
  });
  const [sectionId, date] = useWatch({ control: form.control, name: ['sectionId', 'date'] });
  const classes = useYearSections(yearId);
  const staff = useActiveStaff();
  // The section's lessons on the date, so the period is picked by what is timetabled.
  const day = useQuery({
    queryKey: timetableKeys.week(sectionId, date),
    queryFn: () =>
      unwrap(timetableApi.GET('/api/v1/sections/{id}/timetable', { params: { path: { id: sectionId }, query: { date } } })),
    enabled: sectionId !== '' && DATE.test(date),
    select: (week) => week.days.find((d) => d.date === date) ?? null,
  });
  const sectionOptions = [
    { value: '', label: 'Choose a section' },
    ...(classes.data ?? []).flatMap((k) => k.sections.map((s) => ({ value: s.id, label: `${k.name} ${s.name}` }))),
  ];
  const lessons = day.data?.slots ?? [];
  const periodOptions = [
    { value: '', label: lessons.length === 0 ? 'No lessons that day' : 'Choose a period' },
    ...lessons.map((s) => ({ value: String(s.period), label: `Period ${s.period} · ${s.subjectName} (${s.teacherName})` })),
  ];
  const staffOptions = [
    { value: '', label: 'Choose the substitute' },
    ...(staff.data ?? []).map((s) => ({ value: s.id, label: s.fullName })),
  ];

  const save = useMutation({
    mutationFn: (values: SubstitutionValues) =>
      unwrap(
        timetableApi.POST('/api/v1/sections/{id}/timetable-substitutions', {
          params: { path: { id: values.sectionId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { date: values.date, period: Number(values.period), staffId: values.staffId, reason: values.reason },
        }),
      ),
    onSuccess: (s) => {
      toast.success(`${s.teacherName} substitutes in ${s.className} ${s.sectionName}, period ${s.period}.`);
      void queryClient.invalidateQueries({ queryKey: timetableKeys.all });
      onDone();
    },
    onError: (error) => {
      setIdempotencyKey(newIdempotencyKey());
      if (!applyApiFieldErrors(form, error)) form.setError('root.server', { message: timetableErrorMessage(error) });
    },
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => save.mutate(values))}>
      <DialogHeader>
        <DialogTitle>Add substitution</DialogTitle>
        <DialogDescription>A substitute takes one timetabled period on one date. They need no assignment.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="sectionId" label="Section" options={sectionOptions} />
        <FormField control={form.control} name="date" label="Date" type="date" />
      </div>
      <FormField
        control={form.control}
        name="period"
        label="Period"
        options={periodOptions}
        disabled={sectionId === '' || day.isFetching}
      />
      <FormField control={form.control} name="staffId" label="Substitute" options={staffOptions} />
      <FormField control={form.control} name="reason" label="Reason" maxLength={500} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Add substitution'}
        </Button>
      </DialogFooter>
    </form>
  );
}
