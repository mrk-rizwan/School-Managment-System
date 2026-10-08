'use client';

import Link from 'next/link';
import { ACADEMIC_YEAR_STATUSES, Capability, ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  DataTable,
  type DataTableFeatures,
  type RowAction,
  RowActions,
  SortHeader,
} from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError, toastApiError } from '@/lib/api/errors';
import {
  academics,
  type AcademicYearDto,
  type AcademicYearListQuery,
  type AcademicYearSort,
  type AcademicYearStatus,
  type UpdateAcademicYearBody,
} from '@/lib/api/school-academics-contract';
import { formatDay } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import { academicsKeys, YEAR_STATUS_LABELS, YearStatusBadge } from '../_lib/academics-ui';

const LIMIT = 25;

/** contracts/slice-3.md §2: several years may be active at once; closed is final. */
export function AcademicYears() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canManage = can(Capability.ACADEMIC_YEAR_MANAGE);
  const [status, setStatus] = useState<AcademicYearStatus | ''>('');
  const [sort, setSort] = useState<AcademicYearSort>('-startsOn');
  // null: closed; 'new': create; a year: edit.
  const [editing, setEditing] = useState<AcademicYearDto | 'new' | null>(null);
  const [closing, setClosing] = useState<AcademicYearDto | null>(null);

  const [page, setPage] = useListPage([status, sort]);

  const query: AcademicYearListQuery = { page, limit: LIMIT, sort, ...(status && { status }) };
  const years = useQuery({
    queryKey: [...academicsKeys.years, 'list', query],
    queryFn: () => unwrap(academics.GET('/api/v1/academic-years', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const { mutate: activate } = useMutation({
    mutationFn: (year: AcademicYearDto) =>
      unwrap(
        academics.POST('/api/v1/academic-years/{id}/activate', {
          params: { path: { id: year.id } },
        }),
      ),
    onSuccess: (year) => toast.success(`${year.name} is now active.`),
    onError: toastApiError,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: academicsKeys.all }),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, AcademicYearDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Name" sort={sort} onSort={setSort} />,
        cell: (info) => <span className="font-medium">{info.getValue()}</span>,
      }),
      column.accessor('startsOn', {
        header: () => <SortHeader field="startsOn" label="Starts" sort={sort} onSort={setSort} />,
        cell: (info) => formatDay(info.getValue()),
      }),
      column.accessor('endsOn', { header: 'Ends', cell: (info) => formatDay(info.getValue()) }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <YearStatusBadge status={info.getValue()} />,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const year = info.row.original;
          const actions: RowAction[] = [];
          if (canManage && year.status !== 'closed') {
            actions.push({ label: 'Edit', onSelect: () => setEditing(year) });
            if (year.status === 'planned') {
              actions.push({ label: 'Activate', onSelect: () => activate(year) });
            }
            actions.push({ label: 'Close year', onSelect: () => setClosing(year), destructive: true });
          }
          return <RowActions label={year.name} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage, activate]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <FilterSelect label="Status" value={status} onChange={setStatus} className="sm:w-44">
          <option value="">All statuses</option>
          {ACADEMIC_YEAR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {YEAR_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        {canManage && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            New academic year
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={years}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status ? 'No academic years match' : 'No academic years yet'}
        emptyDescription={
          status
            ? 'Try a different status.'
            : 'Create a session, such as 2026-27, then add its classes.'
        }
      />
      <YearFormDialog year={editing} onClose={() => setEditing(null)} />
      <CloseYearDialog year={closing} onClose={() => setClosing(null)} />
    </>
  );
}

// ---- Create and edit (§2.3, §2.4) ----

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 731;
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date.');

const yearSchema = z
  .object({ name: nameSchema(2, 50), startsOn: isoDate, endsOn: isoDate })
  .superRefine(({ startsOn, endsOn }, ctx) => {
    const span = (Date.parse(endsOn) - Date.parse(startsOn)) / DAY_MS;
    if (span <= 0) {
      ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'End after the start date.' });
    } else if (span > MAX_SPAN_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: `A session can span at most ${MAX_SPAN_DAYS} days.`,
      });
    }
  });
type YearValues = z.infer<typeof yearSchema>;

