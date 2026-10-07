'use client';

import {
  Capability,
  ErrorCode,
  FEE_FREQUENCIES,
  FEE_FREQUENCY_LABELS,
  FEE_HEAD_CATEGORIES,
  FEE_HEAD_CATEGORY_LABELS,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { CheckboxField } from '@/components/checkbox-field';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import {
  DataTable,
  type DataTableFeatures,
  type RowAction,
  RowActions,
  SortHeader,
} from '@/components/data-table';
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
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  feesApi,
  type FeeHeadCategory,
  type FeeHeadDto,
  type FeeHeadListQuery,
  type FeeHeadSort,
  type FeeHeadStatus,
  type UpdateFeeHeadBody,
} from '@/lib/api/school-fees-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import { feesKeys } from '../_lib/fees-ui';

const LIMIT = 25;

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** Fee heads (slice 18, R176): what the school charges for. Archived, never deleted. */
export function FeeHeadList() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canManage = can(Capability.FEE_HEAD_MANAGE);
  const [sort, setSort] = useState<FeeHeadSort>('name');
  const [status, setStatus] = useState<FeeHeadStatus | ''>('active');
  const [editing, setEditing] = useState<FeeHeadDto | 'new' | null>(null);
  const [archiving, setArchiving] = useState<FeeHeadDto | null>(null);
  const [page, setPage] = useListPage([sort, status]);

  const query: FeeHeadListQuery = { page, limit: LIMIT, sort, ...(status && { status }) };
  const heads = useQuery({
    queryKey: [...feesKeys.heads, 'list', query],
    queryFn: () => unwrap(feesApi.GET('/api/v1/fee-heads', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const archive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(feesApi.POST('/api/v1/fee-heads/{id}/archive', { params: { path: { id } }, body: { reason } })),
    onSuccess: (head) => {
      toast.success(`${head.name} archived.`);
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      setArchiving(null);
    },
    onError: (error) => {
      toastApiError(error);
      // Archived meanwhile: show the current rows.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: feesKeys.heads });
        setArchiving(null);
      }
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, FeeHeadDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Fee head" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.status === 'archived' && <Badge variant="ghost">Archived</Badge>}
          </span>
        ),
      }),
      column.accessor('category', {
        header: 'Category',
        cell: (info) => FEE_HEAD_CATEGORY_LABELS[info.getValue()],
      }),
      column.accessor('frequency', {
        header: 'Charged',
        cell: (info) => FEE_FREQUENCY_LABELS[info.getValue()],
      }),
      column.accessor('concessionEligible', {
        header: 'Concession applies',
        cell: (info) => yesNo(info.getValue()),
      }),
      column.accessor('refundable', {
        header: 'Refundable',
        cell: (info) => yesNo(info.getValue()),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const head = info.row.original;
          const actions: RowAction[] =
            canManage && head.status === 'active'
              ? [
                  { label: 'Edit', onSelect: () => setEditing(head) },
                  { label: 'Archive', onSelect: () => setArchiving(head), destructive: true },
                ]
              : [];
          return <RowActions label={head.name} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <FilterSelect<FeeHeadStatus | ''> label="Status" value={status} onChange={setStatus}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="">All</option>
        </FilterSelect>
        {canManage && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            New fee head
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={heads}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'archived' ? 'No archived fee heads' : 'No fee heads yet'}
        emptyDescription={
          status === 'archived'
            ? 'Archived heads keep their history and appear here.'
            : 'A fee head is something the school charges for, such as tuition or an exam fee.'
        }
      />
      <FeeHeadFormDialog head={editing} onClose={() => setEditing(null)} />
      <ConfirmWithReasonDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive fee head: ${archiving?.name ?? ''}`}
        description="An archived head keeps its amounts and history, but no new amount can be set for it. Archiving cannot be undone."
        confirmLabel="Archive"
        minLength={3}
        maxLength={500}
        destructive
        pending={archive.isPending}
        onConfirm={(reason) => archiving && archive.mutate({ id: archiving.id, reason })}
      />
    </>
  );
}

// ---- Create and edit ----

const headSchema = z.object({
  name: nameSchema(1, 60),
  category: z.enum(FEE_HEAD_CATEGORIES),
  frequency: z.enum(FEE_FREQUENCIES),
  concessionEligible: z.boolean(),
  refundable: z.boolean(),
});
type HeadValues = z.infer<typeof headSchema>;

/** Rules 19 and 20: a fine is never concession-eligible; an admission fee is never refundable. */
const fixedFlags = (category: FeeHeadCategory) => ({
  concessionFixed: category === 'fine',
  refundFixed: category === 'admission',
});

const CATEGORY_OPTIONS = FEE_HEAD_CATEGORIES.map((value) => ({ value, label: FEE_HEAD_CATEGORY_LABELS[value] }));
const FREQUENCY_OPTIONS = FEE_FREQUENCIES.map((value) => ({ value, label: FEE_FREQUENCY_LABELS[value] }));

function FeeHeadFormDialog({ head, onClose }: { head: FeeHeadDto | 'new' | null; onClose: () => void }) {
  return (
    <Dialog open={head !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {head !== null && <FeeHeadForm head={head === 'new' ? null : head} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function FeeHeadForm({ head, onDone }: { head: FeeHeadDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<HeadValues>({
    resolver: zodResolver(headSchema),
    defaultValues: head
      ? {
          name: head.name,
          category: head.category,
          frequency: head.frequency,
          concessionEligible: head.concessionEligible,
          refundable: head.refundable,
        }
      : { name: '', category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true },
  });
  const category = useWatch({ control: form.control, name: 'category' });
  const { concessionFixed, refundFixed } = fixedFlags(category);

  // A category with a fixed flag forces it off; the API refuses the other value.
  useEffect(() => {
    if (concessionFixed) form.setValue('concessionEligible', false);
    if (refundFixed) form.setValue('refundable', false);
  }, [concessionFixed, refundFixed, form]);

  const save = useMutation({
    mutationFn: (values: HeadValues) => {
      if (!head) return unwrap(feesApi.POST('/api/v1/fee-heads', { body: values }));
      const body: UpdateFeeHeadBody = {
        ...(values.name !== head.name && { name: values.name }),
        ...(values.concessionEligible !== head.concessionEligible && {
          concessionEligible: values.concessionEligible,
        }),
        ...(values.refundable !== head.refundable && { refundable: values.refundable }),
      };
      return unwrap(feesApi.PATCH('/api/v1/fee-heads/{id}', { params: { path: { id: head.id } }, body }));
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      toast.success(head ? `${saved.name} saved.` : `${saved.name} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.FEE_HEAD_NAME_TAKEN) {
        form.setError('name', { message: error.message }, { shouldFocus: true });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.FEE_HEAD_CATEGORY_TAKEN) {
        form.setError('category', { message: error.message }, { shouldFocus: true });
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
        if (head && !isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{head ? `Edit ${head.name}` : 'New fee head'}</DialogTitle>
        <DialogDescription>
          {head
            ? 'The category and how often it is charged are fixed once a head exists.'
            : 'Amounts are set per class on the fee structure.'}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="name" label="Name" maxLength={60} autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="category"
          label="Category"
          options={CATEGORY_OPTIONS}
          disabled={head !== null}
        />
        <FormField
          control={form.control}
          name="frequency"
          label="Charged"
          options={FREQUENCY_OPTIONS}
          disabled={head !== null}
        />
      </div>
      <CheckboxField
        control={form.control}
        name="concessionEligible"
        label="Concession applies"
        hint={concessionFixed ? 'A fine is never reduced by a concession.' : 'A student’s concession reduces this head.'}
        disabled={concessionFixed}
      />
      <CheckboxField
        control={form.control}
        name="refundable"
        label="Refundable"
        hint={refundFixed ? 'An admission fee is never refunded.' : 'May be refunded when a student leaves.'}
        disabled={refundFixed}
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : head ? 'Save changes' : 'Add fee head'}
        </Button>
      </DialogFooter>
    </form>
  );
}
