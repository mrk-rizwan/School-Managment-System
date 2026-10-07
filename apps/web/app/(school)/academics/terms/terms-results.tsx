'use client';

import { Capability, ErrorCode, PASS_RULES, type PassRule } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { CheckboxField } from '@/components/checkbox-field';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  academics,
  type AcademicYearDto,
  type ResultSettingsDto,
  type TermDto,
  type UpdateResultSettingsBody,
  type UpdateTermBody,
} from '@/lib/api/school-academics-contract';
import { formatDay } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import { academicsKeys, YEAR_STATUS_LABELS } from '../_lib/academics-ui';
import { useClasses, useYears } from '../_lib/options';
import { bandsSchema, toBandRows, toBands } from './_lib/bands';

// Academics → Terms and results (contracts/slice-29.md §2-§4, phase-4-academic.md slice 29): a
// year's terms with their weights and the classes each is not held for, and the year's result
// rules (weights, pass mark and rule, grade bands, report-card toggles).

const PASS_RULE_LABELS: Record<PassRule, string> = {
  all_subjects: 'Every assessed subject at or above the pass mark',
  overall: 'The overall percentage at or above the pass mark',
};

function defaultYear(years: AcademicYearDto[]): AcademicYearDto | undefined {
  return years.find((y) => y.status === 'active') ?? years[0];
}

export function TermsAndResults() {
  const years = useYears();
  const [chosenYearId, setChosenYearId] = useState('');
  return (
    <QueryStates query={years} loadingRows={4}>
      {({ data: yearList }) => {
        if (yearList.length === 0) {
          return (
            <StateCard>
              <EmptyState
                title="No academic years yet"
                description="Terms and result rules belong to an academic year. Create one first."
                action={
                  <Link href="/academics/years" className={buttonVariants({ variant: 'outline' })}>
                    Go to academic years
                  </Link>
                }
              />
            </StateCard>
          );
        }
        const year = yearList.find((y) => y.id === chosenYearId) ?? defaultYear(yearList)!;
        return (
          <div className="grid gap-6">
            <FilterSelect label="Academic year" value={year.id} onChange={setChosenYearId} className="sm:w-56">
              {yearList.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name} ({YEAR_STATUS_LABELS[y.status].toLowerCase()})
                </option>
              ))}
            </FilterSelect>
            <TermsCard key={`terms-${year.id}`} year={year} />
            <ResultSettingsCard key={`settings-${year.id}`} year={year} />
          </div>
        );
      }}
    </QueryStates>
  );
}

// ---------------------------------------------------------------------------------- terms

