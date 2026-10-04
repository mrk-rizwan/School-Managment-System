'use client';

import { Capability, REMARK_CATEGORIES, REMARK_VISIBILITIES, type RemarkCategory, type RemarkVisibility } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { DataTable, RowActions, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { diaryApi, type RemarkDto, type RemarkQuery } from '@/lib/api/school-diary-contract';
import type { StudentDetailDto } from '@/lib/api/school-students-contract';
import { formatDay, formatDateTime, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { mySections } from '../../attendance/_lib/attendance-ui';
import { REMARK_CATEGORY_LABELS, REMARK_VISIBILITY_LABELS, remarkKeys } from '../_lib/remarks-ui';
import { CorrectRemarkDialog, NewRemarkDialog } from './remark-dialogs';

// contracts/slice-13.md §5, §11 "Student → Remarks tab": every visibility for staff; a remark is
// never edited — "Correct" writes a new row and the original shows struck through under it.

const LIMIT = 20;

export function RemarksTab({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const canWrite = can(Capability.REMARK_WRITE);
  const [category, setCategory] = useState<'' | RemarkCategory>('');
  const [visibility, setVisibility] = useState<'' | RemarkVisibility>('');
  const [showCorrected, setShowCorrected] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useListPage([category, visibility, showCorrected, dateFrom, dateTo]);
  // Either date alone is open-ended (§5.1); both are checked only for order.
  const datesBackwards = dateFrom !== '' && dateTo !== '' && dateTo < dateFrom;
  const [creating, setCreating] = useState(false);
  const [correcting, setCorrecting] = useState<RemarkDto | null>(null);
  const toggleId = useId();

  const query: RemarkQuery = {
    page,
    limit: LIMIT,
    sort: '-date',
    includeSuperseded: showCorrected,
    ...(category && { category }),
    ...(visibility && { visibility }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
  };
  const list = useQuery({
    queryKey: [...remarkKeys.student(student.id), query],
    queryFn: () =>
      unwrap(diaryApi.GET('/api/v1/students/{id}/remarks', { params: { path: { id: student.id }, query } })),
    placeholderData: keepPreviousData,
    enabled: !datesBackwards,
  });

  // A section-scoped teacher may correct only their own remarks (§5.3); a school-wide holder any.
  const staffId = me.data?.staffId ?? null;
  const sectionScoped = mySections(me.data, todayInSchool()).some((s) => s.sectionId === student.current?.sectionId);
  const mayCorrect = (r: RemarkDto) =>
    canWrite && r.supersededAt === null && (r.authorStaffId === staffId || !sectionScoped);

  // Each superseded original is listed straight after the row that corrects it.
  const rows = orderChains(list.data?.data ?? []);
  const shown = { ...list, data: list.data && { ...list.data, data: rows } };

  const column = createColumnHelper<DataTableFeatures, RemarkDto>();
  const columns = [
    column.accessor('date', {
      header: 'Date',
      cell: ({ row }) => <Struck remark={row.original}>{formatDay(row.original.date)}</Struck>,
    }),
    column.accessor('category', {
      header: 'Category',
      cell: ({ getValue }) => <Badge variant="outline">{REMARK_CATEGORY_LABELS[getValue()]}</Badge>,
    }),
    column.accessor('text', {
      header: 'Remark',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="grid max-w-md gap-1 whitespace-pre-wrap">
            <Struck remark={r}>{r.text}</Struck>
            {r.supersededAt && (
              <span className="text-xs text-muted-foreground">Superseded {formatDateTime(r.supersededAt)}</span>
            )}
            {r.correctionReason && (
              <span className="text-xs text-muted-foreground" data-testid="correction-reason">
                Correction: {r.correctionReason}
              </span>
            )}
          </div>
        );
      },
    }),
    column.accessor('visibility', {
      header: 'Seen by',
      cell: ({ getValue }) => REMARK_VISIBILITY_LABELS[getValue()],
    }),
    column.display({
      id: 'by',
      header: 'By',
      cell: ({ row }) => [row.original.authorName, row.original.subjectName].filter(Boolean).join(' · '),
    }),
    column.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <RowActions
          label={`the remark of ${formatDay(row.original.date)}`}
          actions={mayCorrect(row.original) ? [{ label: 'Correct', onSelect: () => setCorrecting(row.original) }] : []}
        />
      ),
    }),
  ];

  return (
    <section className="grid gap-4" aria-label="Remarks">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect<'' | RemarkCategory> label="Category" value={category} onChange={setCategory}>
            <option value="">Any</option>
            {REMARK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {REMARK_CATEGORY_LABELS[c]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<'' | RemarkVisibility> label="Seen by" value={visibility} onChange={setVisibility} className="sm:w-48">
            <option value="">Anyone</option>
            {REMARK_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {REMARK_VISIBILITY_LABELS[v]}
              </option>
            ))}
          </FilterSelect>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={`${toggleId}-from`}>From</Label>
            <Input id={`${toggleId}-from`} type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={`${toggleId}-to`}>To</Label>
            <Input id={`${toggleId}-to`} type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
          <div className="flex h-8 items-center gap-2">
            <input
              id={toggleId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={showCorrected}
              onChange={(event) => setShowCorrected(event.target.checked)}
            />
            <Label htmlFor={toggleId}>Show corrected</Label>
          </div>
        </div>
        {canWrite && student.status !== 'withdrawn' && student.status !== 'transferred' && student.status !== 'alumni' && (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            New remark
          </Button>
        )}
      </div>
      {datesBackwards ? (
        <p className="text-sm text-destructive">The end date cannot be before the start date.</p>
      ) : (
        <DataTable
          columns={columns}
          query={shown}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          getRowId={(r) => r.id}
          emptyTitle="No remarks"
          emptyDescription="Remarks from teachers about this student appear here."
        />
      )}
      {creating && <NewRemarkDialog student={student} onClose={() => setCreating(false)} />}
      <CorrectRemarkDialog remark={correcting} studentId={student.id} onClose={() => setCorrecting(null)} />
    </section>
  );
}

function Struck({ remark, children }: { remark: RemarkDto; children: React.ReactNode }) {
  return remark.supersededAt ? (
    <s className="text-muted-foreground" aria-label="Superseded">
      {children}
    </s>
  ) : (
    <span>{children}</span>
  );
}

/** Rows in their order, with each superseded original moved under the row that corrects it. */
function orderChains(rows: RemarkDto[]): RemarkDto[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const placed = new Set<string>();
  const out: RemarkDto[] = [];
  for (const row of rows) {
    // A superseded row whose successor is on this page is placed under the successor.
    if (row.supersededById && byId.has(row.supersededById)) continue;
    let current: RemarkDto | undefined = row;
    while (current && !placed.has(current.id)) {
      out.push(current);
      placed.add(current.id);
      current = current.supersedesId ? byId.get(current.supersedesId) : undefined;
    }
  }
  return out;
}
