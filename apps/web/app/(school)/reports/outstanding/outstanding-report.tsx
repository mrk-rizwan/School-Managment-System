'use client';

import { formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterSelect } from '@/components/list-filters';
import { unwrap } from '@/lib/api/client';
import { reportsApi, type OutstandingGroup, type OutstandingQuery } from '@/lib/api/school-reports-contract';
import { formatDay } from '@/lib/format';
import { ReportRowsTable, ReportStates, YearFilter, plural, reportsKeys, useDefaultYearId } from '../_lib/reports-ui';

const GROUP_LABELS: Record<OutstandingGroup, string> = { class: 'Class', feeHead: 'Fee head', period: 'Month' };

/** Outstanding (slice 22): what a year's open charges still owe today, grouped, and its credits. */
export function OutstandingReport() {
  const [chosenYear, setChosenYear] = useState('');
  const academicYearId = useDefaultYearId(chosenYear);
  const [groupBy, setGroupBy] = useState<OutstandingGroup>('class');
  const query: OutstandingQuery = { academicYearId, groupBy };
  const report = useQuery({
    queryKey: reportsKeys.report('outstanding', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/outstanding', { params: { query } })),
    enabled: academicYearId !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={academicYearId} onChange={setChosenYear} />
        <FilterSelect<OutstandingGroup> label="Group by" value={groupBy} onChange={setGroupBy}>
          {Object.entries(GROUP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
      </div>
      <ReportStates query={report}>
        {(data) => (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">As of {formatDay(data.asOf)}.</p>
            <ReportRowsTable rows={data.rows} keyLabel={GROUP_LABELS[groupBy]} total={data.total} emptyText="Nothing is owed for this year." />
            <p className="text-sm text-muted-foreground">
              Credits given this year: {formatRupees(data.adjustments.amount)} ({plural(data.adjustments.count, 'credit')}), already taken off the charges above.
            </p>
          </div>
        )}
      </ReportStates>
    </>
  );
}
