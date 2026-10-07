'use client';

import {
  Capability,
  COUNTER_PAYMENT_METHODS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_STATUSES,
  RECORDABLE_EXPENSE_CATEGORIES,
  formatRupees,
  newIdempotencyKey,
  PAYMENT_METHOD_LABELS,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { unwrap } from '@/lib/api/client';
import { toApiError, toastApiError } from '@/lib/api/errors';
import {
  expensesApi,
  type ExpenseCategory,
  type ExpenseDto,
  type ExpenseListQuery,
  type ExpenseStatus,
  type RecordableExpenseCategory,
  type UpdateExpenseBody,
} from '@/lib/api/school-expenses-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { useIsPrincipal } from '../fees/_lib/fees-ui';
import { nameSchema } from '@/lib/validation';
import { ACCEPT_ATTRIBUTE, ACCEPTED_TYPES, MAX_UPLOAD_BYTES, saveBlob, uploadFile } from '../students/_lib/documents';

// Expenses (phase-3-financial.md slice 23, R206-R208, R244). Recorders record and edit their own
// open rows and void them; approvers decide pending rows and void approved ones, never their own
// (a principal's self-approved expense excepted). The API decides every one of these; the menu
// only hides what cannot succeed.

const LIMIT = 25;
const expensesKey = ['expenses'] as const;

const STATUS_LABELS: Record<ExpenseStatus, string> = {
  recorded: 'Recorded',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  voided: 'Voided',
};
const isOpen = (e: ExpenseDto) => e.status === 'recorded' || e.status === 'pending_approval';

export function ExpenseList() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const me = useSchoolMe().data;
  const canRecord = can(Capability.EXPENSE_RECORD);
  const canApprove = can(Capability.EXPENSE_APPROVE);
  const isPrincipal = useIsPrincipal();
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [editing, setEditing] = useState<ExpenseDto | 'new' | null>(null);
  const [approving, setApproving] = useState<ExpenseDto | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseDto | null>(null);
  const [voiding, setVoiding] = useState<ExpenseDto | null>(null);
  const [attaching, setAttaching] = useState<ExpenseDto | null>(null);
  const [page, setPage] = useListPage([status, category]);

  const query: ExpenseListQuery = { page, limit: LIMIT, ...(status && { status }), ...(category && { category }) };
  const expenses = useQuery({
    queryKey: [...expensesKey, 'list', query],
    queryFn: () => unwrap(expensesApi.GET('/api/v1/expenses', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const done = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: expensesKey });
  };
  const failed = (close: () => void) => (error: unknown) => {
    toastApiError(error);
    void queryClient.invalidateQueries({ queryKey: expensesKey });
    close();
  };
  const path = (e: ExpenseDto) => ({ params: { path: { id: e.id } } });

  const approve = useMutation({
    mutationFn: (e: ExpenseDto) => // The version shown: an edit since then is refused (409 CONCURRENT_UPDATE) and the list reloads.
      unwrap(expensesApi.POST('/api/v1/expenses/{id}/approve', { ...path(e), body: { expectedUpdatedAt: e.updatedAt } })),
    onSuccess: (e) => {
      done(`Expense ${e.expenseNo} approved.`);
      setApproving(null);
    },
    onError: failed(() => setApproving(null)),
  });
  const reject = useMutation({
    mutationFn: ({ e, reason }: { e: ExpenseDto; reason: string }) =>
      unwrap(
        expensesApi.POST('/api/v1/expenses/{id}/reject', {
          ...path(e),
          body: { reason, expectedUpdatedAt: e.updatedAt },
        }),
      ),
    onSuccess: (e) => {
      done(`Expense ${e.expenseNo} rejected.`);
      setRejecting(null);
    },
    onError: failed(() => setRejecting(null)),
  });
  const voidExpense = useMutation({
    mutationFn: ({ e, reason }: { e: ExpenseDto; reason: string }) =>
      unwrap(expensesApi.POST('/api/v1/expenses/{id}/void', { ...path(e), body: { reason } })),
    onSuccess: (e) => {
      done(`Expense ${e.expenseNo} voided.`);
      setVoiding(null);
    },
    onError: failed(() => setVoiding(null)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ExpenseDto>();
    const mine = (e: ExpenseDto) => me !== undefined && e.recordedByUserId === me.id;
    const actionsFor = (e: ExpenseDto): RowAction[] => {
      const actions: RowAction[] = [];
      if (e.hasReceipt) actions.push({ label: 'Download receipt', onSelect: () => void downloadReceipt(e) });
      if (mine(e) && canRecord && !e.hasReceipt) actions.push({ label: 'Attach receipt', onSelect: () => setAttaching(e) });
      if (mine(e) && canRecord && isOpen(e)) actions.push({ label: 'Edit', onSelect: () => setEditing(e) });
      if (canApprove && e.status === 'pending_approval' && !mine(e)) {
        actions.push({ label: 'Approve', onSelect: () => setApproving(e) });
        actions.push({ label: 'Reject', onSelect: () => setRejecting(e), destructive: true });
      }
      const voidable =
        (isOpen(e) && mine(e) && canRecord) ||
        (e.status === 'approved' && canApprove && (!mine(e) || (e.selfApproved && isPrincipal)));
      if (voidable) actions.push({ label: 'Void', onSelect: () => setVoiding(e), destructive: true });
      return actions;
    };
    return [
      column.accessor('expenseNo', { header: 'No.', cell: (info) => <span className="tabular-nums">{info.getValue()}</span> }),
      column.accessor('spentOn', { header: 'Spent on', cell: (info) => formatDay(info.getValue()) }),
      column.accessor('category', { header: 'Category', cell: (info) => EXPENSE_CATEGORY_LABELS[info.getValue()] }),
      column.accessor('description', {
        header: 'What for',
        cell: (info) => (
          <span className="grid">
            <span>{info.getValue()}</span>
            {info.row.original.payee && <span className="text-xs text-muted-foreground">{info.row.original.payee}</span>}
          </span>
        ),
      }),
      column.accessor('amount', {
        header: () => <span className="block text-right">Amount</span>,
        cell: (info) => <span className="block text-right tabular-nums">{formatRupees(info.getValue())}</span>,
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge variant={info.getValue() === 'pending_approval' ? 'default' : info.getValue() === 'approved' || info.getValue() === 'recorded' ? 'secondary' : 'outline'}>
              {STATUS_LABELS[info.getValue()]}
            </Badge>
            {info.row.original.selfApproved && <Badge variant="outline">Self-approved</Badge>}
          </span>
        ),
      }),
      column.accessor('recordedByName', { header: 'Recorded by' }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => <RowActions label={`expense ${info.row.original.expenseNo}`} actions={actionsFor(info.row.original)} />,
      }),
    ];
  }, [me, canRecord, canApprove, isPrincipal]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <FilterSelect<ExpenseStatus | ''> label="Status" value={status} onChange={setStatus}>
            <option value="">All</option>
            {EXPENSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<ExpenseCategory | ''> label="Category" value={category} onChange={setCategory}>
            <option value="">All</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </FilterSelect>
        </div>
        {canRecord && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            Record expense
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={expenses}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No expenses"
        emptyDescription="Recorded expenses appear here, newest first."
      />
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          {editing !== null && <ExpenseForm expense={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={approving !== null} onOpenChange={(open) => !open && !approve.isPending && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve expense {approving?.expenseNo}</DialogTitle>
            <DialogDescription>
              {approving && `${formatRupees(approving.amount)} for ${approving.description}, recorded by ${approving.recordedByName}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={approve.isPending} onClick={() => setApproving(null)}>
              Cancel
            </Button>
            <Button disabled={approve.isPending} onClick={() => approving && approve.mutate(approving)}>
              {approve.isPending ? 'Approving…' : 'Approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={`Reject expense ${rejecting?.expenseNo ?? ''}`}
        description="The recorder is told it was rejected. A rejected expense cannot be changed."
        confirmLabel="Reject"
        minLength={3}
        maxLength={500}
        destructive
        pending={reject.isPending}
        onConfirm={(reason) => rejecting && reject.mutate({ e: rejecting, reason })}
      />
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => !open && setVoiding(null)}
        title={`Void expense ${voiding?.expenseNo ?? ''}`}
        description="A voided expense stays in the history with your reason and leaves every total. It cannot be undone."
        confirmLabel="Void"
        minLength={3}
        maxLength={500}
        destructive
        pending={voidExpense.isPending}
        onConfirm={(reason) => voiding && voidExpense.mutate({ e: voiding, reason })}
      />
      <Dialog open={attaching !== null} onOpenChange={(open) => !open && setAttaching(null)}>
        <DialogContent>
          {attaching && (
            <AttachReceipt
              expense={attaching}
              onDone={() => {
                setAttaching(null);
                void queryClient.invalidateQueries({ queryKey: expensesKey });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** GET /expenses/:id/receipt, streamed by the API, saved under its own name. */
async function downloadReceipt(e: ExpenseDto): Promise<void> {
  const { data, error, response } = await expensesApi.GET('/api/v1/expenses/{id}/receipt', {
    params: { path: { id: e.id } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) {
    toastApiError(toApiError(response, error));
    return;
  }
  saveBlob(data, response, `expense-${e.expenseNo}`);
}

const receiptProblem = (file: File | null): string | null => {
  if (file === null) return null;
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or PDF file.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 5 MB.';
  return null;
};

function ReceiptInput({ file, onChange, disabled }: { file: File | null; onChange: (file: File | null) => void; disabled: boolean }) {
  const id = useId();
  const problem = receiptProblem(file);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Receipt (JPEG, PNG or PDF, up to 5 MB)</Label>
      <Input id={id} type="file" accept={ACCEPT_ATTRIBUTE} disabled={disabled} aria-invalid={problem ? true : undefined} onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}

function AttachReceipt({ expense, onDone }: { expense: ExpenseDto; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const attach = useMutation({
    mutationFn: async (chosen: File) => {
      const staged = await uploadFile(chosen);
      return unwrap(
        expensesApi.PATCH('/api/v1/expenses/{id}/receipt', { params: { path: { id: expense.id } }, body: { stagedUploadId: staged.id } }),
      );
    },
    onSuccess: () => {
      toast.success(`Receipt attached to expense ${expense.expenseNo}.`);
      onDone();
    },
    onError: toastApiError,
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (file && !receiptProblem(file)) attach.mutate(file);
      }}
    >
      <DialogHeader>
        <DialogTitle>Attach receipt to expense {expense.expenseNo}</DialogTitle>
        <DialogDescription>A receipt is attached once and cannot be replaced.</DialogDescription>
      </DialogHeader>
      <ReceiptInput file={file} onChange={setFile} disabled={attach.isPending} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={attach.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!file || receiptProblem(file) !== null || attach.isPending}>
          {attach.isPending ? 'Attaching…' : 'Attach'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Record and edit ----

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.');

const expenseSchema = z.object({
  category: z.enum(RECORDABLE_EXPENSE_CATEGORIES as [RecordableExpenseCategory, ...RecordableExpenseCategory[]]),
  amount: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,7}$/, 'Enter whole rupees, 1 or more.')
    .refine((value) => Number(value) <= 10_000_000, 'At most Rs 10,000,000.'),
  spentOn: z
    .string()
    .min(1, 'Choose the date.')
    .refine((value) => value <= todayInSchool(), 'The date cannot be in the future.'),
  description: nameSchema(1, 500),
  payee: optionalText(100),
  method: z.enum(['cash', 'bank_transfer', 'jazzcash', 'easypaisa']),
  reference: optionalText(60),
});
type ExpenseValues = z.infer<typeof expenseSchema>;

/** The fields the form changed, as the PATCH body (absent = unchanged; blank clears). */
function changesOf(values: ExpenseValues, expense: ExpenseDto): UpdateExpenseBody {
  const amount = Number(values.amount);
  return {
    ...(values.category !== expense.category && { category: values.category }),
    ...(amount !== expense.amount && { amount }),
    ...(values.spentOn !== expense.spentOn && { spentOn: values.spentOn }),
    ...(values.description !== expense.description && { description: values.description }),
    ...(values.payee !== (expense.payee ?? '') && { payee: values.payee || null }),
    ...(values.method !== expense.method && { method: values.method }),
    ...(values.reference !== (expense.reference ?? '') && { reference: values.reference || null }),
  };
}

const CATEGORY_OPTIONS = RECORDABLE_EXPENSE_CATEGORIES.map((value) => ({ value, label: EXPENSE_CATEGORY_LABELS[value] }));
const METHOD_OPTIONS = COUNTER_PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }));

function ExpenseForm({ expense, onDone }: { expense: ExpenseDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  // One key per opened form: a retried save is a replay, never a second expense.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [file, setFile] = useState<File | null>(null);
  const form = useForm<ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: expense
      ? {
          category: expense.category as RecordableExpenseCategory,
          amount: String(expense.amount),
          spentOn: expense.spentOn,
          description: expense.description,
          payee: expense.payee ?? '',
          method: expense.method,
          reference: expense.reference ?? '',
        }
      : { category: 'stationery', amount: '', spentOn: today, description: '', payee: '', method: 'cash', reference: '' },
  });

  const save = useMutation({
    mutationFn: async (values: ExpenseValues) => {
      const amount = Number(values.amount);
      if (!expense) {
        const staged = file ? await uploadFile(file) : null;
        return unwrap(
          expensesApi.POST('/api/v1/expenses', {
            params: { header: { 'Idempotency-Key': idempotencyKey } },
            body: {
              category: values.category,
              amount,
              spentOn: values.spentOn,
              description: values.description,
              method: values.method,
              ...(values.payee && { payee: values.payee }),
              ...(values.reference && { reference: values.reference }),
              ...(staged && { stagedUploadId: staged.id }),
            },
          }),
        );
      }
      return unwrap(
        expensesApi.PATCH('/api/v1/expenses/{id}', {
          params: { path: { id: expense.id } },
          body: changesOf(values, expense),
        }),
      );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: expensesKey });
      toast.success(
        expense
          ? `Expense ${saved.expenseNo} saved.`
          : saved.status === 'pending_approval'
            ? `Expense ${saved.expenseNo} recorded. It is above the approval threshold and waits for approval.`
            : `Expense ${saved.expenseNo} recorded.`,
      );
      onDone();
    },
    onError: (error) => applyApiError(form, error),
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => {
        if (expense && Object.keys(changesOf(values, expense)).length === 0) return onDone();
        if (receiptProblem(file)) return;
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{expense ? `Edit expense ${expense.expenseNo}` : 'Record expense'}</DialogTitle>
        <DialogDescription>
          {expense
            ? 'You can change your expense until it is decided.'
            : 'Above the school’s approval threshold an expense waits for a principal; a principal’s own is approved as recorded.'}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="category" label="Category" options={CATEGORY_OPTIONS} />
        <FormField control={form.control} name="amount" label="Amount (Rs)" inputMode="numeric" autoFocus />
        <FormField control={form.control} name="spentOn" label="Spent on" type="date" />
        <FormField control={form.control} name="method" label="Paid by" options={METHOD_OPTIONS} />
      </div>
      <FormField control={form.control} name="description" label="What for" maxLength={500} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="payee" label="Paid to (optional)" maxLength={100} />
        <FormField control={form.control} name="reference" label="Bill or reference (optional)" maxLength={60} />
      </div>
      {!expense && <ReceiptInput file={file} onChange={setFile} disabled={save.isPending} />}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : expense ? 'Save changes' : 'Record expense'}
        </Button>
      </DialogFooter>
    </form>
  );
}
