'use client';

import { ErrorCode, formatRupees } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, RowActions, type DataTableFeatures, type RowAction } from '@/components/data-table';
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
  billingApi,
  type PlanDto,
  type PlanListQuery,
  type PlanStatus,
  type UpdatePlanBody,
} from '@/lib/api/platform-billing-contract';
import { useListPage } from '@/lib/hooks';
import { platformKeys } from '@/lib/platform-session';
import { nameSchema } from '@/lib/validation';
import { formatBand } from '../billing-ui';

const LIMIT = 25;

/**
 * Price tiers (R219): bands of student counts that never overlap among active plans, a monthly
 * price and an SMS allowance. Each month a school is billed on the band holding its count unless
 * it is pinned to a plan. Bands are fixed once created; archive a plan to retire it.
 */
export function PlanList() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PlanStatus | ''>('active');
  const [editing, setEditing] = useState<PlanDto | 'new' | null>(null);
  const [archiving, setArchiving] = useState<PlanDto | null>(null);
  const [page, setPage] = useListPage([status]);

  const query: PlanListQuery = { page, limit: LIMIT, ...(status && { status }) };
  const plans = useQuery({
    queryKey: [...platformKeys.plans, 'list', query],
    queryFn: () => unwrap(billingApi.GET('/api/v1/platform/plans', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const archive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(billingApi.POST('/api/v1/platform/plans/{id}/archive', { params: { path: { id } }, body: { reason } })),
    onSuccess: (plan) => {
      toast.success(`${plan.name} archived.`);
      void queryClient.invalidateQueries({ queryKey: platformKeys.plans });
      setArchiving(null);
    },
    onError: (error) => {
      toastApiError(error);
      if (error instanceof ApiError && error.code === ErrorCode.PLAN_IN_USE) setArchiving(null);
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, PlanDto>();
    return [
      column.accessor('name', {
        header: 'Plan',
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.status === 'archived' && <Badge variant="ghost">Archived</Badge>}
          </span>
        ),
      }),
      column.display({ id: 'band', header: 'Band', cell: (info) => formatBand(info.row.original) }),
      column.accessor('monthlyPrice', {
        header: 'Monthly price',
        cell: (info) => <span className="tabular-nums">{formatRupees(info.getValue())}</span>,
      }),
      column.accessor('smsAllowance', {
        header: 'SMS a month',
        cell: (info) => <span className="tabular-nums">{info.getValue().toLocaleString('en-PK')}</span>,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const plan = info.row.original;
          const actions: RowAction[] =
            plan.status === 'active'
              ? [
                  { label: 'Edit', onSelect: () => setEditing(plan) },
                  { label: 'Archive', onSelect: () => setArchiving(plan), destructive: true },
                ]
              : [];
          return <RowActions label={plan.name} actions={actions} />;
        },
      }),
    ];
  }, []);

  return (
    <>
      <PageHeader
        title="Plans"
        description="Price tiers by student count. A school is billed each month on the band holding its count, unless pinned to a plan."
        actions={
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            New plan
          </Button>
        }
      />
      <div className="mb-4">
        <FilterSelect<PlanStatus | ''> label="Status" value={status} onChange={setStatus} className="sm:w-44">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="">All</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={plans}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'archived' ? 'No archived plans' : 'No plans yet'}
        emptyDescription={
          status === 'archived'
            ? 'Archived plans keep their invoices and history.'
            : 'No school can be invoiced until the price tiers are entered.'
        }
      />
      <PlanFormDialog plan={editing} onClose={() => setEditing(null)} />
      <ConfirmWithReasonDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive plan: ${archiving?.name ?? ''}`}
        description="An archived plan keeps its invoices but no school can be billed on it again, and its band becomes free for a new plan. A plan a school is on cannot be archived. This cannot be undone."
        confirmLabel="Archive"
        minLength={3}
        destructive
        pending={archive.isPending}
        onConfirm={(reason) => archiving && archive.mutate({ id: archiving.id, reason })}
      />
    </>
  );
}

// ---- Create and edit ----

const count = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) <= 1_000_000, `${label}: a whole number up to 1,000,000.`);

const planSchema = z
  .object({
    name: nameSchema(2, 60),
    minStudents: count('From'),
    maxStudents: z
      .string()
      .trim()
      .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) <= 1_000_000), 'Leave blank for no upper limit, or a whole number.'),
    monthlyPrice: z
      .string()
      .trim()
      .refine((v) => /^\d+$/.test(v) && Number(v) <= 10_000_000, 'Whole rupees, up to 10,000,000.'),
    smsAllowance: z
      .string()
      .trim()
      .refine((v) => /^\d+$/.test(v) && Number(v) <= 100_000, 'A whole number from 0 to 100,000.'),
  })
  .refine((v) => v.maxStudents === '' || Number(v.maxStudents) >= Number(v.minStudents), {
    path: ['maxStudents'],
    message: 'Must be at least the lower edge.',
  });
type PlanValues = z.infer<typeof planSchema>;

function PlanFormDialog({ plan, onClose }: { plan: PlanDto | 'new' | null; onClose: () => void }) {
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{plan !== null && <PlanForm plan={plan === 'new' ? null : plan} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function PlanForm({ plan, onDone }: { plan: PlanDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<PlanValues>({
    resolver: zodResolver(planSchema),
    defaultValues: plan
      ? {
          name: plan.name,
          minStudents: String(plan.minStudents),
          maxStudents: plan.maxStudents === null ? '' : String(plan.maxStudents),
          monthlyPrice: String(plan.monthlyPrice),
          smsAllowance: String(plan.smsAllowance),
        }
      : { name: '', minStudents: '', maxStudents: '', monthlyPrice: '', smsAllowance: '' },
  });

  const save = useMutation({
    mutationFn: (v: PlanValues) => {
      if (!plan) {
        return unwrap(
          billingApi.POST('/api/v1/platform/plans', {
            body: {
              name: v.name,
              minStudents: Number(v.minStudents),
              ...(v.maxStudents !== '' && { maxStudents: Number(v.maxStudents) }),
              monthlyPrice: Number(v.monthlyPrice),
              smsAllowance: Number(v.smsAllowance),
            },
          }),
        );
      }
      const body: UpdatePlanBody = {
        ...(v.name !== plan.name && { name: v.name }),
        ...(Number(v.monthlyPrice) !== plan.monthlyPrice && { monthlyPrice: Number(v.monthlyPrice) }),
        ...(Number(v.smsAllowance) !== plan.smsAllowance && { smsAllowance: Number(v.smsAllowance) }),
      };
      return unwrap(billingApi.PATCH('/api/v1/platform/plans/{id}', { params: { path: { id: plan.id } }, body }));
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: platformKeys.plans });
      toast.success(plan ? `${saved.name} saved.` : `${saved.name} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.PLAN_BAND_OVERLAPS) {
        form.setError('minStudents', { message: 'This band overlaps an active plan.' }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => {
        if (plan && !form.formState.isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{plan ? `Edit ${plan.name}` : 'New plan'}</DialogTitle>
        <DialogDescription>
          {plan
            ? 'The band is fixed. A new price or allowance applies from the next monthly run.'
            : 'The band is fixed once the plan exists. Active bands may not overlap.'}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="name" label="Name" maxLength={60} autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="minStudents"
          label="From (students)"
          inputMode="numeric"
          maxLength={7}
          disabled={plan !== null}
        />
        <FormField
          control={form.control}
          name="maxStudents"
          label="To (students)"
          hint="Blank: no upper limit."
          inputMode="numeric"
          maxLength={7}
          disabled={plan !== null}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="monthlyPrice" label="Monthly price (Rs)" inputMode="numeric" maxLength={8} />
        <FormField
          control={form.control}
          name="smsAllowance"
          label="SMS a month"
          hint="Becomes the school’s SMS limit unless set by hand."
          inputMode="numeric"
          maxLength={6}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : plan ? 'Save changes' : 'Add plan'}
        </Button>
      </DialogFooter>
    </form>
  );
}
