'use client';

import { ErrorCode, formatRupees } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { billingApi, type SchoolBillingDto } from '@/lib/api/platform-billing-contract';
import type { SchoolDto } from '@/lib/api/platform-contract';
import { formatDate } from '@/lib/format';
import { platformKeys } from '@/lib/platform-session';
import { formatBand, formatYearMonth, InvoiceStatusBadge } from '../../billing-ui';

/**
 * A school's place in platform billing (contracts/slice-26.md §1.2): its plan (derived each month
 * from its student count, or pinned by hand), its latest count, its SMS limit and whether that was
 * set by hand, its last 12 invoices, and after termination when retention ends.
 */
export function SchoolBilling({ school }: { school: SchoolDto }) {
  const queryClient = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [unpinning, setUnpinning] = useState(false);
  const billing = useQuery({
    queryKey: platformKeys.billing(school.id),
    queryFn: () =>
      unwrap(billingApi.GET('/api/v1/platform/schools/{id}/billing', { params: { path: { id: school.id } } })),
  });

  const refresh = (view?: SchoolBillingDto) => {
    if (view) queryClient.setQueryData(platformKeys.billing(school.id), view);
    else void queryClient.invalidateQueries({ queryKey: platformKeys.billing(school.id) });
    void queryClient.invalidateQueries({ queryKey: platformKeys.school(school.id) });
  };

  const unpin = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        billingApi.POST('/api/v1/platform/schools/{id}/unpin-plan', {
          params: { path: { id: school.id } },
          body: { reason },
        }),
      ),
    onSuccess: (view) => {
      refresh(view);
      setUnpinning(false);
      toast.success(
        view.subscription
          ? `Unpinned. Now on ${view.subscription.planName}, from its student count.`
          : 'Unpinned. The next monthly run sets the plan from the student count.',
      );
    },
    onError: (error) => toastApiError(error),
  });

  const useAllowance = useMutation({
    mutationFn: () =>
      unwrap(billingApi.POST('/api/v1/platform/schools/{id}/use-plan-allowance', { params: { path: { id: school.id } } })),
    onSuccess: (view) => {
      refresh(view);
      toast.success(`The SMS limit now follows the plan: ${view.smsCap.value.toLocaleString('en-PK')} a month.`);
    },
    onError: (error) => toastApiError(error),
  });

  if (billing.isPending) {
    return (
      <Card>
        <CardContent>
          <LoadingState rows={3} />
        </CardContent>
      </Card>
    );
  }
  if (billing.error) {
    return (
      <Card>
        <ErrorState error={billing.error} onRetry={() => void billing.refetch()} />
      </Card>
    );
  }
  const data = billing.data;
  const terminated = school.status === 'terminated';
  const sub = data.subscription;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>
          Billed each month on the plan whose band holds the school’s student count, unless pinned to a plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">Plan</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {sub ? (
                <>
                  <span className="font-medium">{sub.planName}</span>
                  <Badge variant={sub.pinned ? 'secondary' : 'outline'}>{sub.pinned ? 'Pinned' : 'From count'}</Badge>
                </>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              )}
            </dd>
            {sub && <dd className="text-xs text-muted-foreground">Since {formatDate(sub.startedOn)}</dd>}
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">Students on the roll</dt>
            <dd>
              {data.metrics ? (
                <>
                  <span className="font-medium tabular-nums">{data.metrics.activeStudents.toLocaleString('en-PK')}</span>
                  <span className="block text-xs text-muted-foreground">Counted {formatDate(data.metrics.day)}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Not counted yet</span>
              )}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">SMS limit</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">{data.smsCap.value.toLocaleString('en-PK')} a month</span>
              {data.smsCap.overridden && <Badge variant="outline">Set by hand</Badge>}
            </dd>
            {data.smsCap.overridden && !terminated && (
              <dd>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  disabled={useAllowance.isPending}
                  onClick={() => useAllowance.mutate()}
                >
                  Use the plan’s allowance
                </Button>
              </dd>
            )}
          </div>
        </dl>

        {data.terminatedAt && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            Terminated {formatDate(data.terminatedAt)}. Its data is retained until{' '}
            <span className="font-medium">{data.retentionEndsOn ? formatDate(data.retentionEndsOn) : '—'}</span>; nothing is
            deleted automatically.
          </p>
        )}

        {!terminated && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAssigning(true)}>
              {sub?.pinned ? 'Change pinned plan' : 'Pin to a plan'}
            </Button>
            {sub?.pinned && (
              <Button variant="ghost" onClick={() => setUnpinning(true)}>
                Unpin
              </Button>
            )}
          </div>
        )}

        <div className="grid gap-2">
          <p className="text-sm font-medium">Invoices</p>
          {data.invoices.length === 0 ? (
            <div className="rounded-md border">
              <EmptyState title="No invoices yet" description="The first is issued on the 1st after the school becomes active." />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-4">Invoice</TableHead>
                    <TableHead className="px-4">Month</TableHead>
                    <TableHead className="px-4">Amount</TableHead>
                    <TableHead className="px-4">Due</TableHead>
                    <TableHead className="px-4">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="px-4 font-mono text-xs">{invoice.invoiceNo}</TableCell>
                      <TableCell className="px-4">{formatYearMonth(invoice.yearMonth)}</TableCell>
                      <TableCell className="px-4 tabular-nums">{formatRupees(invoice.amount)}</TableCell>
                      <TableCell className="px-4">{formatDate(invoice.dueOn)}</TableCell>
                      <TableCell className="px-4">
                        <InvoiceStatusBadge invoice={invoice} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={assigning} onOpenChange={(open) => !open && setAssigning(false)}>
        <DialogContent>
          {assigning && (
            <AssignPlanForm
              school={school}
              currentStart={sub?.startedOn ?? null}
              onDone={(changed) => {
                setAssigning(false);
                if (changed) refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={unpinning}
        onOpenChange={setUnpinning}
        title={`Unpin ${school.name}`}
        description="From today the school is billed on the plan its student count falls in, and its SMS limit follows that plan unless it was set by hand."
        confirmLabel="Unpin"
        minLength={3}
        pending={unpin.isPending}
        onConfirm={(reason) => unpin.mutate(reason)}
      />
    </Card>
  );
}

const todayInKarachi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

const assignSchema = z.object({
  planId: z.string().min(1, 'Pick a plan.'),
  startedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the first day.'),
  reason: z.string().trim().min(3, 'Say why, in at least 3 characters.').max(500, 'Use at most 500 characters.'),
});
type AssignValues = z.infer<typeof assignSchema>;

function AssignPlanForm({
  school,
  currentStart,
  onDone,
}: {
  school: SchoolDto;
  currentStart: string | null;
  onDone: (changed: boolean) => void;
}) {
  const plans = useQuery({
    queryKey: [...platformKeys.plans, 'options'],
    queryFn: () =>
      unwrap(billingApi.GET('/api/v1/platform/plans', { params: { query: { status: 'active', limit: OPTIONS_LIMIT } } })),
  });
  const form = useForm<AssignValues>({
    resolver: zodResolver(assignSchema),
    defaultValues: { planId: '', startedOn: todayInKarachi(), reason: '' },
  });
  const assign = useMutation({
    mutationFn: (v: AssignValues) =>
      unwrap(
        billingApi.POST('/api/v1/platform/schools/{id}/assign-plan', {
          params: { path: { id: school.id } },
          body: v,
        }),
      ),
    onSuccess: (sub) => {
      toast.success(`${school.name} is pinned to ${sub.planName}.`);
      onDone(true);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.PLAN_ARCHIVED) {
        form.setError('planId', { message: 'That plan has been archived. Pick another.' }, { shouldFocus: true });
        void plans.refetch();
        return;
      }
      applyApiError(form, error);
    },
  });

  const options = [
    { value: '', label: plans.isPending ? 'Loading plans…' : 'Choose a plan' },
    ...(plans.data?.data ?? []).map((p) => ({
      value: p.id,
      label: `${p.name}: ${formatBand(p)}, ${formatRupees(p.monthlyPrice)} a month`,
    })),
  ];

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => assign.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Pin {school.name} to a plan</DialogTitle>
        <DialogDescription>
          The school is billed on this plan whatever its student count, until unpinned. Its SMS limit becomes the plan’s
          allowance, replacing any limit set by hand.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="planId" label="Plan" options={options} />
      <FormField
        control={form.control}
        name="startedOn"
        label="From"
        type="date"
        hint={currentStart ? `On or after ${formatDate(currentStart)}, when the current plan started.` : undefined}
      />
      <FormField control={form.control} name="reason" label="Reason" maxLength={500} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={assign.isPending} onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={assign.isPending}>
          {assign.isPending ? 'Saving…' : 'Pin to plan'}
        </Button>
      </DialogFooter>
    </form>
  );
}
