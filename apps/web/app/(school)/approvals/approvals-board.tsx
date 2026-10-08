'use client';

import { Capability, EXPENSE_CATEGORY_LABELS, formatRupees, PAYMENT_METHOD_LABELS, resultTermLabel, yearMonthOf } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState, QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { approvalsApi, type ApprovalsDto } from '@/lib/api/school-approvals-contract';
import { formatDate, formatDateTime, todayInSchool } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { weekAgo } from '../fees/_lib/fees-ui';
import { leavePeriod, workingDaysLabel } from '../leave/_lib/leave-ui';
import { useDefaultYearId } from '../reports/_lib/reports-ui';

const approvalsKey = ['school', 'approvals'] as const;

/**
 * The Approvals page (slice 27, R227): one read of GET /me/approvals, which holds only the
 * sections whose key the user has, each the queue's first ten rows and its total. Deciding happens
 * on each queue's own page, which this links to; the API refuses anything the user may not do.
 * Above the queues, the principal's tiles (each shown when the user may read its source).
 */
export function ApprovalsBoard() {
  const approvals = useQuery({
    queryKey: approvalsKey,
    queryFn: () => unwrap(approvalsApi.GET('/api/v1/me/approvals')),
    // A decision taken on a queue page, or by a colleague, shows on the next visit.
    staleTime: 0,
  });

  return (
    <div className="grid gap-6">
      <QueryStates query={approvals}>
        {(data) => (
          <>
            <Tiles approvals={data} />
            <Queues approvals={data} />
          </>
        )}
      </QueryStates>
    </div>
  );
}

// ------------------------------------------------------------------------------------- tiles

function Tile({ label, value, detail, href, testId }: { label: string; value: React.ReactNode; detail?: string; href: string; testId: string }) {
  return (
    <Link href={href} className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50" data-testid={`approvals.tile.${testId}`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </Link>
  );
}

/** A figure still loading shows a dash; one that failed shows "—" too (the source page explains). */
const figure = (q: { data?: number }, format: (n: number) => string = String) => (q.data === undefined ? '—' : format(q.data));

/**
 * The principal's dashboard tiles (slice 27). The four queue tiles come from the same read; the
 * others from the finance reports, the charges list and the expenses list, each fetched only when
 * the user holds a key that reads it.
 */
function Tiles({ approvals }: { approvals: ApprovalsDto }) {
  const me = useSchoolMe();
  const { can } = useCapabilities();
  // The dashboard is the principal's (slice 27); other approvers see the queues only.
  const principal = me.data?.roles.includes('principal') ?? false;
  const reports = principal && can(Capability.FINANCE_REPORT_VIEW);
  const charges = principal && (can(Capability.FEE_STATEMENT_VIEW) || can(Capability.CHARGE_CREATE));
  const expenses = principal && (can(Capability.EXPENSE_APPROVE) || can(Capability.FINANCE_REPORT_VIEW));
  const today = todayInSchool();
  const yearId = useDefaultYearId('');
  const monthStart = `${yearMonthOf(today)}-01`;

  const collections = useQuery({
    queryKey: ['school', 'approvals', 'tile', 'collections', today],
    queryFn: async () =>
      (
        await unwrap(
          approvalsApi.GET('/api/v1/finance-reports/collections', {
            params: { query: { receivedFrom: today, receivedTo: today, groupBy: 'method' } },
          }),
        )
      ).total,
    enabled: reports,
  });
  const outstanding = useQuery({
    queryKey: ['school', 'approvals', 'tile', 'outstanding', yearId],
    queryFn: async () =>
      (await unwrap(approvalsApi.GET('/api/v1/finance-reports/outstanding', { params: { query: { academicYearId: yearId } } }))).total,
    enabled: reports && yearId !== '',
  });
  const voided = useQuery({
    queryKey: ['school', 'approvals', 'tile', 'voided', weekAgo()],
    queryFn: async () =>
      (await unwrap(approvalsApi.GET('/api/v1/charges', { params: { query: { page: 1, limit: 1, status: 'voided', voidedFrom: weekAgo() } } })))
        .total,
    enabled: charges,
  });
  const selfApproved = useQuery({
    queryKey: ['school', 'approvals', 'tile', 'self-approved', monthStart],
    queryFn: async () =>
      (
        await unwrap(
          approvalsApi.GET('/api/v1/expenses', {
            params: { query: { page: 1, limit: 1, selfApproved: true, decidedFrom: monthStart } },
          }),
        )
      ).total,
    enabled: expenses,
  });

  if (!principal) return null;
  return (
    <section aria-label="At a glance" className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="approvals.tiles">
      {approvals.claims && <Tile label="Fee proofs waiting" value={approvals.claims.count} href="/fees/claims" testId="claims" />}
      {approvals.handovers && <Tile label="Open custody" value={approvals.handovers.count} detail="Handovers to count" href="/fees/handovers" testId="handovers" />}
      {approvals.expenses && <Tile label="Pending expenses" value={approvals.expenses.count} href="/expenses" testId="expenses" />}
      {approvals.leave && <Tile label="Pending leave" value={approvals.leave.count} href="/leave" testId="leave" />}
      {approvals.results && (
        <Tile label="Result sheets" value={approvals.results.count} href="/results/sheets" testId="results" />
      )}
      {reports && <Tile label="Today's collections" value={figure(collections, formatRupees)} href="/reports/collections" testId="collections" />}
      {reports && <Tile label="Outstanding" value={figure(outstanding, formatRupees)} detail="This academic year" href="/reports/outstanding" testId="outstanding" />}
      {charges && <Tile label="Charges voided" value={figure(voided)} detail="Last 7 days" href="/fees/charges" testId="voided" />}
      {expenses && <Tile label="Self-approved expenses" value={figure(selfApproved)} detail="This month" href="/expenses" testId="selfApproved" />}
    </section>
  );
}