function TermsCard({ year }: { year: AcademicYearDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canDefine = can(Capability.ASSESSMENT_DEFINE) && year.status !== 'closed';
  const [editing, setEditing] = useState<TermDto | 'new' | null>(null);
  const [skipping, setSkipping] = useState<TermDto | null>(null);
  const [holding, setHolding] = useState<{ term: TermDto; classId: string; className: string } | null>(null);

  const query = { page: 1, limit: 50, sort: 'sortOrder' } as const;
  const terms = useQuery({
    queryKey: [...academicsKeys.terms(year.id), query],
    queryFn: () =>
      unwrap(academics.GET('/api/v1/academic-years/{id}/terms', { params: { path: { id: year.id }, query } })),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: academicsKeys.terms(year.id) });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, TermDto>();
    return [
      column.accessor('name', {
        header: 'Term',
        cell: (info) => <span className="font-medium">{info.getValue()}</span>,
      }),
      column.display({
        id: 'dates',
        header: 'Dates',
        cell: (info) => (
          <span className="tabular-nums">
            {formatDay(info.row.original.startsOn)} – {formatDay(info.row.original.endsOn)}
          </span>
        ),
      }),
      column.accessor('weight', {
        header: 'Weight in final result',
        cell: (info) => <span className="tabular-nums">{info.getValue()}%</span>,
      }),
      column.accessor('skippedClasses', {
        header: 'Not held for',
        cell: (info) => {
          const skipped = info.getValue();
          if (skipped.length === 0) return <span className="text-muted-foreground">Every class</span>;
          return (
            <span className="flex flex-wrap gap-1">
              {skipped.map((s) => (
                <Badge key={s.classId} variant="outline" title={s.reason}>
                  {s.className}
                </Badge>
              ))}
            </span>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const term = info.row.original;
          const actions: RowAction[] = canDefine
            ? [
                { label: 'Edit', onSelect: () => setEditing(term) },
                { label: 'Not held for a class…', onSelect: () => setSkipping(term) },
                ...term.skippedClasses.map((s) => ({
                  label: `Held for ${s.className} again`,
                  onSelect: () => setHolding({ term, classId: s.classId, className: s.className }),
                })),
              ]
            : [];
          return <RowActions label={`term ${term.name}`} actions={actions} />;
        },
      }),
    ];
  }, [canDefine]);

  const rows = terms.data?.data ?? [];
  const totalWeight = rows.reduce((sum, t) => sum + t.weight, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle>Terms</CardTitle>
          <CardDescription>
            Each term ends in an exam; its weight is its share of the final result. A term can be marked not held
            for a class (a nursery with no mid-term, say).
          </CardDescription>
        </div>
        {canDefine && (
          <Button onClick={() => setEditing('new')} disabled={rows.length >= 6}>
            <PlusIcon />
            Add term
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        <DataTable
          columns={columns}
          query={terms}
          getRowId={(row) => row.id}
          page={1}
          limit={50}
          onPageChange={() => undefined}
          emptyTitle="No terms"
          emptyDescription={canDefine ? 'Add the terms of this year.' : 'Terms added to this year appear here.'}
        />
        {rows.length > 0 && (
          <p className={totalWeight === 100 ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
            Term weights add up to {totalWeight}%
            {totalWeight === 100 ? '.' : '. Make them add up to 100% before the final result is composed.'}
          </p>
        )}
      </CardContent>
      <TermFormDialog yearId={year.id} term={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      {skipping && <SkipClassDialog year={year} term={skipping} onClose={() => setSkipping(null)} onDone={refresh} />}
      <HoldAgainDialog target={holding} onClose={() => setHolding(null)} onDone={refresh} />
    </Card>
  );
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.');
const termSchema = z
  .object({
    name: nameSchema(1, 40),
    startsOn: dateSchema,
    endsOn: dateSchema,
    weight: z
      .string()
      .trim()
      .refine((v) => v === '' || (/^\d{1,3}$/.test(v) && Number(v) <= 100), 'Enter a whole percent from 0 to 100.'),
  })
  .refine((v) => v.endsOn >= v.startsOn, { path: ['endsOn'], message: 'End on or after the start date.' });
type TermValues = z.infer<typeof termSchema>;
/** Editing a term: the weight is required (blank would otherwise be sent as no change). */
const editTermSchema = termSchema.refine((v) => v.weight !== '', {
  path: ['weight'],
  message: 'Enter a whole percent from 0 to 100.',
});

function TermFormDialog({
  yearId,
  term,
  onClose,
  onSaved,
}: {
  yearId: string;
  term: TermDto | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={term !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {term !== null && (
          <TermForm
            yearId={yearId}
            term={term === 'new' ? null : term}
            onDone={() => {
              onSaved();
              onClose();
            }}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TermForm({
  yearId,
  term,
  onDone,
  onCancel,
}: {
  yearId: string;
  term: TermDto | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const form = useForm<TermValues>({
    resolver: zodResolver(term ? editTermSchema : termSchema),
    defaultValues: {
      name: term?.name ?? '',
      startsOn: term?.startsOn ?? '',
      endsOn: term?.endsOn ?? '',
      weight: term ? String(term.weight) : '',
    },
  });
  const save = useMutation({
    mutationFn: (values: TermValues) => {
      const weight = values.weight === '' ? undefined : Number(values.weight);
      if (!term) {
        return unwrap(
          academics.POST('/api/v1/academic-years/{id}/terms', {
            params: { path: { id: yearId } },
            body: { name: values.name, startsOn: values.startsOn, endsOn: values.endsOn, ...(weight !== undefined && { weight }) },
          }),
        );
      }
      const body: UpdateTermBody = {
        ...(values.name !== term.name && { name: values.name }),
        ...(values.startsOn !== term.startsOn && { startsOn: values.startsOn }),
        ...(values.endsOn !== term.endsOn && { endsOn: values.endsOn }),
        ...(weight !== undefined && weight !== term.weight && { weight }),
      };
      return unwrap(academics.PATCH('/api/v1/terms/{id}', { params: { path: { id: term.id } }, body }));
    },
    onSuccess: (saved) => {
      toast.success(term ? `${saved.name} saved.` : `${saved.name} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const messages: Partial<Record<string, [keyof TermValues, string]>> = {
          [ErrorCode.TERM_NAME_TAKEN]: ['name', 'This year already has a term of that name.'],
          [ErrorCode.TERM_OVERLAPS]: ['startsOn', 'These dates overlap another term of the year.'],
          [ErrorCode.TERM_OUTSIDE_YEAR]: ['startsOn', 'A term must lie inside its academic year.'],
        };
        const hit = messages[error.code];
        if (hit) {
          form.setError(hit[0], { message: hit[1] }, { shouldFocus: true });
          return;
        }
      }
      applyApiError(form, error);
    },
  });
  // Read during render: react-hook-form tracks isDirty only once the proxy has been read, so a
  // first read inside the submit handler returned a stale false and an edit was never sent.
  const { isDirty } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => {
        if (term && !isDirty) return onCancel();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{term ? `Edit ${term.name}` : 'Add term'}</DialogTitle>
        <DialogDescription>Terms never overlap and lie inside the academic year.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="name" label="Name" hint="For example Mid-term or Annual." maxLength={40} autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="startsOn" label="Starts on" type="date" />
        <FormField control={form.control} name="endsOn" label="Ends on" type="date" />
      </div>
      <FormField
        control={form.control}
        name="weight"
        label={term ? 'Weight in final result (%)' : 'Weight in final result (%, optional)'}
        hint={term ? undefined : 'Left blank, the term takes what the other terms leave of 100%.'}
        type="number"
        inputMode="numeric"
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : term ? 'Save changes' : 'Add term'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SkipClassDialog({
  year,
  term,
  onClose,
  onDone,
}: {
  year: AcademicYearDto;
  term: TermDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const classes = useClasses(year.id);
  const [classId, setClassId] = useState('');
  const selectId = useId();
  const skipped = new Set(term.skippedClasses.map((s) => s.classId));
  const options = (classes.data?.data ?? []).filter((c) => !skipped.has(c.id));
  const skip = useMutation({
    mutationFn: (reason: string) =>
      unwrap(academics.POST('/api/v1/terms/{id}/skip-class', { params: { path: { id: term.id } }, body: { classId, reason } })),
    onSuccess: () => {
      toast.success(`${term.name} marked not held for the class.`);
      onDone();
      onClose();
    },
    onError: toastApiError,
  });
  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${term.name}: not held for a class`}
      description="The class gets no exam this term, and its final result is composed from the other terms."
      confirmLabel="Mark not held"
      minLength={3}
      pending={skip.isPending}
      confirmDisabled={classId === ''}
      onConfirm={(reason) => skip.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>Class</Label>
        <NativeSelect id={selectId} value={classId} onChange={(event) => setClassId(event.target.value)}>
          <option value="">Choose a class</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmWithReasonDialog>
  );
}

function HoldAgainDialog({
  target,
  onClose,
  onDone,
}: {
  target: { term: TermDto; classId: string; className: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const hold = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        academics.POST('/api/v1/terms/{id}/unskip-class', {
          params: { path: { id: target!.term.id } },
          body: { classId: target!.classId, reason },
        }),
      ),
    onSuccess: () => {
      toast.success(`${target?.term.name} is held for ${target?.className} again.`);
      onDone();
      onClose();
    },
    onError: toastApiError,
  });
  return (
    <ConfirmWithReasonDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={target ? `Hold ${target.term.name} for ${target.className}?` : ''}
      confirmLabel="Hold the term"
      minLength={3}
      pending={hold.isPending}
      onConfirm={(reason) => hold.mutate(reason)}
    />
  );
}

// ------------------------------------------------------------------------------ settings

const percent = (message: string) =>
  z.string().trim().refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 100, message);
const settingsSchema = z
  .object({
    testWeight: percent('Enter a whole percent from 0 to 100.'),
    examWeight: percent('Enter a whole percent from 0 to 100.'),
    passPercent: percent('Enter a whole percent from 0 to 100.'),
    passRule: z.enum(PASS_RULES),
    bands: bandsSchema,
    showPosition: z.boolean(),
    showAttendance: z.boolean(),
    showRemark: z.boolean(),
    withholdCardForDues: z.boolean(),
    notifyClassTests: z.boolean(),
  })
  .refine((v) => Number(v.testWeight) + Number(v.examWeight) === 100, {
    path: ['examWeight'],
    message: 'Class tests and the exam must add up to 100%.',
  });
type SettingsValues = z.infer<typeof settingsSchema>;

const TOGGLES = ['showPosition', 'showAttendance', 'showRemark', 'withholdCardForDues', 'notifyClassTests'] as const;

const toValues = (s: ResultSettingsDto): SettingsValues => ({
  testWeight: String(s.testWeight),
  examWeight: String(s.examWeight),
  passPercent: String(s.passPercent),
  passRule: s.passRule,
  bands: toBandRows(s.bands),
  showPosition: s.showPosition,
  showAttendance: s.showAttendance,
  showRemark: s.showRemark,
  withholdCardForDues: s.withholdCardForDues,
  notifyClassTests: s.notifyClassTests,
});

function ResultSettingsCard({ year }: { year: AcademicYearDto }) {
  const settings = useQuery({
    queryKey: academicsKeys.resultSettings(year.id),
    queryFn: () =>
      unwrap(academics.GET('/api/v1/academic-years/{id}/result-settings', { params: { path: { id: year.id } } })),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Result rules</CardTitle>
        <CardDescription>
          How a term result is composed, graded and passed, and what the report card shows. Frozen once a result
          sheet of the year is approved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={settings} loadingRows={6} notFound={{ title: 'No result rules', description: 'This year has no result rules yet.' }}>
          {(data) => <SettingsForm year={year} settings={data} />}
        </QueryStates>
      </CardContent>
    </Card>
  );
}

function SettingsForm({ year, settings }: { year: AcademicYearDto; settings: ResultSettingsDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const editable = can(Capability.ASSESSMENT_DEFINE) && year.status !== 'closed' && !settings.locked;
  const form = useForm<SettingsValues>({ resolver: zodResolver(settingsSchema), defaultValues: toValues(settings) });
  const bands = useFieldArray({ control: form.control, name: 'bands' });
  // Read during render: react-hook-form tracks isDirty and dirtyFields only once the proxy has been
  // read, and a field-array remove recomputes dirtyFields only while tracked, so removing a band
  // alone sent an empty PATCH.
  const { isDirty, dirtyFields } = form.formState;

  const save = useMutation({
    mutationFn: (values: SettingsValues) => {
      const next = { ...values, testWeight: Number(values.testWeight), examWeight: Number(values.examWeight), passPercent: Number(values.passPercent) };
      const body: UpdateResultSettingsBody = {
        ...(next.testWeight !== settings.testWeight && { testWeight: next.testWeight }),
        ...(next.examWeight !== settings.examWeight && { examWeight: next.examWeight }),
        ...(next.passPercent !== settings.passPercent && { passPercent: next.passPercent }),
        ...(next.passRule !== settings.passRule && { passRule: next.passRule }),
        ...(dirtyFields.bands && { bands: toBands(values.bands) }),
        ...Object.fromEntries(TOGGLES.filter((key) => next[key] !== settings[key]).map((key) => [key, next[key]])),
      };
      return unwrap(
        academics.PATCH('/api/v1/academic-years/{id}/result-settings', { params: { path: { id: year.id } }, body }),
      );
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(academicsKeys.resultSettings(year.id), saved);
      form.reset(toValues(saved));
      toast.success('Result rules saved.');
    },
    onError: (error) => applyApiError(form, error),
  });

  const bandsError = form.formState.errors.bands?.root?.message ?? form.formState.errors.bands?.message;

  return (
    <form
      noValidate
      className="grid gap-6"
      onSubmit={form.handleSubmit((values) => {
        if (!isDirty) return;
        save.mutate(values);
      })}
    >
      <FormRootError form={form} />
      <fieldset disabled={!editable || save.isPending} className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField control={form.control} name="testWeight" label="Class tests (%)" type="number" inputMode="numeric" />
          <FormField control={form.control} name="examWeight" label="Term exam (%)" type="number" inputMode="numeric" />
          <FormField control={form.control} name="passPercent" label="Pass mark (%)" type="number" inputMode="numeric" />
        </div>
        <FormField
          control={form.control}
          name="passRule"
          label="A student passes when"
          options={PASS_RULES.map((rule) => ({ value: rule, label: PASS_RULE_LABELS[rule] }))}
        />
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-4">
            <Label>Grade bands</Label>
            {editable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={bands.fields.length >= 12}
                onClick={() => bands.append({ grade: '', minPercent: '' })}
              >
                <PlusIcon />
                Add band
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Highest first. A percentage at or above a band&apos;s minimum earns its grade; the last band starts at 0.
          </p>
          <ol className="grid gap-2" aria-label="Grade bands">
            {bands.fields.map((field, index) => (
              <li key={field.id} className="flex items-center gap-2">
                <Input
                  aria-label={`Grade ${index + 1}`}
                  className="w-24"
                  maxLength={4}
                  {...form.register(`bands.${index}.grade`)}
                />
                <span className="text-sm text-muted-foreground">from</span>
                <Input
                  aria-label={`Minimum % for grade ${index + 1}`}
                  className="w-24"
                  type="number"
                  inputMode="numeric"
                  {...form.register(`bands.${index}.minPercent`)}
                />
                <span className="text-sm text-muted-foreground">%</span>
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove grade ${index + 1}`}
                    disabled={bands.fields.length === 1}
                    onClick={() => bands.remove(index)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {bandsError && (
            <p role="alert" className="text-sm text-destructive">
              {bandsError}
            </p>
          )}
        </div>
        <div className="grid gap-4">
          <CheckboxField control={form.control} name="showPosition" label="Show position in class" hint="Ties share a position (1, 1, 3)." />
          <CheckboxField control={form.control} name="showAttendance" label="Show attendance" hint="The term's attendance percentage." />
          <CheckboxField control={form.control} name="showRemark" label="Show the class teacher's remark" hint="Written on the result sheet before submission." />
          <CheckboxField
            control={form.control}
            name="withholdCardForDues"
            label="Withhold the report card until dues are cleared"
            hint="The family still gets the result message; the principal may override."
          />
          <CheckboxField
            control={form.control}
            name="notifyClassTests"
            label="Tell families when a class test is marked"
            hint="By the app only, never SMS. Marks are visible in the app either way."
          />
        </div>
      </fieldset>
      {editable && (
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending || !isDirty}>
            {save.isPending ? 'Saving…' : 'Save result rules'}
          </Button>
        </div>
      )}
      {!editable && (
        <p className="text-sm text-muted-foreground">
          {settings.locked
            ? 'A result sheet of this year is approved: these rules are frozen.'
            : year.status === 'closed'
              ? `${year.name} is closed.`
              : 'Only the principal (or a holder of assessment set-up) changes these rules.'}
        </p>
      )}
    </form>
  );
}
