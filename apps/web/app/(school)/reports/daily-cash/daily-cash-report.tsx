'use client';

import { formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { reportsApi, type DailyCashReportDto } from '@/lib/api/school-reports-contract';
import { formatDateTime, formatDay, todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DateFilter, ReportStates, SummaryLines, reportsKeys } from '../_lib/reports-ui';

const RESOLUTION_LABELS = { recovered: 'recovered', written_off: 'written off', explained_by_void: 'explained by a void' } as const;

/**
 * Daily cash (slice 22): one day's cash payments, where that cash is now (still with its
 * collector, or in a handover), and the day's cash going out. The identity line shows that every
 * rupee received and not voided is accounted for.
 */
export function DailyCashReport() {
  const [date, setDate] = useState(todayInSchool);
  const report = useQuery({
    queryKey: reportsKeys.report('daily-cash', { date }),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/daily-cash', { params: { query: { date } } })),
    enabled: date !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateFilter label="Day" value={date} onChange={setDate} />
      </div>
      <ReportStates query={report}>{(data) => <DailyCash data={data} />}</ReportStates>
    </>
  );
}

function DailyCash({ data }: { data: DailyCashReportDto }) {
  const kept = data.cashReceived - data.voidedBeforeHandover;
  const withCollectors = data.withCollectors.reduce((sum, c) => sum + c.amount, 0);
  const handedOver = data.handedOver.reduce((sum, h) => sum + h.fromDay, 0);
  const holds = kept === withCollectors + handedOver;

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Cash in on {formatDay(data.date)}</h2>
        <SummaryLines
          lines={[
            { label: 'Cash received', amount: data.cashReceived },
            { label: 'Voided before handover', amount: -data.voidedBeforeHandover },
            { label: 'Still with collectors', amount: withCollectors },
            { label: 'Handed over', amount: handedOver },
          ]}
        />
        <p
          data-testid="cash-identity"
          className={cn('flex flex-wrap items-center gap-2 text-sm', holds ? 'text-foreground' : 'text-destructive')}
        >
          {holds ? <CheckIcon className="size-4 text-primary" aria-hidden="true" /> : <TriangleAlertIcon className="size-4" aria-hidden="true" />}
          <span className="tabular-nums">
            {formatRupees(data.cashReceived)} − {formatRupees(data.voidedBeforeHandover)} = {formatRupees(withCollectors)} with collectors +{' '}
            {formatRupees(handedOver)} handed over
          </span>
          <span className="sr-only">{holds ? '(balances)' : '(does not balance)'}</span>
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Still with collectors</h2>
        <SimpleTable
          head={['Collector', 'Since', 'Amount']}
          numeric={1}
          empty="No cash from this day is waiting to be handed over."
          rows={data.withCollectors.map((c) => ({
            key: c.collectorUserId,
            cells: [c.collector, formatDateTime(c.since), formatRupees(c.amount)],
          }))}
        />
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Handed over</h2>
        <SimpleTable
          head={['Collector', 'Status', 'From this day', 'Handover expected', 'Counted']}
          numeric={3}
          empty="No cash from this day has been handed over."
          rows={data.handedOver.map((h) => ({
            key: h.handoverId,
            cells: [
              h.collector,
              h.status === 'open' ? (
                <Badge key="s" variant="outline">Waiting to be counted</Badge>
              ) : (
                <span key="s">
                  Counted by {h.confirmedBy ?? 'Unknown'}
                  {(h.shortfall ?? 0) > 0 && (
                    <span className="block text-xs text-destructive">
                      short {formatRupees(h.shortfall ?? 0)}
                      {h.shortfallResolution && `, ${RESOLUTION_LABELS[h.shortfallResolution]}`}
                    </span>
                  )}
                  {(h.surplus ?? 0) > 0 && <span className="block text-xs text-muted-foreground">over {formatRupees(h.surplus ?? 0)}</span>}
                </span>
              ),
              formatRupees(h.fromDay),
              formatRupees(h.expected),
              h.counted === null ? '—' : formatRupees(h.counted),
            ],
          }))}
        />
        {data.voidedAfterHandover > 0 && (
          <p className="text-sm text-muted-foreground">
            Voided after handover: {formatRupees(data.voidedAfterHandover)} (still in the handovers&apos; expected amounts).
          </p>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Cash out on this day</h2>
        <SummaryLines
          lines={[
            { label: 'Refunds paid in cash', amount: data.refundsPaidCash },
            { label: 'Cash expenses', amount: data.cashExpenses, note: data.shortfallWrittenOff > 0 ? `includes ${formatRupees(data.shortfallWrittenOff)} of shortfalls written off` : undefined },
            { label: 'Salaries paid in cash', amount: data.salariesPaidCash },
          ]}
        />
      </section>
    </div>
  );
}

/** A small table whose last `numeric` columns are amounts, right-aligned. */
function SimpleTable({
  head,
  numeric,
  rows,
  empty,
}: {
  head: readonly string[];
  numeric: number;
  rows: readonly { key: string; cells: readonly React.ReactNode[] }[];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {head.map((label, i) => (
              <TableHead key={label} className={cn('px-4 text-muted-foreground', i >= head.length - numeric && 'text-right')}>
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={head.length} className="px-4 py-6 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.key}>
                {row.cells.map((cell, i) => (
                  <TableCell key={i} className={cn('px-4', i >= head.length - numeric && 'text-right tabular-nums')}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
