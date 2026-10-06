'use client';

import { formatRupees } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { schoolBillingApi } from '@/lib/api/school-billing-contract';
import { formatDate } from '@/lib/format';

// The school's own ASMS subscription (contracts/slice-26.md §1.4, A18): its plan and SMS
// allowance, the latest invoice, and whether a payment is overdue. Read-only; the platform
// records payments. Shown on the settings page to school.settings.manage holders.

const billingKeys = ['school', 'billing-status'] as const;

const formatMonth = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1)),
  );
};

export function BillingStatusCard() {
  const status = useQuery({
    queryKey: billingKeys,
    queryFn: () => unwrap(schoolBillingApi.GET('/api/v1/school/billing-status')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>ASMS subscription</CardTitle>
        <CardDescription>Your school’s plan and its monthly invoice from ASMS.</CardDescription>
      </CardHeader>
      <CardContent>
        {status.isPending ? (
          <LoadingState rows={2} />
        ) : status.error ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <div className="grid gap-4 text-sm">
            {status.data.suspensionEligibleAt ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                An invoice is unpaid past its grace period. Please pay to avoid suspension of the service.
              </p>
            ) : (
              status.data.overdue && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  An invoice is overdue.
                </p>
              )
            )}
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">Plan</dt>
                <dd>
                  {status.data.plan ? (
                    <>
                      <span className="font-medium">{status.data.plan.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {status.data.plan.smsAllowance.toLocaleString('en-PK')} SMS a month included
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not assigned yet</span>
                  )}
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">Latest invoice</dt>
                <dd>
                  {status.data.currentInvoice ? (
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium tabular-nums">{formatRupees(status.data.currentInvoice.amount)}</span>
                        <Badge variant={status.data.currentInvoice.status === 'paid' ? 'secondary' : 'outline'}>
                          {status.data.currentInvoice.status === 'paid' ? 'Paid' : 'Unpaid'}
                        </Badge>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {status.data.currentInvoice.invoiceNo}, {formatMonth(status.data.currentInvoice.yearMonth)}, due{' '}
                        {formatDate(status.data.currentInvoice.dueOn)}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
