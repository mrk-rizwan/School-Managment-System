'use client';

import { formatDay, formatRupees, monthLabel } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { payrollApi, type SalaryStructureDto } from '@/lib/api/school-payroll-contract';
import { useListPage } from '@/lib/hooks';
import { PayslipBreakdown, PayslipStatusBadge, PrintLink, payrollKeys } from '../payroll/_lib/payroll-ui';

// A staff member's own salary and payslips (phase-3-financial.md slice 25, R217): the staff id is
// the session's; only payslips of finalised runs are shown.

const LIMIT = 12;

export function MyPayslips() {
  const [page, setPage] = useListPage([]);
  const salary = useQuery({
    queryKey: [...payrollKeys.mine, 'salary'],
    queryFn: () => unwrap(payrollApi.GET('/api/v1/me/staff/salary-structure')),
  });
  const payslips = useQuery({
    queryKey: [...payrollKeys.mine, 'payslips', page],
    queryFn: () => unwrap(payrollApi.GET('/api/v1/me/staff/payslips', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="My payslips" description="Your salary and your payslips. You are told when a new payslip is ready." />
      <section className="mb-8" aria-label="My salary">
        {salary.isPending ? (
          <LoadingState rows={2} />
        ) : salary.isError ? (
          <ErrorState error={salary.error} onRetry={() => void salary.refetch()} />
        ) : salary.data.current === null ? (
          <EmptyState title="No salary recorded" description="The office records your salary." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <SalaryCard title="Current salary" structure={salary.data.current} />
            {salary.data.upcoming && <SalaryCard title={`From ${formatDay(salary.data.upcoming.effectiveFrom)}`} structure={salary.data.upcoming} />}
          </div>
        )}
      </section>
      {payslips.isPending ? (
        <LoadingState />
      ) : payslips.isError ? (
        <ErrorState error={payslips.error} onRetry={() => void payslips.refetch()} />
      ) : payslips.data.data.length === 0 ? (
        <EmptyState title="No payslips yet" description="A payslip appears here once its month's payroll is finalised." />
      ) : (
        <div className="grid gap-3">
          {payslips.data.data.map((slip) => (
            <Card key={slip.id} data-testid={`payslip-${slip.id}`}>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="text-base">{monthLabel(slip.yearMonth)}</CardTitle>
                <div className="flex items-center gap-3">
                  <PayslipStatusBadge status={slip.status} />
                  <PrintLink href={`/api/v1/me/staff/payslips/${slip.id}/print`} />
                </div>
              </CardHeader>
              <CardContent>
                <PayslipBreakdown slip={slip} />
              </CardContent>
            </Card>
          ))}
          {payslips.data.total > page * LIMIT && (
            <Button variant="outline" onClick={() => setPage(page + 1)}>
              Older payslips
            </Button>
          )}
          {page > 1 && (
            <Button variant="ghost" onClick={() => setPage(page - 1)}>
              Newer payslips
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function SalaryCard({ title, structure }: { title: string; structure: SalaryStructureDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        <div className="flex justify-between">
          <span>Basic</span>
          <span className="tabular-nums">{formatRupees(structure.basic)}</span>
        </div>
        {structure.components.map((c) => (
          <div key={`${c.kind}-${c.name}`} className="flex justify-between text-muted-foreground">
            <span>{c.name}</span>
            <span className="tabular-nums">{c.kind === 'deduction' ? `-${formatRupees(c.amount)}` : formatRupees(c.amount)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