function YearFormDialog({
  year,
  onClose,
}: {
  year: AcademicYearDto | 'new' | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={year !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {/* Mounted only while open, so the form starts from the row's values every time. */}
        {year !== null && <YearForm year={year === 'new' ? null : year} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function YearForm({ year, onDone }: { year: AcademicYearDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<YearValues>({
    resolver: zodResolver(yearSchema),
    defaultValues: {
      name: year?.name ?? '',
      startsOn: year?.startsOn ?? '',
      endsOn: year?.endsOn ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (values: YearValues) => {
      if (!year) return unwrap(academics.POST('/api/v1/academic-years', { body: values }));
      // Only what changed is sent.
      const body: UpdateAcademicYearBody = {
        ...(values.name !== year.name && { name: values.name }),
        ...(values.startsOn !== year.startsOn && { startsOn: values.startsOn }),
        ...(values.endsOn !== year.endsOn && { endsOn: values.endsOn }),
      };
      return unwrap(
        academics.PATCH('/api/v1/academic-years/{id}', { params: { path: { id: year.id } }, body }),
      );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.all });
      toast.success(year ? `${saved.name} saved.` : `${saved.name} created.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.ACADEMIC_YEAR_NAME_TAKEN) {
        form.setError('name', { message: error.message }, { shouldFocus: true });
        return;
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
        if (year && !isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{year ? `Edit ${year.name}` : 'New academic year'}</DialogTitle>
        <DialogDescription>
          {year
            ? 'Name and dates can change until the year is closed.'
            : 'The year starts as planned. Activate it when its classes are ready.'}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField
        control={form.control}
        name="name"
        label="Name"
        hint="For example 2026-27 or Sept 2026."
        maxLength={50}
        autoFocus
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="startsOn" label="Starts on" type="date" />
        <FormField control={form.control} name="endsOn" label="Ends on" type="date" />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : year ? 'Save changes' : 'Create year'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Close (§2.6): empty body, final ----

/**
 * The close endpoint takes no reason, so this is a plain confirmation rather than the
 * confirm-with-reason dialog. A refusal (active enrolments, R44) is shown inside the dialog.
 */
function CloseYearDialog({ year, onClose }: { year: AcademicYearDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const close = useMutation({
    mutationFn: (id: string) =>
      unwrap(academics.POST('/api/v1/academic-years/{id}/close', { params: { path: { id } } })),
    onSuccess: (closed) => {
      toast.success(`${closed.name} is closed.`);
      close.reset();
      onClose();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: academicsKeys.all }),
  });
  const dismiss = () => {
    if (close.isPending) return;
    close.reset();
    onClose();
  };

  return (
    <Dialog open={year !== null} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent showCloseButton={!close.isPending}>
        <DialogHeader>
          <DialogTitle>Close {year?.name}?</DialogTitle>
          <DialogDescription>
            A closed year cannot be reopened. Its classes and sections can no longer be edited,
            and no new classes can be added to it.
          </DialogDescription>
        </DialogHeader>
        {close.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {close.error instanceof ApiError &&
              close.error.code === ErrorCode.PROMOTION_INCOMPLETE ? (
                <PromotionIncomplete details={close.error.details} />
              ) : close.error instanceof ApiError &&
                close.error.code === ErrorCode.ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS ? (
                'Students are still actively enrolled in this year. Promote, transfer or withdraw them before closing it.'
              ) : (
                describeApiError(close.error)
              )}
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={close.isPending} onClick={dismiss}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={close.isPending}
            onClick={() => year && close.mutate(year.id)}
          >
            {close.isPending ? 'Closing…' : 'Close year permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * contracts/slice-35.md §5 (R299): the sections whose promotion sheet is not applied yet, from the
 * refusal's details, with the way to the promotion page.
 */
function PromotionIncomplete({ details }: { details: unknown }) {
  const sections =
    typeof details === 'object' && details !== null && 'sections' in details && Array.isArray(details.sections)
      ? (details.sections as { sectionId: string; className: string; sectionName: string }[])
      : [];
  return (
    <>
      Apply the promotion sheet of every section before closing the year. Still open:{' '}
      {sections.map((s) => `${s.className} ${s.sectionName}`).join(', ') || 'some sections'}.{' '}
      <Link href="/promotion" className="font-medium underline">
        Go to Promotion
      </Link>
    </>
  );
}
