'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterSelect } from '@/components/list-filters';
import { unwrap } from '@/lib/api/client';
import {
  reportsApi,
  type CollectionBasis,
  type CollectionGroup,
  type CollectionsQuery,
} from '@/lib/api/school-reports-contract';
import { DateFilter, ReportRowsTable, ReportStates, SummaryLines, last30Days, plural, reportsKeys } from '../_lib/reports-ui';

const GROUP_LABELS: Record<CollectionGroup, string> = {
  day: 'Day',
  method: 'Method',
  feeHead: 'Fee head',
  class: 'Class',
  collector: 'Collector',
};

/**
 * Collections (slice 22): the money received in a range of at most 92 days, grouped, on the day it
 * was received or the day it was verified (rule 25), with the corrections that make up the net.
 */
export function CollectionsReport() {
  const [range, setRange] = useState(last30Days);
  const [groupBy, setGroupBy] = useState<CollectionGroup>('day');
  const [basis, setBasis] = useState<CollectionBasis>('received');
  const query: CollectionsQuery = { receivedFrom: range.from, receivedTo: range.to, groupBy, basis };
  const report = useQuery({
    queryKey: reportsKeys.report('collections', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/collections', { params: { query } })),
    enabled: range.from !== '' && range.to !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateFilter label="From" value={range.from} onChange={(from) => setRange((r) => ({ ...r, from }))} />
        <DateFilter label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
        <FilterSelect<CollectionGroup> label="Group by" value={groupBy} onChange={setGroupBy}>
          {Object.entries(GROUP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect<CollectionBasis> label="Dated by" value={basis} onChange={setBasis}>
          <option value="received">Day received</option>
          <option value="verified">Day verified</option>
        </FilterSelect>
      </div>
      <ReportStates query={report}>
        {(data) => (
          <div className="grid gap-6">
            <ReportRowsTable rows={data.rows} keyLabel={GROUP_LABELS[groupBy]} total={data.total} count={data.count} emptyText="No payments in this range." />
            <SummaryLines
              lines={[
                { label: 'Collected', amount: data.total, note: plural(data.count, 'payment') },
                { label: 'Refunds paid', amount: -data.refunds.amount, note: plural(data.refunds.count, 'refund') },
                { label: 'Refunds reversed', amount: data.refundReversals.amount, note: plural(data.refundReversals.count, 'reversal') },
                { label: 'Net', amount: data.net, strong: true },
              ]}
            />
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">Not in the total</p>
              <SummaryLines
                lines={[
                  { label: 'Voided', amount: data.voided.amount, note: plural(data.voided.count, 'payment') },
                  { label: 'Carried forward from another year', amount: data.carriedForward.amount, note: plural(data.carriedForward.count, 'advance') },
                  { label: 'Carry-forwards undone', amount: data.carryForwardReversals.amount, note: plural(data.carryForwardReversals.count, 'advance') },
                ]}
              />
            </div>
          </div>
        )}
      </ReportStates>
    </>
  );
}
