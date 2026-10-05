'use client';

import {
  Capability,
  ErrorCode,
  FEE_FREQUENCY_LABELS,
  formatRupees,
  newIdempotencyKey,
  yearMonthOf,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { TablePagination } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
  QueryStates,
  StateCard,
  isPermissionDenied,
} from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import type { AcademicYearDto } from '@/lib/api/school-academics-contract';
import {
  feesApi,
  type FeeHeadDto,
  type FeeStructureClassDto,
  type FeeStructureExists,
  type FeeStructureHeadDto,
  type FeeStructureListQuery,
  type FeeStructureNotLater,
} from '@/lib/api/school-fees-contract';
import { formatDate, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { useYears } from '../../academics/_lib/options';
import { YearStatusBadge } from '../../academics/_lib/academics-ui';
import { digitsOnly, feesKeys, formatMonth, rupeesSchema, yearMonthSchema } from '../_lib/fees-ui';

const LIMIT = 25;

/** The heads the grid shows as columns: the ones a class is charged on a schedule (§ slice 18). */
const GRID_FREQUENCIES = new Set<FeeHeadDto['frequency']>(['monthly', 'yearly', 'once']);

/** The first and last month of an academic year. */
const monthsOf = (year: AcademicYearDto) => ({ first: yearMonthOf(year.startsOn), last: yearMonthOf(year.endsOn) });

/** This month, moved inside the year. */
function defaultMonth(year: AcademicYearDto): string {
  const { first, last } = monthsOf(year);
  const now = yearMonthOf(todayInSchool());
  return now < first ? first : now > last ? last : now;
}

/** One cell of the grid: a class and a head, with the amount set now, if any. */
type Target = { cls: FeeStructureClassDto; head: FeeHeadDto; current: FeeStructureHeadDto | undefined };
type AmountValues = { amount: number; effectiveFrom: string };

/** Fee structure (slice 18, R177): per year, the amount each class pays for each head. */
export function FeeStructureGrid() {
  const years = useYears();
  const [chosen, setChosen] = useState('');

  return (
    <QueryStates query={years} loadingRows={6}>
      {({ data }) => {
        if (data.length === 0) {
          return (
            <StateCard>
              <EmptyState
                title="No academic years yet"
                description="Fees are set per class for an academic year. Create the year and its classes first."
                action={
                  <Link href="/academics/years" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    Academic years
                  </Link>
                }
              />
            </StateCard>
          );
        }
        const year =
          data.find((y) => y.id === chosen) ?? data.find((y) => y.status === 'active') ?? data[0];
        return <YearGrid key={year.id} year={year} years={data} onYearChange={setChosen} />;
      }}
    </QueryStates>
  );
}

function YearGrid({
  year,
  years,
  onYearChange,
}: {
  year: AcademicYearDto;
  years: AcademicYearDto[];
  onYearChange: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canManage = can(Capability.FEE_HEAD_MANAGE);
  const writable = canManage && year.status !== 'closed';
  const [page, setPage] = useListPage([year.id]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [setting, setSetting] = useState<Target | null>(null);
  const [replacing, setReplacing] = useState<{ target: Target; values: AmountValues; key: string } | null>(null);
  const [copying, setCopying] = useState(false);

  const headsQuery = { status: 'active', limit: OPTIONS_LIMIT, sort: 'name' } as const;
  const heads = useQuery({
    queryKey: [...feesKeys.heads, 'options'],
    queryFn: () => unwrap(feesApi.GET('/api/v1/fee-heads', { params: { query: headsQuery } })),
  });
  const query: FeeStructureListQuery = { academicYearId: year.id, page, limit: LIMIT };
  const structures = useQuery({
    queryKey: [...feesKeys.structures, query],
    queryFn: () => unwrap(feesApi.GET('/api/v1/fee-structures', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const replace = useMutation({
    mutationFn: ({ target, values, key, reason }: NonNullable<typeof replacing> & { reason: string }) =>
      unwrap(
        feesApi.POST('/api/v1/fee-structures', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            academicYearId: year.id,
            classId: target.cls.classId,
            feeHeadId: target.head.id,
            ...values,
            reason,
          },
        }),
      ),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.structures });
      toast.success(`${saved.feeHeadName} replaced from ${formatMonth(saved.effectiveFrom)}.`);
      setReplacing(null);
    },
    onError: (error) => {
      toastApiError(error);
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: feesKeys.structures });
        setReplacing(null);
      }
    },
  });

  const toggle = (classId: string) => {
    const next = new Set(expanded);
    if (next.has(classId)) next.delete(classId);
    else next.add(classId);
    setExpanded(next);
  };

  const columns = (heads.data?.data ?? []).filter((head) => GRID_FREQUENCIES.has(head.frequency));

  let body: React.ReactNode;
  const error = heads.error ?? structures.error;
  if (error) {
    body = isPermissionDenied(error) ? (
      <NoPermissionState />
    ) : (
      <ErrorState
        error={error}
        onRetry={() => {
          void heads.refetch();
          void structures.refetch();
        }}
      />
    );
  } else if (heads.isPending || structures.isPending || !structures.data) {
    body = <LoadingState rows={6} />;
  } else if (structures.data.total === 0) {
    body = (
      <EmptyState
        title="No classes in this year"
        description="Add the year’s classes under Academic structure, then set their fees here."
      />
    );
  } else if (columns.length === 0) {
    body = (
      <EmptyState
        title="No fee heads to set"
        description="Add a monthly, yearly or one-time fee head first."
        action={
          <Link href="/fees/heads" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Fee heads
          </Link>
        }
      />
    );
  } else {
    const result = structures.data;
    const loading = structures.isPlaceholderData;
    body = (
      <>
        <Table aria-busy={loading} aria-label={`Fee structure ${year.name}`}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4 text-muted-foreground">Class</TableHead>
              {columns.map((head) => (
                <TableHead key={head.id} className="px-4 text-muted-foreground">
                  <span className="block">{head.name}</span>
                  <span className="block text-xs font-normal">{FEE_FREQUENCY_LABELS[head.frequency]}</span>
                </TableHead>
              ))}
              <TableHead className="px-4 text-muted-foreground">
                <span className="sr-only">History</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((cls) => {
              const open = expanded.has(cls.classId);
              return (
                <Fragment key={cls.classId}>
                  <TableRow>
                    <TableCell className="px-4 font-medium">{cls.className}</TableCell>
                    {columns.map((head) => {
                      const current = cls.heads.find((h) => h.feeHeadId === head.id);
                      return (
                        <TableCell key={head.id} className="px-2">
                          <AmountCell
                            className={cls.className}
                            head={head}
                            current={current}
                            onSet={writable ? () => setSetting({ cls, head, current }) : undefined}
                          />
                        </TableCell>
                      );
                    })}
                    <TableCell className="px-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={open}
                        aria-controls={`history-${cls.classId}`}
                        disabled={cls.history.length === 0}
                        onClick={() => toggle(cls.classId)}
                      >
                        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                        History
                        <span className="sr-only"> of {cls.className}</span>
                        {cls.history.length > 0 && ` (${cls.history.length})`}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {open && (
                    <TableRow id={`history-${cls.classId}`} className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={columns.length + 2} className="px-4 py-3">
                        <HistoryList cls={cls} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        <TablePagination
          page={result.page}
          limit={result.limit}
          total={result.total}
          loading={loading}
          onPageChange={setPage}
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect label="Academic year" value={year.id} onChange={onYearChange} className="sm:w-48">
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </FilterSelect>
          <div className="flex h-8 items-center">
            <YearStatusBadge status={year.status} />
          </div>
        </div>
        {writable && years.length > 1 && (
          <Button variant="outline" onClick={() => setCopying(true)}>
            <CopyIcon />
            Copy from another year
          </Button>
        )}
      </div>
      {canManage && year.status === 'closed' && (
        <p className="mb-4 text-sm text-muted-foreground">This year is closed: its amounts can no longer change.</p>
      )}
      <div className="overflow-hidden rounded-lg border bg-card">{body}</div>

      <Dialog open={setting !== null} onOpenChange={(next) => !next && setSetting(null)}>
        <DialogContent>
          {setting && (
            <SetAmountForm
              target={setting}
              year={year}
              onDone={() => setSetting(null)}
              onExists={(values) => {
                setSetting(null);
                // The body changes (a reason is added), so the retry carries a fresh key.
                setReplacing({ target: setting, values, key: newIdempotencyKey() });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={replacing !== null}
        onOpenChange={(next) => !next && setReplacing(null)}
        title={replacing ? `Replace the amount for ${formatMonth(replacing.values.effectiveFrom)}` : ''}
        description={
          replacing
            ? `${replacing.target.cls.className} already has a ${replacing.target.head.name} amount from ${formatMonth(replacing.values.effectiveFrom)}. The new amount, ${formatRupees(replacing.values.amount)}, replaces it; the old one stays in the history with your reason.`
            : undefined
        }
        confirmLabel="Replace amount"
        minLength={3}
        maxLength={500}
        pending={replace.isPending}
        onConfirm={(reason) => replacing && replace.mutate({ ...replacing, reason })}
      />
      <Dialog open={copying} onOpenChange={setCopying}>
        <DialogContent>
          {copying && <CopyForm year={year} years={years} onDone={() => setCopying(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AmountCell({
  className,
  head,
  current,
  onSet,
}: {
  className: string;
  head: FeeHeadDto;
  current: FeeStructureHeadDto | undefined;
  onSet: (() => void) | undefined;
}) {
  const content = current ? (
    <>
      <span className="block font-medium tabular-nums">{formatRupees(current.amount)}</span>
      <span className="block text-xs text-muted-foreground">from {formatMonth(current.effectiveFrom)}</span>
    </>
  ) : (
    <span className="text-muted-foreground">{onSet ? 'Set amount' : '—'}</span>
  );
  if (!onSet) return <div className="px-2 py-1">{content}</div>;
  return (
    <button
      type="button"
      onClick={onSet}
      aria-label={
        current
          ? `${className}, ${head.name}: ${formatRupees(current.amount)} from ${formatMonth(current.effectiveFrom)}. Change`
          : `${className}, ${head.name}: not set. Set amount`
      }
      className="w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {content}
    </button>
  );
}

function HistoryList({ cls }: { cls: FeeStructureClassDto }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">History of {cls.className}</p>
      <ul className="grid gap-1.5 text-sm">
        {cls.history.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-medium">{row.feeHeadName}</span>
            <span className="tabular-nums">{formatRupees(row.amount)}</span>
            <span className="text-muted-foreground">from {formatMonth(row.effectiveFrom)}</span>
            {row.status === 'superseded' && <Badge variant="outline">Replaced</Badge>}
            {row.reason && <span className="text-muted-foreground">“{row.reason}”</span>}
            <span className="text-xs text-muted-foreground">set {formatDate(row.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Set an amount ----

const amountSchema = z.object({ amount: rupeesSchema, effectiveFrom: yearMonthSchema });
type AmountForm = z.infer<typeof amountSchema>;

function SetAmountForm({
  target,
  year,
  onDone,
  onExists,
}: {
  target: Target;
  year: AcademicYearDto;
  onDone: () => void;
  onExists: (values: AmountValues) => void;
}) {
  const queryClient = useQueryClient();
  // One key per opening of the dialog: a retried request is answered from the first one.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const { first, last } = monthsOf(year);
  const form = useForm<AmountForm>({
    resolver: zodResolver(amountSchema),
    defaultValues: { amount: target.current ? String(target.current.amount) : '', effectiveFrom: defaultMonth(year) },
  });

  const save = useMutation({
    mutationFn: (values: AmountValues) =>
      unwrap(
        feesApi.POST('/api/v1/fee-structures', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { academicYearId: year.id, classId: target.cls.classId, feeHeadId: target.head.id, ...values },
        }),
      ),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.structures });
      toast.success(`${target.cls.className}: ${saved.feeHeadName} set from ${formatMonth(saved.effectiveFrom)}.`);
      onDone();
    },
    onError: (error, values) => {
      if (!(error instanceof ApiError)) return applyApiError(form, error);
      switch (error.code) {
        case ErrorCode.FEE_STRUCTURE_EXISTS:
          if ((error.details as Partial<FeeStructureExists> | null)?.structureId) return onExists(values);
          break;
        case ErrorCode.FEE_STRUCTURE_NOT_LATER: {
          const latest = (error.details as Partial<FeeStructureNotLater> | null)?.latestEffectiveFrom;
          const message = latest
            ? `Pick a month after ${formatMonth(latest)}, the latest month already set.`
            : error.message;
          form.setError('effectiveFrom', { message }, { shouldFocus: true });
          return;
        }
        case ErrorCode.IDEMPOTENCY_KEY_REUSED:
          setIdempotencyKey(newIdempotencyKey());
          break;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    if (v.effectiveFrom < first || v.effectiveFrom > last) {
      return form.setError('effectiveFrom', {
        message: `Pick a month from ${formatMonth(first)} to ${formatMonth(last)}.`,
      });
    }
    save.mutate({ amount: Number(v.amount), effectiveFrom: v.effectiveFrom });
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>
          {target.cls.className}: {target.head.name}
        </DialogTitle>
        <DialogDescription>
          {target.current
            ? `Now ${formatRupees(target.current.amount)} from ${formatMonth(target.current.effectiveFrom)}. A new amount applies from the month you pick.`
            : `${FEE_FREQUENCY_LABELS[target.head.frequency]} fee for ${year.name}. Whole rupees.`}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="amount"
          label="Amount (Rs)"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          format={digitsOnly}
          autoFocus
        />
        <FormField
          control={form.control}
          name="effectiveFrom"
          label="From month"
          type="month"
          hint={`Within ${year.name}: ${formatMonth(first)} to ${formatMonth(last)}.`}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Set amount'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Copy from another year ----

const copySchema = z.object({
  fromAcademicYearId: z.string().min(1, 'Pick the year to copy from.'),
  effectiveFrom: yearMonthSchema,
});
type CopyValues = z.infer<typeof copySchema>;

function CopyForm({ year, years, onDone }: { year: AcademicYearDto; years: AcademicYearDto[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const others = years.filter((y) => y.id !== year.id);
  const { first, last } = monthsOf(year);
  const form = useForm<CopyValues>({
    resolver: zodResolver(copySchema),
    defaultValues: { fromAcademicYearId: others[0]?.id ?? '', effectiveFrom: first },
  });

  const copy = useMutation({
    mutationFn: (values: CopyValues) =>
      unwrap(feesApi.POST('/api/v1/fee-structures/copy', { body: { ...values, toAcademicYearId: year.id } })),
    onSuccess: ({ created, skipped }) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.structures });
      const copied = created === 1 ? '1 amount copied' : `${created} amounts copied`;
      toast.success(skipped > 0 ? `${copied}; ${skipped} already set were left as they are.` : `${copied}.`);
      onDone();
    },
    onError: (error) => applyApiError(form, error),
  });

  const onSubmit = form.handleSubmit((v) => {
    if (v.effectiveFrom < first || v.effectiveFrom > last) {
      return form.setError('effectiveFrom', {
        message: `Pick a month from ${formatMonth(first)} to ${formatMonth(last)}.`,
      });
    }
    copy.mutate(v);
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>Copy fees into {year.name}</DialogTitle>
        <DialogDescription>
          Each class takes the current amounts of the class with the same name in the other year. A class and
          head that already have an amount here are left untouched.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField
        control={form.control}
        name="fromAcademicYearId"
        label="Copy from"
        options={others.map((y) => ({ value: y.id, label: y.name }))}
      />
      <FormField
        control={form.control}
        name="effectiveFrom"
        label="From month"
        type="month"
        hint={`The copied amounts apply from this month of ${year.name}.`}
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={copy.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={copy.isPending}>
          {copy.isPending ? 'Copying…' : 'Copy amounts'}
        </Button>
      </DialogFooter>
    </form>
  );
}
