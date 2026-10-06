'use client';

import { formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterSelect } from '@/components/list-filters';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { reportsApi, type ConcessionGroup, type ConcessionsQuery } from '@/lib/api/school-reports-contract';
import { ReportStates, YearFilter, reportsKeys, useDefaultYearId } from '../_lib/reports-ui';

const GROUP_LABELS: Record<ConcessionGroup, string> = { feeHead: 'Fee head', class: 'Class' };

/** Concessions (slice 22): how much a year's concessions took off the charges, and for how many students. */
export function ConcessionsReport() {
  const [chosenYear, setChosenYear] = useState('');
  const academicYearId = useDefaultYearId(chosenYear);
  const [groupBy, setGroupBy] = useState<ConcessionGroup>('feeHead');
  const query: ConcessionsQuery = { academicYearId, groupBy };
  const report = useQuery({
    queryKey: reportsKeys.report('concessions', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/concessions', { params: { query } })),
    enabled: academicYearId !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={academicYearId} onChange={setChosenYear} />
        <FilterSelect<ConcessionGroup> label="Group by" value={groupBy} onChange={setGroupBy}>
          {Object.entries(GROUP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
      </div>
      <ReportStates query={report}>
        {(data) => (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4 text-muted-foreground">{GROUP_LABELS[groupBy]}</TableHead>
                  <TableHead className="px-4 text-right text-muted-foreground">Students</TableHead>
                  <TableHead className="px-4 text-right text-muted-foreground">Reduction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                      No concessions this year.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="px-4">{row.label}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">{row.students}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">{formatRupees(row.reduction)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell className="px-4 font-medium" colSpan={2}>
                    Total
                  </TableCell>
                  <TableCell className="px-4 text-right font-medium tabular-nums">{formatRupees(data.total)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </ReportStates>
    </>
  );
}