// ------------------------------------------------------------------------------------ queues

function Queue({
  title,
  count,
  href,
  testId,
  empty,
  children,
}: {
  title: string;
  count: number;
  href: string;
  testId: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={`approvals.${testId}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          <Badge variant={count > 0 ? 'default' : 'outline'} data-testid={`approvals.${testId}.count`}>
            {count}
          </Badge>
        </CardTitle>
        <CardAction>
          <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open queue
            <ArrowRightIcon />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <>
            <ul className="divide-y text-sm">{children}</ul>
            {count > 10 && <p className="mt-2 text-xs text-muted-foreground">Showing the first 10 of {count}.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ title, detail, amount, badge }: { title: string; detail: string; amount?: string; badge?: string }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">
          {title}
          {badge && (
            <Badge variant="outline" className="ml-2">
              {badge}
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
      {amount && <span className="shrink-0 tabular-nums">{amount}</span>}
    </li>
  );
}

function Queues({ approvals }: { approvals: ApprovalsDto }) {
  const { claims, handovers, expenses, leave, results } = approvals;
  if (!claims && !handovers && !expenses && !leave && !results) {
    return (
      <Card>
        <CardContent>
          <EmptyState title="Nothing for you to approve" description="Deposit slips, cash handovers, expenses, leave and result sheets come here for those who decide them." />
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {claims && (
        <Queue title="Deposit slips" count={claims.count} href="/fees/claims" testId="claims" empty="No deposit slips are waiting.">
          {claims.items.map((c) => (
            <Row
              key={c.id}
              title={`${c.studentName} · ${c.className}`}
              detail={`${PAYMENT_METHOD_LABELS[c.method]}, from ${c.guardianName}, sent ${formatDateTime(c.createdAt)}`}
              amount={formatRupees(c.claimedAmount)}
              badge={c.possibleDuplicate ? 'possible duplicate' : undefined}
            />
          ))}
        </Queue>
      )}
      {handovers && (
        <Queue title="Cash handovers" count={handovers.count} href="/fees/handovers" testId="handovers" empty="No cash is waiting to be counted.">
          {handovers.items.map((h) => (
            <Row
              key={h.id}
              title={h.collector.name}
              detail={`${h.paymentCount} ${h.paymentCount === 1 ? 'payment' : 'payments'}, handed over ${formatDateTime(h.openedAt)}`}
              amount={formatRupees(h.expectedAmount)}
            />
          ))}
        </Queue>
      )}
      {expenses && (
        <Queue title="Expenses" count={expenses.count} href="/expenses" testId="expenses" empty="No expenses are waiting for approval.">
          {expenses.items.map((e) => (
            <Row
              key={e.id}
              title={`No. ${e.expenseNo} · ${EXPENSE_CATEGORY_LABELS[e.category]}`}
              detail={`${e.description} · ${e.recordedByName}, ${formatDate(e.spentOn)}`}
              amount={formatRupees(e.amount)}
            />
          ))}
        </Queue>
      )}
      {results && (
        <Queue title="Result sheets" count={results.count} href="/results/sheets" testId="results" empty="No result sheets are waiting.">
          {results.items.map((r) => (
            <li key={r.id} className="py-2">
              <Link href={`/results/sheets/${r.id}`} className="flex items-start justify-between gap-3 hover:underline">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {r.className} {r.sectionName} · {resultTermLabel(r)}
                    {r.ownChildFlags.length > 0 && (
                      <Badge variant="destructive" className="ml-2">
                        own child
                      </Badge>
                    )}
                    {r.cover && (
                      <Badge variant="outline" className="ml-2">
                        cover
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.submittedByName ? `Submitted by ${r.submittedByName}` : 'Waiting'}
                    {r.submittedAt ? `, ${formatDateTime(r.submittedAt)}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </Queue>
      )}
      {leave && (
        <Queue title="Staff leave" count={leave.count} href="/leave" testId="leave" empty="No leave requests are waiting.">
          {leave.items.map((l) => (
            <Row
              key={l.id}
              title={`${l.staffName} · ${l.leaveType.name}`}
              detail={`${leavePeriod(l)} · ${workingDaysLabel(l.workingDays)}`}
              badge={l.sectionsNeedingCover.length > 0 ? 'needs cover' : undefined}
            />
          ))}
        </Queue>
      )}
    </div>
  );
}
