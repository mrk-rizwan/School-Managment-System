'use client';

import { ErrorCode, formatRupees, INVOICE_STATUSES } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { CalendarPlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, RowActions, type DataTableFeatures, type RowAction } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  billingApi,
  type InvoiceDto,
  type InvoiceListQuery,
  type InvoiceStatus,
  type IssueMonthResultDto,
} from '@/lib/api/platform-billing-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { platformKeys } from '@/lib/platform-session';
import { currentYearMonth, formatYearMonth, INVOICE_STATUS_LABELS, InvoiceStatusBadge } from '../billing-ui';

const LIMIT = 25;

type Eligibility = '' | 'eligible';
type InvoiceSort = NonNullable<InvoiceListQuery['sort']>;

/**
 * Platform invoices (R220, R221): every school's monthly bill. "Eligible for suspension" lists the
 * schools still unpaid after the grace days; suspending one is the status change on its page, by
 * hand. Payments are recorded in full, by hand (no gateway).
 */
export function InvoiceList() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [eligibility, setEligibility] = useState<Eligibility>('');
  const [sort, setSort] = useState<InvoiceSort>('-issuedAt');
  const [paying, setPaying] = useState<InvoiceDto | null>(null);
  const [voiding, setVoiding] = useState<InvoiceDto | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [page, setPage] = useListPage([status, eligibility, sort]);

  const query: InvoiceListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(eligibility === 'eligible' && { suspensionEligible: true }),
  };
  const invoices = useQuery({
    queryKey: [...platformKeys.invoices, 'list', query],
    queryFn: () => unwrap(billingApi.GET('/api/v1/platform/invoices', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const voidInvoice = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(billingApi.POST('/api/v1/platform/invoices/{id}/void', { params: { path: { id } }, body: { reason } })),
    onSuccess: (invoice) => {
      toast.success(`${invoice.invoiceNo} voided. The next run for ${formatYearMonth(invoice.yearMonth)} issues a new one.`);
      void queryClient.invalidateQueries({ queryKey: platformKeys.invoices });
      setVoiding(null);
    },
    onError: (error) => {
      toastApiError(error);
      if (error instanceof ApiError && error.code === ErrorCode.INVOICE_NOT_ISSUED) {
        void queryClient.invalidateQueries({ queryKey: platformKeys.invoices });
        setVoiding(null);
      }
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, InvoiceDto>();
    return [
      column.accessor('invoiceNo', {
        header: 'Invoice',
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
      column.accessor('schoolName', {
        header: 'School',
        cell: (info) => (
          <Link
            href={`/platform/schools/${info.row.original.schoolId}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('yearMonth', { header: 'Month', cell: (info) => formatYearMonth(info.getValue()) }),
      column.display({
        id: 'plan',
        header: 'Plan',
        cell: (info) => (
          <span>
            {info.row.original.planName}
            <span className="block text-xs text-muted-foreground">
              {info.row.original.studentCount.toLocaleString('en-PK')} students
            </span>
          </span>
        ),
      }),
      column.accessor('amount', {
        header: 'Amount',
        cell: (info) => <span className="tabular-nums">{formatRupees(info.getValue())}</span>,
      }),
      column.accessor('dueOn', {
        header: 'Due',
        cell: (info) => formatDate(info.getValue()),
      }),
      column.display({
        id: 'status',
        header: 'Status',
        cell: (info) => <InvoiceStatusBadge invoice={info.row.original} />,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const invoice = info.row.original;
          const actions: RowAction[] =
            invoice.status === 'issued'
              ? [
                  { label: 'Record payment', onSelect: () => setPaying(invoice) },
                  { label: 'Void', onSelect: () => setVoiding(invoice), destructive: true },
                ]
              : [];
          return <RowActions label={invoice.invoiceNo} actions={actions} />;
        },
      }),
    ];
  }, []);

  const filtered = Boolean(status || eligibility);

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Each school’s monthly subscription invoice. Invoices are issued on the 1st; overdue and eligibility are marked daily."
        actions={
          <Button variant="outline" onClick={() => setIssuing(true)}>
            <CalendarPlusIcon />
            Issue month
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <FilterSelect<InvoiceStatus | ''> label="Status" value={status} onChange={setStatus} className="sm:w-44">
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {INVOICE_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect<Eligibility> label="Suspension" value={eligibility} onChange={setEligibility} className="sm:w-56">
          <option value="">Any</option>
          <option value="eligible">Eligible for suspension</option>
        </FilterSelect>
        <FilterSelect<InvoiceSort> label="Order" value={sort} onChange={setSort} className="sm:w-48">
          <option value="-issuedAt">Newest first</option>
          <option value="dueOn">Due date, earliest first</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={invoices}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No invoices match' : 'No invoices yet'}
        emptyDescription={
          eligibility
            ? 'No school is past its grace period with an unpaid invoice.'
            : filtered
              ? 'Try a different status.'
              : 'Invoices are issued on the 1st of each month once plans exist.'
        }
      />
      <RecordPaymentDialog invoice={paying} onClose={() => setPaying(null)} />
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => !open && setVoiding(null)}
        title={`Void invoice ${voiding?.invoiceNo ?? ''}`}
        description="A void invoice is kept on record. The month becomes open again: the next run for it issues a new invoice with a new number."
        confirmLabel="Void invoice"
        minLength={3}
        destructive
        pending={voidInvoice.isPending}
        onConfirm={(reason) => voiding && voidInvoice.mutate({ id: voiding.id, reason })}
      />
      <IssueMonthDialog open={issuing} onClose={() => setIssuing(false)} />
    </>
  );
}

// ---- Record a payment ----

function RecordPaymentDialog({ invoice, onClose }: { invoice: InvoiceDto | null; onClose: () => void }) {
  return (
    <Dialog open={invoice !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{invoice && <RecordPaymentForm invoice={invoice} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

const todayInKarachi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

const paymentSchema = z.object({
  receivedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date the money arrived.')
    .refine((v) => v <= todayInKarachi(), 'Not in the future.'),
  reference: z.string().trim().min(1, 'Enter the bank or transfer reference.').max(60, 'Use at most 60 characters.'),
});
type PaymentValues = z.infer<typeof paymentSchema>;

function RecordPaymentForm({ invoice, onDone }: { invoice: InvoiceDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { receivedOn: todayInKarachi(), reference: '' },
  });
  const record = useMutation({
    mutationFn: (v: PaymentValues) =>
      unwrap(
        billingApi.POST('/api/v1/platform/invoices/{id}/record-payment', {
          params: { path: { id: invoice.id } },
          body: { amount: invoice.amount, receivedOn: v.receivedOn, reference: v.reference },
        }),
      ),
    onSuccess: (paid) => {
      toast.success(`${paid.invoiceNo} marked paid.`);
      void queryClient.invalidateQueries({ queryKey: platformKeys.invoices });
      void queryClient.invalidateQueries({ queryKey: platformKeys.billing(paid.schoolId) });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.INVOICE_NOT_ISSUED) {
        toastApiError(error);
        void queryClient.invalidateQueries({ queryKey: platformKeys.invoices });
        onDone();
        return;
      }
      applyApiError(form, error);
    },
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => record.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Record payment for {invoice.invoiceNo}</DialogTitle>
        <DialogDescription>
          {invoice.schoolName}, {formatYearMonth(invoice.yearMonth)}. Only the full amount,{' '}
          <span className="font-medium text-foreground">{formatRupees(invoice.amount)}</span>, can be recorded.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="receivedOn" label="Received on" type="date" />
      <FormField control={form.control} name="reference" label="Reference" maxLength={60} autoFocus />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={record.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={record.isPending}>
          {record.isPending ? 'Saving…' : `Record ${formatRupees(invoice.amount)}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Issue a month by hand ----

const SKIP_LABELS: Record<string, string> = {
  trial: 'became active during or after the month',
  terminated: 'terminated',
  no_metrics: 'no student count in the last 7 days',
  no_band: 'no plan band holds its student count',
};

function IssueMonthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>{open && <IssueMonthForm onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

const monthSchema = z.object({
  yearMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick a month.')
    .refine((v) => v <= currentYearMonth(), 'Not later than this month.'),
});
type MonthValues = z.infer<typeof monthSchema>;

function IssueMonthForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<IssueMonthResultDto | null>(null);
  const form = useForm<MonthValues>({ resolver: zodResolver(monthSchema), defaultValues: { yearMonth: currentYearMonth() } });
  const issue = useMutation({
    mutationFn: (v: MonthValues) => unwrap(billingApi.POST('/api/v1/platform/invoices/issue-month', { body: v })),
    onSuccess: (r) => {
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: platformKeys.invoices });
    },
    onError: (error) => applyApiError(form, error),
  });

  if (result) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{formatYearMonth(form.getValues('yearMonth'))} issued</DialogTitle>
          <DialogDescription>
            {result.issued} new {result.issued === 1 ? 'invoice' : 'invoices'}; {result.existing} already invoiced.
          </DialogDescription>
        </DialogHeader>
        {result.failed > 0 && (
          <Alert variant="destructive">
            <AlertTitle>{result.failed} could not be issued</AlertTitle>
            <AlertDescription>Run the month again to retry them.</AlertDescription>
          </Alert>
        )}
        {result.skipped.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Not invoiced ({result.skipped.length})</p>
            <ul className="max-h-60 overflow-y-auto rounded-md border text-sm">
              {result.skipped.slice(0, 200).map((s) => (
                <li key={s.schoolId} className="flex justify-between gap-3 border-b px-3 py-2 last:border-b-0">
                  <Link href={`/platform/schools/${s.schoolId}`} className="underline-offset-4 hover:underline">
                    School {s.schoolId}
                  </Link>
                  <span className="text-muted-foreground">{SKIP_LABELS[s.reason] ?? s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => issue.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Issue a month</DialogTitle>
        <DialogDescription>
          Runs the monthly invoicing by hand, as on the 1st. A school already invoiced for the month is left as it is.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="yearMonth" label="Month" type="month" />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={issue.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={issue.isPending}>
          {issue.isPending ? 'Issuing…' : 'Issue invoices'}
        </Button>
      </DialogFooter>
    </form>
  );
}
