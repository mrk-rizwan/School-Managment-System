'use client';

import { addDaysTo } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { documentsApi, type IncompleteAdmissionDto, type IncompleteAdmissionsQuery } from '@/lib/api/school-documents-contract';
import type { DocumentType } from '@/lib/api/school-students-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { DOCUMENT_TYPE_LABELS, placeLabel } from '../../students/_lib/students-ui';
import { documentsKeys } from '../_lib/documents-ui';

// Incomplete admissions (Phase 5 slice 40, R323; contracts/slice-40.md §2.4): students on the roll
// admitted in the range whose required documents are missing, awaiting a check or rejected.
// Default: the last 90 days. A query on the student, never a gate (R324).

const LIMIT = 25;

const types = (list: readonly DocumentType[]) => list.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ');

export function IncompleteAdmissions() {
  const today = todayInSchool();
  const [from, setFrom] = useState(addDaysTo(today, -90));
  const [to, setTo] = useState(today);
  const [page, setPage] = useListPage([from, to]);
  const ids = { from: useId(), to: useId() };

  const query: IncompleteAdmissionsQuery = { page, limit: LIMIT, ...(from && { admittedFrom: from }), ...(to && { admittedTo: to }) };
  const report = useQuery({
    queryKey: [...documentsKeys.incomplete, query],
    queryFn: () => unwrap(documentsApi.GET('/api/v1/documents/incomplete-admissions', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, IncompleteAdmissionDto>();
    return [
      column.accessor('fullName', {
        header: 'Student',
        cell: (info) => {
          const r = info.row.original;
          const place = placeLabel(r.className && r.sectionName ? { className: r.className, sectionName: r.sectionName } : null);
          return (
            <span className="grid">
              <Link className="font-medium hover:underline" href={`/students/${r.studentId}`}>
                {r.fullName}
              </Link>
              <span className="text-xs text-muted-foreground">
                Adm. {r.admissionNo}
                {place ? ` · ${place}` : ''}
              </span>
            </span>
          );
        },
      }),
      column.accessor('admittedOn', { header: 'Admitted', cell: (info) => formatDay(info.getValue()) }),
      column.display({
        id: 'documents',
        header: 'Documents',
        cell: (info) => {
          const r = info.row.original;
          return (
            <span className="flex flex-wrap gap-1">
              {r.missing.length > 0 && <Badge variant="outline">Missing: {types(r.missing)}</Badge>}
              {r.awaiting.length > 0 && <Badge variant="secondary">Awaiting check: {types(r.awaiting)}</Badge>}
              {r.rejected.length > 0 && <Badge variant="destructive">Rejected: {types(r.rejected)}</Badge>}
            </span>
          );
        },
      }),
    ];
  }, []);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={ids.from}>Admitted from</Label>
          <Input id={ids.from} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={ids.to}>Admitted to</Label>
          <Input id={ids.to} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <DataTable
        columns={columns}
        query={report}
        getRowId={(row) => row.studentId}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="Every admission is complete"
        emptyDescription="No student admitted in this range is missing a required document."
      />
    </>
  );
}
